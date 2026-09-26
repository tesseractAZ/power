import type { Alert } from './alerts.js';

/**
 * v0.84.0 — Audible-delivery health signal + self-alert.
 *
 * The audible broadcast channel (Music Assistant → speakers) can be ENABLED yet
 * unable to reach a single speaker — the exact silent failure that hid a dead
 * alarm channel in production: Music Assistant fell into `setup_error`, every
 * MA-provided media_player went `unavailable`, and NOTHING said so. The only
 * component that "knew" audible was dead was the dead audible path itself.
 *
 * This module makes that self-announcing. The broadcast monitor probes target
 * reachability on a throttle and publishes a BroadcastHealth snapshot here; the
 * alert engine turns a confirmed unreachable-while-enabled state into a WARNING
 * that rides the WORKING push channel. It is deliberately NOT `annunciate:false`
 * (which would suppress the push too) — instead broadcast.conditionFromAlerts
 * excludes its id so it can never, circularly, try to chime over the very
 * channel it is reporting broken.
 */
export interface BroadcastHealth {
  /** Audible broadcasting opted in (BROADCAST_ENABLED). */
  enabled: boolean;
  /** Running under the HA supervisor (audible is a no-op otherwise). */
  supervised: boolean;
  /** Configured BROADCAST_TARGETS count. */
  targetCount: number;
  /** Configured targets currently registered AND not `unavailable`. */
  usableTargets: number;
  /** MA announce service present in the catalog AND ≥1 configured target reachable. */
  musicAssistantAvailable: boolean;
  /**
   * Can audible actually deliver right now?
   *   true  = ≥1 speaker reachable
   *   false = CONFIRMED unreachable (debounced past transient HA/MA restarts)
   *   null  = not yet probed / not applicable (disabled or unsupervised)
   * Only `false` raises the operator alert — `null` never false-alarms at boot.
   */
  reachable: boolean | null;
  /** Human reason when !reachable (for the alert detail + status). */
  reason: string | null;
  /** Epoch ms of the last probe (null before the first). */
  lastProbeAt: number | null;
  /**
   * v1.186.0 — CONFIRMED (debounced like `reachable`) fewer usable targets than configured.
   * Optional so a snapshot without it reads as "not degraded"; only `true` raises the alert.
   */
  degraded?: boolean;
  /** v1.186.0 — the configured targets not usable at the last probe, each with its reason. */
  unusableTargets?: string[];
}

const UNKNOWN: BroadcastHealth = {
  enabled: false,
  supervised: false,
  targetCount: 0,
  usableTargets: 0,
  musicAssistantAvailable: false,
  reachable: null,
  reason: null,
  lastProbeAt: null,
};

let current: BroadcastHealth = { ...UNKNOWN };

export function setBroadcastHealth(h: BroadcastHealth): void {
  current = h;
}

export function getBroadcastHealth(): BroadcastHealth {
  return current;
}

/** Reset to the pre-probe unknown state (used by tests). */
export function resetBroadcastHealth(): void {
  current = { ...UNKNOWN };
}

/** Stable id — one alert, dedup + resolve keyed on it. */
export const AUDIBLE_UNREACHABLE_ALERT_ID = 'system-audible-unreachable';

export function isAudibleHealthAlert(alert: Pick<Alert, 'id'>): boolean {
  return alert.id === AUDIBLE_UNREACHABLE_ALERT_ID;
}

/**
 * Pure builder: an audible channel that is ENABLED + SUPERVISED but cannot reach
 * a speaker becomes a WARNING push. Returns null in every other state — most
 * importantly when reachability is unknown (`null`: pre-probe / boot / transient
 * restart) so a not-yet-warmed monitor never false-alarms, and when audible is
 * disabled (the operator chose silence) or unsupervised (audible is N/A).
 *
 * Severity is WARNING / priority MEDIUM: it routes to the push channel and is
 * operator-actionable, but it is NOT high/critical, so it will never break
 * through quiet hours to wake the household — an unreachable *speaker* is not an
 * emergency; the emergencies still push on their own alert.
 *
 * This is a STANDING condition (not an outage-style event), so it resolves
 * normally when audible recovers — the operator wants the "audible restored"
 * signal, unlike a retrospective outage which ages off silently.
 */
