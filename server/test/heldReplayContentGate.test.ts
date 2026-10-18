/**
 * v1.188.1 — the Core content-clock gate (heldSamples.projectionRecordable: a Core is written only
 * while its content clock, contentChangedAtMs, is fresh) and the held-sample machinery (the scan,
 * the replay hold `heldReplayFrom`, the per-device gap records, what explains a fleet silence) give
 * one answer for a Core whose cached body the cloud replays.
 *
 * The held-sample scan was built while a Core had no marker of a replay (a replayed body passed the
 * gate and its 5-minute heartbeat wrote it), so its tests write such rows with a content clock that
 * moves (heldGapRecords.test.ts `dpu`). With the content-clock gate a genuine replay leaves the
 * content clock still and writes nothing after its first minutes. These tests drive a real
 * SnapshotStore, whose content witness moves only when a reading changes, through the recorder:
 *  1. a replay in this process: the gate writes its first minutes only, the scan has nothing to move,
 *     and the device gap is filed 6 h after the Core's last saved reading, from it, once; the gate's
 *     span starts at its last change and is logged once;
 *  2. the upgrade boot into a replay: the rows written before the gate are moved and the record is
 *     filed from the last fresh reading; the replayed bodies after the boot write nothing, so they
 *     never end the replay hold, and the first changed body ends both the gate's hold and the replay
 *     hold; the gate's own span of the replay after the boot is one span, logged (noteGate keeps the
 *     first instant this process held a Core whose content clock is not known yet);
 *  3. every home device held, the Cores by their content clocks: one fleet gap naming them as held,
 *     no per-device warning.
 * Fake serials throughout.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'ef-held-content-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(tmp, 'shadow-witness.json');
const DB_PATH = join(tmp, 'ecoflow.db');
const GAPS_PATH = join(tmp, 'telemetry-gaps.json');

const { createRecorder } = await import('../src/recorder.js');
const { projectionRecordable, createHeldSamples, HELD_MOVE_MIN_AGE_MS } = await import('../src/heldSamples.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { outageAlerts, deviceGapCount } = await import('../src/alerts.js');

const MIN = 60_000;
const H = 60 * MIN;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const OPTS = { enabled: true, recentWindowMs: 24 * H, minDurationMs: 15 * MIN, restartMinDurationMs: 5 * MIN };

const CORE_A = 'COREXXX00XXX0001';
const CORE_B = 'COREXXX00XXX0002';
const PANEL = 'PANEXXX00XXX0001';
const names: Record<string, string> = { [CORE_A]: 'Core 1', [CORE_B]: 'Core 2', [PANEL]: 'Smart Home Panel 2' };
const nameOf = (sn: string) => names[sn];
const listItem = (sn: string, online: boolean) => ({
  sn, deviceName: names[sn], productName: sn === PANEL ? 'Smart Home Panel 2' : 'Delta Pro Ultra', online: online ? 1 : 0,
}) as any;
/** A Core's REST quota; `k` moves every value, as a live Core's readings move. */
const coreQuota = (k: number) => ({
  'hs_yj751_pd_appshow_addr.soc': 40 + (k % 50),
  'hs_yj751_pd_appshow_addr.wattsOutSum': 900 + k,
  'hs_yj751_pd_appshow_addr.wattsInSum': 300 + k,
  'hs_yj751_pd_appshow_addr.outAc5p8Pwr': 850 + k,
  'hs_yj751_pd_backend_addr.batVol': 51 + (k % 7) / 10,
  'hs_yj751_pd_backend_addr.mpptHvTemp': 30 + (k % 5),
  'hs_yj751_pd_backend_addr.mpptLvTemp': 28 + (k % 4),
  'hs_yj751_pd_backend_addr.inHvMpptPwr': 0,
  'hs_yj751_pd_app_set_info_addr.chgMaxSoc': 100,
});
const panelQuota = (k: number) => ({
  'loadInfo.hall1Watt': [k % 300, 134 + k, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
  'wattInfo.gridWatt': 0,
});

function clocks(t: TestContext, wall0: number) {
  const c = { wall: wall0, mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  return { c, at: (ms: number) => { c.mono += ms - c.wall; c.wall = ms; } };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

function resetDb() {
  for (const f of [GAPS_PATH, join(tmp, '.clean-shutdown')]) if (existsSync(f)) unlinkSync(f);
  if (!existsSync(DB_PATH)) return;
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec('DELETE FROM samples');
    try { db.exec('DELETE FROM held_spans; DELETE FROM held_samples; DELETE FROM held_scan; DELETE FROM held_generation;'); } catch { /* the first recorder creates them */ }
  } finally { db.close(); }
}
function q(sql: string, ...p: Array<string | number>): any[] {
  const db = new DatabaseSync(DB_PATH);
  try { return db.prepare(sql).all(...p) as any[]; } finally { db.close(); }
}
const countRows = (table: 'samples' | 'held_samples', sn: string, fromMs: number, toMs: number) =>
  Number(q(`SELECT COUNT(*) AS n FROM ${table} WHERE sn = ? AND ts > ? AND ts <= ?`, sn, fromMs, toMs)[0].n);
const newestRow = (sn: string) => Number(q('SELECT MAX(ts) AS v FROM samples WHERE sn = ?', sn)[0].v ?? 0);
const iso = (ms: number) => new Date(ms).toISOString();

function makeStore() {
  const store = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  return store;
}

/* ══ 1. a replay in this process ═══════════════════════════════════════════ */

test('★★★ a Core whose cloud replays its cached body in this process: the gate writes its first minutes only, the scan has nothing to move, and its gap is filed 6 h after its last saved reading, from it, once', async (t) => {
  resetDb();
  const T0 = phx(2026, 10, 18, 9, 0);
  const { c, at } = clocks(t, T0);
  const store = makeStore();
  const lines: string[] = [];
  const rec = createRecorder(store, (m) => lines.push(m));
  try {
    store.setDeviceList([listItem(CORE_A, true), listItem(PANEL, true)]);
    let filedAt: number | null = null;
    const minute = async (m: number, coreK: number | null) => {
      at(T0 + m * MIN);
      store.setDeviceQuota(PANEL, panelQuota(m));
      if (coreK != null) store.setDeviceQuota(CORE_A, coreQuota(coreK));
      await flush();
      if (m % 60 === 0) rec.scanHeldSamples!(c.wall);
      if (filedAt == null && rec.telemetryGaps().some((g) => g.sn === CORE_A)) filedAt = c.wall;
    };
    for (let m = 1; m <= 30; m++) await minute(m, m); // live: every reading moves
    const lastChange = store.get().devices[CORE_A].contentChangedAtMs!;
    assert.equal(lastChange, T0 + 30 * MIN, 'precondition: the content clock is the last live poll');
    // The Core's own link drops; the cloud answers every poll with the same body. Each 200 lands
    // content (lastTelemetryAtMs), and nothing in it changes.
    for (let m = 31; m <= 30 + 7 * 60; m++) await minute(m, 30);
    const d = store.get().devices[CORE_A];
    assert.equal(d.lastTelemetryAtMs, c.wall, 'precondition: every replayed 200 bumps the arrival clock');
    assert.equal(d.contentChangedAtMs, lastChange, 'precondition: the content clock stays at the last change');
    assert.equal(projectionRecordable(d, c.wall), false);

    const lastSaved = newestRow(CORE_A);
    assert.ok(lastSaved >= lastChange && lastSaved <= lastChange + 5 * MIN, `★★ the gate wrote the replay's first minutes at most: last row ${iso(lastSaved)}`);
    assert.equal(countRows('held_samples', CORE_A, 0, c.wall), 0, '★★ nothing restated reached samples for the scan to move');
    const spans = rec.heldSpans!(0, c.wall).filter((s) => s.sn === CORE_A);
    assert.deepEqual(spans.map((s) => [s.reason, s.startMs]), [['gate-stale', lastChange]],
      `★★ one held span, from its last change (not restarted with every 200), logged by the gate: ${JSON.stringify(spans)}`);

    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1, `★★★ one record: ${JSON.stringify(rec.telemetryGaps())}`);
    assert.equal(g[0].startMs, lastSaved, `★★ from its last saved reading: ${iso(g[0].startMs)}`);
    assert.equal(g[0].alertStartMs, undefined, 'nothing was moved, so nothing is re-dated');
    assert.ok(filedAt != null && filedAt - lastSaved > 6 * H && filedAt - lastSaved <= 6 * H + 2 * MIN,
      `★★★ filed 6 h after it, while the replay ran: ${filedAt == null ? 'never' : iso(filedAt)}`);
    const [a] = outageAlerts(JSON.parse(JSON.stringify(g)), c.wall, OPTS, nameOf);
    assert.ok(a, 'the record is an alert');
    assert.equal(deviceGapCount(rec.telemetryGaps(), c.wall, 24 * H), 1);

    // The first body that differs is a reading again: written, and the hold the gate logged ends.
    await minute(30 + 7 * 60 + 1, 31);
    assert.ok(countRows('samples', CORE_A, c.wall - 1, c.wall) > 0, '★★ recording resumes with its first change');
    assert.ok(lines.some((l) => l.includes(`${CORE_A} is reporting again after`)), lines.filter((l) => l.includes(CORE_A)).join('\n'));
  } finally { rec.close(); }
});

/* ══ 2. the upgrade boot into a replay ═════════════════════════════════════ */

test('★★★ the upgrade boot into a replay: the rows written before the gate are moved and the record is filed from the last fresh reading; the replayed bodies after the boot write nothing and never end the replay hold; the first changed body ends both', async (t) => {
  resetDb();
  const T0 = phx(2026, 10, 19, 6, 0);
  const lastFresh = T0 + 30 * MIN;
  const BOOT = lastFresh + 10 * H;
  const { c, at } = clocks(t, T0);
  // Before the update: the Core reports live for 30 min.
  {
    const store = makeStore();
    const rec = createRecorder(store, () => {});
    try {
      store.setDeviceList([listItem(CORE_A, true), listItem(PANEL, true)]);
      for (let m = 1; m <= 30; m++) {
        at(T0 + m * MIN);
        store.setDeviceQuota(PANEL, panelQuota(m));
        store.setDeviceQuota(CORE_A, coreQuota(m));
        await flush();
      }
    } finally { rec.close(); }
  }
  assert.equal(newestRow(CORE_A), lastFresh, 'precondition: its last fresh reading');
  // …then, as before the gate, its heartbeat restates its last readings every 5 min for 10 h while
  // the panel keeps reporting.
  {
    const lastVal = new Map<string, number>();
    for (const r of q('SELECT metric, value FROM samples WHERE sn = ? ORDER BY ts ASC', CORE_A)) lastVal.set(r.metric, r.value);
    const db = new DatabaseSync(DB_PATH);
    try {
      const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
      db.exec('BEGIN');
      for (let ts = lastFresh + 5 * MIN; ts <= BOOT - 5 * MIN; ts += 5 * MIN) for (const [m, v] of lastVal) ins.run(ts, CORE_A, m, v);
      for (let ts = lastFresh + MIN; ts < BOOT; ts += MIN) ins.run(ts, PANEL, 'panel_load', 1_000 + (ts / MIN) % 97);
      db.exec('COMMIT');
    } finally { db.close(); }
  }
  const lastHeldRow = newestRow(CORE_A);
  assert.ok(lastHeldRow > BOOT - 10 * MIN, 'precondition: the seed will be a held row');

  // The update: a new process, the cloud still replaying the Core's last body every poll.
  at(BOOT);
  const store = makeStore();
  const lines: string[] = [];
  const rec = createRecorder(store, (m) => lines.push(m));
  try {
    store.setDeviceList([listItem(CORE_A, true), listItem(PANEL, true)]);
    const minute = async (m: number, coreK: number | null) => {
      at(BOOT + m * MIN);
      store.setDeviceQuota(PANEL, panelQuota(1_000 + m));
      if (coreK != null) store.setDeviceQuota(CORE_A, coreQuota(coreK));
      await flush();
    };
    await minute(1, 30);
    const sum = rec.scanHeldSamples!(c.wall);
    assert.ok(sum.rowsMoved > 0 && countRows('samples', CORE_A, lastFresh, c.wall - HELD_MOVE_MIN_AGE_MS) === 0, '★★ the held rows written before the gate are moved');
    assert.ok(countRows('samples', CORE_A, c.wall - HELD_MOVE_MIN_AGE_MS, BOOT) > 0, 'precondition: the newest 15 min wait for the next scan');
    for (let m = 2; m <= 90; m++) {
      await minute(m, 30);
      if (m === 61) rec.scanHeldSamples!(c.wall);
    }
    assert.equal(countRows('samples', CORE_A, lastFresh, BOOT), 0, 'the next scan moved the rest of the held rows');
    // The gate's own span of the replay after the boot: the Core has no content clock in this
    // process (its first body only seeded the witness), so it is held from its last arrival, which
    // moves with every poll; the span keeps the first instant this process held it, and is logged.
    const gate = rec.heldSpans!(0, c.wall).filter((s) => s.sn === CORE_A && s.reason !== 'frozen');
    assert.deepEqual(gate.map((s) => [s.reason, s.startMs]), [['gate-stale', BOOT + MIN]],
      `★★ one gate span, from the first held evaluation after the boot (not re-opened at every poll, and not from before the restart): ${JSON.stringify(gate)}`);
    assert.ok(lines.some((l) => l.includes(`${CORE_A} has delivered no fresh readings since ${iso(BOOT + MIN)}`)), lines.filter((l) => l.includes(CORE_A)).join('\n'));
    assert.equal(countRows('samples', CORE_A, BOOT, c.wall), 0, '★★★ the replayed bodies after the boot write nothing (the first body only seeded the witness, and none changed)');
    let g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1, `★★★ one record: ${JSON.stringify(rec.telemetryGaps())}`);
    assert.equal(g[0].startMs, lastFresh, `★★★ from the last fresh reading, the start of the replay hold: ${iso(g[0].startMs)}`);
    const ids = outageAlerts(JSON.parse(JSON.stringify(g)), c.wall, OPTS, nameOf).map((a) => a.id);

    // The first changed body: a reading by the gate, and the end of the replay hold.
    await minute(91, 31);
    const back = c.wall;
    assert.ok(countRows('samples', CORE_A, back - 1, back) > 0, '★★ written');
    for (let m = 92; m <= 95; m++) await minute(m, 31 + m);
    const lastChange = c.wall;
    // Then dark again for more than 6 h while the panel reports (its projection kept, its content
    // clock aging): a second darkness, measured from its last write — the changed body ended the
    // hold, so its clock moved on.
    for (let m = 96; m <= 95 + 6 * 60 + 10; m++) await minute(m, null);
    const lastWrite = newestRow(CORE_A);
    assert.ok(lastWrite >= lastChange && lastWrite <= lastChange + 5 * MIN, `precondition: written to at most 5 min past its last change: ${iso(lastWrite)}`);
    g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 2, `★★ a second darkness is a second record: ${JSON.stringify(g)}`);
    assert.equal(g[0].startMs, lastFresh, 'the first keeps its start');
    assert.deepEqual(outageAlerts(JSON.parse(JSON.stringify([g[0]])), c.wall, OPTS, nameOf).map((a) => a.id), ids, 'and its alert id');
    assert.equal(g[1].startMs, lastWrite, `★★★ the second from its last write after the return, not from the replay hold's start: ${iso(g[1].startMs)}`);
  } finally { rec.close(); }
});

