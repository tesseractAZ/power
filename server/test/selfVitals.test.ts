import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {
  assessVitals, ingestLagProbe, tickAssess, liveVitals, currentAssessment,
  degradedMode, startVitals, _resetVitalsForTest,
  VITALS_LAG_WARN_MS, VITALS_LAG_CRIT_MS, VITALS_MEM_WARN_MB, VITALS_MEM_CRIT_MB,
  VITALS_DISK_WARN_MB, VITALS_DISK_CRIT_MB, VITALS_LOAD_WARN, VITALS_LOAD_CRIT,
  VITALS_MAX_AGE_MS,
  type VitalsSample, type VitalsAssessment,
} from '../src/selfVitals.js';

/* v1.43.0 — self-vitals: co-tenant host-pressure detection. Pure per-dimension
 * rise/clear hysteresis, null-honest external readers, lag EMA + windowed max,
 * and the degradedMode() shed signal. Tests drive everything deterministically
 * through the injectable lag hook and reader overrides — no timers. */

const S = (over: Partial<VitalsSample>): VitalsSample => ({
  evLoopLagMs: 0, evLoopLagMaxMs: 0, load1: null, load5: null,
  memAvailableMb: null, dataDiskFreeMb: null, ts: 0, ...over,
});
const NULL_READERS = {
  load: () => null, memAvailableMb: () => null, dataDiskFreeMb: () => null,
};

test('hysteresis lag — immediate escalate, de-escalate only below 0.8×threshold', () => {
  let a: VitalsAssessment | null = null;
  a = assessVitals(S({ evLoopLagMs: 150 }), a); assert.equal(a.lag, 'ok');
  a = assessVitals(S({ evLoopLagMs: 250 }), a); assert.equal(a.lag, 'warn');
  // back under the line but above 0.8×200=160 ⇒ warn HOLDS (no churn)
  a = assessVitals(S({ evLoopLagMs: 170 }), a); assert.equal(a.lag, 'warn');
  a = assessVitals(S({ evLoopLagMs: 159 }), a); assert.equal(a.lag, 'ok');
  a = assessVitals(S({ evLoopLagMs: 1200 }), a); assert.equal(a.lag, 'crit');
  a = assessVitals(S({ evLoopLagMs: 900 }), a); assert.equal(a.lag, 'crit', 'crit holds ≥ 0.8×1000');
  // clears crit margin ⇒ steps DOWN through warn, not straight to ok
  a = assessVitals(S({ evLoopLagMs: 799 }), a); assert.equal(a.lag, 'warn');
  a = assessVitals(S({ evLoopLagMs: 150 }), a); assert.equal(a.lag, 'ok');
});

test('hysteresis mem — fires below threshold, clears only above 1.15×threshold', () => {
  let a: VitalsAssessment | null = null;
  a = assessVitals(S({ memAvailableMb: 800 }), a); assert.equal(a.mem, 'ok');
  a = assessVitals(S({ memAvailableMb: 600 }), a); assert.equal(a.mem, 'warn');
  // recovered past 700 but not past 1.15×700=805 ⇒ warn HOLDS
  a = assessVitals(S({ memAvailableMb: 750 }), a); assert.equal(a.mem, 'warn');
  a = assessVitals(S({ memAvailableMb: 806 }), a); assert.equal(a.mem, 'ok');
  a = assessVitals(S({ memAvailableMb: 300 }), a); assert.equal(a.mem, 'crit');
  a = assessVitals(S({ memAvailableMb: 380 }), a); assert.equal(a.mem, 'crit', 'crit holds ≤ 1.15×350');
  a = assessVitals(S({ memAvailableMb: 410 }), a); assert.equal(a.mem, 'warn');
  a = assessVitals(S({ memAvailableMb: 900 }), a); assert.equal(a.mem, 'ok');
});

