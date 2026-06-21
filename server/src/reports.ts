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
  computeAmbientThermalForecast,
  computeProbabilisticForecast,
  computeMultiDayForecast,
  computeBayesianSolarModel,
  diurnalBaselinePredictor,
} from './analytics.js';
import { computeTotals, circuitHistoryByDay } from './aggregator.js';
import { backtestPvForecast } from './backtest.js';

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
    return computeForecastSkill(devicesOf(ctx), ctx.recorder, fc, a.days ?? 7);
  },
  ambientThermal: (ctx) => computeAmbientThermalForecast(devicesOf(ctx), ctx.recorder),
  probabilisticForecast: async (ctx) => {
    const fc = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log);
    const skill = await computeForecastSkill(devicesOf(ctx), ctx.recorder, fc);
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
  backtest: (ctx, a) => backtestPvForecast({
    recorder: ctx.recorder,
    dpuSns: a.dpuSns ?? [],
    hoursBack: a.hoursBack ?? 168,
    predict:
      a.typicalPvCurveWhPerHour && a.typicalPvCurveWhPerHour.length === 24
        ? diurnalBaselinePredictor(a.typicalPvCurveWhPerHour)
        : () => a.typicalWhPerHour ?? 0,
  }),
};

export type ReportName = keyof typeof BUILDERS;

export function isReportName(name: string): name is ReportName {
  return Object.prototype.hasOwnProperty.call(BUILDERS, name);
}

export async function buildReport(name: string, ctx: ReportCtx, args: ReportArgs = {}): Promise<unknown> {
  const b = BUILDERS[name];
  if (!b) throw new Error(`unknown report '${name}'`);
  return await b(ctx, args);
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
