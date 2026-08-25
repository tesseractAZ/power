import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateFloorTracker, isFlatProfile, type RateFloorConfig } from '../src/messageRateFloor.js';

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
  peakHalfLifeMs: 7 * 86_400_000, // eligibility high-water mark: 7-day half-life
  flatCollapseMs: 4 * 60_000,   // v1.95.0 short dwell for flat-profile devices
  flatnessMaxCv: 0.15,
  flatnessMinMatureHours: 18,
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

/* ── the DISARM TRAPDOOR (2026-08-05) ──────────────────────────────────────
 *
 * Eligibility used to be read off the comparison baseline — the very quantity a
 * collapse drives down — and the guard protecting the global baseline was itself
 * gated on `baseline >= minBaselineRate`. Once the baseline fell under the floor
 * that condition could never be true again, so the guard switched off and the
 * estimator learned unguarded from the collapse, free-falling.
 *
 * Measured on the live fleet: three Cores starved at 1.6 msg/min (3-4 % of their
 * ~43-51 baselines) for 8.5 h and raised NOTHING, because the detector had
 * disarmed itself 01:02-01:06 while going quiet about it.
 */

test('A COLLAPSE CANNOT DISARM THE DETECTOR — the 2026-08-05 Core scenario', () => {
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  // Prove a healthy ~45 msg/min device.
  for (let i = 0; i < 20; i++) { now += MIN; count += 45; t.sample('core1', count, now); }
  assert.ok(t.baselineOf('core1') >= 40, 'learned a healthy baseline');

  // 8.5 h starved at 1.6 msg/min — the measured live rate.
  let firedOnce = false, everIneligible = false;
  for (let i = 0; i < 510; i++) {
    const r = t.sample('core1', (count += 1.6), (now += MIN));
    if (r.collapsed) firedOnce = true;
    if (r.eligibilityLost) everIneligible = true;
    // The mark must never fall through the floor during ANY of it.
    assert.ok(r.eligibilityPeak >= 10, `still eligible at minute ${i} (peak ${r.eligibilityPeak})`);
  }
  assert.equal(everIneligible, false, 'a collapse must NEVER cost the device its monitoring');
  assert.ok(firedOnce, 'and the collapse it was built to catch actually fires');
});

test('the global baseline does not FREE-FALL during a collapse', () => {
  // The second half of the trapdoor: with the guard gated on the eroding value,
  // the baseline chased the collapse down to ~0.9 on a device whose norm is ~30.
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 20; i++) { now += MIN; count += 30; t.sample('shp2', count, now); }
  const healthy = t.baselineOf('shp2');
  for (let i = 0; i < 300; i++) t.sample('shp2', (count += 0.2), (now += MIN));
  assert.ok(t.baselineOf('shp2') >= healthy * 0.9,
    `baseline held at ${t.baselineOf('shp2').toFixed(1)} (was ${healthy.toFixed(1)}), not dragged to the collapse`);
});

test('eligibility IS still lost when a device is GENUINELY quiet for days', () => {
  // The mark must not be a one-way latch: a device truly reconfigured to be
  // quiet has to age out, or the detector would nag about it forever.
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 20; i++) { now += MIN; count += 30; t.sample('quiet', count, now); }
  let lost = 0;
  for (let h = 0; h < 24 * 14; h++) {
    const r = t.sample('quiet', (count += 7 * 60), (now += 60 * MIN)); // 7 msg/min, hourly samples
    if (r.eligibilityLost) lost++;
  }
  assert.equal(lost, 1, 'the un-monitored transition is still signalled exactly once (edge)');
});

test('the eligibility mark decays on a multi-DAY half-life, not a multi-minute one', () => {
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 20; i++) { now += MIN; count += 40; t.sample('d', count, now); }
  // One 7-day half-life of total silence: the mark should halve, not vanish.
  const r = t.sample('d', count, (now += 7 * 24 * 60 * MIN));
  assert.ok(r.eligibilityPeak > 18 && r.eligibilityPeak < 22,
    `one half-life halves the mark (got ${r.eligibilityPeak.toFixed(1)} from ~40)`);
});

