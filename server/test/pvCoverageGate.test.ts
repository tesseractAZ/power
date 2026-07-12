/**
 * v1.10.0 — engine-review fixes F4 + F11: per-core coverage gates.
 *
 * The 30-day ground-truth review found hours/days where a wired home Core
 * recorded ZERO telemetry being scored as ZERO SUNLIGHT:
 *  - F4: the pvBiasFactor hindcast scored the 06-29→07-02 Core1+Core2 cloud
 *    blackout as a 37% over-forecast, crashing the alarm-facing correction to
 *    0.63 (truth ~1.15) for ~a week — runway/soc-dip mechanically pessimistic.
 *  - F11: 31% of the solar model's training pairs had <3 cores reporting,
 *    deflating the fitted GHI→PV coefficients 11-23% (chronic -21% clear-day
 *    under-forecast the clamped correction can't fully repair).
 *
 * The contract under test: MISSING data is EXCLUDED — but genuinely LOW data
 * (a real cloudy day, with all cores reporting) still teaches the model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePvBiasCorrection,
  coreCoverageByDay,
  fullCoverageFleetPv,
  SOLAR_FIT_MIN_FULL_COVERAGE_HOURS,
  type SolarResponseModel,
} from '../src/analytics.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const TODAY_START = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

function modelWithCoeff(coeff: number): SolarResponseModel {
  return {
    hourly: Array.from({ length: 24 }, (_, h) => ({
      hour: h, coeff, r2: 0.95, samples: 100, observedMaxPvW: 10_000,
    })),
    peakCoeff: coeff,
    pairCount: 240,
    historyDays: 30,
  };
}

/** Daylight = hours 8..16 (9 hours) at ghi=500 for each of the past `days` days. */
function ghiWindow(days: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = days; i >= 1; i--) {
    const dayStart = TODAY_START - i * DAY_MS;
    for (let h = 8; h <= 16; h++) m.set(Math.floor((dayStart + h * HOUR_MS) / HOUR_MS), 500);
  }
  return m;
}

/** Hourly samples for one SN: `watts(dayIndex, hour)` during daylight; null = no sample. */
function snSamples(days: number, watts: (i: number, h: number) => number | null) {
  const pts: Array<{ ts: number; value: number }> = [];
  for (let i = days; i >= 1; i--) {
    const dayStart = TODAY_START - i * DAY_MS;
    for (let h = 8; h <= 16; h++) {
      const w = watts(i, h);
      if (w == null) continue;
      pts.push({ ts: dayStart + h * HOUR_MS + 5 * 60_000, value: w });
    }
  }
  return pts;
}

/* ── coreCoverageByDay ─────────────────────────────────────────────────── */

test('coreCoverageByDay — full-coverage days are covered; a zero-sample core day is not', () => {
  const ghi = ghiWindow(7);
  const pvBySn = new Map([
    ['A', snSamples(7, () => 500)],
    ['B', snSamples(7, (i) => (i === 3 ? null : 500))], // day-3 blackout for B
  ]);
  const cov = coreCoverageByDay(ghi, pvBySn, TODAY_START, 7);
  assert.equal(cov.get(TODAY_START - 5 * DAY_MS)!.covered, true, 'normal day covered');
  const gap = cov.get(TODAY_START - 3 * DAY_MS)!;
  assert.equal(gap.covered, false, 'blackout day uncovered');
  assert.equal(gap.worstSn, 'B');
  assert.equal(gap.worstFrac, 0);
});

test('coreCoverageByDay — 50% of daylight hours fails the 80% bar; 8/9 passes', () => {
  const ghi = ghiWindow(7);
  const half = new Map([['A', snSamples(7, (i, h) => (i === 2 && h % 2 === 0 ? null : 500))]]); // ~44% missing on day 2
  assert.equal(coreCoverageByDay(ghi, half, TODAY_START, 7).get(TODAY_START - 2 * DAY_MS)!.covered, false);
  const mostly = new Map([['A', snSamples(7, (i, h) => (i === 2 && h === 12 ? null : 500))]]); // 8/9 ≈ 0.89
  assert.equal(coreCoverageByDay(ghi, mostly, TODAY_START, 7).get(TODAY_START - 2 * DAY_MS)!.covered, true);
});

test('coreCoverageByDay — a day with NO daylight GHI is neutral (existing ghi gate owns it)', () => {
  const ghi = ghiWindow(7);
  // Remove all of day-4's daylight.
  for (let h = 8; h <= 16; h++) ghi.delete(Math.floor((TODAY_START - 4 * DAY_MS + h * HOUR_MS) / HOUR_MS));
  const cov = coreCoverageByDay(ghi, new Map([['A', snSamples(7, () => 500)]]), TODAY_START, 7);
  const d4 = cov.get(TODAY_START - 4 * DAY_MS)!;
  assert.equal(d4.covered, true);
  assert.equal(d4.daylightHours, 0);
});

