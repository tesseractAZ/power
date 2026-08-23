/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargeGate.ts — the night-charge WRITE-READINESS gate (WS3).
 *
 * v2 gate (v1.50.0, per docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md §5 as amended by
 * the 2026-07-31 supervised-write redesign). Still a PURE reduction over the
 * ONE durable ledger table (`night_charge_ledger`, §3.1), surfaced as one enum
 * + a boolean + a "what's blocking" list — but the evidence base is ACTUATED
 * nights (a bounded reserve write was applied and its delivery measured), not
 * the v1 clean-islanded-baseline nights that a grid-tied home can never
 * produce (overnight import props the SoC on every night, freezing
 * scoredDays=0 and making the v1 gate structurally unopenable).
 *
 * ★★ SAFETY POSTURE (binding):
 *  - The gate NEVER performs a write. `writeReady` gates only the AUTO mode
 *    (unattended writes). SUPERVISED mode is a separate, explicit owner
 *    action in the add-on configuration with a per-night cancel window; it is
 *    how the actuated evidence this gate reduces over gets produced at all.
 *  - FAIL-CLOSED (I13): missing/thin/young data ⇒ LEARNING / writeReady=false,
 *    never null-as-ready.
 *  - Engine-fault strikes hard-block AUTO. v2 strike semantics: a strike
 *    requires the plan to have CLAIMED it could hold floor+cushion
 *    (`cushion_shortfall` falsy — a NULL/legacy row still counts as claimed,
 *    fail-closed) AND either the plan's own simulated trajectory breached
 *    (§3.3) or an actuated night's REALIZED outcome breached. A plan that
 *    honestly disclosed `cushionShortfall` is physics, not fault — exempt.
 *  - Strikes live in a rolling 45-day window and are additionally cleared by
 *    14 consecutive strike-free actuated nights — escapable by demonstrated
 *    performance, never by waiting alone within the window.
 *  - Prior-`algo_version` rows are EXCLUDED (not merely tagged): a planner
 *    physics fix (§0.2) changes the meaning of every prior row. v1.49.0's
 *    corrected charge-only-cap sizing model is exactly such a fix — hence
 *    CURRENT_ALGO_VERSION = 2, which also retires the v1-era strike rows that
 *    were scored against the broken sizing model.
 *
 * Pure reduction: no I/O, no clock reads (nowMs injected), no globals touched
 * except the explicit latest-readiness holder used by the delivery surfaces.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { NightLedgerRow } from './recorder.js';

const DAY_MS = 86_400_000;

// ── v1.39.0 pure Phoenix-date helpers for the expected-nights MNAR denominator ──
/** YYYY-MM-DD of an instant in America/Phoenix. v1.39.1: built from en-US
 *  formatToParts — the house pattern (fmtPhoenixHm / phoenixMinuteOfDay /
 *  localParts) — NOT the en-CA format() shortcut: on a Node whose ICU lacks
 *  en-CA the locale silently falls back to a non-ISO date shape, addDaysYmd
 *  then builds an Invalid Date, and toISOString() THROWS — swallowed by the
 *  fail-safe catches, leaving readiness permanently null on the live Pi while
 *  every full-ICU dev machine passed. en-US parts are locale-fallback-proof. */
