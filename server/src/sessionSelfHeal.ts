/**
 * v1.76.0 — EcoFlow cloud-session SELF-HEAL.
 *
 * The nightly starvation record (90.5h audit, 2026-08-05..09): the cloud session
 * degrades most evenings — Cores drop to ~2-4 msg/min while staying "fresh" on
 * REST — and recovery timing is a lottery: 43 min, 69 min, 5h15m, 11h47m, ~9h.
 * The two long nights ran the entire drawdown on ~2.7 msg/min telemetry.
 *
 * Three facts from that record shape this design:
 *  1. The 11h47m episode self-healed with NO restart and NO reconnect — so the
 *     transport can recover, but nothing forces it to. A proactive session
 *     rebuild (stop + certificate re-fetch + fresh MQTT connect) is the only
 *     lever on our side of the cloud.
 *  2. Two episodes recovered at exactly 23:01 — the night-charge window opening
 *     — suggesting cloud-side activity can wake the stream. A rebuild is a
 *     stronger version of the same nudge.
 *  3. The 08-08 13:1x flap storm shows the failure can thrash. The cooldown and
 *     daily cap exist so the healer can never become its own storm.
 *
 * SCOPE: this rebuilds OUR OWN MQTT client only. It never writes to a device,
 * never touches REST polling (the alarm data path), and a failed rebuild simply
 * falls back to the existing startMqttWithRetry backoff. Worst case equals the
 * status quo; best case turns a 9-hour starvation into a ~20-minute one.
 *
 * Pure and deterministic (time injected, state explicit) so it unit-tests
 * without a clock and the harness can mutate it meaningfully.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';

export interface SelfHealConfig {
  /** Devices simultaneously in a fired rate-collapse before the fleet counts as starved.
   *  2 = a single flaky device can never trigger a session rebuild. */
  minStarvedDevices: number;
  /** How long the fleet must stay starved before healing. Above transients
   *  (compressor bursts, brief dips); far below the 5-12 h pain. */
  starvedForMs: number;
  /** Minimum gap between rebuilds — the anti-thrash guarantee for flap storms. */
  cooldownMs: number;
  /** v1.90.0 — hard cap per ROLLING 24 h. The v1.76.0 UTC-day cap rolled at
   *  17:00 MST — mid-evening, splitting every night's episode across two
   *  budget days (night 9 spent 5 heals before 05:58 and banked the 6th into
   *  the next "day" at 09:31). A rolling window matches the phenomenon. */
  maxPerDay: number;
}

export const DEFAULT_SELF_HEAL_CONFIG: SelfHealConfig = {
  minStarvedDevices: Number(process.env.SELF_HEAL_MIN_DEVICES ?? 2),
  starvedForMs: Number(process.env.SELF_HEAL_AFTER_MS ?? 20 * 60_000),
  cooldownMs: Number(process.env.SELF_HEAL_COOLDOWN_MS ?? 60 * 60_000),
  maxPerDay: Number(process.env.SELF_HEAL_MAX_PER_DAY ?? 6),
};

export interface SelfHealState {
  /** When ≥minStarvedDevices first became continuously true; null when below. */
  starvedSinceMs: number | null;
  /** Last rebuild we initiated. */
  lastHealMs: number | null;
  /** v1.90.0 — timestamps of every heal in (at least) the last 24 h; pruned on
   *  each evaluation. Replaces the UTC-day counter (dayKey/healsToday). */
  healTimesMs: number[];
}

/* ─── budget sidecar ──────────────────────────────────────────────────────
 * v1.93.0 — `healTimesMs` used to live only in process memory, so the "6 per
 * rolling 24 h" anti-thrash guarantee was really "6 per PROCESS LIFETIME". This
 * add-on restarts several times a day (deploys, supervisor updates), and on
 * 2026-08-20/21 that produced 10 rebuilds in 22 h 14 m against a nominal cap of
 * 6: heals at 02:02/03:02/04:02/05:02, a restart at 09:53, then a fresh budget
 * that reported "heal 1/6" at 19:16 while 02:02 was still inside the window.
 * Persist it the way messageRateFloor persists its learned baselines.
 * ─────────────────────────────────────────────────────────────────────── */

const SIDECAR = (): string =>
  process.env.SELF_HEAL_STATE_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'self-heal-budget.json');

