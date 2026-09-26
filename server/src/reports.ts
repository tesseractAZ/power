import type { Recorder } from './recorder.js';
import type { SnapshotStore, FleetSnapshot, DeviceSnapshot } from './snapshot.js';
import type { Alert } from './alerts.js';
import {
  getDayForecast,
  computeDegradation,
  computeRunway,
  computeRoundTripEfficiency,
  computeClipping,
  computeCurtailment,
  computeCurtailmentAlerts,
  computeBaselineAlerts,
  computeForecastAlerts,
  computeSelfConsumption,
  computeCarbonReport,
  computeTariffReport,
  computeThermalEvents,
  computeEquipmentHealth,
  computeShadeReport,
  computeSoilingDecomposition,
  computeStringMismatch,
  computeEvWindowPrediction,
  computeChargeCurveFingerprint,
  computeInternalResistance,
  computeForecastSkill,
  PV_BAND_CAL_WINDOW_DAYS,
  computeAmbientThermalForecast,
  computeProbabilisticForecast,
  computeMultiDayForecast,
  computeBayesianSolarModel,
  diurnalBaselinePredictor,
  forecastHourPvW,
  preferRealizedGhiRows,
  queryRealizedGhi,
} from './analytics.js';
import { computeTotals, circuitHistoryByDay } from './aggregator.js';
import { backtestPvForecast } from './backtest.js';

/**
 * v1.11.0 (review F24) — build the predictor for the REAL alarm-facing forecaster:
 * the learned GHI→PV solar model × recorded GHI, capped at the observed ceiling,
 * then multiplied by the same clamped pvBiasFactor computeRunway/probabilistic
 * consume. Historical GHI + cloud come from the recorder's durable `weather`
 * series. This is the model the alarm actually uses — the pre-v1.11.0 backtest
 * scored only the diurnal typical-day BASELINE (`model:'typical-day-baseline'`),
 * so the r²≈0.94 headline described a model nothing alarms on, and F5/F11's real
 * drift was invisible to the system's own health reporting.
 */
function alarmModelPredictor(
  fc: { solarModel: { hourly: Array<{ hour: number; coeff: number | null; observedMaxPvW: number }> }; pvBiasFactor?: number; typicalPvCurveWhPerHour?: number[] },
  recorder: Recorder,
  nowMs: number,
  hoursBack: number,
): (hourStartMs: number) => number {
  const windowStart = nowMs - hoursBack * 3_600_000;
  const ghiByHe = new Map<number, number>();
  const cloudByHe = new Map<number, number>();
  // v1.173.0 (GHI stage 2) — realized-first: this scores the MODEL, and `ghi_wm2` is a
  // ~3-4-day-lead forecast. cloud_pct stays first-write (it only feeds forecastHourPvW's
  // null-coeff night fallback, and no realized cloud capture exists).
  for (const r of preferRealizedGhiRows(
    recorder.query('weather', 'ghi_wm2', windowStart, nowMs, 3600),
    queryRealizedGhi(recorder, windowStart, nowMs),
  )) ghiByHe.set(Math.floor(r.ts / 3_600_000), r.value);
  for (const r of recorder.query('weather', 'cloud_pct', windowStart, nowMs, 3600)) cloudByHe.set(Math.floor(r.ts / 3_600_000), r.value);
  const bias = fc.pvBiasFactor ?? 1;
  const curve = fc.typicalPvCurveWhPerHour ?? [];
  return (hourStartMs: number): number => {
    const hod = new Date(hourStartMs).getHours();
    const resp = fc.solarModel.hourly[hod];
    if (!resp) return 0;
    const he = Math.floor(hourStartMs / 3_600_000);
    const ghi = ghiByHe.get(he) ?? null;
    // clearnessHist=1: the modelled (coeff≠null) branch — the alarm's clear-day
    // path — ignores it; the fallback branch only runs for null-coeff night hours
    // where ghi≈0 and pv≈0 either way.
    const { pv } = forecastHourPvW(resp as any, ghi, cloudByHe.get(he) ?? null, curve[hod] ?? 0, 1);
    // Mirror getDayForecast's pvAlarm clamp: re-cap AFTER the bias multiply so an
    // under-predicting model can't project more PV than the array has produced.
    const hourCeil = resp.coeff != null ? resp.observedMaxPvW * 1.05 : null;
    return hourCeil != null ? Math.min(pv * bias, hourCeil) : pv * bias;
  };
}

