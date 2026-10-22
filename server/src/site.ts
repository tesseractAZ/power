/**
 * site.ts — where the install is, what its PV array is, and the site facts GET /api/site serves
 * (plan 2.2 and 2.7; section 3.6).
 *
 * v1.191.0 (S7, lane C). Unset means today, in every part of this module:
 *
 *   - Location. `siteLocation()` is FORECAST_LAT / FORECAST_LON, read exactly as config.ts reads
 *     them. With SITE_LOCATION_FROM_HA on (OWNER DECISION 5, optional) it is Home Assistant's home
 *     latitude and longitude instead — but only a location saved by an EARLIER run: the main thread
 *     reads /core/api/config in the background after boot (checkHaHomeLocation) and saves what it
 *     finds, and a location saved during this run is ignored until the next start. So boot never
 *     waits on Home Assistant, the coordinates never change while the process runs, and the analytics
 *     worker (CA17: a second instance of this module) resolves exactly what the main thread does.
 *   - PV array. `pvSite()` is the clearSky.ts legacy site object itself (PHOENIX_SITE: 16 800 W,
 *     25° tilt, due south, NOCT 45, −0.0035/°C, derate 0.85, the placeholder coordinates) while no
 *     PV_* option is set. Once any is set, the array takes the PV_* values and the site moves onto
 *     siteLocation(); switching to the configured coordinates without a PV_* option would change an
 *     install whose FORECAST_LAT/LON differ from the placeholder (golden G5 pins the legacy path).
 *   - Strings. PV_STRINGS describes each Core's strings (`hv=10x400,lv=4x400`), with overrides per
 *     panel slot or per Core name (CA23: `hv=10x400,lv=4x400; slot2=hv=8x450`); unset is today's
 *     10 + 4 × 400 W on every panel-bound Core.
 *   - Solar assumptions for the web (CA24). The hemisphere comes from the sign of the latitude and
 *     solar noon from the longitude and the zone; the web keeps today's bands while the PV site is
 *     the legacy site (a solar-noon band would move this install's text by about half an hour).
 *   - Notices (main thread only). A boot notice and a repair issue when Home Assistant's home is more
 *     than 50 km from FORECAST_LAT/LON (keyed on Home Assistant's coordinates, never on equality with
 *     the shipped default, which a deliberate choice cannot be told apart from), and CA20's
 *     "reference-home defaults in effect" when the zone is not the reference zone while TARIFF_PLAN is
 *     unset, or the site is more than 50 km from the placeholder while no PV_* option is set.
 *
 * Fields other lanes own are marked CA27 below: each lane replaces its own stub line only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { request } from 'undici';
import { config, option, DEFAULT_SITE_LAT, DEFAULT_SITE_LON, DEFAULT_SITE_TIME_ZONE } from './config.js';
import { siteTimeZone, siteTimeZoneSource, type SiteTimeZoneSource } from './siteTime.js';
import { tariffCurrency } from './money.js';
import { REFERENCE_HOME_DEFAULTS_ISSUE_ID } from './tariff.js';
import { MAINS_V, SHP2_SOURCE_SLOTS } from './hwSpec.js';
import { isBenchSpareSn } from './shp2Membership.js';
import { PHOENIX_SITE, clearSkyGHI, equationOfTime, solarPosition, type SiteParams } from './physics/clearSky.js';
import { benchSpareOptionSet } from './topology.js';
import type { DeviceSnapshot } from './snapshot.js';
import type { RepairIssue } from './repairIssues.js';
import type { WeatherForecast } from './weather.js';

/* ───────────────────── inputs other lanes fill (CA27 stubs) ───────────────────── */

/** The resolved site zone (lane A: siteTime.ts — SITE_TIMEZONE, then TZ, then the default). */
export const siteZoneInput = (): string => siteTimeZone();
/** Where the zone came from (lane A). */
export const siteZoneSourceInput = (): SiteTimeZoneSource => siteTimeZoneSource();
/** The tariff currency (lane B: TARIFF_CURRENCY, USD when unset). */
export const siteCurrencyInput = (): string => tariffCurrency().code;
/** Is TARIFF_PLAN unset (lane B)? Then the APS R-EV preset is in effect, the tariff half of CA20. */
export const tariffPlanUnsetInput = (): boolean => option<string | null>('TARIFF_PLAN') == null;
/**
 * Is BENCH_SPARE_SNS set (lane D: topology.ts)? While it is not, the per-DPU `benchSpare` flag is
 * withheld from /api/site, and the web keeps today's rule (every DPU that is not a panel source is a
 * spare with no array): unset, the floor is the built-in list, which does not name every bench unit,
 * so labelling from it would change the Solar page (plan 3.8 S3).
 */