test('hydrate SEEDS the mark from pre-upgrade files (no fleet-wide blind spot on deploy)', () => {
  // Files written before the mark existed carry no `peak`. Defaulting it to 0
  // would leave every device ineligible until it re-proved itself — a silent
  // fleet-wide outage of the detector, caused by shipping its own fix.
  const t = new RateFloorTracker(CFG);
  t.hydrate({ shp2: { baseline: 31, hourly: new Array(24).fill(28), hourlyN: new Array(24).fill(50) } });
  let now = 1_000_000, count = 0;
  t.sample('shp2', count, now); // adopt the counter
  const r = t.sample('shp2', (count += 30), (now += MIN));
  assert.ok(r.eligibilityPeak >= 28, `seeded from learned state, got ${r.eligibilityPeak}`);
  assert.equal(r.eligibilityLost, false, 'an upgrade must not disarm a healthy device');
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

/* ─── v1.73.0 — the FALSE "recovered" latch (the 08-04 19:35 incident) ────── */

test('THE 19:35 INCIDENT: a poisoned hour bucket must not clear the latch as "recovered"', () => {
  // How the false all-clear actually happened: the collapse spanned an hour whose
  // bucket was immature. The bucket learned the STARVED rate, matured low, and the
  // comparison threshold collapsed underneath the alarm — isCollapsed went false
  // with the device still 95 % starved, and v1.66.0 routed that through the
  // recovery branch: "message rate recovered (2.0 msg/min)" on a ~40 msg/min Core.
  const cfg: RateFloorConfig = { ...CFG, minHourSamples: 3 }; // buckets mature fast
  const t = new RateFloorTracker(cfg);
  let now = at(18, 0);
  let count = 0;
  // Healthy hour 18: baseline + peak learn ~40.
  for (let i = 0; i < 10; i++) { now += MIN; count += 40; t.sample('Core 1', count, now); }

  // Hour 19 (immature bucket): collapse to ~2 msg/min for 70 minutes.
  now = at(19, 0);
  let sawRecovered = false;
  let fired = false;
  for (let i = 0; i < 70; i++) {
    const r = t.sample('Core 1', (count += 2), (now += MIN));
    if (r.collapsed) fired = true;
    if (r.recovered) sawRecovered = true;
    if (fired) assert.equal(r.collapsing, true, `latch must hold at minute ${i} (rate ~2 vs healthy ~40)`);
  }
  assert.equal(fired, true, 'the collapse fires');
  assert.equal(sawRecovered, false, '★ NO false "recovered" while starved — the 19:35 bug');

  // Real traffic returns → genuine recovery, once, after the dwell.
  let recoveredAt = -1;
  for (let i = 0; i < 10; i++) {
    const r = t.sample('Core 1', (count += 40), (now += MIN));
    if (r.recovered) { recoveredAt = i; break; }
  }
  assert.ok(recoveredAt >= 4, `recovers only after the dwell (${recoveredAt})`);
});

test('a rate below the eligibility floor is NEVER a recovery, whatever the baseline says', () => {
  // If a device could not qualify for monitoring at this rate, it has not
  // recovered at it either. 9 msg/min on a ~30 msg/min device stays latched even
  // though it beats floorFraction × baseline.
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 10; i++) { now += MIN; count += 30; t.sample('SHP2', count, now); }
  for (let i = 0; i < 25; i++) t.sample('SHP2', (count += 0), (now += MIN)); // full collapse, fires
  for (let i = 0; i < 30; i++) {
    const r = t.sample('SHP2', (count += 9), (now += MIN)); // 9 < minBaselineRate 10
    assert.equal(r.recovered, false, `9 msg/min must not clear the latch (minute ${i})`);
    assert.equal(r.collapsing, true);
  }
  // 12 msg/min IS an absolutely healthy rate → dwelled genuine recovery.
  let recovered = false;
  for (let i = 0; i < 10; i++) recovered ||= t.sample('SHP2', (count += 12), (now += MIN)).recovered;
  assert.equal(recovered, true);
});

test('one healthy burst does not clear the latch — the recovery dwell survives the rewrite', () => {
  const t = new RateFloorTracker(CFG);
  let now = 0, count = 0;
  for (let i = 0; i < 10; i++) { now += MIN; count += 30; t.sample('SHP2', count, now); }
  for (let i = 0; i < 25; i++) t.sample('SHP2', (count += 0), (now += MIN));
  // Single healthy sample (the 08-04 05:06 burst shape)...
  assert.equal(t.sample('SHP2', (count += 30), (now += MIN)).recovered, false, 'burst alone is not recovery');
  // ...then starved again: the dwell clock must reset, not carry.
  for (let i = 0; i < 20; i++) {
    const r = t.sample('SHP2', (count += 1), (now += MIN));
    assert.equal(r.recovered, false);
    assert.equal(r.collapsing, true, 'still latched after the burst');
  }
});

test('a baseline ALREADY under the floor: the guard holds and the collapse still fires', () => {
  // The trapdoor\'s worst case: baseline 8 (under minBaselineRate 10) but the
  // device has PROVEN ~40. The old guard (`prev.baseline >= minBaselineRate`)
  // could never engage here, so learning ran unguarded and the baseline chased
  // the collapse to ~1 — and eligibility read off the baseline meant the
  // collapse could never fire at all. With peak-carried eligibility both hold.
  const t = new RateFloorTracker(CFG);
  t.hydrate({ core: { baseline: 8, hourly: new Array(24).fill(0), hourlyN: new Array(24).fill(0), peak: 40 } });
  let now = 1_000_000, count = 0;
  t.sample('core', count, now); // adopt the counter
  let fired = false;
  for (let i = 0; i < 30; i++) fired ||= t.sample('core', (count += 1), (now += MIN)).collapsed;
  assert.equal(fired, true, 'peak carries eligibility — the collapse fires even at baseline 8');
  assert.ok(t.baselineOf('core') >= 7.5, `guard held the baseline at ${t.baselineOf('core').toFixed(1)}, no free-fall`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * v1.95.0 — FLAT-PROFILE devices fire on a short dwell.
 *
 * MOTIVATING INCIDENT (2026-08-21 13:0x MST). The SHP2 — the single-point-
 * critical alarm data source — delivered 2 messages in 600 s (0.20 msg/min
 * against a 30.2 norm, a 150x collapse) and NOTHING fired. It fell between both
 * detectors: shorter than the 20-min collapse dwell, and never silent long
 * enough for the 180 s staleness alarm. Four more instances in the preceding
 * four days, one with the last message 319 s old.
 *
 * The 20-min dwell exists ONLY to separate legitimate Core idle (4.4 msg/min)
 * from a real collapse (2.1-2.9) — a 1.5x discrimination problem created by the
 * Cores' 13x diurnal swing. A device whose own profile is flat has no such
 * problem, so it earns the short dwell from its OWN measured history.
 * ═══════════════════════════════════════════════════════════════════════ */

test('isFlatProfile — a flat device qualifies; a diurnal one never does', () => {
  const flat = new Array(24).fill(30).map((v, h) => v + (h % 3) * 0.5); // cv ~0.02
  const mature = new Array(24).fill(50);
  assert.equal(isFlatProfile(flat, mature, 30, 0.15, 18), true, 'SHP2-like flat profile');

  const diurnal = [32, 33, 34, 30, 28, 20, 12, 10, 47, 50, 55, 58, 60, 60, 58, 55, 52, 50, 6, 5, 4.6, 5, 30, 32];
  assert.equal(isFlatProfile(diurnal, mature, 30, 0.15, 18), false, 'Core-like 13x swing');
});

test('isFlatProfile — flatness must be EARNED: thin evidence never qualifies', () => {
  const flat = new Array(24).fill(30);
  const immature = new Array(24).fill(5);            // below minHourSamples
  assert.equal(isFlatProfile(flat, immature, 30, 0.15, 18), false, 'no mature buckets');

  const fewMature = new Array(24).fill(0).map((_, h) => (h < 10 ? 50 : 0)); // only 10 mature
  assert.equal(isFlatProfile(flat, fewMature, 30, 0.15, 18), false, 'fewer than minMatureHours');
});

test('isFlatProfile — a zeroed profile is not "flat" (guards against div-by-zero)', () => {
  assert.equal(isFlatProfile(new Array(24).fill(0), new Array(24).fill(50), 30, 0.15, 18), false);
});

test('rate floor — a FLAT device fires on the short dwell (the SHP2 blind spot)', () => {
  const t = new RateFloorTracker({ ...CFG, minHourSamples: 1, flatnessMinMatureHours: 2 });
  const SN = 'HD31ZASAHH120432';
  const base = new Date(2026, 7, 21, 6, 0, 0).getTime();
  const MIN = 60_000;
  // Learn a flat ~30 msg/min profile across enough hours to mature the buckets.
  let count = 0, ts = base;
  for (let i = 0; i < 240; i++) { count += 30; ts += MIN; t.sample(SN, count, ts); }

  // Collapse to ~0.2 msg/min. At 5 min it must have fired (short dwell = 4 min),
  // where the legacy 20-min dwell would still have been silent.
  let fired = false;
  for (let m = 1; m <= 5; m++) { ts += MIN; count += 0; const r = t.sample(SN, count, ts); if (r.collapsed) fired = true; }
  assert.equal(fired, true, 'flat-profile device fires within ~5 min, not 20');
});

test('rate floor — a DIURNAL device still gets the long dwell (no new false positives)', () => {
  const t = new RateFloorTracker({ ...CFG, minHourSamples: 1, flatnessMinMatureHours: 2 });
  const SN = 'Y711ZAB59GBC0314';
  const MIN = 60_000;
  // Teach a swinging profile: alternating fast/slow hours -> cv well above 0.15.
  let count = 0, ts = new Date(2026, 7, 21, 0, 0, 0).getTime();
  for (let h = 0; h < 10; h++) {
    const rate = h % 2 === 0 ? 60 : 12;
    for (let i = 0; i < 60; i++) { count += rate; ts += MIN; t.sample(SN, count, ts); }
  }
  // Now collapse. At 5 min it must NOT have fired — the long dwell still applies.
  let firedEarly = false;
  for (let m = 1; m <= 5; m++) { ts += MIN; const r = t.sample(SN, count, ts); if (r.collapsed) firedEarly = true; }
  assert.equal(firedEarly, false, 'diurnal device keeps the 20-min dwell');
});

// ── v1.108.0: the electrical-idleness surface gate ───────────────────────────
import { isElectricallyIdle, IDLE_SURFACE_SUPPRESS_W } from '../src/messageRateFloor.js';

test('isElectricallyIdle: idle spare (xxCore 3 parked at cap) is idle', () => {
  assert.equal(isElectricallyIdle(0, 0), true);
  assert.equal(isElectricallyIdle(5, 10), true);
});

test('isElectricallyIdle: real power in EITHER direction defeats idleness', () => {
  assert.equal(isElectricallyIdle(1770, 0), false, 'charging burst');
  assert.equal(isElectricallyIdle(0, 250), false, 'discharging (islanded night) stays monitored');
  assert.equal(isElectricallyIdle(-40, 0), false, 'sign must not hide magnitude');
});

test('isElectricallyIdle: missing telemetry fails toward MONITORED, never muted', () => {
  assert.equal(isElectricallyIdle(null, 0), false);
  assert.equal(isElectricallyIdle(0, undefined), false);
  assert.equal(isElectricallyIdle(null, null), false, 'the SHP2 shape (no watt fields) stays monitored');
});

test('isElectricallyIdle: threshold is a sum, just under/over the line', () => {
  assert.equal(isElectricallyIdle(14, 15), true,  `sum 29 < ${IDLE_SURFACE_SUPPRESS_W}`);
  assert.equal(isElectricallyIdle(15, 15), false, `sum 30 >= ${IDLE_SURFACE_SUPPRESS_W}`);
});
