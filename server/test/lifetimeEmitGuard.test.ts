import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardLifetimeEmit, LIFETIME_HOLD_DIP_WH } from '../src/recorder.js';
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

test('haTotalIncreasing — the helper books a reset as the whole new state, a smaller drop as a negative change', () => {
  // The membership leave before v1.193.0: 8,192 -> 4,096 (reset: 4,096 booked again), then +512.
  assert.deepEqual(haTotalIncreasing([8_192, 4_096, 4_608]), { sum: 4_608, resets: 1, phantomWh: 4_096, dips: 0, negativeWh: 0 });
  // A 100 Wh dip on a 10 kWh counter: no reset, a negative change the next rise nets out.
  assert.deepEqual(haTotalIncreasing([10_000, 9_900, 10_050]), { sum: 50, resets: 0, phantomWh: 0, dips: 1, negativeWh: 100 });
  assert.equal(haTotalIncreasing([1_000, Number.NaN, 1_200]).sum, 200, 'unknown is skipped');
});
