/**
 * nightSchedule.ts — v1.191.0 (S6; plan 3.4 W2–W6 and CA15): the night-charge schedule as data.
 *
 * The evening job's catch-up window, the notify-hour clamp, the stale-panel and incomplete-basis
 * deferral, the fallback night the scorer uses for a row with no stored window, and the shortest
 * window that counts as a full recharge were all written for the APS R-EV overnight window,
 * 23:00–05:00. They are resolved here from the tariff in effect:
 *
 *  - the APS R-EV preset planning its own overnight period (the reference install): today's
 *    constants, verbatim (APS_NIGHT_SCHEDULE), whatever the notify time;
 *  - a plan with no cheap period (flat, two_tier without NIGHT_CHARGE_CHEAP_PERIOD, an unusable
 *    spec): the same constants. The planner holds every night; only the evening job's clock reads
 *    them;
 *  - any other plan: derived from the plan's NOMINAL cheap window (nominalCheapWindow): the cheap
 *    period's own hours, or, for off_peak, the longest run of hours no period covers. The night of
 *    plan date D is the first cheap window at or after D 12:00, so a window that opens before noon
 *    opens on the day after the plan date.
 *
 * The derived rules (plan 3.4), with the nominal window opening `open` minutes after the plan date's
 * local midnight (12:00 ≤ open < 36:00) and closing `close` minutes after it:
 *  W2   eveningCutoffMin    open, and at most midnight: the evening job is keyed by the site day;
 *  W6   notifyHourMax       the hour before the open, and at most 22 (the option's own clamp);
 *  W3   staleDeferUntilMin  min(fire + 60 min, open − 30 min): with no time to wait it does not wait;
 *  W4   fallbackNight       open, close, and close + SCORE_SPAN_AFTER_CLOSE_MS (the completion);
 *  CA15 fullWindowMinMs     min(3 h, the nominal window's length): a plan whose cheap window is
 *                           shorter than 3 h still has full nights.
 *  W5   forceChargeMaxRunMs max(7 h, the nominal window's length + 1 h): the backstop no force-charge
 *                           of ours outlives (nightForceCharge.ts ForceChargeOpts.maxRunMs). It is
 *                           the tariff's, never the armed window's, so a corrupted window still
 *                           cannot hold a force-charge on.
 *
 * Every derived rule reproduces the APS constant on the APS window except W3 at a notify time other
 * than 21:30 (a 21:00 notify would move the deferral to 22:00), which is why the preset carries its
 * constants instead of deriving them (plan 6.4 item 5). LONG_GAP_MS (24 h: a skipped night, for any
 * daily window), PRE_PEAK_SURPLUS_MAX_HOURS and SCORE_SPAN_AFTER_CLOSE_MS are measured from the
 * window itself and stay constants.
 *
 * PURE: the model and the configured notify time are arguments. Main thread (index.ts).
 */
import { cheapPeriodIdOf, type TariffModel } from './tariff.js';
import { nominalCheapWindow, isApsOvernightSchedule } from './chargeWindows.js';
import { NIGHT_PLAN_STALE_DEFER_UNTIL_MIN, FULL_CHEAP_WINDOW_MIN_MS, APS_FALLBACK_NIGHT } from './nightChargeAdvisor.js';
import { SCORE_SPAN_AFTER_CLOSE_MS } from './nightLedgerScoring.js';
import { FORCE_CHARGE_MAX_RUN_MS } from './nightForceCharge.js';
import type { RepairIssue } from './repairIssues.js';

// v1.191.0 (review) — the nominal window moved to chargeWindows.ts, whose resolver bounds a run by it
// (cheapNightOf); re-exported here, where the schedule is derived from it.
export { nominalCheapWindow, isApsOvernightSchedule, type NominalCheapWindow } from './chargeWindows.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const NOON_MIN = 12 * 60;
const MIDNIGHT_MIN = 24 * 60;

/** The notify hour's ceiling with any plan: the option's clamp (config.ts NIGHT_CHARGE_NOTIFY_HOUR,
 *  0..22), so the evening job always has an hour before midnight. */
export const NOTIFY_HOUR_CEILING = 22;

/** The fallback night of a plan date: minutes after its local midnight. */
export interface FallbackNight {
  windowStartMin: number;
  windowEndMin: number;
  /** When the night may be scored (nightWindowBounds completeMs). */
  completeMin: number;
}

