import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sohStepDominated } from '../src/analytics.js';

// v0.28.0 — sohStepDominated() must reject a fleet-wide BMS SoH RECALIBRATION
// staircase (which OLS otherwise fits as a confident fade → false EOL / fade /
// r² / peer-fade) while still admitting a genuine gradual fade trend.
const HOUR = 3_600_000;
const series = (vals: number[]) => vals.map((value, i) => ({ ts: i * HOUR, value }));

test('sohStepDominated — true for the live pack5 shape (long flat, then a 2-step terminal cliff)', () => {
  // 109 samples: flat 99.23 for ~94, then 97.28, then 96.72 for the rest.
  const vals = [
    ...Array(94).fill(99.23),
    97.28,
    ...Array(14).fill(96.72),
  ];
  assert.equal(sohStepDominated(series(vals)), true);
});

test('sohStepDominated — true for the inverse (up-step) recalibration too (sign-symmetric)', () => {
  const vals = [...Array(94).fill(97.47), 98.36, ...Array(14).fill(98.59)];
  assert.equal(sohStepDominated(series(vals)), true);
});

test('sohStepDominated — true when < 3 distinct values', () => {
  assert.equal(sohStepDominated(series([99, 99, 99, 99, 98, 98, 98, 98])), true);
});

test('sohStepDominated — true when too few samples', () => {
  assert.equal(sohStepDominated(series([100, 99.5, 99])), true);
});

test('sohStepDominated — FALSE for a genuine gradual fade (many distinct, spread transitions)', () => {
  // 30 samples declining 100 → 97.1 in steady ~0.1pt steps — a real trend.
  const vals = Array.from({ length: 30 }, (_, i) => 100 - i * 0.1);
  assert.equal(sohStepDominated(series(vals)), false);
});

test('sohStepDominated — FALSE for a noisy-but-trending decline', () => {
  const vals = Array.from({ length: 40 }, (_, i) => 100 - i * 0.08 + (i % 2 === 0 ? 0.03 : -0.03));
  assert.equal(sohStepDominated(series(vals)), false);
});
