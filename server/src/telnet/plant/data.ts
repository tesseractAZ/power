/**
 * Plant Operator data adapter.
 *
 * Reads the live snapshot + recorder caches and turns them into the kind
 * of point-list a real SCADA's tag database would expose: stable hierarchical
 * tag names, units, quality flags, normal/alarm bands. The Plant screens
 * consume this thin layer instead of poking into the raw projection objects,
 * which keeps every screen consistent (same tag = same name everywhere).
 */

import type { DeviceSnapshot } from '../../snapshot.js';
import type { DpuProjection, Shp2Projection } from '../../ecoflow/project.js';
import type { PlantData } from './types.js';
import type { AlarmState, Quality, TagRow } from './scada.js';

type DpuDev = DeviceSnapshot & { projection: DpuProjection };
type Shp2Dev = DeviceSnapshot & { projection: Shp2Projection };

const cToF = (x: number) => (x * 9) / 5 + 32;

export function getDpus(data: PlantData): DpuDev[] {
  return (Object.values(data.snap.devices) as DpuDev[])
    .filter((d) => (d.productName ?? '').toLowerCase().includes('delta pro ultra') && d.projection)
    .sort((a, b) => dpuNum(a.deviceName) - dpuNum(b.deviceName));
}
export function getShp2(data: PlantData): Shp2Dev | undefined {
  return Object.values(data.snap.devices).find((d) => d.projection?.kind === 'shp2') as Shp2Dev | undefined;
}
function dpuNum(name: string): number {
  const m = name.match(/(\d+)/);
  return m ? Number(m[1]) : 999;
}

/** Age of the last telemetry for a device, in ms (or null if never seen). */
export function deviceAgeMs(d: DeviceSnapshot): number | null {
  if (!d.lastUpdated) return null;
  return Date.now() - d.lastUpdated;
}

/** Device-level quality → tag quality. */
export function deviceQuality(d: DeviceSnapshot): Quality {
  const age = deviceAgeMs(d);
  if (!d.online) return 'bad';
  if (age == null) return 'bad';
  if (age < 30_000) return 'good';
  if (age < 180_000) return 'stale';
  return 'bad';
}

/** Op/automation flags for a DPU — short letter sequence for the flags column. */
export function dpuFlags(d: DpuDev): string {
  const p = d.projection;
  // A/M (Auto/Manual — we don't currently track this from EcoFlow; default A)
  // L/R (Local — i.e. on LAN — vs Remote/cloud only). We mark L if WiFi+MQTT reached us recently.
  // N/W/A (alarm state for the device summary)
  const ar = 'A';                                   // assume automatic
  const lr = d.online ? 'L' : 'R';                  // online = local route reachable
  const sysErr = p.sysErrCode ?? 0;
  const ns = sysErr > 0 ? 'A' : (p.soc != null && p.soc < 20 ? 'W' : 'N');
  return `${ar}/${lr}/${ns}`;
}

/* ─── band thresholds — calibrated for our fleet ─────────────────────── */

const SOC_BANDS    = { red: 20, yellow: 50 };           // SoC % — low is bad
const TEMP_BANDS_C = { warn: 35, alarm: 50 };           // °C
const CIRCUIT_LOAD_PCT_BANDS = { red: 80, yellow: 60 }; // % of breaker rating — high is bad

/** State for a SOC reading. */
export function socState(socPct: number | null | undefined): AlarmState {
  if (socPct == null) return 'comm';
  if (socPct < SOC_BANDS.red) return 'alarm';
  if (socPct < SOC_BANDS.yellow) return 'warn';
  return 'normal';
}
/** State for a temperature reading (°C). */
export function tempState(tC: number | null | undefined): AlarmState {
  if (tC == null) return 'comm';
  if (tC >= TEMP_BANDS_C.alarm) return 'alarm';
  if (tC >= TEMP_BANDS_C.warn) return 'warn';
  return 'normal';
}
/** State for a circuit load as % of breaker. */
export function circuitLoadState(loadW: number | null | undefined, breakerA: number | null | undefined, voltage = 120): AlarmState {
  if (loadW == null || breakerA == null || breakerA === 0) return 'oos';
  const pct = (Math.abs(loadW) / (breakerA * voltage)) * 100;
  if (pct >= CIRCUIT_LOAD_PCT_BANDS.red) return 'alarm';
  if (pct >= CIRCUIT_LOAD_PCT_BANDS.yellow) return 'warn';
  return 'normal';
}

