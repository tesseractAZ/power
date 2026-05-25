import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFeature,
  predictRisk,
  trainLrModel,
  computeNovelty,
  FEATURE_NAMES,
  type FeatureVector,
  type LrModel,
} from '../src/ml.js';

/**
 * Tests for the ML feature pipeline + LR predict + novelty detector.
 * Verifies the math without needing a live snapshot or recorder.
 */

test('normalizeFeature — null/undefined raw → 0 (treated as no-risk)', () => {
  for (const name of FEATURE_NAMES) {
    assert.equal(normalizeFeature(name, null), 0);
    assert.equal(normalizeFeature(name, NaN), 0);
    assert.equal(normalizeFeature(name, Infinity), 0);
  }
});

test('normalizeFeature — peerFadeRatio bounds (1.0 = healthy, 2.0 = max risk)', () => {
  assert.equal(normalizeFeature('peerFadeRatio', 1.0), 0);
  assert.equal(normalizeFeature('peerFadeRatio', 1.5), 0.5);
  assert.equal(normalizeFeature('peerFadeRatio', 2.0), 1);
  assert.equal(normalizeFeature('peerFadeRatio', 5.0), 1); // clamped
  assert.equal(normalizeFeature('peerFadeRatio', 0.5), 0); // clamped (better than average → 0 risk)
});

test('normalizeFeature — coulombicEffPct inverted (99% = healthy, 97% = max risk)', () => {
  assert.equal(normalizeFeature('coulombicEffPct', 99), 0);
  assert.equal(normalizeFeature('coulombicEffPct', 98), 0.5);
  assert.equal(normalizeFeature('coulombicEffPct', 97), 1);
  assert.equal(normalizeFeature('coulombicEffPct', 99.5), 0); // clamped
});

test('normalizeFeature — fadePctPerYear (1 %/yr = healthy, 6 = max)', () => {
  assert.equal(normalizeFeature('fadePctPerYear', 1), 0);
  assert.equal(normalizeFeature('fadePctPerYear', 3.5), 0.5);
  assert.equal(normalizeFeature('fadePctPerYear', 6), 1);
});

function buildSampleFeatures(sn: string, packNum: number, vals: Record<string, number>): FeatureVector {
  const values: any = {};
  const normalized: any = {};
  for (const n of FEATURE_NAMES) {
    values[n] = vals[n] ?? null;
    normalized[n] = normalizeFeature(n, vals[n] ?? null);
  }
  return { sn, packNum, values, normalized };
}

test('predictRisk — healthy pack scores near 0 with reasonable weights', () => {
  const model: LrModel = {
    version: 'test', trainedAt: 0, samples: 0, source: 'heuristic-distilled',
    bias: -2.5, finalLoss: 0,
    weights: {
      peerFadeRatio: 1.5, rTrend: 0.9, coulombicEffPct: 0.9,
      hardLifeScore: 0.9, ccDriftMv: 0.6, fadePctPerYear: 1.2,
    },
  };
  // Healthy pack: peer = 1.0, low everything
  const healthy = buildSampleFeatures('Y7-A', 1, {
    peerFadeRatio: 1.0,
    rTrend: 0,
    coulombicEffPct: 99.5,
    hardLifeScore: 10,
    ccDriftMv: 5,
    fadePctPerYear: 1.2,
  });
  const { score0to100 } = predictRisk(healthy, model);
  assert.ok(score0to100 < 25, `expected score < 25 for healthy pack, got ${score0to100}`);
});

test('predictRisk — bad pack scores high', () => {
  const model: LrModel = {
    version: 'test', trainedAt: 0, samples: 0, source: 'heuristic-distilled',
    bias: -2.5, finalLoss: 0,
    weights: {
      peerFadeRatio: 1.5, rTrend: 0.9, coulombicEffPct: 0.9,
      hardLifeScore: 0.9, ccDriftMv: 0.6, fadePctPerYear: 1.2,
    },
  };
  // Bad pack: all features at max risk
  const bad = buildSampleFeatures('Y7-B', 2, {
    peerFadeRatio: 2.5,
    rTrend: 4,
    coulombicEffPct: 96,
    hardLifeScore: 350,
    ccDriftMv: 60,
    fadePctPerYear: 7,
  });
  const { score0to100 } = predictRisk(bad, model);
  assert.ok(score0to100 > 75, `expected score > 75 for bad pack, got ${score0to100}`);
});

