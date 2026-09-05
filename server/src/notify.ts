import { request } from 'undici';
import { callHaService } from './haService.js';
import type { Severity } from './alerts.js';
import type { NightChargePlan } from './nightChargeAdvisor.js';

/**
 * v1.120.0 — NOTIFY HTTP BUDGETS.
 *
 * Every request in this module was issued with no headersTimeout / bodyTimeout,
 * so undici's 300 s defaults applied (300 s headers + 300 s body). That matters
 * because sendNotification is awaited INLINE inside alertMonitor's evaluateInner,
 * which is serialised behind a re-entrancy latch on a 20 s tick: one wedged
 * Supervisor->Core proxy request therefore stalls ALL alarm evaluation — battery,
 * reserve floor, grid loss — for up to five minutes per hung notification, and
 * several notifications can be dispatched in a single cycle. haService.ts was
 * capped across v0.9.57 / v0.23.0 / v0.73.0; this module has its own `request`
 * import and was missed by that sweep.
 *
 * A notification that has not been accepted in 10 s is not going to be useful to
 * a life-safety alarm loop; failing fast lets the next tick re-evaluate.
 */
export const NOTIFY_HEADERS_TIMEOUT_MS = 5_000;
export const NOTIFY_BODY_TIMEOUT_MS = 10_000;


/**
 * v1.124.0 — NOTIFICATION DISPATCH IS NOW HOME-ASSISTANT-NATIVE, AND ONLY THAT.
 *
 * THE DEFECT THIS REPLACES: the live channel was 'ha', whose entire transport was
 * `persistent_notification.create` — a card in the HA notification drawer. The
 * companion app shows those cards only when you open it; it raises no OS push, no
 * lock-screen alert and no sound. There was no `mobile_app` reference anywhere in
 * this repo. Combined with in-house-only speakers and quiet hours 23-05, an owner
 * who was away or asleep received NOTHING for a critical battery, reserve-floor or
 * grid event. The add-on's own config text implied the opposite.
 *
 * The ntfy / Pushover / webhook channels existed to fill that gap and were never
 * configured (their options were present but empty). They are REMOVED rather than
 * fixed: Home Assistant already owns a notification system with a first-party app,
 * per-device targeting, and a documented Do-Not-Disturb bypass. Re-implementing a
 * second delivery stack beside it means two things to configure, two things to
 * keep alive, and a second set of credentials living in add-on options.
 *
 * So the 'ha' channel now does BOTH halves of what HA offers:
 *   1. `persistent_notification` — the durable drawer record, unchanged, still
 *      keyed by dedupId so a resolve dismisses the card it fired on.
 *   2. `notify.mobile_app_*` (or any notify service) — the ACTUAL push, with the
 *      documented critical payload so a life-safety alert can break through Do Not
 *      Disturb and the ringer switch.
 *
 * Discovered live on this system: notify.mobile_app_iphone, .mobile_app_ipad,
 * .mobile_app_ipad2, .mobile_app_erics_macbook_air, and notify.notify (all
 * registered devices at once).
 */

export type NotifyChannel = 'ha' | 'none';

export interface NotifyConfig {
  channel: NotifyChannel;
  minSeverity: Severity;        // 'warning' = warning+critical; 'critical' = critical only
  notifyResolved: boolean;      // also send when an alert clears
  /**
   * HA notify services to push to, WITHOUT the `notify.` domain prefix
   * (e.g. `mobile_app_iphone`). Empty = drawer card only, no push — which is the
   * pre-v1.124.0 behaviour and is called out as such in the config UI.
   */
  pushTargets: string[];
  /**
   * Attach the companion app's documented critical payload to CRITICAL alerts so
   * they sound through Do Not Disturb / silent mode. Warnings never get it.
   */
  criticalBypassDnd: boolean;
}

/** Accepts "notify.mobile_app_iphone, mobile_app_ipad" and normalises to service names. */
export function parsePushTargets(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((t) => t.trim().replace(/^notify\./i, ''))
    .filter((t) => /^[a-z0-9_]+$/i.test(t));
}

