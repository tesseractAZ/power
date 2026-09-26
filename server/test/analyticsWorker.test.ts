import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AnalyticsClient } from '../src/analyticsClient.js';
import type { FleetSnapshot, SnapshotStore } from '../src/snapshot.js';
import type { ReportName } from '../src/reports.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

/**
 * v1.186.0 — the analytics worker stops pinning itself and stops holding the HA publish.
 *
 * Log review 2026-09-23/24:
 *   - 'report:degradation' timed out after 6 of 7 boots. No builder was single-flighted, so the
 *     self-warm loop, the HA publish and the client's retry after a 30 s timeout each ran their
 *     own full scan on the one worker thread (the retry a third copy, at the busiest moment).
 *   - The hourly charge-curve recompute still pinned the worker 17-19 s (v1.171.0's 60 s bucket
 *     is a SQL GROUP BY: SQLite still reads every raw row).
 *   - The warm loop awaited 22 builders back to back; for synchronous ones `await` resumes as a
 *     microtask, so queued requests (the alarm path's included) waited for the whole block.
 *   - The HA state publish awaited all nine reports with Promise.all: one slow display report
 *     withheld SoC, runway, the alarm counts and the binary sensors (two cycles lost 13:00:22).
 *   - The first evaluation and the connect-time publish reached the worker before its first
 *     snapshot, and their empty results were cached 20 s on the main thread.
 * Test ids are made up (CORE1, SHP2-P).
 */

// buildState's module graph reads these at import time (lightingPosture's state path), and the
// MQTT publisher is only constructed when enabled. Port 9 has no listener: the client never
// connects, and the test drives the payload builder directly.
const TMP = mkdtempSync(join(tmpdir(), 'analytics-worker-test-'));
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.DATA_DIR = TMP;
process.env.MQTT_DISCOVERY_ENABLED = '1';
process.env.MQTT_DISCOVERY_HOST = '127.0.0.1';
process.env.MQTT_DISCOVERY_PORT = '9';

const reports = await import('../src/reports.js');
const analytics = await import('../src/analytics.js');
const { createReadRecorder } = await import('../src/readRecorder.js');
const { createAnalyticsClient, setAnalyticsClientForTesting } = await import('../src/analyticsClient.js');
const mqttDiscovery = await import('../src/mqttDiscovery.js');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, '../src/', f), 'utf8');

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

/* ── (1) worker-side single-flight ─────────────────────────────────────────── */

test('★★★ concurrent calls for one key share ONE computation; different keys do not', async () => {
  const flights = reports.keyedSingleFlight();
  let runs = 0;
  const gate = deferred<string>();
  const fn = () => { runs++; return gate.promise; };
  const a = flights.run('degradation', fn);
  const b = flights.run('degradation', fn);
  const c = flights.run('degradation {"days":8}', () => { runs++; return 'other'; });
  gate.resolve('packs');
  assert.deepEqual(await Promise.all([a, b, c]), ['packs', 'packs', 'other']);
  assert.equal(runs, 2, 'the second degradation call joined the first');
});

test('★★ the slot frees when the flight settles — the next call computes afresh, a rejection is never cached', async () => {
  const flights = reports.keyedSingleFlight();
  let runs = 0;
  assert.equal(await flights.run('k', () => { runs++; return 1; }), 1);
  assert.equal(await flights.run('k', () => { runs++; return 2; }), 2, 'settled: not joined');
  await assert.rejects(flights.run('k', () => { runs++; throw new Error('scan failed'); }), /scan failed/);
  assert.equal(await flights.run('k', () => { runs++; return 3; }), 3, 'a (synchronous) throw freed its slot');
  assert.equal(runs, 4);
  assert.equal(flights.size(), 0);
});

test('★★ a flight older than the join bound is presumed wedged and is not joined', async () => {
  let t = 0;
  const flights = reports.keyedSingleFlight(1_000, () => t);
  const hung = flights.run('forecast', () => new Promise<string>(() => {}));
  void hung;
  t = 999;
  let fresh = 0;
  void flights.run('forecast', () => { fresh++; return 'x'; });
  assert.equal(fresh, 0, 'inside the bound: joined');
  t = 1_000;
  // Raced, so a regression that joins the hung flight fails here instead of hanging the suite.
  const v = await Promise.race([
    flights.run('forecast', () => { fresh++; return 'recomputed'; }),
    sleep(200).then(() => 'joined the hung flight'),
  ]);
  assert.equal(v, 'recomputed');
  assert.equal(fresh, 1, 'a hung flight must not silence an alarm-path report for the life of the process');
  assert.ok(reports.FLIGHT_MAX_JOIN_MS >= 60_000, 'the bound sits well above the longest builder (~20 s)');
});

