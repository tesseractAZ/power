import type { Alert } from './alerts.js';
import { DEFAULT_RATE_FLOOR_CONFIG } from './messageRateFloor.js';

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
  /** v1.187.10 — the rate and baseline when the episode first surfaced, frozen for its life
   *  (surfacedCollapseEntry). Absent: the live ones are the onset. */
  onset?: { rate: number | null; baseline: number };
  /** v1.187.10 — the live rate is back at or above the collapse floor (`floorFraction` ×
   *  baseline): the episode is waiting out its recovery dwell, not collapsed now. */
  recovering?: boolean;
}

/** v1.187.10 — the onset of each surfaced episode, by SN (the rate-floor tick owns the map). */
export type RateFloorOnsets = Map<string, { rate: number | null; baseline: number }>;

/**
 * v1.187.10 — the card entry for a surfaced collapse. The first surfacing of an episode freezes its
 * onset rate and baseline; every later tick republishes the live rate beside it and says whether
 * the rate is back above the floor (`starvedNow` false). The tick drops an SN's onset when its
 * episode ends (not collapsing, or offline). Before, the live rate alone was republished through
 * the 5-min recovery dwell and the closing card read "collapsed to 27.0 msg/min, far below its
 * learned ~25" (all 78 closing bodies in the ledger at or above the floor). MUTATES `onsets`.
 */
export function surfacedCollapseEntry(
  onsets: RateFloorOnsets,
  sn: string,
  deviceName: string,
  rate: number | null,
  baseline: number,
  starvedNow: boolean,
): RateFloorCollapse {
  let onset = onsets.get(sn);
  if (onset == null) {
    onset = { rate, baseline };
    onsets.set(sn, onset);
  }
  return { sn, deviceName, rate, baseline, onset, recovering: !starvedNow };
}

/**
 * v1.187.10 — the collapse log line, at WARN unless the roster mutes the device (`muteReason`: a
 * bench spare or an off-panel Core, rosterMuteReasonForSn). Its card is then on screen only — never
 * pushed or spoken — and a level-40 line telling the operator to check the cloud session and power
 * for hardware that cannot supply the house was noise in the triage scan (Core 3, off the panel
 * roster, 2026-10-02 11:03). The muted line is INFO and names the mute. Pure; exported for tests.
 */
export function rateFloorCollapseLine(
  c: { name: string; sn: string; rate: number | null; baseline: number; usedHourBucket: boolean; eligibilityPeak: number },
  muteReason: string | null,
): { level: 'warn' | 'info'; text: string } {
  const text =
    `msg-rate-floor: ${c.name} message rate collapsed to ` +
    `${c.rate?.toFixed(2) ?? '?'} msg/min (baseline ~${c.baseline.toFixed(0)}` +
    `${c.usedHourBucket ? ' for this hour' : ', global'}) — device is barely reporting ` +
    `while still appearing "fresh"; check the EcoFlow cloud session / power for ${c.sn} ` +
    `[eligibility mark ~${c.eligibilityPeak.toFixed(0)}]`;
  return muteReason == null
    ? { level: 'warn', text }
    : { level: 'info', text: `${text} — on screen only, not pushed or spoken (${muteReason})` };
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
  idleHeld = [];
}

/**
 * v1.158.0 — the subset of the published collapses that are HELD on an electrically
 * idle device that is not the alarm-path panel (exactly `selfHealQuorum`'s idleExcluded).
 *
 * A surfaced collapse is held through idleness by design (v1.111.0 anti-flap), and an idle
 * pack at ~4.7 msg/min can never clear the 10 msg/min recovery bar — so on 2026-09-13 three
 * such cards pushed at 21:51 and stood until 07:04-07:29, telling the operator to check the
 * cloud session and power on three packs whose session had been healthy since 21:41. The
 * CARD is unchanged (the episode is the same episode); only the PUSH dwell is held, and it
 * is re-earned once the device is active again — see pushDwellStart in alertMonitor.ts.
 */
let idleHeld: string[] = [];

export function setRateFloorIdleHeld(sns: readonly string[]): void {
  idleHeld = [...sns];
}

/** v1.184.0 — SNs currently held as idle (the starved-feed filter exempts them). */
export function rateFloorIdleHeldSns(): ReadonlySet<string> {
  return new Set(idleHeld);
}

/** Alert ids (not SNs) currently push-held as idle. */
export function rateFloorIdleHeldIds(): ReadonlySet<string> {
  return new Set(idleHeld.map(rateFloorAlertId));
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
  const fmt = (r: number | null) => (r != null ? r.toFixed(1) : '?');
  return collapses.map((c) => {
    const onset = c.onset ?? { rate: c.rate, baseline: c.baseline };
    // v1.187.10 — back above the floor: say so, with the onset figures, instead of "collapsed to
    // <a rate above the floor>, far below <a baseline below it>".
    const detail = c.recovering === true
      ? `${c.deviceName}'s incoming message RATE fell to ${fmt(onset.rate)} msg/min against its learned ` +
        `~${Math.round(onset.baseline)} msg/min baseline while it still looked "fresh". It is now ${fmt(c.rate)} msg/min, ` +
        `back above the collapse floor (~${(DEFAULT_RATE_FLOOR_CONFIG.floorFraction * c.baseline).toFixed(1)} msg/min) — recovering: ` +
        `the card clears once the rate has stayed at or above ` +
        `~${Math.max(DEFAULT_RATE_FLOOR_CONFIG.floorFraction * c.baseline, DEFAULT_RATE_FLOOR_CONFIG.minBaselineRate).toFixed(1)} msg/min ` +
        `for ${Math.round(DEFAULT_RATE_FLOOR_CONFIG.recoverMs / 60_000)} min.`
      : `${c.deviceName} is still sending occasional messages — so it looks "fresh" and neither the ` +
        `staleness nor the telemetry-gap detector fired — but its incoming message RATE has collapsed to ` +
        `${fmt(c.rate)} msg/min, far below its learned ~${Math.round(c.baseline)} msg/min ` +
        `baseline. On the SHP2 (the alarm data source) this means the floor/SoC/runway inputs are effectively stale ` +
        `while appearing live. Check the EcoFlow cloud session / power for this device; a power-cycle forces a clean reconnect.`;
    return {
      id: rateFloorAlertId(c.sn),
      severity: 'warning' as const,
      category: 'Connectivity' as const,
      device: c.deviceName,
      // Explicit ISA Medium (P3): operator-actionable but not an immediate hardware
      // danger — it must not read as a High protective-limit breach.
      priority: 'medium' as const,
      title: 'Device barely reporting (rate collapse)',
      detail,
      facts: [
        { label: 'Live rate', value: c.rate != null ? `${c.rate.toFixed(1)} msg/min` : '—' },
        { label: 'Baseline rate', value: `~${Math.round(c.baseline)} msg/min` },
        // v1.187.10 — the figures the episode surfaced on.
        ...(c.onset != null ? [{ label: 'Rate at onset', value: `${fmt(c.onset.rate)} msg/min (baseline ~${Math.round(c.onset.baseline)})` }] : []),
      ],
    };
  });
}
