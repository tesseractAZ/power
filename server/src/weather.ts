import { request } from 'undici';
import { config } from './config.js';

/**
 * Open-Meteo weather client — free, no API key, no account.
 * Pulls hourly cloud cover + shortwave (solar) radiation for the recent past
 * and the next ~2 days, used to turn the historical "typical day" PV curve
 * into a cloud-aware forecast.
 */

export interface WeatherHour {
  ts: number;            // UTC epoch ms
  cloudCoverPct: number; // 0-100
  radiationWm2: number;  // shortwave (GHI), W/m²
  tempC: number;
}

export interface WeatherForecast {
  fetchedAt: number;
  lat: number;
  lon: number;
  hours: WeatherHour[];
}

let cache: WeatherForecast | null = null;
const TTL_MS = 2 * 60 * 60 * 1000; // 2h — weather forecasts don't move minute-to-minute

export async function getWeather(log: (m: string) => void = () => {}): Promise<WeatherForecast | null> {
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
    }));
    cache = { fetchedAt: Date.now(), lat, lon, hours };
    log(`weather: fetched ${hours.length}h forecast for ${lat},${lon}`);
    return cache;
  } catch (e: any) {
    log(`weather: fetch failed (${e?.message ?? e}) — forecast will fall back to history only`);
    return cache; // stale cache is better than nothing
  }
}
