import { request } from 'undici';
import { config } from './config.js';
import { singleFlight } from './singleFlight.js';

/**
 * National Weather Service alerts client (alerts.weather.gov) — free, no API
 * key, no account. Pulls active alerts within ~50 mi of the configured
 * forecast coordinates. Used by the storm-preparedness signal to fire a
 * "pre-charge to 100% before forecast storm" learned alert when a severe
 * event is in the forecast.
 *
 * Off by default. Set NWS_ENABLED=1 to turn on (US-only; outside the US the
 * endpoint will return empty alerts, which is also a graceful no-op).
 */

export interface NwsAlert {
  id: string;
  event: string;             // "Severe Thunderstorm Warning"
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  certainty: 'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown';
  urgency: 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';
  // NWS CAP time semantics (all ISO8601). These are THREE different clocks and
  // conflating them is what made the displayed stamps look "swapped":
  //   • onset     — when the weather EVENT begins (may be null / in the past for
  //                 an already-in-effect warning).
  //   • effective — when the alert MESSAGE became valid (issue-ish time).
  //   • ends      — when the weather EVENT ends. THIS is "storm over".
  //   • expires   — when the alert MESSAGE expires; NWS re-issues ~hourly, so it
  //                 is often only ~30 min out — NOT when the event ends. Pairing
  //                 onset (event start, maybe tomorrow) with expires (message
  //                 expiry, ~30 min) reads as start-after-end. Use onset→ends.
  onset: string | null;      // ISO — event begins
  effective: string | null;  // ISO — message became valid
  ends: string | null;       // ISO — event ends ("in effect until")
  expires: string | null;    // ISO — message expiry (re-issue deadline, short)
  headline: string | null;
  description: string | null;
  instruction: string | null;
  areaDesc: string | null;
}

export interface NwsAlertFeed {
  fetchedAt: number;
  lat: number;
  lon: number;
  alerts: NwsAlert[];
}

/**
 * v0.85.0 — resolve an alert's TRUE event window (pure + exported for tests).
 * The event span is onset→ends; effective/expires are only fallbacks. `expires`
 * alone is the ~30-min message-refresh deadline (NOT the event end), so it is
 * last-resort only — pairing it with onset made a future storm read
 * start-after-end. `inEffectNow` is true once it has begun (onset in the past or
 * absent). The web nwsWindow() helper mirrors this exactly.
 */
export function nwsEventWindow(
  a: Pick<NwsAlert, 'onset' | 'effective' | 'ends' | 'expires'>,
  nowMs: number,
): { beginsMs: number | null; endsMs: number | null; inEffectNow: boolean } {
  const rawBegins = a.onset ? Date.parse(a.onset) : a.effective ? Date.parse(a.effective) : NaN;
  const rawEnds = a.ends ? Date.parse(a.ends) : a.expires ? Date.parse(a.expires) : NaN;
  const bOk = Number.isFinite(rawBegins);
  const eOk = Number.isFinite(rawEnds);
  return {
    beginsMs: bOk ? rawBegins : null,
    endsMs: eOk ? rawEnds : null,
    inEffectNow: !bOk || rawBegins <= nowMs,
  };
}

let cache: NwsAlertFeed | null = null;
/** Alerts cache TTL — 15 min. Active alerts can appear/clear fast, so we
 *  re-poll often. NOTE: this is the *alerts* cadence only; the cloud-cover
 *  cache below has its own (slower) CLOUD_TTL_MS — don't reuse this one. */
export const TTL_MS = 15 * 60 * 1000;

const USER_AGENT =
  `EcoFlowPanel/${process.env.BUILD_VERSION || 'dev'} (https://github.com/tesseractAZ/power)`;

export function isNwsEnabled(): boolean {
  return process.env.NWS_ENABLED === '1' || process.env.NWS_ENABLED?.toLowerCase() === 'true';
}

