import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

/**
 * v0.13.2 — onlineLR bias clamp (audit P3-3).
 *
 * Defense-in-depth on top of v0.13.0's degenerate-feature guard. Even a
 * legitimate stream of one-sided y=1 labels (every alert ack'd, never
 * dismissed) drives `bias -= η·(p−1)` monotonically upward. The clamp bounds
 * the online bias to within ±1.0 of the on-disk BASELINE bias so the
 * intercept can't walk unboundedly. Weights and the inference path are
 * untouched.
 *
 * The clamp anchors to the BASE model at MODEL_PATH (never the shadow, which
 * carries accumulated drift), so we seed BOTH files. Path-override strategy
 * mirrors onlineLrGuard.test.ts: onlineLR.ts freezes MODEL_PATH/SHADOW_PATH at
 * module load via resolve(cwd, dbPath, '..', 'models', ...). DB_PATH MUST be
 * set before the dynamic import.
 */

const tmpRoot = mkdtempSync(resolve(tmpdir(), 'online-lr-clamp-test-'));
const dbDir = join(tmpRoot, 'db');
const modelsDir = join(dbDir, 'models');
const dbPath = join(dbDir, 'ecoflow.db');
mkdirSync(modelsDir, { recursive: true });

const MODEL_PATH = join(modelsDir, 'pack-risk-lr-v1.json');
const SHADOW_PATH = join(modelsDir, 'pack-risk-lr-v1-online.json');

process.env.DB_PATH = dbPath;

const { updateFromOutcome, loadShadowModel } = await import('../src/models/onlineLR.js');

const FEATURE_NAMES = [
  'peerFadeRatio', 'rTrend', 'coulombicEffPct',
  'hardLifeScore', 'ccDriftMv', 'fadePctPerYear',
] as const;

const BASELINE_BIAS = -2.5;
const BIAS_CLAMP = 1.0;

function makeBaseline(bias = BASELINE_BIAS) {
  return {
    version: 'test-baseline',
    trainedAt: 1_700_000_000_000,
    samples: 7,
    source: 'heuristic-distilled' as const,
    weights: {
      peerFadeRatio: 1.5, rTrend: 0.9, coulombicEffPct: 0.9,
      hardLifeScore: 0.9, ccDriftMv: 0.6, fadePctPerYear: 1.2,
    },
    bias,
    finalLoss: 0,
  };
}

/** Seed BOTH the base (clamp anchor) and the shadow (loadCurrent source). */
function seedBoth(bias = BASELINE_BIAS) {
  writeFileSync(MODEL_PATH, JSON.stringify(makeBaseline(bias), null, 2));
  writeFileSync(SHADOW_PATH, JSON.stringify(makeBaseline(bias), null, 2));
}

/** A genuine pack-level vector — discriminative, so the SGD step runs. */
function ackOutcome() {
  return {
    ts: Date.now(),
    alertId: 'pack-hot-clamp',
    outcome: 'ack' as const,
    lrFeatures: {
      peerFadeRatio: 0.4, rTrend: 0.3, coulombicEffPct: 0.2,
      hardLifeScore: 0.5, ccDriftMv: 0.4, fadePctPerYear: 0.6,
    },
    source: {},
  } as any;
}

test('online bias stays within ±1.0 of baseline after many one-sided ack updates', () => {
  seedBoth();

  // Replay the audit scenario: a long run of one-sided y=1 (ack) labels, each
  // pushing the bias upward. Without the clamp this walks monotonically.
  for (let i = 0; i < 200; i++) {
    const res = updateFromOutcome(ackOutcome());
    assert.equal(res.updated, true, 'each real-vector update should train');

    const m = loadShadowModel();
    assert.ok(
      m.bias <= BASELINE_BIAS + BIAS_CLAMP + 1e-9,
      `bias ${m.bias} must not exceed baseline+clamp (iter ${i})`,
    );
    assert.ok(
      m.bias >= BASELINE_BIAS - BIAS_CLAMP - 1e-9,
      `bias ${m.bias} must not fall below baseline-clamp (iter ${i})`,
    );
  }

  // After saturating, the bias should be pinned at the upper bound, not beyond.
  const end = loadShadowModel();
  assert.ok(
    Math.abs(end.bias - (BASELINE_BIAS + BIAS_CLAMP)) < 0.05,
    `bias ${end.bias} should be pinned near baseline+clamp after saturation`,
  );
});

test('clamp anchors to the BASE model bias, not the drifted shadow', () => {
  // Base bias = -2.5; shadow seeded already at the upper edge (-1.5). One more
  // ack must not push past base+clamp = -1.5, proving the anchor is the base
  // file (if it anchored to the shadow, the band would float upward with it).
  writeFileSync(MODEL_PATH, JSON.stringify(makeBaseline(-2.5), null, 2));
  writeFileSync(SHADOW_PATH, JSON.stringify(makeBaseline(-1.5), null, 2));

  const res = updateFromOutcome(ackOutcome());
  assert.equal(res.updated, true);

  const m = loadShadowModel();
  assert.ok(
    m.bias <= -1.5 + 1e-9,
    `bias ${m.bias} must stay at/under base+clamp (-1.5), not float with the shadow`,
  );
});

test('weights still move under the bias clamp (inference path untouched)', () => {
  seedBoth();
  const before = makeBaseline();

  updateFromOutcome(ackOutcome());

  const after = loadShadowModel();
  // The clamp bounds only the bias — the data-term weight updates must remain.
  let anyWeightMoved = false;
  for (const n of FEATURE_NAMES) {
    if (after.weights[n] !== before.weights[n]) anyWeightMoved = true;
    assert.ok(Number.isFinite(after.weights[n]), `weight ${n} must stay finite`);
  }
  assert.ok(anyWeightMoved, 'at least one weight must still move under the clamp');
});
