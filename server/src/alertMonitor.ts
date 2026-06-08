import { SnapshotStore } from './snapshot.js';
import { computeAlerts, type Alert, type Severity } from './alerts.js';
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
import { appendTelemetryEvent, readRecentTelemetry } from './alertTelemetry.js';
import type { Recorder } from './recorder.js';
import { getAnalytics } from './analyticsClient.js';
// v0.11.0 — ISA-18.2 / IEC 62682 annunciation gate. The internal severity
// union is unchanged; priority is DERIVED from (severity, source). Disabling
// a priority on the Alert Settings page silences its notification here (the
// alert stays visible in snapshot.alerts).
import { isPriorityEnabled } from './alertSettings.js';
import { priorityOf, priorityMeta } from './alertPriority.js';

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

const sevRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function qualifies(sev: Severity, min: Severity): boolean {
  return sevRank[sev] <= sevRank[min];
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

  const QUIET_WINDOW = parseQuietHours(process.env.NOTIFY_QUIET_HOURS ?? '22-06');
  const DIGEST_HOUR = Number(process.env.NOTIFY_DIGEST_HOUR ?? 7);
  const DOWNGRADE_MIN_RISES = 5;                  // need ≥ 5 rises before info-tier silencing
  const DOWNGRADE_SHORT_FRAC = 0.7;               // ≥ 70% of rises clear within SHORT_CLEAR_MS
  // v0.9.3 — extended self-tuning rules
  const DEMOTE_WARN_MIN_RISES = 10;               // need ≥ 10 rises before demoting warning→info
  const DEMOTE_WARN_SHORT_FRAC = 0.8;             // ≥ 80% short-clear → demote (stricter than info silencing)
  const CHRONIC_NOISE_MIN_RISES = 10;             // need ≥ 10 rises before chronic-noise silencing
  const CHRONIC_NOISE_NEVER_CLEAR_FRAC = 0.5;     // ≥ 50% of rises stayed alive past CHRONIC_NOISE_LONG_MS without user clearing
  // v0.13.2 — SHORT_CLEAR_MS / CHRONIC_NOISE_LONG_MS now live at module scope
  // (shared with the pure classifyClearDuration helper).

  /**
   * Re-evaluate auto-silencing rules for a family rollup after its counters
   * change. Pulled out so the boot-time replay and the live-event path share
   * the same logic (otherwise a panel restart would reset silencing decisions
   * that the persisted log says should still hold).
   */
  const evaluateSilencingRules = (t: AlertActionStats) => {
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
    // never actually acts on it. The condition exists but the user has
    // accepted it (e.g. a freezer with weird draw that they know about). Stop
    // notifying since they're not going to do anything; alert still shows.
    // Applies to any severity below critical (critical always notifies).
    if (
      t.severity !== 'critical' &&
      t.riseCount >= CHRONIC_NOISE_MIN_RISES &&
      t.neverClearedCount / t.riseCount >= CHRONIC_NOISE_NEVER_CLEAR_FRAC
    ) {
      t.chronicNoiseSilenced = true;
    }
  };

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
    let n = 0;
    for (const e of events) {
      // Defensive shape check — guards against schema drift.
      if (!e.familyKey || !e.alertId || !e.event) continue;
      let t = telemetry.get(e.familyKey);
      if (!t) {
        t = {
          familyKey: e.familyKey,
          alertId: e.alertId, title: e.familyKey, severity: 'info',
          // Category is unknown from replay; the live path overwrites this
          // the first time the alert fires again post-boot.
          category: 'Battery' as Alert['category'],
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

  const dispatch = async (alert: Alert, kind: 'new' | 'resolved') => {
    if (!isConfigured(cfg)) return;
    // v0.9.59 — silencing is now family-keyed so a single noisy condition
    // spread across multiple packs aggregates correctly. The decision
    // still operates per-alert (we silence THIS alert's notification),
    // but the threshold for the decision comes from the family rollup.
    const t = telemetry.get(familyOf(alert.id));
    // v0.7.5 silencing or v0.9.3 chronic-noise silencing — skip notify entirely.
    if (t?.downgradedSilenced || t?.chronicNoiseSilenced) return;
    // v0.11.0 — ISA priority annunciation gate. When the operator has turned
    // off this alarm's priority on the Alert Settings page, suppress the push
    // notification (the alert still stays in snapshot.alerts and renders in the
    // UI — we silence the annunciation, never hide an active alarm).
    if (!isPriorityEnabled(priorityOf(alert))) return;
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
    const title =
      kind === 'resolved'
        ? `Resolved: ${alert.title}`
        : `[${priorityMeta(priorityOf({ severity: effectiveSeverity, source: alert.source })).label}] ${alert.title}`;
    try {
      await sendNotification(cfg, {
        title: `EcoFlow · ${title}`,
        body: kind === 'resolved' ? `${alert.detail}\n\n(condition cleared)` : alert.detail,
        severity: kind === 'resolved' ? 'resolved' : effectiveSeverity,
      });
      sentSinceStart++;
      log(`notify: sent "${title}" via ${cfg.channel}${effectiveSeverity !== alert.severity ? ` (severity ${alert.severity}→${effectiveSeverity} via auto-tune)` : ''}`);
    } catch (e: any) {
      log(`notify: send failed — ${e?.message ?? e}`);
    }
  };

  const dispatchDigest = async () => {
    if (!isConfigured(cfg) || quietQueue.length === 0) return;
    const lines = quietQueue.map((a) => `• [${a.severity}] ${a.title}`);
    try {
      await sendNotification(cfg, {
        title: `EcoFlow · Morning digest (${quietQueue.length} alert${quietQueue.length === 1 ? '' : 's'})`,
        body: `Held during overnight quiet hours:\n\n${lines.join('\n')}\n\n(Critical alerts are always delivered immediately.)`,
        severity: 'info',
      });
      sentSinceStart++;
      log(`notify: morning digest sent (${quietQueue.length} alerts) via ${cfg.channel}`);
      quietQueue.length = 0;
    } catch (e: any) {
      log(`notify: morning digest failed — ${e?.message ?? e}`);
    }
  };

  const evaluate = async () => {
    const snap = store.get();
    let forecastDay: Alert[] = [];
    let stormPrep: Alert[] = [];
    try {
      const df = await getAnalytics().report('forecast');
      forecastDay = forecastDayAlerts(df);
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

    const alerts = [
      ...computeAlerts(snap.devices, connectivity),
      ...computeLearnedAlerts(snap.devices),
      ...baselineAlerts,
      ...forecastAlerts,
      ...forecastDay,
      ...stormPrep,
      ...curtailment,
    ].sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.category.localeCompare(b.category));
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
        tracked.set(a.id, { alert: a, firstSeen: now, notified: firstRun });
        continue;
      }
      existing.alert = a;
      // v0.9.58 — critical alerts bypass debounce on the notify path. A brief
      // critical condition that fires and clears in <60s would otherwise be
      // silently swallowed. Warning/info still debounce to avoid noisy
      // flapping (a short blip isn't worth interrupting for); a brief critical
      // is exactly the kind of thing the user wants to know about.
      const debounceMs = a.severity === 'critical' ? 0 : DEBOUNCE_MS;
      if (
        !existing.notified &&
        now - existing.firstSeen >= debounceMs &&
        qualifies(a.severity, cfg.minSeverity)
      ) {
        existing.notified = true;
        // Quiet hours: critical always goes; warning/info gets queued for digest.
        const quiet = QUIET_WINDOW != null && inQuietWindow(nowDate, QUIET_WINDOW);
        if (quiet && a.severity !== 'critical') {
          quietQueue.push(a);
          log(`notify: queued for morning digest — "${a.title}" (severity ${a.severity})`);
        } else {
          await dispatch(a, 'new');
        }
      }
    }

    // Morning digest — fires once when the local hour rolls over to DIGEST_HOUR
    if (Number.isInteger(DIGEST_HOUR) && DIGEST_HOUR >= 0 && DIGEST_HOUR <= 23) {
      const h = nowDate.getHours();
      if (h === DIGEST_HOUR && lastDigestHour !== h) {
        await dispatchDigest();
        lastDigestHour = h;
      } else if (h !== DIGEST_HOUR) {
        lastDigestHour = -1;
      }
    }

    // Falling edges — condition cleared
    for (const [id, t] of [...tracked.entries()]) {
      if (currentIds.has(id)) continue;
      const duration = now - t.firstSeen;
      if (t.notified && cfg.notifyResolved && qualifies(t.alert.severity, cfg.minSeverity)) {
        await dispatch(t.alert, 'resolved');
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
        if (clearedLog.length > 200) clearedLog.pop();
      }
      // v0.9.59 — records shortClear / longActive events into the family rollup
      // and appends them to the persisted telemetry log.
      // v0.13.2 — moved out of the debounce-gated block (see above).
      recordClear(t.alert, duration, now);
      tracked.delete(id);
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
