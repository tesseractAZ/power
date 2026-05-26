import { SnapshotStore } from './snapshot.js';
import { computeAlerts, type Alert, type Severity } from './alerts.js';
import {
  computeLearnedAlerts,
  computeBaselineAlerts,
  computeForecastAlerts,
  getDayForecast,
  forecastDayAlerts,
  stormPrepAlerts,
} from './analytics.js';
import { loadNotifyConfig, sendNotification, isConfigured, type NotifyConfig } from './notify.js';
// v0.9.25 — feedback-loop snapshot capture at first fire.
import { captureSnapshot, extractFeatures } from './featureSnapshot.js';
import type { Recorder } from './recorder.js';

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

/** Cumulative rise/duration stats for a single alert ID, used by auto-downgrade. */
export interface AlertActionStats {
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
  /** v0.9.3 — count of times the alert cleared but our debounce window meant we treated it as a "rise that never cleared" (excluded from shortClearsCount). */
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
  const SHORT_CLEAR_MS = 10 * 60 * 1000;          // resolved within 10 min = transient
  const DOWNGRADE_MIN_RISES = 5;                  // need ≥ 5 rises before info-tier silencing
  const DOWNGRADE_SHORT_FRAC = 0.7;               // ≥ 70% of rises clear within SHORT_CLEAR_MS
  // v0.9.3 — extended self-tuning rules
  const DEMOTE_WARN_MIN_RISES = 10;               // need ≥ 10 rises before demoting warning→info
  const DEMOTE_WARN_SHORT_FRAC = 0.8;             // ≥ 80% short-clear → demote (stricter than info silencing)
  const CHRONIC_NOISE_MIN_RISES = 10;             // need ≥ 10 rises before chronic-noise silencing
  const CHRONIC_NOISE_LONG_MS = 4 * 60 * 60 * 1000; // "long" = persists ≥ 4 hours
  const CHRONIC_NOISE_NEVER_CLEAR_FRAC = 0.5;     // ≥ 50% of rises stayed alive past CHRONIC_NOISE_LONG_MS without user clearing

  const updateTelemetry = (alertId: string, duration: number, alert: Alert) => {
    let t = telemetry.get(alertId);
    if (!t) {
      t = {
        alertId, title: alert.title, severity: alert.severity, category: alert.category,
        riseCount: 0, medianDurationMs: 0, longestDurationMs: 0, shortClearsCount: 0,
        downgradedSilenced: false, warningDemotedToInfo: false, chronicNoiseSilenced: false,
        neverClearedCount: 0, lastSeenAt: null,
      };
    }
    t.riseCount++;
    t.lastSeenAt = Date.now();
    // Online median via incremental approximation; for the simple use-case the
    // running EWMA on duration is enough to drive a downgrade decision.
    t.medianDurationMs = t.medianDurationMs === 0 ? duration : Math.round((t.medianDurationMs + duration) / 2);
    if (duration > t.longestDurationMs) t.longestDurationMs = duration;
    if (duration <= SHORT_CLEAR_MS) t.shortClearsCount++;
    if (duration >= CHRONIC_NOISE_LONG_MS) t.neverClearedCount++;

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
    telemetry.set(alertId, t);
  };

  const dispatch = async (alert: Alert, kind: 'new' | 'resolved') => {
    if (!isConfigured(cfg)) return;
    const t = telemetry.get(alert.id);
    // v0.7.5 silencing or v0.9.3 chronic-noise silencing — skip notify entirely.
    if (t?.downgradedSilenced || t?.chronicNoiseSilenced) return;
    // v0.9.3 warning→info demotion — alert still notifies but at info priority
    // (no [CRITICAL] prefix, lower ntfy priority). The decision applies only
    // to new alerts, not resolved-cleared notifications.
    const effectiveSeverity: Severity =
      t?.warningDemotedToInfo && alert.severity === 'warning' && kind === 'new'
        ? 'info'
        : alert.severity;
    const title =
      kind === 'resolved'
        ? `Resolved: ${alert.title}`
        : `${effectiveSeverity === 'critical' ? '[CRITICAL] ' : ''}${alert.title}`;
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
      const df = await getDayForecast(snap.devices, recorder, log);
      forecastDay = forecastDayAlerts(df);
    } catch (e: any) {
      log(`forecast: day-ahead failed — ${e?.message ?? e}`);
    }
    try {
      stormPrep = await stormPrepAlerts(snap.devices);
    } catch (e: any) {
      log(`storm-prep: ${e?.message ?? e}`);
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

    const alerts = [
      ...computeAlerts(snap.devices, connectivity),
      ...computeLearnedAlerts(snap.devices),
      ...computeBaselineAlerts(snap.devices, recorder),
      ...computeForecastAlerts(snap.devices, recorder),
      ...forecastDay,
      ...stormPrep,
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
        try {
          const features = extractFeatures(a, snap);
          if (features) {
            captureSnapshot({
              alertId: a.id,
              ts: now,
              features,
              category: a.category,
              severity: a.severity,
              title: a.title,
            }, log);
          }
        } catch { /* ignore — never block alert dispatch on snapshot */ }
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
      if (duration >= DEBOUNCE_MS) {
        clearedLog.unshift({ alert: t.alert, raisedAt: t.firstSeen, clearedAt: now, durationMs: duration });
        if (clearedLog.length > 200) clearedLog.pop();
        updateTelemetry(id, duration, t.alert);
      }
      tracked.delete(id);
    }

    firstRun = false;
  };

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
