/**
 * v1.188.1 dry-run follow-ups — what a run of the real scan over a copy of the live database
 * (28,978,553 rows) found, each pinned here with fake serials:
 *
 *  1. A device-gap record filed from the PRE-MOVE seed (the Core's last held row) was not matched
 *     by the next boot, whose seed reads the kept last fresh row: a second record and a second
 *     pushed warning per Core still dark. The record is re-dated to the last fresh reading when its
 *     start row is moved, and a later, overlapping record of the same device is extended; the
 *     alert id stays the one already delivered.
 *  2. The finishing step of each device looked a held span up for every stretch the device had
 *     (100 k–486 k lookups, 1.6–5.4 s of the alarm thread per device on the Pi), and the scanner
 *     kept every stretch until the device finished (+190–360 MB). One read per device; only
 *     candidates are kept.
 *  3. A restated group after a gap with no rows did not end the stretch: a Core back after 9.8
 *     silent days with one group equal to its held values had that fresh reading moved, and the
 *     span claimed the whole silence.
 *  4. The text: the held-flow estimate counts observed time only; a fleet silence the gate explains
 *     names what was held, not a broker stall.
 *  6. The first scan starts each device at its oldest row, not at the retention horizon.
 * (5, the SQL restore recipe and its samples-generation bump, is documentation: architecture 4.4.)
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

const tmp = mkdtempSync(join(tmpdir(), 'ef-held-dryrun-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(tmp, 'shadow-witness.json');
const DB_PATH = join(tmp, 'ecoflow.db');
const GAPS_PATH = join(tmp, 'telemetry-gaps.json');

const { createRecorder } = await import('../src/recorder.js');
const { HELD_SAMPLES_SQL, HELD_SPANS_SQL, HELD_SCAN_CHUNK_MS } = await import('../src/heldSamples.js');
const { outageAlerts, deviceGapCount } = await import('../src/alerts.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const OPTS = { enabled: true, recentWindowMs: 24 * H, minDurationMs: 15 * MIN, restartMinDurationMs: 5 * MIN };

type Row = [ts: number, sn: string, metric: string, value: number];
const METRICS = ['soc', 'ac_in', 'bat_vol', 'bat_amp', 'total_out', 'pv_total', 'mppt_hv_temp', 'pack1_soc', 'pack1_temp', 'pack1_vol_max_mv', 'pack1_vol_min_mv', 'pack1_remain_cap_mah'];
const CORE_A = 'COREXXX00XXX0001';
const CORE_B = 'COREXXX00XXX0002';
const QUIET = 'COREXXX00XXX0007';
const PANEL = 'PANEXXX00XXX0001';

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
function reset(rows: Row[]) {
  for (const f of [GAPS_PATH, join(tmp, '.clean-shutdown')]) if (existsSync(f)) unlinkSync(f);
  if (!existsSync(DB_PATH)) createRecorder(makeStore(), () => {}).close();
  if (existsSync(GAPS_PATH)) unlinkSync(GAPS_PATH);
  withDb((db) => {
    db.exec('DELETE FROM samples; DELETE FROM held_samples; DELETE FROM held_spans; DELETE FROM held_scan; DELETE FROM held_generation;');
    const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const r of rows) ins.run(...r);
    db.exec('COMMIT');
  });
}
const samplesOf = (sn: string, fromMs = -Infinity, toMs = Infinity): Row[] => withDb((db) =>
  (db.prepare('SELECT ts, sn, metric, value FROM samples WHERE sn = ? ORDER BY ts, metric').all(sn) as any[])
    .map((r) => [Number(r.ts), String(r.sn), String(r.metric), Number(r.value)] as Row)
    .filter((r) => r[0] > fromMs && r[0] <= toMs));
const heldCount = () => Number(withDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM held_samples').get() as any).n));

/** A live device: every metric each minute, every value moving. */
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
/** One group of every metric at `ts`, equal to the last values in `before` (a return reading). */
function equalGroup(sn: string, before: Row[], ts: number): Row[] {
  const lastVal = new Map<string, number>();
  for (const r of before) if (r[1] === sn) lastVal.set(r[2], r[3]);
  return METRICS.map((m) => [ts, sn, m, lastVal.get(m)!] as Row);
}
function panelRows(fromMs: number, toMs: number): Row[] {
  const out: Row[] = [];
  for (let t = fromMs; t <= toMs; t += 5 * MIN) out.push([t, PANEL, 'panel_load', 1_000 + (t / MIN) % 97]);
  return out;
}
/** A fresh panel reading through the recorder's own write path: runs the per-device sweep. */
const panelReads = (rec: ReturnType<typeof createRecorder>, now: number) => rec.insertSnapshot({
  generatedAt: now,
  devices: { [PANEL]: { sn: PANEL, deviceName: 'Smart Home Panel 2', lastTelemetryAtMs: now, projection: { kind: 'shp2', circuits: [{ ch: 1, watts: 900 + (now / MIN) % 50 }], pairedCircuits: [], sources: [], sourceWatts: [], gridWatt: 0 } } },
} as any);
const names: Record<string, string> = { [CORE_A]: 'Core 1', [CORE_B]: 'Core 2', [PANEL]: 'Smart Home Panel 2' };
const nameOf = (sn: string) => names[sn];
const deviceAlertIds = (gaps: unknown[], now: number) =>
  outageAlerts(JSON.parse(JSON.stringify(gaps)), now, OPTS, nameOf).filter((a) => a.id.startsWith('system-outage-device-')).map((a) => a.id).sort();

