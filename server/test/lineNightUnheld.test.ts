import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNightChargePlan, buildNightChargeInputs, lineForceChargeLedgerColumns, type NightChargePlan } from '../src/nightChargeAdvisor.js';
import * as cardWalk from '../src/nightChargeAdvisor.js';
import * as nfc from '../src/nightForceCharge.js';
import { decideForceCharge, lineDeclinedPushTick, EMPTY_LINE_DECLINED_PUSH, type ForceChargeOpts } from '../src/nightForceCharge.js';
import {
  APPLY_LATE_MS, APPLY_VERIFY_AFTER_MS, armFromPlan, coerceActuationState, decideActuation, emptyActuationState,
  restoreSummaryDue, type NightActuationState,
} from '../src/nightChargeActuator.js';
import * as cycle from '../src/chargeCycle.js';
import { asChargeLeg, missedApplyDue, missedApplyReason, promoteCycle, type ChargeLegState } from '../src/chargeCycle.js';
import * as notify from '../src/notify.js';
import { buildNightChargeForeignReserve, buildNightChargeMessage, buildNightChargeMissedApply, buildNightChargeMorningSummary } from '../src/notify.js';
import { computeNightChargeReadiness, CURRENT_ALGO_VERSION, MISSED_APPLY_DISPOSITION, phoenixYmd } from '../src/nightChargeGate.js';
import { eveningAnnouncement } from '../src/chargeAnnounce.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';
import * as cardText from '../../web/src/cards/nightChargeText.js';

/**
 * v1.200.0 (review 9) — A LINE NIGHT THE FORCE-CHARGE CANNOT RIDE IS TOLD, EVERY WAY IT ENDS.
 *
 * The force-charge for a line above the 50% reserve rides a VERIFIED reserve write, so every way the write does not land leaves the
 * line unheld. Four paths said nothing a person could act on:
 *  - U1 a panel already reading the write's 50% (the most it accepts): decideActuation's "nothing to raise", so no record of an apply,
 *    and the force-charge waits on it all night, on every charge night of such a plant. The evidence rule stands (no change to what is
 *    written without a wrong write): the plan no longer claims or arms a line it knows nothing will ride, and says why (reason
 *    'reserveAtTarget'); arming a force-charge on a standing 50 is the owner's decision.
 *  - U2 a reserve write that does not land within the 30-minute apply window (vitals, an incoherent or stale reading, a restart, the
 *    write block, a raise in the app after the plan, a cloud refusing every attempt): missedApplyDue excluded the overnight leg, so no
 *    push, no morning account (no restore to summarise) and no strike. Now the missed-apply push on a record with a line ask, in line
 *    words, and an account at the close of a record with nothing to restore (lineCloseAccountDue); the gate strikes it as a run-time
 *    refusal. The same gap: an ON or a ceiling sync the write block refuses after the reserve verified.
 *  - U3 the reserve settling as someone else's: the force-charge stops or never starts, and the push spoke only of the reserve.
 *  - U4 a grid loss (or a cancel) on a line night: the summary returned before any line or close words.
 * U5 the hand-set reserve's deadline names the last start as what it is, never as the way to hold the line.
 * U1b (Fix9 review 2) the plan's reserve is a reading and the record is what the night can do: the words hold whichever way the reading
 * goes, and a recompute claims no ON a record with no ask cannot make.
 * U1c (Fix10) neither does one with an ask whose start is closed (forceChargeStartClosed, its one source): the plan the card and the
 * entities serve discloses it, the banner stops saying a write is armed, and nothing written and no ledger row moves.
 * U6 (Fix10 review 1) a run stopped for good is such a record too, the card leads with it where no write stands, and a window no record
 * holds with no evening job left is told; a grid-status OFF is pushed; an instruction promises no line; a late account is no close
 * reading; a write the panel never read back is not told as raised.
 * U7 (Fix10 review 2) a run that never took, or that reads off with no re-ON left, is such a record too: nothing of the add-on's brings it
 * back, a late apply reopens it, and a run still on with no re-ON left keeps its line and loses the re-ON's clause.
 * U8 (Fix11) the plan's walk is told a run is on: served as on, never as switching on at a time, and past the last-start gate its close
 * stays continuous, with no "not expected to start" while the panel charges. Nothing written moves, and the plan of record stays.
 * U9 (Fix12) an ON warned of on some slots is a closed start too: its other slots may be running, so no figure is stated and no walk is
 * told a run is on, the card leads with the words whose write stands, and a late apply reopens it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const M = 60_000;
const H = 60 * M;
const CASES = legacyIdentityCases();
const LABEL = '2027-01-04 21:30';
const caseOf = (label: string) => CASES.find((c) => c.label === label)!;
type P = NightChargePlan & { forceChargeLine?: { askPct: number; linePct: number }; cushionEnvelopeReason?: string; cushionShortfallCause?: string; expectedForceChargeMode?: string };
type ClosedInput = { windowStartMs: number; why: string };
type NoReOnInput = { windowStartMs: number; words: string };
const planAt = (floor: number, o: { eligible?: boolean; cost?: boolean; hours?: number; label?: string; noLineAt?: number | null; closed?: ClosedInput | null; noReOn?: NoReOnInput | null; runOn?: number | null; at?: number; pool?: number; fullKwh?: number; noP50?: boolean } = {}): P => {
  const deps = {
    ...caseOf(o.label ?? LABEL).deps, reserveFloorPct: floor, cushionPoolScale: MEASURED_SCALE,
    ...(o.at != null ? { nowMs: o.at } : {}), ...(o.pool != null ? { socNowPct: o.pool } : {}), ...(o.fullKwh != null ? { fullKwh: o.fullKwh } : {}),
    forceChargeEligible: o.cost === true, ...(o.cost === true ? { objectiveMode: 'cost', costMaxSocPct: 80 } : {}),
    ...(o.eligible !== false ? { lineForceChargeEligible: true } : {}),
    ...(o.hours != null ? { outageCushionHours: o.hours } : {}),
    ...(o.noLineAt !== undefined ? { armedNoLineStartMs: o.noLineAt } : {}),
  } as never;
  const inputs = buildNightChargeInputs(deps);
  return computeNightChargePlan({
    ...inputs, ...(o.noP50 === true ? { horizon: inputs!.horizon.map((h) => ({ ...h, loadP50W: null })) } : {}), ...(o.closed !== undefined ? { armedLineStartClosed: o.closed } : {}), ...(o.noReOn !== undefined ? { armedLineNoReOn: o.noReOn } : {}),
    ...(o.runOn !== undefined ? { armedLineRunOnStartMs: o.runOn } : {}),
  } as never) as P;
};
const SIZING = ['chargeTonight', 'buyKwh', 'buyKwhDebiased', 'requiredExtraKwh', 'targetSocPct', 'setpointSocPct', 'costCeilingSocPct', 'cushionTroughSocPct', 'cushionLineSocPct', 'bindingCap', 'minProjSocPct'] as const;
const sizing = (p: NightChargePlan) => Object.fromEntries(SIZING.map((k) => [k, (p as never)[k] ?? null]));

const OPEN = Date.UTC(2027, 0, 5, 6); // 23:00 MST
const CLOSE = OPEN + 6 * H; // 05:00 MST
const armed = (over: Partial<NightActuationState> = {}): NightActuationState => ({
  ...emptyActuationState(), day: '2027-01-04', announcedAtMs: OPEN - 90 * M, targetPct: 50, buyKwh: 28, windowStartMs: OPEN, windowEndMs: CLOSE,
  forceChargeRides: true, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55, ...over,
} as NightActuationState);
const applied = (over: Partial<NightActuationState> = {}): NightActuationState => armed({
  applyAttemptedAtMs: OPEN, attemptBaselinePct: 30, appliedAtMs: OPEN, priorReservePct: 30, applyVerifiedAtMs: OPEN + 3 * M, ...over,
});
const fo = (over: Partial<ForceChargeOpts> & { lineEnabled?: boolean } = {}): ForceChargeOpts => ({
  enabled: false, lineEnabled: true, gridPresent: true, gridStaLost: false, slotsOn: [], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 80, poolSocPct: 50, fullKwh: 92.16, chargeRateKw: 14, ...over,
} as ForceChargeOpts);
const leg = (s: NightActuationState, over: Partial<ChargeLegState> = {}): ChargeLegState => ({ ...asChargeLeg(s), ...over });
/** v1.200.0 (review 9) — the new surfaces, read off the modules so a run on the code before them fails on its assert. */
const closeDue = (s: NightActuationState, t: number): string | null => (nfc as unknown as { lineCloseAccountDue: (s: NightActuationState, t: number) => string | null }).lineCloseAccountDue(s, t);
type AccountInput = { day: string | null; linePct: number; cause: 'noWrite' | 'foreign'; closePoolPct: number | null; onAtMs?: number | null; offAtMs?: number | null; offReason?: string | null };
const account = (o: AccountInput): { severity: string; dedupId: string; title: string; body: string } => (notify as unknown as { buildLineNightCloseAccount: (o: AccountInput) => { severity: string; dedupId: string; title: string; body: string } }).buildLineNightCloseAccount(o);

/* ══ U1 — a panel already reading the write ═════════════════════════════════════════════════════════════════════════════════ */