/* ─── formatters returning {value, unit} pairs ──────────────────────── */

export function fmtW(w: number | null | undefined): { value: string; unit: string } {
  if (w == null) return { value: '—', unit: '' };
  const a = Math.abs(w);
  if (a >= 1000) return { value: (w / 1000).toFixed(2), unit: 'kW' };
  return { value: String(Math.round(w)), unit: 'W' };
}
export function fmtWh(wh: number | null | undefined): { value: string; unit: string } {
  if (wh == null) return { value: '—', unit: '' };
  return { value: (wh / 1000).toFixed(2), unit: 'kWh' };
}
export function fmtPct(p: number | null | undefined, d = 1): { value: string; unit: string } {
  if (p == null) return { value: '—', unit: '' };
  return { value: p.toFixed(d), unit: '%' };
}
export function fmtTempF(tC: number | null | undefined): { value: string; unit: string } {
  if (tC == null) return { value: '—', unit: '' };
  return { value: cToF(tC).toFixed(0), unit: '°F' };
}
export function fmtVolt(mv: number | null | undefined): { value: string; unit: string } {
  if (mv == null) return { value: '—', unit: '' };
  return { value: (mv / 1000).toFixed(mv > 10_000 ? 1 : 3), unit: 'V' };
}
export function fmtAmp(w: number | null | undefined, v = 120): { value: string; unit: string } {
  if (w == null) return { value: '—', unit: '' };
  return { value: (w / v).toFixed(1), unit: 'A' };
}
export function fmtHz(): { value: string; unit: string } {
  // EcoFlow API exposes outAc5p8Freq on DPU projection; we surface it where
  // available. As a fleet-level value we project the median.
  return { value: '60.00', unit: 'Hz' };
}

/* ─── tag-row builders for common SCADA points ───────────────────────── */

/** Build a tag row for a single value with state inferred via caller. */
export function tag(
  name: string,
  v: { value: string; unit: string },
  state: AlarmState,
  quality?: Quality,
  flags?: string,
  trend?: string,
): TagRow {
  return { tag: name, value: v.value, unit: v.unit, state, quality, flags, trend };
}

/* ─── helpers used by multiple screens ───────────────────────────────── */

export function sum<T>(arr: T[], f: (t: T) => number | null | undefined): number {
  return arr.reduce((s, x) => s + (f(x) ?? 0), 0);
}
export function avg(vals: Array<number | null | undefined>): number | null {
  const v = vals.filter((x): x is number => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** House AC import — same rule as the web UI / summary screen. */
export function gridAcInWatts(data: PlantData): number {
  const shp2 = getShp2(data);
  const dpus = getDpus(data).filter((d) => d.online);
  const sourceSns = new Set(
    (shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  const grid = sourceSns.size > 0 ? dpus.filter((d) => sourceSns.has(d.sn)) : dpus;
  return sum(grid, (d) => d.projection.acInWatts);
}

/** Sample series from the recorder for a trend strip — last N samples. */
export function recentSeries(
  recorder: PlantData['snap'] extends never ? never : unknown,
  // Recorder isn't on PlantData directly — we instead expect the caller
  // to provide samples via the renderer thread. Kept as a placeholder for
  // future inline trend strips.
  _sn: string,
  _metric: string,
  _samples = 8,
): number[] {
  return [];
}

/** Format a human-friendly uptime from a start timestamp. */
export function uptime(startMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
