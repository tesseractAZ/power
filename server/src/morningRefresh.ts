/**
 * morningRefresh.ts — the live morning refresh of an armed winter mid-day cost leg (plan §3.4, R5).
 * PURE: the clock, the cycle and the re-sized plan are arguments; index.ts owns the planner call,
 * the persist and the push.
 *
 * WHAT IT DOES. From 30 to 5 minutes before the leg's window opens, the leg is re-planned on the
 * latest solar forecast (the worker asked for weather at most REFRESH_MAX_WEATHER_AGE_MS old) and a
 * fresh panel. The level the evening ANNOUNCED is the consent ceiling: the refresh may lower the
 * written reserve and the force-charge stop, or cancel the leg, and never raise either
 * (middayShadow.refreshLeg, the rule the shadow already records). It runs once per leg — stamped
 * `refreshedAtMs` before anything is pushed — and it never re-arms (armFromPlan would erase a
 * cancel). At 5 minutes before the open with no refresh made, the evening's arm stands. It pushes,
 * never speaks, on a cancel, a changed written value, a cap, or an expected-kWh move above 25%.
 *
 * INERT UNTIL THE SWITCH. liveRefreshDue finds a leg only when the cycle's ACTIVE leg is a super
 * off-peak COST leg, and nothing arms one before the mid-day switch (R6): every overnight leg, of
 * every shape, is refused here first.
 */
import { refreshLeg, REFRESH_DEADLINE_MS, REFRESH_LEAD_MS, REFRESH_PUSH_MOVE_FRAC, type RefreshDisposition } from './middayShadow.js';
import { trailingResolved, type ChargeCycleState, type ChargeLegState } from './chargeCycle.js';
import { armedForceChargeCeilingPct, clampReserveTarget } from './nightChargeActuator.js';
import { chargeLevelPct, statedBuyKwh, type NightChargePlan } from './nightChargeAdvisor.js';
import type { NightLedgerRow } from './recorder.js';

/** The weather a live refresh is sized on is at most this old (plan §3.4 step 1). The worker is
 *  asked for it (the report's maxWeatherAgeMs); weather older than this — a failed fetch leaves the
 *  stale cache in place — defers the refresh to the next minute. */
export const REFRESH_MAX_WEATHER_AGE_MS = 45 * 60_000;

/**
 * Whether the live refresh is due now (plan §3.4). PURE.
 *  'run'   — the ACTIVE leg is an armed super off-peak cost leg (announced, not cancelled, nothing
 *            attempted, not refreshed), no trailing leg is still open, and now is in
 *            [open − REFRESH_LEAD_MS, open − REFRESH_DEADLINE_MS);
 *  'stand' — the same leg, from open − REFRESH_DEADLINE_MS until the open, with no refresh made:
 *            the evening's arm stands (stamped so, once);
 *  null    — anything else: every overnight leg, a pending leg (its backup has not resolved), a leg
 *            already refreshed or attempted, a cancelled leg, a window already open.
 */
export function liveRefreshDue(c: ChargeCycleState, nowMs: number): 'run' | 'stand' | null {
  const leg = c.active;
  if (leg.windowKind !== 'super_off_peak' || leg.leg !== 'cost') return null;
  if (leg.day == null || leg.announcedAtMs == null || leg.cancelled) return null;
  if (leg.applyAttemptedAtMs != null || leg.appliedAtMs != null || leg.refreshedAtMs != null) return null;
  if (c.trailing != null && !trailingResolved(c.trailing)) return null;
  const open = leg.windowStartMs;
  if (open == null || !Number.isFinite(open) || nowMs >= open) return null;
  if (nowMs >= open - REFRESH_DEADLINE_MS) return 'stand';
  return nowMs >= open - REFRESH_LEAD_MS ? 'run' : null;
}

/**
 * The refresh's enforced deadline (plan §3.4: "at start − 5 min the evening arm stands"). The
 * planner's await can outlast the minute it started in; a refresh whose answer arrives at or after
 * open − REFRESH_DEADLINE_MS is dropped unwritten, and the next tick stamps the arm standing. A
 * leg with no window has no refresh to make. PURE.
 */
export function refreshPastDeadline(leg: ChargeLegState, atMs: number): boolean {
  const open = leg.windowStartMs;
  return open == null || !Number.isFinite(open) || atMs >= open - REFRESH_DEADLINE_MS;
}

