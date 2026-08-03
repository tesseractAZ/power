import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  rawPosture,
  createPostureTracker,
  DEESCALATE_HOLD_MS,
  SURPLUS_DWELL_MS,
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

/* ─── v0.87.0 — grid-aware: don't conserve lighting while the grid backstops ── */

test('rawPosture — gridBackstopping demotes the runway-derived red/amber/conserve to normal (above floor)', () => {
  // Live 2026-07-06: grid_available=on, pool above floor, hoursToReserve≈0.8 → the
  // engine went RED and HA dimmed/swept the lights on a grid-TIED evening. The
  // runway projection is islanded-only, so on grid these depletion escalations must
  // not fire.
  assert.equal(rawPosture(inputs({ gridBackstopping: true, hoursToReserve: 0.8 })).posture, 'normal'); // was red
  assert.equal(rawPosture(inputs({ gridBackstopping: true, hoursToReserve: 9.3, dawnMinSocPct: 12 })).posture, 'normal'); // was amber
  assert.equal(rawPosture(inputs({ gridBackstopping: true, dawnMinSocPct: 20 })).posture, 'normal'); // was conserve
  assert.match(rawPosture(inputs({ gridBackstopping: true, hoursToReserve: 0.8 })).reason, /grid backstopping/);
});

test('rawPosture — gridBackstopping NEVER masks the at/below-floor critical, and still allows surplus', () => {
  // SAFETY: the floor critical is grid-independent (at the floor even a backstopped
  // home is in a real conserve-hard state); only the forward PROJECTION demotes.
  assert.equal(rawPosture(inputs({ gridBackstopping: true, belowReserveFloor: true })).posture, 'critical');
  // Excess-solar surplus is orthogonal to depletion and still surfaces on grid.
  assert.equal(rawPosture(inputs({ gridBackstopping: true, curtailmentActive: true })).posture, 'surplus');
});