/* ══ 1. one blackout, one record, one alert id ══════════════════════════════ */

test('★★★ a device-gap record filed from the pre-move seed is extended at the next restart — one record, the same alert id', (t) => {
  // What tonight's deploy finds: v1.188.0 filed each still-dark Core's record from its last HELD row
  // (the seed before the move); the scan has since moved the held rows, so this boot's seed reads
  // the Core's last FRESH row, 40 h earlier.
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + 2 * H;
  const heldEnd = lastFresh + 40 * H;
  const BOOT = heldEnd + 7 * H;
  reset([...live(CORE_A, T0, lastFresh), ...live(CORE_B, T0, lastFresh), ...panelRows(T0, BOOT - MIN)]);
  const filedEnd = heldEnd + 6 * H + 3 * MIN;
  const before = [CORE_A, CORE_B].map((sn) => ({ startMs: heldEnd, endMs: filedEnd, durationMs: filedEnd - heldEnd, detectedAt: filedEnd, sn }));
  writeFileSync(GAPS_PATH, JSON.stringify(before));
  const idsBefore = deviceAlertIds(before, BOOT);
  assert.equal(idsBefore.length, 2);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    const gaps = rec.telemetryGaps();
    for (const sn of [CORE_A, CORE_B]) {
      const d = gaps.filter((g) => g.sn === sn);
      assert.equal(d.length, 1, `★★★ ${sn}: one record, not a second from the earlier seed: ${JSON.stringify(d)}`);
      assert.equal(d[0].startMs, lastFresh, '★★ re-dated to its last fresh reading: it has delivered nothing fresh since');
      assert.equal(d[0].alertStartMs, heldEnd, 'the start it was first filed with, which keys its alert id');
      assert.equal(d[0].endMs, now);
      assert.equal(d[0].durationMs, now - lastFresh);
    }
    assert.deepEqual(deviceAlertIds(gaps, now), idsBefore, '★★★ the same alert ids: nothing new is pushed or digested');
    assert.equal(deviceGapCount(gaps, now, 24 * H), 2, '★★ Device Telemetry Gaps 24h stays 2 (it doubled)');
    const a = outageAlerts(JSON.parse(JSON.stringify(gaps)), now, OPTS, nameOf).find((x) => x.device === 'Core 1')!;
    const startText = new Date(lastFresh).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    assert.ok(a.detail.includes(`(${startText} → `), `★★ the pushed start is the last fresh reading: ${a.detail}`);
    assert.ok(lines.some((l) => l.includes(`DEVICE TELEMETRY GAP — ${CORE_A}`) && l.includes(`re-dated from ${new Date(heldEnd).toISOString()}`)), lines.join('\n'));
  } finally { rec.close(); }
  // And the restart after that: the exact start now, still one record and the same id.
  now = BOOT + 3 * H;
  const rec2 = createRecorder(makeStore(), () => {});
  try {
    now += MIN;
    panelReads(rec2, now);
    const gaps = rec2.telemetryGaps();
    assert.deepEqual([CORE_A, CORE_B].map((sn) => gaps.filter((g) => g.sn === sn).length), [1, 1]);
    assert.deepEqual(deviceAlertIds(gaps, now), idsBefore);
  } finally { rec2.close(); }
});

