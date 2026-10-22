/* ═══════════════════════════════════════════════════════════════════════════
 * tariff.ts — declarative multi-period, seasonal, timezone-resolved TOU model.
 *
 * v1.36.0 (TOU night-charge arbitrage, increment 3). This is the PURE model +
 * `rateAt` resolver. NOTHING consumes it yet — the existing 2-tier tariff path
 * (analytics.ts `onPeakAt` / the MPC feed in index.ts) is rewired onto it in a
 * later, separately-attributable release, and the config-form exposure lands
 * after that. Shipping the model alone keeps this increment provable entirely
 * by unit tests with zero live impact.
 *
 * WHY a model, not two env consts: the deployed tariff is APS Rate Schedule
 * R-EV — FOUR periods across TWO seasons, which the flat on/off-peak pair
 * cannot express:
 *   - ON-PEAK        16:00–19:00 (4–7pm) Mon–Fri, year-round
 *   - SUPER-OFF-PEAK 10:00–15:00 (10am–3pm) Mon–Fri, WINTER only (overlaps solar)
 *   - OVERNIGHT      23:00–05:00 (11pm–5am) Mon–Fri, year-round (the EV window)
 *   - OFF-PEAK       everything else, incl. ALL weekends + observed holidays
 * Seasons (APS billing cycles): bills May–Oct are SUMMER, Nov–Apr WINTER. A bill
 * covers the usage since the previous meter read (early in the month), so by USAGE
 * month SUMMER = Apr–Sep and WINTER = Oct–Mar (v1.187.10 — see APS_SUMMER_MONTHS).
 * R-EV carries NO demand charge (confirmed) — `demand` stays inert here.
 *
 * ★ DOW SEMANTICS (load-bearing, and a bill-confirmable edge): a period's
 * `weekdays` gate is evaluated against EACH INSTANT'S OWN local day-of-week,
 * NOT the day the window "started". So the wrap-around OVERNIGHT window resolves
 * literally: Fri 23:00 is overnight (Fri is Mon–Fri) but Sat 00:00–05:00 is
 * OFF-PEAK (Saturday is a weekend) — consistent with "off-peak = all weekends".
 * Likewise Sun 23:00 is off-peak while Mon 00:00–05:00 is overnight. This is the
 * defensible default; whether APS treats Fri-night→Sat-morning or
 * Sun-night→Mon-morning as a single overnight block is an open question to
 * confirm from the utility bill before the advisor sizes a Friday→Monday carry on it. Rates are null
 * until confirmed, so no $ output depends on this yet.
 *
 * ★ Every local field is resolved in an EXPLICIT IANA timezone via
 * Intl.DateTimeFormat — never the host clock — so a non-Phoenix container (or a
 * future DST zone) can't bleed a rate boundary. Phoenix has no DST, but the
 * resolver does not rely on that.
 *
 * v1.191.0 (S5) — the model is no longer APS-only: `tariffModelFromEnv()` builds the plan the
 * options name (TARIFF_PLAN: the `aps_r_ev` preset when unset, `flat`, `two_tier` or a `custom`
 * table written in the period grammar), and it is the one reader every consumer calls. See the
 * section "THE TARIFF PLAN, READ FROM THE OPTIONS" below.
 * ═════════════════════════════════════════════════════════════════════════ */

// v1.191.0 (lane A, T1) — the models are defined in the site zone (siteTime.ts), not a literal.
import { siteTimeZone } from './siteTime.js';
import { option, optionRaw, TARIFF_FLAT_DEFAULT_CENTS, DEFAULT_SITE_TIME_ZONE } from './config.js';
import { tariffCurrency } from './money.js';
import type { RepairIssue } from './repairIssues.js';

export { TARIFF_FLAT_DEFAULT_CENTS };

export type Season = 'summer' | 'winter';

/** Per-season cents/kWh. `null` means "not yet confirmed from the utility bill". */
export interface SeasonalCents {
  summer: number | null;
  winter: number | null;
}

/** One TOU period. Periods are resolved in PRIORITY order (first match wins);
 *  R-EV's windows don't overlap, but priority is the tie-break safety net. */
export interface TariffPeriod {
  id: string;
  label: string;
  /** Local hour window [startHour, endHour), end-EXCLUSIVE. start > end wraps
   *  past midnight (e.g. 23→5 = 23,0,1,2,3,4). start === end ⇒ all 24 hours. */
  startHour: number;
  endHour: number;
  /** Local days-of-week this applies to (0=Sun … 6=Sat). null/undefined = every day. */
  weekdays?: number[] | null;
  /** Seasons this applies to. null/undefined = every season. */
  seasons?: Season[] | null;
  /** Per-season energy rate. */
  centsBySeason: SeasonalCents;
  /** Marks this as THE on-peak period for the `isOnPeak` back-compat flag,
   *  independent of the period id (so a non-'on_peak'-id model still resolves
   *  isOnPeak correctly). */
  onPeak?: boolean;
}

export interface TariffModel {
  planId: string;
  /** IANA timezone the periods are defined in (e.g. 'America/Phoenix'). */
  timezone: string;
  /** Priority-ordered specific periods (highest priority first). */
  periods: TariffPeriod[];
  /** The catch-all when no specific period matches. */
  offPeak: { id: string; label: string; centsBySeason: SeasonalCents };
  /** Local calendar months (1–12) of USAGE that count as SUMMER; the rest are WINTER.
   *  Read only through `seasonAt` / `seasonOf` — the one season source. */
  summerMonths: number[];
  /** Local 'YYYY-MM-DD' dates treated as all-day off-peak (observed holidays).
   *  v1.187.13 — the APS model defaults to the R-EV tariff's holiday rule
   *  (`apsOffPeakHolidays`); the flat model has none. */
  holidays: string[];
  /** INERT for R-EV (no demand charge). Present so a demand-charge plan can be
   *  modeled later without a schema change; consumed by nothing today. */
  demand?: { centsPerKw: number | null; windowPeriodId: string } | null;
  /** Fixed daily basic-service charge (informational; not part of rateAt). */
  fixedDailyCents?: number | null;
  /** When false, EVERY resolved centsPerKwh is null regardless of the numbers
   *  in the model — the "emit null over a fabricated rate" discipline. */
  ratesConfirmed: boolean;
  /** v1.191.0 (S5) — the period the night-charge engine plans and charges in. Absent means the
   *  APS preset's 'overnight' (read it through `cheapPeriodIdOf`); null means the plan has no cheap
   *  window, so the night-charge plan holds. NIGHT_CHARGE_CHEAP_PERIOD overrides it. The APS preset
   *  leaves it absent, so its model JSON is today's. */
  cheapPeriodId?: string | null;
}