export const benchSpareOptionSetInput = (): boolean => benchSpareOptionSet();

/** The zone the reference home runs in (CA20 compares the resolved zone with it): the site clock's
 *  default, whose one literal is in config.ts (siteTimeLiteral.test.ts). */
export const REFERENCE_ZONE = DEFAULT_SITE_TIME_ZONE;

/* ───────────────────────────── location ───────────────────────────── */

export type LocationSource = 'FORECAST_LAT/LON' | 'home-assistant';
export interface SiteLocation { lat: number; lon: number; source: LocationSource }

const validLatLon = (lat: unknown, lon: unknown): lat is number =>
  typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
  && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** When this process started: the same instant in the main thread and the analytics worker. */
const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

/** Where the background read saves Home Assistant's home location (beside the database). */
export function haLocationPath(): string {
  return config.dataFile('site-location.json', option<string | null>('SITE_LOCATION_PATH'));
}

interface SavedLocation { lat: number; lon: number; savedAt: number }
function readSaved(path: string): SavedLocation | null {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<SavedLocation> | null;
    if (j && validLatLon(j.lat, j.lon) && typeof j.savedAt === 'number' && Number.isFinite(j.savedAt)) {
      return { lat: j.lat, lon: j.lon as number, savedAt: j.savedAt };
    }
  } catch { /* a corrupt file reads as none */ }
  return null;
}

let savedMemo: { lat: number; lon: number } | null | undefined;
/** The saved Home Assistant location this run uses: read once, and only one saved before the run began. */
function savedForThisRun(): { lat: number; lon: number } | null {
  if (savedMemo !== undefined) return savedMemo;
  const s = readSaved(haLocationPath());
  savedMemo = s && s.savedAt < PROCESS_START_MS ? { lat: s.lat, lon: s.lon } : null;
  return savedMemo;
}

/**
 * The site's coordinates. FORECAST_LAT / FORECAST_LON exactly as the forecast, the storm alerts and
 * the energy bridge read them before v1.191.0 (`config.forecastLat` / `forecastLon`), or, with
 * SITE_LOCATION_FROM_HA on, Home Assistant's home as saved by an earlier run.
 */
export function siteLocation(): SiteLocation {
  if (option<boolean>('SITE_LOCATION_FROM_HA')) {
    const saved = savedForThisRun();
    if (saved) return { ...saved, source: 'home-assistant' };
  }
  return { lat: config.forecastLat, lon: config.forecastLon, source: 'FORECAST_LAT/LON' };
}

/** The site's coordinates in the shape the forecast fetchers and energyBridge.bridgeSite take. */
export function siteCoordinates(): { forecastLat: number; forecastLon: number } {
  const l = siteLocation();
  return { forecastLat: l.lat, forecastLon: l.lon };
}

/** Great-circle distance in km (haversine, mean Earth radius). */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Beyond this, a location is "elsewhere" (OWNER DECISION 5, CA20). */
export const SITE_FAR_KM = 50;

/* ───────────────────────────── PV array ───────────────────────────── */

export const PV_KEYS = ['PV_ARRAY_KWP', 'PV_TILT_DEG', 'PV_AZIMUTH_DEG', 'PV_STRINGS'] as const;

/** Is any PV_* option set? Then the PV site is the configured one. */
export function pvConfigured(): boolean {
  return PV_KEYS.some((k) => option<unknown>(k) != null);
}

/**
 * The install's PV array and site. Exactly PHOENIX_SITE (the same object) while no PV_* option is
 * set; otherwise the PV_* values over the reference array's, at siteLocation() (the placeholder
 * coordinates if those are not a usable coordinate).
 */
export function pvSite(): SiteParams {
  if (!pvConfigured()) return PHOENIX_SITE;
  const loc = siteLocation();
  const usable = validLatLon(loc.lat, loc.lon);
  const kwp = option<number | null>('PV_ARRAY_KWP');
  const tilt = option<number | null>('PV_TILT_DEG');
  const azimuth = option<number | null>('PV_AZIMUTH_DEG');
  return {
    ...PHOENIX_SITE,
    lat: usable ? loc.lat : DEFAULT_SITE_LAT,
    lon: usable ? loc.lon : DEFAULT_SITE_LON,
    pNamplate: kwp != null ? kwp * 1000 : PHOENIX_SITE.pNamplate,
    tilt: tilt ?? PHOENIX_SITE.tilt,
    azimuth: azimuth ?? PHOENIX_SITE.azimuth,
  };
}

