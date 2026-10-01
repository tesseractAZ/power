import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  costSurplusLoadFactor, measuredHourlyLoadFloorW, costSurplusLoadW, costMorningSurplusKwh,
  debiasedCostSurplusKwh, buildNightChargeInputs, computeNightChargePlan,
  COST_SURPLUS_LOAD_LOOKBACK_DAYS, COST_SURPLUS_LOAD_MIN_SAMPLES, COST_SURPLUS_LOAD_FULL_SAMPLES,
  COST_SURPLUS_LOAD_FACTOR_MIN, COST_SURPLUS_FLOOR_DAYS, COST_SURPLUS_FLOOR_MIN_DAYS,
  type MorningSurplusHour,
} from '../src/nightChargeAdvisor.js';

/**
 * v1.187.1 — the cost ceiling's morning surplus on a DE-BIASED load.
 *
 * The cost ceiling leaves room for Σ max(0, P50 PV − forecast load) over window close → +14 h.
 * The forecast load ran above the measured load on every ledger night of 2026-09-22..28
 * (load_err_frac −0.26 to −0.43, the actual under the load P10 each time). The 09-29 plan's
 * ceiling of 77.7% (a 20.55 kWh headroom) bought ~18.9 kWh, all economic; the pool was full by
 * 13:00 on 09-30 and ~9-12 kWh of PV was curtailed until ~16:00.
 */

const H = 3_600_000;
const POOL = 92.16;

/** The ledger's load_err_frac on the nights 2026-09-22..28 (the rows the 09-29 plan could read). */
const LEDGER_0922_0928 = [-0.26, -0.40, -0.29, -0.43, -0.35, -0.32, -0.34].map((e) => ({ load_err_frac: e }));

/**
 * The 09-29 plan's morning, 05:00-18:00 on 09-30 (W). The plan's hourly band is not persisted;
 * this is the hourly shape of the next plan's band (issued 09-30 for 10-01, which reproduces that
 * plan's recorded 22.04 kWh surplus exactly), with the P50 PV scaled ×0.966 so the raw surplus is
 * the 09-29 row's recorded 20.55 kWh (ceiling 77.7%). FLOOR = the least hourly-mean panel load
 * in each clock hour over the 7 days before the 09-29 plan (measured, every hour seen 7 days).
 */
const P50_W = [0, 94, 608, 2647, 4725, 6276, 6635, 6695, 6243, 5274, 3938, 2057, 573, 21];
const LOAD_W = [2188, 1864, 1646, 2068, 1851, 2158, 2202, 2927, 3228, 4020, 3435, 3738, 3205, 2978];
const FLOOR_W = [1427, 1231, 1232, 1441, 1413, 1403, 1354, 1625, 1462, 1443, 1425, 1294, 1333, 1497];
const hours0929 = (floor: ReadonlyArray<number | null> = FLOOR_W): MorningSurplusHour[] =>
  P50_W.map((p50W, i) => ({ p50W, p90W: p50W * 1.3, loadW: LOAD_W[i], evW: 0, floorW: floor[i] }));

/* ══ the factor ═══════════════════════════════════════════════════════════ */

test('the knobs', () => {
  assert.equal(COST_SURPLUS_LOAD_LOOKBACK_DAYS, 14);
  assert.equal(COST_SURPLUS_LOAD_MIN_SAMPLES, 5);
  assert.equal(COST_SURPLUS_LOAD_FULL_SAMPLES, 10);
  assert.equal(COST_SURPLUS_LOAD_FACTOR_MIN, 0.6);
  assert.equal(COST_SURPLUS_FLOOR_DAYS, 7);
  assert.equal(COST_SURPLUS_FLOOR_MIN_DAYS, 4);
});

