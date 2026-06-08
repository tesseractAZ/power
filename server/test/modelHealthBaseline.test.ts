import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

/**
 * v0.13.0 — Regression test for P2-3: models_health reported "0 online
 * updates" because it compared the shadow model against itself.
 *
 * Root cause: modelHealth.ts loaded its "baseline" via ml.ts's `loadModel()`,
 * which PREFERS the online-shadow file when present. Baseline and shadow then
 * resolved to the SAME on-disk artifact → every weightDelta was 0 and
 * onlineSamples was 0, even though real online updates had run.
 *
 * The fix routes the baseline side through `loadBaselineModelOnly()`, which
 * reads the frozen baseline file directly (never the shadow). This test pins
 * that helper: with a baseline file AND a DIFFERENT shadow file both on disk,
 * `loadBaselineModelOnly()` must return the BASELINE, while `loadModel()`
 * (the inference path) still prefers the shadow — so a real
 * baseline-vs-shadow comparison yields non-zero weight deltas.
 *
 * ml.ts derives MODEL_PATH/SHADOW_PATH from `config.dbPath` (process.env
 * DB_PATH) at module-load time, so we point DB_PATH at a fresh tmp dir and
 * write both model files BEFORE dynamically importing ml.js.
 */

/** A baseline model and a deliberately-different "online-updated" shadow. */
const BASELINE_MODEL = {
  version: 'lr-heuristic-baseline-v1',
  trainedAt: 1_000,
  samples: 13,
  source: 'heuristic-distilled' as const,
  weights: {
    peerFadeRatio: 1.5,
    rTrend: 0.9,
    coulombicEffPct: 0.9,
    hardLifeScore: 0.9,
    ccDriftMv: 0.6,
    fadePctPerYear: 1.2,
  },
  bias: -2.5,
  finalLoss: 0,
};

const SHADOW_MODEL = {
  ...BASELINE_MODEL,
  version: 'lr-labeled-v1',
  trainedAt: 2_000,
  // 13 online SGD steps landed on top of the baseline's 13 training samples.
  samples: 26,
  source: 'labeled' as const,
  weights: {
    peerFadeRatio: 1.9, // moved
    rTrend: 0.4, // moved
    coulombicEffPct: 0.9,
    hardLifeScore: 0.9,
    ccDriftMv: 0.6,
    fadePctPerYear: 1.5, // moved
  },
  bias: -2.1, // moved
};

test('loadBaselineModelOnly returns the BASELINE file, not the shadow, when both exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecoflow-mh-baseline-'));
  // ml.ts computes MODEL_PATH as resolve(cwd, dbPath, '..', 'models', ...),
  // so DB_PATH's parent dir is where the models/ folder lives. Put the db
  // one level deep so '..' lands back in `dir`.
  const dbPath = join(dir, 'db', 'ecoflow.db');
  process.env.DB_PATH = dbPath;

  const modelsDir = resolve(dbPath, '..', 'models');
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(join(modelsDir, 'pack-risk-lr-v1.json'), JSON.stringify(BASELINE_MODEL));
  writeFileSync(join(modelsDir, 'pack-risk-lr-v1-online.json'), JSON.stringify(SHADOW_MODEL));

  const { loadBaselineModelOnly, loadModel } = await import('../src/ml.js');

  const baseline = loadBaselineModelOnly();
  const inferenceModel = loadModel();

  // The baseline helper must read the frozen baseline file...
  assert.ok(baseline, 'baseline should be loaded from the on-disk baseline file');
  assert.equal(baseline!.version, BASELINE_MODEL.version);
  assert.equal(baseline!.samples, 13);

  // ...while loadModel (inference path) still prefers the shadow.
  assert.equal(inferenceModel.version, SHADOW_MODEL.version);
  assert.equal(inferenceModel.samples, 26);

  // The whole point: they are NOT the same model. If they were (the P2-3
  // bug), every drift delta would be 0.
  assert.notEqual(baseline!.version, inferenceModel.version);
  assert.notEqual(baseline!.bias, inferenceModel.bias);
});

test('baseline-vs-shadow weight deltas are non-zero (drift is real, not self-comparison)', async () => {
  // Reuse the same fixtures: compute the deltas the way computeModelHealth
  // does and assert they actually reflect movement.
  const { loadBaselineModelOnly } = await import('../src/ml.js');
  const baseline = loadBaselineModelOnly();
  assert.ok(baseline, 'baseline fixture should still be readable');

  const names = ['peerFadeRatio', 'rTrend', 'coulombicEffPct', 'hardLifeScore', 'ccDriftMv', 'fadePctPerYear'] as const;
  let nonZero = 0;
  for (const n of names) {
    const d = (SHADOW_MODEL.weights[n] ?? 0) - (baseline!.weights[n] ?? 0);
    if (Math.abs(d) > 1e-9) nonZero++;
  }
  const biasDelta = SHADOW_MODEL.bias - baseline!.bias;

  assert.ok(nonZero > 0, 'at least one weight delta must be non-zero — drift must be observable');
  assert.notEqual(biasDelta, 0, 'bias delta must be non-zero');
  // Pre-fix, baseline === shadow → every one of these would be exactly 0.
  assert.notEqual(baseline!.weights.peerFadeRatio, SHADOW_MODEL.weights.peerFadeRatio);
});
