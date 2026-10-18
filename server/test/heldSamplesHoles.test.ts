/**
 * v1.188.1 review round 2 — holes, silences and scan cadence in the held-sample scan.
 *
 * The dry-run follow-ups ended a frozen stretch at ANY gap longer than the 10-min bridge, so that a
 * Core back after 9.8 silent days with one group equal to its held values kept that reading. That
 * rule also:
 *  1. left the tail of a running hold in `samples` after a restart's 20-min hole (the tail had to
 *     qualify on its own, and a span was extended only within one bridge of its end);
 *  2. stopped the observed time of two sub-hour parts of one hold from adding up;
 *  3. made where a span starts, where it ends and whether a return group is moved depend on how
 *     often the scan runs (the first scan over history reads in one pass, the live scan hourly);
 *  4. announced a hold split by a gap with its first part's end and held flow only.
 * A gap of up to an hour is now a HOLE inside the stretch; a longer one is a SILENCE, after which
 * the rows are a return piece, joined only once it qualifies on its own (createFrozenScanner).
 * Fake serials throughout.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

const tmp = mkdtempSync(join(tmpdir(), 'ef-held-holes-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { HELD_RETURN_GAP_MS, HELD_SPAN_MIN_MS, observedWithinMs } = await import('../src/heldSamples.js');

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
function reset(rows: Row[]) {
  for (const f of ['telemetry-gaps.json', '.clean-shutdown']) if (existsSync(join(tmp, f))) unlinkSync(join(tmp, f));
  if (!existsSync(DB_PATH)) createRecorder(makeStore(), () => {}).close();
  withDb((db) => db.exec('DELETE FROM samples; DELETE FROM held_samples; DELETE FROM held_spans; DELETE FROM held_scan; DELETE FROM held_generation;'));
  insertRows(rows);
}
const tsOf = (table: 'samples' | 'held_samples', sn = CORE_A): number[] => withDb((db) =>
  (db.prepare(`SELECT DISTINCT ts FROM ${table} WHERE sn = ? ORDER BY ts`).all(sn) as any[]).map((r) => Number(r.ts)));
const countOf = (table: 'samples' | 'held_samples') => Number(withDb((db) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n));

/** A live Core: every metric each minute, every value moving. */
function live(sn: string, fromMs: number, toMs: number, k0 = 0): Row[] {
  const out: Row[] = [];
  for (let t = fromMs, k = k0; t <= toMs; t += MIN, k++) METRICS.forEach((m, i) => out.push([t, sn, m, 100 + i * 10 + (k % 17) + i / 100]));
  return out;
}
/** Every metric restated every 5 min (staggered a second apart) at its last value in `before`. */
function held(sn: string, before: Row[], fromMs: number, toMs: number): Row[] {
  const lastVal = new Map<string, number>();
  for (const r of before) if (r[1] === sn) lastVal.set(r[2], r[3]);
  const out: Row[] = [];
  for (let t = fromMs; t <= toMs; t += 5 * MIN) METRICS.forEach((m, i) => out.push([t + i * 1_000, sn, m, lastVal.get(m)!]));
  return out;
}
const lastTs = (rows: Row[]) => Math.max(...rows.map((r) => r[0]));
const iso = (ms: number) => new Date(ms).toISOString();

interface Outcome { held: number[]; left: number[]; spans: Array<[number, number]>; lines: string[] }

/**
 * The live cadence: rows land as time passes, and the scan runs at each of `scans` (the first is
 * the first, full scan). With one scan, the first scan over history after the fact.
 */
function run(t: TestContext, rows: Row[], scans: number[]): Outcome {
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  reset([]);
  let now = scans[0];
  const mocked = t.mock.method(Date, 'now', () => now);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  try {
    let i = 0;
    for (const at of scans) {
      const batch: Row[] = [];
      while (i < sorted.length && sorted[i][0] <= at) batch.push(sorted[i++]);
      insertRows(batch);
      now = at;
      rec.scanHeldSamples!(at);
    }
    const spans = rec.heldSpans!(0, now + DAY).map((s): [number, number] => [s.startMs, s.endMs]);
    return { held: tsOf('held_samples'), left: tsOf('samples'), spans, lines };
  } finally {
    rec.close();
    mocked.mock.restore();
  }
}
const hourlyScans = (fromMs: number, toMs: number, offsetMs = 10 * MIN) => {
  const out: number[] = [];
  for (let t = fromMs + offsetMs; t <= toMs; t += H) out.push(t);
  return out;
};
/** The same rows scanned hourly (at several offsets past the hour) and once after the fact. */
function bothCadences(t: TestContext, rows: Row[], fromMs: number, toMs: number) {
  const once = run(t, rows, [toMs]);
  const hourly = [0, 10, 25, 40, 55].map((off) => ({ off, r: run(t, rows, hourlyScans(fromMs, toMs, off * MIN)) }));
  for (const { off, r } of hourly) {
    assert.deepEqual(r.held, once.held, `★★★ hourly at :${off} moves exactly the rows a scan of the whole history moves`);
    assert.deepEqual(r.spans, once.spans, `★★★ hourly at :${off}: the same spans (${JSON.stringify(r.spans.map((s) => s.map(iso)))} vs ${JSON.stringify(once.spans.map((s) => s.map(iso)))})`);
  }
  return once;
}

