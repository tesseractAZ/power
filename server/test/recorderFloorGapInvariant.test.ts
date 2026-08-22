import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * v1.98.0 — the FLOOR/LIVE GAP INVARIANT.
 *
 * v1.96.0 keyed the lifetime-floor re-seed solely on a CHANGE of the SHP2
 * source-set fingerprint, and recorded that fingerprint on its first observation
 * without repairing. Once written, `membershipFp === bmsMembershipFp` forever
 * after — so the whole branch, including v1.97.0's first-run repair bolted inside
 * it, became UNREACHABLE and the existing ~902 MWh freeze survived both releases.
 * Live verification caught it twice.
 *
 * The property that matters is not "did membership change" but "does the emitted
 * floor still describe the batteries we are measuring". This file pins that.
 *
 * NOTE: `config.dbPath` is captured at module load, so DB_PATH must be set BEFORE
 * the dynamic import and every recorder here shares one database — which is
 * exactly why this case needs its own file.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-floorgap-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.BMS_RESEED_MIN_GAP_WH = '2000';   // 2 kWh — reachable with test-sized deltas

const { createRecorder } = await import('../src/recorder.js');

function makeStore(snap: any) {
  const ee = new EventEmitter() as any;
  ee.snap = snap; ee.get = () => ee.snap; return ee;
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
const total = (t: Record<string, { persistedWh: number; pendingWh: number }>, k: string) =>
  t[k].persistedWh + t[k].pendingWh;

test('gap invariant — a floor left above the live sum is repaired even when the fingerprint NEVER changes', () => {
  // Process 1: a two-member pool builds the floor.
  const s1 = makeStore({ generatedAt: Date.now(), devices: {} as any });
  s1.snap.devices.SHP2 = shp2Device(['BIG1', 'BIG2']);
  s1.snap.devices.BIG1 = dpuDevice('BIG1', [{ num: 1, packSn: 'B1', chg: 1_000_000, dsg: 1_000_000 }]);
  s1.snap.devices.BIG2 = dpuDevice('BIG2', [{ num: 1, packSn: 'B2', chg: 1_000_000, dsg: 1_000_000 }]);
  const rec1 = createRecorder(s1 as any, () => {});
  rec1.rollupLifetime();
  s1.snap.devices.BIG1 = dpuDevice('BIG1', [{ num: 1, packSn: 'B1', chg: 1_040_000, dsg: 1_040_000 }]);
  s1.snap.devices.BIG2 = dpuDevice('BIG2', [{ num: 1, packSn: 'B2', chg: 1_040_000, dsg: 1_040_000 }]);
  rec1.rollupLifetime();
  const peak = total(rec1.getLifetimeTotals(), 'fleet_battery_charge_wh');
  assert.ok(peak > 4000, `floor built to ${peak}`);

  // Poison the state exactly as v1.96.0 did: record the fingerprint for the
  // SMALLER pool without repairing the floor.
  writeFileSync(join(dirname(process.env.DB_PATH!), 'bms-membership.json'),
    JSON.stringify({ fp: 'BIG1', at: 'x' }));

  // Process 2: only BIG1 on the panel. The fingerprint MATCHES, so any repair
  // keyed on a fingerprint change is unreachable — only the gap can drive it.
  const s2 = makeStore({ generatedAt: Date.now(), devices: {} as any });
  s2.snap.devices.SHP2 = shp2Device(['BIG1']);
  s2.snap.devices.BIG1 = dpuDevice('BIG1', [{ num: 1, packSn: 'B1', chg: 1_040_000, dsg: 1_040_000 }]);
  const rec2 = createRecorder(s2 as any, () => {});

  rec2.rollupLifetime();
  const midway = total(rec2.getLifetimeTotals(), 'fleet_battery_charge_wh');
  assert.ok(Math.abs(midway - peak) < 1e-6, `one rollup of gap must NOT repair (peak ${peak}, midway ${midway})`);

  rec2.rollupLifetime();
  const after = total(rec2.getLifetimeTotals(), 'fleet_battery_charge_wh');
  assert.ok(after < peak - 1e-9, `a SUSTAINED gap must step the floor down (peak ${peak}, after ${after})`);
});
