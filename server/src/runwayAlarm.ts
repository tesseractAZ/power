/**
 * v0.14.0 — Projection-depletion audible alarm.
 *
 * Announces when the off-grid runway projection (computeRunway) shows the backup
 * pool will reach its RESERVE floor — or empty — within the 24 h forecast
 * horizon, *despite* forecast solar. This is the "act now so we last until the
 * sun comes back" signal the SoC-threshold ladder can't give: that ladder only
 * fires once the pool has ALREADY fallen to 50/40/30…%, whereas this fires while
 * the pool is still healthy but the forecast (PV − load) trajectory is headed
 * below reserve before solar recovers.
 *
 * Like batterySocAlarm this is a DEDICATED audible path (it calls
 * broadcast.announce directly) rather than riding the alert→condition→broadcast
 * pipeline, so it still annunciates when the operator's broadcast min-severity is
 * 'critical'. The matching on-screen alert is the existing `forecast-runtime-*`
 * (analytics.ts), which is excluded from the broadcast condition (broadcast.ts)
 * so the two never double-chime.
 *
 * Escalation by urgency (the RESERVE-floor trigger the operator selected):
 *   • projected to reach reserve within the horizon  → Low (advisory)
 *   • projected to reach reserve within 6 h          → Medium
 *   • projected EMPTY within 8 h                      → High
 *   • projected EMPTY within 3 h                      → Critical
 * Announces on entering the band and on each escalation, then at most once per
 * `reannounceMs` while it persists; re-arms when the projection recovers (no
 * finite hoursToReserve). Uses the projection's own `generatedAt` as the clock so
 * it is deterministic under test, and persists its state so a restart mid-event
 * doesn't immediately re-announce.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';
import { type AlarmPriority, priorityAnnouncementPrefix } from './alertPriority.js';
import { priorityAnnouncementPrefixEs } from './ttsService.js';

/** The subset of RunwayProjection this alarm consumes. */
export interface RunwayAlarmInput {
  generatedAt: number;
  hoursToReserve: number | null;
  hoursToEmpty: number | null;
  unavailable: string | null;
  /** v0.15.18 — present on RunwayProjection; lets the classifier recognise
   *  "already AT/below the reserve floor" as its own (critical) condition. */
  backupRemainingKwh?: number | null;
  backupReserveKwh?: number | null;
}

/** Default re-announce cadence for a persisting projection (minutes → ms). */
export const RUNWAY_ALARM_REANNOUNCE_MS =
  Math.max(1, Number(process.env.BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN ?? 60)) * 60 * 1000;

const RANK: Record<AlarmPriority, number> = { low: 1, medium: 2, high: 3, critical: 4 };

// v0.15.18 — warm-up window in which a null projection must NOT re-arm the
// alarm (post-boot projections are computed from half-warm inputs).
// v0.15.21 — widened 3 → 10 min: the Jun 12 review caught "projection
// recovered — re-armed" lines 4+ min after boots, on 999-sentinel projections
// built from a degenerate post-boot load curve (an active high alarm was
// silently cleared mid-event). The curve guard in computeRunway removes the
// cause; this covers the first forecast-cache cycle as belt-and-braces.
const PROCESS_START_MS = Date.now();
const REARM_WARMUP_MS = 10 * 60 * 1000;

/**
 * Map a runway projection to an alarm priority, or null when no depletion is
 * projected within the horizon. EMPTY (hoursToEmpty) escalates harder than
 * RESERVE (hoursToReserve) because empty is the harder failure.
 */
/** True when the pool is currently AT or below its reserve floor. */
export function belowReserveFloor(p: RunwayAlarmInput): boolean {
  return (
    p.backupRemainingKwh != null &&
    p.backupReserveKwh != null &&
    p.backupReserveKwh > 0 &&
    p.backupRemainingKwh <= p.backupReserveKwh
  );
}

/** v0.23.0 — grid-backstop context for the floor classifier (see gridState.ts).
 *  Omitted ⇒ treat as off-grid (the safe default: floor stays critical). */
export interface GridContext {
  /** Grid is energized (will carry the load when the pool reaches the floor). */
  present: boolean;
  /** Grid is actively backstopping NOW (carrying the load at the floor). */
  backstopping: boolean;
}

