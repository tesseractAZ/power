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

/** Is this device a Smart Home Panel? By PROJECTION when there is one, else by IDENTITY
 *  (productName). After a restart while the panel is dark, it is listed by /device/list but
 *  has no projection yet — a projection-keyed test dropped it from the home set, and the
 *  pill then read LIVE on the Cores alone while the panel had no reading at all (the same
 *  restart door the server closed in v1.140.0 by keying panels on identity). */
export function isPanel(d: DeviceSnapshot): boolean {
  if (d.projection?.kind === 'shp2') return true;
  if (d.projection) return false;
  return /smart\s*home\s*panel/i.test(d.productName ?? '');
}

/** The devices whose readings the dashboard's headline figures are made of: every panel
 *  (by identity), and the Cores wired to one that are ONLINE. An offline Core is out of
 *  every headline figure (the Energy flow card counts online Cores only) and has its own
 *  alarm; letting its frozen clock drive the pill turned it amber for the whole outage —
 *  days, for a Core that has been dark that long — and trained the operator to ignore it.
 *  Bench spares and accessory devices are excluded. On a cold boot with no connection table
 *  observed, every online DPU stands in, the same fallback the Energy flow card uses. */
export function homeDevices(devices: Record<string, DeviceSnapshot>): DeviceSnapshot[] {
  const list = Object.values(devices);
  const connected = shp2ConnectedDpuSns(devices);
  return list.filter((d) => {
    if (isPanel(d)) return true;
    if (d.projection?.kind !== 'dpu' || !d.online) return false;
    return connected.size > 0 ? isShp2Connected(d.sn, connected) : true;
  });
}

/** When this device's figures on screen were last TRUE, on the server clock.
 *  - `lastTelemetryAtMs`: bumped only when telemetry content lands (not by a /status flip,
 *    not by a failed poll). Absent = no content since the add-on started. There is NO
 *    fallback to `lastUpdated`: after a restart, a panel whose quota keeps failing while its
 *    /status topic flips gets `lastUpdated` stamped by each flip, and a fallback read that as
 *    a fresh reading — LIVE over a panel with blank figures. The web bundle ships in the same
 *    image as the server, so there is no older server to fall back for.
 *  - A panel replaying a cloud shadow (`contentStaleSinceMs`) keeps answering every poll
 *    with 200 OK and a replayed body, so its telemetry clock stays fresh while its figures
 *    are frozen — the server raises "Panel data is stale" for exactly this (21 episodes
 *    2026-09-13..21, 2-18 min each). Its figures are as old as the shadow.
 *  0 = never reported. */
export function readingAt(d: DeviceSnapshot): number {
  const t = d.lastTelemetryAtMs ?? 0;
  if (!(t > 0)) return 0;
  return d.contentStaleSinceMs != null ? Math.min(t, d.contentStaleSinceMs) : t;
}

/** The OLDEST home reading — the device whose figures on screen are most out of date. Null
 *  when a home device has never reported: it is on screen as blanks, not as fresh data. */
export function oldestHomeTelemetryAt(devices: Record<string, DeviceSnapshot>): number | null {
  const home = homeDevices(devices);
  if (home.length === 0) return null;
  let oldest = Infinity;
  for (const d of home) {
    const t = readingAt(d);
    if (!(t > 0)) return null;
    if (t < oldest) oldest = t;
  }
  return Number.isFinite(oldest) ? oldest : null;
}

/** What the header pill says. An open socket is necessary for LIVE, not sufficient: the
 *  oldest home reading must also be inside TELEMETRY_STALE_MS. `serverNowMs` is "now" on the
 *  SERVER's clock (browser now − the offset useSnapshot measures), because every reading
 *  time it is compared against is server-stamped. */
export function linkState(conn: ConnState, devices: Record<string, DeviceSnapshot> | null, serverNowMs: number): LinkState {
  if (conn === 'closed') return 'offline';
  if (conn === 'connecting') return 'linking';
  if (!devices) return 'linking';
  const oldest = oldestHomeTelemetryAt(devices);
  if (oldest == null || serverNowMs - oldest > TELEMETRY_STALE_MS) return 'stale';
  return 'live';
}

/** Is a polled card's last good payload too old to present as current? Null lastOkAt =
 *  never fetched successfully. */
export function pollStale(lastOkAt: number | null, nowMs: number, intervalMs: number): boolean {
  return lastOkAt == null || nowMs - lastOkAt > POLL_STALE_MISSES * intervalMs;
}

/** A day-window payload whose day is over. Rendering it would present yesterday's totals
 *  under "since 12:00 AM" — the label reads identically for either midnight. The server
 *  sends `dayEndMs` (the local midnight that ends the payload's day), which is exact across
 *  daylight-saving changes; a fixed 24 h blanked a fall-back day's last hour (25 h day).
 *  Without it (an older server) the payload's `sinceMs` + 24 h is the estimate. Both are
 *  server-clock times, so `serverNowMs` must be too. */
export function dayWindowExpired(
  win: { sinceMs?: number | null; dayEndMs?: number | null } | null | undefined,
  serverNowMs: number,
): boolean {
  if (!win) return false;
  if (win.dayEndMs != null) return serverNowMs >= win.dayEndMs;
  return win.sinceMs != null && serverNowMs - win.sinceMs >= 24 * 3_600_000;
}

/** The "as of" text for a stale polled card. A time of day alone reads as TODAY — "as of
 *  3:00 PM" at 4 PM looked an hour old when it could be 25 — so anything not from today
 *  names its day. Both arguments are the browser's clock (the fetch completed here). */
export function staleAsOf(lastOkAt: number | null, nowMs: number): string | null {
  if (lastOkAt == null) return null;
  const d = new Date(lastOkAt);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** The browser-minus-server clock offset after one more frame: the MINIMUM sample since the
 *  socket opened (NTP-style). A sample is skew + that frame's transport delay; a client
 *  falling behind a backlog of queued frames sees the delay grow, and taking the latest
 *  sample absorbed the growing lag as "skew" — the header kept reading ~20 s while the
 *  figures on screen were minutes old. The minimum is skew plus the least delay seen. */
export function nextClockOffset(prevMin: number | null, sample: number): number {
  return prevMin == null || sample < prevMin ? sample : prevMin;
}
