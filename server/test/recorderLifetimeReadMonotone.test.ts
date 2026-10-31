import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1.193.0 — Panel Load (fleet_load_wh), Grid Import (Home) (fleet_grid_home_wh) and the circuit
 * counters between rollups after a sharp load drop.
 *
 * A read integrated each panel series from the watermark to the READ INSTANT, and integrateWh holds
 * the newest reading forward to that instant. The next reading revises that span by trapezoid (or
 * drops it, across a gap over 10 min), so a read after a load drop came out lower than the one
 * before it: 100 Wh at 9 -> 1 kW across a 90 s row gap, 147.5 Wh at 19.2 -> 1.5 kW across 60 s,
 * 3.2 kWh after a 10-min silence at 19.2 kW. Only two keys held a dip over 50 Wh, so Home Assistant
 * logged these counters as "not strictly increasing" and booked a negative hour across an hour
 * boundary (64-223 Wh in the live log).
 *
 * Now a read integrates up to the newest reading only: up to it the segments are the ones the next
 * rollup integrates, and the rollup only adds after them, so a read never shows more than the
 * rollup keeps and the publish guard never has to hold (heldWh 0). The published value lags the
 * newest reading by at most one sample interval.
 *
 * The panel's rows are written at chosen instants through a second connection; the store emits no
 * change, so the recorder writes none of its own. Test serials are placeholders.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-read-monotone-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.RECORDER_HELD_SCAN = 'off';

const { createRecorder } = await import('../src/recorder.js');
const { haTotalIncreasing } = await import('./helpers/haTotalIncreasing.js');

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const PANEL = 'PANEXXX00XXX0009';
const SERIES = [
  { key: 'fleet_load_wh', metric: 'panel_load' },
  { key: 'fleet_grid_home_wh', metric: 'grid_home_w' },
  { key: 'circuit_1_wh', metric: 'ch1_w' },
] as const;
const S = 1_000;
const MIN = 60 * S;
const T0 = Date.UTC(2026, 9, 20, 4, 0); // 21:00 at the site
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

function panelDevice() {
  return {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: T0,
    projection: {
      kind: 'shp2', area: null, backupBatPercent: 50, backupFullCapWh: null, backupRemainWh: null,
      backupChargeTimeMin: null, backupDischargeTimeMin: null, backupReserveSoc: null,
      chargeWattPower: null, circuits: [{ ch: 1 }], pairedCircuits: [], sources: [],
      sourceWatts: [], gridWatt: 0, strategy: {} as any,
    },
  };
}

type Reading = { total: number; pending: number; held: number };

/** A fresh database and recorder at T0, the panel's three series written through `row`. */
function plant(t: TestContext) {
  const raw0 = new DatabaseSync(process.env.DB_PATH!);
  raw0.exec(`CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, sn TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS lifetime_totals (metric_key TEXT PRIMARY KEY, wh REAL NOT NULL DEFAULT 0, last_integrated_ts INTEGER NOT NULL DEFAULT 0);
    DELETE FROM samples; DELETE FROM lifetime_totals;`);
  raw0.close();
  rmSync(join(dirname(process.env.DB_PATH!), '.emit-highwater.json'), { force: true });
  const clock = { now: T0 };
  t.mock.method(Date, 'now', () => clock.now);
  const ee = new EventEmitter() as any;
  ee.snap = { generatedAt: T0, devices: { [PANEL]: panelDevice() } };
  ee.get = () => ee.snap;
  const rec = createRecorder(ee, () => {});
  const raw = new DatabaseSync(process.env.DB_PATH!);
  const ins = raw.prepare(`INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)`);
  let open = true;
  const close = () => { if (open) { open = false; rec.close(); raw.close(); } };
  t.after(close);
  return {
    rec,
    close,
    at: (ms: number) => { clock.now = ms; },
    /** One panel row on every series (watts, or one value per series). */
    row: (ts: number, w: number | readonly number[]) => {
      SERIES.forEach((s, i) => ins.run(ts, PANEL, s.metric, typeof w === 'number' ? w : w[i]));
    },
    read: (): Record<string, Reading> => {
      const all = rec.getLifetimeTotals();
      return Object.fromEntries(SERIES.map((s) => {
        const v = all[s.key];
        return [s.key, { total: v.persistedWh + v.pendingWh, pending: v.pendingWh, held: v.heldWh ?? NaN }];
      }));
    },
  };
}

/** The first rollup at T0 with one row 30 s before it: the watermark is T0, the row at 30 s × w. */
function anchor(p: ReturnType<typeof plant>, w: number): number {
  p.row(T0 - 30 * S, w);
  p.at(T0);
  p.rec.rollupLifetime();
  const r = p.read();
  for (const s of SERIES) assert.ok(near(r[s.key].total, (w * 30) / 3600), `anchor ${s.key}`);
  return (w * 30) / 3600;
}

