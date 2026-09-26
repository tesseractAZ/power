/**
 * v1.186.1 — the 7-day curtailment figure's finished days, frozen once their inputs settle.
 *
 * WHY. `computeCurtailment` (analytics.ts) re-estimated all 168 past hours on every refresh,
 * each against the CURRENT learned solar posterior and the CURRENT weather cache. Neither is a
 * property of the past day: the posterior re-learns on every refresh, and the weather cache is
 * replaced every two hours. So seven finished days moved within one day with no new
 * curtailment in them (2026-09-25: 12.6 → 10.5 → 16.09 kWh on "PV Curtailed 7d").
 *
 * WHAT "SETTLED" MEANS. A past hour's estimate reads three inputs:
 *   - the recorder's Core and panel series for that hour — written as they arrive, final once
 *     the hour is over;
 *   - the solar posterior — it never settles (it re-learns forever), which is exactly why a
 *     finished day must stop being re-read through it;
 *   - the hour's irradiance from the analytics worker's own in-memory Open-Meteo cache
 *     (`getWeather()`, `forecast_days=4&past_days=7`). `weatherVerified` in a sampled hour
 *     means that cache held the hour with GHI ≥ the daylight floor and the posterior had
 *     support for it. The cache holds FORECASTS and past-hour estimates side by side: an hour
 *     is the provider's past-hour estimate only if its whole interval had ended when the cache
 *     was fetched (the rule the realized-GHI capture uses, recorder.ts `recordWeatherGhi`),
 *     and a failed fetch keeps serving the stale cache, so a finished day can still be
 *     estimated on forecast irradiance. Past-hour values are also revised in place by later
 *     fetches until the provider has ingested the model runs that cover the hour.
 *
 * A finished local day is therefore settled when ALL of these hold, and only then is it frozen:
 *   1. the weather in hand was fetched at least `CURTAIL_SETTLE_LAG_MS` after the day ended —
 *      no hour of the day is a forecast value, and the provider's revision window has passed;
 *   2. every hour of the day is in that cache with a value the provider actually sent (the past
 *      edge of `past_days=7` counts UTC days, and a `radiationMissing` stand-in 0 is not a
 *      reading);
 *   3. a solar posterior exists — a model-less walk samples every hour null, and a frozen
 *      model-less 0 would stand for a week (the v1.178.0 weather-cold trap).
 * A day that is not settled is estimated live exactly as before. Today is always live.
 *
 * PERSISTENCE. The analytics worker's database connection is read-only, so frozen days live in
 * a JSON sidecar next to the database (`curtailment-days.json`), written atomically. Production
 * (the add-on, SUPERVISOR_TOKEN set) persists there; elsewhere only an explicit
 * CURTAILMENT_DAYS_PATH does, so one test process's frozen days can never rehydrate into
 * another's. Days older than the 7-day window are pruned. An absent or corrupt file starts cold:
 * the days re-estimate live and freeze again once settled.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { atomicWriteFileSync } from './atomicWrite.js';
import type { WeatherForecast } from './weather.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long after a day ends the weather must have been fetched before the day may freeze.
 *
 * Open-Meteo builds past hours by stitching the first hours of each model run, so an hour stops
 * moving once the last run initialised at or before it has been ingested — within that model's
 * ingest delay of the hour. The provider's model metadata (`/data/<model>/static/meta.json`, read
 * 2026-09-25) put the slowest at ~7.2 h (ECMWF IFS, 6-hourly) and GFS at ~6.9 h; HRRR and NBM
 * are hourly at ~1.6 h and ~0.9 h. At the default (Phoenix) location `best_match` served HRRR's
 * values for every past hour of the 7-day window. Twelve hours clears the slowest with margin for
 * a late run; freezing too early is the worse error (a wrong day then stands for a week). The
 * cache's two-hour TTL is not part of the lag: the check reads the fetch time of the weather
 * actually in hand, never the clock.
 */
export const CURTAIL_SETTLE_LAG_MS = 12 * HOUR_MS;

/** One finished local day, frozen: what the 7-day total, hour count and histogram need. */
export interface FrozenCurtailmentDay {
  /** The walk's own day start (`todayStart − d × 24 h`), the key it is looked up by. */
  dayStartMs: number;
  /** kWh lost that day: the sum of its curtailed hours' `curtailedKwh`. */
  kwh: number;
  /** The day's curtailed hours (hour of day + mean surplus W) — the hour count and histogram. */
  hours: Array<{ hour: number; surplusW: number }>;
  /** When it was frozen, and the fetch time of the weather it was estimated against. */
  frozenAtMs: number;
  weatherFetchedAtMs: number;
}

/**
 * Whether the finished local day starting at `dayStartMs` has settled (see the header):
 * weather fetched ≥ CURTAIL_SETTLE_LAG_MS after the day ended, every hour of the day covered by
 * a value the provider sent, and a solar posterior present.
 */
