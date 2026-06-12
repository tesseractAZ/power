/**
 * lightingPosture.ts — the "lighting energy posture" brain (v0.15.19).
 *
 * One enum, published to Home Assistant as an MQTT sensor, that tells the
 * home's lighting how to behave. The key design decision: postures are driven
 * by the RUNWAY model's forward question ("will we reach sunrise above
 * reserve?") rather than raw SoC — a 45 % pool at 21:00 with a clear-day
 * forecast is fine; the same pool at 01:00 drawing 8 kW is not. Raw-SoC
 * triggers nag on good nights and under-react on bad ones.
 *
 * Ladder (escalating):
 *   surplus  — PV curtailment active: energy is going unharvested; lighting
 *              (and everything else) may run freely. Only entered from normal.
 *   normal   — projected dawn minimum comfortably above reserve.
 *   conserve — projected dawn minimum getting thin (< CONSERVE_DAWN_PCT).
 *   amber    — a reserve crossing is projected within the horizon.
 *   red      — the crossing is near (≤ RED_HOURS_TO_RESERVE h away).
 *   critical — the pool is AT/below its reserve floor right now.
 *
 * Hysteresis: escalation is immediate (safety first); de-escalation requires
 * the calmer raw posture to hold for DEESCALATE_HOLD_MS so a cloud edge or a
 * compressor cycle can't make the house breathe up and down.
 *
 * The consumer side (HA automations: heartbeat pulse, exterior policy,
 * dimmer ceilings) is gated by input_boolean.lighting_postures_enabled in
 * Home Assistant — this module only ever computes and publishes.
 */

export type LightingPosture = 'surplus' | 'normal' | 'conserve' | 'amber' | 'red' | 'critical';

/** Severity rank for hysteresis (surplus ranks WITH normal — it is not a
 *  warning tier, just normal-with-headroom). */
const POSTURE_RANK: Record<LightingPosture, number> = {
  surplus: 0, normal: 0, conserve: 1, amber: 2, red: 3, critical: 4,
};

/** Dawn-minimum (projected min SoC %) below which "conserve" engages. */
const CONSERVE_DAWN_PCT = 35;
/** Margin above the reserve % treated as "projected to graze the reserve". */
const AMBER_DAWN_MARGIN_PCT = 5;
/** hoursToReserve at/below which "red" engages. */
const RED_HOURS_TO_RESERVE = 4;
/** A calmer posture must hold this long before the house relaxes. */
export const DEESCALATE_HOLD_MS = 15 * 60 * 1000;

export interface PostureInputs {
  /** Pool currently at/below its reserve floor (runway.belowReserveFloor semantics). */
  belowReserveFloor: boolean;
  /** Projected hours until the pool crosses reserve; null = no crossing in horizon. */
  hoursToReserve: number | null;
  /** Forecast's projected minimum SoC % over the horizon (the "dawn minimum"). */
  dawnMinSocPct: number | null;
  /** The SHP2's configured reserve %, for the amber margin. */
  reservePct: number | null;
  /** PV curtailment currently active (energy going unharvested). */
  curtailmentActive: boolean;
  /** Clock injection for deterministic tests. */
  nowMs: number;
}

export interface PostureResult {
  posture: LightingPosture;
  /** Human-readable basis, published as a diagnostic sensor. */
  reason: string;
}

/** Pure classifier — no hysteresis. Exported for tests. */
export function rawPosture(i: PostureInputs): PostureResult {
  if (i.belowReserveFloor) {
    return { posture: 'critical', reason: 'pool at/below reserve floor' };
  }
  if (i.hoursToReserve != null && i.hoursToReserve <= RED_HOURS_TO_RESERVE) {
    return { posture: 'red', reason: `reserve crossing in ${i.hoursToReserve.toFixed(1)}h` };
  }
  const reserve = i.reservePct ?? 15;
  if (
    i.hoursToReserve != null ||
    (i.dawnMinSocPct != null && i.dawnMinSocPct < reserve + AMBER_DAWN_MARGIN_PCT)
  ) {
    const why =
      i.hoursToReserve != null
        ? `reserve crossing in ${i.hoursToReserve.toFixed(1)}h`
        : `dawn minimum ${i.dawnMinSocPct!.toFixed(0)}% grazes reserve ${reserve}%`;
    return { posture: 'amber', reason: why };
  }
  if (i.dawnMinSocPct != null && i.dawnMinSocPct < CONSERVE_DAWN_PCT) {
    return { posture: 'conserve', reason: `dawn minimum ${i.dawnMinSocPct.toFixed(0)}% (< ${CONSERVE_DAWN_PCT}%)` };
  }
  if (i.curtailmentActive) {
    return { posture: 'surplus', reason: 'PV curtailment active — surplus energy available' };
  }
  return {
    posture: 'normal',
    reason: i.dawnMinSocPct != null ? `dawn minimum ${i.dawnMinSocPct.toFixed(0)}%` : 'no depletion projected',
  };
}

export interface PostureTracker {
  update(i: PostureInputs): PostureResult & { changedAtMs: number };
  /** Test/reset seam. */
  reset(): void;
}

/**
 * Stateful wrapper adding the asymmetric hysteresis: escalations apply on the
 * next update; de-escalations only after the calmer raw posture has held for
 * `holdMs`.
 */
export function createPostureTracker(holdMs = DEESCALATE_HOLD_MS): PostureTracker {
  let current: PostureResult | null = null;
  let changedAtMs = 0;
  /** When the raw posture first went calmer than `current` (null = it hasn't). */
  let calmerSinceMs: number | null = null;

  return {
    update(i) {
      const raw = rawPosture(i);
      if (current == null) {
        current = raw;
        changedAtMs = i.nowMs;
        calmerSinceMs = null;
      } else if (POSTURE_RANK[raw.posture] > POSTURE_RANK[current.posture]) {
        // Escalate immediately.
        current = raw;
        changedAtMs = i.nowMs;
        calmerSinceMs = null;
      } else if (POSTURE_RANK[raw.posture] < POSTURE_RANK[current.posture]) {
        if (calmerSinceMs == null) calmerSinceMs = i.nowMs;
        if (i.nowMs - calmerSinceMs >= holdMs) {
          current = raw;
          changedAtMs = i.nowMs;
          calmerSinceMs = null;
        }
        // else: hold the sterner posture, but keep its original reason.
      } else {
        // Same rank — adopt the fresh reason (and normal↔surplus swaps freely).
        current = raw;
        calmerSinceMs = null;
      }
      return { ...current, changedAtMs };
    },
    reset() {
      current = null;
      changedAtMs = 0;
      calmerSinceMs = null;
    },
  };
}

/** Process-wide tracker — the MQTT publisher and /api/ha-state share one. */
export const lightingPostureTracker: PostureTracker = createPostureTracker();
