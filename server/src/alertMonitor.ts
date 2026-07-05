import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';
import { SnapshotStore } from './snapshot.js';
import { computeAlerts, outageAlerts, isOutageEventFamily, SEVERITY_ORDER, type Alert, type Severity } from './alerts.js';
import { broadcastHealthAlert, getBroadcastHealth } from './broadcastHealth.js';
import { SPARE_DPU_SNS, shp2ConnectedDpuSns, isExpectedOfflineSpare } from './shp2Membership.js';
import {
  computeLearnedAlerts,
  computeBaselineAlerts,
  computeForecastAlerts,
  computeCurtailmentAlerts,
  getDayForecast,
  forecastDayAlerts,
  stormPrepAlerts,
} from './analytics.js';
import { loadNotifyConfig, sendNotification, isConfigured, type NotifyConfig } from './notify.js';
// v0.9.25 — feedback-loop snapshot capture at first fire.
// v0.9.59 — also capture the real normalized LR feature vector for
// pack-level alerts (was previously reconstructed from generic snapshot
// fields at training time, which produced garbage proxies — see audit).
import { captureSnapshot, extractFeatures, captureLrFeatures } from './featureSnapshot.js';
// v0.9.59 — rollups use family keys (so a condition spread across 5 packs
// aggregates as one family for threshold purposes).
import { familyOf } from './alertOutcomes.js';
// v0.9.59 — persist telemetry events so rise/short-clear/long-active
// counts survive restarts. Without this the auto-silencing rules can
// effectively never fire on a panel that gets occasional restarts.
import { appendTelemetryEvent, readRecentTelemetry, loadFamilyMeta, upsertFamilyMeta } from './alertTelemetry.js';
import type { Recorder } from './recorder.js';
import { getAnalytics } from './analyticsClient.js';
// v0.11.0 — ISA-18.2 / IEC 62682 annunciation gate. The internal severity
// union is unchanged; priority is DERIVED from (severity, source). Disabling
// a priority on the Alert Settings page silences its notification here (the
// alert stays visible in snapshot.alerts).
import { isPriorityEnabled } from './alertSettings.js';
import { priorityOf, priorityMeta } from './alertPriority.js';
import * as haStateCache from './haStateCache.js';
import { liveGridBackstop, gridPresenceEntityId } from './gridState.js';

/**
 * Watches the fleet, attaches computed alerts to the snapshot, and pushes a
 * notification when a qualifying alert appears (rising edge) or clears.
 *
 * v0.7.5 enhancements:
 *   - **Incidents**: simultaneous related alerts (same Core, Pack, or
 *     thermal-cascade pattern) are grouped into one Incident so a
 *     cascade fires ONE notification, not five.
 *   - **Quiet hours**: low-severity alerts raised between 22-06 (configurable)
 *     are queued, then delivered as one morning digest at NOTIFY_DIGEST_HOUR.
 *     Critical alerts always go through immediately.
 *   - **Telemetry & auto-downgrade**: tracks rise count + median duration per
 *     alert ID; an info-severity alert that's raised repeatedly but clears
 *     within minutes each time gets auto-downgraded (silenced).
 */

const EVAL_INTERVAL_MS = Number(process.env.ALERT_EVAL_MS ?? 20_000);
const DEBOUNCE_MS = Number(process.env.ALERT_DEBOUNCE_MS ?? 60_000);

// v0.83.0 — system data-gap / unplanned-outage alerting. The recorder records
// telemetry blackouts (host power loss / add-on stop / MQTT stall > 15 min) into
// its gaps sidecar; these surface each recent one as a push-worthy WARNING so the
// operator is flagged when the alarm went dark and can watch the trend after a
// UPS/power fix. Defaults: alert on any recorded gap (≥ the recorder's own 15-min
// floor), keep each visible for 24 h, then it ages off (event — no resolve push).
const OUTAGE_ALERTS_ENABLED = (process.env.SYSTEM_OUTAGE_ALERT_ENABLED ?? 'true') !== 'false';
const OUTAGE_RECENT_WINDOW_MS = Math.max(0, Number(process.env.SYSTEM_OUTAGE_RECENT_WINDOW_H ?? 24)) * 3_600_000;
const OUTAGE_MIN_DURATION_MS = Math.max(0, Number(process.env.SYSTEM_OUTAGE_MIN_MINUTES ?? 15)) * 60_000;

// v0.38.0 — sustained-duration gate for the per-circuit load-anomaly family
// ("<Circuit> load unusual for the hour"). The detector already requires the
// excursion to hold for BASELINE_SUSTAINED_MS (30 min) of *history samples*
// before it emits the alert at all — but that gate is satisfied a few minutes
// into a normal AC compressor cycle (the recent real-time samples all sit on
// the same side of the off-state median), so the alert STILL surfaces here and
// then self-resolves when the compressor cycles off. Net effect (verified in a
// 58 h log): this one family fired/resolved 116× — 72% of all immediate
// notifications — as compressors cycled, burying genuinely-actionable alerts.
//
// The standard notify debounce (DEBOUNCE_MS, 60 s) is far too short to ride
// through a 4–24 min compressor cycle, so these trip the immediate "[Medium]"
// + "Resolved:" pair on every cycle. We give THIS family (only) a much longer
// fire debounce so the anomaly must PERSIST across the whole gate before the
// first push, plus a matching resolve dwell so a brief dip back to baseline
// (compressor momentarily off) doesn't emit a premature "Resolved:". A real
// stuck/faulted circuit holds well past the gate and still surfaces; a normal
// compressor cycle clears inside it and never notifies. Other alert families
// are untouched. Both windows are env-tunable, following the house pattern.
const BASELINE_LOAD_SUSTAIN_MS = Number(process.env.BASELINE_LOAD_SUSTAIN_MS ?? 8 * 60_000);
const BASELINE_LOAD_RESOLVE_DWELL_MS = Number(process.env.BASELINE_LOAD_RESOLVE_DWELL_MS ?? 8 * 60_000);

/**
 * v0.38.0 — does this alert belong to the per-circuit load-anomaly family that
 * needs the sustained-duration notify gate? Matches the learned self-baseline
 * load-circuit anomalies only (ids `baseline-ch{N}_w-{SN}` /
 * `baseline-pair{N}_w-{SN}`, all `source: 'learned'`). Thermal/SoC baselines
 * (`baseline-pack{N}_temp-…`, `baseline-mppt_*`) and every other family keep
 * the normal 60 s debounce + immediate resolve. Exported for tests.
 */
export function isSustainGatedLoadAnomaly(alert: Pick<Alert, 'id' | 'source'>): boolean {
  return alert.source === 'learned' && /^baseline-(ch\d+|pair\d+)_w-/.test(alert.id);
}

// v0.74.0 — resolve-side dwell for the per-pack low-SoC family ("Pack nearly
// empty", ids `soc-low-<sn>-<packNum>`). The FIRE side is already deduped by
// `notified`, but the RESOLVE side fires a "Resolved:" on the very first tick
// the alert is absent. When a pack's SoC sits ON the threshold it crosses back
// and forth every poll, so each absent tick emitted a fresh "Resolved:" and the
// next present tick re-fired — a 36 h log showed 22 resolves for 7 genuine
// fires across three packs. A short resolve dwell (mirroring the load-anomaly
// dwell at the falling edge) holds the entry until the SoC has been
// continuously back above threshold for SOC_RESOLVE_DWELL_MS, so a single
// boundary jitter no longer emits good-news spam. Resolve-only: it can never
// delay or suppress a FIRE, an escalation, or the audible alarm (those read the
// live snapshot on the main thread) — only the "condition cleared" push. If the
// pack dips back under threshold during the dwell the rising-edge path clears
// `clearedSince` and no spurious resolve is sent. Env-tunable, house pattern.
const SOC_RESOLVE_DWELL_MS = Number(process.env.SOC_RESOLVE_DWELL_MS ?? 3 * 60_000);

/**
 * v0.74.0 — does this alert belong to the per-pack low-SoC family that gets the
 * resolve-side dwell? Matches `soc-low-<sn>-<packNum>` only. Pure + exported for
 * tests.
 */
export function isSocResolveDwellFamily(alert: Pick<Alert, 'id'>): boolean {
  return /^soc-low-/.test(alert.id);
}

// v0.77.0 — resolve-side dwell for the per-pack cell-imbalance (vdiff) family. A
// pack whose max cell spread sits ON the warning threshold (e.g. 20 mV) crosses it
// every poll, so each absent tick emitted a premature "Resolved:" and the next
// present tick re-fired — a live v0.76 log showed Core 3 pack 4 pushing ~4× in
// 11 min, diluting the operator's sole live alarm channel (HA push). Same
// resolve-only mechanism as the soc-low family: it holds the "condition cleared"
// push until the spread has been continuously back under threshold for the dwell,
// and NEVER delays or suppresses a FIRE. Applies to both warning and critical
// vdiff (delaying a critical's good-news resolve is harmless; a flapping critical
// would be worse). Env-tunable, house pattern.
const VDIFF_RESOLVE_DWELL_MS = Number(process.env.VDIFF_RESOLVE_DWELL_MS ?? 3 * 60_000);

/**
 * v0.77.0 — does this alert belong to the per-pack cell-imbalance family that gets
 * the resolve-side dwell? Matches `vdiff-warn-<sn>-<pack>` / `vdiff-crit-<sn>-<pack>`.
 * Pure + exported for tests.
 */
export function isCellImbalanceResolveDwellFamily(alert: Pick<Alert, 'id'>): boolean {
  return /^vdiff-(warn|crit)-/.test(alert.id);
}

/**
 * v0.74.0 — a short, human-facing device locator appended to the push TITLE so
 * the SAME condition on different subjects is distinguishable at a glance
 * (three packs all titled "Pack nearly empty" used to be indistinguishable in
 * the notification list). Prefers the device name, then the Core/pack numbers.
 * Returns '' for system-wide alerts (device 'System'/'EcoFlow Cloud' with no
 * Core scope) so their titles stay clean. Pure + exported for tests.
 */
