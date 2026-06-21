import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

/**
 * v0.45.0 — batteryLifetimeDebug() shape + STRICTLY READ-ONLY guarantee.
 *
 * The endpoint feeds /api/debug/battery-lifetime. It must (a) return the
 * documented diagnostic fields and (b) perform ZERO writes — the lifetime_totals
 * table must be row/byte-identical before and after the call (no baseline
 * capture, no held-value write, no counter mutation).
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-bat-debug-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');

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

function snapshotLifetimeTable(dbPath: string): string {
  const raw = new DatabaseSync(dbPath);
  const rows = raw.prepare(
    `SELECT metric_key, wh, last_integrated_ts FROM lifetime_totals ORDER BY metric_key`,
  ).all();
  raw.close();
  return JSON.stringify(rows);
}

test('batteryLifetimeDebug returns the documented fields and is STRICTLY READ-ONLY', () => {
  const dbPath = process.env.DB_PATH!;
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_M']);
  store.snap.devices.DPU_M = dpuDevice('DPU_M', [{ num: 1, accuChgMah: 1_000_000, accuDsgMah: 1_000_000 }]);
  store.snap.devices.DPU_S = dpuDevice('DPU_S', [{ num: 1, accuChgMah: 5_000_000, accuDsgMah: 5_000_000 }]); // spare

  const rec = createRecorder(store as any, () => {});
  // Advance to a net-discharged state so the deficit is informative.
  rec.rollupLifetime();
  // +10k chg, +40k dsg from baseline — net-discharged, and each per-rollup jump
  // stays under one pack capacity (50k mAh) so the corrupt-read guard is inert.
  store.snap.devices.DPU_M = dpuDevice('DPU_M', [{ num: 1, accuChgMah: 1_010_000, accuDsgMah: 1_040_000 }]);
  rec.rollupLifetime();

  // ── Shape ──
  const dbg = rec.batteryLifetimeDebug();
  for (const f of [
    'rawChargeFloorWh', 'rawDischargeFloorWh', 'emittedChargeWh', 'emittedDischargeWh',
    'deficitWh',
  ] as const) {
    assert.equal(typeof dbg[f], 'number', `${f} must be a number`);
  }
  assert.equal(typeof dbg.charge.persistedWh, 'number');
  assert.equal(typeof dbg.charge.pendingWh, 'number');
  assert.equal(typeof dbg.discharge.persistedWh, 'number');
  assert.equal(typeof dbg.discharge.pendingWh, 'number');
  assert.ok(Array.isArray(dbg.packs), 'packs must be an array');
  assert.ok(Array.isArray(dbg.offlineHeldMembers), 'offlineHeldMembers must be an array');
  // deficit reflects discharge > charge (net-discharged window).
  assert.ok(dbg.deficitWh > 0, 'deficitWh should be > 0 for the net-discharged window');
  assert.ok(dbg.rawDischargeFloorWh > dbg.rawChargeFloorWh, 'raw discharge floor exceeds charge floor (unclamped)');
  // Per-pack breakdown carries the documented keys.
  const member = dbg.packs.find((p) => p.sn === 'DPU_M' && p.num === 1)!;
  assert.ok(member, 'member pack present in breakdown');
  assert.equal(member.passesFilter, true);
  assert.equal(member.present, true);
  assert.equal(member.heldFromLastKnown, false);
  for (const f of ['baselineChgMah', 'baselineDsgMah', 'accuChgMah', 'accuDsgMah', 'chgWh', 'dsgWh'] as const) {
    assert.ok(f in member, `member pack must carry ${f}`);
  }
  // Spare is present but excluded.
  const spare = dbg.packs.find((p) => p.sn === 'DPU_S')!;
  assert.ok(spare, 'spare pack present in breakdown');
  assert.equal(spare.passesFilter, false, 'spare must not pass the filter');

  // ── Read-only: lifetime_totals byte/row-identical before/after repeated calls ──
  const before = snapshotLifetimeTable(dbPath);
  rec.batteryLifetimeDebug();
  rec.batteryLifetimeDebug();
  rec.batteryLifetimeDebug();
  const after = snapshotLifetimeTable(dbPath);
  assert.equal(after, before, 'batteryLifetimeDebug must not write to lifetime_totals');

  rec.close();
});
