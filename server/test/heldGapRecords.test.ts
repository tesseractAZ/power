/**
 * v1.188.1 review round 2 — the telemetry-gap records the held-sample work touches.
 *
 *  1. A restore of a span a gap record was re-dated from left the record re-dated: the next boot's
 *     seed (the held row the record was filed from, back in samples) matched neither its start nor
 *     its overlap, and a second record with the SAME alert id was filed — two alerts with one id,
 *     system_device_gap_count_24h doubled. A restore now returns the record to the start it was
 *     filed with (and the seeded clock to the row it read); a boot after a restore by SQL does it
 *     from the record's alertStartMs.
 *  2. A fleet gap was explained as "held readings" whenever an evaluation before it had written no
 *     home row, including one the dedupe skipped with the panel fresh, and even when no evaluation
 *     ran during the silence at all (a true stall). The gate explains a silence now only when the
 *     evaluations with no recordable home reading went on through it, none more than
 *     RECORD_FRESH_MS apart.
 * Sections 3-6 hold the later review rounds; round 5: a SQL restore made while the add-on runs, a
 * replayed Core written between the scan's plan and its move or first after a restart, the upgrade
 * boot's record waiting for the first scan, one record per darkness, and the round-4 survivors;
 * round 6: a seeded clock past the stretch, a Core back during the first scan, a restore in a
 * process booted after the move, a restored replay that ran past its record, a fleet-wide replay,
 * and a write lock held during a move.
 * Fake serials throughout.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

const tmp = mkdtempSync(join(tmpdir(), 'ef-held-gaps-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(tmp, 'shadow-witness.json');
const DB_PATH = join(tmp, 'ecoflow.db');
const GAPS_PATH = join(tmp, 'telemetry-gaps.json');

const { createRecorder } = await import('../src/recorder.js');
const { outageAlerts, deviceGapCount } = await import('../src/alerts.js');
const { benchSpareSns } = await import('../src/shp2Membership.js');

const MIN = 60_000;
const H = 60 * MIN;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const OPTS = { enabled: true, recentWindowMs: 24 * H, minDurationMs: 15 * MIN, restartMinDurationMs: 5 * MIN };

type Row = [ts: number, sn: string, metric: string, value: number];
const METRICS = ['soc', 'ac_in', 'bat_vol', 'bat_amp', 'total_out', 'pv_total', 'mppt_hv_temp', 'pack1_soc', 'pack1_temp', 'pack1_vol_max_mv', 'pack1_vol_min_mv', 'pack1_remain_cap_mah'];
const CORE_A = 'COREXXX00XXX0001';
const CORE_B = 'COREXXX00XXX0002';
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
function live(sn: string, fromMs: number, toMs: number, k0 = 0): Row[] {
  const out: Row[] = [];
  for (let t = fromMs, k = k0; t <= toMs; t += MIN, k++) METRICS.forEach((m, i) => out.push([t, sn, m, 100 + i * 10 + (k % 17) + i / 100]));
  return out;
}
function held(sn: string, before: Row[], fromMs: number, toMs: number): Row[] {
  const lastVal = new Map<string, number>();
  for (const r of before) if (r[1] === sn) lastVal.set(r[2], r[3]);
  const out: Row[] = [];
  for (let t = fromMs; t <= toMs; t += 5 * MIN) METRICS.forEach((m, i) => out.push([t + i * 1_000, sn, m, lastVal.get(m)!]));
  return out;
}
function panelRows(fromMs: number, toMs: number): Row[] {
  const out: Row[] = [];
  for (let t = fromMs; t <= toMs; t += 5 * MIN) out.push([t, PANEL, 'panel_load', 1_000 + (t / MIN) % 97]);
  return out;
}
const panelReads = (rec: ReturnType<typeof createRecorder>, now: number) => rec.insertSnapshot({
  generatedAt: now,
  devices: { [PANEL]: { sn: PANEL, deviceName: 'Smart Home Panel 2', lastTelemetryAtMs: now, projection: { kind: 'shp2', circuits: [{ ch: 1, watts: 900 + (now / MIN) % 50 }], pairedCircuits: [], sources: [], sourceWatts: [], gridWatt: 0 } } },
} as any);
const names: Record<string, string> = { [CORE_A]: 'Core 1', [CORE_B]: 'Core 2', [PANEL]: 'Smart Home Panel 2' };
const nameOf = (sn: string) => names[sn];
const deviceAlertIds = (gaps: unknown[], now: number) =>
  outageAlerts(JSON.parse(JSON.stringify(gaps)), now, OPTS, nameOf).filter((a) => a.id.startsWith('system-outage-device-')).map((a) => a.id).sort();

/** Core A held for 40 h after its last fresh reading; the panel kept reporting until the boot. */
function heldCore() {
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + 2 * H;
  const heldEnd = lastFresh + 40 * H;
  const BOOT = heldEnd + 7 * H;
  const a1 = live(CORE_A, T0, lastFresh);
  const heldA = held(CORE_A, a1, lastFresh + 5 * MIN, heldEnd);
  const lastHeldRow = Math.max(...heldA.map((r) => r[0]));
  return { T0, lastFresh, BOOT, rows: [...a1, ...heldA, ...panelRows(T0, BOOT - MIN)], heldA, lastHeldRow };
}

/* ══ 1. a restore and the gap record it re-dated ═══════════════════════════ */

test('★★★ a restore returns the re-dated record to the start it was filed with; the next boot extends it — one record, one alert id', (t) => {
  const { BOOT, rows, heldA, lastHeldRow, lastFresh } = heldCore();
  reset(rows);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  let ids: string[] = [];
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    ids = deviceAlertIds(rec.telemetryGaps(), now);
    assert.equal(ids.length, 1, 'precondition: filed from the last held row');
    now = BOOT + 2 * MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
    assert.equal(rec.telemetryGaps().find((g) => g.sn === CORE_A)?.startMs, lastFresh, 'precondition: re-dated by the move');
    assert.equal(rec.restoreHeldSamples!(CORE_A, lastFresh), heldA.length);
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1);
    assert.equal(g[0].startMs, lastHeldRow, '★★★ back to the held row it was filed from: that row is in samples again');
    assert.equal(g[0].alertStartMs, undefined, 'no longer re-dated');
    assert.equal(g[0].durationMs, g[0].endMs - lastHeldRow);
    assert.deepEqual(deviceAlertIds(rec.telemetryGaps(), now), ids, 'the same alert id: nothing is pushed again');
    assert.ok(lines.some((l) => l.includes(`device telemetry gap of ${CORE_A} returned to ${new Date(lastHeldRow).toISOString()}`)), lines.join('\n'));
  } finally { rec.close(); }
  now = BOOT + 4 * H;
  const rec2 = createRecorder(makeStore(), () => {});
  try {
    now += MIN;
    panelReads(rec2, now);
    const gaps = rec2.telemetryGaps();
    assert.equal(gaps.filter((x) => x.sn === CORE_A).length, 1, `★★★ one record after the restart, not a second with the same id: ${JSON.stringify(gaps)}`);
    assert.deepEqual(deviceAlertIds(gaps, now), ids, '★★★ one alert, its id unchanged');
    assert.equal(deviceGapCount(gaps, now, 24 * H), 1, '★★ Device Telemetry Gaps 24h stays 1 (it doubled)');
  } finally { rec2.close(); }
});

