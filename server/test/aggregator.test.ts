import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrateWh, startOfLocalDayMs } from '../src/aggregator.js';

/**
 * Tests for the trapezoidal kWh integrator + gap behavior. This function
 * underlies every kWh number the dashboard shows (round-trip efficiency,
 * lifetime accumulator, per-circuit history, dispatch planner). A bug
 * here corrupts ALL of those, so the coverage here is deliberately
 * thorough.
 *
 * Note: integrateWh has a `maxGapMs` parameter (default 10 min) — pairs
 * of samples spaced wider than that are NOT integrated (the function
 * refuses to extrapolate over an unknown period). Tests use samples
 * spaced 5 min apart unless they're specifically exercising gap behavior.
 */

const FIVE_MIN = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;

/** Evenly-spaced samples between [t0, t1] at `step` ms, with optional value(ts) function. */
function evenSamples(t0: number, t1: number, step: number, value: number | ((ts: number) => number)) {
  const fn = typeof value === 'function' ? value : () => value;
  const out: Array<{ ts: number; value: number }> = [];
  for (let t = t0; t <= t1; t += step) out.push({ ts: t, value: fn(t) });
  return out;
}

test('integrateWh — empty input returns zero Wh with full gap', () => {
  const r = integrateWh([], 0, ONE_HOUR);
  assert.equal(r.wh, 0);
  assert.equal(r.coverageMs, 0);
  assert.equal(r.gapMs, ONE_HOUR);
  assert.equal(r.samples, 0);
});

test('integrateWh — constant 1000 W over 1 hour = 1000 Wh', () => {
  const r = integrateWh(evenSamples(0, ONE_HOUR, FIVE_MIN, 1000), 0, ONE_HOUR);
  assert.equal(Math.round(r.wh), 1000);
  assert.equal(r.coverageMs, ONE_HOUR);
});

test('integrateWh — trapezoidal: linear ramp 0→2000 W over 1 hour ≈ 1000 Wh', () => {
  const r = integrateWh(
    evenSamples(0, ONE_HOUR, FIVE_MIN, (ts) => (ts / ONE_HOUR) * 2000),
    0,
    ONE_HOUR,
  );
  // Trapezoidal area under a linear ramp from 0 to 2000W over 1h = 1000 Wh.
  assert.equal(Math.round(r.wh), 1000);
});

test('integrateWh — gap larger than maxGapMs (default 10 min) is NOT integrated', () => {
  // Two samples 30 minutes apart at 1000 W. The single trapezoid spans
  // 30 min > 10-min maxGap, so the function refuses to integrate it.
  const r = integrateWh(
    [
      { ts: 0, value: 1000 },
      { ts: 30 * 60_000, value: 1000 },
    ],
    0,
    30 * 60_000,
  );
  assert.equal(r.wh, 0);
  assert.equal(r.coverageMs, 0);
});

test('integrateWh — leading anchor extends value into window when within maxGapMs', () => {
  // Anchor sample 5 min before window (within default 10-min maxGap), then
  // closely-spaced samples inside the window at constant 500 W. The anchor
  // should hold the value to window-start so the leading bucket integrates.
  const points = [
    { ts: -FIVE_MIN, value: 500 },
    ...evenSamples(0, ONE_HOUR, FIVE_MIN, 500),
  ];
  const r = integrateWh(points, 0, ONE_HOUR);
  // 500 W constant for 1 hour = 500 Wh
  assert.equal(Math.round(r.wh), 500);
  assert.equal(r.coverageMs, ONE_HOUR);
});

test('integrateWh — coverage reflects partial-window samples', () => {
  // Closely-spaced samples covering only the middle 20 min of a 60-min
  // window. Should integrate ~200 Wh (600 W × 20 min) with coverage
  // ~ 30 min (20 min spanned by samples + ~10 min held to window-end if
  // tail is within maxGap... actually 60 - 40 = 20 min > 10 min, so no
  // tail extension; coverage should be ~ 20 min).
  const r = integrateWh(
    evenSamples(20 * 60_000, 40 * 60_000, FIVE_MIN, 600),
    0,
    ONE_HOUR,
  );
  // 600W × (20min/60min) of the hour = 200 Wh
  assert.equal(Math.round(r.wh), 200);
  // Coverage = the 20-min span; no leading anchor, no trailing extend (20min
  // gap to untilMs is over maxGap).
  assert.equal(r.coverageMs, 20 * 60_000);
  assert.equal(r.gapMs, ONE_HOUR - 20 * 60_000);
});

test('integrateWh — trailing sample extends to window end when within maxGapMs', () => {
  // Samples cover only the first ~30 min, last sample is 5 min before
  // window end — within maxGap, so value should be held to window-end.
  const points = evenSamples(0, ONE_HOUR - FIVE_MIN, FIVE_MIN, 1000);
  const r = integrateWh(points, 0, ONE_HOUR);
  // 1000 W constant for the full hour (held to end) = 1000 Wh
  assert.equal(Math.round(r.wh), 1000);
});

test('startOfLocalDayMs — returns midnight of the local day', () => {
  const ms = startOfLocalDayMs();
  const d = new Date(ms);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
});

test('startOfLocalDayMs(specific date) — operates on supplied date, not now', () => {
  const input = new Date(2026, 4, 15, 14, 32, 17); // May 15 2026, 2:32:17 PM local
  const ms = startOfLocalDayMs(input);
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 4); // May
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 0);
});
