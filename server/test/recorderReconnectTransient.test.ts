import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * v0.81.0 — the reconnect re-baseline (recorderReconnectRebaseline.test.ts) must
 * NOT fire on a TRANSIENT one-poll garbage read. A single suspect rollup that
 * clears on the next poll leaves the pack's baseline untouched so counting
 * continues off the ORIGINAL install baseline. Separate file so it gets a fresh
 * DB (dbPath is captured once at config import, per-file under node --test).
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-reconnect-transient-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.BMS_REBASELINE_SUSPECT_ROLLUPS = '3';

const { createRecorder } = await import('../src/recorder.js');

const PACK_MAH_TO_WH = (32 * 3.2) / 1_000;

function makeStore(snap: any) {
  const ee = new EventEmitter() as any;
  ee.snap = snap;
  ee.get = () => ee.snap;
  return ee;
}

function dpuDevice(sn: string, packs: Array<{ num: number; accuChgMah: number | null; accuDsgMah: number | null }>) {
  return {
    sn, deviceName: sn, productName: 'DPU', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 50, packCount: packs.length,
      packs: packs.map((p) => ({
        num: p.num, soc: 50, soh: 100, actSoh: 100, inputWatts: 0, outputWatts: 0, temp: 20,
        cycles: 10, remainTimeMin: null, packSn: `${sn}-P${p.num}`, designCapMah: 50_000,
        fullCapMah: 50_000, remainCapMah: 25_000, accuChgMah: p.accuChgMah, accuDsgMah: p.accuDsgMah,
        cellTemps: [], mosTemps: [], ptcTemps: [], hwBoardTemp: null, curResTemp: null,
        minCellTemp: null, maxCellTemp: null, minMosTemp: null, maxMosTemp: null, cellVoltagesMv: [],
        minCellVoltageMv: null, maxCellVoltageMv: null, maxVolDiffMv: null, balanceState: 0,
        packVoltageMv: null, adBatVoltageMv: null, ocvMv: null,
      })),
      pvHighWatts: null, pvLowWatts: null, pvTotalWatts: 0, pvHighVolts: null, pvHighAmps: null,
      pvLowVolts: null, pvLowAmps: null, pvHighErrCode: null, pvLowErrCode: null, acInWatts: 0,
      acOutWatts: 0, acOutFreq: null, acOutVol: null, batVol: null, batAmp: null, totalInWatts: 0,
      totalOutWatts: 0, remainTimeMin: null, mpptHvTemp: null, mpptLvTemp: null,
      splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null }, sysErrCode: null,
      emsParaVolMaxMv: null, emsParaVolMinMv: null, chgMaxSoc: 100, dsgMinSoc: 0,
    },
  };
}

function shp2Device(sn: string, memberSns: string[]) {
  return {
    sn, deviceName: sn, productName: 'SHP2', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'shp2', area: null, backupBatPercent: 50, backupFullCapWh: null, backupRemainWh: null,
      backupChargeTimeMin: null, backupDischargeTimeMin: null, backupReserveSoc: null,
      chargeWattPower: null, circuits: [], pairedCircuits: [],
      sources: memberSns.map((msn, i) => ({
        slot: i + 1, sn: msn, batteryPercentage: 50, isConnected: true, isAcOpen: true, fullCap: null,
        ratePower: null, emsBatTemp: null, hwConnect: true, errorCodeNum: null,
      })),
      sourceWatts: [], gridWatt: 0, strategy: {} as any,
    },
  };
}

const total = (t: Record<string, { persistedWh: number; pendingWh: number }>, k: string) =>
  t[k].persistedWh + t[k].pendingWh;

test('a transient one-poll spike does NOT re-baseline and never loses the real baseline', () => {
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_A']);
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_000_000, accuDsgMah: 1_000_000 }]);

  const rec = createRecorder(store as any, () => {});
  rec.rollupLifetime(); // baseline (base = 1,000,000)

  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_020_000, accuDsgMah: 1_010_000 }]);
  rec.rollupLifetime();
  const heldChgWh = 20_000 * PACK_MAH_TO_WH;
  let t = rec.getLifetimeTotals();
  assert.ok(Math.abs(total(t, 'fleet_battery_charge_wh') - heldChgWh) < 1e-6, 'held established at 2048 Wh');

  // ONE garbage read (huge), then it clears next poll.
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 99_000_000, accuDsgMah: 99_000_000 }]);
  rec.rollupLifetime(); // suspect #1 (transient)
  t = rec.getLifetimeTotals();
  assert.ok(Math.abs(total(t, 'fleet_battery_charge_wh') - heldChgWh) < 1e-6, 'transient spike held, no spike');

  // Back to a normal register CONSISTENT with the ORIGINAL baseline. Had a single
  // suspect wrongly re-baselined, this fresh delta would be wrong.
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_040_000, accuDsgMah: 1_030_000 }]);
  rec.rollupLifetime(); // not suspect → streak reset; counting off the UNCHANGED base
  t = rec.getLifetimeTotals();
  const resumed = total(t, 'fleet_battery_charge_wh');
  // (1,040,000 − 1,000,000) * 0.1024 = 40,000 * 0.1024 = 4096 Wh, off the ORIGINAL base.
  assert.ok(Math.abs(resumed - 40_000 * PACK_MAH_TO_WH) < 1e-6, `original baseline intact after transient: ${resumed}`);

  rec.close();
});