/**
 * v0.93.0 (audit #8) — should the runway alarm's AUDIBLE annunciation be gated?
 * True ONLY while the grid is actively backstopping the home: at that point the
 * pool reaching/holding the by-design reserve floor merely transfers to mains, so
 * the audible chime that flapped on a grid-tied home is muted. This gates ONLY the
 * audible path (broadcast.announce) at the index.ts call site — push + on-screen
 * are untouched. Off-grid / grid-not-carrying (backstopping=false or no context) →
 * false → a genuine islanded depletion still annunciates unchanged. Pure so the
 * mute decision is unit-tested without the broadcast wiring.
 */
export function shouldGateRunwayAudible(grid?: GridContext): boolean {
  return grid?.backstopping === true;
}

export function classifyRunway(p: RunwayAlarmInput, grid?: GridContext): AlarmPriority | null {
  if (p.unavailable != null) return null;
  // v0.15.18 — being AT/below the reserve floor is the emergency this ladder
  // exists for (the SHP2 cuts non-backup circuits there), yet the old ranking
  // DE-escalated to 'high' once the crossing was behind us (observed Jun 10
  // 00:51 local: "high — reserve in 18.8h" while pinned at the 10 % floor).
  if (belowReserveFloor(p)) {
    // v0.23.0 — at the floor it's only a non-event if the grid is actually
    // CARRYING the load (backstopping). Grid declared-but-not-carrying (pool
    // still discharging) or off-grid keeps the critical: that is the genuine
    // "no backstop at the floor" emergency.
    if (grid?.backstopping) return 'low';
    return 'critical';
  }
  // v0.23.0 — not yet at the floor. If the grid is actually BACKSTOPPING it will
  // carry the load once the pool reaches the floor, so a projected descent to
  // reserve / empty is not an emergency — stay silent on the audible (the
  // on-screen "approaching reserve" alert still shows). A grid that is merely
  // DECLARED present but not carrying (backstopping=false), or off-grid, keeps
  // the full ladder so a genuine fast depletion still annunciates.
  if (grid?.backstopping) return null;
  const he = p.hoursToEmpty;
  const hr = p.hoursToReserve;
  if (he != null && he <= 3) return 'critical';
  if (he != null && he <= 8) return 'high';
  if (hr != null && hr <= 6) return 'medium';
  if (hr != null) return 'low';
  return null;
}

/** The spoken message for a projection at a given priority. */
export function runwayAlarmMessage(p: RunwayAlarmInput, priority: AlarmPriority, grid?: GridContext): string {
  const he = p.hoursToEmpty;
  const hr = p.hoursToReserve;
  // v0.23.0 — at the floor WITH the grid backstopping, the pool reaching reserve
  // just transfers to mains; speak a calm advisory, not the shed/generator call.
  if (belowReserveFloor(p) && grid?.backstopping) {
    return 'Advisory. Backup pool reached the reserve floor. Now drawing from grid power; no action needed.';
  }
  // v0.15.18 — at/below the reserve floor the "projected in N hours" framing is
  // wrong (it already happened); speak the actual condition and the actions.
  if (priority === 'critical' && belowReserveFloor(p)) {
    return 'Critical alarm. Critical alarm. Backup pool is at the reserve floor. Non-backup circuits may lose power. Shed load or start the generator.';
  }
  if (priority === 'critical' && he != null) {
    return `Critical alarm. Critical alarm. Backup pool projected empty in about ${Math.max(1, Math.round(he))} hours before solar recovers. Shed load immediately.`;
  }
  if (priority === 'high' && he != null) {
    return `High priority alarm. Backup pool projected to deplete in about ${Math.max(1, Math.round(he))} hours before solar recovers. Reduce load now.`;
  }
  const h = hr != null ? Math.max(1, Math.round(hr)) : null;
  // v0.15.16 — the alert type leads so the listener hears the severity before
  // the detail (the critical/high paths above already announce it first).
  const prefix = priorityAnnouncementPrefix(priority);
  return `${prefix} Backup pool projected to reach reserve in about ${h} hours at the forecast load. Reduce consumption to preserve reserve until solar generates more.`;
}