export function phoenixYmd(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function ymdToUtcMs(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return NaN; // malformed — caller guards
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function addDaysYmd(ymd: string, days: number): string {
  const base = ymdToUtcMs(ymd);
  if (!Number.isFinite(base)) return ymd; // defensive: never throw from a date helper
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}
function daysBetweenYmdInclusive(a: string, b: string): number {
  return Math.round((ymdToUtcMs(b) - ymdToUtcMs(a)) / DAY_MS) + 1;
}
function maxYmd(a: string, b: string): string { return a >= b ? a : b; }

/* ── Pre-registered, FROZEN thresholds (§5.1/§5.2 as amended 2026-07-31).
 *    Never tuned on the season the gate gates (garden-of-forking-paths); a
 *    later re-tune bumps CURRENT_ALGO_VERSION and resets the readiness clock. ── */

/** Bumped on ANY planner physics/algorithm change (§0.2). Prior-version ledger
 *  rows are excluded and the evidence clock resets. v2: the v1.49.0 sizing
 *  correction (charge cap is CHARGE-ONLY; the home bypasses to grid during
 *  charge hours) — every v1 row's plan, trajectory, and strike verdict was
 *  produced by the superseded physics.
 *
 *  v3 (v1.105.0): `buy_err_kwh` REDEFINED onto the planner-sizing basis. Every
 *  v2 row's value was `planBuy − (delivered + troughDeficit)` — a hybrid that
 *  answered neither "did the planner size right?" nor "did delivery meet the
 *  need?", counted the actuator's by-design over-delivery as under-buy, and
 *  anchored on a trough that is really the reverted reserve setpoint. Those
 *  values are not comparable with v3's, so they are excluded and the evidence
 *  clock resets to zero. This is the cost of the correction and it is
 *  deliberate: 16 nights of an unusable metric are worth less than a clean
 *  start on a sound one. */
export const CURRENT_ALGO_VERSION = 3;

/** Graduation floor: scored ACTUATED nights (a bounded reserve write applied,
 *  delivery measured) before AUTO is considerable. ~3 weeks at one per night. */
const MIN_ACTUATED_NIGHTS = 21;

/** Enough actuated nights to even JUDGE the under-buy rate as a hard safety
 *  signal. Below this we are still LEARNING, not BLOCKED, on under-buy. */
const MIN_NIGHTS_TO_JUDGE_UNDERBUY = 5;

/** Under-buy is a SAFETY miss (§5.1 HARD, asymmetric): recommended kWh must be
 *  ≥ realized need on ≥90% of actuated nights → under-buy fraction ≤ 0.10. */
const MAX_UNDERBUY_RATE = 0.10;

/** v1.105.0 — kWh deadband on the under-buy classifier. Below this a negative
 *  residual is rounding noise, not a safety miss. */
const UNDERBUY_DEADBAND_KWH = 0.5;

/** Signed delivery bias must sit in a SLIGHT over-buy band (§5.1): never net
 *  under, never a gross over-buy. kWh at the meter. */
const BUY_BIAS_MIN_KWH = 0;
const BUY_BIAS_MAX_KWH = 5;

/** Realized PV/load in-band fraction must land in [78%, 92%] (§5.1), judged
 *  over captured forecast-tier nights once the sample is large enough to mean
 *  anything. */
const BAND_COVERAGE_MIN = 0.78;
const BAND_COVERAGE_MAX = 0.92;
const MIN_COVERAGE_NIGHTS = 14;

/** Engine-fault strikes: rolling evidence window, and the demonstrated-
 *  performance escape (consecutive strike-free actuated nights). */
const STRIKE_WINDOW_DAYS = 45;
const STRIKE_CLEAR_STREAK = 14;

export type NightChargeReadinessState =
  | 'LEARNING'
  | 'READY_TO_CONSIDER_WRITES'
  | 'BLOCKED';

export interface NightChargeReadiness {
  state: NightChargeReadinessState;
  writeReady: boolean;
  /** Human-readable reasons the gate is not READY (empty iff READY). */
  blocking: string[];
  /** v2: count of scored ACTUATED nights (the gate's evidence base). */
  scoredDays: number;
  /** Autocorrelation-adjusted independent nights (§5.2), off the PV residual
   *  series of captured forecast nights — diagnostic. */
  effectiveN: number;
  /** All computed sub-metrics; null where the sample cannot support them. */
  metrics: Record<string, number | null>;
}

export interface NightChargeReadinessOpts {
  /** Override the current algo version (rows with a different algo_version are
   *  excluded). Defaults to CURRENT_ALGO_VERSION. */
  algoVersion?: number;
}

/* ── Defensive coercion — ledger booleans may persist as 0/1 or true/false ─── */
function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function truthy(v: unknown): boolean {
  return v === true || v === 1;
}
function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Autocorrelation-adjusted effective sample size (§5.2). Positive lag-1
 *  autocorrelation deflates the count (correlated cloudy runs are NOT
 *  independent evidence); negative autocorrelation is clamped to 0 so it can
 *  only ever REDUCE, never inflate, the evidence (fail-safe). */
function effectiveSampleSize(series: number[]): number {
  const n = series.length;
  if (n < 2) return n;
  const m = mean(series)!;
  let den = 0;
  for (const x of series) den += (x - m) * (x - m);
  if (den <= 0) return n; // constant series → no autocorrelation signal
  let num = 0;
  for (let i = 0; i < n - 1; i++) num += (series[i] - m) * (series[i + 1] - m);
  let r1 = num / den;
  r1 = Math.max(0, Math.min(0.99, r1));
  return (n * (1 - r1)) / (1 + r1);
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * PURE readiness reduction over the night-charge ledger (§5, v2 semantics).
 *
 * Evidence pools (all current-`algo_version` only — prior-version rows are
 * EXCLUDED, §5.2):
 *  - ACTUATED pool: rows with `actuated` AND `scored` truthy — a bounded
 *    reserve write was applied and its delivery measured. Feeds the under-buy
 *    rate, the delivery bias, and the graduation night count. No clean-
 *    baseline requirement: the actuated counterfactual is measured by
 *    subtracting the delivered charge from the realized trough.
 *  - FORECAST pool: outcome-captured forecast-tier rows — feeds PV/load
 *    accuracy and band coverage (those columns are recorded on every captured
 *    night regardless of the realized-need `scored` flag).
 *
 * States:
 *  - BLOCKED  — a HARD safety metric fails: engine-fault strikes active in the
 *               rolling window (uncleared), or an over-threshold under-buy rate
 *               with enough actuated nights to judge it.
 *  - LEARNING — fail-closed: too few actuated nights, or any graduation metric
 *               unmet / uncomputable.
 *  - READY_TO_CONSIDER_WRITES — every graduation criterion passes
 *               (writeReady=true). This unlocks AUTO-mode consideration only;
 *               the write path itself stays behind the owner's mode selection
 *               and the safety spine (§6).
 */
export function computeNightChargeReadiness(
  rows: NightLedgerRow[],
  nowMs: number,
  opts?: NightChargeReadinessOpts,
): NightChargeReadiness {
  const algoVersion = opts?.algoVersion ?? CURRENT_ALGO_VERSION;
  const list = Array.isArray(rows) ? rows : [];

  // Current-algo rows only (prior-version rows are EXCLUDED, not tagged — §5.2).
  // Compare as STRINGS: recordNightPlan persists algo_version as SQLite TEXT
  // ("2"), so a numeric compare would never match a real row.
  const currentAlgo = list.filter((r) => String(r.algo_version) === String(algoVersion));

  // Rows that reached an outcome (night fully complete).
  const withOutcome = currentAlgo.filter((r) => asNum(r.outcome_captured_at_ms) != null);

  // ── MNAR exclusion diagnostic (§3.5): expected nights vs captured-and-scored
  // nights over the current-algo era (trailing 120 d, latest COMPLETE plan date
  // = Phoenix date of now−45 h). Published as a diagnostic so a growing hole in
  // the record is visible; the v2 graduation criteria are the five owner-
  // approved ones (2026-07-31), which do not include it. ──
  let exclusionFrac: number | null = null;
  {
    const scoredRows = withOutcome.filter((r) => truthy(r.scored));
    const dates = currentAlgo
      .map((r) => String(r.plan_date))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    if (dates.length) {
      const lastComplete = phoenixYmd(nowMs - 45 * 3_600_000);
      const rangeStart = maxYmd(dates[0], addDaysYmd(lastComplete, -119));
      if (lastComplete >= rangeStart) {
        const expected = daysBetweenYmdInclusive(rangeStart, lastComplete);
        const scoredInRange = new Set(
          scoredRows
            .map((r) => String(r.plan_date))
            .filter((d) => d >= rangeStart && d <= lastComplete),
        ).size;
        if (expected > 0) exclusionFrac = Math.max(0, expected - scoredInRange) / expected;
      }
    }
  }

  // ── FORECAST pool: PV/load accuracy + band coverage over captured
  // forecast-tier nights. ──
  const forecastPool = withOutcome.filter((r) => r.confidence_tier === 'forecast');
  const forecastBasisPct =
    withOutcome.length > 0 ? (forecastPool.length / withOutcome.length) * 100 : null;

  const pvErrs = forecastPool.map((r) => asNum(r.pv_err_frac)).filter((v): v is number => v != null);
  const loadErrs = forecastPool.map((r) => asNum(r.load_err_frac)).filter((v): v is number => v != null);
  const pvMae = mean(pvErrs.map(Math.abs));
  const pvBias = mean(pvErrs);
  const loadMae = mean(loadErrs.map(Math.abs));
  const loadBias = mean(loadErrs);

  // Band coverage: realized fraction where BOTH PV and load landed in-band,
  // over nights where both verdicts exist (a null verdict is missing data, not
  // an out-of-band miss).
  const bandFlags = forecastPool
    .filter((r) => r.pv_in_band != null && r.load_in_band != null)
    .map((r) => truthy(r.pv_in_band) && truthy(r.load_in_band));
  const coverageNights = bandFlags.length;
  const bandCoverage = coverageNights > 0 ? bandFlags.filter(Boolean).length / coverageNights : null;

  // ── ACTUATED pool (chronological; YYYY-MM-DD sorts lexically = by date). ──
  const actuated = currentAlgo
    .filter((r) => truthy(r.actuated) && truthy(r.scored))
    .sort((a, b) => String(a.plan_date).localeCompare(String(b.plan_date)));
  const actuatedNights = actuated.length;

  // v1.104.0 — a night whose plan DISCLOSED it could not meet the cushion is not
  // evidence that the engine under-bought. The strike rule fifteen lines below
  // already says exactly this — `if (truthy(r.cushion_shortfall)) return false;
  // // disclosed — physics, not fault` — but the under-buy rule had no such
  // exemption, so one and the same night was "physics, not fault" for strikes
  // and "a life-safety miss" for under-buy.
  //
  // On the live ledger all four actuated+scored nights carry
  // cushion_shortfall = 1: the planner said up front that charge/pool caps
  // prevented meeting the cushion, and was then scored down for not delivering
  // what it had explicitly declared undeliverable. That produced the 56%
  // under-buy rate blocking promotion.
  //
  // This does NOT open the gate. With the pool empty `underBuyRate` becomes
  // null, which the graduation criteria below treat as blocking ("under-buy
  // rate uncomputable"), so the state falls from a FALSE hard BLOCKED to
  // LEARNING — fail-closed, and honest about having no evidence rather than
  // asserting bad evidence. No write behaviour changes.
  const underBuyPool = actuated.filter((r) => !truthy(r.cushion_shortfall));
  const buyErrs = underBuyPool.map((r) => asNum(r.buy_err_kwh)).filter((v): v is number => v != null);
  // v1.105.0 — DEADBAND. `e < 0` was untoleranced, so a −0.01 kWh rounding
  // residual scored as a life-safety miss identical to a −31 kWh one. A safety
  // metric needs a threshold below which the miss is not physically meaningful:
  // UNDERBUY_DEADBAND_KWH is well under any real margin but comfortably above
  // the round2() noise floor of the inputs.
  const underBuyCount = buyErrs.filter((e) => e < -UNDERBUY_DEADBAND_KWH).length;
  const underBuyRate = buyErrs.length > 0 ? underBuyCount / buyErrs.length : null;
  const buyBiasKwh = mean(buyErrs);
  /** v1.104.0 — actuated nights excluded from the under-buy judgement as disclosed shortfalls. */
  const underBuyExcluded = actuated.length - underBuyPool.length;

  // ── Engine-fault strikes (v2 §5.1). A strike requires the plan to have
  // CLAIMED hold (`cushion_shortfall` falsy — NULL counts as claimed,
  // fail-closed) AND either the plan's own simulated trajectory breached
  // (forecast-tier plans only, §3.3) or an actuated night's REALIZED outcome
  // breached floor+cushion (any tier — a delivered buy that still breached is
  // fault evidence regardless of the forecast basis). ──
  const strikeRows = currentAlgo.filter((r) => {
    if (truthy(r.cushion_shortfall)) return false; // disclosed — physics, not fault
    const trajStrike = r.confidence_tier === 'forecast' && truthy(r.plan_traj_floor_breached);
    const realizedStrike = truthy(r.actuated) && truthy(r.cushion_breached);
    return trajStrike || realizedStrike;
  });
  const strikeWindowStart = phoenixYmd(nowMs - STRIKE_WINDOW_DAYS * DAY_MS);
  const windowStrikes = strikeRows.filter((r) => String(r.plan_date) >= strikeWindowStart);
  // Demonstrated-performance escape: actuated nights AFTER the newest in-window
  // strike are strike-free by construction (the newest strike is the max
  // strike date); ≥ STRIKE_CLEAR_STREAK of them clears the window.
  let strikeFreeStreak = 0;
  let strikesCleared = false;
  if (windowStrikes.length > 0) {
    const lastStrikeDate = windowStrikes.map((r) => String(r.plan_date)).sort().at(-1)!;
    strikeFreeStreak = actuated.filter((r) => String(r.plan_date) > lastStrikeDate).length;
    strikesCleared = strikeFreeStreak >= STRIKE_CLEAR_STREAK;
  }
  const activeStrikes = strikesCleared ? 0 : windowStrikes.length;

  // ── Autocorrelation-adjusted effective N (§5.2) — diagnostic. ──
  const effSeries = pvErrs.length >= 2 ? pvErrs : loadErrs.length >= 2 ? loadErrs : [];
  const effectiveN = effSeries.length >= 2 ? effectiveSampleSize(effSeries) : actuatedNights;

  const metrics: Record<string, number | null> = {
    scoredDays: actuatedNights,
    actuatedNights,
    effectiveN: round(effectiveN, 2),
    activeStrikes,
    strikeFreeStreak,
    strikesCleared: strikesCleared ? 1 : 0,
    underBuyRate: underBuyRate != null ? round(underBuyRate) : null,
    underBuyExcluded, // v1.104.0 — actuated nights dropped as disclosed cushion shortfalls
    buyBiasKwh: buyBiasKwh != null ? round(buyBiasKwh) : null,
    pvMae: pvMae != null ? round(pvMae) : null,
    pvBias: pvBias != null ? round(pvBias) : null,
    loadMae: loadMae != null ? round(loadMae) : null,
    loadBias: loadBias != null ? round(loadBias) : null,
    bandCoverage: bandCoverage != null ? round(bandCoverage) : null,
    bandCoveragePct: bandCoverage != null ? round(bandCoverage * 100, 1) : null,
    coverageNights,
    forecastBasisPct: forecastBasisPct != null ? round(forecastBasisPct, 1) : null,
    exclusionFrac: exclusionFrac != null ? round(exclusionFrac) : null,
    minActuatedNights: MIN_ACTUATED_NIGHTS,
    strikeWindowDays: STRIKE_WINDOW_DAYS,
    strikeClearStreak: STRIKE_CLEAR_STREAK,
  };

  // ── HARD failures → BLOCKED (writeReady false), evaluated first. ──
  const hard: string[] = [];
  if (activeStrikes > 0) {
    hard.push(
      `${activeStrikes} engine-fault floor strike(s) in the trailing ${STRIKE_WINDOW_DAYS} d (plan claimed hold; trajectory or realized outcome breached floor+cushion) — clears after ${STRIKE_CLEAR_STREAK} consecutive strike-free actuated nights (${strikeFreeStreak} so far) (§5.1 HARD).`,
    );
  }
  if (
    underBuyRate != null &&
    actuatedNights >= MIN_NIGHTS_TO_JUDGE_UNDERBUY &&
    underBuyRate > MAX_UNDERBUY_RATE
  ) {
    hard.push(
      `under-buy rate ${(underBuyRate * 100).toFixed(0)}% exceeds the ${(MAX_UNDERBUY_RATE * 100).toFixed(0)}% cap over ${actuatedNights} actuated night(s) — under-buy is a safety miss (§5.1 HARD).`,
    );
  }
  if (hard.length > 0) {
    return { state: 'BLOCKED', writeReady: false, blocking: hard, scoredDays: actuatedNights, effectiveN: round(effectiveN, 2), metrics };
  }

  // ── Graduation criteria (owner-approved 2026-07-31). Any unmet →
  // fail-closed to LEARNING (§5.3, I13). ──
  const blocking: string[] = [];

  if (actuatedNights < MIN_ACTUATED_NIGHTS) {
    blocking.push(`only ${actuatedNights} scored actuated night(s); need ≥ ${MIN_ACTUATED_NIGHTS}.`);
  }
  if (underBuyRate == null) {
    blocking.push(
      underBuyExcluded > 0
        ? `under-buy rate uncomputable — all ${underBuyExcluded} actuated night(s) disclosed a cushion shortfall, so none is evidence about sizing (§5.1).`
        : 'under-buy rate uncomputable (no actuated buy errors yet).',
    );
  } else if (underBuyRate > MAX_UNDERBUY_RATE) {
    blocking.push(`under-buy rate ${(underBuyRate * 100).toFixed(0)}% exceeds ${(MAX_UNDERBUY_RATE * 100).toFixed(0)}%.`);
  }
  if (buyBiasKwh == null || buyBiasKwh < BUY_BIAS_MIN_KWH || buyBiasKwh > BUY_BIAS_MAX_KWH) {
    blocking.push(
      `delivery bias ${buyBiasKwh != null ? buyBiasKwh.toFixed(2) : 'n/a'} kWh outside the slight-over-buy band [${BUY_BIAS_MIN_KWH}, ${BUY_BIAS_MAX_KWH}].`,
    );
  }
  if (coverageNights < MIN_COVERAGE_NIGHTS) {
    blocking.push(
      `band coverage judged on ${coverageNights} captured forecast night(s); need ≥ ${MIN_COVERAGE_NIGHTS}.`,
    );
  } else if (bandCoverage == null || bandCoverage < BAND_COVERAGE_MIN || bandCoverage > BAND_COVERAGE_MAX) {
    blocking.push(
      `band coverage ${bandCoverage != null ? (bandCoverage * 100).toFixed(0) + '%' : 'n/a'} outside [${(BAND_COVERAGE_MIN * 100).toFixed(0)}%, ${(BAND_COVERAGE_MAX * 100).toFixed(0)}%].`,
    );
  }

  if (blocking.length === 0) {
    return {
      state: 'READY_TO_CONSIDER_WRITES',
      writeReady: true,
      blocking,
      scoredDays: actuatedNights,
      effectiveN: round(effectiveN, 2),
      metrics,
    };
  }

  return { state: 'LEARNING', writeReady: false, blocking, scoredDays: actuatedNights, effectiveN: round(effectiveN, 2), metrics };
}

/* ── Latest-readiness holder for the delivery surfaces (mirror the advisor's
 *    get/set holder pattern; the evening job recomputes and sets this). ─────── */

let latestReadiness: NightChargeReadiness | null = null;
export function getLatestReadiness(): NightChargeReadiness | null {
  return latestReadiness;
}
export function setLatestReadiness(r: NightChargeReadiness): void {
  latestReadiness = r;
}

/**
 * Flat fields the integrator publishes into the MQTT/HA state payload for the
 * `ecoflow_night_charge_readiness` (string) + `ecoflow_night_charge_write_ready`
 * (binary) entities plus the §5.3 diagnostic sub-metric sensors.
 *
 * v2: `night_charge_plan_nights_scored` now counts scored ACTUATED nights (the
 * gate's evidence base) — on a grid-tied home the v1 clean-baseline count was
 * structurally 0.
 *
 * FAIL-CLOSED: on a null readiness, `night_charge_write_ready` is strictly false
 * (never null-as-true) and every diagnostic key is null (basis incomplete).
 */
export function nightChargeGateFields(r: NightChargeReadiness | null): {
  night_charge_readiness: string;
  night_charge_write_ready: boolean;
  night_charge_under_buy_rate: number | null;
  night_charge_band_coverage_pct: number | null;
  night_charge_plan_nights_scored: number | null;
  night_charge_effective_n: number | null;
  night_charge_forecast_basis_pct: number | null;
  night_charge_exclusion_fraction: number | null;
} {
  if (!r) {
    return {
      night_charge_readiness: 'unknown',
      night_charge_write_ready: false,
      night_charge_under_buy_rate: null,
      night_charge_band_coverage_pct: null,
      night_charge_plan_nights_scored: null,
      night_charge_effective_n: null,
      night_charge_forecast_basis_pct: null,
      night_charge_exclusion_fraction: null,
    };
  }
  return {
    night_charge_readiness: r.state,
    night_charge_write_ready: r.writeReady === true,
    night_charge_under_buy_rate: r.metrics.underBuyRate ?? null,
    night_charge_band_coverage_pct: r.metrics.bandCoveragePct ?? null,
    night_charge_plan_nights_scored: r.scoredDays,
    night_charge_effective_n: r.effectiveN,
    night_charge_forecast_basis_pct: r.metrics.forecastBasisPct ?? null,
    night_charge_exclusion_fraction: r.metrics.exclusionFrac ?? null,
  };
}