test('★★★ 9 kW -> 1 kW across a 90 s row gap: the read after the drop is not lower (was 100 Wh lower), and the rollup keeps at least what was read', (t) => {
  const p = plant(t);
  const base = anchor(p, 9_000); // 75 Wh
  const s0 = T0 + 60 * S;
  p.row(s0, 9_000);
  p.at(s0 + 89 * S);
  const a = p.read();
  p.row(s0 + 90 * S, 1_000);
  p.at(s0 + 91 * S);
  const b = p.read();
  for (const { key } of SERIES) {
    // Up to the newest reading (s0): 60 s at 9 kW = 150 Wh; the old read held 9 kW to s0 + 89 s (372.5 Wh).
    assert.ok(near(a[key].total, base + 150), `${key}: the read shows energy up to the newest reading only (${a[key].total})`);
    // + the 9 -> 1 kW trapezoid over 90 s = 125 Wh.
    assert.ok(near(b[key].total, base + 275), `${key}: 350 Wh after the 1 kW row (${b[key].total})`);
    assert.ok(b[key].total >= a[key].total, `${key}: not lower than the read before`);
    assert.equal(a[key].held, 0, `${key}: nothing to hold`);
    assert.equal(b[key].held, 0, `${key}: nothing to hold (was 97.2 Wh under the guard, 100 Wh published as a dip before it)`);
  }
  p.at(s0 + 120 * S);
  p.rec.rollupLifetime();
  const c = p.read();
  for (const { key } of SERIES) {
    // The rollup: 150 + 125 + its own 30 s at 1 kW to its instant = 283.3 Wh, persisted.
    assert.ok(near(c[key].total, base + 275 + (1_000 * 30) / 3600), `${key}: the rollup keeps the read and adds its own tail (${c[key].total})`);
    assert.equal(c[key].pending, 0, `${key}: no reading past the rollup yet`);
    assert.equal(c[key].held, 0);
  }
});

test('★★★ 19.2 kW -> 1.5 kW across a 60 s row gap: no decrease (was 147.5 Wh)', (t) => {
  const p = plant(t);
  const base = anchor(p, 19_200); // 160 Wh
  const s0 = T0 + 60 * S;
  p.row(s0, 19_200);
  p.at(s0 + 59 * S);
  const a = p.read();
  p.row(s0 + 60 * S, 1_500);
  p.at(s0 + 61 * S);
  const b = p.read();
  for (const { key } of SERIES) {
    assert.ok(near(a[key].total, base + 320), `${key}: 60 s at 19.2 kW up to the newest reading (${a[key].total})`);
    assert.ok(near(b[key].total, base + 320 + 172.5), `${key}: + the 60 s trapezoid to 1.5 kW (${b[key].total})`);
    assert.equal(b[key].held, 0, `${key}: no hold needed`);
  }
});

