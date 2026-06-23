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

/** v0.54.4 — physical-plausibility guard. The ~92 kWh backup pool moves well under ~0.3 %
 *  per poll even at rated discharge, so a single-tick SoC FALL larger than this from a
 *  FRESH, healthy baseline is a stale/reconnect artifact (the SHP2's backupIncreInfo briefly
 *  reads 0 on an EcoFlow-cloud reconnect — it laddered the whole 50→2 % cascade on
 *  2026-06-21 18:12), not a real discharge. We ignore such a read rather than fire. This is
 *  the depth backstop for the (rare) perfectly-coherent zero the source coherence gate
 *  (ecoflow/project.ts coherentBackupPool) can't distinguish from a real empty pool. */
const MAX_PLAUSIBLE_DROP_PCT = Number(process.env.BATTERY_SOC_MAX_DROP_PCT ?? 25);
/** Only guard collapses FROM a healthy pool — a real deep discharge reaches 0 from an
 *  already-low baseline, where the critical bands must still fire. */
const HEALTHY_BASELINE_PCT = 30;
/** The slew check only applies against a RECENT baseline. After a long gap (restart, hours
 *  cloud-offline) the persisted lastSoc is stale and a large real change is plausible, so the
 *  first fresh read re-baselines instead of being wrongly rejected. */
const SLEW_BASELINE_MAX_AGE_MS = 10 * 60 * 1000;
/** v0.54.4 — persist the baseline at least this often (even on a quiet, non-firing tick) so the
 *  on-disk `lastSocAtMs` is never more than this stale; keeps the slew guard active across a
 *  quick restart. Comfortably under SLEW_BASELINE_MAX_AGE_MS. */
const BASELINE_PERSIST_THROTTLE_MS = 5 * 60 * 1000;

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
 * The (severity, source, priority) to stamp on the on-screen alert so that the
 * web/TUI's priorityOf() derives the SAME ISA priority as the audible alarm —
 * giving all four tiers (Low/Medium/High/Critical) from this one alert.
 *
 * v0.44.0 — these reserve-band crossings are REAL measured threshold crossings,
 * so they are always source='threshold' (they belong on the operational Alerts
 * page, not the Predictive/learned page, and the cleared-history badge must not
 * mislabel them "learned"). The Medium tier used to ride source='learned' purely
 * so priorityOf mapped warning+learned → Medium; that conflated a measurement
 * with a forecast. Instead we carry an EXPLICIT ISA `priority` field that
 * priorityOf reads first, so Medium stays reachable without faking the source.
 * Reserve source='learned' for genuine forecasts (forecast-… / baseline-… ids).
 */
export function socAlertSeverity(priority: AlarmPriority): {
  severity: 'critical' | 'warning' | 'info';
  source: 'threshold';
  priority: AlarmPriority;
} {
  switch (priority) {
    case 'critical':
      return { severity: 'critical', source: 'threshold', priority: 'critical' }; // → Critical (P1)
    case 'high':
      return { severity: 'warning', source: 'threshold', priority: 'high' }; // → High (P2)
    case 'medium':
      return { severity: 'warning', source: 'threshold', priority: 'medium' }; // → Medium (P3) via explicit field
    case 'low':
      return { severity: 'info', source: 'threshold', priority: 'low' }; // → Low (P4)
  }
}

interface PersistState {
  /** armed[pct] === true → eligible to fire on the next downward crossing. */
  armed: Record<string, boolean>;
  lastSoc: number | null;
  /** v0.54.4 — wall-clock of the last honored reading; lets the slew guard tell a fresh
   *  baseline (quick restart) from a stale one (long downtime). Absent in older state files
   *  → treated as null → first read re-baselines (safe). */
  lastSocAtMs?: number | null;
}

const STATE_PATH = process.env.BATTERY_SOC_ALARM_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'battery-soc-alarm.json');

export interface BatterySocAlarm {
  /** Feed the latest backup-pool SoC (%). Fires onCross for each downward crossing.
   *  `nowMs` is injectable for deterministic tests (defaults to Date.now()). */
  update(socPct: number | null | undefined, nowMs?: number): void;
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
  let lastSocAtMs: number | null = persisted?.lastSocAtMs ?? null;
  // v0.54.4 — the on-disk baseline must stay fresh enough that the plausibility guard is still
  // active on the FIRST reading after a quick restart (SHP2 reconnects often coincide with
  // add-on restart boundaries). Without this, a long quiet period (no crossings → no persist)
  // leaves a stale `lastSocAtMs` on disk, so a coherent-zero arriving right at restart would
  // slip past the guard. Persisting on a throttle bounds the on-disk staleness.
  let lastPersistAtMs: number | null = lastSocAtMs;

  function persist() {
    const armedObj: Record<string, boolean> = {};
    for (const t of BATTERY_SOC_THRESHOLDS) armedObj[t.pct] = armed.get(t.pct) ?? true;
    saveState(path, { armed: armedObj, lastSoc, lastSocAtMs });
    lastPersistAtMs = lastSocAtMs;
  }

  return {
    update(socPct, nowMs = Date.now()) {
      if (socPct == null || !Number.isFinite(socPct)) return;
      const soc = socPct;

      // v0.54.4 — ignore an implausibly-large single-tick DROP from a FRESH, healthy baseline
      // (a stale SHP2 reconnect reads 0 while the pool is fine). Don't fire, don't advance the
      // baseline → it self-heals the instant a real read returns, and a SUSTAINED stale 0 keeps
      // being rejected (the baseline never moves). A real discharge is gradual (each tick well
      // under the cap) and never trips this; a real deep discharge reaches 0 from an already-low
      // (<HEALTHY_BASELINE_PCT) baseline, where the guard is inactive so the critical bands fire.
      if (
        initialized && lastSoc != null && lastSocAtMs != null &&
        nowMs - lastSocAtMs <= SLEW_BASELINE_MAX_AGE_MS &&
        lastSoc >= HEALTHY_BASELINE_PCT &&
        lastSoc - soc > MAX_PLAUSIBLE_DROP_PCT
      ) {
        log(`battery-soc-alarm: ignoring implausible ${lastSoc.toFixed(1)}→${soc.toFixed(1)}% single-tick drop (stale reconnect?)`);
        return;
      }

      // First real reading with no persisted state: arm only thresholds the
      // battery is currently ABOVE, so already-crossed ones don't re-fire.
      if (!initialized) {
        for (const t of BATTERY_SOC_THRESHOLDS) armed.set(t.pct, soc > t.pct);
        initialized = true;
        lastSoc = soc;
        lastSocAtMs = nowMs;
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
      lastSocAtMs = nowMs;
      // Persist on a crossing/re-arm, or on the throttle so the on-disk baseline stays fresh
      // enough that the plausibility guard survives a quick restart.
      if (fired || lastPersistAtMs == null || nowMs - lastPersistAtMs >= BASELINE_PERSIST_THROTTLE_MS) {
        persist();
      }
    },
    armed() {
      const out: Record<number, boolean> = {};
      for (const t of BATTERY_SOC_THRESHOLDS) out[t.pct] = armed.get(t.pct) ?? true;
      return out;
    },
  };
}

/** Test-only reset helper is unnecessary — pass a unique statePath per test. */