test('★★★ the move re-dates a record this boot filed from a held row; the next boot extends it — one record, no second alert', (t) => {
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + 2 * H;
  const heldEnd = lastFresh + 40 * H;
  const BOOT = heldEnd + 7 * H;
  const a1 = live(CORE_A, T0, lastFresh);
  const heldA = held(CORE_A, a1, lastFresh + 5 * MIN, heldEnd);
  const lastHeldRow = Math.max(...heldA.map((r) => r[0]));
  reset([...a1, ...heldA, ...panelRows(T0, BOOT - MIN)]);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  let ids: string[] = [];
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    const filed = rec.telemetryGaps().filter((g) => g.sn === CORE_A);
    assert.equal(filed.length, 1, 'precondition: filed from the seed, before the scan');
    assert.equal(filed[0].startMs, lastHeldRow, 'precondition: the seed was the last held row');
    ids = deviceAlertIds(rec.telemetryGaps(), now);
    now = BOOT + 2 * MIN;
    const sum = rec.scanHeldSamples!(now);
    assert.equal(sum.rowsMoved, heldA.length);
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1);
    assert.equal(g[0].startMs, lastFresh, '★★★ re-dated by the move itself, before any restart');
    assert.equal(g[0].alertStartMs, lastHeldRow);
    assert.equal(g[0].durationMs, g[0].endMs - lastFresh);
    assert.deepEqual(deviceAlertIds(rec.telemetryGaps(), now), ids, '★★★ the same alert id');
    assert.ok(lines.some((l) => l.includes(`device telemetry gap of ${CORE_A} re-dated from ${new Date(lastHeldRow).toISOString()} to ${new Date(lastFresh).toISOString()}, its newest row left in samples`)), lines.join('\n'));
    const persisted = JSON.parse(readFileSync(GAPS_PATH, 'utf8')) as Array<{ sn?: string; startMs: number }>;
    assert.equal(persisted.find((x) => x.sn === CORE_A)?.startMs, lastFresh, 'persisted, so the next boot reads it');
  } finally { rec.close(); }
  now = BOOT + 4 * H;
  const rec2 = createRecorder(makeStore(), () => {});
  try {
    now += MIN;
    panelReads(rec2, now);
    const g = rec2.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1, `★★★ one record after the restart: ${JSON.stringify(g)}`);
    assert.equal(g[0].endMs, now, 'extended to this boot');
    assert.deepEqual(deviceAlertIds(rec2.telemetryGaps(), now), ids, '★★★ no second notify: the id is the one already delivered');
  } finally { rec2.close(); }
});

test('★★★ the first scan over history: a current record is re-dated to its own hold\'s last fresh reading, never to an older span\'s', (t) => {
  // Core 2 on the live database: a held span in August and another in October. The August span's
  // slices are moved first; a record filed from October's last held row lies after them.
  const T0 = phx(2026, 10, 1, 0, 0);
  const f1 = T0 + H;
  const a1 = live(CORE_A, T0, f1);
  const oldHeld = held(CORE_A, a1, f1 + 5 * MIN, f1 + 5 * H);
  const f2 = T0 + 5 * DAY;
  const a2 = live(CORE_A, f1 + 5 * H + 5 * MIN, f2, 300);
  const curHeld = held(CORE_A, a2, f2 + 5 * MIN, f2 + 40 * H);
  const lastHeldRow = Math.max(...curHeld.map((r) => r[0]));
  const BOOT = f2 + 47 * H;
  reset([...a1, ...oldHeld, ...a2, ...curHeld, ...panelRows(T0, BOOT - MIN)]);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    assert.equal(rec.telemetryGaps().find((g) => g.sn === CORE_A)?.startMs, lastHeldRow, 'precondition: filed from the last held row');
    now = BOOT + 2 * MIN;
    const sum = rec.scanHeldSamples!(now);
    assert.equal(sum.spans, 2, 'both holds are moved');
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1);
    assert.equal(g[0].startMs, f2, `★★★ its own hold's last fresh reading, not the August one (${new Date(g[0].startMs).toISOString()})`);
  } finally { rec.close(); }
});