test('★★ a span restored by SQL (architecture 4.4): the next boot returns the record to the start it was filed with', (t) => {
  const { BOOT, rows, heldA, lastHeldRow, lastFresh } = heldCore();
  reset(rows);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  let ids: string[] = [];
  let genBefore = 0;
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    ids = deviceAlertIds(rec.telemetryGaps(), now);
    now = BOOT + 2 * MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
    genBefore = rec.samplesGeneration!();
    assert.ok(genBefore > 0, 'precondition: the move advanced the samples generation');
  } finally { rec.close(); }
  // v1.188.1 (review 3) — the recipe AS DOCUMENTED (architecture 4.4, "Restoring"), in one
  // transaction: copy back and delete on the documented row condition, mark the span restored, and
  // run the documented generation statement. Before, this test ran the source's own bump, so the
  // documented statement was never executed and nothing pinned the step.
  const arch = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/reference/01-architecture.md'), 'utf8');
  const restoring = arch.slice(arch.indexOf('**Restoring.**'), arch.indexOf('#### 4.5'));
  assert.ok(restoring.startsWith('**Restoring.**'), 'architecture 4.4 has its Restoring paragraph');
  const rowsWhere = /copy the span's rows \(`([^`]+)`\) from `held_samples` to `samples`/.exec(restoring)?.[1];
  assert.equal(rowsWhere, 'sn = ? AND ts > start_ts AND ts <= end_ts', 'the documented row condition');
  assert.match(restoring, /delete them from `held_samples`, set `restored_at_ms` on the span/, 'the documented delete and mark');
  const bump = /advance the samples\s+generation with `(UPDATE held_generation[^`]+)`/.exec(restoring)?.[1];
  assert.ok(bump != null, `★★ the documented generation statement: ${restoring}`);
  withDb((db) => {
    const span = db.prepare("SELECT end_ts FROM held_spans WHERE sn = ? AND start_ts = ? AND reason = 'frozen'").get(CORE_A, lastFresh) as { end_ts: number };
    const where = rowsWhere.replace('start_ts', String(lastFresh)).replace('end_ts', String(span.end_ts));
    db.exec('BEGIN');
    db.prepare(`INSERT INTO samples (ts, sn, metric, value) SELECT ts, sn, metric, value FROM held_samples WHERE ${where}`).run(CORE_A);
    db.prepare(`DELETE FROM held_samples WHERE ${where}`).run(CORE_A);
    db.prepare("UPDATE held_spans SET restored_at_ms = ? WHERE sn = ? AND start_ts = ? AND reason = 'frozen'").run(now, CORE_A, lastFresh);
    db.exec(bump!);
    db.exec('COMMIT');
  });
  assert.equal(withDb((db) => Number((db.prepare('SELECT COUNT(*) AS n FROM held_samples').get() as { n: number }).n)), 0, 'every row is back in samples');
  now = BOOT + 4 * H;
  const lines: string[] = [];
  const rec2 = createRecorder(makeStore(), (m) => lines.push(m));
  try {
    now += MIN;
    panelReads(rec2, now);
    const g = rec2.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1, `★★★ one record: ${JSON.stringify(g)}`);
    assert.equal(g[0].startMs, lastHeldRow, '★★ returned to the start it was filed with');
    assert.equal(g[0].alertStartMs, undefined);
    assert.equal(g[0].endMs, now, 'and extended to this boot');
    assert.deepEqual(deviceAlertIds(rec2.telemetryGaps(), now), ids, '★★★ the same alert id');
    assert.ok(lines.some((l) => l.includes(`DEVICE TELEMETRY GAP — ${CORE_A}`) && l.includes(`returned from ${new Date(lastFresh).toISOString()}`)), lines.join('\n'));
    assert.equal(rec2.samplesGeneration!(), genBefore + 1, '★★ the documented statement advanced the samples generation: the worker\'s memos see the restore');
  } finally { rec2.close(); }
});

test('★★ a restore in the same process puts the seeded gap clock back: the sweep extends the record at its filed start', (t) => {
  // The record was filed by an earlier boot from the last held row; this boot moves, then restores,
  // before any write runs the per-device sweep.
  const { BOOT, rows, heldA, lastHeldRow, lastFresh } = heldCore();
  reset(rows);
  const filedEnd = lastHeldRow + 6 * H + 3 * MIN;
  writeFileSync(GAPS_PATH, JSON.stringify([{ startMs: lastHeldRow, endMs: filedEnd, durationMs: filedEnd - lastHeldRow, detectedAt: filedEnd, sn: CORE_A }]));
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  try {
    const ids = deviceAlertIds(rec.telemetryGaps(), now);
    now = BOOT + MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
    assert.equal(rec.telemetryGaps()[0].startMs, lastFresh, 'precondition: re-dated by the move');
    rec.restoreHeldSamples!(CORE_A, lastFresh);
    now = BOOT + 2 * MIN;
    panelReads(rec, now);
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1);
    assert.equal(g[0].startMs, lastHeldRow, `★★ measured from the restored row, not re-dated again by the sweep: ${JSON.stringify(g[0])}`);
    assert.equal(g[0].endMs, now);
    assert.deepEqual(deviceAlertIds(rec.telemetryGaps(), now), ids);
  } finally { rec.close(); }
});

/* ══ 2. what explains a fleet silence ══════════════════════════════════════ */

type Snap = Record<string, unknown>;
/** The panel: fresh with a circuit reading, fresh with nothing measurable (`watts: null`), or held. */
const panel = (now: number, o: { contentAt?: number; shadowSince?: number | null; watts?: number | null } = {}): Snap => ({
  sn: PANEL, deviceName: 'Smart Home Panel 2', lastTelemetryAtMs: o.contentAt ?? now, contentStaleSinceMs: o.shadowSince ?? null,
  projection: o.watts === null
    ? { kind: 'shp2', circuits: [], pairedCircuits: [], sources: [], sourceWatts: [], gridWatt: null }
    : { kind: 'shp2', circuits: [{ ch: 1, watts: o.watts ?? 900 + (now / MIN) % 50 }], pairedCircuits: [], sources: [], sourceWatts: [], gridWatt: 0 },
});
/** A Core with a projection: measurable, or (`empty`) fresh content with nothing measurable. */
const core = (sn: string, contentAt: number, empty = false): Snap => ({
  sn, deviceName: names[sn] ?? sn, lastTelemetryAtMs: contentAt,
  projection: empty ? { kind: 'generic' } : { kind: 'generic', soc: 61, inWatts: 0, outWatts: 900, pvWatts: 0, acInWatts: 0, acOutWatts: 900, temp: 20 },
});

function clocked(t: TestContext, startMs: number) {
  const c = { wall: startMs, mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  return {
    at: (ms: number) => { c.mono += ms - c.wall; c.wall = ms; },
    get now() { return c.wall; },
  };
}
const fleetGaps = (rec: ReturnType<typeof createRecorder>) => rec.telemetryGaps().filter((g) => g.sn == null);
const typeOf = (g: unknown) => outageAlerts(JSON.parse(JSON.stringify([g])), Date.now(), OPTS, nameOf)[0]?.facts?.find((f) => f.label === 'Type')?.value;

test('★★ a true stall after a panel reading the dedupe skipped is an MQTT/broker stall, not held readings', (t) => {
  reset([]);
  const T0 = phx(2026, 10, 17, 13, 0);
  const clk = clocked(t, T0 - MIN);
  const rec = createRecorder(makeStore(), () => {});
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  try {
    // Core 2 reported once and went offline in the cloud: held throughout.
    for (let k = 0; k < 10; k++) { clk.at(T0 + k * MIN); send([panel(clk.now, { watts: 900 + k * 10 }), core(CORE_B, T0 - 5 * MIN)]); }
    clk.at(T0 + 9 * MIN + 3_000);
    send([panel(clk.now, { watts: 990 }), core(CORE_B, T0 - 5 * MIN)]); // fresh, 3 s after the last write: deduped
    clk.at(T0 + 40 * MIN); // 30 min with no evaluation at all
    send([panel(clk.now, { watts: 1_200 }), core(CORE_B, T0 - 5 * MIN)]);
    const [g] = fleetGaps(rec);
    assert.ok(g, 'precondition: a fleet gap');
    assert.equal(g.held, undefined, `★★ nothing the gate held explains it: ${JSON.stringify(g)}`);
    assert.equal(typeOf(g), 'in-process (MQTT stall)');
  } finally { rec.close(); }
});

test('★★ held evaluations explain a silence only while they go on through it, none more than 3 min apart', (t) => {
  const T0 = phx(2026, 10, 17, 14, 0);
  const runCase = (evalAt: (m: number) => boolean, endMin: number) => {
    reset([]);
    const clk = clocked(t, T0 - MIN);
    const rec = createRecorder(makeStore(), () => {});
    const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
    try {
      for (let k = 0; k <= 4; k++) { clk.at(T0 + k * MIN); send([panel(clk.now), core(CORE_B, T0 - 5 * MIN)]); }
      // The cloud replays the panel's body (the shadow latch is set): every evaluation holds both.
      for (let m = 5; m < endMin; m++) {
        if (!evalAt(m)) continue;
        clk.at(T0 + m * MIN);
        send([panel(clk.now, { shadowSince: T0 + 5 * MIN }), core(CORE_B, T0 - 5 * MIN)]);
      }
      clk.at(T0 + endMin * MIN);
      send([panel(clk.now), core(CORE_B, T0 - 5 * MIN)]);
      const gaps = fleetGaps(rec);
      assert.equal(gaps.length, 1, `precondition: one fleet gap ${JSON.stringify(rec.telemetryGaps())}`);
      return gaps[0];
    } finally { rec.close(); }
  };
  const every = runCase(() => true, 30);
  assert.deepEqual(every.held, [{ sn: CORE_B, shadow: false }, { sn: PANEL, shadow: true }], 'control: evaluated every minute through it');
  assert.equal(typeOf(every), 'in-process (held readings)');
  const stopped = runCase((m) => m <= 12, 30);
  assert.equal(stopped.held, undefined, '★★ the evaluations stopped 18 min before its end: a stall, not the gate');
  const inner = runCase((m) => m <= 10 || m >= 20, 29);
  assert.equal(inner.held, undefined, '★ a 10-min stall inside it');
});

test('★★ what the gate held is taken only from evaluations with no recordable home reading', (t) => {
  // The panel reads fresh (written, then skipped by the dedupe) while Core 2 is held; then Core 2
  // sends bodies with nothing measurable and the panel's content stops.
  reset([]);
  const T0 = phx(2026, 10, 17, 15, 0);
  const clk = clocked(t, T0 - MIN);
  const rec = createRecorder(makeStore(), () => {});
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  try {
    // Written at T0, then skipped by the dedupe while fresh (content at T0 + 1 min, fresh to T0 + 4
    // min, never a 5-min heartbeat), held from T0 + 5 min; Core 2 held to T0 + 4 min, then fresh.
    for (let k = 0; k <= 1; k++) { clk.at(T0 + k * MIN); send([panel(clk.now, { watts: 900 }), core(CORE_B, T0 - 10 * MIN)]); }
    clk.at(T0 + 2 * MIN);
    send([panel(clk.now, { contentAt: T0 + MIN, watts: 900 }), core(CORE_B, T0 - 10 * MIN)]);
    for (let k = 3; k <= 4; k++) { clk.at(T0 + k * MIN); send([panel(clk.now, { contentAt: T0 + MIN, watts: 900 }), core(CORE_B, T0 - 10 * MIN)]); }
    for (let k = 5; k <= 25; k++) { clk.at(T0 + k * MIN); send([panel(clk.now, { contentAt: T0 + MIN, watts: 900 }), core(CORE_B, clk.now, true)]); }
    clk.at(T0 + 26 * MIN);
    send([panel(clk.now, { watts: 950 }), core(CORE_B, clk.now, true)]);
    const [g] = fleetGaps(rec);
    assert.ok(g, `precondition: a fleet gap ${JSON.stringify(rec.telemetryGaps())}`);
    assert.equal(g.startMs, T0, 'precondition: nothing was written after T0 (the panel was skipped by the dedupe)');
    assert.deepEqual(g.held, [{ sn: PANEL, shadow: false }], `★★ the panel, held since its content stopped — not Core 2, held only while the panel was read: ${JSON.stringify(g)}`);
    // v1.188.1 (review 3) — Core 2 was read fresh with nothing measurable through the silence: it
    // is named as such, and the alert does not say that every home device it read was held.
    assert.deepEqual(g.unmeasured, [CORE_B], '★ Core 2, read fresh with nothing measurable');
    const [a] = outageAlerts(JSON.parse(JSON.stringify([g])), clk.now, OPTS, nameOf);
    assert.ok(a.detail.startsWith('No home-device reading could be recorded for 26 min'), a.detail);
    assert.ok(a.detail.includes('but no home device it had a reading for gave one to record — Smart Home Panel 2 sent no new readings; Core 2 reported nothing measurable, so nothing was recorded'), a.detail);
    assert.doesNotMatch(a.detail, /every home device/, '★ not "every home device it read was held"');
  } finally { rec.close(); }
});

test('★ a bench spare held through the silence is not named; a shadow seen once stays named as a shadow', (t) => {
  const SPARE = benchSpareSns()[0];
  assert.ok(SPARE, 'precondition: a bench spare');
  reset([]);
  const T0 = phx(2026, 10, 17, 16, 0);
  const clk = clocked(t, T0 - MIN);
  const rec = createRecorder(makeStore(), () => {});
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  try {
    // The spare reports once, in this process; then it and Core 2 are held.
    for (let k = 0; k <= 4; k++) { clk.at(T0 + k * MIN); send([panel(clk.now), core(CORE_B, T0 - 5 * MIN), core(SPARE, T0)]); }
    for (let m = 5; m <= 14; m++) { clk.at(T0 + m * MIN); send([panel(clk.now, { shadowSince: T0 + 5 * MIN }), core(CORE_B, T0 - 5 * MIN), core(SPARE, T0)]); }
    // The shadow latch releases on a body with nothing measurable (nothing is recorded), and the
    // panel then sends nothing more: held as stale, not as a shadow.
    clk.at(T0 + 15 * MIN);
    send([panel(clk.now, { watts: null }), core(CORE_B, T0 - 5 * MIN), core(SPARE, T0)]);
    for (let m = 16; m <= 29; m++) { clk.at(T0 + m * MIN); send([panel(clk.now, { contentAt: T0 + 15 * MIN, watts: null }), core(CORE_B, T0 - 5 * MIN), core(SPARE, T0)]); }
    clk.at(T0 + 30 * MIN);
    send([panel(clk.now), core(CORE_B, T0 - 5 * MIN), core(SPARE, T0)]);
    const [g] = fleetGaps(rec);
    assert.ok(g, `precondition: a fleet gap ${JSON.stringify(rec.telemetryGaps())}`);
    assert.deepEqual(g.held, [{ sn: CORE_B, shadow: false }, { sn: PANEL, shadow: true }],
      `★ the spare is dark by design and never named; the panel's shadow is kept: ${JSON.stringify(g.held)}`);
    assert.equal(g.unmeasured, undefined, 'the panel\'s one empty body is not named beside its hold (review 3)');
  } finally { rec.close(); }
});

test('★★ the post-boot silence carries what the gate held through it, and nothing when the evaluations stopped', (t) => {
  const B0 = phx(2026, 10, 17, 17, 0);
  const runCase = (lastEvalMin: number) => {
    reset([]);
    const clk = clocked(t, B0);
    const rec = createRecorder(makeStore(), () => {});
    const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
    try {
      // The panel's first body has nothing measurable; then it sends nothing, and the device list
      // keeps the recorder evaluating each minute.
      clk.at(B0 + MIN);
      send([panel(clk.now, { watts: null })]);
      for (let m = 2; m <= lastEvalMin; m++) { clk.at(B0 + m * MIN); send([panel(clk.now, { contentAt: B0 + MIN, watts: null })]); }
      clk.at(B0 + 20 * MIN);
      send([panel(clk.now)]);
      const gaps = fleetGaps(rec);
      assert.equal(gaps.length, 1, `precondition: the post-boot silence ${JSON.stringify(rec.telemetryGaps())}`);
      return gaps[0];
    } finally { rec.close(); }
  };
  const through = runCase(19);
  assert.deepEqual(through.held, [{ sn: PANEL, shadow: false }], '★★ held through it');
  assert.equal(through.unmeasured, undefined, 'its first, empty body is not named beside its hold (review 3)');
  assert.equal(runCase(5).held, undefined, '★ the evaluations stopped 15 min before its end');
});

/* ══ 3. review round 3 ═════════════════════════════════════════════════════ */

const iso = (ms: number) => new Date(ms).toISOString();
const fmtClock = (ms: number) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** A Core's DPU projection with a fresh content clock (14 metrics written): its content arrived and
 *  (v1.188.1, the content-clock gate) CHANGED at `contentAt`, so the gate passes it whatever its
 *  readings. A Core whose cached body the cloud replays unchanged keeps its content clock still and
 *  is held by the gate itself, writing nothing past five minutes (heldReplayContentGate.test.ts):
 *  the replays below stand for held rows that reach samples anyway (rows written before v1.188.1,
 *  as on the upgrade boot, or a body whose content clock moves while its recorded readings repeat),
 *  which the scan and the replay hold still catch. */
const dpu = (sn: string, contentAt: number, soc: number): Snap => ({
  sn, deviceName: names[sn] ?? sn, lastTelemetryAtMs: contentAt, contentChangedAtMs: contentAt,
  projection: {
    kind: 'dpu', soc, pvTotalWatts: 0, pvHighWatts: 0, pvLowWatts: 0, pvHighVolts: 1, pvHighAmps: 1, pvLowVolts: 1, pvLowAmps: 1,
    acInWatts: 0, acOutWatts: 300, totalInWatts: 0, totalOutWatts: 300, batVol: 52, batAmp: -6, packs: [],
  },
});

/** In this process: a Core changes to T0 + 30 min, then its body is replayed with a fresh content
 *  clock for 2 h (the gate passes it, the heartbeat writes it: held rows that reach samples anyway,
 *  see `dpu`), then it stops while the panel reports; the hourly scan moves the replay. */
