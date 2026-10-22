/**
 * v1.185.0 — a SECONDARY smart panel's runway, measured at its current drain.
 *
 * The house panel's runway (analytics.computeRunway) simulates its pool hour by hour against
 * the day-ahead PV and load forecast. Neither exists per panel: the forecast models the plant's
 * PV and the house panel's recorded load. So a second panel gets the honest figure it can have
 * — its pool's energy against the drain its own Cores are delivering now, averaged over the
 * last half hour — and its alarm says "at the current drain" instead of "before solar
 * recovers" (runwayAlarm.RunwayWording).
 *
 * Fail-loud shape, each deliberate:
 * - The drain is the NET pack flow of the Cores this panel lists as connected sources, and it
 *   exists only while EVERY one of them is reporting: a partial sum could hide a draining Core,
 *   so an incomplete roster is `unavailable` (the panel's SoC ladder and reserve alerts still
 *   stand), never a smaller drain.
 * - A panel reading that is not a fresh readback (shp2ReadbackFresh) is `unavailable`: its
 *   remaining energy is frozen, and a frozen pool cannot count down.
 * - Charging, or a drain under DRAIN_FLOOR_W, projects no depletion — nulls, which the
 *   classifier reads as "nothing to announce", exactly like the house runway's no-depletion case.
 * - A pool already at or under its reserve reads AT THE FLOOR whether or not a drain has been
 *   measured, so the at-floor alarm never waits on the window.
 * - Beyond PANEL_RUNWAY_HORIZON_H the figure is dropped, matching the house runway's horizon,
 *   so a slow evening drain does not announce a thirty-hour "low" every hour.
 * - v1.187.19 — the pool's energies are the panel's nameplate figures × the measured capacity
 *   scale of ITS connected Cores (poolEnergyBasis.ts; the caller evaluates it on the main
 *   thread's own tracker). The drain needs no overhead term: it is measured at the packs, so the
 *   Cores' own consumption is already in it. The scale is clamped to [CAPACITY_SCALE_MIN, 1], so
 *   it only ever lowers the energies; absent or non-finite it reads as 1 (unchanged).
 */
import type { DeviceSnapshot } from './snapshot.js';
import type { Shp2Projection } from './ecoflow/project.js';
import type { RunwayAlarmInput } from './runwayAlarm.js';
import { shp2ReadbackFresh } from './shp2Membership.js';
import { CAPACITY_SCALE_MIN, CAPACITY_SCALE_MAX, type CapacityBasis } from './poolEnergyBasis.js';
import { RESERVE_FALLBACK_PCT } from './limits.js';

export const PANEL_DRAIN_WINDOW_MS = 30 * 60_000;
/** The window must span at least this much before the mean is a drain rather than a moment. */
export const PANEL_DRAIN_MIN_SPAN_MS = 10 * 60_000;
export const PANEL_RUNWAY_HORIZON_H = 24;
/** Below this the pool is idling, not draining (the house path's own discharge threshold). */
export const DRAIN_FLOOR_W = 50;

export interface DrainSample { tMs: number; netW: number }

/** Net pack flow (POSITIVE = discharging) of this panel's connected Cores, or null unless every
 *  one of them is online and reporting packs. */
export function panelPoolNetWatts(
  devices: Record<string, DeviceSnapshot>,
  panel: DeviceSnapshot & { projection: Shp2Projection },
): { netW: number | null; reporting: number; connected: number } {
  let connected = 0;
  let reporting = 0;
  let net = 0;
  for (const src of panel.projection.sources ?? []) {
    if (!src.isConnected || !src.sn) continue;
    connected += 1;
    const d = devices[src.sn];
    if (!d || !d.online || d.projection?.kind !== 'dpu') continue;
    reporting += 1;
    for (const pk of d.projection.packs ?? []) net += (pk.outputWatts ?? 0) - (pk.inputWatts ?? 0);
  }
  return { netW: connected > 0 && reporting === connected ? net : null, reporting, connected };
}

/** Append a sample and drop those older than the window. A null reading CLEARS the window: a
 *  mean spanning a gap in coverage would average across Cores that were not being seen. */
export function noteDrainSample(samples: DrainSample[], netW: number | null, nowMs: number): DrainSample[] {
  if (netW == null) return [];
  return [...samples.filter((x) => nowMs - x.tMs <= PANEL_DRAIN_WINDOW_MS), { tMs: nowMs, netW }];
}

export interface PanelRunway extends RunwayAlarmInput {
  sn: string;
  name: string;
  drainW: number | null;
  /** v1.187.19 — the capacity scale applied to the panel's energies, and its basis. */
  capacityScale?: number;
  capacityBasis?: CapacityBasis;
}

export function panelDrainRunway(
  panel: DeviceSnapshot & { projection: Shp2Projection },
  samples: readonly DrainSample[],
  nowMs: number,
  basis?: { capacityScale: number; capacityBasis: CapacityBasis },
): PanelRunway {
  const scale = basis && Number.isFinite(basis.capacityScale)
    ? Math.min(CAPACITY_SCALE_MAX, Math.max(CAPACITY_SCALE_MIN, basis.capacityScale)) : 1;
  const base = {
    sn: panel.sn, name: panel.deviceName, generatedAt: nowMs, hoursToReserve: null, hoursToEmpty: null, drainW: null,
    ...(basis ? { capacityScale: scale, capacityBasis: basis.capacityBasis } : {}),
  };
  const remainWhPlate = panel.projection.backupRemainWh ?? null;
  const fullWhPlate = panel.projection.backupFullCapWh ?? null;
  if (remainWhPlate == null || fullWhPlate == null || fullWhPlate <= 0) return { ...base, unavailable: 'pool capacity not reported' };
  const remainWh = remainWhPlate * scale;
  const fullWh = fullWhPlate * scale;
  if (!shp2ReadbackFresh(panel, nowMs)) return { ...base, unavailable: 'panel reading not fresh' };
  const reserveWh = (fullWh * (panel.projection.backupReserveSoc ?? RESERVE_FALLBACK_PCT)) / 100;
  const floor = { backupRemainingKwh: remainWh / 1000, backupReserveKwh: reserveWh / 1000 };
  const recent = samples.filter((x) => nowMs - x.tMs <= PANEL_DRAIN_WINDOW_MS);
  if (recent.length < 2 || recent[recent.length - 1].tMs - recent[0].tMs < PANEL_DRAIN_MIN_SPAN_MS) {
    // A pool already AT its floor needs no drain to say so: the at-floor alarm does not wait for a
    // measurement window (or for a Core that went dark and cleared it).
    const atFloor = remainWh <= reserveWh;
    return atFloor ? { ...base, ...floor, unavailable: null, hoursToReserve: 0 } : { ...base, ...floor, unavailable: 'measuring the drain' };
  }
  const drainW = recent.reduce((a, x) => a + x.netW, 0) / recent.length;
  if (!(drainW > DRAIN_FLOOR_W)) return { ...base, ...floor, drainW, unavailable: null };
  const within = (h: number): number | null => (h <= PANEL_RUNWAY_HORIZON_H ? h : null);
  return {
    ...base,
    ...floor,
    drainW,
    unavailable: null,
    hoursToReserve: within(Math.max(0, remainWh - reserveWh) / drainW),
    hoursToEmpty: within(remainWh / drainW),
  };
}