test('rawPosture — islanding (gridBackstopping false/absent) keeps the full escalation ladder', () => {
  // The islanding-safe default: absent flag behaves exactly as before this change.
  assert.equal(rawPosture(inputs({ hoursToReserve: 0.8 })).posture, 'red');
  assert.equal(rawPosture(inputs({ gridBackstopping: false, hoursToReserve: 0.8 })).posture, 'red');
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

// v1.63.0 — this test previously asserted that normal <-> surplus "swaps freely
// (same rank, no hold)". That WAS the behaviour, and it was the defect: the
// transition is an actuation edge that moves thermostat setpoints, and it had no
// debounce at all. The assertion is inverted deliberately, not relaxed — the same
// three ticks now prove the swap is REFUSED inside the dwell. Sustained-swap
// adoption is covered by the dwell suite at the end of this file.
test('tracker — normal <-> surplus does NOT swap freely; the dwell holds it', () => {
  const t = createPostureTracker();
  assert.equal(t.update(inputs({ dawnMinSocPct: 60, nowMs: 0 })).posture, 'normal');
  assert.equal(
    t.update(inputs({ curtailmentActive: true, dawnMinSocPct: 80, nowMs: MIN })).posture,
    'normal',
    'one tick of curtailment must not actuate the house',
  );
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

// State files live in a private (0700) mkdtemp directory — no predictable
// names in the shared os tmpdir (CodeQL js/insecure-temporary-file).
const stateDir = mkdtempSync(join(tmpdir(), 'posture-state-'));
let seq = 0;
function tmpState(): string {
  return join(stateDir, `posture-${seq++}.json`);
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
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});


/* ─── tracker — normal<->surplus dwell (v1.63.0) ──────────────────────────
 *
 * This transition is an ACTUATION EDGE: the HA "surplus pre-cool" automation
 * fires on -> surplus and moves every cool-mode thermostat setpoint; its sibling
 * restores them on -> normal. Before v1.63.0 it had NO debounce, because surplus
 * and normal share rank 0 and the 15-minute hold only ever guarded cross-rank
 * moves. The live 2026-07-23 event lasted three seconds and wrote both
 * thermostats twice.
 * ───────────────────────────────────────────────────────────────────────── */

const surplusIn = (nowMs: number) => inputs({ dawnMinSocPct: 60, curtailmentActive: true, nowMs });
const normalIn = (nowMs: number) => inputs({ dawnMinSocPct: 60, curtailmentActive: false, nowMs });

test('dwell — a brief curtailment blip NEVER reaches surplus', () => {
  const t = createPostureTracker();
  assert.equal(t.update(normalIn(0)).posture, 'normal');
  // The observed failure: active for one recompute, then gone.
  assert.equal(t.update(surplusIn(3_000)).posture, 'normal', 'a 3s blip must not actuate');
  assert.equal(t.update(normalIn(6_000)).posture, 'normal');
  // And well past the dwell, with the blip long over, still normal.
  assert.equal(t.update(normalIn(30 * MIN)).posture, 'normal');
});

test('dwell — sustained curtailment DOES reach surplus, after the dwell', () => {
  const t = createPostureTracker();
  t.update(normalIn(0));
  assert.equal(t.update(surplusIn(1 * MIN)).posture, 'normal', 'dwell running');
  assert.equal(t.update(surplusIn(9 * MIN)).posture, 'normal', 'still running');
  const r = t.update(surplusIn(1 * MIN + SURPLUS_DWELL_MS));
  assert.equal(r.posture, 'surplus', 'dwell elapsed from when the swap FIRST appeared');
  assert.equal(r.changedAtMs, 1 * MIN + SURPLUS_DWELL_MS);
});

test('dwell — leaving surplus dwells too (a dip must not restore setpoints)', () => {
  const t = createPostureTracker();
  t.update(normalIn(0));
  t.update(surplusIn(1 * MIN));
  t.update(surplusIn(1 * MIN + SURPLUS_DWELL_MS)); // now surplus
  const base = 1 * MIN + SURPLUS_DWELL_MS;
  assert.equal(t.update(normalIn(base + 1 * MIN)).posture, 'surplus', 'a dip holds pre-cool');
  assert.equal(t.update(normalIn(base + 9 * MIN)).posture, 'surplus');
  assert.equal(t.update(normalIn(base + 1 * MIN + SURPLUS_DWELL_MS)).posture, 'normal');
});

test('dwell — a flap back resets the dwell clock (no accumulating credit)', () => {
  const t = createPostureTracker();
  t.update(normalIn(0));
  t.update(surplusIn(1 * MIN));          // dwell starts
  t.update(normalIn(5 * MIN));           // flap back — clock must clear
  t.update(surplusIn(6 * MIN));          // dwell restarts here
  assert.equal(t.update(surplusIn(6 * MIN + SURPLUS_DWELL_MS - 1)).posture, 'normal',
    'the earlier partial dwell must not count toward this one');
  assert.equal(t.update(surplusIn(6 * MIN + SURPLUS_DWELL_MS)).posture, 'surplus');
});

test('dwell — a REAL escalation out of surplus is still immediate', () => {
  // THE safety property. Dwelling the swap must never delay the alarm ladder:
  // surplus -> conserve/amber/red/critical is a RANK increase, not a swap.
  const t = createPostureTracker();
  t.update(normalIn(0));
  t.update(surplusIn(1 * MIN));
  t.update(surplusIn(1 * MIN + SURPLUS_DWELL_MS));
  assert.equal(t.update(surplusIn(20 * MIN)).posture, 'surplus');
  const r = t.update(inputs({ curtailmentActive: true, hoursToReserve: 2, nowMs: 21 * MIN }));
  assert.equal(r.posture, 'red', 'escalation out of surplus must NOT wait for any dwell');
  assert.equal(r.changedAtMs, 21 * MIN);
});

test('dwell — escalating straight from a PENDING swap is immediate too', () => {
  const t = createPostureTracker();
  t.update(normalIn(0));
  t.update(surplusIn(1 * MIN)); // dwell pending, still reporting normal
  const r = t.update(inputs({ curtailmentActive: true, belowReserveFloor: true, nowMs: 2 * MIN }));
  assert.equal(r.posture, 'critical');
  assert.equal(r.changedAtMs, 2 * MIN);
});

test('dwell — survives a restart mid-dwell instead of restarting the countdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'posture-dwell-'));
  const path = join(dir, 'posture.json');
  try {
    const a = createPostureTracker(DEESCALATE_HOLD_MS, path);
    a.update(normalIn(0));
    a.update(surplusIn(1 * MIN)); // dwell begins and is persisted
    // Restart: a fresh tracker reading the same file must resume, not reset.
    const b = createPostureTracker(DEESCALATE_HOLD_MS, path);
    assert.equal(b.update(surplusIn(1 * MIN + SURPLUS_DWELL_MS)).posture, 'surplus',
      'the dwell that began before the restart must still count');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dwell — a same-posture reason refresh does not start or clear a dwell', () => {
  const t = createPostureTracker();
  t.update(inputs({ dawnMinSocPct: 60, nowMs: 0 }));
  const r = t.update(inputs({ dawnMinSocPct: 42, nowMs: 1 * MIN })); // same posture, new reason
  assert.equal(r.posture, 'normal');
  assert.match(r.reason, /42/);
  // A swap starting now must still serve the FULL dwell.
  t.update(surplusIn(2 * MIN));
  assert.equal(t.update(surplusIn(2 * MIN + SURPLUS_DWELL_MS - 1)).posture, 'normal');
  assert.equal(t.update(surplusIn(2 * MIN + SURPLUS_DWELL_MS)).posture, 'surplus');
});
