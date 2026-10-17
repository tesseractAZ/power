/**
 * v1.188.1 review round 4 — the held-sample store and scanner.
 *
 *  1. A restore gives back the HOLD, not only the rows an earlier scan had moved. Matched on overlap
 *     with the restored range alone, a restore made while the device still restated its readings
 *     held only until the 3 h re-read started after the restored end: each hourly scan's anchor was
 *     then a restated row of the same hold, and the rest of it was moved as a new span (a second
 *     HELD SAMPLES line, the ledger refusing those hours again), while a boot scan after a stop left
 *     the same rows. A stretch anchored on a row of a restored span now continues it: it is left in
 *     samples and the span's end follows it, qualifying in the scan's window or not.
 *  2. The documented cadence limit: a hold whose restatements stay more than a bridge apart
 *     throughout is left WHOLE by the hourly scans (no 3 h re-read holds an observed hour); the
 *     first scan, which reads the whole history, moves it. A dense hold after a sparse start loses
 *     only its first rows.
 *  3. A moved span's sub-hour tail followed by a silence is not re-anchored at its own last row
 *     (that row is moved): a replay after the silence extends the same span, and every onMoved
 *     start is a row kept in samples.
 *  4. A return piece that never qualified ends at a fresh change: the quiet rows after the change
 *     are a new stretch, not its continuation.
 *  5. The held-flow estimate: a joined return piece carries its held values, and a flow held at
 *     0 W integrates nothing.
 *  6. (review round 5) Where a restored hold ends: a return reading after a silence that another
 *     silence follows starts a new stretch, and the restore's log line says so. The restored-span
 *     reads (restoredSpans, restoredSpanFrom).
 * Fake serials throughout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHeldSamples, HELD_MOVE_MIN_AGE_MS } from '../src/heldSamples.js';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);

type Row = [ts: number, sn: string, metric: string, value: number];
const SN = 'COREXXX00XXX0004';
const M12 = ['soc', 'ac_in', 'bat_vol', 'bat_amp', 'total_out', 'pv_total', 'mppt_hv_temp', 'pack1_soc', 'pack1_temp', 'pack1_vol_max_mv', 'pack1_vol_min_mv', 'pack1_remain_cap_mah'];
const iso = (ms: number) => new Date(ms).toISOString();

function memDb(rows: Row[] = []): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE samples (ts INTEGER NOT NULL, sn TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL);
    CREATE INDEX idx_samples_sn_metric_ts ON samples (sn, metric, ts); CREATE INDEX idx_samples_ts ON samples (ts);`);
  insert(db, rows);
  return db;
}
function insert(db: DatabaseSync, rows: Row[]) {
  if (rows.length === 0) return;
  const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const r of rows) ins.run(...r);
  db.exec('COMMIT');
}
/** Every metric each minute, every value moving; `val` carries the last values on. */
function liveGroups(fromMs: number, toMs: number, val: Map<string, number>): Row[] {
  const out: Row[] = [];
  let k = 0;
  for (let t = fromMs; t <= toMs; t += MIN) for (const m of M12) { val.set(m, (val.get(m) ?? 100) + 1 + (k++ % 5)); out.push([t, SN, m, val.get(m)!]); }
  return out;
}
/** One group of every metric at each of `times`, at the last values. */
const restated = (times: number[], val: Map<string, number>): Row[] => times.flatMap((t) => M12.map((m): Row => [t, SN, m, val.get(m)!]));
const every5 = (from: number, to: number) => { const o: number[] = []; for (let t = from; t <= to; t += 5 * MIN) o.push(t); return o; };
/** Restatements in 55-min cycles 5, 5, 15, 15, 15 min apart: 10 min of observed constancy a cycle. */
function sparse(from: number, to: number): number[] {
  const steps = [5, 5, 15, 15, 15];
  const o: number[] = [];
  for (let t = from, i = 0; t <= to; t += steps[i++ % steps.length] * MIN) o.push(t);
  return o;
}
const countIn = (db: DatabaseSync, table: string, fromMs: number, toMs: number) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sn = ? AND ts >= ? AND ts <= ?`).get(SN, fromMs, toMs) as { n: number }).n);
const total = (db: DatabaseSync, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

/** A store over `db` whose clock is `clock.now`; its log lines and onMoved calls are kept. */
function store(db: DatabaseSync, clock: { now: number }) {
  const lines: string[] = [];
  const moved: Array<[number, number]> = [];
  const hs = createHeldSamples(db, {
    log: (m) => lines.push(m), retainMs: 400 * DAY, isExcludedSn: () => false, listSns: () => [SN], listMetrics: () => M12,
    now: () => clock.now, onMoved: (_sn, s, e) => moved.push([s, e]),
  });
  return { hs, lines, moved };
}
const frozenSpans = (db: DatabaseSync) => (db.prepare("SELECT start_ts, end_ts, rows, restored_at_ms FROM held_spans WHERE sn = ? AND reason = 'frozen' ORDER BY start_ts").all(SN) as any[])
  .map((r) => ({ startMs: Number(r.start_ts), endMs: Number(r.end_ts), rows: Number(r.rows), restored: r.restored_at_ms != null }));

/* ══ 1. a restore gives back the hold ══════════════════════════════════════ */

/** Live to X, then the same reading restated every 5 min for 10 h: one unbroken hold. */
function runningHold() {
  const T0 = phx(2026, 10, 10, 8, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + H, val);
  const X = T0 + H;
  const hold = restated(every5(X + 5 * MIN, X + 10 * H), val);
  return { X, rows: [...fresh, ...hold].sort((a, b) => a[0] - b[0]), heldRows: hold.length };
}
/** Scans at each of `scans` (rows land as they would have been written), the span from X restored
 *  right after the scan at `restoreAfter`. */
function cadence(scans: number[], restoreAfter: number) {
  const { X, rows, heldRows } = runningHold();
  const db = memDb();
  const clock = { now: scans[0] };
  const { hs, lines } = store(db, clock);
  let i = 0;
  let restoredRows = 0;
  for (const at of scans) {
    const batch: Row[] = [];
    while (i < rows.length && rows[i][0] <= at) batch.push(rows[i++]);
    insert(db, batch);
    clock.now = at;
    hs.scanNow(at);
    if (at === restoreAfter) restoredRows = hs.restore(SN, X);
  }
  return { X, db, hs, lines, heldRows, restoredRows };
}

for (const [label, scansOf] of [
  ['hourly', (X: number) => Array.from({ length: 11 }, (_, k) => X + (k + 1) * H)],
  ['a stop, then a boot scan and an hourly one', (X: number) => [X + H, X + 2 * H, X + 10 * H, X + 11 * H]],
  ['a 3 h stop in the middle', (X: number) => [X + H, X + 2 * H, X + 3 * H, X + 6 * H, X + 7 * H, X + 8 * H, X + 9 * H, X + 10 * H, X + 11 * H]],
] as const) {
  test(`★★★ a hold restored while it runs stays in samples to its end, at any cadence (${label})`, () => {
    const { X } = runningHold();
    const { db, hs, lines, heldRows, restoredRows } = cadence(scansOf(X), X + 2 * H);
    assert.ok(restoredRows > 0, 'precondition: the X + 2 h scan had moved part of the hold, and the restore gave it back');
    assert.equal(total(db, 'held_samples'), 0, `★★★ nothing of the hold is moved again: ${JSON.stringify(frozenSpans(db).map((s) => [iso(s.startMs), iso(s.endMs), s.rows]))}`);
    assert.equal(countIn(db, 'samples', X + 1, X + 10 * H), heldRows, 'every restated row is in samples');
    const spans = frozenSpans(db);
    assert.equal(spans.length, 1, `one span, the restored one: ${JSON.stringify(spans)}`);
    assert.ok(spans[0].restored && spans[0].startMs === X, 'from X, restored');
    assert.equal(spans[0].endMs, X + 10 * H, '★★ its end follows the hold to its last restated row');
    assert.deepEqual(hs.spans(X - DAY, X + DAY), [], '★★ no held span for the ledger');
    assert.equal(lines.filter((l) => l.includes('HELD SAMPLES')).length, 1, `★★ one HELD SAMPLES line, the move the restore undid: ${lines.filter((l) => l.includes('HELD SAMPLES')).join('\n')}`);
    const cont = lines.filter((l) => l.includes('that was restored earlier — left in samples'));
    assert.equal(cont.length, 1, `★ the continuation is logged once per process, not every hour: ${cont.join('\n')}`);
    assert.ok(cont[0].includes(`is part of the span from ${iso(X)} that was restored earlier`), cont[0]);
  });
}

test('★★ a restored hold that resumes after a silence of more than 3 h is still the restored hold, at any cadence', () => {
  // Restated to X + 3 h (moved by the X + 3 h scan, then restored), silent 4 h, then the same
  // readings replayed for 2 h, then a change. The hourly scan after the replay's first hour is
  // anchored on the restored hold's last row (its end), with nothing of the hold in its window.
  const T0 = phx(2026, 10, 11, 20, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + H, val);
  const X = T0 + H;
  const hold = restated(every5(X + 5 * MIN, X + 3 * H), val);
  const replay = restated(every5(X + 7 * H, X + 9 * H), val);
  const after = liveGroups(X + 9 * H + 5 * MIN, X + 9 * H + 20 * MIN, val);
  const rows = [...fresh, ...hold, ...replay, ...after].sort((a, b) => a[0] - b[0]);
  for (const scans of [Array.from({ length: 9 }, (_, k) => X + (k + 3) * H), [X + 3 * H, X + 11 * H, X + 12 * H]]) {
    const db = memDb();
    const clock = { now: scans[0] };
    const { hs, lines } = store(db, clock);
    let i = 0;
    for (const at of scans) {
      const batch: Row[] = [];
      while (i < rows.length && rows[i][0] <= at) batch.push(rows[i++]);
      insert(db, batch);
      clock.now = at;
      hs.scanNow(at);
      if (at === X + 3 * H) assert.ok(hs.restore(SN, X) > 0, 'precondition: restored');
    }
    const label = scans.length > 3 ? 'hourly' : 'a stop';
    assert.equal(total(db, 'held_samples'), 0, `★★ ${label}: the replay is the restored hold's: ${JSON.stringify(frozenSpans(db).map((x) => [iso(x.startMs), iso(x.endMs), x.rows]))}`);
    assert.equal(lines.filter((l) => l.includes('HELD SAMPLES')).length, 1, `${label}: ${lines.filter((l) => l.includes('HELD SAMPLES')).join('\n')}`);
  }
});