/** The weather a refresh was sized on is fresh enough to act on (fetched within
 *  REFRESH_MAX_WEATHER_AGE_MS of now). Unknown is not fresh. PURE. */
export function refreshWeatherFresh(weatherFetchedAtMs: number | null | undefined, nowMs: number): boolean {
  return weatherFetchedAtMs != null && Number.isFinite(weatherFetchedAtMs) && nowMs - weatherFetchedAtMs <= REFRESH_MAX_WEATHER_AGE_MS;
}

/**
 * Re-read after the planner's await (plan §3.4 step 2): the refresh is dropped when the leg it was
 * computed for is no longer the one on record — another day or window, re-announced, attempted,
 * cancelled, or already refreshed. Returns why, or null to go ahead. PURE.
 */
export function refreshAborted(before: ChargeLegState, after: ChargeLegState): string | null {
  if (after.day !== before.day || after.windowStartMs !== before.windowStartMs || after.leg !== before.leg) return 'the cycle no longer holds that leg';
  if (after.announcedAtMs !== before.announcedAtMs) return 'the leg was re-announced';
  if (after.applyAttemptedAtMs !== before.applyAttemptedAtMs || after.appliedAtMs != null) return 'the write was attempted';
  if (after.cancelled !== before.cancelled) return 'the leg was cancelled';
  if (after.refreshedAtMs != null) return 'the leg was already refreshed';
  return null;
}

/** What the live refresh decided for a leg. */
export interface LiveRefreshOutcome {
  disposition: RefreshDisposition;
  /** The stop the leg runs on after the refresh (≤ the announced level), and the reserve (≤ the armed one). */
  levelPct: number | null;
  reservePct: number | null;
  /** The force-charge ceiling after the refresh (≤ the armed one; null: none rides the leg). */
  forceChargeCeilingPct: number | null;
  buyKwh: number | null;
  expectedBuyKwh: number | null;
  /** The level the re-plan asked for (above the announced one when capped). */
  neededLevelPct: number | null;
  /** The reserve the re-plan asked for (above the armed one when that capped it). */
  neededReservePct: number | null;
  wouldPush: boolean;
  reason: string;
}

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The evening's arm standing (no refresh made by the deadline, or nothing to refresh against). */
export function standingLiveRefresh(leg: ChargeLegState, reason: string): LiveRefreshOutcome {
  return {
    disposition: 'stood', levelPct: leg.announcedLevelPct, reservePct: leg.targetPct, forceChargeCeilingPct: leg.forceChargeCeilingPct,
    buyKwh: leg.buyKwh, expectedBuyKwh: leg.announcedExpectedKwh, neededLevelPct: null, neededReservePct: null, wouldPush: false, reason,
  };
}

/**
 * The live refresh's outcome for a leg from its re-sized plan (null: the planner had no inputs).
 * PURE. refreshLeg against what the evening announced (the leg's announced level and expected draw,
 * its armed reserve and worst case). A leg with no announced level has no consent ceiling to refresh
 * against: its arm stands.
 *
 * What was announced is the ceiling of every written value, not the level alone: the 21:30 push
 * said "at 10:00 AM the backup reserve is held at N%", so the written reserve is the lower of the
 * armed one and the re-plan's, and a re-plan that asks for a higher reserve is recorded `capped`
 * (as a higher level is) and writes nothing — its expected figure is not stated, since it was sized
 * on a reserve that will not be written. That rule is refreshLeg's, the one the shadow records. The
 * force-charge ceiling is lowered to the re-plan's when that is lower, and dropped when the re-plan
 * needs none; it is never raised. Whether a live refresh pushes is judged on the values it will
 * actually write.
 */
