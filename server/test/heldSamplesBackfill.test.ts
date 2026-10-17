/**
 * v1.188.1 — held rows ALREADY written are moved out of `samples`, kept, and restorable.
 *
 * Before v1.188.1 the recorder restated a held device's last reading every 5 minutes, so the
 * 2026-10-14/15 incident left ~1,300 rows per Core per hour in which no metric changed, which
 * every learner and scorer reads as measurements. The scan (heldSamples.ts) finds a stretch of an
 * hour or more in which no metric of a device changed, restated at least three times over at
 * least eight metrics, and moves those rows — unchanged, one transaction per slice — to
 * `held_samples`. Nothing is deleted; a restore moves them back and the span is never moved
 * again. Rows are written straight into a real recorder database with fake serials.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

const tmp = mkdtempSync(join(tmpdir(), 'ef-held-backfill-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { integrateWh } = await import('../src/aggregator.js');
const { createFrozenScanner, HELD_MOVE_MIN_AGE_MS, HELD_ROW_BRIDGE_MS, FROZEN_DEFAULTS } = await import('../src/heldSamples.js');
const { createReadRecorder } = await import('../src/readRecorder.js');

const MIN = 60_000;
const H = 60 * MIN;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);

type Row = [ts: number, sn: string, metric: string, value: number];
const METRICS = ['soc', 'ac_in', 'bat_vol', 'bat_amp', 'total_out', 'pv_total', 'mppt_hv_temp', 'pack1_soc', 'pack1_temp', 'pack1_vol_max_mv', 'pack1_vol_min_mv', 'pack1_remain_cap_mah'];

function makeStore(devices: Record<string, unknown> = {}) {
  const ee = new EventEmitter() as any;
  ee.snap = { generatedAt: 0, devices };
  ee.get = () => ee.snap;
  return ee;
}
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(DB_PATH);
  try { return fn(db); } finally { db.close(); }
}
function reset(rows: Row[]) {
  for (const f of ['telemetry-gaps.json', '.clean-shutdown']) if (existsSync(join(tmp, f))) unlinkSync(join(tmp, f));
  if (!existsSync(DB_PATH)) createRecorder(makeStore(), () => {}).close();
  withDb((db) => {
    db.exec('DELETE FROM samples; DELETE FROM held_samples; DELETE FROM held_spans; DELETE FROM held_scan; DELETE FROM held_generation;');
    db.exec('DROP TRIGGER IF EXISTS fail_one_slice;');
    const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const r of rows) ins.run(...r);
    db.exec('COMMIT');
  });
}
const all = (table: 'samples' | 'held_samples', sn?: string): Row[] => withDb((db) =>
  (db.prepare(`SELECT ts, sn, metric, value FROM ${table} ${sn ? 'WHERE sn = ?' : ''} ORDER BY sn, metric, ts`).all(...(sn ? [sn] : [])) as any[])
    .map((r) => [Number(r.ts), String(r.sn), String(r.metric), Number(r.value)] as Row));
const key = (r: Row) => r.join('|');

/** A live Core: every metric written each minute, every value moving. */
function live(sn: string, fromMs: number, toMs: number, k0 = 0): Row[] {
  const out: Row[] = [];
  for (let t = fromMs, k = k0; t <= toMs; t += MIN, k++) {
    METRICS.forEach((m, i) => out.push([t, sn, m, 100 + i * 10 + (k % 17) + i / 100]));
  }
  return out;
}
/** Held: every metric restated every 5 minutes (staggered by a few seconds each) at the value of
 *  its last row in `before` — the pre-v1.188.1 heartbeat on a projection nothing refreshed. */
function held(sn: string, before: Row[], fromMs: number, toMs: number, metrics = METRICS): Row[] {
  const lastVal = new Map<string, number>();
  for (const r of before) if (r[1] === sn) lastVal.set(r[2], r[3]);
  const out: Row[] = [];
  for (let t = fromMs; t <= toMs; t += 5 * MIN) metrics.forEach((m, i) => out.push([t + i * 1_000, sn, m, lastVal.get(m)!]));
  return out;
}

const CORE_A = 'COREXXX00XXX0001'; // held for 3 h after a 2 h outage
const CORE_B = 'COREXXX00XXX0002'; // idle but live: heartbeats only, one value drifting
const CORE_C = 'COREXXX00XXX0003'; // frozen for 40 min only
const GEN_D = 'GENEXXX00XXX0004';  // only seven metrics restated for 3 h
const CORE_E = 'COREXXX00XXX0005'; // a 3 h GAP, then live again

