/**
 * chargeWindows.ts — which tariff windows a charge cycle uses, and where each sits against the
 * tariff's on-peak period. PURE: the tariff model is passed in, the clock is an argument.
 *
 * THE WINDOWS. A charge cycle is planned at ~21:30 and holds one or two legs, applied in order:
 *  - the OVERNIGHT window (APS R-EV 23:00–05:00 Mon–Fri) — today's only leg, the cost buy;
 *  - in winter, the SUPER OFF-PEAK window (10:00–15:00 Mon–Fri) can take the cost buy instead,
 *    and the overnight window before it becomes an outage BACKUP leg (resilience only: it writes
 *    the reserve, never force-charges).
 * `chooseChargeCycle` decides which, structurally, from the calendar: the first super off-peak run
 * within CHARGE_CYCLE_SCAN_HOURS of the plan (30 h — Sunday to Thursday evenings reach the next
 * morning's run; Friday and Saturday evenings do not, so the weekend keeps its overnight cycle),
 * outside the season grace (the first SEASON_GRACE_DAYS of the first winter month, billed on a
 * summer cycle until the meter read), and only when the configuration asks for it. The one rate
 * check is a veto: confirmed rates that put super off-peak at or above overnight.
 * Nothing consumes the mid-day choice yet: every live plan is the overnight leg
 * (OVERNIGHT_CYCLE), and `nextChargeableOpenMs` under it is the overnight scan the planner used.
 *
 * THE ON-PEAK BOUND. A supervised charge leg raises the panel's backup reserve and, in cost mode,
 * switches its force-charge on. Either one left standing into the on-peak period buys grid power
 * at the day's highest rate: the panel holds the raised reserve as its floor and refills to it
 * from the grid. The leg therefore carries the start of the on-peak period that follows its
 * window (`nextOnPeakStartMs`, stamped when the leg is armed), and every raise stops, and every
 * restore falls due, an hour before it (nightChargeActuator.ts `writeWindowEndMs`).
 *
 * The overnight window (23:00–05:00) ends eleven hours before the next 16:00 on-peak, so for
 * it the stamp changes nothing on a night that goes to plan. It bounds the failure paths: a
 * restore that does not take, a force-charge OFF that cannot be confirmed, a readback that
 * goes dark. The mid-day window ends one hour before on-peak.
 */
import { rateAt, localParts, seasonOf, APS_PERIOD, type TariffModel } from './tariff.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The tariff window a leg charges in. */
export type ChargeWindowKind = 'overnight' | 'super_off_peak';
/** What a leg is for: the COST buy, or the resilience-only outage BACKUP ahead of a mid-day buy. */
export type ChargeLegRole = 'backup' | 'cost';

/** One leg of a charge cycle: its window and role. Hour-aligned bounds, end-exclusive. */
export interface ChargeLeg {
  role: ChargeLegRole;
  kind: ChargeWindowKind;
  startMs: number;
  endMs: number;
}

/** The tariff period id each window kind is a run of. */
export const WINDOW_PERIOD_ID: Readonly<Record<ChargeWindowKind, string>> = Object.freeze({
  overnight: APS_PERIOD.OVERNIGHT,
  super_off_peak: APS_PERIOD.SUPER_OFF_PEAK,
});

/**
 * Resolve the next cheap charge window by scanning a period resolver forward for the next
 * contiguous run of `cheapPeriodId` (the overnight tier for today's cycle). Hour-aligned bounds.
 * Returns null if no cheap hour is found within `scanHours`. PURE — the resolver (rateAt-backed)
 * is injected. (Moved here from nightChargeAdvisor.ts, which re-exports it.)
 */
