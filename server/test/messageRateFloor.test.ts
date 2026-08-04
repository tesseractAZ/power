import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateFloorTracker, type RateFloorConfig } from '../src/messageRateFloor.js';

/**
 * v0.92.0 — message-rate floor detector (audit finding #1). Reproduces the SHP2
 * 13 h rate-collapse that defeated both the staleness and gap detectors, and pins
 * the false-positive guards.
 *
 * v1.66.0 — extended for the diurnal rewrite. The legacy tests below pin the GLOBAL
 * fallback path (minHourSamples is set unreachably high so hour buckets never mature),
 * which is what a cold-started device uses. The new tests pin the hour-of-day path and
 * both dwell edges. Timestamps are built with `new Date(y, m, d, HOUR, ...)` — LOCAL
 * time construction — so `getHours()` returns the intended hour in any CI timezone.
 */

const CFG: RateFloorConfig = {
  minBaselineRate: 10, // msg/min
  floorFraction: 0.2, // collapse below 20% of baseline
  collapseMs: 20 * 60_000, // sustain 20 min
  recoverMs: 5 * 60_000, // sustain 5 min before clearing
  baselineAlpha: 0.5, // fast for test convergence
  baselineAlphaDown: 0.02,
  minHourSamples: 999_999, // legacy tests: force the global-baseline path
};
const MIN = 60_000;
/** Local-time timestamp for a given hour-of-day, TZ-independent. */
const at = (hour: number, minute = 0, day = 1) => new Date(2026, 0, day, hour, minute, 0, 0).getTime();

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

test('recovers (edge) once health is SUSTAINED — not on a single sample', () => {
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 10; i++) { now += MIN; count += 30; t.sample('SHP2', count, now); }
  for (let i = 0; i < 25; i++) { t.sample('SHP2', count, (now += MIN)); } // collapse + fire

  // v1.66.0: ONE healthy sample must NOT clear it (v0.92.0 cleared here — the defect).
  const first = t.sample('SHP2', (count += 30), (now += MIN));
  assert.equal(first.recovered, false, 'a single healthy sample does not clear a fired collapse');
  assert.equal(first.collapsing, true, 'still collapsing during the recovery dwell');

  // Sustained health clears it exactly once.
  let recoveries = 0;
  for (let i = 0; i < 10; i++) {
    const r = t.sample('SHP2', (count += 30), (now += MIN));
    if (r.recovered) recoveries++;
  }
  assert.equal(recoveries, 1, 'recovery is edge-triggered once health is sustained');
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

/* ------------------------------------------------------------------ v1.66.0 */

test('THE EVASION: periodic bursts no longer reset the pre-fire timer', () => {
  // Measured defect: at baseline 25 the floor is 5 msg/min, so a device emitting 5
  // messages in ONE tick every <=19 min averaged ~1% of baseline and NEVER fired,
  // because each burst reset collapseSinceMs. It must fire now.
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 10; i++) { now += MIN; count += 30; t.sample('burst', count, now); }
  let fires = 0;
  for (let i = 0; i < 60; i++) {
    // one 30-message burst every 15 min, silence otherwise → ~2 msg/min average
    const bump = i % 15 === 0 ? 30 : 0;
    const r = t.sample('burst', (count += bump), (now += MIN));
    if (r.collapsed) fires++;
  }
  assert.ok(fires >= 1, `a bursty-but-starved device must fire (fires=${fires})`);
});

/**
 * The Cores' REAL measured profile (msg/min, MST): idle 19:00-22:59 ≈ 5, busy otherwise
 * ≈ 50. Warm up on a CONTINUOUS minute-by-minute clock — sampling only a few minutes per
 * day would leave ~24 h gaps between samples, and a 24 h dt computes a ~0.03 msg/min rate
 * that reads as a collapse. Production samples every 60 s without gaps; so does this.
 */
const HOUR_PROFILE = (h: number) => (h >= 19 && h < 23 ? 5 : 50);
function warmDays(t: RateFloorTracker, days: number) {
  const start = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
  let count = 0;
  let ts = start;
  for (let m = 0; m < 1440 * days; m++) {
    ts = start + m * MIN;
    count += HOUR_PROFILE(new Date(ts).getHours());
    t.sample('core', count, ts);
  }
  return { count, ts };
}
/** Continue the clock from `ts` at a fixed rate, counting collapse edges. */
function feed(t: RateFloorTracker, s: { count: number; ts: number }, ratePerMin: number, minutes: number) {
  let fires = 0;
  for (let m = 0; m < minutes; m++) {
    s.ts += MIN;
    s.count += ratePerMin;
    if (t.sample('core', s.count, s.ts).collapsed) fires++;
  }
  return fires;
}

