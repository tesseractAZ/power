import type { DeviceSnapshot } from './types';
import { shp2ConnectedDpuSns, isShp2Connected } from './shp2Membership';

/**
 * v1.176.0 — how old is the data on screen? Pure, so the server suite runs it
 * (server/test/dashboardFreshness.test.ts), the same way it runs shp2Membership.
 *
 * The dashboard used to answer from two signals that cannot see stale data:
 *   - "updated Ns ago" printed `snapshot.generatedAt`, which the server bumps on every
 *     poll FAILURE (snapshot.ts setDeviceError) — so the harder the cloud fails, the
 *     fresher the header looked. Per-device `lastUpdated` is the clock that is NOT
 *     bumped by a failure (v0.97.0), so freshness is read from it instead.
 *   - the LIVE pill was the WebSocket's readyState alone. A socket stays open while the
 *     server has nothing new to send (the 2026-09-22 03:17-03:28 cloud outage), so the
 *     pill stayed green over data eleven minutes old.
 * And the relative time only re-rendered when a snapshot arrived, so a silent pipe froze
 * the header at whatever age it last printed.
 */

/** Mirrors the server's "Telemetry stale" alarm (alerts.ts STALE_MS): the age at which the
 *  alarm engine itself stops trusting a device's reading. */
export const TELEMETRY_STALE_MS = 3 * 60_000;

/** A polled card's payload is stale once it has missed this many of its own polls. */
export const POLL_STALE_MISSES = 2.5;

/** The WebSocket's state. Defined here (and re-exported by useSnapshot) so this module stays
 *  free of browser-only imports — the server's non-DOM test build type-checks it. */
export type ConnState = 'connecting' | 'open' | 'closed';
export type LinkState = 'live' | 'stale' | 'linking' | 'offline';

/** The devices whose readings the dashboard's headline figures are made of: every SHP2 and
 *  the Cores wired to one. Bench spares and accessory devices (a doorbell, a car charger,
 *  a generator) are excluded — their silence is expected and must not paint the whole
 *  dashboard stale. On a cold boot with no SHP2 observed, every online DPU stands in, the
 *  same fallback the Energy flow card uses. */
export function homeDevices(devices: Record<string, DeviceSnapshot>): DeviceSnapshot[] {
  const list = Object.values(devices);
  const connected = shp2ConnectedDpuSns(devices);
  return list.filter((d) => {
    const kind = d.projection?.kind;
    if (kind === 'shp2') return true;
    if (kind !== 'dpu') return false;
    return connected.size > 0 ? isShp2Connected(d.sn, connected) : d.online;
  });
}

/** The OLDEST home reading — the device whose data on screen is most out of date. Null when
 *  no home device has ever reported (lastUpdated 0). A device that never reported counts as
 *  infinitely old: it is on screen as blanks, not as fresh data. */
export function oldestHomeTelemetryAt(devices: Record<string, DeviceSnapshot>): number | null {
  const home = homeDevices(devices);
  if (home.length === 0) return null;
  let oldest = Infinity;
  for (const d of home) {
    const t = d.lastUpdated ?? 0;
    if (!(t > 0)) return null;
    if (t < oldest) oldest = t;
  }
  return Number.isFinite(oldest) ? oldest : null;
}

/** What the header pill says. An open socket is necessary for LIVE, not sufficient: the
 *  oldest home reading must also be inside TELEMETRY_STALE_MS. */
export function linkState(conn: ConnState, devices: Record<string, DeviceSnapshot> | null, nowMs: number): LinkState {
  if (conn === 'closed') return 'offline';
  if (conn === 'connecting') return 'linking';
  if (!devices) return 'linking';
  const oldest = oldestHomeTelemetryAt(devices);
  if (oldest == null || nowMs - oldest > TELEMETRY_STALE_MS) return 'stale';
  return 'live';
}

/** Is a polled card's last good payload too old to present as current? Null lastOkAt =
 *  never fetched successfully. */
export function pollStale(lastOkAt: number | null, nowMs: number, intervalMs: number): boolean {
  return lastOkAt == null || nowMs - lastOkAt > POLL_STALE_MISSES * intervalMs;
}

/** A day-window payload (Today's `sinceMs` is the local midnight that opened its day) whose
 *  day is over. Rendering it would present yesterday's totals under "since 12:00 AM" — the
 *  label reads identically for either midnight. */
export function dayWindowExpired(sinceMs: number | null | undefined, nowMs: number): boolean {
  return sinceMs != null && nowMs - sinceMs >= 24 * 3_600_000;
}