export function resolveCheapWindow(
  periodIdAt: (tsMs: number) => string,
  fromMs: number,
  cheapPeriodId: string,
  scanHours = 30,
): { startMs: number; endMs: number } | null {
  const h0 = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  // v1.39.0 review fix: the END of a found run is scanned up to 24 h past the
  // run's own start — a window START must lie within scanHours, but a run
  // straddling the scan edge must not have its end truncated to the horizon
  // (a Saturday-evening scan found Monday 00:00 at hour 27 of a 30 h scan and
  // clipped the window end to Monday 04:00 instead of 05:00).
  const endOfRun = (runStartMs: number): number => {
    for (let i = 1; i <= 24; i++) {
      const t = runStartMs + i * HOUR_MS;
      if (periodIdAt(t) !== cheapPeriodId) return t;
    }
    return runStartMs + 25 * HOUR_MS; // pathological always-cheap resolver — bounded
  };
  // If `fromMs` is ALREADY inside a cheap window (a recompute running during the
  // 23:00–05:00 window), walk BACK to the window's true start so the reported
  // window_start isn't truncated to the live mid-window clock (display honesty).
  if (periodIdAt(h0) === cheapPeriodId) {
    let s = h0;
    for (let i = 1; i <= scanHours; i++) {
      const t = h0 - i * HOUR_MS;
      if (periodIdAt(t) === cheapPeriodId) s = t;
      else break;
    }
    return { startMs: s, endMs: endOfRun(h0) };
  }
  for (let i = 0; i <= scanHours; i++) {
    const t = h0 + i * HOUR_MS;
    if (periodIdAt(t) === cheapPeriodId) return { startMs: t, endMs: endOfRun(t) };
  }
  return null;
}

/* ── the cycle chooser ─────────────────────────────────────────────────────── */

/** How far ahead of the plan a cycle's legs may start. 30 h: from a 21:30 plan the next
 *  morning's 10:00 run is 12.5 h out, Friday's and Saturday's next run (Monday 10:00) is 60.5 h
 *  and 36.5 h out — so the weekend, and the evening before a holiday, keep the overnight cycle. */
export const CHARGE_CYCLE_SCAN_HOURS = 30;
/** How far the next-chargeable scan looks (the planner's horizon end): a weekend carry. */
export const NEXT_CHARGEABLE_SCAN_HOURS = 96;
/** The first days of the first winter month that stay on the overnight cycle: usage from the 1st
 *  to the meter read, early in the month, is billed on a summer cycle, which has no super
 *  off-peak period. */
export const SEASON_GRACE_DAYS = 7;
/** A mid-day cost leg needs a cost ceiling above the reserve write's maximum: the reserve write
 *  alone (at most 50%) is what the backup leg already does, and the force-charge that carries the
 *  cost fill rides only above it (nightForceCharge.ts forceChargeEnabled). Equal to
 *  RESERVE_WRITE_MAX_PCT (pinned by chargeWindows.test.ts; not imported, to keep this module a leaf). */
export const MIDDAY_MIN_COST_MAX_SOC_PCT = 50;

/** The configuration the chooser reads. */
export interface ChargeCycleConfig {
  /** Where the cost buy goes: 'overnight' (today's cycle) or 'super_off_peak' (mid-day). */
  costWindow: ChargeWindowKind;
  /** ARB_OBJECTIVE: a mid-day buy is a cost buy; resilience keeps the overnight cycle. */
  objective: 'cost' | 'resilience';
  /** ARB_COST_MAX_SOC_PCT. */
  costMaxSocPct: number;
  /** Default SEASON_GRACE_DAYS. */
  seasonGraceDays?: number;
}

/** Today's cycle: the overnight window carries the cost buy, nothing else. */
export const OVERNIGHT_CYCLE: Readonly<ChargeCycleConfig> = Object.freeze({
  costWindow: 'overnight', objective: 'resilience', costMaxSocPct: 0,
});

/**
 * Why a cycle has the legs it has:
 *  - 'midday'            the super off-peak window carries the cost buy;
 *  - 'overnight-configured' / 'not-cost-objective' / 'ceiling-at-reserve' — the configuration does
 *    not ask for a mid-day buy (ChargeCycleConfig);
 *  - 'no-run-in-scan'    no super off-peak run within the scan (Friday, Saturday, a holiday eve,
 *                        summer);
 *  - 'season-grace'      the run falls in the season grace (seasonGraceActive);
 *  - 'rate-veto'         confirmed rates put super off-peak at or above overnight.
 */
