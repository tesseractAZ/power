/**
 * v0.76.0 — pure grid-aware dispatch helpers for the backup-pool SoC alarm,
 * extracted out of index.ts's `store.on('change')` handler so the highest-stakes
 * audible-alarm path — the grid-downgrade re-escalation that the v0.75.0
 * regression broke — is unit-testable against the REAL code instead of a
 * hand-copied mirror in the test.
 *
 * Background: when the grid is backstopping the home, a low backup pool is a
 * non-event (the SHP2 transfers to mains at the floor), so the emergency tiers
 * (high/critical) collapse to a low advisory. The consumer records the TRUE
 * priority of each downgraded crossing in a `socDowngraded` map keyed by pct, so
 * that if the grid LATER drops while the pool is still in that band, the genuine
 * high/critical audible is re-announced (closing a one-shot fail-silent window).
 */

import { downgradePriorityForGrid } from './gridState.js';
import type { AlarmPriority } from './alertPriority.js';
import type { SocThreshold } from './batterySocAlarm.js';

/**
 * The grid-aware decision for a single SoC threshold crossing. Pure. Returns the
 * priority to announce now (downgraded to low advisory when the grid is
 * backstopping) and whether it was downgraded — `onGrid === true` means the
 * consumer must RECORD the crossing's true priority in the re-escalation map so a
 * later grid drop can restore it; `false` means clear any prior record for it.
 */
export function socGridCrossDecision(
  t: Pick<SocThreshold, 'priority'>,
  backstopping: boolean,
): { priority: AlarmPriority; onGrid: boolean } {
  const priority = downgradePriorityForGrid(t.priority, backstopping);
  return { priority, onGrid: priority !== t.priority };
}

/**
 * The grid-drop re-escalation pass. PURE except that it mutates the passed
 * `socDowngraded` map (the consumer's persistent state): it deletes any band the
 * pool has climbed back above, and — only when the grid is NOT backstopping —
 * deletes and returns every still-active downgraded band so the consumer can
 * re-announce it at its true priority. Returns the bands to announce (empty while
 * the grid is up, or when SoC is unknown / nothing is downgraded).
 *
 * This is the exact loop whose v0.75.0 regression (recording only the worst band
 * starved this map, so a partial recovery above the worst band let a grid drop
 * fail-silent on the shallower emergency bands) is now pinned by a test driving
 * THIS function rather than a copy of it.
 */
export function reEscalateGridDrop(
  socDowngraded: Map<number, AlarmPriority>,
  soc: number | null,
  backstopping: boolean,
  isPriorityEnabled: (p: AlarmPriority) => boolean,
): { pct: number; priority: AlarmPriority }[] {
  const toAnnounce: { pct: number; priority: AlarmPriority }[] = [];
  if (soc == null || socDowngraded.size === 0) return toAnnounce;
  for (const [pct, truePriority] of [...socDowngraded]) {
    if (soc > pct) {
      socDowngraded.delete(pct); // climbed back out of the band
      continue;
    }
    if (!backstopping) {
      socDowngraded.delete(pct);
      if (isPriorityEnabled(truePriority)) toAnnounce.push({ pct, priority: truePriority });
    }
  }
  return toAnnounce;
}
