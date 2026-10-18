/**
 * v1.188.1 (review) — ONE notion of "a Core's own reading" across the recorder's freshness gate, the
 * energy bridge and the two power sensors, end to end: a real SnapshotStore feeds createRecorder
 * through its 'change' events (extract() and the gate decide which rows exist), lifetime rollups run
 * every 5 min, and the published figures are Recorder.bridgedFleetFlow over aggregateFleetFlow's
 * sums, as both publishers compute them.
 *
 * Before: the bridge took a Core only once the cloud listed it OFFLINE, the gate keyed on arrival
 * only, and the power sensors summed every Core listed online. So a Core listed online without a
 * reading of its own (a quota that keeps failing, a REST 200 replaying a cached body, an online flip
 * before the first quota after a restart) was booked by nobody, or booked as replayed solar, while
 * Battery Net published a partial sum or a frozen figure; and a Core the cloud listed offline whose
 * MQTT data kept arriving had its measured solar replaced by the inferred lower bound.
 *
 * Test serials are placeholders.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'ef-own-reading-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(tmp, 'shadow-witness.json');
process.env.RECORDER_HELD_SCAN = 'off';
const DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { aggregateFleetFlow, isSourceDpuFrozen } = await import('../src/shp2Membership.js');
const { publishReadiness } = await import('../src/publishReadiness.js');

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

type Any = any;
const MIN = 60_000;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const CORES = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003'];
const PANEL = 'PANEXXX00XXX0001';
const ALL = [...CORES, PANEL];
const PACKS = 2;
const MAH_TO_WH = 0.1024;

const listItem = (sn: string, online: boolean): Any => ({
  sn, deviceName: sn === PANEL ? 'Smart Home Panel 2' : `Core ${CORES.indexOf(sn) + 1}`,
  productName: sn === PANEL ? 'Smart Home Panel 2' : 'Delta Pro Ultra', online: online ? 1 : 0,
});
/** The panel's REST quota: three connected sources delivering ~`w` W each (negative = delivering). */
const panelQuota = (k: number, w: number[], pct: number[]): Record<string, unknown> => {
  const q: Record<string, unknown> = {
    'loadInfo.hall1Watt': [k % 300, 3300 + k, 104, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'wattInfo.gridWatt': 0,
    'backupInfo.chWatt': w.map((x, i) => x + ((k + i) % 7)),
  };
  CORES.forEach((sn, i) => {
    const b = `pd303_mc.backupIncreInfo.Energy${i + 1}Info.`;
    q[`${b}devInfo.modelInfo.sn`] = sn;
    q[`${b}isConnect`] = 1;
    q[`${b}isAcOpen`] = 1;
    q[`${b}batteryPercentage`] = pct[i];
    q[`${b}devInfo.fullCap`] = 30720;
    q[`${b}hwConnect`] = 1;
  });
  return q;
};
/** A Core's REST quota: `k` moves its readings (a fixed `k` is a replayed body); `pv` W of PV; its
 *  packs' discharge register `dsgMah`. */
const coreQuota = (sn: string, k: number, o: { pv?: number; dsgMah?: number } = {}): Record<string, unknown> => {
  const q: Record<string, unknown> = {
    'hs_yj751_pd_appshow_addr.soc': 60,
    'hs_yj751_pd_appshow_addr.wattsOutSum': 900 + k,
    'hs_yj751_pd_appshow_addr.wattsInSum': (o.pv ?? 0) + k,
    'hs_yj751_pd_appshow_addr.outAc5p8Pwr': 850 + k,
    'hs_yj751_pd_appshow_addr.inHvMpptPwr': o.pv ?? 0,
    'hs_yj751_pd_backend_addr.batVol': 51 + (k % 7) / 10,
    'hs_yj751_pd_app_set_info_addr.chgMaxSoc': 100,
  };
  for (let i = 1; i <= PACKS; i++) {
    const b = `hs_yj751_bms_slave_addr.${i}.`;
    q[`${b}packSn`] = `${sn}-P${i}`;
    q[`${b}soc`] = 60;
    q[`${b}fullCap`] = 56_000;
    q[`${b}designCap`] = 60_000;
    q[`${b}remainCap`] = 30_000;
    q[`${b}accuChgCap`] = 1_000_000;
    q[`${b}accuDsgCap`] = o.dsgMah ?? 1_000_000;
    q[`${b}outputWatts`] = 560 + (k % 3);
    q[`${b}inputWatts`] = 0;
  }
  return q;
};

function clocks(t: TestContext, wall0: number) {
  const c = { wall: wall0, mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  return { c, advance: (ms: number) => { c.wall += ms; c.mono += ms; } };
}
const flush = () => new Promise<void>((r) => setImmediate(r));
function fresh(): void {
  for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { recursive: true, force: true });
}
function rows(sql: string, ...p: Array<string | number>): Any[] {
  const db = new DatabaseSync(DB_PATH);
  try { return db.prepare(sql).all(...p) as Any[]; } finally { db.close(); }
}
const total = (rec: Any, k: string): number => { const t = rec.getLifetimeTotals()[k]; return t ? t.persistedWh + t.pendingWh : 0; };
function newStore(): Any {
  const store = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  return store;
}
/** What both publishers publish (index.ts /api/ha-state, mqttDiscovery buildState). */
function published(rec: Any, store: Any): { pv: number | null; net: number | null; ready: boolean; bridged: number; flowBridged: boolean } {
  const devices = store.get().devices;
  const { fleetPv, fleetBatteryNetDisplay: fleetBatteryNet } = aggregateFleetFlow(devices);
  const b = rec.bridgedFleetFlow({ fleetPv, fleetBatteryNet }, devices, Date.now());
  const r = publishReadiness({ devices, alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: null, runway: null, clipping: null,
    curtailment: null, carbon: null, tariff: null, degradation: null, nowMs: Date.now(), flowBridge: b } as Any);
  return { pv: b.fleetPv, net: b.fleetBatteryNet, ready: b.ready, bridged: b.bridgedSlots, flowBridged: r.flowBridged };
}

/** What the panel's slots deliver now (W, positive = out of the Cores). */
const slotsOut = (store: Any): number => -(store.get().devices[PANEL].projection.sourceWatts as number[]).reduce((a, b) => a + b, 0);
/** 1130 W out of each pack pair, in mAh per minute per pack. */
const DSG_MAH_PER_MIN = 1130 / 60 / MAH_TO_WH / PACKS;
const NIGHT_W = [-1130, -1130, -1130];

test('★★★ the reconnect after a restart while dark: a Core flipped ONLINE by /status, its quota then failing, is still metered at its slot — Battery Net is every slot, never a partial sum — and its first fresh body is absorbed', async (t) => {
  fresh();
  const { advance } = clocks(t, phx(2026, 10, 16, 21, 0));
  let store = newStore();
  let rec = createRecorder(store, () => {});
  const dsg: Record<string, number> = Object.fromEntries(CORES.map((sn) => [sn, 1_000_000]));
  try {
    let k = 0;
    const minute = async (coresOnline: boolean, quota: boolean) => {
      advance(MIN);
      for (const sn of CORES) dsg[sn] += DSG_MAH_PER_MIN;
      store.setDeviceList(ALL.map((sn) => listItem(sn, sn === PANEL || coresOnline)));
      await flush();
      store.setDeviceQuota(PANEL, panelQuota(k, NIGHT_W, [55, 55, 55])); await flush();
      if (quota) for (const sn of CORES) store.setDeviceQuota(sn, coreQuota(sn, k, { dsgMah: dsg[sn] }));
      await flush();
      k++;
    };
    // 21:00-21:15 every Core live; 21:15-21:45 every Core cloud-offline (bridged, packs marked).
    for (let m = 1; m <= 15; m++) { await minute(true, true); if (m % 5 === 0) rec.rollupLifetime(); }
    const out0 = total(rec, 'fleet_battery_discharge_wh');
    for (let m = 1; m <= 30; m++) { await minute(false, false); if (m % 5 === 0) rec.rollupLifetime(); }
    assert.equal(rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS, 'precondition: bridged, every pack marked');
    // The deploy: the store sees every Core afresh, listed offline, no projection.
    rec.close();
    store = newStore();
    rec = createRecorder(store, () => {});
    for (let m = 1; m <= 10; m++) { await minute(false, false); if (m % 5 === 0) rec.rollupLifetime(); }
    // Core 1 reconnects: MQTT /status flips it online before any quota; then the device list lists
    // it online but its quota keeps failing for 10 min.
    store.setDeviceOnline(CORES[0], true);
    await flush();
    const atFlip = published(rec, store);
    assert.deepEqual([atFlip.ready, atFlip.bridged, atFlip.flowBridged], [true, 3, true], 'still bridged at the flip');
    assert.equal(atFlip.net, slotsOut(store), 'Battery Net is every slot, not a partial sum');
    const core1Before = rec.batteryLifetimeDebug().bridge.cores[CORES[0]]?.dischargeWh ?? 0;
    for (let m = 1; m <= 10; m++) {
      advance(MIN);
      for (const sn of CORES) dsg[sn] += DSG_MAH_PER_MIN;
      store.setDeviceList(ALL.map((sn) => listItem(sn, sn === PANEL || sn === CORES[0])));
      await flush();
      store.setDeviceQuota(PANEL, panelQuota(k++, NIGHT_W, [55, 55, 55])); await flush();
      store.setDeviceError(CORES[0], 'getQuotaAll ETIMEDOUT');
      await flush();
      if (m % 5 === 0) rec.rollupLifetime();
      const p = published(rec, store);
      assert.equal(p.ready, true, `minute ${m}: ready`);
      assert.equal(p.net, slotsOut(store), `minute ${m}: Battery Net`);
    }
    const core1Hour = (rec.batteryLifetimeDebug().bridge.cores[CORES[0]]?.dischargeWh ?? 0) - core1Before;
    assert.ok(Math.abs(core1Hour - 1130 * 10 / 60) < 1130 / 60 * 1.5, `Core 1's slot was metered while listed online without a reading: ${core1Hour.toFixed(0)} Wh`);
    // Its first quota only seeds the content witness: not a reading yet, still bridged.
    advance(20_000);
    store.setDeviceQuota(CORES[0], coreQuota(CORES[0], k, { dsgMah: dsg[CORES[0]] }));
    await flush();
    assert.equal(rec.batteryLifetimeDebug().bridge.markers.filter((m: string) => m.startsWith(CORES[0])).length, PACKS, 'a first body after a restart is not the return');
    // Its next body changes: it reports; the hand-over absorbs the jump.
    advance(20_000);
    store.setDeviceQuota(CORES[0], coreQuota(CORES[0], k + 1, { dsgMah: dsg[CORES[0]] }));
    await flush();
    total(rec, 'fleet_battery_discharge_wh');
    assert.equal(rec.batteryLifetimeDebug().bridge.markers.filter((m: string) => m.startsWith(CORES[0])).length, 0, 'handed back');
    const out = total(rec, 'fleet_battery_discharge_wh') - out0;
    const trueWh = 3 * 1130 * 50 / 60;
    assert.ok(Math.abs(out - trueWh) < trueWh * 0.04, `battery out over the 50 dark minutes: ${out.toFixed(0)} Wh against ${trueWh.toFixed(0)} (the jump absorbed, not added; no span left to nobody)`);
  } finally { rec.close(); }
});

test('★★★ a Core listed ONLINE whose cloud REPLAYS its cached body: not recorded, metered at its slot, no phantom solar, and Fleet PV never publishes the replayed figure', async (t) => {
  fresh();
  const { c, advance } = clocks(t, phx(2026, 10, 16, 10, 0));
  const store = newStore();
  const rec = createRecorder(store, () => {});
  try {
    let k = 0;
    const tick = async (replay: boolean) => {
      advance(MIN);
      store.setDeviceList(ALL.map((sn) => listItem(sn, true)));
      await flush();
      store.setDeviceQuota(PANEL, panelQuota(k, [-500, -500, -500], [60, 60, 60])); await flush();
      store.setDeviceQuota(CORES[0], coreQuota(CORES[0], replay ? 29 : k, { pv: 2000 }));
      store.setDeviceQuota(CORES[1], coreQuota(CORES[1], k));
      store.setDeviceQuota(CORES[2], coreQuota(CORES[2], k));
      await flush();
      k++;
    };
    for (let m = 1; m <= 30; m++) { await tick(false); if (m % 5 === 0) rec.rollupLifetime(); }
    const pv0 = total(rec, 'fleet_pv_wh');
    const from = c.wall;
    for (let m = 1; m <= 120; m++) { await tick(true); if (m % 5 === 0) rec.rollupLifetime(); }
    const devices = store.get().devices;
    assert.equal(isSourceDpuFrozen({ isConnected: true, sn: CORES[0] }, devices, Date.now()), true, 'precondition: the card reads it from its slot');
    const pvRows = Number(rows("SELECT COUNT(*) AS n FROM samples WHERE sn = ? AND metric = 'pv_total' AND ts > ?", CORES[0], from + 6 * MIN)[0].n);
    assert.equal(pvRows, 0, 'the gate writes no replayed row past the content window');
    const added = total(rec, 'fleet_pv_wh') - pv0;
    // The replay said 2 kW of PV for 2 h (4 kWh). The slot delivered 500 W at a flat SoC: the
    // inferred lower bound is ~1 kWh.
    assert.ok(added < 1500, `no phantom solar: ${added.toFixed(0)} Wh added`);
    const slots = rec.batteryLifetimeDebug().bridge.lastRollup?.slots ?? [];
    assert.deepEqual(slots.map((s: Any) => [s.sn, s.basis]), [[CORES[0], 'inferred']]);
    const p = published(rec, store);
    assert.equal(p.pv, null, 'daylight, the panel PV field unchecked: unknown, never the replayed 2000 W');
    assert.equal(p.net, null);
  } finally { rec.close(); }
});

test('★★★ a Core listed ONLINE whose quota keeps failing at night: its slot is metered from its last reading, and Battery Net is the whole pool', async (t) => {
  fresh();
  const { advance } = clocks(t, phx(2026, 10, 16, 21, 0));
  const store = newStore();
  const rec = createRecorder(store, () => {});
  try {
    let k = 0;
    const tick = async (failing: boolean) => {
      advance(MIN);
      store.setDeviceList(ALL.map((sn) => listItem(sn, sn === PANEL || sn === CORES[0])));
      await flush();
      store.setDeviceQuota(PANEL, panelQuota(k, NIGHT_W, [55, 55, 55])); await flush();
      if (failing) store.setDeviceError(CORES[0], 'getQuotaAll ETIMEDOUT');
      else store.setDeviceQuota(CORES[0], coreQuota(CORES[0], k));
      await flush();
      k++;
    };
    for (let m = 1; m <= 20; m++) { await tick(false); if (m % 5 === 0) rec.rollupLifetime(); }
    const before = rec.batteryLifetimeDebug().bridge;
    for (let m = 1; m <= 60; m++) { await tick(true); if (m % 5 === 0) rec.rollupLifetime(); }
    const after = rec.batteryLifetimeDebug().bridge;
    const core1 = after.cores[CORES[0]]?.dischargeWh ?? 0;
    assert.ok(core1 > 1130 * 55 / 60, `Core 1 (listed online, no reading of its own) is metered: ${core1.toFixed(0)} Wh`);
    const hour = after.dischargeWh - before.dischargeWh;
    assert.ok(hour > 3 * 1130 * 0.92, `the hour's discharge covers all three slots: ${hour.toFixed(0)} Wh`);
    const p = published(rec, store);
    assert.equal(p.ready, true);
    assert.equal(p.net, slotsOut(store), 'Battery Net: the pool through the panel, not the two offline slots plus a frozen projection');
  } finally { rec.close(); }
});

test('★★★ a Core the cloud lists OFFLINE whose MQTT data keeps arriving is its own reading: its measured solar is counted, the bridge stays off, and Fleet PV sums it', async (t) => {
  fresh();
  const { advance } = clocks(t, phx(2026, 10, 16, 10, 0));
  const store = newStore();
  const rec = createRecorder(store, () => {});
  try {
    let k = 0;
    const capWh = 30720;
    let stored1 = 0.5 * capWh;
    const tick = async (core1Online: boolean) => {
      advance(MIN);
      stored1 += 1300 / 60; // 2 kW PV, 500 W to the panel, 200 W of its own draw
      store.setDeviceList(ALL.map((sn) => listItem(sn, sn === CORES[0] ? core1Online : true)));
      await flush();
      store.setDeviceQuota(PANEL, panelQuota(k, [-500, 0, 0], [Math.floor((stored1 / capWh) * 100), 60, 60])); await flush();
      if (core1Online) store.setDeviceQuota(CORES[0], coreQuota(CORES[0], k, { pv: 2000 }));
      else store.mergeDeviceQuota(CORES[0], coreQuota(CORES[0], k, { pv: 2000 }), 'mqtt');
      store.setDeviceQuota(CORES[1], coreQuota(CORES[1], k));
      store.setDeviceQuota(CORES[2], coreQuota(CORES[2], k));
      await flush();
      k++;
    };
    for (let m = 1; m <= 20; m++) { await tick(true); if (m % 5 === 0) rec.rollupLifetime(); }
    const pv0 = total(rec, 'fleet_pv_wh');
    for (let m = 1; m <= 120; m++) { await tick(false); if (m % 5 === 0) rec.rollupLifetime(); }
    const pv = total(rec, 'fleet_pv_wh') - pv0;
    assert.ok(Math.abs(pv - 4000) < 120, `Core 1's own 2 kW for 2 h, not the inferred lower bound: ${pv.toFixed(0)} Wh`);
    const dbg = rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.lastRollup?.slots, [], 'not a dark slot');
    assert.deepEqual(dbg.markers, []);
    const p = published(rec, store);
    assert.deepEqual([p.pv, p.ready, p.flowBridged], [2000, true, true], 'Fleet PV sums its own reading although the cloud lists it offline');
  } finally { rec.close(); }
});
