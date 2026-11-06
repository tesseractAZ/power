import { createHash } from 'node:crypto';
import { request } from 'undici';
import { callHaService } from './haService.js';
import { packSnTail, type Severity } from './alerts.js';
import { lineNotHeldOf, type NightChargePlan } from './nightChargeAdvisor.js';
// v1.187.22 — a night-charge push states what the write will do: the level it drives the pool to
// and the energy it is expected to draw. The worst case the plan is sized on is never pushed.
import {
  armedExpectedPhrase, chargeIsWindowBound, chargeLevelPct, chargeReservePct, floorCushionLinePct, fmtPhoenixDayHm,
  noChargeExpected, statedBuyKwh,
  // v1.198.0 — a plan sized on the provisional solar band says so: beside a charge's confidence
  // tier, and at the end of a sized hold.
  provisionalBandText,
} from './nightChargeAdvisor.js';
import {
  forceChargeStopPct, partialForceChargeOnFailureSlots, forceChargeFailedSlotsText, FORCE_CHARGE_LINE_REON_MAX, lineReOnTimesWords,
  lineAboveReserveWords, lineBesidePct, type ForceChargeNightOutcome, type ForceChargeSlotCore, type LineAtRisk,
  lineStartClosedWords, type ForceChargeStartClosed,
} from './nightForceCharge.js';
import { isNoChargeKwh, revertRetryText, RESERVE_WRITE_MAX_PCT, type NightChargeMode, type RevertResendOnReport, type RestoreSummaryKind } from './nightChargeActuator.js';
// R5 — the day-aware formatter's clocks (chargeText.ts), shared with the mid-day texts.
import { phxParts, phxShortClock } from './chargeText.js';

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
 * Companion-app services are named after the device, e.g. notify.mobile_app_iphone,
 * .mobile_app_ipad or .mobile_app_<device_name>; notify.notify reaches all
 * registered devices at once.
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
 *   `ecoflow_panel_baseline_pair6_w_...` → "Power · Resolved: West Air conditioner load
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
/**
 * v1.187.10 (log review 10-03, C33) — device serials do not leave the host in a phone push.
 *
 * The companion-app push (title, message and data.tag) goes through Apple's or Google's push
 * service to the phone; the drawer card and the logs stay on the host and keep full serials. Full
 * serials reached the push: the per-device telemetry-gap alert's text names "<name> (<serial>)"
 * (and a device with no display name by its serial alone), and every per-device alert id (the push
 * tag) embeds one. A serial-shaped token — 16 letters and digits, at least two of each —
 * is shown as its last PACK_SN_TAIL_CHARS characters (the pack-tail convention, packSnTail), and in
 * the tag it becomes a short stable digest, so a resolve still replaces its own alert and two
 * devices that share a tail never share a tag. Masking never drops or delays a push. Pure +
 * exported for tests.
 */
const SERIAL_TOKEN = /(?<![A-Za-z0-9])[A-Za-z0-9]{16}(?![A-Za-z0-9])/g;
function serialShaped(tok: string): boolean {
  const digits = tok.replace(/[^0-9]/g, '').length;
  return digits >= 2 && tok.length - digits >= 2;
}
export function maskDeviceSerials(text: string): string {
  return text.replace(SERIAL_TOKEN, (tok) => (tok === tok.toUpperCase() && serialShaped(tok) ? packSnTail(tok) : tok));
}
export function maskSerialsInId(id: string): string {
  return id.replace(SERIAL_TOKEN, (tok) => (serialShaped(tok)
    ? `sn${createHash('sha256').update(tok.toUpperCase()).digest('hex').slice(0, 10)}`
    : tok));
}