test('buildFlightKey is exact: key order ignored, numbers NOT truncated, empty args = the bare name', () => {
  const k = reports.buildFlightKey;
  assert.equal(k('runway', {}), 'runway');
  assert.equal(k('totals', { sinceMs: 1, untilMs: 2 }), k('totals', { untilMs: 2, sinceMs: 1 }));
  assert.notEqual(k('carbon', { days: 7 }), k('carbon', { days: 7.5 }), 'a join must return exactly what was asked');
  assert.notEqual(k('backtest', { dpuSns: ['CORE1'] }), k('backtest', { dpuSns: ['CORE2'] }));
});

const coreDevices = {
  CORE1: {
    sn: 'CORE1', deviceName: 'Core 1', productName: 'DELTA Pro Ultra',
    projection: { kind: 'dpu', packs: [{ num: 1 }, { num: 2 }] },
  },
} as never;

test('★★★ buildReport: a request arriving while the same report computes joins it (the warm loop + a request + a retry)', async () => {
  let queries = 0;
  const recorder = makeRecorderStub({
    queryMulti: (_sn, metrics) => { queries++; return new Map(metrics.map((m) => [m, []])); },
  });
  const ctx = { recorder, snapshot: { generatedAt: 0, devices: coreDevices }, log: () => {} };
  analytics.resetChargeCurveCacheForTesting();
  await reports.buildReport('chargeCurve', ctx);
  const one = queries;
  assert.ok(one > 2, 'one computation issues several sliced queries');
  analytics.resetChargeCurveCacheForTesting();
  queries = 0;
  const [warm, request, retry] = await Promise.all([
    reports.buildReport('chargeCurve', ctx),
    reports.buildReport('chargeCurve', ctx, {}),
    reports.buildReport('chargeCurve', ctx, {}),
  ]);
  assert.equal(queries, one, 'three concurrent callers, one scan');
  assert.equal(warm, request);
  assert.equal(request, retry);
  analytics.resetChargeCurveCacheForTesting();
  await assert.rejects(reports.buildReport('no-such-report', ctx), /unknown report/);
});

/* ── (2) the warm loop yields between reports ─────────────────────────────── */

test('★★★ the warm pass lets a queued message in between two reports — not after the whole pass', async () => {
  const { port1, port2 } = new MessageChannel();
  const order: string[] = [];
  port2.on('message', (m) => order.push(`message:${m}`));
  const names = ['forecast', 'degradation', 'runway', 'clipping'] as ReportName[];
  await new Promise<void>((done, fail) => {
    // Run from a check-phase callback, as the worker's warm timer does.
    setImmediate(() => {
      reports.warmReports(
        (name) => {
          order.push(`build:${name}`);
          if (name === 'forecast') port1.postMessage('alarm-path request');
          if (name === 'runway') throw new Error('no data');
          return name; // synchronous builder: `await` alone resumes as a microtask
        },
        (name, e) => order.push(`error:${name}:${(e as Error).message}`),
        names,
      ).then(() => done(), fail);
    });
  });
  port1.close();
  port2.close();
  assert.deepEqual(order.slice(0, 3), ['build:forecast', 'message:alarm-path request', 'build:degradation']);
  assert.ok(order.includes('error:runway:no data') && order.at(-1) === 'build:clipping', 'a failing report is logged and the pass goes on');
});