/**
 * v1.187.3 (log review, LOW) — after a FAILED alerts fetch, no new request for this long.
 *
 * A failed fetch is not cached as "no alerts": before the first success getNwsAlerts returns null,
 * and stormPrepAlerts reads that as UNKNOWN and keeps the storm-prep feed cold (alertSetTrusted).
 * Nothing else bounded the retries, so until NWS first answered after a boot every 20 s
 * alert-monitor pass sent a new request to api.weather.gov — about 180 an hour from the monitor
 * alone, for as long as the failure lasted (an outage, a User-Agent block), against 6 an hour while
 * the failure was cached — and so did every /api/nws-alerts and calendar request. A call inside the
 * backoff answers exactly as the failed fetch did — the last good feed, or null before any success —
 * without a request, so the feed stays cold (unknown) at a bounded request rate.
 */
export const NWS_ALERTS_FAILURE_BACKOFF_MS = 2 * 60_000;

/**
 * v1.187.3 (log review) — is a failed alerts fetch at `failedAtMs` still backing off at `nowMs`?
 * A failure "in the future" (the clock stepped back) does not hold the backoff: the next call asks.
 * Pure + exported for tests.
 */
export function nwsAlertsBackingOff(
  failedAtMs: number | null,
  nowMs: number,
  backoffMs = NWS_ALERTS_FAILURE_BACKOFF_MS,
): boolean {
  return failedAtMs != null && nowMs >= failedAtMs && nowMs - failedAtMs < backoffMs;
}

/**
 * v1.187.10 (log review 10-03) — the oldest last-good alerts feed the storm-prep (alarm) path still
 * reads as current.
 *
 * After the first successful fetch, a failed fetch answers with the last good feed (a warning stays a
 * warning), and nothing bounded its age: through an api.weather.gov outage that began after a boot,
 * stormPrepAlerts kept building storm alerts from a feed hours old and returned them as a normal
 * answer, so the alert monitor's storm-prep feed read fresh (carrying: false, no error) and its carry
 * log and stuck-feed WARNING never engaged. A new warning issued during the outage was silently
 * missed while every surface read healthy. Past this age getNwsAlerts answers null — UNKNOWN — on the
 * alarm path: stormPrepAlerts throws, the feed carries its last good value (the storm alerts stay
 * held, not cleared), and the carry log, the stuck-feed WARNING and /api/notify/status show it. The
 * display route (/api/nws-alerts, the calendar) keeps the last good feed (maxCarryMs = Infinity).
 */
export const NWS_ALERTS_MAX_CARRY_MS = 60 * 60_000;

/**
 * v1.187.10 — is a feed fetched at `fetchedAtMs` past the carry limit at `nowMs`? A feed "from the
 * future" (the clock stepped back) is not. Pure + exported for tests.
 */
export function nwsAlertsCarryExpired(
  fetchedAtMs: number | null,
  nowMs: number,
  maxCarryMs = NWS_ALERTS_MAX_CARRY_MS,
): boolean {
  return fetchedAtMs != null && nowMs - fetchedAtMs > maxCarryMs;
}

/** v1.187.3 (log review) — when the last alerts fetch failed (null: none has). */
let alertsFailedAt: number | null = null;
/** v1.187.3 (log review) — concurrent callers (the alert monitor's storm-prep feed, /api/nws-alerts,
 *  the calendar) share one request. */
const alertsFlight = singleFlight<NwsAlertFeed | null>();

/**
 * v1.187.10 (log review 10-03) — the alerts client's log sinks, installed once per process
 * (setNwsLog; startAlertMonitor installs the monitor's info and warn sinks).
 *
 * Every caller used to call getNwsAlerts() with no logger, so the success line and the v1.187.3
 * failure line could never reach the journal: 40.8 h of log held no trace of a storm-alert fetch
 * while nws-cloud logged 20. The client logs state TRANSITIONS, not every success: the first
 * answer, a change in the set of active events, the first failure of an outage, the carry limit
 * passing (warn), and the recovery.
 */
let nwsInfo: (m: string) => void = () => {};
let nwsWarn: (m: string) => void = (m) => nwsInfo(m);
export function setNwsLog(info: (m: string) => void, warn: (m: string) => void = info): void {
  nwsInfo = info;
  nwsWarn = warn;
}

/** v1.187.10 — the current failure episode (since the last success). */
let alertsFailingSinceMs: number | null = null;
let alertsFailedAttempts = 0;
let alertsLastError: string | null = null;
/** v1.187.10 — the carry limit has been warned about in this episode. */
let alertsCarryWarned = false;
/** v1.187.10 — the sorted active-event list of the last successful answer (null: none yet). */
let alertsEventsKey: string | null = null;

