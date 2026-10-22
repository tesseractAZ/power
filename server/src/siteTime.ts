/**
 * siteTime.ts — the site clock (plan 2.4). One zone, resolved once at boot, for every local
 * calendar date, hour, weekday and clock text the add-on computes.
 *
 * Before v1.191.0 three local-time sources disagreed: the host clock (`Date#getHours`, about 63 lines),
 * the literal 'America/Phoenix' (38 sites) and fixed UTC−7 arithmetic (6 sites). The reference install
 * agreed with itself only because its container zone, its Home Assistant zone and the literal are all
 * America/Phoenix, where Intl, UTC−7 and the host clock coincide at every instant since 1968.
 *
 * THE CHAIN, resolved once when this module loads (never switched afterwards):
 *   1. SITE_TIMEZONE (add-on option, schema-only; unset on an existing install) — when Intl resolves it;
 *   2. TZ — the container's zone, which the Supervisor sets to Home Assistant's;
 *   3. DEFAULT_SITE_TIME_ZONE ('America/Phoenix', config.ts — the one copy of the literal).
 * A value that does not resolve is RECORDED (`siteTimeZoneResolution().rejected`), raised as a repair
 * issue and logged by the main thread, and the chain falls through. It never silently becomes UTC: a
 * runtime whose zone data lacks the zone and answers UTC instead is treated as not resolving it (CA16).
 *
 * CA19 — a link name of the legacy zone ('US/Arizona', 'MST', any letter case) resolves to the canonical
 * 'America/Phoenix', so the tariff model's `timezone` string and every printed zone stay what they were.
 *
 * CA16 — every formatter here is an `en-US` `formatToParts` (the pattern this codebase already uses
 * because the add-on image's ICU once lacked `en-CA`); Spanish weekday names come from a fixed map,
 * never from an `es` locale.
 *
 * CA17 — this module resolves from the environment alone, so the analytics worker and the main thread
 * compute the same zone. It logs nothing and reads nothing over the network; the boot log line and the
 * comparison with Home Assistant's zone run on the main thread only (siteTimeHa.ts, index.ts).
 */
import { option, DEFAULT_SITE_TIME_ZONE } from './config.js';
import type { LocalParts } from './tariff.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/* ───────────────────────────── formatters ───────────────────────────── */

