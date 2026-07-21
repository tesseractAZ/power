/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargeGate.ts — the night-charge WRITE-READINESS gate (WS3).
 *
 * v1 gate per design docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md §5. It is NOT a
 * 4-state machine with a weighted 0–100 score, hysteresis, or a supervised
 * ramp — none of that is observable for months and WRITE-ELIGIBLE is unreachable
 * during the first in-season sample anyway (§5, §5.3). It is a PURE reduction
 * over the ONE durable ledger table (`night_charge_ledger`, §3.1), surfaced as
 * one enum + a boolean + a "what's blocking" list.
 *
 * ★★ SAFETY POSTURE (binding):
 *  - The gate NEVER enables a write by itself. It only reports whether the
 *    physically-measured accuracy record is good enough to even CONSIDER writes
 *    (state READY_TO_CONSIDER_WRITES). The device write path is separately
 *    deferred (§6) behind the probe + owner toggle + the safety spine.
 *  - It gates ONLY on physically-measured prediction accuracy (§5.1). There is
 *    NO savings term — there is no valid counterfactual pre-write (§5), so a
 *    savings-agreement gate would certify a number the system cannot observe.
 *  - FAIL-CLOSED (I13): missing/thin/young data ⇒ LEARNING / writeReady=false,
 *    never null-as-ready. A single would-have-breached plan-night ⇒ BLOCKED.
 *  - Prior-`algo_version` rows are EXCLUDED (not merely tagged), because a
 *    planner physics fix (§0.2) changes the meaning of every prior row and
 *    resets the in-season clock (§5.2).
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

/* ── Pre-registered, FROZEN thresholds (§5.1/§5.2). Never tuned on the season
 *    the gate gates (garden-of-forking-paths); a later re-tune bumps
 *    CURRENT_ALGO_VERSION and resets the readiness clock. ─────────────────── */

/** Bumped on ANY planner physics/algorithm change (§0.2). Prior-version ledger
 *  rows are excluded and the in-season counter resets. WS2 stamps plan rows with
 *  this so a re-learn is attributable. */
export const CURRENT_ALGO_VERSION = 1;

/** Oldest scored-eligible row must span at least this much wall time — the gate
 *  fails-closed to LEARNING if the record is younger (I13, §5.3). A full APS
 *  season / band-coverage CI needs ~a season of independent evidence (§5.1). */
const REQUIRED_IN_SEASON_DAYS = 90;

/** Minimum raw scored, current-algo, forecast-backed nights before any soft
 *  metric is trusted. */
const MIN_SCORED_ELIGIBLE_DAYS = 60;

/** Minimum AUTOCORRELATION-ADJUSTED independent nights (§5.2) — a cloudy stretch
 *  is several correlated bad nights, so raw count over-counts evidence. */
const MIN_EFFECTIVE_N = 45;

/** Enough nights to even JUDGE the under-buy rate as a hard safety signal.
 *  Below this we are still LEARNING, not BLOCKED, on under-buy. */
const MIN_NIGHTS_TO_JUDGE_UNDERBUY = 5;

/** Under-buy is a SAFETY miss (§5.1 HARD, asymmetric): recommended kWh must be
 *  ≥ realized need on ≥90% of plan-nights → under-buy fraction ≤ 0.10. */
const MAX_UNDERBUY_RATE = 0.10;

/** Signed buy bias must sit in a SLIGHT over-buy band (§5.1): never net under,
 *  never a gross over-buy. kWh at the meter. */
const BUY_BIAS_MIN_KWH = 0;
const BUY_BIAS_MAX_KWH = 5;

/** Day-ahead PV/load accuracy is NORMALIZED MAE + a separate signed bias, NOT r²
 *  (variance-driven, inflated by monsoon swings; a +15–20% biased-but-correlated
 *  forecast passes r²≥0.80 yet mis-sizes the buy) — §5.1. Fractions of actual. */
const PV_MAE_MAX_FRAC = 0.20;
const PV_BIAS_ABS_MAX_FRAC = 0.10;
const LOAD_MAE_MAX_FRAC = 0.20;
const LOAD_BIAS_ABS_MAX_FRAC = 0.10;

/** Realized in-band fraction must land in [78%, 92%] (§5.1). Held "insufficient"
 *  until effectiveN is large enough that the Wilson CI can distinguish safe from
 *  dangerous coverage — enforced via the MIN_EFFECTIVE_N gate above. */
const BAND_COVERAGE_MIN = 0.78;
const BAND_COVERAGE_MAX = 0.92;

