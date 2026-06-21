import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * v0.45.0 — OFFLINE-FREEZE fix.
 *
 * When an SHP2-connected core goes cloud-offline its packs leave the snapshot
 * sum, so the fleet BMS sum drops below the monotone floor and BOTH counters
 * froze (HA "Battery in/out today = 0 kWh"). The fix HOLDS each connected
 * pack's last-known per-pack {chgWh,dsgWh} across its offline gap, evaluated
 * through the EXACT live-sum filter (kind==='dpu' AND sourceSns membership AND
 * non-null register AND a captured baseline), monotone (max on reconnect), and
 * PERSISTED so a restart-while-offline doesn't re-freeze. A spare (failing the
 * sourceSns filter) is NEVER carried or summed.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-offline-freeze-'));
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

test('offline core does not freeze counters; reconnect (higher / lower) is monotone; spare never carried', () => {
  // Two member DPUs (A, B) + one SPARE (S) excluded by sourceSns. Baselines all
  // captured at this first snapshot.
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_A', 'DPU_B']); // S is NOT a member
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_000_000, accuDsgMah: 1_000_000 }]);
  store.snap.devices.DPU_B = dpuDevice('DPU_B', [{ num: 1, accuChgMah: 2_000_000, accuDsgMah: 2_000_000 }]);
  store.snap.devices.DPU_S = dpuDevice('DPU_S', [{ num: 1, accuChgMah: 9_000_000, accuDsgMah: 9_000_000 }]); // spare

  const rec = createRecorder(store as any, () => {});
  rec.rollupLifetime(); // capture baselines, deltas 0

  // ── Rollup 2: BOTH members present and advanced; spare advances too (ignored). ──
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_020_000, accuDsgMah: 1_010_000 }]); // +20k chg, +10k dsg
  store.snap.devices.DPU_B = dpuDevice('DPU_B', [{ num: 1, accuChgMah: 2_030_000, accuDsgMah: 2_015_000 }]); // +30k chg, +15k dsg
  store.snap.devices.DPU_S = dpuDevice('DPU_S', [{ num: 1, accuChgMah: 9_500_000, accuDsgMah: 9_500_000 }]); // spare huge jump
  rec.rollupLifetime();

  let t = rec.getLifetimeTotals();
  const chargeAfter2 = total(t, 'fleet_battery_charge_wh');
  const dischargeAfter2 = total(t, 'fleet_battery_discharge_wh');
  // Fleet = A + B only (spare excluded): chg = (20k+30k)=50k mAh, dsg = (10k+15k)=25k mAh.
  assert.ok(Math.abs(chargeAfter2 - 50_000 * PACK_MAH_TO_WH) < 1e-6, `chg after rollup2 = ${chargeAfter2}`);
  assert.ok(Math.abs(dischargeAfter2 - 25_000 * PACK_MAH_TO_WH) < 1e-6, `dsg after rollup2 = ${dischargeAfter2}`);
  // Spare's 500k mAh jump must NOT appear (would be 500k*0.1024 = 51200 Wh).
  assert.ok(chargeAfter2 < 10_000, 'spare contribution must be excluded from the fleet sum');

  // ── Rollup 3: DPU_B goes cloud-offline (packs vanish). Counters must NOT regress. ──
  delete store.snap.devices.DPU_B;
  rec.rollupLifetime();

  t = rec.getLifetimeTotals();
  const chargeAfter3 = total(t, 'fleet_battery_charge_wh');
  const dischargeAfter3 = total(t, 'fleet_battery_discharge_wh');
  // B is held at its last-known delta; A is unchanged → totals identical to rollup 2.
  assert.ok(chargeAfter3 >= chargeAfter2 - 1e-9, `charge must not regress while B offline (${chargeAfter3} vs ${chargeAfter2})`);
  assert.ok(dischargeAfter3 >= dischargeAfter2 - 1e-9, `discharge must not regress while B offline (${dischargeAfter3} vs ${dischargeAfter2})`);
  assert.ok(Math.abs(chargeAfter3 - chargeAfter2) < 1e-6, 'held carry keeps B in the sum (charge stable)');
  assert.ok(Math.abs(dischargeAfter3 - dischargeAfter2) < 1e-6, 'held carry keeps B in the sum (discharge stable)');

  // ── Rollup 4: A advances while B still offline → A's delta moves, B still held. ──
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_040_000, accuDsgMah: 1_030_000 }]); // +40k/+30k from baseline
  rec.rollupLifetime();
  t = rec.getLifetimeTotals();
  const chargeAfter4 = total(t, 'fleet_battery_charge_wh');
  // chg = A(40k) + B held(30k) = 70k mAh.
  assert.ok(Math.abs(chargeAfter4 - 70_000 * PACK_MAH_TO_WH) < 1e-6, `chg after rollup4 = ${chargeAfter4}, A advances + B held`);

  // ── Rollup 5: DPU_B reconnects with HIGHER registers → fresh delta used (no double-count). ──
  store.snap.devices.DPU_B = dpuDevice('DPU_B', [{ num: 1, accuChgMah: 2_050_000, accuDsgMah: 2_025_000 }]); // +50k chg, +25k dsg from baseline
  rec.rollupLifetime();
  t = rec.getLifetimeTotals();
  const chargeAfter5 = total(t, 'fleet_battery_charge_wh');
  // chg = A(40k) + B(50k fresh) = 90k mAh. NOT 70k+50k (no double count of held+fresh).
  assert.ok(Math.abs(chargeAfter5 - 90_000 * PACK_MAH_TO_WH) < 1e-6, `chg after rollup5 = ${chargeAfter5}, fresh B delta used once`);

  // ── Rollup 6: DPU_B reconnects with LOWER registers → monotone-hold keeps the max. ──
  store.snap.devices.DPU_B = dpuDevice('DPU_B', [{ num: 1, accuChgMah: 2_040_000, accuDsgMah: 2_020_000 }]); // LOWER than rollup5 (+40k chg)
  rec.rollupLifetime();
  t = rec.getLifetimeTotals();
  const chargeAfter6 = total(t, 'fleet_battery_charge_wh');
  // B's held max stays at 50k (not the lower 40k fresh read) → fleet chg stays 90k.
  assert.ok(Math.abs(chargeAfter6 - 90_000 * PACK_MAH_TO_WH) < 1e-6, `chg after rollup6 = ${chargeAfter6}, monotone-hold keeps B's max`);
  assert.ok(chargeAfter6 >= chargeAfter5 - 1e-9, 'a lower reconnect read must never de-sync the floor');

  // The spare was never carried/summed at any point.
  const dbg = rec.batteryLifetimeDebug();
  assert.ok(!dbg.packs.some((p) => p.sn === 'DPU_S' && (p.passesFilter || p.heldFromLastKnown)),
    'spare DPU_S must never pass the filter nor be held');

  rec.close();
});
