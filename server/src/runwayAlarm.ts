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
import type { AlarmPriority } from './alertPriority.js';

/** The subset of RunwayProjection this alarm consumes. */
export interface RunwayAlarmInput {
  generatedAt: number;
  hoursToReserve: number | null;
  hoursToEmpty: number | null;
  unavailable: string | null;
}

/** Default re-announce cadence for a persisting projection (minutes → ms). */
export const RUNWAY_ALARM_REANNOUNCE_MS =
  Math.max(1, Number(process.env.BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN ?? 60)) * 60 * 1000;

const RANK: Record<AlarmPriority, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Map a runway projection to an alarm priority, or null when no depletion is
 * projected within the horizon. EMPTY (hoursToEmpty) escalates harder than
 * RESERVE (hoursToReserve) because empty is the harder failure.
 */
export function classifyRunway(p: RunwayAlarmInput): AlarmPriority | null {
  if (p.unavailable != null) return null;
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
  if (priority === 'critical' && he != null) {
    return `Critical alarm. Critical alarm. Backup pool projected empty in about ${Math.max(1, Math.round(he))} hours before solar recovers. Shed load immediately.`;
  }
  if (priority === 'high' && he != null) {
    return `High priority alarm. Backup pool projected to deplete in about ${Math.max(1, Math.round(he))} hours before solar recovers. Reduce load now.`;
  }
  const h = hr != null ? Math.max(1, Math.round(hr)) : null;
  const tail = priority === 'medium' ? 'Medium priority alarm.' : 'Advisory.';
  return `Backup pool projected to reach reserve in about ${h} hours at the forecast load. ${tail} Reduce consumption to preserve reserve until solar generates more.`;
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
        log(
          `runway-alarm: ${desired} — reserve in ${p.hoursToReserve ?? '—'}h / empty in ${p.hoursToEmpty ?? '—'}h`,
        );
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
