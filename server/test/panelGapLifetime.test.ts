/**
 * v1.188.1 (review) — the lifetime counters across a short gap in the PANEL's rows.
 *
 * The recorder writes a panel row only while the panel's reading is fresh (heldSamples
 * projectionRecordable: a quota within 3 min, no cloud-shadow latch). Before v1.188.1 the 5-minute
 * heartbeat restated the held panel values through such an episode, so the rows never stopped. Now
 * a shadow episode (the cloud replaying one body; 2-6 min, 2-4 times a day here) or a quota stall
 * leaves a row gap of several minutes, and the lifetime rollup integrates each 5-min window on its
 * own: integrateWh gives a window with no row 0 Wh. Every window that fell inside the gap was lost
 * from Panel Load (fleet_load_wh), Grid Import (Home) (fleet_grid_home_wh), each circuit and, while
 * the Cores are dark, the energy bridge's battery out — total_increasing counters, never rewritten.
 * During an 8 kW night charge that was ~0.67 kWh of grid import per lost window.
 *
 * Now a window with no row while the series' last row is less than the look-back old HOLDS its
 * watermark (the counters' and the bridge's), and the next window integrates across the gap from the
 * rows on both sides, as integrateWh bridges a gap of up to 10 min inside one window. A longer gap is
 * still not bridged: the 10-min rule is unchanged.
 *
 * End to end through a real SnapshotStore and createRecorder; quotas every minute, a rollup every
 * 5 min. Test serials are placeholders.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ef-panel-gap-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(tmp, 'shadow-witness.json');
process.env.RECORDER_HELD_SCAN = 'off';

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

type Any = any;
const MIN = 60_000;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const PANEL = 'PANEXXX00XXX0001';
const CORES = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003'];
const flush = () => new Promise<void>((r) => setImmediate(r));

function clocks(t: TestContext, wall0: number) {
  const c = { wall: wall0, mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  return { advance: (ms: number) => { c.wall += ms; c.mono += ms; } };
}
function fresh(): void {
  for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { recursive: true, force: true });
}
function newStore(): Any {
  const store = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  return store;
}
const total = (rec: Any, k: string): number => { const t = rec.getLifetimeTotals()[k]; return t ? t.persistedWh + t.pendingWh : 0; };

/** The house panel's quota for reading `k`: ~3.5 kW of circuits, 8 kW through the main (a night
 *  charge). With `sources`, three connected Cores delivering ~1130 W each through their slots. */
