/**
 * v1.187.20 — the charge-curve report has its own request budget on the main thread.
 *
 * Log 2026-10-10..12: "analytics: 'report:chargeCurve' timed out — retrying once" after every start
 * (7 of 7). Its cold build (200 days × 3 metrics × every pack) takes ~32 s on 24 packs with the worker
 * otherwise idle, longer beside the boot warm pass, and the client's single 30 s budget logged each
 * first build as a timeout, though the retry only joined the same scan (v1.186.0). chargeCurve now gets
 * 90 s per attempt (analyticsClient.ts REPORT_TIMEOUT_OVERRIDES_MS); every other report keeps 30 s.
 * Timers are mocked: the budgets below are the production ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FleetSnapshot } from '../src/snapshot.js';
import { createAnalyticsClient, reportTimeoutMs, REPORT_TIMEOUT_OVERRIDES_MS } from '../src/analyticsClient.js';

class FakeWorker extends EventEmitter {
  posted: any[] = [];
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { return Promise.resolve(0); }
  reports(name: string) { return this.posted.filter((m) => m.kind === 'report' && m.name === name); }
  answer(id: number, result: unknown) { this.emit('message', { kind: 'result', id, ok: true, result }); }
}
const withDevices = (): FleetSnapshot => ({ generatedAt: 1, devices: { CORE1: { sn: 'CORE1', projection: { kind: 'dpu' } } as never } });
/** A macrotask turn (setImmediate is not mocked): the request is posted after a microtask chain. */
const turn = () => new Promise<void>((r) => setImmediate(r));

test('the budgets: chargeCurve 90 s per attempt, every other report the 30 s default', () => {
  assert.equal(reportTimeoutMs('chargeCurve'), 90_000);
  assert.equal(reportTimeoutMs('degradation'), 30_000);
  assert.equal(reportTimeoutMs('forecast'), 30_000, 'the alarm path keeps its budget');
  assert.equal(reportTimeoutMs('constructor'), 30_000, 'a prototype key is not an override');
  assert.deepEqual(Object.keys(REPORT_TIMEOUT_OVERRIDES_MS), ['chargeCurve']);
});

test('★★★ a cold chargeCurve build that answers after 36.9 s settles inside its budget: no timeout logged, no retry posted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fw = new FakeWorker();
  const logs: string[] = [];
  const c = createAnalyticsClient('unused.db', (m) => logs.push(m), { spawnWorker: () => fw });
  try {
    c.pushSnapshot(withDevices());
    const p = c.report('chargeCurve');
    p.catch(() => {}); // asserted below; stop() must not leave an unhandled rejection if an assertion fails first
    const control = c.report('degradation'); // the default budget, asked at the same instant
    control.catch(() => {});
    await turn();
    assert.equal(fw.reports('chargeCurve').length, 1);
    assert.equal(fw.reports('degradation').length, 1);
    t.mock.timers.tick(36_874); // 2026-10-12 10:10:16 '/api/charge-curve 200 36874 ms'
    await turn();
    assert.ok(logs.some((l) => l.includes("'report:degradation' timed out — retrying once")), 'the control: 30 s still applies elsewhere');
    assert.ok(!logs.some((l) => l.includes('chargeCurve')), `nothing logged for chargeCurve: ${logs.join(' | ')}`);
    assert.equal(fw.reports('chargeCurve').length, 1, 'no retry posted');
    fw.answer(fw.reports('chargeCurve')[0].id, { generatedAt: 1, packs: [] });
    assert.deepEqual(await p, { generatedAt: 1, packs: [] });
  } finally {
    c.stop();
  }
});

test('★★ the budget is still a bound, and the retry gets the same 90 s: an unanswered chargeCurve times out at 90 s, retries once, then rejects at 180 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fw = new FakeWorker();
  const logs: string[] = [];
  const c = createAnalyticsClient('unused.db', (m) => logs.push(m), { spawnWorker: () => fw });
  try {
    c.pushSnapshot(withDevices());
    const p = c.report('chargeCurve');
    let rejected: Error | null = null;
    p.catch((e) => { rejected = e; });
    await turn();
    t.mock.timers.tick(89_999);
    await turn();
    assert.equal(logs.length, 0);
    t.mock.timers.tick(1);
    await turn();
    assert.ok(logs.some((l) => l.includes("'report:chargeCurve' timed out — retrying once")));
    assert.equal(fw.reports('chargeCurve').length, 2, 'the retry, joining the worker\'s running scan');
    // The retry's own budget is 90 s too, not the 30 s default: a cold build that finishes between
    // 120 s and 180 s after the request (beside the boot warm pass) is still answered.
    t.mock.timers.tick(89_999);
    await turn();
    assert.equal(rejected, null, 'the retry is still pending 1 ms before its own 90 s budget');
    t.mock.timers.tick(1);
    await turn();
    assert.match(String(rejected), /analytics request 'report:chargeCurve' timed out/);
    assert.equal(fw.reports('chargeCurve').length, 2, 'one retry only');
  } finally {
    c.stop();
  }
});

test('★★ a cold chargeCurve build that answers at 150 s (past a 30 s retry budget, inside 90 s) still settles the caller', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fw = new FakeWorker();
  const logs: string[] = [];
  const c = createAnalyticsClient('unused.db', (m) => logs.push(m), { spawnWorker: () => fw });
  try {
    c.pushSnapshot(withDevices());
    const p = c.report('chargeCurve');
    let rejected: Error | null = null;
    p.catch((e) => { rejected = e; });
    await turn();
    t.mock.timers.tick(90_000);
    await turn();
    assert.equal(fw.reports('chargeCurve').length, 2, 'the retry is posted at 90 s');
    t.mock.timers.tick(60_000); // 150 s after the request: a 30 s retry budget would have rejected at 120 s
    await turn();
    assert.equal(rejected, null, 'still pending at 150 s');
    // The worker's single-flight answers both attempts with the one scan; the first answer settles the caller.
    fw.answer(fw.reports('chargeCurve')[0].id, { generatedAt: 2, packs: [] });
    assert.deepEqual(await p, { generatedAt: 2, packs: [] });
    assert.equal(logs.filter((l) => l.includes('chargeCurve')).length, 1, `only the one retry line: ${logs.join(' | ')}`);
  } finally {
    c.stop();
  }
});