test('★★ a sparse continuation of a restored hold (never an observed hour in a 3 h re-read) is kept by the restore too, so a later boot scan leaves it', () => {
  // Dense restatements to X + 2 h (moved, then restored), then the same readings in 55-min cycles
  // (10 min observed a cycle) to X + 20 h. The hourly re-reads from the X + 6 h scan on see under an
  // hour of observed constancy; the boot scan after the stop (X + 10 h → X + 20 h) reads 13 h of it,
  // which does qualify, from an anchor (X + 7 h) past the end of what the qualifying re-reads saw.
  const T0 = phx(2026, 10, 11, 8, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + H, val);
  const X = T0 + H;
  const dense = restated(every5(X + 5 * MIN, X + 2 * H), val);
  const thin = restated(sparse(X + 2 * H + 5 * MIN, X + 20 * H), val);
  const rows = [...fresh, ...dense, ...thin].sort((a, b) => a[0] - b[0]);
  const db = memDb();
  const clock = { now: X + H };
  const { hs, lines } = store(db, clock);
  let i = 0;
  for (const at of [...Array.from({ length: 10 }, (_, k) => X + (k + 1) * H), X + 20 * H, X + 21 * H]) {
    const batch: Row[] = [];
    while (i < rows.length && rows[i][0] <= at) batch.push(rows[i++]);
    insert(db, batch);
    clock.now = at;
    hs.scanNow(at);
    if (at === X + 2 * H) assert.ok(hs.restore(SN, X) > 0, 'precondition: restored');
  }
  assert.equal(total(db, 'held_samples'), 0, `★★ nothing moved after the restore: ${JSON.stringify(frozenSpans(db).map((s) => [iso(s.startMs), iso(s.endMs), s.rows]))}`);
  assert.equal(lines.filter((l) => l.includes('HELD SAMPLES')).length, 1, lines.filter((l) => l.includes('HELD SAMPLES')).join('\n'));
  assert.equal(frozenSpans(db).length, 1);
});

