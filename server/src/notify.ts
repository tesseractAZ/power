import { createHash } from 'node:crypto';
import { request } from 'undici';
import { callHaService } from './haService.js';
import { packSnTail, type Severity } from './alerts.js';
import type { NightChargePlan } from './nightChargeAdvisor.js';
// v1.187.22 — a night-charge push states what the write will do: the level it drives the pool to
// and the energy it is expected to draw. The worst case the plan is sized on is never pushed.
import {
  armedExpectedPhrase, chargeIsWindowBound, chargeLevelPct, chargeReservePct, floorCushionLinePct, fmtPhoenixDayHm,
  noChargeExpected, statedBuyKwh,
} from './nightChargeAdvisor.js';
import { forceChargeStopPct, partialForceChargeOnFailureSlots, type ForceChargeNightOutcome } from './nightForceCharge.js';
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
     *  charges to, just in time. null/omitted = reserve only. */
    forceChargeTargetPct?: number | null;
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
      : ev?.basis === 'unavailable' && plan.cushionShortfall
        ? ' NOTE: no EVSE prediction covers this window, so EV contention is NOT modelled — if the car charges overnight the packs will receive less than planned.'
        : '';
  const shortfallNote = plan.cushionShortfall
    ? ' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.'
    : '';

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
    if (plan.cushionShortfall) {
      return {
        ...base,
        title: 'Night-charge: no charge tonight (the window cannot cover the cushion)',
        body:
          'No overnight charge tonight — the outage cushion needs a charge, but this window cannot deliver '
          + `enough to clear the minimum buy, so nothing will be charged.${shortfallNote}${evNote}`,
      };
    }
    if (plan.requiredExtraKwh > 0) {
      return {
        ...base,
        title: 'Night-charge: hold (the need is under the minimum buy)',
        body:
          'No overnight charge tonight — the islanded worst case the plan is sized on needs only a small '
          + 'top-up, under the minimum buy, so nothing will be charged.',
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
        + `${pct(line)} floor+cushion line. Nothing will be charged.`,
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
  const tail = supervised
    ? `SUPERVISED: ${supervised.cancelDeadlineText} the add-on raises the backup reserve to `
      + `${supervised.targetPct}% (bounded write; auto-restores after the charge window closes). `
      // v1.170.0 — one wording for every target: the 80+ coast is retired.
      + (forceCeiling != null ? forceChargeClause(forceCeiling) : '')
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
  const projection = `Whole-house island projection (if the grid were lost): tomorrow’s low SoC ~${pct(plan.baselineMinSocPct)} `
    + `without ${held ? "tonight's write" : 'this charge'}, ~${pct(plan.minProjSocPct)} with it; the floor+cushion line is ${pct(line)}. `
    + `Confidence: ${plan.confidenceTier}.${shortfallNote}${overBuyNote}${economicNote}${held ? '' : evNote} `;
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
        + `no charge is expected${stays}. ${projection}${tail}`,
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
}): NotifyMessage {
  const base = { severity: 'info' as const, dedupId: 'night_charge_actuation' };
  const day = o.day ?? '—';
  const raised = `${o.targetPct ?? '—'}%`;
  const acked = o.restore === 'acknowledged';
  const sent = `the restore to ${o.restorePct}% was sent (the EcoFlow cloud acknowledged it), and the panel has not read it back yet`;
  const titleRestore = acked ? `reserve restore to ${o.restorePct}% sent` : `reserve restored to ${o.restorePct}%`;
  if (o.ended === 'cancelled' || o.ended === 'gridLoss') {
    const cancelled = o.ended === 'cancelled';
    return {
      ...base,
      title: `Night-charge: ${cancelled ? 'cancelled' : 'stopped (grid lost)'} — ${titleRestore}`,
      body:
        `Supervised night charge for ${day} ${cancelled ? 'was cancelled after the write' : 'stopped: the grid was lost during the window'}: `
        + (acked
          ? `the reserve was raised to ${raised}; ${sent}. Nothing more is charged tonight.`
          : `the reserve, raised to ${raised}, is restored to ${o.restorePct}% and nothing more is charged tonight.`),
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
  if (fc.kind === 'none') {
    night = acked
      ? `${held ? `the reserve was held at ${raised} overnight as a floor (no charge was expected)` : `reserve raised to ${raised}${note}`}; ${sent}. `
      : held
        ? `the reserve was held at ${raised} overnight as a floor (no charge was expected) and is restored to ${o.restorePct}%. `
        : `reserve raised to ${raised}${note} and restored to ${o.restorePct}%. `;
  } else {
    const reserve = held ? `the reserve was held at ${raised} overnight as a floor (no charge was expected)` : `reserve raised to ${raised}`;
    const toward = fc.stopPct != null && Number.isFinite(fc.stopPct) ? ` toward ~${round1(fc.stopPct)}%` : '';
    // v1.187.22 — a PARTIAL failure (the other slots took the ON) is not "did not take effect":
    // the slots, as the ON-failure push named them ("will not happen on those slot(s)").
    const failedOn = fc.kind === 'failed' && fc.partialSlots != null
      ? `was switched ON but did not take effect on slot(s) ${fc.partialSlots.join(', ')} (the buy above the reserve did not happen on those slot(s))`
      : 'was switched ON but did not take effect';
    // (`note` is decided once, by figureFits: empty beside a force-charge that never started,
    // failed or never confirmed.)
    night = fc.kind === 'ran'
      ? `${reserve}, and force-charge ran${toward}${note}; ${restored}`
      : `${reserve}${note}; force-charge${toward} ${fc.kind === 'neverStarted' ? 'never started'
        : fc.kind === 'failed' ? failedOn
          : 'was switched ON but the panel never confirmed it'}; ${restored}`;
  }
  return {
    ...base,
    title: `Night-charge: ${titleRestore}`,
    body:
      `Supervised night charge for ${day} completed: ${night}`
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  };
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
}): NotifyMessage {
  const start = phxParts(o.windowStartMs);
  const sameDay = start.ymd === phxParts(o.nowMs).ymd;
  // A window opening in the evening or before dawn (the overnight backup's 12am) is tonight's.
  const when = sameDay ? (start.hour >= 18 || start.hour < 6 ? 'Tonight\'s' : 'Today\'s') : `${start.weekday}'s`;
  const what = o.role === 'backup' ? 'outage backup' : 'charge';
  const span = `${phxShortClock(o.windowStartMs)}–${phxShortClock(o.windowEndMs)}`;
  const reserve = o.reservePct != null ? `the reserve stays at ${o.reservePct}%` : 'the reserve was not changed';
  return {
    severity: 'info',
    dedupId: `night_charge_missed_apply_${o.role}`,
    title: `Charge plan: ${sameDay ? when.toLowerCase() : when} ${what} did not start`,
    body: `${when} ${span} ${what} did not start — ${o.reason}. Nothing was written; ${reserve}.`,
  };
}

/**
 * The info push sent when the reserve settled as someone else's (nightChargeActuator foreignStep):
 * the same value, neither the night's target nor the value it restores, on two readings five or
 * more minutes apart. Nothing more is written to the reserve for that night. PURE.
 */
export function buildNightChargeForeignReserve(o: {
  day: string | null;
  pct: number;
  targetPct: number | null;
  restorePct: number | null;
}): NotifyMessage {
  return {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: `Night-charge: reserve set to ${o.pct}% outside the add-on`,
    body:
      `The backup reserve reads ${o.pct}% — not the ${o.targetPct ?? '—'}% the ${o.day ?? '—'} night charge set, nor the `
      + `${o.restorePct ?? '—'}% it would restore — on two readings five or more minutes apart. It was changed outside `
      + `the add-on (the EcoFlow app, or the panel itself), so the night charge leaves it at ${o.pct}% and writes nothing `
      + 'more to it for this charge.',
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
}): NotifyMessage {
  const expected = armedExpectedPhrase(o.expectedKwh);
  const planned = isNoChargeKwh(o.expectedKwh)
    ? 'reserve hold (no charge was expected)'
    : `charge${expected ? ` (${expected})` : ''}`;
  return {
    severity: 'warning',
    dedupId: 'night_charge_apply_failure',
    title: 'Night-charge: write did not take effect',
    body:
      `The supervised reserve write for ${o.day ?? '—'} was accepted by the EcoFlow cloud but the Smart Home Panel 2 `
      + `still reads ${o.currentReservePct ?? 'unknown'}% (target ${o.targetPct ?? '—'}%) after ${o.applyRetries} re-issues. `
      + `Tonight's planned ${planned} will not happen; the pool stays on its normal floor. `
      + 'No action needed tonight — the grid is available as backup — but if this repeats, check the SHP2 cloud link.',
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
}): NotifyMessage {
  const partial = partialForceChargeOnFailureSlots({ forceChargeSlots: o.ourSlots, forceChargeOnFailedSlots: o.slots }) != null;
  const toward = o.ceilingPct != null && Number.isFinite(o.ceilingPct) ? ` (toward ~${round1(forceChargeStopPct(o.ceilingPct))}%)` : '';
  return {
    severity: 'warning',
    dedupId: 'night_charge_force_charge_on_failure',
    title: 'Night-charge: force-charge did not take effect',
    body:
      `The night-charge for ${o.day ?? '—'} switched force-charge ("Charge Now") ON, but the Smart Home Panel 2 `
      + `still reads slot(s) ${o.slots.join(', ')} OFF after ${o.retries} re-issue(s)${o.noRetry ? ' (too close to the window end to re-issue)' : ''}. `
      + `Tonight's buy above the ${RESERVE_WRITE_MAX_PCT}% reserve${toward} will not happen${partial ? ' on those slot(s)' : ''}; `
      + 'the reserve charge is unaffected. No action needed tonight — but if this repeats, check the SHP2 cloud link.',
  };
}

/** One-decimal rounding for the human-facing advisory strings. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