test('the constants: a hole is up to an hour; the silence after which rows are a return is longer', () => {
  assert.equal(HELD_RETURN_GAP_MS, HELD_SPAN_MIN_MS);
  assert.equal(HELD_RETURN_GAP_MS, H);
});

/* ══ 1. a restart's hole inside a running hold ═══════════════════════════════ */

test('★★★ a restart\'s 20-min hole inside a running hold: the hourly scans move its tail, as one span', (t) => {
  const T0 = phx(2026, 10, 1, 0, 0);
  const X = T0 + H;
  const a1 = live(CORE_A, T0, X);
  const part1 = held(CORE_A, a1, X + 5 * MIN, X + 3 * H);
  // The add-on restarts: 20 min with no rows, then the cloud's replayed body is restated again.
  const tail = held(CORE_A, a1, X + 3 * H + 20 * MIN, X + 4 * H);
  const back = live(CORE_A, X + 4 * H + 5 * MIN, X + 5 * H, 500);
  const rows = [...a1, ...part1, ...tail, ...back];
  const r = bothCadences(t, rows, T0, X + 10 * H);
  assert.deepEqual(r.held, [...new Set([...part1, ...tail].map((x) => x[0]))].sort((a, b) => a - b),
    '★★★ every held row is moved, the 40-min tail after the hole too (it was left in samples for good)');
  assert.deepEqual(r.spans, [[X, lastTs(tail)]], 'one span, from the last fresh reading to the last held row');
  assert.ok(r.left.includes(X) && r.left.every((ts) => ts <= X || ts > lastTs(tail)), 'only fresh readings stay');
});

/* ══ 2. sub-hour parts add up ════════════════════════════════════════════════ */

test('★★★ two parts of one hold, neither an hour, add up across a 20-min hole and are moved', (t) => {
  const T0 = phx(2026, 10, 2, 0, 0);
  const X = T0 + H;
  const a1 = live(CORE_A, T0, X);
  const p1 = held(CORE_A, a1, X + 5 * MIN, X + 40 * MIN);
  const p2 = held(CORE_A, a1, X + 60 * MIN, X + 95 * MIN);
  const rows = [...a1, ...p1, ...p2, ...live(CORE_A, X + 100 * MIN, X + 2 * H, 500)];
  const r = bothCadences(t, rows, T0, X + 6 * H);
  assert.deepEqual(r.held, [...new Set([...p1, ...p2].map((x) => x[0]))].sort((a, b) => a - b), '★★★ 8 + 8 restated groups: 75 min observed (they were judged apart: 40 and 35)');
  assert.equal(r.held.length, 16 * METRICS.length);
  assert.deepEqual(r.spans, [[X, lastTs(p2)]]);
});

/* ══ 8. a hold broken by short stalls ════════════════════════════════════════ */

test('★★ a 6 h hold broken every 50 min by a 12-min stall is moved whole', (t) => {
  const T0 = phx(2026, 10, 3, 0, 0);
  const X = T0 + H;
  const a1 = live(CORE_A, T0, X);
  const parts: Row[] = [];
  for (let s = X + 5 * MIN; s < X + 6 * H; s += 62 * MIN) parts.push(...held(CORE_A, a1, s, s + 50 * MIN));
  const rows = [...a1, ...parts, ...live(CORE_A, X + 6 * H + 30 * MIN, X + 7 * H, 500)];
  const r = bothCadences(t, rows, T0, X + 12 * H);
  assert.equal(r.held.length, new Set(parts.map((x) => x[0])).size, '★★ every piece, each under an hour (nothing was moved)');
  assert.deepEqual(r.spans, [[X, lastTs(parts)]]);
});

test('★★ a hold\'s last 40 min after a 12-min stall are moved with it', (t) => {
  const T0 = phx(2026, 10, 4, 0, 0);
  const X = T0 + H;
  const a1 = live(CORE_A, T0, X);
  const p1 = held(CORE_A, a1, X + 5 * MIN, X + 2 * H);
  const p2 = held(CORE_A, a1, X + 2 * H + 15 * MIN, X + 2 * H + 55 * MIN);
  const rows = [...a1, ...p1, ...p2, ...live(CORE_A, X + 3 * H, X + 4 * H, 500)];
  const r = bothCadences(t, rows, T0, X + 8 * H);
  assert.equal(r.held.length, new Set([...p1, ...p2].map((x) => x[0])).size, '★★ the tail too (it stayed in samples as fresh readings)');
  assert.deepEqual(r.spans, [[X, lastTs(p2)]]);
});

/* ══ 3. the scan's cadence does not change the outcome ══════════════════════ */