export function curtailmentDaySettled(
  weather: WeatherForecast | null,
  hasPosterior: boolean,
  dayStartMs: number,
): boolean {
  if (!weather || !hasPosterior) return false;
  const dayEndMs = dayStartMs + DAY_MS;
  if (!(weather.fetchedAt >= dayEndMs + CURTAIL_SETTLE_LAG_MS)) return false;
  const sent = new Set<number>();
  for (const h of weather.hours) {
    if (h.radiationMissing !== true && Number.isFinite(h.radiationWm2)) sent.add(Math.floor(h.ts / HOUR_MS));
  }
  // Matched the way sampleCurtailmentHour matches an hour to the cache: by hour epoch.
  for (let h = 0; h < 24; h++) {
    if (!sent.has(Math.floor((dayStartMs + h * HOUR_MS) / HOUR_MS))) return false;
  }
  return true;
}

// ── The store ────────────────────────────────────────────────────────────────
/** null = not resolved yet; '' = persistence disabled (memory only). */
let storePath: string | null = null;
const frozen = new Map<number, FrozenCurtailmentDay>();
let dirty = false;
let writeWarned = false;

function validDay(v: unknown): FrozenCurtailmentDay | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!num(o.dayStartMs) || !num(o.kwh) || o.kwh < 0 || !num(o.frozenAtMs) || !num(o.weatherFetchedAtMs)) return null;
  if (!Array.isArray(o.hours)) return null;
  const hours: Array<{ hour: number; surplusW: number }> = [];
  for (const h of o.hours) {
    const hh = h as Record<string, unknown> | null;
    if (!hh || !Number.isInteger(hh.hour) || (hh.hour as number) < 0 || (hh.hour as number) > 23 || !num(hh.surplusW)) return null;
    hours.push({ hour: hh.hour as number, surplusW: hh.surplusW });
  }
  return { dayStartMs: o.dayStartMs, kwh: o.kwh, hours, frozenAtMs: o.frozenAtMs, weatherFetchedAtMs: o.weatherFetchedAtMs };
}

function ensureLoaded(): void {
  if (storePath != null) return;
  storePath = process.env.CURTAILMENT_DAYS_PATH
    ?? (process.env.SUPERVISOR_TOKEN ? resolve(process.cwd(), config.dbPath, '..', 'curtailment-days.json') : '');
  if (!storePath) return;
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { days?: unknown };
    if (Array.isArray(raw?.days)) {
      for (const d of raw.days) {
        const day = validDay(d);
        if (day) frozen.set(day.dayStartMs, day); // an invalid entry is dropped: that day re-estimates live
      }
    }
  } catch { /* absent or corrupt → start cold */ }
}

/** The frozen record for the day starting at `dayStartMs`, or null when it is not frozen. */
export function frozenCurtailmentDay(dayStartMs: number): FrozenCurtailmentDay | null {
  ensureLoaded();
  return frozen.get(dayStartMs) ?? null;
}

/** Freeze a settled day. A day already frozen keeps its first record. */
export function freezeCurtailmentDay(day: FrozenCurtailmentDay): void {
  ensureLoaded();
  if (frozen.has(day.dayStartMs)) return;
  frozen.set(day.dayStartMs, { ...day, hours: day.hours.map(({ hour, surplusW }) => ({ hour, surplusW })) });
  dirty = true;
}

/** Drop every frozen day that starts before `oldestKeptDayStartMs` (it has left the window). */
export function pruneFrozenCurtailmentDays(oldestKeptDayStartMs: number): void {
  ensureLoaded();
  for (const k of [...frozen.keys()]) {
    if (k < oldestKeptDayStartMs) { frozen.delete(k); dirty = true; }
  }
}

/** Write the store when it changed. Atomic; a failure is logged once and retried on the next call. */
export function persistFrozenCurtailmentDays(log: (m: string) => void = () => {}): void {
  ensureLoaded();
  if (!dirty || !storePath) return;
  try {
    const days = [...frozen.values()].sort((a, b) => a.dayStartMs - b.dayStartMs);
    atomicWriteFileSync(storePath, JSON.stringify({ v: 1, days }));
    dirty = false;
    writeWarned = false;
  } catch (e) {
    if (!writeWarned) {
      writeWarned = true;
      log(`curtailment: could not save the frozen days (${(e as Error)?.message ?? e}) — retrying on each refresh; a restart before a save re-estimates them`);
    }
  }
}

/** Test seam: the frozen days currently held, oldest first. */
export function frozenCurtailmentDaysForTesting(): FrozenCurtailmentDay[] {
  ensureLoaded();
  return [...frozen.values()].sort((a, b) => a.dayStartMs - b.dayStartMs);
}

/** Test seam: forget everything in memory, as a restart does; the next use re-resolves the path
 *  from the environment and reloads the file. */
export function resetCurtailmentFreezeForTesting(): void {
  frozen.clear();
  storePath = null;
  dirty = false;
  writeWarned = false;
}