// Declared before the resolution below, which probes a formatter while the module loads.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function memo(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = FORMATTERS.get(key);
  if (!f) { f = make(); FORMATTERS.set(key, f); }
  return f;
}
function partsFormatter(zone: string): Intl.DateTimeFormat {
  return memo(`parts|${zone}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
}
const partOf = (parts: Intl.DateTimeFormatPart[], t: string): string => parts.find((p) => p.type === t)?.value ?? '';

/* ───────────────────────────── resolution ───────────────────────────── */

export type SiteTimeZoneSource = 'SITE_TIMEZONE' | 'TZ' | 'default';

export interface SiteTimeZoneRejection {
  source: 'SITE_TIMEZONE' | 'TZ';
  /** The configured value, as given. */
  value: string;
  reason: string;
}

export interface SiteTimeZoneResolution {
  zone: string;
  source: SiteTimeZoneSource;
  /** Values earlier in the chain that did not resolve, in chain order. */
  rejected: readonly SiteTimeZoneRejection[];
  /** The configured spelling when a link of the legacy zone was mapped to its canonical name (CA19). */
  mappedFrom: string | null;
}

/**
 * CA19 — names that are links of the legacy zone in tzdata (`backward`; MST since 2024b), mapped to the
 * canonical name so a container whose TZ holds one keeps every zone string unchanged. Matched without
 * regard to letter case, as Intl matches zone names.
 */
export const LEGACY_ZONE_LINKS: Readonly<Record<string, string>> = Object.freeze({
  'US/Arizona': DEFAULT_SITE_TIME_ZONE,
  MST: DEFAULT_SITE_TIME_ZONE,
});
const LINKS_LOWER = new Map<string, string>([
  ...Object.entries(LEGACY_ZONE_LINKS).map(([k, v]) => [k.toLowerCase(), v] as [string, string]),
  [DEFAULT_SITE_TIME_ZONE.toLowerCase(), DEFAULT_SITE_TIME_ZONE],
]);

/** Names that legitimately resolve to UTC (lower case). Any other name that Intl answers as UTC is a
 *  runtime that lacks the zone's data (CA16), not a UTC site. */
const UTC_NAMES = new Set([
  'utc', 'etc/utc', 'uct', 'etc/uct', 'universal', 'etc/universal', 'zulu', 'etc/zulu', 'gmt', 'etc/gmt',
  'gmt0', 'etc/gmt0', 'gmt+0', 'etc/gmt+0', 'gmt-0', 'etc/gmt-0', 'greenwich', 'etc/greenwich',
]);

let canonicalSpellings: Map<string, string> | null = null;
function canonicalSpelling(name: string): string {
  if (!canonicalSpellings) {
    canonicalSpellings = new Map();
    try {
      for (const z of (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []) {
        canonicalSpellings.set(z.toLowerCase(), z);
      }
    } catch { /* an older runtime: keep the configured spelling */ }
  }
  return canonicalSpellings.get(name.toLowerCase()) ?? name;
}

/**
 * The zone a configured name resolves to, or the reason it does not. PURE (Intl only).
 * A link of the legacy zone maps to 'America/Phoenix'; another name keeps its spelling, letter case
 * normalised to the runtime's canonical list where it appears there (so 'Asia/Kolkata' stays
 * 'Asia/Kolkata' even on an ICU whose canonical name is 'Asia/Calcutta').
 */
export function checkTimeZone(raw: string): { zone: string; mappedFrom: string | null } | { reason: string } {
  const name = raw.trim();
  if (name === '') return { reason: 'empty' };
  const link = LINKS_LOWER.get(name.toLowerCase());
  if (link) return { zone: link, mappedFrom: name === link ? null : name };
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return { reason: 'not an IANA time zone this runtime knows' };
  }
  if (/^(etc\/)?(utc|uct|gmt|universal|zulu)$/i.test(resolved) && !UTC_NAMES.has(name.toLowerCase())) {
    return { reason: `this runtime answers ${resolved} for it (its zone data lacks the zone)` };
  }
  // The formatter must also produce numeric calendar parts (a degraded ICU that drops them would make
  // every local date unreadable); probe one fixed instant.
  try {
    const parts = partsFormatter(name).formatToParts(new Date(Date.UTC(2026, 0, 15, 12)));
    const ok = ['year', 'month', 'day', 'hour', 'minute'].every((t) => Number.isFinite(Number(parts.find((p) => p.type === t)?.value)));
    if (!ok) return { reason: 'this runtime cannot format local dates in it' };
  } catch {
    return { reason: 'this runtime cannot format local dates in it' };
  }
  return { zone: canonicalSpelling(name), mappedFrom: null };
}

/**
 * The site zone from the two configured sources (plan 2.4). PURE: SITE_TIMEZONE, then TZ (a leading
 * ':' — the POSIX "zone file" prefix — is accepted), then the default. Blank or absent sources are
 * skipped; a source that does not resolve is listed in `rejected` and the chain falls through.
 */
export function resolveSiteTimeZone(siteTimeZoneOption: string | null | undefined, tz: string | null | undefined): SiteTimeZoneResolution {
  const rejected: SiteTimeZoneRejection[] = [];
  const chain: Array<['SITE_TIMEZONE' | 'TZ', string | null | undefined]> = [['SITE_TIMEZONE', siteTimeZoneOption], ['TZ', tz]];
  for (const [source, raw] of chain) {
    if (raw == null || raw.trim() === '') continue;
    const value = source === 'TZ' ? raw.trim().replace(/^:/, '') : raw.trim();
    const r = checkTimeZone(value);
    if ('zone' in r) return { zone: r.zone, source, rejected, mappedFrom: r.mappedFrom };
    rejected.push({ source, value: raw, reason: r.reason });
  }
  return { zone: DEFAULT_SITE_TIME_ZONE, source: 'default', rejected, mappedFrom: null };
}

/** Resolved once, here, from the environment (config.ts rows SITE_TIMEZONE and TZ). */
const RESOLUTION: SiteTimeZoneResolution = Object.freeze(
  resolveSiteTimeZone(option<string | null>('SITE_TIMEZONE'), option<string | null>('TZ')),
);

/** The site's IANA time zone. Fixed for the life of the process. */
export function siteTimeZone(): string {
  return RESOLUTION.zone;
}
/** Where the site zone came from. */
export function siteTimeZoneSource(): SiteTimeZoneSource {
  return RESOLUTION.source;
}
/** The whole resolution: zone, source, and any configured value that did not resolve. */
export function siteTimeZoneResolution(): SiteTimeZoneResolution {
  return RESOLUTION;
}
/** The boot log line (main thread only, CA17): `site time zone <zone> (source: <source>)`. */
export function siteTimeZoneLogLine(r: SiteTimeZoneResolution = RESOLUTION): string {
  const mapped = r.mappedFrom ? `; ${r.mappedFrom} is a link of it` : '';
  return `site time zone ${r.zone} (source: ${r.source}${mapped})`;
}

/* ───────────────────────────── zone-parameterised (pure) ───────────────────────────── */


/** Local wall-clock fields of an instant in `zone`, to the minute. PURE. */
export function zonedWallParts(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = partsFormatter(zone).formatToParts(new Date(ms));
  return {
    year: Number(partOf(parts, 'year')), month: Number(partOf(parts, 'month')), day: Number(partOf(parts, 'day')),
    hour: Number(partOf(parts, 'hour')), minute: Number(partOf(parts, 'minute')),
  };
}

/** The zone's UTC offset at an instant (local wall time minus UTC), in ms, to the minute. PURE. */
export function zoneOffsetMs(zone: string, ms: number): number {
  const w = zonedWallParts(ms, zone);
  const minuteFloor = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - minuteFloor;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseYmd(ymd: string): [number, number, number] | null {
  const m = YMD.exec(ymd ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const pad2 = (n: number): string => String(n).padStart(2, '0');
/** YYYY-MM-DD of a UTC calendar date. */
function utcYmd(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Calendar arithmetic on a YYYY-MM-DD (no zone involved); a malformed date comes back unchanged. PURE. */
export function addDaysYmd(ymd: string, days: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return utcYmd(Date.UTC(p[0], p[1] - 1, p[2] + days));
}

/**
 * The instant a local wall-clock time on `ymd` occurs in `zone` (its first occurrence when a fall-back
 * repeats it). A time inside a spring-forward gap does not occur; the first instant after the gap is
 * returned. NaN for a malformed date. PURE.
 */
export function zonedWallTimeMs(ymd: string, hour: number, minute: number, zone: string): number {
  const p = parseYmd(ymd);
  if (!p) return NaN;
  const target = Date.UTC(p[0], p[1] - 1, p[2], hour, minute);
  const o1 = zoneOffsetMs(zone, target);
  const o2 = zoneOffsetMs(zone, target - o1);
  const t = target - o2;
  if (zoneOffsetMs(zone, t) === o2) {
    // A valid wall time. In a fall-back the same wall time also occurs earlier, at the larger
    // (pre-transition) offset; prefer that first occurrence.
    const before = zoneOffsetMs(zone, t - 3 * HOUR_MS);
    if (before > o2) {
      const early = target - before;
      if (zoneOffsetMs(zone, early) === before) return early;
    }
    return t;
  }
  // A gap: the wall time does not exist. The answer is the transition instant, the first minute whose
  // wall time is at or after the target; the mapping is monotonic within ±16 h of a lone transition.
  let lo = target - 16 * HOUR_MS;
  let hi = target + 16 * HOUR_MS;
  const wallMs = (ms: number): number => {
    const w = zonedWallParts(ms, zone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  };
  lo = Math.floor(lo / MINUTE_MS); hi = Math.ceil(hi / MINUTE_MS);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallMs(mid * MINUTE_MS) >= target) hi = mid; else lo = mid;
  }
  return hi * MINUTE_MS;
}

/** The instant local midnight starts `ymd` in `zone` (the first instant of that date there). PURE. */
export function zonedDayStartMs(ymd: string, zone: string): number {
  return zonedWallTimeMs(ymd, 0, 0, zone);
}

/**
 * Home Assistant's statistics `start` for a local date: local noon in `zone`, FLOORED TO THE UTC HOUR
 * (recorder/import_statistics rejects a start that is not on the hour, and local noon is off the hour
 * where the offset has 30 or 45 minutes — CA11), written exactly as `YYYY-MM-DDTHH:00:00+00:00` with
 * the UTC date and hour (the payload shape the statistics importer has always been sent; never
 * toISOString's `…000Z`). In America/Phoenix that is `<ymd>T19:00:00+00:00` on every date. PURE.
 */
export function zonedNoonIso(ymd: string, zone: string): string {
  const noon = zonedWallTimeMs(ymd, 12, 0, zone);
  if (!Number.isFinite(noon)) return `${ymd}T12:00:00+00:00`;
  const hourStart = Math.floor(noon / HOUR_MS) * HOUR_MS;
  return `${utcYmd(hourStart)}T${pad2(new Date(hourStart).getUTCHours())}:00:00+00:00`;
}

/* ───────────────────────────── the site clock ───────────────────────────── */

/**
 * Local fields of an instant, computed from the zone's offset, which is cached per 15-minute slot of
 * UTC time: every UTC offset in use is a whole number of quarter hours and every transition falls on
 * a quarter hour, so one Intl lookup serves every sample in the slot (analytics calls this per
 * sample; a formatToParts per sample cost ~40× the host clock it replaces). A slot whose first and
 * last minute disagree — a transition that is not on a quarter hour — is not cached and each instant
 * in it is resolved through Intl. siteTime.test.ts holds this to Intl over every hour of 2024–2028
 * in eight zones.
 */
const SLOT_MS = 15 * MINUTE_MS;
const SLOT_CACHE_MAX = 250_000;
const OFFSET_BY_SLOT = new Map<string, Map<number, number>>();
function slotOffsetMs(zone: string, ms: number): number | null {
  const slot = Math.floor(ms / SLOT_MS);
  let byZone = OFFSET_BY_SLOT.get(zone);
  if (!byZone) { byZone = new Map(); OFFSET_BY_SLOT.set(zone, byZone); }
  let off = byZone.get(slot);
  if (off === undefined) {
    const a = zoneOffsetMs(zone, slot * SLOT_MS);
    const b = zoneOffsetMs(zone, slot * SLOT_MS + SLOT_MS - MINUTE_MS);
    off = a === b ? a : NaN;
    if (byZone.size >= SLOT_CACHE_MAX) byZone.clear();
    byZone.set(slot, off);
  }
  return Number.isNaN(off) ? null : off;
}

export interface SiteParts extends LocalParts {
  minute: number;
}

/** Local calendar/clock fields of an instant in `zone` (fast path above). An invalid instant throws a
 *  RangeError, as Intl does. PURE. */
export function zonedParts(ms: number, zone: string): SiteParts {
  if (!Number.isFinite(new Date(ms).getTime())) throw new RangeError('Invalid time value');
  const off = slotOffsetMs(zone, ms);
  if (off == null) {
    const w = zonedWallParts(ms, zone);
    const dow = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
    return { ...w, dow, ymd: `${String(w.year).padStart(4, '0')}-${pad2(w.month)}-${pad2(w.day)}` };
  }
  const d = new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS + off);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    year, month, day, hour: d.getUTCHours(), minute: d.getUTCMinutes(), dow: d.getUTCDay(),
    ymd: `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`,
  };
}

/** Local calendar/clock parts of an instant in the site zone. */
export function siteLocalParts(ms: number): SiteParts {
  return zonedParts(ms, siteTimeZone());
}
/** YYYY-MM-DD of an instant in the site zone (throws on an invalid instant, as localParts does). */
export function siteYmd(ms: number): string {
  return zonedParts(ms, siteTimeZone()).ymd;
}
/** siteYmd, or — for a value that is not a valid instant — the raw value's first ten characters
 *  (a corrupt persisted timestamp renders as its own text; never a throw from a date helper). */
export function siteYmdOrRaw(ms: number): string {
  return Number.isFinite(new Date(ms).getTime()) ? siteYmd(ms) : String(ms).slice(0, 10);
}
/** Local hour 0–23 in the site zone; NaN for an invalid instant (as `Date#getHours`). */
export function siteHour(ms: number): number {
  return Number.isFinite(new Date(ms).getTime()) ? zonedParts(ms, siteTimeZone()).hour : NaN;
}
/** Local weekday in the site zone, 0 = Sunday … 6 = Saturday; NaN for an invalid instant (as `Date#getDay`). */
export function siteDow(ms: number): number {
  return Number.isFinite(new Date(ms).getTime()) ? zonedParts(ms, siteTimeZone()).dow : NaN;
}
/** Minute of the local day (0–1439) in the site zone; NaN for an invalid instant. */
export function siteMinuteOfDay(ms: number): number {
  if (!Number.isFinite(new Date(ms).getTime())) return NaN;
  const p = zonedParts(ms, siteTimeZone());
  return p.hour * 60 + p.minute;
}
/**
 * The instant with the same local wall-clock time `days` calendar days later (earlier when negative)
 * in `zone`. A fixed `ms ± n × 24 h` step lands an hour off across a daylight-saving change (CA26);
 * in a zone without DST the two are identical. NaN for an invalid instant. PURE.
 */
export function zonedShiftDaysMs(ms: number, days: number, zone: string): number {
  if (!Number.isFinite(new Date(ms).getTime())) return NaN;
  const p = zonedParts(ms, zone);
  const sub = ms - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  return zonedWallTimeMs(addDaysYmd(p.ymd, days), p.hour, p.minute, zone) + sub;
}
/** zonedShiftDaysMs in the site zone. */
export function siteShiftDaysMs(ms: number, days: number): number {
  return zonedShiftDaysMs(ms, days, siteTimeZone());
}
/** The instant local midnight starts `ymd` in the site zone. In America/Phoenix: `ymd` 07:00 UTC. */
export function siteDayStartMs(ymd: string): number {
  return zonedDayStartMs(ymd, siteTimeZone());
}
/** The start of the site day containing `ms` (replaces the host's `setHours(0, 0, 0, 0)`). */
export function siteDayStartOf(ms: number): number {
  return zonedDayStartMs(siteYmd(ms), siteTimeZone());
}
/** The start of the site day after the one containing `ms` (a DST day is 23 or 25 h long). */
export function siteNextDayStartOf(ms: number): number {
  return zonedDayStartMs(addDaysYmd(siteYmd(ms), 1), siteTimeZone());
}
/** The statistics `start` (local noon, floored to the UTC hour) of a site-local date (CA11). */
export function siteNoonIso(ymd: string): string {
  return zonedNoonIso(ymd, siteTimeZone());
}

/* ───────────────────────────── text ───────────────────────────── */

/** Spanish weekday names for the bilingual second pass — a fixed map, never an `es` locale (CA16). */
export const WEEKDAY_ES: Readonly<Record<string, string>> = Object.freeze({
  Sunday: 'domingo', Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miércoles',
  Thursday: 'jueves', Friday: 'viernes', Saturday: 'sábado',
});

/** Clock text ("10:55 PM") of an instant in the site zone. */
export function fmtSiteClock(ms: number): string {
  const parts = memo(`clock|${siteTimeZone()}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: siteTimeZone(), hour: 'numeric', minute: '2-digit',
  })).formatToParts(new Date(ms));
  const dp = partOf(parts, 'dayPeriod');
  return `${partOf(parts, 'hour')}:${partOf(parts, 'minute')}${dp ? ' ' + dp : ''}`;
}

/** Weekday name ("Sunday"; Spanish "domingo") of an instant in the site zone; '' if the runtime gives none. */
export function fmtSiteWeekday(ms: number, lang: 'en' | 'es' = 'en'): string {
  const en = memo(`weekday|${siteTimeZone()}`, () => new Intl.DateTimeFormat('en-US', { timeZone: siteTimeZone(), weekday: 'long' }))
    .formatToParts(new Date(ms))
    .find((p) => p.type === 'weekday')?.value ?? '';
  if (lang === 'en') return en;
  return en ? WEEKDAY_ES[en] ?? '' : '';
}

/** "HH:MM" (24 h) of an instant in the site zone. */
export function fmtSiteHm(ms: number): string {
  const parts = memo(`hm24|${siteTimeZone()}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: siteTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })).formatToParts(new Date(ms));
  const hh = partOf(parts, 'hour') || '00';
  const mm = partOf(parts, 'minute') || '00';
  return `${hh}:${mm}`;
}

