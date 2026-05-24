import { request } from 'undici';
import { config } from './config.js';

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