/** Load the persisted heal budget, pruned to the rolling window. Never throws. */
export function loadSelfHealState(nowMs: number = Date.now()): SelfHealState {
  const fresh = freshSelfHealState();
  try {
    if (!existsSync(SIDECAR())) return fresh;
    const raw = JSON.parse(readFileSync(SIDECAR(), 'utf8'));
    if (Array.isArray(raw?.healTimesMs)) {
      fresh.healTimesMs = raw.healTimesMs
        .filter((t: unknown): t is number => typeof t === 'number' && Number.isFinite(t))
        .filter((t: number) => nowMs - t < HEAL_BUDGET_WINDOW_MS)
        .sort((a: number, b: number) => a - b);
    }
    if (typeof raw?.lastHealMs === 'number' && Number.isFinite(raw.lastHealMs)) {
      fresh.lastHealMs = raw.lastHealMs;  // the cooldown must also survive a restart
    }
    // starvedSinceMs is deliberately NOT restored: the dwell must be re-earned
    // against live telemetry after a restart, not inherited from a dead process.
    return fresh;
  } catch {
    return fresh;
  }
}

export function saveSelfHealState(state: SelfHealState): void {
  try {
    atomicWriteFileSync(SIDECAR(), JSON.stringify({
      healTimesMs: state.healTimesMs, lastHealMs: state.lastHealMs,
    }));
  } catch { /* best-effort: the budget is a guard, never a data source */ }
}

export function freshSelfHealState(): SelfHealState {
  return { starvedSinceMs: null, lastHealMs: null, healTimesMs: [] };
}

export const HEAL_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** UTC day key — deliberately NOT Intl/locale-based (locale data is incomplete
 *  on the Pi image and has bitten this codebase before). */
export function utcDayKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export interface SelfHealVerdict {
  heal: boolean;
  /** For the log line — why we did or did not act. */
  reason: string;
}

/**
 * One evaluation tick. MUTATES `state` (onset tracking, day rollover, and — when
 * healing — the cooldown/day counters), so the caller only acts on `heal`.
 */
export function evaluateSelfHeal(
  nowMs: number,
  starvedCount: number,
  state: SelfHealState,
  cfg: SelfHealConfig = DEFAULT_SELF_HEAL_CONFIG,
): SelfHealVerdict {
  // v1.90.0 — prune the rolling window; the budget is heals within 24 h.
  state.healTimesMs = state.healTimesMs.filter((t) => nowMs - t < HEAL_BUDGET_WINDOW_MS);

  // Onset tracking: the fleet-starved clock runs only while the condition holds.
  if (starvedCount < cfg.minStarvedDevices) {
    state.starvedSinceMs = null;
    return { heal: false, reason: `only ${starvedCount} device(s) starved (< ${cfg.minStarvedDevices})` };
  }
  if (state.starvedSinceMs == null) state.starvedSinceMs = nowMs;

  const starvedFor = nowMs - state.starvedSinceMs;
  if (starvedFor < cfg.starvedForMs) {
    return { heal: false, reason: `fleet starved ${Math.round(starvedFor / 60_000)}m (< ${Math.round(cfg.starvedForMs / 60_000)}m dwell)` };
  }
  if (state.lastHealMs != null && nowMs - state.lastHealMs < cfg.cooldownMs) {
    return { heal: false, reason: `cooldown (${Math.round((nowMs - state.lastHealMs) / 60_000)}m since last heal < ${Math.round(cfg.cooldownMs / 60_000)}m)` };
  }
  if (state.healTimesMs.length >= cfg.maxPerDay) {
    return { heal: false, reason: `daily cap reached (${state.healTimesMs.length}/${cfg.maxPerDay} in the rolling 24h)` };
  }

  // Heal. Reset the onset so a PERSISTING starvation must dwell again on top of
  // the cooldown before the next attempt — the rebuild deserves time to work.
  state.lastHealMs = nowMs;
  state.healTimesMs.push(nowMs);
  state.starvedSinceMs = null;
  return {
    heal: true,
    reason: `${starvedCount} devices starved ${Math.round(starvedFor / 60_000)}m — rebuilding the EcoFlow MQTT session (heal ${state.healTimesMs.length}/${cfg.maxPerDay} in the rolling 24h)`,
  };
}
