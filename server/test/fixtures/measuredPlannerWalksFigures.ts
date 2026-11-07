/**
 * v1.202.0 — the year of legacyIdentityFixtures.ts cases in the groups below, reduced to what a write follows: per case
 * "" (a hold), the reserve as written (clampReserveTarget of the setpoint), and on a night the cost force-charge rides
 * "/" and its stop (forceChargeStopPct of the armed ceiling). measuredPlannerWalks.figures.json holds two parts:
 *
 *  - `main`: the planner of c692f30e (v1.201.0), the walks on the panel's nameplate figure — generated there once, frozen.
 *    measuredPlannerWalks.test.ts holds v1.202.0 to it: no resilience write, cost write or cost stop below it (the three
 *    stops the de-bias's own gate lowers aside, pinned there).
 *  - `c`: the planner as it is, the walks on the measured pool and draining the standby — regenerated for a deliberate,
 *    reviewed change to overnight sizing, said so in the commit; the test holds every later planner to it.
 *
 *   cd server && node --import tsx test/fixtures/measuredPlannerWalksFigures.ts --write <main|c> "<generatedAt>"
 *
 * (The `main` part is written by running this file, copied, on a c692f30e tree.)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNightChargeInputs, computeNightChargePlan, type NightChargeInputDeps, type NightChargePlan } from '../../src/nightChargeAdvisor.js';
import { clampReserveTarget, armedForceChargeCeilingPct } from '../../src/nightChargeActuator.js';
import { forceChargeModeOf, forceChargeStopPct } from '../../src/nightForceCharge.js';
import { legacyIdentityCases } from './legacyIdentityFixtures.js';

export type FigState = 'write' | 'advisory' | 'stand' | 'fixture';
export type FigBasis = 'm' | 'held' | 'mk' | 'np';
/** The scale each basis passes (np: none — the panel's figure, the walks with the standby only). */
export const FIG_SCALES: Readonly<Record<FigBasis, { scale: number; basis: 'measured' | 'held' | 'min-known' } | null>> = Object.freeze({
  m: { scale: 0.944, basis: 'measured' }, held: { scale: 0.92, basis: 'held' }, mk: { scale: 0.9, basis: 'min-known' }, np: null,
});
export const FIG_HOURS = [4, 8, 12, 16, 20] as const;
export const FIG_STANDBY_W = 270;
/** The groups: a write mode on every basis, and the other states at ×0.944. */
export const FIG_GROUPS: ReadonlyArray<readonly [FigState, FigBasis]> = Object.freeze([
  ['write', 'm'], ['write', 'held'], ['write', 'mk'], ['write', 'np'], ['advisory', 'm'], ['stand', 'm'], ['fixture', 'm'],
] as const);
export const figKey = (st: FigState, b: FigBasis, h: number): string => `${st}|${b}|${h}`;

/** The live cost gate (index.ts forceChargeOn): the cost objective and ARB_COST_MAX_SOC_PCT above the reserve maximum. */
const costGate = (d: NightChargeInputDeps): boolean => d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50;
/** A state's deps: a write mode (both force-charges on their live gates), advisory (neither), a write mode on a reserve already
 *  reading 50 (v1.200.1's stand), or the fixture's own. */
export function stateDeps(d: NightChargeInputDeps, st: FigState): NightChargeInputDeps {
  if (st === 'fixture') return d;
  if (st === 'write') return { ...d, lineForceChargeEligible: true, forceChargeEligible: costGate(d) } as NightChargeInputDeps;
  if (st === 'advisory') return { ...d, lineForceChargeEligible: false, forceChargeEligible: false } as NightChargeInputDeps;
  return { ...d, lineForceChargeEligible: true, forceChargeEligible: costGate(d), reserveFloorPct: 50 } as NightChargeInputDeps;
}
/** One case of a group, as planned. */
export function figPlan(d: NightChargeInputDeps, st: FigState, b: FigBasis, h: number): NightChargePlan {
  const sc = FIG_SCALES[b];
  return computeNightChargePlan(buildNightChargeInputs({
    ...stateDeps(d, st), outageCushionHours: h, cushionStandbyW: FIG_STANDBY_W, ...(sc != null ? { cushionPoolScale: sc } : {}),
  } as NightChargeInputDeps));
}
/** The token of a plan: "" a hold; the written reserve; and "/stop" where the cost force-charge rides the night. */
export function figToken(p: NightChargePlan, deps: NightChargeInputDeps): string {
  if (!p.chargeTonight || p.setpointSocPct == null) return '';
  const w = String(clampReserveTarget(p.setpointSocPct));
  const cost = deps.forceChargeEligible === true;
  const line = (deps as { lineForceChargeEligible?: boolean }).lineForceChargeEligible === true;
  const m = forceChargeModeOf(
    { forceChargeCeilingPct: cost ? armedForceChargeCeilingPct({ costCeilingSocPct: p.costCeilingSocPct ?? null }) : null, forceChargeLineAskPct: p.forceChargeLine?.askPct ?? null } as never,
    { cost, line },
  );
  return m?.kind === 'cost' ? `${w}/${forceChargeStopPct(m.targetPct)}` : w;
}
/** Every group's tokens, in the fixtures' case order, joined by ','. */
export function figGroups(): Record<string, string> {
  const out: Record<string, string> = {};
  const cases = legacyIdentityCases();
  for (const [st, b] of FIG_GROUPS) for (const h of FIG_HOURS) {
    out[figKey(st, b, h)] = cases.map((c) => figToken(figPlan(c.deps, st, b, h), stateDeps(c.deps, st))).join(',');
  }
  return out;
}
/** A token read back: [charge, written, stop]. */
export function parseToken(t: string): { charge: boolean; written: number | null; stop: number | null } {
  if (t === '') return { charge: false, written: null, stop: null };
  const [w, s] = t.split('/');
  return { charge: true, written: Number(w), stop: s != null ? Number(s) : null };
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLANNER_WALKS_FIGURES_PATH = resolve(HERE, 'measuredPlannerWalks.figures.json');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--write');
  const part = process.argv[at + 1];
  if (at < 0 || (part !== 'main' && part !== 'c') || !process.argv[at + 2]) {
    console.error('usage: node --import tsx test/fixtures/measuredPlannerWalksFigures.ts --write <main|c> "<generatedAt>"');
    process.exit(2);
  }
  const prev = existsSync(PLANNER_WALKS_FIGURES_PATH) ? JSON.parse(readFileSync(PLANNER_WALKS_FIGURES_PATH, 'utf8')) as Record<string, unknown> : {};
  const about = 'Each legacyIdentityFixtures.ts case per group (state|basis|hours, ' + `${FIG_STANDBY_W} W, ${FIG_HOURS.join('/')} h` + '), as tokens joined by ",": "" a hold, the reserve as written, '
    + '"/stop" where the cost force-charge rides. "main": c692f30e (v1.201.0), frozen; "c": v1.202.0, regenerable (measuredPlannerWalksFigures.ts). measuredPlannerWalks.test.ts reads both.';
  const doc = { _about: about, cases: legacyIdentityCases().length, main: prev.main, c: prev.c, [part]: { generatedAt: process.argv[at + 2], groups: figGroups() } };
  const text = `${JSON.stringify(doc, null, 1)}\n`;
  JSON.parse(text);
  writeFileSync(PLANNER_WALKS_FIGURES_PATH, text);
  console.log(`${part}: ${FIG_GROUPS.length * FIG_HOURS.length} groups → ${PLANNER_WALKS_FIGURES_PATH}`);
}
