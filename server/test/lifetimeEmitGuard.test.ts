import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardLifetimeEmit, LIFETIME_HOLD_DIP_WH, LIFETIME_RETURN_SHARE } from '../src/recorder.js';
import { haTotalIncreasing } from './helpers/haTotalIncreasing.js';

/**
 * v1.193.0 — the published-counter guard, guardLifetimeEmit (was the v0.15.14 micro-dip clamp,
 * clampLifetimeDip; this file was lifetimeDipClamp.test.ts).
 *
 * v0.15.14: HA core log showed 21 Recorder warnings ("state class total_increasing, but its state
 * is not strictly increasing") on per-circuit lifetime energy sensors, each from a 1–6 Wh dip (e.g.
 * 81.429 → 81.423 kWh): the live pending trapezoid is re-derived per call and can land a hair below
 * the previously emitted total after a rollup persists. The clamp held dips up to 50 Wh (5 kWh on
 * two counters, v1.188.1) and let a larger drop through as "a genuine reset".
 *
 * v1.193.0: Home Assistant reads a state below 0.9 × the previous one as a meter reset and books
 * the WHOLE new state again (sensor/recorder.py reset_detected; helpers/haTotalIncreasing.ts), so
 * the drops let through put the full counter into the Energy statistics again (Battery Energy In:
 * about 12,043 kWh by 2026-09-07). The guard never emits below the last value: a drop up to
 * LIFETIME_HOLD_DIP_WH is held, a larger one continues from the last value (`rebaseWh`, which the
 * recorder adds to the counter's basis shift).
 */

test('guardLifetimeEmit — no previous emission: the reading, verdict first', () => {
  assert.deepEqual(guardLifetimeEmit(undefined, 1_234), { emitWh: 1_234, rebaseWh: 0, verdict: 'first' });
  assert.deepEqual(guardLifetimeEmit(Number.NaN, 1_234), { emitWh: 1_234, rebaseWh: 0, verdict: 'first' }, 'a non-finite last value is no last value');
});

test('guardLifetimeEmit — a rise (and a flat reading) is emitted as read', () => {
  assert.deepEqual(guardLifetimeEmit(1_000, 1_200), { emitWh: 1_200, rebaseWh: 0, verdict: 'rise' });
  assert.deepEqual(guardLifetimeEmit(1_000, 1_000), { emitWh: 1_000, rebaseWh: 0, verdict: 'rise' }, 'flat: dip 0 is not a dip');
});

test('guardLifetimeEmit — a micro-dip is held at the last value (the v0.15.14 case)', () => {
  // Previously emitted 81,429 Wh; the rollup persisted 81,423 with pending 0: a 6 Wh dip.
  assert.deepEqual(guardLifetimeEmit(81_429, 81_423), { emitWh: 81_429, rebaseWh: 0, verdict: 'held' });
  assert.deepEqual(guardLifetimeEmit(10_000, 9_900), { emitWh: 10_000, rebaseWh: 0, verdict: 'held' }, 'a 100 Wh dip (9 -> 1 kW on the old read path)');
});

test('v1.193.0 — the hold is LIFETIME_HOLD_DIP_WH (5 kWh) on every key; one Wh more is rebased, never passed through', () => {
  assert.equal(LIFETIME_HOLD_DIP_WH, 5_000);
  assert.deepEqual(guardLifetimeEmit(7_613_000, 7_608_000), { emitWh: 7_613_000, rebaseWh: 0, verdict: 'held' }, 'a dip of exactly 5,000 Wh is held');
  const g = guardLifetimeEmit(7_613_000, 7_607_999.999);
  assert.equal(g.verdict, 'rebased');
  assert.equal(g.emitWh, 7_613_000, 'the last value again');
  assert.ok(Math.abs(g.rebaseWh - 5_000.001) < 1e-6, `rebaseWh is the dip (${g.rebaseWh})`);
  // PV Production at 7,613 kWh: a 600 Wh pending share that left the read path (the v1.188.1 case).
  assert.deepEqual(guardLifetimeEmit(7_613_000, 7_612_400), { emitWh: 7_613_000, rebaseWh: 0, verdict: 'held' });
});

test('v1.193.0 — what the clamp passed through as a genuine reset continues from the last value (changed: the clamp emitted the drop)', () => {
  // The membership leave on the test plant: 8,192 Wh -> 4,096 Wh, below 0.9 × 8,192: HA's meter reset.
  // (The re-seed now shifts explicitly; this is the guard's own backstop for a drop it cannot explain.)
  assert.deepEqual(guardLifetimeEmit(8_192, 4_096, 1_000), { emitWh: 8_192, rebaseWh: 4_096, verdict: 'rebased' });
  // The operator re-zero / a replaced database: 92 kWh -> 100 Wh. The clamp emitted 100 here.
  assert.deepEqual(guardLifetimeEmit(92_047, 100), { emitWh: 92_047, rebaseWh: 91_947, verdict: 'rebased' });
});

