import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGhiByEpoch,
  dayHasGhiCoverage,
  mergeRecorderWeather,
  diurnalBaselinePredictor,
  cappedMedianEffPct,
} from '../src/analytics.js';
import type { WeatherHour } from '../src/weather.js';

/* ===================================================================
 * v0.13.1 — forecasting + solar fixes (7-day audit).
 *
 * These cover the pure exported helpers that back four fixes:
 *   P1-1  forecast-skill days 4-7 showed a phantom errorPct=-100% because the
 *         day had ZERO GHI coverage (hindcast predKwh collapsed to 0). The
 *         per-day row must read errorPct=null / weatherCovered=false instead.
 *   P1-2  the durable GHI consumer: irradiance now comes from the recorder
 *         "ghi_wm2" series (whole window) and falls back to the in-memory
 *         weather cache (≤7 days) on cold start.
 *   P2-5  MPPT register-consistency ratio capped at 100% (no >100% headline).
 *   P3-4  backtest baseline uses a diurnal curve (night≈0, noon≈peak) so its
 *         R² stops collapsing to ≈0 against real diurnal PV.
 * =================================================================== */

const HOUR = 3_600_000;
/** Hour-epoch (the map key) for a given ms timestamp. */
const he = (ms: number) => Math.floor(ms / HOUR);
/** Build a recorder-style {ts,value} row at a given hour-epoch. */
const ghiRow = (epoch: number, value: number) => ({ ts: epoch * HOUR, value });
/** Minimal WeatherHour for the cache path. */
function wh(epoch: number, radiationWm2: number, cloudCoverPct = 0): WeatherHour {
  return { ts: epoch * HOUR, radiationWm2, cloudCoverPct, tempC: 25 };
}

/* ─── P1-1 / P1-2: GHI coverage + durable recorder consumer ────────── */

test('dayHasGhiCoverage — a day with NO GHI for any hour is uncovered (the days 4-7 bug)', () => {
  // GHI only exists for "today" (day 0); a day 5 days back has no rows.
  const todayStart = Date.UTC(2026, 5, 7, 0, 0, 0); // local-day boundary not important here — we key off the same arithmetic
  const ghi = new Map<number, number>();
  for (let h = 8; h <= 17; h++) ghi.set(he(todayStart) + h, 600); // daytime irradiance today
  const day5Start = todayStart - 5 * 24 * HOUR;
  assert.equal(dayHasGhiCoverage(ghi, day5Start), false, 'uncovered day must report false');
  assert.equal(dayHasGhiCoverage(ghi, todayStart), true, 'covered day must report true');
});

test('forecast-skill: an uncovered day yields errorPct=null, NOT a -100% phantom', () => {
  // Reproduce the per-day decision the skill loop makes: when the day has no
  // GHI coverage, errorPct is forced null (mirrors `weatherCovered && act>0.5`).
  const ghi = new Map<number, number>(); // no irradiance at all → uncovered
  const dayStart = Date.UTC(2026, 5, 1, 0, 0, 0);
  const weatherCovered = dayHasGhiCoverage(ghi, dayStart);
  assert.equal(weatherCovered, false);

  // The loop sets predWh=0 (no GHI), and with actKwh>0 the OLD code computed
  // errPct = (0 - act)/act*1000/10 = -100. The fix gates errPct on coverage.
  const predKwh = 0;
  const actKwh = 4.2;
  const errPct = weatherCovered && actKwh > 0.5
    ? Math.round(((predKwh - actKwh) / actKwh) * 1000) / 10
    : null;
  assert.equal(errPct, null, 'uncovered day must NOT report -100%');

  // Sanity: the same arithmetic on a COVERED day still produces the real miss.
  const coveredErrPct = true && actKwh > 0.5
    ? Math.round(((predKwh - actKwh) / actKwh) * 1000) / 10
    : null;
  assert.equal(coveredErrPct, -100, 'covered-day arithmetic unchanged');
});

test('buildGhiByEpoch — recorder series backfills hours the 3-day cache lost', () => {
  const base = he(Date.UTC(2026, 5, 1, 12, 0, 0));
  // Cache only has a recent hour; recorder has older hours (days 4-7 region).
  const cache = [wh(base, 700)];
  const recorder = [ghiRow(base - 96, 500), ghiRow(base - 120, 480)]; // 4-5 days back
  const map = buildGhiByEpoch(recorder, cache);
  assert.equal(map.get(base), 700, 'cache hour present');
  assert.equal(map.get(base - 96), 500, 'recorder backfills older hour');
  assert.equal(map.get(base - 120), 480, 'recorder backfills older hour');
  assert.equal(map.size, 3);
});

