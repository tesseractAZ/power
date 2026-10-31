/**
 * v1.188.1 — the lifetime energy counters across a HELD panel's row gap, and the gate that makes it.
 *
 * The recorder writes a panel row only while the panel's reading is fresh (heldSamples.ts
 * projectionRecordable), so a cloud-shadow replay or a quota stall leaves a row gap, and the
 * lifetime integrator bridges a gap of at most 10 min. v1.188.0 lost nothing in these cases: its
 * 5-min heartbeat restated the held reading, and the counters integrated it. The integration review
 * found that v1.188.1 lost whole 5-min windows of Panel Load, Grid Import (Home), the circuits and,
 * while the Cores are dark, the energy bridge's battery out, once a gap passed 10 min:
 *  - the first NEW body after a replay was not written while the shadow latch (whose release waits
 *    for a second new body) was still set, so a 9-poll replay was an 11-min row gap;
 *  - with two panels, the counter's hold summed the rows of every panel, so a live second panel
 *    released the held one's window.
 * Now (1) a body that arrives new is written whatever the latch's release (latchedBodyNew), (2) across
 * a row gap the gate explains — the panel watched through it and held, not absent — of at most
 * HELD_ENERGY_BRIDGE_MAX_MS (30 min), the counters integrate the held reading restated every 5 min,
 * as v1.188.0's rows were (createHeldGapLog, recorder energyPoints), a longer gap staying a gap, and
 * (3) the hold is judged per panel.
 *
 * The V1880_* figures are what v1.188.0 (main 111247f) booked for the same scenarios, measured by
 * running each against its recorder. End to end through a real SnapshotStore and createRecorder;
 * a quota every minute, a rollup every 5 min. Test serials are placeholders.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'ef-held-gap-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(tmp, 'shadow-witness.json');
process.env.RECORDER_HELD_SCAN = 'off';
const DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const {
  createHeldGapLog, latchedBodyNew, projectionRecordable, heldSinceMs,
  HELD_ENERGY_BRIDGE_MAX_MS, HELD_RESTATE_EVERY_MS, HELD_EVAL_GAP_MS,
} = await import('../src/heldSamples.js');
const { advanceBodySeen } = await import('../src/shp2Shadow.js');
const { connectedSourceListings: serverListings, panelForClient } = await import('../src/shp2Membership.js');
const { connectedSourceListings: webListings } = await import('../../web/src/shp2Membership.js');
const { bridgeFleetFlow, slotVerdicts } = await import('../src/energyBridge.js');
const { liveGridBackstop } = await import('../src/gridState.js');
const { energyFlowModel, batteriesTitle } = await import('../../web/src/cards/energyFlowModel.js');

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

type Any = any;
const MIN = 60_000;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const PANEL = 'PANEXXX00XXX0001';
const PANEL2 = 'PANEXXX00XXX0002';
const CORES = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003'];
const flush = () => new Promise<void>((r) => setImmediate(r));

/** What v1.188.0 booked over the hour for every single-panel replay or stall below (each of 6-12 polls,
 *  the 9-poll latch, and the panel listed offline for 12 polls): the held reading integrated, i.e. the
 *  true energy of these scenarios. */
const V1880_LOAD_WH = 3509;
const V1880_GRID_WH = 8004;
/** …and with a second panel live beside a 7-poll replay of the first (both panels summed). */
const V1880_TWO_PANEL_LOAD_WH = 3560;
const V1880_TWO_PANEL_GRID_WH = 8014;

function fresh(): void {
  for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { recursive: true, force: true });
}
const total = (rec: Any, k: string): number => { const t = rec.getLifetimeTotals()[k]; return t ? t.persistedWh + t.pendingWh : 0; };
const rowsOf = (sn: string, metric: string, fromMs: number): number[] => {
  const db = new DatabaseSync(DB_PATH);
  try { return (db.prepare('SELECT ts FROM samples WHERE sn = ? AND metric = ? AND ts > ? ORDER BY ts').all(sn, metric, fromMs) as Any[]).map((r) => Number(r.ts)); } finally { db.close(); }
};
/** v1.193.0 — a series' newest row at or before `atMs`. */
const newestRow = (sn: string, metric: string, atMs: number): { ts: number; value: number } | null => {
  const db = new DatabaseSync(DB_PATH);
  try {
    const r = db.prepare('SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').get(sn, metric, atMs) as Any;
    return r ? { ts: Number(r.ts), value: Number(r.value) } : null;
  } finally { db.close(); }
};