function replayedCore(t: TestContext, day: number) {
  reset([]);
  const T0 = phx(2026, 10, day, 5, 0);
  const clk = clocked(t, T0);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  for (let m = 1; m <= 30; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 50 + m)]); }
  for (let m = 31; m <= 150; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 80)]); }
  for (let m = 151; m <= 210; m++) { clk.at(T0 + m * MIN); send([panel(clk.now)]); }
  const sum = rec.scanHeldSamples!(clk.now);
  /** The panel reports each minute to `toMin`; returns when the Core's record was first filed. */
  const panelUntil = (toMin: number) => {
    let filedAt: number | null = null;
    for (let m = Math.round((clk.now - T0) / MIN) + 1; m <= toMin; m++) {
      clk.at(T0 + m * MIN);
      send([panel(clk.now)]);
      if (filedAt == null && rec.telemetryGaps().some((g) => g.sn === CORE_A)) filedAt = clk.now;
    }
    return filedAt;
  };
  return { T0, clk, rec, lines, sum, lastFresh: T0 + 30 * MIN, lastHeldWrite: T0 + 150 * MIN, panelUntil };
}

test('★★★ a Core written in this process whose replayed rows the scan moved: its gap is measured from the span\'s start and filed so', (t) => {
  const { rec, sum, lastFresh, lastHeldWrite, panelUntil, clk } = replayedCore(t, 18);
  try {
    assert.ok(sum.rowsMoved > 0, 'precondition: the replay was moved');
    assert.deepEqual(rec.heldSpans!(0, clk.now).filter((s) => s.reason === 'frozen').map((s) => [s.startMs, s.endMs]), [[lastFresh, lastHeldWrite]], 'precondition: the span');
    const filedAt = panelUntil(150 + 6 * 60 + 5);
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1, JSON.stringify(rec.telemetryGaps()));
    assert.equal(g[0].startMs, lastFresh, `★★★ from the span's start, not from the last held row it wrote: ${iso(g[0].startMs)}`);
    assert.equal(g[0].alertStartMs, undefined, 'filed so: nothing to re-date');
    assert.ok(filedAt != null && filedAt - lastFresh <= 6 * H + 2 * MIN, `★★ filed 6 h after the span's start, not a hold later: ${filedAt == null ? 'never' : iso(filedAt)}`);
    const [a] = outageAlerts(JSON.parse(JSON.stringify(g)), clk.now, OPTS, nameOf);
    assert.ok(a.detail.includes(`(${fmtClock(lastFresh)} → `), `★★ the pushed start: ${a.detail}`);
  } finally { rec.close(); }
});

test('★★ restoring that span puts the in-process clock forward again: the gap is measured from the restored row', (t) => {
  const { rec, lastFresh, lastHeldWrite, panelUntil } = replayedCore(t, 19);
  try {
    assert.ok(rec.restoreHeldSamples!(CORE_A, lastFresh) > 0, 'precondition: restored');
    panelUntil(150 + 6 * 60 + 5);
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1, JSON.stringify(rec.telemetryGaps()));
    assert.equal(g[0].startMs, lastHeldWrite, `★★ from the row back in samples: ${iso(g[0].startMs)}`);
  } finally { rec.close(); }
});

/** Core A held twice: 4 h, then (a day later) 40 h; the record was filed from the last held row. */
function twoHolds() {
  const T0 = phx(2026, 10, 4, 17, 0);
  const lastFresh1 = T0 + 2 * H;
  const a1 = live(CORE_A, T0, lastFresh1);
  const heldA1 = held(CORE_A, a1, lastFresh1 + 5 * MIN, lastFresh1 + 4 * H);
  const lastFresh2 = lastFresh1 + 29 * H;
  const a2 = live(CORE_A, lastFresh1 + 4 * H + 5 * MIN, lastFresh2, 5);
  const heldA2 = held(CORE_A, a2, lastFresh2 + 5 * MIN, lastFresh2 + 40 * H);
  const lastHeldRow = Math.max(...heldA2.map((r) => r[0]));
  const BOOT = lastHeldRow + 7 * H;
  return { lastFresh1, lastFresh2, BOOT, lastHeldRow, heldA1, heldA2, rows: [...a1, ...heldA1, ...a2, ...heldA2, ...panelRows(T0, BOOT - MIN)] };
}

for (const order of ['older', 'newer'] as const) {
  test(`★ two spans of a device restored, the ${order} first: the clock and the record go back to the start it was filed with`, (t) => {
    const { BOOT, rows, lastFresh1, lastFresh2, lastHeldRow, heldA1, heldA2 } = twoHolds();
    reset(rows);
    const filedEnd = lastHeldRow + 6 * H + 3 * MIN;
    writeFileSync(GAPS_PATH, JSON.stringify([{ startMs: lastHeldRow, endMs: filedEnd, durationMs: filedEnd - lastHeldRow, detectedAt: filedEnd, sn: CORE_A }]));
    let now = BOOT;
    t.mock.method(Date, 'now', () => now);
    const rec = createRecorder(makeStore(), () => {});
    try {
      now = BOOT + MIN;
      assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA1.length + heldA2.length, 'precondition: both spans moved');
      assert.equal(rec.telemetryGaps()[0].startMs, lastFresh2, 'precondition: re-dated to its own span\'s start');
      const starts = order === 'older' ? [lastFresh1, lastFresh2] : [lastFresh2, lastFresh1];
      for (const s of starts) assert.ok(rec.restoreHeldSamples!(CORE_A, s) > 0);
      now = BOOT + 2 * MIN;
      panelReads(rec, now);
      const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
      assert.equal(g.length, 1);
      assert.equal(g[0].startMs, lastHeldRow, `★ at the row it was filed from, not re-dated again by the sweep: ${iso(g[0].startMs)}`);
      assert.equal(g[0].alertStartMs, undefined);
    } finally { rec.close(); }
  });
}

test('★ a device that reported fresh after the boot (off its seeded clock) still has its record re-dated by the move', (t) => {
  const { BOOT, rows, heldA, lastHeldRow, lastFresh } = heldCore();
  reset(rows);
  const filedEnd = lastHeldRow + 6 * H + 3 * MIN;
  writeFileSync(GAPS_PATH, JSON.stringify([{ startMs: lastHeldRow, endMs: filedEnd, durationMs: filedEnd - lastHeldRow, detectedAt: filedEnd, sn: CORE_A }]));
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  try {
    now = BOOT + MIN;
    rec.insertSnapshot({ generatedAt: now, devices: { [PANEL]: panel(now), [CORE_A]: core(CORE_A, now) } } as any); // back, fresh
    now = BOOT + 2 * MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g.length, 1);
    assert.equal(g[0].startMs, lastFresh, `★ re-dated: its clock is in-process, the record still started at a moved row (${iso(g[0].startMs)})`);
    assert.equal(g[0].alertStartMs, lastHeldRow);
  } finally { rec.close(); }
});

test('★★ a record re-dated to a KEPT restated row says it is the newest row left in samples, and the next boot\'s seed reads that row: one record', (t) => {
  // Live to X; a 35-min restated stretch (too short to be a hold; K = its last row) is left in
  // samples; a 70-min silence; then a 2 h hold, which starts its span at K.
  const T0 = phx(2026, 10, 15, 0, 0);
  const X = T0 + 2 * H;
  const a1 = live(CORE_A, T0, X);
  const P1 = held(CORE_A, a1, X + 5 * MIN, X + 40 * MIN);
  const K = Math.max(...P1.map((r) => r[0]));
  const P2 = held(CORE_A, a1, X + 110 * MIN, X + 230 * MIN);
  const lastHeldRow = Math.max(...P2.map((r) => r[0]));
  const BOOT = lastHeldRow + 7 * H;
  reset([...a1, ...P1, ...P2, ...panelRows(T0, BOOT - MIN)]);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  let ids: string[] = [];
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    assert.equal(rec.telemetryGaps().find((x) => x.sn === CORE_A)?.startMs, lastHeldRow, 'precondition: filed from the seed, the last held row');
    ids = deviceAlertIds(rec.telemetryGaps(), now);
    now = BOOT + 2 * MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, P2.length);
    assert.deepEqual(rec.heldSpans!(0, now).map((s) => s.startMs), [K], 'precondition: the span starts at the kept row');
    const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
    assert.equal(g[0].startMs, K);
    const redate = lines.filter((l) => l.includes('re-dated'));
    assert.ok(redate.some((l) => l.includes(`device telemetry gap of ${CORE_A} re-dated from ${iso(lastHeldRow)} to ${iso(K)}, its newest row left in samples`)), redate.join('\n'));
    assert.ok(!redate.some((l) => /last fresh/.test(l)), `★★ K is a restated row, not its last fresh reading: ${redate.join('\n')}`);
  } finally { rec.close(); }
  now = BOOT + 4 * H;
  const rec2 = createRecorder(makeStore(), () => {});
  try {
    now += MIN;
    panelReads(rec2, now);
    const gaps = rec2.telemetryGaps();
    assert.equal(gaps.filter((x) => x.sn === CORE_A).length, 1, `★★ the seed reads K, the record's start: ${JSON.stringify(gaps)}`);
    assert.deepEqual(deviceAlertIds(gaps, now), ids);
  } finally { rec2.close(); }
});

test('★★ two held silences in one process: the second is judged on its own evaluations and names only what it held', (t) => {
  reset([]);
  const T0 = phx(2026, 10, 17, 18, 0);
  const clk = clocked(t, T0 - MIN);
  const rec = createRecorder(makeStore(), () => {});
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  try {
    let m = 0;
    for (; m <= 4; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), core(CORE_B, T0 - 5 * MIN)]); }
    // Silence 1: the panel's body replayed (shadowed), Core A read fresh with nothing measurable,
    // evaluated only every 5 min: a stall, explained by nothing.
    for (; m <= 24; m += 5) { clk.at(T0 + m * MIN); send([panel(clk.now, { shadowSince: T0 + 5 * MIN }), core(CORE_B, T0 - 5 * MIN), core(CORE_A, clk.now, true)]); }
    for (; m <= 34; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), core(CORE_B, T0 - 5 * MIN)]); }
    // Silence 2: the panel's content stops (stale), evaluated every minute.
    const stopped = clk.now;
    for (; m <= 54; m++) { clk.at(T0 + m * MIN); send([panel(clk.now, { contentAt: stopped, watts: 900 }), core(CORE_B, T0 - 5 * MIN)]); }
    clk.at(T0 + m * MIN);
    send([panel(clk.now), core(CORE_B, T0 - 5 * MIN)]);
    const gaps = fleetGaps(rec);
    assert.equal(gaps.length, 2, JSON.stringify(rec.telemetryGaps()));
    assert.equal(gaps[0].held, undefined, 'precondition: silence 1, evaluated every 5 min, is a stall');
    assert.deepEqual(gaps[1].held, [{ sn: CORE_B, shadow: false }, { sn: PANEL, shadow: false }],
      `★★ silence 2 is explained (its evaluations were a minute apart), and the panel is stale there, not the shadow of silence 1: ${JSON.stringify(gaps[1])}`);
    assert.equal(gaps[1].unmeasured, undefined, '★ and Core A, read with nothing measurable only in silence 1, is not named');
  } finally { rec.close(); }
});

test('★ a bench spare reporting fresh through a held silence does not end it', (t) => {
  const SPARE = benchSpareSns()[0];
  assert.ok(SPARE, 'precondition: a bench spare');
  reset([]);
  const T0 = phx(2026, 10, 17, 19, 0);
  const clk = clocked(t, T0 - MIN);
  const rec = createRecorder(makeStore(), () => {});
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  try {
    let m = 0;
    for (; m <= 4; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), core(CORE_B, T0 - 5 * MIN), dpu(SPARE, clk.now, 40 + m)]); }
    for (; m <= 24; m++) { clk.at(T0 + m * MIN); send([panel(clk.now, { shadowSince: T0 + 5 * MIN }), core(CORE_B, T0 - 5 * MIN), dpu(SPARE, clk.now, 40 + m)]); }
    clk.at(T0 + m * MIN);
    send([panel(clk.now), core(CORE_B, T0 - 5 * MIN), dpu(SPARE, clk.now, 40 + m)]);
    const [g] = fleetGaps(rec);
    assert.ok(g, `precondition: a fleet gap ${JSON.stringify(rec.telemetryGaps())}`);
    assert.deepEqual(g.held, [{ sn: CORE_B, shadow: false }, { sn: PANEL, shadow: true }], `★ the spare's rows are not a home reading: ${JSON.stringify(g)}`);
  } finally { rec.close(); }
});

