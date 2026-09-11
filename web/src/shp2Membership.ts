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
  // v1.146.0 — UNION ACROSS EVERY PANEL, matching the server since v1.129.0.
  //
  // This mirror had drifted three server revisions behind while its own header
  // demanded lock-step. The single `find` took the FIRST panel only, so with a
  // second SHP2 present every DPU wired to it fell out of the connected set and
  // `isShp2Connected` excluded it — silently dropping that half of the plant from
  // EnergyFlow's fleet totals and ThermalPanel. v1.129.0 shipped exactly this
  // one-line repair server-side and called it "the largest lever on the
  // second-SHP2 problem".
  //
  // `?? []` because a partial /quota can return the backup SoC while omitting the
  // pd303_mc sources subtree; the server guards the same way.
  const out = new Set<string>();
  for (const d of Object.values(devices)) {
    if (d.projection?.kind !== 'shp2') continue;
    for (const s of (d.projection as Shp2Projection).sources ?? []) {
      if (s.isConnected && s.sn) out.add(s.sn);
    }
  }
  return out;
}

export function isShp2Connected(sn: string, connected: Set<string>): boolean {
  if (connected.size === 0) return true;
  return connected.has(sn);
}