/** v0.62.0 — Spanish "N hora(s)" with correct singular/plural. */
function horasEs(n: number | null): string {
  if (n == null) return '';
  return n === 1 ? '1 hora' : `${n} horas`;
}

/** v0.62.0 — Spanish (Latin American) counterpart of runwayAlarmMessage for the
 *  bilingual second pass. Same projection inputs → same numbers, in Spanish. */
export function runwayAlarmMessageEs(p: RunwayAlarmInput, priority: AlarmPriority, grid?: GridContext): string {
  const he = p.hoursToEmpty;
  const hr = p.hoursToReserve;
  if (belowReserveFloor(p) && grid?.backstopping) {
    return 'Aviso. La reserva de respaldo alcanzó el nivel mínimo de reserva. Ahora se está tomando energía de la red; no se requiere acción.';
  }
  if (priority === 'critical' && belowReserveFloor(p)) {
    return 'Alarma crítica. Alarma crítica. La reserva de respaldo está en el nivel mínimo de reserva. Los circuitos sin respaldo pueden quedarse sin energía. Reduzca la carga o encienda el generador.';
  }
  if (priority === 'critical' && he != null) {
    return `Alarma crítica. Alarma crítica. Se proyecta que la reserva de respaldo se agote en aproximadamente ${horasEs(Math.max(1, Math.round(he)))} antes de que el sol se recupere. Reduzca la carga de inmediato.`;
  }
  if (priority === 'high' && he != null) {
    return `Alarma de alta prioridad. Se proyecta que la reserva de respaldo se agote en aproximadamente ${horasEs(Math.max(1, Math.round(he)))} antes de que el sol se recupere. Reduzca la carga ahora.`;
  }
  const h = hr != null ? Math.max(1, Math.round(hr)) : null;
  const prefix = priorityAnnouncementPrefixEs(priority);
  return `${prefix} Se proyecta que la reserva de respaldo alcance el nivel mínimo de reserva en aproximadamente ${horasEs(h)} con la carga prevista. Reduzca el consumo para preservar la reserva hasta que el sol genere más.`;
}

interface PersistState {
  announcedPriority: AlarmPriority | null;
  lastAnnouncedAt: number | null;
  /** v0.15.22 — when the classification first went calmer than the announced
   *  tier (null = it hasn't). Persisted so a restart resumes the hold. */
  calmerSinceMs?: number | null;
}

/** v0.15.22 — a calmer classification must hold this long before the latch
 *  steps down. Without it, a projection hovering at a tier boundary (observed
 *  Jun 12: hoursToEmpty oscillating around the 3.0 h critical threshold while
 *  the EV charged) flapped critical→high→critical, and every re-cross
 *  re-announced the SAME critical message — the household heard it 4+ times
 *  in under an hour. Escalations are unaffected (always immediate). */
export const ALARM_DEESCALATE_HOLD_MS = 10 * 60 * 1000;

const STATE_PATH =
  process.env.BATTERY_RUNWAY_ALARM_PATH ??
  resolve(process.cwd(), config.dbPath, '..', 'runway-alarm.json');

export interface RunwayAlarm {
  /** Feed the latest runway projection. Fires onTrigger per the escalation rules.
   *  v0.23.0 — pass the live grid-backstop context so a floor crossing is only
   *  critical when the grid is NOT carrying the load. */
  update(p: RunwayAlarmInput, grid?: GridContext): void;
  /** Current persisted state — exposed for tests/diagnostics. */
  state(): PersistState;
}

export interface RunwayAlarmOptions {
  /** Invoked when an announcement should play. */
  onTrigger: (priority: AlarmPriority, message: string, messageEs: string) => void;
  /** Override the per-persistence re-announce cadence (tests). */
  reannounceMs?: number;
  /** Override the persistence path (tests). */
  statePath?: string;
  /** v0.15.18 — override the post-boot warm-up window during which a null
   *  projection must NOT re-arm the alarm (tests pass 0). */
  rearmWarmupMs?: number;
  /** v0.15.22 — override the de-escalation hold (tests). */
  deescalateHoldMs?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
}

function loadState(path: string): PersistState | null {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as PersistState;
  } catch {
    /* corrupt → null → start fresh */
  }
  return null;
}