/** The APS R-EV preset's schedule: the constants the planner was written with, as data. */
export const APS_NIGHT_SCHEDULE = Object.freeze({
  eveningCutoffMin: 23 * 60,
  notifyHourMax: NOTIFY_HOUR_CEILING,
  staleDeferUntilMin: NIGHT_PLAN_STALE_DEFER_UNTIL_MIN,
  fallbackNight: APS_FALLBACK_NIGHT as Readonly<FallbackNight>,
  fullWindowMinMs: FULL_CHEAP_WINDOW_MIN_MS,
  forceChargeMaxRunMs: FORCE_CHARGE_MAX_RUN_MS,
});

/** The night-charge schedule in effect. */
export interface NightSchedule {
  /** 'aps_r_ev': the preset's constants; 'no-cheap-period': the plan has none (the planner holds),
   *  the same constants; 'derived': from the plan's nominal cheap window. */
  source: 'aps_r_ev' | 'no-cheap-period' | 'derived';
  cheapPeriodId: string | null;
  /** The nominal window on the plan date, in minutes after its local midnight; null unless derived. */
  window: { openMin: number; closeMin: number } | null;
  /** W2 — the evening job's catch-up window [fire, cutoff) ends here (minute of the site day). */
  eveningCutoffMin: number;
  /** W6 — the latest hour the evening job may fire in. */
  notifyHourMax: number;
  /** The time the evening job fires: the configured one, its hour clamped to notifyHourMax. */
  notify: { hour: number; minute: number; fireMin: number; clampedFrom: { hour: number; minute: number } | null };
  /** W3 — until this minute of the site day a stale panel or a transient incomplete basis defers the
   *  evening plan (eveningBasisDefers); from it the plan is decided on what is known. */
  staleDeferUntilMin: number;
  /** W4 — the night nightWindowBounds gives a plan date. */
  fallbackNight: FallbackNight;
  /** CA15 — a cheap window shorter than this is not a full recharge (nextFullCheapWindow, longGapAhead). */
  fullWindowMinMs: number;
  /** W5 — no force-charge of ours outlives this (nightForceCharge.ts ForceChargeOpts.maxRunMs). */
  forceChargeMaxRunMs: number;
}

/**
 * The schedule of `model` for the configured notify time (the option's values, hour 0..22). PURE.
 * The APS preset and a plan with no cheap period keep APS_NIGHT_SCHEDULE exactly; any other plan
 * derives it from its nominal cheap window (see the module comment).
 */
export function nightScheduleOf(
  model: Pick<TariffModel, 'planId' | 'periods' | 'offPeak' | 'cheapPeriodId'>,
  configured: { hour: number; minute: number },
): NightSchedule {
  const nominal = isApsOvernightSchedule(model) ? null : nominalCheapWindow(model);
  if (nominal == null) {
    const hour = Math.min(configured.hour, APS_NIGHT_SCHEDULE.notifyHourMax);
    return {
      source: isApsOvernightSchedule(model) ? 'aps_r_ev' : 'no-cheap-period',
      cheapPeriodId: cheapPeriodIdOf(model),
      window: null,
      eveningCutoffMin: APS_NIGHT_SCHEDULE.eveningCutoffMin,
      notifyHourMax: APS_NIGHT_SCHEDULE.notifyHourMax,
      notify: {
        hour, minute: configured.minute, fireMin: hour * 60 + configured.minute,
        clampedFrom: hour === configured.hour ? null : { ...configured },
      },
      staleDeferUntilMin: APS_NIGHT_SCHEDULE.staleDeferUntilMin,
      fallbackNight: { ...APS_NIGHT_SCHEDULE.fallbackNight },
      fullWindowMinMs: APS_NIGHT_SCHEDULE.fullWindowMinMs,
      forceChargeMaxRunMs: APS_NIGHT_SCHEDULE.forceChargeMaxRunMs,
    };
  }
  const openMin = (nominal.startHour < NOON_MIN / 60 ? nominal.startHour + 24 : nominal.startHour) * 60;
  const closeMin = openMin + nominal.lengthHours * 60;
  const notifyHourMax = Math.min(NOTIFY_HOUR_CEILING, Math.floor(openMin / 60) - 1);
  const hour = Math.min(configured.hour, notifyHourMax);
  const fireMin = hour * 60 + configured.minute;
  return {
    source: 'derived',
    cheapPeriodId: nominal.periodId,
    window: { openMin, closeMin },
    eveningCutoffMin: Math.min(openMin, MIDNIGHT_MIN),
    notifyHourMax,
    notify: { hour, minute: configured.minute, fireMin, clampedFrom: hour === configured.hour ? null : { ...configured } },
    staleDeferUntilMin: Math.min(fireMin + 60, openMin - 30),
    fallbackNight: { windowStartMin: openMin, windowEndMin: closeMin, completeMin: closeMin + SCORE_SPAN_AFTER_CLOSE_MS / MINUTE_MS },
    fullWindowMinMs: Math.min(FULL_CHEAP_WINDOW_MIN_MS, nominal.lengthHours * HOUR_MS),
    forceChargeMaxRunMs: Math.max(FORCE_CHARGE_MAX_RUN_MS, nominal.lengthHours * HOUR_MS + HOUR_MS),
  };
}