/**
 * v0.10.0 — the report registry.
 *
 * Every recorder-backed analytics computation is registered here as a named
 * async builder. This is the single source of truth for "what each report
 * contains and what it depends on" (e.g. runway/clipping/multi-day all need
 * the day-forecast first — each builder fetches it via getDayForecast, which
 * is internally cached so the repeat calls are free).
 *
 * The registry runs INSIDE the analytics worker thread (analyticsWorker.ts)
 * against a read-only recorder, so these multi-second history scans never
 * touch the main event loop. It's also a plain module, so unit tests call
 * buildReport() directly with a synthetic recorder — no worker required.
 *
 * Pure assemblers that take already-computed inputs and no recorder
 * (computeConfidenceSnapshot, computeRepairIssues, computePackRiskScores/V2,
 * computeDispatchPlan, buildCalendarIcs) intentionally stay on the MAIN
 * thread — they're cheap and compose these reports there.
 */

export interface ReportCtx {
  recorder: Recorder;
  snapshot: FleetSnapshot;
  log: (m: string) => void;
}

export interface ReportArgs {
  days?: number;
  /** circuitHistory */
  sn?: string;
  ch?: number;
  metric?: string;
  /** totals */
  sinceMs?: number;
  untilMs?: number;
  /** backtest */
  dpuSns?: string[];
  hoursBack?: number;
  typicalWhPerHour?: number;
  /** v0.13.1 — 24-slot hour-of-day PV curve (Wh/h) for the diurnal baseline
   *  predictor; when present the backtest uses curve[hourOfDay] instead of the
   *  flat typicalWhPerHour scalar (fixes the R²≈0 flat-constant baseline). */
  typicalPvCurveWhPerHour?: number[];
}

const devicesOf = (ctx: ReportCtx): Record<string, DeviceSnapshot> => ctx.snapshot.devices;

/** Minimal SnapshotStore shim — computeTotals only ever calls store.get(). */
const shimStore = (ctx: ReportCtx): SnapshotStore =>
  ({ get: () => ctx.snapshot } as unknown as SnapshotStore);

type Builder = (ctx: ReportCtx, args: ReportArgs) => unknown | Promise<unknown>;

