/**
 * membershipHistory.ts — v1.103.0. A timestamped record of WHICH DPUs were
 * wired into the SHP2 backup pool, and when that changed.
 *
 * WHY THIS EXISTS. Two engines resolve pool membership ONCE from the live
 * snapshot and then apply it across a historical window:
 *
 *   - `computeTotals` (aggregator.ts) filters `[sinceMs, untilMs]` by today's
 *     roster, so a query spanning a reconfiguration silently attributes one
 *     fleet's energy to another's membership.
 *   - `computeLocalPackRte` (energyHistory.ts) sums per-day pack-DC charge and
 *     discharge from those totals. After the 2026-08-20 swap it accumulated a
 *     ratio of 1.20 (77,218 Wh in, 92,676 Wh out) — physically impossible for a
 *     round trip, because the charge and discharge legs of the same day were
 *     measured over different sets of batteries.
 *
 * Neither can be fixed by reasoning harder about the current roster: the
 * information needed is WHEN membership changed, and nothing was recording it.
 *
 * HONEST LIMITS. This records changes from the moment it ships; it cannot
 * reconstruct history that was never observed. Windows predating the first
 * recorded entry are reported as `unknown` rather than assumed clean — the same
 * discipline as the warranty export, which will not invent pack provenance for
 * records whose hardware identity was never captured.
 */

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from './atomicWrite.js';

export interface MembershipEntry {
  /** Sorted, comma-joined SNs of the SHP2-connected DPUs. */
  fp: string;
  /** When this membership was first observed (ms epoch). */
  atMs: number;
  /**
   * v1.196.0 — the panel slot each of those DPUs occupied: `<panel SN>:<slot>` → DPU SN, from the
   * panel's own connector table (`connectedSlotMap`, shp2Membership.ts). It is what tells a
   * like-for-like swap (a Core in the slot a departed Core held, and so on that Core's PV array)
   * from an addition (a Core in a slot nobody held). Absent on an entry recorded before v1.196.0
   * until the recorder next observes the panel (recordMembership).
   */
  slots?: Record<string, string>;
  /**
   * v1.196.0 — the last time a FRESH reading of every panel (shp2ReadbackFresh) showed this
   * membership, stamped at most once per MEMBERSHIP_CONFIRM_STEP_MS (recordMembership). An entry
   * runs until the next one, but the recorder can append the next one only once it reads the
   * panel: a cloud-offline panel keeps its last projection verbatim (setDeviceList) and a stopped
   * add-on reads nothing, so between this stamp and the next entry the record cannot say who was
   * in the pool (membershipConfirmedDuring). Absent on an entry never read fresh since v1.196.0.
   */
  confirmedMs?: number;
}

export interface MembershipHistory {
  entries: MembershipEntry[];
}

/** Keep the file small; a plant reconfigures rarely, and old entries only
 *  matter for windows we can still query. */
export const MEMBERSHIP_HISTORY_MAX = 64;

export function emptyHistory(): MembershipHistory {
  return { entries: [] };
}

export function loadMembershipHistory(path: string): MembershipHistory {
  try {
    if (!existsSync(path)) return emptyHistory();
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const entries: MembershipEntry[] = Array.isArray(raw?.entries)
      ? raw.entries
          .filter(
            (e: unknown): e is MembershipEntry =>
              typeof (e as MembershipEntry)?.fp === 'string'
              && Number.isFinite((e as MembershipEntry)?.atMs),
          )
          .map((e: MembershipEntry): MembershipEntry => {
            const out: MembershipEntry = { fp: e.fp, atMs: e.atMs };
            // v1.196.0 — a malformed slot map is dropped, not the entry: the membership still stands.
            if (validSlots(e.slots)) out.slots = { ...e.slots };
            // v1.196.0 — and so is a confirmation stamp that is not a time at or after the entry's.
            if (Number.isFinite(e.confirmedMs) && (e.confirmedMs as number) >= e.atMs) out.confirmedMs = e.confirmedMs;
            return out;
          })
      : [];
    entries.sort((a: MembershipEntry, b: MembershipEntry) => a.atMs - b.atMs);
    return { entries };
  } catch {
    return emptyHistory();
  }
}

export function saveMembershipHistory(path: string, h: MembershipHistory): void {
  try {
    const entries = h.entries.slice(-MEMBERSHIP_HISTORY_MAX);
    atomicWriteFileSync(path, JSON.stringify({ entries }));
  } catch { /* advisory: a lost write costs precision, never correctness */ }
}

function validSlots(v: unknown): v is Record<string, string> {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const vals = Object.values(v);
  return vals.length > 0 && vals.every((sn) => typeof sn === 'string' && sn !== '');
}