export function buildMobilePushPayload(
  msg: NotifyMessage,
  opts: { criticalBypassDnd: boolean },
): Record<string, unknown> {
  // v1.187.10 — the tag is derived from the serial-masked id (fire and resolve mask identically).
  const tag = haNotificationId(msg.dedupId != null ? maskSerialsInId(msg.dedupId) : undefined, msg.severity);
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

  return { title: maskDeviceSerials(msg.title), message: maskDeviceSerials(msg.body), data };
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
 *   • charge  — a buy IS recommended tonight. The body states the level the write
 *               drives the pool to and (v1.187.22) the energy it is expected to draw
 *               — never the worst case the plan is sized on, and no kWh with no
 *               expected figure — the whole-house island troughs WITHOUT vs WITH
 *               the charge, labelled as such, the floor+cushion line, the confidence
 *               tier, and the ADVISORY-ONLY automation contract (the add-on never
 *               charges; wire your HA automation to charge_tonight gated on
 *               write-ready+window) or the supervised write.
 *   • hold    — nothing is charged tonight. v1.187.22: which hold it is — the cushion
 *               already holds (the trough it was decided on, labelled as the islanded
 *               case it is), the need is under the minimum buy, the window cannot cover
 *               the cushion (the shortfall disclosed), or no window resolved.
 *   • insufficient_basis — no plan tonight (basis incomplete). Sending this makes
 *               the ABSENCE explicit so the owner never wonders if the job died.
 *
 * ★ SAFETY: this is a READ-ONLY advisory. The message NEVER implies the add-on
 *   will act, and it NEVER fabricates a number — a null plan or a null field
 *   renders as an em-dash and (for a null/insufficient plan) the insufficient
 *   shape, never a guessed cushion a reader might trust. Pure + null-safe.
 */
export function buildNightChargeMessage(
  plan: NightChargePlan | null,
  shape: 'charge' | 'hold' | 'insufficient_basis',
  /** v1.50.0 — set when tonight's supervised write is ARMED: the notification
   *  then names the bounded write and its cancel deadline instead of the
   *  advisory-only tail. null/omitted = advisory posture, unchanged. */
  supervised?: {
    cancelDeadlineText: string;
    targetPct: number;
    /** v1.167.0 — set when force-charge will ride tonight's window: the TARGET it
     *  charges to, just in time. null/omitted = reserve only. v1.200.0 — the COST force-charge only. */
    forceChargeTargetPct?: number | null;
    /** v1.200.0 — set when tonight's force-charge rides in LINE mode (forceChargeModeOf on the armed record
     *  and the live gates): the outage line it runs for, to the window close, and the panel ceiling.
     *  null/omitted = none. */
    forceChargeLine?: { askPct: number; linePct: number; panelCeilingPct: number } | null;
  } | null,
  /** v1.187.22 — set when a supervised/auto mode REFUSED to arm tonight's charge plan
   *  (armRefusalReason): the push says no write is armed, and why, instead of recommending the
   *  level and draw of a write nothing will make. null/omitted = not refused. */
  armRefused?: string | null,
  /** v1.187.22 — NIGHT_CHARGE_MODE, for the refused shape's name of the write: "the supervised
   *  write" in supervised mode, "the write" in auto. Omitted = supervised. */
  mode?: NightChargeMode,
): NotifyMessage {
  const base = { severity: 'info' as const, dedupId: 'night_charge_plan' };

  // A null plan can only ever be "insufficient basis" — never a fabricated
  // charge/hold — regardless of the shape the caller asked for.
  if (shape === 'insufficient_basis' || !plan) {
    // v1.196.0 — SAY WHAT REFUSED THE PLAN. The body was the same fixed sentence for every refusal
    // — a band-coverage miss, incoherent SoC telemetry, a climatology tier — and for a night with no
    // panel reading at all, which is no basis question. A null plan is the panel's pool readings
    // missing (recomputeNightChargePlan: no SHP2, or no capacity, SoC or reserve); a refused plan
    // names its gate (plan.basisBlockedBy). A refused plan with no reason (one issued before
    // v1.196.0) reads exactly as before.
    const reason = plan == null
      ? "the panel's pool readings (capacity, state of charge, reserve) are unavailable"
      : `the forecast/telemetry basis is incomplete${plan.basisBlockedBy ? `: ${plan.basisBlockedBy}` : ''}`;
    return {
      ...base,
      title: 'Night-charge: no plan tonight',
      body:
        `No overnight charge plan tonight — ${reason}, `
        + 'so nothing will be charged. (This confirms the evening job ran; the reserve '
        + 'floor is unchanged.)',
    };
  }

  const pct = (n: number | null): string => (n == null ? '—' : `${round1(n)}%`);
  const kwh = (n: number | null): string => (n == null ? '—' : `${round1(n)} kWh`);
  // v1.187.22 — ONE floor+cushion line on every shape: the line the plan is sized on
  // (floorCushionLinePct — the reserve floor plus the cushion as applied), not the legacy
  // reserveFloorPct + cushionPct band the charge shape used to state beside the hold's line.
  const line = floorCushionLinePct(plan);

  // v1.187.22 — a night expected to charge NOTHING (noChargeExpected: the pool is expected to stay
  // at or above the level the write drives it to) is not a charge (see the charge shape below).
  const held = noChargeExpected(plan);

  // v1.60.0 — EV contention. The car and the charger share one grid input, so a
  // predicted overnight session comes straight out of the buy. Two shapes, and
  // the second is deliberately a WARNING: a missing EVSE prediction must never
  // read as a reassuring "no EV expected tonight".
  const ev = plan.evContention;
  // v1.187.22 — no "the buy above" here: the figure above is the expected draw, and a plan
  // with none states no buy at all.
  const evNote =
    plan.bindingCap === 'evContention' && ev?.windowEvKwh != null
      ? ` NOTE: EV charging is predicted inside the window (~${round1(ev.windowEvKwh)} kWh, peak ~${ev.peakEvKw ?? '—'} kW);`
        + ` it shares the grid input, leaving ~${ev.minChargeRateKw ?? '—'} kW for the packs while the car charges.`
      : ev?.basis === 'unavailable' && sizingShortfall(plan)
        ? ' NOTE: no EVSE prediction covers this window, so EV contention is NOT modelled — if the car charges overnight the packs will receive less than planned.'
        : '';
  // v1.200.0 — keyed on the cause: the caps note only where the SIZING fell short; the envelope note
  // where the line is above the 50% the panel accepts as a reserve and the plan does not claim it — (A5) on an armed
  // night, what its own walk cannot hold (lineNotHeldOf), a carried night whose sizing fell short included.
  const shortfallNote = (sizingShortfall(plan)
    ? ' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.'
    : '') + envelopeShortfallNote(plan);

  if (shape === 'hold') {
    // v1.187.22 — SAY WHICH HOLD THIS IS, on the figure it was decided on. The body said "the
    // projected overnight low SoC (0%) stays at or above the 31% floor+cushion" on every hold:
    // that figure was the whole-house island trough (minProjSocPct), not the trough the cushion
    // test judged (cushionTroughSocPct — the pack at window close on the islanded-outage basis),
    // so it read as a 0% outcome that contradicted its own claim; and a starved hold, where the
    // window cannot cover the cushion, still said "No overnight charge needed".
    if (plan.requiredExtraKwh == null) {
      // A basis-complete plan with no sizing: no cheap window resolved tonight.
      return {
        ...base,
        title: 'Night-charge: hold (no charge window)',
        body: 'No overnight charge tonight — no cheap charge window was resolved. Nothing will be charged.',
      };
    }
    // v1.198.0 — a hold SIZED on the provisional solar band says so, as the charge shape does: the
    // sentence closes each sized hold's body. '' on the full basis (the body as before); a hold with
    // no window, above, was sized on nothing and carries no pvBandWiden.
    const provisionalHold = provisionalBandText(plan.pvBandWiden);
    if (plan.cushionShortfall) {
      return {
        ...base,
        title: 'Night-charge: no charge tonight (the window cannot cover the cushion)',
        body:
          'No overnight charge tonight — the outage cushion needs a charge, but this window cannot deliver '
          + `enough to clear the minimum buy, so nothing will be charged.${shortfallNote}${evNote}${provisionalHold}`,
      };
    }
    if (plan.requiredExtraKwh > 0) {
      return {
        ...base,
        title: 'Night-charge: hold (the need is under the minimum buy)',
        body:
          'No overnight charge tonight — the islanded worst case the plan is sized on needs only a small '
          + `top-up, under the minimum buy, so nothing will be charged.${provisionalHold}`,
      };
    }
    // The cushion holds with no charge. Its trough is an islanded projection (no grid, P90 load):
    // labelled as such — with the grid present the SHP2 holds the reserve.
    const trough = plan.cushionTroughSocPct ?? plan.minProjSocPct ?? plan.baselineMinSocPct;
    const wholeHouse = plan.cushionBasis === 'legacy-pct' || plan.cushionTroughSocPct == null;
    return {
      ...base,
      title: 'Night-charge: hold (no charge needed)',
      body:
        `No overnight charge needed — even if the grid were lost overnight, ${wholeHouse
          ? `the whole-house low would stay at ~${pct(trough)}`
          : `the pack would close the charge window at ~${pct(trough)}`}, at or above the `
        + `${pct(line)} floor+cushion line. Nothing will be charged.${provisionalHold}`,
    };
  }

  // shape === 'charge'
  // v1.187.22 — a night expected to charge NOTHING (`held`) is not a charge. Every line said
  // "charging to ~50% tonight (~0 kWh)"; it says what happens: the reserve is held as a floor
  // overnight and no charge is expected.
  const reservePct = supervised?.targetPct ?? chargeReservePct(plan);
  const reserveText = reservePct == null ? '—' : `${reservePct}%`;
  // v1.187.22 — a supervised or auto mode refused to arm tonight's write (armRefusalReason). The
  // plan's level and expected draw describe that write, and nothing will make it: the advisory
  // contract writes the reserve alone, and the add-on arms nothing. Say so, and why — for the
  // night the plan is: a charge, or the reserve held as a floor with no charge expected. In auto
  // mode it is "the write": nothing about it is supervised.
  if (!supervised && armRefused) {
    const write = mode === 'auto' ? 'the write' : 'the supervised write';
    return held
      ? {
        ...base,
        title: 'Night-charge: planned reserve hold NOT armed tonight',
        body:
          `Tonight's plan holds the backup reserve at ${reserveText} overnight as a floor, with no charge expected, but ${write} `
          + `was not armed — ${armRefused}. The add-on will not raise the reserve tonight.${shortfallNote}`,
      }
      : {
        ...base,
        title: 'Night-charge: planned charge NOT armed tonight',
        body:
          `Tonight's plan calls for a charge, but ${write} was not armed — ${armRefused}. `
          + `The add-on will not charge tonight.${shortfallNote}`,
      };
  }
  const overBuyNote = plan.bindingCap === 'overBuy'
    ? ' NOTE: the buy exceeds tomorrow morning’s PV headroom; a small clip is accepted to hold resilience.'
    : '';
  // v1.174.0 — an ECONOMIC-ONLY buy (cost mode on a night resilience needed nothing): say
  // so, or "without it … ~X%; with it, ~X%" reads as a buy that changes nothing.
  const economicNote = plan.objective === 'cost_arbitrage' && plan.requiredExtraKwh === 0
    ? ` Resilience needs no buy tonight — the pack already covers the outage cushion; this ${held ? 'write' : 'buy'} is economic (cost mode).`
    : '';
  // v1.60.0 said both the reserve ASKED for and the arrival EXPECTED ("The pack is only expected
  // to reach ~X% — the reserve is the ask, not a forecast"). v1.187.22 — that arrival was
  // targetSocPct, the islanded worst case the plan is sized on: on a reserve-only night it read
  // "charging to ~50% … ~5.1 kWh expected … only expected to reach ~27.5%", two outcomes, the
  // one called expected the sizing basis. The headline now states the expected charge, "toward"
  // the level when the window cannot get there (chargeIsWindowBound); the worst-case arrival is
  // the rationale's and the card's, labelled.
  const forceCeiling = supervised?.forceChargeTargetPct ?? null;
  const forceLine = supervised?.forceChargeLine ?? null;
  // v1.187.22 — the level the night is expected to reach (chargeLevelPct): on a force-charge night
  // with no just-in-time start expected, the reserve, not the force-charge stop it stands by for.
  const level = chargeLevelPct(plan);
  const expected = statedBuyKwh(plan);
  const levelText = level == null ? '—' : `~${round1(level)}%`;
  // v1.187.22 — "toward" when the window closes before the write reaches the level.
  const bound = chargeIsWindowBound(plan);
  const to = bound ? 'toward' : 'to';
  // v1.187.22 — the force-charge clause says WHEN it is expected to switch on (the plan's
  // expectedForceChargeStartMs, the just-in-time walk on the median load) and that it may not reach
  // the stop. It said "near the end of the window, … just long enough to reach ~80%" on every
  // night — Friday's one-hour window included, where it starts at the open (~23:00) and the pool
  // ends near 62%. Where it stops is forceChargeStopPct, the level the title states: an 80.4
  // target syncs an 80 ceiling and stops at 80.
  const forceChargeClause = (ceiling: number): string => {
    const stop = `~${pct(forceChargeStopPct(ceiling))}`;
    const startMs = plan.expectedForceChargeStartMs;
    if (held || startMs === null) {
      return `It also arms the panel's force-charge toward ${stop}, timed to finish by the window close; it is not expected to start. `;
    }
    if (startMs === undefined) {
      return 'Then, just in time to finish by the window close, it switches the panel\'s force-charge ON just long enough to '
        + `reach ${stop}, and OFF when it gets there (or when the window closes). `;
    }
    const at = fmtPhoenixDayHm(startMs, plan.generatedAt);
    return bound
      ? `Then it switches the panel's force-charge ON at ~${at} and charges toward ${stop}; the window is expected to close `
        + 'before it gets there, and force-charge switches OFF then. '
      : `Then, at ~${at}, timed to finish by the window close, it switches the panel's force-charge ON just long enough to `
        + `reach ${stop}, and OFF when it gets there (or when the window closes). `;
  };
  // v1.200.0 — a LINE night: the force-charge runs to the window close for the outage line, and the level
  // it names is the title's (chargeLevelPct: the expected close). No software stop is promised.
  const lineClause = (l: { linePct: number; panelCeilingPct: number }): string => {
    // (Fix8) The line beside the reserve (and the note's full pool) as lineBesidePct names it; a line stated at the reserve unnumbered.
    const why = `${lineAboveReserveWords(l.linePct, "for tonight's ", ' outage line')} (above the ${RESERVE_WRITE_MAX_PCT}% the panel holds as a reserve)`;
    const lineStartMs = plan.expectedForceChargeStartMs;
    if (held || lineStartMs === null) {
      // v1.200.0 (review) — armed, never switched on: nothing "on until the window closes".
      return `It also arms the panel's force-charge ${why}; it is not expected to start (the pool is expected to stay at or above the panel's ${l.panelCeilingPct}% force-charge ceiling). `;
    }
    const at = lineStartMs === undefined ? 'just in time' : `at ~${fmtPhoenixDayHm(lineStartMs, plan.generatedAt)}`;
    // v1.200.0 (review 2) — a night whose expected walk reaches the panel ceiling (plan.expectedLineCeilingStop): the
    // panel switches Charge Now off there by itself, and the add-on switches it back on under the start target before
    // the close. Never "keeps it on until the window closes", and the ceiling is no backstop there.
    const stop = plan.expectedLineCeilingStop;
    if (stop != null) {
      return `Then, ${at}, it switches the panel's force-charge ON ${why}; the panel switches it off at its ${stop.ceilingPct}% force-charge ceiling, `
        + `and the add-on switches it back on if the pool falls under ${stop.startTargetPct}% before the window closes (at most ${lineReOnTimesWords(FORCE_CHARGE_LINE_REON_MAX)}), `
        + `${levelText} expected at the close. `
        + `After the window the reserve returns to ${round1(plan.reserveFloorPct)}% and the house uses the pool as usual. `;
    }
    return `Then, ${at}, it switches the panel's force-charge ON and keeps it on until the window closes, ${why}, `
      + `taking the pool ${to} ${levelText}; the panel's ${l.panelCeilingPct}% force-charge ceiling is the backstop. `
      + `After the window the reserve returns to ${round1(plan.reserveFloorPct)}% and the house uses the pool as usual. `;
  };
  // v1.200.0 (Fix9 review 1) — a plan whose reserve reads the write (cushionEnvelopeReason 'reserveAtTarget'): none is due, so no raise and
  // no force-charge are promised, a cost ceiling armed beside it included (each rides the verified write). (Fix9 review 2) That is the
  // plan's reading: the record stands armed, with no line ask, so a reserve lowered before the apply lets the write go, and a cost
  // ceiling ride it: true whichever way it goes, and what a lowered reserve does not do is said.
  const tail = supervised && plan.cushionEnvelopeReason === 'reserveAtTarget'
    ? `SUPERVISED: the backup reserve reads ${round1(plan.reserveFloorPct)}% now, so no write is due while it does, and no force-charge runs without one. `
      + `A reading under ${supervised.targetPct}% when the window opens lets the armed write go, and it carries no force-charge for the outage line. `
      + `Cancel from the night-charge card on the panel before ${supervised.cancelDeadlineText}.`
    : supervised
    ? `SUPERVISED: ${supervised.cancelDeadlineText} the add-on raises the backup reserve to `
      + `${supervised.targetPct}% (bounded write; auto-restores after the charge window closes). `
      // v1.170.0 — one wording for every target: the 80+ coast is retired.
      + (forceLine != null ? lineClause(forceLine) : forceCeiling != null ? forceChargeClause(forceCeiling) : '')
      + 'Cancel from the night-charge card on the panel before then.'
    : 'Advisory only — the add-on will NOT charge. Wire your HA automation to the '
      + 'night_charge_recommended (charge_tonight) entity, gated on night_charge_write_ready '
      + 'and the night_charge_window_start/_end sensors.';
  // v1.187.22 — the push states what the write will do: the level it drives the pool to
  // (chargeLevelPct) and the energy it is expected to draw (statedBuyKwh); no expected figure ⇒
  // no kWh. On 2026-10-12 it said "Buy ~64.2 kWh" — the islanded worst case the plan is sized
  // on — for a write that would have drawn ≈34 kWh, and the night was cancelled on the figure.
  // The worst case stays in the rationale and the card, labelled as the sizing basis. The
  // whole-house island troughs are labelled as such: with the grid present the SHP2 holds the
  // reserve, so neither is where the pool is expected to go.
  // v1.187.22 — no EV-contention note on a night expected to charge nothing: "leaving ~2.5 kW for
  // the packs while the car charges" (or "the packs will receive less than planned") describes a
  // pack charge the night is not expected to make.
  // (Fix9 review 2) A reserve reading the write: no write to price, and the figure "with" is the sized buy, which no write is due to make.
  const lowSoc = plan.cushionEnvelopeReason === 'reserveAtTarget'
    ? `with no charge, ~${pct(plan.minProjSocPct)} with the plan's full buy`
    : `without ${held ? "tonight's write" : 'this charge'}, ~${pct(plan.minProjSocPct)} with it`;
  const projection = `Whole-house island projection (if the grid were lost): tomorrow’s low SoC ~${pct(plan.baselineMinSocPct)} `
    + `${lowSoc}; the floor+cushion line is ${pct(line)}. `
    + `Confidence: ${plan.confidenceTier}.${shortfallNote}${overBuyNote}${economicNote}${held ? '' : evNote} `;
  // v1.198.0 — a plan sized on the provisional solar band says so, after its confidence tier.
  const provisionalNote = plan.pvBandWiden != null ? `${provisionalBandText(plan.pvBandWiden).trim()} ` : '';
  if (held) {
    // Where the pool is expected to open the window, when that is at or above the reserve (the
    // reason nothing is charged); a figure under it would contradict the clause, so none is given.
    const start = plan.expectedStartSocPct;
    const stays = start != null && Number.isFinite(start) && reservePct != null && start >= reservePct
      ? ` — the pool should open the window near ~${pct(start)} and stay at or above ${reserveText}` : '';
    return {
      ...base,
      title: `Night-charge: ${supervised ? `reserve held at ${reserveText}` : `reserve hold at ${reserveText} recommended`} tonight — no charge expected`,
      body:
        `${supervised ? 'Holding' : 'Recommended: hold'} the backup reserve at ${reserveText} overnight as a floor; `
        + `no charge is expected${stays}. ${projection}${provisionalNote}${tail}`,
    };
  }
  return {
    ...base,
    title: `Night-charge: ${supervised ? `charging ${to} ${levelText}` : `charge ${to} ${levelText} recommended`} tonight`
      + (expected == null ? '' : ` (~${kwh(expected)})`),
    body:
      `${supervised ? 'Charging' : 'Recommended: charge'} the backup pool ${to} ${levelText} overnight`
      + (bound ? ', as far as the window can deliver' : '')
      + (expected == null ? '. ' : `, ~${kwh(expected)} of grid energy expected. `)
      + projection
      + provisionalNote
      + tail,
  };
}

/**
 * v1.187.22 — the morning summary of an applied night, sent when its reserve is restored. It
 * states what the night DID, from the actuation record:
 *  - the reserve: raised to its target — or, on a night expected to charge nothing
 *    (isNoChargeKwh), held there overnight as a floor;
 *  - the force-charge, when it rode the night (forceChargeNightOutcome — the arm-time stamp, not
 *    the option at the restore): it ran (a readback proved the ON), was switched ON but never
 *    confirmed, did not take effect — on every slot, or "on slot(s) 2" when the others took it
 *    (the ON-failure push's own "on those slot(s)") — or never started.
 *    armedForceChargeStopPct alone (the armed ceiling and the option) named "force-charge toward
 *    ~80%" on nights decideForceCharge never started it;
 *  - the buy: the EXPECTED figure on the armed day's plan row (armedExpectedPhrase), or none —
 *    named only beside an account of the legs it counts (ForceChargeNightOutcome.expectedLeg):
 *    reserve only with a figure that counts no force-charge leg, or a force-charge that ran with a
 *    figure that counts it. The armed record's buyKwh is the worst case the plan was sized on and
 *    is never pushed.
 * A restore that ENDED the night early — an owner cancel after the write, or a grid-loss abort —
 * is not a completed charge: it says so, with no figure. PURE.
 *
 * v1.189.0 (review) — the restore as the panel reported it (`restore`, nightChargeActuator
 * restoreSummaryDue): "restored to 16%" only once it read back ('readBack', the words before, byte
 * for byte); sent and acknowledged with no readback yet ('acknowledged'), when the summary goes at
 * the end of the restore's readback grace. It went on the cloud ACK saying "restored", and a restore
 * that then did not read back was paged critical half an hour later.
 */
export function buildNightChargeMorningSummary(o: {
  day: string | null;
  targetPct: number | null;
  restorePct: number;
  expectedKwh: number | null;
  /** What the night's force-charge did (forceChargeNightOutcome); null/omitted = reserve only. */
  forceCharge?: ForceChargeNightOutcome | null;
  /** Why the reserve came down: the window closed (default), the owner cancelled after the
   *  write, or the grid was lost (decideActuation's gridLossAbort). */
  ended?: 'window' | 'cancelled' | 'gridLoss';
  /** The restore read back (default), or was sent and acknowledged with no readback yet. */
  restore?: RestoreSummaryKind;
  /** v1.200.0 — the pool reading at the restore (a fresh, coherent one), for a LINE night's account of
   *  where it closed. (review 2) On a line night null/omitted ⇒ "the pool was not read at the close" — never
   *  silence, which read as carried; on a night with no line, never stated (v1.199.1 word for word). */
  closePoolPct?: number | null;
  /** v1.200.0 (review 2) — the outage line the night's RECORD carries (nightForceCharge.forceChargeLineNightPct):
   *  line mode, or a COST-DOMINANT night (cost mode on a record with a line ask), whose outcome carries no line of
   *  its own. null/omitted ⇒ the outcome's line, if any. */
  linePct?: number | null;
  /** v1.200.0 (Fix9 review 1) — the add-on's close as clock text while it has not passed (index.ts), else null/omitted: on a grid
   *  loss, how long Charge Now by hand can still help. */
  closeText?: string | null;
  /** v1.200.0 (Fix10 review 1) — this account goes too long after the close for `closePoolPct` to be the close's
   *  (nightForceCharge.lineCloseReadingLate): what it reads now, with no verdict on the line. */
  closeReadLate?: boolean;
  /** v1.200.0 (Fix10 review 1) — on a line night, the write was acknowledged and the panel never read it back (applyVerifiedAtMs null):
   *  it says that, never "raised" or "held". Always false or omitted on a night with no line: v1.199.1's words, word for word. */
  writeUnread?: boolean;
}): NotifyMessage {
  const base = { severity: 'info' as const, dedupId: 'night_charge_actuation' };
  const day = o.day ?? '—';
  const raised = `${o.targetPct ?? '—'}%`;
  const acked = o.restore === 'acknowledged';
  const sent = `the restore to ${o.restorePct}% was sent (the EcoFlow cloud acknowledged it), and the panel has not read it back yet`;
  const titleRestore = acked ? `reserve restore to ${o.restorePct}% sent` : `reserve restored to ${o.restorePct}%`;
  // (Fix10 review 1) The 2026-08-16 phantom write on a line night: the failure push said the reserve never moved.
  const unread = o.writeUnread === true ? `the reserve write to ${raised} never read back` : null;
  if (o.ended === 'cancelled' || o.ended === 'gridLoss') {
    const cancelled = o.ended === 'cancelled';
    // v1.200.0 (Fix9 review 1) — a night whose record carries a line ask names the line and where the pool stands against it: on a grid
    // loss this push is the only account, and the only moment a person could still act. The reading is now's, not the close's (the
    // night stopped early): "reads", and the line named so the order shows. A night with no line: v1.199.1's words.
    const stopLine = o.linePct != null && Number.isFinite(o.linePct) ? o.linePct : null;
    const stopRead = o.closePoolPct != null && Number.isFinite(o.closePoolPct) ? round1(o.closePoolPct) : null;
    const under = stopLine != null && stopRead != null && stopRead < stopLine;
    const stopClose = stopLine == null ? '' : ` ${linePoolStandsWords(stopLine, o.closePoolPct)}`;
    const hand = stopLine != null && !cancelled && o.closeText != null && (stopRead == null || under)
      ? ` ${lineChargeNowByHandWords(o.closeText, 'once the grid is back')}` : '';
    return {
      ...base,
      title: `Night-charge: ${cancelled ? 'cancelled' : 'stopped (grid lost)'} — ${titleRestore}`,
      body:
        `Supervised night charge for ${day} ${cancelled ? 'was cancelled after the write' : 'stopped: the grid was lost during the window'}: `
        + (acked
          ? `${unread ?? `the reserve was raised to ${raised}`}; ${sent}. Nothing more is charged tonight.`
          : unread != null
            ? `${unread}; the reserve is restored to ${o.restorePct}% and nothing more is charged tonight.`
            : `the reserve, raised to ${raised}, is restored to ${o.restorePct}% and nothing more is charged tonight.`)
        + stopClose + hand,
    };
  }
  const held = isNoChargeKwh(o.expectedKwh);
  const expected = armedExpectedPhrase(o.expectedKwh);
  const fc: ForceChargeNightOutcome = o.forceCharge ?? { kind: 'none', expectedLeg: false };
  // v1.187.22 — the figure rides only an account of the legs it counts: reserve only beside a
  // figure that counts no force-charge leg, a force-charge that ran beside one that counts it.
  // Never "reserve raised to 50% (~34.9 kWh expected)" beside a figure that may count a force-charge
  // leg (a record armed before the stamp, the option off by the restore), nor "force-charge ran"
  // beside a reserve-only figure, nor beside a leg that never started, failed or never confirmed.
  const figureFits = fc.kind === 'none' ? fc.expectedLeg === false : fc.kind === 'ran' && fc.expectedLeg === true;
  const note = expected && figureFits ? ` (${expected})` : '';
  const restored = acked ? `${sent}. ` : `the reserve is restored to ${o.restorePct}%. `;
  let night: string;
  if (fc.kind === 'none' && unread != null) {
    night = `${unread}; ${restored}`;
  } else if (fc.kind === 'none') {
    night = acked
      ? `${held ? `the reserve was held at ${raised} overnight as a floor (no charge was expected)` : `reserve raised to ${raised}${note}`}; ${sent}. `
      : held
        ? `the reserve was held at ${raised} overnight as a floor (no charge was expected) and is restored to ${o.restorePct}%. `
        : `reserve raised to ${raised}${note} and restored to ${o.restorePct}%. `;
  } else {
    const reserve = unread ?? (held ? `the reserve was held at ${raised} overnight as a floor (no charge was expected)` : `reserve raised to ${raised}`);
    // v1.200.0 — a LINE night ran to the window close for its outage line (no stop to name).
    const line = 'line' in fc ? fc.line : undefined;
    const toward = line != null ? ` for the ${round1(line.linePct)}% outage line`
      : fc.stopPct != null && Number.isFinite(fc.stopPct) ? ` toward ~${round1(fc.stopPct)}%` : '';
    // v1.200.0 (review 2) — a night whose record carries a line never implies the line held when it did not: a
    // close under the line is said so, and a close that was not read is said so (silence read as carried). A night
    // with no line states no close (v1.199.1 word for word).
    const linePct = o.linePct != null && Number.isFinite(o.linePct) ? o.linePct : line?.linePct ?? null;
    const closeRead = o.closePoolPct != null && Number.isFinite(o.closePoolPct) ? o.closePoolPct : null;
    const close = linePct == null ? ''
      : closeRead == null ? '; the pool was not read at the close (no fresh panel reading)'
        // (Fix10 review 1) Too long after the close to be the close's: as it reads, with no verdict on the line, in either direction.
        : o.closeReadLate === true ? `; the pool reads ${round1(closeRead)}% now, past the window close`
          // (Fix9 review 2) As read, and the line beside it: rounded to the whole percent a close of 55.5 read "56%, under the 55.6% outage line".
          : `; the pool read ${round1(closeRead)}% at the close${closeRead < linePct - 0.05 ? `, under the ${lineBesidePct(linePct, round1(closeRead))}% outage line` : ''}`;
    // v1.187.22 — a PARTIAL failure (the other slots took the ON) is not "did not take effect":
    // the slots, as the ON-failure push named them ("will not happen on those slot(s)").
    const failedOn = fc.kind === 'failed' && fc.partialSlots != null
      ? `was switched ON but did not take effect on slot(s) ${fc.partialSlots.join(', ')} (the buy above the reserve did not happen on those slot(s))`
      : 'was switched ON but did not take effect';
    // (`note` is decided once, by figureFits: empty beside a force-charge that never started,
    // failed or never confirmed.)
    // v1.200.0 (review) — "to the window close" only when the OFF was the window's (or none came): any
    // other OFF ended it early, and the account says when and why (as the mid-day summary does).
    const early = line != null && line.offReason != null && line.offReason !== 'windowEnd';
    // v1.200.0 (review 2) — the panel's own stop ended the charge when it is the latest thing that switched Charge
    // Now off: after the last re-ON, and before any early OFF of ours. The re-ONs after it are named, and those a
    // readback check found not applied (as that check read them: Fix8 review 2). (review 3) A last re-ON that did not
    // take effect (or never reached the panel) resumed nothing: the panel's stop still ended the charge. (review 4) Every
    // re-ON at or after the stop counts, not the last alone: one that took effect (reOnAppliedAtMs, the latest such)
    // resumed the charge, whatever a later one did.
    // (review 5) So does a slot of ours seen ON again after it that no ON write of ours explains (onSeenAtMs: a re-ON
    // applied late, Charge Now switched on in the app).
    const panelAt = line?.panelOffAtMs != null && Number.isFinite(line.panelOffAtMs) ? line.panelOffAtMs : null;
    const lastReOn = line?.lastReOnAtMs != null && Number.isFinite(line.lastReOnAtMs) ? line.lastReOnAtMs : null;
    const offAt = line?.offAtMs != null && Number.isFinite(line.offAtMs) ? line.offAtMs : null;
    const reOnResumed = line?.lastReOnApplied !== false;
    const appliedAt = line?.reOnAppliedAtMs != null && Number.isFinite(line.reOnAppliedAtMs) ? line.reOnAppliedAtMs : null;
    const seenAt = line?.onSeenAtMs != null && Number.isFinite(line.onSeenAtMs) ? line.onSeenAtMs : null;
    const resumedSince = (t: number): boolean => (lastReOn != null && lastReOn >= t && reOnResumed) || (appliedAt != null && appliedAt >= t)
      || (seenAt != null && seenAt >= t);
    const panelEnded = panelAt != null && !resumedSince(panelAt) && !(early && offAt != null && offAt <= panelAt);
    // (review 5) The LAST re-ON resumed nothing (its check found every slot it switched still OFF, or it never reached the
    // panel): it was written to slots of ours reading OFF, and they read off before the close whatever an earlier re-ON
    // did — never "ran to the window close" — unless a slot of ours read ON again after it. Beside the panel's stop when
    // that stop did not end the charge (an earlier re-ON resumed it).
    const readOff = !panelEnded && !early && lastReOn != null && !reOnResumed && !(seenAt != null && seenAt >= lastReOn);
    const ranLine = panelEnded
      ? `ran${toward} until the panel's own stop switched Charge Now off at ${phxShortClock(panelAt!)}`
      : early
        ? `ran${toward} until ${offAt != null ? phxShortClock(offAt) : 'before the window close'} `
          + `(switched off: ${forceChargeOffWords(line!.offReason!)})`
        : readOff ? `ran${toward}` : `ran to the window close${toward}`;
    const reOns = line?.reOns ?? 0;
    const reOnsNotApplied = line?.reOnsNotApplied ?? 0;
    const offSlots = line?.reOnNotAppliedSlots ?? [];
    const readOffText = readOff ? `; Charge Now read off${offSlots.length > 0 ? ` on slot(s) ${offSlots.join(', ')}` : ''} before the window close` : '';
    // (review 3) "after the panel's own stop" only when that stop is on record: a re-ON also follows a slot switched off
    // in the app, or a stop the readback never caught with every slot off.
    // (Fix8 review 2) The re-ONs counted not applied are what their readback checks READ (lineReOnCheckedStamp: a slot of ours
    // still OFF under the panel's ceiling, or every one OFF), never "did not take effect": a slot read ON after a check (a re-ON
    // applied late, or Charge Now switched on in the app — the code cannot tell them apart; onSeenAtMs keeps only the latest) may
    // be that re-ON taking effect, and the count never moves after its check. True in every outcome.
    const reOnText = reOns > 0
      ? `${readOff ? ' and was' : '; Charge Now was'} switched back on ${reOns} time(s)${panelAt != null ? " after the panel's own stop" : ''}${reOnsNotApplied > 0 ? ` (slot(s) still off at the readback check after ${reOnsNotApplied} of them)` : ''}`
      : '';
    night = fc.kind === 'ran'
      ? (line != null
        ? `${reserve}, and force-charge ${ranLine}${readOffText}${reOnText}${close}${note}; ${restored}`
        : `${reserve}, and force-charge ran${toward}${close}${note}; ${restored}`)
      : `${reserve}${note}; force-charge${toward} ${fc.kind === 'neverStarted' ? 'never started'
        : fc.kind === 'failed' ? failedOn
          : 'was switched ON but the panel never confirmed it'}${close}; ${restored}`;
  }
  return {
    ...base,
    title: `Night-charge: ${titleRestore}`,
    body:
      `Supervised night charge for ${day} completed: ${night}`
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  };
}

/** v1.200.0 (Fix9 review 1) — what a person can still do by hand when no force-charge of the add-on's will: Charge Now, which rides no
 *  reserve write. "Can still lift", never "holds the line": how far it gets depends on when it goes on. Off again by the close, in the
 *  words of the push: nothing of the add-on's is left to do it. PURE. */
function lineChargeNowByHandWords(closeText: string, when = 'tonight'): string {
  return `Charge Now switched on by hand in the EcoFlow app can still lift the pool ${when}; switch it off again by ~${closeText}.`;
}

/** v1.200.0 (Fix9 review 1) — where the pool stands against the line, now: "reads", the night stopped early, and the line named so the
 *  order shows beside the reading and the reserve. PURE. */
function linePoolStandsWords(linePct: number, poolPct: number | null | undefined): string {
  const read = poolPct != null && Number.isFinite(poolPct) ? round1(poolPct) : null;
  const named = lineBesidePct(linePct, RESERVE_WRITE_MAX_PCT, read ?? RESERVE_WRITE_MAX_PCT);
  return read == null ? `The pool was not read (no fresh panel reading); the outage line is ${named}%.`
    : `The pool reads ${read}%, ${read < linePct ? 'under' : 'at or above'} the ${named}% outage line.`;
}

/** v1.200.0 (Fix10 review 1) — an OFF of the add-on's on a grid-status reading that no abort reports (nightForceCharge.lineGridOffPushDue):
 *  the one a person did not cause, in the grid-loss account's words. "Lost" is the panel's reading: grid flow may still be measured. Charge
 *  Now by hand always, whatever the pool reads now: nothing of the add-on's watches the line after this. PURE. */
export function buildLineForceChargeGridOff(o: { linePct: number; poolPct: number | null; closeText: string }): NotifyMessage {
  return {
    severity: 'warning',
    dedupId: 'night_charge_line_grid_off',
    title: 'Night-charge: the force-charge for the outage line stopped',
    body: `The panel read the grid as lost, so the add-on switched off the force-charge for tonight's ${lineBesidePct(o.linePct, RESERVE_WRITE_MAX_PCT)}% outage line; it does not start again tonight. `
      + `${linePoolStandsWords(o.linePct, o.poolPct)} ${lineChargeNowByHandWords(o.closeText, 'with the grid present')}`,
  };
}

/** v1.200.0 (Fix10 review 1) — a window no record holds, with no evening job left (chargeCycle.lineNotArmedPushDue): no missed push or
 *  close account knows such a night, and it may be one the evening told as a hold. The window by its clock: it may open tomorrow. PURE. */
export function buildLineNightNotArmed(o: { linePct: number; windowStartMs: number; windowEndMs: number; closeText: string }): NotifyMessage {
  return {
    severity: 'warning',
    dedupId: 'night_charge_line_not_armed',
    title: 'Night-charge: no write is armed for the outage line',
    body: `No reserve write is armed for the ${phxShortClock(o.windowStartMs)}–${phxShortClock(o.windowEndMs)} window, so no force-charge runs for the ${lineBesidePct(o.linePct, RESERVE_WRITE_MAX_PCT)}% outage line, `
      + `and the pool may close under the line. ${lineChargeNowByHandWords(o.closeText, 'in the window')}`,
  };
}

/** v1.200.0 (Fix9 review 1) — the reserve set by hand while a start can still come (the apply failure, an attempt never confirmed).
 *  Never "starts" and never "holds the line": the start has its other gates, and on a night whose write failed the pool drains on its
 *  normal reserve until the reading, so `startByText` (decideForceCharge's last start, the close less 20 min) is only that: a start
 *  there may close under the line (lineLatestStartMs is never later than it, and hours sooner on the year's plans). PURE. */
function lineReserveByHandWords(targetPct: number, startByText: string | null | undefined): string {
  return `To let it start, set the backup reserve to ${targetPct}% in the EcoFlow app now: the sooner the panel reads it, the more of the line a start can reach. `
    + (startByText != null ? `No force-charge starts after ~${startByText}, and one that late may close under the line. ` : '');
}

/**
 * revertDeadline — the critical push beside the spoken page (nightChargeActuator
 * decideRevertDeadline): a restore of the night's reserve write that has not read back by its
 * deadline, or by the on-peak start. `unknown` = no live reading: the words say the restore could
 * not be CONFIRMED, never that the reserve reads raised. `onPeakClock` names the on-peak start
 * ("4:00 PM"); null when the night has none on record. `onPeakDay` names its day at the deadline
 * stage when it is not the page's ("on Monday": chargeText.onPeakDayWords). PURE.
 */
export function buildNightChargeRevertDeadline(o: {
  day: string | null;
  stage: 'deadline' | 'onPeak';
  unknown: boolean;
  targetPct: number;
  restorePct: number | null;
  onPeakClock: string | null;
  /** The on-peak start's day when it is not the page's own; absent or null: the bare clock. */
  onPeakDay?: { en: string; es: string } | null;
  /** A restore of ours will still be sent (nightChargeActuator.revertRetryPending). The push says
   *  the add-on keeps retrying only then: a stuck restore whose re-issues are spent, or one the
   *  panel cannot be read for, is not re-sent, and saying otherwise tells the owner to wait. */
  retrying: boolean;
  /** v1.189.0 (review) — none is being sent and one will be once the panel reports again
   *  (nightChargeActuator.revertResendOnReport): the push says what it waits on. */
  resendOnReport?: RevertResendOnReport | null;
}): NotifyMessage {
  const to = o.restorePct != null ? `${o.restorePct}%` : 'its usual level';
  const peak = o.onPeakClock == null ? ''
    : o.stage === 'onPeak' ? ` On-peak pricing started at ${o.onPeakClock}.`
      : ` On-peak pricing starts ${o.onPeakDay != null ? `${o.onPeakDay.en} ` : ''}at ${o.onPeakClock}.`;
  const state = o.unknown
    ? `could not be confirmed: the Smart Home Panel 2 is not reporting its reserve, so the night's ${o.targetPct}% may still stand.`
    : `has not taken effect: the Smart Home Panel 2 still reads ${o.targetPct}%.`;
  return {
    severity: 'critical',
    dedupId: 'night_charge_revert_deadline',
    title: o.unknown ? 'Night-charge: reserve restore not confirmed' : 'Night-charge: reserve still raised',
    body:
      `The restore of the backup reserve to ${to} after the ${o.day ?? '—'} night charge ${state}${peak} `
      + `While the reserve stays raised the panel holds it as its floor and buys grid power to refill to it. `
      + `Set the backup reserve to ${to} in the EcoFlow app. ${revertRetryText(o.retrying, o.resendOnReport ?? null)}`,
  };
}

/**
 * v1.189.0 — the missed apply (chargeCycle.missedApplyDue): a leg of a charge cycle passed its apply
 * window (30 min after its window opens) with no write — the reason, and the reserve in force. An
 * info push, once per leg. Only a leg the overnight-only cycle never had sends it (a mid-day leg, or
 * the outage backup before one); the overnight leg keeps its own warning for a write that never took
 * effect (buildNightChargeApplyFailure). PURE.
 *   "Today's 10am–3pm charge did not start — <reason>. Nothing was written; the reserve stays at 16%."
 *
 * v1.200.0 (Fix9 review 1) — and a leg whose record carries a line ask (`linePct`), any window: a warning, since the force-charge for
 * the line rides this write. With no write issued, no reading starts it (none is adopted with no attempt on record): it says so, and
 * names what still can, Charge Now by hand. With an attempt the cloud never confirmed (`attempted`), the night has not started and a
 * reading of the target adopts the attempt: the apply failure's words, keyed on `startClosed` as they are.
 */
export function buildNightChargeMissedApply(o: {
  day: string | null;
  role: 'backup' | 'cost';
  windowStartMs: number;
  windowEndMs: number;
  reason: string;
  /** The reserve the panel reads now; null when it is not reporting. */
  reservePct: number | null;
  nowMs: number;
  /** v1.200.0 (Fix9 review 1) — the outage line the record carries (forceChargeLineNightPct); null/omitted ⇒ the words above, word for word. */
  linePct?: number | null;
  /** The reserve the write sets (the record's targetPct). */
  targetPct?: number | null;
  /** A write was attempted and never confirmed (the record's applyAttemptedAtMs). */
  attempted?: boolean;
  /** Why no force-charge can start any more (nightForceCharge.forceChargeStartClosed), or null while one can. */
  startClosed?: ForceChargeStartClosed | null;
  /** The last start (the close less FORCE_CHARGE_MIN_RUN_MS), and the add-on's close, as clock text. */
  startByText?: string | null;
  closeText?: string | null;
}): NotifyMessage {
  const start = phxParts(o.windowStartMs);
  const sameDay = start.ymd === phxParts(o.nowMs).ymd;
  // A window opening in the evening or before dawn (the overnight backup's 12am) is tonight's.
  const when = sameDay ? (start.hour >= 18 || start.hour < 6 ? 'Tonight\'s' : 'Today\'s') : `${start.weekday}'s`;
  const what = o.role === 'backup' ? 'outage backup' : 'charge';
  const span = `${phxShortClock(o.windowStartMs)}–${phxShortClock(o.windowEndMs)}`;
  const reserve = o.reservePct != null ? `the reserve stays at ${o.reservePct}%` : 'the reserve was not changed';
  const titled = (w: string, today: boolean): string => `Charge plan: ${today ? w.toLowerCase() : w} ${what} did not start`;
  const told = (w: string): string => `${w} ${span} ${what} did not start — ${o.reason}. Nothing was written; ${reserve}.`;
  const plain: NotifyMessage = {
    severity: 'info',
    dedupId: `night_charge_missed_apply_${o.role}`,
    title: titled(when, sameDay),
    body: told(when),
  };
  if (o.linePct == null || !Number.isFinite(o.linePct)) return plain;
  // (Fix9 review 2) A restart past the close sends this late, and "tonight" would read as the coming night, whose plan is unrelated: a
  // night past its close, or past its calendar day, goes by its weekday. The weekend's Monday 00:00 window keeps sameDay all that morning.
  const pastClose = o.startClosed === 'over' || o.startClosed === 'overGuard';
  const today = sameDay && !pastClose;
  const lineWhen = today ? when : `${start.weekday}'s`;
  const named = `${today ? lineWhen.toLowerCase() : lineWhen} ${lineBesidePct(o.linePct, RESERVE_WRITE_MAX_PCT)}% outage line`;
  const closed = o.startClosed != null ? lineStartClosedWords(named, o.startClosed) : null;
  const closedSentence = closed != null ? `${closed.charAt(0).toUpperCase()}${closed.slice(1)}.` : '';
  const target = o.targetPct ?? RESERVE_WRITE_MAX_PCT;
  if (o.attempted === true) {
    const reads = o.reservePct != null ? `the panel reads ${o.reservePct}%` : 'the panel is not reporting its reserve';
    return {
      ...plain,
      severity: 'warning',
      title: 'Night-charge: the reserve write has not been confirmed',
      body: `${lineWhen} ${span} ${what} has not started: ${o.reason}, and ${reads}. `
        + (closed != null ? `${closedSentence} `
          // (Fix9 review 2) An attempt never confirmed may have landed: with no reading nothing is said of the reserve the panel holds. With
          // one, not "its normal reserve" either: a write the panel granted in part reads neither that nor the target.
          : (o.reservePct != null
            ? `Until the panel reads ${target}%, the reserve stays under ${named}, and the force-charge for the line waits on this write. `
            : `The force-charge for ${named} waits on a reading of ${target}%. `)
            + lineReserveByHandWords(target, o.startByText))
        + 'If this repeats, check the SHP2 cloud link.',
    };
  }
  // The close passed (a restart past it): nothing is left to hold, by hand or otherwise.
  const hand = o.startClosed !== 'over' && o.startClosed !== 'overGuard' && o.closeText != null ? ` ${lineChargeNowByHandWords(o.closeText)}` : '';
  return { ...plain, severity: 'warning', title: titled(lineWhen, today), body: `${told(lineWhen)} ${closedSentence}${hand}` };
}

/**
 * The info push sent when the reserve settled as someone else's (nightChargeActuator foreignStep):
 * the same value, neither the night's target nor the value it restores, on two readings five or
 * more minutes apart. Nothing more is written to the reserve for that night. PURE.
 *
 * v1.200.0 (Fix9 review 1) — on a record with a line ask, before the add-on's close, with no OFF of ours sent (`line`): a warning, since
 * the settle also ends the force-charge for the line (offReason 'foreign', or its start closed for good: foreignSettledAtMs is
 * one-way, so a reserve set back to the target restarts nothing). What can still lift the pool is Charge Now by hand.
 */
export function buildNightChargeForeignReserve(o: {
  day: string | null;
  pct: number;
  targetPct: number | null;
  restorePct: number | null;
  /** v1.200.0 (Fix9 review 1) — the line the record carries, whether a force-charge of ours is on, and the close as clock text. */
  line?: { linePct: number; started: boolean; closeText: string } | null;
}): NotifyMessage {
  const l = o.line ?? null;
  const named = l != null ? lineBesidePct(l.linePct, RESERVE_WRITE_MAX_PCT) : null;
  const lineTail = l == null ? ''
    : (l.started
      ? ` The force-charge for tonight's ${named}% outage line rode that write, so the add-on switches it off, and it does not start again, whatever the reserve reads later.`
      : ` No force-charge for tonight's ${named}% outage line starts: the reserve was set outside the add-on, and setting it back does not change that.`)
      // (Fix8) Only a line named above the reserve can the pool close under.
      + `${named! > RESERVE_WRITE_MAX_PCT ? ' The pool may close under the line.' : ''} ${lineChargeNowByHandWords(l.closeText)}`;
  return {
    severity: l != null ? 'warning' : 'info',
    dedupId: 'night_charge_actuation',
    title: `Night-charge: reserve set to ${o.pct}% outside the add-on`,
    body:
      `The backup reserve reads ${o.pct}% — not the ${o.targetPct ?? '—'}% the ${o.day ?? '—'} night charge set, nor the `
      + `${o.restorePct ?? '—'}% it would restore — on two readings five or more minutes apart. It was changed outside `
      + `the add-on (the EcoFlow app, or the panel itself), so the night charge leaves it at ${o.pct}% and writes nothing `
      + `more to it for this charge.${lineTail}`,
  };
}

/**
 * v1.200.0 (Fix9 review 1) — the account of a LINE night that closes with no restore to summarise (nightForceCharge.lineCloseAccountDue):
 * the morning's only word for a write that never applied, or a reserve someone else set. What ran, and where the pool stands against
 * the line, in the present tense: a restart across the close may send it late. PURE.
 */
export function buildLineNightCloseAccount(o: {
  day: string | null;
  linePct: number;
  cause: 'noWrite' | 'foreign';
  /** A fresh, coherent pool reading now; null/omitted ⇒ says it was not read. */
  closePoolPct: number | null;
  /** A force-charge of ours that switched on, and its OFF (the record's). */
  onAtMs?: number | null;
  offAtMs?: number | null;
  offReason?: string | null;
}): NotifyMessage {
  const read = o.closePoolPct != null && Number.isFinite(o.closePoolPct) ? round1(o.closePoolPct) : null;
  // (Fix9 review 2) Named beside the reading too: "the 55.6% outage line. The pool reads 55.6%, under the line." shows no order.
  const lineName = lineBesidePct(o.linePct, RESERVE_WRITE_MAX_PCT, read ?? RESERVE_WRITE_MAX_PCT);
  const pool = read == null ? 'The pool was not read (no fresh panel reading).'
    : `The pool reads ${read}%, ${read < o.linePct ? 'under' : 'at or above'} the line.`;
  const ran = o.onAtMs != null && Number.isFinite(o.onAtMs);
  const head = o.cause === 'noWrite' ? 'no reserve write was confirmed' : 'the reserve was set outside the add-on';
  const off = o.offAtMs != null && Number.isFinite(o.offAtMs)
    ? (o.offReason == null || o.offReason === 'windowEnd' ? 'to the window close' : `until ${phxShortClock(o.offAtMs)} (switched off: ${forceChargeOffWords(o.offReason)})`)
    : 'and was not switched off before the window close';
  return {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: ran ? 'Night-charge: the force-charge for the outage line was stopped' : 'Night-charge: no force-charge ran for the outage line',
    body: ran
      ? `Supervised night charge for ${o.day ?? '—'}: ${head}; the force-charge for the ${lineName}% outage line ran from ${phxShortClock(o.onAtMs!)} ${off}. ${pool}`
      : `Supervised night charge for ${o.day ?? '—'}: ${head}, so no force-charge ran for the ${lineName}% outage line. ${pool}`,
  };
}

/**
 * v1.187.22 — the warning sent when the reserve write never took effect (apply retries spent).
 * The charge it says will not happen is stated as the armed day's EXPECTED figure, or with no
 * figure at all — never the worst case (buildNightChargeMorningSummary); a night expected to
 * charge nothing (isNoChargeKwh) was a reserve hold, and is called one. PURE.
 */
export function buildNightChargeApplyFailure(o: {
  day: string | null;
  currentReservePct: number | null;
  targetPct: number | null;
  applyRetries: number;
  expectedKwh: number | null;
  /** v1.200.0 (review 2) — the outage line the armed record carries (nightForceCharge.forceChargeLineNightPct):
   *  the force-charge that carries it rides only a VERIFIED reserve write, so until the panel reads the target the
   *  pool keeps its normal reserve, under the line. null/omitted ⇒ a night with no line: v1.199.1's words, word for word. */
  linePct?: number | null;
  /** v1.200.0 (Fix9) — on a line night, why no force-charge can start any more (nightForceCharge.forceChargeStartClosed, as
   *  index.ts keys its log line), or null/omitted while one still can. */
  startClosed?: ForceChargeStartClosed | null;
  /** v1.200.0 (Fix9) — the last start decideForceCharge makes (the close less FORCE_CHARGE_MIN_RUN_MS), as clock text. */
  startByText?: string | null;
}): NotifyMessage {
  const expected = armedExpectedPhrase(o.expectedKwh);
  const planned = isNoChargeKwh(o.expectedKwh)
    ? 'reserve hold (no charge was expected)'
    : `charge${expected ? ` (${expected})` : ''}`;
  const line = o.linePct != null && Number.isFinite(o.linePct) ? round1(o.linePct) : null;
  // v1.200.0 (review 2) — a line night is the outage cushion, not a buy: never "no action needed". What can still carry it
  // tonight: the reserve set by hand to the night's target — decideActuation verifies a reading of the target
  // even after the apply failed, and the force-charge can then start — (Fix9) while a start can still come. (Fix9 review 1)
  // startByText is decideForceCharge's last start, the close less 20 min, never a deadline that holds the line: a start
  // there may close under it (lineReserveByHandWords). (Fix8
  // review 1) So a late apply is verified too: "has not taken effect", until the panel reads the target — never "will not happen".
  // (Fix9) Where no start can come any more (startClosed: 20 min or less to the close or past it, a cancelled night whose prior
  // cannot be restored), the force-charge never waits on this write, and nothing set in the app would start it: it says so.
  const closed = line != null && o.startClosed != null ? lineStartClosedWords('the line', o.startClosed) : null;
  const tail = line == null
    ? `Tonight's planned ${planned} will not happen; the pool stays on its normal floor. `
      + 'No action needed tonight — the grid is available as backup — but if this repeats, check the SHP2 cloud link.'
    : closed != null
    ? `Tonight's planned ${planned} has not taken effect: until the panel reads ${o.targetPct ?? RESERVE_WRITE_MAX_PCT}%, `
      + `it keeps its normal reserve, under tonight's ${line}% outage line. ${closed.charAt(0).toUpperCase()}${closed.slice(1)}. `
      + 'If this repeats, check the SHP2 cloud link.'
    : `Tonight's planned ${planned} has not taken effect: until the panel reads ${o.targetPct ?? RESERVE_WRITE_MAX_PCT}%, `
      + `it keeps its normal reserve, under tonight's ${line}% outage line, and the force-charge for the line waits on this write. `
      + `${lineReserveByHandWords(o.targetPct ?? RESERVE_WRITE_MAX_PCT, o.startByText)}If this repeats, check the SHP2 cloud link.`;
  return {
    severity: 'warning',
    dedupId: 'night_charge_apply_failure',
    // (Fix8 review 2) The title too: on a line night the ladder still verifies a late reading of the target, so "has not taken
    // effect"; a night with no line keeps v1.199.1's title.
    title: line == null ? 'Night-charge: write did not take effect' : 'Night-charge: the reserve write has not taken effect',
    body:
      `The supervised reserve write for ${o.day ?? '—'} was accepted by the EcoFlow cloud but the Smart Home Panel 2 `
      + `still reads ${o.currentReservePct ?? 'unknown'}% (target ${o.targetPct ?? '—'}%) after ${o.applyRetries} re-issues. `
      + tail,
  };
}

/**
 * v1.187.22 — the warning sent when a force-charge ON never took effect (decideForceCharge's
 * onFailed: the re-issue spent, or too close to the window end for one). It names where the
 * force-charge stops (forceChargeStopPct: "toward ~80%"), as every other surface does — it named
 * the raw ceiling ("toward 80.4%"), which the force-charge never reaches. A failure on only some of
 * our slots (partialForceChargeOnFailureSlots) says the buy "will not happen on those slot(s)". PURE.
 */
export function buildNightForceChargeOnFailure(o: {
  day: string | null;
  /** The slots still reading OFF (onFailed's slots). */
  slots: number[];
  /** Every slot of ours (the record's forceChargeSlots). */
  ourSlots: number[] | null;
  retries: number;
  noRetry: boolean;
  /** The armed ceiling (forceChargeCeilingPct). */
  ceilingPct: number | null;
  /** v1.196.0 — every slot's Core and its own settings (forceChargeSlotCores: the slots from the
   *  fresh panel readback the verify read, each Core's settings its last reported DPU projection).
   *  null/omitted ⇒ the slot numbers alone, as before. */
  cores?: ReadonlyArray<ForceChargeSlotCore> | null;
  /** v1.200.0 — on a LINE night: the outage line the force-charge was to carry (the record's
   *  forceChargeLinePct). The warning then says, in words true in every outcome, what the failure leaves the line. */
  lineLinePct?: number | null;
}): NotifyMessage {
  const partial = partialForceChargeOnFailureSlots({ forceChargeSlots: o.ourSlots, forceChargeOnFailedSlots: o.slots }) != null;
  const toward = o.ceilingPct != null && Number.isFinite(o.ceilingPct) ? ` (toward ~${round1(forceChargeStopPct(o.ceilingPct))}%)` : '';
  // v1.196.0 — each failed slot's Core, and what about it differs from the other Cores'.
  const named = forceChargeFailedSlotsText(o.slots, o.ourSlots, o.cores ?? null);
  const compare = named.differing === 0 ? ''
    : `, and compare ${named.differing === 1 ? "that Core's" : "those Cores'"} work mode and backup reserve with the other Cores' in the EcoFlow app`;
  const head = `The night-charge for ${o.day ?? '—'} switched force-charge ("Charge Now") ON, but the Smart Home Panel 2 `
    + `still reads slot(s) ${named.text} OFF after ${o.retries} re-issue(s)${o.noRetry ? ' (too close to the window end to re-issue)' : ''}. `;
  const line = o.lineLinePct != null && Number.isFinite(o.lineLinePct) ? lineBesidePct(o.lineLinePct, RESERVE_WRITE_MAX_PCT) : null;
  // (Fix8) Only where the line, as named, is above the reserve can the pool close under it: a line stated at 50.00 the reserve holds.
  const underReach = line != null && line > RESERVE_WRITE_MAX_PCT;
  // v1.200.0 (review) — a LINE night is the outage cushion, not a buy: say what the failure does to the line, and
  // what can still lift the pool — never "no action needed". The add-on's close OFF goes to these slots too. (Fix10 review 1) Never
  // "to hold the line": a start held late and an ON that does not take can leave too little of the window for that.
  // (Fix8 review 1) In words true in every outcome: the ON is still watched after this warning and a late apply is verified
  // (verifyForceChargeOn reads onVerified before its failure guard), so "has not taken effect", never "will not happen"; the
  // reserve is no floor islanded (the pool drains through it in an outage), so the add-on "adds nothing above" it, never "only
  // the reserve holds the pool"; and the other slots read ON or at the panel's ceiling (switched off by it), never "still charge".
  const lost = line == null
    ? `Tonight's buy above the ${RESERVE_WRITE_MAX_PCT}% reserve${toward} will not happen${partial ? ' on those slot(s)' : ''}; `
      + `the reserve charge is unaffected. No action needed tonight — but if this repeats, check the SHP2 cloud link${compare}.`
    : (partial
      ? `Tonight's force-charge for the ${line}% outage line has not taken effect on those slot(s)`
        + `${underReach ? ', so the pool may close the window short of the line' : ''}. `
      // (Fix8) The pool at the failure is not known here (it may read above the line): never "will close … under the line".
      : `Tonight's force-charge for the ${line}% outage line has not taken effect: unless it applies late, the add-on adds nothing `
        + `above the ${RESERVE_WRITE_MAX_PCT}% reserve${underReach ? ', and the pool may close the window under the line' : ''}. `)
      + `The reserve charge is unaffected. Charge Now switched on for slot(s) ${named.text} in the EcoFlow app can still lift the pool tonight `
      + `(the add-on switches it off at the window close); if this repeats, check the SHP2 cloud link${compare}.`;
  return {
    severity: 'warning',
    dedupId: 'night_charge_force_charge_on_failure',
    title: line == null ? 'Night-charge: force-charge did not take effect' : 'Night-charge: the outage-line force-charge has not taken effect',
    body: head + lost,
  };
}

/**
 * v1.200.0 — the push when a LINE night's force-charge cannot start for a reason other than the clock or
 * the pool (nightForceCharge.forceChargeBlockerClass: the ceiling refused or unread, Charge Now already on,
 * the grid unknown or absent, vitals red, no slot readback, no slot connected, an incoherent SoC), once per
 * blocker class a night, once it has held (nightForceCharge.lineDeclinedPushStep) — while there is still
 * time to act. `latestStartText` is the LATEST start that still reaches the line at the rate now, with no live reading
 * from the reserve at the plan rate (nightForceCharge.lineDeclinedLatestStartMs), as clock text; a later start closes
 * lower, and with none the add-on adds nothing above the 50% reserve. PURE.
 */
export function buildLineForceChargeDeclinedStart(o: {
  day: string | null; linePct: number; why: string; latestStartText: string;
}): NotifyMessage {
  const line = lineBesidePct(o.linePct, RESERVE_WRITE_MAX_PCT);
  return {
    severity: 'warning',
    dedupId: 'night_charge_line_force_charge_declined',
    // (Fix8 review 2) "yet", as the body and the log say it: decideForceCharge decides every tick, so a held start may still come.
    title: 'Night-charge: the force-charge for the outage line cannot start yet',
    // (Fix8) In words true in every outcome: the pool may already read above the line, or a person's Charge Now may be lifting it
    // (a declined cause) — never "is expected to close under the line", never "near the 50% reserve"; a line stated at 50.00 (the
    // reserve holds it) is not said to close under it. (Fix8 review 1) Nor "only the 50% reserve holds it": with the grid absent (a
    // declined cause) the pool drains through the reserve, and a person's Charge Now lifts it — the add-on adds nothing above it.
    body: `Night-charge: the force-charge for tonight's ${line}% outage line cannot start yet — ${o.why}. `
      + (line > RESERVE_WRITE_MAX_PCT
        ? `If it has not started by ~${o.latestStartText}, the pool may close under the line; if it never starts, the add-on adds nothing above the ${RESERVE_WRITE_MAX_PCT}% reserve.`
        : `If it never starts, the add-on adds nothing above the ${RESERVE_WRITE_MAX_PCT}% reserve.`),
  };
}

/**
 * v1.200.0 (review 2) — the push when a LINE night's line is at risk after its verified ON and the add-on cannot act
 * itself (nightForceCharge.lineAtRiskPushDue): once a night, while a person can still act. Where the pool is
 * against the start target (review 3: on a cost-dominant night, against ⌈L⌉ + 5 named by its margin over the line — that
 * night has no start target) and the line, when the window closes, why the add-on cannot switch Charge Now back
 * on (every cause, the cost-dominant night's included), and what to switch: slots reading OFF — switch Charge Now on (the add-on's close OFF covers them, they are
 * ours); slots reading ON while the pool is not rising — off and on again may restart the charge (the ON-reading
 * shape, unmeasured on this plant; or a load taking the grid cap). Never "No action needed". (review 4) The spent budget
 * is "after the panel's own stop" only with that stop on record (a slot switched off in the app reads the same).
 * (review 5) A handed-back re-ON whose retry the cutoff may refuse ('reOnRefused') says so, never the gates. (review 8) In
 * words true in every outcome: the cooldown refused it; where a tick can still bring the retry (reOnRetryPossible — the push
 * is held only while it is due a full tick before the cutoff, so one pushed may still come), that the add-on may try once
 * more before the re-ON's cutoff; where none can (its spacing ends at or past the cutoff), that its next try would come
 * after it; then the slots to switch on now. PURE.
 */
export function buildLineForceChargeAtRisk(o: {
  day: string | null;
  risk: Pick<LineAtRisk, 'cause' | 'offSlots' | 'onSlots' | 'poolPct' | 'refPct' | 'thresholdPct' | 'linePct' | 'reOnNotAppliedSlots' | 'panelOffAtMs' | 'reOnRetryPossible'>;
  /** When the add-on switches the force-charge off (writeWindowEndMs), as clock text. */
  closeText: string;
  /** (review 8) The re-ON's own cutoff (closeAtMs − FORCE_CHARGE_ON_RETRY_CUTOFF_MS), as clock text: no re-ON at or after it. */
  reOnCutoffText: string;
}): NotifyMessage {
  const r = o.risk;
  const line = round1(r.linePct);
  const falling = r.poolPct < r.refPct;
  // (review 3) A COST-DOMINANT night has no start target (its start is timed to its cost target): its threshold (⌈L⌉ + 5)
  // is named by its margin over the line.
  const costMode = r.cause === 'costMode';
  // (Fix8 review 1) The margin is the difference of the numbers as NAMED (each to one decimal), so they add up: a 55.55% line named
  // 55.6% under a 61% threshold is 5.4 points, never round1(61 − 55.55) = 5.5.
  const margin = `under ${round1(r.thresholdPct)}%, ${round1(round1(r.thresholdPct) - line)} points above tonight's ${line}% outage line,`;
  // (Fix8) Under the line also where the readings, as named, show it under (a 50.05% line, the pool at 50: "50.1%" beside "50%").
  const where = r.poolPct < r.linePct - 0.05 || round1(r.poolPct) < line
    ? `under tonight's ${line}% outage line and ${falling ? 'falling' : 'not rising'}`
    : costMode
      ? `${margin} and ${falling ? 'falling toward it' : 'not rising'}`
      : falling
        ? `under the ${round1(r.thresholdPct)}% start target and falling toward tonight's ${line}% outage line`
        : `under the ${round1(r.thresholdPct)}% start target and not rising; tonight's outage line is ${line}%`;
  const why = costMode
    ? "Tonight's force-charge is the cost plan's, with its own stop: the add-on does not switch Charge Now back on for the line. "
    : r.cause === 'reOnSpent'
    ? `The add-on has switched Charge Now back on ${FORCE_CHARGE_LINE_REON_MAX} times tonight${r.panelOffAtMs != null ? " after the panel's own stop" : ''}, the most it does in a night. `
    // (Fix8 review 1) "has not taken effect": a re-ON its check found not applied may still apply late (lineNightObservations).
    : r.cause === 'reOnNotApplied'
      ? `The add-on switched Charge Now back on for slot(s) ${(r.reOnNotAppliedSlots != null && r.reOnNotAppliedSlots.length > 0 ? r.reOnNotAppliedSlots : r.offSlots).join(', ')} `
        + 'and it has not taken effect; it does not try again tonight. '
      : r.cause === 'reOnHeld'
        ? 'The add-on cannot switch Charge Now back on now (it needs the grid known present, healthy host vitals and a live panel reading). '
        : r.cause === 'reOnRefused'
          ? "The add-on's last try to switch Charge Now back on was refused by its own write cooldown; " + (r.reOnRetryPossible
            ? `it may try once more before ~${o.reOnCutoffText} if the cooldown allows. `
            : `its next try would come after ~${o.reOnCutoffText}, when it no longer switches Charge Now back on. `)
          : '';
  const off = r.offSlots.length > 0
    ? `Charge Now switched on for slot(s) ${r.offSlots.join(', ')} in the EcoFlow app can still lift the pool (the add-on switches it off at the close).`
    : '';
  const on = r.onSlots.length > 0
    ? `${off !== '' ? ' ' : ''}Charge Now reads on for slot(s) ${r.onSlots.join(', ')} but the pool is not rising; `
      + 'switching it off and on again in the EcoFlow app may restart the charge.'
    : '';
  return {
    severity: 'warning',
    dedupId: 'night_charge_line_at_risk',
    title: "Night-charge: tonight's outage line is at risk",
    body: `Night-charge: the pool reads ${round1(r.poolPct)}%, ${where}; the window closes at ~${o.closeText}. ${why}${off}${on}`,
  };
}

/** v1.200.0 (review) — a force-charge OFF reason (nightForceCharge.ForceChargeOffReason) in words. PURE. */
function forceChargeOffWords(reason: string): string {
  switch (reason) {
    case 'cancelled': return 'the night was cancelled';
    case 'reverted': return 'the reserve was restored';
    case 'gridLoss': return 'the grid was lost';
    case 'disabled': return 'the force-charge was disabled by the options';
    case 'maxRun': return 'the run backstop';
    case 'target': return 'it reached its target';
    case 'onPeakGuard': return 'the on-peak guard, an hour before on-peak';
    case 'foreign': return 'the reserve was set outside the add-on';
    default: return reason;
  }
}

/** v1.200.0 — the plan's SIZING fell short (the caps note): a shortfall the envelope alone did not make. PURE. */
function sizingShortfall(plan: Pick<NightChargePlan, 'cushionShortfall' | 'cushionShortfallCause'>): boolean {
  return plan.cushionShortfall === true && plan.cushionShortfallCause !== 'envelope';
}

/** v1.200.0 — the envelope note: the line is above the 50% the panel accepts as a reserve and the plan does not
 *  claim it tonight. Nothing armed (plan.cushionShortfallCause; review: worded by plan.cushionEnvelopeReason): the
 *  backup leg, advisory mode, a reserve that reads the write. (A5) ARMED (plan.forceChargeLine): the force-charge runs — the line clause says how — and
 *  the note says what its own walk cannot hold (lineNotHeldOf, the predicate every surface words by: under the line,
 *  whatever the reason or cause; above a full pool; held without its usual margin), on a carried night whose sizing
 *  fell short too (cause null, beside the caps note). Never "no force-charge" on an armed night. '' otherwise. PURE. */
function envelopeShortfallNote(plan: Pick<NightChargePlan, 'cushionShortfallCause' | 'cushionLineSocPct' | 'cushionEnvelopeReason'
  | 'expectedWriteLevelPct' | 'forceChargeLine' | 'expectedForceChargeMode' | 'reserveFloorPct'>): string {
  // (Fix8) Beside the 50% reserve and a full pool as lineBesidePct names it (a 100.03% line is "100.03%" above a full pool, a 50.03%
  // one "50.03%" above the reserve); a line stated at the reserve unnumbered.
  const line = plan.cushionLineSocPct != null && Number.isFinite(plan.cushionLineSocPct)
    ? lineAboveReserveWords(plan.cushionLineSocPct, "tonight's ", ' outage line') : "tonight's outage line";
  if (plan.forceChargeLine != null) {
    const kind = lineNotHeldOf(plan);
    if (kind === 'closeUnder') {
      const e = plan.expectedWriteLevelPct;
      return ` NOTE: on the median load the pool is expected to close at ${e != null && Number.isFinite(e) ? `~${round1(e)}%` : 'a level'}, under ${line} — residual risk remains.`;
    }
    if (kind === 'aboveFull') return ` NOTE: ${line} is above a full pool, so no charge can hold it — residual risk remains.`;
    if (kind === 'nearFull') return ` NOTE: ${line} is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin — residual risk remains.`;
    // Armed and disclosed, but no line-mode walk to say why (a plan this build does not make): armed, not claimed.
    if (plan.cushionShortfallCause != null) {
      return ` NOTE: ${line} is above the ${RESERVE_WRITE_MAX_PCT}% the panel accepts as a reserve; its force-charge runs, but the plan does not claim the line — residual risk remains.`;
    }
    return '';
  }
  if (plan.cushionShortfallCause == null) return '';
  const why = plan.cushionEnvelopeReason === 'backupLeg' ? 'and the outage backup leg writes the reserve only'
    : plan.cushionEnvelopeReason === 'advisory' ? 'and no force-charge runs in advisory mode'
      : plan.cushionEnvelopeReason === 'reserveAtTarget' ? `and the reserve reads ${round1(plan.reserveFloorPct)}%: no write is due while it does, and no force-charge runs without one`
        : 'and no force-charge carries it to the window close';
  return ` NOTE: ${line} is above the ${RESERVE_WRITE_MAX_PCT}% the panel accepts as a reserve, ${why} — residual risk remains.`;
}

/** One-decimal rounding for the human-facing advisory strings. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