/** A minute of the day as HH:MM (24:00 for midnight at the end of the day). */
export function fmtMinuteOfDay(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** One line for the start-up log, or null on the APS preset (whose schedule is unchanged and unannounced). */
export function nightScheduleLogLine(s: NightSchedule): string | null {
  if (s.source === 'aps_r_ev') return null;
  if (s.source === 'no-cheap-period') {
    return 'night-charge: the tariff plan has no cheap period, so the planner holds every night (no charge window); '
      + 'NIGHT_CHARGE_CHEAP_PERIOD names one, or a custom plan flags one cheap';
  }
  const w = s.window!;
  return `night-charge: schedule from the ${s.cheapPeriodId} period (opens ${fmtMinuteOfDay(w.openMin % MIDNIGHT_MIN)}, `
    + `${(w.closeMin - w.openMin) / 60} h): evening job at ${fmtMinuteOfDay(s.notify.fireMin)}`
    + `${s.notify.clampedFrom ? ` (NIGHT_CHARGE_NOTIFY_HOUR ${s.notify.clampedFrom.hour} is clamped to ${s.notifyHourMax})` : ''}, `
    + `catch-up until ${fmtMinuteOfDay(s.eveningCutoffMin)}, stale-panel deferral until ${fmtMinuteOfDay(Math.max(s.notify.fireMin, s.staleDeferUntilMin))}`;
}

/** The repair-issue id raised when the configured notify time is at or after the cheap window's open. */
export const NIGHT_NOTIFY_CLAMPED_ISSUE_ID = 'night-charge-notify-after-window';
const issueFirstSeen = new Map<string, number>();

/**
 * The repair issue for a configured notify time the cheap window has already opened by: the evening
 * job would plan inside the window, and a write mode refuses to arm a window that opened 30 minutes
 * earlier (nightChargeActuator.ts), so the hour is clamped and this says so. Never on the APS preset
 * (its clamp, 23 → 22, is the option's own and unchanged). PURE apart from the first-seen stamp.
 */
export function nightScheduleRepairIssues(s: NightSchedule, nowMs: number = Date.now()): RepairIssue[] {
  if (s.source !== 'derived' || s.notify.clampedFrom == null) return [];
  const c = s.notify.clampedFrom;
  const key = `${NIGHT_NOTIFY_CLAMPED_ISSUE_ID}:${c.hour}:${c.minute}:${s.notifyHourMax}`;
  let first = issueFirstSeen.get(key);
  if (first == null) { first = nowMs; issueFirstSeen.set(key, first); }
  const open = fmtMinuteOfDay(s.window!.openMin % MIDNIGHT_MIN);
  return [{
    id: NIGHT_NOTIFY_CLAMPED_ISSUE_ID,
    severity: 'info',
    category: 'Configuration',
    title: `The night-charge notify time is moved to ${fmtMinuteOfDay(s.notify.fireMin)}, before the cheap window opens at ${open}`,
    summary: `NIGHT_CHARGE_NOTIFY_HOUR and NIGHT_CHARGE_NOTIFY_MINUTE ask for ${fmtMinuteOfDay(c.hour * 60 + c.minute)}, which is not before the ${s.cheapPeriodId} window opens at ${open}. The evening job must plan before the window opens (a write mode refuses a window that opened more than 30 minutes earlier), so it runs at ${fmtMinuteOfDay(s.notify.fireMin)}.`,
    fixSteps: [
      `Set NIGHT_CHARGE_NOTIFY_HOUR to ${s.notifyHourMax} or earlier in the add-on Configuration, leaving time before ${open} to cancel a charge.`,
      'Restart the add-on.',
    ],
    estimatedTimeMinutes: 2,
    firstSeenAt: first,
  }];
}