test('★★★ the 09-22..28 ledger: median realized/forecast 0.66, seven nights ⇒ ×0.762', () => {
  const f = costSurplusLoadFactor(LEDGER_0922_0928);
  assert.equal(f.basis, 'measured');
  assert.equal(f.samples, 7);
  assert.equal(f.medianRatio, 0.66);
  // 1 + (7/10) × (0.66 − 1) = 0.762: the correction is 70% in at seven nights.
  assert.equal(f.factor, 0.762);
});

test('★★★ FEW SAMPLES: under five ledger nights the forecast load stands as is', () => {
  for (const n of [0, 1, 4]) {
    const f = costSurplusLoadFactor(LEDGER_0922_0928.slice(0, n));
    assert.equal(f.factor, 1, `${n} night(s)`);
    assert.equal(f.basis, 'default');
    assert.equal(f.samples, n);
    assert.equal(f.medianRatio, null);
  }
  // Five is enough, and only half the correction is in.
  const five = costSurplusLoadFactor(Array.from({ length: 5 }, () => ({ load_err_frac: -0.3 })));
  assert.equal(five.basis, 'measured');
  assert.equal(five.factor, 0.85);
});

test('★★★ the correction is whole from ten nights on, never more', () => {
  const at = (n: number) => costSurplusLoadFactor(Array.from({ length: n }, () => ({ load_err_frac: -0.3 }))).factor;
  assert.equal(at(8), 0.76);
  assert.equal(at(10), 0.7);
  assert.equal(at(14), 0.7);
});

test('★★★ SHRINK-ONLY: a ledger whose load ran at or above the forecast leaves the load alone', () => {
  const high = costSurplusLoadFactor([0.05, 0.12, 0, 0.3, 0.08, 0.21, 0.02].map((e) => ({ load_err_frac: e })));
  assert.equal(high.basis, 'measured');
  assert.equal(high.factor, 1, 'never scales the load UP — that would raise a ceiling');
  assert.ok(high.medianRatio! > 1);
});

test('★★ BOUNDED: a broken ledger (a telemetry gap under-counts the actual) cannot drive the load past ×0.6', () => {
  const f = costSurplusLoadFactor(Array.from({ length: 12 }, () => ({ load_err_frac: -0.8 })));
  assert.equal(f.factor, COST_SURPLUS_LOAD_FACTOR_MIN);
});

test('★★ the median of an even count is the mean of the middle two', () => {
  // 09-23..28: ratios 0.57 0.60 0.65 | 0.66 0.68 0.71 ⇒ 0.655; six nights ⇒ 1 − 0.6 × 0.345.
  const f = costSurplusLoadFactor(LEDGER_0922_0928.slice(1));
  assert.equal(f.medianRatio, 0.655);
  assert.equal(f.factor, 0.793);
});

test('★★ unscored rows, non-numbers and impossible ratios are not samples', () => {
  const f = costSurplusLoadFactor([
    ...LEDGER_0922_0928,
    { load_err_frac: null }, {}, { load_err_frac: Number.NaN }, { load_err_frac: -1 }, { load_err_frac: -1.5 },
  ]);
  assert.equal(f.samples, 7);
  assert.equal(f.factor, 0.762);
});

/* ══ the physical floor ═══════════════════════════════════════════════════ */

const DAY = 24 * H;
const T0 = Date.UTC(2026, 8, 22, 7); // 2026-09-22 00:00 MST
const hourOfMst = (ts: number) => new Date(ts - 7 * H).getUTCHours();

test('★★★ the floor is the least hourly mean in each clock hour; an hour seen on under four days has none', () => {
  const pts: Array<{ ts: number; value: number }> = [];
  for (let d = 0; d < 7; d++) {
    pts.push({ ts: T0 + d * DAY + 9 * H, value: 1400 + d * 100 }); // 09:00 every day
    if (d < 3) pts.push({ ts: T0 + d * DAY + 10 * H, value: 900 }); // 10:00 on three days only
    if (d < 4) pts.push({ ts: T0 + d * DAY + 11 * H, value: 1200 - d * 50 }); // 11:00 on four
  }
  const floor = measuredHourlyLoadFloorW(pts, hourOfMst);
  assert.equal(floor.length, 24);
  assert.equal(floor[9], 1400);
  assert.equal(floor[10], null, 'three days is not a floor');
  assert.equal(floor[11], 1050, 'four days is');
  assert.equal(floor[3], null);
});