export function notifyLocator(alert: Pick<Alert, 'device' | 'coreNum' | 'packNum'>): string {
  const parts: string[] = [];
  const dev = alert.device?.trim();
  if (dev && dev !== 'System' && dev !== 'EcoFlow Cloud') {
    parts.push(dev);
  } else if (alert.coreNum != null) {
    parts.push(`Core ${alert.coreNum}`);
  }
  if (alert.packNum != null) parts.push(`pack ${alert.packNum}`);
  return parts.join(' ');
}

/**
 * v0.74.0 — stable per-subject notification identity. The alert `id` already
 * embeds the device SN (e.g. `soc-low-<sn>-<packNum>`, `dpu-err-<sn>`), so it is
 * the natural per-subject key: distinct packs get distinct ids, and a
 * "Resolved:" reuses its fire-side id so the channel updates the same card. The
 * channel slugifies it to its own safe charset. Pure + exported for tests.
 */
export function notifyDedupId(alert: Pick<Alert, 'id'>): string {
  return alert.id;
}

/**
 * v0.38.0 — the fire debounce for an alert: the long sustain window for the
 * gated load-anomaly family, else the standard debounce. Critical alerts keep
 * their 0 ms bypass (handled by the caller). Pure + exported for tests.
 */
export function notifyDebounceMsFor(alert: Pick<Alert, 'id' | 'source'>): number {
  return isSustainGatedLoadAnomaly(alert) ? BASELINE_LOAD_SUSTAIN_MS : DEBOUNCE_MS;
}

/** v0.76.0 — the rising-edge notify decision, extracted as a PURE function so the
 *  highest-stakes alarm-dispatch branch (quiet-hours queue vs immediate push vs
 *  suppress, plus escalation re-notify and the critical-breaks-quiet rule) is
 *  directly unit-testable instead of being buried in the `evaluate` closure.
 *  Returns:
 *   - 'dispatch' → push now (caller marks notified + persists),
 *   - 'queue'    → hold for the morning digest (caller sets the in-memory queued
 *                  flag but must NOT persist, so a restart re-queues it),
 *   - 'none'     → not eligible this tick.
 *  An alert is eligible if it hasn't already been notified AND isn't already
 *  queued, OR if it has ESCALATED above the severity it was last dispatched at
 *  (escalation re-notifies even after a prior push). Eligibility additionally
 *  requires the debounce to have elapsed and the severity to qualify. A qualifying
 *  alert in the quiet window queues unless it is a critical and criticals are
 *  configured to break through. */
export type AlertDispatchAction = 'dispatch' | 'queue' | 'none';
export function decideAlertDispatch(p: {
  qualifies: boolean;
  alreadyNotified: boolean;
  alreadyQueued: boolean;
  escalated: boolean;
  debounceElapsed: boolean;
  inQuiet: boolean;
  breaksThrough: boolean;
}): AlertDispatchAction {
  const eligible = (!p.alreadyNotified && !p.alreadyQueued) || p.escalated;
  if (!eligible || !p.debounceElapsed || !p.qualifies) return 'none';
  return p.inQuiet && !p.breaksThrough ? 'queue' : 'dispatch';
}

// v0.13.2 — clear-duration thresholds hoisted to module scope so the
// classification is a single pure function shared by recordClear and tests.
const SHORT_CLEAR_MS = 10 * 60 * 1000;            // resolved within 10 min = transient
const CHRONIC_NOISE_LONG_MS = 4 * 60 * 60 * 1000; // "long" = persists ≥ 4 hours

/**
 * v0.13.2 — classify a cleared alert's lifetime into the telemetry buckets.
 * Pure and exported so the short-clear accounting invariant is directly
 * testable (P1-3): a sub-debounce (<60s) flap is the MOST transient clear
 * and MUST count as a shortClear — the bug was that such clears were skipped
 * entirely (recordClear was gated on duration ≥ DEBOUNCE_MS), so the
 * short-clear fraction could never reach DEMOTE_WARN_SHORT_FRAC and
 * auto-demote could never fire.
 */
export function classifyClearDuration(durationMs: number): { shortClear: boolean; longActive: boolean } {
  return {
    shortClear: durationMs <= SHORT_CLEAR_MS,
    longActive: durationMs >= CHRONIC_NOISE_LONG_MS,
  };
}

interface TrackedAlert {
  alert: Alert;
  firstSeen: number;
  notified: boolean;
  /** v0.23.0 — severity at which this alert was last dispatched to the push
   *  channel, so a later ESCALATION (e.g. shp2-below-reserve flipping info →
   *  critical when the grid drops out at the reserve floor) re-notifies instead
   *  of being silently swallowed by an already-true `notified`. */
  notifiedSeverity?: Severity;
  /** v0.38.0 — first eval tick at which this alert went absent, for the
   *  resolve-dwell gate on the sustained load-anomaly family. The tracked
   *  entry is held (not resolved) until it has been continuously absent for
   *  BASELINE_LOAD_RESOLVE_DWELL_MS, so a compressor briefly cycling off
   *  mid-anomaly doesn't emit a premature "Resolved:". Reset to undefined if
   *  the alert reappears before the dwell elapses. */
  clearedSince?: number;
  /** v0.76.0 — true while this alert is sitting in the in-memory quiet-hours
   *  digest queue but has NOT yet been dispatched/persisted. Lets the rising-edge
   *  gate avoid re-queueing it every tick, while deliberately NOT being persisted:
   *  a restart before the 08:00 digest leaves persistedNotified WITHOUT this id,
   *  so the alert is re-evaluated and re-queued rather than silently dropped (the
   *  in-memory quietQueue does not survive a restart). Cleared once the alert is
   *  actually dispatched or the digest sends. */
  queued?: boolean;
  /** v0.80.0 — true only when a fire push for this alert was ACTUALLY delivered
   *  (dispatch succeeded, digest sent, or rehydrated from a persisted notify-state
   *  record — i.e. a real prior push). Distinct from `notified`, which boot-seeding
   *  sets true for alerts merely PRESENT at startup to suppress re-pushing them.
   *  The "Resolved:" push gates on THIS flag, so a fire that was never delivered
   *  (boot-seeded, or its send failed) can never emit a phantom all-clear — the
   *  68.9h log review found a spurious "Resolved: EcoFlow Cloud session stale"
   *  push after every daily reboot from exactly that boot-seeded path. */
  pushSent?: boolean;
}

/** A historical record of an alert that was raised and later cleared. */
export interface ClearedAlert {
  alert: Alert;
  raisedAt: number;
  clearedAt: number;
  durationMs: number;
}

/**
 * Cumulative rise/duration stats for an alert FAMILY, used by auto-downgrade.
 *
 * v0.9.59 — keyed by `familyOf(alertId)` rather than full alertId. A
 * condition that spreads across packs (e.g. "pack-hot" on packs 1/2/3)
 * now aggregates into one rollup, so the rise-count thresholds (chronic
 * noise: ≥10 rises) can actually fire instead of being spread across
 * multiple keys that each individually never hit 10. `alertId` on the
 * stats object retains an EXEMPLAR id from the most-recently-seen alert
 * — useful for the UI/API but no longer a primary key.
 */
export interface AlertActionStats {
  /** v0.9.59 — primary key. e.g. `pack-hot`, `cell-imbalance`, `mppt-hot`. */
  familyKey: string;
  /** Exemplar alertId from the most recent member of the family (back-compat field). */
  alertId: string;
  title: string;
  severity: Severity;
  category: Alert['category'];
  riseCount: number;
  medianDurationMs: number;
  longestDurationMs: number;
  shortClearsCount: number;          // resolved within 10 min — likely auto-resolve / transient
  downgradedSilenced: boolean;       // info-tier silencing (v0.7.5: rises ≥5 + short-clear ≥70%)
  /** v0.9.3 — warning→info demotion (warning rises a lot AND mostly short-clears). */
  warningDemotedToInfo: boolean;
  /** v0.9.3 — chronic-noise silencing (alert rises a lot AND user almost never clears it). */
  chronicNoiseSilenced: boolean;
  /** v0.9.3 — count of "longActive" clears: the alert stayed alive past CHRONIC_NOISE_LONG_MS (4h) before clearing, i.e. the user effectively let it persist. Drives the chronic-noise rule. (v0.13.2 — every clear is now counted in telemetry regardless of the debounce window; sub-debounce flaps land in shortClearsCount, not here.) */
  neverClearedCount: number;
  lastSeenAt: number | null;
}

/**
 * Auto-silencing rules for a family rollup, applied after its counters change.
 * Pure + exported so the boot-time replay pass and the live-event path share
 * one implementation (a panel restart must not reset silencing the persisted
 * log says should still hold) — and so the rules are unit-testable in isolation.
 * Mutates the three boolean flags on `t` in place. Critical severity is never
 * silenced or demoted: it must always push.
 */
/** v0.80.0 — ENERGY-STATE families are exempt from every auto-tune rule. The
 *  silencing/demotion rules infer "sensor noise" from fast self-clears — but for
 *  these families a fast clear IS a genuine recovery (charging resumed, load
 *  dropped), not jitter, so the rules' premise doesn't hold. The 68.9h log review
 *  caught the real cost: a genuine backup-pool-at-17% event pushed as "[Low] …
 *  (severity warning→info via auto-tune)" because boundary flapping at the 20%
 *  band had accumulated enough short-clears to demote the family. Exported for
 *  tests. Keyed by familyOf(alert.id). */
export const ENERGY_STATE_FAMILIES: ReadonlySet<string> = new Set([
  'backup-soc',        // SHP2 backup-pool SoC ladder (backup-soc-50/40/30/20/…)
  'shp2-below-reserve',
  'shp2-near-reserve',
  'soc-low',           // per-pack nearly-empty
  'forecast-runtime',  // projected runtime to reserve
]);

