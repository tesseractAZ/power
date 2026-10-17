/**
 * v1.188.1 — the energy bridge, driven through the REAL recorder (lifetime rollup, emitted totals,
 * BMS hand-over, restart).
 *
 * Live shape, 2026-10-14 23:52 → 10-16 MST: all home Cores cloud-offline, the Smart Home Panel 2
 * fresh, its three source slots metering ≈ −1145 / −1145 / −1119 W (the Cores supplying ~3.4 kW).
 * Home Assistant read battery in/out 0/0 and solar 0.0 kWh for 10-15 and 10-16. With the bridge:
 *  - at night the slots' outflow is battery out, at ~3.4 kWh/h; a night grid charge is battery in,
 *    never solar;
 *  - in daylight the PV that charges the Cores is inferred from the slots' net output plus the
 *    stored-energy rise (an unverified 0 W panel PV field is not "no PV"), or read from the field
 *    once it has shown a reading with the sun up;
 *  - when the Cores report again, their BMS counters jump by the dark days' throughput; the
 *    published totals do not jump (the bridge already counted it) and never step down;
 *  - a restart mid-outage keeps all of it.
 * Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'ef-energy-bridge-'));
const DB_PATH = join(tmp, 'ecoflow.db');
process.env.DB_PATH = DB_PATH;
// The v1.98.0 floor-gap re-seed at 5 kWh, so a few bridged hours already cross it.
process.env.BMS_RESEED_MIN_GAP_WH = '5000';
process.env.BMS_RESEED_SUSTAINED_ROLLUPS = '2';

const { createRecorder } = await import('../src/recorder.js');
type Rec = ReturnType<typeof createRecorder>;

const MIN = 60_000;
const H = 60 * MIN;
const PANEL = 'HD31XXX00XXX0001';
const CORES = ['Y711XXX00XXX0001', 'Y711XXX00XXX0002', 'Y711XXX00XXX0003'];
const PACK_MAH_TO_WH = 0.1024;
const FULL_CAP_MAH = 56_000; // per pack: 5,734 Wh
const PACKS = 2;
/** The 10-15 slot meters (W): the Cores supplying the panel. */
const DISCHARGE_W = [-1145, -1145, -1119];