/** The instantaneous rate resolution for a specific timestamp. */
export interface RateSlice {
  periodId: string;
  periodLabel: string;
  season: Season;
  /** null when ratesConfirmed is false OR the matched period has no season rate. */
  centsPerKwh: number | null;
  /** Back-compat with the legacy `onPeakAt(ts)` boolean. */
  isOnPeak: boolean;
  /** Mirrors the model's flag so a consumer can distinguish "null because rates
   *  aren't confirmed yet" (ratesConfirmed=false) from "null because this
   *  confirmed period has a missing-season data gap" (ratesConfirmed=true,
   *  centsPerKwh=null) — the two require different handling in the sizer. */
  ratesConfirmed: boolean;
}

export interface LocalParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  dow: number; // 0=Sun … 6=Sat
  ymd: string; // 'YYYY-MM-DD'
}

// v1.36.0 (review-hardening) — memoize one formatter per timezone. rateAt is
// called once per hour across a multi-day horizon when the MPC builds a cents
// vector; re-constructing an identical Intl.DateTimeFormat each call is pure
// repeated allocation. Correctness is unchanged (same formatter, same output).
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = FORMATTER_CACHE.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    FORMATTER_CACHE.set(timezone, f);
  }
  return f;
}

/** Resolve a UTC instant into local calendar/clock parts in an explicit IANA
 *  timezone. Uses hourCycle 'h23' so midnight is 0 (not 24). */
export function localParts(tsMs: number, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(new Date(tsMs));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  // v1.36.0 (review-hardening) — derive day-of-week from the RESOLVED LOCAL
  // calendar date, not an ICU 'weekday' part. getUTCDay of the Y-M-D at UTC
  // midnight is exactly that calendar date's weekday, and it is ICU-locale
  // independent: a degraded/small-icu runtime that dropped the 'weekday' part
  // would otherwise have collapsed every weekday to Sunday (dow=0) → every
  // on-peak/overnight hour silently mispriced as weekend off-peak. Fail-safe by
  // construction on the safety-relevant path.
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    year,
    month,
    day,
    hour: Number(get('hour')),
    dow,
    ymd: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** True if `hour` falls in [startHour, endHour) with wrap-around support. */
export function inHourWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true; // full 24h
  if (startHour < endHour) return hour >= startHour && hour < endHour; // same-day
  return hour >= startHour || hour < endHour; // wraps past midnight
}

export function seasonOf(month: number, summerMonths: number[]): Season {
  return summerMonths.includes(month) ? 'summer' : 'winter';
}

/**
 * v1.187.10 — THE season of an instant under a model: its local usage month against the
 * model's `summerMonths`. PURE. Every season consumer reads this (or `rateAt`, which applies
 * the same `seasonOf` to the same local month): the period/rate resolution, the two-tier
 * `resolveTariffCents` basis, the /api/tariff view and the nightly plan's tariff snapshot.
 * Until v1.187.10 analytics.ts carried its own May–October test beside this one.
 */
export function seasonAt(model: Pick<TariffModel, 'timezone' | 'summerMonths'>, tsMs: number): Season {
  return seasonOf(localParts(tsMs, model.timezone).month, model.summerMonths);
}

/** Resolve the tariff period + rate in effect at a timestamp. */
export function rateAt(model: TariffModel, tsMs: number): RateSlice {
  const lp = localParts(tsMs, model.timezone);
  const season = seasonOf(lp.month, model.summerMonths); // ≡ seasonAt(model, tsMs), one local resolve

  const pickCents = (c: SeasonalCents): number | null =>
    model.ratesConfirmed ? c[season] : null;

  // Observed holidays are all-day off-peak, ahead of every specific period.
  if (isModelHoliday(model, lp)) {
    return {
      periodId: model.offPeak.id,
      periodLabel: model.offPeak.label,
      season,
      centsPerKwh: pickCents(model.offPeak.centsBySeason),
      isOnPeak: false,
      ratesConfirmed: model.ratesConfirmed,
    };
  }

  for (const p of model.periods) {
    if (p.seasons && !p.seasons.includes(season)) continue;
    if (p.weekdays && !p.weekdays.includes(lp.dow)) continue;
    if (!inHourWindow(lp.hour, p.startHour, p.endHour)) continue;
    return {
      periodId: p.id,
      periodLabel: p.label,
      season,
      centsPerKwh: pickCents(p.centsBySeason),
      isOnPeak: p.onPeak === true,
      ratesConfirmed: model.ratesConfirmed,
    };
  }

  return {
    periodId: model.offPeak.id,
    periodLabel: model.offPeak.label,
    season,
    centsPerKwh: pickCents(model.offPeak.centsBySeason),
    isOnPeak: false,
    ratesConfirmed: model.ratesConfirmed,
  };
}

/**
 * The APS R-EV period ids, named once. `buildApsREvModel` builds its periods from these, and
 * every consumer that asks which period an instant is in (`rateAt(...).periodId`) compares against
 * them rather than a string literal: the overnight charge window, the mid-day super off-peak
 * window (chargeWindows.ts), the nightly plan's tariff snapshot and the /api/tariff view.
 */
export const APS_PERIOD = Object.freeze({
  ON_PEAK: 'on_peak',
  SUPER_OFF_PEAK: 'super_off_peak',
  OVERNIGHT: 'overnight',
  OFF_PEAK: 'off_peak',
} as const);
export type ApsPeriodId = (typeof APS_PERIOD)[keyof typeof APS_PERIOD];

const MON_FRI = [1, 2, 3, 4, 5];
/** APS seasons, by USAGE month: SUMMER = Apr–Sep, WINTER = Oct–Mar.
 *
 *  v1.187.10 — APS seasons follow BILLING CYCLES: the May–October bills are summer and
 *  the November–April bills winter. Each bill covers the usage since the previous meter
 *  read, early in the month, so summer usage runs from the early-April read to the
 *  early-October read. This was [5..10] — calendar months read as if they were bills — so
 *  October usage, which APS bills at winter rates ("You're now on winter rates", sent
 *  2026-10-02: winter from the November billing period), was priced as summer: on-peak at
 *  the summer rate and no 10:00–15:00 super-off-peak tier, and April as winter.
 *  ★ Approximation: the boundary is the 1st of the month; the real one is the meter-read
 *  day (early in the month, varies by cycle), so the first few days of April and October
 *  can be seasoned one cycle off. Rates stay null until confirmed. */
export const APS_SUMMER_MONTHS = [4, 5, 6, 7, 8, 9];

/**
 * v1.187.13 — APS off-peak holidays for a calendar year, as Rate Schedule R-EV states them
 * (A.C.C. No. 6152, effective 2024-03-08, Decision No. 79293): all-day off-peak, so no
 * on-peak, overnight or super off-peak hours on these dates.
 *  - Fixed dates, observed: New Year's Day (Jan 1), Cesar Chavez Day (Mar 31), Juneteenth
 *    (Jun 19), Independence Day (Jul 4), Veterans Day (Nov 11), Christmas Day (Dec 25). On a
 *    Saturday the preceding Friday is off-peak; on a Sunday, the following Monday.
 *  - Nth weekday: Martin Luther King Day (3rd Mon Jan), Presidents Day (3rd Mon Feb),
 *    Memorial Day (last Mon May), Labor Day (1st Mon Sep), Indigenous Peoples' / Columbus
 *    Day (2nd Mon Oct), Thanksgiving (4th Thu Nov).
 *  - On the day itself: Christmas Eve (Dec 24), New Year's Eve (Dec 31).
 * Local calendar dates 'YYYY-MM-DD'; an observed New Year's Day can fall in the year before.
 * PURE.
 */
