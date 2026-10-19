/**
 * chargeAnnounce.ts — which words a charge cycle gets (plan §5, R5). PURE.
 *
 * The overnight cycle's words are notify.ts's and nightChargeActuator.ts's, built exactly as the
 * evening job, the restore and the revert-deadline page build them; a winter mid-day cycle's are
 * chargeText.ts's. The route is the leg's window kind (its resolved window: the tariff's super
 * off-peak or overnight run), so an overnight-only cycle — every cycle the add-on arms until the
 * mid-day switch — reaches only the overnight builders, with the arguments it always had: the
 * golden test (overnightTextGolden.test.ts) holds every overnight shape byte-identical through
 * this route.
 *
 * Until the switch (R6) the mid-day route is reached by the shadow's preview (middayShadow.ts:
 * logged, shown on the card, never sent) and by the restore and revert-deadline paths of a super
 * off-peak leg (index.ts branches on isMiddayLeg ahead of the overnight calls, which stay as they
 * were), and nothing arms a super off-peak leg. The evening job's own two calls are the overnight
 * route of eveningAnnouncement, argument for argument; the mid-day switch moves the evening job onto
 * it.
 */
import { buildNightChargeMessage, type NotifyMessage } from './notify.js';
import { nightChargeSpokenNotice, type NightChargeMode, type RevertResendOnReport } from './nightChargeActuator.js';
import { chargeIsWindowBound, chargeLevelPct, statedBuyKwh, type NightChargePlan } from './nightChargeAdvisor.js';
import {
  buildMiddayPlanMessage, middaySpokenNotice,
  type MiddayAnnounceInput, type MiddayRevertDeadlineText, type MiddaySummaryText,
} from './chargeText.js';
import type { ChargeWindowKind } from './chargeWindows.js';

/** A leg is a winter mid-day leg when it charges in the super off-peak window. A record from before
 *  the cycle record names no window: it is the overnight leg. PURE. */
export function isMiddayLeg(s: { windowKind?: ChargeWindowKind | null }): boolean {
  return s.windowKind === 'super_off_peak';
}

/** The evening job's supervised context (index.ts supervisedCtx). */
export interface OvernightSupervisedCtx {
  cancelDeadlineText: string;
  cancelDeadlineTextEs: string;
  targetPct: number;
  forceChargeTargetPct?: number | null;
}

/** What the evening announces: an overnight cycle's inputs, or a mid-day cycle's. */
export type EveningAnnounceInput =
  | {
    cycle: 'overnight';
    plan: NightChargePlan | null;
    shape: 'charge' | 'hold' | 'insufficient_basis';
    supervised: OvernightSupervisedCtx | null;
    armRefused: string | null;
    mode: NightChargeMode;
  }
  | { cycle: 'midday'; midday: MiddayAnnounceInput };

/**
 * The evening's push and spoken notice (null: nothing is spoken). PURE.
 *  - overnight: buildNightChargeMessage(plan, shape, supervised, armRefused, mode), and — when a
 *    write is armed — nightChargeSpokenNotice on the level the write drives to, the armed reserve,
 *    the expected draw, "toward" and the cushion clause: the evening job's two calls, argument for
 *    argument;
 *  - midday: chargeText's push and spoken notice.
 */
export function eveningAnnouncement(i: EveningAnnounceInput): { push: NotifyMessage; spoken: { en: string; es: string } | null } {
  if (i.cycle === 'midday') {
    return { push: buildMiddayPlanMessage(i.midday), spoken: middaySpokenNotice(i.midday) };
  }
  const { plan, shape, supervised, armRefused, mode } = i;
  const push = buildNightChargeMessage(plan, shape, supervised, armRefused, mode);
  if (!supervised || !plan) return { push, spoken: null };
  return {
    push,
    spoken: nightChargeSpokenNotice({
      levelPct: chargeLevelPct(plan) ?? supervised.targetPct,
      reservePct: supervised.targetPct,
      expectedKwh: statedBuyKwh(plan),
      toward: chargeIsWindowBound(plan),
      deadlineText: supervised.cancelDeadlineText,
      deadlineTextEs: supervised.cancelDeadlineTextEs,
      cushionShortfall: plan.cushionShortfall === true,
    }),
  };
}

/**
 * The mid-day summary's inputs from a leg's record at its restore (index.ts's revert branch sends
 * it for a mid-day leg in place of the overnight summary). PURE.
 */
export function middaySummaryFromLeg(
  leg: {
    windowStartMs: number | null; windowEndMs: number | null; targetPct: number | null;
    forceChargeOffAtMs: number | null; forceChargeOffReason: string | null;
  },
  o: {
    restorePct: number; restoredAtMs: number; expectedKwh: number | null;
    forceCharge: MiddaySummaryText['forceCharge']; onPeak: MiddaySummaryText['onPeak'];
    ended: MiddaySummaryText['ended'];
    /** v1.189.0 (review) — the restore read back, or was only sent and acknowledged. */
    restore?: MiddaySummaryText['restore'];
  },
): MiddaySummaryText {
  return {
    windowStartMs: leg.windowStartMs ?? o.restoredAtMs,
    windowEndMs: leg.windowEndMs ?? o.restoredAtMs,
    targetPct: leg.targetPct,
    restorePct: o.restorePct,
    restoredAtMs: o.restoredAtMs,
    expectedKwh: o.expectedKwh,
    forceCharge: o.forceCharge,
    forceChargeOffAtMs: leg.forceChargeOffAtMs,
    forceChargeOffReason: leg.forceChargeOffReason,
    onPeak: o.onPeak,
    ended: o.ended,
    restore: o.restore ?? 'readBack',
  };
}

/**
 * The mid-day revert-deadline page's inputs from a leg's record (index.ts's pageRevertDeadline
 * says it for a mid-day leg in place of the overnight page). Charge Now is named when it was
 * switched on and its OFF has not read back. PURE.
 */
export function middayRevertDeadlineFromLeg(
  leg: {
    windowStartMs: number | null; windowEndMs: number | null; nextOnPeakStartMs?: number | null;
    forceChargeOnAtMs: number | null; forceChargeOffVerifiedAtMs: number | null;
  },
  o: {
    stage: 'deadline' | 'onPeak'; unknown: boolean; targetPct: number; restorePct: number | null; nowMs: number; retrying: boolean;
    resendOnReport?: RevertResendOnReport | null;
  },
): MiddayRevertDeadlineText {
  return {
    windowStartMs: leg.windowStartMs ?? o.nowMs,
    windowEndMs: leg.windowEndMs ?? o.nowMs,
    stage: o.stage,
    unknown: o.unknown,
    targetPct: o.targetPct,
    restorePct: o.restorePct,
    onPeakStartMs: leg.nextOnPeakStartMs ?? null,
    forceChargeOffOpen: leg.forceChargeOnAtMs != null && leg.forceChargeOffVerifiedAtMs == null,
    retrying: o.retrying,
    resendOnReport: o.resendOnReport ?? null,
  };
}
