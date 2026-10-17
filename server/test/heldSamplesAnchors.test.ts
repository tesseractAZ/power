/**
 * v1.188.1 review round 3 — the held-sample scan around a span's start.
 *
 *  1. A span can start at a KEPT restated row: a sub-hour stretch, a silence of more than an hour,
 *     then a hold (review 2). A scan that re-reads such a span from before its start (the 3 h
 *     rescan overlap, the boot scan after a stop, the retry after a failed slice) passed the row
 *     after the moved part through the silence branch, which opened a return piece without
 *     measuring the gap again from the moved span's end: the rows after the moved part had to
 *     qualify on their own, and a hold that ended within the hour stayed in samples for good.
 *  2. Only FROZEN spans are spans an earlier scan moved: a gate span (nothing written) that starts
 *     at the last fresh row's own ts is not, and the rows after it are not measured from its end.
 *  3. A return piece that qualifies on its last restated row joins the stretch with its rows and
 *     its end.
 *  4. The first scan starts each device at its oldest row over every metric, not at the oldest row
 *     of the last metric listed.
 *  5. recorder.heldRowsWithin says whether a moved row lies in a window (the night ledger's reset).
 * Fake serials throughout.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

const tmp = mkdtempSync(join(tmpdir(), 'ef-held-anchors-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { createHeldSamples } = await import('../src/heldSamples.js');

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);

type Row = [ts: number, sn: string, metric: string, value: number];
const METRICS = ['soc', 'ac_in', 'bat_vol', 'bat_amp', 'total_out', 'pv_total', 'mppt_hv_temp', 'pack1_soc', 'pack1_temp', 'pack1_vol_max_mv', 'pack1_vol_min_mv', 'pack1_remain_cap_mah'];
const CORE_A = 'COREXXX00XXX0001';

function makeStore() {
  const ee = new EventEmitter() as any;
  ee.snap = { generatedAt: 0, devices: {} };
  ee.get = () => ee.snap;
  return ee;
}
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(DB_PATH);
  try { return fn(db); } finally { db.close(); }
}
function insertRows(rows: Row[]) {
  if (rows.length === 0) return;
  withDb((db) => {
    const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const r of rows) ins.run(...r);
    db.exec('COMMIT');
  });
}
function reset() {
  for (const f of ['telemetry-gaps.json', '.clean-shutdown']) if (existsSync(join(tmp, f))) unlinkSync(join(tmp, f));
  if (!existsSync(DB_PATH)) createRecorder(makeStore(), () => {}).close();
  withDb((db) => db.exec('DELETE FROM samples; DELETE FROM held_samples; DELETE FROM held_spans; DELETE FROM held_scan; DELETE FROM held_generation;'));
}
const tsOf = (table: 'samples' | 'held_samples'): number[] => withDb((db) =>
  (db.prepare(`SELECT DISTINCT ts FROM ${table} WHERE sn = ? ORDER BY ts`).all(CORE_A) as any[]).map((r) => Number(r.ts)));

/** A live Core: every metric each minute, every value moving. */
function live(fromMs: number, toMs: number, k0 = 0): Row[] {
  const out: Row[] = [];
  for (let t = fromMs, k = k0; t <= toMs; t += MIN, k++) METRICS.forEach((m, i) => out.push([t, CORE_A, m, 100 + i * 10 + (k % 17) + i / 100]));
  return out;
}
/** Every metric restated every 5 min (staggered a second apart) at its last value in `before`. */
function held(before: Row[], fromMs: number, toMs: number): Row[] {
  const lastVal = new Map<string, number>();
  for (const r of before) lastVal.set(r[2], r[3]);
  const out: Row[] = [];
  for (let t = fromMs; t <= toMs; t += 5 * MIN) METRICS.forEach((m, i) => out.push([t + i * 1_000, CORE_A, m, lastVal.get(m)!]));
  return out;
}
const lastTs = (rows: Row[]) => Math.max(...rows.map((r) => r[0]));
const distinctTs = (rows: Row[]) => [...new Set(rows.map((r) => r[0]))].sort((a, b) => a - b);

interface Outcome { held: number[]; left: number[]; spans: Array<[number, number, number]>; lines: string[]; after: number[][] }

