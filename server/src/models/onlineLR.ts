/**
 * v0.9.27 — Online LR weight updates from operator outcomes.
 *
 * Track A continuation: every time an outcome arrives WITH a feature
 * snapshot, take ONE SGD step on the pack-risk LR weights. This is the
 * thing that makes "ML cargo cult" into "ML that's actually learning":
 *
 *   1. Operator's outcome (ack/dismiss/failed) maps to a binary label
 *   2. Snapshotted features (captured at alert-fire time) replay the
 *      exact inputs the model saw when it predicted
 *   3. SGD step nudges the weights in the direction that would have
 *      predicted the true label better next time
 *
 * Mapping to binary labels:
 *   - "ack"     → 1.0   (true positive — the alert was real)
 *   - "failed"  → 1.0   (extra-strong true positive)
 *   - "dismiss" → 0.0   (false positive — model was wrong)
 *   - "resolved"→ skip  (ambiguous — condition cleared, unclear what it meant)
 *
 * The "failed" labels get an effective sample weight of 2× so they
 * pull the model harder (we really want to catch real failures).
 *
 * **Why pack-risk?** Most other models (forecast, baseline, peer-
 * comparison) aren't differentiable in the same way — they're either
 * statistical (Bayesian/Kalman, which update implicitly via their own
 * mechanisms) or heuristic. Pack-risk LR is the only model in the
 * codebase that benefits directly from labeled-data SGD.
 *
 * The features captured in featureSnapshot.ts are alert-category-
 * specific (pack_temp_c, pack_soc, etc.) and don't directly match the
 * 6 LR feature names (peerFadeRatio, rTrend, …). We do a best-effort
 * **mapping** in `updateFromOutcome()` — if we can construct a usable
 * feature vector from the snapshot we apply the SGD step; otherwise we
 * record the outcome for future bulk retraining but skip the live update.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config } from '../config.js';
import { FEATURE_NAMES, type FeatureName, type LrModel } from '../ml.js';
import type { AlertOutcome, AlertOutcomeEntry } from '../alertOutcomes.js';

const MODEL_PATH = resolve(process.cwd(), config.dbPath, '..', 'models', 'pack-risk-lr-v1.json');
const SHADOW_PATH = resolve(process.cwd(), config.dbPath, '..', 'models', 'pack-risk-lr-v1-online.json');

/** Learning rate. Conservative — we get maybe a few outcomes/day so we
 *  want each one to nudge the model perceptibly but not catastrophically. */
const LEARNING_RATE = 0.05;
/** L2 regularization to prevent any single noisy outcome from blowing weights. */
const L2 = 0.001;
/** Weight given to "failed" labels (vs "ack"=1.0, "dismiss"=1.0). */
const FAILED_LABEL_WEIGHT = 2.0;
/**
 * v0.13.2 — Online bias is clamped to within this band of the on-disk
 * BASELINE bias. Defense-in-depth on top of v0.13.0's degenerate-feature
 * guard: even a legitimate stream of one-sided y=1 labels (every alert
 * ack'd, never dismissed) drives `bias -= η·(p−1)` monotonically upward.
 * Bounding it to ±1.0 of baseline keeps the online model from walking its
 * intercept unboundedly while still allowing real, data-driven adaptation
 * (a logit shift of 1.0 already moves a 50% prediction to ~73%). The weight
 * vector and the inference path are untouched — we only bound the bias.
 */
const BIAS_CLAMP = 1.0;
/** In-code fallback baseline bias — mirrors ml.ts's DEFAULT_MODEL.bias. Used
 *  only when no on-disk baseline model exists to read the bias from. */
const DEFAULT_BASELINE_BIAS = -2.5;

