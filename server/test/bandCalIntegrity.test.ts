import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* ── 6. v1.149.0 — bandSigmaCal's FIVE states are distinguishable ──────
 *
 * `bandSigmaCal = 1` is what the field reads when the calibration is ACTIVE and
 * saturated, when it never ENGAGED, and when the ratio lands exactly on 1 — and
 * at index.ts's old `?? 1` fallback, when there was no forecast at all. The
 * 2026-09-06 PERFORMANCE.md snapshot read 0.50 and asserted "still above its 0.4
 * floor — data-driven, not floor-pinned", checking the floor ambiguity only.
 * Five days later the field read 1 with realized error at 0.657: `saturated` —
 * the band is too NARROW and `Math.min(1, …)` cannot widen it. Indistinguishable
 * from the v1.23.0 defect in which the calibration sat pinned at 1 having never
 * run.
 *
 * These tests pin the basis to the CAUSE, not to the number, so a refactor that
 * keeps `bandSigmaCal` correct while collapsing the states is killed.
 */

test('v1.149.0 — a WIDE band (realized ≪ produced) reports basis "shrunk", cal < 1', async () => {
  // The shrink window on this fixture is measured, not assumed: 8% error clamps
  // to the 0.4 FLOOR (the v1.31.0 test at the top of this file says so), ~50%+
  // saturates, and ~30% lands interior at cal ≈ 0.61. Picking 8% here — the
  // first guess — produced a test that asserted 'shrunk' against a genuinely
  // floor-pinned tree: the fixture was wrong, not the code.
  resetForecastCachesForTesting();
  const days = Array.from({ length: 20 }, () => day(100, 130));
  const r = await computeProbabilisticForecast(forecast24(), skillReport(days));
  assert.equal(r.bandSigmaCalBasis, 'shrunk');
  assert.ok(r.bandSigmaCal != null && r.bandSigmaCal < 1, `expected <1, got ${r.bandSigmaCal}`);
  assert.ok(r.bandSigmaCal! > 0.4, 'shrunk must be strictly above the floor');
});

test('v1.149.0 — a band too NARROW saturates at 1 and says so ("saturated"), not a benign 1', async () => {
  // Realized daily error ≈ 65% of prediction — far wider than the produced
  // half-width, so the ratio exceeds 1 and clamps. This is TODAY's live state
  // (realizedDailyErrHalfFrac 0.657, coverage 72%), and the whole point of the
  // field: the number is 1, the meaning is "I have found the band too narrow
  // and I am not allowed to widen it."
  resetForecastCachesForTesting();
  const days = Array.from({ length: 20 }, () => day(100, 165));
  const r = await computeProbabilisticForecast(forecast24(), skillReport(days));
  assert.equal(r.bandSigmaCal, 1, 'the published factor is still 1');
  assert.equal(r.bandSigmaCalBasis, 'saturated', 'but it is NOT the neutral 1');
});

test('v1.149.0 — NO skill report ⇒ "uncalibrated", also at a published 1', async () => {
  resetForecastCachesForTesting();
  const r = await computeProbabilisticForecast(forecast24(), null);
  assert.equal(r.bandSigmaCal, 1);
  assert.equal(r.bandSigmaCalBasis, 'uncalibrated');
  // The v1.23.0 defect's signature: identical number, opposite meaning to
  // 'saturated'. If these two ever compare equal, the field has stopped working.
  assert.notEqual(r.bandSigmaCalBasis, 'saturated');
});

test('v1.149.0 — a benign window pinned at the 0.4 floor reports "floor-pinned"', async () => {
  // Near-perfect forecasts: the ratio drives below PV_BAND_CAL_FLOOR and clamps
  // UP. Distinct from 'shrunk' because the floor, not the data, set the value.
  resetForecastCachesForTesting();
  const days = Array.from({ length: 20 }, () => day(100, 100.05));
  const r = await computeProbabilisticForecast(forecast24(), skillReport(days));
  assert.equal(r.bandSigmaCalBasis, 'floor-pinned');
  assert.equal(r.bandSigmaCal, 0.4);
});

test('v1.149.0 — an operator override reports "operator-override", never a data basis', async () => {
  const prev = process.env.PV_BAND_SIGMA_CAL;
  process.env.PV_BAND_SIGMA_CAL = '0.7';
  try {
    // Days that would otherwise saturate: the override must win AND be labelled,
    // so a hand-set factor is never read back as a measurement.
    resetForecastCachesForTesting();
    const days = Array.from({ length: 20 }, () => day(100, 165));
    const r = await computeProbabilisticForecast(forecast24(), skillReport(days));
    assert.equal(r.bandSigmaCal, 0.7);
    assert.equal(r.bandSigmaCalBasis, 'operator-override');
  } finally {
    if (prev == null) delete process.env.PV_BAND_SIGMA_CAL;
    else process.env.PV_BAND_SIGMA_CAL = prev;
  }
});

test('v1.149.0 — the saturation boundary is 1, not "comfortably above 1"', async () => {
  // Boundary pin. The 65% fixture above sits far enough past 1 that moving the
  // threshold to 1.5 left it still reading 'saturated' — the mutation harness
  // caught that as a survivor. This day set lands in the (1, 1.5) gap: already
  // clamped, already under-covering, and a threshold that tolerated it would
  // report a band the calibrator cannot fix as a healthy shrink.
  resetForecastCachesForTesting();
  const days = Array.from({ length: 20 }, () => day(100, 150));
  const r = await computeProbabilisticForecast(forecast24(), skillReport(days));
  assert.equal(r.bandSigmaCal, 1);
  assert.equal(r.bandSigmaCalBasis, 'saturated');
});

/* SOURCE PIN — the ledger's missing-forecast value.
 *
 * `bandSigmaCal` for a ledger row is assembled inside `recomputeNightChargePlan`,
 * a long async closure over module singletons with no injection seam, so this
 * follows the repo's convention for un-reachable call sites (cf. the refreshAll
 * pin in pollHealthAttribution.test.ts).
 *
 * It matters because the column is DURABLE: writing 1 for "there was no
 * probabilistic forecast" files that night, permanently, as "calibration
 * neutral" — and every later reduction over the ledger, the readiness gate
 * included, reads it as a measurement that was taken. */
test('★ SOURCE PIN: a missing probabilistic forecast writes NULL to the ledger, never 1', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/index.ts'), 'utf8');
  // Bound the search on the assignment itself rather than a fixed character
  // window — a window big enough today stops reaching the code as the comment
  // above it grows.
  assert.match(
    src,
    /bandSigmaCal: prob\?\.bandSigmaCal \?\? null,/,
    'the ledger must record null when there is no forecast to calibrate against',
  );
  assert.doesNotMatch(
    src,
    /bandSigmaCal: prob\?\.bandSigmaCal \?\? 1,/,
    '`?? 1` fabricates a neutral calibration factor for a night that had no forecast',
  );
});
