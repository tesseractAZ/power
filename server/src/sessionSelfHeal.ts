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

export interface SelfHealConfig {
  /** Devices simultaneously in a fired rate-collapse before the fleet counts as starved.
   *  2 = a single flaky device can never trigger a session rebuild. */
  minStarvedDevices: number;
  /** How long the fleet must stay starved before healing. Above transients
   *  (compressor bursts, brief dips); far below the 5-12 h pain. */
  starvedForMs: number;
  /** Minimum gap between rebuilds — the anti-thrash guarantee for flap storms. */
  cooldownMs: number;
  /** Hard daily cap; past it the healer stands down until the (UTC) day rolls. */
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
  /** UTC day key the counter belongs to (deterministic; no host-TZ dependence). */
  dayKey: string | null;
  healsToday: number;
}

export function freshSelfHealState(): SelfHealState {
  return { starvedSinceMs: null, lastHealMs: null, dayKey: null, healsToday: 0 };
}

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
  // Day rollover resets the cap.
  const day = utcDayKey(nowMs);
  if (state.dayKey !== day) {
    state.dayKey = day;
    state.healsToday = 0;
  }

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
  if (state.healsToday >= cfg.maxPerDay) {
    return { heal: false, reason: `daily cap reached (${state.healsToday}/${cfg.maxPerDay})` };
  }

  // Heal. Reset the onset so a PERSISTING starvation must dwell again on top of
  // the cooldown before the next attempt — the rebuild deserves time to work.
  state.lastHealMs = nowMs;
  state.healsToday += 1;
  state.starvedSinceMs = null;
  return {
    heal: true,
    reason: `${starvedCount} devices starved ${Math.round(starvedFor / 60_000)}m — rebuilding the EcoFlow MQTT session (heal ${state.healsToday}/${cfg.maxPerDay} today)`,
  };
}
