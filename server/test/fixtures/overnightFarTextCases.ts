/**
 * v1.206.0 — the evening announcement's cases for a window that opens a day or more after the plan, and the evenings beside
 * them that must not move (farWindowText.test.ts; overnightFarTextGolden.json holds each case's push).
 *
 * Every plan is the real engine's on a night of the fixture year (legacyIdentityFixtures.ts), so the windows are the tariff's own:
 *  - FAR  — a Saturday evening for Monday 00:00–05:00 (26.5 h out), and the Sunday before a Monday holiday for Tuesday 00:00–05:00;
 *  - NEAR — an ordinary Sunday (Monday 00:00, 2.5 h out), a Friday (its own 23:00–00:00 window), a holiday eve and the holiday,
 *           and a Saturday whose Monday is a holiday (no window inside the scan).
 * Each case is the evening job's inputs: the plan, the push shape, the supervised context (the arm the cycle record makes from the
 * plan, with the cancel deadline as index.ts words it for that evening, written out here), a refusal, the mode.
 *
 * Every plan is the planner's own output. Two cases change its INPUTS, never its output (`inputs`: no median load, so no expected
 * figure). One case stamps a field on the output, and says so in its name (a night that stands at 50% with nothing expected: the
 * planner makes no such plan on the fixture year, and the push has words for it).
 */
import {
  buildNightChargeInputs, computeNightChargePlan, chargeLevelPct, statedBuyKwh,
  type NightChargeInputDeps, type NightChargeInputs, type NightChargePlan,
} from '../../src/nightChargeAdvisor.js';
import { armCycle, emptyCycle } from '../../src/chargeCycle.js';
import type { NightChargeMode } from '../../src/nightChargeActuator.js';
import { legacyIdentityCases } from './legacyIdentityFixtures.js';
import { darkDeps } from './cushionOnlyFigures.js';

export interface FarTextCase {
  name: string;
  /** 'far': the window opens 86,400,000 ms or more after the plan (written out in the test, not read from the subject). */
  kind: 'far' | 'near';
  plan: NightChargePlan;
  shape: 'charge' | 'hold' | 'insufficient_basis';
  supervised: {
    cancelDeadlineText: string; cancelDeadlineTextEs: string; targetPct: number; forceChargeTargetPct?: number | null;
    forceChargeLine?: { askPct: number; linePct: number; panelCeilingPct: number } | null;
  } | null;
  armRefused: string | null;
  mode: NightChargeMode;
}

const CASES = legacyIdentityCases();
const depsOf = (label: string): NightChargeInputDeps => {
  const c = CASES.find((x) => x.label === label);
  if (c == null) throw new Error(`no fixture case ${label}`);
  return c.deps;
};
type Inputs = NightChargeInputs;
const planOf = (d: NightChargeInputDeps, inputs: (i: Inputs) => Inputs = (i) => i): NightChargePlan => computeNightChargePlan(inputs(buildNightChargeInputs(d)));
/** The planner's inputs with no median load: the plan then carries no expected figure (expectedBuyKwh null). */
const noMedianLoad = (i: Inputs): Inputs => ({ ...i, horizon: i.horizon.map((h) => ({ ...h, loadP50W: null })) });
const shapeOf = (p: NightChargePlan): FarTextCase['shape'] => (!p.basisComplete ? 'insufficient_basis' : p.chargeTonight ? 'charge' : 'hold');
const REFUSED = 'the 2026-10-16 reserve write is still applied and not yet restored';

/** The evening job's arm step: armCycle with the overnight cost leg against an empty cycle; the supervised context from the leg. */
function armed(plan: NightChargePlan, deps: NightChargeInputDeps, day: string, deadline: [string, string]): FarTextCase['supervised'] {
  const arm = armCycle(emptyCycle(), day, [{
    role: 'cost', kind: 'overnight', plan, forceChargeEnabled: deps.forceChargeEligible === true,
    lineForceChargeEnabled: deps.lineForceChargeEligible === true, nextOnPeakStartMs: null,
    announcedLevelPct: chargeLevelPct(plan), announcedExpectedKwh: statedBuyKwh(plan),
  }], plan.generatedAt, plan.reserveFloorPct);
  const c = arm.cycle?.active;
  if (c == null || c.targetPct == null) throw new Error(`${day}: the plan does not arm`);
  const line = c.forceChargeLineAskPct != null && c.forceChargeLinePct != null
    ? { askPct: c.forceChargeLineAskPct, linePct: c.forceChargeLinePct, panelCeilingPct: 80 } : null;
  return {
    cancelDeadlineText: deadline[0], cancelDeadlineTextEs: deadline[1], targetPct: c.targetPct,
    forceChargeTargetPct: line == null && c.forceChargeRides === true ? c.forceChargeCeilingPct : null,
    forceChargeLine: line,
  };
}