test('★ a held Core while the panel sends fresh bodies with nothing measurable: the alert names both, and not as "every home device held"', (t) => {
  reset([]);
  const T0 = phx(2026, 10, 17, 21, 0);
  const clk = clocked(t, T0 - MIN);
  const rec = createRecorder(makeStore(), () => {});
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  try {
    for (let m = 0; m <= 4; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 50 + m)]); }
    // The Core's content stops; the panel goes on with fresh bodies that carry no channel and no grid reading.
    for (let m = 5; m <= 29; m++) { clk.at(T0 + m * MIN); send([panel(clk.now, { watts: null }), dpu(CORE_A, T0 + 4 * MIN, 54)]); }
    clk.at(T0 + 30 * MIN);
    send([panel(clk.now), dpu(CORE_A, T0 + 4 * MIN, 54)]);
    const [g] = fleetGaps(rec);
    assert.ok(g, `precondition: a fleet gap ${JSON.stringify(rec.telemetryGaps())}`);
    assert.deepEqual(g.held, [{ sn: CORE_A, shadow: false }]);
    assert.deepEqual(g.unmeasured, [PANEL], '★ the panel was read fresh, not held');
    const [a] = outageAlerts(JSON.parse(JSON.stringify([g])), clk.now, OPTS, nameOf);
    assert.ok(a.detail.includes('no home device it had a reading for gave one to record — Core 1 sent no new readings; Smart Home Panel 2 reported nothing measurable'), a.detail);
    assert.doesNotMatch(a.detail, /every home device/);
    assert.equal(typeOf(g), 'in-process (held readings)');
  } finally { rec.close(); }
});

/* ══ 4. review round 4 ═════════════════════════════════════════════════════ */

/** Core A held 40 h after its last fresh reading; the panel reported to the last held row; the
 *  add-on was down `downMin` (the upgrade boot). */
function heldCoreDown(downMin: number) {
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + 2 * H;
  const a1 = live(CORE_A, T0, lastFresh);
  const heldA = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 40 * H);
  const lastHeldRow = Math.max(...heldA.map((r) => r[0]));
  return { lastFresh, BOOT: lastHeldRow + downMin * MIN, rows: [...a1, ...heldA, ...panelRows(T0, lastHeldRow)], heldA, lastHeldRow };
}

for (const how of ['in the same process', 'after a restart', 'by the SQL of architecture 4.4'] as const) {
  test(`★★★ a record filed at the moved span's start (no alertStartMs), its span then restored ${how}: the next boot extends it — one record, one alert id`, (t) => {
    const { BOOT, rows, heldA, lastHeldRow, lastFresh } = heldCoreDown(20);
    reset(rows);
    let now = BOOT;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(performance, 'now', () => now - BOOT + 1_000);
    let ids: string[] = [];
    // The upgrade boot: the first sweep runs before the scan and files nothing (the seed is the
    // last held row); the scan sets the clock back; the next sweep files the record at the span's start.
    let rec = createRecorder(makeStore(), () => {});
    try {
      now = BOOT + 30_000;
      panelReads(rec, now);
      assert.equal(rec.telemetryGaps().filter((x) => x.sn === CORE_A).length, 0, 'precondition: nothing filed before the scan');
      now = BOOT + MIN;
      assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
      now = BOOT + 2 * MIN;
      panelReads(rec, now);
      const g = rec.telemetryGaps().filter((x) => x.sn === CORE_A);
      assert.equal(g.length, 1, 'precondition: filed');
      assert.equal(g[0].startMs, lastFresh, 'precondition: filed at the span\'s start');
      assert.equal(g[0].alertStartMs, undefined, 'precondition: never re-dated');
      ids = deviceAlertIds(rec.telemetryGaps(), now);
      if (how === 'in the same process') assert.equal(rec.restoreHeldSamples!(CORE_A, lastFresh), heldA.length);
      for (let m = 3; m <= 60; m++) { now = BOOT + m * MIN; panelReads(rec, now); }
      assert.equal(rec.telemetryGaps().filter((x) => x.sn === CORE_A).length, 1);
    } finally { rec.close(); }
    if (how === 'after a restart') {
      now = BOOT + 70 * MIN;
      rec = createRecorder(makeStore(), () => {});
      try {
        now += MIN;
        panelReads(rec, now);
        assert.equal(rec.restoreHeldSamples!(CORE_A, lastFresh), heldA.length);
        for (let m = 2; m <= 30; m++) { now += MIN; panelReads(rec, now); }
      } finally { rec.close(); }
    }
    if (how === 'by the SQL of architecture 4.4') {
      withDb((db) => {
        const end = Number((db.prepare("SELECT end_ts FROM held_spans WHERE sn = ? AND start_ts = ? AND reason = 'frozen'").get(CORE_A, lastFresh) as { end_ts: number }).end_ts);
        db.exec('BEGIN');
        db.prepare('INSERT INTO samples (ts, sn, metric, value) SELECT ts, sn, metric, value FROM held_samples WHERE sn = ? AND ts > ? AND ts <= ?').run(CORE_A, lastFresh, end);
        db.prepare('DELETE FROM held_samples WHERE sn = ? AND ts > ? AND ts <= ?').run(CORE_A, lastFresh, end);
        db.prepare("UPDATE held_spans SET restored_at_ms = ? WHERE sn = ? AND start_ts = ? AND reason = 'frozen'").run(now, CORE_A, lastFresh);
        db.exec('UPDATE held_generation SET gen = gen + 1 WHERE id = 1');
        db.exec('COMMIT');
      });
    }
    // The next boot, the device still dark: its seed is the last held row again, inside the record.
    now += 2 * H;
    const lines: string[] = [];
    rec = createRecorder(makeStore(), (m) => lines.push(m));
    try {
      now += MIN;
      panelReads(rec, now);
      for (let m = 1; m <= 7 * 12; m++) { now += 5 * MIN; panelReads(rec, now); }
      const gaps = rec.telemetryGaps();
      const g = gaps.filter((x) => x.sn === CORE_A);
      assert.equal(g.length, 1, `★★★ one record for the one blackout, not a second from the restored row: ${JSON.stringify(g)}`);
      assert.equal(g[0].startMs, lastFresh, '★★ it keeps the start it was filed with (the warning\'s original time)');
      assert.ok(g[0].endMs > BOOT + 2 * H, `and extended by this boot: ${iso(g[0].endMs)}`);
      assert.deepEqual(deviceAlertIds(gaps, now), ids, '★★★ the same alert id: nothing is pushed again');
      assert.equal(deviceGapCount(gaps, now, 24 * H), 1, '★★ Device Telemetry Gaps 24h stays 1');
      const line = lines.find((l) => l.includes(`DEVICE TELEMETRY GAP — ${CORE_A}`)) ?? '';
      assert.ok(line.includes(`(${iso(lastFresh)} → `), `★ the line states the record's own window: ${line}`);
      assert.ok(line.includes(`its newest row, ${iso(lastHeldRow)}, is a held row moved back to samples, and the record keeps the start it was filed with`), line);
    } finally { rec.close(); }
  });
}

/** In this process: a Core changes to T0 + 30 min, then its body is replayed with a fresh content
 *  clock (the gate passes it: held rows that reach samples anyway, see `dpu`; the heartbeat writes
 *  it every 5 min) to T0 + `replayMin`, with an hourly scan; the panel reports every minute
 *  throughout. */
function runningReplay(t: TestContext, day: number, replayMin: number) {
  reset([]);
  const T0 = phx(2026, 10, day, 5, 0);
  const clk = clocked(t, T0);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  let filedAt: number | null = null;
  /** Minute `m`: the panel and, unless null, the Core (soc); then the hourly scan. */
  const minute = (m: number, soc: number | null) => {
    clk.at(T0 + m * MIN);
    send(soc == null ? [panel(clk.now)] : [panel(clk.now), dpu(CORE_A, clk.now, soc)]);
    if (m % 60 === 0) rec.scanHeldSamples!(clk.now);
    if (filedAt == null && rec.telemetryGaps().some((g) => g.sn === CORE_A)) filedAt = clk.now;
  };
  for (let m = 1; m <= 30; m++) minute(m, 50 + m);
  for (let m = 31; m <= replayMin; m++) minute(m, 80);
  return { T0, clk, rec, lines, minute, lastFresh: T0 + 30 * MIN, get filedAt() { return filedAt; } };
}
const coreRecords = (rec: ReturnType<typeof createRecorder>) => rec.telemetryGaps().filter((g) => g.sn === CORE_A);