test('★★ a device that came back and went dark again is a second blackout: a second record', (t) => {
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + 2 * H;
  const BOOT = lastFresh + 10 * H;
  reset([...live(CORE_A, T0, lastFresh), ...panelRows(T0, BOOT - MIN)]);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  const coreReads = () => rec.insertSnapshot({ generatedAt: now, devices: { [CORE_A]: { sn: CORE_A, lastTelemetryAtMs: now, projection: { kind: 'generic', soc: 50 + (now / MIN) % 40, inWatts: 1, outWatts: 2, pvWatts: 3, acInWatts: 4, acOutWatts: 5, temp: 20 } } } } as any);
  try {
    now += MIN;
    panelReads(rec, now);
    assert.equal(rec.telemetryGaps().filter((g) => g.sn === CORE_A).length, 1, 'precondition: the first blackout');
    now += MIN;
    coreReads();
    const back = now;
    for (let i = 0; i < 7 * 12; i++) { now += 5 * MIN; panelReads(rec, now); }
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 2, `★★ a second record from its return, not the first extended: ${JSON.stringify(g)}`);
    assert.equal(g[0].startMs, lastFresh, 'the first is untouched');
    assert.equal(g[1].startMs, back);
  } finally { rec.close(); }
});

/* ══ 2 + 6. bounded work ════════════════════════════════════════════════════ */

/** Counts calls of the held scan's statements (the statements themselves are the real ones). */
function countStatements(t: TestContext) {
  const counts = { frozenOf: 0, chunkRows: 0, minTs: 0 };
  const orig = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const st = orig.call(this, sql) as any;
    if (sql === HELD_SPANS_SQL.frozenOf) return { all: (...a: any[]) => { counts.frozenOf++; return st.all(...a); } };
    if (sql === HELD_SAMPLES_SQL.chunkRows) return { all: (...a: any[]) => { counts.chunkRows++; return st.all(...a); } };
    if (sql === HELD_SAMPLES_SQL.minTs) return { get: (...a: any[]) => { counts.minTs++; return st.get(...a); } };
    return st;
  });
  return counts;
}

test('★★ bounded work: one held-span read per device per scan, only candidate stretches kept, the first scan from each device\'s oldest row', (t) => {
  // QUIET: two days of a live Core whose one moving metric changes every other heartbeat, so a
  // one-row stretch closes every 10 minutes (288 of them); CORE_A: one 3 h hold.
  const T0 = phx(2026, 10, 12, 0, 0);
  const quiet: Row[] = [];
  for (let k = 0, ts = T0; ts <= T0 + 2 * DAY; k++, ts += 5 * MIN) METRICS.forEach((m, i) => quiet.push([ts, QUIET, m, i === 0 ? 50 + Math.floor(k / 2) : 60 + i]));
  const lastFresh = T0 + 2 * DAY - 6 * H;
  const a1 = live(CORE_A, lastFresh - H, lastFresh);
  const heldA = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 3 * H);
  reset([...quiet, ...a1, ...heldA, ...live(CORE_A, lastFresh + 3 * H + 5 * MIN, lastFresh + 4 * H, 500)]);
  const NOW = T0 + 2 * DAY + H;
  t.mock.method(Date, 'now', () => NOW);
  const counts = countStatements(t);
  const rec = createRecorder(makeStore(), () => {});
  try {
    const sum = rec.scanHeldSamples!(NOW);
    assert.equal(sum.full, true);
    assert.equal(sum.rowsMoved, heldA.length, 'the same rows as ever');
    assert.equal(samplesOf(QUIET).length, quiet.length, 'QUIET untouched');
    assert.equal(counts.frozenOf, 2, `★★ one held-span read per device, not one per stretch (${counts.frozenOf})`);
    assert.equal(sum.candidates, 1, `★★ only the hold is kept for the move decision, not QUIET's 288 one-row stretches (${sum.candidates})`);
    // Each device read from its oldest row in six-hour chunks, one chunk query per metric (the
    // default 30-day retention would be 120 chunks per device).
    const chunks = (oldest: number) => Math.ceil((NOW - (oldest - 1)) / HELD_SCAN_CHUNK_MS);
    assert.equal(counts.chunkRows, METRICS.length * (chunks(T0) + chunks(lastFresh - H)), `★★ ${counts.chunkRows} chunk reads`);
    assert.equal(counts.minTs, 2 * METRICS.length, 'one oldest-row seek per series, on the first scan only');
    const hourly = rec.scanHeldSamples!(NOW + H);
    assert.equal(hourly.full, false);
    assert.equal(counts.frozenOf, 4, 'and one per device on the hourly scan');
    assert.equal(counts.minTs, 2 * METRICS.length, 'an hourly scan starts at its watermark');
    assert.equal(hourly.rowsMoved, 0);
  } finally { rec.close(); }
});