export function loadNotifyConfig(): NotifyConfig {
  const sev = (process.env.NOTIFY_MIN_SEVERITY ?? 'warning').toLowerCase();
  const ch = (process.env.NOTIFY_CHANNEL ?? 'none').toLowerCase();
  return {
    // v1.124.0 — anything that is not an explicit 'ha' is off. A stored value of
    // 'ntfy'/'pushover'/'webhook' from before this release therefore fails SAFE to
    // 'none' rather than silently pretending to deliver.
    channel: ch === 'ha' ? 'ha' : 'none',
    minSeverity: sev === 'critical' ? 'critical' : 'warning',
    notifyResolved: process.env.NOTIFY_RESOLVED !== '0',
    pushTargets: parsePushTargets(process.env.NOTIFY_HA_PUSH_TARGETS),
    criticalBypassDnd: process.env.NOTIFY_CRITICAL_BYPASS_DND !== '0',
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
  return cfg.channel === 'ha' && !!process.env.SUPERVISOR_TOKEN;
}

/**
 * v1.124.0 — does this configuration actually REACH A PHONE?
 *
 * `isConfigured` has always answered "can we dispatch", which for the 'ha'
 * channel was true with nothing but a supervisor token — while delivering only a
 * drawer card. That is precisely how "alerts are configured" and "alerts reach
 * nobody" became indistinguishable. This is the second question, asked
 * separately, and it is what the status route and the self-alert report.
 */
export function reachesAPhone(cfg: NotifyConfig): boolean {
  return isConfigured(cfg) && cfg.pushTargets.length > 0;
}


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

/**
 * v1.124.0 — the companion-app push payload, per the documented spec.
 *
 * ONE payload serves both platforms: iOS reads `data.push.*` and ignores the
 * Android keys, Android reads `data.ttl/priority/channel` and ignores the Apple
 * ones. That is the documented cross-platform approach, and it means we do not
 * have to know which device a target is.
 *
 * CRITICAL (life-safety) — only for severity 'critical', and only when the owner
 * has left the bypass on:
 *   iOS      data.push.sound = { name: 'default', critical: 1, volume: 1.0 }
 *            "Critical alerts always appear at the top of your lock screen above
 *            all other notifications, and play a sound even if Do Not Disturb is
 *            enabled or the iPhone is muted."
 *   Android  data.ttl = 0, data.priority = 'high', data.channel = 'alarm_stream'
 *            — alarm_stream sounds regardless of ringer mode.
 *
 * Everything below critical is an ordinary push: it must NOT wake the household.
 * That asymmetry is the whole point — a warning that behaves like an emergency
 * trains the owner to silence the channel that carries the emergencies.
 *
 * `tag`/`group` reuse the persistent-notification id so a phone notification for
 * the same subject REPLACES its predecessor instead of stacking, mirroring the
 * drawer card's dedupe. A resolve therefore lands on the same tag and supersedes
 * the alert it closes.
 *
 * Pure + exported for tests.
 */
export function buildMobilePushPayload(
  msg: NotifyMessage,
  opts: { criticalBypassDnd: boolean },
): Record<string, unknown> {
  const tag = haNotificationId(msg.dedupId, msg.severity);
  const data: Record<string, unknown> = { tag, group: 'ecoflow-panel' };

  if (msg.severity === 'critical' && opts.criticalBypassDnd) {
    // iOS
    data.push = { sound: { name: 'default', critical: 1, volume: 1.0 } };
    // Android
    data.ttl = 0;
    data.priority = 'high';
    data.channel = 'alarm_stream';
  } else if (msg.severity === 'critical') {
    // Bypass switched off by the owner: still deliver promptly, just don't
    // override Do Not Disturb.
    data.ttl = 0;
    data.priority = 'high';
  }

  return { title: msg.title, message: msg.body, data };
}

export async function sendNotification(cfg: NotifyConfig, msg: NotifyMessage): Promise<void> {
  if (cfg.channel === 'none') return;

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
      headersTimeout: NOTIFY_HEADERS_TIMEOUT_MS,
      bodyTimeout: NOTIFY_BODY_TIMEOUT_MS,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.statusCode >= 300) {
      throw new Error(`HA persistent_notification.${service} returned HTTP ${res.statusCode}`);
    }

    // v1.124.0 — SECOND HALF: the actual phone push.
    //
    // The drawer card above is a durable record; it is NOT an alert. This is the
    // part that lights a locked screen. Failures here are reported, never thrown:
    // one unreachable device must not cost the drawer record or abort the other
    // targets, and sendNotification is awaited inline inside the alarm evaluator.
    if (cfg.pushTargets.length > 0) {
      await dispatchMobilePush(
        cfg.pushTargets,
        buildMobilePushPayload(msg, { criticalBypassDnd: cfg.criticalBypassDnd }),
        (target, payload) => callHaService('notify', target, payload, {
          headersTimeoutMs: NOTIFY_HEADERS_TIMEOUT_MS,
          bodyTimeoutMs: NOTIFY_BODY_TIMEOUT_MS,
        }),
      );
    }
    return;
  }
}