for (const ending of ['still running', 'ended by a fresh reading', 'ended in silence'] as const) {
  test(`★★★ a Core whose replayed body passes the gate for 10 h (${ending}): its gap is filed 6 h after its last fresh reading, from it, once`, (t) => {
    const r = runningReplay(t, 20, 30 + 10 * 60);
    try {
      if (ending === 'ended by a fresh reading') for (let m = 631; m <= 750; m++) r.minute(m, 81 + (m % 7));
      if (ending === 'ended in silence') for (let m = 631; m <= 810; m++) r.minute(m, null);
      assert.ok(Number((withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM held_samples WHERE sn = ?').get(CORE_A)) as { n: number }).n) > 0, 'precondition: the replay was moved');
      const g = coreRecords(r.rec);
      assert.equal(g.length, 1, `★★★ one record: ${JSON.stringify(r.rec.telemetryGaps())}`);
      assert.equal(g[0].startMs, r.lastFresh, `★★ from the last fresh reading: ${iso(g[0].startMs)}`);
      assert.ok(r.filedAt != null && r.filedAt - r.lastFresh <= 6 * H + 2 * MIN, `★★★ filed 6 h after it, while the replay ran: ${r.filedAt == null ? 'never' : iso(r.filedAt)}`);
      const [a] = outageAlerts(JSON.parse(JSON.stringify(g)), r.clk.now, OPTS, nameOf);
      assert.ok(a.detail.includes(`(${fmtClock(r.lastFresh)} → `), `★★ the pushed start: ${a.detail}`);
    } finally { r.rec.close(); }
  });
}

test('★★ a held replayed Core that reads fresh again is not held any more: re-armed, and its later writes move its clock on', (t) => {
  const r = runningReplay(t, 21, 30 + 7 * 60);
  try {
    assert.equal(coreRecords(r.rec).length, 1, 'precondition: filed during the replay');
    for (let m = 451; m <= 455; m++) r.minute(m, 81 + (m % 7)); // fresh again
    for (let m = 456; m <= 480; m++) r.minute(m, 81 + (455 % 7)); // then steady: heartbeats to T0 + 480 min
    for (let m = 481; m <= 481 + 6 * 60 + 5; m++) r.minute(m, null); // then dark for 6 h
    const g = coreRecords(r.rec);
    assert.equal(g.length, 2, `★★ the fresh readings re-armed the sweep: ${JSON.stringify(g)}`);
    assert.equal(g[1].startMs, r.T0 + 480 * MIN, `★★ the second from its last write, a heartbeat after the change, not held at the change: ${iso(g[1].startMs)}`);
  } finally { r.rec.close(); }
});

test('★★ a held replayed Core back after a silence of more than an hour with the same readings is a return, not the hold: its clock moves on', (t) => {
  // Replayed to T0 + 150 min (moved at the T0 + 180 min scan), silent 3 h 45 min, then 30 min of the
  // same readings (a return the scan keeps), then a change. Dark 3 h 45 min: no record.
  const r = runningReplay(t, 22, 150);
  try {
    for (let m = 151; m <= 374; m++) r.minute(m, null);
    for (let m = 375; m <= 405; m++) r.minute(m, 80);
    for (let m = 406; m <= 460; m++) r.minute(m, 90 + (m % 3));
    assert.ok(Number((withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM held_samples WHERE sn = ?').get(CORE_A)) as { n: number }).n) > 0, 'precondition: the replay was moved');
    assert.deepEqual(coreRecords(r.rec), [], `★★ the return reset the clock (the scan keeps it as a reading): ${JSON.stringify(r.rec.telemetryGaps())}`);
  } finally { r.rec.close(); }
});

test('★★ restoring the span of a replay still running gives the Core its clock back: no record while it goes on writing', (t) => {
  const r = runningReplay(t, 23, 200);
  try {
    assert.ok(r.rec.restoreHeldSamples!(CORE_A, r.lastFresh) > 0, 'precondition: restored');
    for (let m = 201; m <= 200 + 6 * 60 + 15; m++) r.minute(m, 80); // past 6 h after its last write before the restore
    assert.deepEqual(coreRecords(r.rec), [], `★★ restored readings are readings: ${JSON.stringify(r.rec.telemetryGaps())}`);
    assert.equal(Number((withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM held_samples WHERE sn = ?').get(CORE_A)) as { n: number }).n), 0,
      '★ and the scan leaves the rest of the hold in samples');
  } finally { r.rec.close(); }
});

test('★★ restoring the span of a replay still running, then silence: the gap is measured from its last write, past the restored end', (t) => {
  const r = runningReplay(t, 25, 200);
  try {
    assert.ok(r.rec.restoreHeldSamples!(CORE_A, r.lastFresh) > 0, 'precondition: restored');
    for (let m = 201; m <= 200 + 6 * 60 + 5; m++) r.minute(m, null);
    const g = coreRecords(r.rec);
    assert.equal(g.length, 1, JSON.stringify(r.rec.telemetryGaps()));
    assert.equal(g[0].startMs, r.T0 + 200 * MIN, `★★ from the last restated write, a reading again: ${iso(g[0].startMs)}`);
  } finally { r.rec.close(); }
});

test('★ a restore after the replayed Core wrote fresh again leaves its clock on that fresh row', (t) => {
  const { rec, lastFresh, T0, clk, panelUntil } = replayedCore(t, 24);
  try {
    clk.at(T0 + 211 * MIN);
    rec.insertSnapshot({ generatedAt: clk.now, devices: { [PANEL]: panel(clk.now), [CORE_A]: dpu(CORE_A, clk.now, 99) } } as any);
    assert.ok(rec.restoreHeldSamples!(CORE_A, lastFresh) > 0, 'precondition: restored');
    panelUntil(150 + 6 * 60 + 5);
    assert.deepEqual(coreRecords(rec), [], `★ the Core wrote at T0 + 211 min: not dark for 6 h: ${JSON.stringify(rec.telemetryGaps())}`);
  } finally { rec.close(); }
});

test('★ an older, closed record of the device does not stop the move re-dating the current one', (t) => {
  const { BOOT, rows, heldA, lastFresh, T0, lastHeldRow } = heldCore();
  reset(rows);
  writeFileSync(GAPS_PATH, JSON.stringify([{ startMs: T0 - 3 * 24 * H, endMs: T0 - 2 * 24 * H, durationMs: 24 * H, detectedAt: T0 - 2 * 24 * H, sn: CORE_A }]));
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    assert.equal(coreRecords(rec).length, 2, 'precondition: the old record and the current one');
    now = BOOT + 2 * MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
    const cur = coreRecords(rec).filter((g) => g.startMs >= T0);
    assert.equal(cur.length, 1);
    assert.equal(cur[0].startMs, lastFresh, '★ the current record is re-dated to the span\'s start');
    assert.equal(cur[0].alertStartMs, lastHeldRow);
    assert.equal(coreRecords(rec).filter((g) => g.startMs < T0)[0].startMs, T0 - 3 * 24 * H, 'the old one is untouched');
  } finally { rec.close(); }
});

test('★ a record already re-dated, moved earlier again by an overlapping seed, keeps the id it was first filed with', (t) => {
  // The record was re-dated to S1, a kept restated row an earlier boot's move started from; S1 has
  // since been moved too, so this boot's seed reads the last fresh row, earlier still.
  const T0 = phx(2026, 10, 15, 0, 0);
  const lastFresh = T0 + 2 * H;
  const S1 = lastFresh + 3 * H;
  const heldEnd = lastFresh + 40 * H;
  const BOOT = heldEnd + 7 * H;
  reset([...live(CORE_A, T0, lastFresh), ...panelRows(T0, BOOT - MIN)]);
  const filedEnd = heldEnd + 6 * H + 3 * MIN;
  const before = [{ startMs: S1, endMs: filedEnd, durationMs: filedEnd - S1, detectedAt: filedEnd, sn: CORE_A, alertStartMs: heldEnd }];
  writeFileSync(GAPS_PATH, JSON.stringify(before));
  const idsBefore = deviceAlertIds(before, BOOT);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    const g = coreRecords(rec);
    assert.equal(g.length, 1);
    assert.equal(g[0].startMs, lastFresh);
    assert.equal(g[0].alertStartMs, heldEnd, `★ the start it was first filed with, not the one it was re-dated to: ${JSON.stringify(g)}`);
    assert.deepEqual(deviceAlertIds(rec.telemetryGaps(), now), idsBefore, '★ the same alert id: nothing is pushed again');
  } finally { rec.close(); }
});

test('★ Cores listed with no projection through a held silence were never read: not named as reporting nothing measurable', (t) => {
  reset([]);
  const T0 = phx(2026, 10, 17, 22, 0);
  const clk = clocked(t, T0 - MIN);
  const rec = createRecorder(makeStore(), () => {});
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  // A Core the cloud lists offline after a restart: listed, never fetched, so no projection.
  const listedOnly = (sn: string): Snap => ({ sn, deviceName: names[sn], online: false });
  try {
    for (let m = 0; m <= 4; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), listedOnly(CORE_A), listedOnly(CORE_B)]); }
    for (let m = 5; m < 30; m++) { clk.at(T0 + m * MIN); send([panel(clk.now, { shadowSince: T0 + 5 * MIN }), listedOnly(CORE_A), listedOnly(CORE_B)]); }
    clk.at(T0 + 30 * MIN);
    send([panel(clk.now), listedOnly(CORE_A), listedOnly(CORE_B)]);
    const [g] = fleetGaps(rec);
    assert.ok(g, `precondition: a fleet gap ${JSON.stringify(rec.telemetryGaps())}`);
    assert.deepEqual(g.held, [{ sn: PANEL, shadow: true }]);
    assert.equal(g.unmeasured, undefined, '★ a Core with no projection was never read');
    const [a] = outageAlerts(JSON.parse(JSON.stringify([g])), clk.now, OPTS, nameOf);
    assert.doesNotMatch(a.detail, /reported nothing measurable/, a.detail);
    assert.match(a.detail, /every home device it had a reading for was held/, a.detail);
  } finally { rec.close(); }
});

/* ══ 5. review round 5 ═════════════════════════════════════════════════════ */

const heldRowsOf = (sn: string) => Number((withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM held_samples WHERE sn = ?').get(sn)) as { n: number }).n);
/** The SQL of architecture 4.4, run on the add-on's database while the recorder has it open. */
function sqlRestore(sn: string, startMs: number, atMs: number) {
  withDb((db) => {
    const end = Number((db.prepare("SELECT end_ts FROM held_spans WHERE sn = ? AND start_ts = ? AND reason = 'frozen'").get(sn, startMs) as { end_ts: number }).end_ts);
    db.exec('BEGIN');
    db.prepare('INSERT INTO samples (ts, sn, metric, value) SELECT ts, sn, metric, value FROM held_samples WHERE sn = ? AND ts > ? AND ts <= ?').run(sn, startMs, end);
    db.prepare('DELETE FROM held_samples WHERE sn = ? AND ts > ? AND ts <= ?').run(sn, startMs, end);
    db.prepare("UPDATE held_spans SET restored_at_ms = ? WHERE sn = ? AND start_ts = ? AND reason = 'frozen'").run(atMs, sn, startMs);
    db.exec('UPDATE held_generation SET gen = gen + 1 WHERE id = 1');
    db.exec('COMMIT');
  });
}

for (const [day, restoreMin] of [[27, 200], [28, 385]] as const) {
  test(`★★ the span of a replay still running restored by the SQL of architecture 4.4 at T0 + ${restoreMin} min, the add-on running: no record while the Core goes on restating`, (t) => {
    // At 385 min the hourly scan that would see the restore (420) comes after the 6 h mark (390).
    const r = runningReplay(t, day, restoreMin);
    try {
      assert.ok(heldRowsOf(CORE_A) > 0, 'precondition: the replay was moved');
      sqlRestore(CORE_A, r.lastFresh, r.clk.now);
      for (let m = restoreMin + 1; m <= restoreMin + 6 * 60 + 15; m++) r.minute(m, 80);
      assert.equal(heldRowsOf(CORE_A), 0, 'every restated row is in samples (the scan leaves the rest of the hold)');
      assert.deepEqual(coreRecords(r.rec), [], `★★ restored readings are readings: no "Device telemetry gap" for a Core that wrote every 5 min: ${JSON.stringify(r.rec.telemetryGaps())}`);
      const lastWrite = r.clk.now;
      for (let m = restoreMin + 6 * 60 + 16; m <= restoreMin + 12 * 60 + 25; m++) r.minute(m, null);
      const g = coreRecords(r.rec);
      assert.equal(g.length, 1, JSON.stringify(r.rec.telemetryGaps()));
      assert.ok(g[0].startMs > lastWrite - 5 * MIN && g[0].startMs <= lastWrite, `★ then silent: from its last write, a reading again (${iso(g[0].startMs)})`);
    } finally { r.rec.close(); }
  });
}

for (const variant of ['restated', 'changed and back'] as const) {
  test(`★★★ a replayed Core writes between the scan's plan and its move (${variant}): ${variant === 'restated' ? 'held from the span\'s start, filed 6 h after it, once' : 'a fresh reading, not held'}`, (t) => {
    // scanInSteps reads every device before its first move (minutes on the Pi): each hourly scan
    // here is planned 30 s before the minute's write, so the Core's newest row is one it never read.
    reset([]);
    const T0 = phx(2026, 10, 29, 5, 0);
    const clk = clocked(t, T0);
    const rec = createRecorder(makeStore(), () => {});
    const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
    let filedAt: number | null = null;
    try {
      for (let m = 1; m <= 630; m++) {
        clk.at(T0 + m * MIN);
        // 'changed and back': 81 at 118, 80 again at 119, after the 117:30 plan.
        const soc = m <= 30 ? 50 + m : variant === 'changed and back' && m === 118 ? 81 : 80;
        send([panel(clk.now), dpu(CORE_A, clk.now, soc)]);
        if (m % 60 === 0 || (variant === 'changed and back' && m === 119)) {
          rec.scanHeldSamples!(variant === 'changed and back' && m === 119 ? T0 + 117 * MIN + 30_000 : clk.now - 30_000);
        }
        if (filedAt == null && coreRecords(rec).length > 0) filedAt = clk.now;
        if (variant === 'changed and back' && m === 420) break;
      }
      assert.ok(heldRowsOf(CORE_A) > 0, 'precondition: the replay was moved');
      const g = coreRecords(rec);
      if (variant === 'changed and back') {
        assert.deepEqual(g, [], `★★ a value that changed after the plan, even back again, is a fresh reading: no record from the hold's start (${JSON.stringify(g)})`);
        return;
      }
      assert.equal(g.length, 1, `★★★ one record: ${JSON.stringify(rec.telemetryGaps())}`);
      assert.equal(g[0].startMs, T0 + 30 * MIN, `★★ from the last fresh reading: ${iso(g[0].startMs)}`);
      assert.ok(filedAt != null && filedAt - (T0 + 30 * MIN) <= 6 * H + 2 * MIN, `★★★ filed 6 h after it, while the replay ran: ${filedAt == null ? 'never' : iso(filedAt)}`);
    } finally { rec.close(); }
  });
}

/** A restart into a replay: the replay is written to T0 + `replayMin` (hourly scans), the add-on is
 *  down `downMin`, the boot scan is planned `planMs` after the boot and runs at boot + 60 s, and the
 *  Core's first write after the boot (soc `soc`, every 30 s from then on) lands `firstMs` after it. */
const RESTARTS = [
  { label: 'restated after the boot scan', replayMin: 360, downMin: 2, planMs: 60_000, firstMs: 90_000, soc: 80, filed: true },
  { label: 'restated after a 52-min hole, the scan having left its newest rows (under 15 min old)', replayMin: 210, downMin: 2, planMs: 60_000, firstMs: 50 * MIN, soc: 80, filed: true },
  { label: 'restated between the boot scan\'s plan and its move', replayMin: 360, downMin: 2, planMs: 10_000, firstMs: 30_000, soc: 80, filed: true },
  { label: 'changed after the boot scan', replayMin: 360, downMin: 2, planMs: 60_000, firstMs: 90_000, soc: 81, filed: false },
  { label: 'changed between the boot scan\'s plan and its move', replayMin: 360, downMin: 2, planMs: 10_000, firstMs: 30_000, soc: 81, filed: false },
  { label: 'the same readings after a 70-min silence', replayMin: 360, downMin: 70, planMs: 60_000, firstMs: 90_000, soc: 80, filed: false },
  { label: 'the same readings after a 70-min silence, between the plan and the move', replayMin: 360, downMin: 70, planMs: 10_000, firstMs: 30_000, soc: 80, filed: false },
] as const;
for (const c of RESTARTS) {
  test(`★★★ a restart into a replay, the Core's first write ${c.label}: ${c.filed ? 'still held, filed 6 h after its last fresh reading' : 'a reading, not held'}`, (t) => {
    reset([]);
    const T0 = phx(2026, 10, 20, 12, 0);
    const clk = clocked(t, T0);
    let rec = createRecorder(makeStore(), () => {});
    const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
    const S = T0 + 30 * MIN;
    for (let m = 1; m <= 30; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 50 + m)]); }
    for (let m = 31; m <= c.replayMin; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 80)]); if (m % 60 === 0) rec.scanHeldSamples!(clk.now); }
    rec.close();
    const BOOT = clk.now + c.downMin * MIN;
    clk.at(BOOT);
    rec = createRecorder(makeStore(), () => {});
    let filedAt: number | null = null;
    const watch = () => { if (filedAt == null && coreRecords(rec).length > 0) filedAt = clk.now; };
    try {
      // The panel every 30 s; the Core from `firstMs`; the boot scan (synchronous here) at +60 s.
      let scanned = false;
      // To 6 h after the last fresh reading, and at least an hour into the new process.
      for (let at = BOOT + 30_000; at <= Math.max(S + 6 * H + 10 * MIN, BOOT + H); at += 30_000) {
        clk.at(at);
        send(at - BOOT >= c.firstMs ? [panel(clk.now), dpu(CORE_A, clk.now, c.soc)] : [panel(clk.now)]);
        if (!scanned && at - BOOT >= 60_000) { rec.scanHeldSamples!(BOOT + c.planMs); scanned = true; }
        watch();
      }
      assert.ok(scanned, 'precondition: the boot scan ran');
      assert.ok(heldRowsOf(CORE_A) > 0, 'precondition: the replay was moved');
      const g = coreRecords(rec);
      if (!c.filed) {
        assert.deepEqual(g, [], `★★ a ${c.soc !== 80 ? 'changed value' : 'return after a silence'} is a reading: its clock moves on (${JSON.stringify(g)})`);
        return;
      }
      assert.equal(g.length, 1, `★★★ one record: ${JSON.stringify(rec.telemetryGaps())}`);
      assert.equal(g[0].startMs, S, `★★ from the last fresh reading: ${iso(g[0].startMs)}`);
      assert.ok(filedAt != null && filedAt - S <= 6 * H + 2 * MIN, `★★★ filed 6 h after it: ${filedAt == null ? 'never' : iso(filedAt)}`);
    } finally { rec.close(); }
  });
}

