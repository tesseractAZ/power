import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateFloorTracker, type RateFloorConfig } from '../src/messageRateFloor.js';

/**
 * v0.92.0 — message-rate floor detector (audit finding #1). Reproduces the SHP2
 * 13 h rate-collapse that defeated both the staleness and gap detectors, and pins
 * the false-positive guards.
 */

const CFG: RateFloorConfig = {
  minBaselineRate: 10, // msg/min
  floorFraction: 0.2, // collapse below 20% of baseline
  collapseMs: 20 * 60_000, // sustain 20 min
  baselineAlpha: 0.5, // fast for test convergence
};
const MIN = 60_000;

test('learns a baseline from healthy samples then fires on a sustained collapse', () => {
  const t = new RateFloorTracker(CFG);
  let now = 0;
  let count = 0;
  // 10 healthy minutes at ~30 msg/min → baseline converges to ~30.
  for (let i = 0; i < 10; i++) { now += MIN; count += 30; t.sample('SHP2', count, now); }
  assert.ok(t.baselineOf('SHP2') > 25, `baseline learned (${t.baselineOf('SHP2')})`);

  // Collapse to ~0.24 msg/min. Under collapseMs → not yet fired.
  const early = t.sample('SHP2', (count += 1), (now += MIN));
  assert.equal(early.collapsed, false, 'no fire before the sustain window');
  assert.equal(early.collapsing, false);

  // Keep crawling past the 20-min sustain window → fires exactly once (edge).
  let fires = 0;
  for (let i = 0; i < 25; i++) { const r = t.sample('SHP2', (count += 0), (now += MIN)); if (r.collapsed) fires++; }
  assert.equal(fires, 1, 'edge-triggered: fires exactly once');

  // Baseline was NOT dragged down by the collapse (still ~30, not ~0).
  assert.ok(t.baselineOf('SHP2') > 25, 'collapse does not erode the baseline');
});

test('recovers (edge) when the rate returns to normal', () => {
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 10; i++) { now += MIN; count += 30; t.sample('SHP2', count, now); }
  for (let i = 0; i < 25; i++) { t.sample('SHP2', count, (now += MIN)); } // collapse + fire
  const back = t.sample('SHP2', (count += 30), (now += MIN)); // healthy again
  assert.equal(back.recovered, true, 'recovery is signalled on return to health');
  assert.equal(back.collapsing, false);
});

test('a normally-quiet device (baseline < minBaselineRate) never fires', () => {
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  // ~2 msg/min sustained — below the 10 msg/min eligibility floor.
  for (let i = 0; i < 10; i++) { now += MIN; count += 2; t.sample('quiet', count, now); }
  let fires = 0;
  for (let i = 0; i < 30; i++) { const r = t.sample('quiet', count, (now += MIN)); if (r.collapsed) fires++; } // goes silent
  assert.equal(fires, 0, 'quiet devices are not eligible for a rate floor');
});

test('a counter reset (process restart) re-baselines instead of firing a spurious collapse', () => {
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 10; i++) { now += MIN; count += 30; t.sample('SHP2', count, now); }
  // Counter resets to a small value (restart re-zeroes mqttMsgCountBySn).
  const r = t.sample('SHP2', 5, (now += MIN));
  assert.equal(r.collapsed, false, 'a counter reset must not read as a collapse');
  assert.equal(r.rate, null, 'no rate computed across a reset');
});
