/**
 * v1.208.0 — the recorder writes the pool's capacity, each slot's flags and codes, and the pool-out tracker's
 * verdicts (src/recorder.ts extract, src/poolOutRecord.ts poolRecordMetrics). None existed on 2026-11-14: the capacity
 * step of that night is known only from Home Assistant's own history of one sensor.
 *
 * A real SnapshotStore and createRecorder (its 'change' subscription) on a temporary database, on mocked wall and
 * monotonic clocks. The bodies are the pool-out fixture's: recorder rows of 2026-11-14 with the capacity, the flags
 * and a moving circuit vector ADDED by the builder (synthetic), and placeholder serials.
 */
import { test, type TestContext, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Body, TimedBody } from './fixtures/poolOutFixtures.js';

const ROOT = mkdtempSync(join(tmpdir(), 'ef-pool-out-rec-'));
process.env.DB_PATH = join(ROOT, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(ROOT, 'shadow-witness.json');
delete process.env.SUPERVISOR_TOKEN;

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { projectShp2 } = await import('../src/ecoflow/project.js');
const { POOL_FLAG_SENT_SHIFT } = await import('../src/poolOutRecord.js');
const fx = await import('./fixtures/poolOutFixtures.js');
const { PANEL_SN, MIN } = fx;

const LOSS = fx.loadPoolFixture('pool-loss-1114');
const lossBodies = fx.bodiesFromRows(LOSS.rows, (t) => fx.capacityAt(LOSS.capacity, t));
const iso = (s: string): number => Date.parse(s);
const LISTED = [{ sn: PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 }] as any[];
const NEW_METRICS = [
  'backup_full_wh', 'backup_full_raw_wh', 'backup_pct_raw',
  'src1_full_wh', 'src1_flags', 'src1_err', 'src1_ctrl', 'src2_full_wh', 'src2_flags', 'src2_err', 'src2_ctrl', 'src3_full_wh', 'src3_flags', 'src3_err', 'src3_ctrl',
  'err_backup_n', 'err_master_n', 'err_hall_n', 'panel_flags', 'pool_counted_slots', 'pool_out_mask',
];

after(() => rmSync(ROOT, { recursive: true, force: true }));

function clocks(t: TestContext, wall0: number) {
  const c = { wall: wall0, mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  return { c, to: (ms: number) => { c.mono += ms - c.wall; c.wall = ms; } };
}
const flush = () => new Promise<void>((r) => setImmediate(r));
function rows(sql: string, ...p: Array<string | number>): any[] {
  const db = new DatabaseSync(process.env.DB_PATH!);
  try { return db.prepare(sql).all(...p) as any[]; } finally { db.close(); }
}
const series = (metric: string, fromMs = 0, toMs = Number.MAX_SAFE_INTEGER): Array<[string, number]> =>
  rows('SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts', PANEL_SN, metric, fromMs, toMs)
    .map((r) => [new Date(Number(r.ts)).toISOString().slice(11, 16), Number(r.value)]);
const metricsWritten = (fromMs = 0, toMs = Number.MAX_SAFE_INTEGER): string[] =>
  rows('SELECT DISTINCT metric FROM samples WHERE sn = ? AND ts >= ? AND ts <= ?', PANEL_SN, fromMs, toMs).map((r) => String(r.metric));
const changes = (s: Array<[string, number]>): Array<[string, number]> => s.filter((r, i) => i === 0 || r[1] !== s[i - 1][1]);

test('★★★ the 2026-11-14 loss as the recorder writes it: the capacity step, the slots counted, the alarm\'s mask — beside the series that existed', async (t) => {
  const { to } = clocks(t, lossBodies[0].atMs);
  const store = new SnapshotStore({ poolOutPath: null, poolEventsDir: null });
  store.setClock(() => Date.now());
  const rec = createRecorder(store, () => {});
  try {
    for (const b of lossBodies) {
      to(b.atMs);
      store.setDeviceList(LISTED);
      await flush();
      store.setDeviceQuota(PANEL_SN, b.body);
      await flush();
    }
    const written = metricsWritten();
    for (const m of NEW_METRICS) assert.equal(written.includes(m), true, `★ ${m} has rows`);
    assert.equal(written.includes('backup_pct') && written.includes('src1_w') && written.includes('panel_load'), true, 'control: the series that existed before are still written');

    // The capacity: 92,160 Wh until the 06:35Z body, 61,440 Wh from the 06:36Z body. Served and raw agree here
    // (a 3-point percent step is not slew-held).
    assert.deepEqual(changes(series('backup_full_raw_wh')), [['06:00', 92160], ['06:36', 61440]]);
    assert.deepEqual(changes(series('backup_full_wh')), [['06:00', 92160], ['06:36', 61440]]);
    assert.deepEqual(changes(series('pool_counted_slots')), [['06:00', 3], ['06:36', 2]], '★ three slots counted, then two');
    assert.deepEqual(changes(series('pool_out_mask')), [['06:00', 0], ['06:46', 1]], '★ the alarm\'s latched set: slot 1 from the raise');
    // A slot's own capacity and flags did not change (the fixture carries the flags of the one raw sample on record).
    const allSent = (2 ** 12 - 1) * 2 ** POOL_FLAG_SENT_SHIFT;
    assert.deepEqual(changes(series('src1_full_wh')), [['06:00', 30720]]);
    assert.deepEqual(changes(series('src1_flags')), [['06:00', 0b0010_0111_1111 + allSent]]);
    assert.deepEqual(changes(series('src1_ctrl')), [['06:00', 1]]);
    assert.deepEqual([changes(series('src1_err')), changes(series('err_backup_n')), changes(series('panel_flags'))], [[['06:00', 0]], [['06:00', 0]], [['06:00', 3 * 2 ** POOL_FLAG_SENT_SHIFT]]]);
    // The heartbeat: an unchanged value is restated every five minutes, like every recorder series.
    assert.equal(series('src1_full_wh').length, 15, '75 minutes at a 5-minute heartbeat');
    assert.equal(written.every((m) => !/sn|serial/i.test(m)), true);
  } finally {
    rec.close();
  }
});

test('★★★ none of it is written during a stale shadow: a replayed body is not a reading', async (t) => {
  const { to } = clocks(t, lossBodies[0].atMs);
  const store = new SnapshotStore({ poolOutPath: null, poolEventsDir: null });
  store.setClock(() => Date.now());
  const rec = createRecorder(store, () => {});
  // After the recorder exists (it creates the table): this test then runs alone as well as after the one above.
  rows('DELETE FROM samples');
  try {
    const poll = async (atMs: number, body: Body) => { to(atMs); store.setDeviceList(LISTED); await flush(); store.setDeviceQuota(PANEL_SN, body); await flush(); };
    for (const b of lossBodies.slice(0, 10)) await poll(b.atMs, b.body);
    const liveUntil = lossBodies[9].atMs;
    assert.equal(series('backup_full_raw_wh', 0, liveUntil).length > 0, true, 'control: recorded while live');
    // The cloud now serves the 06:09Z body for forty minutes: the latch sets after five repeats over four minutes.
    const frozen = lossBodies[9].body;
    for (let k = 1; k <= 40; k++) await poll(liveUntil + k * MIN, frozen);
    assert.notEqual((store.get().devices[PANEL_SN] as any).contentStaleSinceMs ?? null, null, 'control: the stale-shadow latch is set');
    const latchedFrom = (store.get().devices[PANEL_SN] as any).contentStaleSinceMs as number;
    // From shortly after the latch set, to the end: not one row of any new series (nor of any other).
    const quietFrom = liveUntil + 10 * MIN;
    assert.ok(latchedFrom < quietFrom, `latched at ${new Date(latchedFrom).toISOString()}`);
    for (const m of NEW_METRICS) assert.deepEqual(series(m, quietFrom), [], `★ ${m}: nothing during the shadow`);
    assert.deepEqual(metricsWritten(quietFrom), [], 'control: the gate holds every panel series alike');
    // The tracker saw the same: every one of those bodies was skipped.
    assert.equal(store.poolRecord(PANEL_SN).signals, null);
    // Content moves again: the series resume.
    for (let k = 41; k <= 50; k++) await poll(liveUntil + k * MIN, fx.healthyBody(9000 + k));
    assert.equal(series('backup_full_raw_wh', liveUntil + 41 * MIN).length > 0, true, 'and they resume with fresh content');
  } finally {
    rec.close();
  }
});

test('★★★ a failure to form the pool series costs nothing else: the panel\'s other series are written, and it is said once', async (t) => {
  const { to } = clocks(t, lossBodies[0].atMs);
  const store = new SnapshotStore({ poolOutPath: null, poolEventsDir: null });
  store.setClock(() => Date.now());
  const lines: string[] = [];
  const rec = createRecorder(store, (m) => lines.push(m));
  rows('DELETE FROM samples');
  try {
    const real = store.poolRecord.bind(store);
    store.poolRecord = (sn: string) => { const r = real(sn); return { ...r, get state(): any { throw new Error('unreadable state'); } }; };
    for (const b of lossBodies.slice(0, 12)) {
      to(b.atMs);
      store.setDeviceList(LISTED);
      await flush();
      store.setDeviceQuota(PANEL_SN, b.body);
      await flush();
    }
    const written = metricsWritten();
    assert.equal(written.includes('backup_pct') && written.includes('src1_w') && written.includes('panel_load'), true, '★ the series that existed are written');
    assert.deepEqual(written.filter((m) => NEW_METRICS.includes(m)), [], 'the pool series of the failing evaluations are not');
    assert.deepEqual(lines.filter((l) => l.includes('pool-out series')), ['recorder: the pool-out series could not be formed (unreadable state) — every other series is written as usual; said once']);
    assert.equal(lines.some((l) => l.startsWith('recorder: record failed')), false, '★ the evaluation itself did not fail');
  } finally {
    rec.close();
  }
});

test('★ a store stand-in with no side map (as this repository\'s recorder unit tests build) writes the series it always did, and no pool series', async (t) => {
  clocks(t, lossBodies[40].atMs);
  const stub = new EventEmitter() as any;
  stub.get = () => ({
    generatedAt: Date.now(),
    devices: { [PANEL_SN]: { sn: PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(), lastTelemetryAtMs: Date.now(), projection: projectShp2(lossBodies[40].body) } },
  });
  const rec = createRecorder(stub, () => {});
  rows('DELETE FROM samples');
  try {
    rec.insertSnapshot(stub.get());
    const written = metricsWritten();
    assert.equal(written.includes('backup_pct') && written.includes('src1_w'), true, 'the panel is recorded');
    assert.deepEqual(written.filter((m) => NEW_METRICS.includes(m)), []);
  } finally {
    rec.close();
  }
});