/** v1.124.0 — most recent per-target push failures (partial), for the status route. */
let lastPushFailures: string[] = [];
export function getLastPushFailures(): string[] { return [...lastPushFailures]; }
/** Test seam. */
export function resetLastPushFailures(): void { lastPushFailures = []; }

/**
 * v1.131.0 — send one payload to every phone target, RECORDING BEFORE THROWING.
 *
 * The record used to be written after the all-targets-failed throw. In the live
 * single-target configuration that made it dead code: with one target, 100%
 * down is the ONLY way to fail, and that path threw first. `lastPushFailures`
 * therefore read `[]` both when the push channel was healthy and when it was
 * completely dead — and it is the only machine-readable push-health signal the
 * system exposes, surfaced on /api/notify/status beside `reachesAPhone: true`.
 *
 * The throw is still correct and deliberate: the caller's dispatch marks the
 * alert failed so the next evaluate tick retries it. Both things must happen,
 * in that order. Extracted with the service call injected so the ordering is
 * directly testable rather than asserted about the source text.
 */
export async function dispatchMobilePush(
  targets: string[],
  payload: Record<string, unknown>,
  call: (target: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; status?: number }>,
): Promise<void> {
  const failures: string[] = [];
  for (const target of targets) {
    const r = await call(target, payload);
    if (!r.ok) failures.push(`${target}: ${r.error ?? r.status}`);
  }
  lastPushFailures = failures;
  if (targets.length > 0 && failures.length === targets.length) {
    throw new Error(`HA push failed on all ${failures.length} target(s): ${failures.join('; ')}`);
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
  /** v1.50.0 — set when tonight's supervised write is ARMED: the notification
   *  then names the bounded write and its cancel deadline instead of the
   *  advisory-only tail. null/omitted = advisory posture, unchanged. */
  supervised?: { cancelDeadlineText: string; targetPct: number } | null,
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
  // v1.60.0 — EV contention. The car and the charger share one grid input, so a
  // predicted overnight session comes straight out of the buy. Two shapes, and
  // the second is deliberately a WARNING: a missing EVSE prediction must never
  // read as a reassuring "no EV expected tonight".
  const ev = plan.evContention;
  const evNote =
    plan.bindingCap === 'evContention' && ev?.windowEvKwh != null
      ? ` NOTE: EV charging is predicted inside the window (~${round1(ev.windowEvKwh)} kWh, peak ~${ev.peakEvKw ?? '—'} kW);`
        + ` it shares the grid input, leaving ~${ev.minChargeRateKw ?? '—'} kW for the packs — the buy above is what the window can actually deliver.`
      : ev?.basis === 'unavailable' && plan.cushionShortfall
        ? ' NOTE: no EVSE prediction covers this window, so EV contention is NOT modelled — if the car charges overnight the packs will receive less than planned.'
        : '';
  // v1.60.0 — the reserve we ASK for (the requirement) and the arrival we
  // EXPECT (contention-derated) are different numbers whenever a cap bites. Say
  // both, or the owner hears a promise the window cannot keep; say one when
  // they agree, rather than inventing a distinction that does not exist
  // tonight. Only "expect BELOW the ask" is worth a clause — the reverse is
  // just the [10,50] write bound, which the sentence already states.
  const expectNote =
    supervised && plan.targetSocPct != null && plan.targetSocPct < supervised.targetPct - 0.5
      ? ` The pack is only expected to reach ~${pct(plan.targetSocPct)} — the reserve is the ask, not a forecast.`
      : '';
  const tail = supervised
    ? `SUPERVISED: ${supervised.cancelDeadlineText} the add-on raises the backup reserve to `
      + `${supervised.targetPct}% (bounded write; auto-restores after the charge window closes).${expectNote} `
      + 'Cancel from the night-charge card on the panel before then.'
    : 'Advisory only — the add-on will NOT charge. Wire your HA automation to the '
      + 'night_charge_recommended (charge_tonight) entity, gated on night_charge_write_ready '
      + 'and the night_charge_window_start/_end sensors.';
  return {
    ...base,
    title: `Night-charge: buy ~${kwh(plan.buyKwh)} tonight`,
    body:
      `Buy ~${kwh(plan.buyKwh)} of grid energy overnight → target ${pct(plan.targetSocPct)} pool SoC. `
      + `Without it, tomorrow’s projected low SoC falls to ~${pct(plan.baselineMinSocPct)}; `
      + `with it, ~${pct(plan.minProjSocPct)} (the floor+cushion line is ${floorCushion}%). `
      + `Confidence: ${plan.confidenceTier}.${shortfallNote}${overBuyNote}${evNote} `
      + tail,
  };
}

/** One-decimal rounding for the human-facing advisory strings. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