export function applySilencingRules(t: AlertActionStats): void {
  // v0.80.0 — energy-state families always annunciate at their true severity.
  if (ENERGY_STATE_FAMILIES.has(t.familyKey)) return;
  const DOWNGRADE_MIN_RISES = 5;                  // need ≥ 5 rises before info-tier silencing
  const DOWNGRADE_SHORT_FRAC = 0.7;               // ≥ 70% of rises clear within SHORT_CLEAR_MS
  // v0.9.3 — extended self-tuning rules
  const DEMOTE_WARN_MIN_RISES = 10;               // need ≥ 10 rises before demoting warning→info
  const DEMOTE_WARN_SHORT_FRAC = 0.8;             // ≥ 80% short-clear → demote (stricter than info silencing)
  const CHRONIC_NOISE_MIN_RISES = 10;             // need ≥ 10 rises before chronic-noise silencing
  const CHRONIC_NOISE_NEVER_CLEAR_FRAC = 0.5;     // ≥ 50% of rises stayed alive past CHRONIC_NOISE_LONG_MS without user clearing
  // v0.30.0 — pure high-volume rate guard (Rule 4). The band rules (1/2) key on
  // the *cumulative* short-clear fraction, which a handful of early slow clears
  // can drag below the 0.70/0.80 cutoff even when every recent clear is fast —
  // so a family that churn-notifies on every transient rise slips through. The
  // 7-day log showed two warning families doing exactly this: vdiff-warn
  // (short-frac 0.68, 3-min median) and dpu-pvh-err (0.63, 1.3-min median) sit
  // 0.12–0.17 below DEMOTE_WARN_SHORT_FRAC yet pushed on every rise. Demote/
  // silence regardless of clear-band when a family is unambiguously high-volume
  // AND low-persistence (it clears on its own, so it's churn, not a standing
  // condition). The 150-rise floor keeps genuinely infrequent warnings the
  // operator acts on (e.g. soc-low) well clear of the gate.
  const HI_VOLUME_MIN_RISES = 150;                // ~>100/week of replay-window rises = churn
  const HI_VOLUME_MAX_NEVER_CLEAR_FRAC = 0.2;     // ≤ 20% long-active ⇒ transient, not a standing condition

  // Rule 1 (v0.7.5): info-severity alerts that recur a lot and always clear fast → silence
  if (
    t.severity === 'info' &&
    t.riseCount >= DOWNGRADE_MIN_RISES &&
    t.shortClearsCount / t.riseCount >= DOWNGRADE_SHORT_FRAC
  ) {
    t.downgradedSilenced = true;
  }
  // Rule 2 (v0.9.3): warning-severity alerts that mostly short-clear → demote to info
  // (still surface in the UI; just stop firing notifications at warning priority).
  if (
    t.severity === 'warning' &&
    t.riseCount >= DEMOTE_WARN_MIN_RISES &&
    t.shortClearsCount / t.riseCount >= DEMOTE_WARN_SHORT_FRAC
  ) {
    t.warningDemotedToInfo = true;
  }
  // Rule 3 (v0.9.3): chronic-noise — alert persists a long time but the user
  // never actually acts on it. The condition exists but the user has accepted
  // it (e.g. a freezer with weird draw that they know about). Stop notifying
  // since they're not going to do anything; alert still shows. Applies to any
  // severity below critical (critical always notifies).
  if (
    t.severity !== 'critical' &&
    t.riseCount >= CHRONIC_NOISE_MIN_RISES &&
    t.neverClearedCount / t.riseCount >= CHRONIC_NOISE_NEVER_CLEAR_FRAC
  ) {
    t.chronicNoiseSilenced = true;
  }
  // Rule 4 (v0.30.0): high-volume churn that the band rules miss. A family
  // firing very often whose alerts almost always self-clear is transient noise
  // regardless of the exact short-clear fraction. Warning → demote to info
  // (warningDemotedToInfo → info priority, still on-screen); info → silence
  // (downgradedSilenced → skip dispatch, still on-screen). Critical never gated.
  if (
    t.severity !== 'critical' &&
    t.riseCount >= HI_VOLUME_MIN_RISES &&
    t.neverClearedCount / t.riseCount <= HI_VOLUME_MAX_NEVER_CLEAR_FRAC
  ) {
    if (t.severity === 'warning') t.warningDemotedToInfo = true;
    else t.downgradedSilenced = true;
  }
}

export interface Incident {
  id: string;
  severity: Severity;
  scope: 'pack' | 'core' | 'category' | 'system';
  coreNum: number | null;
  packNum: number | null;
  category: Alert['category'] | 'Mixed';
  title: string;
  device: string;
  alertCount: number;
  alertIds: string[];                // members
  topAlertTitle: string;             // headline alert
  detail: string;                    // formatted summary
}

const sevRank = SEVERITY_ORDER;

function qualifies(sev: Severity, min: Severity): boolean {
  return sevRank[sev] <= sevRank[min];
}

/** v0.80.0 — the more-severe of two severities. Used to guarantee a notified
 *  severity can only ever RATCHET UP: the digest re-marks queued alerts from
 *  potentially-stale queue entries, and overwriting an escalated-and-dispatched
 *  alert's critical back down to its queued warning would make the next tick
 *  read "escalated" again and emit a duplicate critical push (and, with sev now
 *  persisted, re-fire it after a restart). Exported for tests. */
export function moreSevere(a: Severity, b: Severity): Severity {
  return sevRank[a] <= sevRank[b] ? a : b;
}

/** v0.80.0 — should a "Resolved:" push go out for this cleared alert? Pure +
 *  exported so the two delivery-integrity rules from the 68.9h log review are
 *  unit-testable on the exact runtime code path:
 *  (1) gate on pushSent (a REAL delivered fire), not `notified` — boot-seeding
 *      marks alerts merely present at startup as notified, which emitted a
 *      phantom "Resolved: EcoFlow Cloud session stale" after every daily reboot;
 *  (2) qualify on the severity the fire was NOTIFIED at (fallback: current) —
 *      two real warning-tier pushes never got their all-clear because the alert
 *      had downgraded below minSeverity by clear time. A pushed fire owes its
 *      resolve regardless of what the severity reads at clear time. */
/**
 * v0.83.0 — should a NEW alert present on the monitor's FIRST evaluate() tick be
 * boot-seeded as already-`notified` (suppressing its fire push)? A pre-existing
 * alert at boot is normally seeded so a sustained CONDITION (a still-low battery)
 * isn't re-announced on every restart. BUT a system-outage EVENT is recorded
 * synchronously in createRecorder() BEFORE startAlertMonitor(), so a
 * restart-spanning outage (the Pi lost power — the case this feature exists to
 * flag) is ALWAYS present on tick 1 with firstRun===true and would be silently
 * boot-suppressed forever. An outage is an event we WANT to push after the very
 * restart it spans, so it is NOT firstRun-seeded — only a genuine persisted record
 * (`alreadyNotified`) suppresses it, which dedups it across subsequent reboots.
 * Pure + exported so the firstRun path (untestable via the private evaluate loop)
 * is unit-testable. Behaviour is IDENTICAL to the old `firstRun || alreadyNotified`
 * for every non-outage alert.
 */
export function bootSeedNotified(p: { alert: Pick<Alert, 'id'>; firstRun: boolean; alreadyNotified: boolean }): boolean {
  if (isOutageEventFamily(p.alert)) return p.alreadyNotified;
  return p.firstRun || p.alreadyNotified;
}

export function shouldSendResolve(
  t: { pushSent?: boolean; notifiedSeverity?: Severity; alert: Pick<Alert, 'id' | 'severity' | 'annunciate'> },
  notifyResolved: boolean,
  minSeverity: Severity,
): boolean {
  // v0.83.0 — a system-outage alert is an EVENT (the outage already ended when we
  // detected it); it ages off the list silently and must never emit a "Resolved:"
  // push — that would be a meaningless "the past outage recovered" a day later.
  if (isOutageEventFamily(t.alert)) return false;
  return (
    t.pushSent === true &&
    t.alert.annunciate !== false &&
    notifyResolved &&
    qualifies(t.notifiedSeverity ?? t.alert.severity, minSeverity)
  );
}

/** v0.76.0 — has this alert ESCALATED above the severity it was last ACTED ON
 *  (dispatched OR queued for the digest)? Pure + exported so the escalation-while-
 *  queued path — a held warning that becomes critical during quiet hours, which the
 *  restart-drop fix's deferred `notified` would otherwise hide — is unit-testable.
 *  An alert never acted on (notifiedSeverity undefined) cannot escalate. */
export function isAlertEscalation(
  prev: { notified: boolean; queued?: boolean; notifiedSeverity?: Severity },
  severity: Severity,
): boolean {
  return (
    (prev.notified || prev.queued === true) &&
    prev.notifiedSeverity != null &&
    sevRank[severity] < sevRank[prev.notifiedSeverity]
  );
}

/** Parse "22-06" into [22, 6]; "" / invalid → null (feature off). Exported for tests. */
export function parseQuietHours(s: string): [number, number] | null {
  const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 23) return null;
  return [start, end];
}

/** Exported for tests. */
export function inQuietWindow(now: Date, window: [number, number]): boolean {
  const h = now.getHours();
  const [start, end] = window;
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  // wrap past midnight
  return h >= start || h < end;
}

