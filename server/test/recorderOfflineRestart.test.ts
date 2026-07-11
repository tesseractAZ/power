import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * v0.45.0 — restart-while-offline must NOT re-freeze the battery counters.
 *
 * The operator's CURRENT live condition (Core 1 cloud-offline) plus routine
 * add-on restarts means a held last-known pack value must survive a process
 * restart. This test accumulates a held value for member DPU_B, builds a NEW
 * recorder over the SAME db (a restart) with DPU_B still offline at boot, and
 * asserts the persisted pack_lastwh_* row carries B back into the fleet sum —
 * the counter does not regress to zero.
 *
 * Hermetic: this is the ONLY test in the file so the module-load DB_PATH is a
 * fresh dir (config.ts reads DB_PATH once at import; both recorders share it,
 * exactly as a real restart shares /data/ecoflow.db).
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-offline-restart-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

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

test('restart-while-offline carries the persisted held value (no re-freeze)', () => {
  // Run 1: capture baselines, then accumulate B's held last-known delta, then crash.
  {
    const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
    store.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_A', 'DPU_B']);
    store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_000_000, accuDsgMah: 1_000_000 }]);
    store.snap.devices.DPU_B = dpuDevice('DPU_B', [{ num: 1, accuChgMah: 2_000_000, accuDsgMah: 2_000_000 }]);
    const rec1 = createRecorder(store as any, () => {});
    rec1.rollupLifetime(); // baselines (deltas 0)
    store.snap.devices.DPU_B = dpuDevice('DPU_B', [{ num: 1, accuChgMah: 2_030_000, accuDsgMah: 2_010_000 }]); // +30k chg
    rec1.rollupLifetime(); // v1.4.4: persists pack_lastwhid_DPU_B:DPU_B-P1_chg = 30k * mahToWh (DPU_B reports a packSn)
    rec1.close();
  }

  // Run 2 (restart over the SAME db): DPU_B is OFFLINE (absent) at boot.
  const store2 = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store2.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_A', 'DPU_B']);
  store2.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_000_000, accuDsgMah: 1_000_000 }]);
  // DPU_B intentionally absent — offline through the restart.
  const rec2 = createRecorder(store2 as any, () => {});
  rec2.rollupLifetime();

  const t = rec2.getLifetimeTotals();
  const chargeWh = total(t, 'fleet_battery_charge_wh');
  // B's persisted held delta (30k mAh) must still be summed even though B is
  // absent from the boot snapshot — otherwise the counter re-freezes/regresses.
  assert.ok(Math.abs(chargeWh - 30_000 * PACK_MAH_TO_WH) < 1e-6,
    `restart-while-offline must carry B's persisted held value; chg=${chargeWh} expected=${30_000 * PACK_MAH_TO_WH}`);

  // The debug view confirms B is being carried as an offline-held member.
  const dbg = rec2.batteryLifetimeDebug();
  // v1.4.4 — DPU_B's pack reports a packSn, so its held row now persists under
  // the stable packSn-keyed shape (`<sn>:<packSn>`), not the legacy `<sn>|<num>`
  // slot-numbered shape.
  assert.ok(dbg.offlineHeldMembers.includes('DPU_B:DPU_B-P1'), `DPU_B:DPU_B-P1 should be an offline-held member, got ${dbg.offlineHeldMembers.join(',')}`);

  rec2.close();
});