export type ChargeCycleWhy =
  | 'midday' | 'overnight-configured' | 'not-cost-objective' | 'ceiling-at-reserve'
  | 'no-run-in-scan' | 'season-grace' | 'rate-veto';

/** The configuration's own answer, before the calendar: null when it asks for a mid-day buy. */
export function middayConfigGate(cfg: ChargeCycleConfig): ChargeCycleWhy | null {
  if (cfg.costWindow !== 'super_off_peak') return 'overnight-configured';
  if (cfg.objective !== 'cost') return 'not-cost-objective';
  if (!(Number.isFinite(cfg.costMaxSocPct) && cfg.costMaxSocPct > MIDDAY_MIN_COST_MAX_SOC_PCT)) return 'ceiling-at-reserve';
  return null;
}

/**
 * The first `graceDays` local days of the first winter month (the month after the model's last
 * summer month: October under APS_SUMMER_MONTHS). APS bills that usage on the summer cycle until
 * the meter read, so its 10:00–15:00 hours are not super off-peak on the bill whatever the
 * usage-month model says. A model with no summer-to-winter turn has no grace.
 */
export function seasonGraceActive(
  model: Pick<TariffModel, 'timezone' | 'summerMonths'>, tsMs: number, graceDays = SEASON_GRACE_DAYS,
): boolean {
  if (!Number.isFinite(tsMs) || !Number.isFinite(graceDays) || graceDays <= 0) return false;
  const lp = localParts(tsMs, model.timezone);
  if (seasonOf(lp.month, model.summerMonths) !== 'winter') return false;
  const prevMonth = lp.month === 1 ? 12 : lp.month - 1;
  return seasonOf(prevMonth, model.summerMonths) === 'summer' && lp.day <= graceDays;
}

/** Confirmed rates that make the super off-peak window no cheaper than overnight: the run at
 *  `tsMs` costs at least the overnight rate of the same season. Unconfirmed or missing rates never
 *  veto — the choice is structural. */
export function superOffPeakRateVeto(model: TariffModel, tsMs: number): boolean {
  if (!model.ratesConfirmed) return false;
  const sop = rateAt(model, tsMs);
  if (sop.periodId !== APS_PERIOD.SUPER_OFF_PEAK || sop.centsPerKwh == null || !Number.isFinite(sop.centsPerKwh)) return false;
  const overnight = model.periods.find((p) => p.id === APS_PERIOD.OVERNIGHT)?.centsBySeason[sop.season];
  return overnight != null && Number.isFinite(overnight) && sop.centsPerKwh >= overnight;
}

/** Why the super off-peak run starting at `runStartMs` cannot carry the cost buy, or null. */
export function middayRunVeto(model: TariffModel, runStartMs: number, cfg: ChargeCycleConfig): 'season-grace' | 'rate-veto' | null {
  if (seasonGraceActive(model, runStartMs, cfg.seasonGraceDays ?? SEASON_GRACE_DAYS)) return 'season-grace';
  if (superOffPeakRateVeto(model, runStartMs)) return 'rate-veto';
  return null;
}

/** A cycle: its legs in the order they apply (the backup first), and why. */
export interface ChargeCycle {
  legs: ChargeLeg[];
  /** The leg that carries the cost buy (or, with a resilience objective, the only buy). null when
   *  no overnight window opens within the scan either (a run of holidays). */
  cost: ChargeLeg | null;
  /** The resilience-only overnight leg ahead of a mid-day cost leg; null otherwise. */
  backup: ChargeLeg | null;
  why: ChargeCycleWhy;
}

const periodIdAtOf = (model: TariffModel) => (t: number): string => rateAt(model, t).periodId;

/**
 * The cycle a plan at `nowMs` arms. PURE.
 *  - cost: the first super off-peak run within `scanHours` (the run in progress, mid-window),
 *    when the configuration asks for it (middayConfigGate) and the run is not vetoed
 *    (middayRunVeto). Otherwise the overnight window the planner has always resolved
 *    (resolveCheapWindow over `scanHours`), kind 'overnight'.
 *  - backup: with a mid-day cost leg, the overnight run that ends by the cost leg's start. A
 *    plan made after that run (06:00 on the day) has none.
 */