export function broadcastHealthAlert(h: BroadcastHealth, _nowMs: number): Alert | null {
  if (!h.enabled || !h.supervised) return null; // audible not applicable → no alert
  if (h.reachable !== false) return null; // true or null → no alert (null = unprobed/transient)
  const detail =
    h.targetCount === 0
      ? 'Audible broadcasts are enabled but no speakers are configured (BROADCAST_TARGETS is empty). Push alerts still work; audible alarms cannot play.'
      : h.usableTargets === 0
        ? `Audible broadcasts are enabled but none of the ${h.targetCount} configured speaker(s) are reachable — ${h.reason ?? 'all targets unavailable'}. Push alerts still work; audible alarms will NOT play until a speaker returns.`
        : `Audible broadcast delivery is degraded — ${h.reason ?? 'unknown'}. Push alerts still work.`;
  return {
    id: AUDIBLE_UNREACHABLE_ALERT_ID,
    severity: 'warning',
    category: 'Connectivity',
    device: 'System',
    title: 'Audible alarm channel unreachable',
    detail,
    priority: 'medium',
  };
}

/** v1.186.0 — stable id for the DEGRADED audible channel (some, not all, speakers usable). The
 *  shared `system-audible` prefix keeps it out of the audible condition (conditionFromAlerts). */
export const AUDIBLE_DEGRADED_ALERT_ID = 'system-audible-degraded';

/**
 * v1.186.0 — the partial-channel alert. The unreachable alert above fires only when NO speaker is
 * usable, so a speaker that dropped out of Home Assistant (one of two was `unavailable` for ~27 h
 * on 2026-09-23/24) raised nothing, and every broadcast still logged "→ ok". A room without its
 * speaker hears no audible alarm, so this is a WARNING push (priority medium, like its sibling:
 * operator-actionable, never breaks through quiet hours) that NAMES the missing speakers.
 *
 * Returns null unless the monitor has CONFIRMED the degraded state (`degraded === true`, debounced
 * like `reachable`, so a restart blip is silent), and while audible is disabled/unsupervised. It
 * also yields to the unreachable alert: once `reachable === false` is confirmed that alert owns
 * the dead channel — one alert, not two. A standing condition; it resolves when every speaker is
 * usable again.
 */
export function broadcastDegradedAlert(h: BroadcastHealth, _nowMs: number): Alert | null {
  if (!h.enabled || !h.supervised) return null;
  if (h.reachable === false) return null;
  if (h.degraded !== true) return null;
  const missing = h.unusableTargets ?? [];
  const names = missing.length > 0 ? missing.join(', ') : 'unknown';
  // v1.186.0 — ZERO usable while the unreachable alert is still confirming (its streak runs
  // behind this one when the last speaker drops after the others): nothing can play, so the
  // card must not say the "remaining speaker(s) still work". Once reachable === false is
  // confirmed the unreachable alert takes over (a handoff, alertMonitor resolveHandoffOwner).
  const none = h.usableTargets === 0;
  return {
    id: AUDIBLE_DEGRADED_ALERT_ID,
    severity: 'warning',
    category: 'Connectivity',
    device: 'System',
    title: 'Audible alarm channel degraded',
    detail: none
      ? `No configured speaker (0 of ${h.targetCount}) can play audible alarms right now — not reachable: ${names}. `
        + 'Audible alarms will NOT play until a speaker returns (confirming whether the whole channel is down); push alerts still work.'
      : `Only ${h.usableTargets} of ${h.targetCount} configured speaker(s) can play audible alarms — not reachable: ${names}. `
        + 'Audible alarms will not play on the missing speaker(s) until they return; the remaining speaker(s) and push alerts still work.',
    priority: 'medium',
  };
}
