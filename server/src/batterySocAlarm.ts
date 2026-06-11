/**
 * v0.12.0 — Backup-pool state-of-charge (SoC) audible alarm.
 *
 * Fires an escalating audible announcement each time the SHP2 backup pool SoC
 * crosses DOWN through a threshold: 50 / 40 / 30 / 20 / 15 / 10 / 8 / 4 / 2 %, with
 * the alarm PRIORITY rising as the reserve gets lower (Low → Medium → High →
 * Critical). One announcement per downward crossing — not once per tick — with
 * hysteresis so a value hovering on a boundary doesn't chatter, and persisted
 * state so a restart doesn't re-announce thresholds already crossed.
 *
 * This is a DEDICATED audible path (it calls broadcast.announce directly)
 * rather than riding the normal alert→condition→broadcast pipeline, because
 * that pipeline only chimes for warning/critical conditions — and the user
 * wants the 40 % / 30 % (Low-priority) crossings to be audible too. The matching
 * on-screen alert is emitted separately by alerts.ts (and is excluded from the
 * broadcast condition there/in broadcast.ts so it never double-chimes).
 *
 * The actual chime + speech is delegated via the `announce` callback so this
 * module stays dependency-light and unit-testable; the annunciation gate
 * (per-priority enable from alertSettings) is applied by the caller (index.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { type AlarmPriority, priorityAnnouncementPrefix } from './alertPriority.js';

export interface SocThreshold {
  /** SoC percent at/below which (on the way down) this alarm fires. */
  pct: number;
  /** ISA alarm priority — escalates as the reserve gets lower. */
  priority: AlarmPriority;
}

/**
 * Thresholds, highest → lowest SoC, with escalating priority. The user asked
 * for 40/30/20/15/10/8/4/2 % with "increased priority as capacity gets lowest".
 */
export const BATTERY_SOC_THRESHOLDS: readonly SocThreshold[] = [
  { pct: 50, priority: 'low' },
  { pct: 40, priority: 'low' },
  { pct: 30, priority: 'low' },
  { pct: 20, priority: 'medium' },
  { pct: 15, priority: 'medium' },
  { pct: 10, priority: 'high' },
  { pct: 8, priority: 'high' },
  { pct: 4, priority: 'critical' },
  { pct: 2, priority: 'critical' },
] as const;

/** Re-arm a crossed threshold only once SoC climbs this many points back above
 *  it — stops a value sitting exactly on a boundary from chattering. */
const REARM_MARGIN_PCT = 2;

/** The spoken message for a crossing, e.g. "Medium priority alarm. Backup pool at 20 percent."
 *  v0.15.16 — the alert type leads so the listener hears the severity before
 *  the detail (matches buildAlertMessage and the runway critical/high paths). */
export function socAlarmMessage(t: SocThreshold): string {
  const prefix = priorityAnnouncementPrefix(t.priority);
  const tail = t.priority === 'critical' ? ' Restore charge immediately.' : '';
  return `${prefix} Backup pool at ${t.pct} percent.${tail}`;
}

/**
 * The highest-pct threshold the given SoC currently sits at/below — i.e. the
 * "active band". Returns null when SoC is null or above the top threshold.
 * Used by alerts.ts to surface a single on-screen "backup low" alert.
 */
export function activeSocBand(socPct: number | null | undefined): SocThreshold | null {
  if (socPct == null || !Number.isFinite(socPct)) return null;
  let band: SocThreshold | null = null;
  for (const t of BATTERY_SOC_THRESHOLDS) {
    if (socPct <= t.pct) band = t; // thresholds descend, so the last match is the lowest crossed
  }
  return band;
}

/**
 * The (severity, source) to stamp on the on-screen alert so that the web/TUI's
 * priorityOf(severity, source) derives the SAME ISA priority as the audible
 * alarm — giving all four tiers (Low/Medium/High/Critical) from this one alert.
 * (Medium is only reachable as warning+learned, hence the source choice.)
 */