test('★★★ the scan scheduled (the add-on), a seeded Core dark since a held stretch: its record waits for the first scan and is filed from its last fresh reading', (t) => {
  const { BOOT, rows, heldA, lastFresh } = heldCore();
  reset(rows);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  process.env.RECORDER_HELD_SCAN = 'on';
  let rec: ReturnType<typeof createRecorder>;
  try { rec = createRecorder(makeStore(), () => {}); } finally { delete process.env.RECORDER_HELD_SCAN; }
  try {
    now = BOOT + 40_000;
    panelReads(rec, now);
    assert.equal(rec.heldSamplesReady!(), false, 'precondition: the first scan has not finished');
    assert.deepEqual(coreRecords(rec), [], `★★★ nothing filed from the seeded held row before the scan: its push would state that row's start and a duration short by the hold (${JSON.stringify(coreRecords(rec))})`);
    now = BOOT + 60_000;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
    now = BOOT + 80_000;
    panelReads(rec, now);
    const g = coreRecords(rec);
    assert.equal(g.length, 1, JSON.stringify(rec.telemetryGaps()));
    assert.equal(g[0].startMs, lastFresh, `★★ filed from the last fresh reading: ${iso(g[0].startMs)}`);
    assert.equal(g[0].alertStartMs, undefined, '★★ filed so, never re-dated: the id the first push carries is the right start');
    const [a] = outageAlerts(JSON.parse(JSON.stringify(g)), now, OPTS, nameOf);
    assert.ok(a.title.includes(`no data for ${Math.round((g[0].endMs - lastFresh) / MIN)} min`), a.title);
    assert.ok(a.detail.includes(`(${fmtClock(lastFresh)} → `), a.detail);
  } finally { rec.close(); }
});

test('★★ the upgrade boot over a record v1.188.0 filed from the last held row, its alert aged out: not extended (re-raised) before the first scan re-dates it', (t) => {
  const T0 = phx(2026, 10, 13, 0, 0);
  const lastFresh = T0 + 2 * H;
  const a1 = live(CORE_A, T0, lastFresh);
  const heldA = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 40 * H);
  const lastHeldRow = Math.max(...heldA.map((r) => r[0]));
  const BOOT = lastHeldRow + 31 * H;
  reset([...a1, ...heldA, ...panelRows(T0, BOOT - MIN)]);
  const filedEnd = lastHeldRow + 6 * H + 3 * MIN;
  writeFileSync(GAPS_PATH, JSON.stringify([{ startMs: lastHeldRow, endMs: filedEnd, durationMs: filedEnd - lastHeldRow, detectedAt: filedEnd, sn: CORE_A }]));
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  process.env.RECORDER_HELD_SCAN = 'on';
  let rec: ReturnType<typeof createRecorder>;
  try { rec = createRecorder(makeStore(), () => {}); } finally { delete process.env.RECORDER_HELD_SCAN; }
  try {
    const listed = () => outageAlerts(JSON.parse(JSON.stringify(rec.telemetryGaps())), now, OPTS, nameOf).filter((a) => a.id.startsWith('system-outage-device-'));
    now = BOOT + 40_000;
    panelReads(rec, now);
    assert.equal(coreRecords(rec)[0].endMs, filedEnd, '★★ not extended before the scan');
    assert.deepEqual(listed(), [], '★★ so its alert is not listed (and not pushed) with the held row\'s start');
    now = BOOT + 60_000;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
    now = BOOT + 80_000;
    panelReads(rec, now);
    const g = coreRecords(rec);
    assert.equal(g.length, 1, JSON.stringify(g));
    assert.equal(g[0].startMs, lastFresh, 're-dated by the scan');
    assert.equal(g[0].alertStartMs, lastHeldRow, 'its id kept');
    assert.equal(g[0].endMs, now, 'then extended');
    const [a] = listed();
    assert.ok(a.detail.includes(`(${fmtClock(lastFresh)} → `), `★★ the alert raised again states the re-dated start: ${a.detail}`);
  } finally { rec.close(); }
});

test('★★ a record filed at the last fresh reading, a replay, then a second record from the last replayed row, with no scan between: the scan merges them — one record, the open one\'s id', (t) => {
  reset([]);
  const T0 = phx(2026, 10, 10, 5, 0);
  const clk = clocked(t, T0);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  try {
    // No scan (scans off, failing, or an earlier version): fresh to S, silent 7 h (record 1, at S),
    // S's body is replayed for 2 h (written: its content clock is fresh, see `dpu`), silent 7 h (record 2).
    for (let m = 1; m <= 60; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 40 + m)]); }
    const S = T0 + 60 * MIN;
    for (let m = 61; m <= 480; m++) { clk.at(T0 + m * MIN); send([panel(clk.now)]); }
    for (let m = 481; m <= 600; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 100)]); }
    for (let m = 601; m <= 1020; m++) { clk.at(T0 + m * MIN); send([panel(clk.now)]); }
    const before = coreRecords(rec);
    assert.equal(before.length, 2, `precondition: two records ${JSON.stringify(before)}`);
    assert.equal(before[0].startMs, S, 'precondition: the first from the last fresh reading');
    const second = before[1].startMs;
    const openId = deviceAlertIds([before[1]], clk.now);
    assert.equal(deviceGapCount(rec.telemetryGaps(), clk.now, 24 * H), 2, 'precondition: counted twice');
    assert.ok(rec.scanHeldSamples!(clk.now).rowsMoved > 0, 'precondition: the replay joined the hold from S and was moved');
    const g = coreRecords(rec);
    assert.equal(g.length, 1, `★★ one record for the one darkness: ${JSON.stringify(g)}`);
    assert.equal(g[0].startMs, S);
    assert.equal(g[0].alertStartMs, second, '★ the open record\'s id: nothing is pushed again');
    assert.equal(g[0].durationMs, g[0].endMs - S);
    assert.deepEqual(deviceAlertIds(rec.telemetryGaps(), clk.now), openId);
    assert.equal(deviceGapCount(rec.telemetryGaps(), clk.now, 24 * H), 1, '★★ Device Telemetry Gaps 24h: 1');
    assert.ok(lines.some((l) => l.includes(`device telemetry gap of ${CORE_A} re-dated from ${iso(second)} to ${iso(S)}`) && l.includes('1 other record(s) of the device from that darkness merged into it')), lines.filter((l) => l.includes('re-dated')).join('\n'));
  } finally { rec.close(); }
});

test('★ a record of another darkness of the device, before the span, is not merged by the re-date', (t) => {
  const { BOOT, rows, heldA, lastFresh, T0, lastHeldRow } = heldCore();
  reset(rows);
  // Closed records before the span's start, one ending exactly at it.
  writeFileSync(GAPS_PATH, JSON.stringify([
    { startMs: T0 - 3 * 24 * H, endMs: T0 - 2 * 24 * H, durationMs: 24 * H, detectedAt: T0 - 2 * 24 * H, sn: CORE_A },
    { startMs: lastFresh - 7 * H, endMs: lastFresh, durationMs: 7 * H, detectedAt: lastFresh, sn: CORE_A },
  ]));
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    assert.equal(coreRecords(rec).length, 3, 'precondition: two older records and the current one');
    now = BOOT + 2 * MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
    const g = coreRecords(rec);
    assert.deepEqual(g.map((x) => x.startMs), [T0 - 3 * 24 * H, lastFresh - 7 * H, lastFresh], '★ the older ones stay');
    assert.equal(g[2].alertStartMs, lastHeldRow);
  } finally { rec.close(); }
});

test('★ the record of a LATER darkness of the device is not merged by the re-date of an earlier hold', (t) => {
  // Two holds, each followed by a silence of more than 6 h, each filed by an earlier version from its
  // last held row. The scan re-dates each record to its own hold's last fresh reading.
  const T0 = phx(2026, 10, 2, 0, 0);
  const F1 = T0 + 2 * H;
  const a1 = live(CORE_A, T0, F1);
  const h1 = held(CORE_A, a1, F1 + 5 * MIN, F1 + 4 * H);
  const H1 = Math.max(...h1.map((r) => r[0]));
  const a2 = live(CORE_A, H1 + 8 * H, H1 + 10 * H, 5);
  const F2 = Math.max(...a2.map((r) => r[0]));
  const h2 = held(CORE_A, a2, F2 + 5 * MIN, F2 + 40 * H);
  const H2 = Math.max(...h2.map((r) => r[0]));
  const BOOT = H2 + 7 * H;
  reset([...a1, ...h1, ...a2, ...h2, ...panelRows(T0, BOOT - MIN)]);
  const rec6 = (start: number) => ({ startMs: start, endMs: start + 6 * H + 3 * MIN, durationMs: 6 * H + 3 * MIN, detectedAt: start + 6 * H + 3 * MIN, sn: CORE_A });
  writeFileSync(GAPS_PATH, JSON.stringify([rec6(H1), rec6(H2)]));
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  try {
    now = BOOT + MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, h1.length + h2.length, 'precondition: both holds moved');
    const g = coreRecords(rec);
    assert.deepEqual(g.map((x) => [x.startMs, x.alertStartMs]), [[F1, H1], [F2, H2]], `★ each record re-dated to its own hold, neither dropped: ${JSON.stringify(g)}`);
  } finally { rec.close(); }
});

test('★ restoring the span of a SECOND replay in one process, then silence: measured from its last restated write, not from the span\'s start', (t) => {
  // Hold A: a replay to T0 + 150 (moved at the 120 scan); fresh 151..200; hold B: a replay of the
  // last fresh value 201..300 (moved at the 300 scan), then silent; B restored at 320. The move of
  // B remembers the clock it set back (its last restated write), not the one A's move remembered.
  const r = runningReplay(t, 26, 150);
  try {
    assert.ok(heldRowsOf(CORE_A) > 0, 'precondition: hold A moved');
    for (let m = 151; m <= 200; m++) r.minute(m, 90 + (m % 5));
    const lastSoc = 90 + (200 % 5);
    for (let m = 201; m <= 300; m++) r.minute(m, lastSoc);
    const spans = withDb((db) => db.prepare("SELECT start_ts FROM held_spans WHERE sn = ? AND reason = 'frozen' ORDER BY start_ts").all(CORE_A)) as Array<{ start_ts: number }>;
    assert.equal(spans.length, 2, `precondition: two spans ${JSON.stringify(spans)}`);
    const bStart = Number(spans[1].start_ts);
    assert.equal(bStart, r.T0 + 200 * MIN, 'precondition: hold B from its last change');
    for (let m = 301; m <= 320; m++) r.minute(m, null);
    assert.ok(r.rec.restoreHeldSamples!(CORE_A, bStart) > 0, 'precondition: B restored');
    for (let m = 321; m <= 300 + 6 * 60 + 5; m++) r.minute(m, null);
    const g = coreRecords(r.rec);
    assert.equal(g.length, 1, JSON.stringify(r.rec.telemetryGaps()));
    assert.equal(g[0].startMs, r.T0 + 300 * MIN, `★ from the last restated write, a reading again, not B's start 100 min earlier: ${iso(g[0].startMs)}`);
  } finally { r.rec.close(); }
});