test('★ a hold that changes after its restored span ends is a new hold: the restore does not reach past the change', () => {
  const T0 = phx(2026, 10, 12, 8, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + H, val);
  const X = T0 + H;
  const hold1 = restated(every5(X + 5 * MIN, X + 3 * H), val);
  const C = X + 3 * H + MIN;
  const change = liveGroups(C, C, val);
  const hold2 = restated(every5(C + 5 * MIN, C + 3 * H), val);
  const rows = [...fresh, ...hold1, ...change, ...hold2].sort((a, b) => a[0] - b[0]);
  const db = memDb();
  const clock = { now: X + 2 * H };
  const { hs } = store(db, clock);
  let i = 0;
  for (let at = X + 2 * H; at <= C + 4 * H; at += H) {
    const batch: Row[] = [];
    while (i < rows.length && rows[i][0] <= at) batch.push(rows[i++]);
    insert(db, batch);
    clock.now = at;
    hs.scanNow(at);
    if (at === X + 2 * H) assert.ok(hs.restore(SN, X) > 0, 'precondition: restored');
  }
  const spans = frozenSpans(db);
  assert.deepEqual(spans.map((s) => [s.startMs, s.restored]), [[X, true], [C, false]], `the second hold, from the change, is moved: ${JSON.stringify(spans)}`);
  assert.equal(spans[0].endMs, X + 3 * H, 'the restored span ends at the last restated row before the change');
  assert.equal(total(db, 'held_samples'), hold2.length, 'all of the second hold');
});