/** The legacy site: no PV_* option set (the web keeps today's solar bands; physics keeps 30 °C). */
export const isLegacyPvSite = (site: SiteParams): boolean => site === PHOENIX_SITE;

/** Ambient the clear-sky model assumes on the legacy site. */
export const LEGACY_PHYSICS_AMBIENT_C = 30;

/**
 * Ambient (°C) for the clear-sky Pmax at `ts`: 30 °C on the legacy site, as today; on a configured
 * site the weather cache's temperature_2m for the hour holding `ts` (30 °C when it has none).
 */
export function physicsAmbientC(ts: number, site: SiteParams, wx: Pick<WeatherForecast, 'hours'> | null): number {
  if (isLegacyPvSite(site)) return LEGACY_PHYSICS_AMBIENT_C;
  const hourMs = Math.floor(ts / 3_600_000) * 3_600_000;
  const h = wx?.hours.find((x) => x.ts === hourMs);
  return h && Number.isFinite(h.tempC) ? h.tempC : LEGACY_PHYSICS_AMBIENT_C;
}

/** The curtailment heuristic's GHI ceiling on the legacy site ("Phoenix mid-summer clear-sky ceiling"). */
export const LEGACY_CURTAIL_GHI_CAP_WM2 = 900;

/** The highest clear-sky GHI the site sees at solar noon over a year (Haurwitz; zenith |lat| − 23.44°, floored at 0). */
export function maxNoonClearSkyGhiWm2(lat: number): number {
  const zenithDeg = Math.max(0, Math.abs(lat) - 23.44);
  return clearSkyGHI(Math.cos((zenithDeg * Math.PI) / 180));
}

/**
 * The curtailment heuristic's GHI ceiling (analytics.ts, the hour with no weather): 900 W/m² on the
 * legacy site, as today; on a configured site the site's own clear-sky noon ceiling, never above 900
 * (at the reference latitude the clear-sky noon peak is ~1 020 W/m², so 900 stays the cap there).
 */
export function curtailGhiCapWm2(site: SiteParams = pvSite()): number {
  if (isLegacyPvSite(site)) return LEGACY_CURTAIL_GHI_CAP_WM2;
  return Math.min(LEGACY_CURTAIL_GHI_CAP_WM2, Math.round(maxNoonClearSkyGhiWm2(site.lat)));
}

/* ───────────────────────────── PV strings ───────────────────────────── */

export interface PvString { count: number; watts: number }
export interface PvStrings { hv: PvString; lv: PvString }
/** Today's layout: a 10-panel high-voltage and a 4-panel low-voltage string of 400 W on each Core. */
export const DEFAULT_PV_STRINGS: PvStrings = Object.freeze({
  hv: Object.freeze({ count: 10, watts: 400 }),
  lv: Object.freeze({ count: 4, watts: 400 }),
}) as PvStrings;

export interface PvStringsSpec {
  /** The layout every Core takes unless an override names it. */
  global: PvStrings;
  /** Overrides by panel source slot (1..3). A field an override leaves out takes the global one. */
  bySlot: Map<number, Partial<PvStrings>>;
  /** Overrides by Core name (case and spacing ignored). */
  byName: Map<string, Partial<PvStrings>>;
  /** Parse errors; any error drops the whole spec back to the default (fail closed, plan P5). */
  errors: string[];
}

const normName = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
const MAX_PANELS_PER_STRING = 100;
const MAX_PANEL_W = 2000;

function parseStringsBody(body: string, where: string, errors: string[]): Partial<PvStrings> | null {
  const out: Partial<PvStrings> = {};
  for (const tokRaw of body.split(',')) {
    const tok = tokRaw.trim();
    if (!tok) continue;
    const none = /^(hv|lv)\s*=\s*0$/i.exec(tok);
    const m = /^(hv|lv)\s*=\s*(\d+)\s*[x×*]\s*(\d+(?:\.\d+)?)$/i.exec(tok);
    if (!none && !m) { errors.push(`${where}: "${tok}" is not hv=<panels>x<watts> or lv=<panels>x<watts>`); return null; }
    const ch = (none ?? m)![1].toLowerCase() as 'hv' | 'lv';
    if (out[ch]) { errors.push(`${where}: ${ch} is given twice`); return null; }
    if (none) { out[ch] = { count: 0, watts: 0 }; continue; }
    const count = Number(m![2]);
    const watts = Number(m![3]);
    if (count > MAX_PANELS_PER_STRING || watts <= 0 || watts > MAX_PANEL_W) {
      errors.push(`${where}: "${tok}" is outside 0..${MAX_PANELS_PER_STRING} panels of 1..${MAX_PANEL_W} W`);
      return null;
    }
    out[ch] = count === 0 ? { count: 0, watts: 0 } : { count, watts };
  }
  if (!out.hv && !out.lv) { errors.push(`${where}: names no string`); return null; }
  return out;
}

