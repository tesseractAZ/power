import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rawPosture,
  createPostureTracker,
  DEESCALATE_HOLD_MS,
  type PostureInputs,
} from '../src/lightingPosture.js';

// v0.15.19 — unit tests for the lighting energy posture classifier + tracker.
// All time flows through PostureInputs.nowMs, so the hysteresis hold is fully
// deterministic here.

const MIN = 60_000;

const inputs = (over: Partial<PostureInputs>): PostureInputs => ({
  belowReserveFloor: false,
  hoursToReserve: null,
  dawnMinSocPct: null,
  reservePct: 15,
  curtailmentActive: false,
  nowMs: 0,
  ...over,
});

/* ─── rawPosture — the pure ladder ───────────────────────────────────── */

test('rawPosture — normal when nothing is projected', () => {
  const r = rawPosture(inputs({ dawnMinSocPct: 62 }));
  assert.equal(r.posture, 'normal');
  assert.match(r.reason, /62%/);
});

test('rawPosture — surplus only while PV curtailment is active', () => {
  assert.equal(rawPosture(inputs({ curtailmentActive: true, dawnMinSocPct: 80 })).posture, 'surplus');
  // Curtailment NEVER masks a depletion signal — conserve outranks surplus.
  assert.equal(rawPosture(inputs({ curtailmentActive: true, dawnMinSocPct: 30 })).posture, 'conserve');
});

test('rawPosture — conserve when the dawn minimum is thin (< 35%)', () => {
  assert.equal(rawPosture(inputs({ dawnMinSocPct: 34.9 })).posture, 'conserve');
  assert.equal(rawPosture(inputs({ dawnMinSocPct: 35 })).posture, 'normal');
});

test('rawPosture — amber on a projected reserve crossing, or a dawn that grazes reserve', () => {
  // A crossing far out (> RED threshold) is amber.
  const crossing = rawPosture(inputs({ hoursToReserve: 9.3, dawnMinSocPct: 12 }));
  assert.equal(crossing.posture, 'amber');
  assert.match(crossing.reason, /9\.3h/);
  // No crossing, but the dawn minimum lands inside reserve + 5% margin.
  const grazing = rawPosture(inputs({ dawnMinSocPct: 18, reservePct: 15 }));
  assert.equal(grazing.posture, 'amber');
  assert.match(grazing.reason, /grazes reserve 15%/);
  // reservePct null falls back to 15 → same graze band applies.
  assert.equal(rawPosture(inputs({ dawnMinSocPct: 18, reservePct: null })).posture, 'amber');
});

test('rawPosture — red when the crossing is ≤ 4 h away', () => {
  assert.equal(rawPosture(inputs({ hoursToReserve: 4 })).posture, 'red');
  assert.equal(rawPosture(inputs({ hoursToReserve: 4.1 })).posture, 'amber');
});

test('rawPosture — critical at/below the reserve floor, regardless of horizon math', () => {
  // Mirrors the v0.15.18 classifyRunway fix: once pinned at the floor, the
  // forward-looking figures can read calm (rising-then-crossing) — the floor wins.
  const r = rawPosture(inputs({ belowReserveFloor: true, hoursToReserve: 18.8, dawnMinSocPct: 60 }));
  assert.equal(r.posture, 'critical');
  assert.match(r.reason, /reserve floor/);
});

/* ─── tracker — asymmetric hysteresis ────────────────────────────────── */

test('tracker — escalation applies immediately', () => {
  const t = createPostureTracker();
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: 0 })).posture, 'normal');
  const r = t.update(inputs({ hoursToReserve: 3, nowMs: MIN }));
  assert.equal(r.posture, 'red');
  assert.equal(r.changedAtMs, MIN);
});

test('tracker — de-escalation holds the sterner posture until the calm has lasted holdMs', () => {
  const t = createPostureTracker(); // default 15-min hold
  t.update(inputs({ hoursToReserve: 3, nowMs: 0 })); // red
  // Calmer raw (normal) — but not yet held long enough.
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: 5 * MIN })).posture, 'red');
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: 14 * MIN })).posture, 'red');
  // 15 min after the calm BEGAN (5min mark) → relax.
  const r = t.update(inputs({ dawnMinSocPct: 60, nowMs: 5 * MIN + DEESCALATE_HOLD_MS }));
  assert.equal(r.posture, 'normal');
  assert.equal(r.changedAtMs, 5 * MIN + DEESCALATE_HOLD_MS);
});

test('tracker — a flap back to the sterner posture resets the de-escalation clock', () => {
  const t = createPostureTracker();
  t.update(inputs({ hoursToReserve: 3, nowMs: 0 })); // red
  t.update(inputs({ dawnMinSocPct: 60, nowMs: 5 * MIN })); // calm begins
  t.update(inputs({ hoursToReserve: 3.5, nowMs: 10 * MIN })); // cloud edge — red again
  // Calm resumes; the old 5-min head start must NOT count.
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: 20 * MIN })).posture, 'red');
  assert.equal(
    t.update(inputs({ dawnMinSocPct: 60, nowMs: 20 * MIN + DEESCALATE_HOLD_MS })).posture,
    'normal',
  );
});

test('tracker — after the hold, de-escalation adopts the current raw posture', () => {
  const t = createPostureTracker();
  t.update(inputs({ belowReserveFloor: true, nowMs: 0 })); // critical
  // Raw says conserve; after the hold the tracker adopts conserve (the raw value).
  t.update(inputs({ dawnMinSocPct: 30, nowMs: MIN }));
  const r = t.update(inputs({ dawnMinSocPct: 30, nowMs: MIN + DEESCALATE_HOLD_MS }));
  assert.equal(r.posture, 'conserve');
});

test('tracker — normal ↔ surplus swap freely (same rank, no hold)', () => {
  const t = createPostureTracker();
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: 0 })).posture, 'normal');
  assert.equal(t.update(inputs({ curtailmentActive: true, dawnMinSocPct: 80, nowMs: MIN })).posture, 'surplus');
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: 2 * MIN })).posture, 'normal');
});

test('tracker — same rank adopts the fresh reason', () => {
  const t = createPostureTracker();
  t.update(inputs({ hoursToReserve: 9.0, dawnMinSocPct: 20, nowMs: 0 })); // amber
  const r = t.update(inputs({ hoursToReserve: 8.2, dawnMinSocPct: 20, nowMs: MIN }));
  assert.equal(r.posture, 'amber');
  assert.match(r.reason, /8\.2h/);
});

test('tracker — reset() forgets state so the next update seeds fresh', () => {
  const t = createPostureTracker();
  t.update(inputs({ hoursToReserve: 3, nowMs: 0 })); // red
  t.reset();
  // Without reset this calm reading would still be inside the hold window.
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: MIN })).posture, 'normal');
});