/** v1.187.10 — test seam: forget the transition state (not the cache). */
export function resetNwsAlertsLogStateForTesting(): void {
  alertsFailingSinceMs = null;
  alertsFailedAttempts = 0;
  alertsLastError = null;
  alertsCarryWarned = false;
  alertsEventsKey = null;
}

/**
 * The NWS active-alerts feed, or null when it is UNKNOWN: NWS off, no fetch has succeeded yet, or —
 * v1.187.10 — the last good feed is older than `maxCarryMs` (default NWS_ALERTS_MAX_CARRY_MS, the
 * alarm path's limit; the display route passes Infinity).
 */
export async function getNwsAlerts(opts: { maxCarryMs?: number } = {}): Promise<NwsAlertFeed | null> {
  if (!isNwsEnabled()) return null;
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  // v1.187.3 (log review) — inside the backoff after a failed fetch: the failure's answer, no request.
  const feed = nwsAlertsBackingOff(alertsFailedAt, Date.now())
    ? cache
    : await alertsFlight.run(() => fetchNwsAlerts(nwsInfo));
  const maxCarryMs = opts.maxCarryMs ?? NWS_ALERTS_MAX_CARRY_MS;
  if (feed != null && nwsAlertsCarryExpired(feed.fetchedAt, Date.now(), maxCarryMs)) {
    if (!alertsCarryWarned) {
      alertsCarryWarned = true;
      nwsWarn(
        `nws: WARNING — no successful storm-alert fetch for ${Math.round((Date.now() - feed.fetchedAt) / 60_000)} min`
        + ` (last error: ${alertsLastError ?? 'unknown'}); the last good feed is past its`
        + ` ${Math.round(maxCarryMs / 60_000)}-min carry limit, so storm alerts are UNKNOWN until api.weather.gov answers`
        + ' (the storm-prep feed holds its last alerts)',
      );
    }
    return null;
  }
  return feed;
}

function eventsList(alerts: NwsAlert[]): string {
  return alerts.length > 0 ? `: ${alerts.map((a) => a.event).join(', ')}` : '';
}

async function fetchNwsAlerts(log: (m: string) => void): Promise<NwsAlertFeed | null> {
  const { forecastLat: lat, forecastLon: lon } = config;
  // v1.40.0: message_type MUST include `update` — NWS delivers upgrades
  // (Watch → Warning) and routine continuations as message_type=Update, and an
  // Update supersedes the original Alert message in the /alerts/active feed.
  // Filtering to `alert` alone made every product vanish from the feed at its
  // FIRST update (live-confirmed: an active Extreme Heat Warning returned zero
  // features under the old query), silently clearing storm pre-charge alerts
  // while the hazard still stood.
  const url = `https://api.weather.gov/alerts/active?point=${lat},${lon}&status=actual&message_type=alert,update`;
  try {
    const res = await request(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } });
    if (res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
    const j = (await res.body.json()) as any;
    const features: any[] = j?.features ?? [];
    const alerts: NwsAlert[] = features.map((f) => {
      const p = f.properties ?? {};
      return {
        id: f.id ?? p.id ?? '',
        event: p.event ?? 'Weather alert',
        severity: p.severity ?? 'Unknown',
        certainty: p.certainty ?? 'Unknown',
        urgency: p.urgency ?? 'Unknown',
        onset: p.onset ?? null,
        effective: p.effective ?? null,
        ends: p.ends ?? null,
        expires: p.expires ?? null,
        headline: p.headline ?? null,
        description: p.description ?? null,
        instruction: p.instruction ?? null,
        areaDesc: p.areaDesc ?? null,
      };
    });
    cache = { fetchedAt: Date.now(), lat, lon, alerts };
    // v1.187.10 — state transitions only: the first answer, a recovery, a changed event set.
    const key = alerts.map((a) => a.event).sort().join(' | ');
    if (alertsFailingSinceMs != null) {
      log(`nws: storm-alert feed recovered after ${alertsFailedAttempts} failed attempt(s) over ${Math.max(1, Math.round((Date.now() - alertsFailingSinceMs) / 60_000))} min — ${alerts.length} active alert(s)${eventsList(alerts)}`);
    } else if (alertsEventsKey == null) {
      log(`nws: storm-alert feed live — ${alerts.length} active alert(s) for ${lat},${lon}${eventsList(alerts)}`);
    } else if (key !== alertsEventsKey) {
      log(`nws: active alerts changed — ${alerts.length} now${eventsList(alerts)}`);
    }
    alertsEventsKey = key;
    alertsFailingSinceMs = null;
    alertsFailedAttempts = 0;
    alertsLastError = null;
    alertsCarryWarned = false;
    return cache;
  } catch (e: any) {
    alertsFailedAt = Date.now();
    alertsFailedAttempts++;
    alertsLastError = String(e?.message ?? e);
    // v1.187.10 — the FIRST failure of an outage; the recovery line closes it.
    if (alertsFailingSinceMs == null) {
      alertsFailingSinceMs = alertsFailedAt;
      log(`nws: storm-alert fetch failed (${alertsLastError}) — ${cache == null
        ? 'no feed yet: storm alerts are UNKNOWN'
        : `the last good feed (${Math.round((Date.now() - cache.fetchedAt) / 60_000)} min old) is carried for at most ${Math.round(NWS_ALERTS_MAX_CARRY_MS / 60_000)} min`
      }; asked again every ${Math.round(NWS_ALERTS_FAILURE_BACKOFF_MS / 1000)} s; logged once per outage, with a recovery line`);
    }
    return cache;
  }
}

