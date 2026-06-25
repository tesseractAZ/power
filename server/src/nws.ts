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
  onset: string | null;      // ISO
  expires: string | null;    // ISO
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

let cache: NwsAlertFeed | null = null;
const TTL_MS = 15 * 60 * 1000;

const USER_AGENT =
  'EcoFlowPanel/0.7.5 (https://github.com/tesseractAZ/ecoflow-panel)';

export function isNwsEnabled(): boolean {
  return process.env.NWS_ENABLED === '1' || process.env.NWS_ENABLED?.toLowerCase() === 'true';
}

export async function getNwsAlerts(log: (m: string) => void = () => {}): Promise<NwsAlertFeed | null> {
  if (!isNwsEnabled()) return null;
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;

  const { forecastLat: lat, forecastLon: lon } = config;
  const url = `https://api.weather.gov/alerts/active?point=${lat},${lon}&status=actual&message_type=alert`;
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
        expires: p.expires ?? null,
        headline: p.headline ?? null,
        description: p.description ?? null,
        instruction: p.instruction ?? null,
        areaDesc: p.areaDesc ?? null,
      };
    });
    cache = { fetchedAt: Date.now(), lat, lon, alerts };
    log(`nws: fetched ${alerts.length} active alert(s) for ${lat},${lon}`);
    return cache;
  } catch (e: any) {
    log(`nws: fetch failed (${e?.message ?? e}) — storm-prep will be quiet`);
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
  if (cloudCache && Date.now() - cloudCache.fetchedAt < TTL_MS) return cloudCache;
  // v0.69.0 — coalesce concurrent cold-cache callers onto one NWS fetch.
  return nwsCloudFlight.run(() => fetchNwsHourlyCloud(log));
}

async function fetchNwsHourlyCloud(log: (m: string) => void): Promise<NwsCloudCache | null> {
  if (cloudCache && Date.now() - cloudCache.fetchedAt < TTL_MS) return cloudCache;
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
