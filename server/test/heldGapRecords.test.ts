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
 * Fake serials throughout.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  try {
    now = BOOT + MIN;
    panelReads(rec, now);
    ids = deviceAlertIds(rec.telemetryGaps(), now);
    now = BOOT + 2 * MIN;
    assert.equal(rec.scanHeldSamples!(now).rowsMoved, heldA.length);
  } finally { rec.close(); }
  // The documented recipe, in one transaction: copy back, delete, mark restored, bump the generation.
  withDb((db) => {
    const span = db.prepare("SELECT end_ts FROM held_spans WHERE sn = ? AND start_ts = ? AND reason = 'frozen'").get(CORE_A, lastFresh) as { end_ts: number };
    db.exec('BEGIN');
    db.prepare('INSERT INTO samples (ts, sn, metric, value) SELECT ts, sn, metric, value FROM held_samples WHERE sn = ? AND ts > ? AND ts <= ?').run(CORE_A, lastFresh, span.end_ts);
    db.prepare('DELETE FROM held_samples WHERE sn = ? AND ts > ? AND ts <= ?').run(CORE_A, lastFresh, span.end_ts);
    db.prepare("UPDATE held_spans SET restored_at_ms = ? WHERE sn = ? AND start_ts = ? AND reason = 'frozen'").run(now, CORE_A, lastFresh);
    db.exec('INSERT INTO held_generation (id, gen) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET gen = gen + 1');
    db.exec('COMMIT');
  });
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
  assert.deepEqual(runCase(19).held, [{ sn: PANEL, shadow: false }], '★★ held through it');
  assert.equal(runCase(5).held, undefined, '★ the evaluations stopped 15 min before its end');
});
