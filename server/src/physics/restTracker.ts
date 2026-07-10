/**
 * v1.2.0 — per-pack "when did this pack last move current?" tracker.
 *
 * `analyzePackLfp` can only convert pack voltage into a physics SoC when the pack is
 * RESTING: low current, and low for long enough that the OCV has settled. That needs a
 * `lastNonRestingAtMs` timestamp, which nothing was producing — `/api/physics/lfp-soc`
 * hardcoded `lastNonRestingAtMs: null`, so `isResting` was false on every pack forever
 * and `physicsSoCPct` was null on all 15 live packs. The endpoint's headline number —
 * "physics says X but the BMS says Y" — could never be computed.
 *
 * SEEDING RULE. The first time we see a pack we do NOT know how long it has been idle;
 * rest may have begun long before the add-on started. We seed `lastNonRestingAt` to the
 * observation time, which is a deliberately LATE estimate: we then require a full
 * RESTING_AGE_MIN_MS of rest that WE observed before claiming the pack is rested. This
 * under-claims rest rather than fabricating an OCV SoC from an unverified assumption —
 * the same "emit null over a fabricated number" rule the panel applies elsewhere.
 *
 * A pack whose current we cannot read (packCurrentA == null) counts as non-resting: an
 * unreadable current is not evidence of stillness.
 *
 * Keyed on the pack hardware serial (`packSn`) so the history survives pack renumbering
 * and DPU reordering. Bounded by fleet size (~15-25 entries).
 */

/** Matches lfpOcv.ts. A pack drawing/absorbing under this is electrically at rest. */
export const REST_CURRENT_THRESHOLD_A = 0.5;

const lastNonRestingAt = new Map<string, number>();

/** Derive pack current (A) from the projection's real fields. Positive = discharging. */
export function packCurrentAmps(
  outputWatts: number | null | undefined,
  inputWatts: number | null | undefined,
  packVoltageMv: number | null | undefined,
): number | null {
  if (packVoltageMv == null || !(packVoltageMv > 0)) return null;
  if (outputWatts == null && inputWatts == null) return null;
  const netW = (outputWatts ?? 0) - (inputWatts ?? 0);
  return netW / (packVoltageMv / 1000);
}

/**
 * Record one observation. Call on every poll. Returns the pack's current
 * `lastNonRestingAtMs` (never null — seeded on first sight).
 */
export function observePackRest(packKey: string, packCurrentA: number | null, nowMs: number): number {
  const moving = packCurrentA == null || Math.abs(packCurrentA) > REST_CURRENT_THRESHOLD_A;
  if (moving || !lastNonRestingAt.has(packKey)) lastNonRestingAt.set(packKey, nowMs);
  return lastNonRestingAt.get(packKey)!;
}

/** Last observed non-resting instant, or null if this pack has never been observed. */
export function lastNonRestingAtMs(packKey: string): number | null {
  return lastNonRestingAt.get(packKey) ?? null;
}

/** Drop packs no longer present so a re-serialled/removed pack can't pin memory. */
export function retainPacks(keys: Iterable<string>): void {
  const keep = new Set(keys);
  for (const k of lastNonRestingAt.keys()) if (!keep.has(k)) lastNonRestingAt.delete(k);
}

/**
 * Stable per-pack key. Prefers the pack hardware serial so the rest history follows the
 * physical pack; falls back to DPU-SN + slot when the BMS hasn't reported a serial.
 */
export function packRestKey(dpuSn: string, pack: { packSn?: string | null; num?: number | null }): string {
  return pack.packSn ? `pack:${pack.packSn}` : `slot:${dpuSn}:${pack.num ?? '?'}`;
}

/** Test seam. */
export function _resetRestTracker(): void {
  lastNonRestingAt.clear();
}
