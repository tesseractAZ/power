/**
 * packPresence.ts — v1.172.0. A pack that has been PHYSICALLY REMOVED stops being shown.
 *
 * 2026-09-20 ~12:10: the owner pulled Core 4's DEFECTIVE pack 1 for warranty. The Core
 * RENUMBERED the four that remained as slots 1-4 and reported 4 packs
 * (`hs_yj751_pd_appshow_addr.bpNum` = 4) — yet the panel's Fleet pack matrix kept showing
 * 25 packs, with Core 4 "pack 5" frozen at 55% / 84 °F: slot 5 still held the last
 * readings of the pack that now reports as slot 4 (the SAME packSn in both slots). Its
 * voltage last moved at 12:10, its SoC at 13:01, its temperature not once in 36 hours; the
 * recorder kept writing it every poll and a predicted-SoH alert and the Core's imbalance
 * warning kept reading it.
 *
 * WHY. projectDpu lists every slot 1..5 that has ANY key in the cached raw quota, and the
 * cache only ever gains or overwrites keys: MQTT deltas merge in place and nothing deletes
 * a slot's keys when its pack disappears. So a removed pack lingers forever at its last
 * readings.
 *
 * WHAT. Two signals, either of which marks a slot as a ghost once its readings have
 * STOPPED CHANGING: the Core's own pack count says there are fewer packs than slots with
 * data, or the slot repeats the packSn of another slot (a renumbered pack's old address). Every live pack's voltage or temperature moves within minutes even at rest
 * (measured 09-21: every live pack changed within 20 min; the removed one had not in 28 h).
 *
 * ★ SAFETY RAILS:
 *  - The count rule never prunes without a positive pack count from the Core (null or a
 *    transient 0 — the reconnect-zero trap — prunes nothing); the duplicate-serial rule
 *    only ever hides the OLDER of two slots carrying one serial.
 *  - A slot is hidden only when it is frozen for PACK_STALE_MS AND every pack kept changed
 *    at least PACK_STALE_MS more recently — so right after a restart, when every slot is
 *    "first seen" at the same moment, nothing is hidden until the live ones move.
 *  - A hidden pack that starts changing again (re-inserted) is shown again on the next
 *    projection.
 */

import type { DpuPack } from './ecoflow/project.js';

/** How long a slot must be frozen, and how far behind every kept pack, before it hides. */
export const PACK_STALE_MS = 10 * 60_000;

export interface PackSlotHistory {
  /** Last fingerprint seen per slot. */
  fp: Map<number, string>;
  /** When each slot's fingerprint last CHANGED (or was first seen). */
  changedMs: Map<number, number>;
}

export function freshPackSlotHistory(): PackSlotHistory {
  return { fp: new Map(), changedMs: new Map() };
}

/** PURE. The readings that move on a live pack — any change means it is still there. */
export function packFingerprint(p: DpuPack): string {
  const x = p as any;
  return JSON.stringify([
    x.soc, x.packVoltageMv, x.maxCellVoltageMv, x.minCellVoltageMv, x.temp,
    x.cellVoltagesMv, x.cellTemps, x.remainCapMah, x.inputWatts, x.outputWatts,
  ]);
}

/**
 * Update the per-slot change history with this projection's packs, then hide the excess
 * frozen slots when the Core's own count says there are fewer packs than slots. Mutates
 * `hist`; returns the packs to show and the slots hidden.
 */
export function prunePhantomPacks(
  packs: DpuPack[],
  packCount: number | null,
  hist: PackSlotHistory,
  nowMs: number,
): { packs: DpuPack[]; dropped: Array<{ num: number; frozenSinceMs: number }> } {
  for (const p of packs) {
    const fp = packFingerprint(p);
    if (hist.fp.get(p.num) !== fp) {
      hist.fp.set(p.num, fp);
      hist.changedMs.set(p.num, nowMs);
    }
  }
  const since = (p: DpuPack) => hist.changedMs.get(p.num) ?? nowMs;
  // "Frozen for PACK_STALE_MS" is implied by each rule's "behind a slot that changed at
  // least PACK_STALE_MS more recently" (no slot changed after now), so it is not re-tested.
  const hideSet = new Map<number, DpuPack>();

  // Rule 1 — the Core counts fewer packs than slots with data: the excess OLDEST slots,
  // if clearly behind every slot kept.
  if (packCount != null && Number.isInteger(packCount) && packCount >= 1 && packs.length > packCount) {
    const byAge = [...packs].sort((a, b) => since(a) - since(b));
    const excess = packs.length - packCount;
    const kept = byAge.slice(excess);
    const keptFloor = Math.min(...kept.map(since));
    for (const c of byAge.slice(0, excess)) {
      if (keptFloor - since(c) >= PACK_STALE_MS) hideSet.set(c.num, c);
    }
  }
  // Rule 2 — two slots carry ONE packSn: the older is a renumbered pack's old address.
  const bySn = new Map<string, DpuPack[]>();
  for (const p of packs) {
    const sn = (p as any).packSn;
    if (typeof sn === 'string' && sn.length > 0) bySn.set(sn, [...(bySn.get(sn) ?? []), p]);
  }
  for (const group of bySn.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => since(b) - since(a)); // newest first
    const newest = since(sorted[0]);
    for (const g of sorted.slice(1)) {
      if (newest - since(g) >= PACK_STALE_MS) hideSet.set(g.num, g);
    }
  }
  const dropped = [...hideSet.values()].sort((a, b) => a.num - b.num);
  if (dropped.length === 0) return { packs, dropped: [] };
  const hide = new Set(dropped.map((d) => d.num));
  return {
    packs: packs.filter((p) => !hide.has(p.num)),
    dropped: dropped.map((d) => ({ num: d.num, frozenSinceMs: since(d) })),
  };
}