/* ══ 2. the documented cadence limit ══════════════════════════════════════ */

test('★ the cadence limit as documented: the hourly scans leave a uniformly sparse hold WHOLE; the first scan moves it', () => {
  const T0 = phx(2026, 10, 13, 8, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + H, val);
  const X = T0 + H;
  const thin = restated(sparse(X + 5 * MIN, X + 10 * H), val);
  const after = liveGroups(X + 10 * H + 5 * MIN, X + 10 * H + 20 * MIN, val);
  const rows = [...fresh, ...thin, ...after].sort((a, b) => a[0] - b[0]);
  // One scan at the end: the first, over the whole history.
  {
    const db = memDb(rows);
    const clock = { now: X + 12 * H };
    const { hs } = store(db, clock);
    assert.equal(hs.scanNow(X + 12 * H).rowsMoved, thin.length, 'the first scan moves it whole');
  }
  // Hourly from X + 1 h: the first scan reads little of it; no later re-read holds an observed hour.
  {
    const db = memDb();
    const clock = { now: X + H };
    const { hs } = store(db, clock);
    let i = 0;
    let moved = 0;
    for (let at = X + H; at <= X + 12 * H; at += H) {
      const batch: Row[] = [];
      while (i < rows.length && rows[i][0] <= at) batch.push(rows[i++]);
      insert(db, batch);
      clock.now = at;
      moved += hs.scanNow(at).rowsMoved;
    }
    assert.equal(moved, 0, '★ none of it: not only its first restated rows');
    assert.equal(countIn(db, 'samples', X + 1, X + 10 * H), thin.length);
  }
});