function panelQuota(k: number, sources: boolean): Record<string, unknown> {
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

type Minute = 'ok' | 'replay' | 'fail';

/**
 * 30 minutes of normal quotas, then 60 minutes in which `perturb(m)` says what the panel does in
 * minute m: a new reading, the cloud replaying the last body (`replay`: the shadow latches), or the
 * quota failing (`fail`: setDeviceError). Returns each counter's rise over the 60 minutes and the
 * true energy over them (the panel's real readings, held at the replayed value while replayed).
 */
async function hour(t: TestContext, day: number, perturb: (m: number) => Minute, o: { sources?: boolean } = {}) {
  fresh();
  const sources = o.sources === true;
  const { advance } = clocks(t, phx(2026, 10, day, 21, 0));
  const store = newStore();
  const rec: Any = createRecorder(store, () => {});
  const list = [{ sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 },
    ...(sources ? CORES.map((sn, i) => ({ sn, deviceName: `Core ${i + 1}`, productName: 'Delta Pro Ultra', online: 0 })) : [])];
  let k = 0;
  let q = panelQuota(0, sources);
  const truth = { load: 0, grid: 0, out: 0 };
  const minute = async (what: Minute) => {
    advance(MIN);
    store.setDeviceList(list);
    await flush();
    if (what === 'ok') q = panelQuota(++k, sources);
    if (what === 'fail') store.setDeviceError(PANEL, 'getQuotaAll ETIMEDOUT');
    else store.setDeviceQuota(PANEL, q);
    await flush();
  };
  let latched = 0;
  try {
    for (let m = 1; m <= 30; m++) { await minute('ok'); if (m % 5 === 0) rec.rollupLifetime(); }
    const keys = ['fleet_load_wh', 'fleet_grid_home_wh', 'circuit_2_wh', 'fleet_battery_discharge_wh'];
    const start = Object.fromEntries(keys.map((key) => [key, total(rec, key)]));
    for (let m = 1; m <= 60; m++) {
      const what = perturb(m);
      await minute(what);
      // The physical plant carries on whatever the cloud says: the next real reading's values.
      const real = what === 'ok' ? q : panelQuota(k + 1, sources);
      truth.load += loadOf(real) / 60;
      truth.grid += ((real['wattInfo.gridWatt'] as number) ?? 0) / 60;
      if (sources) truth.out += slotsOutOf(real) / 60;
      if (store.get().devices[PANEL].contentStaleSinceMs != null) latched += 1;
      if (m % 5 === 0) rec.rollupLifetime();
    }
    const rise = Object.fromEntries(keys.map((key) => [key, total(rec, key) - start[key]]));
    return { rise, truth, latched };
  } finally {
    rec.close();
  }
}

const within = (got: number, want: number, frac: number, msg: string) =>
  assert.ok(Math.abs(got - want) <= want * frac, `${msg}: ${got.toFixed(0)} Wh against ${want.toFixed(0)} Wh (±${(frac * 100).toFixed(1)} %)`);

test('control: an hour of normal readings — every counter books the hour', async (t) => {
  const { rise, truth } = await hour(t, 16, () => 'ok');
  within(rise.fleet_load_wh, truth.load, 0.01, 'Panel Load');
  within(rise.fleet_grid_home_wh, truth.grid, 0.01, 'Grid Import (Home)');
});

test('★★★ a panel cloud shadow (the cloud replays one body for 7 polls, the latch holds ~5 min) during an 8 kW night charge: Panel Load, Grid Import (Home) and the circuit counter keep every window', async (t) => {
  const { rise, truth, latched } = await hour(t, 18, (m) => (m >= 18 && m <= 24 ? 'replay' : 'ok'));
  assert.ok(latched >= 4, `precondition: the shadow latched (${latched} min)`);
  // Before: 292 Wh of load and 667 Wh of grid import lost for good (a 5-min window inside the gap).
  within(rise.fleet_load_wh, truth.load, 0.01, 'Panel Load');
  within(rise.fleet_grid_home_wh, truth.grid, 0.01, 'Grid Import (Home)');
  within(rise.circuit_2_wh, 3302 * 1, 0.01, 'circuit 2 (≈3.3 kW for the hour)');
});

test('★★★ a panel quota stall of 8 polls whose row gap swallows a whole rollup window: the counters wait for the next reading and fill the gap', async (t) => {
  const { rise, truth } = await hour(t, 20, (m) => (m >= 19 && m <= 26 ? 'fail' : 'ok'));
  within(rise.fleet_load_wh, truth.load, 0.012, 'Panel Load');
  within(rise.fleet_grid_home_wh, truth.grid, 0.012, 'Grid Import (Home)');
});

test('★★ a gap over 10 min is still not bridged (the integrator’s rule, unchanged): a 16-poll stall drops its middle', async (t) => {
  const { rise, truth } = await hour(t, 22, (m) => (m >= 19 && m <= 34 ? 'fail' : 'ok'));
  assert.ok(rise.fleet_grid_home_wh < truth.grid * 0.9, `no extrapolation across a long gap: ${rise.fleet_grid_home_wh.toFixed(0)} of ${truth.grid.toFixed(0)} Wh`);
  assert.ok(rise.fleet_grid_home_wh > truth.grid * 0.6, 'the rest of the hour is booked');
});

test('★★★ every Core dark, the bridge metering the slots: a panel cloud shadow does not drop the battery out of the windows inside it', async (t) => {
  const { rise, truth, latched } = await hour(t, 24, (m) => (m >= 18 && m <= 24 ? 'replay' : 'ok'), { sources: true });
  assert.ok(latched >= 4, `precondition: the shadow latched (${latched} min)`);
  within(rise.fleet_battery_discharge_wh, truth.out, 0.02, 'battery out (the slots)');
  within(rise.fleet_load_wh, truth.load, 0.01, 'Panel Load beside it');
});

test('★★★ every Core dark: a panel quota stall across a rollup instant books the slot rows that exist (it was judged on the instant and dropped the whole window)', async (t) => {
  const { rise, truth } = await hour(t, 26, (m) => (m >= 19 && m <= 26 ? 'fail' : 'ok'), { sources: true });
  within(rise.fleet_battery_discharge_wh, truth.out, 0.02, 'battery out (the slots)');
});

test('★★★ every Core dark: a cloud shadow that latches just before a rollup — the window’s rows from before the latch are booked (judged on the reading at the instant, the whole window was dropped)', async (t) => {
  // The replay starts at minute 21 and latches before the rollup at 25: [20, 25] has rows at 21 and
  // earlier, and the panel is not fresh at 25. Before: that window booked nothing (3.10 of 3.38 kWh).
  const { rise, truth, latched } = await hour(t, 28, (m) => (m >= 21 && m <= 27 ? 'replay' : 'ok'), { sources: true });
  assert.ok(latched >= 4, `precondition: the shadow latched (${latched} min)`);
  within(rise.fleet_battery_discharge_wh, truth.out, 0.02, 'battery out (the slots)');
});