/** Rows land as time passes and the scan runs at each of `scans`; `after[i]` is held_samples after scan i. */
function run(t: TestContext, rows: Row[], scans: number[]): Outcome {
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  reset();
  let now = scans[0];
  const mocked = t.mock.method(Date, 'now', () => now);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  const after: number[][] = [];
  try {
    let i = 0;
    for (const at of scans) {
      const batch: Row[] = [];
      while (i < sorted.length && sorted[i][0] <= at) batch.push(sorted[i++]);
      insertRows(batch);
      now = at;
      rec.scanHeldSamples!(at);
      after.push(tsOf('held_samples'));
    }
    const spans = rec.heldSpans!(0, now + DAY).map((s): [number, number, number] => [s.startMs, s.endMs, s.rows]);
    return { held: tsOf('held_samples'), left: tsOf('samples'), spans, lines, after };
  } finally {
    rec.close();
    mocked.mock.restore();
  }
}

/**
 * The kept-anchor shape: live to X, a 35-min restated stretch P1 (too short to be a hold; K = its
 * last row), a 70-min silence, then a hold P2 that qualifies on its own. The span runs from K.
 */
function keptAnchor(day: number, p2Min: number) {
  const X = phx(2026, 10, day, 1, 0);
  const a1 = live(X - H, X);
  const P1 = held(a1, X + 5 * MIN, X + 40 * MIN);
  const K = lastTs(P1);
  const P2 = held(a1, X + 110 * MIN, X + (110 + p2Min) * MIN);
  return { X, a1, P1, K, P2 };
}

/* ══ 1. a re-read of a span that starts at a kept restated row ══════════════ */

test('★★★ a boot after a stop re-reads a kept-anchor span from before its start: the rest of the hold is moved, as by one scan', (t) => {
  const { X, a1, P1, K, P2 } = keptAnchor(1, 65);
  const back = live(X + 8 * H, X + 9 * H, 500); // fresh readings after the stop
  const rows = [...a1, ...P1, ...P2, ...back];
  // A scan at the hold's last row moves it up to 15 min before; the add-on is stopped 5 h (no rows,
  // no scans); the boot scan reads from 3 h before the watermark, before K; hourly after it.
  const scans = [X + 175 * MIN, X + 8 * H + MIN, X + 9 * H + MIN, X + 10 * H + MIN, X + 11 * H + MIN];
  const hourly = run(t, rows, scans);
  const once = run(t, rows, [scans[scans.length - 1]]);
  assert.deepEqual(once.spans.map(([s, e]) => [s, e]), [[K, lastTs(P2)]], 'precondition: one scan moves the hold from K');
  assert.equal(hourly.after[0].length > 0 && Math.max(...hourly.after[0]) < lastTs(P2), true, 'precondition: the first scan moved only the hold\'s older part');
  assert.deepEqual(distinctTs(P2).filter((ts) => hourly.left.includes(ts)), [], '★★★ no row of the hold is left in samples');
  assert.deepEqual(hourly.held, once.held, '★★★ the same rows as one scan');
  assert.deepEqual(hourly.spans, once.spans, '★★ the same span, to the hold\'s last row');
  assert.ok(distinctTs(P1).every((ts) => hourly.left.includes(ts)), 'the short stretch before the silence stays');
});

test('★★ hourly scans over a kept-anchor hold: no held row older than 15 min waits for a later scan', (t) => {
  const { X, a1, P1, K, P2 } = keptAnchor(2, 90);
  const back = live(lastTs(P2) + 5 * MIN, X + 4 * H, 500);
  const rows = [...a1, ...P1, ...P2, ...back];
  const scans: number[] = [];
  for (let s = X + 175 * MIN; s <= X + 8 * H; s += H) scans.push(s);
  const r = run(t, rows, scans);
  for (const [i, at] of scans.entries()) {
    const waiting = distinctTs(P2).filter((ts) => ts <= at - 15 * MIN && !r.after[i].includes(ts));
    assert.deepEqual(waiting, [], `★★ after the scan at ${new Date(at).toISOString()}: rows of the hold old enough to move, still in samples`);
  }
  assert.deepEqual(r.spans.map(([s, e]) => [s, e]), [[K, lastTs(P2)]]);
});