function incident(T0: number) {
  const lastFresh = T0 + 2 * H;
  const a1 = live(CORE_A, T0, lastFresh);
  const a = [...a1, ...held(CORE_A, a1, lastFresh + 2 * H, lastFresh + 5 * H), ...live(CORE_A, lastFresh + 5 * H + 5 * MIN, lastFresh + 6 * H, 500)];
  const b: Row[] = [];
  for (let t = T0, k = 0; t <= T0 + 8 * H; t += 5 * MIN, k++) METRICS.forEach((m, i) => b.push([t, CORE_B, m, i === 4 ? 1_000 + k * 0.01 : 50 + i]));
  const c1 = live(CORE_C, T0, lastFresh);
  const c = [...c1, ...held(CORE_C, c1, lastFresh + 5 * MIN, lastFresh + 40 * MIN), ...live(CORE_C, lastFresh + 45 * MIN, lastFresh + 2 * H, 900)];
  // Twelve metrics while live, seven restated after: under the eight a stretch needs.
  const d1 = live(GEN_D, T0, lastFresh);
  const d = [...d1, ...held(GEN_D, d1, lastFresh + 5 * MIN, lastFresh + 3 * H, METRICS.slice(0, 7))];
  const e = [...live(CORE_E, T0, lastFresh), ...live(CORE_E, lastFresh + 3 * H, lastFresh + 4 * H, 0)];
  const w: Row[] = [];
  for (let t = T0; t <= T0 + 8 * H; t += H) for (const m of ['ghi_wm2', 'cloud_pct', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6']) w.push([t, 'weather', m, 0]);
  // A synthetic series written every 5 min with nothing moving (the night-charge chart overlay):
  // it would qualify as frozen, and it is never scanned.
  for (let t = T0; t <= T0 + 8 * H; t += 5 * MIN) for (let i = 0; i < 9; i++) w.push([t, 'night_charge', `overlay_${i}`, 40 + i]);
  return { lastFresh, heldA: a.filter((r) => r[0] > lastFresh && r[0] <= lastFresh + 5 * H + 11_000), rows: [...a, ...b, ...c, ...d, ...e, ...w] };
}

function boot(t: TestContext, nowMs: number) {
  t.mock.method(Date, 'now', () => nowMs);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  return { rec, lines };
}

test('★★★ a held stretch is moved, unchanged, to held_samples — nothing else is touched and nothing is deleted', (t) => {
  const T0 = phx(2026, 10, 14, 20, 0);
  const { lastFresh, heldA, rows } = incident(T0);
  reset(rows);
  const before = all('samples');
  const { rec, lines } = boot(t, T0 + 10 * H);
  try {
    const sum = rec.scanHeldSamples!(T0 + 10 * H);
    assert.equal(sum.full, true, 'the first scan covers the retention window');
    assert.equal(sum.spans, 1, `only CORE_A held: ${lines.join('\n')}`);
    assert.equal(sum.rowsMoved, heldA.length);
    const moved = all('held_samples');
    assert.deepEqual(moved.map(key).sort(), heldA.map(key).sort(), '★★★ exactly the restated rows, byte for byte');
    const after = all('samples');
    assert.equal(after.length + moved.length, before.length, '★★★ non-destructive: every row is in one table or the other');
    assert.deepEqual([...after, ...moved].map(key).sort(), before.map(key).sort());
    assert.ok(after.some((r) => r[1] === CORE_A && r[0] === lastFresh), 'the last FRESH reading stays (the span is exclusive at its start)');
    for (const sn of [CORE_B, CORE_C, GEN_D, CORE_E, 'weather', 'night_charge']) {
      assert.deepEqual(all('samples', sn), before.filter((r) => r[1] === sn), `${sn} untouched`);
    }
    const spans = rec.heldSpans!(T0, T0 + 10 * H);
    assert.equal(spans.length, 1);
    assert.deepEqual({ sn: spans[0].sn, startMs: spans[0].startMs, reason: spans[0].reason, rows: spans[0].rows },
      { sn: CORE_A, startMs: lastFresh, reason: 'frozen', rows: heldA.length });
    assert.equal(spans[0].endMs, Math.max(...heldA.map((r) => r[0])));
    const line = lines.find((l) => l.includes('HELD SAMPLES'));
    assert.ok(line && line.includes(CORE_A) && line.includes('kept, not deleted, and restorable'), String(line));
    // ac_in held at 111.01 W from the first restatement (2 h after the last fresh reading, past the
    // outage gap the counters did not bridge) for 3 h: 0.33 kWh.
    assert.match(line!, /about 0\.3 kWh of ac_in/, 'the held flow the lifetime counters integrated is estimated once, never rewritten');
    assert.ok(lines.some((l) => /held-sample scan \(first, over the retention window\) done in \d+ s — 1 held stretch\(es\), \d+ row\(s\) moved to held_samples \(none deleted\)/.test(l)), lines.join('\n'));
  } finally { rec.close(); }
});

test('★★★ every read the learners, scorers and charts use sees the hold as a gap — the integrals no longer count the held flow', (t) => {
  const T0 = phx(2026, 10, 14, 20, 0);
  const { lastFresh, rows } = incident(T0);
  reset(rows);
  const { rec } = boot(t, T0 + 10 * H);
  try {
    const from = lastFresh + 1;
    const to = lastFresh + 5 * H + 20_000;
    const heldFlow = integrateWh(rec.query(CORE_A, 'ac_in', from - 10 * MIN, to), from, to);
    assert.ok(heldFlow.wh > 300 && heldFlow.coverageMs > 2.9 * H, `precondition: the held 111 W was integrated for ~3 h (${heldFlow.wh.toFixed(0)} Wh)`);
    rec.scanHeldSamples!(T0 + 10 * H);
    assert.deepEqual(rec.query(CORE_A, 'ac_in', from, to), [], 'query()');
    assert.deepEqual(rec.query(CORE_A, 'ac_in', from, to, 300), [], 'the bucketed AVG (charts, hour curves)');
    assert.deepEqual(rec.queryFirstLast!(CORE_A, 'pack1_remain_cap_mah', from, to), [], 'queryFirstLast() (counter deltas)');
    for (const [m, pts] of rec.queryMulti(CORE_A, ['pv_total', 'ac_in', 'bat_vol'], from, to)) assert.deepEqual(pts, [], `queryMulti() ${m}`);
    const after = integrateWh(rec.query(CORE_A, 'ac_in', from - 10 * MIN, to), from, to);
    assert.equal(after.wh, 0, '★★★ no held energy is integrated');
    assert.equal(after.coverageMs, 0, 'and the coverage gates see the hours as uncovered');
  } finally { rec.close(); }
});

test('★★ idempotent: a second scan, hourly or full, moves nothing more', (t) => {
  const T0 = phx(2026, 10, 14, 20, 0);
  const { heldA, rows } = incident(T0);
  reset(rows);
  const { rec } = boot(t, T0 + 10 * H);
  try {
    assert.equal(rec.scanHeldSamples!(T0 + 10 * H).rowsMoved, heldA.length);
    const snap = all('samples').map(key).join('\n');
    const hourly = rec.scanHeldSamples!(T0 + 11 * H);
    assert.equal(hourly.full, false);
    assert.deepEqual([hourly.spans, hourly.rowsMoved], [0, 0]);
    withDb((db) => db.exec('DELETE FROM held_scan'));
    const full = rec.scanHeldSamples!(T0 + 11 * H);
    assert.equal(full.full, true);
    assert.deepEqual([full.spans, full.rowsMoved], [0, 0], '★★ the gap the move left is not a hold: it has no restated rows');
    assert.equal(all('samples').map(key).join('\n'), snap);
    assert.equal(all('held_samples').length, heldA.length);
  } finally { rec.close(); }
});

test('★★★ reversible: a restore puts every row back unchanged, and no later scan moves that span again', (t) => {
  const T0 = phx(2026, 10, 14, 20, 0);
  const { lastFresh, rows } = incident(T0);
  reset(rows);
  const original = all('samples');
  const { rec, lines } = boot(t, T0 + 10 * H);
  try {
    const n = rec.scanHeldSamples!(T0 + 10 * H).rowsMoved;
    assert.equal(rec.restoreHeldSamples!(CORE_A, lastFresh), n);
    assert.deepEqual(all('samples').map(key).sort(), original.map(key).sort(), '★★★ byte-identical');
    assert.equal(all('held_samples').length, 0);
    assert.deepEqual(rec.heldSpans!(T0, T0 + 10 * H), [], 'a restored span is not a held span');
    withDb((db) => db.exec('DELETE FROM held_scan'));
    assert.equal(rec.scanHeldSamples!(T0 + 11 * H).rowsMoved, 0, '★★ the restored stretch is left in samples');
    assert.ok(lines.some((l) => l.includes('was restored earlier — left in samples')));
    assert.equal(rec.restoreHeldSamples!(CORE_A, lastFresh + 1), 0, 'no such span: nothing restored');
  } finally { rec.close(); }
});

test('★ an hourly scan extends a hold still running from where the last move stopped', (t) => {
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + H;
  const a1 = live(CORE_A, T0, lastFresh);
  reset([...a1, ...held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 4 * H)]);
  const { rec } = boot(t, lastFresh + 4 * H);
  try {
    // Scanned 10 min after the newest restatement: the scan reads all of them.
    const firstAt = lastFresh + 4 * H + 10 * MIN;
    const first = rec.scanHeldSamples!(firstAt);
    assert.equal(first.spans, 1);
    const kept = all('samples', CORE_A).filter((r) => r[0] > lastFresh);
    assert.ok(kept.length > 0, '★ rows younger than 15 min stay until the next scan (the lifetime rollup re-reads its last 10 min)');
    assert.ok(kept.every((r) => r[0] > firstAt - HELD_MOVE_MIN_AGE_MS), 'and only those');
    // An hour later the slip-through hold is still being restated (a REST replay the gate cannot see).
    withDb((db) => {
      const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
      for (const r of held(CORE_A, a1, lastFresh + 4 * H + 5 * MIN, lastFresh + 5 * H)) ins.run(...r);
    });
    const second = rec.scanHeldSamples!(lastFresh + 5 * H + 20 * MIN);
    assert.equal(second.full, false);
    assert.equal(second.spans, 1);
    assert.deepEqual(all('samples', CORE_A).filter((r) => r[0] > lastFresh), [], 'the rest of the hold is moved');
    const spans = rec.heldSpans!(T0, T0 + 10 * H);
    assert.equal(spans.length, 1, 'still ONE span, from the same last fresh reading');
    assert.equal(spans[0].startMs, lastFresh);
    assert.equal(spans[0].rows, all('held_samples', CORE_A).length);
  } finally { rec.close(); }
});

test('★★★ the deploy replay: a Core still held at boot is moved in two scans, then measured from its last FRESH sample', (t) => {
  // v1.188.0 restated the held Core up to the minute before the deploy; v1.188.1's gate writes
  // nothing after it. The first scan (a minute after boot) leaves the newest 15 min; the hourly
  // scan moves that tail — one or two restatements per metric, too few to qualify on its own — as
  // the continuation of the span the first scan moved.
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + H;
  const BOOT = lastFresh + 9 * H;
  const PANEL = 'PANEXXX00XXX0001';
  const a1 = live(CORE_A, T0, lastFresh);
  const p: Row[] = [];
  for (let ts = T0; ts <= BOOT - MIN; ts += MIN) p.push([ts, PANEL, 'panel_load', 1_000 + (ts / MIN) % 97]);
  reset([...a1, ...held(CORE_A, a1, lastFresh + 5 * MIN, BOOT - 2 * MIN), ...p]);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  const panelReads = () => rec.insertSnapshot({ generatedAt: now, devices: { [PANEL]: { sn: PANEL, lastTelemetryAtMs: now, projection: { kind: 'shp2', circuits: [{ ch: 1, watts: 900 + (now / MIN) % 50 }], pairedCircuits: [], sources: [], sourceWatts: [], gridWatt: 0 } } } } as any);
  try {
    now = BOOT + MIN;
    rec.scanHeldSamples!(now);
    const tail = all('samples', CORE_A).filter((r) => r[0] > lastFresh);
    assert.ok(tail.length > 0 && tail.every((r) => r[0] > now - HELD_MOVE_MIN_AGE_MS), 'the newest 15 min wait for the next scan');
    panelReads();
    assert.deepEqual(rec.telemetryGaps().filter((x) => x.sn === CORE_A), [], 'its seeded clock is still the last held row');
    now = BOOT + H + MIN;
    rec.scanHeldSamples!(now);
    assert.deepEqual(all('samples', CORE_A).filter((r) => r[0] > lastFresh), [], '★★ the tail is moved as the same hold');
    const spans = rec.heldSpans!(T0, now);
    assert.equal(spans.length, 1, 'one span, from the last fresh reading');
    assert.equal(spans[0].startMs, lastFresh);
    panelReads();
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1, '★★★ the held Core is ledgered within the hour, not 6 h after its last held row');
    assert.equal(g[0].startMs, lastFresh, 'from its last fresh sample — the row a later boot\'s seed reads, so it extends this record');
  } finally { rec.close(); }
});