test('★★ a negative or non-finite reading is not a floor', () => {
  const pts = [0, 1, 2, 3].map((d) => ({ ts: T0 + d * DAY + 8 * H, value: 1500 }));
  pts.push({ ts: T0 + 4 * DAY + 8 * H, value: -200 }, { ts: T0 + 5 * DAY + 8 * H, value: Number.NaN });
  assert.equal(measuredHourlyLoadFloorW(pts, hourOfMst)[8], 1500);
});

/* ══ one hour's load ══════════════════════════════════════════════════════ */

test('★★★ an hour is scaled by the factor but never below its measured floor, nor above its forecast', () => {
  assert.equal(costSurplusLoadW({ loadW: 3000, factor: 0.7, floorW: 1000 }), 2100);
  assert.equal(costSurplusLoadW({ loadW: 3000, factor: 0.7, floorW: 2500 }), 2500, 'the floor binds');
  assert.equal(costSurplusLoadW({ loadW: 3000, factor: 0.7, floorW: 4000 }), 3000, 'a floor above the forecast restores it, never more');
});

test('★★★ an hour with no measured floor, or a factor of 1, keeps its forecast', () => {
  assert.equal(costSurplusLoadW({ loadW: 3000, factor: 0.7, floorW: null }), 3000);
  assert.equal(costSurplusLoadW({ loadW: 3000, factor: 0.7, floorW: undefined }), 3000);
  assert.equal(costSurplusLoadW({ loadW: 3000, factor: 0.7, floorW: Number.NaN }), 3000);
  assert.equal(costSurplusLoadW({ loadW: 3000, factor: 1, floorW: 0 }), 3000);
  assert.equal(costSurplusLoadW({ loadW: 3000, factor: 1.2, floorW: 0 }), 3000);
  assert.equal(costSurplusLoadW({ loadW: 3000, factor: Number.NaN, floorW: 0 }), 3000);
});

test('★★★ a predicted EV block is kept whole — the factor de-biases the house curve only', () => {
  // 3000 W forecast of which 1000 W is the expected-value EV block: 2000 × 0.7 + 1000.
  assert.equal(costSurplusLoadW({ loadW: 3000, evW: 1000, factor: 0.7, floorW: 0 }), 2400);
  // The floor is compared with the house's own part, then the EV block is added back.
  assert.equal(costSurplusLoadW({ loadW: 3000, evW: 1000, factor: 0.7, floorW: 1800 }), 2800);
  // An EV figure past the forecast cannot make the house part negative.
  assert.equal(costSurplusLoadW({ loadW: 3000, evW: 5000, factor: 0.7, floorW: 0 }), 3000);
});

/* ══ the morning surplus ══════════════════════════════════════════════════ */

test('★★★ the 09-29 morning: ~20.55 kWh on the forecast load, 25.75 kWh on the de-biased one', () => {
  const raw = costMorningSurplusKwh(hours0929(), 1);
  assert.equal(raw.p50Kwh, 20.54, 'the 09-29 row recorded 20.55 (ceiling 77.7%); the hourly reconstruction rounds to 20.54');
  const deb = costMorningSurplusKwh(hours0929(), 0.762);
  assert.equal(deb.p50Kwh, 25.75);
  assert.ok(deb.p90Kwh! > raw.p90Kwh!, 'the P90 that stands in is de-biased the same way');
});

test('★★★ a genuinely high load — the house drew its forecast every day this week — leaves the surplus unchanged', () => {
  const raw = costMorningSurplusKwh(hours0929(LOAD_W), 1);
  const deb = costMorningSurplusKwh(hours0929(LOAD_W), 0.762);
  assert.deepEqual(deb, raw, 'the measured floor IS the forecast: nothing to de-bias');
});