test('★★★ a failed LAST slice of a kept-anchor span is moved by the next scan: the retry the log promises', (t) => {
  const { X, a1, P1, K, P2 } = keptAnchor(3, 180);
  const back = live(lastTs(P2) + 5 * MIN, X + 6 * H, 500);
  reset();
  insertRows([...a1, ...P1, ...P2, ...back]);
  const NOW = X + 5 * DAY;
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  try {
    // The span moves in hourly slices from K; the fourth hour's end is K + 4 h, and the last slice
    // (K + 4 h, the hold's last row] fails.
    withDb((db) => db.exec(`CREATE TRIGGER fail_last_slice BEFORE INSERT ON held_samples WHEN NEW.sn = '${CORE_A}' AND NEW.ts > ${K + 4 * H}
      BEGIN SELECT RAISE(ABORT, 'simulated SQLITE_FULL'); END;`));
    const first = rec.scanHeldSamples!(NOW);
    withDb((db) => db.exec('DROP TRIGGER fail_last_slice;'));
    assert.ok(first.rowsMoved > 0, 'precondition: the first slices moved');
    assert.ok(lines.some((l) => l.includes('held-sample move FAILED') && l.includes(`the next scan re-reads ${CORE_A} from ${new Date(K).toISOString()}`)), lines.join('\n'));
    now = NOW + H;
    const second = rec.scanHeldSamples!(now);
    assert.equal(first.rowsMoved + second.rowsMoved, P2.length, '★★★ the retry moves the rest of the span');
    assert.deepEqual(distinctTs(P2).filter((ts) => tsOf('samples').includes(ts)), [], 'none of the hold left in samples');
    const spans = rec.heldSpans!(0, now + DAY).map((s) => [s.startMs, s.endMs, s.rows]);
    assert.deepEqual(spans, [[K, lastTs(P2), P2.length]], '★★ one span, from K to the hold\'s last row');
  } finally { rec.close(); }
});

/* ══ in-memory store (one device, the move statements' indexes) ═══════════ */

const SN = 'COREXXX00XXX0003';
const M12 = Array.from({ length: 12 }, (_, i) => `m${String(i).padStart(2, '0')}`);
function memDb(rows: Row[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE samples (ts INTEGER NOT NULL, sn TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL);
    CREATE INDEX idx_samples_sn_metric_ts ON samples (sn, metric, ts); CREATE INDEX idx_samples_ts ON samples (ts);`);
  const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const r of rows) ins.run(...r);
  db.exec('COMMIT');
  return db;
}
/** Live groups, all metrics at one ts each minute, every value moving; returns the rows and the last values. */
function liveGroups(fromMs: number, toMs: number, val: Map<string, number>, metrics = M12): Row[] {
  const out: Row[] = [];
  let k = 0;
  for (let t = fromMs; t <= toMs; t += MIN) for (const m of metrics) { val.set(m, (val.get(m) ?? 100) + 1 + (k++ % 5)); out.push([t, SN, m, val.get(m)!]); }
  return out;
}
/** Groups at `times`, all metrics at one ts, each at its last value. */
const restated = (times: number[], val: Map<string, number>, metrics = M12): Row[] => times.flatMap((t) => metrics.map((m): Row => [t, SN, m, val.get(m)!]));
const memStore = (db: DatabaseSync, nowMs: () => number, retainMs = 400 * DAY, metrics = M12) =>
  createHeldSamples(db, { log: () => {}, retainMs, isExcludedSn: () => false, listSns: () => [SN], listMetrics: () => metrics, now: nowMs });
const countIn = (db: DatabaseSync, table: string, fromMs: number, toMs: number) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ts >= ? AND ts <= ?`).get(fromMs, toMs) as { n: number }).n);

/* ══ 2. a gate span is not a span an earlier scan moved ═══════════════════ */

for (const shadow of [false, true]) {
  test(`★★ a ${shadow ? 'gate-shadow' : 'gate-stale'} span from the last fresh row's own ts: the device's return readings after it are not moved`, () => {
    // The gate span starts at heldSinceMs, the content clock; record() writes the rows from its own
    // Date.now() a setImmediate later, so the two are the same ms whenever both land in one.
    const T0 = phx(2026, 10, 5, 2, 0);
    const val = new Map<string, number>();
    const fresh = liveGroups(T0, T0 + 30 * MIN, val);
    const F = T0 + 30 * MIN;
    const back = F + 3 * H; // nothing was written behind the gate
    const ret = restated([back, back + 5 * MIN], val); // two groups equal to its last values
    const after = liveGroups(back + 6 * MIN, back + 30 * MIN, val);
    const db = memDb([...fresh, ...ret, ...after]);
    let now = F + MIN;
    const hs = memStore(db, () => now);
    hs.scanNow(now); // the first, full scan: nothing held yet
    for (let at = F + MIN; at < back; at += MIN) { now = at; hs.noteGate(new Map([[SN, { sinceMs: F, shadow }]]), at); }
    now = back;
    hs.noteGate(new Map(), back);
    const gate = (db.prepare('SELECT start_ts, reason FROM held_spans').all() as Array<{ start_ts: number; reason: string }>);
    assert.deepEqual(gate.map((g) => [Number(g.start_ts), g.reason]), [[F, shadow ? 'gate-shadow' : 'gate-stale']], 'precondition: the gate span, from the last fresh row');
    now = back + 2 * H;
    const sum = hs.scanNow(now);
    assert.equal(sum.rowsMoved, 0, '★★ the return readings after the gate stay in samples (the gate span is not a moved span)');
    assert.equal(countIn(db, 'samples', back, back + 5 * MIN), ret.length);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM held_spans WHERE reason = 'frozen'").get() as { n: number }).n), 0, 'no frozen span');
  });
}

