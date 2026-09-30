/**
 * v1.187.0 — an alert feed logs a carry only when it is worth a line.
 *
 * The 09-28/29 add-on log held 1260 alert-feed lines out of 2011: 630 "still running after its
 * 2500 ms budget — carrying its last good value (22 s old)" / "fresh again after 1 pass(es)"
 * pairs, one per worker recompute of forecastAlerts, baselineAlerts, curtailmentAlerts and
 * forecast. A one-pass carry is the worker's normal compute time. What must still be logged:
 * a failed read (at once), a carry that outlives a second tick, and — loudly, once — a stuck
 * feed. The live state stays countable in status().
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLastGoodFeed, ALERT_FEED_CARRY_LOG_PASSES, ALERT_FEED_STUCK_WARN_PASSES } from '../src/alertMonitor.js';

// A read whose only pending timer is its unref'd budget would otherwise be cancelled.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const BUDGET = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A worker whose next answer is released by hand (a recompute that outlives the budget). */
function slowWorker() {
  let release: ((v: number) => void) | null = null;
  let n = 0;
  return {
    start: () => new Promise<number>((r) => { release = r; }),
    land: async () => { release?.(++n); release = null; await sleep(1); },
  };
}

function feed() {
  const logs: string[] = [];
  const warns: string[] = [];
  const f = createLastGoodFeed<number>('baselineAlerts', (m) => logs.push(m), undefined, undefined, (m) => warns.push(m));
  return { f, logs, warns };
}

test('★★★ the 09-28 shape: 50 one-pass budget carries log NOTHING, and are still counted', async () => {
  const { f, logs, warns } = feed();
  await f.read(async () => 0, 50); // first delivery
  const w = slowWorker();
  for (let i = 0; i < 50; i++) {
    const carried = await f.read(w.start, BUDGET); // the recompute misses this tick's budget…
    assert.equal(carried.fresh, false);
    assert.equal(carried.value != null, true, '…and the last good value is carried, as before');
    await w.land();                                // …and lands before the next tick
    const fresh = await f.read(async () => -1, BUDGET);
    assert.equal(fresh.fresh, true);
  }
  assert.deepEqual(logs.filter((l) => /carrying|fresh again/.test(l)), [], 'no routine carry/fresh pairs');
  assert.deepEqual(warns, []);
  assert.equal(f.status().carryEpisodes, 50, 'every carry is still countable at /api/notify/status');
  assert.equal(f.status().carrying, false);
});

test('★★★ a carry reaching its second consecutive pass is logged once, and its end is logged', async () => {
  const { f, logs } = feed();
  await f.read(async () => 0, 50);
  const w = slowWorker();
  await f.read(w.start, BUDGET);
  assert.equal(logs.filter((l) => /carrying its last good value/.test(l)).length, 0, 'pass 1: nothing yet');
  await f.read(w.start, BUDGET); // the same request, still running
  assert.equal(ALERT_FEED_CARRY_LOG_PASSES, 2);
  const carryLines = logs.filter((l) => /carrying its last good value/.test(l));
  assert.equal(carryLines.length, 1, 'pass 2: logged');
  assert.match(carryLines[0], /alert-feed: baselineAlerts still running after its 5 ms budget — carrying its last good value \(\d+ s old, 2 pass\(es\)\); its alerts are held, not cleared/);
  await f.read(w.start, BUDGET);
  assert.equal(logs.filter((l) => /carrying its last good value/.test(l)).length, 1, 'once per episode, not per pass');
  await w.land();
  await f.read(async () => -1, BUDGET);
  assert.ok(logs.some((l) => l === 'alert-feed: baselineAlerts fresh again after 3 pass(es) on its last good value'));
});

test('★★★ a FAILED read is logged on its first pass — an error is never routine', async () => {
  const { f, logs } = feed();
  await f.read(async () => 0, 50);
  const r = await f.read(() => Promise.reject(new Error('analytics worker exited')), 50);
  assert.equal(r.value, 0, 'carried');
  const lines = logs.filter((l) => /carrying its last good value/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /failed — analytics worker exited — carrying its last good value .*1 pass\(es\)/);
  await f.read(async () => 1, 50);
  assert.ok(logs.some((l) => /fresh again after 1 pass\(es\)/.test(l)), 'its recovery is logged too');
});

test('★★★ a STUCK feed is a WARNING at ALERT_FEED_STUCK_WARN_PASSES, once per episode', async () => {
  const { f, logs, warns } = feed();
  await f.read(async () => 0, 50);
  const hung = () => new Promise<number>(() => {});
  for (let i = 1; i < ALERT_FEED_STUCK_WARN_PASSES; i++) await f.read(hung, 1);
  assert.deepEqual(warns, [], `not before pass ${ALERT_FEED_STUCK_WARN_PASSES}`);
  await f.read(hung, 1);
  assert.equal(warns.length, 1);
  assert.match(warns[0], new RegExp(`alert-feed: WARNING — baselineAlerts has carried its last good value for ${ALERT_FEED_STUCK_WARN_PASSES} passes`));
  assert.match(warns[0], /not being recomputed/);
  for (let i = 0; i < 5; i++) await f.read(hung, 1);
  assert.equal(warns.length, 1, 'not repeated while the episode lasts');
  assert.equal(logs.filter((l) => /carrying its last good value/.test(l)).length, 1, 'the info line was written at pass 2, once');
  assert.equal(f.status().carrying, true);
});

test('the warn sink defaults to the log sink (existing callers keep every line)', async () => {
  const logs: string[] = [];
  const f = createLastGoodFeed<number>('forecast', (m) => logs.push(m));
  await f.read(async () => 0, 50);
  const hung = () => new Promise<number>(() => {});
  for (let i = 0; i < ALERT_FEED_STUCK_WARN_PASSES; i++) await f.read(hung, 1);
  assert.ok(logs.some((l) => /alert-feed: WARNING — forecast has carried/.test(l)));
});
