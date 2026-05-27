import { request } from 'undici';
import { config } from './config.js';
import { getNwsHourlyCloud, isNwsEnabled } from './nws.js';

/**
 * Weather forecast client. Open-Meteo is the primary source (free, no key,
 * provides cloud cover + shortwave GHI + temperature). v0.9.2 adds NWS NDFD
 * as a second cloud-cover source for an ensemble — Phoenix monsoon clouds
 * are notoriously hard for any single global model, so blending two
 * independent forecasts tightens the median AND lets us widen the
 * probabilistic forecast bands when sources disagree (the disagreement
 * itself is a useful uncertainty signal).
 *
 * NWS doesn't expose shortwave radiation directly, so GHI still comes from
 * Open-Meteo. NWS contributes only the cloud-cover ensemble.
 */

export interface WeatherHour {
  ts: number;                    // UTC epoch ms
  cloudCoverPct: number;         // 0-100 (ensemble median when 2 sources)
  radiationWm2: number;          // shortwave (GHI), W/m² — from Open-Meteo
  tempC: number;
  // v0.9.2 — ensemble metadata
  ensembleSources?: number;      // 1 if Open-Meteo only, 2 if NWS also available
  ensembleDisagreementPct?: number; // |Open-Meteo cloud − NWS cloud| (0-100); undefined if 1 source
}

export interface WeatherForecast {
  fetchedAt: number;
  lat: number;
  lon: number;
  hours: WeatherHour[];
  // v0.9.2 ensemble summary
  ensembleSourcesCount?: number;     // 1 or 2
  ensembleAvgDisagreement?: number;  // mean |diff| across overlapping hours
}

let cache: WeatherForecast | null = null;
let testForceMode: 'unset' | 'value' | 'null' = 'unset';
const TTL_MS = 2 * 60 * 60 * 1000; // 2h — weather forecasts don't move minute-to-minute

/**
 * Test-only seam: pin (or clear) the value getWeather() returns so tests
 * can run the weather-dependent analytics functions (multi-day forecast,
 * ambient thermal, forecast skill, Bayesian solar model) deterministically
 * without hitting the network. Pass a WeatherForecast to install it; pass
 * null to force getWeather() to return null without attempting a fetch.
 */
export function setWeatherCacheForTesting(value: WeatherForecast | null): void {
  cache = value;
  testForceMode = value == null ? 'null' : 'value';
}

/** Test-only seam: release the forced override so getWeather() resumes
 *  normal cache-then-fetch behavior. */
export function clearWeatherTestOverride(): void {
  cache = null;
  testForceMode = 'unset';
}

export async function getWeather(log: (m: string) => void = () => {}): Promise<WeatherForecast | null> {
  if (testForceMode === 'null') return null;
  if (testForceMode === 'value') return cache;
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;

  const { forecastLat: lat, forecastLon: lon } = config;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=cloud_cover,shortwave_radiation,temperature_2m&forecast_days=2&past_days=3`;
  try {
    const res = await request(url);
    if (res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
    const j = (await res.body.json()) as any;
    const offsetMs = (j.utc_offset_seconds ?? 0) * 1000;
    const time: string[] = j.hourly?.time ?? [];
    const cc: number[] = j.hourly?.cloud_cover ?? [];
    const sw: number[] = j.hourly?.shortwave_radiation ?? [];
    const tp: number[] = j.hourly?.temperature_2m ?? [];
    const hours: WeatherHour[] = time.map((iso, i) => ({
      // Open-Meteo returns local-zone ISO strings; convert to true UTC epoch.
      ts: Date.parse(`${iso}:00Z`) - offsetMs,
      cloudCoverPct: cc[i] ?? 0,
      radiationWm2: sw[i] ?? 0,
      tempC: tp[i] ?? 0,
      ensembleSources: 1, // overridden by getEnsembleWeather if NWS is also available
    }));
    // v0.9.2 — fold in NWS cloud cover when available (US-only, opt-in via
    // NWS_ENABLED=1). The ensemble enriches each hour's `cloudCoverPct`
    // toward the mean of the two sources AND reports per-hour disagreement
    // so downstream callers (probabilistic forecast) can widen bands when
    // sources disagree — disagreement is a real uncertainty signal in
    // Phoenix monsoon weather.
    if (isNwsEnabled()) {
      try {
        const nws = await getNwsHourlyCloud(log);
        if (nws && nws.hours.length > 0) {
          const nwsByHourEpoch = new Map<number, number>();
          for (const h of nws.hours) {
            nwsByHourEpoch.set(Math.floor(h.ts / 3_600_000), h.cloudCoverPct);
          }
          let disagreementSum = 0;
          let overlapCount = 0;
          for (const h of hours) {
            const he = Math.floor(h.ts / 3_600_000);
            const nwsCloud = nwsByHourEpoch.get(he);
            if (nwsCloud == null) continue;
            const diff = Math.abs(h.cloudCoverPct - nwsCloud);
            // Replace cloud cover with the ensemble mean.
            h.cloudCoverPct = (h.cloudCoverPct + nwsCloud) / 2;
            h.ensembleSources = 2;
            h.ensembleDisagreementPct = Math.round(diff);
            disagreementSum += diff;
            overlapCount++;
          }
          if (overlapCount > 0) {
            const avgDisagree = Math.round((disagreementSum / overlapCount) * 10) / 10;
            log(`weather: ensembled ${overlapCount}h with NWS (avg cloud-cover disagreement ${avgDisagree}%)`);
          }
        }
      } catch (e: any) {
        log(`weather: NWS ensemble augment failed (${e?.message ?? e}) — continuing with Open-Meteo only`);
      }
    }
    // Ensemble summary stats
    const enriched = hours.filter((h) => (h.ensembleSources ?? 1) > 1);
    const ensembleSourcesCount = enriched.length > 0 ? 2 : 1;
    const ensembleAvgDisagreement =
      enriched.length > 0
        ? Math.round(
            (enriched.reduce((s, h) => s + (h.ensembleDisagreementPct ?? 0), 0) / enriched.length) * 10,
          ) / 10
        : 0;
    cache = { fetchedAt: Date.now(), lat, lon, hours, ensembleSourcesCount, ensembleAvgDisagreement };
    log(`weather: fetched ${hours.length}h forecast for ${lat},${lon}${ensembleSourcesCount > 1 ? ` (ensemble: ${enriched.length}/${hours.length}h enriched)` : ''}`);
    return cache;
  } catch (e: any) {
    log(`weather: fetch failed (${e?.message ?? e}) — forecast will fall back to history only`);
    return cache; // stale cache is better than nothing
  }
}
