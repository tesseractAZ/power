/**
 * chargeTaper.ts — where the packs stop taking solar, and how much solar a charge must leave
 * room for. PURE (no imports, no clock).
 *
 * THE TAPER. Curtailment does not begin AT a Core's charge ceiling (`chgMaxSoc`), it begins in
 * the CV/absorption taper BELOW it. As the LFP packs approach full, charge acceptance falls and
 * the DPU backs off its MPPTs to match (load + dwindling charge current) — shedding the LV string
 * first. Live evidence from Core 3 (ceiling 100): the LV MPPT held ~900-1060 W all day, then
 * collapsed 698 W → 0 W as SoC climbed 88 → 90 %, while HV only throttled partially. So real PV
 * rejection starts ~10 % below the ceiling, not 2 %: the saturation threshold is
 * `ceiling − CURTAIL_TAPER_BAND_PCT`. The curtailment engine, the soiling detector's taper hours
 * (analytics.ts) and the mid-day charge ceiling all read it from here.
 *
 * THE HEADROOM. A grid charge that fills the pool past the taper before the sun is done throws
 * that sun away. The overnight cost ceiling leaves room for the median surplus over the morning
 * after the window (window close → +MORNING_SURPLUS_HOURS); a mid-day window closes at 15:00 with
 * the morning already behind it, so its headroom is the surplus from the close to the on-peak
 * start, under the taper rather than under full (`taperCeilingKwh`).
 */

/** SoC band below the ceiling where PV shedding begins (see the header). */
export const CURTAIL_TAPER_BAND_PCT = 10;
/** The ceiling assumed when no Core reports one: the EcoFlow default. */
export const DEFAULT_CHARGE_CEILING_PCT = 100;

/** The SoC at/above which the pool enters the charge-taper band where PV shedding begins
 *  (curtailment can occur): `ceiling − taper band`. When no ceiling is reported we assume 100
 *  (the EcoFlow default), so the fallback threshold is 90 — consistent with the taper-aware model
 *  rather than the old fixed 96. */
export function saturationThresholdPct(ceiling: number | null): number {
  const eff = ceiling != null && ceiling > 0 ? ceiling : DEFAULT_CHARGE_CEILING_PCT;
  return Math.max(0, eff - CURTAIL_TAPER_BAND_PCT);
}

/**
 * The pool's effective charge ceiling (%): the mean of the Cores' configured `chgMaxSoc`, the
 * ones that report one (> 0). Null when none does. Mean (not min) is the physically correct pool
 * aggregate — it is compared against mean SoC, and the pool is "saturated" only when the average
 * has reached the average ceiling (every DPU at its own limit). In the common case all DPUs share
 * one ceiling, so the mean is that value.
 */
export function meanChargeCeilingPct(ceilings: ReadonlyArray<number | null | undefined>): number | null {
  const reported = ceilings.filter((v): v is number => v != null && v > 0);
  if (reported.length === 0) return null;
  return reported.reduce((s, v) => s + v, 0) / reported.length;
}

/** How far past an overnight window's close the morning surplus reaches. */
export const MORNING_SURPLUS_HOURS = 14;
const HOUR_MS = 3_600_000;

/**
 * The end of the span whose PV surplus a window's cost ceiling leaves room for: an overnight
 * window's close + MORNING_SURPLUS_HOURS (the next solar day); a super off-peak window's close to
 * the on-peak start after it (15:00 → 16:00 on a weekday), the hours the sun can still fill the
 * pool before the dearest ones. No on-peak start known ⇒ the overnight span.
 */
export function surplusSpanEndMs(
  kind: 'overnight' | 'super_off_peak', windowEndMs: number, nextOnPeakStartMs: number | null,
): number {
  if (kind === 'super_off_peak' && nextOnPeakStartMs != null && Number.isFinite(nextOnPeakStartMs) && nextOnPeakStartMs >= windowEndMs) {
    return nextOnPeakStartMs;
  }
  return windowEndMs + MORNING_SURPLUS_HOURS * HOUR_MS;
}

/** One hour of the probabilistic PV band (analytics' ProbabilisticForecast hours). */
export interface SurplusBandHour {
  ts: number;
  p90W: number;
  p50W?: number | null;
}

/**
 * The PV surplus over [fromMs, toMs), kWh, from the probabilistic band and the forecast load:
 * Σ max(0, P90 PV − load) and Σ max(0, P50 PV − load) over the band hours inside the span that
 * have a load (`loadAt`). `p90Kwh` is null when no band hour in the span has a load; `p50Kwh` is
 * null then too, and whenever a covered hour has no finite P50 — absence of a median is not a
 * median of zero. Rounded to 0.01 kWh. (The loop the planner ran inline until R2.)
 */
export function pvSurplusFromBand(o: {
  hours: ReadonlyArray<SurplusBandHour>;
  loadAt: (ts: number) => number | null | undefined;
  fromMs: number;
  toMs: number;
}): { p90Kwh: number | null; p50Kwh: number | null } {
  let p90 = 0;
  let p50 = 0;
  let p50Complete = true;
  let hasData = false;
  for (const pb of o.hours) {
    if (pb.ts < o.fromMs || pb.ts >= o.toMs) continue;
    const loadW = o.loadAt(pb.ts);
    if (loadW == null) continue;
    hasData = true;
    p90 += Math.max(0, pb.p90W - loadW) / 1000;
    if (typeof pb.p50W === 'number' && Number.isFinite(pb.p50W)) {
      p50 += Math.max(0, pb.p50W - loadW) / 1000;
    } else {
      p50Complete = false;
    }
  }
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    p90Kwh: hasData ? round2(p90) : null,
    p50Kwh: hasData && p50Complete ? round2(p50) : null,
  };
}

/**
 * The PV-curtail ceiling, kWh of pool: the taper line (`curtailFromPct`, the saturation threshold
 * of the pool's charge ceiling) less the PV surplus still to come, so the sun that follows the
 * charge fills the pool to the taper and no further. `surplusKwh` null (no surplus known) ⇒ the
 * taper line itself. Never below 0.
 */
export function taperCeilingKwh(fullKwh: number, curtailFromPct: number, surplusKwh: number | null | undefined): number {
  const taperKwh = (fullKwh * Math.max(0, Math.min(100, curtailFromPct))) / 100;
  const surplus = surplusKwh != null && Number.isFinite(surplusKwh) ? Math.max(0, surplusKwh) : 0;
  return Math.max(0, taperKwh - surplus);
}
