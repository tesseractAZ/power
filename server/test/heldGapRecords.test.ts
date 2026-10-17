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
/** A Core's DPU projection with a fresh content clock (14 metrics written). */
const dpu = (sn: string, contentAt: number, soc: number): Snap => ({
  sn, deviceName: names[sn] ?? sn, lastTelemetryAtMs: contentAt,
  projection: {
    kind: 'dpu', soc, pvTotalWatts: 0, pvHighWatts: 0, pvLowWatts: 0, pvHighVolts: 1, pvHighAmps: 1, pvLowVolts: 1, pvLowAmps: 1,
    acInWatts: 0, acOutWatts: 300, totalInWatts: 0, totalOutWatts: 300, batVol: 52, batAmp: -6, packs: [],
  },
});

/** In this process: a Core changes to T0 + 30 min, then the cloud replays its body with a fresh
 *  clock for 2 h (a Core has no shadow latch: the gate passes it, the heartbeat writes it), then it
 *  stops while the panel reports; the hourly scan moves the replay. */
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