test('★★ nulls exactly where the raw figures are: no hour, or an hour without a P50', () => {
  assert.deepEqual(costMorningSurplusKwh([], 0.7), { p50Kwh: null, p90Kwh: null });
  const gap = hours0929();
  gap[6] = { ...gap[6], p50W: null };
  const r = costMorningSurplusKwh(gap, 0.7);
  assert.equal(r.p50Kwh, null);
  assert.ok(r.p90Kwh != null && r.p90Kwh > 0);
});

/* ══ the headroom the ceiling uses ════════════════════════════════════════ */

test('★★★ the de-biased surplus is used only where it is WIDER, never past the resilience target', () => {
  const o = { fullKwh: POOL, resilienceTargetKwh: 40 };
  assert.equal(debiasedCostSurplusKwh({ ...o, rawKwh: 20, debiasedKwh: 25 }), 25);
  assert.equal(debiasedCostSurplusKwh({ ...o, rawKwh: 20, debiasedKwh: 18 }), 20, 'a narrower figure never raises a ceiling');
  assert.equal(debiasedCostSurplusKwh({ ...o, rawKwh: 20, debiasedKwh: 20 }), 20);
  // Resilience target 70 kWh ⇒ the de-biased ceiling stops at 70 (headroom 22.16), not at 92.16 − 25.
  assert.equal(debiasedCostSurplusKwh({ ...o, resilienceTargetKwh: 70, rawKwh: 20, debiasedKwh: 25 }), POOL - 70);
  // …unless the raw ceiling already sat below the resilience target: then the raw figure stands.
  assert.equal(debiasedCostSurplusKwh({ ...o, resilienceTargetKwh: 80, rawKwh: 20, debiasedKwh: 25 }), 20);
});

test('★★ an unknown raw surplus, or an unknown de-biased one, is today\'s behaviour', () => {
  const o = { fullKwh: POOL, resilienceTargetKwh: 40 };
  assert.equal(debiasedCostSurplusKwh({ ...o, rawKwh: null, debiasedKwh: 25 }), null);
  assert.equal(debiasedCostSurplusKwh({ ...o, rawKwh: 20, debiasedKwh: null }), 20);
  assert.equal(debiasedCostSurplusKwh({ ...o, rawKwh: 20, debiasedKwh: undefined }), 20);
  assert.equal(debiasedCostSurplusKwh({ ...o, rawKwh: 20, debiasedKwh: Number.NaN }), 20);
});

/* ══ the planner ══════════════════════════════════════════════════════════ */

/** The raw P50 surplus of the reconstructed 09-29 morning (index.ts's own sum, factor 1). */
const RAW_0929 = costMorningSurplusKwh(hours0929(), 1).p50Kwh;
/** 21:30 MST on 2026-09-29 (a Tuesday); the band is a flat stand-in, the surplus is the input. */
const EVE = Date.UTC(2026, 8, 30, 4, 30);
const overnightPeriodIdAt = (ms: number): string | null => {
  const h = new Date(ms).getUTCHours();
  return h >= 6 && h < 12 ? 'overnight' : 'other';
};
const mkHorizon = (from: number, n: number, pvW: number, loadW: number) =>
  Array.from({ length: n }, (_, i) => ({ ts: from + i * H, pvP10W: pvW, loadP90W: loadW }));
function deps(over: Record<string, unknown> = {}) {
  return {
    gridInputCapKw: null, nowMs: EVE, fullKwh: POOL, socNowPct: 74,
    reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 18,
    periodIdAt: overnightPeriodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: mkHorizon(EVE, 30, 0, 1500),
    dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: null,
    ev: null, evMaxLoadW: 11520, confidenceTier: 'forecast', forecastPresent: true,
    calScoredDays: 30, minCalScoredDays: 7, bandCoverageFrac: 0.9,
    morningPvSurplusP90Kwh: 41, morningPvSurplusP50Kwh: RAW_0929, minBuyKwh: 1, buyDebiasFactor: 1,
    islandedLoadKw: 2.66, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90, longGapAhead: false,
    ...over,
  } as never;
}
const plan = (over: Record<string, unknown> = {}): any => computeNightChargePlan(buildNightChargeInputs(deps(over)));
/** What index.ts hands the planner for a ledger and a morning. */
const surplusLoad = (rows: Array<{ load_err_frac: number }>, hours = hours0929()) => {
  const f = costSurplusLoadFactor(rows);
  return { factor: f.factor, basis: f.basis, samples: f.samples, ...costMorningSurplusKwh(hours, f.factor) };
};