export function apsOffPeakHolidays(year: number): string[] {
  const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
  const day = (m: number, d: number): number => Date.UTC(year, m - 1, d);
  const DAY = 86_400_000;
  const observed = (t: number): number => {
    const dow = new Date(t).getUTCDay();
    return dow === 6 ? t - DAY : dow === 0 ? t + DAY : t;
  };
  const nthWeekday = (m: number, weekday: number, n: number): number => {
    const first = day(m, 1);
    const offset = (weekday - new Date(first).getUTCDay() + 7) % 7;
    return first + (offset + (n - 1) * 7) * DAY;
  };
  const lastWeekday = (m: number, weekday: number): number => {
    const last = Date.UTC(year, m, 0); // day 0 of the next month = the last day of m
    return last - ((new Date(last).getUTCDay() - weekday + 7) % 7) * DAY;
  };
  const out = [
    observed(day(1, 1)), observed(day(3, 31)), observed(day(6, 19)), observed(day(7, 4)),
    observed(day(11, 11)), observed(day(12, 25)),
    nthWeekday(1, 1, 3), nthWeekday(2, 1, 3), lastWeekday(5, 1), nthWeekday(9, 1, 1),
    nthWeekday(10, 1, 2), nthWeekday(11, 4, 4),
    day(12, 24), day(12, 31),
  ].map(iso);
  return [...new Set(out)].sort();
}

/** v1.187.13 — the R-EV holiday rule over a span of years wide enough for any date the
 *  add-on prices (history and forecast horizons alike). */
export const APS_OFF_PEAK_HOLIDAYS: readonly string[] = Object.freeze(
  Array.from({ length: 2045 - 2015 + 1 }, (_, i) => apsOffPeakHolidays(2015 + i)).flat().sort(),
);

/** v1.191.0 (R3) — the last year APS_OFF_PEAK_HOLIDAYS precomputes. */
export const APS_HOLIDAY_TABLE_LAST_YEAR = 2045;
/** The holiday lists that follow the R-EV rule (apsHolidayList): past the table's last year, rateAt
 *  computes the rule's dates for the year on demand instead of finding none. A list, not a model
 *  field, so the model JSON (golden G2) is unchanged. */
const APS_RULE_LISTS = new WeakSet<readonly string[]>();
const APS_RULE_YEARS = new Map<number, ReadonlySet<string>>();

/** v1.191.0 — the R-EV holiday list for a model: today's 2015–2045 table, carrying the rule beyond it. */
export function apsHolidayList(): string[] {
  const list = [...APS_OFF_PEAK_HOLIDAYS];
  APS_RULE_LISTS.add(list);
  return list;
}

/**
 * v1.191.0 (R3) — is this local date an observed holiday of the model? The listed dates, and for a
 * list that follows the R-EV rule, the rule's dates of any year after 2045 (computed once per year).
 * Identical to the list alone from 2015 to 2045; declared: from 2046 the holidays are computed rather
 * than missing.
 */
export function isModelHoliday(model: Pick<TariffModel, 'holidays'>, lp: Pick<LocalParts, 'year' | 'ymd'>): boolean {
  if (model.holidays.includes(lp.ymd)) return true;
  if (lp.year <= APS_HOLIDAY_TABLE_LAST_YEAR || !APS_RULE_LISTS.has(model.holidays)) return false;
  let year = APS_RULE_YEARS.get(lp.year);
  if (!year) { year = new Set(apsOffPeakHolidays(lp.year)); APS_RULE_YEARS.set(lp.year, year); }
  return year.has(lp.ymd);
}

export interface ApsREvRates {
  onPeak?: SeasonalCents;
  superOffPeak?: SeasonalCents; // winter only
  overnight?: SeasonalCents;
  offPeak?: SeasonalCents;
  fixedDailyCents?: number | null;
  holidays?: string[];
  confirmed?: boolean;
}

const NULL_SEASON: SeasonalCents = { summer: null, winter: null };

/** Build the APS R-EV model. Rates default to null (ratesConfirmed=false), so
 *  the model is structurally complete but emits null $ until the owner confirms
 *  effective per-period cents from a bill. */
export function buildApsREvModel(rates: ApsREvRates = {}): TariffModel {
  return {
    planId: 'aps_r_ev',
    timezone: siteTimeZone(),
    // Priority order: on-peak > winter super-off-peak > overnight. (Disjoint in
    // R-EV, so order is only a safety net against future overlapping edits.)
    periods: [
      {
        id: APS_PERIOD.ON_PEAK,
        label: 'On-Peak (4–7pm Mon–Fri)',
        startHour: 16,
        endHour: 19,
        weekdays: MON_FRI,
        seasons: null, // year-round
        centsBySeason: rates.onPeak ?? NULL_SEASON,
        onPeak: true,
      },
      {
        id: APS_PERIOD.SUPER_OFF_PEAK,
        label: 'Super Off-Peak (10am–3pm Mon–Fri, winter)',
        startHour: 10,
        endHour: 15,
        weekdays: MON_FRI,
        seasons: ['winter'],
        centsBySeason: rates.superOffPeak ?? NULL_SEASON,
      },
      {
        id: APS_PERIOD.OVERNIGHT,
        label: 'Overnight (11pm–5am Mon–Fri)',
        startHour: 23,
        endHour: 5,
        weekdays: MON_FRI,
        seasons: null,
        centsBySeason: rates.overnight ?? NULL_SEASON,
      },
    ],
    offPeak: {
      id: APS_PERIOD.OFF_PEAK,
      label: 'Off-Peak (nights/weekends/holidays)',
      centsBySeason: rates.offPeak ?? NULL_SEASON,
    },
    summerMonths: APS_SUMMER_MONTHS,
    // v1.187.13 — the R-EV holiday rule (APS_OFF_PEAK_HOLIDAYS) unless the rates name their own list.
    // v1.191.0 — apsHolidayList(): the same dates, carrying the rule past 2045 (isModelHoliday).
    holidays: rates.holidays ?? apsHolidayList(),
    demand: null, // R-EV has no demand charge
    // Null-over-fabrication (review-hardening): a money value is surfaced only
    // once rates are confirmed, so an unconfirmed model can never leak a
    // fabricated basic-service charge to a daily-cost consumer.
    fixedDailyCents: (rates.confirmed ?? false) ? (rates.fixedDailyCents ?? null) : null,
    ratesConfirmed: rates.confirmed ?? false,
  };
}

