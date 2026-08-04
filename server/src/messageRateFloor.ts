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
 * ---------------------------------------------------------------------------
 * v1.66.0 — DIURNAL REWRITE. The v0.92.0 design was wrong in BOTH directions, and
 * the 2026-08-02→04 logs contain a worked example of each. Do not "simplify" this
 * back to a single scalar baseline.
 *
 * The original header claimed: "The baseline is a slow EWMA updated ONLY from healthy
 * samples, so a collapse cannot drag the baseline down to meet itself." THAT WAS FALSE.
 * "Healthy" only meant `rate >= floorFraction * baseline` (20 %), so every sample in
 * [0.2·B, B) still dragged B down at alpha 0.2. On a RAMP-DOWN the baseline chased the
 * decline and the collapse never registered as one.
 *
 *   FALSE NEGATIVE (measured): Core baselines eroded 47 → 32 over two days. By 08-04
 *   they had fallen far enough that an 11.7 h fleet-wide collapse (Cores pinned at
 *   2.7-2.9 msg/min) fired NOTHING. The SHP2 fired only because it is flat-rate.
 *
 *   FALSE POSITIVE (measured): 08-03 19:24 Core 2 fired at 4.0 msg/min against a
 *   baseline of ~40 — but 19:00-22:00 is the Cores' legitimate idle window (measured
 *   4.4-6.2 msg/min every day). Its baseline simply had not eroded yet.
 *
 * Root cause of both: one scalar EWMA cannot describe a signal with a 13x diurnal
 * swing. Measured hour-of-day medians, msg/min:
 *   Cores  19:00-22:00 ≈ 4.6-6.2 (idle)   23:00-01:00 ≈ 32-34   08:00-18:00 ≈ 47-60
 *   SHP2   flat 30.0-30.7 at EVERY hour (no diurnal component at all)
 * Legitimate Core idle (4.4) and a real collapse (2.1-2.9) are only ~1.5x apart, so no
 * single global threshold can separate them. The hour-of-day IS the discriminator.
 *
 * So: the comparison baseline is a per-hour-of-day EWMA, matching the established
 * convention in analytics.ts (see BASELINE_MIN_SAMPLES, "hour-of-day … so daily cycles
 * don't false-alarm"). Hour is read from the injected clock via `new Date(ms).getHours()`
 * — process-local, exactly like every other hour-of-day consumer in this codebase; the
 * add-on container runs in plant-local time.
 * ---------------------------------------------------------------------------
 *
 * Design guards against false positives:
 *  - Only devices that SUSTAIN a high baseline (>= MIN_BASELINE_RATE msg/min) are ever
 *    eligible — a normally-quiet device can't "collapse". The SHP2 (~30/min) qualifies;
 *    idle/spare units never do.
 *  - The hour bucket is asymmetric: it rises at `baselineAlpha` but decays at
 *    `baselineAlphaDown` (10x slower), so a ramp-down cannot walk the bucket down to
 *    meet the collapse. It is NOT frozen — a genuine permanent slowdown still converges,
 *    just over days rather than minutes.
 *  - A bucket is only trusted once it holds `minHourSamples` healthy samples; until then
 *    the tracker falls back to the global EWMA (the v0.92.0 behaviour). The global stays
 *    SYMMETRIC on purpose: while buckets are immature it must track the diurnal swing, or
 *    a sticky global would re-create the 19:24 false positive on day one.
 *  - A collapse must PERSIST >= COLLAPSE_MS before it fires, and a recovery must persist
 *    >= RECOVER_MS before it clears. v0.92.0 was 20 min to fire but ONE sample to clear —
 *    a 20:1 asymmetry in the wrong direction for a safety detector, which cost 27 min of
 *    silence inside the 08-04 episode and let a device emitting 5 messages once every
 *    <=19 min evade the detector entirely. Both edges are now dwelled.
 */

export interface RateFloorConfig {
  /** Min learned baseline (msg/min) for a device to be eligible for the floor. */
  minBaselineRate: number;
  /** Collapse trips when the live rate falls below this fraction of the baseline. */
  floorFraction: number;
  /** A collapse must persist at least this long before it fires. */
  collapseMs: number;
  /** A recovery must persist at least this long before a fired collapse clears. */
  recoverMs: number;
  /** EWMA smoothing for the baseline when the rate is AT OR ABOVE it (0..1). */
  baselineAlpha: number;
  /** EWMA smoothing for an hour bucket when the rate is BELOW it. Deliberately slow. */
  baselineAlphaDown: number;
  /** Healthy samples an hour bucket needs before it outranks the global baseline. */
  minHourSamples: number;
}

export const DEFAULT_RATE_FLOOR_CONFIG: RateFloorConfig = {
  minBaselineRate: Number(process.env.MSG_RATE_FLOOR_MIN_BASELINE ?? 10),
  floorFraction: Number(process.env.MSG_RATE_FLOOR_FRACTION ?? 0.2),
  collapseMs: Number(process.env.MSG_RATE_FLOOR_COLLAPSE_MIN ?? 20) * 60_000,
  recoverMs: Number(process.env.MSG_RATE_FLOOR_RECOVER_MIN ?? 5) * 60_000,
  baselineAlpha: 0.2,
  baselineAlphaDown: 0.02,
  minHourSamples: Number(process.env.MSG_RATE_FLOOR_MIN_HOUR_SAMPLES ?? 30),
};

export interface RateSampleResult {
  /** Live rate this sample, msg/min (null until two samples exist). */
  rate: number | null;
  /** The baseline the collapse test actually used, msg/min (hour bucket or global). */
  baseline: number;
  /** True on the tick a sustained collapse first fires (edge-triggered). */
  collapsed: boolean;
  /** True on the tick a device recovers from a fired collapse. */
  recovered: boolean;
  /** True while a fired collapse is ongoing. */
  collapsing: boolean;
  /** True when `baseline` came from a matured hour-of-day bucket rather than the global. */
  usedHourBucket: boolean;
  /**
   * True on the tick a device that WAS eligible drops below minBaselineRate. v0.92.0
   * made this transition completely silently, which is how three Cores went unmonitored
   * without a single log line. The caller logs it.
   */
  eligibilityLost: boolean;
}

interface SnState {
  lastCount: number;
  lastMs: number;
  /** Global EWMA — symmetric, tracks the diurnal swing, cold-start fallback only. */
  baseline: number;
  /** Per-hour-of-day EWMA, asymmetric (fast up / slow down). Index 0..23. */
  hourly: number[];
  /** Healthy-sample count per hour bucket; a bucket is trusted at minHourSamples. */
  hourlyN: number[];
  collapseSinceMs: number | null;
  recoverSinceMs: number | null;
  fired: boolean;
  wasEligible: boolean;
}

/** Serialisable form — the caller persists this so buckets survive the ~6 restarts/day. */
export interface RateFloorPersisted {
  [sn: string]: { baseline: number; hourly: number[]; hourlyN: number[] };
}

const HOURS = 24;
const zeros = (): number[] => new Array(HOURS).fill(0);

function freshState(count: number, nowMs: number, baseline = 0): SnState {
  return {
    lastCount: count,
    lastMs: nowMs,
    baseline,
    hourly: zeros(),
    hourlyN: zeros(),
    collapseSinceMs: null,
    recoverSinceMs: null,
    fired: false,
    wasEligible: false,
  };
}

export class RateFloorTracker {
  private readonly cfg: RateFloorConfig;
  private readonly bySn = new Map<string, SnState>();

  constructor(cfg: RateFloorConfig = DEFAULT_RATE_FLOOR_CONFIG) {
    this.cfg = cfg;
  }

  /**
   * Restore learned baselines from a previous process. Counters/timers are NOT restored —
   * only what was learned. A restart must never resurrect a stale in-flight collapse.
   */
  hydrate(saved: RateFloorPersisted | null | undefined): void {
    if (!saved || typeof saved !== 'object') return;
    for (const [sn, v] of Object.entries(saved)) {
      if (!v || typeof v !== 'object') continue;
      const hourly = Array.isArray(v.hourly) && v.hourly.length === HOURS ? v.hourly.map((n) => (Number.isFinite(n) && n >= 0 ? n : 0)) : zeros();
      const hourlyN = Array.isArray(v.hourlyN) && v.hourlyN.length === HOURS ? v.hourlyN.map((n) => (Number.isFinite(n) && n >= 0 ? n : 0)) : zeros();
      const baseline = Number.isFinite(v.baseline) && v.baseline >= 0 ? v.baseline : 0;
      // lastCount/lastMs stay unset until the first live sample: the message counter
      // re-zeroes on restart, so any carried-over count would compute a bogus rate.
      const st = freshState(0, 0, baseline);
      st.hourly = hourly;
      st.hourlyN = hourlyN;
      st.lastMs = -1; // sentinel: "no live sample yet"
      this.bySn.set(sn, st);
    }
  }

  /** Snapshot the learned baselines for persistence. */
  toJSON(): RateFloorPersisted {
    const out: RateFloorPersisted = {};
    for (const [sn, st] of this.bySn) {
      out[sn] = { baseline: st.baseline, hourly: st.hourly.slice(), hourlyN: st.hourlyN.slice() };
    }
    return out;
  }

  /** Feed the current cumulative message count for a device. */
  sample(sn: string, cumulativeCount: number, nowMs: number): RateSampleResult {
    const prev = this.bySn.get(sn);
    const idle = (baseline: number, usedHourBucket = false): RateSampleResult => ({
      rate: null, baseline, collapsed: false, recovered: false, collapsing: false, usedHourBucket, eligibilityLost: false,
    });

    if (!prev) {
      this.bySn.set(sn, freshState(cumulativeCount, nowMs));
      return idle(0);
    }
    // Hydrated-but-unsampled: adopt the live counter without computing a rate off the
    // sentinel, keeping the learned buckets.
    if (prev.lastMs < 0) {
      prev.lastCount = cumulativeCount;
      prev.lastMs = nowMs;
      this.bySn.set(sn, prev);
      return idle(prev.baseline);
    }
    const dtMin = (nowMs - prev.lastMs) / 60_000;
    if (dtMin <= 0) {
      return { ...idle(prev.baseline), collapsing: prev.fired };
    }
    // A counter reset (process restart re-zeroes mqttMsgCountBySn) → re-baseline
    // rather than compute a negative/huge rate. Learned buckets are preserved.
    if (cumulativeCount < prev.lastCount) {
      const next = { ...prev, lastCount: cumulativeCount, lastMs: nowMs, collapseSinceMs: null, recoverSinceMs: null, fired: false };
      this.bySn.set(sn, next);
      return { ...idle(prev.baseline), recovered: prev.fired };
    }
    const rate = Math.max(0, (cumulativeCount - prev.lastCount) / dtMin);
    const hour = new Date(nowMs).getHours();

    // Prefer this hour's learned bucket once it is mature; otherwise the global EWMA.
    const bucket = prev.hourly[hour];
    const usedHourBucket = prev.hourlyN[hour] >= this.cfg.minHourSamples && bucket > 0;
    const cmpBaseline = usedHourBucket ? bucket : prev.baseline;

    const eligible = cmpBaseline >= this.cfg.minBaselineRate;
    const isCollapsed = eligible && rate < this.cfg.floorFraction * cmpBaseline;

    // Learn only from samples that are NOT a collapse — but each estimator is gated on
    // ITS OWN view, never on the other's.
    //
    // ★ Gating the bucket on the GLOBAL view is a bootstrap deadlock, and it is subtle
    //   enough to be worth spelling out: the Cores idle at ~5 msg/min from 19:00-22:59
    //   while the global baseline sits at ~50 from the busy hours. Judged against the
    //   global, every idle sample "is a collapse" — so the 19:00-22:00 buckets would
    //   never be allowed to learn, would stay at 0, would never mature, and the idle
    //   window would false-fire against the global FOREVER. That is precisely the
    //   08-03 19:24 Core 2 false positive this rewrite exists to kill.
    let baseline = prev.baseline;
    const hourly = prev.hourly.slice();
    const hourlyN = prev.hourlyN.slice();

    // Global: symmetric — it must follow the diurnal swing while buckets are immature.
    const globalCollapsed = prev.baseline >= this.cfg.minBaselineRate && rate < this.cfg.floorFraction * prev.baseline;
    if (!globalCollapsed) {
      baseline = prev.baseline === 0 ? rate : this.cfg.baselineAlpha * rate + (1 - this.cfg.baselineAlpha) * prev.baseline;
    }

    // Hour bucket: asymmetric — rises at alpha, decays 10x slower, so a ramp-down cannot
    // walk it down to meet the collapse (the v0.92.0 defect). An IMMATURE bucket has no
    // opinion yet, so it always learns; only a mature bucket can veto its own update.
    // Bootstrap exposure, accepted: a collapse spanning an hour whose bucket is still
    // immature teaches that hour a low baseline. It is self-correcting — the upward alpha
    // is 10x the downward one — and bounded to the first day of that hour, because the
    // learned buckets are persisted across restarts.
    const bucketCollapsed = usedHourBucket && rate < this.cfg.floorFraction * bucket;
    if (!bucketCollapsed) {
      const a = bucket === 0 ? 1 : rate >= bucket ? this.cfg.baselineAlpha : this.cfg.baselineAlphaDown;
      hourly[hour] = a * rate + (1 - a) * bucket;
      hourlyN[hour] = prev.hourlyN[hour] + 1;
    }

    let collapseSinceMs = prev.collapseSinceMs;
    let recoverSinceMs = prev.recoverSinceMs;
    let fired = prev.fired;
    let collapsed = false;
    let recovered = false;

    if (isCollapsed) {
      recoverSinceMs = null;
      if (collapseSinceMs == null) collapseSinceMs = prev.lastMs; // count from the last healthy sample
      if (!fired && nowMs - collapseSinceMs >= this.cfg.collapseMs) {
        fired = true;
        collapsed = true;
      }
    } else {
      // Dwell BOTH edges. A single healthy sample no longer resets the pre-fire timer
      // (the "5 messages every 19 min" evasion) nor clears a fired collapse (the 08-04
      // 05:06 burst, which bought 27 min of silence mid-episode).
      if (recoverSinceMs == null) recoverSinceMs = nowMs;
      if (nowMs - recoverSinceMs >= this.cfg.recoverMs) {
        if (fired) recovered = true;
        fired = false;
        collapseSinceMs = null;
        recoverSinceMs = null;
      }
    }

    this.bySn.set(sn, { lastCount: cumulativeCount, lastMs: nowMs, baseline, hourly, hourlyN, collapseSinceMs, recoverSinceMs, fired, wasEligible: eligible });
    return {
      rate,
      baseline: cmpBaseline,
      collapsed,
      recovered,
      collapsing: fired,
      usedHourBucket,
      eligibilityLost: prev.wasEligible && !eligible,
    };
  }

  /** For diagnostics/tests. */
  baselineOf(sn: string): number {
    return this.bySn.get(sn)?.baseline ?? 0;
  }

  /** For diagnostics/tests — the learned bucket for one hour-of-day. */
  hourBaselineOf(sn: string, hour: number): number {
    return this.bySn.get(sn)?.hourly[hour] ?? 0;
  }
}