/**
 * Build the normalized 6-dim LR feature vector for an outcome.
 *
 * v0.9.59 — PREFER `outcome.lrFeatures` (the REAL normalized vector
 * captured at alert fire time via featureSnapshot.captureLrFeatures,
 * which routes through ml.ts's extractFeatures — same code path that
 * `computePackRiskV2` uses for inference). When the captured vector
 * is present we use it verbatim; the training inputs then match the
 * inference inputs exactly. No proxy reconstruction.
 *
 * Fallback path (lower fidelity) — only used for historical snapshots
 * captured BEFORE v0.9.59, where `outcome.lrFeatures` was never written:
 * project the category-specific snapshot features to LR features as
 * best we can. This proxy is known-bad for two cases the audit called
 * out:
 *
 *   - rTrend was proxied via pack temperature, so a Phoenix summer
 *     would train the model to predict "every pack high risk" from
 *     ambient heat alone.
 *   - coulombicEffPct always defaulted to 0 (no source in the snapshot),
 *     wasting one of the six dimensions.
 *
 * Both bugs are FIXED by the captured-vector path. The fallback stays
 * around only to keep historical outcomes (pre-v0.9.59) replayable.
 *
 * Returns null when we can't construct a usable vector at all (e.g.
 * non-pack alert with no captured vector AND no usable proxy fields).
 */
export function snapshotToLrFeatures(
  snapshot: Record<string, number> | undefined,
  capturedLrFeatures?: Record<string, number> | null,
): Record<FeatureName, number> | null {
  // v0.9.59 preferred path — use the real captured vector when present.
  if (capturedLrFeatures && typeof capturedLrFeatures === 'object') {
    const out = {} as Record<FeatureName, number>;
    let hasAny = false;
    for (const name of FEATURE_NAMES) {
      const v = capturedLrFeatures[name];
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[name] = v;
        hasAny = true;
      } else {
        out[name] = 0;
      }
    }
    if (hasAny) return out;
    // capturedLrFeatures was an empty object — fall through to proxy logic.
  }

  if (!snapshot) return null;

  // Pre-v0.9.59 proxy fallback. Known to be lossy — see the audit notes
  // above. We keep it ONLY so historical outcomes captured before the
  // captured-vector path landed still produce a usable training signal.
  const out = {} as Record<FeatureName, number>;
  // peerFadeRatio — how badly this pack lags peers. Best proxy: vol_diff (mV imbalance).
  out.peerFadeRatio = snapshot['pack_vol_diff_mv'] != null
    ? Math.min(1, snapshot['pack_vol_diff_mv'] / 100)  // 100 mV ≈ severe → 1.0
    : 0;
  // rTrend — internal resistance trending up. Proxy via temperature delta
  // from mean (hot packs imply rising IR). KNOWN-BAD in summer climates.
  out.rTrend = snapshot['pack_temp_c'] != null
    ? Math.max(0, Math.min(1, (snapshot['pack_temp_c'] - 30) / 30))   // 30→60°C maps 0→1
    : 0;
  // coulombicEffPct — drift below 100%. We don't capture this in snapshots
  // currently, so default to 0 (no signal). KNOWN-BAD; wastes a feature.
  out.coulombicEffPct = 0;
  // hardLifeScore — pack age / cycles. cycles >2000 ≈ end-of-life.
  out.hardLifeScore = snapshot['pack_cycles'] != null
    ? Math.min(1, snapshot['pack_cycles'] / 2000)
    : 0;
  // ccDriftMv — cell voltage spread. Already in mV, normalize to 100mV scale.
  out.ccDriftMv = snapshot['pack_vol_diff_mv'] != null
    ? Math.min(1, snapshot['pack_vol_diff_mv'] / 100)
    : 0;
  // fadePctPerYear — long-term degradation. Use SoH (100 − soh) as proxy.
  out.fadePctPerYear = snapshot['pack_soh'] != null
    ? Math.min(1, Math.max(0, (100 - snapshot['pack_soh']) / 25))   // 75% SoH → 1.0
    : 0;
  return out;
}

/** Sigmoid (numerically stable). */
function sigmoid(x: number): number {
  if (x >= 0) { const z = Math.exp(-x); return 1 / (1 + z); }
  const z = Math.exp(x); return z / (1 + z);
}

