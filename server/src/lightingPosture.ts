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

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';

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

/**
 * A normal↔surplus swap must hold this long before it is adopted.
 *
 * WHY THIS EXISTS (v1.63.0)
 * -------------------------
 * `surplus` and `normal` share rank 0 — correctly, because surplus is not a
 * warning tier. But that put every normal↔surplus swap in the same-rank branch
 * below, which adopted it IMMEDIATELY. The 15-minute de-escalation hold only
 * ever guarded CROSS-rank moves, so this transition had no debounce at all.
 *
 * That matters because posture is an ACTUATION trigger. The HA automation
 * `EcoFlow HVAC — surplus pre-cool` fires on `→ surplus` and drops every
 * cool-mode setpoint; its sibling restores them on `→ normal`. And the upstream
 * signal is a bare threshold — `computeCurtailment` calls it curtailed when the
 * gap clears `CURTAIL_MIN_SURPLUS_W` (300 W) with no hysteresis of its own, on a
 * 5-minute recompute. Surplus hovering near 300 W therefore flips `active` every
 * recompute, and each flip wrote both thermostats and then wrote them back.
 *
 * The observed 2026-07-23 event lasted THREE SECONDS end to end.
 *
 * The dwell is symmetric on purpose. Debouncing only the entry would still let a
 * momentary dip end a real surplus event, restoring setpoints and then
 * re-cooling — the same thrash wearing the opposite sign. Staying pre-cooled a
 * few minutes too long is cheap; oscillating the thermostats is not.
 *
 * This never delays a real escalation: surplus→conserve/amber/red/critical is a
 * RANK increase and is handled by the escalate branch, which still applies on the
 * very next tick.
 */
