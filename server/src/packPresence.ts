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
 *
 * v1.187.1 — THE HIDE SURVIVES A RESTART. The restart rail above held for every slot, the ghost
 * included: after each restart Core 4's slot 5 (pulled 2026-09-20) was first seen "now" like the
 * live packs, so for ~10 minutes it was projected again — muted alerts raised on a pack that does
 * not exist (dpu-imbalance "Lowest: Pack 5 at 55%", peer-soc, peer-soh), HA's warning count one
 * higher, three stale pack5_* samples written to the 5-year store and ~3 rows added to the full
 * cleared-alert ledger, on ~23 restarts since v1.172.0. A hidden slot is now remembered as a
 * GHOST — its exact fingerprint and how long it has stood unchanged — and persisted by the store
 * (pack-ghosts.json). A slot whose FIRST reading in a new process is byte-identical to its ghost
 * is the same frozen slot: it keeps the ghost's time instead of "now", so the rules above hide it
 * on the first projection. Neither rule is loosened (Rule 1 still needs a positive count below the
 * slot count, Rule 2 a repeated serial), and any other reading — a re-inserted pack, anything that
 * moved — is first seen "now" as before and retires the ghost.
 */

import type { DpuPack } from './ecoflow/project.js';

/** How long a slot must be frozen, and how far behind every kept pack, before it hides. */
export const PACK_STALE_MS = 10 * 60_000;

/**
 * v1.187.1 — a hidden slot's frozen readings, kept across a restart (see the header).
 * `frozenSinceMs` is when its readings were last SEEN to change (`changeSeen`), or else when they
 * were first seen — a lower bound: the freeze may be older.
 */
export interface PackGhost {
  fp: string;
  frozenSinceMs: number;
  changeSeen: boolean;
}

export interface PackSlotHistory {
  /** Last fingerprint seen per slot. */
  fp: Map<number, string>;
  /** When each slot's fingerprint last CHANGED (or was first seen). */
  changedMs: Map<number, number>;
  /** v1.187.1 — slots whose changedMs is an observed change, not a first sighting. */
  changeSeen: Set<number>;
  /** v1.187.1 — this Core's ghosts, by slot: restored from disk, then kept current here. */
  ghosts: Map<number, PackGhost>;
}

export function freshPackSlotHistory(ghosts?: ReadonlyMap<number, PackGhost>): PackSlotHistory {
  return { fp: new Map(), changedMs: new Map(), changeSeen: new Set(), ghosts: new Map(ghosts ?? []) };
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
 * v1.187.1 — also keeps `hist.ghosts` current (a hidden slot is recorded; a slot whose readings
 * move again is forgotten) and says whether it changed, so the caller persists only on change.
 */
export function prunePhantomPacks(
  packs: DpuPack[],
  packCount: number | null,
  hist: PackSlotHistory,
  nowMs: number,
): {
  packs: DpuPack[];
  dropped: Array<{ num: number; frozenSinceMs: number; changeSeen: boolean }>;
  ghostsChanged: boolean;
} {
  let ghostsChanged = false;
  for (const p of packs) {
    const fp = packFingerprint(p);
    const prev = hist.fp.get(p.num);
    if (prev === fp) continue;
    hist.fp.set(p.num, fp);
    const ghost = hist.ghosts.get(p.num);
    // v1.187.1 — a reading byte-identical to the slot's ghost: the same frozen readings, so the same
    // freeze. In practice this is the slot's first reading in a new process (any other reading
    // retires the ghost below). Any other reading is "now", as before.
    if (ghost != null && ghost.fp === fp) {
      hist.changedMs.set(p.num, Math.min(ghost.frozenSinceMs, nowMs));
      if (ghost.changeSeen) hist.changeSeen.add(p.num);
      continue;
    }
    hist.changedMs.set(p.num, nowMs);
    if (prev != null) hist.changeSeen.add(p.num);
    // A slot that reads anything but its ghost is not that ghost any more: a re-inserted pack, or
    // readings that moved. It re-earns a hide by the rules below, from now.
    if (hist.ghosts.delete(p.num)) ghostsChanged = true;
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
  // v1.187.1 — every hidden slot is (still) a ghost: record it as it stands. A ghost only ever holds
  // its slot's current reading (any other reading retires it above), so its time is the one thing
  // that can differ — a ghost from before a backward clock step is clamped to now.
  for (const d of dropped) {
    const frozenSinceMs = since(d);
    if (hist.ghosts.get(d.num)?.frozenSinceMs === frozenSinceMs) continue;
    hist.ghosts.set(d.num, { fp: hist.fp.get(d.num)!, frozenSinceMs, changeSeen: hist.changeSeen.has(d.num) });
    ghostsChanged = true;
  }
  if (dropped.length === 0) return { packs, dropped: [], ghostsChanged };
  const hide = new Set(dropped.map((d) => d.num));
  return {
    packs: packs.filter((p) => !hide.has(p.num)),
    dropped: dropped.map((d) => ({ num: d.num, frozenSinceMs: since(d), changeSeen: hist.changeSeen.has(d.num) })),
    ghostsChanged,
  };
}

/**
 * v1.187.1 — PURE. The persisted ghosts (pack-ghosts.json: `{ [coreSn]: { [slot]: PackGhost } }`),
 * validated: anything malformed is skipped, never guessed at.
 */
export function parsePackGhosts(raw: unknown): Map<string, Map<number, PackGhost>> {
  const out = new Map<string, Map<number, PackGhost>>();
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [sn, slots] of Object.entries(raw as Record<string, unknown>)) {
    if (slots == null || typeof slots !== 'object' || Array.isArray(slots)) continue;
    const m = new Map<number, PackGhost>();
    for (const [k, v] of Object.entries(slots as Record<string, unknown>)) {
      const slot = Number(k);
      const g = v as Partial<PackGhost> | null;
      if (!Number.isInteger(slot) || slot < 1 || g == null || typeof g !== 'object') continue;
      if (typeof g.fp !== 'string' || g.fp.length === 0) continue;
      if (typeof g.frozenSinceMs !== 'number' || !Number.isFinite(g.frozenSinceMs)) continue;
      if (typeof g.changeSeen !== 'boolean') continue;
      m.set(slot, { fp: g.fp, frozenSinceMs: g.frozenSinceMs, changeSeen: g.changeSeen });
    }
    if (m.size > 0) out.set(sn, m);
  }
  return out;
}

/** v1.187.1 — PURE. The hide line's time phrase. An observed change is a date; a first sighting
 *  is only a lower bound — the readings may have stopped long before this or an earlier process
 *  first saw them (v1.172.0 printed the boot instant as "frozen since"). */
export function packFrozenPhrase(d: { frozenSinceMs: number; changeSeen: boolean }): string {
  return `readings unchanged since ${new Date(d.frozenSinceMs).toISOString()}${d.changeSeen ? '' : ' or earlier'}`;
}