/**
 * Parse PV_STRINGS. Entries are separated by `;`. One entry without a selector is the layout every
 * Core takes (`hv=10x400,lv=4x400`); an entry `slot<N>=…` or `<Core name>=…` overrides one Core
 * (`slot2=hv=8x450`), a string it leaves out taking the global one. `hv=0` / `lv=0` is no string.
 * A string the global entry leaves out takes today's. Unset (null) is today's layout everywhere.
 */
export function parsePvStrings(raw: string | null | undefined): PvStringsSpec {
  const spec: PvStringsSpec = { global: DEFAULT_PV_STRINGS, bySlot: new Map(), byName: new Map(), errors: [] };
  if (raw == null || raw.trim() === '') return spec;
  const errors: string[] = [];
  let global: Partial<PvStrings> | null = null;
  const bySlot = new Map<number, Partial<PvStrings>>();
  const byName = new Map<string, Partial<PvStrings>>();
  for (const entryRaw of raw.split(';')) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    if (/^(hv|lv)\s*=/i.test(entry)) {
      if (global) { errors.push('two entries without a slot or Core name'); continue; }
      global = parseStringsBody(entry, 'the global entry', errors);
      continue;
    }
    const eq = entry.indexOf('=');
    if (eq <= 0) { errors.push(`"${entry}" is neither a layout nor <slot or Core name>=<layout>`); continue; }
    const selector = entry.slice(0, eq).trim();
    const body = parseStringsBody(entry.slice(eq + 1), selector, errors);
    if (!body) continue;
    const slot = /^slot\s*(\d+)$/i.exec(selector);
    if (slot) {
      const n = Number(slot[1]);
      if (n < 1 || n > SHP2_SOURCE_SLOTS) { errors.push(`${selector}: a panel has slots 1..${SHP2_SOURCE_SLOTS}`); continue; }
      if (bySlot.has(n)) { errors.push(`${selector} is given twice`); continue; }
      bySlot.set(n, body);
    } else {
      const k = normName(selector);
      if (byName.has(k)) { errors.push(`"${selector}" is given twice`); continue; }
      byName.set(k, body);
    }
  }
  if (errors.length > 0) return { ...spec, errors };
  return {
    global: { hv: global?.hv ?? DEFAULT_PV_STRINGS.hv, lv: global?.lv ?? DEFAULT_PV_STRINGS.lv },
    bySlot,
    byName,
    errors: [],
  };
}

/** The PV_STRINGS option, parsed. */
export function pvStrings(): PvStringsSpec {
  return parsePvStrings(option<string | null>('PV_STRINGS'));
}

/** One Core's strings: an override for its name, else for its panel slot, else the global layout. */
export function pvStringsFor(spec: PvStringsSpec, core: { name?: string | null; slot?: number | null }): PvStrings {
  const o = (core.name != null ? spec.byName.get(normName(core.name)) : undefined)
    ?? (core.slot != null ? spec.bySlot.get(core.slot) : undefined);
  return { hv: o?.hv ?? spec.global.hv, lv: o?.lv ?? spec.global.lv };
}

const stringsW = (s: PvStrings): number => s.hv.count * s.hv.watts + s.lv.count * s.lv.watts;

/**
 * PV_STRINGS against PV_ARRAY_KWP, for the boot warning: the strings' total over `coreCount` panel
 * Cores (each override taken to name one Core) differs from the nameplate by more than 5 %. null when
 * either is unset, the spec is invalid, or the Core count is not known yet.
 */
export function pvStringsArrayMismatch(spec: PvStringsSpec, kwp: number | null, coreCount: number): { stringsW: number; nameplateW: number } | null {
  if (kwp == null || spec.errors.length > 0 || coreCount <= 0) return null;
  if (option<string | null>('PV_STRINGS') == null) return null;
  const overrides = [...spec.bySlot.values(), ...spec.byName.values()].slice(0, coreCount);
  const full = (o: Partial<PvStrings>): PvStrings => ({ hv: o.hv ?? spec.global.hv, lv: o.lv ?? spec.global.lv });
  const total = overrides.reduce((s, o) => s + stringsW(full(o)), 0) + (coreCount - overrides.length) * stringsW(spec.global);
  const nameplateW = kwp * 1000;
  return Math.abs(total - nameplateW) > 0.05 * nameplateW ? { stringsW: total, nameplateW } : null;
}

