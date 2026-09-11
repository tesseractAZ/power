/**
 * v1.142.0 — detecting an EcoFlow CLOUD SHADOW on the alarm-path panel.
 *
 * THE DEFECT THIS EXISTS FOR, observed live on two consecutive nights
 * (2026-09-08 and 09-09): the SHP2's `gridWatt` — the grid-presence alarm input —
 * held ONE value for 16.0 min and 14.5 min while the 60 s REST poll returned
 * 200 OK sixteen times in a row. Both windows sat inside an armed night-charge
 * window with 4-7 kW flowing through the panel.
 *
 * Nothing in this add-on was wrong. `setDeviceQuota` replaces the raw map
 * wholesale and re-projects unconditionally; there is no cache, no ETag, no
 * short-circuit anywhere in the REST client. EcoFlow's cloud simply served a
 * stale shadow of a device whose own session had stalled. Our code had no way
 * to notice, and every gating surface stayed green: zero fetch failures,
 * `poll_health = ok`, `/api/health blind:false`.
 *
 * This is the THIRD variant of one family. v1.86.0 closed "asked and FAILED".
 * v1.138.0 closed "never ASKED". This is "asked, answered 200 OK, and handed a
 * stale body" — which neither of those gates can see, because both key on the
 * fetch, and `lastUpdated` is bumped whether or not the payload MOVED.
 *
 * ── Why the witness is a VECTOR, not a scalar ──
 * The obvious rule — "this value has not changed in N polls" — was measured
 * against this plant and FAILS. `grid_power_home` legitimately holds 0 W for
 * 12.5+ hours on a sunny day, because solar covers the house. A detector built
 * on it could only ever fire falsely, which is precisely what the v1.139.0
 * doorbell deletion exists to prevent.
 *
 * The panel's twelve per-circuit watt readings are a different instrument. Over
 * 1,558 sampled minutes of live history the full twelve-channel vector never
 * held identical for even ONE minute — not once, day or night. Twelve
 * independent analog measurements holding byte-identical is not something a live
 * panel does; it is the signature of a replayed payload.
 *
 * ── Failing open ──
 * If the witness cannot be computed (no circuits in the projection yet, a
 * partial payload, a non-SHP2 device) this returns null and NOTHING is ever
 * judged stale. Absence of a witness is not evidence of a shadow — the same
 * doctrine this codebase states as `fallingEdgeFrozenByEvidence`.
 */

/** Consecutive byte-identical payloads before the content is called stale. */
export const SHP2_SHADOW_MIN_REPEATS = 5;
/** …and it must have held at least this long, so a fast poll cadence cannot trip it. */
export const SHP2_SHADOW_MIN_MS = 4 * 60_000;

export interface ContentFreshness {
  /** The witness string these repeats are counted against. */
  witness: string;
  /** When this witness was FIRST seen (not when it was last re-seen). */
  firstSeenMs: number;
  /** How many consecutive payloads have carried it. 1 = seen once, i.e. fresh. */
  repeats: number;
}

/**
 * A high-entropy fingerprint of one SHP2 payload, or null if it cannot be formed.
 *
 * Deliberately built from the twelve per-circuit watts PLUS the whole-panel
 * scalars: the scalars alone are low-entropy (see above), and the circuits alone
 * would miss a payload where only the grid reading is replayed.
 */
export function shp2ContentWitness(projection: unknown): string | null {
  const p = projection as {
    kind?: string;
    circuits?: Array<{ ch?: number; watts?: number | null }>;
    gridWatt?: number | null;
    backupBatPercent?: number | null;
    backupRemainWh?: number | null;
  } | undefined;
  if (!p || p.kind !== 'shp2') return null;
  const circuits = p.circuits;
  // No circuit vector means no high-entropy witness. Fail open.
  if (!Array.isArray(circuits) || circuits.length === 0) return null;
  const legs = circuits
    .slice()
    .sort((a, b) => (a.ch ?? 0) - (b.ch ?? 0))
    .map((c) => `${c.ch ?? '?'}:${c.watts ?? 'x'}`)
    .join(',');
  return `${legs}|g=${p.gridWatt ?? 'x'}|b=${p.backupBatPercent ?? 'x'}|r=${p.backupRemainWh ?? 'x'}`;
}

/**
 * Fold one freshly-received witness into the running state.
 *
 * A null witness RESETS the state rather than extending it: we cannot tell a
 * shadow from a partial payload, so an unmeasurable poll must not accumulate
 * evidence toward "stale".
 */
export function advanceContentFreshness(
  prev: ContentFreshness | undefined,
  witness: string | null,
  nowMs: number,
): ContentFreshness | undefined {
  if (witness == null) return undefined;
  if (!prev || prev.witness !== witness) return { witness, firstSeenMs: nowMs, repeats: 1 };
  return { witness, firstSeenMs: prev.firstSeenMs, repeats: prev.repeats + 1 };
}

/**
 * Has the content stopped moving? Requires BOTH a repeat count and a duration,
 * so neither a burst of fast polls nor a single long gap can assert a shadow.
 */
export function isContentStale(
  f: ContentFreshness | undefined,
  nowMs: number,
  minRepeats: number = SHP2_SHADOW_MIN_REPEATS,
  minMs: number = SHP2_SHADOW_MIN_MS,
): boolean {
  if (!f) return false;
  return f.repeats >= minRepeats && nowMs - f.firstSeenMs >= minMs;
}