export function socAlertSeverity(priority: AlarmPriority): {
  severity: 'critical' | 'warning' | 'info';
  source: 'threshold' | 'learned';
} {
  switch (priority) {
    case 'critical':
      return { severity: 'critical', source: 'threshold' }; // → Critical (P1)
    case 'high':
      return { severity: 'warning', source: 'threshold' }; // → High (P2)
    case 'medium':
      return { severity: 'warning', source: 'learned' }; // → Medium (P3)
    case 'low':
      return { severity: 'info', source: 'threshold' }; // → Low (P4)
  }
}

interface PersistState {
  /** armed[pct] === true → eligible to fire on the next downward crossing. */
  armed: Record<string, boolean>;
  lastSoc: number | null;
}

const STATE_PATH = process.env.BATTERY_SOC_ALARM_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'battery-soc-alarm.json');

export interface BatterySocAlarm {
  /** Feed the latest backup-pool SoC (%). Fires onCross for each downward crossing. */
  update(socPct: number | null | undefined): void;
  /** Current armed map — exposed for tests/diagnostics. */
  armed(): Record<number, boolean>;
}

export interface BatterySocAlarmOptions {
  /** Invoked once per downward threshold crossing. */
  onCross: (t: SocThreshold) => void;
  /** Override the persistence path (tests). */
  statePath?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
}

function loadState(path: string): PersistState | null {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as PersistState;
  } catch {
    /* corrupt → null → re-derive from current SoC */
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

export function createBatterySocAlarm(opts: BatterySocAlarmOptions): BatterySocAlarm {
  const path = opts.statePath ?? STATE_PATH;
  const log = opts.log ?? (() => {});
  const persisted = loadState(path);
  // armed by pct. If no persisted state, arming is derived lazily on the first
  // real reading so a boot at e.g. 18% doesn't re-announce 40/30/20.
  const armed = new Map<number, boolean>();
  if (persisted?.armed) {
    for (const t of BATTERY_SOC_THRESHOLDS) {
      if (typeof persisted.armed[t.pct] === 'boolean') armed.set(t.pct, persisted.armed[t.pct]);
    }
  }
  let initialized = armed.size === BATTERY_SOC_THRESHOLDS.length;
  let lastSoc: number | null = persisted?.lastSoc ?? null;

  function persist() {
    const armedObj: Record<string, boolean> = {};
    for (const t of BATTERY_SOC_THRESHOLDS) armedObj[t.pct] = armed.get(t.pct) ?? true;
    saveState(path, { armed: armedObj, lastSoc });
  }

  return {
    update(socPct) {
      if (socPct == null || !Number.isFinite(socPct)) return;
      const soc = socPct;

      // First real reading with no persisted state: arm only thresholds the
      // battery is currently ABOVE, so already-crossed ones don't re-fire.
      if (!initialized) {
        for (const t of BATTERY_SOC_THRESHOLDS) armed.set(t.pct, soc > t.pct);
        initialized = true;
        lastSoc = soc;
        persist();
        return;
      }

      let fired = false;
      for (const t of BATTERY_SOC_THRESHOLDS) {
        const isArmed = armed.get(t.pct) ?? true;
        if (isArmed && soc <= t.pct) {
          // Downward crossing.
          armed.set(t.pct, false);
          fired = true;
          log(`battery-soc-alarm: crossed ${t.pct}% (${t.priority}) — SoC ${soc.toFixed(1)}%`);
          try {
            opts.onCross(t);
          } catch (e: any) {
            log(`battery-soc-alarm: onCross error: ${e?.message ?? e}`);
          }
        } else if (!isArmed && soc >= t.pct + REARM_MARGIN_PCT) {
          // Recovered above the threshold (+hysteresis) → re-arm for next time.
          armed.set(t.pct, true);
          fired = true;
        }
      }
      lastSoc = soc;
      if (fired) persist();
    },
    armed() {
      const out: Record<number, boolean> = {};
      for (const t of BATTERY_SOC_THRESHOLDS) out[t.pct] = armed.get(t.pct) ?? true;
      return out;
    },
  };
}

/** Test-only reset helper is unnecessary — pass a unique statePath per test. */
