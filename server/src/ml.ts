import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config } from './config.js';
import type {
  PackDegradation,
  FleetDegradation,
  FleetThermalEvents,
  ThermalEventCounts,
  InternalResistanceReport,
  InternalResistanceDevice,
  ChargeCurveReport,
  ChargeCurvePack,
  PackRiskScore,
  RiskFactor,
} from './analytics.js';
import type { DeviceSnapshot } from './snapshot.js';
import type { DpuProjection } from './ecoflow/project.js';
import { loadShadowModel } from './models/onlineLR.js';
import { computeFamilyStats } from './alertOutcomes.js';
import { shp2ConnectedDpuSns, isShp2Connected } from './shp2Membership.js';

/**
 * v0.9.4 — ML inference framework for pack-failure risk.
 *
 * Honest scope:
 *
 *   - We don't have a labeled pack-failure dataset (your fleet is 25
 *     functional packs, zero failures). A trained classifier needs
 *     (features, label) pairs; we have only features.
 *
 *   - The shipped baseline model `lr-heuristic-baseline-v1` is a real
 *     logistic regression — fitted via `scripts/train-pack-risk.ts`
 *     against heuristic-distilled labels (PackRiskScore > 50 = 1, else
 *     0). It's a real ML inference path (sigmoid, learned weights from
 *     gradient descent) but won't beat the heuristic on prediction
 *     quality, since the labels ARE the heuristic. The value is the
 *     infrastructure + the surfacing of learned feature importances
 *     (which may differ from my hand-tuned weights — that's an insight).
 *
 *   - When real failures eventually accumulate, drop a CSV of
 *     `sn,packNum,failed_at_ts` into `data/labels.csv`, re-run
 *     `npm run train`, restart. Production code uses the new weights
 *     with zero changes. `modelVersion` bumps to `lr-labeled-v1`.
 *
 *   - The **Mahalanobis centroid-distance novelty detector** here is real
 *     unsupervised ML — no labels needed. For each pack, compute its
 *     feature-vector distance from the fleet centroid (Mahalanobis-style
 *     using inverse stdev). A pack that's an outlier in feature space
 *     gets a high novelty score regardless of the heuristic. Genuine new
 *     signal beyond what PackRiskScore offers.
 */

/* ─── Stable feature ordering ─────────────────────────────────────────── */

/** Feature names — must stay in this order for model file compatibility. */
export const FEATURE_NAMES = [
  'peerFadeRatio',     // 1.0 = average, >1 = wearing fast (vs fleet)
  'rTrend',            // mΩ per month (rising R = aging)
  'coulombicEffPct',   // discharge mAh ÷ charge mAh (<99% = side reactions)
  'hardLifeScore',     // events/yr (thermal stress, normalized)
  'ccDriftMv',         // mean |charge-curve drift| at SoC checkpoints
  'fadePctPerYear',    // SoH erosion rate
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export interface FeatureVector {
  sn: string;
  packNum: number;
  values: Record<FeatureName, number | null>;
  /** Normalized to 0..1 where 1 = high risk; null features clamped to 0. */
  normalized: Record<FeatureName, number>;
}

/** Clamp x into [0, 1]. */
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Normalize each feature to a 0..1 "risk-ness" scale. These ranges are
 * the SAME thresholds used by the heuristic in `computePackRiskScores`
 * — keeps the LR distillation faithful and means swap-in for a future
 * label-trained model is drop-in.
 */
export function normalizeFeature(name: FeatureName, raw: number | null): number {
  if (raw == null || !Number.isFinite(raw)) return 0;
  switch (name) {
    case 'peerFadeRatio':
      return clamp01((raw - 1) / 1.0);            // 1.0 = healthy, 2.0 = max risk
    case 'rTrend':
      return clamp01(raw / 3);                    // 3 mΩ/mo = max risk
    case 'coulombicEffPct':
      return clamp01((99 - raw) / 2);             // 97% = max risk
    case 'hardLifeScore':
      return clamp01(raw / 300);                  // 300 events/yr = max risk
    case 'ccDriftMv':
      return clamp01(Math.abs(raw) / 50);         // 50 mV drift = max risk
    case 'fadePctPerYear':
      return clamp01((raw - 1) / 5);              // 1 %/yr = healthy, 6 %/yr = max
  }
}

/**
 * Extract a feature vector for one pack. Consumes the same inputs as
 * `computePackRiskScores` — `degradation`, `thermalEvents`,
 * `internalR`, `chargeCurve` — keyed off (sn, packNum).
 */
export function extractFeatures(
  sn: string,
  packNum: number,
  degradation: FleetDegradation,
  thermalEvents: FleetThermalEvents,
  internalR: InternalResistanceReport,
  chargeCurve: ChargeCurveReport,
): FeatureVector {
  const deg: PackDegradation | undefined =
    degradation.packs.find((p) => p.sn === sn && p.packNum === packNum);
  const therm: ThermalEventCounts | undefined =
    thermalEvents.packs.find((p) => p.sn === sn && p.packNum === packNum);
  // Internal-R is bus-level — shared across all packs on a DPU.
  const ir: InternalResistanceDevice | undefined =
    internalR.devices.find((d) => d.sn === sn);
  const cc: ChargeCurvePack | undefined =
    chargeCurve.packs.find((p) => p.sn === sn && p.packNum === packNum);

  // v0.15.12 — fade features are only meaningful once the degradation fit is
  // mature. The degradation engine itself gates its EOL projection on
  // status==='projecting' (≥21 days of trend at adequate R²), but these
  // features previously consumed the raw early-fit slope: a fresh pack 18
  // days in showed fadePctPerYear=22.1 %/yr of fit noise and got ranked the
  // fleet's most-at-risk pack. Treat immature fade as unknown (null), which
  // normalizeFeature maps to the neutral 0.
  const fadeMature = deg?.status === 'projecting';
  const values: Record<FeatureName, number | null> = {
    peerFadeRatio: fadeMature ? (deg?.peerFadeRatio ?? null) : null,
    rTrend: ir?.trendMilliohmsPerMonth ?? null,
    coulombicEffPct: deg?.coulombicEffPct ?? null,
    hardLifeScore: therm?.hardLifeScore ?? null,
    ccDriftMv: cc?.meanDriftMv ?? null,
    fadePctPerYear: fadeMature ? (deg?.fadePctPerYear ?? null) : null,
  };
  const normalized = Object.fromEntries(
    FEATURE_NAMES.map((n) => [n, normalizeFeature(n, values[n])]),
  ) as Record<FeatureName, number>;
  return { sn, packNum, values, normalized };
}

/* ─── Logistic regression model ──────────────────────────────────────── */

export interface LrModel {
  version: string;
  trainedAt: number;
  samples: number;
  /** Per-feature weights, in FEATURE_NAMES order. */
  weights: Record<FeatureName, number>;
  /** Bias term. */
  bias: number;
  /** How the model was trained — "heuristic-distilled" or "labeled". */
  source: 'heuristic-distilled' | 'labeled';
  /** Training loss at convergence (binary cross-entropy on training set). */
  finalLoss: number;
  /** Notes for the human reading the file. */
  notes?: string;
  /** v1.18.0 (F16) — WHERE the model was loaded from, stamped by loadModel/
   *  loadBaselineModelOnly (never persisted to disk). 'shadow' = the online-SGD
   *  file; 'baseline' = MODEL_PATH (labels.csv batch fit); 'default' = the
   *  in-code fallback. The samples gate applies only to non-baseline labeled
   *  models: a converged batch fit legitimately has ~one sample per fleet pack
   *  (~20-25 here) and must not be permanently gated by a floor written for
   *  the online one-class walk. */
  provenance?: 'shadow' | 'baseline' | 'default';
}

/** Sigmoid activation. */
function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  } else {
    const z = Math.exp(x);
    return z / (1 + z);
  }
}

