/**
 * v1.182.0 — pure text/visibility rules for the night-charge card (run by
 * server/test/dashboardAuditFour.test.ts; no browser imports).
 */

export interface BannerActuation {
  day: string | null;
  appliedAtMs: number | null;
  revertedAtMs: number | null;
  cancelled: boolean;
  windowEndMs: number | null;
  cancelDeadlineMs: number | null;
  /** The revert CONFIRMED by readback (revertedAtMs is the cloud's ACK only). */
  revertVerifiedAtMs?: number | null;
  revertRetries?: number;
  revertReadbackEscalated?: boolean;
  /** v1.189.0 — the reserve settled as someone else's (the server's foreign rule): the night is
   *  resolved, its write no longer holds the reserve, and there is nothing of it left to cancel. */
  foreignSettledAtMs?: number | null;
  foreignReservePct?: number | null;
  /** v1.200.1 — the reserve stood at the target (the server's reserveStandingAtMs): no write went and nothing is restored. */
  reserveStandingAtMs?: number | null;
}

/** A restore the cloud acknowledged but the panel has not confirmed, and the actuator is retrying
 *  or has escalated: still actionable, never "Completed", never hidden. */
export function revertUnconfirmed(a: BannerActuation | null): boolean {
  return !!a && a.revertedAtMs != null && a.revertVerifiedAtMs == null
    && (a.revertReadbackEscalated === true || (a.revertRetries ?? 0) > 0);
}

/** A completed night's banner stays up this long after the revert, then clears. */
export const COMPLETED_BANNER_MS = 6 * 3_600_000;

/**
 * Last night's actuation banner stayed on the card all day — "Completed — reserve restored"
 * at 4 PM reads as something happening now. A banner belongs to its night: shown while armed or
 * applied, for COMPLETED_BANNER_MS after a revert, until the window ends for a cancel with no
 * write, and not at all once a window that never applied has passed.
 */
export function actuationBannerVisible(a: BannerActuation | null, nowMs: number): boolean {
  if (!a || a.day == null) return false;
  // v1.189.0 — a reserve someone else set settles the night like a restore: shown as long.
  if (a.foreignSettledAtMs != null) return nowMs - a.foreignSettledAtMs < COMPLETED_BANNER_MS;
  if (revertUnconfirmed(a)) return true;
  if (a.revertedAtMs != null) return nowMs - (a.revertVerifiedAtMs ?? a.revertedAtMs) < COMPLETED_BANNER_MS;
  const windowOver = a.windowEndMs != null ? nowMs > a.windowEndMs + 3_600_000 : false;
  if (a.appliedAtMs == null && windowOver) return false;
  if (a.cancelled && a.appliedAtMs == null) {
    return a.windowEndMs != null ? nowMs <= a.windowEndMs
      : a.cancelDeadlineMs != null ? nowMs - a.cancelDeadlineMs < 8 * 3_600_000 : true;
  }
  return true;
}

/** The actuation fields the banner's words read (a subset of /api/night-charge/status → actuation). */
export interface BannerTextActuation extends BannerActuation {
  targetPct: number | null;
  priorReservePct: number | null;
  /** v1.200.0 (Fix10) — the server's chargeCycle.lineStartClosedStatus: a line night whose start is closed, its words, and whether
   *  anything is left to cancel. Absent on any other night. */
  lineStartClosed?: { text: string; cancel: boolean };
  /** v1.200.0 (Fix10 review 1) — the server's chargeCycle.lineWriteUnreadStatus: a line night's write the panel has not read back.
   *  Absent on any other night. */
  lineWriteUnread?: boolean;
}

/** v1.189.0 — the banner's words, its tone and its Cancel control. */
export interface BannerState {
  text: string;
  /** Completed or cancelled: shown muted. Anything else (armed, applied, a restore not confirmed)
   *  is shown as a warning. */
  settled: boolean;
  /** The Cancel button's label; null when nothing is left to cancel. */
  cancel: string | null;
}

/**
 * v1.189.0 — the actuation banner, by the write's state, in this order: a restore the panel has
 * not confirmed (never "Completed", never muted; nothing left to cancel — the actuator is retrying
 * it), completed, cancelled, applied ("Cancel & revert"), a line night's closed start (the server's words) or armed ("Cancel tonight"). The card
 * renders the button whenever `cancel` is set, in every shape it has: a recompute that holds, an
 * incomplete basis or a stale plan does not disarm the write (writeStands), so none of them may
 * hide its Cancel. `deadline` is the cancel deadline as HH:MM, or null.
 */
export function actuationBannerState(a: BannerTextActuation, deadline: string | null, reservePct: number | null = null): BannerState {
  const prior = a.priorReservePct ?? '—';
  // v1.189.0 — first: once the reserve has settled as someone else's, nothing of ours holds it and
  // the server answers a cancel with 409, so the banner offers none ("Cancel & revert" over a
  // reserve the owner set would read as a promise to restore it).
  if (a.foreignSettledAtMs != null) {
    // v1.200.1 — a stood night names neither the app nor a write: the add-on's own floor route lands here too, and no write went.
    const text = a.reserveStandingAtMs != null
      ? `The reserve was changed to ${a.foreignReservePct ?? '—'}% after it read the night's target — no force-charge runs on it tonight.`
      : `The reserve was set to ${a.foreignReservePct ?? '—'}% outside the add-on — tonight's write no longer holds it.`;
    return { text, settled: true, cancel: null };
  }
  if (revertUnconfirmed(a)) {
    return { text: `Restore not confirmed — the panel has not reported the reserve back at ${prior}%.`, settled: false, cancel: null };
  }
  if (a.revertedAtMs != null) return { text: `Completed — reserve restored to ${prior}%.`, settled: true, cancel: null };
  if (a.cancelled) {
    const text = a.appliedAtMs != null ? 'Cancelled — the applied write reverts within a minute.'
      : a.reserveStandingAtMs != null ? CANCELLED_STOOD_TEXT : 'Cancelled — no write tonight.';
    return { text, settled: true, cancel: null };
  }
  const target = a.targetPct ?? '—';
  if (a.appliedAtMs != null) {
    // v1.200.0 (Fix10 review 1) — never "raised" on a line night's write no reading has shown: true in the apply's grace too.
    const raised = a.lineWriteUnread === true ? `Reserve write to ${target}% has not read back` : `Reserve raised to ${target}%`;
    return { text: `${raised} (was ${prior}%); auto-restores after the window closes.`, settled: false, cancel: 'Cancel & revert' };
  }
  // v1.200.0 (Fix10) — a line night whose start is closed: the server's words, never "write armed" past a window no write came of.
  if (a.lineStartClosed != null) return { text: a.lineStartClosed.text, settled: false, cancel: a.lineStartClosed.cancel ? 'Cancel tonight' : null };
  // v1.200.1 — the reserve stood at the target: no write went and nothing is restored, and the ride can be cancelled to the close.
  if (a.reserveStandingAtMs != null) return { text: `The reserve stands at ${target}%: no write and nothing to restore.`, settled: false, cancel: 'Cancel tonight' };
  // v1.200.0 (Fix9 review 2) — the panel already reads the write (decideActuation: nothing to raise): armed, and none is due while it does.
  // Cancel stays: a reading under the target lets the write go.
  if (a.targetPct != null && reservePct != null && reservePct >= a.targetPct) {
    return { text: `Supervised write armed${deadline ? ` for ${deadline}` : ''} — the reserve reads ${reservePct}%, so none is due while it does.`, settled: false, cancel: 'Cancel tonight' };
  }
  return { text: `Supervised write armed — reserve → ${target}%${deadline ? ` at ${deadline}` : ''}.`, settled: false, cancel: 'Cancel tonight' };
}

