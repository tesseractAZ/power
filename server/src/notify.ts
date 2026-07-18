import { request } from 'undici';
import type { Severity } from './alerts.js';
import type { NightChargePlan } from './nightChargeAdvisor.js';

/**
 * Notification dispatch. Supports ntfy (default — free, no account), Pushover,
 * and a generic JSON webhook. Channel + credentials come from env.
 */

export type NotifyChannel = 'ntfy' | 'pushover' | 'webhook' | 'ha' | 'none';

export interface NotifyConfig {
  channel: NotifyChannel;
  minSeverity: Severity;        // 'warning' = warning+critical; 'critical' = critical only
  notifyResolved: boolean;      // also send when an alert clears
  ntfyServer: string;
  ntfyTopic: string;
  pushoverToken: string;
  pushoverUser: string;
  webhookUrl: string;
}

export function loadNotifyConfig(): NotifyConfig {
  const sev = (process.env.NOTIFY_MIN_SEVERITY ?? 'warning').toLowerCase();
  return {
    channel: (process.env.NOTIFY_CHANNEL ?? 'none').toLowerCase() as NotifyChannel,
    minSeverity: sev === 'critical' ? 'critical' : 'warning',
    notifyResolved: process.env.NOTIFY_RESOLVED !== '0',
    ntfyServer: process.env.NOTIFY_NTFY_SERVER ?? 'https://ntfy.sh',
    ntfyTopic: process.env.NOTIFY_NTFY_TOPIC ?? '',
    pushoverToken: process.env.NOTIFY_PUSHOVER_TOKEN ?? '',
    pushoverUser: process.env.NOTIFY_PUSHOVER_USER ?? '',
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL ?? '',
  };
}

export interface NotifyMessage {
  title: string;
  body: string;
  severity: Severity | 'resolved';
  /**
   * v0.74.0 — stable per-subject identity for channels that collapse/replace
   * notifications in place (currently the HA persistent-notification card).
   * When supplied, the HA channel keys `notification_id` on THIS instead of the
   * severity, so two distinct subjects (e.g. "Pack nearly empty" on three
   * different packs) get three distinct cards rather than overwriting one
   * another, and a "Resolved:" send updates the SAME card it fired on. Omit it
   * (digest, channel-less callers) and the legacy per-severity id still applies.
   */
  dedupId?: string;
}

/** True if the channel is configured well enough to actually send. */
export function isConfigured(cfg: NotifyConfig): boolean {
  switch (cfg.channel) {
    case 'ntfy':
      return !!cfg.ntfyTopic;
    case 'pushover':
      return !!cfg.pushoverToken && !!cfg.pushoverUser;
    case 'webhook':
      return !!cfg.webhookUrl;
    // v0.15.18 — 'ha' posts a Home Assistant persistent notification through
    // the Supervisor proxy. Zero external accounts; visible in the HA UI and
    // mirrored to the companion app. Needs only the supervised environment.
    case 'ha':
      return !!process.env.SUPERVISOR_TOKEN;
    default:
      return false;
  }
}

const NTFY_PRIORITY: Record<NotifyMessage['severity'], string> = {
  critical: '5',
  warning: '4',
  info: '3',
  resolved: '2',
};
const NTFY_TAGS: Record<NotifyMessage['severity'], string> = {
  critical: 'rotating_light',
  warning: 'warning',
  info: 'information_source',
  resolved: 'white_check_mark',
};
const PUSHOVER_PRIORITY: Record<NotifyMessage['severity'], number> = {
  critical: 1,
  warning: 0,
  info: -1,
  resolved: -1,
};

/**
 * v0.74.0 — derive the HA persistent-notification `notification_id`. With a
 * per-subject `dedupId` (e.g. an alert id that embeds the device SN), distinct
 * subjects get distinct cards and a "Resolved:" reuses the fire-side id to
 * update the same card. Without one, falls back to the legacy per-severity id
 * (so all callers that don't supply a dedupId — the morning digest — keep their
 * previous single-card behaviour). The id is always reduced to HA's safe slug
 * charset ([a-z0-9_]) and length-capped, so an arbitrary alert id can't produce
 * an invalid notification_id. Pure + exported for tests.
 */