function sameSlots(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (a == null) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/**
 * v1.196.0 — how often a confirmation stamp (`confirmedMs`) moves on. The record is saved on every
 * change, and a stamp on every 5-min rollup would rewrite the file every rollup.
 */
export const MEMBERSHIP_CONFIRM_STEP_MS = 60 * 60_000;

/**
 * Record `fp` if it differs from the newest entry. Returns true when the record
 * changed (an entry appended, or the newest entry's slot map or confirmation
 * stamp set). An EMPTY fingerprint (the panel itself unreadable) is never
 * recorded — absence of evidence is not a membership change.
 *
 * v1.196.0 — `slots` (the panel's slot table) rides on the entry. The SAME Cores
 * in other slots update the newest entry in place instead of appending one: the
 * pool is the same Cores on the same PV arrays, and an appended entry would read
 * as a membership change to `membershipVerdict` (the curtailment freeze, the
 * pack-DC RTE). An entry recorded before v1.196.0 gains its slot map the same
 * way, on the first rollup after the update. `confirmed` (every panel read
 * fresh) stamps the entry's `confirmedMs`: at once on an appended entry, then at
 * most once per MEMBERSHIP_CONFIRM_STEP_MS.
 */
export function recordMembership(
  h: MembershipHistory,
  fp: string,
  atMs: number,
  slots?: Record<string, string>,
  confirmed = false,
): boolean {
  if (fp === '') return false;
  const s = validSlots(slots) ? slots : undefined;
  const last = h.entries[h.entries.length - 1];
  if (last != null && last.fp === fp) {
    let changed = false;
    if (s != null && !sameSlots(last.slots, s)) {
      last.slots = { ...s };
      changed = true;
    }
    if (confirmed && (last.confirmedMs == null || atMs - last.confirmedMs >= MEMBERSHIP_CONFIRM_STEP_MS)) {
      last.confirmedMs = atMs;
      changed = true;
    }
    return changed;
  }
  const entry: MembershipEntry = { fp, atMs };
  if (s != null) entry.slots = { ...s };
  if (confirmed) entry.confirmedMs = atMs;
  h.entries.push(entry);
  if (h.entries.length > MEMBERSHIP_HISTORY_MAX) h.entries.splice(0, h.entries.length - MEMBERSHIP_HISTORY_MAX);
  return true;
}

export type MembershipVerdict = 'stable' | 'changed' | 'unknown';

/**
 * Did pool membership change during `[fromMs, toMs)`?
 *
 *  - `changed` — a recorded change falls inside the window.
 *  - `stable`  — the window lies entirely within one recorded membership.
 *  - `unknown` — the window starts before anything was recorded, so we cannot
 *    say. Callers must treat this as "not trustworthy", NOT as "fine".
 */
export function membershipVerdict(h: MembershipHistory, fromMs: number, toMs: number): MembershipVerdict {
  const e = h.entries;
  if (e.length === 0) return 'unknown';
  if (fromMs < e[0].atMs) return 'unknown';
  for (let i = 1; i < e.length; i++) {
    if (e[i].atMs > fromMs && e[i].atMs < toMs) return 'changed';
  }
  return 'stable';
}

/** The membership in force at `atMs`, or null when it predates the record. */
export function membershipAt(h: MembershipHistory, atMs: number): string | null {
  let found: string | null = null;
  for (const e of h.entries) {
    if (e.atMs <= atMs) found = e.fp;
    else break;
  }
  return found;
}

/**
 * v1.196.0 — the shortest-lived membership taken as a real one: the recorder's own bar for a
 * change (MEMBERSHIP_SUSTAINED_ROLLUPS, 3 rollups × 5 min, recorder.ts). A home Core's isConnect
 * reads 0 for a single poll now and then (a Core power-cycled while it reconnects); the record
 * then holds a one-rollup entry without it, and its return.
 */
export const MEMBERSHIP_GLITCH_MS = 15 * 60_000;

/** v1.196.0 — the record with each flicker (a membership held under `glitchMs`) folded away, with
 *  its return to the membership before it (membershipsDuring). */
function foldFlickers(h: MembershipHistory, glitchMs: number): MembershipEntry[] {
  const kept: MembershipEntry[] = [];
  for (let i = 0; i < h.entries.length; i++) {
    const e = h.entries[i];
    const next = h.entries[i + 1];
    if (i > 0 && next != null && next.atMs - e.atMs < glitchMs) continue; // a flicker
    const prev = kept[kept.length - 1];
    if (prev != null && prev.fp === e.fp) {
      // The flicker's return. The earlier entry stands; it takes the return's slot map only when
      // it has none (an entry recorded before slot maps were), and the return's later stamp.
      const merged: MembershipEntry = { ...prev };
      if (prev.slots == null && e.slots != null) merged.slots = e.slots;
      if (e.confirmedMs != null && (prev.confirmedMs == null || e.confirmedMs > prev.confirmedMs)) merged.confirmedMs = e.confirmedMs;
      kept[kept.length - 1] = merged;
      continue;
    }
    kept.push(e);
  }
  return kept;
}

/**
 * v1.196.0 — the memberships in force at any instant of `[fromMs, toMs)`, oldest first, or null
 * when the window starts before the record (unknown, as in `membershipVerdict`). A membership held
 * for less than `glitchMs` before the next one is a flicker and is folded away, with its return to
 * the membership before it; the newest entry has no successor and is always kept. The first entry
 * is kept too: it is where the record begins.
 */
export function membershipsDuring(
  h: MembershipHistory,
  fromMs: number,
  toMs: number,
  glitchMs: number = MEMBERSHIP_GLITCH_MS,
): MembershipEntry[] | null {
  const kept = foldFlickers(h, glitchMs);
  if (kept.length === 0 || fromMs < kept[0].atMs) return null;
  const out: MembershipEntry[] = [];
  for (let i = 0; i < kept.length; i++) {
    const end = i + 1 < kept.length ? kept[i + 1].atMs : Infinity;
    if (end > fromMs && kept[i].atMs < toMs) out.push(kept[i]);
  }
  return out;
}

/**
 * v1.196.0 — how far a confirmation stamp vouches past itself: the stamp lags a fresh reading by up
 * to MEMBERSHIP_CONFIRM_STEP_MS, plus the rollups a brief stale-shadow episode skips.
 */
export const MEMBERSHIP_CONFIRM_SLACK_MS = MEMBERSHIP_CONFIRM_STEP_MS + MEMBERSHIP_GLITCH_MS;

/**
 * v1.196.0 — whether the record vouches for every instant of `[fromMs, toMs)`: each membership in
 * force then (flickers folded, as in membershipsDuring) was confirmed by a fresh panel reading
 * (`confirmedMs`) until the next membership was recorded, or until `toMs`, within `slackMs`. False
 * when the window starts before the record.
 *
 * A change made while the panel was cloud-offline, or the add-on stopped, is recorded only when
 * the panel next reads fresh, so between an entry's last stamp and the next entry the record still
 * names the Cores of before. One stamp vouches back to the entry's start: the same membership was
 * read at both ends, and a change the panel showed in between would be an entry of its own.
 */
export function membershipConfirmedDuring(
  h: MembershipHistory,
  fromMs: number,
  toMs: number,
  slackMs: number = MEMBERSHIP_CONFIRM_SLACK_MS,
  glitchMs: number = MEMBERSHIP_GLITCH_MS,
): boolean {
  const kept = foldFlickers(h, glitchMs);
  if (kept.length === 0 || fromMs < kept[0].atMs) return false;
  for (let i = 0; i < kept.length; i++) {
    const end = i + 1 < kept.length ? kept[i + 1].atMs : Infinity;
    if (end <= fromMs || kept[i].atMs >= toMs) continue;
    const stamp = kept[i].confirmedMs;
    if (stamp == null || stamp + slackMs < Math.min(end, toMs)) return false;
  }
  return true;
}

/**
 * v1.196.0 — the slot each of `sns` holds in the newest entry that records it with a slot map
 * (`<panel SN>:<slot>`). A Core no slot map records is absent from the result.
 */
export function latestSlotOf(h: MembershipHistory, sns: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = h.entries.length - 1; i >= 0 && out.size < sns.length; i--) {
    const slots = h.entries[i].slots;
    if (slots == null) continue;
    for (const [slot, sn] of Object.entries(slots)) {
      if (sns.includes(sn) && !out.has(sn)) out.set(sn, slot);
    }
  }
  return out;
}

/**
 * v1.196.0 — the Cores whose PV stands for `modelSns` while `entry` was the pool (sorted), or null.
 *
 * A model Core that was a member stands for itself. One that was not stands in by the member that
 * then held the slot it holds now (`slotOf`, latestSlotOf): a Core swapped into a slot takes over
 * the departing Core's PV array, so the two measure the same panels. Null when a model Core has
 * neither — it came in through a slot nobody held (an addition: the pool then lacked that array),
 * or the entry carries no slot map to say — and when the slot's holder then is a model Core in its
 * own right (it already stands for itself).
 */
export function standInCores(
  entry: MembershipEntry,
  modelSns: readonly string[],
  slotOf: ReadonlyMap<string, string>,
): string[] | null {
  const pool = new Set(entry.fp.split(','));
  const out = new Set<string>();
  for (const sn of modelSns) {
    if (pool.has(sn)) { out.add(sn); continue; }
    const slot = slotOf.get(sn);
    const held = slot != null && entry.slots != null && Object.hasOwn(entry.slots, slot) ? entry.slots[slot] : null;
    if (held == null || !pool.has(held) || modelSns.includes(held) || out.has(held)) return null;
    out.add(held);
  }
  return [...out].sort();
}
