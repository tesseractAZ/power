import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * v0.45.0 — the discharge≤charge clamp REMOVAL.
 *
 * accuChgMah/accuDsgMah are COULOMB counters. Over the open v0.13.0 baseline→now
 * window, if the pool ends below its baseline SoC the cumulative DISCHARGE
 * legitimately exceeds cumulative CHARGE. HA ingests fleet_battery_charge_wh and
 * fleet_battery_discharge_wh as two INDEPENDENT total_increasing sensors, so the
 * old clamp (pin discharge to charge) was a category error that FROZE the true
 * battery-out total. This test drives a baseline-subtracted snapshot whose
 * dischargeWh > chargeWh and asserts the SURFACED fleet_battery_discharge_wh is
 * the TRUE (higher) discharge — not pinned to charge — and that charge is
 * unaffected.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-bat-clamp-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');

const PACK_MAH_TO_WH = (32 * 3.2) / 1_000; // 0.1024 — same as recorder

// Minimal store: createRecorder only needs `.on('change', cb)` + `.get()`.
function makeStore(snap: any) {
  const ee = new EventEmitter() as any;
  ee.snap = snap;
  ee.get = () => ee.snap;
  return ee;
}

function dpuDevice(sn: string, packs: Array<{ num: number; accuChgMah: number | null; accuDsgMah: number | null; fullCapMah?: number | null }>) {
  return {
    sn,
    deviceName: sn,
    productName: 'DPU',
    online: true,
    lastUpdated: Date.now(),
    projection: {
      kind: 'dpu',
      soc: 50,
      packCount: packs.length,
      packs: packs.map((p) => ({
        num: p.num,
        soc: 50,
        soh: 100,
        actSoh: 100,
        inputWatts: 0,
        outputWatts: 0,
        temp: 20,
        cycles: 10,
        remainTimeMin: null,
        packSn: `${sn}-P${p.num}`,
        designCapMah: 50_000,
        fullCapMah: p.fullCapMah ?? 50_000,
        remainCapMah: 25_000,
        accuChgMah: p.accuChgMah,
        accuDsgMah: p.accuDsgMah,
        cellTemps: [], mosTemps: [], ptcTemps: [],
        hwBoardTemp: null, curResTemp: null, minCellTemp: null, maxCellTemp: null,
        minMosTemp: null, maxMosTemp: null, cellVoltagesMv: [], minCellVoltageMv: null,
        maxCellVoltageMv: null, maxVolDiffMv: null, balanceState: 0, packVoltageMv: null,
        adBatVoltageMv: null, ocvMv: null,
      })),
      pvHighWatts: null, pvLowWatts: null, pvTotalWatts: 0, pvHighVolts: null,
      pvHighAmps: null, pvLowVolts: null, pvLowAmps: null, pvHighErrCode: null,
      pvLowErrCode: null, acInWatts: 0, acOutWatts: 0, acOutFreq: null, acOutVol: null,
      batVol: null, batAmp: null, totalInWatts: 0, totalOutWatts: 0, remainTimeMin: null,
      mpptHvTemp: null, mpptLvTemp: null,
      splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
      sysErrCode: null, emsParaVolMaxMv: null, emsParaVolMinMv: null,
      chgMaxSoc: 100, dsgMinSoc: 0,
    },
  };
}

function shp2Device(sn: string, memberSns: string[]) {
  return {
    sn,
    deviceName: sn,
    productName: 'SHP2',
    online: true,
    lastUpdated: Date.now(),
    projection: {
      kind: 'shp2',
      area: null, backupBatPercent: 50, backupFullCapWh: null, backupRemainWh: null,
      backupChargeTimeMin: null, backupDischargeTimeMin: null, backupReserveSoc: null,
      chargeWattPower: null, circuits: [], pairedCircuits: [],
      sources: memberSns.map((msn, i) => ({
        slot: i + 1, sn: msn, batteryPercentage: 50, isConnected: true, isAcOpen: true,
        fullCap: null, ratePower: null, emsBatTemp: null, hwConnect: true, errorCodeNum: null,
      })),
      sourceWatts: [], gridWatt: 0, strategy: {} as any,
    },
  };
}

test('discharge > charge surfaces the TRUE discharge (clamp removed); charge unaffected', () => {
  // Member DPU; baseline captured at snap1, then real usage where DISCHARGE
  // exceeds CHARGE (net-discharged window — pool drained below baseline SoC).
  const store = makeStore({
    generatedAt: Date.now(),
    devices: { DPU_M: dpuDevice('DPU_M', [{ num: 1, accuChgMah: 1_000_000, accuDsgMah: 1_000_000 }]) },
  });
  // SHP2 with DPU_M as the sole member so the sourceSns filter passes it.
  store.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_M']);

  const rec = createRecorder(store as any, () => {});

  // Rollup 1: captures baseline (chg=1.0M, dsg=1.0M) → both deltas 0.
  rec.rollupLifetime();

  // Rollup 2: charge +5,000 mAh but discharge +50,000 mAh (net-discharged).
  store.snap.devices.DPU_M = dpuDevice('DPU_M', [{ num: 1, accuChgMah: 1_005_000, accuDsgMah: 1_050_000 }]);
  rec.rollupLifetime();

  const totals = rec.getLifetimeTotals();
  const charge = totals['fleet_battery_charge_wh'];
  const discharge = totals['fleet_battery_discharge_wh'];
  const chargeWh = charge.persistedWh + charge.pendingWh;
  const dischargeWh = discharge.persistedWh + discharge.pendingWh;

  const expectedChargeWh = 5_000 * PACK_MAH_TO_WH;      // 512 Wh
  const expectedDischargeWh = 50_000 * PACK_MAH_TO_WH;  // 5120 Wh

  // Discharge is the TRUE higher value, NOT pinned to charge.
  assert.ok(Math.abs(dischargeWh - expectedDischargeWh) < 1e-6, `discharge should be true ${expectedDischargeWh}, got ${dischargeWh}`);
  assert.ok(dischargeWh > chargeWh, 'discharge must be allowed to exceed charge (open net-discharged window)');
  // Charge is unaffected by the discharge value.
  assert.ok(Math.abs(chargeWh - expectedChargeWh) < 1e-6, `charge should be ${expectedChargeWh}, got ${chargeWh}`);

  rec.close();
});