/**
 * v1.189.0 — which armed write an actuation record is: its plan date and window. A cancel the
 * server confirmed is held on the card against this key, so it applies to that write only: held
 * as a flag, a cancel made on one night showed the next night's write, on a card left open, as
 * "Cancelled", with no Cancel. null when nothing is armed.
 */
export function actuationKey(a: { day: string | null; windowStartMs?: number | null; leg?: string | null } | null): string | null {
  // v1.189.0 — and its leg: a cycle's two legs share a plan date, and a cancel of one is not a cancel
  // of the other.
  return a == null || a.day == null ? null : `${a.day}|${a.leg ?? 'cost'}|${a.windowStartMs ?? '-'}`;
}

/** v1.189.0 — the record with a cancel the server confirmed for it (actuationKey), until the
 *  status poll carries the flag itself; any other write's record is returned unchanged. */
export function withConfirmedCancel<T extends { day: string | null; windowStartMs?: number | null; cancelled: boolean }>(
  a: T | null,
  cancelledKey: string | null,
): T | null {
  return a != null && !a.cancelled && cancelledKey != null && actuationKey(a) === cancelledKey ? { ...a, cancelled: true } : a;
}

/**
 * v1.189.0 — the write the evening job armed from the ANNOUNCED plan still stands: the actuator
 * never substitutes a later recompute (nightChargeActuator.ts), so the recompute every 30 minutes
 * — which can hold once the raised reserve has charged the pool, lose its basis, or stop and leave
 * the plan stale — does not disarm it. True exactly while the banner is shown with its Cancel: a
 * write mode, armed or applied, neither cancelled nor reverted. The card then says the write
 * stands where it would say "nothing will be charged".
 */
export function writeStands(a: BannerTextActuation | null, mode: string, nowMs: number): boolean {
  return mode !== 'advisory' && a != null && actuationBannerVisible(a, nowMs) && actuationBannerState(a, null).cancel != null;
}

/**
 * v1.189.0 — the card's line when no fresh plan can be shown: the basis was incomplete, or the
 * plan is missing or older than the 12 h staleness horizon. With a write standing it says so
 * rather than "nothing will be charged" (the banner beneath carries its Cancel).
 */
export function noPlanText(basisIncomplete: boolean, stands: boolean, reserveStood = false): string {
  if (stands) {
    return `${basisIncomplete ? 'No fresh plan — forecast/telemetry basis incomplete.' : 'No fresh night-charge plan — advisor idle or plan stale.'} `
      + (reserveStood ? 'The night armed on the standing reserve can be cancelled below.' : 'The write armed with the announced plan stands; cancel it below.');
  }
  return basisIncomplete
    ? 'No plan tonight — forecast/telemetry basis incomplete; nothing will be charged.'
    : 'No night-charge plan available — advisor idle or plan stale.';
}

/**
 * v1.189.0 — the cancel request: a POST, with `{ leg }` when one is named (the server cancels the
 * cost leg when none is — with one leg, tonight's write).
 */
export function cancelRequestInit(leg: 'cost' | 'backup' | null): { method: 'POST'; headers?: Record<string, string>; body?: string } {
  return leg == null ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leg }) };
}

/** v1.200.1 — a cancel on a night whose reserve stood: no write to undo, and true whether or not a force-charge of the night is on. */
export const CANCELLED_STOOD_TEXT = "Cancelled — no reserve write to undo; any force-charge of tonight's switches off within a minute.";

/**
 * v1.189.0 — what a POST to /api/night-charge/cancel did, in the card's words. 2xx: cancelled
 * (an applied write reverts within a minute); 409: nothing was left to cancel, with the server's
 * reason; anything else failed and may be retried. `done` = a definitive answer (the button goes).
 */
export function cancelOutcome(httpStatus: number, body: unknown): { ok: boolean; done: boolean; text: string } {
  const rec = (v: unknown): Record<string, unknown> | null => (v != null && typeof v === 'object' ? v as Record<string, unknown> : null);
  const b = rec(body);
  if (httpStatus >= 200 && httpStatus < 300) {
    const applied = typeof rec(b?.actuation)?.appliedAtMs === 'number';
    const stood = typeof rec(b?.actuation)?.reserveStandingAtMs === 'number';
    return { ok: true, done: true, text: applied ? 'Cancelled — the applied write reverts within a minute.' : stood ? CANCELLED_STOOD_TEXT : 'Cancelled — no write tonight.' };
  }
  if (httpStatus === 409) {
    const why = typeof b?.error === 'string' && b.error.length > 0 && b.error.length <= 200 ? b.error : 'nothing is armed';
    return { ok: false, done: true, text: `Nothing to cancel — ${why}.` };
  }
  return { ok: false, done: false, text: `cancel failed (HTTP ${httpStatus})` };
}

/**
 * The reserve the plan will actually WRITE: the setpoint clamped to the panel's maximum (the
 * SHP2 caps backupReserveSoc at 50 — settled 2026-09-16). The card printed "reserve set to 94%"
 * from the unclamped requirement; the device would sit at 50.
 */
export function reserveWriteLabel(setpointPct: number | null, predictedPct: number | null, maxPct: number | null, reserveStands = false): string | null {
  if (setpointPct == null) return null;
  const cap = maxPct != null && maxPct > 0 ? maxPct : null;
  const rounded = Math.round(setpointPct); // the actuator writes Math.round, clamped (clampReserveTarget)
  // v1.200.1 — a plan whose reserve already reads the write (plan.lineReserveStands): no write sets it.
  const verb = reserveStands ? 'reads' : 'set to';
  if (cap != null && rounded > cap) return `reserve ${verb} ${cap}% (the panel's maximum; ${rounded}% needed)`;
  if (predictedPct != null && setpointPct > predictedPct + 0.5) return `reserve ${verb} ${rounded}%`;
  return null;
}