test('★ a record extended from a seed inside its window states its own duration', (t) => {
  const { BOOT, rows, heldA, lastHeldRow, lastFresh } = heldCoreDown(20);
  reset(rows);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now - BOOT + 1_000);
  let rec = createRecorder(makeStore(), () => {});
  try {
    now = BOOT + 30_000;
    panelReads(rec, now);
    now = BOOT + MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
    now = BOOT + 2 * MIN;
    panelReads(rec, now);
    assert.equal(coreRecords(rec)[0].startMs, lastFresh, 'precondition: filed at the span\'s start');
    assert.equal(rec.restoreHeldSamples!(CORE_A, lastFresh), heldA.length);
  } finally { rec.close(); }
  now += 2 * H;
  rec = createRecorder(makeStore(), () => {});
  try {
    now += MIN;
    panelReads(rec, now);
    for (let m = 1; m <= 7 * 12; m++) { now += 5 * MIN; panelReads(rec, now); }
    const g = coreRecords(rec);
    assert.equal(g.length, 1);
    assert.equal(g[0].startMs, lastFresh, 'precondition: it keeps its start (the seed, the restored last row, lies inside it)');
    assert.ok(lastHeldRow > lastFresh);
    assert.equal(g[0].durationMs, g[0].endMs - g[0].startMs, `★ the duration of the record's own window, not from the seed: ${JSON.stringify(g[0])}`);
    const [a] = outageAlerts(JSON.parse(JSON.stringify(g)), now, OPTS, nameOf);
    assert.ok(a.title.includes(`no data for ${Math.round((g[0].endMs - g[0].startMs) / MIN)} min`), a.title);
  } finally { rec.close(); }
});

/* ══ 6. review round 6 ═════════════════════════════════════════════════════ */

/** The add-on's recorder: the held-sample scan scheduled (RECORDER_HELD_SCAN=on). */
function addonRecorder(lines?: string[]) {
  process.env.RECORDER_HELD_SCAN = 'on';
  try { return createRecorder(makeStore(), (m) => lines?.push(m)); } finally { delete process.env.RECORDER_HELD_SCAN; }
}

for (const quiet of ['silent', 'restated by v1.188.0'] as const) {
  test(`★★★ the upgrade boot, a seeded Core back fresh for 15 min after a 40 h hold, then ${quiet} 25 min: not held from the hold's start — no 41 h warning`, (t) => {
    // The scan reads the seed (it plans after the boot): past the stretch's last restated row, the
    // seed is a fresh reading or a later hold's start, never one of the stretch's restatements.
    const T0 = phx(2026, 10, 14, 20, 0);
    const lastFresh = T0 + 2 * H;
    const a1 = live(CORE_A, T0, lastFresh);
    const heldA = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 40 * H);
    const lastHeldRow = Math.max(...heldA.map((r) => r[0]));
    const back = live(CORE_A, lastHeldRow + 5 * MIN, lastHeldRow + 20 * MIN, 7);
    const lastBack = Math.max(...back.map((r) => r[0]));
    const held2 = quiet === 'silent' ? [] : held(CORE_A, back, lastBack + 5 * MIN, lastBack + 25 * MIN);
    const newest = held2.length > 0 ? Math.max(...held2.map((r) => r[0])) : lastBack;
    const BOOT = lastBack + 27 * MIN;
    reset([...a1, ...heldA, ...back, ...held2, ...panelRows(T0, BOOT - MIN)]);
    let now = BOOT;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(performance, 'now', () => now - BOOT + 1_000);
    const rec = addonRecorder();
    try {
      now = BOOT + 30_000;
      panelReads(rec, now);
      now = BOOT + MIN;
      assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length, 'precondition: the 40 h hold is moved, the fresh return and the 25 min after it are not');
      let filedAt: number | null = null;
      for (let m = 2; m <= 7 * 60; m += 5) {
        now = BOOT + m * MIN;
        panelReads(rec, now);
        if (filedAt == null && coreRecords(rec).length > 0) filedAt = now;
      }
      const g = coreRecords(rec);
      assert.equal(g.length, 1, JSON.stringify(rec.telemetryGaps()));
      assert.equal(g[0].startMs, newest, `★★★ from its own newest row, not from the hold's start ${iso(lastFresh)}: ${iso(g[0].startMs)}`);
      assert.ok(filedAt != null && filedAt - BOOT > 5 * H, `★★ filed only once its own silence passed 6 h: ${filedAt == null ? 'never' : iso(filedAt)}`);
      const [a] = outageAlerts(JSON.parse(JSON.stringify(g)), now, OPTS, nameOf);
      assert.ok(!a.detail.includes(fmtClock(lastFresh)), `★★ the pushed window is not the hold's: ${a.detail}`);
      assert.ok(g[0].durationMs < 8 * H, `★★ not 41 h: ${Math.round(g[0].durationMs / MIN)} min`);
    } finally { rec.close(); }
  });
}

/** A Core's DPU projection sent with the panel's. */
const sendBoth = (rec: ReturnType<typeof createRecorder>, now: number, soc: number) =>
  rec.insertSnapshot({ generatedAt: now, devices: { [PANEL]: panel(now), [CORE_A]: dpu(CORE_A, now, soc) } } as any);

for (const when of ['before the scan\'s first move', 'after its first move, before it finishes'] as const) {
  test(`★★ the upgrade boot, a Core held 40 h comes back ${when}: filed once the scan has finished, from its last fresh reading to its return`, (t) => {
    const { BOOT, rows, heldA, lastFresh } = heldCoreDown(20);
    reset(rows);
    let now = BOOT;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(performance, 'now', () => now - BOOT + 1_000);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const rec = addonRecorder();
    let backAt = 0;
    try {
      now = BOOT + 30_000;
      panelReads(rec, now);
      if (when === 'before the scan\'s first move') {
        now = BOOT + 40_000;
        sendBoth(rec, now, 40);
        backAt = now;
        assert.deepEqual(coreRecords(rec), [], 'precondition: the sweep waits for the first scan');
        now = BOOT + MIN;
        assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
      } else {
        // The production scan: a minute after the boot, one step per timer tick.
        now = BOOT + 60_000;
        t.mock.timers.tick(60_000);
        for (let k = 0; k < 10_000 && !rec.heldSamplesReady!(); k++) {
          now += 1_000;
          t.mock.timers.tick(5);
          if (backAt === 0 && heldRowsOf(CORE_A) > 0) { sendBoth(rec, now, 40); backAt = now; }
        }
        assert.ok(rec.heldSamplesReady!() && backAt > 0, 'precondition: the Core wrote between the first move and the end of the scan');
        assert.ok(heldRowsOf(CORE_A) === heldA.length, 'precondition: the scan moved the hold');
      }
      assert.deepEqual(coreRecords(rec), [], 'not before the scan has finished');
      for (let m = 2; m <= 30; m++) { now = BOOT + m * MIN; sendBoth(rec, now, 40 + (m % 3)); }
      const g = coreRecords(rec);
      assert.equal(g.length, 1, `★★ one record for the 40 h hold: ${JSON.stringify(rec.telemetryGaps())}`);
      assert.equal(g[0].startMs, lastFresh, `★★ from the last fresh reading: ${iso(g[0].startMs)}`);
      assert.equal(g[0].endMs, backAt, `★ to its return: ${iso(g[0].endMs)}`);
      const [a] = outageAlerts(JSON.parse(JSON.stringify(g)), now, OPTS, nameOf);
      assert.ok(a.title.includes(`no data for ${Math.round((backAt - lastFresh) / MIN)} min`), a.title);
      assert.ok(a.detail.includes(`(${fmtClock(lastFresh)} → ${fmtClock(backAt)})`), a.detail);
    } finally { rec.close(); t.mock.timers.reset(); }
  });
}

test('★ a Core back during the first scan after only 30 min without a reading: no record', (t) => {
  const T0 = phx(2026, 10, 21, 0, 0);
  const a1 = live(CORE_A, T0, T0 + 2 * H);
  const BOOT = T0 + 2 * H + 30 * MIN;
  reset([...a1, ...panelRows(T0, BOOT - MIN)]);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now - BOOT + 1_000);
  const rec = addonRecorder();
  try {
    now = BOOT + 30_000;
    panelReads(rec, now);
    now = BOOT + 40_000;
    sendBoth(rec, now, 40);
    now = BOOT + MIN;
    rec.scanHeldSamples!(now);
    for (let m = 2; m <= 30; m++) { now = BOOT + m * MIN; sendBoth(rec, now, 40 + (m % 3)); }
    assert.deepEqual(coreRecords(rec), [], `★ judged from its own clock: ${JSON.stringify(coreRecords(rec))}`);
  } finally { rec.close(); }
});

/** Core A: fresh to `lastFresh`, a 3 h replay moved by process 1, which runs on 30 min with the Core
 *  silent; process 2 boots 5 min later (its seed for the Core: the span's start). */
function replayMovedBeforeRestart(t: TestContext) {
  const T0 = phx(2026, 10, 18, 0, 0);
  const lastFresh = T0 + 2 * H;
  const a1 = live(CORE_A, T0, lastFresh);
  const heldA = held(CORE_A, a1, lastFresh + 5 * MIN, lastFresh + 3 * H);
  const lastHeldRow = Math.max(...heldA.map((r) => r[0]));
  const BOOT1 = lastFresh + 3 * H + 20 * MIN;
  reset([...a1, ...heldA, ...panelRows(T0, BOOT1 - MIN)]);
  const clk = clocked(t, BOOT1);
  const rec1 = createRecorder(makeStore(), () => {});
  try {
    assert.equal(rec1.scanHeldSamples!(clk.now).rowsMoved, heldA.length, 'precondition: process 1 moved the replay');
    for (let k = 1; k <= 30; k++) { clk.at(BOOT1 + k * MIN); panelReads(rec1, clk.now); }
    assert.deepEqual(coreRecords(rec1), [], 'precondition: not filed by process 1');
  } finally { rec1.close(); }
  const BOOT2 = BOOT1 + 35 * MIN;
  clk.at(BOOT2);
  return { clk, lastFresh, lastHeldRow, heldA, BOOT2 };
}

for (const how of ['the SQL of architecture 4.4', 'restoreHeldSamples'] as const) {
  test(`★★ a replay moved before a restart, restored by ${how} in the next process: filed 6 h after the last restored row, from it`, (t) => {
    const { clk, lastFresh, lastHeldRow, heldA, BOOT2 } = replayMovedBeforeRestart(t);
    const rec = createRecorder(makeStore(), () => {});
    try {
      clk.at(BOOT2 + MIN);
      panelReads(rec, clk.now);
      if (how === 'restoreHeldSamples') assert.equal(rec.restoreHeldSamples!(CORE_A, lastFresh), heldA.length);
      else sqlRestore(CORE_A, lastFresh, clk.now);
      let filedAt: number | null = null;
      for (let k = 2; k <= 8 * 60; k += 5) {
        clk.at(BOOT2 + k * MIN);
        panelReads(rec, clk.now);
        if (filedAt == null && coreRecords(rec).length > 0) filedAt = clk.now;
      }
      const g = coreRecords(rec);
      assert.equal(g.length, 1, JSON.stringify(rec.telemetryGaps()));
      assert.equal(g[0].startMs, lastHeldRow, `★★ from the last row back in samples, not the span's start ${iso(lastFresh)}: ${iso(g[0].startMs)}`);
      assert.ok(filedAt != null && filedAt - lastHeldRow >= 6 * H, `★★ not before 6 h after it: ${filedAt == null ? 'never' : `${((filedAt - lastHeldRow) / H).toFixed(2)} h`}`);
      const [a] = outageAlerts(JSON.parse(JSON.stringify(g)), clk.now, OPTS, nameOf);
      assert.ok(a.detail.includes(`(${fmtClock(lastHeldRow)} → `), a.detail);
    } finally { rec.close(); }
  });
}

test('★★ a span restored in a process booted after its move, the Core dark: it is still filed (released once, then judged from the restored rows)', (t) => {
  const { BOOT, rows, heldA, lastHeldRow, lastFresh } = heldCore();
  reset(rows);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const rec = createRecorder(makeStore(), () => {});
  try {
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length, 'precondition: moved before any write ran the sweep');
    assert.deepEqual(coreRecords(rec), [], 'precondition: no record yet');
  } finally { rec.close(); }
  now = BOOT + 4 * H;
  const rec2 = createRecorder(makeStore(), () => {});
  try {
    assert.equal(rec2.restoreHeldSamples!(CORE_A, lastFresh), heldA.length);
    for (let k = 1; k <= 3; k++) { now += MIN; panelReads(rec2, now); }
    const g = coreRecords(rec2);
    assert.equal(g.length, 1, `★★ the Core has written nothing for ${((now - lastHeldRow) / H).toFixed(1)} h: filed, not released on every sweep (${JSON.stringify(rec2.telemetryGaps())})`);
    assert.equal(g[0].startMs, lastHeldRow, '★ from its last row back in samples');
  } finally { rec2.close(); }
});

