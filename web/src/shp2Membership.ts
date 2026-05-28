/**
 * v0.9.75 — Web mirror of `server/src/shp2Membership.ts`.
 *
 * Identical semantics + fallback. See the server-side file's docstring
 * for the full rationale. tl;dr — only DPUs whose SN appears in
 * `shp2.projection.sources[].sn` (with `isConnected: true`) contribute
 * to fleet totals; setups without an SHP2 fall back to "no filter".
 *
 * Keeping the web side as a literal mirror (no shared package) because
 * the React UI and the Lit HACS cards have different module graphs and
 * we don't want to wire up an npm workspace just for two functions.
 * If the contract changes, update both files in lock-step.
 */

import type { DeviceSnapshot, Shp2Projection } from './types';

export function shp2ConnectedDpuSns(devices: Record<string, DeviceSnapshot>): Set<string> {
  const list = Object.values(devices);
  const shp2 = list.find((d) => d.projection?.kind === 'shp2');
  if (!shp2 || shp2.projection?.kind !== 'shp2') return new Set();
  const proj = shp2.projection as Shp2Projection;
  return new Set(
    proj.sources
      .filter((s) => s.isConnected && s.sn)
      .map((s) => s.sn as string),
  );
}

export function isShp2Connected(sn: string, connected: Set<string>): boolean {
  if (connected.size === 0) return true;
  return connected.has(sn);
}