test('★★ noteGate: a later start for a device held at every evaluation is the same hold; an earlier one opens a new span; a recordable evaluation closes it', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE samples (ts INTEGER NOT NULL, sn TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL);
    CREATE INDEX idx_samples_sn_metric_ts ON samples (sn, metric, ts); CREATE INDEX idx_samples_ts ON samples (ts);`);
  const T0 = phx(2026, 10, 21, 1, 0);
  let now = T0;
  const lines: string[] = [];
  const hs = createHeldSamples(db, { log: (m) => lines.push(m), retainMs: 30 * 24 * H, isExcludedSn: () => false, listSns: () => [], listMetrics: () => [], now: () => now });
  const spans = () => (db.prepare('SELECT start_ts, end_ts, reason FROM held_spans ORDER BY start_ts').all() as Array<{ start_ts: number; end_ts: number; reason: string }>)
    .map((r) => [Number(r.start_ts), Number(r.end_ts), r.reason]);
  // Held from its last arrival, which moves with every poll (a Core with no content clock yet).
  for (let m = 0; m <= 70; m++) { now = T0 + m * MIN; hs.noteGate(new Map([[CORE_A, { sinceMs: now, shadow: false }]]), now); }
  assert.deepEqual(spans(), [[T0, T0 + 70 * MIN, 'gate-stale']], '★★ one span from the first held evaluation, logged once it is an hour long');
  assert.equal(lines.filter((l) => l.includes('has delivered no fresh readings since')).length, 1);
  // An earlier start is another hold's (a shadow onset found earlier): a span of its own.
  now = T0 + 71 * MIN;
  hs.noteGate(new Map([[CORE_A, { sinceMs: T0 - 2 * H, shadow: false }]]), now);
  assert.deepEqual(spans().map((x) => x[0]), [T0 - 2 * H, T0], 'an earlier start opens a new span');
  // A recordable evaluation closes it; the next hold is a new span.
  now = T0 + 72 * MIN;
  hs.noteGate(new Map(), now);
  assert.ok(lines.some((l) => l.includes(`${CORE_A} is reporting again after`)));
  for (let m = 73; m <= 140; m++) { now = T0 + m * MIN; hs.noteGate(new Map([[CORE_A, { sinceMs: now, shadow: false }]]), now); }
  assert.deepEqual(spans().map((x) => x[0]), [T0 - 2 * H, T0, T0 + 73 * MIN], '★ a hold after a fresh reading is a new span');
});

/* ══ 3. every home device held ═════════════════════════════════════════════ */

test('★★ every home device held — the panel offline in the cloud, both Cores replaying with still content clocks: one fleet gap that names them as held, no per-device warning', async (t) => {
  resetDb();
  const T0 = phx(2026, 10, 20, 4, 0);
  const { c, at } = clocks(t, T0);
  const store = makeStore();
  const lines: string[] = [];
  const rec = createRecorder(store, (m) => lines.push(m));
  try {
    const all = [CORE_A, CORE_B, PANEL];
    const poll = async (m: number, panelOnline: boolean, coreK: (sn: string) => number) => {
      at(T0 + m * MIN);
      store.setDeviceList(all.map((sn) => listItem(sn, sn !== PANEL || panelOnline)));
      if (panelOnline) store.setDeviceQuota(PANEL, panelQuota(m));
      store.setDeviceQuota(CORE_A, coreQuota(coreK(CORE_A)));
      store.setDeviceQuota(CORE_B, coreQuota(100 + coreK(CORE_B)));
      await flush();
      if (m % 60 === 0) rec.scanHeldSamples!(c.wall);
    };
    for (let m = 1; m <= 30; m++) await poll(m, true, () => m);
    const S = T0 + 30 * MIN;
    // The panel drops off the cloud (its projection kept, its content aging) and the cloud replays
    // both Cores' last bodies: 8 h with no fresh home reading, the recorder evaluating every minute.
    for (let m = 31; m <= 30 + 8 * 60; m++) await poll(m, false, () => 30);
    assert.equal(countRows('held_samples', CORE_A, 0, c.wall) + countRows('held_samples', CORE_B, 0, c.wall), 0, 'precondition: nothing restated reached samples');
    assert.deepEqual(rec.telemetryGaps(), [], `★★ no record while no home device had a fresh reading: ${JSON.stringify(rec.telemetryGaps())}`);
    const R = T0 + (30 + 8 * 60 + 1) * MIN;
    for (let m = 30 + 8 * 60 + 1; m <= 30 + 8 * 60 + 20; m++) await poll(m, true, () => m);
    const gaps = rec.telemetryGaps();
    assert.deepEqual(gaps.filter((g) => g.sn != null), [], '★★★ no per-device warning: the time no home device could report is charged to none of them');
    const fleet = gaps.filter((g) => g.sn == null);
    assert.equal(fleet.length, 1, JSON.stringify(gaps));
    assert.ok(fleet[0].startMs >= S && fleet[0].startMs <= S + 5 * MIN, `from the last home write: ${iso(fleet[0].startMs)}`);
    assert.equal(fleet[0].endMs, R, 'to the first fresh home reading');
    assert.deepEqual(fleet[0].held, [{ sn: CORE_A, shadow: false }, { sn: CORE_B, shadow: false }, { sn: PANEL, shadow: false }],
      `★★★ the Cores are named as held by the gate (no fresh content), not as replays the scan moved: ${JSON.stringify(fleet[0].held)}`);
    assert.equal(deviceGapCount(gaps, c.wall, 24 * H), 0);
    const [a] = outageAlerts(JSON.parse(JSON.stringify(gaps)), c.wall, OPTS, nameOf);
    assert.equal(a.facts?.find((f) => f.label === 'Type')?.value, 'in-process (held readings)', a.detail);
  } finally { rec.close(); }
});
