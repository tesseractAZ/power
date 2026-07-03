import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * v0.81.0 — BMS RECONNECT RE-BASELINE.
 *
 * The v0.45.0 corrupt-read guard freezes a pack's counter whenever its fresh
 * baseline-subtracted delta jumps more than one pack capacity above the held
 * value in a single rollup. That's right for a one-poll garbage spike, but a
 * GENUINE multi-day reconnect produces the same jump PERMANENTLY — so `suspect`
 * latched true forever, the counter stayed frozen, and every post-reconnect kWh
 * was silently dropped from HA Energy (the live operator condition: Cores 1+2
 * offline for days, then back).
 *
 * The fix counts CONSECUTIVE suspect rollups per pack; once a pack is suspect for
 * REBASELINE_SUSPECT_ROLLUPS in a row it's a real reconnect, so we re-baseline
 * (base := register − held) making fresh == held. The rollup that re-baselines
 * still reports the frozen held value (NO total_increasing spike into HA), the
 * unobservable offline throughput is dropped, and the NEXT rollup resumes counting
 * from held. A transient (single suspect rollup) must NOT re-baseline.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-reconnect-rebaseline-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.BMS_REBASELINE_SUSPECT_ROLLUPS = '3'; // deterministic threshold for the test

const { createRecorder } = await import('../src/recorder.js');

const PACK_MAH_TO_WH = (32 * 3.2) / 1_000;
// dpuDevice below sets fullCapMah: 50_000 → capWh = 50_000 * 0.1024 = 5120 Wh.
const CAP_WH = 50_000 * PACK_MAH_TO_WH;

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

test('sustained reconnect re-baselines after N suspect rollups: no HA spike, counting resumes, offline gap dropped', () => {
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_A']);
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_000_000, accuDsgMah: 1_000_000 }]);

  const rec = createRecorder(store as any, () => {});
  rec.rollupLifetime(); // baseline capture (chg base = dsg base = 1,000,000)

  // Normal advance → held delta 20,000 mAh chg / 10,000 mAh dsg.
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_020_000, accuDsgMah: 1_010_000 }]);
  rec.rollupLifetime();
  const heldChgWh = 20_000 * PACK_MAH_TO_WH; // 2048 Wh
  let t = rec.getLifetimeTotals();
  assert.ok(Math.abs(total(t, 'fleet_battery_charge_wh') - heldChgWh) < 1e-6, 'held established at 2048 Wh');

  // Core goes offline for "days": its pack vanishes; held carries.
  delete store.snap.devices.DPU_A;
  rec.rollupLifetime();
  t = rec.getLifetimeTotals();
  assert.ok(Math.abs(total(t, 'fleet_battery_charge_wh') - heldChgWh) < 1e-6, 'offline → held carries');

  // Reconnect with a HUGE register step (+2,000,000 mAh ≈ 204,800 Wh, ≫ CAP_WH):
  // this is the reconnect burst the v0.45.0 guard used to freeze forever.
  const reconnect = (chg: number, dsg: number) =>
    (store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: chg, accuDsgMah: dsg }]));

  // Suspect rollup 1 & 2: below the threshold → still frozen at held (NO spike).
  reconnect(3_020_000, 3_010_000);
  rec.rollupLifetime();
  t = rec.getLifetimeTotals();
  assert.ok(Math.abs(total(t, 'fleet_battery_charge_wh') - heldChgWh) < 1e-6, 'suspect #1: held, no spike');

  rec.rollupLifetime(); // same registers → suspect #2
  t = rec.getLifetimeTotals();
  assert.ok(Math.abs(total(t, 'fleet_battery_charge_wh') - heldChgWh) < 1e-6, 'suspect #2: held, no spike');

  // Suspect rollup 3 → RE-BASELINE. This rollup STILL reports held (no spike): the
  // 204,800 Wh offline gap must never reach HA.
  rec.rollupLifetime(); // suspect #3 → rebaseline
  t = rec.getLifetimeTotals();
  const afterRebaseline = total(t, 'fleet_battery_charge_wh');
  assert.ok(Math.abs(afterRebaseline - heldChgWh) < 1e-6, 're-baseline rollup reports held, NOT the offline gap');
  assert.ok(afterRebaseline < CAP_WH * 2, 'the ~204,800 Wh offline gap never appeared in the total');

  // Now a REAL post-reconnect advance (+20,000 mAh from the reconnect register):
  // counting must resume from held — total climbs by the real delta only.
  reconnect(3_040_000, 3_020_000); // +20,000 chg, +10,000 dsg since reconnect
  rec.rollupLifetime();
  t = rec.getLifetimeTotals();
  const resumed = total(t, 'fleet_battery_charge_wh');
  const expected = heldChgWh + 20_000 * PACK_MAH_TO_WH; // 2048 + 2048 = 4096 Wh
  assert.ok(Math.abs(resumed - expected) < 1e-6, `counting resumed from held: ${resumed} ≈ ${expected}`);
  assert.ok(resumed > afterRebaseline, 'post-reconnect throughput is now being counted again');

  rec.close();
});