/**
 * v1.1.0 — decide what the HA persistent-notification channel should actually DO.
 *
 * The drawer must show ACTIVE conditions. Previously a "Resolved:" send re-`create`d the
 * same card, so a cleared condition sat in HA's notification section forever until the
 * operator dismissed it by hand — observed live:
 *   `ecoflow_panel_baseline_pair6_w_...` → "EcoFlow · Resolved: West Air conditioner load
 *    unusual for the hour … (condition cleared)"
 * A drawer full of resolved cards is worse than useless on an alarm system: it trains the
 * operator to ignore it. The resolve RECORD already lives in the app's cleared-anomalies log.
 *
 * So: a resolve DISMISSES the card it fired on. That is only safe when we can identify that
 * card, i.e. when a `dedupId` was supplied — `haNotificationId` slugs the dedupId and ignores
 * severity, so the fire-side and resolve-side ids are identical. Without a dedupId the fire
 * used a per-severity id we can no longer reconstruct from `'resolved'`, so we keep the old
 * create-a-card behaviour rather than guess and dismiss the wrong one.
 *
 * Pure + exported for tests.
 */
export function haNotifyCall(msg: NotifyMessage): { service: 'create' | 'dismiss'; notificationId: string } {
  const notificationId = haNotificationId(msg.dedupId, msg.severity);
  const service = msg.severity === 'resolved' && msg.dedupId ? 'dismiss' : 'create';
  return { service, notificationId };
}

export function haNotificationId(dedupId: string | undefined, severity: NotifyMessage['severity']): string {
  if (!dedupId) return `ecoflow_panel_${severity}`;
  const slug = dedupId
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  // An all-symbol dedupId could slug to empty — fall back to severity then so we
  // never emit a bare `ecoflow_panel_` (which would re-collapse everything).
  return `ecoflow_panel_${slug || severity}`;
}