test('★★★ THE 09-29 NIGHT: the de-biased load lowers the ceiling 77.7% → 72.1% and the buy with it', () => {
  const before = plan();
  assert.equal(before.costCeilingSocPct, 77.7, 'the recorded 09-29 ceiling');
  assert.equal(before.costCeilingSurplusKwh, 20.54);
  const after = plan({ costSurplusLoad: surplusLoad(LEDGER_0922_0928) });
  assert.equal(after.costCeilingSocPct, 72.1);
  assert.equal(after.costCeilingSurplusKwh, 25.75);
  assert.equal(after.costCeilingSurplusRawKwh, 20.54, 'the figure the forecast load alone gave, kept for audit');
  assert.equal(after.costSurplusLoadFactor, 0.762);
  assert.equal(after.costSurplusLoadSamples, 7);
  assert.equal(after.costCeilingSurplusBasis, 'p50');
  assert.ok(after.buyKwh < before.buyKwh - 4, `buy ${before.buyKwh} → ${after.buyKwh}`);
  assert.ok(after.targetSocPct < before.targetSocPct);
  assert.match(after.rationale, /×0\.762 of its forecast from 7 realized nights; ~20\.5 kWh on the forecast as is/);
  // Nothing the resilience side computes moved. (An economic-only night asks the panel for the
  // cost target itself — v1.174.0 — so its setpoint follows the ceiling down.)
  assert.equal(before.requiredExtraKwh, 0, 'the 09-29 buy was economic only');
  assert.equal(after.requiredExtraKwh, before.requiredExtraKwh);
  assert.equal(after.setpointSocPct, after.targetSocPct);
  assert.equal(after.cushionKwh, before.cushionKwh);
  assert.equal(after.cushionShortfall, before.cushionShortfall);
  assert.equal(after.minProjSocPct, before.minProjSocPct);
  assert.equal(after.cushionTroughSocPct, before.cushionTroughSocPct);
});

test('★★★ a night with few ledger samples is today\'s night exactly', () => {
  const before = plan();
  const after = plan({ costSurplusLoad: surplusLoad(LEDGER_0922_0928.slice(0, 4)) });
  for (const k of ['costCeilingSocPct', 'costCeilingSurplusKwh', 'buyKwh', 'targetSocPct', 'setpointSocPct', 'rationale']) {
    assert.deepEqual(after[k], before[k], k);
  }
  assert.equal(after.costSurplusLoadFactor, 1);
});

test('★★★ a night with a genuinely high load is today\'s night exactly', () => {
  const before = plan();
  // The ledger's load ran at/above its forecast: no de-bias at all.
  const highLedger = [0.05, 0.12, 0, 0.3, 0.08, 0.21, 0.02].map((e) => ({ load_err_frac: e }));
  // A biased ledger, but the house drew its forecast in every morning hour all week.
  const highMorning = surplusLoad(LEDGER_0922_0928, hours0929(LOAD_W));
  for (const sl of [surplusLoad(highLedger), highMorning]) {
    const after = plan({ costSurplusLoad: sl });
    for (const k of ['costCeilingSocPct', 'costCeilingSurplusKwh', 'buyKwh', 'targetSocPct', 'rationale']) {
      assert.deepEqual(after[k], before[k], k);
    }
  }
});

