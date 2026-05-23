import { SnapshotStore } from './snapshot.js';
import { computeAlerts, type Alert, type Severity } from './alerts.js';
import {
  computeLearnedAlerts,
  computeBaselineAlerts,
  computeForecastAlerts,
  getDayForecast,
  forecastDayAlerts,
} from './analytics.js';
import { loadNotifyConfig, sendNotification, isConfigured, type NotifyConfig } from './notify.js';
import type { Recorder } from './recorder.js';

/**
 * Watches the fleet, attaches computed alerts to the snapshot, and pushes a
 * notification when a qualifying alert appears (rising edge) or clears.
 *
 * Debounce: an alert must persist for DEBOUNCE_MS before it notifies — filters
 * transient telemetry spikes. On startup, conditions already present are seeded
 * as "already notified" so a restart doesn't replay every active alert.
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
  raisedAt: number;   // when the monitor first observed the condition
  clearedAt: number;  // when it cleared
  durationMs: number;
}

const sevRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function qualifies(sev: Severity, min: Severity): boolean {
  return sevRank[sev] <= sevRank[min];
}

export interface AlertMonitor {
  stop: () => void;
  getConfig: () => NotifyConfig;
  sendTest: () => Promise<void>;
  stats: () => { tracked: number; sentSinceStart: number };
  /** Newest-first log of alerts that were raised and have since cleared. */
  history: () => ClearedAlert[];
}

export function startAlertMonitor(store: SnapshotStore, recorder: Recorder, log: (m: string) => void): AlertMonitor {
  let cfg = loadNotifyConfig();
  const tracked = new Map<string, TrackedAlert>();
  const clearedLog: ClearedAlert[] = []; // newest-first, capped
  let sentSinceStart = 0;
  let firstRun = true;

  const dispatch = async (alert: Alert, kind: 'new' | 'resolved') => {
    if (!isConfigured(cfg)) return;
    const title =
      kind === 'resolved'
        ? `Resolved: ${alert.title}`
        : `${alert.severity === 'critical' ? '[CRITICAL] ' : ''}${alert.title}`;
    try {
      await sendNotification(cfg, {
        title: `EcoFlow · ${title}`,
        body: kind === 'resolved' ? `${alert.detail}\n\n(condition cleared)` : alert.detail,
        severity: kind === 'resolved' ? 'resolved' : alert.severity,
      });
      sentSinceStart++;
      log(`notify: sent "${title}" via ${cfg.channel}`);
    } catch (e: any) {
      log(`notify: send failed — ${e?.message ?? e}`);
    }
  };

  const evaluate = async () => {
    const snap = store.get();
    // Static threshold alerts + learned alerts (peer, self-baseline, runtime/
    // degradation, and the cloud-aware day-ahead forecast).
    let forecastDay: Alert[] = [];
    try {
      const df = await getDayForecast(snap.devices, recorder, log);
      forecastDay = forecastDayAlerts(df);
    } catch (e: any) {
      log(`forecast: day-ahead failed — ${e?.message ?? e}`);
    }
    const alerts = [
      ...computeAlerts(snap.devices),
      ...computeLearnedAlerts(snap.devices),
      ...computeBaselineAlerts(snap.devices, recorder),
      ...computeForecastAlerts(snap.devices, recorder),
      ...forecastDay,
    ].sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.category.localeCompare(b.category));
    store.setAlerts(alerts);

    const now = Date.now();
    const currentIds = new Set(alerts.map((a) => a.id));

    // Rising edges + debounce
    for (const a of alerts) {
      const existing = tracked.get(a.id);
      if (!existing) {
        // On the very first run, seed as already-notified so a restart is quiet.
        tracked.set(a.id, { alert: a, firstSeen: now, notified: firstRun });
        continue;
      }
      existing.alert = a; // refresh detail text
      if (
        !existing.notified &&
        now - existing.firstSeen >= DEBOUNCE_MS &&
        qualifies(a.severity, cfg.minSeverity)
      ) {
        existing.notified = true;
        await dispatch(a, 'new');
      }
    }

    // Falling edges — condition cleared
    for (const [id, t] of [...tracked.entries()]) {
      if (currentIds.has(id)) continue;
      if (t.notified && cfg.notifyResolved && qualifies(t.alert.severity, cfg.minSeverity)) {
        await dispatch(t.alert, 'resolved');
      }
      // Log non-transient clears (the condition persisted past the debounce
      // window) so the UI can show a history of what came and went.
      if (now - t.firstSeen >= DEBOUNCE_MS) {
        clearedLog.unshift({ alert: t.alert, raisedAt: t.firstSeen, clearedAt: now, durationMs: now - t.firstSeen });
        if (clearedLog.length > 200) clearedLog.pop();
      }
      tracked.delete(id);
    }

    firstRun = false;
  };

  // Kick off immediately, then on an interval.
  evaluate().catch((e) => log(`alert-monitor: ${e?.message ?? e}`));
  const timer = setInterval(() => {
    evaluate().catch((e) => log(`alert-monitor: ${e?.message ?? e}`));
  }, EVAL_INTERVAL_MS);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    getConfig: () => cfg,
    sendTest: async () => {
      cfg = loadNotifyConfig(); // pick up any .env edits
      await sendNotification(cfg, {
        title: 'EcoFlow · Test notification',
        body: 'Notifications are working. This is a test from the EcoFlow panel.',
        severity: 'info',
      });
      sentSinceStart++;
    },
    stats: () => ({ tracked: tracked.size, sentSinceStart }),
    history: () => [...clearedLog],
  };
}