export function chooseChargeCycle(
  model: TariffModel, nowMs: number, cfg: ChargeCycleConfig, scanHours = CHARGE_CYCLE_SCAN_HOURS,
): ChargeCycle {
  const periodIdAt = periodIdAtOf(model);
  const overnight = resolveCheapWindow(periodIdAt, nowMs, APS_PERIOD.OVERNIGHT, scanHours);
  const overnightCycle = (why: ChargeCycleWhy): ChargeCycle => {
    const cost: ChargeLeg | null = overnight ? { role: 'cost', kind: 'overnight', ...overnight } : null;
    return { legs: cost ? [cost] : [], cost, backup: null, why };
  };
  const gate = middayConfigGate(cfg);
  if (gate != null) return overnightCycle(gate);
  const run = resolveCheapWindow(periodIdAt, nowMs, APS_PERIOD.SUPER_OFF_PEAK, scanHours);
  if (!run) return overnightCycle('no-run-in-scan');
  const veto = middayRunVeto(model, run.startMs, cfg);
  if (veto != null) return overnightCycle(veto);
  const cost: ChargeLeg = { role: 'cost', kind: 'super_off_peak', ...run };
  const backup: ChargeLeg | null = overnight && overnight.endMs <= run.startMs
    ? { role: 'backup', kind: 'overnight', ...overnight } : null;
  return { legs: backup ? [backup, cost] : [cost], cost, backup, why: 'midday' };
}

/**
 * The start of the next window a cycle can charge in, at or after `fromMs` (the run in progress
 * when `fromMs` is inside one), within `scanHours`, or null: the end of the planner's horizon
 * (`nextRechargeMs`). The overnight run always counts; a super off-peak run counts when the
 * configuration asks for mid-day buys and the run is not vetoed (vetoed runs are stepped over).
 * Under OVERNIGHT_CYCLE this is exactly the overnight scan the planner has used since v1.39.0.
 */
export function nextChargeableOpenMs(
  model: TariffModel, fromMs: number, cfg: ChargeCycleConfig = OVERNIGHT_CYCLE, scanHours = NEXT_CHARGEABLE_SCAN_HOURS,
): number | null {
  const periodIdAt = periodIdAtOf(model);
  const overnightMs = resolveCheapWindow(periodIdAt, fromMs, APS_PERIOD.OVERNIGHT, scanHours)?.startMs ?? null;
  if (middayConfigGate(cfg) != null) return overnightMs;
  const limitMs = Math.floor(fromMs / HOUR_MS) * HOUR_MS + scanHours * HOUR_MS;
  let middayMs: number | null = null;
  let from = fromMs;
  for (let i = 0; i < 64 && from <= limitMs; i++) {
    const hoursLeft = Math.max(0, Math.ceil((limitMs - Math.floor(from / HOUR_MS) * HOUR_MS) / HOUR_MS));
    const run = resolveCheapWindow(periodIdAt, from, APS_PERIOD.SUPER_OFF_PEAK, hoursLeft);
    if (!run || run.startMs > limitMs) break;
    if (middayRunVeto(model, run.startMs, cfg) == null) { middayMs = run.startMs; break; }
    from = run.endMs;
  }
  if (overnightMs == null) return middayMs;
  return middayMs == null ? overnightMs : Math.min(overnightMs, middayMs);
}

/* ── per-leg objective and force-charge ────────────────────────────────────── */

/** The objective a leg is sized for: the backup leg is resilience-only whatever is configured;
 *  the cost leg keeps the configured objective (passed through as given, unset included). */
export function legObjective<T extends 'cost' | 'resilience' | undefined>(role: ChargeLegRole, configured: T): T | 'resilience' {
  return role === 'backup' ? 'resilience' : configured;
}

/** Whether a leg may force-charge: never the backup leg (it writes the reserve only); the cost
 *  leg when force-charge is enabled (nightForceCharge.ts forceChargeEnabled). */