/** MNAR exclusion cap (§3.5): SHP2 cloud-offline correlates with storms + the
 *  daily power-cycle, so excluded nights are the adverse high-shortfall ones.
 *  Refuse readiness credit above this fraction of outcome-captured nights. */
const MAX_EXCLUSION_FRAC = 0.35;

export type NightChargeReadinessState =
  | 'LEARNING'
  | 'READY_TO_CONSIDER_WRITES'
  | 'BLOCKED';

export interface NightChargeReadiness {
  state: NightChargeReadinessState;
  writeReady: boolean;
  /** Human-readable reasons the gate is not READY (empty iff READY). */
  blocking: string[];
  /** Raw count of scored, current-algo, forecast-backed nights. */
  scoredDays: number;
  /** Autocorrelation-adjusted independent nights (§5.2). */
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
 * PURE readiness reduction over the night-charge ledger (§5).
 *
 * Eligible rows = scored AND current-`algo_version` AND fully forecast-backed
 * (`confidence_tier === 'forecast'`; climatology/mixed weekend rows never count
 * toward eligibility, §5.1). Each gated metric must independently pass its own
 * pre-registered threshold; there is NO composite score for eligibility.
 *
 * States:
 *  - BLOCKED  — a HARD safety metric fails (any plan-trajectory floor breach; or,
 *               with enough nights to judge, an under-buy rate over threshold).
 *  - LEARNING — fail-closed: too-young record, too-few (effective) nights, or any
 *               soft accuracy metric unmet / uncomputable.
 *  - READY_TO_CONSIDER_WRITES — every gate passes (writeReady=true). This only
 *               unlocks CONSIDERATION; the device write path stays behind the
 *               probe + owner toggle + safety spine (§6).
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
  // ("1"), so a numeric `asNum(...) === algoVersion` never matched a real row and
  // the gate was permanently stuck excluding every persisted night. String-vs-
  // string is robust whether the column is stored TEXT or INTEGER.
  const currentAlgo = list.filter((r) => String(r.algo_version) === String(algoVersion));

  // Rows that reached an outcome (night fully complete) — used for the
  // forecast-basis diagnostic and the ELIGIBLE set below.
  const withOutcome = currentAlgo.filter((r) => asNum(r.outcome_captured_at_ms) != null);
  const scoredWithOutcome = withOutcome.filter((r) => truthy(r.scored));