test('★★★ the de-bias never lowers the ceiling below the resilience target', () => {
  // A lower pack and a 10 kW islanded load: the resilience target is 73.7%, above the 72.1%
  // the de-biased surplus alone would set.
  const lowPack = { socNowPct: 40, islandedLoadKw: 10 };
  const before = plan(lowPack);
  const after = plan({ ...lowPack, costSurplusLoad: surplusLoad(LEDGER_0922_0928) });
  assert.equal(before.costCeilingSocPct, 77.7);
  assert.equal(after.costCeilingSocPct, 73.7, 'it lowers the ceiling, and stops at the resilience target');
  assert.equal(after.targetSocPct, 73.7, 'the force-charge stop is the target itself');
  assert.equal(after.requiredExtraKwh, before.requiredExtraKwh);
  assert.equal(after.setpointSocPct, before.setpointSocPct);
  assert.equal(after.cushionShortfall, before.cushionShortfall);
  // A resilience target above the raw ceiling: the raw ceiling stands, the de-bias adds nothing.
  const higher = { socNowPct: 40, islandedLoadKw: 11 };
  assert.equal(plan({ ...higher, costSurplusLoad: surplusLoad(LEDGER_0922_0928) }).costCeilingSocPct, plan(higher).costCeilingSocPct);
});

test('★★★ the P90 stand-in is de-biased too, and a long-gap night is untouched', () => {
  const sl = surplusLoad(LEDGER_0922_0928);
  const p90 = plan({ morningPvSurplusP50Kwh: null, morningPvSurplusP90Kwh: 30, costSurplusLoad: { ...sl, p50Kwh: null, p90Kwh: 36 } });
  assert.equal(p90.costCeilingSurplusBasis, 'p90');
  assert.equal(p90.costCeilingSurplusKwh, 36);
  assert.equal(p90.costCeilingSurplusRawKwh, 30);
  const gap = { longGapAhead: true, prePeakPvSurplusP10Kwh: 12 };
  const a = plan(gap);
  const b = plan({ ...gap, costSurplusLoad: sl });
  assert.equal(b.costCeilingSurplusBasis, 'p10');
  assert.equal(b.costCeilingSurplusKwh, a.costCeilingSurplusKwh);
  assert.equal(b.costCeilingSocPct, a.costCeilingSocPct);
  assert.equal(b.buyKwh, a.buyKwh);
  assert.equal(b.costSurplusLoadFactor, null, 'a long-gap night reports no de-bias');
  assert.equal(b.costSurplusLoadSamples, null);
  assert.doesNotMatch(b.rationale, /of its forecast/);
});

test('★★★ resilience mode is untouched', () => {
  const a = plan({ objectiveMode: 'resilience' });
  const b = plan({ objectiveMode: 'resilience', costSurplusLoad: surplusLoad(LEDGER_0922_0928) });
  assert.equal(b.buyKwh, a.buyKwh);
  assert.equal(b.targetSocPct, a.targetSocPct);
  assert.equal(b.bindingCap, a.bindingCap);
  assert.equal(b.rationale, a.rationale);
  assert.equal(b.costCeilingSurplusRawKwh, undefined);
});

test('★★ a cost-mode HOLD reports the same headroom fields', () => {
  // A pack already above the de-biased ceiling: nothing to buy.
  const p = plan({ socNowPct: 95, costSurplusLoad: surplusLoad(LEDGER_0922_0928) });
  assert.equal(p.objective, 'none');
  assert.equal(p.costCeilingSocPct, 72.1);
  assert.equal(p.costCeilingSurplusRawKwh, 20.54);
  assert.equal(p.costSurplusLoadFactor, 0.762);
});