/**
 * Predict failure probability for one feature vector. Returns
 * { probability: 0..1, contribution: per-feature weighted score }
 * — the contributions sum to the logit input and let the caller show
 * which features pushed the score where (interpretability).
 */
export function predictRisk(
  features: FeatureVector,
  model: LrModel,
): {
  probability: number;
  score0to100: number;
  logit: number;
  contributions: Record<FeatureName, number>;
} {
  let logit = model.bias;
  const contributions = {} as Record<FeatureName, number>;
  for (const name of FEATURE_NAMES) {
    const w = model.weights[name] ?? 0;
    const x = features.normalized[name] ?? 0;
    const c = w * x;
    contributions[name] = c;
    logit += c;
  }
  const probability = sigmoid(logit);
  return {
    probability,
    score0to100: Math.round(probability * 100),
    logit,
    contributions,
  };
}

/* ─── Model loading + caching ────────────────────────────────────────── */

const MODEL_PATH = resolve(process.cwd(), config.dbPath, '..', 'models', 'pack-risk-lr-v1.json');
/**
 * v0.9.58 — Online-shadow model path. Mirrors the constant in
 * `models/onlineLR.ts` (kept in sync by convention — both files write
 * to/read from the same on-disk artifact). When SGD-updates fire on
 * /api/alerts/outcome, `onlineLR.updateFromOutcome` writes here.
 *
 * Until v0.9.58 the shadow was decorative — only `models/modelHealth.ts`
 * read it (to compute drift stats for the dashboard). Predictions
 * continued to use the frozen baseline, so operator outcomes changed the
 * `/api/models/health` numbers but moved ZERO predictions. We now wire
 * the shadow into `loadModel` so `computePackRiskV2` actually consumes
 * the online-updated weights.
 *
 * v0.9.59 follow-up: add an auto-downgrade gate that falls back to the
 * baseline when the shadow has drifted too far (e.g. a string of
 * "dismiss" verdicts crashes the trained score to ~0). Tracked separately.
 */
const SHADOW_PATH = resolve(process.cwd(), config.dbPath, '..', 'models', 'pack-risk-lr-v1-online.json');
let modelCache: LrModel | null = null;
let modelCacheLoadedAt = 0;
/** mtime (ms) of whichever file was used to populate `modelCache`. Lets
 *  us invalidate the cache the moment the shadow gets written on disk,
 *  rather than waiting MODEL_CACHE_TTL_MS for the SGD update to land. */
let modelCacheSourceMtimeMs = 0;
/** Which file backed the current cache entry — used by the freshness
 *  check below to know which path to stat. */