/* ══ 3. a gap ends a stretch ═══════════════════════════════════════════════ */

test('★★★ a Core back after a long gap with a first group equal to its held values keeps its return readings', (t) => {
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + 2 * H;
  const a1 = live(CORE_A, T0, lastFresh);
  const heldA = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 20 * H);
  reset([...a1, ...heldA]);
  let now = lastFresh + 21 * H;
  t.mock.method(Date, 'now', () => now);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  try {
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length, 'precondition: the hold is moved');
    const [span] = rec.heldSpans!(T0, now);
    // Two days later the Core reconnects: its first three MQTT groups equal its held values, then it moves.
    const R = lastFresh + 20 * H + 2 * DAY;
    const back = [...equalGroup(CORE_A, a1, R), ...equalGroup(CORE_A, a1, R + MIN), ...equalGroup(CORE_A, a1, R + 2 * MIN), ...live(CORE_A, R + 3 * MIN, R + 50 * MIN, 900)];
    withDb((db) => { const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)'); for (const r of back) ins.run(...r); });
    now = R + H;
    const sum = rec.scanHeldSamples!(now);
    assert.equal(sum.full, false);
    assert.deepEqual([sum.spans, sum.rowsMoved], [0, 0], `★★★ the return readings are fresh: ${lines.filter((l) => l.includes('held samples')).join('\n')}`);
    assert.equal(samplesOf(CORE_A, R - 1, R + 2 * MIN).length, 3 * METRICS.length, '★★★ all three equal groups stay in samples');
    const spans = rec.heldSpans!(T0, now);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].endMs, span.endMs, '★★ the span does not grow across the two silent days');
  } finally { rec.close(); }
});

