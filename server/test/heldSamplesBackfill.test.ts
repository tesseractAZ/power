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
const { createFrozenScanner, HELD_MOVE_MIN_AGE_MS } = await import('../src/heldSamples.js');

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
    db.exec('DELETE FROM samples; DELETE FROM held_samples; DELETE FROM held_spans; DELETE FROM held_scan;');
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
    for (const sn of [CORE_B, CORE_C, GEN_D, CORE_E, 'weather']) {
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
      assert.ok(ticks > 20, `one device-day or one move slice per tick (${ticks} ticks)`);
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
  assert.deepEqual(s3.finish().map((x) => x.qualifies), [false], 'two restatements are not three');
  const s4 = createFrozenScanner(new Map(), null, opts);
  for (let k = 0; k <= 13; k++) s4.feed(rowsAt(k * 5 * MIN, 1, 2));
  const out4 = s4.finish();
  assert.equal(out4[0]?.startMs, 0, 'with no prior rows the first row is new content: the stretch starts there');
  assert.equal(out4[0]?.qualifies, true);
  const s5 = createFrozenScanner(new Map([['a', 1]]), 0, opts);
  s5.feed([{ metric: 'a', ts: H, value: 2 }]);
  assert.deepEqual(s5.finish(), [], 'a gap followed by new content: no restated rows, no stretch');
});