function saveState(path: string, s: PersistState): void {
  try {
    atomicWriteFileSync(path, JSON.stringify(s));
  } catch {
    /* best effort — losing this just risks one extra announcement after a crash */
  }
}

export function createRunwayAlarm(opts: RunwayAlarmOptions): RunwayAlarm {
  const path = opts.statePath ?? STATE_PATH;
  const reannounceMs = opts.reannounceMs ?? RUNWAY_ALARM_REANNOUNCE_MS;
  const rearmWarmupMs = opts.rearmWarmupMs ?? REARM_WARMUP_MS;
  const deescalateHoldMs = opts.deescalateHoldMs ?? ALARM_DEESCALATE_HOLD_MS;
  const log = opts.log ?? (() => {});
  const persisted = loadState(path);
  let announcedPriority: AlarmPriority | null = persisted?.announcedPriority ?? null;
  let lastAnnouncedAt: number | null = persisted?.lastAnnouncedAt ?? null;
  let calmerSinceMs: number | null = persisted?.calmerSinceMs ?? null;

  const persist = () => saveState(path, { announcedPriority, lastAnnouncedAt, calmerSinceMs });

  return {
    update(p, grid) {
      const desired = classifyRunway(p, grid);
      const now = p.generatedAt;

      if (desired == null) {
        // Projection recovered (or unavailable) → re-arm so the next genuine
        // descent announces fresh.
        // v0.15.18 — NOT during process warm-up: every "projection recovered —
        // re-armed" in the 50 h log window fired 100–140 s after a boot, on a
        // projection computed from a half-warm forecast, wiping the persisted
        // announce state so the next tick re-announced an unchanged condition.
        // A genuine recovery survives past the warm-up window.
        if (Date.now() - PROCESS_START_MS < rearmWarmupMs) return;
        if (announcedPriority != null) {
          announcedPriority = null;
          lastAnnouncedAt = null;
          calmerSinceMs = null;
          persist();
          log('runway-alarm: projection recovered — re-armed');
        }
        return;
      }

      const entering = announcedPriority == null;
      const escalated = announcedPriority != null && RANK[desired] > RANK[announcedPriority];
      const stale = lastAnnouncedAt != null && now - lastAnnouncedAt >= reannounceMs;

      if (entering || escalated || stale) {
        // v0.15.18 — only mention figures that exist ("empty in —h" read like
        // a rendering bug and leaked into copied/pasted reports).
        const figs = [
          p.hoursToReserve != null ? `reserve in ${p.hoursToReserve}h` : null,
          p.hoursToEmpty != null ? `empty in ${p.hoursToEmpty}h` : null,
          belowReserveFloor(p) ? 'AT RESERVE FLOOR' : null,
        ].filter(Boolean);
        log(`runway-alarm: ${desired} — ${figs.join(' / ') || 'no horizon figures'}`);
        try {
          opts.onTrigger(desired, runwayAlarmMessage(p, desired, grid), runwayAlarmMessageEs(p, desired, grid));
        } catch (e: any) {
          log(`runway-alarm: onTrigger error: ${e?.message ?? e}`);
        }
        announcedPriority = desired;
        lastAnnouncedAt = now;
        calmerSinceMs = null;
        persist();
      } else if (RANK[desired] < RANK[announcedPriority!]) {
        // v0.15.22 — de-escalate the latch only after the calmer tier has HELD.
        // The old immediate step-down meant a projection hovering at a tier
        // boundary (critical↔high around hoursToEmpty = 3.0 h) re-announced the
        // same message on every re-cross. A genuine de-escalation (held the
        // full window) still steps down, so a later real rise re-announces.
        if (calmerSinceMs == null) {
          calmerSinceMs = now;
          persist();
        } else if (now - calmerSinceMs >= deescalateHoldMs) {
          announcedPriority = desired;
          calmerSinceMs = null;
          persist();
        }
      } else if (calmerSinceMs != null) {
        // Back at the announced tier — the calm didn't hold; reset its clock.
        calmerSinceMs = null;
        persist();
      }
    },
    state() {
      return { announcedPriority, lastAnnouncedAt, calmerSinceMs };
    },
  };
}