  // v1.39.0 (§3.5, review MED ×2): the MNAR denominator is EXPECTED nights, not
  // rows-that-reached-an-outcome. Nights that never produced a ledger row at all
  // — add-on down at the evening job, SHP2 cloud-offline (the documented ADVERSE
  // failure modes) — and completed rows never captured must count as exclusions;
  // keying the fraction on captured rows let exactly the adverse nights the
  // MAX_EXCLUSION_FRAC cap exists for vanish from BOTH numerator and
  // denominator. Expected range = every Phoenix calendar date from the first
  // current-algo plan (bounded to a trailing 120 d so ancient history can't
  // dominate) through the most recent COMPLETED night: plan D completes at
  // D+1 21:00, so the latest complete plan date is the Phoenix date of now−45 h.
  let exclusionFrac: number | null = null;
  {
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
          scoredWithOutcome
            .map((r) => String(r.plan_date))
            .filter((d) => d >= rangeStart && d <= lastComplete),
        ).size;
        if (expected > 0) exclusionFrac = Math.max(0, expected - scoredInRange) / expected;
      }
    }
  }

  // Fraction of scored nights that were forecast-backed (dashboard/diagnostic).
  const forecastBasisPct =
    scoredWithOutcome.length > 0
      ? (scoredWithOutcome.filter((r) => r.confidence_tier === 'forecast').length /
          scoredWithOutcome.length) *
        100
      : null;

  // ELIGIBLE = scored, current-algo, fully forecast-backed weekday nights (§5.1).
  const eligible = scoredWithOutcome
    .filter((r) => r.confidence_tier === 'forecast')
    // chronological by plan_date (YYYY-MM-DD sorts lexically = chronologically)
    .sort((a, b) => String(a.plan_date).localeCompare(String(b.plan_date)));

  const scoredDays = eligible.length;

  // ── HARD: plan-trajectory floor safety (§5.1). Evaluated on the SIMULATED
  // plan trajectory, recorded by WS2 as `plan_traj_floor_breached` (§3.3). A
  // SINGLE would-have-breached plan-night → not ready, regardless of sample.
  // ★ Evaluated over ALL current-algo, forecast-tier rows that recorded a breach
  // verdict — NOT only the coverage-`scored` subset: the plan-trajectory breach
  // is a property of the plan's own simulated trajectory (§3.3), independent of
  // grid_home_w coverage, so a would-have-breached plan on a coverage-EXCLUDED
  // (propped / storm / SHP2-offline) night — exactly the adverse high-shortfall
  // night the gate exists to catch — MUST still block readiness. ──
  // "has a verdict" = the field is present (null ⇒ no trajectory recorded). Use
  // a loose != null so a boolean true/false (in-memory) OR a SQLite 0/1 both count
  // — asNum() would wrongly drop the boolean form and let a breach slip through.
  const floorBreachPool = currentAlgo.filter(
    (r) => r.confidence_tier === 'forecast' && r.plan_traj_floor_breached != null,
  );
  const floorBreaches = floorBreachPool.filter((r) => truthy(r.plan_traj_floor_breached)).length;

  // ── Sizing under-buy (HARD, asymmetric §5.1). buy_err_kwh signed, +over-bought;
  // under-buy = buy_err_kwh < 0. ──
  const buyErrs = eligible.map((r) => asNum(r.buy_err_kwh)).filter((v): v is number => v != null);
  const underBuyCount = buyErrs.filter((e) => e < 0).length;
  const underBuyRate = buyErrs.length > 0 ? underBuyCount / buyErrs.length : null;
  const buyBiasKwh = mean(buyErrs);

  // ── PV & load day-ahead accuracy: normalized MAE + signed bias, NOT r² (§5.1) ──
  const pvErrs = eligible.map((r) => asNum(r.pv_err_frac)).filter((v): v is number => v != null);
  const loadErrs = eligible.map((r) => asNum(r.load_err_frac)).filter((v): v is number => v != null);
  const pvMae = mean(pvErrs.map(Math.abs));
  const pvBias = mean(pvErrs);
  const loadMae = mean(loadErrs.map(Math.abs));
  const loadBias = mean(loadErrs);

  // ── Band coverage: realized fraction where BOTH PV and load landed in-band ──
  const bandFlags = eligible.map((r) => truthy(r.pv_in_band) && truthy(r.load_in_band));
  const bandCoverage = bandFlags.length > 0 ? bandFlags.filter(Boolean).length / bandFlags.length : null;

  // ── Autocorrelation-adjusted effective N (§5.2), off the PV residual series
  // (fall back to the load series, then raw count). ──
  const effSeries = pvErrs.length >= 2 ? pvErrs : loadErrs.length >= 2 ? loadErrs : [];
  const effectiveN = effSeries.length >= 2 ? effectiveSampleSize(effSeries) : scoredDays;

  // ── In-season window age (I13): oldest ELIGIBLE row's issue instant. ──
  const issueTimes = eligible.map((r) => asNum(r.issued_at_ms)).filter((v): v is number => v != null);
  const oldestIssueMs = issueTimes.length > 0 ? Math.min(...issueTimes) : null;
  const oldestRowAgeDays = oldestIssueMs != null ? (nowMs - oldestIssueMs) / DAY_MS : null;

  const metrics: Record<string, number | null> = {
    scoredDays,
    effectiveN: round(effectiveN, 2),
    floorBreaches,
    underBuyRate: underBuyRate != null ? round(underBuyRate) : null,
    buyBiasKwh: buyBiasKwh != null ? round(buyBiasKwh) : null,
    pvMae: pvMae != null ? round(pvMae) : null,
    pvBias: pvBias != null ? round(pvBias) : null,
    loadMae: loadMae != null ? round(loadMae) : null,
    loadBias: loadBias != null ? round(loadBias) : null,
    bandCoverage: bandCoverage != null ? round(bandCoverage) : null,
    bandCoveragePct: bandCoverage != null ? round(bandCoverage * 100, 1) : null,
    forecastBasisPct: forecastBasisPct != null ? round(forecastBasisPct, 1) : null,
    exclusionFrac: exclusionFrac != null ? round(exclusionFrac) : null,
    oldestRowAgeDays: oldestRowAgeDays != null ? round(oldestRowAgeDays, 1) : null,
    requiredInSeasonDays: REQUIRED_IN_SEASON_DAYS,
    minScoredEligibleDays: MIN_SCORED_ELIGIBLE_DAYS,
    minEffectiveN: MIN_EFFECTIVE_N,
  };

  // ── HARD failures → BLOCKED (writeReady false), evaluated first. ──
  const hard: string[] = [];
  if (floorBreaches > 0) {
    hard.push(
      `plan-trajectory floor breach on ${floorBreaches} forecast plan-night(s) (incl. coverage-excluded) — a single would-have-breach blocks writes (§5.1 HARD).`,
    );
  }
  if (
    underBuyRate != null &&
    scoredDays >= MIN_NIGHTS_TO_JUDGE_UNDERBUY &&
    underBuyRate > MAX_UNDERBUY_RATE
  ) {
    hard.push(
      `under-buy rate ${(underBuyRate * 100).toFixed(0)}% exceeds the ${(MAX_UNDERBUY_RATE * 100).toFixed(0)}% cap — under-buy is a safety miss (§5.1 HARD).`,
    );
  }
  if (hard.length > 0) {
    return { state: 'BLOCKED', writeReady: false, blocking: hard, scoredDays, effectiveN: round(effectiveN, 2), metrics };
  }

  // ── Soft eligibility gates. Any unmet → fail-closed to LEARNING (§5.3, I13). ──
  const blocking: string[] = [];

  if (scoredDays < MIN_SCORED_ELIGIBLE_DAYS) {
    blocking.push(`only ${scoredDays} scored forecast-backed night(s); need ≥ ${MIN_SCORED_ELIGIBLE_DAYS}.`);
  }
  if (oldestRowAgeDays == null || oldestRowAgeDays < REQUIRED_IN_SEASON_DAYS) {
    blocking.push(
      `record spans ${oldestRowAgeDays != null ? oldestRowAgeDays.toFixed(0) : 0}d; need ≥ ${REQUIRED_IN_SEASON_DAYS}d in-season (fail-closed, I13).`,
    );
  }
  if (effectiveN < MIN_EFFECTIVE_N) {
    blocking.push(`effective-N ${effectiveN.toFixed(1)} below ${MIN_EFFECTIVE_N} (autocorrelation-adjusted, §5.2).`);
  }
  if (underBuyRate == null) {
    blocking.push('under-buy rate uncomputable (no scored buy errors).');
  } else if (underBuyRate > MAX_UNDERBUY_RATE) {
    blocking.push(`under-buy rate ${(underBuyRate * 100).toFixed(0)}% exceeds ${(MAX_UNDERBUY_RATE * 100).toFixed(0)}%.`);
  }
  if (buyBiasKwh == null || buyBiasKwh < BUY_BIAS_MIN_KWH || buyBiasKwh > BUY_BIAS_MAX_KWH) {
    blocking.push(
      `buy bias ${buyBiasKwh != null ? buyBiasKwh.toFixed(2) : 'n/a'} kWh outside the slight-over-buy band [${BUY_BIAS_MIN_KWH}, ${BUY_BIAS_MAX_KWH}].`,
    );
  }
  if (pvMae == null || pvMae > PV_MAE_MAX_FRAC || pvBias == null || Math.abs(pvBias) > PV_BIAS_ABS_MAX_FRAC) {
    blocking.push(
      `PV day-ahead accuracy unmet (MAE ${pvMae != null ? pvMae.toFixed(3) : 'n/a'} > ${PV_MAE_MAX_FRAC} or |bias| > ${PV_BIAS_ABS_MAX_FRAC}).`,
    );
  }
  if (loadMae == null || loadMae > LOAD_MAE_MAX_FRAC || loadBias == null || Math.abs(loadBias) > LOAD_BIAS_ABS_MAX_FRAC) {
    blocking.push(
      `load day-ahead accuracy unmet (MAE ${loadMae != null ? loadMae.toFixed(3) : 'n/a'} > ${LOAD_MAE_MAX_FRAC} or |bias| > ${LOAD_BIAS_ABS_MAX_FRAC}).`,
    );
  }
  if (bandCoverage == null || bandCoverage < BAND_COVERAGE_MIN || bandCoverage > BAND_COVERAGE_MAX) {
    blocking.push(
      `band coverage ${bandCoverage != null ? (bandCoverage * 100).toFixed(0) + '%' : 'n/a'} outside [${(BAND_COVERAGE_MIN * 100).toFixed(0)}%, ${(BAND_COVERAGE_MAX * 100).toFixed(0)}%].`,
    );
  }
  if (exclusionFrac == null) {
    blocking.push('MNAR exclusion fraction uncomputable (no outcome-captured nights).');
  } else if (exclusionFrac > MAX_EXCLUSION_FRAC) {
    blocking.push(
      `MNAR exclusion ${(exclusionFrac * 100).toFixed(0)}% exceeds ${(MAX_EXCLUSION_FRAC * 100).toFixed(0)}% cap (§3.5).`,
    );
  }

  if (blocking.length === 0) {
    return {
      state: 'READY_TO_CONSIDER_WRITES',
      writeReady: true,
      blocking,
      scoredDays,
      effectiveN: round(effectiveN, 2),
      metrics,
    };
  }

  return { state: 'LEARNING', writeReady: false, blocking, scoredDays, effectiveN: round(effectiveN, 2), metrics };
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