test('hysteresis disk — same low-is-bad banding on the data-dir free space', () => {
  let a: VitalsAssessment | null = null;
  a = assessVitals(S({ dataDiskFreeMb: 3000 }), a); assert.equal(a.disk, 'ok');
  a = assessVitals(S({ dataDiskFreeMb: 1000 }), a); assert.equal(a.disk, 'warn');
  a = assessVitals(S({ dataDiskFreeMb: 2200 }), a); assert.equal(a.disk, 'warn', 'holds ≤ 1.15×2048');
  a = assessVitals(S({ dataDiskFreeMb: 2400 }), a); assert.equal(a.disk, 'ok');
  a = assessVitals(S({ dataDiskFreeMb: 400 }), a); assert.equal(a.disk, 'crit');
  a = assessVitals(S({ dataDiskFreeMb: 550 }), a); assert.equal(a.disk, 'crit', 'holds ≤ 1.15×512');
  a = assessVitals(S({ dataDiskFreeMb: 600 }), a); assert.equal(a.disk, 'warn');
  a = assessVitals(S({ dataDiskFreeMb: 2500 }), a); assert.equal(a.disk, 'ok');
});

test('hysteresis load — de-escalate only below threshold − 0.5', () => {
  let a: VitalsAssessment | null = null;
  a = assessVitals(S({ load1: 2 }), a); assert.equal(a.load, 'ok');
  a = assessVitals(S({ load1: 4 }), a); assert.equal(a.load, 'warn');
  a = assessVitals(S({ load1: 3.2 }), a); assert.equal(a.load, 'warn', 'holds ≥ 3.5−0.5');
  a = assessVitals(S({ load1: 2.9 }), a); assert.equal(a.load, 'ok');
  a = assessVitals(S({ load1: 7 }), a); assert.equal(a.load, 'crit');
  a = assessVitals(S({ load1: 5.6 }), a); assert.equal(a.load, 'crit', 'holds ≥ 6−0.5');
  a = assessVitals(S({ load1: 5.4 }), a); assert.equal(a.load, 'warn');
  a = assessVitals(S({ load1: 2.9 }), a); assert.equal(a.load, 'ok');
});

