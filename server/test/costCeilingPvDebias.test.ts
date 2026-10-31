import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  costSurplusPvFactor, costSurplusPvW, costMorningSurplusKwh, buildCostSurplusLoad, costSurplusLedgerColumns,
  COST_SURPLUS_PV_FACTOR_MAX, COST_SURPLUS_PV_MIN_FORECAST_KWH, COST_SURPLUS_LOAD_LOOKBACK_DAYS,
  type CostSurplusLoad, type CostSurplusPvRow, type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { pvSaturationColumns, forecastSpanResetColumns } from '../src/nightLedgerScoring.js';
import { forceChargeStopPct } from '../src/nightForceCharge.js';
import { goldenPlan } from './fixtures/overnightTextCases.js';

/**
 * v1.196.0 — THE COST CEILING DE-BIASES THE PV TERM OF ITS MORNING SURPLUS, NOT ONLY THE LOAD.
 *
 * The cost ceiling leaves room for Σ max(0, P50 PV − load) over the morning after the window.
 * v1.187.1 de-biased the load term; the P50 PV went in as forecast. That forecast is censored low
 * on exactly the days the ceiling matters: the solar fit and pvBiasFactor learn from hours when the
 * pool was full and the Cores shed their PV, so a sunny morning's P50 under-states the sun, the
 * surplus comes out small, the ceiling high, and the overnight buy fills room the sun would have.
 * The PV factor is the median realized/forecast P50 PV (1 + pv_err_frac) over forecast-tier rows
 * whose PV verdict stands and whose pool never reached the charge taper — expand-only, at most
 * ×1.3, under the load factor's 5 → 10 night ramp, and never past an hour's own P90.
 */

const row = (e: number, o: Partial<CostSurplusPvRow> = {}): CostSurplusPvRow =>
  ({ pv_err_frac: e, pv_p50_kwh: 30, pv_verdict_set_aside: null, confidence_tier: 'forecast', pv_saturated: 0, ...o });
const TEN = [0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.10, 0.11, 0.12, 0.13].map((e) => row(e));

/* ══ the factor ═══════════════════════════════════════════════════════════ */

test('the knobs', () => {
  assert.equal(COST_SURPLUS_PV_FACTOR_MAX, 1.3);
  assert.equal(COST_SURPLUS_PV_MIN_FORECAST_KWH, 5);
});

test('★★★ ten unsaturated nights whose sun ran 5-13% over the P50: median 1.095, whole ⇒ ×1.095', () => {
  assert.deepEqual(costSurplusPvFactor(TEN), { factor: 1.095, basis: 'measured', samples: 10, medianRatio: 1.095 });
});

test('★★★ the 5 → 10 night ramp: six nights put 60% of the correction in; four are none', () => {
  // 1.05 … 1.10: median (1.07 + 1.08) / 2 = 1.075; 1 + 0.6 × 0.075.
  assert.equal(costSurplusPvFactor(TEN.slice(0, 6)).factor, 1.045);
  assert.deepEqual(costSurplusPvFactor(TEN.slice(0, 4)), { factor: 1, basis: 'default', samples: 4, medianRatio: null });
});

test('★★★ the ramp is WHOLE at ten: past ten nights the factor is the median itself, never more', () => {
  // The lookback holds up to COST_SURPLUS_LOAD_LOOKBACK_DAYS rows. Fourteen at +10%: ×1.10 — a weight
  // left uncapped (14 / 10) would count the sun at ×1.14, past what the ledger measured.
  assert.ok(COST_SURPLUS_LOAD_LOOKBACK_DAYS > 10);
  for (const n of [11, COST_SURPLUS_LOAD_LOOKBACK_DAYS]) {
    assert.deepEqual(costSurplusPvFactor(Array.from({ length: n }, () => row(0.1))),
      { factor: 1.1, basis: 'measured', samples: n, medianRatio: 1.1 }, `${n} nights`);
  }
});