/** The plan fields the card's charge figures read (a subset of /api/night-charge/status → plan). */
export interface ChargeFigurePlan {
  /** The worst case the plan is SIZED on (raw). */
  buyKwh: number | null;
  /** The worst case × the realized-buy calibration (the figure the sizing line names). */
  buyKwhDebiased?: number | null;
  buyDebiasFactor?: number;
  /** v1.187.22 — what the armed write is expected to draw; absent on older plans. */
  expectedBuyKwh?: number | null;
  /** v1.187.22 — the level that write drives the pool to; absent on older plans. */
  expectedWriteLevelPct?: number | null;
  /** v1.187.22 — the window closes before that level is reached ("toward"). */
  expectedDeliverableBound?: boolean;
  /** v1.187.22 — force-charge rides the night: its expected start, null when none is expected
   *  (the night then stops at the reserve); absent otherwise. */
  expectedForceChargeStartMs?: number | null;
  setpointSocPct: number | null;
  /** v1.198.0 — the plan was sized on the provisional solar band; absent on the full basis. */
  pvBandWiden?: PvBandWidenText | null;
  /** v1.203.0 — a cushion-only plan (the server's NightChargePlan.cushionOnly); absent on every other plan. */
  cushionOnly?: CushionOnlyText | null;
  /** ★★★ v1.204.0 — the sentence the server's rationale closes with on the selected solar basis (NightChargePlan.pvBasisText): the
   *  panel-measured basis on a plan sized on it, or why the panel's readings are not used on a cushion-only plan. Shown word for
   *  word; '' or absent on every other plan. */
  pvBasisText?: string | null;
  costCeilingSocPct?: number | null;
  longGapAhead?: boolean | null;
  /** v1.202.0 — the pool and the Cores' standby the plan's walks counted (NightChargePlan.planPool); absent where neither
   *  differs from the panel's figure with no standby, and on older plans. */
  planPool?: { kwh: number; standbyW: number } | null;
}

/** v1.200.0 — the plan fields the card's outage-cushion notes read (/api/night-charge/status → plan). */
export interface CushionNotePlan {
  cushionShortfall?: boolean;
  /** The server's NightChargePlan.cushionShortfallCause: the 50% reserve envelope contributes. */
  cushionShortfallCause?: 'envelope' | 'envelope+caps';
  /** The server's NightChargePlan.cushionEnvelopeReason: why the plan does not claim the line (review; A5: armed
   *  'nearFull' / 'closeUnder', v1.205.0 'lateStart', or nothing armed 'advisory' / 'backupLeg' / 'reserveAtTarget' / 'armedNoLine' /
   *  'startClosed'). */
  cushionEnvelopeReason?: 'advisory' | 'backupLeg' | 'reserveAtTarget' | 'armedNoLine' | 'startClosed' | 'nearFull' | 'closeUnder' | 'lateStart';
  /** The server's words for 'startClosed' (NightChargePlan.cushionStartClosedWords). */
  cushionStartClosedWords?: string;
  /** v1.205.0 (review) — beside 'lateStart': the plan's own start is inside the at-open allowance (NightChargePlan.cushionLateStartAtOpen),
   *  so the row names a late switch-on at the window open; absent, the window's charge. */
  cushionLateStartAtOpen?: boolean;
  /** No verified write stands behind 'startClosed', or a partial ON runs beside it (NightChargePlan.cushionStartClosedNoWrite): the card leads with the words. */
  cushionStartClosedNoWrite?: boolean;
  /** The reserve the plan read: what 'reserveAtTarget' names. */
  reserveFloorPct?: number;
  cushionLineSocPct?: number | null;
  /** The outage line the night force-charge is armed for (A5: carried, or disclosed beside it). */
  forceChargeLine?: { askPct: number; linePct: number } | null;
  /** 'line' when the expected walk ran the line force-charge (never on a cost-dominant night). */
  expectedForceChargeMode?: 'line';
  /** The server's NightChargePlan.expectedLineCeilingStop (review 2): the expected walk reaches the panel ceiling,
   *  where the panel switches Charge Now off, and the add-on switches it back on under the start target. */
  expectedLineCeilingStop?: { ceilingPct: number; startTargetPct: number; noReOnWords?: string };
  expectedWriteLevelPct?: number | null;
  expectedForceChargeStartMs?: number | null;
  /** v1.202.0 — a line night the cost force-charge carries whose walk past its stop closes under the line, whether or not
   *  its sizing fell short: that close (NightChargePlan.expectedCloseAfterStopPct; the outage-line row names it). v1.205.0 — present
   *  beside 'lateStart' too, where it holds the line (the row reads it by lineNotHeldOfCard, so never as under). Absent otherwise. */
  expectedCloseAfterStopPct?: number;
}

/** v1.200.0 (review 2) — the server's FORCE_CHARGE_LINE_REON_MAX in words (nightForceCharge.lineReOnTimesWords): the
 *  re-ONs a line night may spend after the panel's own stop. lineForceCharge.test.ts pins the card's row against the
 *  server's rationale, so a change of the budget there shows here. */
export const LINE_REON_TIMES_TEXT = 'twice';

/** v1.200.0 — the "charge/pool caps" row: only where the plan's SIZING fell short (the server's
 *  cushionShortfall less an envelope-only cause), never on a plan whose only shortfall is the envelope. */
export function capsShortfallShown(plan: CushionNotePlan): boolean {
  return plan.cushionShortfall === true && plan.cushionShortfallCause !== 'envelope';
}

/** v1.200.0 (A5) — the server's nightChargeAdvisor.lineNotHeldOf, mirrored: what an ARMED line-mode night's own walk
 *  cannot hold — 'aboveFull' (a line above a full pool), 'closeUnder' (its expected close under the line less the
 *  scorer's 0.05, whatever the reason or cause), 'nearFull' (held, within 10 points of full) — or null. The server's
 *  lineForceChargeYear.test.ts holds the two equal on every plan of the year, and lineForceCharge.test.ts T20 at the
 *  edge: a close exactly at L − 0.05 holds (1e-9 of float slack, the server's LINE_CLOSE_EDGE_EPS: in binary 50.35 −
 *  0.05 is 50.300000000000004). v1.202.0 — and, on a night the cost force-charge carries, 'closeUnder' where its walk past
 *  the stop closes under the line (expectedCloseAfterStopPct). v1.205.0 — 'lateStart' on the server's reason, on either walk mode:
 *  held on the median walk, not with the at-open allowance (never beside a close under the line). */
export function lineNotHeldOfCard(plan: CushionNotePlan): 'closeUnder' | 'aboveFull' | 'nearFull' | 'lateStart' | null {
  if (plan.forceChargeLine == null) return null;
  const l = plan.cushionLineSocPct;
  if (l == null || !Number.isFinite(l)) return null;
  // v1.202.0 — a night the cost force-charge carries: its close past the stop, where under the line.
  if (plan.expectedForceChargeMode !== 'line') {
    const c = plan.expectedCloseAfterStopPct;
    if (plan.cushionEnvelopeReason === 'lateStart') return 'lateStart';
    return c != null && Number.isFinite(c) && c < l - 0.05 - 1e-9 ? 'closeUnder' : null;
  }
  if (l > 100) return 'aboveFull';
  const e = plan.expectedWriteLevelPct;
  if (e != null && e < l - 0.05 - 1e-9) return 'closeUnder';
  if (plan.cushionEnvelopeReason === 'lateStart') return 'lateStart';
  return plan.cushionEnvelopeReason === 'nearFull' ? 'nearFull' : null;
}