test('a stretch too short to qualify, with no span before it, is left alone', (t) => {
  const T0 = phx(2026, 10, 15, 0, 0);
  const a1 = live(CORE_A, T0, T0 + H);
  reset([...a1, ...held(CORE_A, a1, T0 + H + 5 * MIN, T0 + H + 50 * MIN), ...live(CORE_A, T0 + H + 55 * MIN, T0 + 2 * H, 300)]);
  const { rec } = boot(t, T0 + 3 * H);
  try {
    assert.equal(rec.scanHeldSamples!(T0 + 3 * H).rowsMoved, 0);
  } finally { rec.close(); }
});

test('★★ in the add-on the scan starts by itself a minute after boot, one step per timer tick, and the capture waits for it', (t) => {
  const T0 = phx(2026, 10, 14, 20, 0);
  const { heldA, rows } = incident(T0);
  reset(rows);
  const NOW = T0 + 10 * H;
  process.env.RECORDER_HELD_SCAN = 'on';
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(Date, 'now', () => NOW);
  try {
    const lines: string[] = [];
    const rec = createRecorder(makeStore(), (m) => lines.push(m));
    try {
      assert.equal(rec.heldSamplesReady!(), false, '★★ a scanning process is not ready before its first scan: the ledger capture waits');
      t.mock.timers.tick(59_000);
      assert.equal(all('held_samples').length, 0, 'not before a minute');
      t.mock.timers.tick(1_000);
      let ticks = 0;
      while (!rec.heldSamplesReady!() && ticks < 1_000) { t.mock.timers.tick(5); ticks++; }
      assert.equal(rec.heldSamplesReady!(), true, lines.join('\n'));
      // Five devices, each read in two six-hour chunks from its OLDEST row (v1.188.1 dry run: not
      // from the 30-day retention horizon, 120 chunks each), and CORE_A's hold in four one-hour
      // slices: one per tick.
      assert.ok(ticks >= 5 * 2 + 4, `one device-chunk or one move slice per tick (${ticks} ticks)`);
      assert.equal(all('held_samples').length, heldA.length);
    } finally { rec.close(); }
  } finally {
    delete process.env.RECORDER_HELD_SCAN;
  }
});

