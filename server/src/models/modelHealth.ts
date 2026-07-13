/**
 * v0.9.27 — Aggregate model-health report.
 *
 * Pulls together signals from across the codebase to give the operator
 * (and future me debugging) ONE place to see how every model is doing:
 *
 *   - Pack-risk LR: precision/recall from outcomes, shadow-vs-baseline drift
 *   - Forecast: RMSE/MAE/bias from the backtest harness
 *   - Alert families: precision per family from the outcome log
 *   - Online learning: sample count + last-update timestamp
 *
 * The view is "model health dashboard" — like a hospital chart for each
 * model. Used by the Science-station Model Health panel.
 */

import { computeFamilyStats } from '../alertOutcomes.js';
import { loadShadowModel } from './onlineLR.js';
import { loadBaselineModelOnly, DEFAULT_MODEL, loadModel, computeGateDecision } from '../ml.js';
import { FEATURE_NAMES } from '../ml.js';

export interface ModelHealthReport {
  generatedAt: number;
  packRiskLr: {
    baseline: { version: string; trainedAt: number; samples: number; source: string };
    shadow: { version: string; trainedAt: number; samples: number; source: string };
    /** Per-weight delta between baseline and shadow.
     *  Magnitude shows how much the online updates have moved the model. */
    weightDeltas: Record<string, number>;
    /** L2 norm of weight differences — a single summary statistic.
     *  v1.18.0 (F16): read `driftBasis` before trusting this number — with no
     *  on-disk baseline it measures movement from the IN-CODE SEED, not drift
     *  from a trained baseline (the gate's driftL2 reads null in that case). */
    totalDriftL2: number;
    /** v1.18.0 (F16) — what totalDriftL2 was computed against. */
    driftBasis: 'baseline' | 'default-seed';
    /** v1.18.0 (F16) — whether a trained baseline file exists on disk. */
    baselineOnDisk: boolean;
    /** Samples seen since last full retrain. */
    onlineSamples: number;
    /**
     * v0.13.0 — Online samples that ACTUALLY moved the weights (any
     * |Δw| > EPSILON between baseline and shadow). When online updates run
     * but the shadow ends up identical to the baseline — the P0-2 no-op
     * regression — this reads 0 while `onlineSamples` still shows the raw
     * counter, making the no-op visible instead of silently "13 updates,
     * 0 drift". Equals `onlineSamples` in the healthy case.
     */
    effectiveOnlineSamples: number;
  };
  alertFamilies: ReturnType<typeof computeFamilyStats>;
  /** Total alerts with operator verdicts. */
  labeledAlertCount: number;
  /** Overall precision across all families that have decided outcomes.
   *  v1.18.0 (F16) — same evidence semantics as the pack-risk gate: null
   *  unless the stream contains >= 1 dismissal and >= 3 decided outcomes.
   *  A one-class all-'ack' stream is not a measurement (the live system's 33
   *  batch-acks rendered a fake permanent 1.0 here). */
  overallPrecision: number | null;
  /** v1.18.0 (F16) — the authoritative auto-downgrade gate verdict for the
   *  CURRENTLY SERVED pack-risk model (same object /api/pack-risk/v2 reports),
   *  so the health surface and the gate can never disagree again. */
  gate: ReturnType<typeof computeGateDecision>;
}

/** Below this magnitude a weight delta is treated as "no movement" — guards
 *  against float noise counting as real drift in effectiveOnlineSamples. */
const DELTA_EPSILON = 1e-9;

export function computeModelHealth(): ModelHealthReport {
  // v0.13.0 — Resolve a TRUE baseline. Previously this called `loadModel()`,
  // which PREFERS the shadow file (pack-risk-lr-v1-online.json) when it exists
  // — so `baseline` and `shadow` were the SAME on-disk artifact, every
  // weightDelta was 0, and onlineSamples was 0 even after real online updates
  // had run. `loadBaselineModelOnly()` reads MODEL_PATH (the frozen baseline)
  // directly; when no trained baseline exists yet we fall back to the in-code
  // DEFAULT_MODEL rather than the shadow, so the comparison stays honest.
  const baselineOnDisk = loadBaselineModelOnly();
  // v1.18.0 (F16) — keep the per-weight movement detail even with no trained
  // baseline (movement since the in-code seed is still diagnostic), but LABEL
  // the basis: the pre-fix report presented seed-relative movement as if it
  // were measured baseline drift (the live +0.586 all-bias walk rendered as
  // authoritative drift while the gate saw nothing).
  const baseline = baselineOnDisk ?? DEFAULT_MODEL;
  const shadow = loadShadowModel();
  const weightDeltas: Record<string, number> = {};
  let l2sq = 0;
  let movedDeltas = 0;
  for (const name of FEATURE_NAMES) {
    const b = baseline.weights[name] ?? 0;
    const s = shadow.weights[name] ?? 0;
    const d = s - b;
    weightDeltas[name] = d;
    l2sq += d * d;
    if (Math.abs(d) > DELTA_EPSILON) movedDeltas++;
  }
  const biasDelta = shadow.bias - baseline.bias;
  weightDeltas['_bias'] = biasDelta;
  l2sq += biasDelta * biasDelta;
  if (Math.abs(biasDelta) > DELTA_EPSILON) movedDeltas++;

  const families = computeFamilyStats();
  let totalReal = 0;
  let totalDecided = 0;
  let labeledCount = 0;
  for (const f of families) {
    labeledCount += f.total;
    const real = f.ack + f.failed;
    const decided = real + f.dismiss;
    totalReal += real;
    totalDecided += decided;
  }
  // v1.18.0 (F16) — single-source the gate verdict and the evidence-guarded
  // precision from computeGateDecision (the exact object /api/pack-risk/v2
  // serves), instead of re-deriving both with the disavowed pre-F16 math.
  const gate = computeGateDecision(loadModel());
  const overallPrecision = gate.overallPrecision;
  void totalReal; void totalDecided;

  return {
    generatedAt: Date.now(),
    packRiskLr: {
      baseline: {
        version: baseline.version,
        trainedAt: baseline.trainedAt,
        samples: baseline.samples,
        source: baseline.source,
      },
      shadow: {
        version: shadow.version,
        trainedAt: shadow.trainedAt,
        samples: shadow.samples,
        source: shadow.source,
      },
      weightDeltas,
      totalDriftL2: Math.sqrt(l2sq),
      driftBasis: (baselineOnDisk ? 'baseline' : 'default-seed') as 'baseline' | 'default-seed',
      baselineOnDisk: baselineOnDisk != null,
      onlineSamples: Math.max(0, shadow.samples - baseline.samples),
      // v0.13.0 — honest count: the raw online-sample delta, but only when
      // SOMETHING actually moved. If every weight (and bias) is within
      // EPSILON of the baseline, no online learning took effect regardless of
      // what the counter claims, so report 0 — surfacing a P0-2-style no-op.
      effectiveOnlineSamples:
        movedDeltas > 0 ? Math.max(0, shadow.samples - baseline.samples) : 0,
    },
    alertFamilies: families,
    labeledAlertCount: labeledCount,
    overallPrecision,
    gate,
  };
}