/**
 * v1.200.0 — the outage line above the panel's 50% reserve, in one row: disclosed with nothing armed ("not held
 * tonight": advisory mode, the backup leg), or the force-charge's own row (line mode only, with the expected close —
 * the level the charge figure names) — (A5) followed, on an armed night, by what its walk cannot hold
 * (lineNotHeldOfCard). v1.202.0 — a night the cost force-charge carries whose walk past its stop closes under the line
 * (lineNotHeldOfCard 'closeUnder'): that close, under the line. null otherwise, any other cost-dominant night included.
 * `maxPct` is the panel's reserve maximum (status.reserveWriteMaxPct); 50 when unknown.
 */
export function outageLineRow(plan: CushionNotePlan, maxPct: number | null = null): string | null {
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const max = maxPct ?? 50;
  // (Fix8) The server's lineAboveReserveWords (nightForceCharge.ts), mirrored: the line beside the reserve maximum and a full pool,
  // round1 or two decimals where one reads as either ("outage line 50.03% is above the 50% reserve", never "50%"); a line stated at
  // the reserve, unnumbered.
  const lineText = (l: number | null | undefined): string => {
    if (l == null || !Number.isFinite(l)) return '';
    const r = r1(l);
    // v1.203.0 — a line at or under the reserve (one in (49, 50]) beside the level the panel holds as well, as the server does.
    if (l <= max) {
      const b = r === max - 1 || r === max || r === 100 ? Math.round(l * 100) / 100 : r;
      return b > max - 1 && b < max ? `${b}% ` : '';
    }
    const n = r === max || r === 100 ? Math.round(l * 100) / 100 : r;
    return n > max ? `${n}% ` : '';
  };
  // v1.203.0 — what the line is above (the server's lineOverReserveText): the reserve, or for a line at or under it the level the
  // panel holds the pool at under it, one point below (a line in (49, 50] is the line force-charge's).
  const over = (l: number | null | undefined, form: 'reserve' | 'accepts'): string => lineOverReserveCard(l, max, form);
  const armed = plan.forceChargeLine != null;
  if (plan.cushionShortfallCause != null && !armed) {
    const l = plan.cushionLineSocPct;
    const why = plan.cushionEnvelopeReason === 'backupLeg' ? 'not held tonight (the backup leg writes the reserve only)'
      : plan.cushionEnvelopeReason === 'advisory' ? 'not held tonight (advisory mode)'
        : plan.cushionEnvelopeReason === 'reserveAtTarget' ? `not claimed tonight (the reserve reads ${plan.reserveFloorPct ?? max}%: no write while it does, no force-charge without one)`
          : plan.cushionEnvelopeReason === 'armedNoLine' ? 'not claimed tonight (no write armed for this window carries a force-charge for it)'
            : plan.cushionEnvelopeReason === 'startClosed' ? `not claimed tonight (${plan.cushionStartClosedWords ?? 'no force-charge for it starts'})` : 'not held tonight';
    return `outage line ${lineText(l)}is above ${over(l, 'accepts')} — ${why}; residual risk remains`;
  }
  // A5 — an ARMED night: the force-charge's row (what it does), then what its walk cannot hold. Never "not held tonight".
  const kind = lineNotHeldOfCard(plan);
  const notHeld = kind === 'closeUnder' ? ' — under the line; residual risk remains'
    : kind === 'aboveFull' ? ' — the line is above a full pool; residual risk remains'
      : kind === 'nearFull' ? ' — within 10 points of a full pool, not held with its usual margin; residual risk remains'
        // v1.205.0 — held on the median walk, not with the at-open allowance (a cost-carried night: the disclosed row below). (review) The
        // server's nightForceCharge.lateStartAllowanceWords, mirrored: a switch-on at the window open only where the plan's own start is
        // inside the allowance (cushionLateStartAtOpen), else the window's charge.
        : kind === 'lateStart' ? ` — too close to the line to allow for ${plan.cushionLateStartAtOpen === true ? 'a late switch-on at the window open' : "a late start of the window's charge"}; residual risk remains` : '';
  const row = outageLineArmedRow(plan, max, r1, lineText, over);
  if (row == null && armed && (plan.cushionShortfallCause != null || kind === 'closeUnder')) {
    // Never silent on a disclosed night, whatever the walk's mode. v1.202.0 — a night the cost force-charge carries whose walk
    // past its stop closes under the line (kind 'closeUnder', whether or not its sizing fell short) names that close, and the
    // stop it is armed with (its level, expectedWriteLevelPct: reached or not, the stop is what the charge figure names); any
    // other armed, disclosed night says the line is not claimed.
    const l = plan.cushionLineSocPct;
    const c = plan.expectedCloseAfterStopPct;
    if (kind === 'closeUnder' && c != null && Number.isFinite(c)) {
      const stop = plan.expectedWriteLevelPct;
      const stopText = stop != null && Number.isFinite(stop) ? ` (the cost force-charge's stop is ~${r1(stop)}%)` : '';
      return `outage line ${lineText(l)}is above ${over(l, 'accepts')} — ~${r1(c)}% expected at the close, under the line${stopText}; residual risk remains`;
    }
    return `outage line ${lineText(l)}is above ${over(l, 'accepts')} — its force-charge runs, but the line is not claimed; residual risk remains`;
  }
  return row == null ? null : `${row}${notHeld}`;
}

/** v1.203.0 — the server's lineOverReserveText (nightForceCharge.ts), mirrored: what an outage line is above. A line above the
 *  reserve maximum: the reserve, as before. One at or under it (a line in (49, 50], which the line force-charge carries because
 *  the panel holds the pool one point under a reserve it charged up to): the level it holds, one point under the maximum. */
export function lineOverReserveCard(linePct: number | null | undefined, max: number, form: 'reserve' | 'accepts'): string {
  if (linePct == null || !Number.isFinite(linePct) || linePct > max) return form === 'reserve' ? `the ${max}% reserve` : `the ${max}% the panel accepts as a reserve`;
  return form === 'accepts' ? `the ${max - 1}% the panel holds the pool at under the ${max}% it accepts as a reserve`
    : `the ${max - 1}% the panel holds the pool at under a ${max}% reserve`;
}

/** v1.200.0 (Fix10 review 1) — the card's lead on a closed start no write stands behind: the plan's expected figures and the write's
 *  level are the reserve-alone figures of a write nothing holds, so "reserve held as a floor" or "expected charge to ~50%" would state
 *  what will not happen, above the banner that says why. A write that stands keeps its figure, which is true. (Fix12) Not on 'partTaken':
 *  its write stands, and "no charge expected" is false while two slots charge. null otherwise. */
