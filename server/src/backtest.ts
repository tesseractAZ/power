/**
 * v0.9.27 — Forecast backtest harness.
 *
 * Track E. Replays a forecaster against historical actuals to compute
 * standard error metrics. The use case is "did v0.9.26's tweak to the
 * Bayesian solar model actually help?" — without backtesting, we can't
 * tell good model changes from bad ones.
 *
 * Generic enough to score ANY forecaster that produces a series of
 * hourly predictions vs the recorded actuals. Currently used for:
 *
 *   - getDayForecast PV totals (this hour vs predicted)
 *   - Bayesian solar model (per-hour GHI→PV)
 *   - Multi-day forecast (24h-out, 48h-out predictions)
 *
 * Metrics computed:
 *
 *   - RMSE — root mean squared error (penalizes big misses)
 *   - MAE  — mean absolute error (robust to outliers)
 *   - Bias — mean (predicted - actual). Tells you systemic over/under
 *   - MAPE — mean absolute percent error (when actual >> 0)
 *   - sMAPE — symmetric MAPE (better when actuals near 0)
 *   - R²   — coefficient of determination (variance explained)
 *
 * The pattern is "given a function that produces a forecast for hour H,
 * run it for the last N hours, compare to recorder samples." Each
 * forecaster registers a "replay" function returning per-hour predictions.
 */

import type { Recorder } from './recorder.js';

export interface ForecastDatum {
  /** Hour-aligned timestamp (ms). */
  ts: number;
  /** Predicted value for this hour. */
  predicted: number;
  /** Actual value recorded for this hour. */
  actual: number;
}

export interface BacktestScore {
  /** Number of (predicted, actual) pairs evaluated. */
  n: number;
  /** Root-mean-squared error. */
  rmse: number;
  /** Mean absolute error. */
  mae: number;
  /** Mean (predicted - actual). Positive = over-forecasting. */
  bias: number;
  /** Mean absolute percent error. Null when any actual is ~0. */
  mape: number | null;
  /** Symmetric MAPE — works near zero. */
  sMape: number;
  /** Coefficient of determination (R²). */
  r2: number;
  /** Period covered. */
  fromTs: number;
  toTs: number;
}

export function scoreForecast(data: ForecastDatum[]): BacktestScore {
  if (data.length === 0) {
    return {
      n: 0, rmse: 0, mae: 0, bias: 0, mape: null, sMape: 0, r2: 0,
      fromTs: 0, toTs: 0,
    };
  }
  let sumSqErr = 0, sumAbsErr = 0, sumErr = 0;
  let sumActual = 0;
  let sumAbsPct = 0;
  let sumSMape = 0;
  let validMape = true;
  for (const d of data) {
    const err = d.predicted - d.actual;
    sumSqErr += err * err;
    sumAbsErr += Math.abs(err);
    sumErr += err;
    sumActual += d.actual;
    if (Math.abs(d.actual) < 1e-6) validMape = false;
    else sumAbsPct += Math.abs(err / d.actual);
    // sMAPE: |err| / ((|a| + |p|) / 2). Handles near-zero gracefully.
    const denom = (Math.abs(d.actual) + Math.abs(d.predicted)) / 2;
    if (denom > 1e-9) sumSMape += Math.abs(err) / denom;
  }
  const n = data.length;
  const meanActual = sumActual / n;
  // R² requires baseline variance — total sum of squares around mean of actuals.
  let sumTotalSq = 0;
  for (const d of data) sumTotalSq += (d.actual - meanActual) ** 2;
  const r2 = sumTotalSq > 0 ? 1 - (sumSqErr / sumTotalSq) : 0;
  return {
    n,
    rmse: Math.sqrt(sumSqErr / n),
    mae: sumAbsErr / n,
    bias: sumErr / n,
    mape: validMape ? sumAbsPct / n : null,
    sMape: sumSMape / n,
    r2,
    fromTs: data[0].ts,
    toTs: data[data.length - 1].ts,
  };
}

/* ─── concrete backtest: PV forecast vs realized ──────────────────── */

export interface PvBacktestInputs {
  recorder: Recorder;
  /** Device SNs to sum PV from. Typically all online DPUs. */
  dpuSns: string[];
  /** Hours back to evaluate (default 168 = last 7 days). */
  hoursBack?: number;
  /** Function that, given a target ms-timestamp, returns the model's
   *  predicted total-fleet PV (Wh) for the HOUR STARTING at that ts. */
  predict: (hourStartMs: number) => number;
  /** v0.21.0 — inject "now" for deterministic tests; defaults to Date.now(). */
  nowMs?: number;
}

/**
 * v0.21.0 — inclusive [startMs, endMs] slice of a ts-ASC points array. Mirrors
 * the recorder's `ts >= ? AND ts <= ?` bounds EXACTLY (both ends inclusive), so
 * a sample landing on an hour boundary appears in BOTH adjacent windows — the
 * same behaviour as issuing one query per window. Lets callers fetch a whole
 * series once and bucket it in memory while staying bit-identical to the prior
 * one-query-per-bucket loops. Binary-searched: O(log n) per window.
 */
export function sliceByTsInclusive<T extends { ts: number }>(pts: T[], startMs: number, endMs: number): T[] {
  let lo = 0, hi = pts.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (pts[m].ts < startMs) lo = m + 1; else hi = m; }
  const start = lo;
  hi = pts.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (pts[m].ts <= endMs) lo = m + 1; else hi = m; }
  return pts.slice(start, lo);
}

export function backtestPvForecast(inputs: PvBacktestInputs): BacktestScore {
  const hoursBack = inputs.hoursBack ?? 168;
  const now = inputs.nowMs ?? Date.now();
  const data: ForecastDatum[] = [];
  // v0.21.0 — fetch each DPU's full pv_total series ONCE over the whole window,
  // then slice each hour from it in memory. The old loop issued one SQLite query
  // per hour per DPU (~hoursBack × DPUs ≈ 1000 synchronous calls per cold hit
  // that blocked the analytics worker). sliceByTsInclusive reproduces the
  // recorder's inclusive bounds exactly, so the trapezoidal integration below is
  // byte-for-byte unchanged and the score is bit-identical (pinned by a test).
  const windowStart = now - hoursBack * 3_600_000;
  const seriesBySn = new Map<string, Array<{ ts: number; value: number }>>();
  for (const sn of inputs.dpuSns) {
    seriesBySn.set(sn, inputs.recorder.query(sn, 'pv_total', windowStart, now));
  }
  for (let h = hoursBack; h >= 1; h--) {
    const hourStartMs = now - h * 3_600_000;
    const hourEndMs = hourStartMs + 3_600_000;
    // Sum actual PV across all DPUs for this hour from the recorder.
    let actualWh = 0;
    for (const sn of inputs.dpuSns) {
      const pts = sliceByTsInclusive(seriesBySn.get(sn) ?? [], hourStartMs, hourEndMs);
      if (pts.length < 2) continue;
      // Trapezoidal integration of W → Wh
      for (let i = 1; i < pts.length; i++) {
        const dtMs = pts[i].ts - pts[i - 1].ts;
        if (dtMs > 600_000) continue;  // ignore gaps > 10 min
        const avg = (pts[i].value + pts[i - 1].value) / 2;
        actualWh += (avg * dtMs) / 3_600_000;
      }
    }
    const predictedWh = inputs.predict(hourStartMs);
    if (Number.isFinite(predictedWh) && Number.isFinite(actualWh)) {
      data.push({ ts: hourStartMs, predicted: predictedWh, actual: actualWh });
    }
  }
  return scoreForecast(data);
}
