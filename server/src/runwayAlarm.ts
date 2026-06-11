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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { type AlarmPriority, priorityAnnouncementPrefix } from './alertPriority.js';

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
const PROCESS_START_MS = Date.now();
const REARM_WARMUP_MS = 3 * 60 * 1000;

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

export function classifyRunway(p: RunwayAlarmInput): AlarmPriority | null {
  if (p.unavailable != null) return null;
  // v0.15.18 — being AT/below the reserve floor is the emergency this ladder
  // exists for (the SHP2 cuts non-backup circuits there), yet the old ranking
  // DE-escalated to 'high' once the crossing was behind us (observed Jun 10
  // 00:51 local: "high — reserve in 18.8h" while pinned at the 10 % floor).
  if (belowReserveFloor(p)) return 'critical';
  const he = p.hoursToEmpty;
  const hr = p.hoursToReserve;
  if (he != null && he <= 3) return 'critical';
  if (he != null && he <= 8) return 'high';
  if (hr != null && hr <= 6) return 'medium';
  if (hr != null) return 'low';
  return null;
}

/** The spoken message for a projection at a given priority. */
export function runwayAlarmMessage(p: RunwayAlarmInput, priority: AlarmPriority): string {
  const he = p.hoursToEmpty;
  const hr = p.hoursToReserve;
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

interface PersistState {
  announcedPriority: AlarmPriority | null;
  lastAnnouncedAt: number | null;
}

const STATE_PATH =
  process.env.BATTERY_RUNWAY_ALARM_PATH ??
  resolve(process.cwd(), config.dbPath, '..', 'runway-alarm.json');

export interface RunwayAlarm {
  /** Feed the latest runway projection. Fires onTrigger per the escalation rules. */
  update(p: RunwayAlarmInput): void;
  /** Current persisted state — exposed for tests/diagnostics. */
  state(): PersistState;
}

export interface RunwayAlarmOptions {
  /** Invoked when an announcement should play. */
  onTrigger: (priority: AlarmPriority, message: string) => void;
  /** Override the per-persistence re-announce cadence (tests). */
  reannounceMs?: number;
  /** Override the persistence path (tests). */
  statePath?: string;
  /** v0.15.18 — override the post-boot warm-up window during which a null
   *  projection must NOT re-arm the alarm (tests pass 0). */
  rearmWarmupMs?: number;
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
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, path);
  } catch {
    /* best effort — losing this just risks one extra announcement after a crash */
  }
}

export function createRunwayAlarm(opts: RunwayAlarmOptions): RunwayAlarm {
  const path = opts.statePath ?? STATE_PATH;
  const reannounceMs = opts.reannounceMs ?? RUNWAY_ALARM_REANNOUNCE_MS;
  const rearmWarmupMs = opts.rearmWarmupMs ?? REARM_WARMUP_MS;
  const log = opts.log ?? (() => {});
  const persisted = loadState(path);
  let announcedPriority: AlarmPriority | null = persisted?.announcedPriority ?? null;
  let lastAnnouncedAt: number | null = persisted?.lastAnnouncedAt ?? null;

  const persist = () => saveState(path, { announcedPriority, lastAnnouncedAt });

  return {
    update(p) {
      const desired = classifyRunway(p);
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
          opts.onTrigger(desired, runwayAlarmMessage(p, desired));
        } catch (e: any) {
          log(`runway-alarm: onTrigger error: ${e?.message ?? e}`);
        }
        announcedPriority = desired;
        lastAnnouncedAt = now;
        persist();
      } else if (RANK[desired] < RANK[announcedPriority!]) {
        // De-escalated but still in the band — track the lower priority (without
        // re-announcing) so a later rise is correctly detected as an escalation.
        announcedPriority = desired;
        persist();
      }
    },
    state() {
      return { announcedPriority, lastAnnouncedAt };
    },
  };
}