const BUILDERS: Record<string, Builder> = {
  forecast: (ctx) => getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log),
  degradation: (ctx) => computeDegradation(devicesOf(ctx), ctx.recorder),
  runway: async (ctx) => {
    const fc = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log);
    return computeRunway(devicesOf(ctx), ctx.recorder, fc);
  },
  roundTripEfficiency: (ctx, a) => computeRoundTripEfficiency(devicesOf(ctx), ctx.recorder, a.days ?? 7),
  clipping: async (ctx) => {
    const fc = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log);
    return computeClipping(devicesOf(ctx), ctx.recorder, fc);
  },
  curtailment: (ctx) => computeCurtailment(devicesOf(ctx), ctx.recorder),
  curtailmentAlerts: (ctx) => computeCurtailmentAlerts(devicesOf(ctx), ctx.recorder),
  baselineAlerts: (ctx) => computeBaselineAlerts(devicesOf(ctx), ctx.recorder),
  forecastAlerts: async (ctx) => {
    // v0.41.0 — pass the depletion-aware day forecast so computeForecastAlerts can gate
    // the trailing-3h runtime alert on it (suppresses the false overnight depletion).
    const fc = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log);
    return computeForecastAlerts(devicesOf(ctx), ctx.recorder, fc);
  },
  selfConsumption: (ctx, a) => computeSelfConsumption(devicesOf(ctx), ctx.recorder, a.days ?? 7),
  carbon: (ctx, a) => computeCarbonReport(devicesOf(ctx), ctx.recorder, a.days ?? 7),
  tariff: (ctx, a) => computeTariffReport(devicesOf(ctx), ctx.recorder, a.days ?? 7),
  thermalEvents: (ctx) => computeThermalEvents(devicesOf(ctx), ctx.recorder),
  equipmentHealth: (ctx) => computeEquipmentHealth(devicesOf(ctx), ctx.recorder),
  shadeReport: (ctx) => computeShadeReport(devicesOf(ctx), ctx.recorder),
  soilingDecomposition: (ctx) => computeSoilingDecomposition(devicesOf(ctx), ctx.recorder),
  stringMismatch: (ctx) => computeStringMismatch(devicesOf(ctx), ctx.recorder),
  evWindowPrediction: (ctx) => computeEvWindowPrediction(devicesOf(ctx), ctx.recorder),
  chargeCurve: (ctx) => computeChargeCurveFingerprint(devicesOf(ctx), ctx.recorder),
  internalResistance: (ctx) => computeInternalResistance(devicesOf(ctx), ctx.recorder),
  forecastSkill: async (ctx, a) => {
    const fc = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log);
    // v1.173.0 (GHI stage 2) — display/diagnostic skill (/api/forecast-skill, /api/confidence,
    // the forecast-bias repair card) scores the MODEL against realized irradiance.
    return computeForecastSkill(devicesOf(ctx), ctx.recorder, fc, a.days ?? 7, 'realized');
  },
  ambientThermal: (ctx) => computeAmbientThermalForecast(devicesOf(ctx), ctx.recorder),
  probabilisticForecast: async (ctx) => {
    const fc = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log);
    // v1.30.0 — feed the band a 30-day skill window (PV_BAND_CAL_WINDOW_DAYS),
    // not the 7-day default: the F30 calibration gate needs ≥14 SCORED days,
    // which a 7-day report can never contain (bandSigmaCal sat pinned at 1 in
    // production since v1.23.0) and a 14-day window only reaches at 100%
    // weather/telemetry coverage (live: 9/14). One window serves BOTH skillFrac
    // and the calibration so the shrink ratio is measured on the same sample
    // the sigma was built from.
    // v1.173.0 (GHI stage 2) kept this on the first-write basis pending a policy decision:
    // this skill sets skillFrac, bandSigmaCal, bandRealizedCoveragePct (the night-charge
    // basis gate) and realizedDailyErrHalfFrac (the multi-day P10/P90 widening that sizes
    // the buy). ★ v1.173.1 (2026-09-21) — policy: the calibrator uses the more accurate
    // data. It now scores on REALIZED irradiance: the band stops carrying a
    // ~3-4-day-lead weather-forecast error that is not the day-ahead band's own error, and
    // the multi-day widening narrows accordingly (~40% on the 2026-09 window) — weekend
    // carries buy somewhat less. Hours with no realized capture fall back to first-write.
    const skill = await computeForecastSkill(
      devicesOf(ctx), ctx.recorder, fc, PV_BAND_CAL_WINDOW_DAYS, 'realized',
    );
    return computeProbabilisticForecast(fc, skill);
  },
  multiDayForecast: async (ctx, a) => {
    const fc = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log);
    return computeMultiDayForecast(devicesOf(ctx), ctx.recorder, fc, a.days ?? 3);
  },
  bayesianSolar: (ctx) => computeBayesianSolarModel(devicesOf(ctx), ctx.recorder),
  totals: (ctx, a) => computeTotals(shimStore(ctx), ctx.recorder, a.sinceMs ?? 0, a.untilMs ?? Date.now()),
  circuitHistory: (ctx, a) => circuitHistoryByDay(ctx.recorder, a.sn ?? '', a.ch ?? 0, a.days ?? 7, a.metric),
  // v0.13.1 — we can't postMessage a function, so the worker reconstructs the
  // predictor from args: a 24-slot diurnal curve (curve[hourOfDay], night≈0 /
  // noon≈peak) when present, else the legacy flat scalar. The flat constant is
  // why the backtest scored R²≈0 — it predicted the same Wh for night and noon.
  backtest: async (ctx, a) => {
    const hoursBack = a.hoursBack ?? 168;
    const dpuSns = a.dpuSns ?? [];
    const baseline = backtestPvForecast({
      recorder: ctx.recorder,
      dpuSns,
      hoursBack,
      predict:
        a.typicalPvCurveWhPerHour && a.typicalPvCurveWhPerHour.length === 24
          ? diurnalBaselinePredictor(a.typicalPvCurveWhPerHour)
          : () => a.typicalWhPerHour ?? 0,
    });
    // v1.11.0 (review F24) — ALSO score the real alarm-facing model, so the
    // reported skill reflects what computeRunway actually consumes.
    let alarmModel: unknown = null;
    try {
      const fc: any = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log);
      if (fc?.solarModel?.hourly?.length === 24) {
        alarmModel = backtestPvForecast({
          recorder: ctx.recorder,
          dpuSns,
          hoursBack,
          predict: alarmModelPredictor(fc, ctx.recorder, Date.now(), hoursBack),
        });
      }
    } catch { /* alarm-model score is best-effort; baseline still returned */ }
    // v1.11.0 (review F24) — spell out the two bias conventions so the seed
    // contradiction (backtest bias > 0 "over-forecast" vs pvBiasFactor > 1
    // "under-forecast") is reconciled, not just presented side by side.
    return {
      ...baseline,
      model: 'typical-day-baseline',
      alarmModel,
      biasConvention:
        "bias = mean(predicted − actual) Wh/h; POSITIVE = the model over-forecast PV. Distinct from /api/confidence.pvBiasFactor = Σactual/Σpredicted (a MULTIPLIER); pvBiasFactor > 1 = the raw model UNDER-produces and the alarm scales PV UP. The two describe the SAME error with opposite-signed conventions.",
    };
  },
};

export type ReportName = keyof typeof BUILDERS;

export function isReportName(name: string): name is ReportName {
  return Object.prototype.hasOwnProperty.call(BUILDERS, name);
}