test('hour-of-day: a legitimate nightly idle window does NOT false-fire', () => {
  // Measured false positive: 08-03 19:24 Core 2 fired at 4.0 msg/min against a global
  // baseline of ~40 — but 19:00-22:59 is the Cores' real idle window (4.4-6.2 msg/min).
  const t = new RateFloorTracker({ ...CFG, minHourSamples: 30 });
  const s = warmDays(t, 3); // ends at 23:59 on day 3
  assert.ok(t.hourBaselineOf('core', 20) < 12, `idle hour learned low (${t.hourBaselineOf('core', 20)})`);
  assert.ok(t.hourBaselineOf('core', 9) > 30, `busy hour learned high (${t.hourBaselineOf('core', 9)})`);

  // Run day 4 up to 19:00, then sit in the idle window at its normal 5 msg/min.
  feed(t, s, 50, 19 * 60);
  const fires = feed(t, s, 5, 3 * 60);
  assert.equal(fires, 0, 'the nightly idle window must not fire');
});

test('hour-of-day: a real collapse during an ACTIVE hour still fires', () => {
  const t = new RateFloorTracker({ ...CFG, minHourSamples: 30 });
  const s = warmDays(t, 3);
  // Day 4: healthy through the night, then the fleet collapse level (3 msg/min) at 09:00.
  feed(t, s, 50, 9 * 60);
  const fires = feed(t, s, 3, 60);
  assert.equal(fires, 1, 'a collapse during an active hour fires exactly once');
});

test('the hour bucket resists a RAMP-DOWN that eroded the old global baseline', () => {
  // Measured false negative: Core baselines eroded 47 -> 32 over two days because every
  // sample in [0.2*B, B) still dragged B down. The hour bucket decays 10x slower.
  const t = new RateFloorTracker({ ...CFG, minHourSamples: 30 });
  const s = warmDays(t, 3);
  feed(t, s, 50, 9 * 60); // into day 4, 09:00
  const before = t.hourBaselineOf('core', 9);
  // A ramp DOWN that never dips under the 20% floor, so every sample counts as "healthy".
  for (const r of [40, 30, 20, 12, 11, 11, 11, 11]) feed(t, s, r, 1);
  const after = t.hourBaselineOf('core', 9);
  assert.ok(after > before * 0.9, `ramp must not walk the bucket down (${before.toFixed(1)} -> ${after.toFixed(1)})`);
});

test('eligibilityLost is signalled when a device stops being monitored', () => {
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 10; i++) { now += MIN; count += 30; t.sample('SHP2', count, now); }
  // Erode the GLOBAL baseline with samples that stay ABOVE the 20% collapse floor (so
  // they count as "healthy" and DO update it) but below the baseline — the exact band
  // the v0.92.0 header wrongly claimed could not drag the baseline down.
  let lost = 0;
  for (let i = 0; i < 40; i++) {
    const r = t.sample('SHP2', (count += 7), (now += MIN));
    if (r.eligibilityLost) lost++;
  }
  assert.equal(lost, 1, 'the un-monitored transition is signalled exactly once (edge)');
  assert.ok(t.baselineOf('SHP2') < 10, 'baseline did erode below the eligibility floor');
});

test('hydrate/toJSON round-trips learned baselines without resurrecting a collapse', () => {
  const cfg: RateFloorConfig = { ...CFG, minHourSamples: 5 };
  const a = new RateFloorTracker(cfg);
  let count = 0;
  for (let day = 1; day <= 3; day++) {
    for (let m = 0; m < 10; m++) { count += 50; a.sample('core', count, at(9, m, day)); }
  }
  const saved = JSON.parse(JSON.stringify(a.toJSON()));

  const b = new RateFloorTracker(cfg);
  b.hydrate(saved);
  assert.ok(Math.abs(b.hourBaselineOf('core', 9) - a.hourBaselineOf('core', 9)) < 1e-9, 'hour buckets survive');

  // First live sample after restart: counter re-zeroed, must not compute a rate off it.
  const first = b.sample('core', 0, at(9, 0, 5));
  assert.equal(first.rate, null, 'no rate computed from the hydrated sentinel');
  assert.equal(first.collapsing, false, 'a restart never resurrects an in-flight collapse');
});

test('hydrate tolerates corrupt/absent state (fail-open, cold start)', () => {
  const t = new RateFloorTracker(CFG);
  t.hydrate(null);
  t.hydrate(undefined);
  t.hydrate({ bad: { baseline: NaN, hourly: [1, 2], hourlyN: 'nope' } } as any);
  assert.equal(t.baselineOf('bad'), 0, 'garbage does not become a baseline');
  assert.equal(t.hourBaselineOf('bad', 3), 0, 'malformed buckets reset to zero');
});