let modelCacheSourcePath: string | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Built-in default model — used when no trained model file exists yet. */
export const DEFAULT_MODEL: LrModel = {
  version: 'lr-heuristic-baseline-v1-builtin',
  trainedAt: 0,
  samples: 0,
  source: 'heuristic-distilled',
  // Weights mirror the heuristic's hand-tuned weights × a sigmoid-friendly
  // scale factor (chosen so 50% of healthy packs sit below score 25, and a
  // worst-case pack sits ≥ 75).
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
  notes: 'Built-in baseline; run scripts/train-pack-risk.ts to fit weights to your data.',
};

/** mtime helper — returns 0 when the file is missing or unreadable. */
function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Load the LR model used by `computePackRiskV2`.
 *
 * v0.9.58 fallback chain (highest → lowest priority):
 *   1. Online-shadow file at SHADOW_PATH — written by
 *      `onlineLR.updateFromOutcome` on every operator verdict (ack /
 *      dismiss / failed). When present, it IS the current model.
 *   2. Trained baseline at MODEL_PATH — produced by
 *      `scripts/train-pack-risk.ts`. Frozen until the operator re-runs
 *      training; the shadow diverges from this via SGD.
 *   3. Built-in DEFAULT_MODEL — the in-code baseline, used when neither
 *      file exists (fresh install).
 *
 * Cache invalidation: a normal TTL alone is too slow — an operator can
 * click "dismiss" and refresh the panel inside MODEL_CACHE_TTL_MS, and
 * they'd expect to see the trained-score budge. We also stat the source
 * file's mtime and invalidate the cache the instant it moves. (statSync
 * is fast on local FS — a few microseconds.) Cheaper than reparsing the
 * JSON on every call.
 *
 * NOTE (v0.9.58 known caveat → v0.9.59): there's no drift-gate yet. If a
 * string of "dismiss" verdicts pulls the shadow weights toward zero, the
 * trained score will crash and stay there until someone re-runs training
 * or deletes the shadow file. v0.9.59 will add an auto-downgrade that
 * detects pathological drift (e.g. shadow.bias swings > 3σ from baseline)
 * and falls back to the baseline until manual intervention.
 */
export function loadModel(): LrModel {
  // Determine which file SHOULD back the model right now (shadow wins).
  // Re-check this every call — a fresh shadow may have been written
  // since the last load.
  const shadowExists = existsSync(SHADOW_PATH);
  const baselineExists = existsSync(MODEL_PATH);
  const sourcePath = shadowExists ? SHADOW_PATH : baselineExists ? MODEL_PATH : null;
  const sourceMtime = sourcePath ? safeMtimeMs(sourcePath) : 0;

  // Cache hit only when: (a) the cached source still wins the fallback
  // chain, (b) its file hasn't been rewritten under us, and (c) the TTL
  // hasn't elapsed.
  if (
    modelCache &&
    modelCacheSourcePath === sourcePath &&
    modelCacheSourceMtimeMs === sourceMtime &&
    Date.now() - modelCacheLoadedAt < MODEL_CACHE_TTL_MS
  ) {
    return modelCache;
  }

  // Try the source file (shadow if present, else baseline).
  if (sourcePath) {
    try {
      const raw = readFileSync(sourcePath, 'utf8');
      const m = { ...(JSON.parse(raw) as LrModel), provenance: (sourcePath === SHADOW_PATH ? 'shadow' : 'baseline') as 'shadow' | 'baseline' };
      modelCache = m;
      modelCacheLoadedAt = Date.now();
      modelCacheSourcePath = sourcePath;
      modelCacheSourceMtimeMs = sourceMtime;
      return m;
    } catch {
      // Parse/IO failure — if we were attempting the shadow, fall back
      // to baseline; if baseline failed too, fall through to default.
      if (sourcePath === SHADOW_PATH && baselineExists) {
        try {
          const raw = readFileSync(MODEL_PATH, 'utf8');
          const m = { ...(JSON.parse(raw) as LrModel), provenance: 'baseline' as const };
          modelCache = m;
          modelCacheLoadedAt = Date.now();
          modelCacheSourcePath = MODEL_PATH;
          modelCacheSourceMtimeMs = safeMtimeMs(MODEL_PATH);
          return m;
        } catch {
          // fall through to default
        }
      }
    }
  }

  modelCache = { ...DEFAULT_MODEL, provenance: 'default' as const };
  modelCacheLoadedAt = Date.now();
  modelCacheSourcePath = null;
  modelCacheSourceMtimeMs = 0;
  return modelCache;
}

export function saveModel(model: LrModel): void {
  mkdirSync(dirname(MODEL_PATH), { recursive: true });
  writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2), 'utf8');
  modelCache = null;
  modelCacheLoadedAt = 0;
  modelCacheSourcePath = null;
  modelCacheSourceMtimeMs = 0;
}

/**
 * v0.9.62 — Read the on-disk baseline (MODEL_PATH) directly, bypassing the
 * shadow-preference logic in `loadModel()`. Used by `computeGateDecision`
 * to get a *true* baseline reference for drift comparison against the
 * shadow. Not cached — drift checks are infrequent and we want the freshest
 * baseline content if the operator just re-ran training.
 *
 * Returns `null` when MODEL_PATH doesn't exist or fails to parse — caller
 * treats that as "no baseline to compare against" (drift is unknown, not 0).
 *
 * v0.13.0 — exported so `models/modelHealth.ts` can resolve a TRUE baseline
 * for its shadow-vs-baseline drift report. It previously called `loadModel()`,
 * which prefers the shadow file → baseline and shadow were the same object →
 * every weightDelta was 0 and onlineSamples was 0, even after real online
 * updates had run. This is the baseline-only read both call sites need.
 */