/**
 * v1.186.0 — worker-side single-flight, keyed by report name + args.
 *
 * Log 2026-09-23: 'report:degradation' timed out after 6 of 7 boots. The builders check their
 * TTL cache on entry and fill it only at the end, and nothing serialised the worker's async
 * message handler, so the self-warm loop's cold 'degradation', the HA publish's request and
 * the analytics client's retry after a 30 s timeout each ran their own full scan on the one
 * worker thread — the retry started a third copy while the worker was at its busiest.
 *
 * A caller whose key is already in flight now joins that computation and receives its result.
 * The key is EXACT (sorted keys, numbers untruncated — unlike the client's cache key): a join
 * must return precisely what was asked for. The slot clears when the flight settles, success
 * or failure, so a rejection is never cached. A flight older than FLIGHT_MAX_JOIN_MS is presumed
 * wedged and is not joined: the longest builder runs ~20 s, and a hung promise must not
 * silence an alarm-path report (forecast, runway, the alert reports) for the life of the
 * process — before v1.186.0 every request computed independently, and that stays the fallback.
 */
export const FLIGHT_MAX_JOIN_MS = 5 * 60_000;

export const buildFlightKey = (name: string, args: ReportArgs): string => {
  const keys = Object.keys(args ?? {}).sort();
  if (keys.length === 0) return name;
  const canon: Record<string, unknown> = {};
  for (const k of keys) canon[k] = (args as Record<string, unknown>)[k];
  return name + ' ' + JSON.stringify(canon);
};

export interface KeyedFlights {
  run<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
  size(): number;
}

export function keyedSingleFlight(maxJoinMs: number = FLIGHT_MAX_JOIN_MS, now: () => number = Date.now): KeyedFlights {
  const flights = new Map<string, { p: Promise<unknown>; startedMs: number }>();
  return {
    run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
      const t = now();
      const flying = flights.get(key);
      if (flying && t - flying.startedMs < maxJoinMs) return flying.p as Promise<T>;
      // The builder starts on a microtask AFTER the slot is registered, so a builder that
      // throws synchronously still settles through the same finally and frees its slot.
      const p: Promise<T> = Promise.resolve()
        .then(fn)
        .finally(() => { if (flights.get(key)?.p === p) flights.delete(key); });
      flights.set(key, { p, startedMs: t });
      return p;
    },
    size: () => flights.size,
  };
}

const reportFlights = keyedSingleFlight();

export async function buildReport(name: string, ctx: ReportCtx, args: ReportArgs = {}): Promise<unknown> {
  const b = BUILDERS[name];
  if (!b) throw new Error(`unknown report '${name}'`);
  return reportFlights.run(buildFlightKey(name, args), () => b(ctx, args));
}

/** v1.186.0 — give queued macrotasks (the worker's 'message' events) a turn. Awaiting a
 *  synchronous builder only resumes as a microtask, which never lets a message in. */
export const yieldTurn = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/**
 * v1.186.0 — one self-warm pass over `names`, yielding a macrotask turn after every report.
 *
 * The pass awaited 22 builders back to back, and for the synchronous ones `await` resumes as a
 * microtask: when several TTLs expired in the same 4-min cycle they ran as one uninterrupted
 * block, and the alarm path's requests (forecast, runway, curtailmentAlerts, baselineAlerts,
 * forecastAlerts) queued behind all of them. A failing report is logged and the pass goes on.
 */
export async function warmReports(
  build: (name: ReportName) => unknown,
  onError: (name: ReportName, e: unknown) => void,
  names: readonly ReportName[] = WARM_REPORTS,
): Promise<void> {
  for (const name of names) {
    try { await build(name); }
    catch (e) { onError(name, e); }
    await yieldTurn();
  }
}

/**
 * Reports the self-warm loop precomputes every cycle to keep the worker's
 * internal TTL caches hot — the no-argument reports that /api/ha-state and the
 * dashboard tabs hit on every poll. Argument-parameterised reports
 * (circuitHistory, totals, and the {days}-overridable ones) are computed
 * on demand; their default-arg form is still warmed via this list.
 */
export const WARM_REPORTS: ReportName[] = [
  'forecast',
  'degradation',
  'runway',
  'roundTripEfficiency',
  'clipping',
  'curtailment',
  'selfConsumption',
  'carbon',
  'tariff',
  'thermalEvents',
  'equipmentHealth',
  'shadeReport',
  'soilingDecomposition',
  'stringMismatch',
  'evWindowPrediction',
  'chargeCurve',
  'internalResistance',
  'forecastSkill',
  'ambientThermal',
  'probabilisticForecast',
  'multiDayForecast',
  'bayesianSolar',
];

export type { Alert };
