import type { Alert } from './alerts.js';

/**
 * v1.69.0 — TELEMETRY-BLIND self-alert.
 *
 * On 2026-08-04 the house was powered down to reset the SHP2. The Pi has no
 * battery-backed RTC, so it booted with a stale clock, and DNS was still coming up
 * (EAI_AGAIN at 16:20) so systemd-timesyncd could not sync. The clock sat 170 s
 * behind real time. EcoFlow signs every API request with a timestamp, so every poll
 * returned `8521: signature is wrong` and the add-on held ZERO telemetry:
 *
 *     /api/snapshot  generatedAt = 0, devices = {}      (never populated)
 *     /api/health    { ok: true, vitalsLevel: "ok" }    (reported healthy)
 *
 * For 22 minutes the alarm system could not have seen a fire, a grid loss or an
 * empty battery — and said it was fine. Nothing alerted. It self-resolved only when
 * timesyncd eventually caught up, and only the operator asking for a log review
 * surfaced it at all.
 *
 * The pre-existing comment at index.ts startMqttWithRetry states the assumption this
 * module exists to break: "REST polling (the alarm data path) never stops". It can,
 * and when it does the failure is SILENT and self-reporting is GREEN.
 *
 * Two guards, both here:
 *   1. BLIND DETECTION — no usable device telemetry past a grace window raises a
 *      CRITICAL alert, and makes /api/health honest. Grace exists because a cold
 *      boot legitimately has no data for a minute or two.
 *   2. AUTH SELF-HEAL — repeated signature rejections are, on this hardware, almost
 *      always clock skew. After enough consecutive ones we tell the caller to rebuild
 *      the EcoFlow client, which re-signs from the (hopefully corrected) clock rather
 *      than waiting out a backoff that tops out at 5 min and never gives up.
 *
 * Pure and deterministic (time injected) so it unit-tests without a clock.
 */

export interface BlindConfig {
  /** Grace after boot before an empty store counts as blind. */
  bootGraceMs: number;
  /** How long telemetry may be stale before it counts as blind. */
  staleMs: number;
  /** Consecutive auth-shaped poll failures before recommending a client rebuild. */
  authFailuresBeforeHeal: number;
  /** Minimum gap between self-heal attempts, so this cannot become a restart loop. */
  healCooldownMs: number;
}

export const DEFAULT_BLIND_CONFIG: BlindConfig = {
  bootGraceMs: Number(process.env.TELEMETRY_BLIND_BOOT_GRACE_MS ?? 180_000), // 3 min
  staleMs: Number(process.env.TELEMETRY_BLIND_STALE_MS ?? 300_000), // 5 min
  authFailuresBeforeHeal: Number(process.env.TELEMETRY_AUTH_HEAL_AFTER ?? 5),
  healCooldownMs: Number(process.env.TELEMETRY_AUTH_HEAL_COOLDOWN_MS ?? 600_000), // 10 min
};

/**
 * Classify a poll error. `auth` is the class that means "the cloud is reachable and
 * rejecting us" — on this hardware that is overwhelmingly a clock-skew signature
 * failure, NOT a credential problem, because the credentials do not change by
 * themselves across a power cut.
 */
export type PollErrorKind = 'auth' | 'network' | 'other';
export function classifyPollError(message: string | null | undefined): PollErrorKind {
  const m = (message ?? '').toLowerCase();
  if (!m) return 'other';
  // 8521 is EcoFlow's "signature is wrong". Match the code AND the prose, because
  // the API has returned the text without the code before.
  if (m.includes('8521') || m.includes('signature is wrong')) return 'auth';
  if (m.includes('eai_again') || m.includes('enotfound') || m.includes('econnrefused')
      || m.includes('etimedout') || m.includes('timeout') || m.includes('socket hang up')
      || m.includes('network') || m.includes('econnreset')) return 'network';
  return 'other';
}

export interface BlindInputs {
  nowMs: number;
  /** When this process started. */
  bootMs: number;
  /** Devices currently carrying a usable projection (dpu/shp2). */
  projectedDeviceCount: number;
  /** Last successful poll, or null if there has never been one. */
  lastPollOkMs: number | null;
  /** Consecutive poll failures right now (0 when healthy). */
  consecutiveFailures: number;
  /** The most recent poll error message. */
  lastError: string | null;
  /** When we last rebuilt the client because of this, or null. */
  lastHealAtMs: number | null;
}

export interface BlindVerdict {
  /** True when the add-on has no telemetry it can raise alarms from. */
  blind: boolean;
  /** 'never' — never populated since boot; 'stale' — had data, lost it. */
  reason: 'never' | 'stale' | null;
  /** How long it has been blind, ms. */
  blindForMs: number;
  /** The failure class currently driving it. */
  errorKind: PollErrorKind;
  /** True when the caller should rebuild the EcoFlow client now. */
  shouldSelfHeal: boolean;
}