/* ───────────────────────────── solar assumptions (CA24) ───────────────────────────── */

/** The zone's UTC offset in minutes at `ms` (en-US formatToParts, the codebase's pattern; CA16). */
export function zoneOffsetMinutes(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Solar noon at `lon` on the day holding `ms`, in the zone's decimal hours (longitude, zone offset, equation of time). */
export function solarNoonLocalHour(ms: number, lon: number, zone: string): number {
  const utcNoonMin = 720 - 4 * lon - equationOfTime(new Date(ms));
  const local = (utcNoonMin + zoneOffsetMinutes(ms, zone)) / 60;
  return ((local % 24) + 24) % 24;
}

/** The local hours the web's daylight band spans on the legacy site (SolarResponseCard, today's 4..21). */
export const LEGACY_DAYLIGHT_HOURS: readonly [number, number] = [4, 21];

const daylightMemo = new Map<string, [number, number]>();
/**
 * The local hours in which the sun is up on any day of the year at (lat, lon), widened by an hour
 * each side: [first, last], in the zone's clock (DST included). A site with a midnight sun spans the
 * whole day.
 */
export function daylightHours(lat: number, lon: number, zone: string, year = 2026): [number, number] {
  const key = `${lat}|${lon}|${zone}|${year}`;
  const hit = daylightMemo.get(key);
  if (hit) return hit;
  let first = 24;
  let last = -1;
  for (let day = 0; day < 366; day += 3) {
    const dayStart = Date.UTC(year, 0, 1) + day * 86_400_000;
    const offsetMin = zoneOffsetMinutes(dayStart + 12 * 3_600_000, zone);
    for (let m = 0; m < 24 * 60; m += 10) {
      const localMs = dayStart + m * 60_000;
      if (solarPosition(new Date(localMs - offsetMin * 60_000), lat, lon).elevation <= 0) continue;
      const h = Math.floor(m / 60);
      if (h < first) first = h;
      if (h > last) last = h;
    }
  }
  const out: [number, number] = last < 0 ? [...LEGACY_DAYLIGHT_HOURS] as [number, number] : [Math.max(0, first - 1), Math.min(23, last + 1)];
  daylightMemo.set(key, out);
  return out;
}

export interface SiteSolar {
  /** The PV site is the legacy site: the web keeps today's orientation bands and daylight band. */
  legacy: boolean;
  hemisphere: 'north' | 'south';
  /** Solar noon today in site-local decimal hours. */
  solarNoonHour: number;
  /** The daylight band [first, last] in site-local hours. */
  daylightHours: [number, number];
}

/** The web's solar assumptions. A zone Intl cannot resolve answers as the legacy site does (today's bands), never as UTC. */
export function siteSolar(site: SiteParams, zone: string, now: number): SiteSolar {
  const legacy = isLegacyPvSite(site);
  const hemisphere = site.lat < 0 ? 'south' : 'north';
  try {
    return {
      legacy,
      hemisphere,
      solarNoonHour: Math.round(solarNoonLocalHour(now, site.lon, zone) * 100) / 100,
      daylightHours: legacy ? [...LEGACY_DAYLIGHT_HOURS] as [number, number] : daylightHours(site.lat, site.lon, zone),
    };
  } catch {
    return { legacy: true, hemisphere, solarNoonHour: 12, daylightHours: [...LEGACY_DAYLIGHT_HOURS] as [number, number] };
  }
}

/* ───────────────────────────── GET /api/site ───────────────────────────── */

export interface SiteResponse {
  /** IANA zone the site runs on, and where it came from (siteTime.ts: SITE_TIMEZONE, TZ or the default). */
  siteTimeZone: string;
  source: SiteTimeZoneSource;
  /** The site's coordinates (siteLocation) and where they came from. */
  lat: number;
  lon: number;
  locationSource: LocationSource;
  /** ISO 4217 currency of the tariff figures. */
  currency: string;
  /** The PV layout every panel-bound Core takes unless an override names it (PV_STRINGS; today's 10 + 4 × 400 W). */
  pvStrings: PvStrings;
  pvStringsSource: 'default' | 'PV_STRINGS';
  /** Each DPU's own strings (CA23: an override for its name or panel slot, else the layout above). */
  pvStringsPerDpu: Record<string, PvStrings>;
  /** The PV array the physics uses (pvSite) and whether it is the legacy site. */
  pv: { source: 'legacy' | 'configured'; nameplateW: number; tiltDeg: number; azimuthDeg: number };
  /** The web's solar assumptions (CA24). */
  solar: SiteSolar;
  /** Mains voltages (hwSpec.ts, read-only): North American split phase. */
  mainsV: { line: number; split: number };
  /** Per-DPU: is this unit a bench spare (its offline state expected)? Present only while BENCH_SPARE_SNS is set (lane D). */
  perDpu: Record<string, { benchSpare: boolean }>;
}

/** Each DPU's panel source slot, from every panel's source list (null when it is on none). */
function slotOf(devices: Record<string, DeviceSnapshot>, sn: string): number | null {
  for (const d of Object.values(devices)) {
    if (d.projection?.kind !== 'shp2') continue;
    const s = (d.projection.sources ?? []).find((x) => x.sn === sn);
    if (s) return s.slot;
  }
  return null;
}

/** The site facts. `lastKnownRoster` is the published roster the spare floor honours (null = literal alone). */
export function siteResponse(
  devices: Record<string, DeviceSnapshot>,
  lastKnownRoster?: ReadonlySet<string> | null,
  now: number = Date.now(),
): SiteResponse {
  const spec = pvStrings();
  const zone = siteZoneInput();
  const site = pvSite();
  const loc = siteLocation();
  const perDpu: Record<string, { benchSpare: boolean }> = {};
  const pvStringsPerDpu: Record<string, PvStrings> = {};
  const flagOn = benchSpareOptionSetInput();
  for (const d of Object.values(devices)) {
    if (d.projection?.kind !== 'dpu') continue;
    pvStringsPerDpu[d.sn] = pvStringsFor(spec, { name: d.deviceName, slot: slotOf(devices, d.sn) });
    if (flagOn) perDpu[d.sn] = { benchSpare: isBenchSpareSn(d.sn, lastKnownRoster) };
  }
  return {
    siteTimeZone: zone,
    source: siteZoneSourceInput(),
    lat: loc.lat,
    lon: loc.lon,
    locationSource: loc.source,
    currency: siteCurrencyInput(),
    pvStrings: spec.global,
    pvStringsSource: option<string | null>('PV_STRINGS') != null && spec.errors.length === 0 ? 'PV_STRINGS' : 'default',
    pvStringsPerDpu,
    pv: { source: isLegacyPvSite(site) ? 'legacy' : 'configured', nameplateW: site.pNamplate, tiltDeg: site.tilt, azimuthDeg: site.azimuth },
    solar: siteSolar(site, zone, now),
    mainsV: { line: MAINS_V.line, split: MAINS_V.split },
    perDpu,
  };
}

/* ───────────────────────────── notices (main thread only) ───────────────────────────── */

export const SITE_REPAIR_IDS = {
  locationFar: 'site-location-far-from-home',
  locationPending: 'site-location-from-ha-pending',
  referenceDefaults: REFERENCE_HOME_DEFAULTS_ISSUE_ID, // CA20's one id, named in tariff.ts (its tariff half)
  pvStringsInvalid: 'site-pv-strings-invalid',
} as const;

const activeIssues = new Map<string, RepairIssue>();
function raise(issue: Omit<RepairIssue, 'firstSeenAt'>, now: number): void {
  const prev = activeIssues.get(issue.id);
  activeIssues.set(issue.id, { ...issue, firstSeenAt: prev?.firstSeenAt ?? now });
}
const clear = (id: string): void => { activeIssues.delete(id); };

/** The site's active repair issues, appended to GET /api/repair-issues (index.ts). */
export function siteRepairIssues(): RepairIssue[] {
  return [...activeIssues.values()];
}

/** Test seam: forget the raised issues and the saved-location read. */
export function resetSiteForTesting(): void {
  activeIssues.clear();
  savedMemo = undefined;
  daylightMemo.clear();
}

export interface ReferenceDefaultsInput {
  zone: string;
  tariffPlanUnset: boolean;
  location: { lat: number; lon: number };
  pvConfigured: boolean;
}

/**
 * CA20 — the reference home's defaults in effect on what is evidently another home. Each reason:
 * the zone is not the reference zone while TARIFF_PLAN is unset (the APS preset's windows on another
 * clock), or the site is more than 50 km from the placeholder while no PV_* option is set (the
 * reference roof's 16.8 kW array somewhere else). Empty on the reference install.
 */
export function referenceDefaultsReasons(i: ReferenceDefaultsInput): string[] {
  const out: string[] = [];
  if (i.zone !== REFERENCE_ZONE && i.tariffPlanUnset) {
    out.push(`the site runs on ${i.zone} but no TARIFF_PLAN is set, so the built-in APS R-EV tariff and its night-charge windows apply`);
  }
  const km = validLatLon(i.location.lat, i.location.lon)
    ? distanceKm(i.location, { lat: DEFAULT_SITE_LAT, lon: DEFAULT_SITE_LON })
    : 0;
  if (km > SITE_FAR_KM && !i.pvConfigured) {
    out.push(`the site is ${Math.round(km)} km from the reference location but no PV_* option is set, so the physics model uses the reference home's 16.8 kWp array`);
  }
  return out;
}

export interface SiteLog { info(m: string): void; warn(m: string): void }

/**
 * The boot notices that need nothing from Home Assistant (main thread, synchronous, no I/O):
 * CA20's reference-defaults notice, an invalid PV_STRINGS, PV_STRINGS against PV_ARRAY_KWP, and one
 * line naming where the site's facts come from. `rosterSize` is the persisted panel roster's size.
 */
export function siteBootNotices(log: SiteLog, opts: { rosterSize: number; now?: number }): void {
  const now = opts.now ?? Date.now();
  const configured = pvConfigured();
  const loc = siteLocation();
  log.info(`site: location from ${loc.source}; PV array ${configured ? `configured (${(pvSite().pNamplate / 1000).toFixed(1)} kWp)` : 'the reference array (no PV_* option set)'}`);

  const reasons = referenceDefaultsReasons({ zone: siteZoneInput(), tariffPlanUnset: tariffPlanUnsetInput(), location: loc, pvConfigured: configured });
  if (reasons.length > 0) {
    log.warn(`site: the reference home's defaults are in effect: ${reasons.join('; ')}`);
    raise({
      id: SITE_REPAIR_IDS.referenceDefaults,
      severity: 'warning',
      title: "The reference home's defaults are in effect",
      summary: `${reasons.map((r) => r[0].toUpperCase() + r.slice(1)).join('. ')}.`,
      fixSteps: [
        'Set TARIFF_PLAN and its rates for your utility (Configuration tab).',
        'Set PV_ARRAY_KWP, PV_TILT_DEG and PV_AZIMUTH_DEG (and PV_STRINGS) for your array.',
        'Check FORECAST_LAT / FORECAST_LON (or turn on SITE_LOCATION_FROM_HA), then restart the add-on.',
      ],
      category: 'Configuration',
      estimatedTimeMinutes: 10,
    }, now);
  } else {
    clear(SITE_REPAIR_IDS.referenceDefaults);
  }

  const spec = pvStrings();
  if (spec.errors.length > 0) {
    log.warn(`site: PV_STRINGS is not valid (${spec.errors.join('; ')}); every Core takes the default 10 + 4 × 400 W layout`);
    raise({
      id: SITE_REPAIR_IDS.pvStringsInvalid,
      severity: 'warning',
      title: 'PV_STRINGS is not valid',
      summary: `${spec.errors.join('; ')}. The Solar page shows the default layout until it is fixed.`,
      fixSteps: [
        'Write each Core\'s strings as hv=<panels>x<watts>,lv=<panels>x<watts>, e.g. hv=10x400,lv=4x400.',
        'Add an override per Core after a semicolon, keyed by panel slot or Core name: ; slot2=hv=8x450.',
        'Save; the add-on restarts with the new layout.',
      ],
      category: 'Configuration',
      estimatedTimeMinutes: 5,
    }, now);
  } else {
    clear(SITE_REPAIR_IDS.pvStringsInvalid);
  }

  if (configured && option<number | null>('PV_ARRAY_KWP') == null) {
    log.warn('site: a PV_* option is set but PV_ARRAY_KWP is not: the physics model keeps the reference 16.8 kWp nameplate; set PV_ARRAY_KWP to the array total');
  }
  const mismatch = pvStringsArrayMismatch(spec, option<number | null>('PV_ARRAY_KWP'), opts.rosterSize);
  if (mismatch) {
    log.warn(`site: PV_STRINGS adds up to ${(mismatch.stringsW / 1000).toFixed(2)} kWp over ${opts.rosterSize} panel Core(s) but PV_ARRAY_KWP is ${(mismatch.nameplateW / 1000).toFixed(2)} kWp; the physics model uses PV_ARRAY_KWP`);
  }
}

/** Home Assistant's `/core/api/config` fields this module reads. */
export interface HaCoreConfig { latitude?: unknown; longitude?: unknown }

/** GET /core/api/config through the Supervisor proxy; null outside Home Assistant or on any failure. */
export async function fetchHaCoreConfig(): Promise<HaCoreConfig | null> {
  const token = option<string | undefined>('SUPERVISOR_TOKEN');
  if (!token) return null;
  try {
    const res = await request('http://supervisor/core/api/config', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) { await res.body.dump(); return null; }
    return (await res.body.json()) as HaCoreConfig;
  } catch {
    return null;
  }
}

export type HaLocationOutcome = 'unavailable' | 'within' | 'far' | 'saved' | 'unchanged';

/**
 * The background read of Home Assistant's home location (main thread only; never awaited by boot).
 *
 *   - SITE_LOCATION_FROM_HA off: Home Assistant's home against FORECAST_LAT/LON. More than 50 km
 *     apart is a boot notice and a repair issue; within, the issue clears. The comparison is keyed on
 *     Home Assistant's coordinates, never on whether FORECAST_LAT/LON still hold the shipped default.
 *   - SITE_LOCATION_FROM_HA on: the home location is saved beside the database when it differs from
 *     the saved one, and applies from the next start (this run's coordinates never change). While the
 *     run uses another location than the one saved, an info repair issue asks for a restart.
 */
export async function checkHaHomeLocation(deps: {
  log: SiteLog;
  fetchConfig?: () => Promise<HaCoreConfig | null>;
  now?: () => number;
}): Promise<HaLocationOutcome> {
  const now = deps.now ?? Date.now;
  const cfg = await (deps.fetchConfig ?? fetchHaCoreConfig)();
  const lat = cfg?.latitude;
  const lon = cfg?.longitude;
  if (!validLatLon(lat, lon)) return 'unavailable';
  const home = { lat, lon: lon as number };

  if (option<boolean>('SITE_LOCATION_FROM_HA')) {
    const path = haLocationPath();
    const saved = readSaved(path);
    let outcome: HaLocationOutcome = 'unchanged';
    if (!saved || distanceKm(saved, home) > 0.1) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify({ lat: home.lat, lon: home.lon, savedAt: now() }));
        renameSync(tmp, path);
        outcome = 'saved';
        deps.log.info("site: Home Assistant's home location is saved (SITE_LOCATION_FROM_HA); the site uses it from the next start");
      } catch (e) {
        deps.log.warn(`site: could not save Home Assistant's home location: ${(e as Error)?.message ?? e}`);
        return 'unavailable';
      }
    }
    const inUse = siteLocation();
    if (inUse.source !== 'home-assistant' || distanceKm(inUse, home) > 0.1) {
      raise({
        id: SITE_REPAIR_IDS.locationPending,
        severity: 'info',
        title: "Restart to use Home Assistant's home location",
        summary: "SITE_LOCATION_FROM_HA is on and Home Assistant's home location has been saved, but this run started with another location; the forecast, the day/night test and the PV site switch to it at the next start.",
        fixSteps: ['Restart the add-on (Settings → Add-ons → Power → Restart).'],
        category: 'Configuration',
        estimatedTimeMinutes: 1,
      }, now());
    } else {
      clear(SITE_REPAIR_IDS.locationPending);
    }
    clear(SITE_REPAIR_IDS.locationFar);
    return outcome;
  }

  const configured = { lat: config.forecastLat, lon: config.forecastLon };
  const km = validLatLon(configured.lat, configured.lon) ? distanceKm(home, configured) : Number.POSITIVE_INFINITY;
  if (km > SITE_FAR_KM) {
    const how = Number.isFinite(km) ? `${Math.round(km)} km from` : 'not comparable with';
    deps.log.warn(`site: Home Assistant's home is ${how} FORECAST_LAT/LON; the solar forecast and the day/night test use FORECAST_LAT/LON`);
    raise({
      id: SITE_REPAIR_IDS.locationFar,
      severity: 'warning',
      title: "The site location is far from Home Assistant's home",
      summary: `Home Assistant's home location is ${how} the configured FORECAST_LAT / FORECAST_LON. The solar forecast, the day/night test and the PV model use the configured coordinates; the shipped default is a placeholder.`,
      fixSteps: [
        'Set FORECAST_LAT and FORECAST_LON to the install location (Configuration tab), or',
        "turn on SITE_LOCATION_FROM_HA to use Home Assistant's home location.",
        'Save; the add-on restarts.',
      ],
      category: 'Configuration',
      estimatedTimeMinutes: 5,
    }, now());
    return 'far';
  }
  clear(SITE_REPAIR_IDS.locationFar);
  return 'within';
}