test('predictRisk — contributions sum to logit input', () => {
  const model: LrModel = {
    version: 'test', trainedAt: 0, samples: 0, source: 'heuristic-distilled',
    bias: 0, finalLoss: 0,
    weights: {
      peerFadeRatio: 1, rTrend: 1, coulombicEffPct: 1,
      hardLifeScore: 1, ccDriftMv: 1, fadePctPerYear: 1,
    },
  };
  const f = buildSampleFeatures('X', 1, {
    peerFadeRatio: 1.5, rTrend: 1.5, coulombicEffPct: 98, hardLifeScore: 150, ccDriftMv: 25, fadePctPerYear: 3.5,
  });
  const { logit, contributions } = predictRisk(f, model);
  const sumContrib = Object.values(contributions).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(logit - sumContrib) < 1e-9, `logit should equal sum of contributions + bias`);
});

test('trainLrModel — converges on a trivially-separable distilled set', () => {
  // Build samples where label=1 iff feature[0] > 0.5; should learn that
  // peerFadeRatio is the dominant predictor.
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const peerFade = i / 50; // 0..1
    samples.push({
      features: [peerFade, 0.1, 0.1, 0.1, 0.1, 0.1],
      label: (peerFade > 0.5 ? 1 : 0) as 0 | 1,
    });
  }
  const m = trainLrModel(samples, 'heuristic-distilled', { iterations: 1000, learningRate: 0.1 });
  // peerFadeRatio should end up with the largest weight
  const weights = m.weights;
  assert.ok(weights.peerFadeRatio > 0, 'peerFadeRatio weight should be positive');
  assert.ok(
    weights.peerFadeRatio > weights.rTrend,
    `peerFadeRatio (${weights.peerFadeRatio}) should outweigh rTrend (${weights.rTrend})`,
  );
  assert.ok(m.finalLoss < 0.5, `expected low final loss, got ${m.finalLoss}`);
});

test('computeNovelty — homogeneous fleet → near-zero novelty for all', () => {
  const fleet: FeatureVector[] = [];
  for (let i = 0; i < 5; i++) {
    fleet.push(buildSampleFeatures(`SN${i}`, 1, {
      peerFadeRatio: 1.0, rTrend: 0, coulombicEffPct: 99.5,
      hardLifeScore: 10, ccDriftMv: 5, fadePctPerYear: 1.2,
    }));
  }
  const novel = computeNovelty(fleet);
  // All within noise of each other; novelty should be near zero
  for (const n of novel) {
    assert.ok(n.novelty0to100 < 20, `homogeneous fleet should score low novelty, got ${n.novelty0to100} for ${n.sn}`);
  }
});

test('computeNovelty — one outlier pack scores max novelty', () => {
  const fleet: FeatureVector[] = [];
  for (let i = 0; i < 4; i++) {
    fleet.push(buildSampleFeatures(`SN${i}`, 1, {
      peerFadeRatio: 1.0, rTrend: 0, coulombicEffPct: 99.5,
      hardLifeScore: 10, ccDriftMv: 5, fadePctPerYear: 1.2,
    }));
  }
  // One pack at the opposite extreme
  fleet.push(buildSampleFeatures('OUTLIER', 1, {
    peerFadeRatio: 2.5, rTrend: 4, coulombicEffPct: 96,
    hardLifeScore: 350, ccDriftMv: 60, fadePctPerYear: 7,
  }));
  const novel = computeNovelty(fleet);
  const outlier = novel.find((n) => n.sn === 'OUTLIER');
  const normal = novel.find((n) => n.sn === 'SN0');
  assert.ok(outlier);
  assert.equal(outlier!.novelty0to100, 100, 'outlier should score max novelty (100)');
  assert.ok((normal?.novelty0to100 ?? 100) < 50, `normal pack should score low novelty, got ${normal?.novelty0to100}`);
});

test('computeNovelty — empty input returns []', () => {
  assert.deepEqual(computeNovelty([]), []);
});
