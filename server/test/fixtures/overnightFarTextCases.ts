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
 * planner makes no such plan on the fixture year, and the push has words for it). One case carries the panel-measured solar basis,
 * put on the planner's output as the evening job puts it (onPanelBasis: the selection's fields and the rationale's closing sentence;
 * no figure of the plan moves).
 */
import {
  buildNightChargeInputs, computeNightChargePlan, chargeLevelPct, statedBuyKwh,
  type NightChargeInputDeps, type NightChargeInputs, type NightChargePlan,
} from '../../src/nightChargeAdvisor.js';
import { armCycle, emptyCycle } from '../../src/chargeCycle.js';
import { selectPvBasis, pvBasisDecoration, withPvBasis, type PvSelectionInput } from '../../src/panelPvSelection.js';
import type { UcVerdict } from '../../src/panelPvBasis.js';
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

/**
 * A plan with the PANEL-MEASURED solar basis on it (v1.204.0), as the evening job puts it on a plan sized on the planning band
 * (index.ts: withPvBasis(plan, pvBasisDecoration(...))) once the 7-day energy balance passes — the basis the plant plans on while
 * its Cores are dark and the balance holds. The selection is the real selector's on the inputs written out here: every connected
 * slot on the panel's own reading, the balance at 0.9997 against the 1.05 it is refused above (panelPvSelection.test.ts's passing
 * evening; 1.04 until v1.207.1, and the record's threshold and blind band follow the line). Only the pvBasis* fields and the rationale's closing sentence are added; every figure of the plan is the planner's.
 * The push then says " Solar from the panel's readings (7-day energy balance 0.9997, refused above 1.05)." after its confidence tier.
 */
const PANEL_AS_OF = '2026-10-29';
const PANEL_KEYS = ['P#1', 'P#2', 'P#3'];
const PANEL_SOURCES = [{ slot: 1, source: 'panel' }, { slot: 2, source: 'panel' }, { slot: 3, source: 'panel' }] as UcVerdict['sources'];
const PANEL_VERDICT: UcVerdict = {
  asOfDay: PANEL_AS_OF, state: 'pass', ok: true, reason: null, sources: PANEL_SOURCES, basis: 'panel',
  checks: {
    asOfDay: PANEL_AS_OF, threshold: 1.05, ratio: 0.9997, balanceDaylightRatio: 0.9781, nightResidualKwhPerNight: -1.13, max7: 0.9997,
    blindBandPct: 5, fieldDays: 8, newestFieldDay: '2026-10-28', fieldSlots: [1, 2, 3],
    constants: { 1: { days: 51, chargeHours: 97 }, 2: { days: 51, chargeHours: 96 }, 3: { days: 51, chargeHours: 95 } },
    vendorDaysPresent: 14, vendorMaxDiffKwh: 0.17, nightMaxW: 0, frozenHours: 0,
  },
};
const PANEL_SELECTION: PvSelectionInput = {
  asOfDay: PANEL_AS_OF,
  eligible: { writeMode: true, panelFresh: true, cancelled: false },
  latched: null,
  published: { gate: { basisComplete: false, basisBlockedBy: 'only 0 scored calibration day(s), need 4', transient: true }, uncoveredSlots: [1, 2, 3] },
  planning: { asOfDay: PANEL_AS_OF, keys: PANEL_KEYS, verdict: PANEL_VERDICT, gate: { basisComplete: true, basisBlockedBy: null, transient: false } },
  planningRollupOk: true,
  connectedKeys: PANEL_KEYS,
  ratioKnown: true,
};
export function onPanelBasis(p: NightChargePlan): NightChargePlan {
  const sel = selectPvBasis(PANEL_SELECTION);
  if (sel.use !== 'planning') throw new Error(`the selection written out here does not take the planning band: ${sel.use}`);
  if (!p.basisComplete || p.requiredExtraKwh == null || p.cushionOnly != null) throw new Error('the panel basis is put on a plan sized on the planning band, never on a refused or a cushion-only plan');
  const out = withPvBasis(p, pvBasisDecoration({ sel, asOfDay: PANEL_AS_OF, plan: { sized: true, cushionOnly: false }, calScoredDays: 22, admittedDays: 13 })) as NightChargePlan;
  if (out.pvBasis !== 'panel') throw new Error('the selection written out here puts no panel basis on the plan');
  return out;
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
  // v1.206.0 review — what a far push carries beside its lows: the economic sentence and each basis sentence, on plans that have them.
  // An economic buy (cost mode, the cushion already covered): both lows the same figure, so the sentence is what says why it buys.
  add('Sat for Mon: an economic buy in cost mode, the lows the same (2026-10-24, the pool at 80%)', 'far', '2026-10-24 21:30', MON, { over: { socNowPct: 80 } });
  // The panel-measured solar basis (the plant's basis while its Cores are dark and the 7-day balance passes): said after the tier.
  add('Sat for Mon: charge on the panel\'s solar readings (2026-10-17, the panel basis on the plan)', 'far', '2026-10-17 21:30', MON, { plan: onPanelBasis });
  // The provisional solar band (9 of 14 calibration days scored): said after the notes, before the supervised sentence.
  add('Sat for Mon: charge on the provisional solar band (2026-10-17, 9 of 14 calibration days)', 'far', '2026-10-17 21:30', MON, { over: { calScoredDays: 9, provisionalMinCalScoredDays: 4 } });
  // The Cores dark with a full pool at 4 h: cushion only and nothing expected — the reserve hold's title keeps "outage cushion only".
  add('Sat for Mon: a reserve hold with the Cores dark, cushion only (2027-04-10, a full pool, 4 h)', 'far', '2027-04-10 21:30', MON, { over: { socNowPct: 100, outageCushionHours: 4 }, dark: true });
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