const realNow = Date.now;
test.after(() => { Date.now = realNow; try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

type Any = any;

function dpu(sn: string, online: boolean, regs: { chg: number; dsg: number } | null): Any {
  return {
    sn, deviceName: sn, productName: 'DELTA Pro Ultra', online, lastUpdated: 0,
    ...(regs ? {
      projection: {
        kind: 'dpu', soc: 60, packCount: PACKS, pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, acOutWatts: 0,
        packs: Array.from({ length: PACKS }, (_, i) => ({
          num: i + 1, packSn: `${sn}-P${i + 1}`, soc: 60, inputWatts: 0, outputWatts: 0,
          designCapMah: 60_000, fullCapMah: FULL_CAP_MAH, remainCapMah: 30_000,
          accuChgMah: regs.chg, accuDsgMah: regs.dsg,
        })),
      },
    } : {}),
  };
}

function panelDev(t: number, sourceWatts: number[], pct: number[], pvW: number[] = [0, 0, 0]): Any {
  return {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true,
    lastUpdated: t, lastQuotaAtMs: t, contentStaleSinceMs: null,
    projection: {
      kind: 'shp2', backupBatPercent: 60, backupFullCapWh: 92_160, backupRemainWh: 55_000, backupReserveSoc: 10,
      circuits: [{ ch: 1, watts: 3400, name: 'Main' }], pairedCircuits: [], gridWatt: 0, gridSta: 1, gridConnected: true,
      sourceWatts,
      sources: CORES.map((sn, i) => ({
        slot: i + 1, sn, isConnected: true, isAcOpen: true, batteryPercentage: pct[i], fullCap: 30_720,
        ratePower: null, emsBatTemp: null, hwConnect: true, errorCodeNum: null, forceCharge: null,
        pvWatts: pvW[i], pvHighWatts: null, pvLowWatts: null, inputWatts: 0, outputWatts: 0,
      })),
      strategy: {},
    },
  };
}

/** One simulated plant: the real recorder, a store it reads, and a second connection that writes
 *  the samples the recorder would have recorded (the store emits no 'change', so nothing else does). */
class Plant {
  clock: number;
  rec!: Rec;
  store: Any;
  db!: DatabaseSync;
  ins!: ReturnType<DatabaseSync['prepare']>;
  logs: string[] = [];
  last: Record<string, number> = {};
  sourceWatts = [0, 0, 0];
  pct = [60, 60, 60];
  pvW = [0, 0, 0];
  coresOnline = true;
  regs: { chg: number; dsg: number } | null = { chg: 1_000_000, dsg: 1_000_000 };
  /** Keep the dark Cores' projection (the store preserves it across an offline flip); false = a
   *  restart while dark (no projection at all). */
  frozenProjection = true;
  panelStale = false;

  constructor(t0: number, opts: { reuse?: boolean } = {}) {
    if (!opts.reuse) for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { recursive: true, force: true });
    this.clock = t0;
    Date.now = () => this.clock;
    const ee = new EventEmitter() as Any;
    ee.get = () => ({ generatedAt: this.clock, devices: this.devices() });
    this.store = ee;
    this.open();
  }
  open(): void {
    this.rec = createRecorder(this.store, (m) => this.logs.push(m));
    this.db = new DatabaseSync(DB_PATH);
    this.ins = this.db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
  }
  restart(): void {
    this.rec.close();
    this.db.close();
    this.open();
  }
  close(): void {
    this.rec.close();
    this.db.close();
    Date.now = realNow;
  }
  devices(): Record<string, Any> {
    const p = panelDev(this.panelStale ? this.clock - 600_000 : this.clock, this.sourceWatts, this.pct, this.pvW);
    const out: Record<string, Any> = { [PANEL]: p };
    for (const sn of CORES) {
      const projected = this.coresOnline || this.frozenProjection;
      out[sn] = dpu(sn, this.coresOnline, projected ? this.regs : null);
    }
    return out;
  }
  sample(sn: string, metric: string, value: number, ts = this.clock): void {
    this.ins.run(ts, sn, metric, value);
  }
  /** Record the panel's slot series at `t` (what extract() writes). */
  panelSamples(t: number): void {
    for (let i = 0; i < 3; i++) {
      this.sample(PANEL, `src${i + 1}_w`, this.sourceWatts[i], t);
      this.sample(PANEL, `src${i + 1}_pct`, this.pct[i], t);
      this.sample(PANEL, `src${i + 1}_pv_w`, this.pvW[i], t);
    }
    this.sample(PANEL, 'grid_home_w', 0, t);
  }
  /** Advance the clock minute by minute, recording samples; a lifetime rollup every 5 minutes,
   *  each followed by a published read (asserted never to decrease). */
  run(minutes: number, each: (t: number, m: number) => void = () => {}): void {
    for (let m = 1; m <= minutes; m++) {
      const t = this.clock + MIN;
      each(t, m);
      this.panelSamples(t);
      this.clock = t;
      if (m % 5 === 0) {
        this.rec.rollupLifetime();
        this.read();
      }
    }
  }
  totals(): { chg: number; dsg: number; pv: number; gridImport: number } {
    const t = this.rec.getLifetimeTotals();
    const v = (k: string) => (t[k] ? t[k].persistedWh + t[k].pendingWh : 0);
    return { chg: v('fleet_battery_charge_wh'), dsg: v('fleet_battery_discharge_wh'), pv: v('fleet_pv_wh'), gridImport: v('fleet_grid_import_wh') };
  }
  /** A published read: every emitted total is non-decreasing. */
  read(): { chg: number; dsg: number; pv: number; gridImport: number } {
    const t = this.totals();
    for (const [k, v] of Object.entries(t)) {
      const prev = this.last[k];
      if (prev != null) assert.ok(v >= prev - 1e-6, `${k} stepped DOWN ${prev.toFixed(1)} → ${v.toFixed(1)} Wh at ${new Date(this.clock).toISOString()}`);
      this.last[k] = v;
    }
    return t;
  }
  /** The Cores report, capture baselines, then move a little: a held value exists per pack. */
  establishHeld(): void {
    this.rec.rollupLifetime();
    this.regs = { chg: 1_010_000, dsg: 1_008_000 };
    this.run(5);
  }
  goDark(sourceWatts: number[]): void {
    this.coresOnline = false;
    this.sourceWatts = sourceWatts;
  }
  rows(): string {
    return JSON.stringify(this.db.prepare('SELECT metric_key, wh, last_integrated_ts FROM lifetime_totals ORDER BY metric_key').all());
  }
}

const near = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(1)} vs ${b.toFixed(1)} (±${tol})`);

/* ── the 10-15 shape ─────────────────────────────────────────────────────── */

test('★★★ Cores dark at night, slots discharging 3.4 kW for 4 h → battery out rises ~3.4 kWh/h; battery in and PV stay flat', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark(DISCHARGE_W);
    p.run(240);
    const after = p.read();
    const expected = 3409 * 4 - 3409 / 60; // the first minute after the flip has no sample yet
    near(after.dsg - before.dsg, expected, expected * 0.01, 'battery out bridged');
    near(after.chg - before.chg, 0, 1, 'battery in');
    near(after.pv - before.pv, 0, 1, 'PV at night');
    const dbg = p.rec.batteryLifetimeDebug();
    near(dbg.bridge.dischargeWh, expected, expected * 0.01, 'the bridge row');
    assert.equal(dbg.bridge.markers.length, CORES.length * PACKS, 'every held pack is marked for the hand-over');
    assert.ok(p.logs.some((l) => l.includes('metering its battery and solar at the panel slot')), 'one line per Core');
  } finally { p.close(); }
});

test('★★★ daylight, grid 0, the Cores supplying 300 W each while PV charges them: battery in and PV production rise (an unverified 0 W field is not "no PV")', () => {
  const t0 = Date.parse('2026-10-15T09:00:00-07:00');
  const p = new Plant(t0);
  try {
    // The Cores' measured full-charge capacity, recorded while they reported: 5 packs × 56,000 mAh.
    for (const sn of CORES) for (let k = 1; k <= 5; k++) p.sample(sn, `pack${k}_full_cap_mah`, FULL_CAP_MAH, t0 - H);
    p.coresOnline = false;
    p.frozenProjection = false; // the live case: dark since before the restart, no projection
    p.sourceWatts = [-300, -300, -300];
    p.pct = [40, 40, 40];
    p.panelSamples(t0);
    const before = p.read();
    // SoC +1 % every 8 min for 4 h: 40 → 70 %. The panel's PV field reads 0 throughout.
    p.run(240, (_t, m) => { p.pct = CORES.map(() => 40 + Math.floor(m / 8)); });
    const after = p.read();
    const capWh = 5 * FULL_CAP_MAH * PACK_MAH_TO_WH; // 28,672 Wh
    const storedWh = (p.pct[0] - 40) / 100 * capWh;
    const perSlotPv = 300 * 4 + storedWh;
    near(after.pv - before.pv, 3 * perSlotPv, 3 * capWh / 100 + 30, 'PV production inferred');
    near(after.chg - before.chg, 3 * storedWh, 3 * capWh / 100 + 30, 'battery in');
    near(after.dsg - before.dsg, 0, 1, 'battery out: the 300 W the Cores supplied came from PV');
    assert.ok(after.pv - before.pv > 20_000, 'a 0 W reading from a field never seen working was not taken as PV = 0');
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.trustedSlots, [], 'the field never read above 0 W');
    assert.equal(dbg.lastRollup?.slots[0].basis, 'inferred');
  } finally { p.close(); }
});

test('★★★ daylight with the panel PV field reading: it is trusted from its first sun-up reading and battery = slot net − PV', () => {
  const p = new Plant(Date.parse('2026-10-15T11:00:00-07:00'));
  try {
    p.coresOnline = false;
    p.frozenProjection = false;
    p.sourceWatts = [-500, -500, -500];
    p.pvW = [2500, 2500, 2500];
    p.panelSamples(p.clock);
    const before = p.read();
    p.run(60);
    const after = p.read();
    near(after.pv - before.pv, 3 * 2500, 5, 'PV = the field');
    near(after.chg - before.chg, 3 * 2000, 5, 'battery in = PV − slot output');
    near(after.dsg - before.dsg, 0, 1, 'battery out');
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.trustedSlots, [`${PANEL}_1`, `${PANEL}_2`, `${PANEL}_3`]);
    assert.ok(p.logs.some((l) => l.includes('its PV field is trusted from now on')));
    // The power sensors follow the slots and the field.
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([f.ready, f.fleetPv, f.fleetBatteryNet], [true, 7500, 3 * 500 - 7500]);
  } finally { p.close(); }
});

test('★★★ a night grid charge: battery in rises with the slot inflow, PV production does not; Grid to Battery Charge follows it', () => {
  const p = new Plant(Date.parse('2026-10-15T23:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark([2000, 2000, 2000]);
    p.run(240);
    const after = p.read();
    const expected = 6000 * 4 - 6000 / 60;
    near(after.chg - before.chg, expected, expected * 0.01, 'battery in');
    near(after.pv - before.pv, 0, 1, 'no PV at night');
    near(after.dsg - before.dsg, 0, 1, 'battery out');
    near(after.gridImport - before.gridImport, expected, expected * 0.01, 'the Cores\' AC input, metered at the panel');
  } finally { p.close(); }
});

/* ── the return ──────────────────────────────────────────────────────────── */

for (const [label, jumpWh] of [['under one pack\'s capacity', 3_000], ['over one pack\'s capacity', 20_000]] as const) {
  test(`★★★ the Cores report again with their counters ${label} ahead: the published totals do not jump, then count on`, () => {
    const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
    try {
      p.establishHeld();
      p.goDark(DISCHARGE_W);
      p.run(120);
      const beforeReturn = p.read();
      // Back: each pack's discharge register is `jumpWh` ahead, charge a third of it.
      const dMah = jumpWh / PACK_MAH_TO_WH;
      p.coresOnline = true;
      p.regs = { chg: p.regs!.chg + dMah / 3, dsg: p.regs!.dsg + dMah };
      const atReturn = p.read();
      near(atReturn.dsg, beforeReturn.dsg, 1, 'battery out on return (the dark throughput is absorbed)');
      near(atReturn.chg, beforeReturn.chg, 1, 'battery in on return');
      p.run(15);
      const settled = p.read();
      near(settled.dsg, beforeReturn.dsg, 1, 'no jump on the following rollups either');
      // Counting resumes from the held value: +500 mAh per pack, both Cores' packs.
      p.regs = { chg: p.regs.chg, dsg: p.regs.dsg + 500 };
      p.run(5);
      const resumed = p.read();
      near(resumed.dsg - settled.dsg, CORES.length * PACKS * 500 * PACK_MAH_TO_WH, 0.01, 'live counting resumed');
      const dbg = p.rec.batteryLifetimeDebug().bridge;
      assert.deepEqual(dbg.markers, [], 'every marker cleared');
      assert.deepEqual(dbg.cores, {}, 'the per-Core accumulators are cleared once handed over');
      const lines = p.logs.filter((l) => l.includes('energy-bridge hand-over'));
      assert.equal(lines.length, CORES.length, 'one hand-over line per Core');
      assert.match(lines[0], /re-baselined on return — the BMS counted [\d.]+ kWh in \/ [\d.]+ kWh out while dark \(absorbed, not published\)/);
    } finally { p.close(); }
  });
}

test('★★★ an online flip before the first fresh quota does not spend the marker: the jump is still absorbed when it lands', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(30);
    const before = p.read();
    p.coresOnline = true; // online, the projection still the frozen one (registers = held)
    p.run(5);
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS, 'markers kept');
    p.regs = { chg: p.regs!.chg + 10_000, dsg: p.regs!.dsg + 30_000 }; // the fresh quota
    const after = p.read();
    near(after.dsg, before.dsg, 1, 'absorbed');
  } finally { p.close(); }
});

test('★★★ a restart mid-outage: the bridged totals, the markers and the watermark persist; nothing steps down; the return is absorbed', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(60);
    const beforeRestart = p.read();
    p.frozenProjection = false; // after the restart the dark Cores have no projection (the live case)
    p.restart();
    const afterRestart = p.read();
    near(afterRestart.dsg, beforeRestart.dsg, 60, 'no step at the restart (the final rollup may add its minute)');
    p.run(60);
    const afterHour = p.read();
    near(afterHour.dsg - afterRestart.dsg, 3409, 3409 * 0.02, 'the bridge carries on after the restart');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS, 'markers survived the restart');
    p.coresOnline = true;
    p.regs = { chg: p.regs!.chg + 9_000, dsg: p.regs!.dsg + 27_000 };
    const atReturn = p.read();
    near(atReturn.dsg, afterHour.dsg, 1, 'absorbed after a restart too');
  } finally { p.close(); }
});

test('★★★ the Cores come back while the add-on is down: the persisted markers absorb the jump at the first read after boot', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(30);
    const beforeRestart = p.read();
    // Down for 20 minutes; the Cores return in that window with their dark-span jump.
    p.rec.close();
    p.db.close();
    p.clock += 20 * MIN;
    p.coresOnline = true;
    p.regs = { chg: p.regs!.chg + 9_000, dsg: p.regs!.dsg + 27_000 };
    p.open();
    near(p.read().dsg, beforeRestart.dsg, 60, 'no jump at the first read after boot (no bridge rollup has run yet)');
  } finally { p.close(); }
});

test('★★★ more than the v1.98.0 re-seed gap bridged: the floor is not involved, so nothing steps down', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark(DISCHARGE_W);
    p.run(180); // ≈ 10 kWh bridged against a 5 kWh re-seed gap; every read asserted non-decreasing
    const after = p.read();
    assert.ok(after.dsg - before.dsg > 9_500, `bridged ${(after.dsg - before.dsg).toFixed(0)} Wh`);
    assert.ok(!p.logs.some((l) => l.includes('v1.98.0 lifetime battery floor sat')), 'the floor-gap re-seed never fired');
  } finally { p.close(); }
});

/* ── what is not bridged ─────────────────────────────────────────────────── */

test('★★ a stale panel bridges nothing', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark(DISCHARGE_W);
    p.panelStale = true;
    p.run(60);
    const after = p.read();
    near(after.dsg - before.dsg, 0, 1, 'battery out');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.lastRollup?.slots[0].reason, 'the panel reading is not fresh');
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([f.ready, f.fleetBatteryNet], [false, null]);
  } finally { p.close(); }
});

test('★★ no double count: a dark Core\'s held pv_total rows are not integrated beside the bridge', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark(DISCHARGE_W);
    // The held sample a frozen projection re-records every 5 minutes (the recorder's heartbeat).
    p.run(60, (t, m) => { if (m % 5 === 0) for (const sn of CORES) { p.sample(sn, 'pv_total', 3000, t); p.sample(sn, 'ac_in', 900, t); } });
    const after = p.read();
    near(after.pv - before.pv, 0, 1, 'PV: night, and the held 3 kW is not a reading');
    near(after.gridImport - before.gridImport, 0, 1, 'the held ac_in is not a reading either');
  } finally { p.close(); }
});

test('★★ the read-only debug pass writes nothing, and reports the held value for a returned, marked pack', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(30);
    const before = p.read();
    p.coresOnline = true;
    p.regs = { chg: p.regs!.chg + 10_000, dsg: p.regs!.dsg + 30_000 };
    const rowsBefore = p.rows();
    const dbg = p.rec.batteryLifetimeDebug();
    assert.equal(p.rows(), rowsBefore, 'the lifetime table is byte-identical');
    near(dbg.emittedDischargeWh, before.dsg, 1, 'debug reports held + bridged');
    assert.equal(dbg.bridge.markers.length, CORES.length * PACKS, 'the markers are untouched');
    near(p.read().dsg, before.dsg, 1, 'and the first mutating pass then absorbs the jump');
  } finally { p.close(); }
});

test('★★ the power sensors at night follow the slots while bridged; the readiness verdict follows the bridge', async () => {
  const { publishReadiness } = await import('../src/publishReadiness.js');
  const p = new Plant(Date.parse('2026-10-16T20:15:00-07:00'));
  try {
    p.coresOnline = false;
    p.frozenProjection = false;
    p.sourceWatts = [-627, -623, -625];
    const devices = p.store.get().devices;
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, devices, p.clock);
    assert.deepEqual([f.ready, f.fleetPv, f.fleetBatteryNet, f.bridgedSlots], [true, 0, 1875, 3]);
    const base = {
      devices, alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: null, runway: null, clipping: null,
      curtailment: null, carbon: null, tariff: null, degradation: null, nowMs: p.clock,
    };
    const r = publishReadiness({ ...base, flowBridge: f });
    assert.equal(r.flow, false, 'no online home Core: the Cores\' own in/out/ac-import sums stay withheld');
    assert.equal(r.flowBridged, true, 'Fleet PV and Battery Net publish');
    assert.equal(publishReadiness({ ...base, flowBridge: { bridgedSlots: 3, ready: false } }).flowBridged, false);
    assert.equal(publishReadiness(base).flowBridged, false, 'without a bridged flow it reads as flow');
  } finally { p.close(); }
});