export function startClosedLead(plan: CushionNotePlan): { headline: string; detail: string } | null {
  if (plan.cushionEnvelopeReason !== 'startClosed' || plan.cushionStartClosedNoWrite !== true) return null;
  const words = plan.cushionStartClosedWords ?? 'no force-charge for it starts';
  return { headline: 'The outage line is not claimed tonight', detail: `${words.charAt(0).toUpperCase()}${words.slice(1)}.` };
}

/** v1.200.0 — the armed line force-charge's own row (outageLineRow): line mode only. */
function outageLineArmedRow(
  plan: CushionNotePlan, max: number, r1: (n: number) => number, lineText: (l: number) => string,
  over: (l: number, form: 'reserve' | 'accepts') => string,
): string | null {
  if (plan.expectedForceChargeMode === 'line' && plan.forceChargeLine != null) {
    // v1.200.0 (review) — armed but not expected to start (the pool stays at or above the panel ceiling):
    // never "stays on to the window close" for a force-charge that does not switch on.
    if (plan.expectedForceChargeStartMs === null) {
      return `outage line ${lineText(plan.forceChargeLine.linePct)}is above ${over(plan.forceChargeLine.linePct, 'reserve')} — the panel's force-charge is armed for it, not expected to start (the pool stays at or above its ceiling)`;
    }
    const lvl = plan.expectedWriteLevelPct;
    const tail = lvl != null && Number.isFinite(lvl) && plan.expectedForceChargeStartMs != null ? `, ~${r1(lvl)}% expected at the close` : '';
    // v1.200.0 (review 2) — a walk that reaches the panel ceiling: the panel switches Charge Now off there, and the
    // add-on switches it back on under the start target before the close. Never "stays on to the window close".
    const stop = plan.expectedLineCeilingStop;
    if (stop != null) {
      return `outage line ${lineText(plan.forceChargeLine.linePct)}is above ${over(plan.forceChargeLine.linePct, 'reserve')} — the panel's force-charge runs until the panel `
        + `switches it off at its ${stop.ceilingPct}% ceiling, and ${stop.noReOnWords ?? `the add-on switches it back on under ${stop.startTargetPct}% before the close (at most ${LINE_REON_TIMES_TEXT})`}${tail}`;
    }
    return `outage line ${lineText(plan.forceChargeLine.linePct)}is above ${over(plan.forceChargeLine.linePct, 'reserve')} — the panel's force-charge stays on to the window close${tail}`;
  }
  return null;
}

/** v1.198.0 — the server's PvBandWiden (nightChargeAdvisor.ts): how far a provisional plan's P10 PV
 *  was widened. */
export interface PvBandWidenText {
  factor: number;
  calScoredDays: number;
  fullCalScoredDays: number;
  bandP10Kwh: number;
  widenedP10Kwh: number;
  rollupHalfFrac: number;
}

/** v1.198.0 — the server's provisionalBandText (nightChargeAdvisor.ts), word for word: the plan was
 *  sized on the PROVISIONAL solar band, and how far its P10 PV was widened. '' on the full basis. */
export function provisionalBandText(w: PvBandWidenText | null | undefined): string {
  if (w == null) return '';
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  return ` PROVISIONAL SOLAR BAND: ${w.calScoredDays} of ${w.fullCalScoredDays} calibration days scored, so the P10 PV this plan is sized on`
    + ` is widened ×${w.factor.toFixed(2)} (the next 24 h: ~${r1(w.bandP10Kwh)} → ~${r1(w.widenedP10Kwh)} kWh)`
    + ` and the multi-day carry by ±${Math.round(w.rollupHalfFrac * 100)}% per √day; the full band returns at ${w.fullCalScoredDays} scored days.`;
}

/** ★★★ v1.203.0 — the server's CushionOnlyBasis (nightChargeAdvisor.ts): a plan sized with the solar basis refused, on the outage
 *  cushion at the window close alone. */
export interface CushionOnlyText {
  refusedBy: string;
  transient?: boolean;
  gapAfterMs: number | null;
  longGapAfter: boolean;
  poolFloorScale?: number;
}

/** v1.203.0 — the server's gapAfterWindowText, mirrored word for word. */
export function gapAfterWindowCardText(gapAfterMs: number | null): string {
  return gapAfterMs == null
    ? 'no further charge window is found within the tariff scan after this one'
    : `the next charge window opens ~${Math.round(gapAfterMs / 3_600_000)} h after this one closes`;
}

/** v1.203.0 — the server's cushionOnlyFills (nightChargeAdvisor.ts), mirrored: a cushion-only plan on the long-gap fill (cost mode,
 *  before a gap of more than a day after its window), sized on the cushion and the fill, so never called "cushion only". */
export function cushionOnlyFillsCard(
  co: Pick<CushionOnlyText, 'longGapAfter'>,
  plan: { costCeilingSocPct?: number | null; longGapAhead?: boolean | null },
): boolean {
  return co.longGapAfter && plan.longGapAhead === true && plan.costCeilingSocPct != null;
}

/** v1.203.0 — the card's Basis stat on a cushion-only plan (in place of the confidence tier): the cushion only, or on the long-gap
 *  fill the cushion and the fill. */
export function cushionOnlyBasisValue(
  co: Pick<CushionOnlyText, 'longGapAfter'>,
  plan: { costCeilingSocPct?: number | null; longGapAhead?: boolean | null },
): string {
  return cushionOnlyFillsCard(co, plan) ? 'cushion + long-gap fill' : 'cushion only';
}

/** ★★★ v1.203.0 — the server's cushionOnlyText (nightChargeAdvisor.ts), mirrored word for word: a cushion-only plan's disclosure. ''
 *  on every other plan. */
export function cushionOnlyCardText(
  co: CushionOnlyText | null | undefined,
  plan: { costCeilingSocPct?: number | null; longGapAhead?: boolean | null },
): string {
  if (co == null) return '';
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const costFill = cushionOnlyFillsCard(co, plan);
  const head = costFill
    ? ` NO SOLAR BASIS; THE OUTAGE CUSHION AND THE LONG-GAP FILL: the solar basis is refused (${co.refusedBy}), so this plan is sized only on the outage cushion at the window close and, before the gap, the long-gap fill — no solar is credited, no solar calibration is used, and no mid-day charge is planned.`
    : ` OUTAGE CUSHION ONLY; NO SOLAR BASIS: the solar basis is refused (${co.refusedBy}), so this plan is sized only to hold the outage cushion at the window close — no solar is credited, no solar calibration is used, and no cost target or mid-day charge is planned.`;
  const g = gapAfterWindowCardText(co.gapAfterMs);
  const gap = !co.longGapAfter ? ''
    : costFill
      ? ` Before the gap (${g}) tonight's cost target is the long-gap fill: the ${r1(plan.costCeilingSocPct!)}% state-of-charge ceiling, with the solar headroom set aside.`
      : ` ${g.charAt(0).toUpperCase()}${g.slice(1)}; the cushion is sized for this window's close only, and no long-gap fill runs in resilience mode.`;
  const floor = co.poolFloorScale != null ? ` The pool is counted on the capacity floor, ×${co.poolFloorScale.toFixed(2)} of nameplate: no pack capacity ratio is known.` : '';
  return `${head}${gap}${floor}`;
}

