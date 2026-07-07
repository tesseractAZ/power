import type { Alert } from './alerts.js';

/**
 * v0.93.0 (audit #1 phase-2) — message-RATE floor SELF-ALERT.
 *
 * v0.92.0 added the RateFloorTracker (messageRateFloor.ts) + a 60 s tick in
 * index.ts that only `app.log.warn`-ed when a normally-chatty device's incoming
 * message RATE collapsed below its learned baseline while `lastUpdated` stayed
 * fresh (the SHP2 ~13 h crawl that defeated BOTH the staleness and recorder-gap
 * detectors). A WARN in the add-on log is invisible to the operator; the SHP2 is
 * the single-point-critical alarm DATA SOURCE, so a silent rate-collapse is a
 * real blind spot that deserves a push.
 *
 * This module mirrors broadcastHealth.ts EXACTLY: the 60 s tick publishes the set
 * of currently-collapsing devices here; the alert engine (alertMonitor.ts) turns
 * that set into one WARNING Alert per collapsing device that flows through the
 * SAME notify + snapshot.alerts pipeline as the offline/stale alerts. It is NOT
 * `annunciate:false` — it rides the working push channel like offline/stale do.
 *
 * Severity is WARNING / priority MEDIUM (NOT critical): a rate-collapse is serious
 * but push is the right channel — it must reach the operator without breaking
 * through quiet hours as a full emergency. The id is STABLE per device
 * (`msg-rate-floor-<sn>`) so it de-dups across ticks and simply drops from the
 * set on recovery (a standing condition, not a retrospective event).
 */

/** One collapsing device, as published by the rate-floor tick. */
export interface RateFloorCollapse {
  sn: string;
  deviceName: string;
  /** Live rate at the collapse (msg/min), null if not yet computed. */
  rate: number | null;
  /** Learned healthy baseline (msg/min). */
  baseline: number;
}

let current: RateFloorCollapse[] = [];

/** Publish the CURRENT set of collapsing devices (empty ⇒ nothing collapsing). */
export function setRateFloorCollapses(collapses: RateFloorCollapse[]): void {
  current = collapses;
}

export function getRateFloorCollapses(): RateFloorCollapse[] {
  return current;
}

/** Reset to the empty state (used by tests). */
export function resetRateFloorCollapses(): void {
  current = [];
}

/** Stable id prefix — one alert per device, dedup + resolve keyed on it. */
export function rateFloorAlertId(sn: string): string {
  return `msg-rate-floor-${sn}`;
}

export function isRateFloorAlert(alert: Pick<Alert, 'id'>): boolean {
  return alert.id.startsWith('msg-rate-floor-');
}

/**
 * Pure builder: one WARNING push Alert per currently-collapsing device. Returns
 * [] when nothing is collapsing. Deterministic (no clock read) so it unit-tests
 * without a fake timer — the tick owns the timing (persist/edge) via the tracker.
 */
export function rateFloorAlerts(collapses: RateFloorCollapse[]): Alert[] {
  return collapses.map((c) => ({
    id: rateFloorAlertId(c.sn),
    severity: 'warning' as const,
    category: 'Connectivity' as const,
    device: c.deviceName,
    // Explicit ISA Medium (P3): operator-actionable but not an immediate hardware
    // danger — it must not read as a High protective-limit breach.
    priority: 'medium' as const,
    title: 'Device barely reporting (rate collapse)',
    detail:
      `${c.deviceName} is still sending occasional messages — so it looks "fresh" and neither the ` +
      `staleness nor the telemetry-gap detector fired — but its incoming message RATE has collapsed to ` +
      `${c.rate != null ? c.rate.toFixed(1) : '?'} msg/min, far below its learned ~${Math.round(c.baseline)} msg/min ` +
      `baseline. On the SHP2 (the alarm data source) this means the floor/SoC/runway inputs are effectively stale ` +
      `while appearing live. Check the EcoFlow cloud session / power for this device; a power-cycle forces a clean reconnect.`,
    facts: [
      { label: 'Live rate', value: c.rate != null ? `${c.rate.toFixed(1)} msg/min` : '—' },
      { label: 'Baseline rate', value: `~${Math.round(c.baseline)} msg/min` },
    ],
  }));
}