const MON: [string, string] = ['on Monday at 12:00 AM', 'el lunes a las 12:00 AM'];
const TUE: [string, string] = ['on Tuesday at 12:00 AM', 'el martes a las 12:00 AM'];
const AT12: [string, string] = ['at 12:00 AM', 'a las 12:00 AM'];
const AT11: [string, string] = ['at 11:00 PM', 'a las 11:00 PM'];

/** Every case, in a fixed order. */
export function farTextCases(): FarTextCase[] {
  const out: FarTextCase[] = [];
  const add = (
    name: string, kind: FarTextCase['kind'], label: string, deadline: [string, string] | null,
    o: {
      over?: Partial<NightChargeInputDeps>; dark?: boolean; refused?: boolean; mode?: NightChargeMode;
      inputs?: (i: Inputs) => Inputs; plan?: (p: NightChargePlan) => NightChargePlan;
    } = {},
  ): void => {
    const base = { ...depsOf(label), ...(o.over ?? {}) } as NightChargeInputDeps;
    const deps = o.dark ? darkDeps(base, 'held') : base;
    const p0 = planOf(deps, o.inputs);
    const plan = o.plan ? o.plan(p0) : p0;
    const shape = shapeOf(plan);
    const mode = o.mode ?? 'supervised';
    const supervised = shape === 'charge' && mode !== 'advisory' && !o.refused && deadline != null ? armed(plan, deps, label.slice(0, 10), deadline) : null;
    out.push({ name, kind, plan, shape, supervised, armRefused: o.refused ? REFUSED : null, mode });
  };
  // ── FAR: Saturday evening for Monday 00:00–05:00 ──
  add('Sat for Mon: charge, reserve only, the lows differ (2026-10-17)', 'far', '2026-10-17 21:30', MON);
  add('Sat for Mon: charge, force-charge riding, the lows the same (2026-11-07)', 'far', '2026-11-07 21:30', MON);
  add('Sat for Mon: a reserve hold, nothing expected (2027-03-06)', 'far', '2027-03-06 21:30', MON);
  add('Sat for Mon: charge, auto mode (2026-10-17)', 'far', '2026-10-17 21:30', MON, { mode: 'auto' });
  add('Sat for Mon: charge, advisory (2026-10-17)', 'far', '2026-10-17 21:30', null, { mode: 'advisory' });
  add('Sat for Mon: a reserve hold, advisory (2027-03-06)', 'far', '2027-03-06 21:30', null, { mode: 'advisory' });
  add('Sat for Mon: charge, refused (supervised)', 'far', '2026-10-17 21:30', null, { refused: true });
  add('Sat for Mon: charge, refused (auto)', 'far', '2026-10-17 21:30', null, { refused: true, mode: 'auto' });
  add('Sat for Mon: a reserve hold, refused (2027-03-06)', 'far', '2027-03-06 21:30', null, { refused: true });
  add('Sat for Mon: no plan, the basis incomplete (2026-12-26)', 'far', '2026-12-26 21:30', null);
  add('Sat for Mon: hold, under the minimum buy', 'far', '2026-10-17 21:30', null, { over: { minBuyKwh: 60 } });
  add('Sat for Mon: hold, the window cannot cover the cushion', 'far', '2026-10-17 21:30', null, { over: { chargeCapKw: 0.2, gridInputCapKw: 0.2, minBuyKwh: 5, socNowPct: 20 } });
  add('Sat for Mon: hold, the cushion holds (2026-10-24, a full pool)', 'far', '2026-10-24 21:30', null, { over: { socNowPct: 100, objectiveMode: 'resilience', forceChargeEligible: false } });
  add('Sat for Mon: the outage line above the reserve, its force-charge armed (10 h)', 'far', '2026-10-17 21:30', MON, { over: { outageCushionHours: 10, lineForceChargeEligible: true } });
  add('Sat for Mon: the Cores dark, cushion only', 'far', '2026-10-17 21:30', MON, { dark: true });
  add('Sat for Mon: the Cores dark, cushion only, refused', 'far', '2026-10-17 21:30', null, { dark: true, refused: true });
  // An economic buy that the morning's sun would clip (the notes of a far push, on the real plan with the cap named).
  add('Sat for Mon: the over-buy note (cap named)', 'far', '2026-10-17 21:30', MON, { plan: (p) => ({ ...p, bindingCap: 'overBuy' }) });
  // The panel's reserve reads above the write (51%): no write is due, so no charge is priced ("with no charge" / "the plan's full buy").
  add('Sat for Mon: the reserve reads above the write, the lows differ (2026-10-17, 51%, 10 h)', 'far', '2026-10-17 21:30', MON, { over: { reserveFloorPct: 51, outageCushionHours: 10, lineForceChargeEligible: true } });
  add('Sat for Mon: the reserve reads above the write, the lows the same (2027-05-01, 51%, 6 h)', 'far', '2027-05-01 21:30', MON, { over: { reserveFloorPct: 51, outageCushionHours: 6, lineForceChargeEligible: true } });
  // The panel's reserve reads the write (50%): the night stands, and its line force-charge is armed beside it.
  add('Sat for Mon: a night that stands at 50%, its line force-charge armed (2026-10-17, 10 h)', 'far', '2026-10-17 21:30', MON, { over: { reserveFloorPct: 50, outageCushionHours: 10, lineForceChargeEligible: true } });
  // …and the same night with nothing expected (the expected buy stamped 0 on the real plan: the planner makes none on the fixture year).
  add('Sat for Mon: a night that stands at 50%, nothing expected (expected buy stamped 0)', 'far', '2026-10-17 21:30', MON, { over: { reserveFloorPct: 50, outageCushionHours: 10, lineForceChargeEligible: true }, plan: (p) => ({ ...p, expectedBuyKwh: 0 }) });
  // The legacy cushion basis (no islanded load): the hold's figure is the whole-house low.
  add('Sat for Mon: hold, the cushion holds on the legacy basis (2026-10-24, no islanded load)', 'far', '2026-10-24 21:30', null, { over: { socNowPct: 80, islandedLoadKw: null, objectiveMode: 'resilience', forceChargeEligible: false } });
  // No median load: the plan carries no expected figure, and the push states none.
  add('Sat for Mon: charge with no expected figure (no median load)', 'far', '2026-10-17 21:30', MON, { inputs: noMedianLoad });
  // ── FAR: the Sunday before a Monday holiday, for Tuesday 00:00–05:00 ──
  add('Sun for Tue, Monday a holiday: charge toward its level (2027-01-17)', 'far', '2027-01-17 21:30', TUE);
  // ── NEAR: must not move ──
  add('Sunday for Monday 00:00, 2.5 h out (2026-10-18)', 'near', '2026-10-18 21:30', AT12);
  add('Friday, its own 23:00 window (2026-10-16)', 'near', '2026-10-16 21:30', AT11);
  add('Friday, its own 23:00 window, a charge (2026-10-30)', 'near', '2026-10-30 21:30', AT11);
  add('a holiday eve, Wednesday (2026-11-25)', 'near', '2026-11-25 21:30', AT11);
  add('the holiday, Thursday, for Friday 00:00 (2026-11-26)', 'near', '2026-11-26 21:30', AT12);
  add('a Saturday whose Monday is a holiday: no window in the scan (2027-01-16)', 'near', '2027-01-16 21:30', null);
  add('Sunday, refused (2026-10-18)', 'near', '2026-10-18 21:30', null, { refused: true });
  add('Sunday, advisory (2026-10-18)', 'near', '2026-10-18 21:30', null, { mode: 'advisory' });
  return out;
}