/** v1.187.22 — below this an expected draw is NO charge (the server's NO_CHARGE_EXPECTED_KWH,
 *  nightChargeActuator.ts): what the card would show as "0.0 kWh". */
export const NO_CHARGE_EXPECTED_KWH = 0.05;

/** v1.187.22 — tonight's write is expected to charge nothing (the server's noChargeExpected): an
 *  expected figure under NO_CHARGE_EXPECTED_KWH. false with no expected figure. */
export function noChargeExpected(plan: { expectedBuyKwh?: number | null }): boolean {
  const exp = plan.expectedBuyKwh;
  return exp != null && Number.isFinite(exp) && exp < NO_CHARGE_EXPECTED_KWH;
}

/** v1.187.22 — the reserve the write sets, % (the server's chargeReservePct): the setpoint,
 *  rounded, at most the panel's maximum. null with no setpoint. */
export function writtenReservePct(plan: { setpointSocPct: number | null }, maxPct: number | null): number | null {
  const set = plan.setpointSocPct;
  const cap = maxPct != null && maxPct > 0 ? maxPct : Infinity;
  return set != null && Number.isFinite(set) ? Math.min(Math.round(set), cap) : null;
}

/**
 * v1.187.22 — the card's headline: the CHARGE the write arms. With an expected figure the big
 * number is that draw ("34.9 kWh — expected charge to ~80%"); without one the big number is the
 * level and no kWh is shown. The level is the plan's expectedWriteLevelPct (the reserve as written,
 * or the force-charge stop when force-charge rides the night), else — a plan issued before it —
 * the setpoint as written (rounded, at most the panel's maximum) — and, on a force-charge night with
 * no just-in-time start expected (expectedForceChargeStartMs null), the reserve: the level the night
 * is expected to reach. Never the worst case: that is
 * sizingLine's. Mirrors the server's chargeLevelPct / statedBuyKwh (nightChargeAdvisor.ts), and says
 * "toward" the level when the window closes before it is reached (chargeIsWindowBound): Friday's
 * one-hour window from ~48% passes ~14 kWh, ~62%, not the 80% it charges toward.
 * A night expected to charge nothing (the server's noChargeExpected: the pool is expected to stay
 * at or above the level) shows the reserve the write holds — "50% reserve held as a floor — no
 * charge expected" — never "0.0 kWh expected charge to ~50%".
 */
export function chargeFigureParts(
  plan: ChargeFigurePlan,
  maxPct: number | null,
): { main: string; unit: string; label: string } {
  const lvl = plan.expectedWriteLevelPct;
  const written = writtenReservePct(plan, maxPct);
  const level = lvl != null && Number.isFinite(lvl)
    ? (plan.expectedForceChargeStartMs === null && written != null ? written : lvl)
    : written;
  const levelText = level == null ? '—' : `${Math.round(level * 10) / 10}`;
  const exp = plan.expectedBuyKwh;
  if (exp == null || !Number.isFinite(exp)) return { main: levelText, unit: '%', label: 'charge target' };
  if (noChargeExpected(plan)) {
    // The reserve as written (the server's chargeReservePct): the setpoint, rounded, at most the maximum.
    return { main: written == null ? '—' : `${written}`, unit: '%', label: 'reserve held as a floor — no charge expected' };
  }
  const to = plan.expectedDeliverableBound === true ? 'toward' : 'to';
  return { main: exp.toFixed(1), unit: 'kWh', label: `expected charge ${to} ~${levelText}%` };
}

/**
 * v1.187.22 — the ONE line on the card that names the worst case, labelled as the basis the plan
 * is sized on, with the realized-buy calibration beside the figure it multiplies — the server's
 * sizingBasisText wording (nightChargeAdvisor.ts). null with no figure.
 */
export function sizingLine(plan: ChargeFigurePlan): string | null {
  const factor = plan.buyDebiasFactor ?? 1;
  const deb = plan.buyKwhDebiased;
  const worst = deb != null && Number.isFinite(deb) ? deb : plan.buyKwh;
  if (worst == null || !Number.isFinite(worst)) return null;
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const cal = factor > 1.005 && plan.buyKwh != null && Number.isFinite(plan.buyKwh)
    ? ` (raw estimate ${r1(plan.buyKwh)} kWh × ${factor.toFixed(2)} realized-buy calibration)` : '';
  // v1.198.0 — and, on a provisional plan, the widened P10 it was sized on. v1.202.0 — and the Cores' standby where the walks
  // drained it (the server's sizingBasisText).
  const sb = plan.planPool?.standbyW;
  const standby = sb != null && Number.isFinite(sb) && sb > 0 ? ` and the Cores' ~${Math.round(sb)} W standby` : '';
  // v1.203.0 — a cushion-only plan credits no solar: "no PV" (the server's NO_PV_WORST_CASE_BASIS), and its disclosure.
  const pv = plan.cushionOnly != null ? 'no PV' : 'P10 PV';
  return `Sized on an islanded worst case (${pv}, P90 load including any committed EV session${standby}, no grid) of ~${r1(worst)} kWh${cal}.`
    + provisionalBandText(plan.pvBandWiden) + cushionOnlyCardText(plan.cushionOnly, plan) + (plan.pvBasisText ?? '');
}

/** The plan fields the card's HOLD summary reads (a subset of /api/night-charge/status → plan). */
export interface HoldSummaryPlan {
  /** 0 when the cushion holds with no charge; > 0 when a need was sized; null with no sizing. */
  requiredExtraKwh: number | null;
  cushionShortfall: boolean;
  /** v1.186.0 — the trough the cushion test judged and its line (absent on older plans). */
  cushionTroughSocPct?: number | null;
  cushionLineSocPct?: number | null;
  cushionBasis?: string | null;
  minProjSocPct: number | null;
  baselineMinSocPct: number | null;
  reserveFloorPct: number;
  cushionPct: number;
  /** v1.198.0 — the hold was sized on the provisional solar band; absent on the full basis. */
  pvBandWiden?: PvBandWidenText | null;
  /** v1.203.0 — a cushion-only hold (the server's NightChargePlan.cushionOnly); absent on every other plan. */
  cushionOnly?: CushionOnlyText | null;
  /** ★★★ v1.204.0 — the server's closing sentence on the selected solar basis (NightChargePlan.pvBasisText), word for word. */
  pvBasisText?: string | null;
  costCeilingSocPct?: number | null;
  longGapAhead?: boolean | null;
}

