import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldGateRunwayAudible, type GridContext } from '../src/runwayAlarm.js';

/**
 * v0.93.0 (audit #8) — the runway CRITICAL audible flapped a chime at the by-design
 * ~10% reserve floor on a GRID-TIED home. The AUDIBLE annunciation is now gated
 * while the grid is backstopping (push + on-screen untouched). These pin the pure
 * gate predicate: it mutes ONLY when the grid is actively carrying the load, and is
 * a strict no-op off-grid so a genuine islanded depletion still annunciates.
 */

const ctx = (over: Partial<GridContext>): GridContext => ({ present: true, backstopping: true, ...over });

test('grid backstopping → audible gated (chime muted)', () => {
  assert.equal(shouldGateRunwayAudible(ctx({ backstopping: true })), true);
});

test('off-grid (backstopping=false) → NOT gated — real islanded emergency still annunciates', () => {
  assert.equal(shouldGateRunwayAudible(ctx({ present: false, backstopping: false })), false);
});

test('grid present but NOT carrying the load (declared, not backstopping) → NOT gated', () => {
  // A grid that is energized but not actually carrying the load at the floor keeps
  // the audible — that is the genuine "no backstop at the floor" emergency.
  assert.equal(shouldGateRunwayAudible(ctx({ present: true, backstopping: false })), false);
});

test('missing grid context → NOT gated (safe default = off-grid, audible fires)', () => {
  assert.equal(shouldGateRunwayAudible(undefined), false);
});