export function loadBaselineModelOnly(): LrModel | null {
  if (!existsSync(MODEL_PATH)) return null;
  try {
    return { ...(JSON.parse(readFileSync(MODEL_PATH, 'utf8')) as LrModel), provenance: 'baseline' };
  } catch {
    return null;
  }
}

/* ─── Training (heuristic-distilled, or labeled when CSV exists) ─────── */

const LABELS_PATH = resolve(process.cwd(), config.dbPath, '..', 'labels.csv');

interface TrainingSample {
  features: number[];   // normalized, in FEATURE_NAMES order
  label: 0 | 1;
}

/**
 * Read labels.csv if it exists. Format: `sn,packNum,failed_at_ts` (header
 * optional). Each row is a positive label (failure occurred). All other
 * (sn, packNum) combinations in current state get label 0 (no failure).
 */
function readLabelsCsv(): Array<{ sn: string; packNum: number; failedAtTs: number }> | null {
  if (!existsSync(LABELS_PATH)) return null;
  try {
    const raw = readFileSync(LABELS_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
    const out: Array<{ sn: string; packNum: number; failedAtTs: number }> = [];
    for (const line of lines) {
      const [sn, packNumStr, tsStr] = line.split(',').map((s) => s.trim());
      if (sn === 'sn') continue; // header
      const packNum = Number(packNumStr);
      const ts = Number(tsStr);
      if (!sn || !Number.isInteger(packNum) || !Number.isFinite(ts)) continue;
      out.push({ sn, packNum, failedAtTs: ts });
    }
    return out;
  } catch {
    return null;
  }
}

/** Build training data: real labels if CSV exists, else heuristic-distilled. */
export function buildTrainingData(
  packs: PackRiskScore[],
  features: FeatureVector[],
): { samples: TrainingSample[]; source: 'labeled' | 'heuristic-distilled' } {
  const labels = readLabelsCsv();
  if (labels && labels.length > 0) {
    const positive = new Set(labels.map((l) => `${l.sn}|${l.packNum}`));
    const samples: TrainingSample[] = features.map((f) => ({
      features: FEATURE_NAMES.map((n) => f.normalized[n]),
      label: positive.has(`${f.sn}|${f.packNum}`) ? 1 : 0,
    }));
    return { samples, source: 'labeled' };
  }
  // Heuristic distillation: use score > 50 as the positive class.
  const heuristicByKey = new Map(packs.map((p) => [`${p.sn}|${p.packNum}`, p.score0to100]));
  const samples: TrainingSample[] = features.map((f) => {
    const score = heuristicByKey.get(`${f.sn}|${f.packNum}`) ?? 0;
    return {
      features: FEATURE_NAMES.map((n) => f.normalized[n]),
      label: score > 50 ? 1 : 0,
    };
  });
  return { samples, source: 'heuristic-distilled' };
}

/** Train a logistic regression by gradient descent. Returns the fitted model. */
export function trainLrModel(
  samples: TrainingSample[],
  source: 'labeled' | 'heuristic-distilled',
  opts: { iterations?: number; learningRate?: number; l2?: number } = {},
): LrModel {
  const iterations = opts.iterations ?? 2000;
  const lr = opts.learningRate ?? 0.05;
  const l2 = opts.l2 ?? 0.01;
  const nFeatures = FEATURE_NAMES.length;
  // Initialize weights small + random.
  const weights = new Array(nFeatures).fill(0).map(() => (Math.random() - 0.5) * 0.1);
  let bias = 0;
  let finalLoss = 0;

  for (let iter = 0; iter < iterations; iter++) {
    // Compute gradients
    const gradW = new Array(nFeatures).fill(0);
    let gradB = 0;
    let loss = 0;
    for (const s of samples) {
      let logit = bias;
      for (let j = 0; j < nFeatures; j++) logit += weights[j] * s.features[j];
      const p = sigmoid(logit);
      const err = p - s.label;
      for (let j = 0; j < nFeatures; j++) gradW[j] += err * s.features[j];
      gradB += err;
      // BCE loss (clamped to avoid log(0))
      const pc = Math.max(1e-9, Math.min(1 - 1e-9, p));
      loss += -(s.label * Math.log(pc) + (1 - s.label) * Math.log(1 - pc));
    }
    // L2 regularization on weights (not bias)
    for (let j = 0; j < nFeatures; j++) gradW[j] = gradW[j] / samples.length + l2 * weights[j];
    gradB = gradB / samples.length;
    // Update
    for (let j = 0; j < nFeatures; j++) weights[j] -= lr * gradW[j];
    bias -= lr * gradB;
    finalLoss = loss / samples.length;
  }

  const weightsObj = {} as Record<FeatureName, number>;
  for (let j = 0; j < nFeatures; j++) {
    weightsObj[FEATURE_NAMES[j]] = Math.round(weights[j] * 10000) / 10000;
  }
  return {
    version: source === 'labeled' ? 'lr-labeled-v1' : 'lr-heuristic-baseline-v1',
    trainedAt: Date.now(),
    samples: samples.length,
    weights: weightsObj,
    bias: Math.round(bias * 10000) / 10000,
    source,
    finalLoss: Math.round(finalLoss * 10000) / 10000,
    notes:
      source === 'labeled'
        ? `Fitted to ${samples.filter((s) => s.label === 1).length} positive labels.`
        : `Heuristic-distilled (PackRiskScore > 50 = positive). Trained on ${samples.length} samples for ${iterations} iterations.`,
  };
}

/* ─── Isolation-forest-lite novelty detector ─────────────────────────── */

export interface NoveltyResult {
  sn: string;
  packNum: number;
  novelty0to100: number;     // 0 = typical, 100 = extreme outlier
  distanceFromCentroid: number;
  topFeatures: Array<{ name: FeatureName; deviation: number }>;
}

/**
 * Compute per-pack novelty as the Mahalanobis centroid distance: each pack's
 * inverse-stdev-weighted distance from the fleet centroid in feature space, so
 * all features contribute on a common scale. Truly unsupervised.
 *
 * Output 0..100, mapped ABSOLUTELY against a fixed chi-square cutoff
 * (CHI2_THRESHOLD) — a pack only reads 100 once its distance actually reaches
 * the outlier threshold. (It used to divide by the in-sample MAX distance,
 * which pinned the single most-deviant pack to 100 even on a healthy fleet.)
 */
/**
 * v0.9.76 — accepts an optional `baseline` pool of feature vectors that
 * define the centroid + per-feature stdev. When omitted, falls back to
 * the scoring set itself (legacy behavior). The split exists so callers
 * can pass SHP2-connected packs only as the baseline while still scoring
 * every pack — same pattern as computeDegradation's v0.9.75 peer-pool
 * fix, applied to novelty here. Without this, a spare core's 10 packs
 * dominate the centroid mass and compress the spread, then home-pack
 * anomalies look extreme against an artificially deflated cloud.
 *
 * Live evidence pre-fix: Core 1 Pack 4 scored novelty=100 while 24 other packs
 * sat at novelty=4 — partly the spare-deflated centroid (fixed by the baseline
 * pool here), partly the old divide-by-max scaling (replaced in v0.13.x by the
 * absolute chi-square mapping below).
 */
export function computeNovelty(
  features: FeatureVector[],
  baseline?: FeatureVector[],
): NoveltyResult[] {
  if (features.length === 0) return [];
  const baselineSet = baseline && baseline.length > 0 ? baseline : features;
  const nBase = baselineSet.length;
  const dim = FEATURE_NAMES.length;
  // Centroid (mean per feature) — from the baseline pool.
  const mean = new Array(dim).fill(0);
  for (const f of baselineSet) {
    for (let j = 0; j < dim; j++) mean[j] += f.normalized[FEATURE_NAMES[j]];
  }
  for (let j = 0; j < dim; j++) mean[j] /= nBase;
  // Per-feature stdev for Mahalanobis-style scaling — also from baseline.
  const stdev = new Array(dim).fill(0);
  for (const f of baselineSet) {
    for (let j = 0; j < dim; j++) {
      const d = f.normalized[FEATURE_NAMES[j]] - mean[j];
      stdev[j] += d * d;
    }
  }
  for (let j = 0; j < dim; j++) stdev[j] = Math.sqrt(stdev[j] / Math.max(1, nBase - 1));

  // Distance for each pack
  const raw = features.map((f) => {
    let sq = 0;
    const devs: Array<{ name: FeatureName; deviation: number }> = [];
    for (let j = 0; j < dim; j++) {
      const name = FEATURE_NAMES[j];
      const d = f.normalized[name] - mean[j];
      const scaled = stdev[j] > 1e-9 ? d / stdev[j] : 0;
      sq += scaled * scaled;
      devs.push({ name, deviation: Math.round(scaled * 100) / 100 });
    }
    return {
      sn: f.sn,
      packNum: f.packNum,
      distance: Math.sqrt(sq),
      devs: devs.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation)).slice(0, 3),
    };
  });
  // v0.13.3 — ABSOLUTE novelty mapping. The old divide-by-in-sample-max scaling
  // forced the single most-deviant pack to exactly 100 BY CONSTRUCTION — even a
  // perfectly healthy, homogeneous fleet always had a "100% novel" pack, which is
  // meaningless. Instead map the absolute Mahalanobis centroid distance against a
  // fixed chi-square cutoff: with `dim`=6 standardized features, distance² is
  // ~chi-square_dim and CHI2_THRESHOLD≈3.4 marks "this pack is a genuine outlier".
  // A pack reads 100 only once its distance actually reaches the threshold; a
  // tight, healthy fleet shows everyone low — no in-sample-maximum coupling.
  const CHI2_THRESHOLD = 3.4;
  return raw.map((r) => ({
    sn: r.sn,
    packNum: r.packNum,
    novelty0to100: Math.round(Math.min(1, r.distance / CHI2_THRESHOLD) * 100),
    distanceFromCentroid: Math.round(r.distance * 100) / 100,
    topFeatures: r.devs,
  }));
}