test('the cadence limit\'s other case: a dense hold after a sparse start loses only its first rows to the hourly scans', () => {
  const T0 = phx(2026, 10, 13, 20, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + H, val);
  const X = T0 + H;
  const thin = restated(sparse(X + 5 * MIN, X + 5 * H), val);
  const dense = restated(every5(X + 5 * H + 5 * MIN, X + 10 * H), val);
  const after = liveGroups(X + 10 * H + 5 * MIN, X + 10 * H + 20 * MIN, val);
  const rows = [...fresh, ...thin, ...dense, ...after].sort((a, b) => a[0] - b[0]);
  const db = memDb();
  const clock = { now: X + H };
  const { hs } = store(db, clock);
  let i = 0;
  for (let at = X + H; at <= X + 12 * H; at += H) {
    const batch: Row[] = [];
    while (i < rows.length && rows[i][0] <= at) batch.push(rows[i++]);
    insert(db, batch);
    clock.now = at;
    hs.scanNow(at);
  }
  const kept = countIn(db, 'samples', X + 1, X + 10 * H);
  assert.ok(kept > 0 && kept < thin.length, `its first rows stay as the anchor (${kept} of ${thin.length} sparse rows)`);
  assert.equal(countIn(db, 'held_samples', X + 5 * H + 5 * MIN, X + 10 * H), dense.length, 'the dense part is moved');
});

/* ══ 3. a moved span's tail, a silence, a replay ═══════════════════════════ */

test('★★ a moved span\'s tail, a silence, then a replay that qualifies: one span, and every onMoved start is a row kept in samples', () => {
  const T0 = phx(2026, 10, 9, 2, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + 30 * MIN, val);
  const X = T0 + 30 * MIN;
  const hold = restated(every5(X + 5 * MIN, X + 3 * H), val);
  const tail = restated(every5(X + 3 * H + 5 * MIN, X + 3 * H + 15 * MIN), val); // too young for the first scan
  const R0 = X + 5 * H + 15 * MIN; // a 2 h silence after the tail
  const replay = restated(every5(R0, R0 + 75 * MIN), val);
  const after = liveGroups(R0 + 76 * MIN, R0 + 90 * MIN, val);
  const db = memDb([...fresh, ...hold, ...tail, ...replay, ...after]);
  const clock = { now: X + 3 * H + 16 * MIN };
  const { hs, lines, moved } = store(db, clock);
  hs.scanNow(clock.now);
  assert.ok(moved.length > 0 && moved.every(([s]) => s === X), 'precondition: the first scan moved the hold from X');
  assert.ok(countIn(db, 'samples', X + 3 * H + 5 * MIN, X + 3 * H + 15 * MIN) > 0, 'precondition: its tail waits');
  clock.now = R0 + 2 * H;
  hs.scanNow(clock.now);
  const kept = new Set((db.prepare('SELECT DISTINCT ts FROM samples WHERE sn = ?').all(SN) as any[]).map((r) => Number(r.ts)));
  for (const [s] of moved) assert.ok(kept.has(s), `★★ onMoved start ${iso(s)} is a row kept in samples (the gap clock is set to it)`);
  assert.deepEqual([...new Set(moved.map(([s]) => s))], [X], 'every move names X');
  assert.deepEqual(frozenSpans(db).map((s) => s.startMs), [X], '★★ one span, from X: the replay is not a second one from a moved row');
  assert.equal(lines.filter((l) => l.includes('HELD SAMPLES')).length, 1, lines.filter((l) => l.includes('HELD SAMPLES')).join('\n'));
  assert.equal(countIn(db, 'samples', X + 1, R0 + 75 * MIN), 0, 'no held row left');
});

/* ══ 4. a return piece that never qualified, then a fresh change ═══════════ */

