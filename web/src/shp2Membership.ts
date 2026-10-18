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

import type { DeviceSnapshot, Shp2EnergySource, Shp2Projection } from './types';

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

type Panel = DeviceSnapshot & { projection: Shp2Projection };

/**
 * v1.185.0 — the HOUSE panel, mirroring the server's findShp2: the panel the server flagged
 * `housePanel` (resolveHousePanel), or nothing while that panel has no projection; with none
 * flagged, the lowest serial. Before this every card took the FIRST panel in the map, so a second
 * panel could quietly become the one the dashboard called "the" backup pool.
 */
export function findHousePanel(devices: Record<string, DeviceSnapshot>): Panel | undefined {
  let best: Panel | undefined;
  let flagged: DeviceSnapshot | undefined;
  let missing = false;
  for (const d of Object.values(devices)) {
    if (d.housePanel === true) flagged = d;
    if (d.housePanelMissing != null) missing = true;
    if (d.projection?.kind !== 'shp2') continue;
    if (!best || d.sn < best.sn) best = d as Panel;
  }
  if (flagged) return flagged.projection?.kind === 'shp2' ? (flagged as Panel) : undefined;
  if (missing) return undefined; // the pinned house panel is off the account: nothing stands in for it
  return best;
}

/** v1.185.0 — every projected panel, the house panel first, then by serial. */
export function allPanels(devices: Record<string, DeviceSnapshot>): Panel[] {
  const house = findHousePanel(devices);
  const rest = Object.values(devices)
    .filter((d): d is Panel => d.projection?.kind === 'shp2' && d !== house)
    .sort((a, b) => (a.sn < b.sn ? -1 : a.sn > b.sn ? 1 : 0));
  return house ? [house, ...rest] : rest;
}

/** v1.188.1 — the serial the house role belongs to, mirroring the server's houseSnOf: the flagged
 *  panel, else the MISSING pinned serial, else the lowest-serial projected panel. */
function houseSnOf(devices: Record<string, DeviceSnapshot>): string | undefined {
  let missing: string | undefined;
  let lowest: string | undefined;
  for (const d of Object.values(devices)) {
    if (d.housePanel === true) return d.sn;
    if (d.housePanelMissing != null) missing = d.housePanelMissing;
    if (d.projection?.kind === 'shp2' && (lowest == null || d.sn < lowest)) lowest = d.sn;
  }
  return missing ?? lowest;
}

/**
 * v1.188.1 — each connected home Core ONCE, at the one panel listing that reads it: the mirror of the
 * server's connectedSourceListings (shp2Membership.ts), the listing the energy bridge, Home
 * Assistant's two power sensors and the backup timers' bound read. A Core listed connected by two
 * panels (one panel's source list stale) is read at the listing on an online panel whose reading the
 * server judged fresh (`readbackFresh`, stamped on every panel the client receives), else on an
 * online panel, else the first; a tie goes to the house panel, then the lower panel serial. `index`
 * is the slot's position in the panel's sourceWatts.
 */
export function connectedSourceListings(devices: Record<string, DeviceSnapshot>): Array<{ panel: Panel; src: Shp2EnergySource; index: number }> {
  const house = houseSnOf(devices);
  const fresh = (p: Panel): boolean => p.readbackFresh === true || (p.readbackFresh == null && p.contentStaleSinceMs == null);
  const rank = (p: Panel): number => (p.online === true ? (fresh(p) ? 2 : 1) : 0);
  const panels = Object.values(devices)
    .filter((d): d is Panel => d.projection?.kind === 'shp2')
    .sort((a, b) => rank(b) - rank(a) || (b.sn === house ? 1 : 0) - (a.sn === house ? 1 : 0) || (a.sn < b.sn ? -1 : a.sn > b.sn ? 1 : 0));
  const chosen = new Map<string, { panel: Panel; src: Shp2EnergySource; index: number }>();
  for (const panel of panels) {
    (panel.projection.sources ?? []).forEach((src, index) => {
      if (src.isConnected && src.sn && !chosen.has(src.sn)) chosen.set(src.sn, { panel, src, index });
    });
  }
  return [...chosen.values()];
}