test('null dimensions stay ok — unreadable never raises OR holds an alert', () => {
  const a = assessVitals(S({}), null);
  assert.equal(a.level, 'ok');
  assert.deepEqual([a.lag, a.mem, a.disk, a.load], ['ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(a.reasons, []);
  // a held warn does NOT survive the gauge going dark — null over fabrication
  let b: VitalsAssessment | null = assessVitals(S({ memAvailableMb: 600 }), null);
  assert.equal(b.mem, 'warn');
  b = assessVitals(S({ memAvailableMb: null }), b);
  assert.equal(b.mem, 'ok');
  assert.equal(b.level, 'ok');
});

test('reasons carry value + threshold, and mark hysteresis-held levels', () => {
  let a = assessVitals(S({ evLoopLagMs: 640, evLoopLagMaxMs: 900, memAvailableMb: 480 }), null);
  assert.equal(a.level, 'warn');
  assert.equal(a.reasons.length, 2);
  assert.match(a.reasons[0], /event-loop lag 640 ms/);
  assert.match(a.reasons[0], new RegExp(`warn ≥ ${VITALS_LAG_WARN_MS} ms`));
  assert.match(a.reasons[0], /60s max 900 ms/);
  assert.match(a.reasons[1], /MemAvailable 480 MB/);
  assert.match(a.reasons[1], new RegExp(`warn < ${VITALS_MEM_WARN_MB} MB`));
  const c = assessVitals(S({ dataDiskFreeMb: 400 }), null);
  assert.match(c.reasons[0], new RegExp(`crit < ${VITALS_DISK_CRIT_MB} MB`));
  const l = assessVitals(S({ load1: 6.5 }), null);
  assert.match(l.reasons[0], new RegExp(`load1 6.50 \\(crit ≥ ${VITALS_LOAD_CRIT}\\)`));
  // dip inside the line while held ⇒ the reason says so
  a = assessVitals(S({ evLoopLagMs: 170 }), a);
  assert.equal(a.lag, 'warn');
  assert.match(a.reasons[0], /event-loop lag 170 ms .*\[holding\]/);
});

test('multi-dimension — level is the max across dimensions', () => {
  const a = assessVitals(S({ evLoopLagMs: 250, memAvailableMb: 300, dataDiskFreeMb: 1000 }), null);
  assert.equal(a.lag, 'warn');
  assert.equal(a.mem, 'crit');
  assert.equal(a.disk, 'warn');
  assert.equal(a.load, 'ok');
  assert.equal(a.level, 'crit');
  assert.equal(a.reasons.length, 3);
});

test('lag accumulator — EMA seeds then blends at α=0.2; windowed max expires past 60s', () => {
  _resetVitalsForTest();
  ingestLagProbe(100, 1000);   // seed: ema = 100
  ingestLagProbe(200, 1500);   // 100 + 0.2×(200−100) = 120
  ingestLagProbe(0, 2000);     // 120 + 0.2×(0−120)   = 96
  assert.ok(tickAssess(2000, NULL_READERS));
  const s = liveVitals(2000);
  assert.ok(s);
  assert.ok(Math.abs(s.evLoopLagMs - 96) < 1e-9, `ema ${s.evLoopLagMs} ≠ 96`);
  assert.equal(s.evLoopLagMaxMs, 200);
  // 61s later the 100/200 probes have aged out of the max window
  ingestLagProbe(10, 63_000);
  assert.ok(tickAssess(63_000, NULL_READERS));
  assert.equal(liveVitals(63_000)?.evLoopLagMaxMs, 10);
  _resetVitalsForTest();
});

test('degradedMode — true only while the held level is crit', () => {
  _resetVitalsForTest();
  assert.equal(tickAssess(1000, NULL_READERS), null, 'no lag probe yet ⇒ no assessment');
  assert.equal(currentAssessment(), null);
  assert.equal(degradedMode(), false);
  ingestLagProbe(1500, 1000);
  assert.equal(tickAssess(1000, NULL_READERS)?.level, 'crit');
  assert.equal(degradedMode(), true);
  // EMA decays 1500→1200→960→768 < 0.8×1000 ⇒ crit clears, steps to warn
  ingestLagProbe(0, 2000); ingestLagProbe(0, 2500); ingestLagProbe(0, 3000);
  assert.equal(tickAssess(3000, NULL_READERS)?.level, 'warn');
  assert.equal(degradedMode(), false, 'warn is not degraded mode');
  _resetVitalsForTest();
});

test('staleness — old stored sample reads null; dead lag probe refuses to assess', () => {
  _resetVitalsForTest();
  ingestLagProbe(10, 1000);
  assert.ok(tickAssess(1000, NULL_READERS));
  assert.equal(liveVitals(1000 + VITALS_MAX_AGE_MS - 1)?.evLoopLagMs, 10);
  assert.equal(liveVitals(1000 + VITALS_MAX_AGE_MS + 1), null);
  // the lag probe has been silent > 5 min ⇒ tickAssess declines (null over
  // dressing a stale accumulator up as a fresh sample)
  assert.equal(tickAssess(1000 + VITALS_MAX_AGE_MS + 1, NULL_READERS), null);
  _resetVitalsForTest();
});

test('startVitals — idempotent; real readers yield null or finite, never throw', () => {
  _resetVitalsForTest();
  startVitals(tmpdir());
  startVitals(tmpdir()); // second call is a no-op, not a second timer
  ingestLagProbe(5, 5000);
  assert.ok(tickAssess(5000)); // default (real) readers — must not throw anywhere
  const s = liveVitals(5000);
  assert.ok(s);
  assert.equal(s.evLoopLagMs, 5);
  for (const v of [s.load1, s.load5, s.memAvailableMb, s.dataDiskFreeMb]) {
    assert.ok(v === null || (Number.isFinite(v) && v >= 0), `reader value ${v}: null or finite ≥ 0`);
  }
  _resetVitalsForTest();
});

test('thresholds — defaults form sane bands (crit strictly beyond warn)', () => {
  assert.ok(VITALS_LAG_CRIT_MS > VITALS_LAG_WARN_MS);
  assert.ok(VITALS_MEM_CRIT_MB < VITALS_MEM_WARN_MB);
  assert.ok(VITALS_DISK_CRIT_MB < VITALS_DISK_WARN_MB);
  assert.ok(VITALS_LOAD_CRIT > VITALS_LOAD_WARN);
});