/** Cluster alerts by (Core, Pack) or by Category-on-Core thermal cascade. Exported for tests. */
export function buildIncidents(alerts: Alert[]): Incident[] {
  const byPack = new Map<string, Alert[]>();   // "core{N}.pack{M}"
  const byCore = new Map<number, Alert[]>();
  const orphans: Alert[] = [];

  for (const a of alerts) {
    if (a.coreNum != null && a.packNum != null) {
      const k = `core${a.coreNum}.pack${a.packNum}`;
      const arr = byPack.get(k) ?? [];
      arr.push(a); byPack.set(k, arr);
    } else if (a.coreNum != null) {
      const arr = byCore.get(a.coreNum) ?? [];
      arr.push(a); byCore.set(a.coreNum, arr);
    } else {
      orphans.push(a);
    }
  }

  const incidents: Incident[] = [];
  // Pack-scoped incident: 2+ alerts on the same pack
  for (const [key, arr] of byPack) {
    if (arr.length < 2) {
      // single-alert "incident" still represents but with scope=pack
      const a = arr[0];
      incidents.push({
        id: `inc-${key}`, severity: a.severity, scope: 'pack',
        coreNum: a.coreNum ?? null, packNum: a.packNum ?? null,
        category: a.category, title: a.title, device: a.device,
        alertCount: 1, alertIds: [a.id], topAlertTitle: a.title, detail: a.detail,
      });
      continue;
    }
    arr.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
    const top = arr[0];
    const cats = new Set(arr.map((a) => a.category));
    incidents.push({
      id: `inc-${key}`, severity: top.severity, scope: 'pack',
      coreNum: top.coreNum ?? null, packNum: top.packNum ?? null,
      category: cats.size === 1 ? top.category : 'Mixed',
      title: `${arr.length} concurrent alerts on Core ${top.coreNum} · Pack ${top.packNum}`,
      device: top.device,
      alertCount: arr.length, alertIds: arr.map((a) => a.id),
      topAlertTitle: top.title,
      detail: `Lead alert: ${top.title}. ${arr.length - 1} other simultaneous condition${arr.length - 1 === 1 ? '' : 's'} on the same pack — ${arr.slice(1).map((a) => a.title).join('; ')}.`,
    });
  }
  // Core-scoped incident: 2+ alerts on the same Core w/ no pack (e.g. MPPT + AC-out)
  for (const [coreNum, arr] of byCore) {
    if (arr.length < 2) {
      const a = arr[0];
      incidents.push({
        id: `inc-core${coreNum}-${a.id}`, severity: a.severity, scope: 'core',
        coreNum, packNum: null,
        category: a.category, title: a.title, device: a.device,
        alertCount: 1, alertIds: [a.id], topAlertTitle: a.title, detail: a.detail,
      });
      continue;
    }
    arr.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
    const top = arr[0];
    const cats = new Set(arr.map((a) => a.category));
    const cascadeLabel = cats.size === 1 && top.category === 'Thermal'
      ? `Thermal cascade on Core ${coreNum}`
      : `${arr.length} concurrent alerts on Core ${coreNum}`;
    incidents.push({
      id: `inc-core${coreNum}`, severity: top.severity, scope: 'core',
      coreNum, packNum: null,
      category: cats.size === 1 ? top.category : 'Mixed',
      title: cascadeLabel, device: top.device,
      alertCount: arr.length, alertIds: arr.map((a) => a.id),
      topAlertTitle: top.title,
      detail: `Lead alert: ${top.title}. ${arr.length - 1} other simultaneous condition${arr.length - 1 === 1 ? '' : 's'} on the same Core — ${arr.slice(1).map((a) => a.title).join('; ')}.`,
    });
  }
  // System-scoped: orphans (no core/pack), pass through as 1-alert incidents
  for (const a of orphans) {
    incidents.push({
      id: `inc-system-${a.id}`, severity: a.severity, scope: 'system',
      coreNum: null, packNum: null,
      category: a.category, title: a.title, device: a.device,
      alertCount: 1, alertIds: [a.id], topAlertTitle: a.title, detail: a.detail,
    });
  }
  // Sort: severity, then alert count desc
  incidents.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.alertCount - a.alertCount);
  return incidents;
}

export interface AlertMonitor {
  stop: () => void;
  getConfig: () => NotifyConfig;
  sendTest: () => Promise<void>;
  stats: () => { tracked: number; sentSinceStart: number; quietQueued: number };
  history: () => ClearedAlert[];
  incidents: () => Incident[];
  telemetry: () => AlertActionStats[];
}

/* ─── v0.15.21 — notified-state persistence across restarts ──────────────
 * The startup-seed (`notified: firstRun`) only protects alerts visible on the
 * FIRST tick. Learned/analytics alerts take ~1–2 min to warm after a boot, so
 * an alert that was active-and-notified before a restart looked like a fresh
 * rise once analytics warmed — observed Jun 12: the same "[Medium] Projected
 * battery dip below reserve" push re-sent 100 s after a restart. Persist the
 * notified set so a restart never re-pushes a still-active alert. */

/** Entries older than this are dropped at load (the event is long over). */
export const NOTIFY_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** v0.80.0 — a record for a STILL-ACTIVE notified alert is timestamp-refreshed
 *  once it is older than this, so a long-lived alert (a >25 h cloud wedge — a
 *  documented real event for this fleet) never TTL-drops its proof-of-delivery
 *  across one of this host's ~daily reboots, which would strand its "Resolved:"
 *  card. Half the TTL: at most one extra sidecar write every 12 h per alert,
 *  while records for alerts that genuinely vanished still expire at 24 h. */
export const NOTIFY_STATE_REFRESH_MS = NOTIFY_STATE_MAX_AGE_MS / 2;
/** Learned alerts absent during this post-boot window are warm-up, not
 *  recovery — hold their falling edge so a restart can't emit a premature
 *  "Resolved" (observed 25 s after a boot, before analytics had warmed). */
export const LEARNED_RESOLVE_GRACE_MS = 10 * 60 * 1000;

/** v0.80.0 — persisted notify-state record. Legacy files stored a bare
 *  epoch-ms number; the record now also carries whether the push was actually
 *  DELIVERED (`sent` — false for a policy-suppressed dispatch, which must not
 *  rehydrate into a "Resolved:"-owing pushSent) and the severity it was
 *  notified at (`sev` — so the owed-resolve rule survives a restart even when
 *  the alert has downgraded below minSeverity by clear time). A legacy number
 *  loads as {ts, sent: true}: pre-v0.80 records cannot distinguish suppressed,
 *  and treating them as delivered matches the pre-upgrade resolve behavior. */
export interface NotifyRecord {
  ts: number;
  sent: boolean;
  sev?: Severity;
}

export function loadNotifiedState(path: string, nowMs = Date.now()): Map<string, NotifyRecord> {
  const out = new Map<string, NotifyRecord>();
  try {
    if (!existsSync(path)) return out;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const cutoff = nowMs - NOTIFY_STATE_MAX_AGE_MS;
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === 'number' && v > cutoff) {
        out.set(id, { ts: v, sent: true }); // legacy shape (pre-v0.80)
      } else if (v !== null && typeof v === 'object') {
        const r = v as { ts?: unknown; sent?: unknown; sev?: unknown };
        if (typeof r.ts === 'number' && r.ts > cutoff) {
          out.set(id, {
            ts: r.ts,
            sent: r.sent === true,
            sev: r.sev === 'critical' || r.sev === 'warning' || r.sev === 'info' ? r.sev : undefined,
          });
        }
      }
    }
  } catch {
    /* corrupt → start fresh */
  }
  return out;
}

export function saveNotifiedState(path: string, state: Map<string, NotifyRecord>): void {
  try {
    atomicWriteFileSync(path, JSON.stringify(Object.fromEntries(state)));
  } catch {
    /* best effort — losing this just risks one duplicate push after a crash */
  }
}

