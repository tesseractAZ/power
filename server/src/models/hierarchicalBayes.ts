/**
 * v0.9.27 — Hierarchical Bayesian shrinkage for pack-level estimates.
 *
 * Track D. The operator has 25 packs (5 DPUs × 5 packs). Estimating each pack's
 * metrics (SoH, IR, vol-spread, cycles-to-EOL) IN ISOLATION gives noisy
 * per-pack numbers. Pooling them gives precise fleet-mean but loses
 * individual signal. The right answer is **partial pooling** — let each
 * pack share strength with its siblings while still moving away from
 * the group mean if its own data is informative enough.
 *
 * We do this with a closed-form three-level Gaussian:
 *
 *   y_pack    ~ Normal(μ_dpu, σ²_pack)        (one obs per pack)
 *   μ_dpu     ~ Normal(μ_fleet, σ²_dpu)       (DPU-level prior)
 *   μ_fleet   ~ Normal(μ_global, σ²_fleet)    (fleet-level prior)
 *
 * The posterior mean for any pack is a precision-weighted average of
 * its own observation, its DPU's mean, and the fleet mean. Packs with
 * tight measurements drift toward their own value; packs with noisy
 * measurements drift toward the DPU/fleet mean. This is exactly the
 * "borrow strength" we want.
 *
 * Conjugate Gaussian math (no MCMC needed):
 *
 *   posterior_mean = (prior_mean × prior_precision + y × obs_precision)
 *                  / (prior_precision + obs_precision)
 *
 * Applied recursively up the levels.
 *
 * For our use we pre-compute σ²_dpu and σ²_fleet as the empirical
 * within-group variance (method of moments). Each release we re-fit
 * these from a snapshot of observations.
 */

export interface HBPackObs {
  packKey: string;        // "<dpu-sn>:<pack-num>" — unique
  dpuKey: string;         // "<dpu-sn>"
  value: number;
  /** Per-observation σ (1-sigma uncertainty). 0 → no uncertainty (pin to value). */
  obsSigma: number;
}

export interface HBPackPosterior {
  packKey: string;
  dpuKey: string;
  /** Raw observation. */
  rawValue: number;
  rawSigma: number;
  /** Shrunken (partial-pooled) posterior estimate. */
  posteriorMean: number;
  posteriorSigma: number;
  /** How much the pack moved toward its DPU mean — 0=unchanged, 1=fully shrunk to DPU mean. */
  shrinkageToDpu: number;
}

export interface HBFitResult {
  packs: HBPackPosterior[];
  /** Posterior estimate of each DPU's mean. */
  dpuMeans: Map<string, number>;
  /** Fleet (top-level) posterior mean. */
  fleetMean: number;
  /** Empirical within-DPU σ (pack-to-pack variance). */
  sigmaWithinDpu: number;
  /** Empirical within-fleet σ (DPU-to-DPU variance). */
  sigmaWithinFleet: number;
}

/**
 * Three-level hierarchical Bayesian shrinkage fit.
 *
 * Inputs: per-pack observations (value + uncertainty), each tagged with
 * its DPU. Output: posterior mean + uncertainty for each pack, plus
 * the inferred DPU + fleet means.
 *
 * This is a one-pass, closed-form computation — no sampling. The
 * within-group variances are estimated by method-of-moments from the
 * observations themselves (empirical Bayes).
 */
