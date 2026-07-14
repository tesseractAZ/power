import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProbabilisticForecast,
  computeSoilingDecomposition,
  resetForecastCachesForTesting,
  parsePvBandSigmaCal,
  pvBandRealizedHalfFrac,
} from '../src/analytics.js';
import type { ForecastSkillReport, DayForecast } from '../src/analytics.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride } from '../src/weather.js';
import { parseTelemetryLine } from '../src/alertTelemetry.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ===================================================================
 * v1.23.0 — engine-review final low-severity queue.
 *  F29: soiling decomposition applies the v0.13.1 recorder-weather
 *       backfill so the baseline spans 60 days, not a sliding 7.
 *  F30: the PV P10-P90 band self-calibrates to realized daily coverage
 *       (~80% target), shrink-only + floored + gated on ≥14 scored days.
 *  F31: alert telemetry recovers NUL-torn append records.
 * =================================================================== */

/* ── F31: parseTelemetryLine — recover NUL-torn records ───────────── */

test('F31 — parseTelemetryLine parses a normal JSONL record', () => {
  const e = parseTelemetryLine('{"familyKey":"pack-hot","alertId":"x-1","event":"rise","ts":123}');
  assert.equal(e?.familyKey, 'pack-hot');
  assert.equal(e?.ts, 123);
});

test('F31 — a record torn behind a run of NUL bytes is RECOVERED (the exact live artifact)', () => {
  // The finding: 424 leading NULs ahead of a valid record after a power-cut
  // torn append. `\0` is not whitespace, so the old trim()+JSON.parse dropped it.
  const nulls = String.fromCharCode(0).repeat(424);
  const e = parseTelemetryLine(nulls + '{"familyKey":"cell-imbalance","alertId":"y-2","event":"shortClear","ts":456,"durationMs":90}');
  assert.equal(e?.familyKey, 'cell-imbalance', 'the record after the NULs is recovered');
  assert.equal(e?.durationMs, 90);
});

test('F31 — other C0 control bytes ahead of the record are also stripped', () => {
  const e = parseTelemetryLine(String.fromCharCode(0, 1, 31) + '{"familyKey":"f","alertId":"z","event":"rise","ts":7}');
  assert.equal(e?.ts, 7);
});

test('F31 — a pure-NUL / non-JSON / empty line yields null (skipped, as before)', () => {
  assert.equal(parseTelemetryLine(String.fromCharCode(0, 0, 0)), null);
  assert.equal(parseTelemetryLine('not json at all'), null);
  assert.equal(parseTelemetryLine(''), null);
  assert.equal(parseTelemetryLine('   '), null);
});

/* ── F30: pure calibration helpers ───────────────────────────────── */

test('F30 — parsePvBandSigmaCal: empty/NaN/≤0 → null (auto); valid → self; out-of-range clamped', () => {
  assert.equal(parsePvBandSigmaCal(undefined), null);
  assert.equal(parsePvBandSigmaCal(''), null);
  assert.equal(parsePvBandSigmaCal('   '), null);
  assert.equal(parsePvBandSigmaCal('abc'), null);
  assert.equal(parsePvBandSigmaCal('0'), null);
  assert.equal(parsePvBandSigmaCal('-0.5'), null);
  assert.equal(parsePvBandSigmaCal('0.5'), 0.5);
  assert.equal(parsePvBandSigmaCal('1'), 1);
  assert.equal(parsePvBandSigmaCal('9'), 2, 'clamped to the 2× ceiling');
  assert.equal(parsePvBandSigmaCal('0.01'), 0.1, 'clamped to the 0.1 floor');
});

function skillDays(count: number, absErrPct: number, covered = true): ForecastSkillReport['days'] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
    predictedKwh: 50,
    actualKwh: 50 * (1 + (i % 2 ? absErrPct : -absErrPct) / 100),
    errorKwh: 0,
    errorPct: covered ? (i % 2 ? absErrPct : -absErrPct) : null,
    weatherCovered: covered,
  }));
}

test('F30 — pvBandRealizedHalfFrac: null below 14 scored days; nearest-rank p80 at/above', () => {
  assert.equal(pvBandRealizedHalfFrac(skillDays(13, 5)), null, '13 days is below the gate');
  // 14 days all |err| = 5% → p80 = 0.05.
  assert.equal(pvBandRealizedHalfFrac(skillDays(14, 5)), 0.05);
});

test('F30 — pvBandRealizedHalfFrac excludes uncovered / null-errorPct days from the count', () => {
  // 14 rows but uncovered → 0 scored → null.
  assert.equal(pvBandRealizedHalfFrac(skillDays(14, 5, false)), null);
  // 10 covered + 6 uncovered = 10 scored < 14 → null.
  const mixed = [...skillDays(10, 5, true), ...skillDays(6, 5, false)];
  assert.equal(pvBandRealizedHalfFrac(mixed), null);
});

