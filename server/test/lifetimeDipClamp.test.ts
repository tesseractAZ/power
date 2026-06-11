import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLifetimeDip } from '../src/recorder.js';

/**
 * v0.15.14 — lifetime micro-dip clamp (from the 20h log analysis).
 *
 * HA core log showed 21 Recorder warnings ("state class total_increasing, but
 * its state is not strictly increasing") on per-circuit lifetime energy
 * sensors, each triggered by a 1–6 Wh dip (e.g. 81.429 → 81.423 kWh): the
 * live pendingWh trapezoid estimate is re-derived per call and can land a
 * hair below the previously emitted total after a rollup persists. HA reads
 * any decrease on a total_increasing sensor as a meter RESET, corrupting the
 * Energy Dashboard with phantom resets. The clamp holds the previous total
 * across micro-dips; large drops (a genuine operator re-zero) pass through.
 */

test('clampLifetimeDip — no previous emission → pending unchanged', () => {
  assert.equal(clampLifetimeDip(undefined, 1000, 25), 25);
});

test('clampLifetimeDip — increasing total → pending unchanged', () => {
  // prev 1020, new total 1030 — normal accumulation.
  assert.equal(clampLifetimeDip(1020, 1000, 30), 30);
});

test('clampLifetimeDip — micro-dip is held at the previous total', () => {
  // Previously emitted 81429 Wh; rollup persisted 81423 with pending 0 —
  // a 6 Wh dip (the exact live case from the HA log). Held: pending becomes
  // prev − persisted so persisted+pending == prev.
  assert.equal(clampLifetimeDip(81_429, 81_423, 0), 6);
  // boundary: exactly maxDip (50 Wh) is still held
  assert.equal(clampLifetimeDip(1050, 1000, 0), 50);
});

test('clampLifetimeDip — flat total → unchanged (dip = 0 is not a dip)', () => {
  assert.equal(clampLifetimeDip(1000, 1000, 0), 0);
});

test('clampLifetimeDip — a genuine reset (large drop) passes through', () => {
  // Operator re-zeroed the accumulator: 92 kWh → 100 Wh. Must NOT be held,
  // so HA's total_increasing reset semantics engage as designed.
  assert.equal(clampLifetimeDip(92_047, 0, 100), 100);
});