export function liveRefreshOutcome(leg: ChargeLegState, plan: NightChargePlan | null): LiveRefreshOutcome {
  if (leg.announcedLevelPct == null || !Number.isFinite(leg.announcedLevelPct)) {
    return standingLiveRefresh(leg, 'the leg has no announced level to refresh against; the evening arm stands');
  }
  const refreshedReserve = plan != null && plan.setpointSocPct != null && Number.isFinite(plan.setpointSocPct)
    ? clampReserveTarget(plan.setpointSocPct) : null;
  const r = refreshLeg({
    announced: { levelPct: leg.announcedLevelPct, reservePct: leg.targetPct, expectedBuyKwh: leg.announcedExpectedKwh, buyKwh: leg.buyKwh },
    refreshed: plan == null ? null : {
      basisComplete: plan.basisComplete, chargeTonight: plan.chargeTonight,
      levelPct: fin(chargeLevelPct(plan)),
      reservePct: refreshedReserve,
      expectedBuyKwh: statedBuyKwh(plan), buyKwh: fin(plan.buyKwh),
    },
  });
  const neededLevelPct = plan != null ? fin(chargeLevelPct(plan)) : null;
  const neededReservePct = refreshedReserve;
  if (r.disposition === 'stood' || r.disposition === 'cancelled') {
    return {
      disposition: r.disposition,
      levelPct: r.levelPct,
      reservePct: r.disposition === 'cancelled' ? null : leg.targetPct,
      forceChargeCeilingPct: r.disposition === 'cancelled' ? null : leg.forceChargeCeilingPct,
      buyKwh: r.buyKwh, expectedBuyKwh: r.expectedBuyKwh, neededLevelPct, neededReservePct, wouldPush: r.wouldPush, reason: r.reason,
    };
  }
  const armedReserve = leg.targetPct;
  // refreshLeg caps a higher level, and a higher reserve than the armed (announced) one.
  const capped = r.disposition === 'capped';
  // A cap writes nothing at all: the reserve, the stop and the ceiling stay as armed. Below a cap
  // the re-plan's reserve is at most the armed one already; the min holds it there regardless.
  const reserve = armedReserve == null || capped ? armedReserve : Math.min(armedReserve, r.reservePct ?? armedReserve);
  const armedCeiling = leg.forceChargeCeilingPct;
  const re = armedForceChargeCeilingPct(plan!);
  const ceiling = capped || armedCeiling == null ? armedCeiling : re == null ? null : Math.min(armedCeiling, re);
  const level = capped ? leg.announcedLevelPct : r.levelPct;
  const written = !capped && ((armedReserve != null && reserve != null && reserve < armedReserve - 1e-9)
    || (level != null && level < leg.announcedLevelPct - 1e-9)
    || (armedCeiling != null && (ceiling == null || ceiling < armedCeiling - 1e-9)));
  // A cap states no expected figure (refreshLeg): it was sized on values that will not be written.
  const expectedBuyKwh = r.expectedBuyKwh;
  const a = leg.announcedExpectedKwh;
  const moved = a != null && a > 0 && expectedBuyKwh != null && Math.abs(expectedBuyKwh - a) > REFRESH_PUSH_MOVE_FRAC * a;
  const disposition: RefreshDisposition = capped ? 'capped' : written ? 'lowered' : 'unchanged';
  return {
    disposition,
    levelPct: level,
    reservePct: reserve,
    forceChargeCeilingPct: ceiling,
    buyKwh: r.buyKwh,
    expectedBuyKwh,
    neededLevelPct,
    neededReservePct,
    wouldPush: capped || written || moved,
    reason: r.reason,
  };
}

/**
 * The leg after its refresh: stamped `refreshedAtMs` (it runs once), cancelled on a cancel, and on a
 * lowered refresh its reserve and force-charge ceiling at most what was armed. A cap, an unchanged
 * plan or a standing arm write nothing but the stamp. PURE.
 */
export function applyLiveRefresh(leg: ChargeLegState, o: LiveRefreshOutcome, nowMs: number): ChargeLegState {
  const stamped: ChargeLegState = { ...leg, refreshedAtMs: nowMs };
  if (o.disposition === 'cancelled') return { ...stamped, cancelled: true };
  if (o.disposition !== 'lowered') return stamped;
  const min = (a: number | null, b: number | null): number | null => (a == null ? null : b == null ? a : Math.min(a, b));
  return {
    ...stamped,
    targetPct: min(leg.targetPct, o.reservePct),
    forceChargeCeilingPct: leg.forceChargeCeilingPct == null ? null : o.forceChargeCeilingPct == null ? null : Math.min(leg.forceChargeCeilingPct, o.forceChargeCeilingPct),
  };
}

/** The refresh's ledger columns (the cost leg's refreshed_* columns; the plan columns stay the
 *  evening's). PURE. */
export function liveRefreshLedgerColumns(o: LiveRefreshOutcome, nowMs: number, weatherAgeS: number | null): Partial<NightLedgerRow> {
  return {
    refreshed_at_ms: nowMs,
    refresh_disposition: o.disposition,
    refreshed_level_pct: o.levelPct,
    refreshed_reserve_pct: o.reservePct,
    refreshed_buy_kwh: o.buyKwh,
    refresh_weather_age_s: weatherAgeS,
  };
}