test('★★★ U1 a reserve read above the write: the plan neither claims nor arms the line (reason reserveAtTarget), says why, and no sizing figure moves; at the write, or under it, it arms (v1.200.1: test/lineStandingReserve.test.ts)', () => {
  const p = planAt(51);
  const absent = planAt(51, { eligible: false });
  assert.equal(p.chargeTonight, true);
  assert.ok(p.cushionLineSocPct! > 50);
  assert.equal(p.forceChargeLine, undefined, 'nothing armed: a force-charge rides a verified write, and none goes');
  assert.equal(p.cushionShortfall, true, 'the line is not claimed');
  assert.ok(p.cushionShortfallCause === 'envelope' || p.cushionShortfallCause === 'envelope+caps', String(p.cushionShortfallCause));
  assert.equal(p.cushionEnvelopeReason, 'reserveAtTarget');
  assert.deepEqual(sizing(p), sizing(absent), 'I-A1: no sizing figure moves');
  assert.notEqual(p.expectedForceChargeMode, 'line');
  assert.ok(p.rationale.includes(`The reserve is set to 50%, the most the panel accepts as a backup reserve; tonight's ${p.cushionLineSocPct}% outage line is above it and the reserve reads 51%: no write is due while it does, and no force-charge runs without one, so the cushion is not assured — residual risk remains.`), p.rationale);
  assert.doesNotMatch(p.rationale, /switches on at|stays on until the window closes|tonight's write/);
  // The ledger: the ask is not recorded, the disclosure is.
  assert.deepEqual(lineForceChargeLedgerColumns(p as never), { cushion_line_force_charge_pct: null, cushion_envelope_shortfall: 1 });
  // One point under the write: the write goes, and the line arms as ever.
  const q = planAt(49);
  assert.equal(q.forceChargeLine?.askPct != null, true, 'the write raises 49 to 50: armed');
  assert.equal(q.cushionEnvelopeReason === 'reserveAtTarget', false);
  // Advisory and the backup leg keep their own reason.
  assert.equal(planAt(51, { eligible: false }).cushionEnvelopeReason, undefined, 'no eligibility input: v1.199.1');
});

test('★★★ U1 no force-charge is expected on such a plan, a cost night too: what the night expects is what it can do (the reserve alone)', () => {
  const costOn = planAt(51, { cost: true });
  assert.equal(costOn.forceChargeLine, undefined);
  assert.equal(costOn.cushionEnvelopeReason, 'reserveAtTarget');
  assert.ok(costOn.costCeilingSocPct! > 50, 'a cost ceiling above the reserve: on any other night the force-charge rides it');
  assert.equal(costOn.expectedForceChargeStartMs == null, true, 'no start stated');
  assert.equal(costOn.expectedForceChargeMode === 'line', false);
  assert.equal(costOn.expectedWriteLevelPct, 50, 'the reserve alone');
  assert.equal(costOn.expectedBuyKwh, 0);
});

test('★★★ U1 the evening surfaces of such a plan: the note names why, the supervised tail says nothing is written, no raise and no force-charge are promised; the card row says why', () => {
  const p = planAt(51);
  const sup = { cancelDeadlineText: 'tonight at 11:00 PM', targetPct: 50, forceChargeTargetPct: null, forceChargeLine: null };
  const body = buildNightChargeMessage(p as never, 'charge', sup as never).body;
  assert.ok(body.includes(`NOTE: tonight's ${Math.round(p.cushionLineSocPct! * 10) / 10}% outage line is above the 50% the panel accepts as a reserve, and the reserve reads 51%: no write is due while it does, and no force-charge runs without one — residual risk remains.`), body);
  assert.ok(body.includes('SUPERVISED: the backup reserve reads 51% now, so no write is due while it does, and no force-charge runs without one. A reading under 50% when the window opens lets the armed write go, and it carries no force-charge for the outage line. Cancel from the night-charge card on the panel before the window opens.'), body);
  assert.doesNotMatch(body, /raises the backup reserve|switches the panel's force-charge ON/);
  // A cost ceiling armed beside it rides nothing either.
  const cost = planAt(51, { cost: true });
  const costBody = buildNightChargeMessage(cost as never, 'charge', { ...sup, forceChargeTargetPct: 80 } as never).body;
  assert.doesNotMatch(costBody, /raises the backup reserve|arms the panel's force-charge|switches the panel's force-charge ON/);
  const row = (cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow(p);
  assert.ok(row != null && row.includes('not claimed tonight (the reserve reads 51%: no write while it does, no force-charge without one)'), String(row));
  // The record arms with no line, so no line surface promises one; the 21:30 line says the same.
  const rec = armFromPlan(emptyActuationState(), '2027-01-04', p as never, p.window!.startMs - 90 * M, 51, false, null, true)!;
  assert.equal(rec.forceChargeLineAskPct, null);
  assert.ok(INDEX.includes("if (plan?.cushionEnvelopeReason === 'reserveAtTarget') return `Force-charge: none for the line — the reserve reads ${plan.reserveFloorPct}%, so no write is due while it does, and no force-charge runs without one; the plan does not claim tonight's outage line.`;"));
});

test('★★ U1 the spoken notice of such a plan says the cushion is not met, and promises no raise', () => {
  const p = planAt(51);
  const { spoken } = eveningAnnouncement({
    cycle: 'overnight', plan: p as never, shape: 'charge', armRefused: null, mode: 'supervised',
    supervised: { cancelDeadlineText: 'tonight at 11:00 PM', cancelDeadlineTextEs: 'esta noche a las 11:00 PM', targetPct: 50, forceChargeTargetPct: null, forceChargeLine: null },
  } as never);
  assert.ok(spoken != null);
  assert.ok(spoken.en.includes('Outage cushion not fully met.'), spoken.en);
  assert.doesNotMatch(spoken.en, /raise|force|Charge Now/i);
});

/** The year at a reading above the write and 4 h of cushion, every case: measured with the fix. v1.200.1 — a reading OF the write now arms (lineStandingReserve). */
// v1.202.0 — re-measured with the walks on the measured pool (v1.201.0: 816 charge nights, 656 disclosed).
const PIN_U1_YEAR = { charge: 817, armed: 0, disclosed: 658 };

test('★★★ U1 the year at a reading above the write: every line that could never start is disclosed, and none arms; at 49 they arm as before', () => {
  let charge = 0;
  let isArmed = 0;
  let disclosed = 0;
  for (const c of CASES) {
    const p = planAt(51, { label: c.label, hours: 4 });
    if (!p.chargeTonight) continue;
    charge++;
    if (p.forceChargeLine != null) isArmed++;
    if (p.cushionEnvelopeReason === 'reserveAtTarget') {
      disclosed++;
      assert.doesNotMatch(p.rationale, /tonight's write/, c.label);
    }
  }
  assert.deepEqual({ charge, armed: isArmed, disclosed }, PIN_U1_YEAR);
  assert.ok(CASES.some((c) => planAt(49, { label: c.label, hours: 4 }).forceChargeLine != null), 'one point under, lines arm');
});

/* ══ U1b — the reserve is a reading, not a promise ═════════════════════════════════════════════════════════════════════════ */

const SUP = { cancelDeadlineText: 'tonight at 11:00 PM', targetPct: 50, forceChargeTargetPct: null, forceChargeLine: null };
const TICK = (reserve: number | null) => ({ mode: 'supervised' as const, writeReady: true, currentReservePct: reserve, socCoherent: true, vitalsRed: false, gridPresent: true });
const noLineStart = (s: NightActuationState): number | null => (nfc as unknown as { armedNoLineStartMs: (s: NightActuationState) => number | null }).armedNoLineStartMs(s);

test('★★★ U1b the plan reads the reserve once, and the night is decided at the apply: the words hold whichever way the reading goes, the write the record still makes included', () => {
  for (const cost of [false, true]) {
    const p = planAt(51, { cost });
    const rec = armFromPlan(emptyActuationState(), '2027-01-04', p as never, p.window!.startMs - 90 * M, 51, cost, null, true)!;
    assert.equal(rec.forceChargeLineAskPct, null);
    const body = buildNightChargeMessage(p as never, 'charge', { ...SUP, forceChargeTargetPct: cost ? 80 : null } as never).body;
    // The record arms a write: at a reading of 50 nothing goes, under it the write goes, so neither is promised.
    assert.equal(decideActuation(rec, rec.windowStartMs! + M, TICK(50)).kind, 'none');
    assert.deepEqual(decideActuation(rec, rec.windowStartMs! + M, TICK(45)), { kind: 'apply', targetPct: 50 });
    assert.doesNotMatch(body, /writes nothing|no write goes/, 'the write can go');
    assert.ok(body.includes('A reading under 50% when the window opens lets the armed write go, and it carries no force-charge for the outage line.'), body);
    assert.ok(p.rationale.includes('no write is due while it does, and no force-charge runs without one'), p.rationale);
    assert.doesNotMatch(p.rationale, /no write goes/);
    // "No force-charge runs" holds only as "without one": a cost ceiling armed beside it rides the write if one goes.
    assert.doesNotMatch(`${body}\n${p.rationale}`, /no force-charge runs(?! without one)/);
    const v = { ...rec, applyAttemptedAtMs: rec.windowStartMs!, attemptBaselinePct: 45, appliedAtMs: rec.windowStartMs!, priorReservePct: 45, applyVerifiedAtMs: rec.windowStartMs! + 3 * M };
    const later = rec.windowEndMs! - H;
    const verified = decideForceCharge(v, later, fo({ enabled: cost, poolSocPct: 50 }));
    assert.equal(verified.kind === 'on', cost, `a cost ceiling rides the write, a line never: ${JSON.stringify(verified)}`);
    assert.doesNotMatch(p.rationale, /fully held/, 'a cost force-charge may hold it: never said not to');
    const row = (cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow(p)!;
    assert.doesNotMatch(row, /not held tonight/, row);
    assert.ok(row.includes('not claimed tonight'), row);
  }
  assert.ok(!INDEX.includes('Force-charge: none tonight — the reserve'), 'the 21:30 line: no "none tonight" a cost ceiling beside it can contradict');
});

test('★★★ U1b a recompute of a window whose armed record carries no line never claims an ON the record cannot make: the line is disclosed (armedNoLine), every figure stands, and it names the reason', () => {
  const armedPlan = planAt(45);
  assert.equal(armedPlan.forceChargeLine != null, true, 'with no armed record: armed');
  assert.match(armedPlan.rationale, /switches on at|stays on until the window closes|runs until the panel/);
  const open = armedPlan.window!.startMs;
  const q = planAt(45, { noLineAt: open });
  assert.equal(q.forceChargeLine, undefined, 'the record has no ask: nothing can start');
  assert.equal(q.cushionEnvelopeReason, 'armedNoLine');
  assert.equal(q.cushionShortfall, true);
  assert.deepEqual(sizing(q), sizing(armedPlan), 'no sizing figure moves');
  assert.notEqual(q.expectedForceChargeMode, 'line');
  assert.equal(q.expectedForceChargeStartMs == null, true, 'no start stated');
  assert.doesNotMatch(q.rationale, /switches on at|stays on until the window closes|runs until the panel/, q.rationale);
  assert.ok(q.rationale.includes(`tonight's ${q.cushionLineSocPct}% outage line is above it and no write armed for this window carries a force-charge for it, so the cushion is not assured — residual risk remains.`), q.rationale);
  const row = (cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow(q)!;
  assert.ok(row.includes('not claimed tonight (no write armed for this window carries a force-charge for it)'), row);
  assert.doesNotMatch(row, /force-charge runs|switches/, row);
  // Only that window, only a live gate, and a reading of the write is still that reason.
  assert.equal(planAt(45, { noLineAt: open + 24 * H }).forceChargeLine != null, true, 'another window');
  assert.equal(planAt(45, { noLineAt: null }).forceChargeLine != null, true, 'no such record');
  assert.equal(planAt(51, { noLineAt: open }).cushionEnvelopeReason, 'reserveAtTarget');
  assert.equal(planAt(45, { eligible: false, noLineAt: open }).cushionEnvelopeReason, undefined, 'no eligibility: v1.199.1');
  assert.equal(JSON.stringify(planAt(45, { eligible: false, noLineAt: open })), JSON.stringify(planAt(45, { eligible: false })), 'byte for byte');
});

test('★★★ U1b the real path: the record the evening arms at 50 is what the recompute at 45 reads, and the record it arms at 45 carries its ask', () => {
  const p = planAt(51);
  const rec = armFromPlan(emptyActuationState(), '2027-01-04', p as never, p.window!.startMs - 90 * M, 51, false, null, true)!;
  assert.equal(noLineStart(rec), p.window!.startMs);
  assert.equal(planAt(45, { noLineAt: noLineStart(rec) }).cushionEnvelopeReason, 'armedNoLine');
  // v1.200.1 — a record of v1.200.0's at a reading of the write keeps its one night: it has no ask, and a recompute says so.
  assert.equal(planAt(50, { noLineAt: noLineStart(rec) }).cushionEnvelopeReason, 'armedNoLine');
  const q = planAt(45);
  const rec2 = armFromPlan(emptyActuationState(), '2027-01-04', q as never, q.window!.startMs - 90 * M, 45, false, null, true)!;
  assert.ok(rec2.forceChargeLineAskPct != null);
  assert.equal(noLineStart(rec2), null, 'a record with its ask: the recompute stays armed');
  assert.equal(noLineStart(emptyActuationState()), null, 'nothing armed');
  assert.equal(noLineStart(armed({ windowStartMs: null, forceChargeLineAskPct: null, forceChargeLinePct: null })), null, 'no window');
  assert.equal(noLineStart(armed({ day: null, forceChargeLineAskPct: null, forceChargeLinePct: null })), null, 'no day: nothing armed');
  assert.equal(noLineStart(armed({ forceChargeLineAskPct: 50, forceChargeLinePct: 50 })), OPEN, 'an ask at the reserve is no line');
  assert.equal(noLineStart(armed({ cancelled: true, forceChargeLineAskPct: null, forceChargeLinePct: null })), OPEN, 'cancelled: no write armed carries one either');
});

test('★★★ U1b the wiring: every live recompute reads the armed record; the evening job, which arms from its plan, and a shadow leg never do', () => {
  const at = INDEX.indexOf('async function recomputeNightChargePlan(');
  const fn = INDEX.slice(at, INDEX.indexOf('const inputs = buildNightChargeInputs(deps);', at));
  assert.ok(fn.includes('armedNoLineStartMs: shadowLeg == null && opts.arming !== true ? armedNoLineStartMs(nightActuationMem) : null,'), fn);
  assert.ok(INDEX.includes('const result = await recomputeNightChargePlan({ allowStalePanel: nowMin >= deferUntilMin, arming: true });'), 'the evening arm');
  assert.equal([...INDEX.matchAll(/arming: true/g)].length, 1, 'that job alone');
});

/** The year's plans that arm at 45 with no armed record, each recomputed against a record with no ask: measured with the fix. */
// v1.202.0 — re-measured with the walks on the measured pool (v1.201.0: 628).
// v1.203.0 — 637: five lines in (49, 50], which the 50% reserve holds at 49, now carry an ask too.
const PIN_U1B_YEAR = { armed: 0, disclosed: 637 };

test('★★★ U1b the year: no plan of the window of a record with no ask arms or states a start, and none moves a sizing figure', () => {
  let isArmed = 0;
  let disclosed = 0;
  for (const c of CASES) {
    const a = planAt(45, { label: c.label, hours: 4 });
    if (a.forceChargeLine == null) continue;
    const p = planAt(45, { label: c.label, hours: 4, noLineAt: a.window!.startMs });
    if (p.forceChargeLine != null) isArmed++;
    if (p.cushionEnvelopeReason === 'armedNoLine') disclosed++;
    assert.deepEqual(sizing(p), sizing(a), c.label);
    assert.doesNotMatch(p.rationale, /switches on at|stays on until the window closes|runs until the panel/, c.label);
  }
  assert.deepEqual({ armed: isArmed, disclosed }, PIN_U1B_YEAR);
});

test('★★★ U1b the push prices no write it does not make: the projection on such a night says what each figure is, in both shapes; any other night keeps its words', () => {
  for (const cost of [false, true]) {
    const p = planAt(51, { cost });
    const body = buildNightChargeMessage(p as never, 'charge', { ...SUP, forceChargeTargetPct: cost ? 80 : null } as never).body;
    assert.doesNotMatch(body, /tonight's write|without this charge/, body);
    assert.match(body, /tomorrow.s low SoC ~[\d.]+% with no charge, ~[\d.]+% with the plan's full buy; the floor\+cushion line is /, body);
  }
  // A pool expected under the reserve: a night the panel's own reserve charges, the charge shape: the same words.
  const low = { ...planAt(51), expectedBuyKwh: 6, noChargeExpected: false, expectedWriteLevelPct: 50 };
  const lowBody = buildNightChargeMessage(low as never, 'charge', SUP as never).body;
  assert.doesNotMatch(lowBody, /tonight's write|without this charge/, lowBody);
  // A write that goes keeps its own words.
  const q = planAt(49);
  const qBody = buildNightChargeMessage(q as never, 'charge', { ...SUP } as never).body;
  assert.match(qBody, /without (tonight's write|this charge), ~[\d.]+% with it/, qBody);
});

test('★★★ U1b the armed banner says the reserve reads the target, while the panel does, and keeps its Cancel; a reading under it, none, or a write applied keeps its words', () => {
  const a = { targetPct: 50, priorReservePct: null, appliedAtMs: null, revertedAtMs: null, foreignSettledAtMs: null, foreignReservePct: null, cancelled: false } as never;
  const banner = cardText.actuationBannerState as unknown as (a: unknown, d: string | null, r?: number | null) => { text: string; settled: boolean; cancel: string | null };
  assert.deepEqual(banner(a, '22:55', 50), { text: 'Supervised write armed for 22:55 — the reserve reads 50%, so none is due while it does.', settled: false, cancel: 'Cancel tonight' });
  assert.equal(banner(a, null, 50).text, 'Supervised write armed — the reserve reads 50%, so none is due while it does.');
  assert.equal(banner(a, '22:55', 45).text, 'Supervised write armed — reserve → 50% at 22:55.', 'the write is due');
  assert.equal(banner(a, '22:55', null).text, 'Supervised write armed — reserve → 50% at 22:55.', 'no reading: as ever');
  assert.equal(banner(a, '22:55').text, 'Supervised write armed — reserve → 50% at 22:55.');
  assert.equal(banner({ ...(a as object), appliedAtMs: 1, priorReservePct: 30 }, '22:55', 50).text, 'Reserve raised to 50% (was 30%); auto-restores after the window closes.');
  const CARD_SRC = readFileSync(resolve(HERE, '../../web/src/cards/NightChargeCard.tsx'), 'utf8');
  assert.ok(CARD_SRC.includes('const state = actuationBannerState(actuation, hhmm(actuation.cancelDeadlineMs), reservePct);'), 'the live reading reaches it');
  assert.ok(CARD_SRC.includes('reservePct={status.reserveFloorPercent}'), 'the panel\'s live reading (status.reserveFloorPercent)');
});

/* ══ U1c — a record with an ask whose start is closed ══════════════════════════════════════════════════════════════════════ */

const GATES = { cost: false, line: true };
const closedRec = (s: NightActuationState, t: number, g: { cost: boolean; line: boolean } = GATES): ClosedInput | null =>
  (nfc as unknown as { armedLineStartClosed: (s: NightActuationState, t: number, g: { cost: boolean; line: boolean }) => ClosedInput | null }).armedLineStartClosed(s, t, g);
const WHY = nfc.FORCE_CHARGE_START_CLOSED_WHY as unknown as Record<string, string>;
const ON_CLAIM = /switches on at|stays on until the window closes|runs until the panel|force-charge for the outage line|just-in-time|force-charge \(~/;
const CLOSED_CASES = (): Array<[string, NightActuationState, number]> => [
  ['cancelled', armed({ cancelled: true }), OPEN - H],
  ['cancelled', applied({ cancelled: true }), OPEN + H],
  ['reverted', applied({ revertedAtMs: OPEN + H }), OPEN + H],
  ['foreign', armed({ foreignSettledAtMs: OPEN + M }), OPEN + 2 * M],
  ['noWrite', armed(), OPEN + APPLY_LATE_MS + 1],
  ['late', armed(), CLOSE - 20 * M],
  ['late', applied(), CLOSE - 20 * M],
  ['over', armed(), CLOSE],
  ['lateGuard', armed({ nextOnPeakStartMs: CLOSE + 30 * M }), CLOSE - 50 * M],
  ['overGuard', armed({ nextOnPeakStartMs: CLOSE + 30 * M }), CLOSE - 30 * M],
];

test('★★★ U1c armedLineStartClosed: forceChargeStartClosed is its one source; every key but "started" and "gatedOff" is a record with an ask that cannot start one', () => {
  for (const [why, s, t] of CLOSED_CASES()) {
    assert.equal(nfc.forceChargeStartClosed(s, t, GATES), why, why);
    assert.deepEqual(closedRec(s, t), { windowStartMs: OPEN, why, ...(s.applyVerifiedAtMs != null && !s.cancelled && s.revertedAtMs == null ? { writeStands: true } : {}) }, why);
    assert.equal(closedRec({ ...s, forceChargeLineAskPct: null, forceChargeLinePct: null }, t), null, `${why}: no ask, no line to disclose (armedNoLine has it)`);
    assert.equal(closedRec({ ...s, forceChargeLineAskPct: 50, forceChargeLinePct: 50 }, t), null, `${why}: an ask at the reserve is no line`);
    // (Fix10 review 1) 'started' shadows the stamps of the shapes that end for good (U6 has them); a late key behind it is still a run.
    if (why === 'late' || why === 'over' || why === 'lateGuard' || why === 'overGuard') assert.equal(closedRec({ ...s, forceChargeOnAtMs: OPEN + H, forceChargeLineAskPct: 56 }, t), null, `${why}: a run with no OFF yet`);
  }
  assert.equal(nfc.forceChargeStartClosed(armed(), OPEN + M, { cost: false, line: false }), 'gatedOff');
  assert.equal(closedRec(armed(), OPEN + M, { cost: false, line: false }), null, "'gatedOff': what advisory already discloses");
  for (const [what, s, t] of [
    ['before the window', armed(), OPEN - H],
    ['the last instant of the apply window', armed(), OPEN + APPLY_LATE_MS],
    ['an attempt on record: a reading of the target still starts one', armed({ applyAttemptedAtMs: OPEN, attemptBaselinePct: 30 }), OPEN + H],
    ['a write applied', applied(), OPEN + H],
  ] as Array<[string, NightActuationState, number]>) assert.equal(closedRec(s, t), null, what);
  assert.equal(closedRec(armed({ day: null, cancelled: true }), OPEN), null, 'nothing armed');
  assert.equal(closedRec(armed({ windowStartMs: null, cancelled: true }), OPEN), null, 'no window to name');
});

test('★★★ U1c a recompute of a window whose record can no longer start one claims no ON, for every key: the line is disclosed, every figure a write reads stands, and it says why', () => {
  const armedPlan = planAt(45);
  assert.ok(armedPlan.forceChargeLine != null);
  assert.match(armedPlan.rationale, /switches on at|stays on until the window closes|runs until the panel/);
  const open = armedPlan.window!.startMs;
  for (const [why, words] of Object.entries(WHY)) {
    const q = planAt(45, { closed: { windowStartMs: open, why } });
    assert.equal(q.forceChargeLine, undefined, why);
    assert.equal(q.cushionEnvelopeReason, 'startClosed', why);
    assert.equal(q.cushionShortfall, true, why);
    assert.deepEqual(sizing(q), sizing(armedPlan), `${why}: no sizing figure moves`);
    assert.deepEqual([q.window, q.evContention, q.setpointSocPct, q.chargeTonight], [armedPlan.window, armedPlan.evContention, armedPlan.setpointSocPct, armedPlan.chargeTonight], `${why}: what the tick reads off the served plan`);
    assert.notEqual(q.expectedForceChargeMode, 'line', why);
    assert.equal(q.expectedForceChargeStartMs == null, true, `${why}: no start stated`);
    assert.doesNotMatch(q.rationale, ON_CLAIM, q.rationale);
    assert.doesNotMatch(q.rationale, /no write armed for this window/, 'false of a record with an ask');
    assert.doesNotMatch(q.rationale, /tonight's write|The reserve is set to|Charge to|Hold the reserve/, `${why}: no write is claimed: none may stand`);
    assert.ok(q.rationale.startsWith(`Tonight's ${q.cushionLineSocPct}% outage line is above the 50% the panel accepts as a reserve, and no force-charge for it starts: ${words}, so the cushion is not assured — residual risk remains. Expected: the pool should open the window near ~${q.expectedStartSocPct}% with the grid present (median load and PV, never below the 45% reserve). Sized on `), q.rationale);
    assert.equal(q.rationale.split('no force-charge for it starts').length, 2, 'said once');
    const row = (cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow(q)!;
    assert.ok(row.includes(`not claimed tonight (no force-charge for it starts: ${words})`), row);
    assert.doesNotMatch(row, /force-charge runs|switches|expected at the close|no write armed/, row);
    assert.ok((cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow({ ...q, cushionStartClosedWords: undefined })!.includes('not claimed tonight (no force-charge for it starts)'), 'never a blank from an older server');
  }
  // Only that window, only a live gate; a reserve reading above the write keeps its reason.
  const noWrite = { windowStartMs: open, why: 'noWrite' };
  assert.equal(JSON.stringify(planAt(45, { closed: { ...noWrite, windowStartMs: open + 24 * H } })), JSON.stringify(armedPlan), 'another window');
  assert.equal(JSON.stringify(planAt(45, { closed: null })), JSON.stringify(armedPlan), 'none');
  const atWrite = planAt(51, { closed: noWrite });
  assert.equal(atWrite.cushionEnvelopeReason, 'reserveAtTarget');
  assert.equal(atWrite.rationale, planAt(51).rationale, 'and its words');
  assert.equal(JSON.stringify(planAt(45, { eligible: false, closed: noWrite })), JSON.stringify(planAt(45, { eligible: false })), 'no eligibility: v1.199.1, byte for byte');
});

test('★★★ U1c no force-charge is expected on such a plan, a cost ceiling beside it included: no ON rides a closed start, of either mode', () => {
  const a = planAt(45, { cost: true });
  assert.ok(a.forceChargeLine != null && a.costCeilingSocPct! > 50);
  const q = planAt(45, { cost: true, closed: { windowStartMs: a.window!.startMs, why: 'noWrite' } });
  assert.deepEqual(sizing(q), sizing(a));
  assert.equal(q.expectedForceChargeStartMs == null, true);
  assert.equal(q.expectedWriteLevelPct, 50, 'the reserve alone');
  assert.doesNotMatch(q.rationale, ON_CLAIM, q.rationale);
  assert.doesNotMatch(q.rationale, /the force-charge (is due|from)/, q.rationale);
});

test('★★★ U1c a night with no ask, and a plan with no line above the reserve, are byte for byte: nothing here reaches a cost night', () => {
  const low = planAt(45, { hours: 1 });
  assert.ok(low.cushionLineSocPct! <= 50 && low.forceChargeLine == null);
  assert.equal(JSON.stringify(planAt(45, { hours: 1, closed: { windowStartMs: low.window!.startMs, why: 'noWrite' } })), JSON.stringify(low));
  const q = planAt(45);
  const rec = armFromPlan(emptyActuationState(), '2027-01-04', planAt(51) as never, q.window!.startMs - 90 * M, 51, true, null, true)!;
  assert.equal(rec.forceChargeLineAskPct, null);
  assert.equal(closedRec({ ...rec, cancelled: true }, rec.windowStartMs! + H), null);
  assert.equal(closedRec(rec, rec.windowStartMs! + H), null);
  assert.equal(planAt(45, { noLineAt: noLineStart(rec), closed: closedRec(rec, rec.windowStartMs! + H) }).cushionEnvelopeReason, 'armedNoLine', 'its own reason, its own words');
  assert.ok(planAt(45, { noLineAt: noLineStart(rec) }).rationale.includes('no write armed for this window carries a force-charge for it'));
});

test('★★★ U1c the real path: an evening arm at 45, an apply window lost to red vitals, and no start can come: the recompute says what the push says', () => {
  const p = planAt(45);
  const open = p.window!.startMs;
  const rec = armFromPlan(emptyActuationState(), '2027-01-04', p as never, open - 90 * M, 45, false, null, true)!;
  assert.ok(rec.forceChargeLineAskPct != null);
  for (let t = open; t <= open + APPLY_LATE_MS; t += M) assert.equal(decideActuation(rec, t, { ...TICK(45), vitalsRed: true }).kind, 'none');
  const at = open + APPLY_LATE_MS + M;
  assert.equal(decideActuation(rec, at, TICK(45)).kind, 'none');
  for (let t = at; t < rec.windowEndMs!; t += 10 * M) assert.equal(decideForceCharge(rec, t, fo({ poolSocPct: 55 })).kind, 'none');
  const closed = closedRec(rec, at);
  assert.deepEqual(closed, { windowStartMs: open, why: 'noWrite' });
  const q = planAt(45, { closed });
  assert.equal(q.cushionEnvelopeReason, 'startClosed');
  const push = buildNightChargeMissedApply({ day: '2027-01-04', role: 'cost', windowStartMs: open, windowEndMs: rec.windowEndMs, reservePct: 45, nowMs: at, reason: 'x', linePct: rec.forceChargeLinePct, targetPct: 50, attempted: false, startClosed: 'noWrite', startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.ok(push.body.includes(WHY.noWrite!), push.body);
  assert.ok(q.rationale.includes(WHY.noWrite!), q.rationale);
  // The record is what it was: a recompute reads it and stamps nothing.
  assert.deepEqual(rec, armFromPlan(emptyActuationState(), '2027-01-04', p as never, open - 90 * M, 45, false, null, true));
});

test('★★★ U1c the wiring: only the plan the card and the entities serve reads the closed record; the plan of record (the ledger, the snapshot, the callers) never, an arm and a shadow leg no plan at all', () => {
  const at = INDEX.indexOf('async function recomputeNightChargePlan(');
  const fn = INDEX.slice(at, INDEX.indexOf('function armedExpectedBuyKwh(', at));
  const deps = fn.slice(0, fn.indexOf('const inputs = buildNightChargeInputs(deps);'));
  assert.ok(!deps.includes('armedLineStartClosed'), 'never in the inputs of the plan of record');
  assert.ok(fn.includes('  const plan = computeNightChargePlan(inputs);\n'), 'nor where it is computed');
  assert.ok(fn.includes('const lineClosed = shadowLeg == null && opts.arming !== true ? servedLineClosure(nightCycleView(), plan.window?.startMs ?? null, armedLineStartClosed(nightActuationMem, nowMs, forceChargeGatesOn(legRoleOf(nightActuationMem))), plan.window != null && noEveningArmLeft(plan.window.startMs, nowMs, eveningJobClock(nowMs))) : null;'), fn);
  assert.ok(fn.includes('if (!shadowLeg) setLatestNightChargePlan(lineClosed != null || lineNoReOn != null || lineRunOn != null ? computeNightChargePlan({ ...inputs, armedLineStartClosed: lineClosed, armedLineNoReOn: lineNoReOn, armedLineRunOnStartMs: lineRunOn }) : plan);'), fn);
  assert.equal([...INDEX.matchAll(/armedLineStartClosed: lineClosed/g)].length, 1, 'that one plan');
  assert.ok(/atomicWriteFileSync\(NIGHT_CHARGE_PLANSNAP_PATH, JSON\.stringify\(\{[\s\S]{0,300}?\n\s+plan, extras,\n/.test(fn), 'the snapshot holds the plan of record');
  assert.ok(fn.trimEnd().endsWith('return { plan, extras };\n}') || fn.includes('  return { plan, extras };\n}'), 'and the callers get it');
  assert.ok(INDEX.includes('...lineStartClosedStatus(nightActuationMem, Date.now(), forceChargeGatesOn(legRoleOf(nightActuationMem))),'), 'the status route');
});

test('★★★ U1c the ledger keeps its ask: the plan of record carries it, so a night missed by the evening job still strikes; the served plan could not', () => {
  const raw = planAt(45);
  const served = planAt(45, { closed: { windowStartMs: raw.window!.startMs, why: 'cancelled' } });
  assert.equal(lineForceChargeLedgerColumns(raw as never).cushion_line_force_charge_pct, raw.forceChargeLine!.askPct);
  assert.equal(lineForceChargeLedgerColumns(served as never).cushion_line_force_charge_pct, null, 'why the ledger never reads it');
  // Two computes on one set of inputs, as the recompute makes them: the first is the plan of record, whatever follows it.
  const inputs = buildNightChargeInputs({ ...caseOf(LABEL).deps, reserveFloorPct: 45, cushionPoolScale: MEASURED_SCALE, forceChargeEligible: false, lineForceChargeEligible: true } as never);
  const first = JSON.stringify(computeNightChargePlan(inputs));
  assert.equal(first, JSON.stringify(raw));
  computeNightChargePlan({ ...inputs, armedLineStartClosed: { windowStartMs: raw.window!.startMs, why: 'cancelled' } } as never);
  assert.equal(JSON.stringify(computeNightChargePlan(inputs)), first, 'the served compute leaves the inputs as it found them');
  const NOW = Date.UTC(2026, 9, 31, 4, 30);
  const row = (columns: Record<string, unknown>) => ({
    plan_date: phoenixYmd(NOW - 3 * 86_400_000), algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast',
    issued_at_ms: NOW - 3 * 86_400_000, outcome_captured_at_ms: NOW - 2 * 86_400_000,
    scored: 1, actuated: null, cushion_shortfall: 0, plan_traj_floor_breached: 0, cushion_breached: 1,
    buy_err_kwh: 0.5, pv_err_frac: 0.05, load_err_frac: -0.05, pv_in_band: 1, load_in_band: 1, grid_home_coverage_frac: 0.95,
    reserve_floor_pct: 30, cushion_pct: 15, cushion_line_soc_pct: 55.55, cushion_trough_soc_pct: 55.55, window_kind: 'overnight',
    force_charge_on_at_ms: null, window_close_soc_pct: 41, actual_min_soc_pct: 40, arm_disposition: 'missed — no write', ...columns,
  });
  const strikes = (columns: Record<string, unknown>) => computeNightChargeReadiness([row(columns)] as never, NOW).metrics.lineForceChargeStrikes;
  assert.equal(strikes(lineForceChargeLedgerColumns(raw as never)), 1);
  assert.equal(strikes(lineForceChargeLedgerColumns(served as never)), 0, 'the strike the widening must not lose');
});

/** The year's plans that arm at 45 with no armed record, each served against a record with its ask whose apply window passed: measured with the fix. */
// v1.202.0 — re-measured with the walks on the measured pool (v1.201.0: 628).
// v1.203.0 — 637: five lines in (49, 50], which the 50% reserve holds at 49, now carry an ask too.
const PIN_U1C_YEAR = { armed: 0, disclosed: 637 };

test('★★★ U1c the year: no plan of the window of a closed record arms or states a start, and none moves a sizing figure', () => {
  let isArmed = 0;
  let disclosed = 0;
  for (const c of CASES) {
    const a = planAt(45, { label: c.label, hours: 4 });
    if (a.forceChargeLine == null) continue;
    const p = planAt(45, { label: c.label, hours: 4, closed: { windowStartMs: a.window!.startMs, why: 'noWrite' } });
    if (p.forceChargeLine != null) isArmed++;
    if (p.cushionEnvelopeReason === 'startClosed') disclosed++;
    assert.deepEqual(sizing(p), sizing(a), c.label);
    assert.doesNotMatch(p.rationale, ON_CLAIM, c.label);
    assert.doesNotMatch(p.rationale, /tonight's write/, c.label);
  }
  assert.deepEqual({ armed: isArmed, disclosed }, PIN_U1C_YEAR);
});

test('★★★ U1c the banner of a line night whose start is closed says so, never "write armed"; Cancel stays while a write can still go; a night with no ask, or one a start can still reach, keeps its words', () => {
  const status = (s: NightActuationState, t: number, g: { cost: boolean; line: boolean } = GATES): Record<string, unknown> =>
    (cycle as unknown as { lineStartClosedStatus: (s: NightActuationState, t: number, g: { cost: boolean; line: boolean }) => Record<string, unknown> }).lineStartClosedStatus(s, t, g);
  const banner = cardText.actuationBannerState as unknown as (a: unknown, d: string | null, r?: number | null) => { text: string; settled: boolean; cancel: string | null };
  const card = (s: NightActuationState, t: number) => ({ ...s, cancelDeadlineMs: s.windowStartMs, ...status(s, t) });
  const past = OPEN + APPLY_LATE_MS + M;
  const NO_WRITE = 'No force-charge for the 55.6% outage line starts: no verified reserve write, and no reading of the target with every check clear, came in the apply window.';
  // Past the apply window with no write: at any reading, nothing left to cancel, and no write "stands".
  assert.deepEqual(status(armed(), past), { lineStartClosed: { text: NO_WRITE, cancel: false } });
  for (const reading of [45, 50, null]) assert.deepEqual(banner(card(armed(), past), '23:00', reading), { text: NO_WRITE, settled: false, cancel: null });
  assert.equal(cardText.writeStands(card(armed(), past) as never, 'supervised', past), false, 'the hold shape says nothing will be charged');
  // The late keys with no attempt: the same, in their words; the guard's own.
  assert.deepEqual(banner(card(armed(), CLOSE - 20 * M), '23:00', 45), { text: 'No force-charge for the 55.6% outage line starts: 20 min or less of the window is left.', settled: false, cancel: null });
  assert.deepEqual(status(armed({ nextOnPeakStartMs: CLOSE + 30 * M }), CLOSE - 30 * M), { lineStartClosed: { text: 'No force-charge for the 55.6% outage line starts: the on-peak guard (an hour before on-peak) has begun.', cancel: false } });
  // An attempt not confirmed: a reading of the target still adopts it and its restore goes, so Cancel means something; a start can come until the close less 20 min.
  const attempt = armed({ applyAttemptedAtMs: OPEN, attemptBaselinePct: 30 });
  assert.deepEqual(status(attempt, OPEN + H), {}, 'a start can still come');
  assert.equal(banner(card(attempt, OPEN + H), '23:00', 45).text, 'Supervised write armed — reserve → 50% at 23:00.');
  assert.deepEqual(status(attempt, CLOSE - 20 * M), { lineStartClosed: { text: 'No force-charge for the 55.6% outage line starts: 20 min or less of the window is left.', cancel: true } });
  assert.equal(banner(card(attempt, CLOSE - 20 * M), '23:00', 45).cancel, 'Cancel tonight');
  assert.equal(cardText.writeStands(card(attempt, CLOSE - 20 * M) as never, 'supervised', CLOSE - 20 * M), true);
  // A window so short that its last 20 minutes open inside the apply window: the write can still go, so its Cancel stays.
  const short = armed({ windowEndMs: OPEN + 40 * M });
  assert.deepEqual(status(short, OPEN + 25 * M), { lineStartClosed: { text: 'No force-charge for the 55.6% outage line starts: 20 min or less of the window is left.', cancel: true } });
  assert.equal(decideActuation(short, OPEN + 25 * M, TICK(45)).kind, 'apply');
  // A line stated at the reserve, unnumbered, and the ask where the line is unknown.
  assert.match((status(armed({ forceChargeLinePct: 50.003, forceChargeLineAskPct: 51 }), past).lineStartClosed as { text: string }).text, /^No force-charge for the outage line starts: /);
  assert.match((status(armed({ forceChargeLinePct: null }), past).lineStartClosed as { text: string }).text, /^No force-charge for the 56% outage line starts: /);
  // No ask, a start still to come, a force-charge that ran, the gate off: not a word.
  const noAsk = armed({ forceChargeLineAskPct: null, forceChargeLinePct: null });
  assert.deepEqual(status(noAsk, past), {});
  assert.equal(banner(card(noAsk, past), '23:00', 45).text, 'Supervised write armed — reserve → 50% at 23:00.', 'a cost night, byte for byte');
  assert.equal(banner(card(noAsk, past), '23:00', 45).cancel, 'Cancel tonight');
  // (Fix12) At a reading of the target the armed banner reads as a line night's, on a night with no line too: decideActuation has
  // nothing to raise there, so it is true, where v1.199.1 read "reserve → 50%" for a write that does not go. It needs no ask to know:
  // every reserveAtTarget night has none. Cancel stays. The one surface of a no-line night that differs from v1.199.1.
  assert.equal(decideActuation(noAsk, OPEN + M, TICK(50)).kind, 'none');
  assert.deepEqual(banner(card(noAsk, past), '23:00', 50), { text: 'Supervised write armed for 23:00 — the reserve reads 50%, so none is due while it does.', settled: false, cancel: 'Cancel tonight' });
  assert.equal(decideActuation(noAsk, OPEN + M, TICK(49)).kind, 'apply');
  assert.deepEqual(banner(card(noAsk, past), '23:00', 49), { text: 'Supervised write armed — reserve → 50% at 23:00.', settled: false, cancel: 'Cancel tonight' }, "under the target: v1.199.1's words");
  assert.deepEqual(status(armed(), OPEN + M), {});
  assert.deepEqual(status(applied({ forceChargeOnAtMs: OPEN + H }), CLOSE - 10 * M), {});
  assert.deepEqual(status(armed(), OPEN + M, { cost: false, line: false }), {}, "'gatedOff'");
  // Every state ahead of it keeps its own words, whatever a stale poll carried: nothing is added to an applied, cancelled, foreign or restored night.
  const carried = { ...armed(), cancelDeadlineMs: OPEN, lineStartClosed: { text: NO_WRITE, cancel: false } };
  assert.equal(banner({ ...carried, cancelled: true }, '23:00', 45).text, 'Cancelled — no write tonight.');
  assert.equal(banner({ ...carried, appliedAtMs: OPEN, priorReservePct: 30 }, '23:00', 50).text, 'Reserve raised to 50% (was 30%); auto-restores after the window closes.');
  assert.equal(banner({ ...carried, foreignSettledAtMs: OPEN, foreignReservePct: 40 }, '23:00', 40).settled, true);
  assert.equal(banner({ ...carried, appliedAtMs: OPEN, revertedAtMs: OPEN, priorReservePct: 30, revertVerifiedAtMs: OPEN }, '23:00', 30).text, 'Completed — reserve restored to 30%.');
  const CARD_SRC = readFileSync(resolve(HERE, '../../web/src/cards/NightChargeCard.tsx'), 'utf8');
  assert.ok(CARD_SRC.includes('lineStartClosed?: { text: string; cancel: boolean };'), 'the status field reaches the card');
});

/* ══ U2 — a write that does not land in its apply window ══════════════════════════════════════════════════════════════════ */

/** The tick's steps by the minute through the real decisions: the apply, the force-charge, the declined push; what the night owes. */
const walk = (start: NightActuationState, tick: (t: number) => { reserve: number | null; vitalsRed?: boolean; socCoherent?: boolean; cloud?: boolean; down?: boolean }) => {
  let s = start;
  let dp = { day: null as string | null, st: EMPTY_LINE_DECLINED_PUSH };
  const out = { missedAt: null as number | null, accountAt: null as number | null, declined: 0, on: false, attempts: 0 };
  for (let t = OPEN - 5 * M; t <= CLOSE + 2 * H; t += M) {
    const o = tick(t);
    if (o.down) continue;
    const a = decideActuation(s, t, { mode: 'supervised', writeReady: true, currentReservePct: o.reserve, socCoherent: o.socCoherent ?? true, vitalsRed: o.vitalsRed ?? false, gridPresent: true });
    if (a.kind === 'apply') {
      out.attempts++;
      s = { ...s, applyAttemptedAtMs: t, attemptBaselinePct: o.reserve };
      if (o.cloud !== false) s = { ...s, appliedAtMs: t, priorReservePct: o.reserve };
    }
    if (a.kind === 'adopt') s = { ...s, appliedAtMs: s.applyAttemptedAtMs, priorReservePct: a.priorPct };
    if (a.kind === 'applyVerified') s = { ...s, applyVerifiedAtMs: t };
    const f = decideForceCharge(s, t, fo({ vitalsRed: o.vitalsRed ?? false, socCoherent: o.socCoherent ?? true }));
    if (f.kind === 'on') out.on = true;
    const d = lineDeclinedPushTick(dp, s, f.kind === 'none' ? f.why : null, t, { cost: false, line: true });
    dp = d.mem;
    if (d.push != null) out.declined++;
    if (out.missedAt == null && missedApplyDue(asChargeLeg(s), t)) { out.missedAt = t; s = { ...s, missedApplyPushedAtMs: t } as NightActuationState; }
    if (out.accountAt == null && closeDue(s, t) != null) { out.accountAt = t; s = { ...s, lineCloseAccountAtMs: t } as NightActuationState; }
  }
  return out;
};
const AFTER_WINDOW = OPEN + APPLY_LATE_MS + M;

test('★★★ U2 every way the reserve write misses its apply window on a line night is pushed once, and accounted for at the close: nothing silent', () => {
  for (const [what, night, tick, wantAt] of [
    ['a reserve raised to the write in the app after the plan', armed(), () => ({ reserve: 50 }), AFTER_WINDOW],
    ['red vitals through the window', armed(), (t: number) => ({ reserve: 30, vitalsRed: t <= OPEN + 31 * M }), AFTER_WINDOW],
    ['an incoherent reading through the window', armed(), (t: number) => ({ reserve: 30, socCoherent: t > OPEN + 31 * M }), AFTER_WINDOW],
    ['a stale reserve reading through the window', armed(), (t: number) => ({ reserve: t <= OPEN + 31 * M ? null : 30 }), AFTER_WINDOW],
    ['a restart across the window', armed(), (t: number) => ({ reserve: 30, down: t >= OPEN - M && t <= OPEN + 40 * M }), OPEN + 41 * M],
    ['a reading above the envelope', armed(), () => ({ reserve: 60 }), AFTER_WINDOW],
  ] as Array<[string, NightActuationState, (t: number) => { reserve: number | null }, number]>) {
    const w = walk(night, tick);
    assert.equal(w.attempts, 0, `${what}: no write went`);
    assert.equal(w.on, false, `${what}: no ON`);
    assert.equal(w.missedAt, wantAt, `${what}: pushed once the apply window has passed`);
    assert.equal(w.accountAt, CLOSE, `${what}: accounted for at the close`);
  }
});

test('★★★ U2 a cloud refusing every apply: the attempts are on record, the push waits out the last attempt\'s readback grace, the words are the attempt\'s, and the close is accounted for', () => {
  const w = walk(armed(), () => ({ reserve: 30, cloud: false }));
  assert.equal(w.attempts, 31, 'an attempt a tick through the apply window');
  assert.equal(w.on, false);
  assert.equal(w.missedAt, OPEN + 30 * M + APPLY_VERIFY_AFTER_MS, 'the last attempt\'s grace');
  assert.equal(w.accountAt, CLOSE);
  // A landed write whose confirmation was lost is adopted on its reading: nothing to push.
  const landed = walk(armed(), (t) => ({ reserve: t <= OPEN ? 30 : 50, cloud: false }));
  assert.equal(landed.missedAt, null, 'adopted before the grace ended');
});

test('★★★ U2 missedApplyDue: a line ask widens the overnight leg; a night with no ask, a verified night, a cancelled night and a night already pushed are as before', () => {
  const late = OPEN + APPLY_LATE_MS + 1;
  assert.equal(missedApplyDue(leg(armed()), late), true, 'a line ask');
  assert.equal(missedApplyDue(leg(armed()), OPEN + APPLY_LATE_MS), false, 'the apply window still open');
  assert.equal(missedApplyDue(leg(armed({ forceChargeLineAskPct: null, forceChargeLinePct: null })), late), false, 'no ask: v1.199.1, only a write that never took effect pushes');
  assert.equal(missedApplyDue(leg(armed({ forceChargeLineAskPct: 50, forceChargeLinePct: 50 })), late), false, 'an ask at the reserve is no line');
  assert.equal(missedApplyDue(leg(applied()), late), false, 'applied');
  assert.equal(missedApplyDue(leg(armed({ cancelled: true })), late), false, 'cancelled');
  assert.equal(missedApplyDue(leg(armed({ announcedAtMs: null })), late), false, 'never announced');
  assert.equal(missedApplyDue(leg(armed(), { missedApplyPushedAtMs: late - M }), late), false, 'once');
  // An attempted write: only on a line ask, and only after the last attempt's readback grace.
  const attempted = armed({ applyAttemptedAtMs: OPEN + 30 * M, attemptBaselinePct: 30 });
  assert.equal(missedApplyDue(leg(attempted), OPEN + 30 * M + APPLY_VERIFY_AFTER_MS - 1), false, 'its grace');
  assert.equal(missedApplyDue(leg(attempted), OPEN + 30 * M + APPLY_VERIFY_AFTER_MS), true);
  assert.equal(missedApplyDue(leg({ ...attempted, forceChargeLineAskPct: null, forceChargeLinePct: null }), CLOSE), false, 'no ask: an attempt is not "missed"');
  assert.equal(missedApplyDue(leg({ ...attempted, forceChargeLineAskPct: null, forceChargeLinePct: null }, { leg: 'backup' }), CLOSE), false, 'a backup leg never carries a line: an attempt there is as before');
});

test('★★ U2 the cycle holds the promotion for a line night\'s push as for a mid-day leg\'s', () => {
  const late = OPEN + APPLY_LATE_MS + M;
  const pending = leg(armed({ day: '2027-01-05', windowStartMs: OPEN + 7 * H, windowEndMs: OPEN + 12 * H }));
  const c = { active: leg(armed()), pendingLegs: [pending], trailing: null };
  assert.equal(promoteCycle(c as never, late, 30), null, 'the push goes first');
  const stamped = { ...c, active: leg(armed(), { missedApplyPushedAtMs: late }) };
  assert.equal(promoteCycle(stamped as never, late, 30)?.promoted?.to.day, '2027-01-05');
});

test('★★★ U2 missedApplyReason names an attempt the cloud never confirmed, and a reserve already at the write', () => {
  const ctx = { blockedBy: null, mode: 'supervised' as const, vitalsRed: false, socCoherent: true, currentReservePct: 30, panelBlock: null };
  assert.equal(missedApplyReason(leg(armed({ applyAttemptedAtMs: OPEN + 30 * M })), ctx), 'the EcoFlow cloud did not confirm the reserve write');
  // v1.200.1 — on a line ask a reading of the target is no "nothing was due": the ride needed it in the window, with every check clear.
  assert.equal(missedApplyReason(leg(armed()), { ...ctx, currentReservePct: 50 }), "the panel's reserve reading did not reach the add-on with every check clear while the 30-minute apply window was open");
  assert.equal(missedApplyReason(leg(armed({ forceChargeLineAskPct: null, forceChargeLinePct: null })), { ...ctx, currentReservePct: 50 }), 'the backup reserve already read 50%, at or above the 50% this charge sets', 'no ask: as ever');
  // An attempt never changes a mid-day or backup leg's reason (it never reaches the push there).
  assert.equal(missedApplyReason(leg(armed({ applyAttemptedAtMs: OPEN, forceChargeLineAskPct: null, forceChargeLinePct: null })), ctx), 'no write was issued in the 30 minutes after the window opened');
});

const SPAN = /^Tonight's 11pm–5am /;

test('★★★ U2 the missed push on a line night: no write went, so no force-charge for the line starts, and what still holds it (Charge Now by hand); the words are v1.199.1\'s with no line', () => {
  const base = { day: '2027-01-04', role: 'cost' as const, windowStartMs: OPEN, windowEndMs: CLOSE, reservePct: 50, nowMs: OPEN + 31 * M };
  const reason = 'the backup reserve already read 50%, at or above the 50% this charge sets';
  const m = buildNightChargeMissedApply({ ...base, reason, linePct: 55.55, targetPct: 50, attempted: false, startClosed: 'noWrite', startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.equal(m.severity, 'warning', 'a person can act');
  assert.match(m.body, SPAN);
  assert.ok(m.body.endsWith(`charge did not start — ${reason}. Nothing was written; the reserve stays at 50%. No force-charge for tonight's 55.6% outage line starts: no verified reserve write, and no reading of the target with every check clear, came in the apply window. Charge Now switched on by hand in the EcoFlow app can still lift the pool tonight; switch it off again by ~5:00 AM.`), m.body);
  // Past the close nothing can be done by hand: no advice.
  const over = buildNightChargeMissedApply({ ...base, nowMs: CLOSE + H, reason, linePct: 55.55, targetPct: 50, attempted: false, startClosed: 'over', startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.ok(over.body.endsWith("No force-charge for Monday's 55.6% outage line starts: the window has closed."), over.body);
  // In the last 20 minutes Charge Now by hand still adds something.
  const late = buildNightChargeMissedApply({ ...base, reason, linePct: 55.55, targetPct: 50, attempted: false, startClosed: 'late', startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.ok(late.body.includes('20 min or less of the window is left. Charge Now switched on by hand'), late.body);
  // No line: v1.199.1, word for word and severity (overnightTextGolden holds the words).
  const plain = buildNightChargeMissedApply({ ...base, reason });
  assert.deepEqual(buildNightChargeMissedApply({ ...base, reason, linePct: null, targetPct: 50, attempted: true, startClosed: 'noWrite', startByText: '4:40 AM', closeText: '5:00 AM' } as never), plain);
  assert.equal(plain.severity, 'info');
});

test('★★★ U2 the push for an attempt never confirmed: it has not started, the force-charge waits on a reading of the target while a start can come, and a reading set by hand is what lets it (an attempt is adopted on it; a night with no attempt is not)', () => {
  const base = { day: '2027-01-04', role: 'cost' as const, windowStartMs: OPEN, windowEndMs: CLOSE, reservePct: 30, nowMs: OPEN + 35 * M, reason: 'the EcoFlow cloud did not confirm the reserve write' };
  const m = buildNightChargeMissedApply({ ...base, linePct: 55.55, targetPct: 50, attempted: true, startClosed: null, startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.equal(m.title, 'Night-charge: the reserve write has not been confirmed');
  assert.equal(m.severity, 'warning');
  assert.ok(m.body.endsWith("charge has not started: the EcoFlow cloud did not confirm the reserve write, and the panel reads 30%. Until the panel reads 50%, the reserve stays under tonight's 55.6% outage line, and the force-charge for the line waits on this write. To let it start, set the backup reserve to 50% in the EcoFlow app now: the sooner the panel reads it, the more of the line a start can reach. No force-charge starts after ~4:40 AM, and one that late may close under the line. If this repeats, check the SHP2 cloud link."), m.body);
  assert.doesNotMatch(m.body, /Nothing was written/);
  const dark = buildNightChargeMissedApply({ ...base, reservePct: null, linePct: 55.55, targetPct: 50, attempted: true, startClosed: null, startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  // No reading: the write may have landed with its confirmation lost (a write the cloud link dropped is the likeliest shape), so nothing is said of the reserve the panel holds.
  assert.ok(dark.body.includes("and the panel is not reporting its reserve. The force-charge for tonight's 55.6% outage line waits on a reading of 50%. To let it start, set the backup reserve to 50% in the EcoFlow app now"), dark.body);
  assert.doesNotMatch(dark.body, /normal reserve|stays under|keeps/);
  const closed = buildNightChargeMissedApply({ ...base, linePct: 55.55, targetPct: 50, attempted: true, startClosed: 'late', startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.ok(closed.body.endsWith("No force-charge for tonight's 55.6% outage line starts: 20 min or less of the window is left. If this repeats, check the SHP2 cloud link."), closed.body);
  assert.doesNotMatch(closed.body, /waits on|To let it start/);
  // The advice holds: a reading of the target adopts an attempt, verifies, and the start rides it; with no attempt it does not.
  const attempted = armed({ applyAttemptedAtMs: OPEN + 30 * M, attemptBaselinePct: 30 });
  const tick = { mode: 'supervised' as const, writeReady: true, currentReservePct: 50, socCoherent: true, vitalsRed: false, gridPresent: true };
  assert.equal(decideActuation(attempted, OPEN + 40 * M, tick).kind, 'adopt');
  assert.equal(decideActuation(armed(), OPEN + 40 * M, tick).kind, 'none', 'no attempt: a hand-set reserve starts nothing, so that push names Charge Now instead');
});

test('★★★ U2 a missed push sent late names the night it was, never "tonight": a restart past the close, the same day or the next, up to the next arm; while a start can come the night is tonight', () => {
  const base = { day: '2027-01-04', role: 'cost' as const, windowStartMs: OPEN, windowEndMs: CLOSE, reservePct: 30, reason: "the add-on's host was under critical load", linePct: 55.55, targetPct: 50, startByText: '4:40 AM', closeText: '5:00 AM' };
  for (const nowMs of [CLOSE + 3 * H, CLOSE + 15 * H]) {
    const m = buildNightChargeMissedApply({ ...base, nowMs, attempted: false, startClosed: 'over' } as never);
    assert.equal(m.title, "Charge plan: Monday's charge did not start");
    assert.ok(m.body.endsWith("Nothing was written; the reserve stays at 30%. No force-charge for Monday's 55.6% outage line starts: the window has closed."), m.body);
    assert.doesNotMatch(m.body, /[Tt]onight/, m.body);
    const t = buildNightChargeMissedApply({ ...base, nowMs, attempted: true, startClosed: 'over', reason: 'the EcoFlow cloud did not confirm the reserve write' } as never);
    assert.doesNotMatch(t.body, /[Tt]onight/, t.body);
  }
  // Past midnight, before the close: the record's day, as the head says.
  const small = buildNightChargeMissedApply({ ...base, nowMs: OPEN + 90 * M, attempted: false, startClosed: 'noWrite' } as never);
  assert.ok(small.body.startsWith("Monday's 11pm–5am charge did not start"), small.body);
  assert.ok(small.body.includes("No force-charge for Monday's 55.6% outage line starts"), small.body);
  // A window opening after midnight (the weekend's Monday 00:00) sent past its close the same day: never "Tonight's", head to tail.
  const MON = Date.UTC(2027, 0, 11, 7); // 00:00 MST, a Monday
  const end = MON + 5 * H;
  const late = buildNightChargeMissedApply({ ...base, windowStartMs: MON, windowEndMs: end, nowMs: end + 3 * H, attempted: false, startClosed: 'over' } as never);
  assert.equal(late.title, "Charge plan: Monday's charge did not start");
  assert.ok(late.body.startsWith("Monday's 12am–5am charge did not start"), late.body);
  assert.doesNotMatch(late.body, /[Tt]onight/, late.body);
  const lateT = buildNightChargeMissedApply({ ...base, windowStartMs: MON, windowEndMs: end, nowMs: end + 3 * H, attempted: true, startClosed: 'over', reason: 'the EcoFlow cloud did not confirm the reserve write' } as never);
  assert.ok(lateT.body.startsWith("Monday's 12am–5am charge has not started"), lateT.body);
  assert.doesNotMatch(lateT.body, /[Tt]onight/, lateT.body);
  // The on-peak guard past the add-on's close: as the close.
  const guard = buildNightChargeMissedApply({ ...base, windowStartMs: MON, windowEndMs: end, nowMs: MON + 2 * H, attempted: false, startClosed: 'overGuard' } as never);
  assert.doesNotMatch(guard.body, /[Tt]onight/, guard.body);
  assert.ok(guard.body.includes("No force-charge for Monday's 55.6% outage line starts: the on-peak guard"), guard.body);
  // Inside that window: tonight's.
  const inside = buildNightChargeMissedApply({ ...base, windowStartMs: MON, windowEndMs: end, nowMs: MON + H, attempted: false, startClosed: 'noWrite' } as never);
  assert.ok(inside.body.startsWith("Tonight's 12am–5am charge did not start"), inside.body);
  assert.ok(inside.body.includes("No force-charge for tonight's 55.6% outage line starts"), inside.body);
  // No line: v1.199.1's words, whatever the hour (overnightTextGolden holds them).
  const plainLate = buildNightChargeMissedApply({ ...base, linePct: null, windowStartMs: MON, windowEndMs: end, nowMs: end + 3 * H } as never);
  assert.ok(plainLate.body.startsWith("Tonight's 12am–5am charge did not start"), plainLate.body);
});

test('★★★ U2 the wiring: the step keys the push on the record\'s line, reads the start, and logs the line night\'s words; the cost-leg line stands', () => {
  const at = INDEX.indexOf('async function runMissedApplyStep(): Promise<void> {');
  const step = INDEX.slice(at, INDEX.indexOf('\n}\n', at));
  assert.ok(step.includes('const missedLinePct = forceChargeLineNightPct(leg);'), step);
  assert.ok(step.includes('const missedStartClosed = forceChargeStartClosed(leg, nowMs, forceChargeGatesOn(legRoleOf(leg)));'), step);
  assert.ok(step.includes('linePct: missedLinePct, targetPct: leg.targetPct, attempted: leg.applyAttemptedAtMs != null,'), step);
  assert.ok(step.includes('startClosed: missedStartClosed,'), step);
  assert.ok(step.includes('startByText: leg.windowEndMs != null ? fmtSiteClock(writeWindowEndMs(leg)! - FORCE_CHARGE_MIN_RUN_MS) : null,'), step);
  assert.ok(step.includes('closeText: leg.windowEndMs != null ? fmtSiteClock(writeWindowEndMs(leg)!) : null,'), step);
  assert.ok(step.includes('if (missedLinePct != null) app.log.warn(`night-charge: the ${leg.day} reserve write for the ${lineLogPct(leg)}% outage line ${leg.applyAttemptedAtMs != null ? \'has not been confirmed\' : \'was not issued\'} — ${reason}; the reserve reads ${currentReservePct ?? \'unknown\'}%, and ${missedStartClosed == null ? \'the force-charge for the line waits on a reading of the target\' : lineStartClosedWords(\'the line\', missedStartClosed)}.`);'), step);
  assert.ok(step.includes("else app.log.warn(`night-charge: the ${leg.leg} leg for ${leg.day} ("), 'the leg with no line keeps its line');
  // The disposition is what the gate reads (lineWriteNeverHeld).
  assert.ok(step.includes('stampLegOutcome(leg, { arm_disposition: `${MISSED_APPLY_DISPOSITION}${reason}` });'), step);
  assert.equal(MISSED_APPLY_DISPOSITION, 'missed — ');
});

test('★★★ U2 lineCloseAccountDue: a record with a line ask and nothing to restore, once, from its close: a write that never applied, or a reserve someone else set; never a night a summary accounts for', () => {
  assert.equal(closeDue(armed(), CLOSE - 1), null, 'before the close');
  assert.equal(closeDue(armed(), CLOSE), 'noWrite');
  assert.equal(closeDue(armed({ applyAttemptedAtMs: OPEN, attemptBaselinePct: 30 }), CLOSE + H), 'noWrite', 'an attempt never confirmed');
  assert.equal(closeDue(armed({ nextOnPeakStartMs: CLOSE + 10 * M }), CLOSE - 50 * M), 'noWrite', 'the add-on\'s close: the on-peak guard, when sooner');
  assert.equal(closeDue(applied({ foreignSettledAtMs: CLOSE - H }), CLOSE), 'foreign');
  assert.equal(closeDue(applied(), CLOSE), null, 'an applied night is restored, and its summary accounts for it');
  assert.equal(closeDue(applied({ revertedAtMs: CLOSE }), CLOSE + H), null);
  assert.equal(closeDue(applied({ foreignSettledAtMs: CLOSE + M, revertedAtMs: CLOSE }), CLOSE + H), null, 'its restore went: the summary goes');
  assert.equal(closeDue(armed({ cancelled: true }), CLOSE), null, 'the person\'s cancel');
  assert.equal(closeDue(armed({ forceChargeLineAskPct: null, forceChargeLinePct: null }), CLOSE), null, 'no ask: v1.199.1');
  assert.equal(closeDue(armed({ forceChargeLineAskPct: 50, forceChargeLinePct: 50 }), CLOSE), null, 'an ask at the reserve is no line');
  assert.equal(closeDue(armed({ day: null }), CLOSE), null);
  assert.equal(closeDue(armed({ lineCloseAccountAtMs: CLOSE } as Partial<NightActuationState>), CLOSE + M), null, 'once');
  assert.equal(closeDue(armed({ windowEndMs: null }), CLOSE), null);
  // The stamp survives a restart (a record from before it reads null).
  assert.equal(coerceActuationState({ ...armed(), lineCloseAccountAtMs: CLOSE } as never).lineCloseAccountAtMs, CLOSE);
  assert.equal(emptyActuationState().lineCloseAccountAtMs, null);
  // The two due functions never overlap: a restore summary and a close account for one record.
  for (const s of [armed(), applied(), applied({ revertedAtMs: CLOSE }), applied({ foreignSettledAtMs: CLOSE - H })]) {
    assert.equal(closeDue(s, CLOSE + H) != null && restoreSummaryDue(s, CLOSE + H, 30) != null, false);
  }
});

test('★★★ U2 the close account: what never ran, and where the pool stands against the line, in the present tense (a restart may send it late)', () => {
  const base = { day: '2027-01-04', linePct: 55.55 };
  const a = account({ ...base, cause: 'noWrite', closePoolPct: 41 });
  assert.equal(a.severity, 'info');
  assert.equal(a.dedupId, 'night_charge_actuation');
  assert.equal(a.title, 'Night-charge: no force-charge ran for the outage line');
  assert.equal(a.body, 'Supervised night charge for 2027-01-04: no verified reserve write, and no reading of the target with every check clear, came in the apply window, so no force-charge ran for the 55.6% outage line. The pool reads 41%, under the line.');
  assert.ok(account({ ...base, cause: 'noWrite', closePoolPct: 60 }).body.endsWith('The pool reads 60%, at or above the line.'));
  assert.ok(account({ ...base, cause: 'noWrite', closePoolPct: null }).body.endsWith('The pool was not read (no fresh panel reading).'));
  const f = account({ ...base, cause: 'foreign', closePoolPct: 53 });
  assert.equal(f.body, 'Supervised night charge for 2027-01-04: the reserve was set outside the add-on, so no force-charge ran for the 55.6% outage line. The pool reads 53%, under the line.');
  const ran = account({ ...base, cause: 'foreign', closePoolPct: 53, onAtMs: CLOSE - 95 * M, offAtMs: CLOSE - 60 * M, offReason: 'foreign' });
  assert.match(ran.title, /^Night-charge: the force-charge for the outage line was stopped$/);
  assert.match(ran.body, /^Supervised night charge for 2027-01-04: the reserve was set outside the add-on; the force-charge for the 55\.6% outage line ran from [^ ]+ until [^ ]+ \(switched off: the reserve was set outside the add-on\)\. The pool reads 53%, under the line\.$/);
  // An ON the window's OFF ended (the restore refused, then someone else's reserve): never "switched off: windowEnd".
  const closeOff = account({ ...base, cause: 'foreign', closePoolPct: 60, onAtMs: CLOSE - 95 * M, offAtMs: CLOSE, offReason: 'windowEnd' });
  assert.doesNotMatch(closeOff.body, /windowEnd/);
  assert.match(closeOff.body, /ran from [^ ]+ to the window close\./);
  // A line stated at the reserve is named so the order shows.
  assert.ok(account({ day: 'd', linePct: 50.03, cause: 'noWrite', closePoolPct: 50 }).body.includes('the 50.03% outage line. The pool reads 50%, under the line.'));
  // …and beside the reading it is read against: one decimal would read as the pool, in the sentence that says the pool is under it.
  assert.ok(account({ day: 'd', linePct: 55.62, cause: 'noWrite', closePoolPct: 55.6 }).body.endsWith('the 55.62% outage line. The pool reads 55.6%, under the line.'));
  assert.ok(account({ day: 'd', linePct: 56.03, cause: 'noWrite', closePoolPct: 56 }).body.endsWith('the 56.03% outage line. The pool reads 56%, under the line.'));
  assert.ok(account({ day: 'd', linePct: 56.03, cause: 'foreign', closePoolPct: 56, onAtMs: CLOSE - 95 * M, offAtMs: CLOSE, offReason: 'windowEnd' }).body.includes('the force-charge for the 56.03% outage line ran from'));
  assert.ok(account({ day: 'd', linePct: 55.6, cause: 'noWrite', closePoolPct: 56 }).body.includes('the 55.6% outage line. The pool reads 56%, at or above the line.'), 'apart, one decimal');
});

test('★★★ U2 the close account is wired after the missed step, on the active record, stamped before it goes, with a fresh pool reading', () => {
  const tick = INDEX.slice(INDEX.indexOf('async function runNightActuationTick(): Promise<void> {'), INDEX.indexOf('/** v1.166.0 — reasons already logged for the current night'));
  const missed = tick.indexOf('await runMissedApplyStep();');
  const closeStep = tick.indexOf('runLineCloseAccountStep();');
  assert.ok(missed > 0 && closeStep > missed, tick);
  const at = INDEX.indexOf('function runLineCloseAccountStep(): void {');
  const step = INDEX.slice(at, INDEX.indexOf('\n}\n', at));
  const stamp = step.indexOf('persistNightActuation({ ...state, lineCloseAccountAtMs: nowMs });');
  assert.ok(stamp > 0 && stamp < step.indexOf('sendNotification('), step);
  assert.ok(step.includes('const due = lineCloseAccountDue(state, nowMs);'), step);
  assert.ok(step.includes('    closePoolPct: freshPoolSocPct(nowMs),\n    onAtMs: state.forceChargeOnAtMs,'), step);
  assert.ok(step.includes('onAtMs: state.forceChargeOnAtMs, offAtMs: state.forceChargeOffAtMs, offReason: state.forceChargeOffReason,'), step);
});

test('★★★ U2 the strike: a night armed for its line whose write never held and that closed under it is a run-time refusal, carried or disclosed; a cancel before the write, and a night that held, are not', () => {
  const NOW = Date.UTC(2026, 9, 31, 4, 30);
  const row = (f: Record<string, unknown>) => ({
    plan_date: phoenixYmd(NOW - 3 * 86_400_000), algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast',
    issued_at_ms: NOW - 3 * 86_400_000, outcome_captured_at_ms: NOW - 2 * 86_400_000,
    scored: 1, actuated: null, cushion_shortfall: 0, cushion_envelope_shortfall: 0, plan_traj_floor_breached: 0, cushion_breached: 1,
    buy_err_kwh: 0.5, pv_err_frac: 0.05, load_err_frac: -0.05, pv_in_band: 1, load_in_band: 1, grid_home_coverage_frac: 0.95,
    reserve_floor_pct: 30, cushion_pct: 15, cushion_line_soc_pct: 55.55, cushion_trough_soc_pct: 55.55, window_kind: 'overnight',
    cushion_line_force_charge_pct: 56, force_charge_on_at_ms: null, window_close_soc_pct: 41, actual_min_soc_pct: 40, arm_disposition: 'missed — no write',
    ...f,
  });
  const run = (f: Record<string, unknown>) => computeNightChargeReadiness([row(f)] as never, NOW).metrics;
  const missed = run({});
  assert.deepEqual([missed.activeStrikes, missed.lineForceChargeStrikes, missed.strikesMeasurable], [1, 1, 1], 'carried, missed, closed under');
  assert.equal(run({ actuated: 0, arm_disposition: null }).activeStrikes, 1, 'an accepted write that never landed (applyFailed)');
  assert.equal(run({ cushion_shortfall: 1, cushion_envelope_shortfall: 1 }).activeStrikes, 1, 'disclosed and armed: the plan disclosed its walk, not this');
  assert.equal(run({ cushion_shortfall: 1, actuated: 0, arm_disposition: null }).activeStrikes, 1);
  assert.equal(run({ window_close_soc_pct: 60 }).activeStrikes, 0, 'held');
  assert.equal(run({ window_close_soc_pct: 55.5 }).activeStrikes, 0, 'at the line less the scorer\'s tolerance');
  assert.equal(run({ arm_disposition: null }).activeStrikes, 0, 'no record of a miss: not armed, or cancelled before the write');
  assert.equal(run({ arm_disposition: 'cancelled by the 2026-10-28 plan — x' }).activeStrikes, 0);
  assert.equal(run({ cushion_line_force_charge_pct: null }).activeStrikes, 0, 'no line armed');
  assert.equal(run({ force_charge_on_at_ms: NOW - 3 * 86_400_000 + 3 * 3_600_000 }).activeStrikes, 0, 'a hand-set reserve let it start: the row is judged as actuated when it is');
  assert.equal(run({ cushion_line_force_charge_pct: null, arm_disposition: 'missed — no write', actuated: null }).strikesMeasurable, 1, 'a carried row is graded as before');
});

test('★★★ U2 an ON or a ceiling sync the write block refuses is a held start like any other: a blocker class, pushed by the same tick', () => {
  const W = nfc.FORCE_CHARGE_BLOCKER_WHY as unknown as Record<string, string>;
  assert.equal(W.writeBlock, 'the add-on is not writing to the panel: ');
  assert.equal(nfc.forceChargeBlockerClass(`${W.writeBlock}two smart panels present`), 'writeBlock');
  const s = applied();
  let mem = { day: null as string | null, st: EMPTY_LINE_DECLINED_PUSH };
  const pushes: string[] = [];
  for (let t = OPEN + H; t < OPEN + H + 15 * M; t += M) {
    const d = lineDeclinedPushTick(mem, s, `${W.writeBlock}two smart panels present`, t, { cost: false, line: true });
    mem = d.mem;
    if (d.push != null) pushes.push(d.push);
  }
  assert.deepEqual(pushes, ['writeBlock'], 'once, after 10 min unbroken');
  // The tick: one closure behind every held start, on the 'none' tick and on the two refusals.
  const at = INDEX.indexOf('async function runForceChargeTick(');
  const tick = INDEX.slice(at, INDEX.indexOf('\n}\n', at));
  assert.ok(tick.includes('const pushLineDeclinedIfDue = (why: string | null | undefined): void => {'), 'the closure');
  assert.ok(tick.includes("    pushLineDeclinedIfDue(action.why);\n    judgeLineNight();\n    return;\n"), 'the none tick');
  assert.ok(tick.includes("if (blocked) { app.log.warn(`night-charge: force-charge ON refused — ${blocked}`); pushLineDeclinedIfDue(`${FORCE_CHARGE_BLOCKER_WHY.writeBlock}${blocked}`); return; }"), 'the ON');
  assert.ok(tick.includes("if (blocked) { app.log.warn(`night-charge: force-charge ceiling sync refused — ${blocked}`); if (whileOn) judgeLineNight(); else pushLineDeclinedIfDue(`${FORCE_CHARGE_BLOCKER_WHY.writeBlock}${blocked}`); return; }"), 'the ceiling sync');
});

/* ══ U3 — the reserve settles as someone else's ═══════════════════════════════════════════════════════════════════════════ */

test('★★★ U3 the foreign push on a line night says what happens to the force-charge, that setting the reserve back does not undo it, and what still holds the line; a night with no line is v1.199.1\'s word for word', () => {
  const base = { day: '2027-01-04', pct: 40, targetPct: 50, restorePct: 30 };
  const plain = buildNightChargeForeignReserve(base);
  assert.equal(plain.body, buildNightChargeForeignReserve({ ...base, line: null } as never).body);
  assert.equal(plain.severity, 'info');
  const not = buildNightChargeForeignReserve({ ...base, line: { linePct: 55.55, started: false, closeText: '5:00 AM' } } as never);
  assert.equal(not.severity, 'warning');
  assert.ok(not.body.startsWith(plain.body), not.body);
  assert.equal(not.body.slice(plain.body.length), " No force-charge for tonight's 55.6% outage line starts: the reserve was set outside the add-on, and setting it back does not change that. The pool may close under the line. Charge Now switched on by hand in the EcoFlow app can still lift the pool tonight; switch it off again by ~5:00 AM.");
  const on = buildNightChargeForeignReserve({ ...base, line: { linePct: 55.55, started: true, closeText: '5:00 AM' } } as never);
  assert.equal(on.body.slice(plain.body.length), " The force-charge for tonight's 55.6% outage line rode that write, so the add-on switches it off, and it does not start again, whatever the reserve reads later. The pool may close under the line. Charge Now switched on by hand in the EcoFlow app can still lift the pool tonight; switch it off again by ~5:00 AM.");
  // A line the reserve holds is never said to close under it. v1.203.0 — the panel holds the pool one point under a reserve it
  // charged up to, so a 50% reserve holds 49: a line at 49 is held, and one at 50 is not (the pool may close under it).
  const at49 = buildNightChargeForeignReserve({ ...base, line: { linePct: 49, started: false, closeText: '5:00 AM' } } as never);
  assert.doesNotMatch(at49.body, /under the line/);
  const at50 = buildNightChargeForeignReserve({ ...base, line: { linePct: 50, started: false, closeText: '5:00 AM' } } as never);
  assert.match(at50.body, / The pool may close under the line\. /);
});

test('★★★ U3 the claims hold on the real decisions: the force-charge stops or never starts, and a reserve set back restarts nothing', () => {
  const FOREIGN_AT = CLOSE - 60 * M;
  const before = applied({ foreignSettledAtMs: FOREIGN_AT, foreignReservePct: 40 });
  const during = applied({ foreignSettledAtMs: FOREIGN_AT, foreignReservePct: 40, forceChargeOnAtMs: CLOSE - 95 * M, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: CLOSE - 90 * M, forceChargeMode: 'line' });
  assert.equal(decideForceCharge(during, FOREIGN_AT + M, fo({ slotsOn: [1, 2, 3], poolSocPct: 55 })).kind, 'off');
  for (let t = FOREIGN_AT; t < CLOSE; t += M) {
    const a = decideActuation(before, t, { mode: 'supervised', writeReady: true, currentReservePct: 50, socCoherent: true, vitalsRed: false, gridPresent: true });
    assert.equal(a.kind, 'none', 'a reading of the target settles nothing back');
    assert.notEqual(decideForceCharge(before, t, fo()).kind, 'on');
  }
});

test('★★★ U3 the wiring: the settled tick tells the push what stands, keyed on the record and before the close; the morning has its account', () => {
  const block = INDEX.slice(INDEX.indexOf("if (action.kind === 'foreignSettled') {"), INDEX.indexOf("if (action.kind === 'applyVerified') {"));
  assert.ok(block.includes('line: foreignLineWords(state, nowMs),'), block);
  const at = INDEX.indexOf('function foreignLineWords(');
  const fn = INDEX.slice(at, INDEX.indexOf('\n}\n', at));
  assert.ok(fn.includes('const linePct = forceChargeLineNightPct(state);'), fn);
  assert.ok(fn.includes('const closeMs = writeWindowEndMs(state);'), fn);
  assert.ok(fn.includes('if (linePct == null || closeMs == null || nowMs >= closeMs || state.forceChargeOffAtMs != null) return null;'), fn);
  assert.ok(fn.includes('return { linePct, started: state.forceChargeOnAtMs != null, closeText: fmtSiteClock(closeMs) };'), fn);
});

/* ══ U4 — a line night ended by a grid loss or a cancel ═══════════════════════════════════════════════════════════════════ */

test('★★★ U4 the grid-loss and cancelled accounts of a line night name the line and where the pool stands, in the present tense (the stop is no close); a night with no line is v1.199.1\'s', () => {
  const base = { day: '2027-01-04', targetPct: 50, restorePct: 30, expectedKwh: 20 };
  for (const ended of ['gridLoss', 'cancelled'] as const) {
    const plain = buildNightChargeMorningSummary({ ...base, ended });
    assert.equal(plain.body, buildNightChargeMorningSummary({ ...base, ended, closePoolPct: null, linePct: null }).body, 'no line');
    assert.equal(plain.body, buildNightChargeMorningSummary({ ...base, ended, closePoolPct: 53, linePct: null, closeText: '5:00 AM' } as never).body, 'no line, whatever else');
    const under = buildNightChargeMorningSummary({ ...base, ended, closePoolPct: 53, linePct: 55.55 } as never);
    assert.equal(under.body, `${plain.body} The pool reads 53%, under the 55.6% outage line.`, ended);
    const above = buildNightChargeMorningSummary({ ...base, ended, closePoolPct: 60, linePct: 55.55 } as never);
    assert.equal(above.body, `${plain.body} The pool reads 60%, at or above the 55.6% outage line.`, ended);
    const unread = buildNightChargeMorningSummary({ ...base, ended, closePoolPct: null, linePct: 55.55 } as never);
    assert.equal(unread.body, `${plain.body} The pool was not read (no fresh panel reading); the outage line is 55.6%.`, ended);
    // The line named beside the reading and the 50% the same body states, as the close account names it.
    assert.ok(buildNightChargeMorningSummary({ ...base, ended, closePoolPct: 53, linePct: 50.03 } as never).body.endsWith('The pool reads 53%, at or above the 50.03% outage line.'), ended);
    assert.ok(buildNightChargeMorningSummary({ ...base, ended, closePoolPct: 49, linePct: 50.03 } as never).body.endsWith('The pool reads 49%, under the 50.03% outage line.'), ended);
    const acked = buildNightChargeMorningSummary({ ...base, ended, restore: 'acknowledged', closePoolPct: 53, linePct: 55.55 } as never);
    assert.ok(acked.body.endsWith('Nothing more is charged tonight. The pool reads 53%, under the 55.6% outage line.'), acked.body);
  }
});

test('★★★ U4 a grid loss before the close says what can still hold the line once the grid is back; a cancel, and a stop at or after the close, do not', () => {
  const base = { day: '2027-01-04', targetPct: 50, restorePct: 30, expectedKwh: 20, closePoolPct: 53, linePct: 55.55 };
  const tail = ' Charge Now switched on by hand in the EcoFlow app can still lift the pool once the grid is back; switch it off again by ~5:00 AM.';
  assert.ok(buildNightChargeMorningSummary({ ...base, ended: 'gridLoss', closeText: '5:00 AM' } as never).body.endsWith(`under the 55.6% outage line.${tail}`));
  assert.ok(!buildNightChargeMorningSummary({ ...base, ended: 'gridLoss', closeText: null } as never).body.includes('Charge Now switched on by hand'), 'past the close');
  assert.ok(!buildNightChargeMorningSummary({ ...base, ended: 'cancelled', closeText: '5:00 AM' } as never).body.includes('Charge Now switched on by hand'), 'the person\'s cancel');
  // Held: nothing to hold.
  assert.ok(!buildNightChargeMorningSummary({ ...base, closePoolPct: 60, ended: 'gridLoss', closeText: '5:00 AM' } as never).body.includes('Charge Now switched on by hand'), 'at or above the line');
  const at = INDEX.indexOf('function sendRestoreSummary(');
  const fn = INDEX.slice(at, INDEX.indexOf('\n}\n', at));
  assert.ok(fn.includes('closeText: lineNight != null && state.windowEndMs != null && nowMs < writeWindowEndMs(state)! ? fmtSiteClock(writeWindowEndMs(state)!) : null,'), fn);
});

/* ══ U6 — (Fix10 review 1) what the night can no longer do, told on every surface ═════════════════════════════════════════ */

const RUN = (over: Partial<NightActuationState> = {}): NightActuationState => applied({
  forceChargeOnAtMs: CLOSE - 2 * H, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: CLOSE - 2 * H + 16 * M, forceChargeMode: 'line', ...over,
});
const STOP_AT = CLOSE - H;
const STOPPED_CASES = (): Array<[string, Partial<NightActuationState>]> => [
  ['cancelled', { cancelled: true }],
  ['reverted', { revertedAtMs: STOP_AT }],
  ['foreign', { foreignSettledAtMs: STOP_AT, foreignReservePct: 40 }],
  ['stopped', { forceChargeOffAtMs: STOP_AT, forceChargeOffReason: 'gridLoss' }],
  ['stopped', { forceChargeOffAtMs: STOP_AT, forceChargeOffReason: 'disabled' }],
  ['cancelled', { cancelled: true, forceChargeOffAtMs: STOP_AT, forceChargeOffReason: 'cancelled' }],
  ['foreign', { foreignSettledAtMs: STOP_AT, foreignReservePct: 40, forceChargeOffAtMs: STOP_AT, forceChargeOffReason: 'foreign' }],
];

test('★★★ U6 a run stopped for good is a closed start: every stamp behind "started", and an OFF of ours; a run that can still run or be switched back on stays armed', () => {
  for (const [why, over] of STOPPED_CASES()) {
    const s = RUN(over);
    const t = STOP_AT + 15 * M;
    assert.equal(nfc.forceChargeStartClosed(s, t, GATES), 'started', "the pushes' own key stays");
    assert.equal(closedRec(s, t)?.why, why, JSON.stringify(over));
    assert.equal(closedRec(s, t)?.windowStartMs, OPEN);
    // Nothing starts or comes back on any of them, on the real decisions, whatever the pool reads.
    for (let at = t; at < CLOSE; at += 5 * M) {
      assert.notEqual(decideForceCharge(s, at, fo({ poolSocPct: 52, slotsOn: [] })).kind, 'on');
      assert.notEqual(decideForceCharge(s, at, fo({ poolSocPct: 52, slotsOn: [] })).kind, 'lineReOn');
      if (s.forceChargeOffAtMs != null) assert.equal(nfc.lineReOnDue(s, at, fo({ poolSocPct: 52, slotsOn: [] }), [1, 2, 3]), null, 'an OFF of ours: never again');
    }
  }
  const t = CLOSE - H;
  assert.equal(closedRec(RUN(), t), null, 'a verified ON still running');
  assert.equal(closedRec(RUN({ forceChargeLinePanelOffAtMs: t - 10 * M } as Partial<NightActuationState>), t), null, "the panel's own stop: the re-ON can still bring it back");
  assert.notEqual(nfc.lineReOnDue(RUN({ forceChargeLinePanelOffAtMs: t - 10 * M } as Partial<NightActuationState>), t, fo({ poolSocPct: 52, slotsOn: [] }), [1, 2, 3]), null, 'and does');
  assert.equal(closedRec(RUN({ forceChargeOnVerifiedAtMs: null }), t), null, 'an ON no reading has judged yet: it may still verify');
  assert.equal(closedRec(RUN({ forceChargeOffAtMs: STOP_AT, forceChargeLineAskPct: null, forceChargeLinePct: null }), t), null, 'a cost night: not a word');
  assert.deepEqual([nfc.lineStartClosedWords('it', 'stopped' as never), nfc.lineStartClosedWords('the 55.6% outage line', 'stopped' as never)],
    ['the force-charge for it was switched off and does not start again', 'the force-charge for the 55.6% outage line was switched off and does not start again']);
});

test('★★★ U6 the served plan of a stopped run claims no ON: the row, the rationale and the banner say what the push says', () => {
  const base = planAt(45);
  const open = base.window!.startMs;
  for (const [why, words] of [
    ['stopped', 'the force-charge for it was switched off and does not start again'],
    ['cancelled', 'no force-charge for it starts: the night was cancelled'],
    ['foreign', 'no force-charge for it starts: the reserve was changed'],
    ['reverted', "no force-charge for it starts: the reserve's restore was sent"],
  ] as const) {
    const p = planAt(45, { closed: { windowStartMs: open, why } });
    assert.equal(p.forceChargeLine, undefined, why);
    assert.equal(p.cushionEnvelopeReason, 'startClosed', why);
    assert.equal((p as unknown as { cushionStartClosedWords: string }).cushionStartClosedWords, words);
    assert.ok(p.rationale.includes(words), p.rationale);
    assert.doesNotMatch(p.rationale, ON_CLAIM, p.rationale);
    const row = cardText.outageLineRow(p as never, 50)!;
    assert.ok(row.includes(`not claimed tonight (${words})`), row);
    assert.doesNotMatch(row, /stays on|switches it back on|expected at the close/, row);
    assert.deepEqual(sizing(p), sizing(base), why);
  }
  // The status keeps its words for the banner, on a stopped run with nothing applied, and a banner of an applied night keeps its own.
  const status = (cycle as unknown as { lineStartClosedStatus: (s: NightActuationState, t: number, g: { cost: boolean; line: boolean }) => Record<string, unknown> }).lineStartClosedStatus;
  const off = RUN({ forceChargeOffAtMs: STOP_AT, forceChargeOffReason: 'gridLoss' });
  assert.deepEqual(status(off, STOP_AT + M, GATES), { lineStartClosed: { text: 'The force-charge for the 55.6% outage line was switched off and does not start again.', cancel: true } });
  assert.equal(cardText.actuationBannerState({ ...off, ...status(off, STOP_AT + M, GATES), cancelDeadlineMs: OPEN } as never, '23:00', 50).text, 'Reserve raised to 50% (was 30%); auto-restores after the window closes.');
});

test('★★★ U6 whether a write stands travels with the closure: verified, and neither cancelled, restored nor set outside the add-on', () => {
  const stands = (s: NightActuationState, t: number) => (closedRec(s, t) as unknown as { writeStands?: boolean } | null)?.writeStands === true;
  assert.equal(stands(applied(), CLOSE - 20 * M), true, "a verified write, 'late': the reserve stands");
  assert.equal(stands(RUN({ forceChargeOffAtMs: STOP_AT }), STOP_AT + M), true, 'an OFF leaves the write in place');
  assert.equal(stands(applied({ applyVerifiedAtMs: null }), CLOSE - 20 * M), false, 'acknowledged, never read back');
  assert.equal(stands(applied({ cancelled: true }), OPEN + H), false);
  assert.equal(stands(applied({ revertedAtMs: OPEN + H }), OPEN + H), false);
  assert.equal(stands(applied({ foreignSettledAtMs: OPEN + H }), OPEN + H), false);
  assert.equal(stands(armed(), OPEN + APPLY_LATE_MS + 1), false, 'noWrite');
  const base = planAt(45);
  const open = base.window!.startMs;
  assert.equal((planAt(45, { closed: { windowStartMs: open, why: 'noWrite' } }) as never as { cushionStartClosedNoWrite?: boolean }).cushionStartClosedNoWrite, true);
  assert.equal((planAt(45, { closed: { windowStartMs: open, why: 'late', writeStands: true } as never }) as never as { cushionStartClosedNoWrite?: boolean }).cushionStartClosedNoWrite, undefined);
  assert.equal((base as never as { cushionStartClosedNoWrite?: boolean }).cushionStartClosedNoWrite, undefined);
});

test('★★★ U6 the card leads with a closed start no write stands behind, and names no reserve set or held; a write that stands keeps its figure, and any other night its own', () => {
  const lead = (cardText as unknown as { startClosedLead: (p: unknown) => { headline: string; detail: string } | null }).startClosedLead;
  const open = planAt(45).window!.startMs;
  for (const [why, detail] of [
    ['noWrite', 'No force-charge for it starts: no verified reserve write, and no reading of the target with every check clear, came in the apply window.'],
    ['cancelled', 'No force-charge for it starts: the night was cancelled.'],
    ['foreign', 'No force-charge for it starts: the reserve was changed.'],
    ['reverted', "No force-charge for it starts: the reserve's restore was sent."],
    ['noArm', 'No force-charge for it starts: no write is armed for this window.'],
  ] as const) {
    const p = planAt(45, { closed: { windowStartMs: open, why } });
    assert.deepEqual(lead(p), { headline: 'The outage line is not claimed tonight', detail }, why);
  }
  assert.equal(lead(planAt(45, { closed: { windowStartMs: open, why: 'late', writeStands: true } as never })), null, 'a write that stands: its figure is true');
  assert.equal(lead(planAt(45, { closed: { windowStartMs: open, why: 'stopped', writeStands: true } as never })), null);
  assert.equal(lead(planAt(45)), null, 'armed');
  assert.equal(lead(planAt(51)), null, 'reserveAtTarget');
  assert.equal(lead(planAt(45, { noLineAt: open })), null, 'armedNoLine: its write goes');
  const CARD = readFileSync(resolve(HERE, '../../web/src/cards/NightChargeCard.tsx'), 'utf8');
  assert.ok(CARD.includes('const closedLead = startClosedLead(plan);'), CARD);
  assert.ok(/\{refused \? \([\s\S]{0,300}?\) : closedLead \? \(\n\s+<div className="mb-3 text-sm">\n\s+<div className="text-warn font-medium">\{closedLead\.headline\}<\/div>\n\s+<div className="text-muted mt-1 leading-relaxed">\{closedLead\.detail\}<\/div>\n\s+<\/div>\n\s+\) : \(/.test(CARD), 'the same shape as the refused lead, ahead of the figure');
  assert.ok(CARD.includes('closedLead != null ? null : reserveWriteLabel(plan.setpointSocPct, plan.targetSocPct, status.reserveWriteMaxPct ?? null, plan.lineReserveStands === true),'), 'the stat names no reserve set');
  assert.ok(CARD.includes('cushionStartClosedNoWrite?: boolean;'), 'the field reaches the card');
});

test('★★★ U6 noEveningArmLeft: only once no evening job can run before the window opens; the weekend\'s shared window, and a night inside its own window', () => {
  const left = (cycle as unknown as { noEveningArmLeft: (w: number, now: number, j: { consumed: boolean; fireMin: number; nowMin: number }) => boolean }).noEveningArmLeft;
  const FIRE = 21 * 60 + 30;
  const at = (hoursBeforeOpen: number) => OPEN - hoursBeforeOpen * H;
  const min = (hoursBeforeOpen: number) => 23 * 60 - hoursBeforeOpen * 60;
  assert.equal(left(OPEN, at(10), { consumed: false, fireMin: FIRE, nowMin: min(10) }), false, '13:00: tonight\'s job is ahead');
  assert.equal(left(OPEN, at(1), { consumed: false, fireMin: FIRE, nowMin: min(1) }), false, '22:00: deferred, still retrying');
  assert.equal(left(OPEN, at(1), { consumed: true, fireMin: FIRE, nowMin: min(1) }), true, '22:00: latched');
  assert.equal(left(OPEN + 24 * H - 90 * M, at(1), { consumed: true, fireMin: FIRE, nowMin: min(1) }), true, 'a window opening as the next job fires: that job cannot arm it');
  assert.equal(left(OPEN + 24 * H - 90 * M + 1, at(1), { consumed: true, fireMin: FIRE, nowMin: min(1) }), false, 'a millisecond later it can');
  assert.equal(left(OPEN, OPEN + 5 * M, { consumed: true, fireMin: FIRE, nowMin: 23 * 60 + 5 }), true, 'past the cutoff');
  assert.equal(left(OPEN, OPEN + 3 * H, { consumed: false, fireMin: FIRE, nowMin: 2 * 60 }), true, "02:00: the new day's job fires after this window opened");
  // Saturday's job for the Monday 00:00 window: Sunday's can still arm it. On Sunday, once latched, none can.
  const MON = Date.UTC(2027, 0, 11, 7);
  const sat2200 = MON - 26 * H;
  assert.equal(left(MON, sat2200, { consumed: true, fireMin: FIRE, nowMin: 22 * 60 }), false, 'Saturday, latched: Sunday\'s job is ahead');
  assert.equal(left(MON, MON - 2 * H, { consumed: true, fireMin: FIRE, nowMin: 22 * 60 }), true, 'Sunday, latched');
  assert.equal(left(MON, MON - 2 * H, { consumed: false, fireMin: FIRE, nowMin: 22 * 60 }), false, 'Sunday, not yet');
});

test('★★★ U6 servedLineClosure: the record of the window speaks for it; any leg of that window holds it; with none, and no evening job left, no write is armed', () => {
  const served = (cycle as unknown as { servedLineClosure: (c: unknown, w: number | null, rec: unknown, noneLeft: boolean) => unknown }).servedLineClosure;
  const view = (active: NightActuationState, pending: NightActuationState[] = []) => ({ active, pendingLegs: pending, trailing: null });
  const TONIGHT = OPEN + 24 * H;
  const closedOld = { windowStartMs: OPEN, why: 'over' };
  assert.deepEqual(served(view(armed()), TONIGHT, closedOld, true), { windowStartMs: TONIGHT, why: 'noArm' }, "last night's closed record is no record of tonight");
  assert.equal(served(view(armed()), TONIGHT, closedOld, false), null, 'a job can still arm it');
  assert.equal(served(view(emptyActuationState()), TONIGHT, null, false), null);
  assert.deepEqual(served(view(emptyActuationState()), TONIGHT, null, true), { windowStartMs: TONIGHT, why: 'noArm' });
  assert.deepEqual(served(view(armed()), OPEN, closedOld, true), closedOld, "the record's own closure");
  assert.equal(served(view(armed()), OPEN, null, true), null, 'its record, a start still to come');
  assert.equal(served(view(armed({ forceChargeLineAskPct: null, forceChargeLinePct: null })), OPEN, null, true), null, 'its record with no ask: armedNoLine has it');
  assert.equal(served(view(emptyActuationState(), [armed({ windowStartMs: TONIGHT })]), TONIGHT, null, true), null, 'a pending leg of the window');
  assert.equal(served({ active: emptyActuationState(), pendingLegs: [], trailing: armed({ windowStartMs: TONIGHT }) }, TONIGHT, null, true), null, 'a trailing leg of the window');
  assert.equal(served(view(emptyActuationState()), null, null, true), null, 'no window');
});

test('★★★ U6 a window no record holds: the served plan claims no write and no ON, and every sizing figure stays; the year', () => {
  let n = 0;
  for (const c of CASES) {
    const a = planAt(45, { label: c.label, hours: 4 });
    if (a.forceChargeLine == null) continue;
    const p = planAt(45, { label: c.label, hours: 4, closed: { windowStartMs: a.window!.startMs, why: 'noArm' } });
    assert.equal(p.forceChargeLine, undefined, c.label);
    assert.equal(p.cushionEnvelopeReason, 'startClosed', c.label);
    assert.doesNotMatch(p.rationale, /switches on at|stays on until the window closes|runs until the panel|The reserve is set to|Charge (to|toward) ~|Hold the reserve at/, c.label);
    assert.ok(p.rationale.includes('no force-charge for it starts: no write is armed for this window, so the cushion is not assured — residual risk remains.'), p.rationale);
    assert.deepEqual(sizing(p), sizing(a), c.label);
    n++;
  }
  assert.equal(n, PIN_U1C_YEAR.disclosed);
});

test('★★★ U6 the push of a window no record holds: once, on a served charge plan, never beside a refusal the evening already pushed; what still lifts the pool', () => {
  const due = (cycle as unknown as { lineNotArmedPushDue: (closure: unknown, plan: unknown, pushed: number | null, refusal: string | null) => unknown }).lineNotArmedPushDue;
  const open = planAt(45).window!.startMs;
  const closure = { windowStartMs: open, why: 'noArm' };
  const p = planAt(45, { closed: closure });
  const want = { windowStartMs: open, windowEndMs: p.window!.endMs, linePct: p.cushionLineSocPct };
  assert.deepEqual(due(closure, p, null, null), want);
  assert.deepEqual(due(closure, p, open - 24 * H, null), want, "last night's stamp");
  assert.equal(due(closure, p, open, null), null, 'once a window');
  assert.equal(due(closure, p, null, 'a prior write is unresolved'), null, 'the refusal: the evening said so');
  assert.equal(due(null, p, null, null), null);
  assert.equal(due({ windowStartMs: open, why: 'cancelled' }, planAt(45, { closed: { windowStartMs: open, why: 'cancelled' } }), null, null), null, 'a record speaks for itself');
  assert.equal(due(closure, planAt(51, { closed: closure }), null, null), null, 'a disclosed reserve above the write, not this');
  assert.equal(due(closure, planAt(45, { eligible: false, closed: closure }), null, null), null, 'no write mode');
  const build = (notify as unknown as { buildLineNightNotArmed: (o: unknown) => { severity: string; dedupId: string; title: string; body: string } }).buildLineNightNotArmed;
  const m = build({ linePct: 55.55, windowStartMs: OPEN, windowEndMs: CLOSE, closeText: '5:00 AM' });
  assert.equal(m.severity, 'warning');
  assert.equal(m.dedupId, 'night_charge_line_not_armed');
  assert.equal(m.title, 'Night-charge: no write is armed for the outage line');
  assert.equal(m.body, 'No reserve write is armed for the 11pm–5am window, so no force-charge runs for the 55.6% outage line, and the pool may close under the line. Charge Now switched on by hand in the EcoFlow app can still lift the pool in the window; switch it off again by ~5:00 AM.');
  // The wiring: on the plan just served, stamped on the latch before it goes, the stamp surviving every other latch write.
  const at = INDEX.indexOf('async function recomputeNightChargePlan(');
  const fn = INDEX.slice(at, INDEX.indexOf('function armedExpectedBuyKwh(', at));
  assert.ok(fn.includes('if (!shadowLeg) pushLineNotArmedIfDue(getLatestNightChargePlan(), lineClosed, nowMs);'), fn);
  const pushAt = INDEX.indexOf('function pushLineNotArmedIfDue(');
  const push = INDEX.slice(pushAt, INDEX.indexOf('\n}\n', pushAt));
  assert.ok(push.indexOf('writeNightChargeLatch({ ...latch, lineNotArmedWindowStartMs: due.windowStartMs });') > 0, push);
  assert.ok(push.indexOf('writeNightChargeLatch({ ...latch, lineNotArmedWindowStartMs: due.windowStartMs });') < push.indexOf('sendNotification('), 'stamped before it goes');
  assert.ok(push.includes('servedArmRefusal(latch.armRefused, plan, NIGHT_CHARGE_MODE, nowMs)'), push);
  const writer = INDEX.slice(INDEX.indexOf('function writeNightChargeLatch('), INDEX.indexOf('\n}\n', INDEX.indexOf('function writeNightChargeLatch(')));
  assert.ok(writer.includes('lineNotArmedWindowStartMs: l.lineNotArmedWindowStartMs ?? nightChargeLatchMem.lineNotArmedWindowStartMs ?? null,'), writer);
  assert.ok(writer.includes('atomicWriteFileSync(NIGHT_CHARGE_LATCH_PATH, JSON.stringify(nightChargeLatchMem));'), writer);
  const read = INDEX.slice(INDEX.indexOf('function readNightChargeLatchFile('), INDEX.indexOf('let nightChargeLatchMem'));
  assert.ok(read.includes('lineNotArmedWindowStartMs: typeof raw?.lineNotArmedWindowStartMs === \'number\' ? raw.lineNotArmedWindowStartMs : null'), read);
  const clock = INDEX.slice(INDEX.indexOf('function eveningJobClock('), INDEX.indexOf('\n}\n', INDEX.indexOf('function eveningJobClock(')));
  assert.ok(clock.includes('consumed: readNightChargeLatch().lastNotifyDay === siteYmd(nowMs) || nowMin >= sched.eveningCutoffMin,'), clock);
  assert.ok(clock.includes('fireMin: sched.notify.fireMin,'), clock);
});

test('★★★ U6 the force-charge row never stands under a refused arm: an armed row gives way to the lead, a disclosed one stays', () => {
  const CARD = readFileSync(resolve(HERE, '../../web/src/cards/NightChargeCard.tsx'), 'utf8');
  assert.ok(CARD.includes('const lineRow = refused != null && plan.forceChargeLine != null ? null : outageLineRow(plan, status.reserveWriteMaxPct ?? null);'), CARD);
  assert.ok(CARD.includes('{lineRow != null && ('), CARD);
  assert.equal([...CARD.matchAll(/outageLineRow\(plan/g)].length, 1, 'one row, read once');
});

test('★★★ U6 a grid-status OFF the abort does not report is pushed once, at the OFF: it stopped, it does not start again, where the pool stands, and what can still lift it', () => {
  const due = (nfc as unknown as { lineGridOffPushDue: (s: NightActuationState, r: string, o: { gridPresent: boolean | null }) => number | null }).lineGridOffPushDue;
  const s = RUN();
  // The finding's walk: gridSta 2 with flow still measured. The OFF goes, the abort does not.
  const t = STOP_AT;
  const off = decideForceCharge(s, t, fo({ gridPresent: true, gridStaLost: true, slotsOn: [1, 2, 3], poolSocPct: 54 }));
  assert.deepEqual([off.kind, (off as { reason?: string }).reason], ['off', 'gridLoss']);
  assert.equal(decideActuation(s, t, TICK(50)).kind, 'none', 'gridPresent true: no abort, and nothing else reports it');
  assert.equal(due(s, 'gridLoss', { gridPresent: true }), 55.55);
  assert.equal(due(s, 'gridLoss', { gridPresent: null }), 55.55, 'unknown: no abort either');
  assert.equal(due(s, 'gridLoss', { gridPresent: false }), null, "the abort's own account says it");
  assert.equal(decideActuation(s, t, { ...TICK(50), gridPresent: false }).kind, 'revert');
  for (const reason of ['windowEnd', 'onPeakGuard', 'cancelled', 'reverted', 'foreign', 'target']) assert.equal(due(s, reason, { gridPresent: true }), null, reason);
  assert.equal(due(RUN({ forceChargeLineAskPct: null, forceChargeLinePct: null }), 'gridLoss', { gridPresent: true }), null, 'a night with no line: v1.199.1');
  const build = (notify as unknown as { buildLineForceChargeGridOff: (o: unknown) => { severity: string; dedupId: string; title: string; body: string } }).buildLineForceChargeGridOff;
  const m = build({ linePct: 55.55, poolPct: 54, closeText: '5:00 AM' });
  assert.equal(m.severity, 'warning');
  assert.equal(m.dedupId, 'night_charge_line_grid_off');
  assert.equal(m.title, 'Night-charge: the force-charge for the outage line stopped');
  assert.equal(m.body, "The panel read the grid as lost, so the add-on switched off the force-charge for tonight's 55.6% outage line; it does not start again tonight. The pool reads 54%, under the 55.6% outage line. Charge Now switched on by hand in the EcoFlow app can still lift the pool with the grid present; switch it off again by ~5:00 AM.");
  assert.ok(build({ linePct: 55.55, poolPct: 60, closeText: '5:00 AM' }).body.includes('The pool reads 60%, at or above the 55.6% outage line. Charge Now switched on by hand'));
  assert.ok(build({ linePct: 55.55, poolPct: null, closeText: '5:00 AM' }).body.includes('The pool was not read (no fresh panel reading); the outage line is 55.6%. Charge Now switched on by hand'));
  // The wiring: the OFF's first tick only, on the record as the OFF found it, not awaited.
  const at = INDEX.indexOf("if (action.kind === 'off' || action.kind === 'offRetry') {");
  const block = INDEX.slice(at, INDEX.indexOf("if (action.kind === 'offVerified') {", at));
  assert.ok(block.includes("const gridOffLine = action.kind === 'off' && state.forceChargeOffAtMs == null ? lineGridOffPushDue(state, action.reason, fcOpts) : null;"), block);
  assert.ok(block.includes('void sendNotification(loadNotifyConfig(), buildLineForceChargeGridOff({ linePct: gridOffLine, poolPct: fcOpts.poolSocPct ?? null, closeText: fmtSiteClock(writeWindowEndMs(state)!) }))'), block);
});

test('★★★ U6 an instruction promises no line it cannot hold: both pushes say what can still lift the pool, the close\'s OFF beside it', () => {
  const on = (notify as unknown as { buildNightForceChargeOnFailure: (o: unknown) => { body: string } }).buildNightForceChargeOnFailure({ day: '2027-01-04', slots: [1, 2, 3], ourSlots: [1, 2, 3], retries: 0, noRetry: true, ceilingPct: null, lineLinePct: 55.55 });
  assert.ok(on.body.includes('Charge Now switched on for slot(s) 1, 2, 3 in the EcoFlow app can still lift the pool tonight (the add-on switches it off at the window close)'), on.body);
  assert.doesNotMatch(on.body, /[Tt]o hold the line|would hold/);
});

test('★★★ U6 an account sent long after the close is no reading of the close: it reads now, with no verdict; a prompt one keeps its verdict', () => {
  const late = (nfc as unknown as { lineCloseReadingLate: (s: NightActuationState, t: number) => boolean }).lineCloseReadingLate;
  assert.equal(late(applied(), CLOSE), false);
  assert.equal(late(applied(), CLOSE + 15 * M), false, "the restore's readback grace and the restart hold");
  assert.equal(late(applied(), CLOSE + 15 * M + 1), true);
  assert.equal(late(applied(), CLOSE + 4 * H), true);
  assert.equal(late(applied({ nextOnPeakStartMs: CLOSE + 30 * M }), CLOSE - 30 * M + 15 * M + 1), true, "from the add-on's close, the guard's when sooner");
  assert.equal(late(applied({ windowEndMs: null }), CLOSE + 4 * H), false, 'no close to read');
  const base = { day: '2027-01-04', targetPct: 50, restorePct: 30, expectedKwh: 20, linePct: 55.55 };
  const fc = (kind: string) => ({ kind, stopPct: null, expectedLeg: true, line: { askPct: 56, linePct: 55.55 } }) as never;
  const body = (o: Record<string, unknown>) => buildNightChargeMorningSummary({ ...base, forceCharge: fc('neverStarted'), ...o } as never).body;
  assert.ok(body({ closePoolPct: 48 }).includes('the pool read 48% at the close, under the 55.6% outage line'), 'prompt');
  const lateUnder = body({ closePoolPct: 48, closeReadLate: true });
  assert.ok(lateUnder.includes('; the pool reads 48% now, past the window close;'), lateUnder);
  assert.doesNotMatch(lateUnder, /at the close|under the 55\.6/, lateUnder);
  const lateOver = body({ closePoolPct: 85, closeReadLate: true });
  assert.ok(lateOver.includes('; the pool reads 85% now, past the window close;'), lateOver);
  assert.ok(body({ closePoolPct: null, closeReadLate: true }).includes('; the pool was not read at the close (no fresh panel reading)'), 'no reading: as ever');
  const at = INDEX.indexOf('function sendRestoreSummary(');
  const fn = INDEX.slice(at, INDEX.indexOf('\n}\n', at));
  assert.ok(fn.includes('closeReadLate: lineNight != null && lineCloseReadingLate(state, nowMs),'), fn);
});

test('★★★ U6 a write the panel never read back is not told as raised: the morning, the abort and the cancel accounts, and the banner; a verified write, and a night with no line, keep their words', () => {
  const base = { day: '2027-01-04', targetPct: 50, restorePct: 30, expectedKwh: 20, linePct: 55.55, closePoolPct: 30 };
  const fc = { kind: 'neverStarted', stopPct: null, expectedLeg: true, line: { askPct: 56, linePct: 55.55 } } as never;
  const unread = buildNightChargeMorningSummary({ ...base, forceCharge: fc, writeUnread: true } as never).body;
  assert.equal(unread, 'Supervised night charge for 2027-01-04 completed: the reserve write to 50% never read back; force-charge for the 55.6% outage line never started; the pool read 30% at the close, under the 55.6% outage line; the reserve is restored to 30%. Delivery vs plan scores in the ledger at tomorrow evening\'s update.');
  assert.ok(buildNightChargeMorningSummary({ ...base, forceCharge: fc }).body.includes('completed: reserve raised to 50%; force-charge'), 'verified');
  // A night expected to hold is told no hold either; nor the shape with no force-charge, nor the acknowledged restore.
  assert.doesNotMatch(buildNightChargeMorningSummary({ ...base, expectedKwh: 0, forceCharge: fc, writeUnread: true } as never).body, /held at 50%/);
  assert.ok(buildNightChargeMorningSummary({ ...base, forceCharge: { kind: 'none', expectedLeg: false }, writeUnread: true } as never).body.includes('completed: the reserve write to 50% never read back; the reserve is restored to 30%. '));
  assert.ok(buildNightChargeMorningSummary({ ...base, forceCharge: { kind: 'none', expectedLeg: false }, writeUnread: true, restore: 'acknowledged' } as never).body.includes('completed: the reserve write to 50% never read back; the restore to 30% was sent'));
  for (const [ended, head] of [['gridLoss', 'stopped: the grid was lost during the window'], ['cancelled', 'was cancelled after the write']] as const) {
    const m = buildNightChargeMorningSummary({ ...base, ended, writeUnread: true } as never).body;
    assert.ok(m.includes(`${head}: the reserve write to 50% never read back; the reserve is restored to 30% and nothing more is charged tonight.`), m);
    assert.doesNotMatch(m, /raised to/, m);
    const acked = buildNightChargeMorningSummary({ ...base, ended, writeUnread: true, restore: 'acknowledged' } as never).body;
    assert.ok(acked.includes(`${head}: the reserve write to 50% never read back; the restore to 30% was sent`), acked);
    assert.doesNotMatch(acked, /was raised to/, acked);
  }
  // A night with no line: v1.199.1's words, whatever it is told.
  assert.equal(buildNightChargeMorningSummary({ day: 'd', targetPct: 50, restorePct: 30, expectedKwh: 20, writeUnread: false } as never).body, buildNightChargeMorningSummary({ day: 'd', targetPct: 50, restorePct: 30, expectedKwh: 20 }).body);
  const at = INDEX.indexOf('function sendRestoreSummary(');
  const fn = INDEX.slice(at, INDEX.indexOf('\n}\n', at));
  assert.ok(fn.includes('writeUnread: lineNight != null && state.applyVerifiedAtMs == null,'), fn);
  // The banner: the server's field, on a record with its ask, acknowledged and unread; its Cancel stays. In the apply's grace too: the words hold there.
  const status = (cycle as unknown as { lineWriteUnreadStatus: (s: NightActuationState) => Record<string, unknown> }).lineWriteUnreadStatus;
  const phantom = applied({ applyVerifiedAtMs: null, applyEscalated: true });
  assert.deepEqual(status(phantom), { lineWriteUnread: true });
  assert.deepEqual(status(applied({ applyVerifiedAtMs: null })), { lineWriteUnread: true });
  assert.deepEqual(status(applied()), {}, 'read back');
  assert.deepEqual(status(armed()), {}, 'no write acknowledged');
  assert.deepEqual(status(applied({ applyVerifiedAtMs: null, forceChargeLineAskPct: null, forceChargeLinePct: null })), {}, 'a night with no line: byte for byte');
  const banner = cardText.actuationBannerState as unknown as (a: unknown, d: string | null, r?: number | null) => { text: string; settled: boolean; cancel: string | null };
  assert.deepEqual(banner({ ...phantom, ...status(phantom), cancelDeadlineMs: OPEN }, '23:00', 30), { text: 'Reserve write to 50% has not read back (was 30%); auto-restores after the window closes.', settled: false, cancel: 'Cancel & revert' });
  assert.equal(banner({ ...applied(), ...status(applied()), cancelDeadlineMs: OPEN }, '23:00', 50).text, 'Reserve raised to 50% (was 30%); auto-restores after the window closes.');
  assert.equal(banner({ ...phantom, ...status(phantom), cancelled: true, cancelDeadlineMs: OPEN }, '23:00', 30).text, 'Cancelled — the applied write reverts within a minute.', 'a state ahead of it keeps its words');
  assert.ok(INDEX.includes('...lineWriteUnreadStatus(nightActuationMem),'), 'the status route');
  const CARD = readFileSync(resolve(HERE, '../../web/src/cards/NightChargeCard.tsx'), 'utf8');
  assert.ok(CARD.includes('lineWriteUnread?: boolean;'), 'the field reaches the card');
});

/* ══ U7 — (Fix10 review 2) a run that never took, or that no re-ON can bring back ═════════════════════════════════════════════ */

const NOT_TAKEN = 'the force-charge for it was switched on and has not taken effect: unless it applies late, none runs';
const NO_RE_ON = 'the force-charge for it reads off and the add-on does not switch it back on tonight';
const WORDS_SPENT = 'the add-on does not switch it back on tonight';
const CUT = CLOSE - 20 * M;
const WARNED = (over: Partial<NightActuationState> = {}): NightActuationState => RUN({
  forceChargeOnVerifiedAtMs: null, forceChargeOnFailedAtMs: STOP_AT - 30 * M, forceChargeOnFailedSlots: [1, 2, 3], forceChargeOnRetries: 1, ...over,
});
const SPENT = (over: Partial<NightActuationState> = {}): NightActuationState => RUN({
  forceChargeLinePanelOffAtMs: CLOSE - 100 * M, forceChargeLineReOns: 2, forceChargeLineReOnAtMs: CLOSE - 90 * M, forceChargeLineOffSlots: [1, 2, 3], ...over,
});
const noReOnOf = (s: NightActuationState, t: number): NoReOnInput | null => (nfc as unknown as { armedLineNoReOn: (s: NightActuationState, t: number) => NoReOnInput | null }).armedLineNoReOn(s, t);
const reOnGone = (s: NightActuationState, t: number): boolean => (nfc as unknown as { lineReOnGone: (s: NightActuationState, t: number) => boolean }).lineReOnGone(s, t);

test('★★★ U7 an ON warned of on every slot is a closed start: nothing of the add-on\'s switches it on again; a late apply reopens it', () => {
  const s = WARNED();
  const t = STOP_AT;
  assert.equal(nfc.forceChargeStartClosed(s, t, GATES), 'started', "the pushes' own key stays");
  assert.deepEqual(closedRec(s, t), { windowStartMs: OPEN, why: 'notTaken', writeStands: true });
  assert.equal(nfc.lineReOnDue(s, t, fo({ poolSocPct: 45, slotsOn: [] }), [1, 2, 3]), null, 'a re-ON needs a verified ON');
  for (let at = t; at < CLOSE - M; at += M) assert.equal(decideForceCharge(s, at, fo({ poolSocPct: 45, slotsOn: [] })).kind, 'none', 'the tick has nothing left to issue');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedSlots: null }), t)?.why, 'notTaken', 'a failure kept before its slots were: whole-night, as the push reads it');
  // A late apply is verified, and the record reads armed from the next recompute.
  assert.equal(decideForceCharge(s, t, fo({ poolSocPct: 45, slotsOn: [1, 2, 3] })).kind, 'onVerified');
  assert.equal(closedRec({ ...s, forceChargeOnVerifiedAtMs: t }, t + M), null, 'a late apply reopens it');
  assert.deepEqual(closedRec(WARNED({ forceChargeOnFailedSlots: [3] }), t), { windowStartMs: OPEN, why: 'partTaken' }, 'a partial failure: U9');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedSlots: [1, 2], forceChargeSlots: [1, 2] }), t)?.why, 'notTaken', 'every slot of ours, of a list of two');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedAtMs: null, forceChargeOnFailedSlots: null }), t), null, 'not warned of');
  assert.equal(closedRec(WARNED({ cancelled: true }), t)?.why, 'cancelled');
  assert.equal(closedRec(WARNED({ forceChargeOffAtMs: t, forceChargeOffReason: 'windowEnd' }), t + M)?.why, 'stopped');
  assert.equal(closedRec(WARNED({ forceChargeLineAskPct: null, forceChargeLinePct: null }), t), null, 'a cost night: not a word');
});

test('★★★ U7 every slot reading off with no re-ON left is a closed start: the budget spent or the cutoff passed, past the last re-ON\'s grace; a slot reading on, or a re-ON still to come, stays armed', () => {
  const t = CLOSE - H;
  const off52 = fo({ poolSocPct: 52, slotsOn: [] });
  assert.deepEqual(closedRec(SPENT(), t), { windowStartMs: OPEN, why: 'noReOn', writeStands: true });
  assert.equal(nfc.lineReOnDue(SPENT(), t, off52, [1, 2, 3]), null, 'the budget');
  // The last re-ON's readback grace: it may yet take, so it is not called off.
  const fresh = SPENT({ forceChargeLineReOnAtMs: t - 15 * M + 1 });
  assert.equal(closedRec(fresh, t), null, 'in its grace');
  assert.equal(closedRec(fresh, t + 1)?.why, 'noReOn', 'the grace run');
  // The cutoff, and it runs from the on-peak guard where that is sooner.
  const stop = RUN({ forceChargeLinePanelOffAtMs: CUT - H, forceChargeLineOffSlots: [1, 2, 3] });
  assert.equal(closedRec(stop, CUT - 1), null, 'the re-ON can still come');
  assert.notEqual(nfc.lineReOnDue(stop, CUT - 1, off52, [1, 2, 3]), null, 'and does');
  assert.equal(closedRec(stop, CUT)?.why, 'noReOn');
  assert.equal(nfc.lineReOnDue(stop, CUT, off52, [1, 2, 3]), null);
  const guarded = { ...stop, nextOnPeakStartMs: CLOSE + 30 * M };
  assert.equal(closedRec(guarded, CUT - 30 * M - 1), null);
  assert.equal(closedRec(guarded, CUT - 30 * M)?.why, 'noReOn');
  // What reopens it, or keeps it open.
  assert.equal(closedRec(SPENT({ forceChargeLineOffSlots: [2, 3] }), t), null, 'a slot reading on: the run goes on');
  assert.equal(closedRec(SPENT({ forceChargeLineOffSlots: null }), t), null, 'no reading on record');
  assert.equal(closedRec(SPENT({ forceChargeLineOffSlots: [] }), t), null, 'every slot reading on');
  assert.equal(closedRec(SPENT({ forceChargeLineReOns: 1 }), t), null, 'one left');
  assert.notEqual(nfc.lineReOnDue(SPENT({ forceChargeLineReOns: 1 }), t, off52, [1, 2, 3]), null, 'and it comes');
  assert.equal(closedRec(SPENT({ forceChargeSlots: [1, 2], forceChargeLineOffSlots: [1, 2] }), t)?.why, 'noReOn', 'ours only');
  assert.equal(closedRec(SPENT({ forceChargeSlots: [1, 2], forceChargeLineOffSlots: [1] }), t), null);
  assert.equal(closedRec(SPENT({ forceChargeSlots: null, forceChargeLineOffSlots: [1, 2] }), t), null, 'no list: every slot is ours');
  assert.equal(closedRec(SPENT({ forceChargeOnVerifiedAtMs: null, forceChargeOnFailedAtMs: null }), t), null, 'an ON not judged yet');
  assert.equal(closedRec(SPENT({ forceChargeOffAtMs: t }), t + M)?.why, 'stopped', 'an OFF of ours goes first');
  assert.equal(closedRec(SPENT({ cancelled: true }), t)?.why, 'cancelled');
  assert.equal(closedRec(SPENT({ forceChargeLineAskPct: null, forceChargeLinePct: null }), t), null, 'a cost night: not a word');
  // lineReOnGone is lineReOnDue's own refusal: with every other gate open a re-ON comes exactly while it is false.
  for (const spent of [0, 1, 2]) {
    for (let at = CLOSE - 100 * M; at <= CLOSE + 5 * M; at += 5 * M) {
      const s = RUN({ forceChargeLineReOns: spent, forceChargeLineOffSlots: [1, 2, 3] });
      assert.equal(nfc.lineReOnDue(s, at, off52, [1, 2, 3]) == null, reOnGone(s, at), `${spent} spent, ${(CLOSE - at) / M} min to the close`);
      if (closedRec(s, at)?.why === 'noReOn') assert.notEqual(decideForceCharge(s, Math.min(at, CLOSE - 1), off52).kind, 'lineReOn');
    }
  }
  assert.equal(reOnGone(RUN({ windowEndMs: null }), t), true, 'no window: none');
});

test('★★★ U7 the words hold in every outcome: both are the plan\'s, the row\'s and the banner\'s; the reserve write they ride stands, so the card keeps its figure', () => {
  assert.equal(nfc.lineStartClosedWords('it', 'notTaken' as never), NOT_TAKEN);
  assert.equal(nfc.lineStartClosedWords('it', 'noReOn' as never), NO_RE_ON);
  const base = planAt(45);
  const open = base.window!.startMs;
  for (const [why, words] of [['notTaken', NOT_TAKEN], ['noReOn', NO_RE_ON]] as const) {
    const p = planAt(45, { closed: { windowStartMs: open, why, writeStands: true } as never });
    assert.equal(p.forceChargeLine, undefined, why);
    assert.equal(p.cushionEnvelopeReason, 'startClosed', why);
    assert.equal((p as unknown as { cushionStartClosedWords: string }).cushionStartClosedWords, words);
    assert.equal((p as never as { cushionStartClosedNoWrite?: boolean }).cushionStartClosedNoWrite, undefined, 'its write stands');
    assert.ok(p.rationale.includes(`, and ${words}, so the cushion is not assured — residual risk remains.`), p.rationale);
    assert.doesNotMatch(p.rationale, ON_CLAIM, p.rationale);
    assert.doesNotMatch(p.rationale, /the add-on switches it back on/, p.rationale);
    const row = cardText.outageLineRow(p as never, 50)!;
    assert.ok(row.includes(`not claimed tonight (${words})`), row);
    assert.doesNotMatch(row, /stays on|the add-on switches it back on|expected at the close/, row);
    assert.deepEqual(sizing(p), sizing(base), why);
  }
  const status = (cycle as unknown as { lineStartClosedStatus: (s: NightActuationState, t: number, g: { cost: boolean; line: boolean }) => Record<string, unknown> }).lineStartClosedStatus;
  assert.deepEqual(status(WARNED(), STOP_AT, GATES), { lineStartClosed: { text: 'The force-charge for the 55.6% outage line was switched on and has not taken effect: unless it applies late, none runs.', cancel: true } });
  assert.deepEqual(status(SPENT(), STOP_AT, GATES), { lineStartClosed: { text: 'The force-charge for the 55.6% outage line reads off and the add-on does not switch it back on tonight.', cancel: true } });
});

test('★★★ U7 the finding\'s walk, on the real chain: a night whose ON is written and never reads back serves neither the start, the run nor the re-ON, from the warning on', () => {
  const base = planAt(45);
  const open = base.window!.startMs;
  let s = armFromPlan(emptyActuationState(), '2027-01-04', base, OPEN - 90 * M, 45, false, null, true)!;
  assert.equal(s.forceChargeLinePct, base.forceChargeLine!.linePct);
  s = { ...s, applyAttemptedAtMs: OPEN, attemptBaselinePct: 45, appliedAtMs: OPEN, priorReservePct: 45, applyVerifiedAtMs: OPEN + 3 * M };
  const onAt = CLOSE - 2 * H;
  s = { ...s, forceChargeOnAtMs: onAt, forceChargeOnLastAttemptMs: onAt, forceChargeSlots: [1, 2, 3], forceChargeMode: 'line' };
  const seen: string[] = [];
  for (let at = onAt + M; at < CLOSE - M; at += M) {
    const a = decideForceCharge(s, at, fo({ ceilingReadbackPct: 81, poolSocPct: 50, slotsOn: [] }));
    if (a.kind === 'none') continue;
    seen.push(a.kind);
    if (a.kind === 'onRetry') s = { ...s, forceChargeOnRetries: s.forceChargeOnRetries + 1, forceChargeOnLastAttemptMs: at };
    if (a.kind === 'onFailed') s = { ...s, forceChargeOnFailedAtMs: at, forceChargeOnFailedSlots: [...a.slots] };
  }
  assert.deepEqual(seen, ['onRetry', 'onFailed'], 'and nothing after it to the close');
  const closure = closedRec(s, s.forceChargeOnFailedAtMs! + M);
  assert.equal(closure?.why, 'notTaken');
  const p = planAt(45, { closed: { ...closure!, windowStartMs: open } as never });
  assert.doesNotMatch(p.rationale, ON_CLAIM, p.rationale);
  assert.doesNotMatch(cardText.outageLineRow(p as never, 50)!, /stays on|the add-on switches it back on|expected at the close/);
});

test('★★★ U7 a run with no re-ON left keeps its line and loses the clause: spent, or past the cutoff; a run with one to come, and any other night, as it was', () => {
  const t = CLOSE - H;
  const spent = { windowStartMs: OPEN, words: WORDS_SPENT };
  assert.deepEqual(noReOnOf(SPENT({ forceChargeLineOffSlots: [] }), t), spent, 'spent, slots reading on');
  assert.deepEqual(noReOnOf(RUN(), CUT), spent, 'at the cutoff');
  assert.equal(noReOnOf(RUN(), CUT - 1), null, 'before it');
  assert.equal(noReOnOf(SPENT({ forceChargeLineReOns: 1 }), t), null, 'one left');
  // (Fix12) An ON warned of on some slots is a closure's, which goes first (U9): this reads a verified run alone.
  assert.equal(noReOnOf(WARNED({ forceChargeOnFailedSlots: [3] }), t), null);
  assert.equal(nfc.lineReOnDue(WARNED({ forceChargeOnFailedSlots: [3], forceChargeLineOffSlots: [1, 2, 3] }), t, fo({ poolSocPct: 52, slotsOn: [] }), [1, 2, 3]), null);
  assert.equal(noReOnOf(RUN({ forceChargeOnVerifiedAtMs: null }), t), null, 'an ON no reading has judged');
  assert.equal(noReOnOf(applied(), t), null, 'no run');
  assert.equal(noReOnOf(emptyActuationState(), t), null, 'no record');
  assert.equal(noReOnOf(SPENT({ forceChargeLineAskPct: null, forceChargeLinePct: null }), t), null, 'a cost night: not a word');
  // The row and the rationale: the line stays claimed, the walk stays, and what the record cannot do is said.
  const base = planAt(45);
  const open = base.window!.startMs;
  for (const words of [WORDS_SPENT]) {
    const p = planAt(45, { noReOn: { windowStartMs: open, words } });
    assert.deepEqual(p.forceChargeLine, base.forceChargeLine);
    assert.equal(p.cushionEnvelopeReason, undefined, 'still carried');
    assert.deepEqual(sizing(p), sizing(base));
    assert.ok(p.rationale.includes(`runs until the panel switches it off at its 81% ceiling; ${words}, ~${p.expectedWriteLevelPct}% expected at the close.`), p.rationale);
    assert.doesNotMatch(p.rationale, /the add-on switches it back on/, p.rationale);
    const row = cardText.outageLineRow(p as never, 50)!;
    assert.ok(row.endsWith(`the panel's force-charge runs until the panel switches it off at its 81% ceiling, and ${words}, ~${p.expectedWriteLevelPct}% expected at the close`), row);
    assert.doesNotMatch(row, /the add-on switches it back on|at most/, row);
  }
  // No re-ON is walked on such a record: the figure beside the words is the walk's without one.
  const barred = planAt(40, { hours: 15, noReOn: { windowStartMs: open, words: WORDS_SPENT } });
  const walked = planAt(40, { hours: 15 });
  assert.ok(barred.expectedWriteLevelPct! < walked.expectedWriteLevelPct!, `${barred.expectedWriteLevelPct} under ${walked.expectedWriteLevelPct}`);
  assert.deepEqual(sizing(barred), sizing(walked));
  // Another window, an empty input, a closed start ahead of it, a night with no ceiling stop: nothing moves.
  assert.deepEqual(planAt(45, { noReOn: { windowStartMs: open + 1, words: WORDS_SPENT } }), base, "an earlier night's record");
  assert.deepEqual(planAt(45, { noReOn: null }), base);
  const closed = planAt(45, { closed: { windowStartMs: open, why: 'noReOn', writeStands: true } as never, noReOn: { windowStartMs: open, words: WORDS_SPENT } });
  assert.deepEqual(closed, planAt(45, { closed: { windowStartMs: open, why: 'noReOn', writeStands: true } as never }), 'the closure says it');
  // v1.202.0 — on the measured pool the walk at a 30% floor reaches the 80% ceiling: a 29% floor stays under it.
  const noStop = planAt(29);
  assert.equal(noStop.expectedLineCeilingStop, undefined);
  assert.equal(planAt(29, { noReOn: { windowStartMs: open, words: WORDS_SPENT } }).rationale, noStop.rationale, 'no clause to word: "stays on" is true of a run still on');
});

test('★★★ U7 the walk books no re-ON the record cannot make', () => {
  const nca = { expectedLineForceChargeWalk: (cardWalk as { expectedLineForceChargeWalk: (o: unknown) => { closeKwh: number; gridKwh: number; ceilingReached: boolean } }).expectedLineForceChargeWalk };
  const hours = Array.from({ length: 8 }, (_, i) => ({ ts: OPEN + i * H, pvP10W: 0, pvP50W: 0, loadP90W: 9000, loadP50W: 9000, evP90W: 8000 }));
  const o = { startKwh: 0.5 * 92.16, reserveKwh: 0.5 * 92.16, fullKwh: 92.16, tickPoolKwh: 92.16, startTargetPct: 61, panelCeilingPct: 80, hours, fromMs: OPEN, windowEndMs: CLOSE + 2 * H, dischargeEff: 0.94, chargeCapKw: 17, envelopeKw: 17, legEff: 0.927 };
  const on = nca.expectedLineForceChargeWalk(o);
  const off = nca.expectedLineForceChargeWalk({ ...o, noReOn: true });
  assert.equal(off.ceilingReached, true);
  assert.ok(on.closeKwh > off.closeKwh + 1 && on.gridKwh > off.gridKwh + 1, `${on.closeKwh} against ${off.closeKwh}`);
});

test('★★★ U7 wiring: the served plan alone reads it, the plan of record stays, and a night with neither keeps its one compute', () => {
  const at = INDEX.indexOf('async function recomputeNightChargePlan(');
  const fn = INDEX.slice(at, INDEX.indexOf('function armedExpectedBuyKwh(', at));
  assert.ok(fn.includes('  const lineNoReOn = shadowLeg == null && opts.arming !== true && nightActuationMem.windowStartMs === plan.window?.startMs ? armedLineNoReOn(nightActuationMem, nowMs) : null;\n'), 'never an arm, a shadow leg or a later window');
  assert.ok(fn.includes('  if (!shadowLeg) setLatestNightChargePlan(lineClosed != null || lineNoReOn != null || lineRunOn != null ? computeNightChargePlan({ ...inputs, armedLineStartClosed: lineClosed, armedLineNoReOn: lineNoReOn, armedLineRunOnStartMs: lineRunOn }) : plan);\n'), fn.slice(0, 200));
  assert.ok(fn.includes('  const inputs = buildNightChargeInputs(deps);\n  const plan = computeNightChargePlan(inputs);\n'), 'the plan of record');
  const SRC = readFileSync(resolve(HERE, '../src/nightChargeAdvisor.ts'), 'utf8');
  assert.ok(SRC.includes('forceChargeLine, lineForceChargeEligible: inputs.lineForceChargeEligible === true, noReOn: lineNoReOn != null, runOn: lineRunOn, tickPoolKwh: panelFullKwh,'), 'the walk');
  const CARD = readFileSync(resolve(HERE, '../../web/src/cards/NightChargeCard.tsx'), 'utf8');
  assert.ok(CARD.includes('expectedLineCeilingStop?: { ceilingPct: number; startTargetPct: number; noReOnWords?: string };'), 'the field reaches the card');
});

/* ══ U8 — (Fix11) the plan's walk is told a run is on ═════════════════════════════════════════════════════════════════════════════ */

const runOnOf = (s: NightActuationState): number | null => (nfc as unknown as { armedLineRunOn: (s: NightActuationState) => number | null }).armedLineRunOn(s);
const PLAN45 = planAt(45);
const WIN_OPEN = PLAN45.window!.startMs;
const WIN_CLOSE = PLAN45.window!.endMs;
/** The record the real arm builds, its write verified, and its ON verified with every slot reading on. */
const armedRun = (over: Partial<NightActuationState> = {}): NightActuationState => {
  const onAt = WIN_CLOSE - 110 * M;
  return {
    ...armFromPlan(emptyActuationState(), '2027-01-04', PLAN45, WIN_OPEN - 90 * M, 45, false, null, true)!,
    applyAttemptedAtMs: WIN_OPEN, attemptBaselinePct: 45, appliedAtMs: WIN_OPEN, priorReservePct: 45, applyVerifiedAtMs: WIN_OPEN + 3 * M,
    forceChargeOnAtMs: onAt, forceChargeOnLastAttemptMs: onAt, forceChargeSlots: [1, 2, 3], forceChargeMode: 'line', forceChargeOnVerifiedAtMs: onAt + 2 * M, forceChargeLineOffSlots: [],
    ...over,
  };
};
/** The plan served for a record, read through the wiring's own three record readers. */
const servedOf = (s: NightActuationState, t: number, pool: number): P => planAt(45, { at: t, pool, closed: closedRec(s, t), noReOn: noReOnOf(s, t), runOn: runOnOf(s) });
const CEILING_CLAIM = /at or above|not expected to start|no charge expected/;
const START_CLAIM = /switches on at|switches on just in time|runs from ~/;
const lineWords = (p: P): string => p.rationale.split(' The cushion is')[0]!;

test('★★★ U8 armedLineRunOn: a verified ON, no OFF of ours, no one-way stamp, and not every slot of ours reading off', () => {
  assert.equal(runOnOf(RUN()), OPEN, 'no reading of the slots yet: none reads off');
  assert.equal(runOnOf(RUN({ forceChargeLineOffSlots: [] })), OPEN, 'every slot reading on');
  assert.equal(runOnOf(RUN({ forceChargeLineOffSlots: [1, 2] })), OPEN, 'a slot reading on: the run goes on');
  assert.equal(runOnOf(RUN({ forceChargeLineOffSlots: [1, 2, 3] })), null, 'every slot reading off: the panel stopped it, or something did');
  assert.equal(runOnOf(RUN({ forceChargeSlots: [1, 2], forceChargeLineOffSlots: [1, 2] })), null, 'ours only');
  assert.equal(runOnOf(RUN({ forceChargeSlots: [1, 2], forceChargeLineOffSlots: [1] })), OPEN);
  assert.equal(runOnOf(RUN({ forceChargeSlots: null, forceChargeLineOffSlots: [1, 2] })), OPEN, 'no list: every slot is ours');
  // Not verified: an ON in its readback grace, or one warned of, wholly or in part.
  assert.equal(runOnOf(RUN({ forceChargeOnVerifiedAtMs: null })), null, 'in its grace');
  assert.equal(runOnOf(WARNED()), null, 'warned of on every slot');
  assert.equal(runOnOf(WARNED({ forceChargeOnFailedSlots: [3] })), null, 'a partial ON');
  assert.equal(runOnOf(WARNED({ forceChargeOnFailedSlots: [3], forceChargeOnVerifiedAtMs: STOP_AT })), OPEN, 'a late apply verifies it');
  // Ended.
  assert.equal(runOnOf(RUN({ forceChargeOffAtMs: STOP_AT })), null, 'an OFF of ours');
  for (const over of [{ cancelled: true }, { revertedAtMs: STOP_AT }, { foreignSettledAtMs: STOP_AT }]) assert.equal(runOnOf(RUN(over)), null, JSON.stringify(over));
  // No run, no line, no record.
  assert.equal(runOnOf(applied()), null, 'no ON');
  assert.equal(runOnOf(emptyActuationState()), null, 'no record');
  assert.equal(runOnOf(RUN({ windowStartMs: null })), null, 'no window');
  assert.equal(runOnOf(RUN({ forceChargeLineAskPct: null, forceChargeLinePct: null })), null, 'a cost night: not a word');
  assert.equal(runOnOf(SPENT({ forceChargeLineOffSlots: [] })), OPEN, 'a run with no re-ON left, still on');
  // A closure and a run on are never one record.
  for (const t of [STOP_AT, CUT - M, CUT, CLOSE - 5 * M]) {
    for (const s of [RUN(), SPENT(), WARNED(), RUN({ forceChargeLineOffSlots: [1, 2, 3] }), ...STOPPED_CASES().map(([, over]) => RUN(over))]) {
      assert.equal(closedRec(s, t) != null && runOnOf(s) != null, false, `${(CLOSE - t) / M} min to the close`);
    }
  }
});

test('★★★ U8 the walk: a run on rises from fromMs, past the last-start gate and the timed start; the latch, the re-ON and noReOn stay as they are', () => {
  const nca = { walk: (cardWalk as { expectedLineForceChargeWalk: (o: unknown) => { closeKwh: number; startMs: number | null; startPackKwh: number; gridKwh: number; ceilingReached: boolean } }).expectedLineForceChargeWalk };
  const hours = Array.from({ length: 8 }, (_, i) => ({ ts: OPEN + i * H, pvP10W: 0, pvP50W: 0, loadP90W: 1000, loadP50W: 1000, evP90W: 0 }));
  const full = 92.16;
  const o = (pct: number, fromMs: number, over: Record<string, unknown> = {}) => ({
    startKwh: (pct / 100) * full, reserveKwh: 0.5 * full, fullKwh: full, tickPoolKwh: full, startTargetPct: 76, panelCeilingPct: 81, hours, fromMs, windowEndMs: CLOSE,
    dischargeEff: 0.94, chargeCapKw: 17, envelopeKw: 17, legEff: 0.927, ...over,
  });
  // Past the last start: no start can be walked, and the run is on all the same.
  const late = nca.walk(o(72, CLOSE - 15 * M));
  assert.equal(late.startMs, null, 'nothing to start, on a walk told nothing');
  assert.ok(late.closeKwh < (72 / 100) * full);
  const on = nca.walk(o(72, CLOSE - 15 * M, { runOn: true }));
  assert.equal(on.startMs, CLOSE - 15 * M, 'started at fromMs');
  assert.equal(on.startPackKwh, (72 / 100) * full);
  assert.ok(on.closeKwh > (72 / 100) * full + 2, String(on.closeKwh));
  assert.ok(on.gridKwh > 2);
  // The timed start: a pool that needs no start yet.
  const timed = nca.walk(o(75, CLOSE - 2 * H));
  assert.ok(timed.startMs != null && timed.startMs > CLOSE - 2 * H, 'the timed start, later');
  const running = nca.walk(o(75, CLOSE - 2 * H, { runOn: true }));
  assert.equal(running.startMs, CLOSE - 2 * H);
  assert.ok(running.startPackKwh > timed.startPackKwh, 'no drain to a start already past');
  // At the ceiling already: the panel's latch, the house draws it, and the walk's own re-ON stays.
  const atCeiling = nca.walk(o(81, CLOSE - 2 * H, { runOn: true }));
  assert.equal(atCeiling.ceilingReached, true);
  assert.equal(atCeiling.startMs, CLOSE - 2 * H);
  // A re-ON still walks, and noReOn still bars it.
  const heavy = { startTargetPct: 61, panelCeilingPct: 80, hours: hours.map((h) => ({ ...h, loadP50W: 9000, loadP90W: 9000, evP90W: 8000 })), fromMs: OPEN, windowEndMs: CLOSE + 2 * H };
  const free = nca.walk(o(50, OPEN, { ...heavy, runOn: true }));
  const barred = nca.walk(o(50, OPEN, { ...heavy, runOn: true, noReOn: true }));
  assert.equal(barred.ceilingReached, true);
  assert.ok(free.gridKwh > barred.gridKwh + 1 && free.closeKwh > barred.closeKwh + 1, `${free.closeKwh} against ${barred.closeKwh}`);
});

test('★★★ U8 the finding: a run on at T-21, T-20, T-15 and T-5 is served as on, its close continuous; no "not expected to start", no "no charge expected", no ceiling claim', () => {
  const s = armedRun();
  for (const pool of [66, 68, 70, 72]) {
    const levels: number[] = [];
    for (const toClose of [21, 20, 15, 5]) {
      const t = WIN_CLOSE - toClose * M;
      const p = servedOf(s, t, pool);
      const where = `pool ${pool}, T-${toClose}`;
      assert.equal(p.chargeTonight, true, where);
      assert.equal(p.expectedForceChargeStartMs, t, where);
      assert.equal(p.expectedForceChargeMode, 'line', where);
      assert.ok(p.expectedBuyKwh! > 0.05, `${where}: ${p.expectedBuyKwh}`);
      assert.ok(p.expectedWriteLevelPct! > pool, `${where}: ${p.expectedWriteLevelPct}`);
      levels.push(p.expectedWriteLevelPct!);
      assert.doesNotMatch(p.rationale, CEILING_CLAIM, where);
      assert.doesNotMatch(p.rationale, START_CLAIM, where);
      assert.ok(p.rationale.includes(`the pool is at ~${pool}% now, above the 50% reserve; the force-charge for the outage line is on, runs to the window close and takes it to ${p.expectedWriteLevelPct}%`), p.rationale);
      assert.ok(p.rationale.includes(`so the panel's force-charge is on and stays on until the window closes, taking the pool to ~${p.expectedWriteLevelPct}%.`), p.rationale);
      const row = cardText.outageLineRow(p as never, 50)!;
      assert.ok(row.includes(`the panel's force-charge stays on to the window close, ~${p.expectedWriteLevelPct}% expected at the close`), row);
      assert.doesNotMatch(row, CEILING_CLAIM, row);
      const fig = cardText.chargeFigureParts(p as never, 50);
      assert.equal(fig.unit, 'kWh', where);
      assert.ok(fig.label.includes(`expected charge to ~${p.expectedWriteLevelPct}%`), fig.label);
    }
    assert.ok(levels[0]! > levels[1]! && levels[1]! > levels[2]! && levels[2]! > levels[3]!, `${pool}: ${levels}`);
  }
});

test('★★★ U8 no step in the stated close at the cutoff: it moves by what one minute of the walk moves, minute by minute through it', () => {
  const s = armedRun();
  for (const pool of [66, 70, 72]) {
    const level = (toClose: number): number => servedOf(s, WIN_CLOSE - toClose * M, pool).expectedWriteLevelPct!;
    const minute = level(26) - level(25);
    assert.ok(minute > 0.1 && minute < 0.5, `one minute of the walk: ${minute}`);
    for (let toClose = 25; toClose > 4; toClose -= 1) {
      const step = level(toClose) - level(toClose - 1);
      assert.ok(step > 0 && step <= minute + 0.11, `pool ${pool}, T-${toClose}: ${step} against ${minute}`);
    }
    assert.ok(Math.abs((level(21) - level(20)) - (level(22) - level(21))) <= 0.11, 'the cutoff is no step');
  }
});

test('★★★ U8 a close under the line is the run\'s own, not a drain walk: a slow run behind it says so, one that gets there does not', () => {
  const s = armedRun();
  const line = PLAN45.forceChargeLine!.linePct;
  const under = servedOf(s, WIN_CLOSE - 5 * M, 66);
  assert.ok(under.expectedWriteLevelPct! < line && under.expectedWriteLevelPct! > 66, String(under.expectedWriteLevelPct));
  assert.ok(under.rationale.includes(`NOTE: on the median load the pool is expected to close at ~${under.expectedWriteLevelPct}%, under tonight's ${under.cushionLineSocPct}% outage line`), under.rationale);
  assert.ok(cardText.outageLineRow(under as never, 50)!.endsWith('expected at the close — under the line; residual risk remains'));
  const over = servedOf(s, WIN_CLOSE - 15 * M, 70);
  assert.ok(over.expectedWriteLevelPct! > line, String(over.expectedWriteLevelPct));
  assert.equal(over.cushionShortfall, false, 'a run that gets there is not under the line, where the drain walk read it so');
  assert.equal(over.cushionEnvelopeReason, undefined);
  assert.doesNotMatch(over.rationale, /under tonight's|residual risk/);
  assert.equal(cardText.outageLineRow(over as never, 50)!.includes('under the line'), false);
});

test('★★★ U8 earlier in a run: never "switches on at" an ON long past, whichever the walk: to the close, or to the ceiling with no re-ON left, or with one to come', () => {
  const t = WIN_CLOSE - 60 * M;
  const s = armedRun();
  const toClose = servedOf(s, t, 60);
  assert.equal(toClose.expectedLineCeilingStop, undefined);
  assert.doesNotMatch(lineWords(toClose), START_CLAIM, toClose.rationale);
  assert.ok(lineWords(toClose).includes('the force-charge for the outage line is on, runs to the window close'), toClose.rationale);
  const stop = servedOf(s, t, 72);
  assert.deepEqual(stop.expectedLineCeilingStop, { ceilingPct: 81, startTargetPct: 76 });
  assert.doesNotMatch(lineWords(stop), START_CLAIM, stop.rationale);
  assert.ok(lineWords(stop).includes(`the force-charge for the outage line is on and the panel switches it off at its 81% ceiling, ~${stop.expectedWriteLevelPct}% expected at the close`), stop.rationale);
  assert.ok(lineWords(stop).includes(`so the panel's force-charge is on and runs until the panel switches it off at its 81% ceiling; the add-on switches it back on if the pool falls under 76% before the window closes (at most twice), ~${stop.expectedWriteLevelPct}% expected at the close.`), stop.rationale);
  const spent = armedRun({ forceChargeLineReOns: 2, forceChargeLineReOnAtMs: t - 40 * M });
  const barred = servedOf(spent, t, 72);
  assert.equal((barred.expectedLineCeilingStop as { noReOnWords?: string }).noReOnWords, WORDS_SPENT);
  assert.doesNotMatch(lineWords(barred), START_CLAIM, barred.rationale);
  assert.ok(lineWords(barred).includes(`so the panel's force-charge is on and runs until the panel switches it off at its 81% ceiling; ${WORDS_SPENT}, ~${barred.expectedWriteLevelPct}% expected at the close.`), barred.rationale);
  assert.doesNotMatch(barred.rationale, /the add-on switches it back on/, barred.rationale);
});

test('★★★ U8 what is not a run on keeps its words: an ON in its grace, a run stopped at the ceiling with a re-ON to come; a partial ON is told nothing of a run (U9)', () => {
  for (const [why, s, t] of [
    ['an ON in its readback grace', armedRun({ forceChargeOnVerifiedAtMs: null, forceChargeLineOffSlots: null, forceChargeOnAtMs: WIN_CLOSE - 21 * M, forceChargeOnLastAttemptMs: WIN_CLOSE - 21 * M }), WIN_CLOSE - 15 * M],
    ['a partial ON, the closure\'s', armedRun({ forceChargeOnVerifiedAtMs: null, forceChargeOnFailedAtMs: WIN_CLOSE - 30 * M, forceChargeOnFailedSlots: [3] }), WIN_CLOSE - 15 * M],
    ['a panel stop', armedRun({ forceChargeLineOffSlots: [1, 2, 3], forceChargeLinePanelOffAtMs: WIN_CLOSE - 50 * M }), WIN_CLOSE - 45 * M],
  ] as const) {
    assert.equal(runOnOf(s), null, why);
    const pool = 72;
    assert.deepEqual(servedOf(s, t, pool), planAt(45, { at: t, pool, closed: closedRec(s, t), noReOn: noReOnOf(s, t) }), why);
  }
});

test('★★★ U8 what stays: another window, an empty input and a closure leave the plan as it was; a night with no ask, a cost night and a cost-dominant night read no word of it; the plan of record is a pure first compute', () => {
  const t = WIN_CLOSE - 15 * M;
  const on = { at: t, pool: 72 };
  const base = planAt(45, on);
  assert.notDeepEqual(planAt(45, { ...on, runOn: WIN_OPEN }), base, 'the input moves the plan it is for');
  assert.deepEqual(planAt(45, { ...on, runOn: WIN_OPEN + 1 }), base, "an earlier night's record");
  assert.deepEqual(planAt(45, { ...on, runOn: null }), base);
  const closed = { closed: { windowStartMs: WIN_OPEN, why: 'stopped', writeStands: true } as never };
  assert.deepEqual(planAt(45, { ...on, ...closed, runOn: WIN_OPEN }), planAt(45, { ...on, ...closed }), 'a closure goes first');
  // A cost-dominant night keeps its cost words: a record with an ask and a walk of the cost force-charge.
  const cost = { at: WIN_CLOSE - 40 * M, pool: 50, cost: true };
  const costPlan = planAt(27, cost);
  assert.ok(costPlan.forceChargeLine != null && costPlan.expectedForceChargeMode !== 'line', JSON.stringify(costPlan.forceChargeLine));
  assert.ok(costPlan.costCeilingSocPct! >= costPlan.forceChargeLine!.askPct + 10, 'cost-dominant at ⌈L⌉ + 10');
  assert.deepEqual(planAt(27, { ...cost, runOn: WIN_OPEN }), costPlan);
  // A night of the cost force-charge with no line at all.
  const noAsk = { at: WIN_CLOSE - 40 * M, pool: 60, cost: true };
  assert.equal(planAt(30, noAsk).forceChargeLine, undefined);
  assert.deepEqual(planAt(30, { ...noAsk, runOn: WIN_OPEN }), planAt(30, noAsk));
  // A floor above the write and an advisory plan arm no line.
  assert.deepEqual(planAt(51, { ...on, runOn: WIN_OPEN }), planAt(51, on));
  assert.deepEqual(planAt(45, { ...on, eligible: false, runOn: WIN_OPEN }), planAt(45, { ...on, eligible: false }));
  // A plan told of no run keeps its times, to the close and to the ceiling (v1.202.0: a 29% floor stays under the ceiling
  // on the measured pool; 30% reaches it).
  const evening = planAt(29);
  assert.equal(evening.expectedLineCeilingStop, undefined);
  assert.match(evening.rationale, /the force-charge for the outage line runs from ~\S+ to the window close and takes it to /, evening.rationale);
  assert.match(evening.rationale, /so the panel's force-charge switches on at ~\S+ and stays on until the window closes/, evening.rationale);
  assert.match(PLAN45.rationale, /the force-charge for the outage line switches on at ~\S+ and the panel switches it off at its 81% ceiling/, PLAN45.rationale);
  assert.match(PLAN45.rationale, /so the panel's force-charge switches on at ~\S+ and runs until the panel switches it off/, PLAN45.rationale);
  // The sizing, and what a tick reads off the served plan: nothing written moves.
  const served = planAt(45, { ...on, runOn: WIN_OPEN, noReOn: { windowStartMs: WIN_OPEN, words: WORDS_SPENT } });
  assert.deepEqual(sizing(served), sizing(base));
  assert.deepEqual(served.evContention, base.evContention, 'decideForceCharge reads the EV displacement off the served plan');
  assert.deepEqual(served.window, base.window, 'nextForceChargeOpenMs reads its window');
  assert.deepEqual(served.forceChargeLine, base.forceChargeLine);
  // A pure compute: the inputs and the first plan are as they were.
  const deps = { ...caseOf(LABEL).deps, reserveFloorPct: 45, cushionPoolScale: MEASURED_SCALE, forceChargeEligible: false, lineForceChargeEligible: true, nowMs: t, socNowPct: 72 } as never;
  const inputs = buildNightChargeInputs(deps);
  const first = computeNightChargePlan(inputs);
  const before = JSON.stringify([inputs, first]);
  computeNightChargePlan({ ...inputs, armedLineRunOnStartMs: WIN_OPEN } as never);
  assert.equal(JSON.stringify([inputs, first]), before);
  assert.deepEqual(first, computeNightChargePlan(inputs), 'the plan of record');
});

test('★★★ U8 past the cutoff the ceiling\'s words are reached: a pool the rest of the run takes to the panel\'s stop, with no re-ON left, says so, and walks none', () => {
  const t = WIN_CLOSE - 20 * M;
  const on = { at: t, pool: 71, fullKwh: 61, runOn: WIN_OPEN };
  const words = { windowStartMs: WIN_OPEN, words: WORDS_SPENT };
  const p = planAt(30, { ...on, noReOn: words });
  const line = p.forceChargeLine!.linePct;
  assert.ok(line > 50);
  assert.deepEqual(p.expectedLineCeilingStop, { ceilingPct: 80, startTargetPct: 74, noReOnWords: WORDS_SPENT });
  assert.ok(p.rationale.includes(`so the panel's force-charge is on and runs until the panel switches it off at its 80% ceiling; ${WORDS_SPENT}, ~${p.expectedWriteLevelPct}% expected at the close.`), p.rationale);
  assert.ok(p.rationale.includes(`the force-charge for the outage line is on and the panel switches it off at its 80% ceiling, ~${p.expectedWriteLevelPct}% expected at the close`), p.rationale);
  assert.doesNotMatch(p.rationale, /the add-on switches it back on|at most/, p.rationale);
  assert.doesNotMatch(p.rationale, CEILING_CLAIM, p.rationale);
  const row = cardText.outageLineRow(p as never, 50)!;
  assert.ok(row.endsWith(`the panel's force-charge runs until the panel switches it off at its 80% ceiling, and ${WORDS_SPENT}, ~${p.expectedWriteLevelPct}% expected at the close`), row);
  // The same run with no word of the record: the plan the finding read, past the walk's last start.
  const told = planAt(30, { at: t, pool: 71, fullKwh: 61, noReOn: words });
  assert.equal(told.expectedForceChargeStartMs, null, 'a start the walk can no longer make');
  assert.equal(told.expectedLineCeilingStop, undefined);
});

test('★★★ U8 a walk with no P50 basis keeps the run on: never "switches on just in time"', () => {
  const on = { at: WIN_CLOSE - 15 * M, pool: 72, noP50: true };
  const before = planAt(45, on);
  assert.equal(before.expectedForceChargeStartMs, undefined, 'no walk');
  assert.ok(before.rationale.includes("so the panel's force-charge switches on just in time and stays on until the window closes."), before.rationale);
  const p = planAt(45, { ...on, runOn: WIN_OPEN });
  assert.equal(p.expectedForceChargeStartMs, undefined);
  assert.ok(p.rationale.includes("so the panel's force-charge is on and stays on until the window closes."), p.rationale);
  assert.doesNotMatch(p.rationale, START_CLAIM, p.rationale);
});

test('★★★ U8 two whole runs through the cutoff on the real chain: a slow one and a normal one, each minute served as on or as the sizing\'s own hold, and the tick unmoved', () => {
  const s = armedRun();
  const line = PLAN45.forceChargeLine!.linePct;
  // pool(toClose): a slow run holds under the sizing's hold to the close; a normal one rises through it.
  for (const [name, poolAt] of [['slow', (m: number) => 72 - 0.3 * (m - 4)], ['normal', (m: number) => 80 - 0.24 * m]] as const) {
    let held = 0;
    for (let toClose = 40; toClose >= 1; toClose -= 1) {
      const t = WIN_CLOSE - toClose * M;
      const pool = Math.round(poolAt(toClose) * 10) / 10;
      const where = `${name}, T-${toClose}, pool ${pool}`;
      const p = servedOf(s, t, pool);
      assert.equal(decideForceCharge(s, t, fo({ poolSocPct: pool, slotsOn: [1, 2, 3], ceilingReadbackPct: 81 })).kind, 'none', `${where}: the run stays on`);
      assert.doesNotMatch(p.rationale, /not expected to start|no charge expected/, where);
      assert.doesNotMatch(p.rationale, START_CLAIM, where);
      if (p.chargeTonight) {
        assert.equal(p.expectedForceChargeStartMs, t, where);
        assert.ok(p.expectedWriteLevelPct! > pool, where);
        assert.ok(lineWords(p).includes('the force-charge for the outage line is on'), where);
      } else {
        held += 1;
        assert.equal(p.forceChargeLine, undefined, where);
        assert.deepEqual(p, planAt(45, { at: t, pool, noReOn: noReOnOf(s, t) }), `${where}: a hold reads no word of it`);
      }
      if (p.chargeTonight && p.expectedWriteLevelPct! >= line) assert.equal(cardText.outageLineRow(p as never, 50)!.includes('under the line'), false, where);
    }
    assert.ok(held > 0, `${name}: the sizing's own hold comes at the end, a true word`);
  }
});

test('★★★ U8 the on-peak guard: the re-ON\'s cutoff runs from it and the run is still on there; its OFF ends the run', () => {
  const peak = WIN_CLOSE + 30 * M;
  const s = armedRun({ nextOnPeakStartMs: peak });
  const end = peak - H;
  assert.equal(end, WIN_CLOSE - 30 * M);
  const cut = end - 20 * M;
  assert.equal(noReOnOf(s, cut - 1), null);
  assert.deepEqual(noReOnOf(s, cut), { windowStartMs: WIN_OPEN, words: WORDS_SPENT });
  for (const at of [cut - M, cut, cut + 10 * M]) {
    assert.equal(runOnOf(s), WIN_OPEN);
    const p = servedOf(s, at, 70);
    assert.equal(p.expectedForceChargeStartMs, at);
    assert.doesNotMatch(p.rationale, CEILING_CLAIM);
    assert.doesNotMatch(p.rationale, START_CLAIM);
  }
  const a = decideForceCharge(s, end, fo({ poolSocPct: 70, slotsOn: [1, 2, 3], ceilingReadbackPct: 81 }));
  assert.equal(a.kind, 'off', 'the guard ends the write window');
  const off = { ...s, forceChargeOffAtMs: end, forceChargeOffReason: 'windowEnd' } as NightActuationState;
  assert.equal(runOnOf(off), null);
  assert.equal(closedRec(off, end + M)?.why, 'stopped');
});

/* ══ U9 — (Fix12) an ON warned of on some slots ═══════════════════════════════════════════════════════════════════════════════════ */

const PART_TAKEN = 'the force-charge for it was switched on and has not taken effect on all its slots: unless it applies late, the add-on does not switch it back on';
/** What a partial ON must never be served: its other slots may run on or stop, so no start, no run, no "armed" and no walked close. */
const PART_CLAIMS = /switches on at|switches on just in time|runs from|runs until|is on, runs|not expected to start|no charge expected|% by the close|expected at the close|takes it to|stays on/;
/** The real chain, a minute at a time: armed by armFromPlan, stepped by decideForceCharge with index.ts's stamps, `refused` never reading ON,
 *  the others importing `kw` each beside a `house` kW load on a pool of `poolKwh`. Returns the record and the pool at each minute left. */
const partialChain = (p0: number, refused: number[], { kw = 14 / 3, house = 0.9, poolKwh = 92.16 } = {}) => {
  let s: NightActuationState = {
    ...armFromPlan(emptyActuationState(), '2027-01-04', PLAN45, WIN_OPEN - 90 * M, 45, false, null, true)!,
    applyAttemptedAtMs: WIN_OPEN, attemptBaselinePct: 45, appliedAtMs: WIN_OPEN, priorReservePct: 45, applyVerifiedAtMs: WIN_OPEN + 3 * M,
  };
  let pool = p0;
  let onAt: number | null = null;
  const seen: string[] = [];
  const at = new Map<number, { s: NightActuationState; t: number; pool: number }>();
  for (let t = WIN_OPEN + 4 * M; t < WIN_CLOSE; t += M) {
    const slotsOn = onAt == null ? [] : [1, 2, 3].filter((n) => !refused.includes(n));
    const a = decideForceCharge(s, t, fo({ ceilingReadbackPct: 81, poolSocPct: pool, slotsOn, slotSocPct: { 1: pool, 2: pool, 3: pool } }));
    if (a.kind !== 'none') seen.push(a.kind);
    if (a.kind === 'syncCeiling') s = { ...s, forceChargeCeilingPriorPct: a.prior, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingSyncedPct: a.pct };
    else if (a.kind === 'on') { s = { ...s, ...nfc.forceChargeOnStamp(s, t, a.slots, GATES), forceChargeOnLastAttemptMs: t }; onAt = t; }
    else if (a.kind === 'onRetry') s = { ...s, forceChargeOnRetries: s.forceChargeOnRetries + 1, forceChargeOnLastAttemptMs: t };
    else if (a.kind === 'onFailed') s = { ...s, forceChargeOnFailedAtMs: t, forceChargeOnFailedSlots: [...a.slots] };
    else if (a.kind === 'onVerified') s = { ...s, forceChargeOnVerifiedAtMs: t };
    pool += (([1, 2, 3].filter((n) => !refused.includes(n)).length * (onAt == null ? 0 : kw) - house) / 60 / poolKwh) * 100;
    at.set((WIN_CLOSE - t) / M, { s, t, pool: Number(pool.toFixed(2)) });
  }
  return { seen, at: (left: number) => at.get(left)! };
};

test('★★★ U9 an ON warned of on some slots is a closed start, of its own: the closure names it, its write stands but the card leads, and the words state no figure', () => {
  const t = STOP_AT;
  const s = WARNED({ forceChargeOnFailedSlots: [3] });
  assert.deepEqual(nfc.partialForceChargeOnFailureSlots(s), [3]);
  assert.equal(nfc.reserveWriteStands(s), true, 'its write does stand');
  assert.deepEqual(closedRec(s, t), { windowStartMs: OPEN, why: 'partTaken' }, 'and is withheld: "reserve held as a floor — no charge expected" is false while two slots charge');
  assert.equal(closedRec(WARNED(), t)?.why, 'notTaken', 'every slot');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedSlots: null }), t)?.why, 'notTaken', 'a failure kept before its slots were: whole-night');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedSlots: [2, 3] }), t)?.why, 'partTaken', 'two of three');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedSlots: [1], forceChargeSlots: [1, 2] }), t)?.why, 'partTaken', 'one of two');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedAtMs: null, forceChargeOnFailedSlots: null }), t), null, 'an ON in its grace: not warned of');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedSlots: [3], cancelled: true }), t)?.why, 'cancelled', 'a one-way stamp goes first');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedSlots: [3], forceChargeOffAtMs: t, forceChargeOffReason: 'windowEnd' }), t + M)?.why, 'stopped');
  assert.equal(closedRec(WARNED({ forceChargeOnFailedSlots: [3], forceChargeLineAskPct: null, forceChargeLinePct: null }), t), null, 'a cost night: not a word');
  assert.equal(nfc.lineStartClosedWords('it', 'partTaken' as never), PART_TAKEN);
  assert.equal(nfc.lineStartClosedWords('the 55.6% outage line', 'partTaken' as never), PART_TAKEN.replace('for it', 'for the 55.6% outage line'));
  assert.ok(!('partTaken' in nfc.FORCE_CHARGE_START_CLOSED_WHY));
  assert.equal(nfc.forceChargeStartClosed(s, t, GATES), 'started', "the pushes' own key stays");
  const base = planAt(45);
  const p = planAt(45, { closed: { windowStartMs: base.window!.startMs, why: 'partTaken' } as never });
  assert.equal(p.forceChargeLine, undefined);
  assert.equal(p.cushionEnvelopeReason, 'startClosed');
  assert.equal((p as unknown as { cushionStartClosedWords: string }).cushionStartClosedWords, PART_TAKEN);
  assert.equal((p as never as { cushionStartClosedNoWrite?: boolean }).cushionStartClosedNoWrite, true, 'the card leads');
  assert.deepEqual(cardText.startClosedLead(p as never), { headline: 'The outage line is not claimed tonight', detail: `${PART_TAKEN.charAt(0).toUpperCase()}${PART_TAKEN.slice(1)}.` });
  assert.ok(p.rationale.includes(`, and ${PART_TAKEN}, so the cushion is not assured — residual risk remains.`), p.rationale);
  assert.deepEqual(sizing(p), sizing(base), 'every figure a write reads stays');
  const status = (cycle as unknown as { lineStartClosedStatus: (s: NightActuationState, t: number, g: { cost: boolean; line: boolean }) => Record<string, unknown> }).lineStartClosedStatus;
  assert.deepEqual(status(s, t, GATES), { lineStartClosed: { text: `${PART_TAKEN.replace('for it', 'for the 55.6% outage line').charAt(0).toUpperCase()}${PART_TAKEN.replace('for it', 'for the 55.6% outage line').slice(1)}.`, cancel: true } });
  // The tick is untouched: no re-ON, nothing more to issue, and the failure stays once a night.
  for (let at = t; at < CLOSE - M; at += M) assert.equal(decideForceCharge(s, at, fo({ poolSocPct: 52, slotsOn: [1, 2] })).kind, 'none');
  assert.equal(nfc.lineReOnDue(s, t, fo({ poolSocPct: 52, slotsOn: [1, 2] }), [1, 2, 3]), null);
});

test('★★★ U9 the finding, on the real chain: at T-60, T-45 and T-15, from pools 46, 48, 60 and 62, slot 2 or slots 2 and 3 refused: no start, no run, no "armed", no walked figure on the rationale, the row, the lead or the banner', () => {
  const status = (cycle as unknown as { lineStartClosedStatus: (s: NightActuationState, t: number, g: { cost: boolean; line: boolean }) => Record<string, unknown> }).lineStartClosedStatus;
  for (const p0 of [46, 48, 60, 62]) for (const refused of [[2], [2, 3]]) {
    const night = partialChain(p0, refused);
    assert.deepEqual(night.seen.filter((k) => k !== 'syncCeiling'), ['on', 'onRetry', 'onFailed'], 'and nothing after it to the close');
    for (const left of [60, 45, 15]) {
      const { s, t, pool } = night.at(left);
      const name = `pool ${p0}, ${refused.join('+')} refused, T-${left}, reading ${pool}`;
      assert.deepEqual(nfc.partialForceChargeOnFailureSlots(s), refused, name);
      assert.equal(s.forceChargeOnVerifiedAtMs, null, name);
      assert.equal(runOnOf(s), null, name);
      assert.equal(noReOnOf(s, t), null, name);
      const p = servedOf(s, t, pool);
      assert.equal(p.chargeTonight, true, name);
      assert.equal(p.cushionEnvelopeReason, 'startClosed', name);
      const row = cardText.outageLineRow(p as never, 50)!;
      const lead = cardText.startClosedLead(p as never)!;
      const banner = (cardText.actuationBannerState as unknown as (a: unknown, d: string | null, r?: number | null) => { text: string })({ ...s, ...status(s, t, GATES) }, '23:00', 50).text;
      assert.ok(lead != null, name);
      assert.ok(row.includes(`not claimed tonight (${PART_TAKEN})`), row);
      for (const [where, text] of [['rationale', p.rationale], ['row', row], ['headline', `${lead.headline} ${lead.detail}`], ['banner', banner]] as const) {
        assert.doesNotMatch(text, PART_CLAIMS, `${name}, ${where}: ${text}`);
      }
      assert.equal(p.expectedForceChargeStartMs, undefined, name);
      assert.equal(p.expectedForceChargeMode, undefined, name);
    }
  }
});

test('★★★ U9 a late apply reopens it: the verify stamps it, the closure goes and the run is on, as any verified run', () => {
  const night = partialChain(60, [3]);
  const { s, t, pool } = night.at(45);
  assert.equal(closedRec(s, t)?.why, 'partTaken');
  const a = decideForceCharge(s, t + M, fo({ ceilingReadbackPct: 81, poolSocPct: pool, slotsOn: [1, 2, 3], slotSocPct: { 1: pool, 2: pool, 3: pool } }));
  assert.equal(a.kind, 'onVerified', 'a late apply still verifies');
  const v = { ...s, forceChargeOnVerifiedAtMs: t + M };
  assert.equal(closedRec(v, t + 2 * M), null, 'reopened');
  assert.equal(runOnOf(v), v.windowStartMs);
  assert.equal(servedOf(v, t + 2 * M, pool).cushionEnvelopeReason, undefined, 'carried again');
  assert.equal(lineWords(servedOf(v, t + 2 * M, pool)).includes('the force-charge for the outage line is on'), true);
  // Its words said so: "unless it applies late", and that is the one way back.
  assert.ok(PART_TAKEN.includes('unless it applies late'));
});

test('★★★ U9 never a run on: told it is on, the walk takes the three-slot rate and drops a true warning: served over the 70.55 line, on a night that closes under it', () => {
  // Measured: 5.2 kW a Core (15-2), the house on the grid, an 87 kWh pool.
  const night = partialChain(60, [2, 3], { kw: 5.2, house: 0, poolKwh: 87 });
  const { s, t, pool } = night.at(15);
  assert.equal(runOnOf(s), null);
  // What the walk would say, told: over the line, with no note. What the chain does: under it.
  const told = planAt(45, { at: t, pool, runOn: WIN_OPEN });
  assert.ok(told.expectedWriteLevelPct! > PLAN45.cushionLineSocPct!, `${told.expectedWriteLevelPct}`);
  assert.ok(night.at(1).pool < PLAN45.cushionLineSocPct!, `the night reads ${night.at(1).pool} at the close`);
  assert.deepEqual(servedOf(s, t, pool), planAt(45, { at: t, pool, closed: closedRec(s, t) }), 'the closure says it, with no figure');
});

test('★★★ U9 the unverified branch of armedLineNoReOn is gone: a closure goes first on every failure stamp, so nothing reached it', () => {
  for (const failed of [[1, 2, 3], [3], [2, 3], null]) {
    const s = WARNED({ forceChargeOnFailedSlots: failed });
    assert.equal(noReOnOf(s, STOP_AT), null, String(failed));
    assert.notEqual(closedRec(s, STOP_AT), null, String(failed));
  }
  assert.equal(noReOnOf(SPENT({ forceChargeOnVerifiedAtMs: null }), STOP_AT), null, 'no reading has judged it: the budget says nothing of it yet');
  assert.equal(noReOnOf(RUN({ forceChargeOnVerifiedAtMs: null }), CUT), null, 'nor the cutoff');
  const SRC = readFileSync(resolve(HERE, '../src/nightForceCharge.ts'), 'utf8');
  assert.ok(!SRC.includes("words: 'unless it applies late, the add-on does not switch it back on'"));
});

test('★★★ U8 wiring: beside the closure and the no-re-ON, on their terms: the served plan alone reads it, and the plan of record stays', () => {
  const at = INDEX.indexOf('async function recomputeNightChargePlan(');
  const fn = INDEX.slice(at, INDEX.indexOf('function armedExpectedBuyKwh(', at));
  assert.ok(fn.includes('  const lineRunOn = shadowLeg == null && opts.arming !== true && nightActuationMem.windowStartMs === plan.window?.startMs ? armedLineRunOn(nightActuationMem) : null;\n'), 'never an arm, a shadow leg or a later window');
  assert.ok(fn.includes('  if (!shadowLeg) setLatestNightChargePlan(lineClosed != null || lineNoReOn != null || lineRunOn != null ? computeNightChargePlan({ ...inputs, armedLineStartClosed: lineClosed, armedLineNoReOn: lineNoReOn, armedLineRunOnStartMs: lineRunOn }) : plan);\n'), 'the second compute');
  assert.ok(fn.includes('  const inputs = buildNightChargeInputs(deps);\n  const plan = computeNightChargePlan(inputs);\n'), 'the plan of record');
  assert.ok(fn.includes('  return { plan, extras };\n}'), 'the caller gets the first compute');
  const SRC = readFileSync(resolve(HERE, '../src/nightChargeAdvisor.ts'), 'utf8');
  assert.ok(SRC.includes('noReOn: lineNoReOn != null, runOn: lineRunOn, tickPoolKwh: panelFullKwh,'), 'the walk');
});