/** Load the current model (shadow first, fall back to base). */
function loadCurrent(): LrModel {
  // Prefer the online-shadow model — it's a copy of the base updated by
  // online learning. We never overwrite the base file, so bulk retraining
  // (from buildTrainingData → trainLrModel) can still produce a clean
  // baseline anytime.
  if (existsSync(SHADOW_PATH)) {
    try { return JSON.parse(readFileSync(SHADOW_PATH, 'utf-8')) as LrModel; } catch { /* fall through */ }
  }
  if (existsSync(MODEL_PATH)) {
    try { return JSON.parse(readFileSync(MODEL_PATH, 'utf-8')) as LrModel; } catch { /* fall through */ }
  }
  // No file at all — use the in-code default (same shape as ml.ts's DEFAULT_MODEL,
  // but we re-import to avoid circular). Caller imports the actual default.
  return {
    version: 'lr-online-shadow-init',
    trainedAt: 0,
    samples: 0,
    source: 'heuristic-distilled',
    weights: {
      peerFadeRatio: 1.5, rTrend: 0.9, coulombicEffPct: 0.9,
      hardLifeScore: 0.9, ccDriftMv: 0.6, fadePctPerYear: 1.2,
    },
    bias: -2.5,
    finalLoss: 0,
  };
}

/**
 * v0.13.2 — Read the BASELINE bias (the on-disk, never-online-updated base
 * model at MODEL_PATH). This is the anchor for the bias clamp — NOT the
 * shadow, which may already carry accumulated online drift. Falls back to
 * the in-code default when the base model file is absent or unreadable.
 */
function loadBaselineBias(): number {
  if (existsSync(MODEL_PATH)) {
    try {
      const base = JSON.parse(readFileSync(MODEL_PATH, 'utf-8')) as LrModel;
      if (typeof base.bias === 'number' && Number.isFinite(base.bias)) return base.bias;
    } catch { /* fall through to default */ }
  }
  return DEFAULT_BASELINE_BIAS;
}

/** Persist the shadow model after each SGD step.
 *
 *  CodeQL js/http-to-file-access context: SHADOW_PATH is a fixed constant —
 *  never request-influenced. The numeric model content (weights/bias/loss) is
 *  derived arithmetically with finite-guards, so the only request-derived
 *  value that can reach this file is the sanitized alertId embedded in the
 *  provenance `notes` string built in updateFromOutcome (see there). */
function saveShadow(model: LrModel): void {
  mkdirSync(dirname(SHADOW_PATH), { recursive: true });
  writeFileSync(SHADOW_PATH, JSON.stringify(model, null, 2));
}

/**
 * Take ONE SGD step on the pack-risk LR weights from a single outcome.
 *
 *   loss   = -(y log(p) + (1-y) log(1-p))    (binary cross-entropy)
 *   dL/dw  = (p - y) × x   (per weight)
 *   w     -= η × (p - y) × x + η × L2 × w
 *
 * Returns the updated model. Idempotent for "resolved" or feature-less
 * outcomes — those just return the current model unchanged.
 */
