/**
 * siteTime.ts — the site clock in the browser (v1.191.0, lane A: T16, CA25).
 *
 * The server computes every local date, hour and clock time in ONE site zone (server/src/siteTime.ts:
 * SITE_TIMEZONE → the container's TZ → the default zone) and reports it: GET /api/site carries
 * `siteTimeZone`, and /api/night-charge/status stamps it on the payload. A card that sends a "start
 * of today" to the server, or shows a time the server reasons about, uses that zone — never the
 * browser's own, which differs from the site's whenever the viewer is elsewhere. Formatting is
 * `en-US` `formatToParts` only (the server's rule, CA16). PURE: no React, no fetch.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(zone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    FORMATTERS.set(zone, f);
  }
  return f;
}

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; ymd: string }

/** Local fields of an instant in `zone`. Throws on an invalid instant or zone, as Intl does. */
export function zonedParts(ms: number, zone: string): ZonedParts {
  const parts = partsFormatter(zone).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  const year = get('year'); const month = get('month'); const day = get('day');
  return {
    year, month, day, hour: get('hour'), minute: get('minute'),
    ymd: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function offsetMs(zone: string, ms: number): number {
  const p = zonedParts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** The instant local midnight starts `ymd` in `zone` (the first instant of that date there when a
 *  daylight-saving change skips midnight). NaN for a malformed date. */
export function zonedDayStartMs(ymd: string, zone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return NaN;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const o = offsetMs(zone, target - offsetMs(zone, target));
  const t = target - o;
  if (offsetMs(zone, t) === o) {
    const before = offsetMs(zone, t - 3 * HOUR_MS);
    if (before > o && offsetMs(zone, target - before) === before) return target - before;
    return t;
  }
  // midnight falls in a gap: the day starts at the transition (first minute dated `ymd`)
  let lo = Math.floor((target - 16 * HOUR_MS) / MINUTE_MS);
  let hi = Math.ceil((target + 16 * HOUR_MS) / MINUTE_MS);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (zonedParts(mid * MINUTE_MS, zone).ymd >= ymd) hi = mid; else lo = mid;
  }
  return hi * MINUTE_MS;
}

/** The start of the site day containing `nowMs`. */
export function zonedTodayStartMs(nowMs: number, zone: string): number {
  return zonedDayStartMs(zonedParts(nowMs, zone).ymd, zone);
}

/** Minute of the local day (0–1439) in `zone`. */
export function zonedMinuteOfDay(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  return p.hour * 60 + p.minute;
}

/** "HH:MM" (24 h) of an instant in `zone`; null without a zone or for an invalid instant. */
export function fmtHHMMIn(ms: number | null | undefined, zone: string | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || !zone) return null;
  try {
    const p = zonedParts(ms, zone);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

/** v1.191.1 — hour of the day (0–23) of an instant in `zone`; null without a zone, or for an invalid
 *  instant or zone. */
export function zonedHourIn(ms: number | null | undefined, zone: string | null | undefined): number | null {
  if (ms == null || !Number.isFinite(ms) || !zone) return null;
  try {
    const h = zonedParts(ms, zone).hour;
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

/** v1.191.1 — an instant as the browser's own locale writes it (the caller's fields, the default
 *  locale), on the clock of `zone`: a label keeps the text it had where the browser is in the site
 *  zone and reads the site's time everywhere else. null without a zone, or for an invalid instant
 *  or zone. The one exception to the `en-US` rule above, so the reference text does not change. */
export function fmtLocaleIn(
  ms: number | null | undefined,
  zone: string | null | undefined,
  fields: Intl.DateTimeFormatOptions,
): string | null {
  if (ms == null || !Number.isFinite(ms) || !zone) return null;
  try {
    return new Date(ms).toLocaleString([], { ...fields, timeZone: zone });
  } catch {
    return null;
  }
}

/** Whole calendar days from `fromYmd` to `toYmd` (positive when `toYmd` is later); NaN if malformed. */
export function calendarDaysBetween(fromYmd: string, toYmd: string): number {
  const at = (ymd: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  return Math.round((at(toYmd) - at(fromYmd)) / 86_400_000);
}