/** The house panel's quota for reading `k`: ~3.5 kW of circuits, 8 kW through the main (a night
 *  charge). With `sources`, three connected Cores delivering ~1130 W each through their slots. */
function panelQuota(k: number, sources = false): Record<string, unknown> {
  const q: Record<string, unknown> = {
    'loadInfo.hall1Watt': [100 + (k % 7), 3300 + (k % 5), 104, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'wattInfo.gridWatt': sources ? 0 : 8000 + (k % 9),
  };
  if (sources) {
    q['backupInfo.chWatt'] = [-1130, -1130, -1130].map((x, i) => x + ((k + i) % 7));
    CORES.forEach((sn, i) => {
      const b = `pd303_mc.backupIncreInfo.Energy${i + 1}Info.`;
      q[`${b}devInfo.modelInfo.sn`] = sn;
      q[`${b}isConnect`] = 1;
      q[`${b}isAcOpen`] = 1;
      q[`${b}batteryPercentage`] = 50;
      q[`${b}devInfo.fullCap`] = 30720;
      q[`${b}hwConnect`] = 1;
    });
  }
  return q;
}
const loadOf = (q: Record<string, unknown>): number => (q['loadInfo.hall1Watt'] as number[]).reduce((a, b) => a + b, 0);
const slotsOutOf = (q: Record<string, unknown>): number => -(q['backupInfo.chWatt'] as number[]).reduce((a, b) => a + b, 0);

/** What the panel does in one minute: a new reading, the cloud replaying the last body (the shadow
 *  latches after 5 polls / 4 min), the quota failing, the panel listed offline (no quota fetched), or
 *  nothing at all happening (no device list, no quota: a fleet silence, nothing evaluated). */
type Minute = 'ok' | 'replay' | 'fail' | 'offline' | 'silent';

/**
 * 30 minutes of normal quotas, then 60 minutes in which `perturb(m)` says what the panel does in minute
 * m. `truth` is what v1.188.0 integrated: the panel's readings, held at the replayed or last value
 * through a replay or a stall (the energy a held reading stands for). `second`: a second panel, always
 * live, beside the first.
 */
async function hour(
  t: TestContext, day: number, perturb: (m: number) => Minute,
  o: { sources?: boolean; second?: boolean; probe?: (m: number, rec: Any) => void } = {},
) {
  fresh();
  const sources = o.sources === true;
  const c = { wall: phx(2026, 10, day, 21, 0), mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  const store: Any = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  const rec: Any = createRecorder(store, () => {});
  const list = (panelOnline: boolean) => [
    { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: panelOnline ? 1 : 0 },
    ...(o.second ? [{ sn: PANEL2, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 }] : []),
    ...(sources ? CORES.map((sn, i) => ({ sn, deviceName: `Core ${i + 1}`, productName: 'Delta Pro Ultra', online: 0 })) : []),
  ];
  let k = 0;
  let q = panelQuota(0, sources);
  const truth = { load: 0, grid: 0, out: 0 };
  const minute = async (what: Minute) => {
    c.wall += MIN;
    c.mono += MIN;
    if (what === 'silent') return;
    store.setDeviceList(list(what !== 'offline'));
    await flush();
    if (what === 'ok') q = panelQuota(++k, sources);
    if (what === 'fail') store.setDeviceError(PANEL, 'getQuotaAll ETIMEDOUT');
    else if (what !== 'offline') store.setDeviceQuota(PANEL, q);
    await flush();
    if (o.second) {
      const m = Math.round(c.wall / MIN);
      store.setDeviceQuota(PANEL2, { 'loadInfo.hall1Watt': [50 + (m % 3), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'wattInfo.gridWatt': 10 + (m % 2) });
      await flush();
    }
  };
  let latched = 0;
  /** The largest difference between a read just before a rollup and one just after it, at the same
   *  instant, over the panel counters: the read path integrates the same series the rollup books.
   *  v1.193.0 — a read integrates up to the newest reading only, while the rollup still holds that
   *  reading to its own instant (persisted, final): the read may trail the rollup by exactly that
   *  span at the newest reading's power (8 kW × 3 min = 400 Wh at the onset of a replay), never by
   *  more (the same series, restated across a gap the gate explains, up to the newest reading), and
   *  never exceed it (a dip). The figure is the largest departure from that. */
  let readVsRollupWh = 0;
  const panelKeys = ['fleet_load_wh', 'fleet_grid_home_wh', 'circuit_2_wh'];
  const panelMetrics = ['panel_load', 'grid_home_w', 'ch2_w'];
  const hourStartMs = c.wall + 30 * MIN;
  try {
    for (let m = 1; m <= 30; m++) { await minute('ok'); if (m % 5 === 0) rec.rollupLifetime(); }
    const keys = ['fleet_load_wh', 'fleet_grid_home_wh', 'circuit_2_wh', 'fleet_battery_discharge_wh'];
    const start = Object.fromEntries(keys.map((key) => [key, total(rec, key)]));
    for (let m = 1; m <= 60; m++) {
      await minute(perturb(m));
      truth.load += loadOf(q) / 60;
      truth.grid += ((q['wattInfo.gridWatt'] as number) ?? 0) / 60;
      if (sources) truth.out += slotsOutOf(q) / 60;
      if (store.get().devices[PANEL].contentStaleSinceMs != null) latched += 1;
      if (m % 5 === 0) {
        const before = panelKeys.map((key) => total(rec, key));
        rec.rollupLifetime();
        // Measured, not published: the publish guard would hold a dip at the read's value.
        const after = rec.getLifetimeTotals();
        panelKeys.forEach((key, i) => {
          const a = after[key];
          const measured = a.persistedWh + a.pendingWh - (a.heldWh ?? 0);
          const n = newestRow(PANEL, panelMetrics[i], c.wall);
          // The rollup's own hold of the newest reading to its instant (integrateWh: within 10 min),
          // when it wrote the window (a window with no row while the gap can still be bridged is held).
          const wrote = a.watermarkMs === c.wall;
          const tail = wrote && n && c.wall - n.ts <= 10 * MIN ? (n.value * (c.wall - n.ts)) / 3_600_000 : 0;
          readVsRollupWh = Math.max(readVsRollupWh, Math.abs(measured - before[i] - tail));
        });
      }
      o.probe?.(m, rec);
    }
    const rise = Object.fromEntries(keys.map((key) => [key, total(rec, key) - start[key]]));
    const gridRows = rowsOf(PANEL, 'grid_home_w', hourStartMs).map((ts) => Math.round((ts - hourStartMs) / MIN));
    return { rise, truth, latched, gridRows, store, readVsRollupWh };
  } finally {
    rec.close();
  }
}

const within = (got: number, want: number, tolWh: number, msg: string) =>
  assert.ok(Math.abs(got - want) <= tolWh, `${msg}: ${got.toFixed(0)} Wh against ${want.toFixed(0)} Wh (±${tolWh} Wh)`);

/* ── (1) the gate keys on content ─────────────────────────────────────────── */

test('★★★ advanceBodySeen: unlatched every changed body is new; latched only a body not seen since the content froze', () => {
  let s = advanceBodySeen(undefined, 'A', false);
  assert.equal(s.isNew, true, 'a first body');
  s = advanceBodySeen(s.seen, 'A', false);
  assert.equal(s.isNew, false, 'the same body again (unlatched) is not new');
  s = advanceBodySeen(s.seen, 'A', true);
  assert.equal(s.isNew, false, 'the frozen body at the latch is not new');
  s = advanceBodySeen(s.seen, 'B1', true);
  assert.equal(s.isNew, true, 'the first refreshed body while latched is NEW content (the latch waits for a second)');
  s = advanceBodySeen(s.seen, 'B1', true);
  assert.equal(s.isNew, false, 'the refreshed body replayed is not');
  s = advanceBodySeen(s.seen, 'A', true);
  assert.equal(s.isNew, false, 'the frozen body again is not');
  s = advanceBodySeen(s.seen, 'B1', true);
  assert.equal(s.isNew, false, 'a cloud alternating between cached bodies is not');
  s = advanceBodySeen(s.seen, null, false);
  assert.equal(s.isNew, false, 'an unmeasurable poll is never new');
  s = advanceBodySeen(s.seen, 'B2', false);
  assert.equal(s.isNew, true, 'after the release, a changed body is new');
});

test('★★★ latchedBodyNew / projectionRecordable: a latched panel is a reading at the arrival that brought a new body, not at its replay', () => {
  const now = phx(2026, 10, 18, 21, 30);
  const base = { projection: { kind: 'shp2' }, contentStaleSinceMs: now - 8 * MIN };
  const atNew = { ...base, lastTelemetryAtMs: now - 10_000, contentNewAtMs: now - 10_000 };
  assert.equal(latchedBodyNew(atNew), true);
  assert.equal(projectionRecordable(atNew, now), true, 'the first new body while the latch holds is written');
  const replayed = { ...base, lastTelemetryAtMs: now - 5_000, contentNewAtMs: now - 65_000 };
  assert.equal(projectionRecordable(replayed, now), false, 'its replay at the next poll is not');
  const onset = { ...base, lastTelemetryAtMs: now - 5_000, contentNewAtMs: now - 8 * MIN };
  assert.equal(projectionRecordable({ ...onset, lastTelemetryAtMs: now - 8 * MIN }, now), false, 'the frozen body (new at the onset) is not');
  assert.equal(projectionRecordable({ ...base, lastTelemetryAtMs: now - 5_000 }, now), false, 'no content clock: latched is not a reading');
  assert.equal(heldSinceMs({ ...replayed }), now - 65_000, 'a hold after a new body starts at that body, not at the latch onset');
  assert.equal(heldSinceMs({ ...base, lastTelemetryAtMs: now - 5_000, contentNewAtMs: now - 9 * MIN }), now - 8 * MIN, 'a body older than the onset does not move the start');
});

test('★★★ a 9-poll replay: the first new body after it is written while the latch still holds (it was dropped, an 11-min row gap)', async (t) => {
  const r = await hour(t, 18, (m) => (m >= 18 && m <= 26 ? 'replay' : 'ok'));
  assert.ok(r.latched >= 7, `precondition: the shadow latched (${r.latched} min)`);
  // Rows at minute 17 (the body the cloud then replays) and 27 (the first new body, latch still set).
  assert.ok(r.gridRows.includes(17), `the replayed body's own arrival is written (${r.gridRows.join(',')})`);
  assert.ok(!r.gridRows.some((m) => m >= 18 && m <= 26), 'no row while the cloud replays it');
  assert.ok(r.gridRows.includes(27), `the first new body is written although the latch had not released yet (${r.gridRows.join(',')})`);
});

test('★★ the new-body clock survives a device-list rebuild (setDeviceList carries it)', async (t) => {
  const now = phx(2026, 10, 19, 21, 0);
  t.mock.method(Date, 'now', () => now);
  const store: Any = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  const item = { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 };
  store.setDeviceList([item]);
  store.setDeviceQuota(PANEL, panelQuota(1));
  const at = store.get().devices[PANEL].contentNewAtMs;
  assert.equal(at, now);
  store.setDeviceList([item]);
  assert.equal(store.get().devices[PANEL].contentNewAtMs, at);
});

/* ── (2) the counters across a gap the gate explains: parity with v1.188.0 ─────── */

for (const [n, day] of [[6, 1], [7, 2], [8, 3], [9, 4], [10, 5], [11, 6], [12, 7]] as const) {
  test(`★★★ a ${n}-poll cloud-shadow replay during an 8 kW night charge books what v1.188.0 booked (Panel Load, Grid Import (Home))`, async (t) => {
    const r = await hour(t, day, (m) => (m >= 18 && m < 18 + n ? 'replay' : 'ok'));
    within(r.rise.fleet_load_wh, V1880_LOAD_WH, 1, 'Panel Load');
    within(r.rise.fleet_grid_home_wh, V1880_GRID_WH, 1, 'Grid Import (Home)');
    assert.ok(r.readVsRollupWh <= 1, `a read and the rollup at the same instant differ by the rollup's hold of the newest reading only (${r.readVsRollupWh.toFixed(1)} Wh off)`);
  });
  test(`★★★ a ${n}-poll quota stall during an 8 kW night charge books what v1.188.0 booked`, async (t) => {
    const r = await hour(t, day + 10, (m) => (m >= 18 && m < 18 + n ? 'fail' : 'ok'));
    within(r.rise.fleet_load_wh, V1880_LOAD_WH, 1, 'Panel Load');
    within(r.rise.fleet_grid_home_wh, V1880_GRID_WH, 1, 'Grid Import (Home)');
  });
}

test('★★★ the panel listed offline for 12 polls (a device-list blip: no quota fetched) books what v1.188.0 booked', async (t) => {
  // Before: 2.92 of 3.51 kWh of Panel Load and 6.67 of 8.00 kWh of Grid Import (Home).
  const r = await hour(t, 28, (m) => (m >= 18 && m <= 29 ? 'offline' : 'ok'));
  within(r.rise.fleet_load_wh, V1880_LOAD_WH, 1, 'Panel Load');
  within(r.rise.fleet_grid_home_wh, V1880_GRID_WH, 1, 'Grid Import (Home)');
});

test('★★★ a 29-poll replay (inside the 30-min bound) books the held reading across it, circuit counter too', async (t) => {
  const r = await hour(t, 20, (m) => (m >= 10 && m <= 38 ? 'replay' : 'ok'));
  within(r.rise.fleet_load_wh, r.truth.load, 2, 'Panel Load');
  within(r.rise.fleet_grid_home_wh, r.truth.grid, 2, 'Grid Import (Home)');
  within(r.rise.circuit_2_wh, 3302, 4, 'circuit 2 (≈3.3 kW for the hour)');
});

test('★★★ two panels: a 7-poll replay of the first while the second is live — the hold is judged per panel, as v1.188.0 booked', async (t) => {
  const r = await hour(t, 21, (m) => (m >= 18 && m <= 24 ? 'replay' : 'ok'), { second: true });
  assert.ok(r.latched >= 4, `precondition: the shadow latched (${r.latched} min)`);
  within(r.rise.fleet_load_wh, V1880_TWO_PANEL_LOAD_WH, 1, 'Panel Load (both panels)');
  within(r.rise.fleet_grid_home_wh, V1880_TWO_PANEL_GRID_WH, 1, 'Grid Import (Home) (both panels)');
});

test('★★★ two panels: a 15-poll quota stall of the first while the second is live — its held reading is booked', async (t) => {
  const r = await hour(t, 22, (m) => (m >= 18 && m <= 32 ? 'fail' : 'ok'), { second: true });
  // The second panel draws ~51 W of load and ~10.5 W through its main for the hour.
  within(r.rise.fleet_load_wh, r.truth.load + 51, 3, 'Panel Load (both panels)');
  within(r.rise.fleet_grid_home_wh, r.truth.grid + 10.5, 3, 'Grid Import (Home) (both panels)');
});

test('★★★ every Core dark, the bridge metering the slots: a 12-poll replay keeps the battery out of the windows inside it', async (t) => {
  const r = await hour(t, 23, (m) => (m >= 18 && m <= 29 ? 'replay' : 'ok'), { sources: true });
  assert.ok(r.latched >= 8, `precondition: the shadow latched (${r.latched} min)`);
  within(r.rise.fleet_battery_discharge_wh, r.truth.out, r.truth.out * 0.01, 'battery out (the slots)');
  within(r.rise.fleet_load_wh, r.truth.load, 2, 'Panel Load beside it');
});

test('★★★ every Core dark: a 25-poll quota stall (the bridge window held past its 15-min clamp) keeps the battery out', async (t) => {
  const r = await hour(t, 24, (m) => (m >= 15 && m <= 39 ? 'fail' : 'ok'), { sources: true });
  within(r.rise.fleet_battery_discharge_wh, r.truth.out, r.truth.out * 0.01, 'battery out (the slots)');
  within(r.rise.fleet_load_wh, r.truth.load, 2, 'Panel Load beside it');
});

/* ── beyond the bound, and what the gate does not explain ─────────────────────── */

test('★★★ a 40-poll quota stall (over the 30-min bound) is left a gap: nothing booked inside it, the rest of the hour booked', async (t) => {
  const r = await hour(t, 25, (m) => (m >= 10 && m <= 49 ? 'fail' : 'ok'));
  const perMin = V1880_GRID_WH / 60;
  // The 20 live minutes (with the integrator's own tail after the last row, inside its window).
  within(r.rise.fleet_grid_home_wh, 20 * perMin, perMin / 2, 'Grid Import (Home): the live minutes, none of the stall');
  within(r.rise.fleet_load_wh, 20 * V1880_LOAD_WH / 60, V1880_LOAD_WH / 120, 'Panel Load: the live minutes, none of the stall');
});

test('★★★ the 10-15 outage shape: the panel listed offline for 45 polls is not integrated at a reading from before it, and the counters stop waiting at the bound', async (t) => {
  let heldAt45: number | null = null;
  const r = await hour(t, 26, (m) => (m >= 10 && m <= 54 ? 'offline' : 'ok'), {
    // 35 min after the last row (minute 9): the persisted watermark has moved on past the gap's start.
    probe: (m, rec) => { if (m === 45) heldAt45 = rec.getLifetimeTotals().fleet_grid_home_wh.watermarkMs; },
  });
  assert.ok(heldAt45 != null && heldAt45 >= phx(2026, 10, 26, 21, 30 + 40), `past the bound the window is not held (watermark ${heldAt45 == null ? 'none' : new Date(heldAt45).toISOString()})`);
  const perMin = V1880_GRID_WH / 60;
  // The 15 live minutes only (v1.188.0 integrated the whole hour at the reading from before it).
  within(r.rise.fleet_grid_home_wh, 15 * perMin, perMin / 2, `Grid Import (Home): the outage is not booked (v1.188.0: ${r.truth.grid.toFixed(0)} Wh)`);
  within(r.rise.fleet_load_wh, 15 * V1880_LOAD_WH / 60, V1880_LOAD_WH / 120, 'Panel Load: nor here');
});

test('★★ a fleet silence inside a stall (nothing evaluated for 5 min) is not the gate\'s: that gap is not bridged', async (t) => {
  const r = await hour(t, 27, (m) => (m >= 22 && m <= 26 ? 'silent' : m >= 18 && m <= 29 ? 'fail' : 'ok'));
  // Rows at minutes 17 and 30: a 13-min gap with a silence in it, not bridged — 50 of the 60 minutes.
  within(r.rise.fleet_grid_home_wh, 50 * V1880_GRID_WH / 60, V1880_GRID_WH / 120, 'a silence is absence, not a hold');
});

/* ── the log's rules, unit by unit ─────────────────────────────────────────────── */

test('★★★ createHeldGapLog: a gap is explained only when the panel was watched through it, held in it, and not read fresh past a heartbeat', () => {
  const t0 = phx(2026, 10, 17, 2, 0);
  const feed = (log: Any, from: number, to: number, held: (t: number) => boolean, skip?: (t: number) => boolean) => {
    for (let t = from; t <= to; t += MIN) if (!skip?.(t)) log.note(PANEL, held(t), t);
  };
  // fresh to t0+10, held t0+11..t0+25, fresh from t0+26 (the next row there)
  const log = createHeldGapLog();
  feed(log, t0, t0 + 40 * MIN, (t) => t > t0 + 10 * MIN && t < t0 + 26 * MIN);
  assert.equal(log.explains(PANEL, t0 + 8 * MIN, t0 + 26 * MIN), true, 'a row 2 min before the hold, the next at its end');
  assert.equal(log.explains(PANEL, t0 + 4 * MIN, t0 + 26 * MIN), false, 'read fresh more than a heartbeat after the row: the metric was absent');
  assert.equal(log.explains(PANEL, t0 + 8 * MIN, t0 + 30 * MIN), false, 'read fresh before the next row: absent');
  assert.equal(log.explains(PANEL, t0 + 28 * MIN, t0 + 36 * MIN), false, 'never held inside the gap');
  assert.equal(log.explains('COREXXX00XXX0001', t0 + 8 * MIN, t0 + 26 * MIN), false, 'a device the log does not track');
  // a silence inside the hold
  const s = createHeldGapLog();
  feed(s, t0, t0 + 40 * MIN, (t) => t > t0 + 10 * MIN && t < t0 + 26 * MIN, (t) => t > t0 + 15 * MIN && t < t0 + 15 * MIN + HELD_EVAL_GAP_MS + 2 * MIN);
  assert.equal(s.explains(PANEL, t0 + 8 * MIN, t0 + 26 * MIN), false, 'nothing evaluated for more than HELD_EVAL_GAP_MS: not watched through');
  // …while a later hold, watched through after that silence, is the gate's
  feed(s, t0 + 41 * MIN, t0 + 70 * MIN, (t) => t > t0 + 50 * MIN && t < t0 + 62 * MIN);
  assert.equal(s.explains(PANEL, t0 + 48 * MIN, t0 + 62 * MIN), true, 'a hold after an earlier silence');
  // a stretch the gate never held is not its gap, however short
  const f = createHeldGapLog();
  feed(f, t0, t0 + 4 * MIN, () => false);
  assert.equal(f.explains(PANEL, t0, t0 + 4 * MIN), false, 'read fresh throughout: not held');
  assert.equal(f.open(PANEL, t0, t0 + 4 * MIN), false, 'nor open');
  // a restart: the log starts after the row
  const r = createHeldGapLog();
  feed(r, t0 + 12 * MIN, t0 + 40 * MIN, (t) => t < t0 + 26 * MIN);
  assert.equal(r.explains(PANEL, t0 + 8 * MIN, t0 + 26 * MIN), false, 'a gap across a restart is not bridged');
  // the bound
  const b = createHeldGapLog();
  feed(b, t0, t0 + 60 * MIN, (t) => t > t0 + 10 * MIN && t < t0 + 50 * MIN);
  assert.equal(b.explains(PANEL, t0 + 10 * MIN, t0 + 10 * MIN + HELD_ENERGY_BRIDGE_MAX_MS), true, 'a gap of exactly the bound');
  assert.equal(b.explains(PANEL, t0 + 10 * MIN, t0 + 10 * MIN + HELD_ENERGY_BRIDGE_MAX_MS + 1), false, 'over the bound');
  assert.equal(b.explains(PANEL, t0 + 10 * MIN, t0 + 50 * MIN), false, 'the whole 40-min hold');
  assert.equal(b.open(PANEL, t0 + 10 * MIN, t0 + 30 * MIN), true, 'open, inside the bound, still watched');
  assert.equal(b.open(PANEL, t0 + 10 * MIN, t0 + 10 * MIN + HELD_ENERGY_BRIDGE_MAX_MS + 1), false, 'open past the bound');
  assert.equal(b.heldWithin(PANEL, t0, t0 + 10 * MIN), false);
  assert.equal(b.heldWithin(PANEL, t0, t0 + 11 * MIN), true);
  // evaluations stop while held (a fleet silence begins)
  const w = createHeldGapLog();
  feed(w, t0, t0 + 20 * MIN, (t) => t > t0 + 10 * MIN);
  assert.equal(w.open(PANEL, t0 + 10 * MIN, t0 + 21 * MIN), true, 'watched a minute ago');
  assert.equal(w.open(PANEL, t0 + 10 * MIN, t0 + 20 * MIN + HELD_EVAL_GAP_MS + MIN), false, 'no evaluation for longer than HELD_EVAL_GAP_MS: not watched now');
});

test('★★★ restate: the held reading every 5 min across an explained gap, at the reading before it — nothing elsewhere', () => {
  const t0 = phx(2026, 10, 17, 3, 0);
  const log = createHeldGapLog();
  for (let t = t0; t <= t0 + 40 * MIN; t += MIN) log.note(PANEL, t > t0 + 10 * MIN && t < t0 + 23 * MIN, t);
  const pts = [{ ts: t0 + 9 * MIN, value: 8000 }, { ts: t0 + 23 * MIN, value: 8800 }, { ts: t0 + 24 * MIN, value: 8801 }];
  const out = log.restate(PANEL, pts);
  assert.deepEqual(out.map((p) => [Math.round((p.ts - t0) / MIN), p.value]), [[9, 8000], [14, 8000], [19, 8000], [23, 8800], [24, 8801]]);
  assert.equal(HELD_RESTATE_EVERY_MS, 5 * MIN);
  assert.deepEqual(createHeldGapLog().restate(PANEL, pts), pts, 'nothing logged: the rows as they are');
});

/* ── (4) the Energy flow card: a Core listed by two panels counts once ──────────── */

test('★★★ the Energy flow card counts a dark Core listed by two panels once, at the listing the bridge and the timers read', (t) => {
  const NOW = Date.UTC(2026, 9, 17, 6, 0);
  t.mock.method(Date, 'now', () => NOW);
  const darkCore: Any = { sn: CORES[0], deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: false, lastUpdated: NOW - 3600_000 };
  const panel = (sn: string, w: number, freshPanel = true): Any => ({
    sn, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: NOW,
    lastQuotaAtMs: freshPanel ? NOW - 20_000 : NOW - 20 * MIN, lastTelemetryAtMs: NOW - 20_000, contentStaleSinceMs: null,
    projection: { kind: 'shp2', circuits: [{ ch: 1, watts: 1000, name: 'x' }], pairedCircuits: [], gridWatt: 0, gridSta: 1, gridConnected: true,
      sources: [{ slot: 1, sn: CORES[0], isConnected: true, batteryPercentage: 50, fullCap: 30720 }], sourceWatts: [w] },
  });
  const ds: Record<string, Any> = { [CORES[0]]: darkCore, [PANEL]: panel(PANEL, -1000), [PANEL2]: panel(PANEL2, -1000) };
  const b = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, ds, NOW, () => false, { lat: 33.45, lon: -112.07 });
  const v = slotVerdicts(b);
  const client = { ...ds, [PANEL]: panelForClient(ds[PANEL], ds, NOW, v), [PANEL2]: panelForClient(ds[PANEL2], ds, NOW, v) };
  const card = energyFlowModel(client as Any, liveGridBackstop(ds) as Any);
  assert.equal(card.viaPanelCount, 1, batteriesTitle(card));
  assert.equal(card.batNet, b.fleetBatteryNet, 'the card\'s battery figure is the power sensor\'s');
  assert.equal(card.acOut, 1000);
});

test('★★ the web listing mirrors the server\'s connectedSourceListings (fresh panel first, then the house panel, then the serial)', () => {
  const NOW = Date.UTC(2026, 9, 17, 6, 0);
  const panel = (sn: string, o: { fresh?: boolean; online?: boolean; house?: boolean; w?: number[] }): Any => ({
    sn, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: o.online ?? true, lastUpdated: NOW,
    lastQuotaAtMs: o.fresh === false ? NOW - 20 * MIN : NOW - 20_000, contentStaleSinceMs: null, ...(o.house ? { housePanel: true } : {}),
    projection: { kind: 'shp2', circuits: [], pairedCircuits: [], gridWatt: 0, gridSta: 1, gridConnected: true,
      sources: CORES.map((s, i) => ({ slot: i + 1, sn: s, isConnected: true })), sourceWatts: o.w ?? [-1, -2, -3] },
  });
  const cases: Array<Record<string, Any>> = [
    { [PANEL]: panel(PANEL, { fresh: false }), [PANEL2]: panel(PANEL2, {}) },
    { [PANEL]: panel(PANEL, {}), [PANEL2]: panel(PANEL2, { house: true }) },
    { [PANEL]: panel(PANEL, { online: false }), [PANEL2]: panel(PANEL2, { fresh: false }) },
    { [PANEL2]: panel(PANEL2, {}), [PANEL]: panel(PANEL, {}) },
  ];
  for (const ds of cases) {
    const client = Object.fromEntries(Object.entries(ds).map(([sn, p]) => [sn, panelForClient(p, ds, NOW)]));
    const s = serverListings(ds, NOW).map((l: Any) => `${l.panel.sn}#${l.index}#${l.src.sn}`);
    const w = webListings(client as Any).map((l: Any) => `${l.panel.sn}#${l.index}#${l.src.sn}`);
    assert.deepEqual(w, s);
  }
});
