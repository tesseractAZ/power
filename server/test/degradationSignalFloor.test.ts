import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sohSignalBelowFloor } from '../src/analytics.js';

// v0.32.0 — sohSignalBelowFloor() must reject a near-new pack whose SoH has only
// wobbled a fraction of a percent across the window (BMS quantization noise that
// OLS would fit as a confident multi-%/yr fade → a false dated EOL), while still
// admitting a genuine multi-point decline. This is the companion to
// sohStepDominated for the shallow-noisy-decline shape it misses.
const HOUR = 3_600_000;
const series = (vals: number[]) => vals.map((value, i) => ({ ts: i * HOUR, value }));

test('sohSignalBelowFloor — TRUE for the live Y711FAB59J234000 pack 2 shape (98.6% SoH, ~0.5pt net drop over 5 quantized values)', () => {
  const vals = [
    ...Array(40).fill(99.14),
    ...Array(15).fill(98.72),
    98.14, // a lone quantization spike down — robust measure must ignore it
    ...Array(13).fill(98.59),
    ...Array(40).fill(98.63),
  ];
  assert.equal(sohSignalBelowFloor(series(vals)), true);
});

test('sohSignalBelowFloor — TRUE for the live pack 3 shape (98.8% SoH, ~0.33pt net drop)', () => {
  const vals = [
    ...Array(40).fill(99.16),
    ...Array(15).fill(98.83),
    98.16,
    ...Array(13).fill(98.44),
    ...Array(40).fill(98.83),
  ];
  assert.equal(sohSignalBelowFloor(series(vals)), true);
});

test('sohSignalBelowFloor — TRUE for a flat wobble with no net trend', () => {
  const vals = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 99.0 : 98.6));
  assert.equal(sohSignalBelowFloor(series(vals)), true);
});

test('sohSignalBelowFloor — TRUE for an up-step (negative net drop)', () => {
  const vals = [...Array(40).fill(97.47), ...Array(40).fill(98.59)];
  assert.equal(sohSignalBelowFloor(series(vals)), true);
});

test('sohSignalBelowFloor — TRUE for too-few samples', () => {
  assert.equal(sohSignalBelowFloor(series([100, 99])), true);
});

test('sohSignalBelowFloor — FALSE for a genuine gradual fade (net drop ~2.3pt > floor)', () => {
  const vals = Array.from({ length: 30 }, (_, i) => 100 - i * 0.1); // 100 → 97.1
  assert.equal(sohSignalBelowFloor(series(vals)), false);
});

test('sohSignalBelowFloor — FALSE for a noisy-but-trending decline with real signal', () => {
  const vals = Array.from({ length: 40 }, (_, i) => 100 - i * 0.08 + (i % 2 === 0 ? 0.03 : -0.03));
  assert.equal(sohSignalBelowFloor(series(vals)), false);
});
