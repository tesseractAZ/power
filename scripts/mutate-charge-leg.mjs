#!/usr/bin/env node
/**
 * mutate-charge-leg.mjs — v1.194.0: a PV surplus reaches the cells through the CHARGE LEG in every
 * walk that steps a pool hour by hour. The runway (the alarm path), the day and multi-day SoC
 * projections and the probabilistic band store a surplus at RUNWAY_CHARGE_EFFICIENCY
 * (√DISPATCH_ROUND_TRIP_EFFICIENCY, 0.927); the night-charge planner's islanded sizing walk, its
 * with-buy window walk, its median walks and the mid-day shadow's held-import walk at the injected
 * legEff (the same figure). All of them go through one pure step, chargeLegStep
 * (server/src/physics/chargeLeg.ts): a deficit as it is, a surplus × η, η clamped to [0, 1], a
 * non-finite η crediting nothing.
 *
 *   Step       S-i..S-iii   (deficits untouched, the clamp, fail-closed)
 *   Constant   K-i          (one source: √RTE, not unity)
 *   Runway     C-i          (computeRunway — the alarm path)
 *   Forecasts  C-ii..C-vi   (the day walk, the multi-day walk, the band's inversion and seed, its
 *                             per-path steps, the spread stepped after it is added)
 *   Planner    P-i..P-viii  (simulate, the post-window trough's caller, the with-buy window walk,
 *                             the expected carry, the PV credit, the just-in-time walk, the shadow;
 *                             simulate's step takes the whole net, the house load included)
 *   Ledger     L-i          (buy_err_kwh keeps its fixed 1/legEff conversion: exact for a deficit
 *                             hour's PV miss, 7.8 % deep for a surplus hour's, 1.4 % deep for a
 *                             surplus hour's load miss — the blocking side)
 *
 * Each mutant runs the BEHAVIOUR tests named on it — worked figures, never the source pins
 * (runwayChargeLegPins.test.ts is deliberately in no list), so a kill shows that a figure moved.
 *
 * Not mutated: the clamp's lower bound alone (Math.max(0, …) → …) — a negative η can only come from
 * DISPATCH_ROUND_TRIP_EFFICIENCY, which config.ts clamps to [0.8, 1], and the upper-bound mutant
 * S-ii already exercises the clamp's shape; the gridGainKw acceptance bound, which stays on the raw
 * PV on purpose (conservative) and is held by mutate-midday-plan.mjs.
 *
 *   MUTATE_CONCURRENCY=1 node scripts/mutate-charge-leg.mjs [--only <id prefix>]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEG = resolve(REPO, 'server/src/physics/chargeLeg.ts');
const AN = resolve(REPO, 'server/src/analytics.ts');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const MS = resolve(REPO, 'server/src/middayShadow.ts');

const STEP = ['test/runwayChargeLeg.test.ts'];
const RUNWAY = ['test/runwayChargeLeg.test.ts', 'test/poolEnergyBasis.test.ts', 'test/runwayDischargeEfficiency.test.ts'];
const BASIS = ['test/runwayBasisContracts.test.ts'];
const PLANNER = ['test/runwayChargeLeg.test.ts', 'test/legacyIdentity.test.ts', 'test/nightChargeExpectedBuy.test.ts', 'test/middayPlan.test.ts'];

const MUTANTS = [
  /* ── the step ── */
  {
    id: 'S-i. ★★★ η is applied to a deficit too',
    file: LEG,
    find: '  if (!(net > 0)) return net;',
    to: '  if (!(net > 0)) return net * 0.9274; /* MUTANT */',
    why: 'A deficit drains less than the pool gives up: every runway and every sizing trough reads long — the unsafe direction.',
    tests: [...STEP, 'test/runwayDischargeEfficiency.test.ts'],
  },
  {
    id: 'S-ii. ★★ η is not clamped to unity',
    file: LEG,
    find: '  const eta = Number.isFinite(chargeEff) ? Math.min(1, Math.max(0, chargeEff)) : 0;',
    to: '  const eta = Number.isFinite(chargeEff) ? Math.max(0, chargeEff) : 0; /* MUTANT */',
    why: 'A configured efficiency above 1 credits a surplus beyond what PV delivered.',
    tests: STEP,
  },
  {
    id: 'S-iii. ★★ a non-finite η credits the surplus in full (fail-open)',
    file: LEG,
    find: '  const eta = Number.isFinite(chargeEff) ? Math.min(1, Math.max(0, chargeEff)) : 0;',
    to: '  const eta = Number.isFinite(chargeEff) ? Math.min(1, Math.max(0, chargeEff)) : 1; /* MUTANT */',
    why: 'A broken efficiency reads the longest runway instead of the shortest.',
    tests: STEP,
  },

  /* ── the constant ── */
  {
    id: 'K-i. ★★★ the alarm path charges at unity again',
    file: AN,
    find: 'export const RUNWAY_CHARGE_EFFICIENCY = Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY);',
    to: 'export const RUNWAY_CHARGE_EFFICIENCY = 1; /* MUTANT */',
    why: 'The runway, the SoC projections and the band credit a sunny day in full: an 18 kWh pool reads LOW (6.1 h), not MEDIUM (5.9 h).',
    tests: [...RUNWAY, ...BASIS],
  },

  /* ── the runway ── */
  {
    id: 'C-i. ★★★ computeRunway credits a surplus at unity',
    file: AN,
    find: '    const delta = chargeLegStep(pvKwh - runwayDrainW(loadKwhPerHour * 1000, basis.overheadW) / 1000, RUNWAY_CHARGE_EFFICIENCY);',
    to: '    const delta = pvKwh - runwayDrainW(loadKwhPerHour * 1000, basis.overheadW) / 1000; /* MUTANT */',
    why: 'The alarm path reads a projection across a sunny day long: the reserve crossing an hour late, a tier too low.',
    tests: RUNWAY,
  },

  /* ── the forecasts ── */
  {
    id: 'C-ii. ★★★ the day SoC walk credits a surplus at unity',
    file: AN,
    // v1.195.0 — re-pointed: the day walk's step is one closure (stepSocWh) shared by the alarm walk
    // and the restored display walk, and the charge leg sits inside it.
    find: 'soc + chargeLegStep(pvW - runwayDrainW(loadW, poolBasis.overheadW), RUNWAY_CHARGE_EFFICIENCY)',
    to: 'soc + (pvW - runwayDrainW(loadW, poolBasis.overheadW)) /* MUTANT */',
    why: 'minProjectedSoc, the forecast-soc-dip alert and the forecast-runtime bound read high beside the runway.',
    tests: BASIS,
  },
  {
    id: 'C-iii. ★★ the multi-day SoC walk credits a surplus at unity',
    file: AN,
    find: 'socWh + chargeLegStep(pv - runwayDrainW(load, poolBasis.overheadW), RUNWAY_CHARGE_EFFICIENCY)',
    to: 'socWh + (pv - runwayDrainW(load, poolBasis.overheadW)) /* MUTANT */',
    why: 'Day 0 of the multi-day view contradicts the day forecast after the first sunny hour.',
    tests: BASIS,
  },
  {
    id: 'C-iv. ★★★ the band inverts and seeds with the net at unity',
    file: AN,
    find: '  const netKwh = (pvW: number, loadW: number): number => chargeLegStep(rawNetKwh(pvW, loadW), RUNWAY_CHARGE_EFFICIENCY);',
    to: '  const netKwh = (pvW: number, loadW: number): number => rawNetKwh(pvW, loadW); /* MUTANT */',
    why: 'Read across a sunny hour the inversion recovers poolFull / η (8% larger) and the band narrows.',
    tests: BASIS,
  },
  {
    id: 'C-v. ★★★ the band applies η before adding the spread',
    file: AN,
    find: '        const stepPct = (z: number) => (chargeLegStep(dP50Kwh + z * sigmaNetKwh, RUNWAY_CHARGE_EFFICIENCY) / fullKwh) * 100;',
    to: '        const stepPct = (z: number) => ((chargeLegStep(dP50Kwh, RUNWAY_CHARGE_EFFICIENCY) + z * sigmaNetKwh) / fullKwh) * 100; /* MUTANT */',
    why: 'Every path stores its spread at unity: across a sunny day the band is ~7% too wide, and a P10 path in deficit is charged as a surplus.',
    tests: BASIS,
  },
  {
    id: 'C-vi. ★★ the band steps the P50 net twice through the charge leg',
    file: AN,
    find: '    const dP50Kwh = rawNetKwh(p50, h.forecastLoadW);',
    to: '    const dP50Kwh = netKwh(p50, h.forecastLoadW); /* MUTANT */',
    why: 'A sunny hour\'s median is stored at η², so the raw median lags the anchor and the band moves at the full rail.',
    tests: BASIS,
  },

  /* ── the planner ── */
  {
    id: 'P-i. ★★★ the islanded sizing walk credits a P10 surplus at unity',
    file: NCA,
    find: '    packWh = Math.max(0, Math.min(fullWh, packWh + chargeLegStep(h.pvP10W - h.loadP90W / dischargeEff, chargeEff)));',
    to: '    packWh = Math.max(0, Math.min(fullWh, packWh + (h.pvP10W - h.loadP90W / dischargeEff))); /* MUTANT */',
    why: 'The trough after a sunny day sits 2.25 kWh high on 31 kWh of surplus: the buy is 2.43 kWh short.',
    tests: PLANNER,
  },
  {
    id: 'P-ii. ★★★ the post-window trough is walked at unity (its caller passes 1)',
    file: NCA,
    find: '    simulate(p, fullKwh, postHours, dischargeEff, legEff, windowEnd, windowEnd).minPackKwh;',
    to: '    simulate(p, fullKwh, postHours, dischargeEff, 1, windowEnd, windowEnd).minPackKwh; /* MUTANT */',
    why: 'The setpoint is solved on a trough the sizing does not use: the resilience ask reads 69.5% for a 69.8% need.',
    tests: ['test/nightChargeExpectedBuy.test.ts', 'test/legacyIdentity.test.ts'],
  },
  {
    id: 'P-iii. ★★ the with-buy window walk credits the sun at unity',
    file: NCA,
    find: '      pack = Math.max(0, Math.min(fullKwh, pack + gainKwh + chargeLegStep(pvKwh - drainKwh, legEff)));',
    to: '      pack = Math.max(0, Math.min(fullKwh, pack + pvKwh + gainKwh - drainKwh)); /* MUTANT */',
    why: 'A window with sun in it (the mid-day leg) counts that sun in full at the close: the lift falls 1.74 kWh short of the line on 24 kWh of window PV.',
    tests: ['test/runwayChargeLeg.test.ts', 'test/middayPlan.test.ts'],
  },
  {
    id: 'P-iv. ★★★ the expected carry credits a P50 surplus at unity',
    file: NCA,
    find: '    pack = Math.max(slotFloor, Math.min(o.fullKwh, pack + chargeLegStep((w * (pv - Math.max(0, h.loadP50W!) / o.dischargeEff)) / 1000, o.legEff)));',
    to: '    pack = Math.max(slotFloor, Math.min(o.fullKwh, pack + (w * (pv - Math.max(0, h.loadP50W!) / o.dischargeEff)) / 1000)); /* MUTANT */',
    why: 'The pool expected at the open reads high: the expected buy is stated low.',
    tests: ['test/runwayChargeLeg.test.ts', 'test/nightChargeExpectedBuy.test.ts', 'test/middayPlan.test.ts'],
  },
  {
    id: 'P-v. ★★ the sun\'s share of a lift is credited at unity',
    file: NCA,
    find: '    const pvStep = Math.min(chargeLegStep((pvW / 1000) * dtH, o.legEff), o.liftKwh - gained);',
    to: '    const pvStep = Math.min((pvW / 1000) * dtH, o.liftKwh - gained); /* MUTANT */',
    why: 'The mid-day expected buy states 35.9 kWh for a 37.3 kWh draw.',
    tests: ['test/middayPlan.test.ts'],
  },
  {
    id: 'P-vi. ★★ the just-in-time walk credits a surplus at unity',
    file: NCA,
    find: '    pack = Math.max(floor, Math.min(o.fullKwh, pack + chargeLegStep(((pv - loadW / o.dischargeEff) / 1000) * (EXPECTED_JIT_STEP_MS / HOUR_MS), o.legEff)));',
    to: '    pack = Math.max(floor, Math.min(o.fullKwh, pack + ((pv - loadW / o.dischargeEff) / 1000) * (EXPECTED_JIT_STEP_MS / HOUR_MS))); /* MUTANT */',
    why: 'Under sun the force-charge is expected later and from higher: the expected draw reads low.',
    tests: ['test/runwayChargeLeg.test.ts'],
  },
  {
    id: 'P-vii. ★★ the held-import walk credits a surplus at unity',
    file: MS,
    find: '    const net = chargeLegStep((w * (Math.max(0, h.pvP50W) - Math.max(0, h.loadP50W) / o.dischargeEff)) / 1000, o.legEff);',
    to: '    const net = (w * (Math.max(0, h.pvP50W) - Math.max(0, h.loadP50W) / o.dischargeEff)) / 1000; /* MUTANT */',
    why: 'A held reserve under sun is estimated to send less to the grid than it does.',
    tests: ['test/heldImport.test.ts'],
  },
  {
    id: 'P-viii. ★★ the islanded sizing walk stores only the PV at legEff; a surplus hour\'s house load skips the leg',
    file: NCA,
    find: '    packWh = Math.max(0, Math.min(fullWh, packWh + chargeLegStep(h.pvP10W - h.loadP90W / dischargeEff, chargeEff)));',
    to: '    packWh = Math.max(0, Math.min(fullWh, packWh + chargeLegStep(h.pvP10W, chargeEff) - h.loadP90W / dischargeEff)); /* MUTANT */',
    why: 'The load a surplus hour serves from PV never reaches the cells, so it is not taxed by the charge leg: storing PV × η and drawing the whole load sinks the trough after a sunny day 1.24 kWh too low, and a daytime load miss moves the buy 4.59 kWh per 4 kWh instead of 4.26.',
    tests: ['test/runwayChargeLeg.test.ts'],
  },

  /* ── the ledger ── */
  {
    id: 'L-i. ★★ the ledger converts a forecast miss 1:1, as if every hour were a surplus hour',
    file: NCA,
    find: '  return round2(opts.planBuyKwh + netMissKwh / opts.legEff);',
    to: '  return round2(opts.planBuyKwh + netMissKwh); /* MUTANT */',
    why: 'A deficit hour\'s PV miss and every load miss read 7 % shallow: a real under-buy can land inside the 0.5 kWh deadband, the gate\'s open side.',
    tests: ['test/runwayChargeLeg.test.ts', 'test/plannerSizingBasis.test.ts'],
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// perMutantTests: each mutant runs the behaviour tests named on it; fullSuite: false — a kill must
// come from those figures, not from a source pin or an unrelated full-suite failure.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-charge-leg', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, fullSuite: false, typecheck: true });