test('★★★ the August shape: ~23 h held, 9.8 silent days, one equal return group — the span ends at its last held row, the estimate counts the held hours only', (t) => {
  const T0 = phx(2026, 8, 9, 15, 0);
  const lastFresh = T0 + 2 * H;
  // A live Core whose last fresh reading has 6 kW of PV (the held flow the counters integrated).
  const a1 = live(CORE_A, T0, lastFresh).map((r): Row => (r[0] === lastFresh && r[2] === 'pv_total' ? [r[0], r[1], r[2], 6_000] : r));
  const heldA = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 23 * H);
  const lastHeld = Math.max(...heldA.map((r) => r[0]));
  const R = lastHeld + 9.8 * DAY;
  const back = [...equalGroup(CORE_A, a1, R), ...live(CORE_A, R + MIN, R + H, 300)];
  reset([...a1, ...heldA, ...back]);
  const NOW = R + 2 * H;
  t.mock.method(Date, 'now', () => NOW);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  try {
    const sum = rec.scanHeldSamples!(NOW);
    assert.equal(sum.full, true);
    assert.equal(sum.rowsMoved, heldA.length, `★★★ the held rows only, not the return group (${sum.rowsMoved} vs ${heldA.length})`);
    assert.equal(samplesOf(CORE_A, R - 1, R).length, METRICS.length, '★★★ the return reading stays in samples');
    const spans = rec.heldSpans!(T0, NOW);
    assert.deepEqual(spans.map((s) => [s.startMs, s.endMs]), [[lastFresh, lastHeld]],
      `★★★ one span, ending at its last held row (it claimed ${((R - lastFresh) / H).toFixed(1)} h): ${JSON.stringify(spans)}`);
    // Every interval of the stretch is within the bridge, the first (last fresh → first restatement) too.
    const observed = lastHeld - lastFresh;
    const line = lines.find((l) => l.includes('HELD SAMPLES'));
    assert.ok(line?.includes(` ${(6_000 * observed / H / 1000).toFixed(1)} kWh of pv_total`), `★★ ${line}`);
    assert.equal((6_000 * observed / H / 1000).toFixed(1), '138.0', 'about 23 h at 6 kW (the span had claimed ~258 h: ~1,550 kWh)');
  } finally { rec.close(); }
});

test('★★ a hold split by a gap, each part an hour or more, is one span from its last fresh reading, announced once with both parts', (t) => {
  // A replayed body restated for two hours after a two-hour silence qualifies on its own, so it
  // joins the hold from the last change before the silence (createFrozenScanner). v1.188.1
  // (review 2) — one stretch: the HELD SAMPLES line states the second part's end and counts both
  // parts' held flow (the dry run's chain announced the first part's end and flow only).
  const T0 = phx(2026, 10, 10, 0, 0);
  const lastFresh = T0 + H;
  const a1 = live(CORE_A, T0, lastFresh).map((r): Row => (r[0] === lastFresh && r[2] === 'pv_total' ? [r[0], r[1], r[2], 6_000] : r));
  const part1 = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 3 * H);
  const part2 = held(CORE_A, a1, lastFresh + 5 * H, lastFresh + 7 * H);
  reset([...a1, ...part1, ...part2, ...live(CORE_A, lastFresh + 7 * H + 5 * MIN, lastFresh + 8 * H, 500)]);
  const NOW = lastFresh + 10 * H;
  t.mock.method(Date, 'now', () => NOW);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  try {
    const sum = rec.scanHeldSamples!(NOW);
    assert.equal(sum.candidates, 1, 'one stretch from one last fresh reading');
    assert.deepEqual([sum.spans, sum.rowsMoved], [1, part1.length + part2.length]);
    const end2 = Math.max(...part2.map((r) => r[0]));
    assert.deepEqual(rec.heldSpans!(T0, NOW).map((s) => [s.startMs, s.endMs]), [[lastFresh, end2]]);
    const announced = lines.filter((l) => l.includes('HELD SAMPLES'));
    assert.equal(announced.length, 1, `★★ announced once: ${announced.join('\n')}`);
    assert.ok(announced[0].includes(`from ${new Date(lastFresh).toISOString()} to ${new Date(end2).toISOString()}`), `★★ the second part's end: ${announced[0]}`);
    // Observed: the first part from the last fresh reading (its first interval is a heartbeat) and
    // the second from its first row (the silence before it is not observed).
    const observed = (Math.max(...part1.map((r) => r[0])) - lastFresh) + (end2 - (lastFresh + 5 * H));
    assert.ok(announced[0].includes(` ${(6_000 * observed / H / 1000).toFixed(1)} kWh of pv_total`), `★★ both parts' held flow: ${announced[0]}`);
    assert.equal((6_000 * observed / H / 1000).toFixed(1), '30.0', 'about 5 h at 6 kW (the dry run said 18.0, the first part only)');
    assert.equal(lines.filter((l) => l.includes('moved to held_samples') && l.includes('held samples of')).length, 1);
  } finally { rec.close(); }
});

/* ══ 4e. a silence the gate explains is not a broker stall ═══════════════════ */