/* ─── Public surface: combined v2 risk report ────────────────────────── */

export interface PackRiskV2Entry {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  // Heuristic (carried through from v0.9.0)
  heuristic: {
    score0to100: number;
    tier: PackRiskScore['tier'];
    topFactors: RiskFactor[];
  };
  // Trained LR
  trained: {
    score0to100: number;
    probability: number;
    contributions: Record<FeatureName, number>;
    modelVersion: string;
    modelSource: 'labeled' | 'heuristic-distilled';
  };
  // Unsupervised novelty
  novelty: {
    score0to100: number;
    distanceFromCentroid: number;
    topFeatures: Array<{ name: FeatureName; deviation: number }>;
  };
  // Composite — average of the three, gives a smoothed "overall risk"
  composite0to100: number;
}

export interface PackRiskV2Report {
  generatedAt: number;
  modelVersion: string;
  modelSource: 'labeled' | 'heuristic-distilled';
  modelTrainedAt: number;
  modelTrainingSamples: number;
  modelFinalLoss: number;
  /** Learned feature importances (|weight| × stdev across the fleet). Surfaces what the model actually relies on. */
  featureImportances: Array<{ name: FeatureName; importance: number; weight: number }>;
  packs: PackRiskV2Entry[];
  /**
   * v0.9.59 — Auto-downgrade gate state. When `degraded === true`, the
   * trained track has been pinned to the heuristic score (per-pack) because
   * either the shadow LR has drifted too far from the baseline or the
   * alert-family precision is too low to trust the trained predictions.
   * Optional so existing consumers don't break.
   */
  degraded?: boolean;
  /** v1.18.0 (F16) — 'samples': the shadow has too few labeled training
   *  samples to serve; the composite pins to the heuristic ALONE (the
   *  novelty track is also excluded — see computePackRiskV2). */
  degradeReason?: 'samples' | 'drift' | 'precision' | 'drift+precision';
  /** Debug payload for /api/models/health so the dashboard can surface
   *  the exact numbers that drove the gate decision. */
  gateDecision?: {
    driftL2: number | null;
    overallPrecision: number | null;
    threshold: number;
    minPrecision: number;
    minTrainingSamples?: number;
    degraded: boolean;
  };
}