test('★★★ an equal group between two silences is a return reading at any cadence; the replay after it is a hold from it', (t) => {
  // A 2 h hold; a silent day; one group equal to the held values; another silent day; a 2 h replay.
  const T0 = phx(2026, 10, 5, 0, 0);
  const X = T0 + H;
  const a1 = live(CORE_A, T0, X);
  const A = held(CORE_A, a1, X + 5 * MIN, X + 2 * H);
  const R = X + 2 * H + DAY;
  const groupR = held(CORE_A, a1, R, R);
  const C = held(CORE_A, a1, R + DAY, R + DAY + 2 * H);
  const rows = [...a1, ...A, ...groupR, ...C, ...live(CORE_A, R + DAY + 2 * H + 5 * MIN, R + DAY + 3 * H, 500)];
  const r = bothCadences(t, rows, T0, R + DAY + 5 * H);
  const rTs = lastTs(groupR);
  assert.ok(r.left.includes(rTs), '★★★ the return reading stays in samples (moved by a scan of the whole history, kept by the hourly scans)');
  assert.deepEqual(r.spans, [[X, lastTs(A)], [rTs, lastTs(C)]],
    '★★ two spans: neither claims the silent days, and the second starts at the newest row kept before it');
});

test('★★★ a stretch too short to be a hold before a silence stays at any cadence, and the replay after it is a hold from its last row', (t) => {
  const T0 = phx(2026, 10, 6, 0, 0);
  const X = T0 + H;
  const a1 = live(CORE_A, T0, X);
  const P1 = held(CORE_A, a1, X + 5 * MIN, X + 40 * MIN);
  const P2 = held(CORE_A, a1, X + 2 * H + 45 * MIN, X + 4 * H + 15 * MIN);
  const rows = [...a1, ...P1, ...P2, ...live(CORE_A, X + 4 * H + 20 * MIN, X + 5 * H, 500)];
  const r = bothCadences(t, rows, T0, X + 9 * H);
  const p1End = lastTs(P1);
  assert.ok(new Set(P1.map((x) => x[0])).size > 0 && P1.every((x) => r.left.includes(x[0])), 'the 35-min stretch stays (an hourly scan no longer reads its fresh start when the replay qualifies)');
  assert.deepEqual(r.spans, [[p1End, lastTs(P2)]]);
  assert.equal(r.held.length, new Set(P2.map((x) => x[0])).size, '★★ the replay is moved whole, its first group too');
});

/* ══ 4. what the log states ═════════════════════════════════════════════════ */

test('★★ a span found by an hourly scan and extended by the next ones: each line states its range, and the held flow adds up once', (t) => {
  const T0 = phx(2026, 10, 7, 0, 0);
  const X = T0 + H;
  // 6 kW of PV on the last fresh reading: the held flow the lifetime counters integrated.
  const a1 = live(CORE_A, T0, X).map((r): Row => (r[0] === X && r[2] === 'pv_total' ? [r[0], r[1], r[2], 6_000] : r));
  const h1 = held(CORE_A, a1, X + 5 * MIN, X + 3 * H);
  const h2 = held(CORE_A, a1, X + 3 * H + 25 * MIN, X + 5 * H); // a 25-min hole: one hold
  const rows = [...a1, ...h1, ...h2, ...live(CORE_A, X + 5 * H + 5 * MIN, X + 6 * H, 500)];
  const scans = hourlyScans(T0, X + 8 * H, 20 * MIN);
  const r = run(t, rows, scans);
  assert.deepEqual(r.spans, [[X, lastTs(h2)]]);
  const announce = r.lines.filter((l) => l.includes('HELD SAMPLES'));
  assert.equal(announce.length, 1, r.lines.join('\n'));
  const extensions = r.lines.filter((l) => l.includes(`held samples of ${CORE_A} up to`) && l.includes('continued from'));
  assert.ok(extensions.length >= 2, `★★ each later scan's move states its range: ${r.lines.filter((l) => l.includes('held samples of')).join('\n')}`);
  // The first scan to qualify moved up to 15 min before itself (newer rows wait); the line says so.
  const firstTo = /to (\S+Z) \(/.exec(announce[0])![1];
  assert.ok(extensions[0].includes(`continued from ${firstTo}`), `★ the extension starts where the first move stopped: ${extensions[0]}`);
  const kwh = (l: string) => Number(/ (\d+\.\d) kWh of pv_total/.exec(l)![1]);
  const total = [announce[0], ...extensions].reduce((a, l) => a + kwh(l), 0);
  // Observed: every interval of the hold up to the bridge (the 25-min hole is not observed).
  const observed = (lastTs(h1) - X) + (lastTs(h2) - (X + 3 * H + 25 * MIN));
  const expected = 6_000 * observed / H / 1000;
  assert.ok(Math.abs(total - expected) <= 0.05 * (1 + extensions.length), `★★ the parts add up to the held flow once: ${total.toFixed(2)} vs ${expected.toFixed(2)} kWh`);
});

test('observedWithinMs — the observed runs inside a range', () => {
  const s = { observed: [[0, 40 * MIN], [60 * MIN, 95 * MIN]] as const };
  assert.equal(observedWithinMs(s, 0, 95 * MIN), 75 * MIN);
  assert.equal(observedWithinMs(s, 30 * MIN, 70 * MIN), 20 * MIN, 'the part of each run inside it');
  assert.equal(observedWithinMs(s, 40 * MIN, 60 * MIN), 0, 'a hole observed nothing');
});