test('★★ a fleet silence of a shadowed panel (no Core reporting) names the cloud shadow, not an MQTT/broker stall', async (t) => {
  reset([]);
  const c = { wall: phx(2026, 10, 17, 13, 0), mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  const advance = (ms: number) => { c.wall += ms; c.mono += ms; };
  const flush = () => new Promise<void>((r) => setImmediate(r));
  const store = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  const lines: string[] = [];
  const rec = createRecorder(store, (m) => lines.push(m));
  const quota = (k: number) => ({ 'loadInfo.hall1Watt': [k % 300, 134 + k, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60], 'wattInfo.gridWatt': 0 });
  try {
    store.setDeviceList([
      { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 } as any,
      { sn: CORE_B, deviceName: 'Core 2', productName: 'Delta Pro Ultra', online: 0 } as any,
    ]);
    // Core 2 reported once and then went offline in the cloud: its projection is held from here on.
    store.setDeviceQuota(CORE_B, { 'hs_yj751_pd_appshow_addr.soc': 61, 'hs_yj751_pd_appshow_addr.wattsOutSum': 900, 'hs_yj751_pd_backend_addr.batVol': 51.2 });
    await flush();
    for (let k = 0; k < 5; k++) { store.setDeviceQuota(PANEL, quota(k)); await flush(); advance(MIN); }
    // The cloud replays one payload: the latch sets, then 25 more minutes of replays.
    const frozen = quota(7);
    for (let i = 0; i < 16; i++) { store.setDeviceQuota(PANEL, frozen); await flush(); advance(MIN); }
    assert.ok(store.get().devices[PANEL].contentStaleSinceMs != null, 'precondition: latched');
    for (let i = 0; i < 25; i++) { store.setDeviceQuota(PANEL, frozen); await flush(); advance(MIN); }
    for (let k = 1; k <= 8; k++) { store.setDeviceQuota(PANEL, quota(100 + k)); await flush(); advance(MIN); }
    const fleet = rec.telemetryGaps().filter((g) => g.sn == null);
    assert.equal(fleet.length, 1, `precondition: the gate's silence is a fleet gap: ${JSON.stringify(rec.telemetryGaps())}`);
    assert.deepEqual(fleet[0].held, [{ sn: CORE_B, shadow: false }, { sn: PANEL, shadow: true }], '★★ the record says what the gate held');
    const [a] = outageAlerts(JSON.parse(JSON.stringify(fleet)), c.wall, OPTS, (sn) => store.get().devices[sn]?.deviceName);
    assert.equal(a.title.startsWith('Telemetry gap — no data for '), true);
    assert.match(a.detail, /^No fresh home-device readings reached the recorder for \d+ min \(/);
    assert.match(a.detail, /the add-on kept checking the fleet, but every home device it had a reading for was held — the EcoFlow cloud replayed the last payload of Smart Home Panel 2 \(cloud shadow\); Core 2 sent no new readings, so nothing was recorded/);
    assert.doesNotMatch(a.detail, /MQTT|broker/, `★★ ${a.detail}`);
    assert.equal(a.facts?.find((f) => f.label === 'Type')?.value, 'in-process (held readings)');
    assert.ok(lines.some((l) => l.includes('TELEMETRY GAP — no home-device samples') && l.includes(`held ${CORE_B} (no fresh content), ${PANEL} (cloud shadow)`)), lines.join('\n'));
    // Then a silence in which nothing reached the recorder at all (no evaluation): Core 2 was held
    // at every evaluation since, but those evaluations wrote the panel's rows, so they explain nothing.
    advance(20 * MIN);
    store.setDeviceQuota(PANEL, quota(500));
    await flush();
    const fleet2 = rec.telemetryGaps().filter((g) => g.sn == null);
    assert.equal(fleet2.length, 2);
    assert.equal(fleet2[1].held, undefined, `★★ nothing the gate held explains this one: ${JSON.stringify(fleet2[1])}`);
    assert.match(outageAlerts(JSON.parse(JSON.stringify([fleet2[1]])), c.wall, OPTS)[0].detail, /— an MQTT\/broker stall;/);
  } finally { rec.close(); }
});