export const SURPLUS_DWELL_MS = 10 * 60 * 1000;

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
  /** v0.87.0 — the grid is genuinely backstopping the home right now
   *  (liveGridBackstop().backstopping). When true and the pool is above its floor,
   *  the runway-to-reserve projection is islanded-only, so the depletion-driven
   *  conserve escalations (red/amber/conserve) must NOT fire — the house should not
   *  dim/sweep lights while the grid has it. Absent/false = the full escalation
   *  ladder (the islanding-safe default). */
  gridBackstopping?: boolean;
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
  // v0.87.0 — grid-aware: when the grid is genuinely backstopping the home and the
  // pool is above its floor (the belowReserveFloor→critical branch above still
  // handles the floor itself), the runway-to-reserve projection is islanded-only — a
  // non-event on grid, since the SHP2 transfers to mains at the floor. So the
  // depletion-driven escalations (red/amber/conserve) must NOT fire; the house
  // should not dim/sweep lights on a grid-up evening. Excess-solar surplus still
  // applies. When gridBackstopping is false/absent (islanding — the safe default)
  // the full escalation ladder below runs unchanged.
  if (i.gridBackstopping) {
    if (i.curtailmentActive) {
      return { posture: 'surplus', reason: 'PV curtailment active — surplus energy available' };
    }
    return { posture: 'normal', reason: 'grid backstopping — depletion projection is islanded-only' };
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

/* ─── v0.15.20 — persistence across restarts ─────────────────────────────
 * The tracker was process-local, so an add-on restart mid-event flapped the
 * published posture (amber → normal-on-a-half-warm-forecast → amber within a
 * couple of minutes; observed live Jun 11 19:28 local). The HA consumers are
 * escalation-edge-triggered, so a flap fires a spurious restore-then-reclamp
 * (and a heartbeat pulse) at the family. Persisting {posture, changedAtMs,
 * calmerSinceMs} means a restart resumes the HELD posture: a half-warm calmer
 * reading is just a de-escalation candidate that has to survive the 15-min
 * hold — by which time the forecast is warm and the flap never reaches HA. */
interface PersistedPosture {
  posture: LightingPosture;
  reason: string;
  changedAtMs: number;
  calmerSinceMs: number | null;
  /** v1.63.0 — when a same-rank normal<->surplus swap first appeared. Absent in
   *  files written before this field existed; treated as null (dwell restarts). */
  swapSinceMs?: number | null;
  savedAtMs: number;
}

/** Persisted state older than this is discarded (the event is likely over). */
export const PERSIST_MAX_AGE_MS = 60 * 60 * 1000;

function loadPersisted(path: string): PersistedPosture | null {
  try {
    if (!existsSync(path)) return null;
    const s = JSON.parse(readFileSync(path, 'utf8')) as PersistedPosture;
    if (typeof s?.posture !== 'string' || !(s.posture in POSTURE_RANK)) return null;
    if (typeof s.savedAtMs !== 'number' || Date.now() - s.savedAtMs > PERSIST_MAX_AGE_MS) return null;
    return s;
  } catch {
    return null; // corrupt → start fresh
  }
}

function savePersisted(path: string, s: Omit<PersistedPosture, 'savedAtMs'>): void {
  try {
    atomicWriteFileSync(path, JSON.stringify({ ...s, savedAtMs: Date.now() } satisfies PersistedPosture));
  } catch {
    /* best effort — losing this just risks one restart flap */
  }
}

/**
 * Stateful wrapper adding the asymmetric hysteresis: escalations apply on the
 * next update; de-escalations only after the calmer raw posture has held for
 * `holdMs`. With a `statePath` the tracker survives restarts (writes only on
 * posture changes and hold-window transitions, not every tick — SD-card diet).
 */
export function createPostureTracker(
  holdMs = DEESCALATE_HOLD_MS,
  statePath?: string,
  dwellMs = SURPLUS_DWELL_MS,
): PostureTracker {
  let current: PostureResult | null = null;
  let changedAtMs = 0;
  /** When the raw posture first went calmer than `current` (null = it hasn't). */
  let calmerSinceMs: number | null = null;
  /** When a same-rank swap (normal<->surplus) first appeared (null = none pending). */
  let swapSinceMs: number | null = null;

  if (statePath != null) {
    const persisted = loadPersisted(statePath);
    if (persisted != null) {
      current = { posture: persisted.posture, reason: persisted.reason };
      changedAtMs = persisted.changedAtMs;
      calmerSinceMs = persisted.calmerSinceMs;
      swapSinceMs = persisted.swapSinceMs ?? null;
    }
  }

  const persist = () => {
    if (statePath != null && current != null) {
      savePersisted(statePath, { ...current, changedAtMs, calmerSinceMs, swapSinceMs });
    }
  };

  return {
    update(i) {
      const raw = rawPosture(i);
      if (current == null) {
        current = raw;
        changedAtMs = i.nowMs;
        calmerSinceMs = null;
        swapSinceMs = null;
        persist();
      } else if (POSTURE_RANK[raw.posture] > POSTURE_RANK[current.posture]) {
        // Escalate immediately.
        current = raw;
        changedAtMs = i.nowMs;
        calmerSinceMs = null;
        swapSinceMs = null;
        persist();
      } else if (POSTURE_RANK[raw.posture] < POSTURE_RANK[current.posture]) {
        const startedHold = calmerSinceMs == null;
        if (calmerSinceMs == null) calmerSinceMs = i.nowMs;
        if (i.nowMs - calmerSinceMs >= holdMs) {
          current = raw;
          changedAtMs = i.nowMs;
          calmerSinceMs = null;
          persist();
        } else if (startedHold) {
          // Hold the sterner posture (original reason); record the hold start
          // so a restart mid-hold resumes the countdown instead of resetting it.
          persist();
        }
      } else if (raw.posture === current.posture) {
        // Same rank AND same posture — only the reason may have changed. It
        // refreshes every tick, so don't write it to disk each time.
        const holdCleared = calmerSinceMs != null || swapSinceMs != null;
        current = raw;
        calmerSinceMs = null;
        swapSinceMs = null;
        if (holdCleared) persist();
      } else {
        // Same rank, DIFFERENT posture — i.e. normal↔surplus. v1.63.0: this must
        // DWELL. It is an actuation edge (the HA pre-cool automation triggers on
        // it and moves every thermostat setpoint), and the upstream curtailment
        // signal is a bare 300 W threshold with no hysteresis of its own, so an
        // undebounced swap thrashes the house. See SURPLUS_DWELL_MS.
        if (swapSinceMs == null) {
          swapSinceMs = i.nowMs;
          calmerSinceMs = null;
          persist(); // so a restart mid-dwell resumes the countdown, not resets it
        } else if (i.nowMs - swapSinceMs >= dwellMs) {
          current = raw;
          changedAtMs = i.nowMs;
          swapSinceMs = null;
          calmerSinceMs = null;
          persist();
        }
        // else: dwell still running — hold the CURRENT posture, return it unchanged.
      }
      return { ...current, changedAtMs };
    },
    reset() {
      current = null;
      changedAtMs = 0;
      calmerSinceMs = null;
      swapSinceMs = null;
    },
  };
}

/** Where the process-wide tracker persists (mirrors runwayAlarm's pattern). */
const STATE_PATH =
  process.env.LIGHTING_POSTURE_STATE_PATH ??
  resolve(process.cwd(), config.dbPath, '..', 'lighting-posture.json');

/** Process-wide tracker — the MQTT publisher and /api/ha-state share one. */
export const lightingPostureTracker: PostureTracker = createPostureTracker(DEESCALATE_HOLD_MS, STATE_PATH);