/** v1.39.0 (§4 display honesty): "HH:MM" for an instant within the next 24 h of `nowMs`, "EEE HH:MM"
 *  (e.g. "Mon 00:00") beyond — a Saturday-evening plan resolving Monday's window must not present it
 *  as tonight's. */
export function fmtSiteDayHm(ms: number, nowMs: number): string {
  const hm = fmtSiteHm(ms);
  if (ms - nowMs < 24 * HOUR_MS) return hm;
  const wd = memo(`wdshort|${siteTimeZone()}`, () => new Intl.DateTimeFormat('en-US', { timeZone: siteTimeZone(), weekday: 'short' }))
    .formatToParts(new Date(ms))
    .find((p) => p.type === 'weekday')?.value ?? '';
  return wd ? `${wd} ${hm}` : hm;
}

/** "YYYY-MM-DD HH:MM" (or "…:SS") of an instant in the site zone — the TUI's stamps. */
export function fmtSiteStamp(ms: number, withSeconds = false): string {
  const p = siteLocalParts(ms);
  const hm = `${p.ymd} ${pad2(p.hour)}:${pad2(p.minute)}`;
  return withSeconds ? `${hm}:${pad2(new Date(ms).getUTCSeconds())}` : hm;
}
/** "HH:MM:SS" of an instant in the site zone. */
export function fmtSiteHms(ms: number): string {
  const p = siteLocalParts(ms);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(new Date(ms).getUTCSeconds())}`;
}

/* ───────────────────── deprecated names (kept for existing importers) ───────────────────── */

/** @deprecated v1.191.0 — use siteYmd. */
export const phoenixYmd = siteYmd;
/** @deprecated v1.191.0 — use fmtSiteHm. */
export const fmtPhoenixHm = fmtSiteHm;
/** @deprecated v1.191.0 — use fmtSiteDayHm. */
export const fmtPhoenixDayHm = fmtSiteDayHm;
/** @deprecated v1.191.0 — use siteNoonIso. */
export const noonPhoenixIso = siteNoonIso;