test('guardLifetimeEmit — a non-finite reading is held at the last value; with none, the result is non-finite (the key publishes null)', () => {
  assert.deepEqual(guardLifetimeEmit(500, Number.NaN), { emitWh: 500, rebaseWh: 0, verdict: 'held' });
  assert.deepEqual(guardLifetimeEmit(500, Number.POSITIVE_INFINITY), { emitWh: 500, rebaseWh: 0, verdict: 'held' });
  assert.ok(!Number.isFinite(guardLifetimeEmit(undefined, Number.NaN).emitWh));
});

// v1.193.0 — the 2026-06-08 shape: every counter read about 0 for an hour, then its old value, and
// Home Assistant booked each one a second time (PV +808.6 kWh, Home Consumption +825.1 kWh). A drop
// the guard continues from is OWED (the recorder keeps it in lifetime_basis.owed_wh); when the
// reading climbs back, the owed shift is taken back instead of being published as energy.
test('v1.193.0 — an unexplained drop that RETURNS is taken back, never published twice', () => {
  const down = guardLifetimeEmit(92_047, 100);
  assert.deepEqual(down, { emitWh: 92_047, rebaseWh: 91_947, verdict: 'rebased' });
  // The next read: the row back plus 50 Wh of new energy, carried by the 91,947 Wh shift.
  const back = guardLifetimeEmit(92_047, 92_097 + 91_947, LIFETIME_HOLD_DIP_WH, 91_947);
  assert.deepEqual(back, { emitWh: 92_097, rebaseWh: -91_947, verdict: 'returned' });
  assert.deepEqual(haTotalIncreasing([92_047, down.emitWh, back.emitWh]), { sum: 50, resets: 0, phantomWh: 0, dips: 0, negativeWh: 0 });
  // Nothing owed (the take-back removed): the same read publishes the counter twice.
  assert.equal(guardLifetimeEmit(92_047, 92_097 + 91_947).emitWh, 184_044);
});