/* ─── v0.9.2 — NWS hourly cloud cover (for the weather ensemble) ─────────
 *
 * NWS NDFD exposes `skyCover` on the gridpoint endpoint. The API is
 * two-step: first resolve (lat, lon) → {office, gridX, gridY}, then
 * fetch the gridpoint data. The grid lookup is stable per-coordinate
 * so we cache it separately and refresh every 24 h. Cloud cover
 * forecast itself caches for the same 2 h as Open-Meteo.
 *
 * skyCover values come as `{ validTime: "ISO8601/PT3H", value: 30 }`
 * — value is constant for the duration. Many entries span multiple
 * hours, so we expand them into per-hour observations.
 */

export interface NwsHourlyCloud {
  ts: number;            // epoch ms — top of each hour
  cloudCoverPct: number; // 0-100 from skyCover
}

interface NwsGridLookup {
  fetchedAt: number;
  lat: number;
  lon: number;
  office: string;
  gridX: number;
  gridY: number;
}

interface NwsCloudCache {
  fetchedAt: number;
  lat: number;
  lon: number;
  hours: NwsHourlyCloud[];
}

const GRID_TTL_MS = 24 * 60 * 60 * 1000;
/** Cloud-cover cache TTL — 2 h, tracking the Open-Meteo weather TTL
 *  (weather.ts) per the v0.9.2 design note above. Deliberately NOT the
 *  15-min alerts TTL_MS: sky-cover forecasts don't move minute-to-minute,
 *  and reusing the alerts cadence made ~8× more api.weather.gov calls than
 *  designed (120 min / 15 min). */
export const CLOUD_TTL_MS = 2 * 60 * 60 * 1000;
let gridCache: NwsGridLookup | null = null;
let cloudCache: NwsCloudCache | null = null;
// v0.69.0 — coalesce concurrent cold-cache fetches (see singleFlight.ts).
const nwsGridFlight = singleFlight<NwsGridLookup | null>();
const nwsCloudFlight = singleFlight<NwsCloudCache | null>();

async function resolveNwsGrid(lat: number, lon: number, log: (m: string) => void): Promise<NwsGridLookup | null> {
  if (gridCache && gridCache.lat === lat && gridCache.lon === lon && Date.now() - gridCache.fetchedAt < GRID_TTL_MS) {
    return gridCache;
  }
  // v0.69.0 — coalesce concurrent cold lookups (config coords are constant, so a
  // single in-flight slot is safe).
  return nwsGridFlight.run(() => fetchNwsGrid(lat, lon, log));
}