/**
 * v0.9.59 — Auto-downgrade gate. Decides whether the trained LR track
 * is currently trustworthy. Mirrors the math in `models/modelHealth.ts`
 * but inlined here to avoid a ml.ts ↔ modelHealth.ts ↔ ml.ts import cycle
 * (modelHealth.ts already imports `loadModel` and `FEATURE_NAMES`).
 *
 * Trigger conditions:
 *   - `driftL2 > PACK_RISK_DRIFT_THRESHOLD` (default 2.0). Set when the
 *     shadow weights have wandered far from the trained baseline — usually
 *     a sign that a string of `dismiss` outcomes has pushed the model
 *     toward predicting 0 for everything.
 *   - `overallPrecision < PACK_RISK_MIN_PRECISION` (default 0.4). Set when
 *     the alert families with operator verdicts are running mostly-false-positive,
 *     so the model fitting against them is learning bad signal.
 *
 * Cold-start handling: when the shadow file doesn't exist yet, the in-code
 * defaults make `driftL2 === 0` (well below threshold) and `overallPrecision`
 * is `null` (no decided alerts) — neither condition fires, so we don't degrade.
 * Same for a healthy steady-state.
 *
 * v0.9.62 — `model` parameter is now ignored for the drift calculation; we
 * always read the on-disk baseline (MODEL_PATH) directly via
 * `loadBaselineModelOnly()`. See the inline comment in the drift block for
 * why the previous shadow-vs-`model` comparison was a no-op end-to-end.
 * The parameter is retained to preserve the call-site API.
 */
/* v1.18.0 (engine-review F16) — NaN/empty-safe env parse for the gate knobs.
 * `Number('') === 0` would zero a threshold and silently flip gate behavior. */