test('buildGhiByEpoch — recorder overwrites cache for the same hour (recorder is source of truth)', () => {
  const epoch = he(Date.UTC(2026, 5, 2, 12, 0, 0));
  const map = buildGhiByEpoch([ghiRow(epoch, 650)], [wh(epoch, 600)]);
  assert.equal(map.get(epoch), 650, 'persisted value wins over stale cache');
});

test('buildGhiByEpoch — cold start (empty recorder) falls back to the cache', () => {
  const epoch = he(Date.UTC(2026, 5, 3, 12, 0, 0));
  const map = buildGhiByEpoch([], [wh(epoch, 620)]);
  assert.equal(map.get(epoch), 620);
});

test('buildGhiByEpoch — zero / nighttime GHI is ignored (not a coverage signal)', () => {
  const epoch = he(Date.UTC(2026, 5, 4, 2, 0, 0)); // 2am
  const map = buildGhiByEpoch([ghiRow(epoch, 0)], [wh(epoch, 0)]);
  assert.equal(map.has(epoch), false, '0 W/m² must not register as coverage');
});

test('mergeRecorderWeather — reconstructs WeatherHour (GHI + cloud) for the soiling/training window', () => {
  const epoch = he(Date.UTC(2026, 5, 5, 12, 0, 0)); // 8 days back of a 30-day window
  const wxByHour = new Map<number, WeatherHour>();
  const ghiByEpoch = new Map<number, number>();
  mergeRecorderWeather(
    wxByHour, ghiByEpoch,
    [ghiRow(epoch, 540)],
    [{ ts: epoch * HOUR, value: 18 }],
  );
  assert.equal(ghiByEpoch.get(epoch), 540);
  const reconstructed = wxByHour.get(epoch);
  assert.ok(reconstructed, 'WeatherHour reconstructed for soiling consumer');
  assert.equal(reconstructed!.radiationWm2, 540);
  assert.equal(reconstructed!.cloudCoverPct, 18, 'cloud_pct paired by hour-epoch');
});

test('mergeRecorderWeather — missing cloud_pct defaults to 0 (clear), GHI still present', () => {
  const epoch = he(Date.UTC(2026, 5, 6, 12, 0, 0));
  const wxByHour = new Map<number, WeatherHour>();
  const ghiByEpoch = new Map<number, number>();
  mergeRecorderWeather(wxByHour, ghiByEpoch, [ghiRow(epoch, 500)], []);
  assert.equal(wxByHour.get(epoch)!.cloudCoverPct, 0);
  assert.equal(ghiByEpoch.get(epoch), 500);
});

/* ─── P2-5: MPPT efficiency capped ≤100% ───────────────────────────── */

test('cappedMedianEffPct — median above 100 is capped at 100 (no >100% MPPT headline)', () => {
  // Register skew pushes the ratio just over 100 (passed the 100.5 per-sample gate).
  assert.equal(cappedMedianEffPct([100.2, 100.4, 100.1]), 100);
});

test('cappedMedianEffPct — a healthy sub-100 median is returned unchanged', () => {
  assert.equal(cappedMedianEffPct([96, 97, 98]), 97);
});

test('cappedMedianEffPct — empty input returns null', () => {
  assert.equal(cappedMedianEffPct([]), null);
});

test('cappedMedianEffPct — every output is ≤100 across a noisy mix', () => {
  for (const xs of [[99, 100, 101], [100.5, 100.5], [50, 100.4]]) {
    const eff = cappedMedianEffPct(xs);
    assert.ok(eff != null && eff <= 100, `eff ${eff} must be ≤100`);
  }
});

/* ─── P3-4: diurnal backtest baseline ──────────────────────────────── */

test('diurnalBaselinePredictor — night predicts ≈0, noon predicts ≈peak (not a flat line)', () => {
  const curve = new Array(24).fill(0);
  curve[12] = 5000; // midday peak Wh
  curve[2] = 0;     // 2am
  const predict = diurnalBaselinePredictor(curve);
  // Use a fixed UTC day; getHours() is local, so assert via the same Date.
  const at = (hourOfDay: number) => {
    const d = new Date(2026, 5, 1, hourOfDay, 0, 0);
    return predict(d.getTime());
  };
  assert.equal(at(2), 0, 'night must predict ~0');
  assert.equal(at(12), 5000, 'noon must predict the peak');
  assert.notEqual(at(12), at(2), 'a real baseline must NOT be flat across the day');
});

test('diurnalBaselinePredictor — short / NaN curve is normalized to safe 24 slots', () => {
  const predict = diurnalBaselinePredictor([NaN, undefined as unknown as number]);
  const d = new Date(2026, 5, 1, 12, 0, 0);
  assert.equal(predict(d.getTime()), 0, 'missing/NaN slots clamp to 0, no crash');
});