test('★★ a pending return piece ends at a fresh change: the quiet rows of a live device after it stay in samples', () => {
  const T0 = phx(2026, 10, 8, 2, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + 30 * MIN, val);
  const F = T0 + 30 * MIN;
  const R0 = F + 2 * H; // a 2 h silence
  const ret = restated(every5(R0, R0 + 50 * MIN), val); // a 50-min return piece: never an hour
  const C = R0 + 51 * MIN;
  const change = liveGroups(C, C, val); // a fresh reading: every value moves
  const quiet = restated(every5(C + 5 * MIN, C + 15 * MIN), val); // 15 quiet minutes
  const after = liveGroups(C + 16 * MIN, C + 40 * MIN, val);
  const db = memDb([...fresh, ...ret, ...change, ...quiet, ...after]);
  const clock = { now: C + 3 * H };
  const { hs } = store(db, clock);
  const sum = hs.scanNow(clock.now);
  assert.equal(sum.rowsMoved, 0, '★★ nothing here is a hold');
  assert.equal(countIn(db, 'samples', C + 5 * MIN, C + 15 * MIN), quiet.length, 'the 15 quiet minutes after the change stay');
  assert.equal(countIn(db, 'samples', R0, R0 + 50 * MIN), ret.length, 'and so does the return piece');
});

/* ══ 5. the held-flow estimate ═════════════════════════════════════════════ */

test('★ a return piece that joins on its last group carries its held values into the estimate', () => {
  // The last fresh reading has pv_total 6 kW; 2 h with no rows; then exactly an hour restated (a
  // replay that qualifies on its last group, so no row after the join adds a value), then a change.
  const T0 = phx(2026, 10, 14, 10, 0);
  const val = new Map<string, number>();
  const F = T0 + H;
  const filtered = liveGroups(T0, F, val).map((r): Row => (r[0] === F && r[2] === 'pv_total' ? [r[0], r[1], r[2], 6_000] : r));
  val.set('pv_total', 6_000);
  const ret = restated(every5(F + 2 * H, F + 3 * H), val);
  const after = liveGroups(F + 3 * H + 5 * MIN, F + 4 * H, val);
  const db = memDb([...filtered, ...ret, ...after]);
  const clock = { now: F + 8 * H };
  const { hs, lines } = store(db, clock);
  assert.equal(hs.scanNow(clock.now).rowsMoved, ret.length, 'precondition: the replay is moved');
  const line = lines.find((l) => l.includes('HELD SAMPLES')) ?? '';
  assert.match(line, /6\.0 kWh of pv_total/, `★ an hour observed at 6 kW: ${line}`);
});

test('★ a flow held at 0 W is not stated as integrated energy', () => {
  const T0 = phx(2026, 10, 14, 20, 0);
  const val = new Map<string, number>();
  const F = T0 + H;
  const filtered = liveGroups(T0, F, val).map((r): Row => (r[0] === F && r[2] === 'pv_total' ? [r[0], r[1], r[2], 0] : r));
  val.set('pv_total', 0);
  const hold = restated(every5(F + 5 * MIN, F + 3 * H), val);
  const after = liveGroups(F + 3 * H + 5 * MIN, F + 4 * H, val);
  const db = memDb([...filtered, ...hold, ...after]);
  const clock = { now: F + 6 * H };
  const { hs, lines } = store(db, clock);
  assert.equal(hs.scanNow(clock.now).rowsMoved, hold.length);
  const line = lines.find((l) => l.includes('HELD SAMPLES')) ?? '';
  assert.match(line, /kWh of ac_in/, `precondition: a held flow above 0 is stated: ${line}`);
  assert.doesNotMatch(line, /kWh of pv_total/, `★ 0 W held is no energy: ${line}`);
});

/* ══ review round 5: where a restored hold ends ═══════════════════════════════ */