test('F30 — pvBandRealizedHalfFrac returns the 80th percentile, not the min, of a VARIED error set', () => {
  // 11 days at 2% + one each at 10/20/40% → sorted |err|/100 puts the p80
  // (nearest-rank index ceil(0.8·14)-1 = 11) at 0.10, distinct from the 0.02
  // minimum. An all-equal fixture can't tell p80 from min apart.
  const days = [
    ...skillDays(11, 2), ...skillDays(1, 10), ...skillDays(1, 20), ...skillDays(1, 40),
  ];
  assert.equal(pvBandRealizedHalfFrac(days), 0.1);
});

/* ── F30: band calibration end-to-end ────────────────────────────── */

function forecast24(): DayForecast {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const start = base.getTime() + DAY; // tomorrow local midnight
  const hours = Array.from({ length: 24 }, (_, h) => ({
    ts: start + h * HOUR,
    forecastPvW: h >= 7 && h <= 18 ? 3_000 : 0,
    forecastLoadW: 1_000,
    projectedSocPct: 50 + h * 0.5,
  }));
  return { hours, reserveSoc: 20, pvCeilingW: 20_000, deviceModels: [{}, {}, {}] } as unknown as DayForecast;
}
const skill = (days: ForecastSkillReport['days']): ForecastSkillReport => ({
  generatedAt: 0, days, meanAbsErrorKwh: 3, meanAbsErrorPct: 6, biasFactor: 1, windowDays: 30,
});
const daySpread = (r: { hours: Array<{ p10W: number; p90W: number }> }) =>
  r.hours.reduce((s, b) => s + (b.p90W - b.p10W), 0);

beforeEach(() => { resetForecastCachesForTesting(); setWeatherCacheForTesting(null); });
afterEach(() => { clearWeatherTestOverride(); delete process.env.PV_BAND_SIGMA_CAL; });

test('F30 — no skill report → bandSigmaCal 1.0 (uncalibrated, the safe raw band)', async () => {
  const r = await computeProbabilisticForecast(forecast24(), null);
  assert.equal(r.bandSigmaCal, 1);
  assert.ok(r.realizedDailyErrHalfFrac == null);
  for (const b of r.hours) { assert.ok(b.p10W <= b.p50W && b.p50W <= b.p90W); }
});

test('F30 — <14 scored days → gate not met → bandSigmaCal 1.0, realized half-frac null', async () => {
  const r = await computeProbabilisticForecast(forecast24(), skill(skillDays(12, 3)));
  assert.equal(r.bandSigmaCal, 1, 'the calibration must not act on a thin sample');
  assert.equal(r.realizedDailyErrHalfFrac, null);
});

test('F30 — moderate realized error lands the calibration in the INTERMEDIATE band (0.4 < cal < 1)', async () => {
  // ~25% daily error → realized half-frac ≈ 0.25 vs a produced ≈ 0.4 → cal ≈ 0.63,
  // strictly between the 0.4 floor and 1. (An 8% fixture would floor at exactly
  // 0.4 — the review-flagged gap that left this open interval untested.)
  const rawSpread = daySpread(await computeProbabilisticForecast(forecast24(), null));
  resetForecastCachesForTesting(); setWeatherCacheForTesting(null);
  const r = await computeProbabilisticForecast(forecast24(), skill(skillDays(20, 25)));
  assert.ok(r.bandSigmaCal! > 0.4 && r.bandSigmaCal! < 1, `intermediate shrink, not floored/clamped; got ${r.bandSigmaCal}`);
  assert.ok(daySpread(r) < rawSpread, 'the calibrated band is narrower than the raw band');
  assert.ok(r.realizedDailyErrHalfFrac != null && r.realizedDailyErrHalfFrac > 0);
  for (const b of r.hours) { assert.ok(b.p10W <= b.p50W && b.p50W <= b.p90W); }
});

test('F30 — an extremely tight realized error floors the calibration at 0.4 (never collapses the band)', async () => {
  const r = await computeProbabilisticForecast(forecast24(), skill(skillDays(20, 1)));
  assert.equal(r.bandSigmaCal, 0.4, 'shrink is capped at the 40% floor');
});

