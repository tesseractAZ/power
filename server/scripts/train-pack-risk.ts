#!/usr/bin/env tsx
/**
 * v0.9.4 — Pack-risk logistic regression trainer.
 *
 * Reads the live SnapshotStore + recorder DB, builds feature vectors
 * for every pack in the fleet, generates training labels (real if
 * `data/labels.csv` exists; heuristic-distilled otherwise), fits a
 * logistic regression model, and writes the result to
 * `data/models/pack-risk-lr-v1.json`. The server picks up the new
 * model on next API request (cached 5 min).
 *
 * Run from the server directory:
 *
 *   ECOFLOW_ACCESS_KEY=... ECOFLOW_SECRET_KEY=... npx tsx scripts/train-pack-risk.ts
 *
 * Or via the npm script: `npm run train-pack-risk`.
 *
 * To use real failure labels: create `data/labels.csv` with one row
 * per failed pack:
 *
 *   sn,packNum,failed_at_ts
 *   Y711XXXXXXXX,2,1730000000000
 *   Y711YYYYYYYY,1,1740000000000
 *
 * Re-run the trainer. Model version flips from `lr-heuristic-baseline-v1`
 * to `lr-labeled-v1`.
 */

import { SnapshotStore, refreshAll } from '../src/snapshot.js';
import { createRecorder } from '../src/recorder.js';
import {
  computeDegradation,
  computeThermalEvents,
  computeInternalResistance,
  computeChargeCurveFingerprint,
  computePackRiskScores,
} from '../src/analytics.js';
import { extractFeatures, buildTrainingData, trainLrModel, saveModel } from '../src/ml.js';
import type { FeatureVector } from '../src/ml.js';

const log = (m: string) => console.log(`[train-pack-risk] ${m}`);

async function main() {
  log('starting');
  const store = new SnapshotStore();
  const recorder = createRecorder(store, (m) => log(m));
  log('refreshing snapshot from EcoFlow Cloud…');
  await refreshAll(store);

  const devices = store.get().devices;
  const dpus = Object.values(devices).filter((d) => d.projection?.kind === 'dpu');
  log(`fleet: ${dpus.length} DPU(s), ${dpus.reduce((s, d: any) => s + d.projection.packs.length, 0)} pack(s)`);

  const degradation = computeDegradation(devices, recorder);
  const thermalEvents = computeThermalEvents(devices, recorder);
  const internalR = computeInternalResistance(devices, recorder);
  const chargeCurve = computeChargeCurveFingerprint(devices, recorder);
  const heuristicScores = computePackRiskScores(devices, degradation, thermalEvents, internalR, chargeCurve);

  // Build feature vectors per pack
  const features: FeatureVector[] = [];
  for (const d of dpus) {
    for (const pk of (d as any).projection.packs) {
      features.push(extractFeatures(d.sn, pk.num, degradation, thermalEvents, internalR, chargeCurve));
    }
  }
  log(`extracted ${features.length} feature vectors`);

  const { samples, source } = buildTrainingData(heuristicScores.packs, features);
  const nPositive = samples.filter((s) => s.label === 1).length;
  log(`training data: ${samples.length} samples (${nPositive} positive, ${samples.length - nPositive} negative), source=${source}`);

  if (samples.length < 5) {
    log('ERROR: too few samples to train. Need at least 5; the fleet must have data flowing.');
    process.exit(1);
  }
  if (nPositive === 0 || nPositive === samples.length) {
    log('WARN: training data is single-class (all positive or all negative). The model will learn the bias but no feature weights.');
  }

  log('fitting logistic regression (gradient descent, 2000 iterations)…');
  const model = trainLrModel(samples, source);
  log(`training complete — final loss ${model.finalLoss}, source=${model.source}`);
  log('learned weights:');
  for (const [name, w] of Object.entries(model.weights)) {
    log(`  ${name.padEnd(20)} ${w >= 0 ? ' ' : ''}${w.toFixed(4)}`);
  }
  log(`  ${'bias'.padEnd(20)} ${model.bias >= 0 ? ' ' : ''}${model.bias.toFixed(4)}`);

  saveModel(model);
  log(`wrote model to data/models/pack-risk-lr-v1.json (version ${model.version})`);
  log('done — the server will pick up the new model on the next API call (5-min cache).');

  recorder.close();
}

main().catch((e) => {
  console.error('[train-pack-risk] failed:', e);
  process.exit(1);
});