export async function sendNotification(cfg: NotifyConfig, msg: NotifyMessage): Promise<void> {
  if (cfg.channel === 'none') return;

  if (cfg.channel === 'ntfy') {
    if (!cfg.ntfyTopic) throw new Error('ntfy topic not set');
    const url = `${cfg.ntfyServer.replace(/\/$/, '')}/${cfg.ntfyTopic}`;
    const res = await request(url, {
      method: 'POST',
      headers: {
        Title: msg.title,
        Priority: NTFY_PRIORITY[msg.severity],
        Tags: NTFY_TAGS[msg.severity],
      },
      body: msg.body,
    });
    if (res.statusCode >= 300) {
      throw new Error(`ntfy returned HTTP ${res.statusCode}`);
    }
    return;
  }

  if (cfg.channel === 'pushover') {
    if (!cfg.pushoverToken || !cfg.pushoverUser) throw new Error('Pushover token/user not set');
    const form = new URLSearchParams({
      token: cfg.pushoverToken,
      user: cfg.pushoverUser,
      title: msg.title,
      message: msg.body,
      priority: String(PUSHOVER_PRIORITY[msg.severity]),
    });
    const res = await request('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (res.statusCode >= 300) {
      throw new Error(`Pushover returned HTTP ${res.statusCode}`);
    }
    return;
  }

  if (cfg.channel === 'webhook') {
    if (!cfg.webhookUrl) throw new Error('Webhook URL not set');
    const res = await request(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: msg.title, body: msg.body, severity: msg.severity, ts: Date.now() }),
    });
    if (res.statusCode >= 300) {
      throw new Error(`Webhook returned HTTP ${res.statusCode}`);
    }
    return;
  }

  if (cfg.channel === 'ha') {
    // v0.15.18 — persistent_notification.create via the Supervisor's Core API
    // proxy. A stable notification_id means repeated sends update in place
    // instead of stacking unbounded cards in the HA UI.
    // v0.74.0 — prefer a caller-supplied per-subject id (msg.dedupId) so that
    // distinct subjects no longer collapse into one severity-keyed card and a
    // "Resolved:" updates the card it fired on. Falls back to the legacy
    // per-severity id when no dedupId is given (digest, etc.). The id is fixed
    // to a safe HA slug ([a-z0-9_]) regardless of what the alert id contains.
    // v1.1.0 — a "Resolved:" now DISMISSES the card it fired on instead of re-creating it,
    // so HA's notification drawer shows ACTIVE conditions only (see haNotifyCall).
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) throw new Error('SUPERVISOR_TOKEN not set (not running supervised)');
    const { service, notificationId } = haNotifyCall(msg);
    const body = service === 'dismiss'
      ? { notification_id: notificationId }
      : { title: msg.title, message: msg.body, notification_id: notificationId };
    const res = await request(`http://supervisor/core/api/services/persistent_notification/${service}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.statusCode >= 300) {
      throw new Error(`HA persistent_notification.${service} returned HTTP ${res.statusCode}`);
    }
    return;
  }
}

/**
 * v1.38.0 — build the ~21:30 night-charge advisory notification (design §4.2).
 *
 * Three shapes, ALL severity 'info' and ALL dedupId 'night_charge_plan' so the
 * message lands in ONE updating HA card (a nightly stack of cards would train the
 * operator to ignore it). This is dispatched via a DIRECT sendNotification()
 * (design §4.2 / I10) so it bypasses NOTIFY_QUIET_HOURS + minSeverity — a plan
 * pushed after charging should begin is worse than none, so it must not sit in a
 * quiet-hours queue.
 *
 *   • charge  — a buy IS recommended tonight. The body states the buy kWh, the
 *               target pool SoC %, tomorrow's projected low SoC WITHOUT vs WITH
 *               the buy, the floor+cushion line, the confidence tier, and the
 *               ADVISORY-ONLY automation contract (the add-on never charges; wire
 *               your HA automation to charge_tonight gated on write-ready+window).
 *   • hold    — no charge needed; the projected trough already clears floor+cushion.
 *   • insufficient_basis — no plan tonight (basis incomplete). Sending this makes
 *               the ABSENCE explicit so the owner never wonders if the job died.
 *
 * ★ SAFETY: this is a READ-ONLY advisory. The message NEVER implies the add-on
 *   will act, and it NEVER fabricates a number — a null plan or a null field
 *   renders as an em-dash and (for a null/insufficient plan) the insufficient
 *   shape, never a guessed cushion the owner might trust. Pure + null-safe.
 */
export function buildNightChargeMessage(
  plan: NightChargePlan | null,
  shape: 'charge' | 'hold' | 'insufficient_basis',
): NotifyMessage {
  const base = { severity: 'info' as const, dedupId: 'night_charge_plan' };

  // A null plan can only ever be "insufficient basis" — never a fabricated
  // charge/hold — regardless of the shape the caller asked for.
  if (shape === 'insufficient_basis' || !plan) {
    return {
      ...base,
      title: 'Night-charge: no plan tonight',
      body:
        'No overnight charge plan tonight — the forecast/telemetry basis is incomplete, '
        + 'so nothing will be charged. (This confirms the evening job ran; the reserve '
        + 'floor is unchanged.)',
    };
  }

  const pct = (n: number | null): string => (n == null ? '—' : `${round1(n)}%`);
  const kwh = (n: number | null): string => (n == null ? '—' : `${round1(n)} kWh`);
  const floorCushion = round1(plan.reserveFloorPct + plan.cushionPct);

  if (shape === 'hold') {
    return {
      ...base,
      title: 'Night-charge: hold (no charge needed)',
      body:
        `No overnight charge needed — the projected overnight low SoC `
        + `(${pct(plan.minProjSocPct ?? plan.baselineMinSocPct)}) stays at or above the `
        + `${floorCushion}% floor+cushion. Nothing will be charged.`,
    };
  }

  // shape === 'charge'
  const shortfallNote = plan.cushionShortfall
    ? ' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.'
    : '';
  const overBuyNote = plan.bindingCap === 'overBuy'
    ? ' NOTE: the buy exceeds tomorrow morning’s PV headroom; a small clip is accepted to hold resilience.'
    : '';
  return {
    ...base,
    title: `Night-charge: buy ~${kwh(plan.buyKwh)} tonight`,
    body:
      `Buy ~${kwh(plan.buyKwh)} of grid energy overnight → target ${pct(plan.targetSocPct)} pool SoC. `
      + `Without it, tomorrow’s projected low SoC falls to ~${pct(plan.baselineMinSocPct)}; `
      + `with it, ~${pct(plan.minProjSocPct)} (the floor+cushion line is ${floorCushion}%). `
      + `Confidence: ${plan.confidenceTier}.${shortfallNote}${overBuyNote} `
      + 'Advisory only — the add-on will NOT charge. Wire your HA automation to the '
      + 'night_charge_recommended (charge_tonight) entity, gated on night_charge_write_ready '
      + 'and the night_charge_window_start/_end sensors.',
  };
}

/** One-decimal rounding for the human-facing advisory strings. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