test('the worker runs its warm pass through warmReports and its requests through buildReport', () => {
  const w = src('analyticsWorker.ts');
  assert.match(w, /await warmReports\(\s*\(name\) => buildReport\(name, ctx\(\)\)/);
  assert.match(w, /const result = await buildReport\(msg\.name, ctx\(\), msg\.args \?\? \{\}\);/);
  assert.doesNotMatch(w, /for \(const name of WARM_REPORTS\)/, 'the old non-yielding loop is gone');
});

/* ── (3) the charge-curve scan: sliced, yielding, identical ───────────────── */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BUCKET = 60_000;

test('★★ chargeCurveSlices: contiguous, covering, bucket-aligned week-long ranges', () => {
  const since = Date.UTC(2026, 2, 3, 7, 11, 13, 457); // deliberately off every boundary
  const until = since + 200 * DAY + 123_456;
  const s = analytics.chargeCurveSlices(since, until);
  assert.equal(s[0][0], since);
  assert.equal(s.at(-1)![1], until);
  for (let i = 0; i < s.length; i++) {
    assert.ok(s[i][0] <= s[i][1]);
    assert.ok(s[i][1] - s[i][0] < 7 * DAY, 'at most one week per query');
    if (i > 0) assert.equal(s[i][0], s[i - 1][1] + 1, 'no gap, no overlap');
    if (i > 0) assert.equal(s[i][0] % BUCKET, 0, 'every interior boundary starts a 60 s bucket');
  }
  assert.ok(s.length >= 29 && s.length <= 30);
  assert.deepEqual(analytics.chargeCurveSlices(since, until, Infinity), [[since, until]], 'Infinity = the single pre-v1.186.0 range');
});

/** A real WAL SQLite file with the production samples schema. */
function seedDb(rows: Array<[number, string, string, number]>): string {
  const path = join(TMP, `cc-${rows.length}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE samples (ts INTEGER NOT NULL, sn TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL);
    CREATE INDEX idx_samples_sn_metric_ts ON samples (sn, metric, ts);`);
  const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const r of rows) ins.run(...r);
  db.exec('COMMIT');
  db.close();
  return path;
}

const plain = (m: Map<string, Array<{ ts: number; value: number }>>) =>
  Object.fromEntries([...m].map(([k, v]) => [k, v.map((r) => ({ ts: r.ts, value: r.value }))]));

test('★★★ sliced rows are IDENTICAL to one 200-day query — dense samples across every boundary', async () => {
  const since = Date.UTC(2026, 4, 1, 3, 17, 29, 311); // unaligned
  const until = since + 45 * DAY;
  const rows: Array<[number, string, string, number]> = [];
  const metrics = ['pack1_soc', 'pack1_vol_max_mv', 'pack1_in'];
  const put = (ts: number, i: number) => {
    if (ts < since || ts > until) return;
    rows.push([ts, 'CORE1', metrics[0], 20 + (i * 7) % 80 + 0.25]);
    rows.push([ts, 'CORE1', metrics[1], 3300 + (i * 13) % 97 + 0.5]);
    rows.push([ts, 'CORE1', metrics[2], 50 + (i * 31) % 900]);
  };
  let i = 0;
  // Background: one sample every 10 min.
  for (let ts = since; ts <= until; ts += 10 * 60_000) put(ts, i++);
  // Bursts every 5 s for ±3 min around the ALIGNED slice boundaries (this code's) and around
  // since + k·week (where an unaligned slicer would cut), plus samples on both sides of each
  // aligned boundary to the millisecond.
  const week = 7 * DAY;
  for (let b = Math.ceil(since / week) * week; b <= until; b += week) {
    for (let ts = b - 180_000; ts <= b + 180_000; ts += 5_000) put(ts + 1_234, i++);
    put(b - 1, i++);
    put(b, i++);
  }
  for (let b = since + week; b <= until; b += week) {
    for (let ts = b - 180_000; ts <= b + 180_000; ts += 5_000) put(ts, i++);
  }
  const path = seedDb(rows);
  const rec = createReadRecorder(path);
  try {
    const oneShot = plain(await analytics.readChargeCurveRows(rec, 'CORE1', 1, since, until, Infinity));
    const sliced = plain(await analytics.readChargeCurveRows(rec, 'CORE1', 1, since, until));
    assert.ok(oneShot.pack1_soc.length > 1000, 'non-trivial data');
    assert.deepEqual(sliced, oneShot);
  } finally {
    rec.close();
  }
});