export function assessBlind(i: BlindInputs, cfg: BlindConfig = DEFAULT_BLIND_CONFIG): BlindVerdict {
  const errorKind = classifyPollError(i.lastError);
  const idle: BlindVerdict = { blind: false, reason: null, blindForMs: 0, errorKind, shouldSelfHeal: false };

  // Healthy: we have devices AND a recent successful poll. Both matter — a stale
  // projection left over from before the outage still populates the devices map,
  // which is exactly how this failure hid the first time.
  const sincePollOk = i.lastPollOkMs == null ? null : i.nowMs - i.lastPollOkMs;
  const hasDevices = i.projectedDeviceCount > 0;
  const pollFresh = sincePollOk != null && sincePollOk < cfg.staleMs;
  if (hasDevices && pollFresh) return idle;

  // Never populated: only counts once the boot grace has elapsed.
  const sinceBoot = i.nowMs - i.bootMs;
  if (i.lastPollOkMs == null) {
    if (sinceBoot < cfg.bootGraceMs) return idle;
    return {
      blind: true, reason: 'never', blindForMs: sinceBoot, errorKind,
      shouldSelfHeal: shouldHeal(i, cfg, errorKind),
    };
  }

  // Had data, lost it.
  if (sincePollOk != null && sincePollOk >= cfg.staleMs) {
    return {
      blind: true, reason: 'stale', blindForMs: sincePollOk, errorKind,
      shouldSelfHeal: shouldHeal(i, cfg, errorKind),
    };
  }
  return idle;
}

function shouldHeal(i: BlindInputs, cfg: BlindConfig, kind: PollErrorKind): boolean {
  // Only auth-shaped failures. A network outage is not something a client rebuild
  // fixes, and restarting into a dead network would just add churn.
  if (kind !== 'auth') return false;
  if (i.consecutiveFailures < cfg.authFailuresBeforeHeal) return false;
  if (i.lastHealAtMs != null && i.nowMs - i.lastHealAtMs < cfg.healCooldownMs) return false;
  return true;
}

/* ─── live state, published by the poll loop ──────────────────────────────── */

let lastPollOkMs: number | null = null;
let consecutiveFailures = 0;
let lastError: string | null = null;

export function notePollOk(nowMs: number): void {
  lastPollOkMs = nowMs;
  consecutiveFailures = 0;
  lastError = null;
}
export function notePollFailed(message: string): void {
  consecutiveFailures += 1;
  lastError = message;
}
export function pollState(): { lastPollOkMs: number | null; consecutiveFailures: number; lastError: string | null } {
  return { lastPollOkMs, consecutiveFailures, lastError };
}
/** Test seam. */
export function resetPollState(): void {
  lastPollOkMs = null; consecutiveFailures = 0; lastError = null;
}

/* ─── the alert ───────────────────────────────────────────────────────────── */

export const TELEMETRY_BLIND_ALERT_ID = 'telemetry-blind';

/**
 * CRITICAL, deliberately. Every other alert in this system describes something the
 * add-on can SEE. This one says the add-on cannot see anything — which means every
 * other alarm is silently unable to fire. It is the one condition where a quiet
 * system is the most dangerous system.
 */
export function telemetryBlindAlerts(v: BlindVerdict, nowMs: number): Alert[] {
  if (!v.blind) return [];
  const mins = Math.max(1, Math.round(v.blindForMs / 60_000));
  const authHint = v.errorKind === 'auth'
    ? ' The cloud is reachable and REJECTING our requests, which on this hardware is almost always a clock problem: '
      + 'EcoFlow signs each request with a timestamp, the Pi has no battery-backed clock, and after a power cut it '
      + 'boots with the wrong time until NTP syncs. Check the host clock first, not the credentials.'
    : v.errorKind === 'network'
      ? ' The EcoFlow cloud is unreachable (DNS or network). Check the router and the Pi\'s DNS.'
      : '';
  const reasonText = v.reason === 'never'
    ? `has NEVER received telemetry since it started ${mins} minute${mins === 1 ? '' : 's'} ago`
    : `has received no telemetry for ${mins} minute${mins === 1 ? '' : 's'}`;
  return [{
    id: TELEMETRY_BLIND_ALERT_ID,
    severity: 'critical' as const,
    category: 'Connectivity' as const,
    device: 'Power add-on',
    priority: 'critical' as const,
    title: 'Alarm system is blind — no telemetry',
    detail:
      `The Power add-on ${reasonText}, so it currently cannot see battery state, grid presence or any device fault. `
      + `Every other alarm in this system depends on that data, so they cannot fire while this is true — a quiet `
      + `system right now does NOT mean a safe one.${authHint}`,
    facts: [
      { label: 'Blind for', value: `${mins} min` },
      { label: 'Cause', value: v.errorKind === 'auth' ? 'cloud rejecting our requests (check host clock)' : v.errorKind === 'network' ? 'cloud unreachable' : 'unknown' },
      { label: 'Since', value: new Date(nowMs - v.blindForMs).toISOString() },
    ],
  }];
}
