/**
 * v0.9.40 — Project Genesis utilities.
 *
 * Math + small helpers used across the Opus skin. Keeping them out of
 * components so the components stay focused on rendering.
 */

import type { FleetSnapshot } from '../types';

/** Clamp a number to [lo, hi]. */
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Linear interpolate. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);

/** Format a number with a unit, gracefully handling null. */
export function fmtNum(n: number | null | undefined, opts: { digits?: number; unit?: string; fallback?: string } = {}): { value: string; unit: string } {
  const { digits = 0, unit = '', fallback = '—' } = opts;
  if (n == null || !Number.isFinite(n)) return { value: fallback, unit: '' };
  return { value: n.toFixed(digits), unit };
}

/** Format a watts value, choosing kW above 1000W. */
export function fmtWatts(w: number | null | undefined): { value: string; unit: string } {
  if (w == null || !Number.isFinite(w)) return { value: '—', unit: '' };
  const abs = Math.abs(w);
  if (abs >= 1000) return { value: (w / 1000).toFixed(2), unit: 'kW' };
  return { value: Math.round(w).toString(), unit: 'W' };
}

/** Format a kWh value. */
export function fmtKwh(kwh: number | null | undefined): { value: string; unit: string } {
  if (kwh == null || !Number.isFinite(kwh)) return { value: '—', unit: '' };
  return { value: kwh.toFixed(1), unit: 'kWh' };
}

/** Derive total PV across all DPUs in the snapshot. */
export function totalPvWatts(snapshot: FleetSnapshot | null): number {
  if (!snapshot) return 0;
  let total = 0;
  for (const d of Object.values(snapshot.devices)) {
    if (d.projection?.kind === 'dpu') {
      total += d.projection.pvTotalWatts ?? 0;
    }
  }
  return total;
}

/** Derive total load (AC-out + circuit watts) — best-effort across DPUs + SHP2. */
export function totalLoadWatts(snapshot: FleetSnapshot | null): number {
  if (!snapshot) return 0;
  let total = 0;
  for (const d of Object.values(snapshot.devices)) {
    if (d.projection?.kind === 'shp2') {
      // SHP2 circuits sum up actual house load
      for (const c of d.projection.circuits ?? []) {
        total += c.watts ?? 0;
      }
      return total;
    }
  }
  // Fallback: sum DPU AC-out
  for (const d of Object.values(snapshot.devices)) {
    if (d.projection?.kind === 'dpu') {
      total += d.projection.acOutWatts ?? 0;
    }
  }
  return total;
}

/** Derive fleet-average SoC from SHP2 backupBatPercent if present, else mean of DPU SoCs. */
export function fleetSoc(snapshot: FleetSnapshot | null): number | null {
  if (!snapshot) return null;
  for (const d of Object.values(snapshot.devices)) {
    if (d.projection?.kind === 'shp2') {
      const p = d.projection as unknown as { backupBatPercent?: number | null };
      if (typeof p.backupBatPercent === 'number') return p.backupBatPercent;
    }
  }
  const socs: number[] = [];
  for (const d of Object.values(snapshot.devices)) {
    if (d.projection?.kind === 'dpu' && typeof d.projection.soc === 'number') {
      socs.push(d.projection.soc);
    }
  }
  if (socs.length === 0) return null;
  return socs.reduce((s, n) => s + n, 0) / socs.length;
}

/** Pull every pack across the fleet, tagged with its parent DPU SN + index. */
export interface PackRef {
  dpuSn: string;
  dpuName: string;
  packNum: number;
  soc: number | null;
  soh: number | null;
  actSoh: number | null;
  temp: number | null;
  cycles: number | null;
  cellSpreadMv: number | null;
  inputW: number | null;
  outputW: number | null;
}

export function allPacks(snapshot: FleetSnapshot | null): PackRef[] {
  if (!snapshot) return [];
  const packs: PackRef[] = [];
  for (const d of Object.values(snapshot.devices)) {
    if (d.projection?.kind !== 'dpu') continue;
    for (const p of d.projection.packs ?? []) {
      packs.push({
        dpuSn: d.sn,
        dpuName: d.deviceName,
        packNum: p.num,
        soc: p.soc,
        soh: p.actSoh ?? p.soh,
        actSoh: p.actSoh,
        temp: p.temp,
        cycles: p.cycles,
        cellSpreadMv: p.maxVolDiffMv,
        inputW: p.inputWatts,
        outputW: p.outputWatts,
      });
    }
  }
  return packs;
}

/** Map SoH percent to a color for the Pack Vitals constellation. */
export function packColor(soh: number | null): string {
  if (soh == null) return 'var(--color-muted)';
  if (soh >= 95) return 'var(--opus-life-1)';     // Genesis green
  if (soh >= 90) return 'var(--opus-life-2)';     // light emerald
  if (soh >= 80) return 'var(--opus-solar-2)';    // amber 300
  if (soh >= 70) return 'var(--opus-solar)';      // amber 400
  return 'var(--color-bad)';                      // coral 400
}

/** Time-of-day formatter — "9:42 AM" style. */
export function fmtClock(d: Date = new Date()): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Compact percentage. */
export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}