test('★★★ EXPAND-ONLY: a sun that ran under its forecast leaves the P50 as it is', () => {
  const low = costSurplusPvFactor(Array.from({ length: 10 }, () => row(-0.2)));
  assert.equal(low.basis, 'measured');
  assert.equal(low.factor, 1, 'never scales the PV down — that would raise a ceiling');
  assert.equal(low.medianRatio, 0.8);
});

test('★★★ BOUNDED: a ledger past ×1.3 is held at ×1.3', () => {
  assert.equal(costSurplusPvFactor(Array.from({ length: 10 }, () => row(0.6))).factor, COST_SURPLUS_PV_FACTOR_MAX);
});

test('★★★ only rows that measured the sun are samples: set aside, saturated, a near-dark forecast, not forecast-tier', () => {
  const r = costSurplusPvFactor([
    ...TEN,
    row(0.9, { pv_verdict_set_aside: 'band built for Cores 1, 2; actuals from 1, 2, 3' }),
    row(0.9, { pv_saturated: 1 }),
    row(19, { pv_p50_kwh: 0.5 }),
    row(0.9, { pv_p50_kwh: COST_SURPLUS_PV_MIN_FORECAST_KWH - 0.01 }),
    row(0.9, { confidence_tier: 'climatology' }),
    row(0.9, { confidence_tier: 'mixed' }),
    { pv_err_frac: null, pv_p50_kwh: 30, confidence_tier: 'forecast' },
    row(-1), row(-1.5), row(Number.NaN),
  ]);
  assert.equal(r.samples, 10);
  assert.equal(r.factor, 1.095);
  // A row captured before pv_saturated existed (NULL) still counts: censoring only pulls its ratio down.
  assert.equal(costSurplusPvFactor(TEN.map((x) => ({ ...x, pv_saturated: null }))).samples, 10);
  assert.equal(costSurplusPvFactor(TEN.map((x) => ({ ...x, pv_p50_kwh: COST_SURPLUS_PV_MIN_FORECAST_KWH }))).samples, 10, 'the minimum itself is a sample');
});

/* ══ one hour, and the morning ════════════════════════════════════════════ */

