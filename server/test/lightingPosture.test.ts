import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  rawPosture,
  createPostureTracker,
  DEESCALATE_HOLD_MS,
  PERSIST_MAX_AGE_MS,
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

/* ─── v0.15.20 — persistence across restarts ─────────────────────────── */

const tmpPaths: string[] = [];
let seq = 0;
function tmpState(): string {
  const p = join(tmpdir(), `posture-${process.pid}-${seq++}.json`);
  tmpPaths.push(p);
  return p;
}

test('persistence — a restart resumes the held posture (no flap on half-warm calm)', () => {
  const path = tmpState();
  const now = Date.now(); // persistence freshness uses wall-clock
  const t1 = createPostureTracker(DEESCALATE_HOLD_MS, path);
  assert.equal(t1.update(inputs({ hoursToReserve: 9, dawnMinSocPct: 12, nowMs: now })).posture, 'amber');
  // "Restart": a fresh tracker on the same path, fed the half-warm 'normal'
  // the live system produced — it must stay amber (de-escalation hold).
  const t2 = createPostureTracker(DEESCALATE_HOLD_MS, path);
  assert.equal(t2.update(inputs({ dawnMinSocPct: 60, nowMs: now + 2 * MIN })).posture, 'amber');
  // Once the calm has genuinely held, it relaxes as usual.
  assert.equal(
    t2.update(inputs({ dawnMinSocPct: 60, nowMs: now + 2 * MIN + DEESCALATE_HOLD_MS })).posture,
    'normal',
  );
});

test('persistence — the de-escalation countdown survives a restart mid-hold', () => {
  const path = tmpState();
  const now = Date.now();
  const t1 = createPostureTracker(DEESCALATE_HOLD_MS, path);
  t1.update(inputs({ hoursToReserve: 3, nowMs: now })); // red
  t1.update(inputs({ dawnMinSocPct: 60, nowMs: now + 5 * MIN })); // calm begins (persisted)
  const t2 = createPostureTracker(DEESCALATE_HOLD_MS, path);
  // 15 min after the calm BEGAN — not after the restart — it relaxes.
  assert.equal(
    t2.update(inputs({ dawnMinSocPct: 60, nowMs: now + 5 * MIN + DEESCALATE_HOLD_MS })).posture,
    'normal',
  );
});

test('persistence — stale state (> 1 h) is discarded; tracker seeds fresh', () => {
  const path = tmpState();
  writeFileSync(path, JSON.stringify({
    posture: 'critical', reason: 'old event', changedAtMs: 0, calmerSinceMs: null,
    savedAtMs: Date.now() - PERSIST_MAX_AGE_MS - 1,
  }));
  const t = createPostureTracker(DEESCALATE_HOLD_MS, path);
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: Date.now() })).posture, 'normal');
});

test('persistence — corrupt or unknown-posture state is discarded', () => {
  const path = tmpState();
  writeFileSync(path, '{not json');
  const t = createPostureTracker(DEESCALATE_HOLD_MS, path);
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: Date.now() })).posture, 'normal');
  const path2 = tmpState();
  writeFileSync(path2, JSON.stringify({ posture: 'panic', reason: 'x', changedAtMs: 0, calmerSinceMs: null, savedAtMs: Date.now() }));
  const t2 = createPostureTracker(DEESCALATE_HOLD_MS, path2);
  assert.equal(t2.update(inputs({ dawnMinSocPct: 60, nowMs: Date.now() })).posture, 'normal');
});

test('persistence — same-rank reason refreshes do NOT rewrite the file each tick', () => {
  const path = tmpState();
  const now = Date.now();
  const t = createPostureTracker(DEESCALATE_HOLD_MS, path);
  t.update(inputs({ hoursToReserve: 9, dawnMinSocPct: 12, nowMs: now })); // amber, persisted
  const before = readFileSync(path, 'utf8');
  t.update(inputs({ hoursToReserve: 8.5, dawnMinSocPct: 12, nowMs: now + MIN })); // same rank, new reason
  const after = readFileSync(path, 'utf8');
  assert.equal(before, after);
});

test.after(() => {
  for (const p of tmpPaths) {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});
