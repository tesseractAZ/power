/**
 * v1.202.0 — the year of legacyIdentityFixtures.ts cases in the groups below, reduced to what a write follows: per case
 * "" (a hold), the reserve as written (clampReserveTarget of the setpoint), and on a night the cost force-charge rides
 * "/" and its stop (forceChargeStopPct of the armed ceiling). measuredPlannerWalks.figures.json holds two parts:
 *
 *  - `main`: the planner of c692f30e (v1.201.0), the walks on the panel's nameplate figure — generated there once, frozen.
 *    measuredPlannerWalks.test.ts holds v1.202.0 to it: no resilience write, cost write or cost stop below it (the three
 *    stops the de-bias's own gate lowers aside, pinned there).
 *  - `c`: the planner as it is, the walks on the measured pool and draining the standby — regenerated for a deliberate,
 *    reviewed change to overnight sizing, said so in the commit; the test holds every later planner to it. v1.203.0 — regenerated
 *    for the panel's hold point (every write that was a line's whole percent is that and one point more); v1.202.0's `c` is the
 *    planner with no hold point (figGroups(0)), which the test still holds to its own pins.
 *  - `mainStandby`: c692f30e's planner again, in a write mode at ×0.944 with the other standby figures (FIG_STANDBY_EXTRA_W:
 *    0, 90 and 336 W) at the same hours — generated there once, frozen. measuredPlannerWalks.test.ts T6b holds v1.202.0 to it.
 *
 *   cd server && node --import tsx test/fixtures/measuredPlannerWalksFigures.ts --write <main|c|mainStandby> "<generatedAt>"
 *
 * (The `main` and `mainStandby` parts are written by running this file, copied, on a c692f30e tree.)
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
/** The other standby figures (W) of the `mainStandby` part: none, one Core's 90 W, and the top of the three later spans'
 *  implied overhead (336 W). 270 W is FIG_STANDBY_W's, in `main`. */
export const FIG_STANDBY_EXTRA_W = [0, 90, 336] as const;
/** The `mainStandby` groups: a write mode at ×0.944. */
export const FIG_STANDBY_GROUPS: ReadonlyArray<readonly [FigState, FigBasis]> = Object.freeze([['write', 'm']] as const);
export const figStandbyKey = (st: FigState, b: FigBasis, h: number, w: number): string => `${st}|${b}|${h}|${w}W`;

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
/** One case of a group, as planned (at FIG_STANDBY_W, or the standby figure `w`). v1.203.0 — `hold`: the panel's hold point
 *  (computeNightChargePlan's holdUndershootPct); omitted, the planner's own. */
export function figPlan(d: NightChargeInputDeps, st: FigState, b: FigBasis, h: number, w: number = FIG_STANDBY_W, hold?: number): NightChargePlan {
  const sc = FIG_SCALES[b];
  return computeNightChargePlan(buildNightChargeInputs({
    ...stateDeps(d, st), outageCushionHours: h, cushionStandbyW: w, ...(sc != null ? { cushionPoolScale: sc } : {}),
  } as NightChargeInputDeps), ...(hold !== undefined ? [hold] : []));
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
/** Every group's tokens, in the fixtures' case order, joined by ','. v1.203.0 — `hold` as figPlan's. */
export function figGroups(hold?: number): Record<string, string> {
  const out: Record<string, string> = {};
  const cases = legacyIdentityCases();
  for (const [st, b] of FIG_GROUPS) for (const h of FIG_HOURS) {
    out[figKey(st, b, h)] = cases.map((c) => figToken(figPlan(c.deps, st, b, h, FIG_STANDBY_W, hold), stateDeps(c.deps, st))).join(',');
  }
  return out;
}
/** The `mainStandby` groups' tokens, as figGroups. */
export function figStandbyGroups(hold?: number): Record<string, string> {
  const out: Record<string, string> = {};
  const cases = legacyIdentityCases();
  for (const [st, b] of FIG_STANDBY_GROUPS) for (const w of FIG_STANDBY_EXTRA_W) for (const h of FIG_HOURS) {
    out[figStandbyKey(st, b, h, w)] = cases.map((c) => figToken(figPlan(c.deps, st, b, h, w, hold), stateDeps(c.deps, st))).join(',');
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
  if (at < 0 || (part !== 'main' && part !== 'c' && part !== 'mainStandby') || !process.argv[at + 2]) {
    console.error('usage: node --import tsx test/fixtures/measuredPlannerWalksFigures.ts --write <main|c|mainStandby> "<generatedAt>"');
    process.exit(2);
  }
  const prev = existsSync(PLANNER_WALKS_FIGURES_PATH) ? JSON.parse(readFileSync(PLANNER_WALKS_FIGURES_PATH, 'utf8')) as Record<string, unknown> : {};
  const about = 'Each legacyIdentityFixtures.ts case per group (state|basis|hours, ' + `${FIG_STANDBY_W} W, ${FIG_HOURS.join('/')} h` + '), as tokens joined by ",": "" a hold, the reserve as written, '
    + '"/stop" where the cost force-charge rides. "main": c692f30e (v1.201.0), frozen; "c": the planner as it is (v1.203.0), regenerable (measuredPlannerWalksFigures.ts). '
    + `"mainStandby": c692f30e again, write|m|hours|W at ${FIG_STANDBY_EXTRA_W.join('/')} W, frozen. measuredPlannerWalks.test.ts reads all three.`;
  const groups = part === 'mainStandby' ? figStandbyGroups() : figGroups();
  const doc = { _about: about, cases: legacyIdentityCases().length, main: prev.main, c: prev.c, mainStandby: prev.mainStandby, [part]: { generatedAt: process.argv[at + 2], groups } };
  const text = `${JSON.stringify(doc, null, 1)}\n`;
  JSON.parse(text);
  writeFileSync(PLANNER_WALKS_FIGURES_PATH, text);
  console.log(`${part}: ${Object.keys(groups).length} groups → ${PLANNER_WALKS_FIGURES_PATH}`);
}