test('★★★ the fingerprint REPORT is identical sliced vs unsliced, on real charge cycles with drift', async () => {
  const T0 = Date.now();
  const rows: Array<[number, string, string, number]> = [];
  for (const pack of [1, 2]) {
    for (let k = 1; k <= 40; k++) {
      // Charge sessions 20 h → 14 h before each day mark: no sample near now − 14 d.
      const start = T0 - k * DAY - 20 * HOUR;
      const drift = k <= 13 ? 9 + pack : 0; // the recent fortnight charges at a higher voltage
      for (let j = 0; j * 30_000 < 6 * HOUR; j++) {
        const ts = start + j * 30_000;
        const soc = 30 + (70 * j * 30_000) / (6 * HOUR);
        if (j % 3 === 0) rows.push([ts, 'CORE1', `pack${pack}_soc`, Math.round(soc * 10) / 10]);
        if (j % 3 !== 2) rows.push([ts + 7_000, 'CORE1', `pack${pack}_vol_max_mv`, 3310 + soc * 1.9 + drift + ((j * 7919) % 13) / 10]);
        rows.push([ts + 3_000, 'CORE1', `pack${pack}_in`, 400 + ((j * 104729) % 300)]);
      }
    }
  }
  const path = seedDb(rows);
  const rec = createReadRecorder(path);
  try {
    analytics.resetChargeCurveCacheForTesting();
    const before = await analytics.computeChargeCurveFingerprint(coreDevices, rec, { sliceMs: Infinity });
    analytics.resetChargeCurveCacheForTesting();
    const after = await analytics.computeChargeCurveFingerprint(coreDevices, rec);
    analytics.resetChargeCurveCacheForTesting();
    assert.deepEqual(after.packs, before.packs);
    assert.equal(before.packs.length, 2);
    for (const p of before.packs) {
      assert.equal(p.status, 'tracking', 'baseline and recent windows both populated');
      assert.ok(p.meanDriftMv != null && p.meanDriftMv > 0, 'the drift is measured, so the equality is not vacuous');
    }
  } finally {
    rec.close();
  }
});

test('★★★ the scan yields between slices — a queued request runs before the scan ends, not after 17 s', async () => {
  let queries = 0;
  const recorder = makeRecorderStub({
    queryMulti: (_sn, metrics) => { queries++; return new Map(metrics.map((m) => [m, []])); },
  });
  analytics.resetChargeCurveCacheForTesting();
  let seenAt = -1;
  setImmediate(() => { seenAt = queries; });
  await analytics.computeChargeCurveFingerprint(coreDevices, recorder);
  analytics.resetChargeCurveCacheForTesting();
  assert.ok(queries >= 2 * 29, `two packs × ~29 week slices, got ${queries}`);
  assert.ok(seenAt >= 1 && seenAt <= 2, `the queued callback ran after ${seenAt} of ${queries} slice queries`);
});

/* ── (1b)+(5) the client: a retry joins; nothing before the first snapshot ──── */

class FakeWorker extends EventEmitter {
  posted: any[] = [];
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { return Promise.resolve(0); }
  reports() { return this.posted.filter((m) => m.kind === 'report'); }
  answer(id: number, result: unknown) { this.emit('message', { kind: 'result', id, ok: true, result }); }
}
// v1.186.0 — with a PROJECTION: the first-snapshot gate opens on a projected device, not a listed one.
const withDevices = (): FleetSnapshot => ({ generatedAt: 1, devices: { CORE1: { sn: 'CORE1', projection: { kind: 'dpu' } } as never } });
const listOnly = (): FleetSnapshot => ({ generatedAt: 1, devices: { CORE1: { sn: 'CORE1', online: true } as never } });

test('★★★ a retry after a timeout keeps the first attempt answerable — its late answer settles the caller', async () => {
  const fw = new FakeWorker();
  const logs: string[] = [];
  const c = createAnalyticsClient('unused.db', (m) => logs.push(m), { spawnWorker: () => fw, requestTimeoutMs: 150 });
  try {
    c.pushSnapshot(withDevices());
    const p = c.report('degradation');
    p.catch(() => {});
    await sleep(20);
    assert.equal(fw.reports().length, 1);
    await sleep(180); // past the first timeout
    const [first, retry] = fw.reports();
    assert.ok(retry, 'the retry was posted');
    assert.deepEqual({ name: retry.name, args: retry.args }, { name: first.name, args: first.args },
      'identical name + args, so the worker single-flight joins the running scan');
    assert.ok(logs.some((l) => l.includes("'report:degradation' timed out — retrying once")));
    fw.answer(first.id, { packs: ['from the first attempt'] });
    const v = await Promise.race([p, sleep(40).then(() => 'still waiting')]);
    assert.deepEqual(v, { packs: ['from the first attempt'] });
    fw.answer(retry.id, { packs: ['late retry'] }); // ignored, no double settle
  } finally {
    c.stop();
  }
});

