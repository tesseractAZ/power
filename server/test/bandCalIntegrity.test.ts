import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v1.31.0 — band-calibration INTEGRITY (audit follow-ups to the v1.30.0
 * dormancy fix):
 *   1. DENOMINATOR: errors scored %-of-PREDICTED (matching how the half-width
 *      is applied), not the skill report's errorPct (%-of-actual).
 *   2. BIAS BASIS: the calibrator adjusts each day's prediction by the
 *      forecast's pvBiasFactor — the band wraps the bias-corrected series, so
 *      it must be scored against that series' errors.
 *   3. ESTIMATOR: quantile rank k = ceil(0.8·(n+1)) keeps E[coverage] ≥ 0.8
 *      for every n (nearest-rank ceil(0.8n) dipped to ~0.75 for most n>14).
 *   4. DIAGNOSTICS: calScoredDays + bandRealizedCoveragePct published so the
 *      "≥80%, conservatively wide" claim is continuously measurable.
 *   5. ARCHIVE: recorder persists the issued next-24h PV forecast under SN
 *      "forecast" (hour-snapped, idempotent, change-detected) for future
 *      out-of-sample scoring.
 */

// Hermetic DB for the recorder-archive tests (set BEFORE importing recorder).
const tmp = mkdtempSync(join(tmpdir(), 'ef-bandcal-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const {
  pvBandScoredErrs,
  pvBandRealizedHalfFrac,
  computeProbabilisticForecast,
  resetForecastCachesForTesting,
} = await import('../src/analytics.js');
const { setWeatherCacheForTesting, clearWeatherTestOverride } = await import('../src/weather.js');
const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

type SkillDays = import('../src/analytics.js').ForecastSkillReport['days'];
type DayForecast = import('../src/analytics.js').DayForecast;
type ForecastSkillReport = import('../src/analytics.js').ForecastSkillReport;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A scored day with explicit predicted/actual (errorPct set only as the
 *  non-null scoring gate — the calibrator derives its own error basis). */
function day(predictedKwh: number, actualKwh: number): SkillDays[number] {
  return {
    date: '2026-06-01',
    predictedKwh,
    actualKwh,
    errorKwh: predictedKwh - actualKwh,
    errorPct: Math.round(((predictedKwh - actualKwh) / actualKwh) * 1000) / 10,
    weatherCovered: true,
  };
}

/* ── 1. denominator: %-of-predicted, not %-of-actual ─────────────── */

test('v1.31.0 — errors are |actual − pred| / PRED (the band’s own denominator)', () => {
  // pred 50, actual 100: %-of-actual reads 50%; %-of-predicted reads 100%.
  // Under under-prediction the old basis was anti-conservative — the band
  // (applied as a fraction of P50) needed the 100% figure to cover this day.
  const errs = pvBandScoredErrs([day(50, 100)]);
  assert.equal(errs.length, 1);
  assert.ok(Math.abs(errs[0] - 1.0) < 1e-9, `expected 1.0 (=50/50), got ${errs[0]}`);
});

/* ── 2. bias basis: score against the bias-corrected prediction ──── */

test('v1.31.0 — pvBiasFactor shifts the scoring basis to the published series', () => {
  // Raw model predicts 50, publication multiplies by biasFactor 1.2 → the
  // band wraps 60. Actual 57: error vs the PUBLISHED series is 3/60 = 5%,
  // not the raw-model 7/50 = 14%.
  const errs = pvBandScoredErrs([day(50, 57)], 1.2);
  assert.equal(errs.length, 1);
  assert.ok(Math.abs(errs[0] - 0.05) < 1e-9, `expected 0.05, got ${errs[0]}`);
  // Null / non-finite / non-positive bias degrades to 1 (raw basis).
  assert.ok(Math.abs(pvBandScoredErrs([day(50, 57)], null)[0] - 0.14) < 1e-9);
  assert.ok(Math.abs(pvBandScoredErrs([day(50, 57)], 0)[0] - 0.14) < 1e-9);
});

test('v1.31.0 — a near-zero adjusted prediction is unscorable and drops out', () => {
  assert.equal(pvBandScoredErrs([day(0.3, 40)]).length, 0);
});

/* ── 3. estimator: k = ceil(0.8·(n+1)), E[coverage] ≥ 0.8 for all n ─ */

test('v1.31.0 — at n=15 the quantile takes the 13th smallest (old rank under-covered)', () => {
  // 15 distinct errors 1%..15% (pred 100, actual 100+i). Old nearest-rank
  // ceil(0.8·15)=12 → 12% (E[coverage]=12/16=0.75); corrected
  // ceil(0.8·16)=13 → 13% (E=13/16≈0.81).
  const days = Array.from({ length: 15 }, (_, i) => day(100, 100 + (i + 1)));
  const q = pvBandRealizedHalfFrac(days);
  assert.ok(q != null && Math.abs(q - 0.13) < 1e-9, `expected 0.13, got ${q}`);
});

test('v1.31.0 — at n=14 the corrected rank coincides with the old one (12th smallest)', () => {
  // ceil(0.8·15)=12 and ceil(0.8·14)=12 — the v1.23.0 F30 tests stay valid.
  const days = Array.from({ length: 14 }, (_, i) => day(100, 100 + (i + 1)));
  const q = pvBandRealizedHalfFrac(days);
  assert.ok(q != null && Math.abs(q - 0.12) < 1e-9, `expected 0.12, got ${q}`);
});

/* ── 4. published diagnostics ────────────────────────────────────── */

function forecast24(pvBiasFactor?: number): DayForecast {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const start = base.getTime() + DAY;
  const hours = Array.from({ length: 24 }, (_, h) => ({
    ts: start + h * HOUR,
    forecastPvW: h >= 7 && h <= 18 ? 3_000 : 0,
    forecastLoadW: 1_000,
    projectedSocPct: 50 + h * 0.5,
  }));
  return {
    hours, reserveSoc: 20, pvCeilingW: 20_000, deviceModels: [{}, {}, {}],
    ...(pvBiasFactor != null ? { pvBiasFactor } : {}),
  } as unknown as DayForecast;
}

const skillReport = (days: SkillDays): ForecastSkillReport => ({
  generatedAt: 0, days, meanAbsErrorKwh: 3, meanAbsErrorPct: 6, biasFactor: 1, windowDays: 30,
});

beforeEach(() => { resetForecastCachesForTesting(); setWeatherCacheForTesting(null); });
afterEach(() => { clearWeatherTestOverride(); delete process.env.PV_BAND_SIGMA_CAL; });

test('v1.31.0 — payload publishes calScoredDays + bandRealizedCoveragePct (tight errors ⇒ 100%)', async () => {
  const days = Array.from({ length: 20 }, () => day(50, 54)); // 8% of predicted
  const r = await computeProbabilisticForecast(forecast24(), skillReport(days));
  assert.equal(r.calScoredDays, 20);
  // Floored band (≈0.4 × raw ≫ 8%) covers every scored day.
  assert.equal(r.bandRealizedCoveragePct, 100);
  assert.ok(r.bandSigmaCal != null && r.bandSigmaCal < 1, 'calibration engaged');
});

test('v1.31.0 — no skill report ⇒ diagnostics are 0 scored days / null coverage', async () => {
  const r = await computeProbabilisticForecast(forecast24(), null);
  assert.equal(r.calScoredDays, 0);
  assert.equal(r.bandRealizedCoveragePct, null);
});

/* ── 5. forecast archive series ──────────────────────────────────── */

test('v1.31.0 — recordForecastArchive: hour-snapped, idempotent, change-detected', () => {
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  const BASE = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);
  rec.recordForecastArchive(70_000, BASE + 5 * 60_000);      // snaps to BASE
  rec.recordForecastArchive(71_000, BASE + 20 * 60_000);     // same hour → idempotent no-op
  rec.recordForecastArchive(70_100, BASE + HOUR);            // +0.14% vs prev → change-detected no-op
  rec.recordForecastArchive(80_000, BASE + 2 * HOUR);        // real change → written
  rec.recordForecastArchive(-5, BASE + 3 * HOUR);            // invalid → ignored
  rec.recordForecastArchive(Number.NaN, BASE + 4 * HOUR);    // invalid → ignored
  const rows = rec.query('forecast', 'pv_next24_wh', BASE - HOUR, BASE + 5 * HOUR, 0);
  assert.deepEqual(
    rows.map((r) => ({ ts: r.ts, value: r.value })),
    [{ ts: BASE, value: 70_000 }, { ts: BASE + 2 * HOUR, value: 80_000 }],
  );
  rec.close();
});
