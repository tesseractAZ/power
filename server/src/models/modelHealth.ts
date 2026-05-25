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
import { loadModel as loadBaseLrModel } from '../ml.js';
import { FEATURE_NAMES } from '../ml.js';

export interface ModelHealthReport {
  generatedAt: number;
  packRiskLr: {
    baseline: { version: string; trainedAt: number; samples: number; source: string };
    shadow: { version: string; trainedAt: number; samples: number; source: string };
    /** Per-weight delta between baseline and shadow.
     *  Magnitude shows how much the online updates have moved the model. */
    weightDeltas: Record<string, number>;
    /** L2 norm of weight differences — a single summary statistic. */
    totalDriftL2: number;
    /** Samples seen since last full retrain. */
    onlineSamples: number;
  };
  alertFamilies: ReturnType<typeof computeFamilyStats>;
  /** Total alerts with operator verdicts. */
  labeledAlertCount: number;
  /** Overall precision across all families that have decided outcomes. */
  overallPrecision: number | null;
}

export function computeModelHealth(): ModelHealthReport {
  const baseline = loadBaseLrModel();
  const shadow = loadShadowModel();
  const weightDeltas: Record<string, number> = {};
  let l2sq = 0;
  for (const name of FEATURE_NAMES) {
    const b = baseline.weights[name] ?? 0;
    const s = shadow.weights[name] ?? 0;
    const d = s - b;
    weightDeltas[name] = d;
    l2sq += d * d;
  }
  const biasDelta = shadow.bias - baseline.bias;
  weightDeltas['_bias'] = biasDelta;
  l2sq += biasDelta * biasDelta;

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
  const overallPrecision = totalDecided > 0 ? totalReal / totalDecided : null;

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
      onlineSamples: Math.max(0, shadow.samples - baseline.samples),
    },
    alertFamilies: families,
    labeledAlertCount: labeledCount,
    overallPrecision,
  };
}