test('★★★ 19.2 kW, then 10 min without a row: the reads do not extrapolate, so the row after the silence takes nothing back (was a 3.2 kWh dip)', (t) => {
  const p = plant(t);
  const base = anchor(p, 19_200);
  const s0 = T0 + 60 * S;
  p.row(s0, 19_200);
  const reads: number[] = [];
  for (let m = 1; m <= 10; m++) {
    p.at(s0 + m * MIN);
    const r = p.read();
    for (const { key } of SERIES) assert.ok(near(r[key].total, base + 320), `${key} at +${m} min: the newest reading's energy only (${r[key].total})`);
    reads.push(r.fleet_load_wh.total);
  }
  // The next row lands 10 min 1 s after the last: a gap the integrator does not bridge.
  p.row(s0 + 601 * S, 1_500);
  p.at(s0 + 602 * S);
  const after = p.read();
  for (const { key } of SERIES) {
    assert.ok(near(after[key].total, base + 320), `${key}: the >10 min segment books 0 and the read does not fall (${after[key].total})`);
    assert.equal(after[key].held, 0, `${key}: nothing held (was 3,200 Wh held, under the 5 kWh hold)`);
  }
  reads.push(after.fleet_load_wh.total);
  p.rec.rollupLifetime();
  const r = p.read();
  for (const { key } of SERIES) {
    assert.ok(r[key].total >= after[key].total, `${key}: the rollup keeps it`);
    assert.ok(near(r[key].total, base + 320 + (1_500 * 1) / 3600), `${key}: + 1 s at 1.5 kW to the rollup (${r[key].total})`);
  }
  reads.push(r.fleet_load_wh.total);
  assert.equal(haTotalIncreasing(reads).dips, 0);
});

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test('★★★ fuzz — 10 random panel streams (0-20 kW, row gaps 10 s - 12 min, sharp drops), reads between rows, a rollup every 5 min: every published counter only rises and the guard never holds', (t) => {
  for (let stream = 0; stream < 10; stream++) {
    const rand = rng(0x5eed + stream);
    const p = plant(t);
    const w = SERIES.map(() => rand() * 20_000);
    p.row(T0 - 30 * S, w);
    p.at(T0);
    p.rec.rollupLifetime();
    let ts = T0 - 30 * S;
    let nextRollup = T0 + 5 * MIN;
    const published: Record<string, number[]> = Object.fromEntries(SERIES.map((s) => [s.key, []]));
    const readAt = (ms: number) => {
      p.at(ms);
      const r = p.read();
      for (const { key } of SERIES) {
        const prev = published[key][published[key].length - 1];
        assert.equal(r[key].held, 0, `stream ${stream} at +${((ms - T0) / S).toFixed(0)} s ${key}: a read never shows more than the rollup keeps (held ${r[key].held} Wh)`);
        if (prev != null) assert.ok(r[key].total >= prev, `stream ${stream} ${key}: ${r[key].total} after ${prev}`);
        published[key].push(r[key].total);
      }
    };
    for (let i = 0; i < 300; i++) {
      const gap = rand() < 0.8 ? 10 * S + rand() * 80 * S : 90 * S + rand() * (12 * MIN - 90 * S);
      const next = ts + Math.round(gap);
      // Reads and rollups strictly between this row and the next, in time order.
      const events: Array<{ ms: number; kind: 'read' | 'rollup' }> = [];
      const nReads = Math.floor(rand() * 4);
      for (let k = 0; k < nReads; k++) events.push({ ms: ts + 1 + Math.floor(rand() * (next - ts - 1)), kind: 'read' });
      while (nextRollup < next) { events.push({ ms: Math.max(nextRollup, ts + 1), kind: 'rollup' }); nextRollup += 5 * MIN; }
      events.sort((x, y) => x.ms - y.ms || (x.kind === 'rollup' ? -1 : 1));
      for (const e of events) {
        if (e.kind === 'read') readAt(e.ms);
        else { p.at(e.ms); p.rec.rollupLifetime(); readAt(e.ms); }
      }
      // The next row: a sharp drop a fifth of the time, the same reading a fifth, else anything.
      for (let j = 0; j < w.length; j++) {
        const u = rand();
        if (u < 0.2) w[j] = rand() * 2_000;
        else if (u < 0.6) w[j] = rand() * 20_000;
      }
      ts = next;
      p.row(ts, w);
    }
    for (const { key } of SERIES) {
      const ha = haTotalIncreasing(published[key]);
      assert.equal(ha.resets, 0, `stream ${stream} ${key}: no meter reset`);
      assert.equal(ha.dips, 0, `stream ${stream} ${key}: no negative hour`);
      assert.ok(published[key].length > 100, 'the stream was read');
    }
    p.close();
  }
});

test('★★ the lag is at most one sample interval: a flat 2 kW with rows only at the 5-min heartbeat reads within 166.7 Wh below the true energy, never above', (t) => {
  const p = plant(t);
  const base = anchor(p, 2_000);
  const rows: number[] = [];
  for (let k = 1; k <= 24; k++) rows.push(T0 + k * 5 * MIN - 30 * S);
  let lagMax = 0;
  for (let ms = T0 + 37 * S, nextRollup = T0 + 5 * MIN; ms < T0 + 2 * 60 * MIN; ms += 37 * S) {
    while (rows.length > 0 && rows[0] <= ms) p.row(rows.shift()!, 2_000);
    if (nextRollup <= ms) { p.at(nextRollup); p.rec.rollupLifetime(); nextRollup += 5 * MIN; }
    p.at(ms);
    const r = p.read();
    const trueWh = (2_000 * (ms - T0)) / 3_600_000;
    for (const { key } of SERIES) {
      const got = r[key].total - base;
      assert.ok(got <= trueWh + 1e-6, `${key} at +${(ms - T0) / S} s: never above the true energy (${got} > ${trueWh})`);
      assert.ok(got >= trueWh - (2_000 * 5) / 60 - 1e-6, `${key} at +${(ms - T0) / S} s: at most 5 min at 2 kW behind (${got} vs ${trueWh})`);
      lagMax = Math.max(lagMax, trueWh - got);
    }
  }
  assert.ok(lagMax > 100, `the heartbeat lag is real (${lagMax.toFixed(1)} Wh at most): energy is delayed, never lost`);
});
