import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

/**
 * v0.13.0 — onlineLR degenerate-feature guard (audit P0-2).
 *
 * A non-pack outcome (system / SHP2 / EVSE family — no packNum, no captured
 * lrFeatures) collapses to an ALL-ZERO proxy vector. With x=0 the SGD
 * gradient `error*x + L2*w` loses its data term and ONLY the bias moves, so
 * each such outcome silently inflates the pack-risk baseline with zero
 * discrimination. The 7-day audit observed 13 system-level labels walking
 * the baseline 2.5%→12.9% while every weightDelta stayed exactly 0.
 *
 * The guard in updateFromOutcome skips the SGD step BEFORE the gradient when
 * the feature vector is all-zero (or carries any NaN/Inf), returning
 * { updated:false, reason:'degenerate-features' }. A real non-zero vector
 * must still train (weights AND bias move).
 *
 * Path-override strategy mirrors ml-feedback.test.ts: onlineLR.ts freezes
 * MODEL_PATH/SHADOW_PATH at module load via resolve(cwd, dbPath, '..',
 * 'models', ...). We set DB_PATH BEFORE the dynamic import so the shadow
 * model writes into our tmpdir, never the real /data.
 */

const tmpRoot = mkdtempSync(resolve(tmpdir(), 'online-lr-guard-test-'));
const dbDir = join(tmpRoot, 'db');
const modelsDir = join(dbDir, 'models');
const dbPath = join(dbDir, 'ecoflow.db');
mkdirSync(modelsDir, { recursive: true });

// loadCurrent() prefers the shadow model, so seeding the shadow path is
// sufficient — we never need to write the base MODEL_PATH here.
const SHADOW_PATH = join(modelsDir, 'pack-risk-lr-v1-online.json');

// Must be set before the dynamic import — onlineLR.ts freezes its paths at
// module-load time.
process.env.DB_PATH = dbPath;

const { updateFromOutcome, loadShadowModel } = await import('../src/models/onlineLR.js');

const FEATURE_NAMES = [
  'peerFadeRatio', 'rTrend', 'coulombicEffPct',
  'hardLifeScore', 'ccDriftMv', 'fadePctPerYear',
] as const;

/** Stable known baseline so each test starts from the same weights. */
function makeBaseline() {
  return {
    version: 'test-baseline',
    trainedAt: 1_700_000_000_000,
    samples: 7,
    source: 'heuristic-distilled' as const,
    weights: {
      peerFadeRatio: 1.5, rTrend: 0.9, coulombicEffPct: 0.9,
      hardLifeScore: 0.9, ccDriftMv: 0.6, fadePctPerYear: 1.2,
    },
    bias: -2.5,
    finalLoss: 0,
  };
}

/** Write the baseline into the SHADOW path (loadCurrent prefers shadow). */
function seedShadow() {
  writeFileSync(SHADOW_PATH, JSON.stringify(makeBaseline(), null, 2));
}

/** Minimal AlertOutcomeEntry carrying an explicit captured lrFeatures vector. */
function outcomeWith(lrFeatures: Record<string, number> | null) {
  return {
    ts: Date.now(),
    alertId: 'test-alert',
    outcome: 'ack' as const,
    lrFeatures,
    source: {},
  } as any;
}

const ZERO_VECTOR = Object.fromEntries(FEATURE_NAMES.map((n) => [n, 0]));

test('all-zero feature vector → no update, reason degenerate-features', () => {
  seedShadow();
  const before = makeBaseline();

  const res = updateFromOutcome(outcomeWith({ ...ZERO_VECTOR }));

  assert.equal(res.updated, false, 'should not train on all-zero vector');
  assert.equal(res.reason, 'degenerate-features');

  // Shadow model must be byte-for-byte unchanged: no bias inflation, no
  // weight movement, no samples increment.
  const after = JSON.parse(readFileSync(SHADOW_PATH, 'utf-8'));
  assert.equal(after.bias, before.bias, 'bias must not move on zero vector');
  assert.equal(after.samples, before.samples, 'samples must not increment');
  for (const n of FEATURE_NAMES) {
    assert.equal(after.weights[n], before.weights[n], `weight ${n} must not move`);
  }
});

test('NaN in feature vector → no update, reason degenerate-features', () => {
  seedShadow();
  const before = makeBaseline();

  const res = updateFromOutcome(
    outcomeWith({ ...ZERO_VECTOR, rTrend: NaN }),
  );

  assert.equal(res.updated, false);
  assert.equal(res.reason, 'degenerate-features');

  const after = JSON.parse(readFileSync(SHADOW_PATH, 'utf-8'));
  assert.equal(after.bias, before.bias, 'bias must not move on NaN vector');
  for (const n of FEATURE_NAMES) {
    assert.ok(Number.isFinite(after.weights[n]), `weight ${n} must stay finite`);
    assert.equal(after.weights[n], before.weights[n], `weight ${n} must not move`);
  }
});

test('Infinity in feature vector → no update, reason degenerate-features', () => {
  seedShadow();
  const before = makeBaseline();

  const res = updateFromOutcome(
    outcomeWith({ ...ZERO_VECTOR, ccDriftMv: Infinity }),
  );

  assert.equal(res.updated, false);
  assert.equal(res.reason, 'degenerate-features');

  const after = JSON.parse(readFileSync(SHADOW_PATH, 'utf-8'));
  for (const n of FEATURE_NAMES) {
    assert.equal(after.weights[n], before.weights[n], `weight ${n} must not move`);
  }
});

test('real non-zero feature vector → weights AND bias move', () => {
  seedShadow();
  const before = makeBaseline();

  // A genuine pack-level vector — discriminative signal present.
  const res = updateFromOutcome(
    outcomeWith({
      peerFadeRatio: 0.4,
      rTrend: 0.3,
      coulombicEffPct: 0.2,
      hardLifeScore: 0.5,
      ccDriftMv: 0.4,
      fadePctPerYear: 0.6,
    }),
  );

  assert.equal(res.updated, true, 'should train on a real vector');
  assert.equal(res.reason, undefined);

  const after = JSON.parse(readFileSync(SHADOW_PATH, 'utf-8'));
  assert.equal(after.samples, before.samples + 1, 'samples must increment');
  assert.notEqual(after.bias, before.bias, 'bias must move');

  // At least one weight with non-zero input must have moved — proving the
  // data term (error*x), not just the bias, is contributing. (This is the
  // exact discrimination the audit found missing.)
  let anyWeightMoved = false;
  for (const n of FEATURE_NAMES) {
    if (after.weights[n] !== before.weights[n]) anyWeightMoved = true;
    assert.ok(Number.isFinite(after.weights[n]), `weight ${n} must stay finite`);
  }
  assert.ok(anyWeightMoved, 'at least one weight must move on a real vector');
});

test('repeated all-zero outcomes never inflate the baseline (P0-2 regression)', () => {
  seedShadow();
  const start = loadShadowModel();

  // Replay the audit scenario: many system-level (all-zero) outcomes in a row.
  for (let i = 0; i < 13; i++) {
    const res = updateFromOutcome(outcomeWith({ ...ZERO_VECTOR }));
    assert.equal(res.updated, false);
  }

  const end = loadShadowModel();
  assert.equal(end.bias, start.bias, 'bias must not drift after 13 zero outcomes');
  assert.equal(end.samples, start.samples, 'samples must not increment');
  for (const n of FEATURE_NAMES) {
    assert.equal(end.weights[n], start.weights[n], `weight ${n} must not drift`);
  }
});
