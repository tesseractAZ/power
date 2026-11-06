import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNightChargePlan, buildNightChargeInputs, lineForceChargeLedgerColumns, type NightChargePlan } from '../src/nightChargeAdvisor.js';
import * as nfc from '../src/nightForceCharge.js';
import { decideForceCharge, lineDeclinedPushTick, EMPTY_LINE_DECLINED_PUSH, type ForceChargeOpts } from '../src/nightForceCharge.js';
import {
  APPLY_LATE_MS, APPLY_VERIFY_AFTER_MS, armFromPlan, coerceActuationState, decideActuation, emptyActuationState,
  restoreSummaryDue, type NightActuationState,
} from '../src/nightChargeActuator.js';
import { asChargeLeg, missedApplyDue, missedApplyReason, promoteCycle, type ChargeLegState } from '../src/chargeCycle.js';
import * as notify from '../src/notify.js';
import { buildNightChargeForeignReserve, buildNightChargeMessage, buildNightChargeMissedApply, buildNightChargeMorningSummary } from '../src/notify.js';
import { computeNightChargeReadiness, CURRENT_ALGO_VERSION, phoenixYmd } from '../src/nightChargeGate.js';
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
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const M = 60_000;
const H = 60 * M;
const CASES = legacyIdentityCases();
const LABEL = '2027-01-04 21:30';
const caseOf = (label: string) => CASES.find((c) => c.label === label)!;
type P = NightChargePlan & { forceChargeLine?: { askPct: number; linePct: number }; cushionEnvelopeReason?: string; cushionShortfallCause?: string; expectedForceChargeMode?: string };
const planAt = (floor: number, o: { eligible?: boolean; cost?: boolean; hours?: number; label?: string } = {}): P => {
  const deps = {
    ...caseOf(o.label ?? LABEL).deps, reserveFloorPct: floor, cushionPoolScale: MEASURED_SCALE, objective: 'resilience',
    forceChargeEligible: o.cost === true, ...(o.eligible !== false ? { lineForceChargeEligible: true } : {}),
    ...(o.hours != null ? { outageCushionHours: o.hours } : {}),
  } as never;
  return computeNightChargePlan(buildNightChargeInputs(deps)) as P;
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

test('★★★ U1 a reserve already at the write: the plan neither claims nor arms the line (reason reserveAtTarget), says why, and no sizing figure moves; one point under, it arms', () => {
  const p = planAt(50);
  const absent = planAt(50, { eligible: false });
  assert.equal(p.chargeTonight, true);
  assert.ok(p.cushionLineSocPct > 50);
  assert.equal(p.forceChargeLine, undefined, 'nothing armed: a force-charge rides a verified write, and none goes');
  assert.equal(p.cushionShortfall, true, 'the line is not claimed');
  assert.ok(p.cushionShortfallCause === 'envelope' || p.cushionShortfallCause === 'envelope+caps', String(p.cushionShortfallCause));
  assert.equal(p.cushionEnvelopeReason, 'reserveAtTarget');
  assert.deepEqual(sizing(p), sizing(absent), 'I-A1: no sizing figure moves');
  assert.notEqual(p.expectedForceChargeMode, 'line');
  assert.ok(p.rationale.includes(`The reserve is set to 50%, the most the panel accepts as a backup reserve; tonight's ${p.cushionLineSocPct}% outage line is above it and the reserve already reads 50%: no write goes, and no force-charge runs without one, so the cushion is not fully held — residual risk remains.`), p.rationale);
  assert.doesNotMatch(p.rationale, /switches on at|stays on until the window closes|tonight's write/);
  // The ledger: the ask is not recorded, the disclosure is.
  assert.deepEqual(lineForceChargeLedgerColumns(p as never), { cushion_line_force_charge_pct: null, cushion_envelope_shortfall: 1 });
  // One point under the write: the write goes, and the line arms as ever.
  const q = planAt(49);
  assert.equal(q.forceChargeLine?.askPct != null, true, 'the write raises 49 to 50: armed');
  assert.equal(q.cushionEnvelopeReason === 'reserveAtTarget', false);
  // Advisory and the backup leg keep their own reason.
  assert.equal(planAt(50, { eligible: false }).cushionEnvelopeReason, undefined, 'no eligibility input: v1.199.1');
});

test('★★★ U1 no force-charge is expected on such a plan, a cost night too: what the night expects is what it can do (the reserve alone)', () => {
  const costOn = planAt(50, { cost: true });
  assert.equal(costOn.forceChargeLine, undefined);
  assert.equal(costOn.cushionEnvelopeReason, 'reserveAtTarget');
  assert.equal(costOn.expectedForceChargeStartMs == null, true, 'no start stated');
  assert.equal(costOn.expectedForceChargeMode === 'line', false);
});

test('★★★ U1 the evening surfaces of such a plan: the note names why, the supervised tail says nothing is written, no raise and no force-charge are promised; the card row says why', () => {
  const p = planAt(50);
  const sup = { cancelDeadlineText: 'tonight at 11:00 PM', targetPct: 50, forceChargeTargetPct: null, forceChargeLine: null };
  const body = buildNightChargeMessage(p as never, 'charge', sup as never).body;
  assert.ok(body.includes(`NOTE: tonight's ${Math.round(p.cushionLineSocPct * 10) / 10}% outage line is above the 50% the panel accepts as a reserve, and the reserve already reads 50%: no write goes, and no force-charge runs without one — residual risk remains.`), body);
  assert.ok(body.includes('SUPERVISED: the backup reserve already reads 50%, so the add-on writes nothing tonight and no force-charge runs.'), body);
  assert.doesNotMatch(body, /raises the backup reserve|switches the panel's force-charge ON|Cancel from the night-charge card/);
  // A cost ceiling armed beside it rides nothing either.
  const cost = planAt(50, { cost: true });
  const costBody = buildNightChargeMessage(cost as never, 'charge', { ...sup, forceChargeTargetPct: 80 } as never).body;
  assert.doesNotMatch(costBody, /raises the backup reserve|arms the panel's force-charge|switches the panel's force-charge ON/);
  const row = (cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow(p);
  assert.ok(row != null && row.includes('not held tonight (the reserve already reads 50%: no write, no force-charge)'), String(row));
  // The record arms with no line, so no line surface promises one; the 21:30 line says the same.
  const rec = armFromPlan(emptyActuationState(), '2027-01-04', p as never, p.window!.startMs - 90 * M, 50, false, null, true)!;
  assert.equal(rec.forceChargeLineAskPct, null);
  assert.ok(INDEX.includes("if (plan?.cushionEnvelopeReason === 'reserveAtTarget') return `Force-charge: none tonight — the reserve already reads ${plan.reserveFloorPct}%, so no write goes and no force-charge runs without one; tonight's outage line is not held.`;"));
});

test('★★ U1 the spoken notice of such a plan says the cushion is not met, and promises no raise', () => {
  const p = planAt(50);
  const { spoken } = eveningAnnouncement({
    cycle: 'overnight', plan: p as never, shape: 'charge', armRefused: null, mode: 'supervised',
    supervised: { cancelDeadlineText: 'tonight at 11:00 PM', cancelDeadlineTextEs: 'esta noche a las 11:00 PM', targetPct: 50, forceChargeTargetPct: null, forceChargeLine: null },
  } as never);
  assert.ok(spoken != null);
  assert.ok(spoken.en.includes('Outage cushion not fully met.'), spoken.en);
  assert.doesNotMatch(spoken.en, /raise|force|Charge Now/i);
});

/** The year at a standing 50 and 4 h of cushion, every case: measured with the fix (each of these armed before, and never could start). */
const PIN_U1_YEAR = { charge: 815, armed: 0, disclosed: 655 };

test('★★★ U1 the year at a standing 50: every line that armed and could never start is now disclosed, and none arms; at 49 they arm as before', () => {
  let charge = 0;
  let isArmed = 0;
  let disclosed = 0;
  for (const c of CASES) {
    const p = planAt(50, { label: c.label, hours: 4 });
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
  assert.equal(missedApplyReason(leg(armed()), { ...ctx, currentReservePct: 50 }), 'the backup reserve already read 50%, at or above the 50% this charge sets');
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
  assert.ok(m.body.endsWith(`charge did not start — ${reason}. Nothing was written; the reserve stays at 50%. No force-charge for tonight's 55.6% outage line starts: it rides a verified reserve write, and none was issued. To hold the line tonight, switch Charge Now on in the EcoFlow app, and off again by ~5:00 AM.`), m.body);
  // Past the close nothing can be done by hand: no advice.
  const over = buildNightChargeMissedApply({ ...base, nowMs: CLOSE + H, reason, linePct: 55.55, targetPct: 50, attempted: false, startClosed: 'over', startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.ok(over.body.endsWith("No force-charge for tonight's 55.6% outage line starts: the window has closed."), over.body);
  // In the last 20 minutes Charge Now by hand still adds something.
  const late = buildNightChargeMissedApply({ ...base, reason, linePct: 55.55, targetPct: 50, attempted: false, startClosed: 'late', startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.ok(late.body.includes('20 min or less of the window is left. To hold the line tonight, switch Charge Now on'), late.body);
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
  assert.ok(m.body.endsWith("charge has not started: the EcoFlow cloud did not confirm the reserve write, and the panel reads 30%. Until the panel reads 50%, it keeps its normal reserve, under tonight's 55.6% outage line, and the force-charge for the line waits on this write. To let it start, set the backup reserve to 50% in the EcoFlow app now: the sooner the panel reads it, the more of the line a start can reach. No force-charge starts after ~4:40 AM, and one that late may close under the line. If this repeats, check the SHP2 cloud link."), m.body);
  assert.doesNotMatch(m.body, /Nothing was written/);
  const dark = buildNightChargeMissedApply({ ...base, reservePct: null, linePct: 55.55, targetPct: 50, attempted: true, startClosed: null, startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.ok(dark.body.includes('and the panel is not reporting its reserve. '), dark.body);
  const closed = buildNightChargeMissedApply({ ...base, linePct: 55.55, targetPct: 50, attempted: true, startClosed: 'late', startByText: '4:40 AM', closeText: '5:00 AM' } as never);
  assert.ok(closed.body.endsWith("No force-charge for tonight's 55.6% outage line starts: 20 min or less of the window is left. If this repeats, check the SHP2 cloud link."), closed.body);
  assert.doesNotMatch(closed.body, /waits on|To let it start/);
  // The advice holds: a reading of the target adopts an attempt, verifies, and the start rides it; with no attempt it does not.
  const attempted = armed({ applyAttemptedAtMs: OPEN + 30 * M, attemptBaselinePct: 30 });
  const tick = { mode: 'supervised' as const, writeReady: true, currentReservePct: 50, socCoherent: true, vitalsRed: false, gridPresent: true };
  assert.equal(decideActuation(attempted, OPEN + 40 * M, tick).kind, 'adopt');
  assert.equal(decideActuation(armed(), OPEN + 40 * M, tick).kind, 'none', 'no attempt: a hand-set reserve starts nothing, so that push names Charge Now instead');
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
  assert.equal(a.body, 'Supervised night charge for 2027-01-04: no reserve write was confirmed, so no force-charge ran for the 55.6% outage line. The pool reads 41%, under the line.');
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
  assert.ok(step.includes('closePoolPct: freshPoolSocPct(nowMs),'), step);
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
  assert.equal(not.body.slice(plain.body.length), " No force-charge for tonight's 55.6% outage line starts: the reserve was set outside the add-on, and setting it back does not change that. The pool may close under the line. To hold the line tonight, switch Charge Now on in the EcoFlow app, and off again by ~5:00 AM.");
  const on = buildNightChargeForeignReserve({ ...base, line: { linePct: 55.55, started: true, closeText: '5:00 AM' } } as never);
  assert.equal(on.body.slice(plain.body.length), " The force-charge for tonight's 55.6% outage line rode that write, so the add-on switches it off, and it does not start again, whatever the reserve reads later. The pool may close under the line. To hold the line tonight, switch Charge Now on in the EcoFlow app, and off again by ~5:00 AM.");
  // A line the reserve holds is never said to close under it.
  const at50 = buildNightChargeForeignReserve({ ...base, line: { linePct: 50, started: false, closeText: '5:00 AM' } } as never);
  assert.doesNotMatch(at50.body, /under the line/);
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
    assert.equal(unread.body, `${plain.body} The pool was not read (no fresh panel reading); tonight's outage line is 55.6%.`, ended);
    const acked = buildNightChargeMorningSummary({ ...base, ended, restore: 'acknowledged', closePoolPct: 53, linePct: 55.55 } as never);
    assert.ok(acked.body.endsWith('Nothing more is charged tonight. The pool reads 53%, under the 55.6% outage line.'), acked.body);
  }
});

test('★★★ U4 a grid loss before the close says what can still hold the line once the grid is back; a cancel, and a stop at or after the close, do not', () => {
  const base = { day: '2027-01-04', targetPct: 50, restorePct: 30, expectedKwh: 20, closePoolPct: 53, linePct: 55.55 };
  const tail = ' To hold the line once the grid is back, switch Charge Now on in the EcoFlow app, and off again by ~5:00 AM.';
  assert.ok(buildNightChargeMorningSummary({ ...base, ended: 'gridLoss', closeText: '5:00 AM' } as never).body.endsWith(`under the 55.6% outage line.${tail}`));
  assert.ok(!buildNightChargeMorningSummary({ ...base, ended: 'gridLoss', closeText: null } as never).body.includes('To hold the line'), 'past the close');
  assert.ok(!buildNightChargeMorningSummary({ ...base, ended: 'cancelled', closeText: '5:00 AM' } as never).body.includes('To hold the line'), 'the person\'s cancel');
  // Held: nothing to hold.
  assert.ok(!buildNightChargeMorningSummary({ ...base, closePoolPct: 60, ended: 'gridLoss', closeText: '5:00 AM' } as never).body.includes('To hold the line'), 'at or above the line');
  const at = INDEX.indexOf('function sendRestoreSummary(');
  const fn = INDEX.slice(at, INDEX.indexOf('\n}\n', at));
  assert.ok(fn.includes('closeText: lineNight != null && state.windowEndMs != null && nowMs < writeWindowEndMs(state)! ? fmtSiteClock(writeWindowEndMs(state)!) : null,'), fn);
});