test('★ the retry is still one: two unanswered attempts reject as timed out', async () => {
  const fw = new FakeWorker();
  const c = createAnalyticsClient('unused.db', () => {}, { spawnWorker: () => fw, requestTimeoutMs: 30 });
  try {
    c.pushSnapshot(withDevices());
    await assert.rejects(c.report('runway'), /analytics request 'report:runway' timed out/);
    assert.equal(fw.reports().length, 2);
  } finally {
    c.stop();
  }
});

test('★★★ no report reaches the worker before its first snapshot with devices — and the snapshot goes first', async () => {
  const fw = new FakeWorker();
  const c = createAnalyticsClient('unused.db', () => {}, { spawnWorker: () => fw, firstSnapshotWaitMs: 5_000 });
  try {
    const p = c.report('forecast');
    c.pushSnapshot({ generatedAt: 0, devices: {} }); // an empty store does not open the gate
    await sleep(30);
    assert.equal(fw.reports().length, 0, 'the boot request waits for the first poll');
    // v1.186.0 — nor does the device LIST: every device on it lacks a projection, and a report
    // computed on it is empty (and would be a feed's one-shot first delivery).
    c.pushSnapshot(listOnly());
    await sleep(30);
    assert.equal(fw.reports().length, 0, '★ a list-only snapshot does not open the gate');
    c.pushSnapshot(withDevices());
    await sleep(5);
    const kinds = fw.posted.map((m) => m.kind);
    const snapAt = fw.posted.findIndex((m) => m.kind === 'snapshot' && Object.values(m.snapshot.devices).some((d: any) => d.projection));
    assert.ok(snapAt >= 0 && snapAt < kinds.indexOf('report'), `snapshot before report: ${kinds.join(',')}`);
    fw.answer(fw.reports()[0].id, { minProjectedSoc: 40 });
    assert.deepEqual(await p, { minProjectedSoc: 40 });
  } finally {
    c.stop();
  }
});

test('★★ v1.186.0 — flushSnapshot posts the hydrated map at once, so the first reports see every projected Core', async () => {
  const fw = new FakeWorker();
  const c = createAnalyticsClient('unused.db', () => {}, { spawnWorker: () => fw, firstSnapshotWaitMs: 5_000 });
  try {
    const snap = listOnly();
    c.pushSnapshot(snap);
    c.flushSnapshot();
    assert.equal(fw.posted.filter((m) => m.kind === 'snapshot').length, 0, 'a list-only map is not flushed (nor opens the gate)');
    (snap.devices as any).CORE1.projection = { kind: 'dpu' }; // the first quota lands (in place, as the store does)
    c.pushSnapshot(snap);
    (snap.devices as any).CORE2 = { sn: 'CORE2', projection: { kind: 'dpu' } }; // the last one: hydrated
    c.pushSnapshot(snap); // throttled: not posted yet
    const before = fw.posted.filter((m) => m.kind === 'snapshot').length;
    c.flushSnapshot();
    const snaps = fw.posted.filter((m) => m.kind === 'snapshot');
    assert.equal(snaps.length, before + 1, 'posted now, not on the next 750 ms tick');
    assert.equal(Object.keys(snaps.at(-1)!.snapshot.devices).length, 2, 'with both Cores');
    const p = c.report('forecastAlerts');
    await sleep(5);
    const kinds = fw.posted.map((m) => m.kind);
    assert.ok(kinds.lastIndexOf('snapshot') < kinds.indexOf('report'), 'the report follows the hydrated snapshot');
    fw.answer(fw.reports()[0].id, []);
    await p;
  } finally {
    c.stop();
  }
});

test('★ BRIDGE: index.ts flushes the worker snapshot when the store hydrates, before the alert monitor starts', () => {
  const idx = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
  const flush = idx.indexOf("store.on('hydrated', () => analytics.flushSnapshot());");
  assert.ok(flush > 0, 'wired');
  assert.ok(flush < idx.indexOf('const monitor = startAlertMonitor('), 'registered before the monitor listens');
});