test('outside the add-on nothing is scanned unless asked, and the capture does not wait; RECORDER_HELD_SCAN=off stops it in the add-on', (t) => {
  const T0 = phx(2026, 10, 14, 20, 0);
  const { rows } = incident(T0);
  reset(rows);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(Date, 'now', () => T0 + 10 * H);
  for (const env of [{}, { SUPERVISOR_TOKEN: 'test-token', RECORDER_HELD_SCAN: 'off' }] as Array<Record<string, string>>) {
    Object.assign(process.env, env);
    try {
      const rec = createRecorder(makeStore(), () => {});
      try {
        assert.equal(rec.heldSamplesReady!(), true, JSON.stringify(env));
        t.mock.timers.tick(2 * H);
        assert.equal(all('held_samples').length, 0, JSON.stringify(env));
      } finally { rec.close(); }
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  }
});

test('createFrozenScanner — a change closes a stretch; restatements, metrics and length all have to qualify', () => {
  const opts = { minSpanMs: H, minRestatements: 3, minMetrics: 2 };
  const prev = new Map([['a', 1], ['b', 2]]);
  const rowsAt = (ts: number, a: number, b: number) => [{ metric: 'a', ts, value: a }, { metric: 'b', ts, value: b }];
  const s1 = createFrozenScanner(prev, 0, opts);
  for (let k = 1; k <= 13; k++) s1.feed(rowsAt(k * 5 * MIN, 1, 2));
  const out1 = s1.finish().filter((x) => x.qualifies);
  assert.equal(out1.length, 1);
  assert.deepEqual([out1[0].startMs, out1[0].endMs, out1[0].restatements, out1[0].metrics], [0, 65 * MIN, 13, 2]);
  const s2 = createFrozenScanner(prev, 0, opts);
  for (let k = 1; k <= 13; k++) s2.feed(rowsAt(k * 5 * MIN, 1, k === 7 ? 3 : 2));
  const out2 = s2.finish();
  assert.equal(out2.length, 2, 'one metric moving once splits it in two…');
  assert.ok(out2.every((x) => !x.qualifies), '…and neither is long enough');
  const s3 = createFrozenScanner(prev, 0, opts);
  s3.feed(rowsAt(10 * MIN, 1, 2));
  s3.feed(rowsAt(70 * MIN, 1, 2));
  // v1.188.1 (review 2) — an hour with no rows is a HOLE (up to HELD_RETURN_GAP_MS): one stretch
  // across it, its observed time the 10 min before it only. (The dry run had split it in two.)
  assert.deepEqual(s3.finish().map((x) => [x.startMs, x.firstHeldMs, x.endMs, x.restatements, x.observedMs, x.qualifies]),
    [[0, 10 * MIN, 70 * MIN, 2, 10 * MIN, false]], 'a hole does not end a stretch; two restatements are not three');
  // A minute longer is a SILENCE: the row after it is a return piece that never qualified on its
  // own, a return reading, and the stretch ends at its last restated row before the silence.
  const s3b = createFrozenScanner(prev, 0, opts);
  s3b.feed(rowsAt(10 * MIN, 1, 2));
  s3b.feed(rowsAt(71 * MIN, 1, 2));
  assert.deepEqual(s3b.finish().map((x) => [x.startMs, x.firstHeldMs, x.endMs, x.restatements, x.qualifies]),
    [[0, 10 * MIN, 10 * MIN, 1, false]], 'a silence ends it; the return reading is not a stretch');
  const s4 = createFrozenScanner(new Map(), null, opts);
  for (let k = 0; k <= 13; k++) s4.feed(rowsAt(k * 5 * MIN, 1, 2));
  const out4 = s4.finish();
  assert.equal(out4[0]?.startMs, 0, 'with no prior rows the first row is new content: the stretch starts there');
  assert.equal(out4[0]?.qualifies, true);
  const s5 = createFrozenScanner(new Map([['a', 1]]), 0, opts);
  s5.feed([{ metric: 'a', ts: H, value: 2 }]);
  assert.deepEqual(s5.finish(), [], 'a gap followed by new content: no restated rows, no stretch');
});

/* ══ v1.188.1 review ════════════════════════════════════════════════════════ */

test('★★ createFrozenScanner — a gap with no rows is not observed constancy', () => {
  const opts = { minSpanMs: H, minRestatements: 3, minMetrics: 2 };
  const prev = new Map([['a', 1], ['b', 2]]);
  const rowsAt = (ts: number) => [{ metric: 'a', ts, value: 1 }, { metric: 'b', ts, value: 2 }];
  assert.equal(FROZEN_DEFAULTS.bridgeMs, HELD_ROW_BRIDGE_MS);
  assert.equal(HELD_ROW_BRIDGE_MS, 10 * MIN, 'two heartbeats, integrateWh\'s own bridge');
  // A genuinely constant device back from a 55-min gap, three heartbeats identical to before it.
  const s1 = createFrozenScanner(prev, 0, opts);
  for (const ts of [55 * MIN, 60 * MIN, 65 * MIN]) s1.feed(rowsAt(ts));
  const [g1] = s1.finish();
  assert.equal(g1.restatements, 3);
  assert.equal(g1.qualifies, false, '★★★ 10 min observed, not 65: its fresh rows are not a hold');
  // The same after a 2 h gap with 30 min of restatements (a replayed body, or a constant device):
  // deliberately not caught until an hour of restatement has been observed.
  const s2 = createFrozenScanner(prev, 0, opts);
  for (let ts = 2 * H; ts <= 2 * H + 30 * MIN; ts += 5 * MIN) s2.feed(rowsAt(ts));
  // v1.188.1 (review 2) — after a 2 h silence these rows are a return piece: not a stretch until it
  // has qualified on its own, and left as return readings if it never does.
  assert.deepEqual(s2.finish(), [], '30 min of restatement after a gap: not yet (return readings)');
  const s3 = createFrozenScanner(prev, 0, opts);
  for (let ts = 2 * H; ts <= 3 * H + 5 * MIN; ts += 5 * MIN) s3.feed(rowsAt(ts));
  const [g3] = s3.finish();
  assert.equal(g3.qualifies, true, '★★ an hour of restatement after the gap: a hold, from the last change before it');
  assert.deepEqual([g3.startMs, g3.firstHeldMs, g3.endMs], [0, 2 * H, 3 * H + 5 * MIN]);
  // Intervals up to the bridge count; a restart's 20-min hole inside a hold does not.
  const s4 = createFrozenScanner(prev, 0, opts);
  for (let ts = 10 * MIN; ts <= 70 * MIN; ts += 10 * MIN) s4.feed(rowsAt(ts));
  assert.equal(s4.finish()[0].qualifies, true, 'rows 10 min apart (exactly the bridge) are an observed hour');
  const s5 = createFrozenScanner(prev, 0, opts);
  for (const ts of [5, 10, 15, 20, 40, 45, 50, 55, 60, 65].map((m) => m * MIN)) s5.feed(rowsAt(ts));
  assert.deepEqual(s5.finish().map((x) => [x.startMs, x.endMs, x.observedMs, x.qualifies]), [[0, 65 * MIN, 45 * MIN, false]],
    'a 20-min hole inside the stretch is not counted (65 − 20 = 45 min observed), and does not end it');
  // v1.188.1 (review 2) — the observed time on both sides of a hole adds up: 40 + 35 min is a hold.
  const s5b = createFrozenScanner(prev, 0, opts);
  for (let ts = 5 * MIN; ts <= 40 * MIN; ts += 5 * MIN) s5b.feed(rowsAt(ts));
  for (let ts = 60 * MIN; ts <= 95 * MIN; ts += 5 * MIN) s5b.feed(rowsAt(ts));
  const [g5b] = s5b.finish();
  assert.deepEqual([g5b.startMs, g5b.firstHeldMs, g5b.endMs, g5b.observedMs, g5b.qualifies], [0, 5 * MIN, 95 * MIN, 75 * MIN, true],
    '★★ two parts of one hold, neither an hour, add up across the 20-min hole');
  assert.deepEqual(g5b.observed, [[0, 40 * MIN], [60 * MIN, 95 * MIN]], 'the observed runs, the hole between them');
  // An observed hour in which no metric is restated three times (each metric twice, in turn).
  const s6 = createFrozenScanner(new Map([['a', 1], ['b', 2], ['c', 3]]), 0, opts);
  ([['a', 1], ['a', 1], ['b', 2], ['b', 2], ['c', 3], ['c', 3]] as Array<[string, number]>)
    .forEach(([metric, value], k) => s6.feed([{ metric, ts: (k + 1) * 10 * MIN, value }]));
  const [g6] = s6.finish();
  assert.deepEqual([g6.restatements, g6.metrics, g6.endMs], [2, 3, 60 * MIN]);
  assert.equal(g6.qualifies, false, '★ an hour observed, but no metric restated three times');
  // Two 40-min quiet stretches split by one change: each is its own stretch, neither an hour.
  const s7 = createFrozenScanner(prev, 0, opts);
  for (let ts = 5 * MIN; ts <= 40 * MIN; ts += 5 * MIN) s7.feed(rowsAt(ts));
  s7.feed([{ metric: 'a', ts: 45 * MIN, value: 5 }, { metric: 'b', ts: 45 * MIN, value: 2 }]);
  for (let ts = 50 * MIN; ts <= 85 * MIN; ts += 5 * MIN) s7.feed([{ metric: 'a', ts, value: 5 }, { metric: 'b', ts, value: 2 }]);
  const out7 = s7.finish();
  assert.deepEqual(out7.map((x) => [x.startMs, x.qualifies]), [[0, false], [45 * MIN, false]], '★ the second does not inherit the first\'s observed time');
});

test('★★★ a constant Core back from a 55-min gap with identical heartbeats keeps its rows', (t) => {
  const T0 = phx(2026, 10, 16, 1, 0);
  // Idle at night: every metric constant, restated every 5 min, for 2 h before the gap.
  const quiet = (from: number, to: number) => {
    const out: Row[] = [];
    for (let ts = from; ts <= to; ts += 5 * MIN) METRICS.forEach((m, i) => out.push([ts + i * 1_000, CORE_B, m, 50 + i]));
    return out;
  };
  const first = [...live(CORE_B, T0 - 10 * MIN, T0), ...quiet(T0 + 5 * MIN, T0 + 40 * MIN)];
  // Gap 40 → 95 min (offline in the cloud: the gate wrote nothing); back at 95 min with the same values.
  const back = quiet(T0 + 95 * MIN, T0 + 105 * MIN);
  const after = live(CORE_B, T0 + 110 * MIN, T0 + 3 * H, 400);
  reset([...first, ...back, ...after]);
  const before = all('samples', CORE_B);
  const { rec, lines } = boot(t, T0 + 4 * H);
  try {
    const sum = rec.scanHeldSamples!(T0 + 4 * H);
    assert.deepEqual([sum.spans, sum.rowsMoved], [0, 0], lines.join('\n'));
    assert.deepEqual(all('samples', CORE_B), before, '★★★ nothing moved');
    assert.deepEqual(rec.heldSpans!(T0 - H, T0 + 4 * H), [], 'no frozen span (its night is not refused for it)');
    assert.ok(!lines.some((l) => l.includes('HELD SAMPLES')));
  } finally { rec.close(); }
});

/** A trigger that aborts the move of one slice: held rows of `sn` in (fromMs, toMs]. */
function failSlice(sn: string, fromMs: number, toMs: number) {
  withDb((db) => db.exec(`CREATE TRIGGER fail_one_slice BEFORE INSERT ON held_samples
    WHEN NEW.sn = '${sn}' AND NEW.ts > ${fromMs} AND NEW.ts <= ${toMs}
    BEGIN SELECT RAISE(ABORT, 'simulated SQLITE_FULL'); END;`));
}
const healFault = () => withDb((db) => db.exec('DROP TRIGGER IF EXISTS fail_one_slice;'));

test('★★★ a failed move slice is retried by the next scan, from the span\'s last fresh reading', (t) => {
  // A 6 h hold found by the FIRST (full) scan; its third slice fails.
  const T0 = phx(2026, 10, 10, 0, 0);
  const lastFresh = T0 + H;
  const a1 = live(CORE_A, T0, lastFresh);
  const heldRows = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 6 * H);
  reset([...a1, ...heldRows, ...live(CORE_A, lastFresh + 6 * H + 5 * MIN, lastFresh + 7 * H, 300)]);
  const NOW = phx(2026, 10, 15, 0, 0); // five days later: far behind any incremental re-read
  const { rec, lines } = boot(t, NOW);
  try {
    failSlice(CORE_A, lastFresh + 2 * H, lastFresh + 3 * H);
    const first = rec.scanHeldSamples!(NOW);
    assert.equal(first.full, true);
    assert.ok(first.rowsMoved > 0 && first.rowsMoved < heldRows.length, `precondition: a partial move (${first.rowsMoved} of ${heldRows.length})`);
    assert.equal(Number(withDb((db) => (db.prepare('SELECT scanned_to_ts AS w FROM held_scan WHERE id = 1').get() as any).w)), lastFresh,
      '★★ the watermark stops at the failed span\'s last fresh reading');
    const fail = lines.find((l) => l.includes('held-sample move FAILED'));
    assert.ok(fail && fail.includes(`re-reads ${CORE_A} from ${new Date(lastFresh).toISOString()}`), String(fail));
    healFault();
    const second = rec.scanHeldSamples!(NOW + H);
    assert.equal(second.full, false, 'an hourly scan …');
    assert.equal(first.rowsMoved + second.rowsMoved, heldRows.length, '★★★ … moves the rest of the span: v1.188.1 before review left it in samples for good');
    assert.deepEqual(all('samples', CORE_A).filter((r) => r[0] > lastFresh && r[0] <= lastFresh + 6 * H + 11_000), []);
    const spans = rec.heldSpans!(T0, NOW + H);
    assert.equal(spans.length, 1, `still ONE span: ${JSON.stringify(spans)}`);
    assert.equal(spans[0].startMs, lastFresh, 'from the last fresh reading');
    assert.equal(spans[0].rows, heldRows.length);
    assert.equal(lines.filter((l) => l.includes('HELD SAMPLES')).length, 1, 'announced once');
    const watermark = () => Number(withDb((db) => (db.prepare('SELECT scanned_to_ts AS w FROM held_scan WHERE id = 1').get() as any).w));
    assert.equal(watermark(), NOW + H, '★ the retry succeeded, so the watermark moves on (a fault is not remembered for ever)');
    assert.deepEqual([rec.scanHeldSamples!(NOW + 2 * H).rowsMoved], [0], 'and then idempotent');
  } finally { rec.close(); }
});