test('★ a restored hold, a silence, one return reading equal to it, another silence, a replay: the replay is a new hold at any cadence, and the restore says so', () => {
  // The scanner's own rule (createFrozenScanner): after a return reading that another silence
  // follows, the stretch starts again from that reading. A restore gives back the hold up to there,
  // not past it; its log line promised more ("the rest of its hold … will not be excluded again").
  const T0 = phx(2026, 10, 11, 20, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + H, val);
  const X = T0 + H;
  const hold = restated(every5(X + 5 * MIN, X + 3 * H), val);
  const ret = restated([X + 5 * H], val);
  const replay = restated(every5(X + 7 * H + 30 * MIN, X + 9 * H + 30 * MIN), val);
  const after = liveGroups(X + 9 * H + 35 * MIN, X + 9 * H + 50 * MIN, val);
  const rows = [...fresh, ...hold, ...ret, ...replay, ...after].sort((a, b) => a[0] - b[0]);
  for (const scans of [Array.from({ length: 10 }, (_, k) => X + (k + 3) * H), [X + 3 * H, X + 11 * H, X + 12 * H]]) {
    const db = memDb();
    const clock = { now: scans[0] };
    const { hs, lines } = store(db, clock);
    let i = 0;
    for (const at of scans) {
      const batch: Row[] = [];
      while (i < rows.length && rows[i][0] <= at) batch.push(rows[i++]);
      insert(db, batch);
      clock.now = at;
      hs.scanNow(at);
      if (at === X + 3 * H) assert.ok(hs.restore(SN, X) > 0, 'precondition: restored');
    }
    const label = scans.length > 3 ? 'hourly' : 'a stop';
    const spans = frozenSpans(db);
    assert.deepEqual(spans.map((x) => [x.startMs, x.restored]), [[X, true], [X + 5 * H, false]], `${label}: ${JSON.stringify(spans.map((x) => [iso(x.startMs), iso(x.endMs), x.rows]))}`);
    assert.equal(total(db, 'held_samples'), replay.length, `${label}: the replay is moved, the return reading stays`);
    const line = lines.find((l) => l.includes('restored') && l.includes('held sample(s)')) ?? '';
    assert.ok(line.includes('the hold ends when a reading changes, or when the device comes back from a silence of more than an hour with a return reading and falls silent again (a later replay is then a new hold)'),
      `★ ${label}: the restore states where the hold it gives back ends: ${line}`);
  }
});

test('★ restoredSpans lists the restored spans over a window, and only those; restoredSpanFrom finds one by its start', () => {
  const T0 = phx(2026, 10, 13, 8, 0);
  const val = new Map<string, number>();
  const fresh = liveGroups(T0, T0 + H, val);
  const X = T0 + H;
  const hold = restated(every5(X + 5 * MIN, X + 3 * H), val);
  const after = liveGroups(X + 3 * H + 5 * MIN, X + 3 * H + 20 * MIN, val);
  const db = memDb([...fresh, ...hold, ...after]);
  const clock = { now: X + 5 * H };
  const { hs } = store(db, clock);
  assert.equal(hs.scanNow(clock.now).rowsMoved, hold.length, 'precondition: moved');
  assert.deepEqual(hs.restoredSpans(X - DAY, X + DAY), [], 'nothing restored yet');
  assert.equal(hs.restoredSpanFrom(SN, X), null);
  assert.equal(hs.spans(X - DAY, X + DAY).length, 1, 'precondition: held');
  assert.ok(hs.restore(SN, X) > 0);
  const r = hs.restoredSpans(X - DAY, X + DAY);
  assert.deepEqual(r.map((x) => [x.sn, x.startMs, x.reason, x.restoredAtMs != null]), [[SN, X, 'frozen', true]], '★ the restored span');
  assert.deepEqual(hs.restoredSpans(X + 4 * H, X + DAY), [], 'outside the window: none');
  assert.deepEqual(hs.restoredSpanFrom(SN, X), { startMs: X, endMs: r[0].endMs });
  assert.equal(hs.restoredSpanFrom(SN, X + MIN), null, 'by its exact start');
  assert.deepEqual(hs.spans(X - DAY, X + DAY), [], 'and no longer held');
});

void HELD_MOVE_MIN_AGE_MS;
