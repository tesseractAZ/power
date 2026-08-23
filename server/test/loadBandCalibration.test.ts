import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibratedLoadBandFactor } from '../src/nightChargeAdvisor.js';

/**
 * v1.106.0 — the load band was never a quantile.
 *
 * `loadP10Kwh`/`loadP90Kwh` were `P50 ÷ 1.15` and `P50 × 1.15` — a hand-set ±15%
 * sizing multiplier that nothing estimated from data, yet named P10/P90 and
 * graded by the readiness gate as a calibrated 80% interval. Measured on the
 * live ledger it contained the actual **14%** of the time, and realized load
 * errors of −28% sat far outside it.
 */

test('below minSamples it returns the floor and says so — never calibrates on noise', () => {
  const r = calibratedLoadBandFactor([0.3, 0.4, 0.5], { minSamples: 10 });
  assert.equal(r.basis, 'default');
  assert.equal(r.factor, 1.15, 'the historical hand-set value');
  assert.equal(r.samples, 3);
});

test('★ it can only WIDEN — a tight error history never narrows below the floor', () => {
  // Every night within ±2%: the empirical band would be 1.02, but narrowing
  // would make the planner LESS conservative than it is today.
  const tiny = new Array(20).fill(0.02);
  const r = calibratedLoadBandFactor(tiny);
  assert.equal(r.factor, 1.15, 'floored — this change is monotone in the safe direction');
  assert.equal(r.basis, 'measured', 'still reports that it had data');
});

test('a realistic error history widens the band to cover ~80%', () => {
  // 20 nights: 16 within ±25%, 4 worse. The 80th percentile of |err| is 0.25.
  const errs = [...new Array(16).fill(0.25), 0.4, 0.45, 0.5, 0.6];
  const r = calibratedLoadBandFactor(errs);
  assert.equal(r.basis, 'measured');
  assert.equal(r.factor, 1.25, `±25% covers 80% of realized nights (got ${r.factor})`);
});

test('sign is irrelevant — an over-forecast miss widens the band the same as an under', () => {
  const neg = calibratedLoadBandFactor(new Array(20).fill(-0.3));
  const pos = calibratedLoadBandFactor(new Array(20).fill(0.3));
  assert.equal(neg.factor, pos.factor, 'the band is two-sided');
  assert.equal(neg.factor, 1.3);
});

test('★ a cap stops pathological nights running the band away', () => {
  const wild = [...new Array(10).fill(0.2), ...new Array(10).fill(5.0)];
  const r = calibratedLoadBandFactor(wild, { cap: 2.0 });
  assert.equal(r.factor, 2.0, 'clamped');
});

test('nulls and non-finite values are ignored, not treated as zero error', () => {
  const errs = [null, undefined, NaN, Infinity, ...new Array(12).fill(0.3)];
  const r = calibratedLoadBandFactor(errs as any);
  assert.equal(r.samples, 12, 'only real observations count');
  assert.equal(r.factor, 1.3, 'a null must not masquerade as a perfect forecast');
});

test('reproduces the live shape: ±15% covering 14% means the band must widen', () => {
  // Live: load_in_band 0.14 against a ±15% band, with errors around -0.28.
  const errs = [0.05, 0.10, ...new Array(12).fill(0.28), 0.35, 0.40];
  const r = calibratedLoadBandFactor(errs);
  assert.ok(r.factor > 1.15, `must widen beyond the hand-set value (got ${r.factor})`);
  assert.ok(r.factor <= 1.4, `but stay physically sane (got ${r.factor})`);
});