/** Read the APS R-EV per-period effective cents from the config env (all default
 *  "" / unconfirmed → ratesConfirmed=false → every $ output null).
 *
 *  ★ v1.70.0 — moved here from index.ts. It was private there, so the on-peak
 *  grid-draw detector in alertMonitor would have had to duplicate it, and two
 *  copies of a tariff reader is exactly how two engines end up disagreeing about
 *  when on-peak starts. One reader, one model, every consumer.
 *
 *  v1.191.0 (S5) — read through config.ts (the TARIFF_APS_* rows: blank is null, any finite value
 *  counts), and the confirmation is the one in effect (`tariffRatesConfirmation`): TARIFF_RATES_CONFIRMED
 *  when set, else TARIFF_APS_RATES_CONFIRMED. These keys stay the inputs of the aps_r_ev preset. */
export function apsREvRatesFromEnv(): ApsREvRates {
  const cent = (name: string): number | null => option<number | null>(name);
  return {
    onPeak: { summer: cent('TARIFF_APS_ONPEAK_SUMMER_CENTS'), winter: cent('TARIFF_APS_ONPEAK_WINTER_CENTS') },
    offPeak: { summer: cent('TARIFF_APS_OFFPEAK_SUMMER_CENTS'), winter: cent('TARIFF_APS_OFFPEAK_WINTER_CENTS') },
    overnight: { summer: cent('TARIFF_APS_OVERNIGHT_CENTS'), winter: cent('TARIFF_APS_OVERNIGHT_CENTS') },
    superOffPeak: { summer: null, winter: cent('TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS') },
    confirmed: tariffRatesConfirmation().confirmed,
  };
}

/** Deprecated alias of `tariffModelFromEnv` (v1.191.0): the model of the plan in effect, which is the
 *  APS R-EV preset while TARIFF_PLAN is unset. */
export function apsREvModelFromEnv(): TariffModel {
  return tariffModelFromEnv();
}

/**
 * v1.187.0 — a model's on-peak period in the legacy report notation: hours as
 * "start-end" (end-exclusive, local) and days as "first-last" on the 1=Mon…7=Sun scale
 * `onPeakAt` uses. PURE. Null when the model has no on-peak period.
 *
 * /api/tariff printed the TARIFF_ON_PEAK_HOURS default ("15-20") verbatim while every
 * priced and gated path used this model's 16:00-19:00 — two hours of "on-peak" that
 * nothing charged. The model's `weekdays` run 0=Sun…6=Sat; a set that is not one
 * contiguous run on the Mon-first scale is listed ("1,3,5") rather than bent into a range.
 * Observed holidays are all-day off-peak in the model and have no place in this string.
 */
export function onPeakWindowStrings(model: TariffModel): { hours: string; days: string } | null {
  const p = model.periods.find((x) => x.onPeak === true);
  if (!p) return null;
  const hours = `${p.startHour}-${p.endHour}`;
  if (p.weekdays == null) return { hours, days: '1-7' };
  const monFirst = [...new Set(p.weekdays.map((d) => (d === 0 ? 7 : d)))].sort((a, b) => a - b);
  if (monFirst.length === 0) return { hours, days: '' };
  const contiguous = monFirst.every((d, i) => i === 0 || d === monFirst[i - 1] + 1);
  const days = contiguous ? `${monFirst[0]}-${monFirst[monFirst.length - 1]}` : monFirst.join(',');
  return { hours, days };
}

/** A single-rate flat model — the legacy default (17¢ both bins) as a TariffModel,
 *  so the eventual consumer rewire is a behavior-preserving swap under flat rates. */