/* ── fullCoverageFleetPv ───────────────────────────────────────────────── */

const hourMap = (entries: Array<[number, number]>) => new Map(entries);

test('fullCoverageFleetPv — sums ONLY intersection hours when coverage is sufficient', () => {
  // 100 shared hours + 30 hours where only core A reported.
  const a = hourMap(Array.from({ length: 130 }, (_, k) => [k, 1000]));
  const b = hourMap(Array.from({ length: 100 }, (_, k) => [k, 2000]));
  const r = fullCoverageFleetPv([a, b]);
  assert.equal(r.usedFullCoverageOnly, true);
  assert.equal(r.fullHours, 100);
  assert.equal(r.unionHours, 130);
  assert.equal(r.map.get(50), 3000, 'shared hour = true fleet sum');
  assert.equal(r.map.get(120), undefined, 'partial-coverage hour EXCLUDED from the fit');
});

test('fullCoverageFleetPv — a whole-window-dark core is skipped from the requirement', () => {
  const a = hourMap(Array.from({ length: 100 }, (_, k) => [k, 1000]));
  const dark = new Map<number, number>();
  const r = fullCoverageFleetPv([a, dark]);
  assert.equal(r.fullHours, 100, 'empty map cannot nuke the intersection');
  assert.equal(r.map.get(10), 1000);
});

test('fullCoverageFleetPv — too few full-coverage hours falls back to the ungated union', () => {
  const n = SOLAR_FIT_MIN_FULL_COVERAGE_HOURS - 10;
  const a = hourMap(Array.from({ length: 200 }, (_, k) => [k, 1000]));
  const b = hourMap(Array.from({ length: n }, (_, k) => [k, 2000])); // only n shared hours
  const r = fullCoverageFleetPv([a, b]);
  assert.equal(r.usedFullCoverageOnly, false);
  assert.equal(r.map.size, 200, 'fallback = union (pre-v1.10.0 behaviour)');
  assert.equal(r.map.get(199), 1000);
});

/* ── computePvBiasCorrection with the F4 gate ──────────────────────────── */

// coeff 2 × ghi 500 × 9h = 9 kWh predicted/day. Two SNs at 500 W each ⇒ 9 kWh
// actual/day ⇒ a perfectly calibrated model (factor 1.0).
const MODEL = modelWithCoeff(2);

test('bias gate — a core-blackout day no longer deflates the factor (missing data ≠ missing sun)', () => {
  const ghi = ghiWindow(7);
  const pvBySn = new Map([
    ['A', snSamples(7, () => 500)],
    ['B', snSamples(7, (i) => (i === 3 ? null : 500))], // B dark on day-3 → fleet actual halves
  ]);
  const factor = computePvBiasCorrection(MODEL, ghi, pvBySn, TODAY_START);
  // Pre-gate this read (6×9 + 4.5)/63 ≈ 0.93 — phantom over-forecast. Now the
  // blackout day is excluded and the remaining 6 days say the model is calibrated.
  assert.equal(factor, 1.0);
});

test('bias gate — a GENUINE cloudy day (all cores reporting, low PV) still teaches the model', () => {
  const ghi = ghiWindow(7);
  const pvBySn = new Map([
    ['A', snSamples(7, (i) => (i === 3 ? 100 : 500))], // real clouds: both cores report, output low
    ['B', snSamples(7, (i) => (i === 3 ? 100 : 500))],
  ]);
  const factor = computePvBiasCorrection(MODEL, ghi, pvBySn, TODAY_START);
  assert.ok(factor < 1.0, `low-output day with full telemetry must still count (got ${factor})`);
  assert.ok(factor > 0.85, 'and by roughly the right amount');
});

test('bias gate — a core dark the ENTIRE window yields the neutral 1.0 no-op (never learns from unmeasurable actuals)', () => {
  const ghi = ghiWindow(7);
  const pvBySn = new Map([
    ['A', snSamples(7, () => 500)],
    ['B', [] as Array<{ ts: number; value: number }>], // wedged all week
  ]);
  assert.equal(computePvBiasCorrection(MODEL, ghi, pvBySn, TODAY_START), 1.0);
});

test('bias gate — excluded days are reported through the log hook', () => {
  const ghi = ghiWindow(7);
  const pvBySn = new Map([
    ['A', snSamples(7, () => 500)],
    ['B', snSamples(7, (i) => (i === 3 ? null : 500))],
  ]);
  const lines: string[] = [];
  computePvBiasCorrection(MODEL, ghi, pvBySn, TODAY_START, undefined, (m) => lines.push(m));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /pv-bias: excluded .* core B reported 0% of daylight hours/);
});
