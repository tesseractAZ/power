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
 * Seasons (APS billing cycles): SUMMER = May–Oct, WINTER = Nov–Apr.
 * R-EV carries NO demand charge (confirmed) — `demand` stays inert here.
 *
 * ★ DOW SEMANTICS (load-bearing, and an owner-confirmable edge): a period's
 * `weekdays` gate is evaluated against EACH INSTANT'S OWN local day-of-week,
 * NOT the day the window "started". So the wrap-around OVERNIGHT window resolves
 * literally: Fri 23:00 is overnight (Fri is Mon–Fri) but Sat 00:00–05:00 is
 * OFF-PEAK (Saturday is a weekend) — consistent with "off-peak = all weekends".
 * Likewise Sun 23:00 is off-peak while Mon 00:00–05:00 is overnight. This is the
 * defensible default; whether APS treats Fri-night→Sat-morning or
 * Sun-night→Mon-morning as a single overnight block is flagged for Eric to
 * confirm before the advisor sizes a Friday→Monday carry on it. Rates are null
 * until confirmed, so no $ output depends on this yet.
 *
 * ★ Every local field is resolved in an EXPLICIT IANA timezone via
 * Intl.DateTimeFormat — never the host clock — so a non-Phoenix container (or a
 * future DST zone) can't bleed a rate boundary. Phoenix has no DST, but the
 * resolver does not rely on that.
 * ═════════════════════════════════════════════════════════════════════════ */

export type Season = 'summer' | 'winter';

/** Per-season cents/kWh. `null` means "not yet confirmed from the owner's bill". */
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
  /** Local calendar months (1–12) that count as SUMMER; the rest are WINTER. */
  summerMonths: number[];
  /** Local 'YYYY-MM-DD' dates treated as all-day off-peak (observed holidays).
   *  ★ Confirm the exact APS observed-holiday list from a bill before relying
   *  on the $ output — defaults to [] (documented, not guessed). */
  holidays: string[];
  /** INERT for R-EV (no demand charge). Present so a demand-charge plan can be
   *  modeled later without a schema change; consumed by nothing today. */
  demand?: { centsPerKw: number | null; windowPeriodId: string } | null;
  /** Fixed daily basic-service charge (informational; not part of rateAt). */
  fixedDailyCents?: number | null;
  /** When false, EVERY resolved centsPerKwh is null regardless of the numbers
   *  in the model — the "emit null over a fabricated rate" discipline. */
  ratesConfirmed: boolean;
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

/** Resolve the tariff period + rate in effect at a timestamp. */
export function rateAt(model: TariffModel, tsMs: number): RateSlice {
  const lp = localParts(tsMs, model.timezone);
  const season = seasonOf(lp.month, model.summerMonths);

  const pickCents = (c: SeasonalCents): number | null =>
    model.ratesConfirmed ? c[season] : null;

  // Observed holidays are all-day off-peak, ahead of every specific period.
  if (model.holidays.includes(lp.ymd)) {
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

const MON_FRI = [1, 2, 3, 4, 5];
/** APS seasons: SUMMER = May–Oct, WINTER = Nov–Apr.
 *  ★ NOTE (documented approximation): APS defines seasons by BILLING CYCLE, not
 *  calendar month, so a handful of boundary days in early May / early Nov that
 *  still fall in the prior month's billing cycle are seasoned by calendar month
 *  here. Exact billing-cycle handling needs the meter read date (not modeled;
 *  deferred). Bounded to ≤ a few days/yr and rates are null until confirmed. */
export const APS_SUMMER_MONTHS = [5, 6, 7, 8, 9, 10];

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
    timezone: 'America/Phoenix',
    // Priority order: on-peak > winter super-off-peak > overnight. (Disjoint in
    // R-EV, so order is only a safety net against future overlapping edits.)
    periods: [
      {
        id: 'on_peak',
        label: 'On-Peak (4–7pm Mon–Fri)',
        startHour: 16,
        endHour: 19,
        weekdays: MON_FRI,
        seasons: null, // year-round
        centsBySeason: rates.onPeak ?? NULL_SEASON,
        onPeak: true,
      },
      {
        id: 'super_off_peak',
        label: 'Super Off-Peak (10am–3pm Mon–Fri, winter)',
        startHour: 10,
        endHour: 15,
        weekdays: MON_FRI,
        seasons: ['winter'],
        centsBySeason: rates.superOffPeak ?? NULL_SEASON,
      },
      {
        id: 'overnight',
        label: 'Overnight (11pm–5am Mon–Fri)',
        startHour: 23,
        endHour: 5,
        weekdays: MON_FRI,
        seasons: null,
        centsBySeason: rates.overnight ?? NULL_SEASON,
      },
    ],
    offPeak: {
      id: 'off_peak',
      label: 'Off-Peak (nights/weekends/holidays)',
      centsBySeason: rates.offPeak ?? NULL_SEASON,
    },
    summerMonths: APS_SUMMER_MONTHS,
    holidays: rates.holidays ?? [],
    demand: null, // R-EV has no demand charge
    // Null-over-fabrication (review-hardening): a money value is surfaced only
    // once rates are confirmed, so an unconfirmed model can never leak a
    // fabricated basic-service charge to a daily-cost consumer.
    fixedDailyCents: (rates.confirmed ?? false) ? (rates.fixedDailyCents ?? null) : null,
    ratesConfirmed: rates.confirmed ?? false,
  };
}

/** A single-rate flat model — the legacy default (17¢ both bins) as a TariffModel,
 *  so the eventual consumer rewire is a behavior-preserving swap under flat rates. */
export function flatTariffModel(centsPerKwh: number | null, timezone = 'America/Phoenix'): TariffModel {
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