export function flatTariffModel(centsPerKwh: number | null, timezone: string = siteTimeZone()): TariffModel {
  const both: SeasonalCents = { summer: centsPerKwh, winter: centsPerKwh };
  return {
    planId: 'flat',
    timezone,
    periods: [],
    offPeak: { id: 'off_peak', label: 'Flat', centsBySeason: both },
    summerMonths: APS_SUMMER_MONTHS,
    holidays: [],
    demand: null,
    fixedDailyCents: null,
    ratesConfirmed: centsPerKwh != null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.191.0 (S5) — THE TARIFF PLAN, READ FROM THE OPTIONS.
 *
 * `tariffModelFromEnv()` is the one tariff reader (plan 2.5). TARIFF_PLAN picks a preset:
 *
 *   unset / aps_r_ev  today's R-EV table (`buildApsREvModel`), rates from TARIFF_APS_*, labels kept
 *                     literal; with every generic key below unset the model is deep-equal to
 *                     today's (golden G2);
 *   flat              one rate, TARIFF_FLAT_CENTS_PER_KWH, every hour; no cheap window;
 *   two_tier          one on-peak period from TARIFF_ON_PEAK_HOURS / TARIFF_ON_PEAK_DAYS ('15-20' /
 *                     '1-5' when unset), rates TARIFF_ON_PEAK_CENTS / TARIFF_OFF_PEAK_CENTS (the MPC
 *                     names …_CENTS_PER_KWH are accepted as aliases here); no cheap window;
 *   custom            TARIFF_PERIODS and TARIFF_RATES in the grammar below; the cheap window is the
 *                     period flagged `cheap`.
 *
 * Generic keys, every plan: TARIFF_SUMMER_MONTHS (4-9 when unset; a range may wrap the year, 10-3),
 * TARIFF_HOLIDAYS (`aps`, `none` or a comma list of YYYY-MM-DD dates; unset is `aps` for aps_r_ev and
 * `none` otherwise), TARIFF_FIXED_DAILY_CENTS (surfaced only once confirmed), TARIFF_RATES_CONFIRMED
 * (unset takes TARIFF_APS_RATES_CONFIRMED), NIGHT_CHARGE_CHEAP_PERIOD (overrides the cheap period).
 *
 * The grammar (semicolons separate entries; `off_peak` is the implicit base period):
 *   TARIFF_PERIODS  on_peak 16-19 mon-fri all onpeak; super_off_peak 10-15 mon-fri winter; overnight 23-05 mon-fri all cheap
 *                   <id> <start>-<end> <days> <season> [onpeak] [cheap] — hours local, end-exclusive,
 *                   a start above the end wraps midnight, end 24 is midnight; days `all`, a name
 *                   (`mon`…`sun`), a range (`mon-fri`, wrapping `fri-mon`) or a comma list of those;
 *                   season `all`, `summer` or `winter`; listed order is the priority order.
 *   TARIFF_RATES    on_peak=31.17/22.47; off_peak=16.91/15.07; overnight=12.59; super_off_peak=-/8.2
 *                   <id>=<summer>/<winter> or <id>=<both>; `-` is "no rate this season"; any finite
 *                   number counts (a 0 ¢ period is priced at 0); every period and off_peak must appear.
 *
 * ★ P5 FAIL CLOSED. A spec that does not parse — an unknown plan, a bad range, a missing rate, a cheap
 * period that does not exist, TARIFF_PERIODS set without TARIFF_PLAN custom — never falls back to the
 * APS table. The model becomes `failClosedTariffModel`: no periods and no rates, ratesConfirmed false,
 * so every price is null, the cost figures use the legacy flat ladder exactly as an unconfirmed
 * install does, no cheap window resolves (the night-charge plan holds: "no valid cheap charge window"),
 * and `tariffRepairIssues()` raises a repair issue that names the option.
 * ═════════════════════════════════════════════════════════════════════════ */

/** TARIFF_PLAN's values (unset is aps_r_ev). */
export const TARIFF_PLANS = ['aps_r_ev', 'flat', 'two_tier', 'custom'] as const;
export type TariffPlanId = (typeof TARIFF_PLANS)[number];

/** The confirmation key that decides `ratesConfirmed`, by name (score notes and logs name the one in effect). */
export type ConfirmationKey = 'TARIFF_RATES_CONFIRMED' | 'TARIFF_APS_RATES_CONFIRMED';

/** Whether the rates come from a bill, and which option said so: TARIFF_RATES_CONFIRMED when set, else
 *  TARIFF_APS_RATES_CONFIRMED (only the string 'true' counts for either). */
export function tariffRatesConfirmation(): { confirmed: boolean; key: ConfirmationKey } {
  const own = option<boolean | null>('TARIFF_RATES_CONFIRMED');
  if (own != null) return { confirmed: own, key: 'TARIFF_RATES_CONFIRMED' };
  return { confirmed: option<boolean>('TARIFF_APS_RATES_CONFIRMED'), key: 'TARIFF_APS_RATES_CONFIRMED' };
}

/** The cheap period the night-charge engine charges in: the model's own, or the APS preset's
 *  'overnight' when the model names none. Null: the plan has no cheap window. */
export function cheapPeriodIdOf(model: Pick<TariffModel, 'cheapPeriodId'>): string | null {
  return model.cheapPeriodId === undefined ? APS_PERIOD.OVERNIGHT : model.cheapPeriodId;
}

/** A cent value the cost-figure (KPI) path accepts: finite and above zero (OWNER DECISION 8 keeps this
 *  rule on that path; the model path accepts any finite value). */
export function positiveCents(n: number | null | undefined): number | null {
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The two-tier pair a model gives at an instant: its season, the in-season on-peak period's cents (the
 * off-peak cents when no on-peak period is in season) and the off-peak cents. PURE. On the APS preset
 * this is exactly what the cost figures read from TARIFF_APS_ON/OFFPEAK_<season>_CENTS until v1.191.0.
 */
export function twoTierPairOf(model: TariffModel, tsMs: number): { season: Season; onPeak: number | null; offPeak: number | null } {
  const season = seasonAt(model, tsMs);
  const on = model.periods.find((p) => p.onPeak === true && (!p.seasons || p.seasons.includes(season)));
  return { season, onPeak: (on ?? model.offPeak).centsBySeason[season], offPeak: model.offPeak.centsBySeason[season] };
}

/** The legacy ladder: the tariff settings the cost figures and the MPC fall back to while no confirmed
 *  rate prices an hour, each with the rule its consumer applied until v1.191.0. */
export interface LegacyTariff {
  /** TARIFF_FLAT_CENTS_PER_KWH: bare Number (a blank reads 0), 17 when absent. Three copies until v1.191.0. */
  flatCents: number;
  /** The cost figures' explicit two-tier pair (TARIFF_ON_PEAK_CENTS / TARIFF_OFF_PEAK_CENTS): above zero only. */
  kpi: { onPeak: number | null; offPeak: number | null };
  /** The MPC vector's two-tier pair (the …_CENTS_PER_KWH names): bare Number, the flat rate when absent. */
  mpc: { onPeak: number; offPeak: number };
  /** TARIFF_EXPORT_CENTS_PER_KWH: bare Number, 0 when absent (no export credit). */
  exportCents: number;
  /** TARIFF_ON_PEAK_HOURS / TARIFF_ON_PEAK_DAYS as exported ('15-20' / '1-5' when absent). */
  onPeakHours: string;
  onPeakDays: string;
}

/**
 * v1.191.0 (F1–F4) — the one reader of the legacy tariff settings. The analytics reader and the MPC
 * reader of the two-tier cents keep their own names and rules while TARIFF_PLAN is unset: golden G2's
 * twoTierAnalyticsNames / twoTierMpcNames variants pin that each path ignores the other's names, so the
 * names are accepted as aliases only by the two_tier preset (declared, not unified).
 */
export function legacyTariffFromEnv(): LegacyTariff {
  return {
    flatCents: option<number>('TARIFF_FLAT_CENTS_PER_KWH'),
    kpi: { onPeak: option<number | null>('TARIFF_ON_PEAK_CENTS'), offPeak: option<number | null>('TARIFF_OFF_PEAK_CENTS') },
    mpc: { onPeak: option<number>('TARIFF_ON_PEAK_CENTS_PER_KWH'), offPeak: option<number>('TARIFF_OFF_PEAK_CENTS_PER_KWH') },
    exportCents: option<number>('TARIFF_EXPORT_CENTS_PER_KWH'),
    onPeakHours: option<string>('TARIFF_ON_PEAK_HOURS'),
    onPeakDays: option<string>('TARIFF_ON_PEAK_DAYS'),
  };
}

/**
 * v1.191.0 (F2) — the on-peak window the legacy two-tier fallback judges an hour against (onPeakAt) and
 * the report states while rates are unconfirmed: TARIFF_ON_PEAK_HOURS / _DAYS when either is set; for a
 * plan other than aps_r_ev, the plan's own on-peak period (`onPeakWindowStrings`); otherwise the legacy
 * '15-20' / '1-5'. Unchanged on an install with TARIFF_PLAN unset.
 */
export function legacyOnPeakWindow(model: TariffModel, legacy: LegacyTariff = legacyTariffFromEnv()): { hours: string; days: string } {
  const explicit = optionRaw('TARIFF_ON_PEAK_HOURS') !== undefined || optionRaw('TARIFF_ON_PEAK_DAYS') !== undefined;
  if (!explicit && model.planId !== 'aps_r_ev') {
    const w = onPeakWindowStrings(model);
    if (w) return w;
  }
  return { hours: legacy.onPeakHours, days: legacy.onPeakDays };
}

/** A spec error: the message names the option and what is wrong with it. */
export class TariffSpecError extends Error {}
const specError = (msg: string): never => { throw new TariffSpecError(msg); };

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const PERIOD_ID = /^[a-z][a-z0-9_]*$/;

/** `HH-HH` (local, end-exclusive; start 0–23, end 0–24; a start above the end wraps midnight). */
export function parseHourWindow(s: string, what: string): { startHour: number; endHour: number } {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return specError(`${what}: hours ${JSON.stringify(s)} are not HH-HH`);
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (startHour > 23 || endHour > 24) return specError(`${what}: hours ${JSON.stringify(s)} are outside 0-24`);
  if (startHour === endHour) return specError(`${what}: hours ${JSON.stringify(s)} are an empty window (use 0-24 for a whole day)`);
  return { startHour, endHour };
}

/** Days: `all`, a name, a range (wrapping allowed) or a comma list of those → 0=Sun…6=Sat, sorted; null = every day. */
export function parseDays(s: string, what: string): number[] | null {
  if (s === 'all' || s === 'daily') return null;
  const idx = (t: string): number => {
    const i = (DAY_NAMES as readonly string[]).indexOf(t);
    return i >= 0 ? i : specError(`${what}: ${JSON.stringify(t)} is not a day (mon … sun)`);
  };
  const set = new Set<number>();
  for (const part of s.split(',')) {
    const r = part.trim().split('-');
    if (r.length === 1) { set.add(idx(r[0])); continue; }
    if (r.length !== 2) return specError(`${what}: ${JSON.stringify(part)} is not a day or a day range`);
    let d = idx(r[0]);
    const end = idx(r[1]);
    for (;;) { set.add(d); if (d === end) break; d = (d + 1) % 7; }
  }
  const out = [...set].sort((a, b) => a - b);
  return out.length === 7 ? null : out;
}

/** Months: `M` or `M-N` (a range may wrap the year: `10-3`), comma separated, or `none` → sorted 1–12. */
export function parseMonths(s: string, what = 'TARIFF_SUMMER_MONTHS'): number[] {
  if (s === 'none') return [];
  const month = (t: string): number => {
    const n = Number(t);
    return /^\d{1,2}$/.test(t) && n >= 1 && n <= 12 ? n : specError(`${what}: ${JSON.stringify(t)} is not a month (1-12)`);
  };
  const set = new Set<number>();
  for (const part of s.split(',')) {
    const r = part.trim().split('-');
    if (r.length === 1) { set.add(month(r[0])); continue; }
    if (r.length !== 2) return specError(`${what}: ${JSON.stringify(part)} is not a month or a month range`);
    let m = month(r[0]);
    const end = month(r[1]);
    for (;;) { set.add(m); if (m === end) break; m = (m % 12) + 1; }
  }
  return [...set].sort((a, b) => a - b);
}

/** TARIFF_HOLIDAYS: `aps` (the R-EV rule), `none`, or a comma list of real YYYY-MM-DD dates. */
export function parseHolidays(s: string): string[] {
  if (s === 'aps') return apsHolidayList();
  if (s === 'none') return [];
  const out = new Set<string>();
  for (const part of s.split(',')) {
    const t = part.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    const real = m != null && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === t;
    if (!real) specError(`TARIFF_HOLIDAYS: ${JSON.stringify(t)} is not aps, none or a YYYY-MM-DD date`);
    out.add(t);
  }
  return [...out].sort();
}

/** One rate token: a finite number, or `-` (no rate). */
function parseCentToken(t: string, what: string): number | null {
  if (t === '-') return null;
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? n : specError(`${what}: ${JSON.stringify(t)} is not a number or -`);
}

/** TARIFF_RATES → id → per-season cents. */
export function parseRates(s: string): Map<string, SeasonalCents> {
  const out = new Map<string, SeasonalCents>();
  for (const raw of s.split(';')) {
    const e = raw.trim();
    if (e === '') continue;
    const m = /^([a-z][a-z0-9_]*)\s*=\s*(\S+)$/.exec(e);
    if (!m) specError(`TARIFF_RATES: ${JSON.stringify(e)} is not <period>=<summer>/<winter> or <period>=<both>`);
    const [, id, v] = m!;
    if (out.has(id)) specError(`TARIFF_RATES: ${id} has two rates`);
    const parts = v.split('/');
    if (parts.length > 2) specError(`TARIFF_RATES: ${id}=${v} has more than two seasons`);
    const summer = parseCentToken(parts[0], `TARIFF_RATES ${id}`);
    const winter = parts.length === 2 ? parseCentToken(parts[1], `TARIFF_RATES ${id}`) : summer;
    out.set(id, { summer, winter });
  }
  return out;
}

const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;
function daysLabel(weekdays: number[] | null | undefined): string {
  if (weekdays == null) return 'every day';
  const monFirst = weekdays.map((d) => (d === 0 ? 7 : d)).sort((a, b) => a - b);
  const contiguous = monFirst.length > 1 && monFirst.every((d, i) => i === 0 || d === monFirst[i - 1] + 1);
  const name = (d: number) => DAY_LABELS[d % 7];
  return contiguous ? `${name(monFirst[0])}–${name(monFirst[monFirst.length - 1])}` : monFirst.map(name).join(', ');
}
/** A custom period's label, from its hours (the APS preset keeps its literal labels). */
export function periodLabel(p: Pick<TariffPeriod, 'id' | 'startHour' | 'endHour' | 'weekdays' | 'seasons'>): string {
  const name = p.id.replace(/_/g, ' ');
  const season = p.seasons && p.seasons.length === 1 ? `, ${p.seasons[0]}` : '';
  return `${name[0].toUpperCase()}${name.slice(1)} (${hh(p.startHour)}–${hh(p.endHour)} ${daysLabel(p.weekdays)}${season})`;
}

/** TARIFF_PERIODS + TARIFF_RATES → the custom plan's periods, off-peak cents and cheap period. */
export function parsePeriods(periodsSpec: string, ratesSpec: string): { periods: TariffPeriod[]; offPeak: SeasonalCents; cheapPeriodId: string | null } {
  const rates = parseRates(ratesSpec);
  const periods: TariffPeriod[] = [];
  let cheap: string | null = null;
  let onPeakSeen = false;
  for (const raw of periodsSpec.split(';')) {
    const e = raw.trim();
    if (e === '') continue;
    const tok = e.split(/\s+/);
    if (tok.length < 4) specError(`TARIFF_PERIODS: ${JSON.stringify(e)} needs <id> <hours> <days> <season> [onpeak] [cheap]`);
    const [id, hours, days, season, ...flags] = tok;
    const what = `TARIFF_PERIODS ${id}`;
    if (!PERIOD_ID.test(id)) specError(`TARIFF_PERIODS: ${JSON.stringify(id)} is not a period id (lower case, digits, _)`);
    if (id === APS_PERIOD.OFF_PEAK) specError('TARIFF_PERIODS: off_peak is the implicit base period; give it a rate in TARIFF_RATES only');
    if (periods.some((p) => p.id === id)) specError(`TARIFF_PERIODS: ${id} is listed twice`);
    const { startHour, endHour } = parseHourWindow(hours, what);
    const weekdays = parseDays(days, what);
    const seasons: Season[] | null = season === 'all' ? null
      : season === 'summer' || season === 'winter' ? [season] : specError(`${what}: season ${JSON.stringify(season)} is not all, summer or winter`);
    let onPeak = false;
    for (const f of flags) {
      if (f === 'onpeak') {
        if (onPeakSeen) specError('TARIFF_PERIODS: more than one period is flagged onpeak');
        onPeak = true; onPeakSeen = true;
      } else if (f === 'cheap') {
        if (cheap != null) specError('TARIFF_PERIODS: more than one period is flagged cheap');
        cheap = id;
      } else specError(`${what}: ${JSON.stringify(f)} is not a flag (onpeak, cheap)`);
    }
    const cents = rates.get(id);
    if (!cents) specError(`TARIFF_RATES: no rate for ${id} (write ${id}=<summer>/<winter>, or ${id}=- for none)`);
    const period: TariffPeriod = { id, label: '', startHour, endHour, weekdays, seasons, centsBySeason: cents! };
    if (onPeak) period.onPeak = true;
    period.label = periodLabel(period);
    periods.push(period);
  }
  if (periods.length === 0) specError('TARIFF_PERIODS: no period is listed');
  const offPeak = rates.get(APS_PERIOD.OFF_PEAK);
  if (!offPeak) specError('TARIFF_RATES: no rate for off_peak (every hour no period covers)');
  for (const id of rates.keys()) {
    if (id !== APS_PERIOD.OFF_PEAK && !periods.some((p) => p.id === id)) specError(`TARIFF_RATES: ${id} is not a period in TARIFF_PERIODS`);
  }
  return { periods, offPeak: offPeak!, cheapPeriodId: cheap };
}

/** Legacy `first-last` days on the 1=Mon…7=Sun scale (a range may wrap) → 0=Sun…6=Sat; null = every day. */
function legacyDays(s: string): number[] | null {
  const m = /^([1-7])-([1-7])$/.exec(s);
  if (!m) return specError(`TARIFF_ON_PEAK_DAYS: ${JSON.stringify(s)} is not first-last on 1=Mon … 7=Sun`);
  const set = new Set<number>();
  let d = Number(m[1]);
  const end = Number(m[2]);
  for (;;) { set.add(d % 7); if (d === end) break; d = (d % 7) + 1; }
  const out = [...set].sort((a, b) => a - b);
  return out.length === 7 ? null : out;
}

/** A raw cent for a plan's rate (the model path: any finite number; blank or absent is null). */
function rawCent(name: string): number | null | 'invalid' {
  const raw = optionRaw(name);
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 'invalid';
}
function requiredCent(names: string[], plan: string): number {
  for (const name of names) {
    const v = rawCent(name);
    if (v === 'invalid') return specError(`${name}: ${JSON.stringify(optionRaw(name))} is not a number`);
    if (v != null) return v;
  }
  return specError(`TARIFF_PLAN ${plan} needs ${names[0]}`);
}

/** The fail-closed model (P5): no periods, no rates, nothing confirmed, no cheap window. Never the APS table. */
export function failClosedTariffModel(): TariffModel {
  const base = flatTariffModel(null);
  return {
    ...base,
    planId: 'invalid',
    offPeak: { id: APS_PERIOD.OFF_PEAK, label: 'Tariff settings invalid', centsBySeason: NULL_SEASON },
    ratesConfirmed: false,
    cheapPeriodId: null,
  };
}

/** The resolved tariff: the model every consumer reads, and why the spec failed if it did. */
export interface TariffResolution {
  /** TARIFF_PLAN as set, or 'aps_r_ev' while unset. */
  plan: string;
  /** TARIFF_PLAN was set (an explicit aps_r_ev silences the reference-home notice). */
  planSet: boolean;
  /** The model; `failClosedTariffModel()` when `error` is set. */
  model: TariffModel;
  /** Why the spec cannot be used (the option and the fault), or null. */
  error: string | null;
  confirmationKey: ConfirmationKey;
}

const CUSTOM_CACHE = new Map<string, ReturnType<typeof parsePeriods>>();
function parsePeriodsCached(periods: string, rates: string): ReturnType<typeof parsePeriods> {
  const key = `${periods}\u0000${rates}`;
  let v = CUSTOM_CACHE.get(key);
  if (!v) {
    v = parsePeriods(periods, rates);
    if (CUSTOM_CACHE.size > 16) CUSTOM_CACHE.clear();
    CUSTOM_CACHE.set(key, v);
  }
  return v;
}

/** Build the plan's model from the options. Throws TariffSpecError on an unusable spec. */
function buildPlanModel(plan: string): TariffModel {
  const confirmed = tariffRatesConfirmation().confirmed;
  const periodsSpec = option<string | null>('TARIFF_PERIODS');
  const ratesSpec = option<string | null>('TARIFF_RATES');
  if (plan !== 'custom' && (periodsSpec != null || ratesSpec != null)) {
    specError(`${periodsSpec != null ? 'TARIFF_PERIODS' : 'TARIFF_RATES'} is set but TARIFF_PLAN is ${plan}; set TARIFF_PLAN to custom to use a period table`);
  }
  const summerSpec = option<string | null>('TARIFF_SUMMER_MONTHS');
  const summerMonths = summerSpec != null ? parseMonths(summerSpec) : undefined;
  const holidaySpec = option<string | null>('TARIFF_HOLIDAYS');
  const holidays = holidaySpec != null ? parseHolidays(holidaySpec) : undefined;
  const fixed = option<number | null>('TARIFF_FIXED_DAILY_CENTS');
  if (fixed != null && !Number.isFinite(fixed)) specError(`TARIFF_FIXED_DAILY_CENTS: ${JSON.stringify(optionRaw('TARIFF_FIXED_DAILY_CENTS'))} is not a number`);

  let model: TariffModel;
  if (plan === 'aps_r_ev') {
    // Today's model, verbatim, while the generic keys are unset.
    const rates: ApsREvRates = apsREvRatesFromEnv();
    if (holidays !== undefined) rates.holidays = holidays;
    if (fixed != null) rates.fixedDailyCents = fixed;
    model = buildApsREvModel(rates);
    if (summerMonths !== undefined) model.summerMonths = summerMonths;
  } else {
    const base = flatTariffModel(null); // its timezone is the site's (lane A moves that default)
    const common = {
      timezone: base.timezone,
      summerMonths: summerMonths ?? APS_SUMMER_MONTHS,
      holidays: holidays ?? [],
      demand: null,
      fixedDailyCents: confirmed ? fixed : null,
      ratesConfirmed: confirmed,
    };
    if (plan === 'flat') {
      const cents = requiredCent(['TARIFF_FLAT_CENTS_PER_KWH'], plan);
      model = { planId: 'flat', periods: [], offPeak: { id: APS_PERIOD.OFF_PEAK, label: 'Flat', centsBySeason: { summer: cents, winter: cents } }, ...common, cheapPeriodId: null };
    } else if (plan === 'two_tier') {
      const on = requiredCent(['TARIFF_ON_PEAK_CENTS', 'TARIFF_ON_PEAK_CENTS_PER_KWH'], plan);
      const off = requiredCent(['TARIFF_OFF_PEAK_CENTS', 'TARIFF_OFF_PEAK_CENTS_PER_KWH'], plan);
      const legacy = legacyTariffFromEnv();
      const { startHour, endHour } = parseHourWindow(legacy.onPeakHours, 'TARIFF_ON_PEAK_HOURS');
      const period: TariffPeriod = {
        id: APS_PERIOD.ON_PEAK, label: '', startHour, endHour, weekdays: legacyDays(legacy.onPeakDays), seasons: null,
        centsBySeason: { summer: on, winter: on }, onPeak: true,
      };
      period.label = periodLabel(period);
      model = { planId: 'two_tier', periods: [period], offPeak: { id: APS_PERIOD.OFF_PEAK, label: 'Off-peak (all other hours)', centsBySeason: { summer: off, winter: off } }, ...common, cheapPeriodId: null };
    } else if (plan === 'custom') {
      if (periodsSpec == null) specError('TARIFF_PLAN custom needs TARIFF_PERIODS');
      if (ratesSpec == null) specError('TARIFF_PLAN custom needs TARIFF_RATES');
      const p = parsePeriodsCached(periodsSpec!, ratesSpec!);
      model = {
        planId: 'custom', periods: p.periods.map((x) => ({ ...x })),
        offPeak: { id: APS_PERIOD.OFF_PEAK, label: 'Off-peak (all other hours)', centsBySeason: p.offPeak },
        ...common, cheapPeriodId: p.cheapPeriodId,
      };
    } else {
      return specError(`TARIFF_PLAN: ${JSON.stringify(plan)} is not one of ${TARIFF_PLANS.join(', ')}`);
    }
  }
  const cheapOverride = option<string | null>('NIGHT_CHARGE_CHEAP_PERIOD');
  if (cheapOverride != null) {
    const ids = [...model.periods.map((p) => p.id), model.offPeak.id];
    if (!ids.includes(cheapOverride)) specError(`NIGHT_CHARGE_CHEAP_PERIOD: ${JSON.stringify(cheapOverride)} is not a period of the ${model.planId} plan (${ids.join(', ')})`);
    model.cheapPeriodId = cheapOverride;
  }
  return model;
}

/** v1.191.0 (S5) — resolve the tariff from the options: the plan, its model, and the fault if the spec is unusable. */
export function resolveTariffFromEnv(): TariffResolution {
  const planRaw = option<string | null>('TARIFF_PLAN');
  const plan = planRaw ?? 'aps_r_ev';
  const confirmationKey = tariffRatesConfirmation().key;
  try {
    return { plan, planSet: planRaw != null, model: buildPlanModel(plan), error: null, confirmationKey };
  } catch (e) {
    if (!(e instanceof TariffSpecError)) throw e;
    return { plan, planSet: planRaw != null, model: failClosedTariffModel(), error: e.message, confirmationKey };
  }
}

/** v1.191.0 (S5) — THE tariff model: the plan the options name (the APS R-EV preset while TARIFF_PLAN is
 *  unset), or the fail-closed model when the spec is unusable. Read at call time. */
export function tariffModelFromEnv(): TariffModel {
  return resolveTariffFromEnv().model;
}

/** The option that sets the rates of a plan, for a message that tells the operator what to fill in. */
export function rateOptionsHint(planId: string): string {
  switch (planId) {
    case 'flat': return 'TARIFF_FLAT_CENTS_PER_KWH';
    case 'two_tier': return 'TARIFF_ON_PEAK_CENTS / TARIFF_OFF_PEAK_CENTS';
    case 'custom': return 'TARIFF_RATES';
    default: return 'TARIFF_APS_*_CENTS';
  }
}

/** The zone the APS R-EV preset's windows were written for (CA20): the reference install's, the site
 *  clock's default (config.ts holds the one copy of the literal; siteTimeLiteral.test.ts). */
export const APS_R_EV_ZONE = DEFAULT_SITE_TIME_ZONE;
/** CA20 — one repair-issue id for "the reference home's defaults are in effect" (lane C raises it, with
 *  the PV half; this module supplies the tariff half's predicate). */
export const REFERENCE_HOME_DEFAULTS_ISSUE_ID = 'reference-home-defaults';

/**
 * CA20, the tariff half: the site runs in a zone other than the one the APS preset was written for and
 * TARIFF_PLAN is unset, so the APS R-EV windows are applied to a clock they do not describe. Pass the
 * resolved site zone. Silent on the reference install (its zone is APS_R_EV_ZONE). Main thread only (CA17).
 */
export function referenceHomeTariffDefaults(resolvedZone: string): boolean {
  return resolvedZone !== APS_R_EV_ZONE && option<string | null>('TARIFF_PLAN') == null;
}
/** The notice text for the tariff half of CA20, or null when it does not apply. */
export function referenceHomeTariffNotice(resolvedZone: string): string | null {
  if (!referenceHomeTariffDefaults(resolvedZone)) return null;
  return `the site time zone is ${resolvedZone} and TARIFF_PLAN is unset, so the reference home's APS R-EV tariff (on-peak 16:00-19:00, overnight 23:00-05:00, Monday to Friday) prices this site and times the night charge; set TARIFF_PLAN (flat, two_tier or custom) to describe this site's tariff, or aps_r_ev to keep it`;
}

/** The repair-issue ids this module raises. */
export const TARIFF_SPEC_ISSUE_ID = 'tariff-spec-invalid';
export const TARIFF_CURRENCY_ISSUE_ID = 'tariff-currency-invalid';
const issueFirstSeen = new Map<string, number>();
function firstSeen(key: string, nowMs: number): number {
  let t = issueFirstSeen.get(key);
  if (t == null) { t = nowMs; issueFirstSeen.set(key, t); }
  return t;
}

/** The repair issues for an unusable tariff spec and an unknown currency (main thread; GET /api/repair-issues). */
export function tariffRepairIssues(nowMs: number = Date.now()): RepairIssue[] {
  const out: RepairIssue[] = [];
  const t = resolveTariffFromEnv();
  if (t.error != null) {
    out.push({
      id: TARIFF_SPEC_ISSUE_ID,
      severity: 'warning',
      title: 'Tariff settings are not usable: prices are unknown and the night charge holds',
      summary: `${t.error}. Until it is corrected every price and cost-rate figure is unknown, the cost figures use the flat fallback rate, and no night-charge window is planned; the built-in APS R-EV table is not used in its place.`,
      fixSteps: [
        'Open the add-on Configuration and correct the option named above (the tariff options are under "Show unused optional configuration options").',
        'To return to the built-in APS R-EV preset, clear TARIFF_PLAN, TARIFF_PERIODS and TARIFF_RATES.',
        'Save and restart the add-on; the start-up log names the tariff plan in effect.',
      ],
      category: 'Configuration',
      estimatedTimeMinutes: 5,
      firstSeenAt: firstSeen(`${TARIFF_SPEC_ISSUE_ID}:${t.error}`, nowMs),
    });
  }
  const cur = tariffCurrency();
  if (cur.error != null) {
    out.push({
      id: TARIFF_CURRENCY_ISSUE_ID,
      severity: 'info',
      title: 'Unknown tariff currency: money units stay USD',
      summary: `${cur.error}.`,
      fixSteps: ['Set TARIFF_CURRENCY to one of the listed codes, or clear it for USD.', 'Changing the currency changes the unit of the Home Assistant money sensors; Home Assistant asks to repair their long-term statistics once.'],
      category: 'Configuration',
      estimatedTimeMinutes: 2,
      firstSeenAt: firstSeen(`${TARIFF_CURRENCY_ISSUE_ID}:${cur.error}`, nowMs),
    });
  }
  return out;
}
