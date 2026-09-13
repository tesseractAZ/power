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
  /** v1.154.0 — what the most recent failure was, when it was an alarm-path panel verdict. */
  lastFailure?: PollFailure | null;
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
  /** v1.154.0 — the panel verdict behind the most recent failure, or null. */
  failure: PollFailure | null;
}

export function assessBlind(i: BlindInputs, cfg: BlindConfig = DEFAULT_BLIND_CONFIG): BlindVerdict {
  const errorKind = classifyPollError(i.lastError);
  const idle: BlindVerdict = { blind: false, reason: null, blindForMs: 0, errorKind, shouldSelfHeal: false, failure: null };

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
      blind: true, reason: 'never', blindForMs: sinceBoot, errorKind, failure: i.lastFailure ?? null,
      shouldSelfHeal: shouldHeal(i, cfg, errorKind),
    };
  }

  // Had data, lost it.
  if (sincePollOk != null && sincePollOk >= cfg.staleMs) {
    return {
      blind: true, reason: 'stale', blindForMs: sincePollOk, errorKind, failure: i.lastFailure ?? null,
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
let lastFailure: PollFailure | null = null;

/**
 * v1.154.0 — the alarm-path panel verdicts that route through `notePollFailed`.
 * Declared here rather than imported from snapshot.ts, which imports this module.
 */
export type PollFailureCause = 'shp2-fetch-failed' | 'shp2-not-polled' | 'shp2-content-frozen';
export interface PollFailure { cause: PollFailureCause; sns: string[] }

export function notePollOk(nowMs: number): void {
  lastPollOkMs = nowMs;
  consecutiveFailures = 0;
  lastError = null;
  lastFailure = null;
}
export function notePollFailed(message: string, failure: PollFailure | null = null): void {
  consecutiveFailures += 1;
  lastError = message;
  // Bound to THIS failure, exactly like `lastError`. A thrown poll passes no
  // failure and so clears it: carrying a panel verdict forward from an earlier
  // tick would let a total outage be described as one stale panel.
  lastFailure = failure;
}
/**
 * v1.140.0 — the poll-health verdict, recorded so it can be AUDITED.
 *
 * S1 (a cloud-offline SHP2 counting as a healthy poll) was fixed on code reading
 * alone: the detector shipped five weeks after the last confirmed SHP2-dark
 * window, and the verdict was never stored anywhere, so no amount of history
 * could show whether it had actually manifested. That is a poor position to
 * argue a life-safety fix from.
 *
 * The value already exists — pollHealthVerdict computes it every 60 s. Recording
 * it puts months of HA recorder history behind the NEXT dark window, and lets
 * the v1.138.0/v1.140.0 fixes' own firing be checked rather than assumed.
 */
let lastPollHealth: { ok: boolean; reason: string | null } = { ok: true, reason: null };
export function notePollHealth(ok: boolean, reason: string | null): void {
  lastPollHealth = { ok, reason };
}
export function pollHealth(): { ok: boolean; reason: string | null } {
  return lastPollHealth;
}

export function pollState(): { lastPollOkMs: number | null; consecutiveFailures: number; lastError: string | null; lastFailure: PollFailure | null } {
  return { lastPollOkMs, consecutiveFailures, lastError, lastFailure };
}

/* ─── the alert ───────────────────────────────────────────────────────────── */

export const TELEMETRY_BLIND_ALERT_ID = 'telemetry-blind';

/**
 * CRITICAL, deliberately. Every other alert in this system describes something the
 * add-on can SEE. This one says the add-on cannot see anything — which means every
 * other alarm is silently unable to fire. It is the one condition where a quiet
 * system is the most dangerous system.
 */
/**
 * v1.154.0 — THE PANEL VARIANT. Since v1.148.0 a replayed SHP2 payload has routed
 * into this alert (pollHealthVerdict → notePollFailed), as a failed and a
 * never-asked panel fetch already did. All three rendered the
 * text written for the 2026-08-04 outage: the add-on "has received no telemetry"
 * and "cannot see battery state, grid presence or any device fault". With the
 * Cores still streaming that was false, it was spoken aloud, and the Cause fact
 * read "unknown" although the verdict naming the cause had just been computed.
 *
 * The panel wording is used only when the failure IS a panel verdict AND at least
 * one other device is still current. With nothing else reporting, the original
 * text is the accurate one and is kept. Severity, id and priority are identical
 * in both branches, so escalation and audibility do not change.
 */
const PANEL_FAILURE_TEXT: Record<PollFailureCause, { title: string; clause: string; grid: string; cause: string }> = {
  'shp2-content-frozen': {
    title: 'Panel data is stale — grid presence unknown',
    clause: "the fetch succeeds, but the EcoFlow cloud is replaying a stale copy of the panel's data",
    grid: 'Grid presence from the panel is being treated as UNKNOWN.',
    cause: 'cloud replaying a stale copy of the panel',
  },
  'shp2-fetch-failed': {
    title: 'Panel is not answering — grid presence unconfirmed',
    clause: 'fetching the panel is failing',
    grid: 'Grid presence cannot be confirmed from the panel.',
    cause: 'panel fetch failing',
  },
  'shp2-not-polled': {
    title: 'Panel is offline to the cloud — grid presence unconfirmed',
    clause: 'the EcoFlow cloud reports the panel offline, so it is not being polled',
    grid: 'Grid presence cannot be confirmed from the panel.',
    cause: 'cloud reports the panel offline',
  },
};

export interface BlindAlertContext {
  /** Display names of the SNs the failure names. */
  affectedNames: string[];
  /** Devices other than those whose telemetry is still current. */
  otherReportingCount: number;
}

/**
 * v1.154.0 — who the failure names and who is still reporting. PURE.
 *
 * "Current" means a quota write within `staleMs` from an online device, using the
 * quota clock where one exists: a bare online/offline flip bumps `lastUpdated`
 * without carrying any telemetry.
 */
export function blindAlertContext(
  devices: Record<string, {
    deviceName?: string;
    online?: boolean;
    lastUpdated?: number;
    lastQuotaAtMs?: number | null;
    projection?: { kind?: string } | null;
  } | undefined>,
  failure: PollFailure | null,
  nowMs: number,
  staleMs: number = DEFAULT_BLIND_CONFIG.staleMs,
): BlindAlertContext {
  const affected = new Set(failure?.sns ?? []);
  const affectedNames = [...affected].map((sn) => devices[sn]?.deviceName ?? sn);
  let otherReportingCount = 0;
  for (const [sn, d] of Object.entries(devices)) {
    if (!d || affected.has(sn)) continue;
    const kind = d.projection?.kind;
    if (kind !== 'dpu' && kind !== 'shp2') continue;
    if (d.online === false) continue;
    const at = d.lastQuotaAtMs ?? d.lastUpdated ?? 0;
    if (at > 0 && nowMs - at < staleMs) otherReportingCount++;
  }
  return { affectedNames, otherReportingCount };
}

export function telemetryBlindAlerts(v: BlindVerdict, nowMs: number, ctx?: BlindAlertContext): Alert[] {
  if (!v.blind) return [];
  const mins = Math.max(1, Math.round(v.blindForMs / 60_000));
  const panel = v.failure != null && ctx != null && ctx.otherReportingCount > 0
    ? PANEL_FAILURE_TEXT[v.failure.cause]
    : null;
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
  const others = ctx?.otherReportingCount ?? 0;
  const panelName = ctx?.affectedNames.length ? ctx.affectedNames.join(', ') : 'the Smart Home Panel';
  return [{
    id: TELEMETRY_BLIND_ALERT_ID,
    severity: 'critical' as const,
    category: 'Connectivity' as const,
    device: 'Power add-on',
    priority: 'critical' as const,
    title: panel ? panel.title : 'Alarm system is blind — no telemetry',
    detail: panel
      ? `The alarm path has had no current data from ${panelName} for ${mins} minute${mins === 1 ? '' : 's'}: `
        + `${panel.clause}. ${panel.grid} Its other readings, including the backup reserve level, are not current either. `
        + `${others} other device${others === 1 ? ' is' : 's are'} still reporting, so this is not a total loss of `
        + `telemetry — but no alarm that depends on the panel can be trusted while this is true.`
      : `The Power add-on ${reasonText}, so it currently cannot see battery state, grid presence or any device fault. `
        + `Every other alarm in this system depends on that data, so they cannot fire while this is true — a quiet `
        + `system right now does NOT mean a safe one.${authHint}`,
    facts: [
      { label: panel ? 'No current panel data for' : 'Blind for', value: `${mins} min` },
      {
        label: 'Cause',
        value: v.failure != null
          ? PANEL_FAILURE_TEXT[v.failure.cause].cause
          : v.errorKind === 'auth' ? 'cloud rejecting our requests (check host clock)' : v.errorKind === 'network' ? 'cloud unreachable' : 'unknown',
      },
      ...(panel ? [{ label: 'Other devices reporting', value: String(others) }] : []),
      { label: 'Since', value: new Date(nowMs - v.blindForMs).toISOString() },
    ],
  }];
}
