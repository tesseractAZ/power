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
    const entries = Array.isArray(raw?.entries)
      ? raw.entries.filter(
          (e: unknown): e is MembershipEntry =>
            typeof (e as MembershipEntry)?.fp === 'string'
            && Number.isFinite((e as MembershipEntry)?.atMs),
        )
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

/**
 * Record `fp` if it differs from the newest entry. Returns true when an entry
 * was appended. An EMPTY fingerprint (the panel itself unreadable) is never
 * recorded — absence of evidence is not a membership change.
 */
export function recordMembership(h: MembershipHistory, fp: string, atMs: number): boolean {
  if (fp === '') return false;
  const last = h.entries[h.entries.length - 1];
  if (last != null && last.fp === fp) return false;
  h.entries.push({ fp, atMs });
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
