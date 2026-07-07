/**
 * v0.92.0 — message-RATE floor detector.
 *
 * The staleness alarm (alerts.ts) and the recorder gap detector (recorder.ts) both
 * key off the TIME since the last message. A device can defeat BOTH by still sending
 * something — the live audit caught the SHP2 crawling at ~0.24 msg/min for ~13 h
 * (150x below its ~30 msg/min norm): its ~5-min heartbeat kept `lastUpdated` under the
 * 180 s stale threshold AND under the 15-min gap threshold, so neither fired while the
 * device was effectively not reporting. The SHP2 is the single-point-critical alarm
 * DATA SOURCE (floor / SoC / runway), so a silent rate-collapse is a real blind spot.
 *
 * This tracker watches the per-SN cumulative message count (store.mqttMsgCountBySn) and
 * flags a device whose incoming message RATE has collapsed well below its own learned
 * baseline for a sustained window — even while `lastUpdated` stays fresh. It is pure and
 * deterministic (time is injected) so it unit-tests without a clock.
 *
 * Design guards against false positives:
 *  - Only devices that SUSTAIN a high baseline (>= MIN_BASELINE_RATE msg/min) are ever
 *    eligible — a normally-quiet device can't "collapse". The SHP2 (~30/min) qualifies;
 *    idle/spare units never do.
 *  - The baseline is a slow EWMA updated ONLY from healthy samples, so a collapse cannot
 *    drag the baseline down to meet itself.
 *  - A collapse must PERSIST >= COLLAPSE_MS before it fires (rides out a brief burst gap),
 *    and fires once (edge-triggered), then clears on recovery.
 */

export interface RateFloorConfig {
  /** Min learned baseline (msg/min) for a device to be eligible for the floor. */
  minBaselineRate: number;
  /** Collapse trips when the live rate falls below this fraction of the baseline. */
  floorFraction: number;
  /** A collapse must persist at least this long before it fires. */
  collapseMs: number;
  /** EWMA smoothing for the baseline (0..1; higher = faster adaptation). */
  baselineAlpha: number;
}

export const DEFAULT_RATE_FLOOR_CONFIG: RateFloorConfig = {
  minBaselineRate: Number(process.env.MSG_RATE_FLOOR_MIN_BASELINE ?? 10),
  floorFraction: Number(process.env.MSG_RATE_FLOOR_FRACTION ?? 0.2),
  collapseMs: Number(process.env.MSG_RATE_FLOOR_COLLAPSE_MIN ?? 20) * 60_000,
  baselineAlpha: 0.2,
};

export interface RateSampleResult {
  /** Live rate this sample, msg/min (null until two samples exist). */
  rate: number | null;
  /** Current learned baseline, msg/min. */
  baseline: number;
  /** True on the tick a sustained collapse first fires (edge-triggered). */
  collapsed: boolean;
  /** True on the tick a device recovers from a fired collapse. */
  recovered: boolean;
  /** True while a fired collapse is ongoing. */
  collapsing: boolean;
}

interface SnState {
  lastCount: number;
  lastMs: number;
  baseline: number;
  collapseSinceMs: number | null;
  fired: boolean;
}

export class RateFloorTracker {
  private readonly cfg: RateFloorConfig;
  private readonly bySn = new Map<string, SnState>();

  constructor(cfg: RateFloorConfig = DEFAULT_RATE_FLOOR_CONFIG) {
    this.cfg = cfg;
  }

  /** Feed the current cumulative message count for a device. */
  sample(sn: string, cumulativeCount: number, nowMs: number): RateSampleResult {
    const prev = this.bySn.get(sn);
    if (!prev) {
      this.bySn.set(sn, { lastCount: cumulativeCount, lastMs: nowMs, baseline: 0, collapseSinceMs: null, fired: false });
      return { rate: null, baseline: 0, collapsed: false, recovered: false, collapsing: false };
    }
    const dtMin = (nowMs - prev.lastMs) / 60_000;
    if (dtMin <= 0) {
      return { rate: null, baseline: prev.baseline, collapsed: false, recovered: false, collapsing: prev.fired };
    }
    // A counter reset (process restart re-zeroes mqttMsgCountBySn) → re-baseline
    // rather than compute a negative/huge rate.
    if (cumulativeCount < prev.lastCount) {
      this.bySn.set(sn, { lastCount: cumulativeCount, lastMs: nowMs, baseline: prev.baseline, collapseSinceMs: null, fired: false });
      return { rate: null, baseline: prev.baseline, collapsed: false, recovered: prev.fired, collapsing: false };
    }
    const rate = Math.max(0, (cumulativeCount - prev.lastCount) / dtMin);

    const eligible = prev.baseline >= this.cfg.minBaselineRate;
    const isCollapsed = eligible && rate < this.cfg.floorFraction * prev.baseline;

    // Update the baseline only from HEALTHY samples so a collapse can't erode it.
    let baseline = prev.baseline;
    if (!isCollapsed) {
      baseline = prev.baseline === 0 ? rate : this.cfg.baselineAlpha * rate + (1 - this.cfg.baselineAlpha) * prev.baseline;
    }

    let collapseSinceMs = prev.collapseSinceMs;
    let fired = prev.fired;
    let collapsed = false;
    let recovered = false;

    if (isCollapsed) {
      if (collapseSinceMs == null) collapseSinceMs = prev.lastMs; // count from the last healthy sample
      if (!fired && nowMs - collapseSinceMs >= this.cfg.collapseMs) {
        fired = true;
        collapsed = true;
      }
    } else {
      if (fired) recovered = true;
      collapseSinceMs = null;
      fired = false;
    }

    this.bySn.set(sn, { lastCount: cumulativeCount, lastMs: nowMs, baseline, collapseSinceMs, fired });
    return { rate, baseline, collapsed, recovered, collapsing: fired };
  }

  /** For diagnostics/tests. */
  baselineOf(sn: string): number {
    return this.bySn.get(sn)?.baseline ?? 0;
  }
}