/**
 * v1.187.22 — WHICH hold tonight is, on the figure it was decided on — the evening push's hold
 * shape (buildNightChargeMessage, server/src/notify.ts) in the card's words. The card said
 * "Projected overnight trough 0% stays at/above the 31% floor+cushion" on every hold: the
 * whole-house island trough, unlabelled, not the trough the cushion test judged, and on a night
 * whose window cannot cover the cushion it still said "No overnight charge needed."
 *  - the cushion holds: the trough it was judged on (the pack at window close; the whole-house
 *    low on the legacy-pct basis), labelled as the islanded case it is;
 *  - a need under the minimum buy;
 *  - the window cannot cover the cushion: said, with the residual risk (tone 'warn');
 *  - no sizing (no window resolved).
 * v1.189.0 — `writeStands`: the hold is a later recompute's and the write armed from the announced
 * plan still stands (writeStands), so the hold leads with that, each shape says what the
 * recompute would do instead of "nothing will be charged", and the tone is 'warn'.
 * v1.198.0 — a sized hold on the provisional solar band (pvBandWiden) closes its detail with
 * provisionalBandText, as the hold push does; before the write-stands note when one stands.
 */
export function holdSummary(
  plan: HoldSummaryPlan,
  o: { writeStands?: boolean; reserveStood?: boolean } = {},
): { headline: string; detail: string; tone: 'ok' | 'warn' | 'muted' } {
  const stands = o.writeStands === true;
  const hold = holdVerdict(plan, stands ? 'the latest recompute would charge nothing' : 'nothing will be charged');
  if (stands && o.reserveStood === true) return { headline: RESERVE_STOOD_HEADLINE, detail: `${hold.detail} ${RESERVE_STOOD_NOTE}`, tone: 'warn' };
  return stands ? { headline: WRITE_STANDS_HEADLINE, detail: `${hold.detail} ${WRITE_STANDS_NOTE}`, tone: 'warn' } : hold;
}

/** v1.189.0 — the hold shape's headline while a write armed from the announced plan stands
 *  (writeStands): the recompute shown holds, the write does not. */
export const WRITE_STANDS_HEADLINE = 'The latest recompute would not charge — the armed write stands.';
/** v1.189.0 — appended to the hold's detail while a write stands; the banner beneath carries its Cancel. */
export const WRITE_STANDS_NOTE = 'A recompute never replaces the write armed with the announced plan; cancel it below.';
/** v1.200.1 — the same on a night whose reserve stood: no write stands, the night armed on it does. */
export const RESERVE_STOOD_HEADLINE = 'The latest recompute would not charge — the night armed on the standing reserve stands.';
export const RESERVE_STOOD_NOTE = 'A recompute never replaces the night armed with the announced plan; cancel it below.';

/** The hold's verdict; `none` closes each shape: "nothing will be charged", or what the latest
 *  recompute would do while a write stands. */
function holdVerdict(plan: HoldSummaryPlan, none: string): { headline: string; detail: string; tone: 'ok' | 'warn' | 'muted' } {
  const pct = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 10) / 10}%`);
  if (plan.requiredExtraKwh == null) {
    return { headline: 'No overnight charge tonight.', detail: `No cheap charge window was resolved — ${none}.`, tone: 'muted' };
  }
  // v1.198.0 — a hold SIZED on the provisional solar band closes its detail with the sentence the
  // push closes it with ('' on the full basis); a hold with no window, above, was sized on nothing.
  const provisionalDetail = provisionalBandText(plan.pvBandWiden) + cushionOnlyCardText(plan.cushionOnly, plan) + (plan.pvBasisText ?? '');
  if (plan.cushionShortfall) {
    return {
      headline: 'No overnight charge tonight — the window cannot cover the cushion.',
      detail: 'The outage cushion needs a charge, but this window cannot deliver enough to clear the minimum buy, '
        + `so ${none}. Charge/pool limits prevent meeting the cushion — residual risk remains.${provisionalDetail}`,
      tone: 'warn',
    };
  }
  if (plan.requiredExtraKwh > 0) {
    return {
      headline: 'No overnight charge tonight.',
      detail: `The islanded worst case the plan is sized on needs only a small top-up, under the minimum buy, so ${none}.${provisionalDetail}`,
      tone: 'ok',
    };
  }
  const trough = plan.cushionTroughSocPct ?? plan.minProjSocPct ?? plan.baselineMinSocPct;
  const line = floorCushionLinePct(plan);
  const wholeHouse = plan.cushionBasis === 'legacy-pct' || plan.cushionTroughSocPct == null;
  return {
    headline: 'No overnight charge needed.',
    detail: `Even if the grid were lost overnight, ${wholeHouse
      ? `the whole-house low would stay at ~${pct(trough)}`
      : `the pack would close the charge window at ~${pct(trough)}`}, at or above the ${pct(line)} floor+cushion line — ${none}.${provisionalDetail}`,
    tone: 'ok',
  };
}

/** The plan fields the floor+cushion line reads. */
export interface FloorCushionPlan {
  cushionLineSocPct?: number | null;
  reserveFloorPct: number;
  cushionPct: number;
}

/**
 * v1.187.22 — the floor+cushion line the card states, %: the line the plan is SIZED on
 * (cushionLineSocPct — the reserve floor plus the cushion as applied), the server's
 * floorCushionLinePct (nightChargeAdvisor.ts). The hold summary stated it while the
 * "Island low, with charge" stat stated reserveFloorPct + cushionPct, the legacy flat band; that
 * sum stands in only on a plan issued before v1.186.0. null when neither is finite.
 */
export function floorCushionLinePct(plan: FloorCushionPlan): number | null {
  const line = plan.cushionLineSocPct;
  if (line != null && Number.isFinite(line)) return line;
  const legacy = plan.reserveFloorPct + plan.cushionPct;
  return Number.isFinite(legacy) ? legacy : null;
}

/** v1.187.22 — a percentage as the card and the push state it: one decimal. */
export function fmtLinePct(n: number | null): string {
  return n == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 10) / 10}%`;
}

/**
 * v1.187.22 — the card's lead on a night a supervised or auto mode REFUSED to arm (the status
 * route's armRefusal, servedArmRefusal — a refusal, or a write no announcement channel delivered):
 * the evening push says "planned charge NOT armed tonight", and the card led with the plan's
 * expected charge ("34.9 kWh — expected charge to ~80%") for a write nothing would make. It leads
 * with the refusal and its reason, and states no level or kWh — for the night the plan is (the
 * push's words): a charge, or, on a night expected to charge nothing (`held`), the reserve held as
 * a floor. "the write" in auto mode, "the supervised write" otherwise.
 */