export function updateFromOutcome(outcome: AlertOutcomeEntry, log: (m: string) => void = () => {}): {
  updated: boolean;
  prevLogit: number;
  newLogit: number;
  label: number | null;
  reason?: string;
} {
  // Skip ambiguous outcomes — no label to learn from.
  if (outcome.outcome === 'resolved') {
    return { updated: false, prevLogit: 0, newLogit: 0, label: null, reason: 'resolved (ambiguous)' };
  }
  // v0.9.59 — prefer the LR feature vector captured at alert-fire time
  // (real model inputs); fall back to proxy reconstruction only for
  // historical outcomes that pre-date the captured-vector path.
  const lrFeatures = snapshotToLrFeatures(outcome.features, outcome.lrFeatures);
  if (!lrFeatures) {
    return { updated: false, prevLogit: 0, newLogit: 0, label: null, reason: 'no features captured' };
  }

  // v0.13.0 — degenerate-feature guard. A non-pack outcome (system / SHP2 /
  // EVSE family — no packNum, no captured lrFeatures) collapses to an
  // all-zero proxy vector. With x=0 the gradient `error*x + L2*w` loses its
  // data term and ONLY the bias moves, so each such outcome silently
  // inflates the pack-risk baseline without any discrimination (audit P0-2:
  // 13 system-level labels walked the baseline 2.5%→12.9%, weightDeltas all
  // exactly 0). Skip the SGD step entirely when the vector carries no usable
  // signal — all features zero, or any NaN/Inf that would poison the weights.
  let anyNonZero = false;
  for (const name of FEATURE_NAMES) {
    const x = lrFeatures[name] ?? 0;
    if (!Number.isFinite(x)) {
      return { updated: false, prevLogit: 0, newLogit: 0, label: null, reason: 'degenerate-features' };
    }
    if (x !== 0) anyNonZero = true;
  }
  if (!anyNonZero) {
    return { updated: false, prevLogit: 0, newLogit: 0, label: null, reason: 'degenerate-features' };
  }

  const label = outcomeLabel(outcome.outcome);
  const sampleWeight = outcome.outcome === 'failed' ? FAILED_LABEL_WEIGHT : 1.0;

  const model = loadCurrent();
  let logit = model.bias;
  for (const name of FEATURE_NAMES) {
    logit += (model.weights[name] ?? 0) * (lrFeatures[name] ?? 0);
  }
  const prob = sigmoid(logit);
  const error = (prob - label) * sampleWeight;

  // Per-weight update.
  const newWeights = { ...model.weights } as Record<FeatureName, number>;
  for (const name of FEATURE_NAMES) {
    const w = newWeights[name] ?? 0;
    const x = lrFeatures[name] ?? 0;
    const grad = error * x + L2 * w;
    newWeights[name] = w - LEARNING_RATE * grad;
  }
  // Bias update (no regularization on bias).
  // v0.13.2 — clamp the post-step bias to within ±BIAS_CLAMP of the on-disk
  // baseline bias (defense-in-depth: a stream of one-sided y=1 labels can't
  // walk the intercept unboundedly). The weights above are untouched.
  const baselineBias = loadBaselineBias();
  const rawBias = model.bias - LEARNING_RATE * error;
  const newBias = Math.min(
    baselineBias + BIAS_CLAMP,
    Math.max(baselineBias - BIAS_CLAMP, rawBias),
  );

  // v0.15.12 — finalLoss was a hardcoded 0 inherited from the shadow-init
  // template and never recomputed, publishing as a (misleadingly perfect)
  // training loss. Track the real prequential log-loss instead: the
  // cross-entropy of each sample against the PRE-update model, smoothed
  // with an EMA (~10-sample horizon). Seeds from the first online step.
  const PRED_EPS = 1e-7;
  const pClamped = Math.min(1 - PRED_EPS, Math.max(PRED_EPS, prob));
  const sampleLoss = -(label * Math.log(pClamped) + (1 - label) * Math.log(1 - pClamped));
  const LOSS_EMA = 0.9;
  const newFinalLoss =
    model.finalLoss > 0 ? LOSS_EMA * model.finalLoss + (1 - LOSS_EMA) * sampleLoss : sampleLoss;

  // Provenance note (persisted into the shadow-model file). The alertId is
  // request-derived — allow-list its characters and bound its length before it
  // lands on disk; the verdict is re-normalized to a fresh literal ('resolved'
  // already returned above, so ack/dismiss/failed cover every reachable case).
  const alertIdForNotes = String(outcome.alertId ?? '').replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120);
  const verdictForNotes: AlertOutcome =
    outcome.outcome === 'dismiss' ? 'dismiss' : outcome.outcome === 'failed' ? 'failed' : 'ack';
  const updated: LrModel = {
    ...model,
    weights: newWeights,
    bias: newBias,
    trainedAt: Date.now(),
    samples: model.samples + 1,
    source: 'labeled',
    finalLoss: Math.round(newFinalLoss * 10000) / 10000,
    notes: `online-updated from outcome ${alertIdForNotes} (${verdictForNotes}, label=${label}) at ${new Date().toISOString()}`,
  };
  saveShadow(updated);

  let newLogit = updated.bias;
  for (const name of FEATURE_NAMES) {
    newLogit += (updated.weights[name] ?? 0) * (lrFeatures[name] ?? 0);
  }

  log(`onlineLR: outcome=${outcome.outcome} label=${label} prob=${prob.toFixed(3)} logit=${logit.toFixed(3)}→${newLogit.toFixed(3)} (samples=${updated.samples})`);
  return { updated: true, prevLogit: logit, newLogit, label };
}

function outcomeLabel(outcome: AlertOutcome): number {
  return outcome === 'dismiss' ? 0 : 1; // ack + failed → real
}

/** Read-only access to the current shadow model — used by the model
 *  health endpoint to show "online has diverged from baseline by N%". */
export function loadShadowModel(): LrModel {
  return loadCurrent();
}