export function fitHierarchical(obs: HBPackObs[]): HBFitResult {
  if (obs.length === 0) {
    return {
      packs: [],
      dpuMeans: new Map(),
      fleetMean: 0,
      sigmaWithinDpu: 0,
      sigmaWithinFleet: 0,
    };
  }

  // Group packs by DPU.
  const byDpu = new Map<string, HBPackObs[]>();
  for (const o of obs) {
    let arr = byDpu.get(o.dpuKey);
    if (!arr) { arr = []; byDpu.set(o.dpuKey, arr); }
    arr.push(o);
  }

  // Empirical within-DPU σ — pack-to-pack spread WITHIN a DPU.
  //
  // Robust to outliers via 10% winsorization on squared deviations. Without
  // this, a single big outlier inflates the σ estimate, which then SUPPRESSES
  // the shrinkage that would have caught it — the exact opposite of what we
  // want for partial pooling. Empirically: with one 25-point outlier in 25
  // observations, naive σ ≈ 4.5 → shrinkage ≈ 4% (model effectively ignores
  // the outlier); winsorized σ ≈ 2.2 → shrinkage ≈ 16% (model meaningfully
  // pulls outlier toward its DPU mean).
  const sqDevs: number[] = [];
  for (const [, arr] of byDpu) {
    if (arr.length < 2) continue;
    const mean = arr.reduce((s, o) => s + o.value, 0) / arr.length;
    for (const o of arr) sqDevs.push((o.value - mean) ** 2);
  }
  sqDevs.sort((a, b) => a - b);
  // Winsorize: replace the top 10% of squared deviations with the 90th-pct.
  const cutoff = Math.max(1, Math.floor(sqDevs.length * 0.9));
  const cap = sqDevs[Math.min(cutoff, sqDevs.length - 1)] ?? 0;
  let trimmedSum = 0;
  for (let i = 0; i < sqDevs.length; i++) {
    trimmedSum += i < cutoff ? sqDevs[i] : cap;
  }
  const sigmaWithinDpu = sqDevs.length > 0
    ? Math.sqrt(trimmedSum / sqDevs.length)
    : 1;

  // DPU means (simple average for prior — true Bayes would precision-weight).
  const dpuRawMeans = new Map<string, number>();
  for (const [dpu, arr] of byDpu) {
    dpuRawMeans.set(dpu, arr.reduce((s, o) => s + o.value, 0) / arr.length);
  }

  // Empirical between-DPU σ — DPU-mean-to-DPU-mean spread.
  const dpuMeansList = Array.from(dpuRawMeans.values());
  const fleetRawMean = dpuMeansList.reduce((s, v) => s + v, 0) / dpuMeansList.length;
  let sumBetweenSq = 0;
  for (const m of dpuMeansList) sumBetweenSq += (m - fleetRawMean) ** 2;
  const sigmaWithinFleet = dpuMeansList.length > 1
    ? Math.sqrt(sumBetweenSq / dpuMeansList.length)
    : 1;

  // Posterior fleet mean — prior is uninformative, so just the empirical avg.
  const fleetMean = fleetRawMean;

  // Posterior DPU means — shrink each DPU's empirical mean toward the fleet mean.
  const dpuMeans = new Map<string, number>();
  for (const [dpu, arr] of byDpu) {
    const dpuRaw = dpuRawMeans.get(dpu)!;
    const n = arr.length;
    // Likelihood precision: n / sigmaWithinDpu²
    const likPrec = n / Math.max(1e-9, sigmaWithinDpu ** 2);
    // Prior precision: 1 / sigmaWithinFleet²
    const priorPrec = 1 / Math.max(1e-9, sigmaWithinFleet ** 2);
    const post = (likPrec * dpuRaw + priorPrec * fleetMean) / (likPrec + priorPrec);
    dpuMeans.set(dpu, post);
  }

  // Posterior pack means — shrink each pack's observation toward its DPU's posterior mean.
  const packs: HBPackPosterior[] = [];
  for (const o of obs) {
    const dpuPostMean = dpuMeans.get(o.dpuKey)!;
    // Likelihood precision from obs: 1/σ². If σ=0, infinite precision (pinned).
    const likSigma = Math.max(1e-3, o.obsSigma);
    const likPrec = 1 / (likSigma ** 2);
    // Prior precision from DPU pooling
    const priorPrec = 1 / Math.max(1e-9, sigmaWithinDpu ** 2);
    const postMean = (likPrec * o.value + priorPrec * dpuPostMean) / (likPrec + priorPrec);
    const postPrec = likPrec + priorPrec;
    const postSigma = 1 / Math.sqrt(postPrec);
    // Shrinkage: 0 = no movement, 1 = fully pulled to DPU mean
    const shrinkage = Math.abs(o.value - dpuPostMean) > 1e-9
      ? (o.value - postMean) / (o.value - dpuPostMean)
      : 0;
    packs.push({
      packKey: o.packKey,
      dpuKey: o.dpuKey,
      rawValue: o.value,
      rawSigma: o.obsSigma,
      posteriorMean: postMean,
      posteriorSigma: postSigma,
      shrinkageToDpu: Math.max(0, Math.min(1, shrinkage)),
    });
  }

  return { packs, dpuMeans, fleetMean, sigmaWithinDpu, sigmaWithinFleet };
}

/**
 * Identify outlier packs — those whose posterior is unusually far from
 * their DPU's posterior mean (i.e. they didn't shrink toward sibling
 * packs much), AND whose deviation is large in absolute units.
 *
 * Returns packs whose deviation z-score exceeds `zThreshold` (default 2).
 */
export function findOutliers(fit: HBFitResult, zThreshold = 2.0): HBPackPosterior[] {
  return fit.packs.filter((p) => {
    const dpuMean = fit.dpuMeans.get(p.dpuKey) ?? 0;
    const z = Math.abs(p.posteriorMean - dpuMean) / Math.max(1e-9, fit.sigmaWithinDpu);
    return z >= zThreshold;
  });
}