test('★ the first-snapshot wait is bounded: with no devices at all the request goes ahead as before', async () => {
  const fw = new FakeWorker();
  const c = createAnalyticsClient('unused.db', () => {}, { spawnWorker: () => fw, firstSnapshotWaitMs: 40 });
  try {
    const p = c.report('forecast');
    await sleep(10);
    assert.equal(fw.reports().length, 0);
    await sleep(60);
    assert.equal(fw.reports().length, 1, 'past the bound: an honest empty report, as before v1.186.0');
    fw.answer(fw.reports()[0].id, { pvForecastUnavailable: true });
    assert.deepEqual(await p, { pvForecastUnavailable: true });
    const again = c.report('runway');
    await sleep(5);
    assert.equal(fw.reports().length, 2, 'the wait is paid once, not per request');
    fw.answer(fw.reports()[1].id, {});
    await again;
  } finally {
    c.stop();
  }
});

/* ── (4) the HA state publish: per-report settle ──────────────────────────── */

test('★★★ settleStateReports: a failed report falls back to its last good answer, only while it is fresh', async () => {
  const lastGood = new Map<string, { value: unknown; atMs: number }>();
  let t = 1_000_000;
  const now = () => t;
  const errs: string[] = [];
  const opts = { waitMs: 50, maxAgeMs: 120_000, now, onError: (n: string) => errs.push(n) };
  assert.deepEqual(
    await mqttDiscovery.settleStateReports(['forecast', 'degradation'] as const, async (n) => `${n}@1`, lastGood, opts),
    { forecast: 'forecast@1', degradation: 'degradation@1' },
  );
  t += 60_000;
  const failDeg = (n: string) => (n === 'degradation' ? Promise.reject(new Error("analytics request 'report:degradation' timed out")) : Promise.resolve(`${n}@2`));
  assert.deepEqual(
    await mqttDiscovery.settleStateReports(['forecast', 'degradation'] as const, failDeg, lastGood, opts),
    { forecast: 'forecast@2', degradation: 'degradation@1' },
    'the failure nulls nothing else, and a 60 s-old answer still stands',
  );
  assert.deepEqual(errs, ['degradation']);
  t += 60_001; // the degradation answer is now 120.001 s old
  assert.deepEqual(
    await mqttDiscovery.settleStateReports(['forecast', 'degradation'] as const, failDeg, lastGood, opts),
    { forecast: 'forecast@2', degradation: null },
    'past expire_after a republished value would keep a dead report looking alive: null',
  );
  assert.deepEqual(
    await mqttDiscovery.settleStateReports(['runway'] as const, () => { throw new Error('sync'); }, lastGood, opts),
    { runway: null },
    'never computed stays null; a synchronous throw is a failure like any other',
  );
  assert.equal(mqttDiscovery.STATE_REPORT_LAST_GOOD_MAX_AGE_MS, 120_000, 'the bound is the live sensors\' expire_after');
});

test('★★★ settleStateReports: a slow report does not hold the others; its late answer serves the next cycle', async () => {
  const lastGood = new Map<string, { value: unknown; atMs: number }>();
  const slow = deferred<string>();
  const timer = setTimeout(() => slow.resolve('degradation@late'), 400);
  const t0 = Date.now();
  const r = await mqttDiscovery.settleStateReports(
    ['runway', 'degradation'] as const,
    (n) => (n === 'degradation' ? slow.promise : Promise.resolve('runway@now')),
    lastGood,
    { waitMs: 30 },
  );
  const waited = Date.now() - t0;
  assert.deepEqual(r, { runway: 'runway@now', degradation: null });
  assert.ok(waited < 300, `returned at the deadline, after ${waited} ms`);
  await slow.promise;
  clearTimeout(timer);
  await sleep(0);
  assert.equal(lastGood.get('degradation')?.value, 'degradation@late');
  assert.equal(mqttDiscovery.STATE_REPORT_WAIT_MS, 5_000);
});

const REPORT_FIXTURES: Record<string, unknown> = {
  forecast: { forecastPvWhNext24: 12_000, forecastPvWhNext24Display: 12_000, minProjectedSoc: 42, structurallyIncomplete: false, pvForecastUnavailable: false, soiling: null },
  degradation: { generatedAt: 1, eolSoh: 70, packs: [] },
  runway: { hoursToReserve: 7.5, hoursToEmpty: 12, unavailable: null, backupRemainingKwh: 20, backupReserveKwh: 5 },
  roundTripEfficiency: { efficiencyPct: 91 },
  clipping: { todayKwh: 1.2, arrayPeakW: 9000 },
  selfConsumption: { solarFractionOfLoadPct: 80, directUseRatioPct: 60, homeDpusCoveragePartial: false },
  carbon: { totalKgAvoided: 10, lifetimeKgAvoided: 100, lifetimeMilesNotDriven: 250, basisComplete: true },
  tariff: { todayGridImportCostDollars: 1, todaySolarLoadValueDollars: 2, netSavingsDollars: 3, basisComplete: true },
  curtailment: { active: false, currentSurplusW: 0, todayKwh: 0, recent7dKwh: 1, current: null, basisComplete: true },
};