export function legForceChargeEligible(role: ChargeLegRole, enabled: boolean): boolean {
  return role !== 'backup' && enabled;
}

/* ── the plan date a cycle belongs to ──────────────────────────────────────── */

const MINUTE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function localMinuteOfDay(tsMs: number, timezone: string): number {
  let f = MINUTE_FORMATTERS.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    MINUTE_FORMATTERS.set(timezone, f);
  }
  const parts = f.formatToParts(new Date(tsMs));
  const num = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return num('hour') * 60 + num('minute');
}

/**
 * The plan date (local 'YYYY-MM-DD') that owns the cycle a plan at `nowMs` describes, whose
 * first remaining leg starts at `firstLegStartMs`. A cycle belongs to the evening that plans it:
 * at or after the evening's plan time (`notifyMinuteOfDay`) that is today. Before it, a cycle
 * whose first leg starts before this evening's plan time is still the one last evening armed —
 * a mid-day cost leg recomputed at 06:00 — and belongs to yesterday. A cycle starting later is
 * this evening's (an overnight window is always this evening's: its plan time comes first).
 */
export function planDateOwningCycle(o: {
  nowMs: number;
  firstLegStartMs: number | null;
  timezone: string;
  notifyMinuteOfDay: number;
}): string {
  const today = localParts(o.nowMs, o.timezone).ymd;
  if (o.firstLegStartMs == null || !Number.isFinite(o.firstLegStartMs)) return today;
  const minuteNow = localMinuteOfDay(o.nowMs, o.timezone);
  if (minuteNow >= o.notifyMinuteOfDay) return today;
  const planTimeTodayMs = Math.floor(o.nowMs / MINUTE_MS) * MINUTE_MS + (o.notifyMinuteOfDay - minuteNow) * MINUTE_MS;
  return o.firstLegStartMs < planTimeTodayMs ? localParts(o.nowMs - DAY_MS, o.timezone).ymd : today;
}

/* ── the on-peak bound ─────────────────────────────────────────────────────── */

/** How far ahead the on-peak scan looks: a weekend plus the longest run of R-EV holidays
 *  (Christmas Eve and Christmas Day on a Thursday and Friday put the next on-peak period
 *  about five days out) fits inside eight days. */
export const ON_PEAK_SCAN_HOURS = 8 * 24;

/**
 * The start of the first on-peak period at or after `fromMs` under `model`, or null when the
 * model has none within `scanHours` (a flat tariff has no on-peak period at all). An instant
 * already inside an on-peak period returns the start of that period (at most 24 h back), so a
 * leg armed inside one is guarded from the start. The tariff's periods are whole local hours,
 * so the scan steps hour by hour, as the cheap-window resolver does (resolveCheapWindow).
 */
export function nextOnPeakStartMs(model: TariffModel, fromMs: number, scanHours = ON_PEAK_SCAN_HOURS): number | null {
  if (!Number.isFinite(fromMs)) return null;
  const onPeak = (t: number): boolean => rateAt(model, t).isOnPeak;
  const h0 = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  if (onPeak(h0)) {
    let start = h0;
    for (let i = 1; i <= 24 && onPeak(h0 - i * HOUR_MS); i++) start = h0 - i * HOUR_MS;
    return start;
  }
  for (let i = 1; i <= scanHours; i++) {
    const t = h0 + i * HOUR_MS;
    if (onPeak(t)) return t;
  }
  return null;
}

/**
 * R5 (v1.189.0) — the end of the on-peak period that starts at `startMs` (nextOnPeakStartMs): the
 * first hour after it that is not on-peak, within a day; null when `startMs` is not on-peak, or the
 * period runs a whole day. The mid-day texts name the on-peak period by its span ("4–7pm"). PURE.
 */
export function onPeakEndMs(model: TariffModel, startMs: number): number | null {
  if (!Number.isFinite(startMs) || !rateAt(model, startMs).isOnPeak) return null;
  for (let i = 1; i <= 24; i++) {
    const t = startMs + i * HOUR_MS;
    if (!rateAt(model, t).isOnPeak) return t;
  }
  return null;
}