export function refusedArmLead(
  reason: string,
  o: { mode?: string; held?: boolean; reservePct?: number | null } = {},
): { headline: string; detail: string } {
  const write = o.mode === 'auto' ? 'the write' : 'the supervised write';
  if (o.held) {
    const reserve = o.reservePct != null && Number.isFinite(o.reservePct) ? `${o.reservePct}%` : '—';
    return {
      headline: `Planned reserve hold not armed tonight — ${reason}.`,
      detail: `Tonight's plan holds the backup reserve at ${reserve} overnight as a floor, with no charge expected, but ${write} `
        + 'was not armed. The add-on will not raise the reserve tonight.',
    };
  }
  return {
    headline: `Planned charge not armed tonight — ${reason}.`,
    detail: `Tonight's plan calls for a charge, but ${write} was not armed. The add-on will not charge tonight.`,
  };
}

/* ── v1.189.0 (R4) — the winter mid-day cycle in shadow ─────────────────────────────────── */

/** One leg of the mid-day cycle as /api/night-charge/status → middayShadow serves it. */
export interface MiddayShadowLeg {
  role: 'backup' | 'cost';
  windowStartMs: number;
  windowEndMs: number;
  basisComplete: boolean;
  chargeTonight: boolean;
  reservePct: number | null;
  levelPct: number | null;
  buyKwh: number | null;
  expectedBuyKwh: number | null;
  wouldArm: boolean;
  disposition: string;
}

/** The mid-day cycle computed in shadow (server: middayShadow.ts MiddayShadowRecord). */
export interface MiddayShadowStatus {
  day: string;
  backup: MiddayShadowLeg | null;
  cost: MiddayShadowLeg | null;
  refresh: {
    atMs: number;
    disposition: string;
    levelPct: number | null;
    reservePct: number | null;
    expectedBuyKwh: number | null;
    reason: string;
  } | null;
}

/** v1.189.0 (R5) — what the 21:30 notice would have pushed and spoken for the shadow's cycle
 *  (/api/night-charge/status → middayShadowPreview; server: middayShadow.middayShadowPreview). It
 *  was never sent. */
export interface MiddayShadowPreviewStatus {
  push: { title: string; body: string };
  spoken: { en: string; es: string } | null;
  spokenChars: number | null;
}

/** The section's closing words: what the shadow is, and that it has no control. */
export const MIDDAY_SHADOW_NOTE =
  'Shadow only: computed to judge the mid-day charge before it is switched on. Nothing is armed, written or announced for it, and there is nothing to cancel.';

const fmtKwh = (v: number | null): string | null => (v == null || !Number.isFinite(v) ? null
  : v < NO_CHARGE_EXPECTED_KWH ? 'no charge expected' : `~${Math.round(v * 10) / 10} kWh expected`);
const fmtPct = (v: number | null): string => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 10) / 10}%`);

/**
 * v1.189.0 (R4) — the card's read-only section for the winter mid-day cycle computed in shadow: the
 * outage backup, the 10:00–15:00 charge and its morning refresh, each with what it would do and
 * whether it would arm. null with no mid-day leg (a weekend, summer, a configuration that asks for
 * none): the card then shows nothing. `hhmm` formats an instant as the card's other times. PURE.
 */
export function middayShadowView(
  s: MiddayShadowStatus | null | undefined,
  hhmm: (ms: number) => string | null,
  /** R5 — the evening notice it would have sent; its title closes the lines ("not sent"). */
  preview?: MiddayShadowPreviewStatus | null,
): { title: string; lines: string[]; note: string } | null {
  if (s == null || s.cost == null) return null;
  const span = (l: MiddayShadowLeg): string => `${hhmm(l.windowStartMs) ?? '—'}–${hhmm(l.windowEndMs) ?? '—'}`;
  const lines: string[] = [];
  const b = s.backup;
  if (b != null) {
    const what = !b.basisComplete ? 'not sized (incomplete basis)'
      : b.chargeTonight ? [`reserve held at ${fmtPct(b.reservePct)}`, fmtKwh(b.expectedBuyKwh)].filter(Boolean).join(', ')
        : 'not needed — the pool holds the line without it';
    lines.push(`Outage backup ${span(b)}: ${what} · ${b.disposition}`);
  }
  const c = s.cost;
  const cWhat = !c.basisComplete ? 'not sized (incomplete basis)'
    : c.chargeTonight ? [`to ~${fmtPct(c.levelPct)}`, fmtKwh(c.expectedBuyKwh), `reserve ${fmtPct(c.reservePct)} from the open`].filter(Boolean).join(', ')
      : 'no charge needed';
  lines.push(`Mid-day charge ${span(c)}: ${cWhat} · ${c.disposition}`);
  const r = s.refresh;
  if (r != null) {
    // 'not-comparable': the live overnight charge wrote to the panel, so no re-sized figures exist.
    const fig = r.disposition === 'cancelled' ? 'cancelled'
      : r.disposition === 'not-comparable' ? 'not comparable'
        : [r.disposition, `~${fmtPct(r.levelPct)}`, fmtKwh(r.expectedBuyKwh)].filter(Boolean).join(', ');
    lines.push(`Morning refresh ${hhmm(r.atMs) ?? '—'}: ${fig} — ${r.reason}`);
  } else if (c.basisComplete && c.chargeTonight) {
    lines.push(`Morning refresh: due 30 minutes before ${hhmm(c.windowStartMs) ?? 'the open'}`);
  }
  if (preview?.push?.title) lines.push(`Its evening notice would read (not sent): “${preview.push.title}”`);
  return { title: 'Mid-day charge (shadow)', lines, note: MIDDAY_SHADOW_NOTE };
}

/**
 * ★★★ v1.204.0 — the card's Basis stat on the selected solar basis: on a plan sized on the panel-measured band 'panel solar' (every
 * connected slot on the panel's readings) or 'Cores + panel solar' (mixed), its sub the 7-day energy balance against its threshold;
 * on a cushion-only plan whose panel basis was refused, the cushion-only value with "panel solar refused" in the sub. Null where the
 * plan carries neither (the card shows what it showed in v1.203.0). PURE.
 */
export function panelBasisStat(plan: {
  pvBasis?: 'panel' | 'mixed' | null;
  pvBasisChecks?: { ratio: number | null; threshold: number } | null;
  pvBasisRefusedBy?: { code: string } | null;
  cushionOnly?: unknown;
}): { value: string | null; sub: string } | null {
  if (plan.pvBasis === 'panel' || plan.pvBasis === 'mixed') {
    const c = plan.pvBasisChecks;
    return {
      value: plan.pvBasis === 'panel' ? 'panel solar' : 'Cores + panel solar',
      sub: c?.ratio != null ? `balance ${c.ratio.toFixed(4)} ≤ ${c.threshold.toFixed(2)}` : 'panel solar',
    };
  }
  if (plan.cushionOnly != null && plan.pvBasisRefusedBy != null) return { value: null, sub: 'no solar basis · panel solar refused' };
  return null;
}