export function startAlertMonitor(store: SnapshotStore, recorder: Recorder, log: (m: string) => void): AlertMonitor {
  let cfg = loadNotifyConfig();
  const tracked = new Map<string, TrackedAlert>();
  const clearedLog: ClearedAlert[] = [];
  const telemetry = new Map<string, AlertActionStats>();
  const quietQueue: Alert[] = [];
  let currentIncidents: Incident[] = [];
  let sentSinceStart = 0;
  let firstRun = true;
  let lastDigestHour = -1;
  const monitorStartMs = Date.now();

  // v0.15.21 — notified-state persistence (see loadNotifiedState above).
  const notifyStatePath =
    process.env.NOTIFY_STATE_PATH ?? resolve(process.cwd(), config.dbPath, '..', 'notify-state.json');
  const persistedNotified = loadNotifiedState(notifyStatePath);
  if (persistedNotified.size > 0) {
    log(`notify: rehydrated ${persistedNotified.size} already-notified alert(s) from ${notifyStatePath}`);
  }
  const persistNotified = () => saveNotifiedState(notifyStatePath, persistedNotified);

  // v0.85.0 — cleared-alert history persistence. The in-memory clearedLog was
  // wiped on every restart, so on a host that power-cycles daily the operator
  // lost the record of what fired and cleared — the exact thing they need to see
  // "what happened" when the audible channel was down. Persist it to a bounded
  // JSON sidecar (newest-first), seed it on boot, rewrite on each qualifying
  // clear. Best-effort throughout: alert HISTORY is observability, never gates a
  // live alarm.
  const CLEARED_LOG_MAX = Math.max(50, Number(process.env.CLEARED_LOG_MAX ?? 500));
  const clearedLogPath =
    process.env.CLEARED_LOG_PATH ?? resolve(process.cwd(), config.dbPath, '..', 'cleared-alerts.json');
  try {
    const raw = JSON.parse(readFileSync(clearedLogPath, 'utf8')) as ClearedAlert[];
    if (Array.isArray(raw)) {
      for (const c of raw.slice(0, CLEARED_LOG_MAX)) {
        if (c && (c as ClearedAlert).alert && Number.isFinite(c.raisedAt) && Number.isFinite(c.clearedAt)) clearedLog.push(c);
      }
      if (clearedLog.length > 0) log(`alerts: rehydrated ${clearedLog.length} cleared-alert record(s) from ${clearedLogPath}`);
    }
  } catch { /* first boot / no prior log — fine */ }
  const persistClearedLog = () => {
    try { atomicWriteFileSync(clearedLogPath, JSON.stringify(clearedLog.slice(0, CLEARED_LOG_MAX))); }
    catch { /* best-effort; history is non-critical */ }
  };

  const QUIET_WINDOW = parseQuietHours(process.env.NOTIFY_QUIET_HOURS ?? '22-06');
  // v0.23.0 — opt-in: when true, critical alerts break through quiet hours and
  // push immediately (today's behaviour). Default false ⇒ critical is ALSO held
  // for the morning digest during quiet hours, so the night stays truly quiet.
  const CRITICAL_BREAKS_QUIET =
    process.env.CRITICAL_BREAKS_QUIET_HOURS === 'true' || process.env.CRITICAL_BREAKS_QUIET_HOURS === '1';
  const DIGEST_HOUR = Number(process.env.NOTIFY_DIGEST_HOUR ?? 7);
  // Auto-silencing thresholds + the four rules now live at module scope as the
  // pure, exported applySilencingRules() so the boot-time replay pass and the
  // live-event path share one tested implementation (a panel restart must not
  // reset silencing the persisted log says should still hold). v0.30.0.
  const evaluateSilencingRules = applySilencingRules;

  /**
   * Fetch or seed the family-keyed rollup for an alert.
   *
   * v0.9.59 — rollup keys switched from full alertId to familyOf(alertId).
   * The exemplar `alertId`, `title`, `severity`, `category` fields track the
   * most recent member of the family — they're descriptive metadata, not
   * primary keys.
   */
  const getOrSeedRollup = (alert: Alert): AlertActionStats => {
    const familyKey = familyOf(alert.id);
    let t = telemetry.get(familyKey);
    if (!t) {
      t = {
        familyKey,
        alertId: alert.id, title: alert.title, severity: alert.severity, category: alert.category,
        riseCount: 0, medianDurationMs: 0, longestDurationMs: 0, shortClearsCount: 0,
        downgradedSilenced: false, warningDemotedToInfo: false, chronicNoiseSilenced: false,
        neverClearedCount: 0, lastSeenAt: null,
      };
      telemetry.set(familyKey, t);
    } else {
      // Always carry forward the freshest exemplar — useful for the UI's
      // "what was the last instance of this family" affordance.
      t.alertId = alert.id;
      t.title = alert.title;
      t.severity = alert.severity;
      t.category = alert.category;
    }
    // v0.31.0 — persist this family's real metadata so a post-restart replay
    // seeds the rollup with a true title/severity/category instead of the
    // familyKey/'info'/'Battery' placeholder. Change-detected ⇒ a no-op write
    // on the steady-state hot path.
    upsertFamilyMeta(familyKey, { title: alert.title, severity: alert.severity, category: alert.category });
    return t;
  };

  /**
   * Record a "rise" event for an alert. v0.9.59 — split out from the
   * combined-counter pattern that lived in updateTelemetry so we can
   * persist the EVENT as it happens (writes one JSONL line) rather than
   * persisting it lazily at clear time (which loses partial state when
   * we restart mid-alert).
   */
  const recordRise = (alert: Alert, ts: number) => {
    const t = getOrSeedRollup(alert);
    t.riseCount++;
    t.lastSeenAt = ts;
    evaluateSilencingRules(t);
    appendTelemetryEvent({ familyKey: t.familyKey, alertId: alert.id, event: 'rise', ts });
  };

  /**
   * Record a duration-bearing event (shortClear or longActive) at the
   * moment the alert clears. We always trigger one of the two depending
   * on how long the alert was alive.
   *
   *   - duration ≤ SHORT_CLEAR_MS  → 'shortClear' (transient / auto-resolve)
   *   - duration ≥ CHRONIC_NOISE_LONG_MS → 'longActive' (user never acted)
   *
   * A duration in between gets no event — it was a "real" alert that the
   * system cleared on its own time but not quickly enough to count as
   * noise and not slowly enough to count as chronic. The rollup still
   * tracks medianDurationMs / longestDurationMs from the rise count.
   */
  const recordClear = (alert: Alert, duration: number, ts: number) => {
    const t = getOrSeedRollup(alert);
    // Online median via incremental approximation; for the simple use-case the
    // running EWMA on duration is enough to drive a downgrade decision.
    t.medianDurationMs = t.medianDurationMs === 0 ? duration : Math.round((t.medianDurationMs + duration) / 2);
    if (duration > t.longestDurationMs) t.longestDurationMs = duration;
    // v0.13.2 — single source of truth for the short/long classification.
    const { shortClear, longActive } = classifyClearDuration(duration);
    if (shortClear) {
      t.shortClearsCount++;
      appendTelemetryEvent({ familyKey: t.familyKey, alertId: alert.id, event: 'shortClear', ts, durationMs: duration });
    }
    if (longActive) {
      t.neverClearedCount++;
      appendTelemetryEvent({ familyKey: t.familyKey, alertId: alert.id, event: 'longActive', ts, durationMs: duration });
    }
    t.lastSeenAt = ts;
    evaluateSilencingRules(t);
  };

  /**
   * v0.9.59 — Hydrate the in-memory rollup from the persisted JSONL on
   * boot. Counters re-derive from event replay (cheap given the 30-day
   * window cap); silencing rules are re-evaluated as the rollup grows.
   *
   * One known soft-spot: when replaying we don't have the live Alert
   * object (with severity/category/title) for events whose alert no
   * longer exists. We seed a placeholder rollup from the first event's
   * familyKey/alertId and let it get overwritten with real metadata the
   * first time the alert fires post-boot. Until then the rollup carries
   * counts but `severity` defaults to 'info' so silencing rules behave
   * conservatively (least aggressive silencing).
   */
  const replayPersistedTelemetry = () => {
    const events = readRecentTelemetry();
    if (events.length === 0) return;
    const familyMeta = loadFamilyMeta(); // v0.31.0 — real title/severity/category, if the sidecar knows this family
    let n = 0;
    for (const e of events) {
      // Defensive shape check — guards against schema drift.
      if (!e.familyKey || !e.alertId || !e.event) continue;
      let t = telemetry.get(e.familyKey);
      if (!t) {
        // v0.31.0 — prefer the persisted sidecar metadata so the rollup boots
        // with the family's true title/severity/category; the old
        // familyKey/'info'/'Battery' placeholders are only the fallback for a
        // family the sidecar has never seen (e.g. first boot after upgrade).
        // Real severity here also keeps the post-replay batch silencing pass
        // from running against a wrong 'info' default.
        const meta = familyMeta[e.familyKey];
        t = {
          familyKey: e.familyKey,
          alertId: e.alertId,
          title: meta?.title ?? e.familyKey,
          severity: (meta?.severity as Severity) ?? 'info',
          category: (meta?.category as Alert['category']) ?? ('Battery' as Alert['category']),
          riseCount: 0, medianDurationMs: 0, longestDurationMs: 0, shortClearsCount: 0,
          downgradedSilenced: false, warningDemotedToInfo: false, chronicNoiseSilenced: false,
          neverClearedCount: 0, lastSeenAt: null,
        };
        telemetry.set(e.familyKey, t);
      }
      switch (e.event) {
        case 'rise':
          t.riseCount++;
          break;
        case 'shortClear':
          t.shortClearsCount++;
          if (e.durationMs != null) {
            t.medianDurationMs = t.medianDurationMs === 0 ? e.durationMs : Math.round((t.medianDurationMs + e.durationMs) / 2);
            if (e.durationMs > t.longestDurationMs) t.longestDurationMs = e.durationMs;
          }
          break;
        case 'longActive':
          t.neverClearedCount++;
          if (e.durationMs != null) {
            t.medianDurationMs = t.medianDurationMs === 0 ? e.durationMs : Math.round((t.medianDurationMs + e.durationMs) / 2);
            if (e.durationMs > t.longestDurationMs) t.longestDurationMs = e.durationMs;
          }
          break;
      }
      t.lastSeenAt = e.ts;
      n++;
    }
    // Re-evaluate silencing on every family after replay finishes —
    // single pass is fine since each evaluate is O(1).
    for (const t of telemetry.values()) evaluateSilencingRules(t);
    log(`alert-telemetry: replayed ${n} events across ${telemetry.size} families`);
  };

  /** v0.80.0 — dispatch outcome. 'sent' = the push was actually delivered;
   *  'suppressed' = a POLICY gate (no channel / auto-tune silencing / priority
   *  toggle) intentionally skipped it — counts as handled, never retried;
   *  'failed' = the send itself errored (HA Core restarting, network) — the
   *  caller must NOT mark the alert notified, so the next evaluate tick
   *  retries. The 68.9h log review found the old void dispatch let one real
   *  HTTP 400 (HA mid-restart) permanently eat a push: `notified` was already
   *  durably persisted before the send, and the failure logged at info with no
   *  identity. At-least-once now: a crash between send and persist duplicates
   *  one push after restart — the right direction for the sole alarm channel. */
  const dispatch = async (alert: Alert, kind: 'new' | 'resolved'): Promise<'sent' | 'suppressed' | 'failed'> => {
    if (!isConfigured(cfg)) return 'suppressed';
    // v0.9.59 — silencing is now family-keyed so a single noisy condition
    // spread across multiple packs aggregates correctly. The decision
    // still operates per-alert (we silence THIS alert's notification),
    // but the threshold for the decision comes from the family rollup.
    const t = telemetry.get(familyOf(alert.id));
    // v0.7.5 silencing or v0.9.3 chronic-noise silencing — skip notify entirely.
    if (t?.downgradedSilenced || t?.chronicNoiseSilenced) return 'suppressed';
    // v0.11.0 — ISA priority annunciation gate. When the operator has turned
    // off this alarm's priority on the Alert Settings page, suppress the push
    // notification (the alert still stays in snapshot.alerts and renders in the
    // UI — we silence the annunciation, never hide an active alarm).
    if (!isPriorityEnabled(priorityOf(alert))) return 'suppressed';
    // v0.9.3 warning→info demotion — alert still notifies but at info priority
    // (no [CRITICAL] prefix, lower ntfy priority). The decision applies only
    // to new alerts, not resolved-cleared notifications.
    const effectiveSeverity: Severity =
      t?.warningDemotedToInfo && alert.severity === 'warning' && kind === 'new'
        ? 'info'
        : alert.severity;
    // v0.11.0 — human-facing title carries the ISA priority LABEL in brackets
    // for ALL priorities (e.g. "[Critical] …", "[High] …", "[Medium] …",
    // "[Low] …"), replacing the old critical-only "[CRITICAL] " prefix. This is
    // purely presentational — the NotifyMessage.severity passed onward below
    // stays critical/warning/info so the ntfy/Pushover priority maps are
    // unchanged. Priority is derived from the EFFECTIVE severity (so a
    // warning→info auto-demotion shows "[Low]").
    // v0.74.0 — append a device locator so the same condition on different
    // subjects is distinguishable in the notification list ("Pack nearly empty
    // — RIVER 3 Plus pack 1" vs "… Delta 3 Plus pack 1"). Empty for system-wide
    // alerts, so their titles are unchanged.
    const loc = notifyLocator(alert);
    const titleBody = loc ? `${alert.title} — ${loc}` : alert.title;
    const title =
      kind === 'resolved'
        ? `Resolved: ${titleBody}`
        : `[${priorityMeta(priorityOf({ severity: effectiveSeverity, source: alert.source })).label}] ${titleBody}`;
    try {
      await sendNotification(cfg, {
        title: `EcoFlow · ${title}`,
        body: kind === 'resolved' ? `${alert.detail}\n\n(condition cleared)` : alert.detail,
        severity: kind === 'resolved' ? 'resolved' : effectiveSeverity,
        // v0.74.0 — per-subject card identity (same id for fire + its resolve)
        // so distinct subjects no longer overwrite one shared severity-keyed card
        // and a "Resolved:" updates the card it fired on. See notifyDedupId.
        dedupId: notifyDedupId(alert),
      });
      sentSinceStart++;
      log(`notify: sent "${title}" via ${cfg.channel}${effectiveSeverity !== alert.severity ? ` (severity ${alert.severity}→${effectiveSeverity} via auto-tune)` : ''}`);
      return 'sent';
    } catch (e: any) {
      // v0.80.0 — identity + retry intent in the failure line (the old
      // identity-free info line hid which push a real HTTP 400 ate).
      log(`notify: WARNING — send failed for "${title}" — ${e?.message ?? e}; will retry next evaluate tick`);
      return 'failed';
    }
  };

  /** v0.80.0 — returns whether the digest is SETTLED for this hour (sent,
   *  nothing to send, or deliberately dropped). A send FAILURE returns false so
   *  the caller does NOT latch lastDigestHour — the held overnight alerts retry
   *  on every tick within the digest hour instead of silently waiting 24 h
   *  (the one delivery path the at-least-once rework had left fire-and-forget). */
  const dispatchDigest = async (): Promise<boolean> => {
    if (quietQueue.length === 0) return true;
    // v0.15.18 — the digest used to vanish without a trace when no channel was
    // configured: 58 queued warnings (incl. 17× cell-imbalance) dropped over
    // 50 h with nothing in the log. Now it says so, loudly, once per digest.
    if (!isConfigured(cfg)) {
      log(
        `notify: WARNING — morning digest has ${quietQueue.length} queued alert(s) but no notify ` +
          `channel is configured (NOTIFY_CHANNEL=${cfg.channel}). Set NOTIFY_CHANNEL to ` +
          `"ha" (HA persistent notification, zero setup), ntfy, pushover, or webhook to receive them. Dropping queue.`,
      );
      quietQueue.length = 0;
      return true;
    }
    // v0.15.18 — include device identity so a digest line is actionable on its
    // own ("Cell imbalance" alone can't say WHICH of 15 packs).
    const lines = quietQueue.map((a) => {
      const loc =
        a.coreNum != null
          ? ` (Core ${a.coreNum}${a.packNum != null ? ` pack ${a.packNum}` : ''})`
          : '';
      return `• [${a.severity}] ${a.title}${loc}`;
    });
    try {
      await sendNotification(cfg, {
        title: `EcoFlow · Morning digest (${quietQueue.length} alert${quietQueue.length === 1 ? '' : 's'})`,
        body: `Held during overnight quiet hours:\n\n${lines.join('\n')}\n\n${
          CRITICAL_BREAKS_QUIET
            ? '(Critical alerts break through immediately; the items above are warning/info.)'
            : '(Every tier — including critical — was held overnight. Set CRITICAL_BREAKS_QUIET_HOURS=true to be woken for critical emergencies.)'
        }`,
        severity: 'info',
      });
      sentSinceStart++;
      log(`notify: morning digest sent (${quietQueue.length} alerts) via ${cfg.channel}`);
      // v0.76.0 — the held alerts have now ACTUALLY been delivered, so mark them
      // notified + persisted (deferred from queue-time so a pre-digest restart
      // couldn't silently drop them). Keyed by id; the tracked entry may already
      // have cleared, in which case the persisted record alone prevents a re-push.
      const digestSentMs = Date.now();
      for (const qa of quietQueue) {
        const qt = tracked.get(qa.id);
        // v0.80.0 — RATCHET, never regress: a queued warning that escalated and
        // was dispatched directly (critical break-through, or the post-quiet
        // pre-digest window) already holds the higher severity; re-marking it
        // from this stale queue entry would re-arm isAlertEscalation and emit a
        // duplicate critical push. See moreSevere().
        if (qt) {
          qt.notified = true;
          qt.notifiedSeverity = qt.notifiedSeverity ? moreSevere(qt.notifiedSeverity, qa.severity) : qa.severity;
          qt.queued = false;
          qt.pushSent = true; // the digest line IS the delivered fire; its resolve is owed
        }
        const prior = persistedNotified.get(qa.id);
        const sev = prior?.sev ? moreSevere(prior.sev, qa.severity) : qa.severity;
        persistedNotified.set(qa.id, { ts: digestSentMs, sent: true, sev });
      }
      persistNotified();
      quietQueue.length = 0;
      return true;
    } catch (e: any) {
      // v0.80.0 — the queue is retained (cleared only in the success path) and
      // the caller retries next tick within the digest hour.
      log(`notify: WARNING — morning digest failed — ${e?.message ?? e}; will retry next evaluate tick`);
      return false;
    }
  };

  // v0.80.0 — evaluate() re-entrancy guard. The at-least-once rework marks
  // `notified` AFTER the awaited send, so without this latch an overlapping
  // setInterval tick (a tick outlives EVAL_INTERVAL_MS whenever sends hang
  // against a restarting HA Core — exactly the retry window) would see
  // notified=false mid-send and double-dispatch the same fire, and a clear
  // during the overlap would recordClear() twice, corrupting the auto-tune
  // telemetry fractions. Skipping a tick while one is in flight is safe: the
  // next interval re-evaluates from the live snapshot.
  let evaluating = false;

  const evaluate = async () => {
    if (evaluating) return;
    evaluating = true;
    try {
      await evaluateInner();
    } finally {
      evaluating = false;
    }
  };

  const evaluateInner = async () => {
    const snap = store.get();
    let forecastDay: Alert[] = [];
    let stormPrep: Alert[] = [];
    try {
      const df = await getAnalytics().report('forecast');
      // v0.59.0 — pass grid presence so a projected dip below reserve reads as
      // informational ("if islanded") when the grid is backstopping the load.
      forecastDay = forecastDayAlerts(df, liveGridBackstop(snap.devices));
    } catch (e: any) {
      log(`forecast: day-ahead failed — ${e?.message ?? e}`);
    }
    try {
      stormPrep = await stormPrepAlerts(snap.devices);
    } catch (e: any) {
      log(`storm-prep: ${e?.message ?? e}`);
    }
    // v0.9.77 — SoC-saturation curtailment alert. Returns 0 or 1 entries;
    // its severity is `info` (not a fault) and its content carries the
    // "you have X kW of headroom — could absorb with pool pump etc." copy.
    let curtailment: Alert[] = [];
    try {
      curtailment = await getAnalytics().report('curtailmentAlerts');
    } catch (e: any) {
      log(`curtailment-alert: ${e?.message ?? e}`);
    }
    // v0.7.7 — build the connectivity context the alerts engine uses to
    // enrich offline/stale alerts with last-data timestamps + source.
    const perDevice = new Map<string, { lastMqttAt?: number; lastSource?: 'rest' | 'mqtt'; mqttCount: number }>();
    for (const d of Object.values(snap.devices)) {
      perDevice.set(d.sn, {
        lastMqttAt: store.lastMqttAtBySn.get(d.sn),
        lastSource: store.lastSourceBySn.get(d.sn),
        mqttCount: store.mqttMsgCountBySn.get(d.sn) ?? 0,
      });
    }
    const connectivity = {
      lastDeviceListAttemptAt: store.lastDeviceListAttemptAt,
      lastDeviceListSuccessAt: store.lastDeviceListSuccessAt,
      perDevice,
    };

    // v0.10.0 — baseline + forecast alert signals are recorder-backed; fetch
    // them from the analytics worker so this 20s eval never scans SQLite on
    // the main thread.
    let baselineAlerts: Alert[] = [];
    let forecastAlerts: Alert[] = [];
    try {
      [baselineAlerts, forecastAlerts] = await Promise.all([
        getAnalytics().report('baselineAlerts'),
        getAnalytics().report('forecastAlerts'),
      ]);
    } catch (e: any) {
      log(`alert-signals: baseline/forecast failed — ${e?.message ?? e}`);
    }

    // v0.23.0 — grid-backstop context for the reserve/floor alerts. Keep the HA
    // state cache warm when a grid-presence entity is configured (TTL-gated +
    // coalesced, so this is cheap), then resolve from the live snapshot. When no
    // entity is configured this resolves from GRID_AVAILABLE + live import only.
    if (gridPresenceEntityId()) {
      try {
        await haStateCache.refreshIfStale();
      } catch {
        /* best effort — a stale/empty cache resolves to NOT present (safe) */
      }
    }
    const grid = liveGridBackstop(snap.devices);

    const alerts = [
      ...computeAlerts(snap.devices, connectivity, grid),
      ...computeLearnedAlerts(snap.devices),
      ...baselineAlerts,
      ...forecastAlerts,
      ...forecastDay,
      ...stormPrep,
      ...curtailment,
      // v0.83.0 — recorded telemetry blackouts (host power loss / add-on stop /
      // MQTT stall) surfaced as operator push alerts. Reads the recorder's durable
      // gaps sidecar, so a gap detected AT BOOT (spanning the very restart that
      // caused it) still fires after the process comes back.
      ...outageAlerts(recorder.telemetryGaps(), Date.now(), {
        enabled: OUTAGE_ALERTS_ENABLED,
        recentWindowMs: OUTAGE_RECENT_WINDOW_MS,
        minDurationMs: OUTAGE_MIN_DURATION_MS,
      }),
      // v0.84.0 — audible-delivery self-alert. When audible broadcasting is
      // enabled but the broadcast monitor has CONFIRMED no reachable speaker
      // (Music Assistant down → its media_players go unavailable), surface it as
      // a WARNING push. This is the ONLY component that can report a dead audible
      // channel — the audible path itself can't announce its own outage. It rides
      // this push path (working) with full dedup/quiet-hours; conditionFromAlerts
      // excludes its id so it never tries to chime. Null health (unprobed/boot/
      // transient) yields no alert — see broadcastHealthAlert.
      ...(() => { const a = broadcastHealthAlert(getBroadcastHealth(), Date.now()); return a ? [a] : []; })(),
    ].sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.category.localeCompare(b.category));
    // v0.26.0 — central spare gate. A bench spare (in SPARE_DPU_SNS, not wired
    // into the SHP2) is online for diagnostics but must NEVER chime/push. v0.16.4
    // only gated the offline/stale branches; the learned/forecast/baseline emitters
    // had no membership filter, so a spare's peer-*/forecast-imbalance/baseline
    // alerts went out live. Stamp annunciate:false on every alert whose id carries
    // an expected-offline-spare SN (idempotent with the per-emitter threshold gate
    // in alerts.ts). Keeps the alert visible in the UI; auto-re-arms the instant the
    // spare is wired into an SHP2 (shp2ConnectedDpuSns then includes it).
    {
      const connectedSns = shp2ConnectedDpuSns(snap.devices);
      const mutedSpares = [...SPARE_DPU_SNS].filter((sn) => isExpectedOfflineSpare(sn, connectedSns));
      if (mutedSpares.length > 0) {
        for (const a of alerts) {
          if (a.annunciate !== false && mutedSpares.some((sn) => a.id.includes(sn))) {
            a.annunciate = false;
          }
        }
      }
    }
    store.setAlerts(alerts);
    currentIncidents = buildIncidents(alerts);

    const now = Date.now();
    const nowDate = new Date(now);
    const currentIds = new Set(alerts.map((a) => a.id));

    // Rising edges + debounce
    for (const a of alerts) {
      const existing = tracked.get(a.id);
      if (!existing) {
        // v0.9.25 — snapshot the feature vector at first fire so future
        // online-learning code can replay the model inputs that produced
        // this alert. Failure is silent: missing snapshots only mean the
        // outcome record won't carry features.
        //
        // v0.9.59 — also capture the REAL normalized LR feature vector
        // for pack-level alerts (was being reconstructed from generic
        // features at training time, which proxied rTrend off pack
        // temperature — meaning Phoenix summer would train every pack
        // as "high risk" from ambient heat). Now stored alongside the
        // generic features so onlineLR can read them back directly.
        try {
          const features = extractFeatures(a, snap);
          if (features) {
            // captureLrFeatures returns null for non-pack alerts (SHP2,
            // EVSE, system) — those skip the SGD update anyway, so the
            // null is correct and not lossy.
            const lrFeatures = await captureLrFeatures(a, snap, recorder);
            captureSnapshot({
              alertId: a.id,
              ts: now,
              features,
              category: a.category,
              severity: a.severity,
              title: a.title,
              lrFeatures,
            }, log);
          }
        } catch { /* ignore — never block alert dispatch on snapshot */ }
        // v0.9.59 — record the rise in the family rollup and persist it.
        // Previously rise counts were only incremented at clear time,
        // which made the chronic-noise rule blind to permanently-active
        // alerts (they never cleared, so never got counted).
        recordRise(a, now);
        // v0.15.21 — an alert already pushed (recorded in notify-state.json) must
        // not re-push when it "rises" again here: analytics warm-up re-deriving
        // it post-boot, OR its tracked entry having been dropped and recreated
        // while the persisted record still stands. The suppression is correct in
        // all those cases.
        // v0.74.0 — corrected the log wording only. It previously asserted "was
        // already notified before restart", which misled restart-triage: the gate
        // keys purely on the persisted record, so it also fires in steady state
        // far from any restart. The suppression ACTION is unchanged.
        const rec = persistedNotified.get(a.id);
        const alreadyNotified = rec != null;
        if (alreadyNotified && !firstRun) {
          log(`notify: "${a.title}" already has a notification on record (notify-state) — suppressing duplicate push`);
        }
        // v0.83.0 — outage EVENTs are NOT firstRun-seeded (see bootSeedNotified),
        // so a restart-spanning outage recorded before the monitor starts still
        // fires its push on the boot that follows it, instead of being swallowed.
        const seeded = bootSeedNotified({ alert: a, firstRun, alreadyNotified });
        tracked.set(a.id, {
          alert: a,
          firstSeen: now,
          notified: seeded,
          // v0.80.0 — rehydrate the severity we actually notified at (the record
          // carries it), so the owed-resolve rule survives a restart even when
          // the alert has since downgraded below minSeverity; fall back to the
          // current severity for legacy/absent records. A not-seeded alert hasn't
          // been notified yet → undefined (so its next tick dispatches normally).
          notifiedSeverity: alreadyNotified ? (rec.sev ?? a.severity) : seeded ? a.severity : undefined,
          // v0.80.0 — pushSent only when the record says the push was DELIVERED
          // (`sent`; a policy-suppressed dispatch also persists a record for
          // dedupe, but its rehydration must not owe a "Resolved:"). A
          // firstRun-only seed suppresses the fire push but must not enable an
          // all-clear for a push that never went out.
          pushSent: rec?.sent === true,
        });
        continue;
      }
      existing.alert = a;
      // v0.38.0 — the alert is present again this tick, so cancel any pending
      // resolve-dwell countdown (a sustained load-anomaly that briefly dipped
      // back to baseline and recovered must not resolve).
      existing.clearedSince = undefined;
      // v0.80.0 — keep the notify-state record ALIVE while its alert stays
      // active: the record is stamped once at dispatch and NOTIFY_STATE_MAX_AGE
      // (24 h) drops it at load, so an alert outliving 24 h (a >25 h cloud wedge
      // is documented for this fleet) that spans one of this host's ~daily
      // reboots would rehydrate with pushSent=false and lose its owed
      // "Resolved:". Refresh at most every NOTIFY_STATE_REFRESH_MS (12 h), so
      // records for alerts that genuinely vanished still expire on schedule.
      if (existing.notified) {
        const liveRec = persistedNotified.get(a.id);
        if (liveRec && now - liveRec.ts > NOTIFY_STATE_REFRESH_MS) {
          persistedNotified.set(a.id, { ...liveRec, ts: now });
          persistNotified();
        }
      }
      // v0.16.4 — non-annunciating alerts (annunciate === false, e.g. an
      // expected-offline bench spare) stay tracked + visible in snapshot.alerts
      // but must never push or queue a notification. Gate HERE, above the
      // quiet-hours split, so the morning digest queue can't leak them either.
      // The falling-edge "Resolved" path is gated separately below (a boot can
      // seed `notified:true` for an already-present alert, so the rising-edge
      // gate alone isn't sufficient there).
      if (a.annunciate === false) continue;
      // v0.9.58 — critical alerts bypass debounce on the notify path. A brief
      // critical condition that fires and clears in <60s would otherwise be
      // silently swallowed. Warning/info still debounce to avoid noisy
      // flapping (a short blip isn't worth interrupting for); a brief critical
      // is exactly the kind of thing the user wants to know about.
      // v0.38.0 — the sustained load-anomaly family ("<Circuit> load unusual
      // for the hour") gets a much longer fire debounce so a normal AC
      // compressor cycle (a few minutes) clears inside the window and never
      // pushes; only an anomaly that PERSISTS past BASELINE_LOAD_SUSTAIN_MS
      // surfaces. Critical still bypasses (these are never critical, but the
      // ordering keeps that invariant explicit).
      const debounceMs = a.severity === 'critical' ? 0 : notifyDebounceMsFor(a);
      // v0.23.0 — re-notify when a PERSISTENT alert ESCALATES above the severity
      // it was last dispatched at. The motivating case: shp2-below-reserve flips
      // info→critical when the grid drops out at the reserve floor; without this
      // the `notified` flag swallows the upgrade and the push channel stays
      // silent on a genuine emergency. Escalation bypasses debounce (like a fresh
      // critical) so the upgrade is immediate.
      // v0.76.0 — a QUEUED alert (left notified=false by the restart-drop fix) must
      // ALSO be re-evaluated when it escalates, or a warning that becomes critical
      // while held in quiet hours would be stuck at its original tier — and, under
      // CRITICAL_BREAKS_QUIET_HOURS=true, a genuine overnight critical would never
      // break through. notifiedSeverity is recorded at BOTH dispatch and queue time,
      // so isAlertEscalation() (pure, tested) sees the queued severity too.
      const escalated = isAlertEscalation(existing, a.severity);
      const escDebounceMs = escalated && a.severity === 'critical' ? 0 : debounceMs;
      // Quiet hours: warning/info is always queued for the morning digest.
      // v0.23.0 — critical breaks through ONLY when CRITICAL_BREAKS_QUIET_HOURS
      // is opted in; default OFF ⇒ critical is also queued (surfaces at the
      // digest, still visible on-screen meanwhile) so nights stay quiet.
      const quiet = QUIET_WINDOW != null && inQuietWindow(nowDate, QUIET_WINDOW);
      const breaksThrough = a.severity === 'critical' && CRITICAL_BREAKS_QUIET;
      // v0.76.0 — decision extracted to the pure decideAlertDispatch() (tested).
      const action = decideAlertDispatch({
        qualifies: qualifies(a.severity, cfg.minSeverity),
        alreadyNotified: existing.notified,
        alreadyQueued: existing.queued === true,
        escalated,
        debounceElapsed: now - existing.firstSeen >= escDebounceMs,
        inQuiet: quiet,
        breaksThrough,
      });
      if (action === 'queue') {
        // v0.76.0 — hold for the morning digest. Set ONLY the in-memory `queued`
        // flag (prevents re-queueing every tick); deliberately do NOT mark
        // notified or persist, so a restart before the digest re-evaluates and
        // re-queues this alert rather than silently dropping it (the in-memory
        // quietQueue does NOT survive a restart, but persistedNotified does — so
        // marking notified at queue-time, as the pre-v0.76 code did, let the daily
        // clock-jump restart permanently swallow a held overnight alert). The
        // digest marks it notified + persisted when it actually sends.
        existing.queued = true;
        // v0.76.0 — record the severity we queued AT (but NOT `notified`, and NOT
        // persisted) so a later escalation of a held alert is detected (the escalated
        // check above reads notifiedSeverity). notified stays false so a restart still
        // re-queues; persistedNotified stays absent so the restart-drop fix holds.
        existing.notifiedSeverity = a.severity;
        quietQueue.push(a);
        log(`notify: queued for morning digest — "${a.title}" (severity ${a.severity})`);
      } else if (action === 'dispatch') {
        // v0.80.0 — at-LEAST-once delivery: attempt the send FIRST; mark +
        // durably persist only when it was sent (or policy-suppressed = handled).
        // The old order (persist, then send) let one real HTTP 400 during an HA
        // Core restart permanently eat a push — notify-state said "already
        // notified", so it was never retried and never re-pushed. On 'failed'
        // NOTHING advances and the next evaluate tick naturally retries:
        //   • first dispatch (notified=false, queued=false) — eligible again;
        //   • ESCALATED re-dispatch of an already-notified alert — eligible again
        //     only because notifiedSeverity still holds the OLD severity. Do NOT
        //     set notifiedSeverity pre-send: advancing it on a failed escalation
        //     would make the next tick read critical<critical = not-escalated and
        //     silently swallow the retry of a CRITICAL break-through push.
        existing.queued = false;
        const outcome = await dispatch(a, 'new');
        if (outcome !== 'failed') {
          existing.notified = true;
          existing.notifiedSeverity = a.severity;
          if (outcome === 'sent') existing.pushSent = true;
          // v0.15.21 — record the push durably so a restart can't repeat it.
          // v0.80.0 — the record carries delivered-vs-suppressed + the severity,
          // so a restart rehydrates pushSent/notifiedSeverity faithfully.
          persistedNotified.set(a.id, { ts: now, sent: outcome === 'sent', sev: a.severity });
          persistNotified();
        }
      }
    }

    // Morning digest — fires once when the local hour rolls over to DIGEST_HOUR
    if (Number.isInteger(DIGEST_HOUR) && DIGEST_HOUR >= 0 && DIGEST_HOUR <= 23) {
      const h = nowDate.getHours();
      if (h === DIGEST_HOUR && lastDigestHour !== h) {
        // v0.80.0 — latch the hour only when the digest SETTLED; a failed send
        // retries each tick within the hour rather than waiting until tomorrow.
        if (await dispatchDigest()) lastDigestHour = h;
      } else if (h !== DIGEST_HOUR) {
        lastDigestHour = -1;
      }
    }

    // Falling edges — condition cleared
    for (const [id, t] of [...tracked.entries()]) {
      if (currentIds.has(id)) continue;
      // v0.15.21 — learned/analytics alerts take ~1–2 min to warm after a
      // boot; absence in the early ticks is warm-up, not recovery. Hold the
      // falling edge through the grace window (the entry stays tracked and
      // re-evaluates next tick) so a restart can't fire a premature
      // "Resolved" — a genuine clear still resolves once the window passes.
      if (t.alert.source === 'learned' && now - monitorStartMs < LEARNED_RESOLVE_GRACE_MS) continue;
      // v0.38.0 — resolve-dwell for the sustained load-anomaly family. A
      // genuinely-sustained anomaly can momentarily dip back under the floor
      // (compressor cycling within a fault, sample jitter); without a dwell
      // that single absent tick would emit a "Resolved:" and the next present
      // tick would re-fire — recreating the flap on the clear side. Hold the
      // entry until it has been continuously absent for the dwell. If it
      // reappears first, the rising-edge path clears `clearedSince` and the
      // countdown restarts. (An alert that never reached the sustained-fire
      // threshold has `notified === false`, so the resolve dispatch below is a
      // no-op for it regardless — no "Resolved:" without a matching fire.)
      if (isSustainGatedLoadAnomaly(t.alert)) {
        if (t.clearedSince == null) {
          t.clearedSince = now;
          continue; // start the dwell; re-evaluate next tick
        }
        if (now - t.clearedSince < BASELINE_LOAD_RESOLVE_DWELL_MS) continue; // still dwelling
      }
      // v0.74.0 — resolve dwell for the per-pack low-SoC family. A pack whose
      // SoC sits on the "nearly empty" threshold crosses it every poll; without
      // a dwell each absent tick emits a premature "Resolved:" (good-news spam)
      // and the next present tick re-fires. Hold the entry until the SoC has been
      // continuously back above threshold for SOC_RESOLVE_DWELL_MS. If it dips
      // back under first, the rising-edge path clears `clearedSince` and no
      // resolve is sent. Resolve-only — never delays a fire or the audible alarm.
      if (isSocResolveDwellFamily(t.alert)) {
        if (t.clearedSince == null) {
          t.clearedSince = now;
          continue; // start the dwell; re-evaluate next tick
        }
        if (now - t.clearedSince < SOC_RESOLVE_DWELL_MS) continue; // still dwelling
      }
      // v0.77.0 — same resolve-side dwell for the per-pack cell-imbalance (vdiff)
      // family: a pack whose cell spread sits on the warning/critical threshold was
      // flapping "Resolved:"/re-fire every poll (Core 3 pack 4: ~4 pushes in 11 min,
      // live v0.76 log), diluting the operator's sole live push channel. Resolve-only.
      if (isCellImbalanceResolveDwellFamily(t.alert)) {
        if (t.clearedSince == null) {
          t.clearedSince = now;
          continue;
        }
        if (now - t.clearedSince < VDIFF_RESOLVE_DWELL_MS) continue;
      }
      const duration = now - t.firstSeen;
      // v0.16.4 — defense-in-depth: a non-annunciating alert (annunciate:false,
      // e.g. an expected-offline bench spare) must not emit a "Resolved" push
      // either, even if a boot seeded its `notified` flag true. The current
      // spare is info-severity (so qualifies() already returns false), but this
      // keeps the mute correct for any future warning/critical annunciate:false.
      // v0.80.0 — delivery-integrity: the gate is the pure shouldSendResolve()
      // (pushSent + notified-at severity; see its doc), and a FAILED resolve send
      // keeps the tracked entry (continue) so the next tick retries —
      // recordClear/delete only run once the resolve is settled.
      // v0.80.0 — forget the notified-state record BEFORE attempting the resolve
      // send: the event is over, and the record's only job (suppressing a
      // duplicate fire push for THIS event) is done. If the record instead
      // outlived a failed resolve into a restart, a GENUINE re-rise within the
      // 24 h TTL — including one arriving straight at critical — would read
      // "already notified" and be silently eaten. Losing the resolve retry
      // across a restart is the bounded, safe direction; eating a future fire
      // is not. Within-process retry is unaffected (it gates on the tracked
      // entry's pushSent, not the record).
      if (persistedNotified.delete(id)) persistNotified();
      if (shouldSendResolve(t, cfg.notifyResolved, cfg.minSeverity)) {
        if ((await dispatch(t.alert, 'resolved')) === 'failed') continue;
      }
      // v0.13.2 — account EVERY cleared rise in telemetry, not just clears that
      // outlived the debounce window. The old code only called recordClear when
      // `duration >= DEBOUNCE_MS`, so a sub-60s flap bumped riseCount (at first
      // fire) but NEVER incremented shortClearsCount — structurally capping the
      // short-clear fraction below DEMOTE_WARN_SHORT_FRAC and making auto-demote
      // unreachable for the very families that flap fastest. A <60s clear is the
      // MOST transient outcome and is exactly what shortClear should capture.
      // The visible-history push stays gated by duration (a 5s blip isn't worth
      // surfacing in the cleared-alert UI), but telemetry counts the clear.
      if (duration >= DEBOUNCE_MS) {
        clearedLog.unshift({ alert: t.alert, raisedAt: t.firstSeen, clearedAt: now, durationMs: duration });
        if (clearedLog.length > CLEARED_LOG_MAX) clearedLog.pop();
        persistClearedLog(); // v0.85.0 — survive restarts (the daily Pi power cut)
      }
      // v0.9.59 — records shortClear / longActive events into the family rollup
      // and appends them to the persisted telemetry log.
      // v0.13.2 — moved out of the debounce-gated block (see above).
      recordClear(t.alert, duration, now);
      tracked.delete(id);
      // (v0.15.21's notified-state forget moved ABOVE the resolve attempt in
      // v0.80.0 — see the comment there.)
    }

    firstRun = false;
  };

  // v0.9.59 — hydrate the in-memory telemetry rollup from the persisted
  // JSONL log BEFORE the first evaluate(). Otherwise the first eval cycle
  // could miss silencing decisions that prior runs had already established
  // (e.g. a chronic-noise alert that fired before restart would re-notify).
  try {
    replayPersistedTelemetry();
  } catch (e: any) {
    log(`alert-telemetry: replay failed — ${e?.message ?? e}`);
  }

  evaluate().catch((e) => log(`alert-monitor: ${e?.message ?? e}`));
  const timer = setInterval(() => {
    evaluate().catch((e) => log(`alert-monitor: ${e?.message ?? e}`));
  }, EVAL_INTERVAL_MS);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    getConfig: () => cfg,
    sendTest: async () => {
      cfg = loadNotifyConfig();
      await sendNotification(cfg, {
        title: 'EcoFlow · Test notification',
        body: 'Notifications are working. This is a test from the EcoFlow panel.',
        severity: 'info',
      });
      sentSinceStart++;
    },
    stats: () => ({ tracked: tracked.size, sentSinceStart, quietQueued: quietQueue.length }),
    history: () => [...clearedLog],
    incidents: () => [...currentIncidents],
    telemetry: () => [...telemetry.values()],
  };
}