test('★★★ SWEEP: the de-bias never raises a ceiling, a target or a buy, and never moves the resilience side', () => {
  let lowered = 0;
  for (const socNowPct of [20, 40, 60, 74, 90]) {
    for (const islandedLoadKw of [1.5, 4, 10]) {
      for (const errs of [[-0.4], [-0.3, -0.35, -0.3, -0.32, -0.4], [-0.2, -0.3, -0.25, -0.3, -0.35, -0.3, -0.28, -0.31, -0.3, -0.33], [0.1, 0.2, 0.05, 0.15, 0.1]]) {
        for (const floor of [FLOOR_W, LOAD_W, P50_W.map(() => null)]) {
          for (const p50 of [true, false]) {
            const base = { socNowPct, islandedLoadKw, ...(p50 ? {} : { morningPvSurplusP50Kwh: null }) };
            const a = plan(base);
            const b = plan({ ...base, costSurplusLoad: surplusLoad(errs.map((e) => ({ load_err_frac: e })), hours0929(floor)) });
            const tag = `soc ${socNowPct} island ${islandedLoadKw} n ${errs.length} p50 ${p50}`;
            assert.ok(b.costCeilingSocPct <= a.costCeilingSocPct + 1e-9, `ceiling ${tag}`);
            assert.ok(b.targetSocPct <= a.targetSocPct + 1e-9, `target ${tag}`);
            assert.ok(b.buyKwh <= a.buyKwh + 1e-9, `buy ${tag}`);
            assert.equal(b.requiredExtraKwh, a.requiredExtraKwh, `requirement ${tag}`);
            assert.equal(b.cushionKwh, a.cushionKwh, `cushion ${tag}`);
            assert.equal(b.cushionShortfall, a.cushionShortfall, `shortfall ${tag}`);
            assert.equal(b.minProjSocPct, a.minProjSocPct, `trough ${tag}`);
            // The setpoint is max(cost target, resilience requirement): where the requirement set
            // it, it is unchanged; elsewhere it follows the (lower) cost target.
            if (a.setpointSocPct > a.targetSocPct + 0.05) assert.equal(b.setpointSocPct, a.setpointSocPct, `setpoint ${tag}`);
            assert.ok(b.setpointSocPct >= b.targetSocPct && b.setpointSocPct <= a.setpointSocPct + 1e-9, `setpoint ${tag}`);
            if (b.costCeilingSocPct < a.costCeilingSocPct) lowered++;
          }
        }
      }
    }
  }
  assert.ok(lowered > 20, `the sweep exercises the change (${lowered} lowered ceilings)`);
});

/* ══ integration pins (index.ts has no seam a unit test can drive) ════════ */

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('★★★ index.ts builds the de-biased surplus from the ledger, the week\'s hourly load and the same hours', () => {
  assert.ok(INDEX.includes('morningHours.push({ ts: pb.ts, p50W: pb.p50W, p90W: pb.p90W, loadW: fh.forecastLoadW, evW: fh.predictedEvLoadW ?? 0 });'),
    'the same hours as the raw surplus, with the EV block');
  assert.ok(INDEX.includes('recorder.readNightLedger(COST_SURPLUS_LOAD_LOOKBACK_DAYS)'));
  assert.ok(INDEX.includes(".query(shp2.sn, 'panel_load', nowMs - COST_SURPLUS_FLOOR_DAYS * 24 * HOUR_MS, nowMs, 3600)"),
    'the floor is the house panel\'s own load, hourly, over the trailing week');
  assert.ok(INDEX.includes('floorW: floorByHour ? floorByHour[localParts(h.ts, tz).hour] : null'));
  assert.ok(INDEX.includes("if (objectiveMode === 'cost' && costLoadCal.factor < 1 && morningHours.length > 0) {"));
  assert.ok(INDEX.includes('    costSurplusLoad,\n'), 'it reaches the planner deps — the v1.125.0 trap');
  // The raw surplus is untouched: the P90 over-buy flag and the P50 basis keep the forecast load.
  assert.ok(INDEX.includes('morningSurplusP50Kwh += Math.max(0, pb.p50W - fh.forecastLoadW) / 1000;'));
  assert.ok(INDEX.includes('morningSurplusKwh += Math.max(0, pb.p90W - fh.forecastLoadW) / 1000;'));
});