test('v1.193.0 — the take-back: at most the amount owed, and only a rise over the hold and of at least half of it', () => {
  assert.equal(LIFETIME_RETURN_SHARE, 0.5);
  // Owed 10 kWh, a 30 kWh rise: 10 taken back, 20 published.
  assert.deepEqual(guardLifetimeEmit(100_000, 130_000, LIFETIME_HOLD_DIP_WH, 10_000), { emitWh: 120_000, rebaseWh: -10_000, verdict: 'returned' });
  // A rise short of the owed: all of it taken back, the last value published again.
  assert.deepEqual(guardLifetimeEmit(100_000, 160_000, LIFETIME_HOLD_DIP_WH, 100_000), { emitWh: 100_000, rebaseWh: -60_000, verdict: 'returned' });
  // Half the owed is the line.
  assert.deepEqual(guardLifetimeEmit(100_000, 149_999, LIFETIME_HOLD_DIP_WH, 100_000), { emitWh: 149_999, rebaseWh: 0, verdict: 'rise' });
  assert.deepEqual(guardLifetimeEmit(100_000, 150_000, LIFETIME_HOLD_DIP_WH, 100_000), { emitWh: 100_000, rebaseWh: -50_000, verdict: 'returned' });
  // Real energy between two reads is published as read, however much is owed.
  assert.deepEqual(guardLifetimeEmit(92_047, 94_047, LIFETIME_HOLD_DIP_WH, 91_947), { emitWh: 94_047, rebaseWh: 0, verdict: 'rise' });
  // A rise of up to the hold is never a return (owed 6 kWh: 5 kWh is a rise, 5.001 kWh a return).
  assert.deepEqual(guardLifetimeEmit(100_000, 105_000, LIFETIME_HOLD_DIP_WH, 6_000), { emitWh: 105_000, rebaseWh: 0, verdict: 'rise' });
  assert.deepEqual(guardLifetimeEmit(100_000, 105_001, LIFETIME_HOLD_DIP_WH, 6_000), { emitWh: 100_000, rebaseWh: -5_001, verdict: 'returned' });
  // Nothing owed, a negative or a non-finite owed: a rise.
  for (const owed of [0, -10_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(guardLifetimeEmit(100_000, 130_000, LIFETIME_HOLD_DIP_WH, owed), { emitWh: 130_000, rebaseWh: 0, verdict: 'rise' }, `owed ${owed}`);
  }
});

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test('property — 1,000 random walks (steps −20 kWh … +2 kWh): the emitted series never falls and HA books no reset', () => {
  const rand = rng(0xc0ffee);
  for (let walk = 0; walk < 1_000; walk++) {
    let measured = 50_000 + rand() * 1_000_000;
    let hw: number | undefined;
    let shift = 0;
    const emitted: number[] = [];
    for (let step = 0; step < 60; step++) {
      measured = Math.max(0, measured + (rand() * 22_000 - 20_000));
      const g = guardLifetimeEmit(hw, measured + shift);
      if (g.verdict === 'rebased') shift += g.rebaseWh;
      if (hw != null) assert.ok(g.emitWh >= hw, `walk ${walk} step ${step}: ${g.emitWh} after ${hw}`);
      assert.ok(g.rebaseWh >= 0);
      if (g.verdict === 'rebased') assert.ok(g.rebaseWh > LIFETIME_HOLD_DIP_WH, 'only a drop over the hold is rebased');
      hw = g.emitWh;
      emitted.push(g.emitWh);
    }
    const ha = haTotalIncreasing(emitted);
    assert.equal(ha.resets, 0, `walk ${walk}: no meter reset`);
    assert.equal(ha.dips, 0, `walk ${walk}: no negative change`);
  }
});

// A drop holds one offset for its reads (a counter reads its row or 0; the 06-08 hour read 0
// throughout) and a clean read comes between two drops. A drop that comes back in steps each under
// half of what is owed is not recognised: those steps are published (the guard's docblock).
test('property — 1,000 walks with drops that come back (offsets of 6 kWh up to the whole counter, 1–3 reads): HA books exactly the real energy, and each shift goes back to 0', () => {
  const rand = rng(0x0608);
  for (let walk = 0; walk < 1_000; walk++) {
    let real = 50_000 + rand() * 1_000_000;
    const first = real;
    let hw: number | undefined;
    let shift = 0;
    let owed = 0;
    let glitch = 0; // reads left in the current drop
    let inDrop = false; // the previous read was inside a drop
    let offset = 0;
    const emitted: number[] = [];
    for (let step = 0; step < 80; step++) {
      real += rand() * 2_000;
      if (glitch === 0 && !inDrop && step > 0 && step < 70 && rand() < 0.08) {
        glitch = 1 + Math.floor(rand() * 3);
        offset = rand() < 0.3 ? real : 6_000 + rand() * (real - 6_000); // to 0, or part of the way
      }
      const read = (glitch > 0 ? Math.max(0, real - offset) : real) + shift;
      inDrop = glitch > 0;
      if (glitch > 0) glitch--;
      const g = guardLifetimeEmit(hw, read, LIFETIME_HOLD_DIP_WH, owed);
      if (g.verdict === 'rebased' || g.verdict === 'returned') {
        shift += g.rebaseWh;
        owed = Math.max(0, owed + g.rebaseWh);
      }
      if (hw != null) assert.ok(g.emitWh >= hw, `walk ${walk} step ${step}: ${g.emitWh} after ${hw}`);
      hw = g.emitWh;
      emitted.push(g.emitWh);
    }
    // The walk ends outside a drop (none starts after step 70).
    const ha = haTotalIncreasing(emitted);
    assert.equal(ha.resets, 0, `walk ${walk}: no meter reset`);
    assert.equal(ha.dips, 0, `walk ${walk}: no negative change`);
    assert.ok(Math.abs(shift) < 1e-6 && owed < 1e-6, `walk ${walk}: shift ${shift}, owed ${owed} once every drop came back`);
    assert.ok(Math.abs(ha.sum - (emitted[emitted.length - 1] - emitted[0])) < 1e-6);
    assert.ok(Math.abs(emitted[emitted.length - 1] - real) < 1e-6, `walk ${walk}: published ${emitted[emitted.length - 1]}, real ${real} (from ${first})`);
  }
});

test('haTotalIncreasing — the helper books a reset as the whole new state, a smaller drop as a negative change', () => {
  // The membership leave before v1.193.0: 8,192 -> 4,096 (reset: 4,096 booked again), then +512.
  assert.deepEqual(haTotalIncreasing([8_192, 4_096, 4_608]), { sum: 4_608, resets: 1, phantomWh: 4_096, dips: 0, negativeWh: 0 });
  // A 100 Wh dip on a 10 kWh counter: no reset, a negative change the next rise nets out.
  assert.deepEqual(haTotalIncreasing([10_000, 9_900, 10_050]), { sum: 50, resets: 0, phantomWh: 0, dips: 1, negativeWh: 100 });
  assert.equal(haTotalIncreasing([1_000, Number.NaN, 1_200]).sum, 200, 'unknown is skipped');
});