test('★★ a hold whose FIRST slice failed is found whole by the next scan', (t) => {
  const T0 = phx(2026, 10, 10, 0, 0);
  const lastFresh = T0 + H;
  const a1 = live(CORE_A, T0, lastFresh);
  const heldRows = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 4 * H);
  reset([...a1, ...heldRows]);
  const NOW = phx(2026, 10, 15, 0, 0);
  const { rec } = boot(t, NOW);
  try {
    failSlice(CORE_A, lastFresh, lastFresh + H);
    const first = rec.scanHeldSamples!(NOW);
    assert.equal(first.rowsMoved, 0, 'the first slice rolled back, so the rest were dropped');
    assert.deepEqual(rec.heldSpans!(T0, NOW), [], 'and no span was logged');
    healFault();
    assert.equal(rec.scanHeldSamples!(NOW + H).rowsMoved, heldRows.length, '★★ the next scan moves all of it');
    const spans = rec.heldSpans!(T0, NOW + H);
    assert.deepEqual(spans.map((s) => [s.startMs, s.rows]), [[lastFresh, heldRows.length]]);
  } finally { rec.close(); }
});

test('★★ a failed slice of a RECENT hold is re-read from its last fresh reading, not from a held row', (t) => {
  // The 3 h overlap alone would re-read from inside the failed region: its anchor would be a held
  // restatement, a second span opened at that row and the failed slice left in samples.
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + H;
  const a1 = live(CORE_A, T0, lastFresh);
  reset([...a1, ...held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 5 * H)]);
  const NOW = lastFresh + 5 * H + 30 * MIN;
  const { rec, lines } = boot(t, NOW);
  try {
    failSlice(CORE_A, lastFresh + H, lastFresh + 2 * H);
    rec.scanHeldSamples!(NOW);
    healFault();
    rec.scanHeldSamples!(NOW + H);
    assert.deepEqual(all('samples', CORE_A).filter((r) => r[0] > lastFresh), [], '★★ every held row moved');
    const spans = rec.heldSpans!(T0, NOW + H);
    assert.deepEqual(spans.map((s) => s.startMs), [lastFresh], '★★ one span, from the last fresh reading');
    assert.equal(lines.filter((l) => l.includes('HELD SAMPLES')).length, 1);
  } finally { rec.close(); }
});

test('★★★ the samples generation moves with every move and restore, and the read recorder sees it', (t) => {
  const T0 = phx(2026, 10, 14, 20, 0);
  const { lastFresh, rows } = incident(T0);
  reset(rows);
  const { rec } = boot(t, T0 + 10 * H);
  const rr = createReadRecorder(DB_PATH);
  try {
    assert.equal(rec.samplesGeneration!(), 0, 'before any move');
    assert.equal(rr.samplesGeneration!(), 0);
    rec.scanHeldSamples!(T0 + 10 * H);
    const g1 = rr.samplesGeneration!();
    assert.ok(g1 > 0, '★★★ a move advances it, on the worker\'s connection too');
    assert.equal(rec.samplesGeneration!(), g1);
    rec.scanHeldSamples!(T0 + 11 * H);
    assert.equal(rr.samplesGeneration!(), g1, 'a scan that moves nothing leaves it');
    rec.restoreHeldSamples!(CORE_A, lastFresh);
    assert.ok(rr.samplesGeneration!() > g1, '★★ a restore advances it');
  } finally { rr.close(); rec.close(); }
});