/* ══ 3. a return piece that qualifies on its last restated row ═══════════════ */

for (const holdBefore of [true, false]) {
  test(`★★ a return piece that qualifies on its LAST restated row joins the stretch${holdBefore ? ' after a hold' : ' (an outage, then a replay)'}`, () => {
    const T0 = phx(2026, 10, 6, 2, 0);
    const val = new Map<string, number>();
    const fresh = liveGroups(T0, T0 + 29 * MIN, val);
    const F = T0 + 29 * MIN;
    const hold = holdBefore ? restated(Array.from({ length: 24 }, (_, i) => F + (i + 1) * 5 * MIN), val) : [];
    const R = (holdBefore ? lastTs(hold) : F) + 2 * H; // a 2 h silence
    // 13 groups 5 min apart, every metric at one ts: 12 intervals, the hour reached on the last one.
    const ret = restated(Array.from({ length: 13 }, (_, i) => R + i * 5 * MIN), val);
    const last = R + 60 * MIN;
    const after = liveGroups(last + MIN, last + 10 * MIN, val);
    const db = memDb([...fresh, ...hold, ...ret, ...after]);
    const NOW = last + 3 * H;
    const hs = memStore(db, () => NOW);
    const sum = hs.scanNow(NOW);
    const spans = (db.prepare("SELECT start_ts, end_ts, rows FROM held_spans WHERE reason = 'frozen'").all() as any[]).map((r) => [Number(r.start_ts), Number(r.end_ts), Number(r.rows)]);
    assert.deepEqual(spans, [[F, last, hold.length + ret.length]], '★★ one span, from the last change to the return piece\'s last row');
    assert.equal(countIn(db, 'samples', R, last), 0, '★★ no row of the return piece is left in samples');
    assert.equal(sum.rowsMoved, hold.length + ret.length);
  });
}

/* ══ 4. the first scan starts at the device's oldest row over every metric ═════ */

test('★★ the first scan starts at the device\'s oldest row, not at the last listed metric\'s', () => {
  // Metrics are added over time (ems_para_vol_* in v1.187.3), and listMetrics returns them in name
  // order: here the twelfth, last in that order, first appears 3 h after the hold.
  const T0 = phx(2026, 10, 7, 2, 0);
  const base = M12.slice(0, 11);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + 30 * MIN, val, base);
  const F = T0 + 30 * MIN;
  const hold = restated(Array.from({ length: 24 }, (_, i) => F + (i + 1) * 5 * MIN), val, base);
  const later = F + 3 * H;
  const after = liveGroups(later, later + 30 * MIN, val, M12);
  const db = memDb([...fresh, ...hold, ...after]);
  const NOW = later + 2 * H;
  const hs = memStore(db, () => NOW, 30 * DAY, M12);
  const sum = hs.scanNow(NOW);
  assert.ok(sum.full, 'precondition: the first scan');
  assert.equal(sum.rowsMoved, hold.length, '★★ the hold before the late metric\'s first row is read and moved');
});

/* ══ 5. recorder.heldRowsWithin ════════════════════════════════════════════ */

test('★ heldRowsWithin: a moved row of that metric inside the window, and nothing outside it', (t) => {
  const X = phx(2026, 10, 8, 1, 0);
  const a1 = live(X - H, X);
  const P = held(a1, X + 5 * MIN, X + 3 * H);
  const back = live(lastTs(P) + 5 * MIN, lastTs(P) + 30 * MIN, 500);
  reset();
  insertRows([...a1, ...P, ...back]);
  let now = X + 2 * DAY;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  try {
    assert.equal(rec.heldRowsWithin!(CORE_A, 'pv_total', X - H, X + 4 * H), false, 'nothing moved yet');
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, P.length);
    assert.equal(rec.heldRowsWithin!(CORE_A, 'pv_total', X - H, X + 4 * H), true, '★ a moved pv_total row in the window');
    assert.equal(rec.heldRowsWithin!(CORE_A, 'pv_total', X - H, X), false, 'a window before the hold');
    assert.equal(rec.heldRowsWithin!(CORE_A, 'panel_load', X - H, X + 4 * H), false, 'another metric');
    assert.equal(rec.heldRowsWithin!('COREXXX00XXX0009', 'pv_total', X - H, X + 4 * H), false, 'another device');
  } finally { rec.close(); }
});
