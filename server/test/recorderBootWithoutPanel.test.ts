import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * v1.188.1 — a boot with NO panel reading (the cloud unreachable at boot, or the panel's quota
 * failing across the restart): the store starts empty, so the panel has no projection until its
 * first quota lands, and the SHP2 source set reads empty. The BMS sum's empty-set fallback (meant
 * for a plant with no panel) then counted EVERY persisted held pack row as a home member, the
 * rows a former member left behind for packs moved to a bench spare included: the orphan guard
 * skips such a row only while its pack is projected in another chassis, and with nothing projected
 * it never fired. On the live data that is Core 3's five rows from 2026-08-20: +938.8 kWh Battery
 * Energy In / +965.9 kWh Out on the first publish after the boot, then the v1.98.0 re-seed stepped
 * both counters back down once the panel returned (Home Assistant: a meter reset, phantom energy
 * kept in its statistics). With an accepted roster on file, the members are that roster while the
 * panel reads no source set.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-boot-no-panel-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');

const PACK_MAH_TO_WH = (32 * 3.2) / 1_000;

function makeStore(snap: any) {
  const ee = new EventEmitter() as any;
  ee.snap = snap;
  ee.get = () => ee.snap;
  return ee;
}

function dpuDevice(sn: string, packs: Array<{ num: number; packSn: string; chg: number; dsg: number }>) {
  return {
    sn, deviceName: sn, productName: 'DPU', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 50, packCount: packs.length,
      packs: packs.map((p) => ({
        num: p.num, soc: 50, soh: 100, actSoh: 100, inputWatts: 0, outputWatts: 0, temp: 20,
        cycles: 10, remainTimeMin: null, packSn: p.packSn, designCapMah: 50_000,
        fullCapMah: 50_000, remainCapMah: 25_000, accuChgMah: p.chg, accuDsgMah: p.dsg,
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

function shp2Device(memberSns: string[]) {
  return {
    sn: 'SHP2', deviceName: 'SHP2', productName: 'SHP2', online: true, lastUpdated: Date.now(),
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

/** The panel in /device/list with its quota not landed yet: no projection. */
const unprojectedShp2 = () => ({ sn: 'SHP2', deviceName: 'SHP2', productName: 'SHP2', online: true, lastUpdated: Date.now(), projection: null });

const total = (t: Record<string, { persistedWh: number; pendingWh: number }>, k: string) =>
  t[k].persistedWh + t[k].pendingWh;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test('★★★ a boot with no panel reading carries the accepted roster\'s held packs only: no jump, no re-seed step when the panel returns', () => {
  // A home Core and a Core that later leaves the panel; its pack then moves to a bench spare.
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device(['DPU_HOME', 'DPU_GONE']);
  store.snap.devices.DPU_HOME = dpuDevice('DPU_HOME', [{ num: 1, packSn: 'PHOME1', chg: 1_000_000, dsg: 1_000_000 }]);
  store.snap.devices.DPU_GONE = dpuDevice('DPU_GONE', [{ num: 1, packSn: 'PMOVED1', chg: 2_000_000, dsg: 2_000_000 }]);
  const lines1: string[] = [];
  const rec1 = createRecorder(store as any, (m: string) => lines1.push(m));
  rec1.rollupLifetime();
  store.snap.devices.DPU_HOME = dpuDevice('DPU_HOME', [{ num: 1, packSn: 'PHOME1', chg: 1_040_000, dsg: 1_030_000 }]);
  // Under one pack's capacity per rollup (the v0.45.0 corrupt-read guard): 160k mAh in, 150k out.
  for (let i = 1; i <= 4; i++) {
    store.snap.devices.DPU_GONE = dpuDevice('DPU_GONE', [{ num: 1, packSn: 'PMOVED1', chg: 2_000_000 + 40_000 * i, dsg: 2_000_000 + 37_500 * i }]);
    rec1.rollupLifetime();
  }
  assert.ok(near(total(rec1.getLifetimeTotals(), 'fleet_battery_charge_wh'), 200_000 * PACK_MAH_TO_WH), 'precondition: both Cores counted');
  // DPU_GONE leaves the panel for good: re-seeded to the home Core's packs once sustained.
  store.snap.devices.SHP2 = shp2Device(['DPU_HOME']);
  delete store.snap.devices.DPU_GONE;
  rec1.rollupLifetime();
  rec1.rollupLifetime();
  rec1.rollupLifetime();
  const homeChg = 40_000 * PACK_MAH_TO_WH;
  const homeDsg = 30_000 * PACK_MAH_TO_WH;
  const t1 = rec1.getLifetimeTotals();
  assert.ok(near(total(t1, 'fleet_battery_charge_wh'), homeChg), `precondition: re-seeded to the home Core (${total(t1, 'fleet_battery_charge_wh')})`);
  assert.ok(lines1.some((l) => l.includes('v1.96.0 SHP2 pool membership changed')), 'precondition: the rollover');
  // The moved pack now sits in a bench spare, off the panel.
  store.snap.devices.DPU_SPARE = dpuDevice('DPU_SPARE', [{ num: 1, packSn: 'PMOVED1', chg: 2_160_000, dsg: 2_150_000 }]);
  rec1.rollupLifetime();
  assert.ok(near(total(rec1.getLifetimeTotals(), 'fleet_battery_charge_wh'), homeChg), 'precondition: the spare does not count');
  rec1.close();

  // The restart: the cloud is unreachable, so nothing is in the store and nothing is projected.
  const store2 = makeStore({ generatedAt: Date.now(), devices: {} as any });
  const lines: string[] = [];
  const rec2 = createRecorder(store2 as any, (m: string) => lines.push(m));
  try {
    const t2 = rec2.getLifetimeTotals();
    assert.ok(near(total(t2, 'fleet_battery_charge_wh'), homeChg),
      `★★★ the first publish after the boot: the former member's orphan row is not carried (pre-fix +${160_000 * PACK_MAH_TO_WH} Wh): ${total(t2, 'fleet_battery_charge_wh')}`);
    assert.ok(near(total(t2, 'fleet_battery_discharge_wh'), homeDsg), `★★★ discharge likewise: ${total(t2, 'fleet_battery_discharge_wh')}`);
    // Rollups while the panel stays unprojected write no inflated floor.
    rec2.rollupLifetime();
    rec2.rollupLifetime();
    assert.ok(near(total(rec2.getLifetimeTotals(), 'fleet_battery_charge_wh'), homeChg), '★★ the rollups keep the floor');

    // The cloud is back, the panel's quota still failing (listed, no projection); the bench spare
    // holding the moved pack is online and charging on the bench.
    store2.snap.devices.SHP2 = unprojectedShp2();
    store2.snap.devices.DPU_SPARE = dpuDevice('DPU_SPARE', [{ num: 1, packSn: 'PMOVED1', chg: 2_160_000, dsg: 2_150_000 }]);
    rec2.rollupLifetime();
    store2.snap.devices.DPU_SPARE = dpuDevice('DPU_SPARE', [{ num: 1, packSn: 'PMOVED1', chg: 2_200_000, dsg: 2_150_000 }]);
    rec2.rollupLifetime();
    assert.ok(near(total(rec2.getLifetimeTotals(), 'fleet_battery_charge_wh'), homeChg),
      `★★ a bench spare is no member while the panel reads no source set (its bench charge is not home energy): ${total(rec2.getLifetimeTotals(), 'fleet_battery_charge_wh')}`);

    // The panel returns with the home Core: no gap, so no v1.98.0 re-seed step.
    store2.snap.devices.SHP2 = shp2Device(['DPU_HOME']);
    store2.snap.devices.DPU_HOME = dpuDevice('DPU_HOME', [{ num: 1, packSn: 'PHOME1', chg: 1_040_000, dsg: 1_030_000 }]);
    for (let i = 0; i < 4; i++) rec2.rollupLifetime();
    assert.ok(near(total(rec2.getLifetimeTotals(), 'fleet_battery_charge_wh'), homeChg), 'unchanged once the panel is back');
    assert.ok(!lines.some((l) => l.includes('Re-seeding')), `★★ no re-seed: ${lines.filter((l) => l.includes('Re-seeding')).join(' | ')}`);
  } finally {
    rec2.close();
  }
});