test('F30 — the auto calibration is SHRINK-ONLY: a loose realized error never widens the band', async () => {
  // ~60% realized daily error exceeds the raw band half-width, so the raw ratio
  // would want cal > 1 (widen). Shrink-only clamps it to exactly 1 — the band
  // is never widened beyond the conservative raw default.
  const r = await computeProbabilisticForecast(forecast24(), skill(skillDays(20, 60)));
  assert.equal(r.bandSigmaCal, 1, 'cal is capped at 1 (never widens)');
  assert.ok(r.realizedDailyErrHalfFrac != null && r.realizedDailyErrHalfFrac > 0.4,
    'it DID measure a large realized error — the clamp, not the gate, held it at 1');
});

test('F30 — PV_BAND_SIGMA_CAL env override wins over the auto factor', async () => {
  process.env.PV_BAND_SIGMA_CAL = '0.5';
  const r = await computeProbabilisticForecast(forecast24(), skill(skillDays(20, 1)));
  assert.equal(r.bandSigmaCal, 0.5, 'env override bypasses the auto 0.4 floor');
});

/* ── F29: soiling decomposition uses the recorder weather backfill ── */

function dpuDevice(sn: string): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn, deviceName: `DELTA-PRO-ULTRA-${sn}`, productName: 'Delta Pro Ultra',
      online: true, lastUpdated: Date.now(),
      projection: { kind: 'dpu', soc: 80, packs: [] },
    } as unknown as DeviceSnapshot,
  };
}

/** Recorder that serves 60 days of clear-midday weather + PV from the persisted
 *  series (recorder.query), and empty everything else. PV coeff steps DOWN in
 *  the recent 7 days to simulate soiling the 60-day baseline should catch. */
function backfillRecorder(sn: string): Recorder {
  const now = Date.now();
  const ghi: Array<{ ts: number; value: number }> = [];
  const pv: Array<{ ts: number; value: number }> = [];
  const RAD = [820, 900, 810]; // hours 10/11/12 — all clear (≥250, cloud 0)
  for (let d = 60; d >= 1; d--) {
    const dayStart = now - d * DAY;
    const recent = d <= 7;
    const coeff = recent ? 8.0 : 9.0; // ~11% drop in the last week
    for (let k = 0; k < 3; k++) {
      // Anchor each sample to local hour 10/11/12 so computeSoiling's clear-hour
      // grouping (≥3 clear hours/day) is satisfied deterministically.
      const anchor = new Date(dayStart); anchor.setHours(10 + k, 0, 0, 0);
      const ts = anchor.getTime();
      ghi.push({ ts, value: RAD[k] });
      pv.push({ ts, value: coeff * RAD[k] });
    }
  }
  return {
    insertSnapshot: () => {},
    query: (qsn: string, metric: string) => {
      if (qsn === 'weather' && metric === 'ghi_wm2') return ghi;
      if (qsn === 'weather' && metric === 'cloud_pct') return ghi.map((g) => ({ ts: g.ts, value: 0 }));
      if (qsn === sn && metric === 'pv_total') return pv;
      return [];
    },
    queryMulti: (_sn: string, metrics: string[]) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [], close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

test('F29 — soiling decomposition computes from RECORDER weather even when the live cache is empty', async () => {
  // The core of the fix: pre-v1.23.0 this returned empty() the moment
  // getWeather() was null, so the 60-day baseline could never form. Now the
  // recorder backfill drives it.
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null); // live weather cache COLD
  const sn = 'SN-SOIL-F29';
  const rec = backfillRecorder(sn);
  const r = await computeSoilingDecomposition(dpuDevice(sn), rec);
  clearWeatherTestOverride();
  assert.equal(r.perDevice.length, 1, 'a per-device soiling row is produced from recorder weather');
  const dev = r.perDevice[0];
  assert.ok(dev.baselineCoeff != null && dev.recentCoeff != null, 'baseline + recent coefficients computed');
  assert.ok((dev.dropPct ?? 0) > 5, `the ~11% recent soiling drop is detected (got ${dev.dropPct}%)`);
});

test('F29 — with NO weather from either source the decomposition still bails empty (guard intact)', async () => {
  // The size===0 guard must still short-circuit: live cache null AND recorder
  // weather empty → no baseline can form → empty(), not a bogus row.
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  const sn = 'SN-SOIL-EMPTY';
  const noWeather = {
    insertSnapshot: () => {},
    query: (qsn: string, metric: string) => (qsn === sn && metric === 'pv_total'
      ? [{ ts: Date.now() - DAY, value: 5000 }] : []),
    queryMulti: (_sn: string, metrics: string[]) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [], close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
  const r = await computeSoilingDecomposition(dpuDevice(sn), noWeather);
  clearWeatherTestOverride();
  assert.equal(r.perDevice.length, 0, 'no weather → empty(), no per-device rows');
  assert.equal(r.perHour.length, 0);
});