async function fetchNwsGrid(lat: number, lon: number, log: (m: string) => void): Promise<NwsGridLookup | null> {
  if (gridCache && gridCache.lat === lat && gridCache.lon === lon && Date.now() - gridCache.fetchedAt < GRID_TTL_MS) {
    return gridCache; // a prior flight may have resolved it while we queued
  }
  const url = `https://api.weather.gov/points/${lat},${lon}`;
  try {
    const res = await request(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } });
    if (res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
    const j = (await res.body.json()) as any;
    const p = j?.properties;
    if (!p?.gridId || p?.gridX == null || p?.gridY == null) throw new Error('grid info missing');
    gridCache = {
      fetchedAt: Date.now(), lat, lon,
      office: p.gridId, gridX: p.gridX, gridY: p.gridY,
    };
    log(`nws-grid: resolved ${lat},${lon} → ${gridCache.office}/${gridCache.gridX},${gridCache.gridY}`);
    return gridCache;
  } catch (e: any) {
    log(`nws-grid: lookup failed (${e?.message ?? e}) — ensemble will use Open-Meteo only`);
    return null;
  }
}

/** Expand a skyCover entry like `{ validTime: "2026-05-25T18:00:00+00:00/PT3H", value: 25 }` into N per-hour rows. Exported for tests. */
export function expandSkyCoverEntry(entry: { validTime?: string; value?: number | null }): NwsHourlyCloud[] {
  if (!entry?.validTime || entry.value == null) return [];
  const parts = entry.validTime.split('/');
  const startIso = parts[0];
  const dur = parts[1] ?? 'PT1H';
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return [];
  // Parse ISO 8601 duration — we only need hours (and the occasional
  // days-as-PnD, which we convert to hours). Format we'll encounter:
  // PT1H, PT3H, P1DT6H, PT12H. Strip "P", split "T" if present.
  let totalHours = 1;
  const m = dur.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (m) {
    const d = m[1] ? Number(m[1]) : 0;
    const h = m[2] ? Number(m[2]) : 0;
    totalHours = Math.max(1, d * 24 + h);
  }
  const out: NwsHourlyCloud[] = [];
  for (let i = 0; i < totalHours; i++) {
    out.push({ ts: startMs + i * 3_600_000, cloudCoverPct: entry.value });
  }
  return out;
}

export async function getNwsHourlyCloud(log: (m: string) => void = () => {}): Promise<NwsCloudCache | null> {
  if (!isNwsEnabled()) return null;
  if (cloudCache && Date.now() - cloudCache.fetchedAt < CLOUD_TTL_MS) return cloudCache;
  // v0.69.0 — coalesce concurrent cold-cache callers onto one NWS fetch.
  return nwsCloudFlight.run(() => fetchNwsHourlyCloud(log));
}

async function fetchNwsHourlyCloud(log: (m: string) => void): Promise<NwsCloudCache | null> {
  if (cloudCache && Date.now() - cloudCache.fetchedAt < CLOUD_TTL_MS) return cloudCache;
  const { forecastLat: lat, forecastLon: lon } = config;
  const grid = await resolveNwsGrid(lat, lon, log);
  if (!grid) return null;
  const url = `https://api.weather.gov/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}`;
  try {
    const res = await request(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } });
    if (res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
    const j = (await res.body.json()) as any;
    const skyValues: Array<{ validTime?: string; value?: number | null }> = j?.properties?.skyCover?.values ?? [];
    const expanded: NwsHourlyCloud[] = [];
    for (const e of skyValues) expanded.push(...expandSkyCoverEntry(e));
    // Sort + de-dupe (some entries can overlap on hour boundaries)
    expanded.sort((a, b) => a.ts - b.ts);
    const dedup: NwsHourlyCloud[] = [];
    let lastTs = -1;
    for (const h of expanded) {
      const hourEpoch = Math.floor(h.ts / 3_600_000) * 3_600_000;
      if (hourEpoch === lastTs) continue;
      dedup.push({ ts: hourEpoch, cloudCoverPct: h.cloudCoverPct });
      lastTs = hourEpoch;
    }
    cloudCache = { fetchedAt: Date.now(), lat, lon, hours: dedup };
    log(`nws-cloud: fetched ${dedup.length}h of cloud-cover forecast for ${grid.office}/${grid.gridX},${grid.gridY}`);
    return cloudCache;
  } catch (e: any) {
    log(`nws-cloud: fetch failed (${e?.message ?? e}) — ensemble will use Open-Meteo only`);
    return cloudCache;
  }
}