test('★★★ buildState: degradation and runway failing — the alarm and live fields still publish, their own fields read unknown', async () => {
  const failing = new Set<string>(['degradation', 'runway']);
  const stub: AnalyticsClient = {
    report: async <T = any>(name: string): Promise<T> => {
      if (failing.has(name)) throw new Error(`analytics request 'report:${name}' timed out`);
      return structuredClone(REPORT_FIXTURES[name]) as T;
    },
    query: async () => [],
    listMetrics: async () => [],
    pushSnapshot: () => {},
    flushSnapshot: () => {},
    pushOwnerFloor: () => {},
    stop: () => {},
  };
  setAnalyticsClientForTesting(stub);
  const snap: FleetSnapshot = {
    generatedAt: Date.now(),
    devices: {
      'SHP2-P': {
        sn: 'SHP2-P', deviceName: 'Panel', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
        projection: { kind: 'shp2', backupBatPercent: 55, backupReserveSoc: 20, circuits: [{ ch: 1, watts: 100 }] },
      } as never,
    },
    alerts: [{ id: 'soc-floor', severity: 'critical', source: 'threshold', category: 'battery', title: 'Pool at floor' } as never],
    alertsComplete: true, // v1.186.0 — the monitor's set is complete (publishReadiness 'alerts')
  };
  const store = { get: () => snap, on: () => {} } as unknown as SnapshotStore;
  const logs: string[] = [];
  const handle = await mqttDiscovery.startMqttDiscovery(store, makeRecorderStub(), (m) => logs.push(m));
  try {
    assert.ok(handle.buildState, 'the enabled publisher exposes its payload builder');
    const s1 = await handle.buildState!(snap);
    assert.equal(s1.alert_critical_count, 1, 'alarm counts publish');
    assert.equal(s1.backup_pool_percent, 55, 'snapshot fields publish');
    assert.equal(s1.forecast_pv_next_24h_kwh, 12, 'a report that answered publishes');
    assert.equal(s1.round_trip_efficiency_percent, 91);
    assert.equal(s1.degradation_soonest_eol_years, null);
    assert.equal(s1.degradation_peer_outliers, null);
    assert.equal(s1.runway_to_reserve_hours, null, 'no runway is data loss — never the 999 "no depletion" sentinel');
    assert.equal(s1.runway_to_empty_hours, null);
    assert.equal(s1.lighting_posture, null, 'no posture from reports that did not answer');
    assert.equal(s1.lighting_posture_reason, null);
    assert.ok(logs.some((l) => l.includes("report 'degradation' failed for the state publish")));

    failing.clear();
    const s2 = await handle.buildState!(snap);
    assert.equal(s2.runway_to_reserve_hours, 7.5);
    assert.equal(s2.degradation_peer_outliers, 0);
    assert.equal(typeof s2.lighting_posture, 'string');

    failing.add('runway');
    const s3 = await handle.buildState!(snap);
    assert.equal(s3.runway_to_reserve_hours, 7.5, 'a seconds-old last good runway stands in for one failed cycle');
    assert.equal(typeof s3.lighting_posture, 'string');
  } finally {
    handle.stop();
    setAnalyticsClientForTesting(null);
  }
});

test('★★ every report-derived binary sensor renders null as "None" (HA unknown), never a fabricated OFF', () => {
  const reportDerived = ['pv_curtailment_active', 'self_consumption_coverage_partial', 'forecast_structurally_incomplete'];
  for (const key of reportDerived) {
    const b = mqttDiscovery.BINARY_SENSORS.find((x) => x.value_template.includes(`value_json.${key}`));
    assert.ok(b, key);
    assert.match(b!.value_template, new RegExp(`"None" if value_json\\.${key} is none`), `${b!.unique_id}`);
  }
});