function gateEnvNum(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/* v1.18.0 (engine-review F16) — minimum labeled training samples before the
 * shadow LR's score is allowed into the operator-facing composite. The live
 * system served a 13-sample one-class shadow whose learned signal was 99.99%
 * bias ("raise everyone's risk"), inflating healthy-fleet composites 4-7×
 * (three near-new packs falsely tiered 'moderate'). 8 features + bias ≈ 9
 * params; ≥10 observations/param is the floor of respectability. */
const PACK_RISK_MIN_TRAINING_SAMPLES = gateEnvNum('PACK_RISK_MIN_TRAINING_SAMPLES', 100);
/* Minimum decided outcomes (with ≥1 dismissal among them) before alert-family
 * precision counts as evidence. 3, not higher: dismissals are ALWAYS
 * informative (each one is an explicit false-positive verdict), so a short
 * 100%-dismiss stream must still be able to degrade the model — a 10-outcome
 * floor would have ignored up to 9 straight false-positive verdicts. */
const PACK_RISK_MIN_DECIDED_OUTCOMES = gateEnvNum('PACK_RISK_MIN_DECIDED_OUTCOMES', 3);

export function computeGateDecision(model: LrModel): {
  driftL2: number | null;
  overallPrecision: number | null;
  threshold: number;
  minPrecision: number;
  minTrainingSamples: number;
  degraded: boolean;
  reason?: 'samples' | 'drift' | 'precision' | 'drift+precision';
} {
  const threshold = gateEnvNum('PACK_RISK_DRIFT_THRESHOLD', 2.0);
  const minPrecision = gateEnvNum('PACK_RISK_MIN_PRECISION', 0.4);

  // Drift: L2 distance between shadow and the on-disk baseline.
  //
  // v0.9.62 — Previously this compared `shadow` to the `model` argument.
  // But `computePackRiskV2` passes `loadModel()` as that arg, and
  // `loadModel()` prefers the shadow file when present → both sides ended
  // up being the same shadow object → drift L2 was always 0 → the drift
  // branch was unreachable end-to-end. (Only the precision branch could
  // actually trigger via the public API.) Now we read MODEL_PATH directly
  // via `loadBaselineModelOnly()` so the comparison is shadow-vs-baseline,
  // which is what the gate is supposed to detect.
  //
  // Cold-start handling: if MODEL_PATH doesn't exist (operator never ran
  // training, only the in-code default and the shadow exist), there is no
  // true baseline to compare against — drift is set to 0 (the correct
  // "no comparison possible" answer, not a degradation signal).
  let driftL2: number | null = null;
  try {
    const baseline = loadBaselineModelOnly();
    if (baseline === null) {
      // v1.18.0 (F16) — no on-disk baseline means drift is UNKNOWN, not zero.
      // The old `driftL2 = 0` displayed as a measured no-drift verdict in
      // /api/models/health while the shadow's actual divergence (the live
      // system's +0.586 all-bias walk) was structurally invisible — the gate
      // could never fire on the exact cold-start it was written to catch.
      // null does not degrade by itself (same gate outcome), but the samples
      // gate now covers the immature-shadow case, and the health surface
      // stops asserting a comparison that never happened.
      driftL2 = null;
    } else {
      const shadow = loadShadowModel();
      let l2sq = 0;
      for (const name of FEATURE_NAMES) {
        const b = baseline.weights[name] ?? 0;
        const s = shadow.weights[name] ?? 0;
        const d = s - b;
        l2sq += d * d;
      }
      const biasDelta = shadow.bias - baseline.bias;
      l2sq += biasDelta * biasDelta;
      driftL2 = Math.sqrt(l2sq);
    }
  } catch {
    // If shadow can't be loaded for any reason, treat drift as unknown
    // (null) — don't degrade on missing data.
    driftL2 = null;
  }

  // Precision across alert families with decided outcomes.
  let overallPrecision: number | null = null;
  try {
    const families = computeFamilyStats();
    let totalReal = 0;
    let totalDecided = 0;
    let totalDismiss = 0;
    for (const f of families) {
      const real = f.ack + f.failed;
      const decided = real + f.dismiss;
      totalReal += real;
      totalDecided += decided;
      totalDismiss += f.dismiss;
    }
    // v1.18.0 (F16) — precision is EVIDENCE only when the outcome stream can
    // express a false positive. The live system's 33 outcomes were 33 batch
    // 'ack's (median time-to-action 21.9 DAYS) — a UI that only ever produces
    // acks pins precision at 1.0 forever, which is not a measurement; the
    // precision gate could structurally never fire. Require at least one
    // dismissal AND a small decided floor (3 — anti-flap only, so a single
    // stray dismissal can't degrade the model by itself, but a genuine short
    // false-positive streak still can). Dismissals are the informative class:
    // every sub-0.4 stream necessarily contains them, so this guard can delay
    // a genuine degrade by at most two outcomes, never block it.
    overallPrecision =
      totalDismiss > 0 && totalDecided >= PACK_RISK_MIN_DECIDED_OUTCOMES
        ? totalReal / totalDecided
        : null;
  } catch {
    overallPrecision = null;
  }

  // v1.18.0 (F16) — the missing gate: an immature LABELED shadow (too few
  // training samples) must not reach the composite regardless of drift or
  // precision. loadModel() prefers the shadow file whenever it exists, so
  // this is the only check standing between a 13-sample artifact and the
  // dashboard. Exemptions, both deliberate:
  //  - source 'heuristic-distilled' (the in-code default and distilled fits
  //    mirror the heuristic by construction — sample count is not their trust
  //    axis; cold-start stays ungated as designed);
  //  - provenance 'baseline' (a labels.csv batch fit via train-pack-risk is a
  //    CONVERGED, balance-checked fit that legitimately has ~one sample per
  //    fleet pack — ~20-25 here — and would otherwise be gated forever; the
  //    train script owns its own sample floor).
  // Everything else — the online-SGD shadow, and any file whose `source` is
  // missing or unrecognized (fail-safe: `undefined === 'labeled'` would have
  // let a hand-edited file through) — must show a FINITE samples count at or
  // above the floor (`undefined < 100` is false — the old shape silently
  // opened the gate on a corrupt file). Note the shadow inherits its seed
  // model's batch count (~20-25 on this fleet), so the floor in practice
  // demands ≥75 real operator outcomes on top — bounded dilution, accepted.
  const samplesBad =
    model.provenance !== 'baseline' &&
    model.source !== 'heuristic-distilled' &&
    !(Number.isFinite(model.samples) && model.samples >= PACK_RISK_MIN_TRAINING_SAMPLES);
  const driftBad = driftL2 != null && driftL2 > threshold;
  const precBad = overallPrecision != null && overallPrecision < minPrecision;
  const degraded = samplesBad || driftBad || precBad;
  // 'samples' dominates the reason: drift/precision verdicts about a model
  // too immature to serve are secondary detail.
  const reason: 'samples' | 'drift' | 'precision' | 'drift+precision' | undefined = samplesBad
    ? 'samples'
    : driftBad && precBad ? 'drift+precision' : driftBad ? 'drift' : precBad ? 'precision' : undefined;

  return { driftL2, overallPrecision, threshold, minPrecision, minTrainingSamples: PACK_RISK_MIN_TRAINING_SAMPLES, degraded, reason };
}

export function computePackRiskV2(
  devices: Record<string, DeviceSnapshot>,
  heuristic: PackRiskScore[],
  degradation: FleetDegradation,
  thermalEvents: FleetThermalEvents,
  internalR: InternalResistanceReport,
  chargeCurve: ChargeCurveReport,
): PackRiskV2Report {
  const model = loadModel();
  const gate = computeGateDecision(model);
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  // Build feature vectors per pack
  const features: FeatureVector[] = [];
  for (const d of dpus) {
    for (const pk of d.projection.packs) {
      features.push(extractFeatures(d.sn, pk.num, degradation, thermalEvents, internalR, chargeCurve));
    }
  }
  // v0.9.76 — Score every pack, but build the centroid+stdev from
  // SHP2-connected packs only. Spare cores (4 & 5) carry idle/zero-load
  // feature signatures that dragged the cluster mean down and compressed
  // the spread pre-fix, making a healthy home pack score novelty=100
  // simply because it sat outside the spare-cluster cloud. Same
  // "filter the baseline, score everyone" pattern as
  // computeDegradation's v0.9.75 peer-pool fix.
  const connected = shp2ConnectedDpuSns(devices);
  const baselineFeatures = features.filter((f) => isShp2Connected(f.sn, connected));
  const noveltyByKey = new Map<string, NoveltyResult>();
  for (const n of computeNovelty(features, baselineFeatures)) {
    noveltyByKey.set(`${n.sn}|${n.packNum}`, n);
  }

  // Per-feature importance: |weight| × per-feature stdev across fleet.
  // The weight alone is misleading (a feature can be high-weighted but
  // never vary across packs); scaling by stdev surfaces what actually
  // drives between-pack differences.
  const stdev = {} as Record<FeatureName, number>;
  for (const name of FEATURE_NAMES) {
    const values = features.map((f) => f.normalized[name]);
    const m = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    const v = values.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, values.length - 1);
    stdev[name] = Math.sqrt(v);
  }
  const featureImportances = FEATURE_NAMES.map((name) => ({
    name,
    weight: model.weights[name] ?? 0,
    importance: Math.round(Math.abs(model.weights[name] ?? 0) * stdev[name] * 1000) / 1000,
  })).sort((a, b) => b.importance - a.importance);

  const packs: PackRiskV2Entry[] = [];
  for (const f of features) {
    const heur = heuristic.find((h) => h.sn === f.sn && h.packNum === f.packNum);
    if (!heur) continue;
    const pred = predictRisk(f, model);
    const nov = noveltyByKey.get(`${f.sn}|${f.packNum}`);
    // v0.9.59 — When the auto-downgrade gate fires, pin the trained track
    // to the heuristic score so the composite (mean of three) doesn't
    // crater silently. The `degraded` flag on the report tells the
    // dashboard to surface why. We still expose the raw `pred.probability`
    // and `pred.contributions` for debug visibility — only the score that
    // feeds the composite is overridden.
    const trainedScore = gate.degraded ? heur.score0to100 : pred.score0to100;
    // v1.18.0 (F16) — an immature ML stack ('samples' gate) contributes
    // NOTHING to the operator-facing composite: not the shadow score (pinned
    // above) and not the unsupervised novelty either. With the trained track
    // pinned, mean(heur, heur, novelty) still read 37 'moderate' on a healthy
    // pack whose novelty=100 came from a 16-sample charge-curve checkpoint —
    // the exact 4-7× inflation F16 flagged. Both tracks stay fully populated
    // as diagnostics; only the headline composite (which the dashboard tiers
    // at ≥25 'moderate' / ≥50 'elevated') is heuristic-only until the model
    // earns its way in. Mature-model degrades (drift/precision) keep the
    // pre-existing behavior: trained pinned, novelty still averaged.
    const composite = gate.reason === 'samples'
      ? heur.score0to100
      : Math.round((heur.score0to100 + trainedScore + (nov?.novelty0to100 ?? 0)) / 3);
    packs.push({
      sn: f.sn,
      device: heur.device,
      coreNum: heur.coreNum,
      packNum: f.packNum,
      heuristic: {
        score0to100: heur.score0to100,
        tier: heur.tier,
        topFactors: heur.topFactors,
      },
      trained: {
        score0to100: trainedScore,
        probability: Math.round(pred.probability * 1000) / 1000,
        contributions: pred.contributions,
        modelVersion: model.version,
        modelSource: model.source,
      },
      novelty: {
        score0to100: nov?.novelty0to100 ?? 0,
        distanceFromCentroid: nov?.distanceFromCentroid ?? 0,
        topFeatures: nov?.topFeatures ?? [],
      },
      composite0to100: composite,
    });
  }
  // Sort by composite score desc — most-at-risk first
  packs.sort((a, b) => b.composite0to100 - a.composite0to100);

  return {
    generatedAt: Date.now(),
    modelVersion: model.version,
    modelSource: model.source,
    modelTrainedAt: model.trainedAt,
    modelTrainingSamples: model.samples,
    modelFinalLoss: model.finalLoss,
    featureImportances,
    packs,
    degraded: gate.degraded,
    degradeReason: gate.reason,
    gateDecision: {
      driftL2: gate.driftL2,
      overallPrecision: gate.overallPrecision,
      threshold: gate.threshold,
      minPrecision: gate.minPrecision,
      minTrainingSamples: gate.minTrainingSamples,
      degraded: gate.degraded,
    },
  };
}