test('★★★ an hour\'s P50 × the factor, never past its own P90 and never below the P50', () => {
  assert.equal(costSurplusPvW(6000, 7500, 1.095), 6570);
  assert.equal(costSurplusPvW(6000, 7500, 1.3), 7500, 'the P90 binds');
  assert.equal(costSurplusPvW(6000, 5000, 1.3), 6000, 'a P90 under the P50 never lowers it');
  for (const f of [1, 0.8, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(costSurplusPvW(6000, 7500, f), 6000, `factor ${f}`);
});

test('★★★ the morning: ten hours of 6 kW P50 over 2 kW of load — 40.00 kWh as forecast, 45.70 at ×1.095; the P90 unchanged', () => {
  const hours = Array.from({ length: 10 }, () => ({ p50W: 6000, p90W: 7500, loadW: 2000 }));
  assert.deepEqual(costMorningSurplusKwh(hours, 1), { p50Kwh: 40, p90Kwh: 55 });
  assert.deepEqual(costMorningSurplusKwh(hours, 1, 1.095), { p50Kwh: 45.7, p90Kwh: 55 });
  assert.deepEqual(costMorningSurplusKwh(hours, 1, 1.3), { p50Kwh: 55, p90Kwh: 55 }, 'never past the P90 surplus');
  // With the load factor too: each term de-biased on its own.
  assert.deepEqual(costMorningSurplusKwh(hours.map((h) => ({ ...h, floorW: 0 })), 0.8, 1.095), { p50Kwh: 49.7, p90Kwh: 59 });
});

/* ══ the builder ══════════════════════════════════════════════════════════ */

const MORNING0 = Date.UTC(2026, 9, 1, 12);
const H = 3_600_000;
async function build(rows: ReadonlyArray<{ load_err_frac?: number | null } & CostSurplusPvRow>) {
  const fetched: number[] = [];
  const out = await buildCostSurplusLoad({
    objectiveMode: 'cost', nowMs: MORNING0 - 7.5 * H,
    probHours: Array.from({ length: 10 }, (_, i) => ({ ts: MORNING0 + i * H, p50W: 6000, p90W: 7500 })),
    loadAt: () => ({ forecastLoadW: 2000, predictedEvLoadW: 0 }),
    fromMs: MORNING0, toMs: MORNING0 + 14 * H,
    readLedger: (days) => { assert.equal(days, COST_SURPLUS_LOAD_LOOKBACK_DAYS); return rows; },
    fetchHourlyLoad: async () => { fetched.push(1); return []; },
    hourOf: (ts) => new Date(ts - 7 * H).getUTCHours(),
  });
  return { out, fetched };
}

test('★★★ BUILDER: a ledger whose load ran to forecast and whose sun ran over it builds a surplus (it was null)', async () => {
  const { out, fetched } = await build(TEN.map((r) => ({ ...r, load_err_frac: 0 })));
  assert.ok(out, 'the load factor alone (1) built nothing');
  assert.deepEqual(out!.load, { factor: 1, basis: 'measured', samples: 10, p50Kwh: 45.7, p90Kwh: 55, pvFactor: 1.095, pvSamples: 10 });
  assert.equal(out!.pvMedianRatio, 1.095);
  assert.deepEqual(fetched, [], 'no hourly-load query when the load factor cannot apply');
  // Neither factor applies: null, today's behaviour.
  assert.equal((await build(TEN.map((r) => ({ ...r, load_err_frac: 0, pv_err_frac: -0.1 })))).out, null);
});

/* ══ the planner ══════════════════════════════════════════════════════════ */

/** The 2026-10-12 fixture (cost, max 90, force-charge eligible, line 31.13%) with a 40 kWh P50 morning. */
const MORNING = { morningPvSurplusP50Kwh: 40, morningPvSurplusP90Kwh: 55 };
const PV_LOAD: CostSurplusLoad = { factor: 1, basis: 'measured', samples: 10, p50Kwh: 45.7, p90Kwh: 55, pvFactor: 1.095, pvSamples: 10 };

test('★★★ the planner: the ceiling and the force-charge stop fall 56.6% → 50.4%, the buy with them', () => {
  const before = goldenPlan(MORNING);
  const after = goldenPlan({ ...MORNING, costSurplusLoad: PV_LOAD });
  assert.equal(before.costCeilingSocPct, 56.6, '92.16 − 40 kWh');
  assert.equal(after.costCeilingSocPct, 50.4, '92.16 − 45.70 kWh = 46.46 kWh');
  assert.equal(after.costCeilingSurplusKwh, 45.7);
  assert.equal(after.costCeilingSurplusRawKwh, 40);
  assert.equal(after.costSurplusPvFactor, 1.095);
  assert.equal(after.costSurplusPvSamples, 10);
  assert.equal(after.costSurplusLoadFactor, 1);
  assert.equal(forceChargeStopPct(before.costCeilingSocPct!), 56.6);
  assert.equal(forceChargeStopPct(after.costCeilingSocPct!), 50.4);
  assert.equal(before.expectedWriteLevelPct, 56.6);
  assert.equal(after.expectedWriteLevelPct, 50.4);
  assert.equal(before.buyKwh, 44.88);
  assert.equal(after.buyKwh, 39.93);
  assert.equal(before.expectedBuyKwh, 11.61);
  assert.equal(after.expectedBuyKwh, 5.05);
  assert.match(after.rationale, /up to the morning-solar headroom \(~45\.7 kWh, counting the median sun at ×1\.095 of its forecast from 10 realized nights; ~40 kWh on the forecast as is\)\./);
  // The resilience side does not move.
  for (const k of ['requiredExtraKwh', 'cushionKwh', 'cushionLineSocPct', 'cushionTroughSocPct', 'cushionShortfall', 'minProjSocPct'] as const) {
    assert.deepEqual(after[k], before[k], k);
  }
  assert.deepEqual(costSurplusLedgerColumns(after), {
    cost_surplus_kwh: 45.7, cost_surplus_raw_kwh: 40, cost_surplus_load_factor: 1, cost_surplus_load_samples: 10,
    cost_surplus_pv_factor: 1.095, cost_surplus_pv_samples: 10,
  });
  // Both terms at once name both.
  const both = goldenPlan({ ...MORNING, costSurplusLoad: { ...PV_LOAD, factor: 0.8, samples: 7, p50Kwh: 49.7 } });
  assert.match(both.rationale, /counting the house load at ×0\.8 of its forecast from 7 realized nights and the median sun at ×1\.095 of its forecast from 10 realized nights;/);
});

test('★★★ unchanged: resilience mode, a cushion-shortfall night, a long-gap night', () => {
  const sl = { costSurplusLoad: PV_LOAD };
  const res = { ...MORNING, objectiveMode: 'resilience' as const, forceChargeEligible: false };
  assert.deepEqual(goldenPlan({ ...res, ...sl }), goldenPlan(res), 'resilience');
  // A 2 kW charger cannot lift to the line: the raw surplus stands (v1.187.1's rule, inherited).
  const short = { ...MORNING, chargeCapKw: 2, gridInputCapKw: 2, socNowPct: 20 };
  const a = goldenPlan(short);
  const b = goldenPlan({ ...short, ...sl });
  assert.equal(a.cushionShortfall, true);
  assert.equal(b.costCeilingSocPct, a.costCeilingSocPct);
  assert.equal(b.costCeilingSurplusKwh, a.costCeilingSurplusKwh);
  assert.equal(b.buyKwh, a.buyKwh);
  // A long-gap night keeps its own pessimistic surplus, and reports no factor.
  const gap = { ...MORNING, longGapAhead: true, prePeakPvSurplusP10Kwh: 12 };
  const g1 = goldenPlan(gap);
  const g2 = goldenPlan({ ...gap, ...sl });
  assert.equal(g2.costCeilingSocPct, g1.costCeilingSocPct);
  assert.equal(g2.costSurplusPvFactor, null);
  assert.equal(g2.costSurplusPvSamples, null);
});

test('★★★ SWEEP: the PV factor never raises a ceiling, a target or a buy, and never moves the resilience side', () => {
  let lowered = 0;
  const hours = (p50W: number) => Array.from({ length: 12 }, (_, i) => ({ p50W: p50W * Math.sin(((i + 0.5) / 12) * Math.PI), p90W: p50W * 1.3 * Math.sin(((i + 0.5) / 12) * Math.PI), loadW: 2200 }));
  for (const socNowPct of [20, 40, 60, 80]) {
    for (const islandedLoadKw of [1.5, 2.62, 8]) {
      for (const p50W of [3000, 6000, 9000]) {
        for (const pvFactor of [1, 1.05, 1.2, 1.3]) {
          for (const chargeCapKw of [3, 17.8]) {
            const raw = costMorningSurplusKwh(hours(p50W), 1);
            const deb = costMorningSurplusKwh(hours(p50W), 1, pvFactor);
            const base = { socNowPct, islandedLoadKw, chargeCapKw, gridInputCapKw: chargeCapKw, morningPvSurplusP50Kwh: raw.p50Kwh, morningPvSurplusP90Kwh: raw.p90Kwh };
            const a = goldenPlan(base);
            const b = goldenPlan({ ...base, costSurplusLoad: { factor: 1, basis: 'measured', samples: 10, ...deb, pvFactor, pvSamples: 10 } });
            const tag = `soc ${socNowPct} island ${islandedLoadKw} p50 ${p50W} pv ×${pvFactor} cap ${chargeCapKw}`;
            assert.ok(b.costCeilingSocPct! <= a.costCeilingSocPct! + 1e-9, `ceiling ${tag}`);
            assert.ok(b.targetSocPct! <= a.targetSocPct! + 1e-9, `target ${tag}`);
            assert.ok(b.buyKwh! <= a.buyKwh! + 1e-9, `buy ${tag}`);
            assert.ok(b.setpointSocPct! <= a.setpointSocPct! + 1e-9, `setpoint ${tag}`);
            for (const k of ['requiredExtraKwh', 'cushionKwh', 'cushionShortfall', 'cushionTroughSocPct', 'minProjSocPct'] as const) {
              assert.deepEqual(b[k], a[k], `${k} ${tag}`);
            }
            // Never under the line the raw stop cleared.
            assert.ok(b.costCeilingSocPct! >= Math.min(a.costCeilingSocPct!, a.cushionLineSocPct!) - 0.05, `line ${tag}`);
            if (b.costCeilingSocPct! < a.costCeilingSocPct!) lowered++;
          }
        }
      }
    }
  }
  assert.ok(lowered > 40, `the sweep exercises the change (${lowered} lowered ceilings)`);
});

/* ══ the censoring guard: did the pool reach the charge taper? ═══════════ */

test('★★★ pv_saturated: the span\'s highest pool SoC (median-filtered) against the taper of the Cores\' mean charge ceiling', () => {
  const pts = (vals: number[]) => vals.map((value, i) => ({ ts: i * 300_000, value }));
  assert.deepEqual(pvSaturationColumns({ socPts: pts([40, 60, 88, 92, 93, 91, 70]), chgMaxSocPcts: [100, 100, 100] }),
    { actual_max_soc_pct: 92, pv_saturated: 1 }, 'a 100% ceiling tapers from 90');
  assert.deepEqual(pvSaturationColumns({ socPts: pts([40, 60, 85, 89, 88, 70]), chgMaxSocPcts: [100, 100] }),
    { actual_max_soc_pct: 88, pv_saturated: 0 });
  assert.deepEqual(pvSaturationColumns({ socPts: pts([40, 85, 86, 85, 70]), chgMaxSocPcts: [95, 95, null] }),
    { actual_max_soc_pct: 85, pv_saturated: 1 }, 'a 95% ceiling tapers from 85 (at it is in it)');
  assert.deepEqual(pvSaturationColumns({ socPts: pts([40, 60, 88, 92, 93, 91]), chgMaxSocPcts: [null] }).pv_saturated, 1, 'no ceiling reported: 100, as the analytics assume');
  // A lone reconnect sample is not a level the pool held.
  assert.deepEqual(pvSaturationColumns({ socPts: pts([60, 61, 100, 62, 60]), chgMaxSocPcts: [100] }), { actual_max_soc_pct: 62, pv_saturated: 0 });
  assert.deepEqual(pvSaturationColumns({ socPts: [], chgMaxSocPcts: [100] }), { actual_max_soc_pct: null, pv_saturated: null }, 'no reading: unknown, never 0');
});

test('★★ a re-captured row re-measures its saturation with its PV (the reset clears both)', () => {
  const r = forecastSpanResetColumns(3_600_000);
  assert.equal(r.actual_max_soc_pct, null);
  assert.equal(r.pv_saturated, null);
  assert.equal(r.pv_err_frac, null);
});

test('★★★ index.ts: the outcome capture writes the saturation from the PV span, and the log line names the PV factor', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.ok(idx.includes("socPts: recorder.query(shp2Sn, 'backup_pct', fcSpanStart, fcSpanEnd),\n    chgMaxSocPcts: homeChgMaxSocPcts(),"));
  assert.match(idx, /actual_min_soc_ts_ms: actualMinSocTsMs,\n\s+\.\.\.pvSaturation,\n/);
  assert.ok(idx.includes('and the median sun at ×${pvF.toFixed(2)} of its forecast'));
  // The plan's PV factor reaches the ledger with the load factor (costSurplusLedgerColumns; its call
  // site is pinned in costCeilingLoadDebias.test.ts).
  assert.ok(idx.includes('    ...costSurplusLedgerColumns(plan),'));
});

test('★★ a plan from before the PV factor (no pvFactor on its surplus) reports ×1 from 0 nights', () => {
  const p = goldenPlan({ ...MORNING, costSurplusLoad: { factor: 0.8, basis: 'measured', samples: 7, p50Kwh: 44, p90Kwh: 60 } }) as NightChargePlan;
  assert.equal(p.costSurplusPvFactor, 1);
  assert.equal(p.costSurplusPvSamples, 0);
  assert.doesNotMatch(p.rationale, /median sun/);
});