test('★ a span marked restored with none of its rows back in samples (the SQL\'s mark without its copy): the dark Core is filed from where its clock is', (t) => {
  const { clk, lastFresh, BOOT2 } = replayMovedBeforeRestart(t);
  withDb((db) => db.prepare("UPDATE held_spans SET restored_at_ms = ? WHERE sn = ? AND start_ts = ? AND reason = 'frozen'").run(clk.now, CORE_A, lastFresh));
  const rec = createRecorder(makeStore(), () => {});
  try {
    for (let k = 1; k <= 8 * 60; k += 5) { clk.at(BOOT2 + k * MIN); panelReads(rec, clk.now); }
    const g = coreRecords(rec);
    assert.equal(g.length, 1, `★ the sweep releases a restored span's device only when the restore gives its clock somewhere to go: ${JSON.stringify(rec.telemetryGaps())}`);
    assert.equal(g[0].startMs, lastFresh, 'its newest row in samples');
  } finally { rec.close(); }
});

for (const how of ['restoreHeldSamples', 'the SQL of architecture 4.4'] as const) {
  test(`★★ a replay restored by ${how} after it ran past its record (filed 6 h into it), then a restart with the Core still dark: one record, one alert id`, (t) => {
    const r = runningReplay(t, 23, 30 + 10 * 60);
    let ids: string[] = [];
    try {
      const g0 = coreRecords(r.rec);
      assert.equal(g0.length, 1, 'precondition: filed during the replay');
      assert.ok(g0[0].endMs < r.T0 + 630 * MIN, 'precondition: the replay ran past the record\'s end');
      ids = deviceAlertIds(r.rec.telemetryGaps(), r.clk.now);
      for (let m = 631; m <= 750; m++) r.minute(m, null);
      assert.ok(heldRowsOf(CORE_A) > 0, 'precondition: moved');
      if (how === 'restoreHeldSamples') assert.ok(r.rec.restoreHeldSamples!(CORE_A, r.lastFresh) > 0);
      else sqlRestore(CORE_A, r.lastFresh, r.clk.now);
      for (let m = 751; m <= 800; m++) r.minute(m, null);
      assert.equal(heldRowsOf(CORE_A), 0, 'precondition: every replayed row is back in samples');
      assert.equal(coreRecords(r.rec).length, 1, 'precondition: one record in this process');
    } finally { r.rec.close(); }
    r.clk.at(r.T0 + 802 * MIN);
    const lines: string[] = [];
    const rec2 = createRecorder(makeStore(), (m) => lines.push(m));
    try {
      for (let m = 803; m <= 800 + 8 * 60; m++) {
        r.clk.at(r.T0 + m * MIN);
        rec2.insertSnapshot({ generatedAt: r.clk.now, devices: { [PANEL]: panel(r.clk.now) } } as any);
        if (m === 863) rec2.scanHeldSamples!(r.clk.now);
      }
      const gaps = rec2.telemetryGaps();
      const g = gaps.filter((x) => x.sn === CORE_A);
      assert.equal(g.length, 1, `★★★ one record for the one darkness, not a second from the restored replay's last row: ${JSON.stringify(g.map((x) => [iso(x.startMs), iso(x.endMs)]))}`);
      assert.equal(g[0].startMs, r.lastFresh, '★★ it keeps the start it was filed with');
      assert.ok(g[0].endMs > r.T0 + 802 * MIN, `and is extended by the boot: ${iso(g[0].endMs)}`);
      assert.deepEqual(deviceAlertIds(gaps, r.clk.now), ids, '★★★ the same alert id: nothing is pushed again');
      assert.equal(deviceGapCount(gaps, r.clk.now, 24 * H), 1, '★★ Device Telemetry Gaps 24h stays 1');
      assert.ok(lines.some((l) => l.includes(`DEVICE TELEMETRY GAP — ${CORE_A}`) && l.includes(`its newest row, ${iso(r.T0 + 630 * MIN)}, is a held row moved back to samples, and the record keeps the start it was filed with`)), lines.filter((l) => l.includes('DEVICE TELEMETRY GAP')).join('\n'));
    } finally { rec2.close(); }
  });
}

for (const withPanel of [true, false]) {
  test(`★★★ every home device held — ${withPanel ? 'the panel behind its shadow latch, ' : ''}both Cores replayed with fresh clocks: one fleet gap that names them, no per-device warning`, (t) => {
    reset([]);
    const T0 = phx(2026, 10, 24, 5, 0);
    const clk = clocked(t, T0);
    const lines: string[] = [];
    const rec = createRecorder(makeStore(), (m) => lines.push(m));
    const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
    const S = T0 + 30 * MIN;
    const thePanel = (fresh: boolean): Snap[] => (!withPanel ? [] : [fresh ? panel(clk.now) : panel(clk.now, { contentAt: S, shadowSince: S })]);
    try {
      for (let m = 1; m <= 30; m++) { clk.at(T0 + m * MIN); send([...thePanel(true), dpu(CORE_A, clk.now, 50 + m), dpu(CORE_B, clk.now, 20 + m)]); }
      for (let m = 31; m <= 30 + 8 * 60; m++) {
        clk.at(T0 + m * MIN);
        send([...thePanel(false), dpu(CORE_A, clk.now, 80), dpu(CORE_B, clk.now, 50)]);
        if (m % 60 === 0) rec.scanHeldSamples!(clk.now);
      }
      assert.ok(heldRowsOf(CORE_A) > 0 && heldRowsOf(CORE_B) > 0, 'precondition: both replays moved');
      assert.deepEqual(rec.telemetryGaps(), [], `★★★ no per-device record while no home device had a fresh reading: ${JSON.stringify(rec.telemetryGaps())}`);
      const R = T0 + (30 + 8 * 60 + 1) * MIN;
      for (let m = 30 + 8 * 60 + 1; m <= 30 + 8 * 60 + 30; m++) { clk.at(T0 + m * MIN); send([...thePanel(true), dpu(CORE_A, clk.now, 81 + (m % 5)), dpu(CORE_B, clk.now, 51 + (m % 5))]); }
      const gaps = rec.telemetryGaps();
      assert.deepEqual(gaps.filter((g) => g.sn != null), [], '★★★ none when the fleet came back either');
      const fleet = gaps.filter((g) => g.sn == null);
      assert.equal(fleet.length, 1, JSON.stringify(gaps));
      assert.equal(fleet[0].startMs, S, `★★ from the last fresh home reading: ${iso(fleet[0].startMs)}`);
      assert.equal(fleet[0].endMs, R, 'to the first fresh one');
      const cores = [{ sn: CORE_A, shadow: false, replayed: true }, { sn: CORE_B, shadow: false, replayed: true }];
      assert.deepEqual(fleet[0].held, withPanel ? [...cores, { sn: PANEL, shadow: true }] : cores, '★★ what was held, each as it was held');
      assert.equal(fleet[0].unmeasured, undefined, '★ a replayed Core is not "read with nothing measurable"');
      assert.equal(deviceGapCount(gaps, clk.now, 24 * H), 0, '★★ Device Telemetry Gaps 24h: 0');
      const [a] = outageAlerts(JSON.parse(JSON.stringify(gaps)), clk.now, OPTS, nameOf);
      assert.equal(a.title, `Telemetry gap — no data for ${Math.round((R - S) / MIN)} min`);
      assert.equal(a.facts?.find((f) => f.label === 'Type')?.value, 'in-process (held readings)');
      const phrase = `every home device it had a reading for was held — ${withPanel ? 'the EcoFlow cloud replayed the last payload of Smart Home Panel 2 (cloud shadow); ' : ''}Core 1 and Core 2 only restated their last readings, which the hourly check moved out of the history as held samples, so no fresh reading was recorded (only fresh readings are kept).`;
      assert.ok(a.detail.includes(phrase), `★★ the pushed text: ${a.detail}`);
      const why = `held ${CORE_A} (restating readings the held-sample scan moved), ${CORE_B} (restating readings the held-sample scan moved)${withPanel ? `, ${PANEL} (cloud shadow)` : ''}`;
      assert.ok(lines.some((l) => l.includes(why)), lines.filter((l) => l.includes('TELEMETRY GAP')).join('\n'));
    } finally { rec.close(); }
  });
}

test('★ a restart into a fleet-wide hold, the Core replayed: the in-process fleet gap starts at the first write after the boot, not inside the restart\'s own record', (t) => {
  reset([]);
  const T0 = phx(2026, 10, 26, 5, 0);
  const clk = clocked(t, T0);
  const S = T0 + 30 * MIN;
  let rec = createRecorder(makeStore(), () => {});
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  const heldMinute = (m: number) => { clk.at(T0 + m * MIN); send([panel(clk.now, { contentAt: S, shadowSince: S }), dpu(CORE_A, clk.now, 80)]); };
  for (let m = 1; m <= 30; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 50 + m)]); }
  for (let m = 31; m <= 120; m++) heldMinute(m); // no scan in this process
  rec.close();
  clk.at(T0 + 125 * MIN);
  rec = createRecorder(makeStore(), () => {});
  try {
    for (let m = 126; m <= 300; m++) {
      heldMinute(m);
      if (m === 127 || m % 60 === 0) rec.scanHeldSamples!(clk.now);
    }
    assert.ok(heldRowsOf(CORE_A) > 0, 'precondition: the replay moved by the boot scan');
    for (let m = 301; m <= 310; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 81 + (m % 5))]); }
    const fleet = rec.telemetryGaps().filter((g) => g.sn == null).sort((a, b) => a.startMs - b.startMs);
    assert.deepEqual(fleet.map((g) => [g.restartSpanning === true, g.startMs, g.endMs]), [[true, T0 + 120 * MIN, T0 + 125 * MIN], [false, T0 + 126 * MIN, T0 + 301 * MIN]],
      `★ the restart's record, then the in-process one from this process's first home write — not from ${iso(S)}, inside the first: ${JSON.stringify(fleet.map((g) => [iso(g.startMs), iso(g.endMs)]))}`);
    assert.deepEqual(rec.telemetryGaps().filter((g) => g.sn != null), [], 'no per-device record');
  } finally { rec.close(); }
});

test('★ every home device held, then one Core\'s span restored while its replay goes on: its restored rows are readings — no fleet gap from the last fresh home reading', (t) => {
  reset([]);
  const T0 = phx(2026, 10, 25, 5, 0);
  const clk = clocked(t, T0);
  const rec = createRecorder(makeStore(), () => {});
  const send = (devices: Snap[]) => rec.insertSnapshot({ generatedAt: clk.now, devices: Object.fromEntries(devices.map((d) => [d.sn, d])) } as any);
  try {
    for (let m = 1; m <= 30; m++) { clk.at(T0 + m * MIN); send([panel(clk.now), dpu(CORE_A, clk.now, 50 + m), dpu(CORE_B, clk.now, 20 + m)]); }
    const S = T0 + 30 * MIN;
    const minute = (m: number) => {
      clk.at(T0 + m * MIN);
      send([panel(clk.now, { contentAt: S, shadowSince: S }), dpu(CORE_A, clk.now, 80), dpu(CORE_B, clk.now, 50)]);
      if (m % 60 === 0) rec.scanHeldSamples!(clk.now);
    };
    for (let m = 31; m <= 200; m++) minute(m);
    assert.ok(heldRowsOf(CORE_A) > 0 && heldRowsOf(CORE_B) > 0, 'precondition: both replays moved');
    assert.ok(rec.restoreHeldSamples!(CORE_A, S) > 0, 'precondition: Core 1\'s span restored');
    for (let m = 201; m <= 240; m++) minute(m);
    assert.deepEqual(rec.telemetryGaps().filter((g) => g.sn == null), [], `★ Core 1 wrote readings throughout: ${JSON.stringify(rec.telemetryGaps())}`);
  } finally { rec.close(); }
});

test('★ a write lock held on another connection (an SQL session mid-transaction) fails the move\'s slice, not the scan; the next scan moves it', (t) => {
  const { BOOT, rows, heldA } = heldCore();
  reset(rows);
  let now = BOOT;
  t.mock.method(Date, 'now', () => now);
  const lines: string[] = [];
  const rec = createRecorder(makeStore(), (m) => lines.push(m));
  const other = new DatabaseSync(DB_PATH);
  try {
    other.exec('BEGIN IMMEDIATE');
    const first = rec.scanHeldSamples!(now);
    assert.equal(first.rowsMoved, 0, 'nothing moved while the lock is held');
    assert.ok(lines.some((l) => l.includes(`held-sample move FAILED for ${CORE_A}`)), `★ the slice fails and says so: ${lines.filter((l) => l.includes('held-sample')).join('\n')}`);
    other.exec('ROLLBACK');
    now += H;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length, '★ the next scan moves the hold');
  } finally { try { other.exec('ROLLBACK'); } catch { /* released */ } other.close(); rec.close(); }
});
