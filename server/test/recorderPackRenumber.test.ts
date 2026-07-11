import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1.4.4 — per-pack BMS lifetime state must be keyed on the pack's stable
 * hardware serial (packSn), not the positional BMS-bus slot number (num).
 * `num` can renumber (BMS rescan / pack reseat) without the physical pack
 * changing; keying on (sn, num) alone let a renumbered pack silently inherit
 * — and corrupt — whatever OTHER pack previously occupied that slot's
 * baseline/held row (double-count or lost history). Mirrors the v1.2.0
 * restTracker.packRestKey precedent.
 *
 * Two things pinned here:
 *  (1) UPGRADE MIGRATION — a pre-fix legacy slot-keyed row is copied forward
 *      (not reset) onto the new packSn-keyed row the first time that pack's
 *      serial is seen live, and the legacy row is deleted (never rediscovered
 *      as a stale second contributor).
 *  (2) RENUMBER SAFETY — two packs on the same DPU that swap BMS-bus slots
 *      keep accumulating from THEIR OWN prior held value, not each other's.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-pack-renumber-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const DB_PATH = process.env.DB_PATH;

const { createRecorder } = await import('../src/recorder.js');

// v1.4.4 — the recorder captures DB_PATH at import, so all createRecorder()
// calls share ONE sqlite file. Both tests exercise the SAME device serial
// (DPU_A) and members persist across rollups by design, so without a reset the
// first test's persisted pack held-row would (correctly) be carried into the
// second test's fleet sum. Wipe the persisted tables between tests so each
// scenario is asserted in isolation (each test still builds a fresh recorder,
// whose in-memory baseline/held caches are per-instance).
function clearDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, sn TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS lifetime_totals (metric_key TEXT PRIMARY KEY, wh REAL NOT NULL DEFAULT 0, last_integrated_ts INTEGER NOT NULL DEFAULT 0);
    DELETE FROM lifetime_totals; DELETE FROM samples;`);
  db.close();
}

const PACK_MAH_TO_WH = (32 * 3.2) / 1_000;

function makeStore(snap: any) {
  const ee = new EventEmitter() as any;
  ee.snap = snap;
  ee.get = () => ee.snap;
  return ee;
}

function dpuDevice(
  sn: string,
  packs: Array<{ num: number; packSn: string | null; accuChgMah: number | null; accuDsgMah: number | null }>,
) {
  return {
    sn, deviceName: sn, productName: 'DPU', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 50, packCount: packs.length,
      packs: packs.map((p) => ({
        num: p.num, soc: 50, soh: 100, actSoh: 100, inputWatts: 0, outputWatts: 0, temp: 20,
        cycles: 10, remainTimeMin: null, packSn: p.packSn, designCapMah: 50_000,
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

test('v1.4.4 — a pre-fix legacy slot-keyed baseline migrates forward without resetting the counter', () => {
  clearDb();
  // Seed PRE-FIX state directly: legacy pack_base_/pack_lastwh_ rows for
  // DPU_A slot 1, exactly as a real /data/ecoflow.db looked before this fix.
  const raw = new DatabaseSync(DB_PATH);
  raw.exec(`CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, sn TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS lifetime_totals (metric_key TEXT PRIMARY KEY, wh REAL NOT NULL DEFAULT 0, last_integrated_ts INTEGER NOT NULL DEFAULT 0);`);
  const up = raw.prepare(`INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)`);
  const seededAt = Date.now() - 24 * 60 * 60 * 1000;
  up.run('pack_base_DPU_A_1_chg', 1_000_000, seededAt);
  up.run('pack_base_DPU_A_1_dsg', 1_000_000, seededAt);
  up.run('pack_lastwh_DPU_A_1_chg', 30_000 * PACK_MAH_TO_WH, seededAt);
  up.run('pack_lastwh_DPU_A_1_dsg', 10_000 * PACK_MAH_TO_WH, seededAt);
  raw.close();

  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_A']);
  // Live register has advanced 5k mAh chg beyond the pre-fix held value's
  // implied register (base 1,000,000 + held 30,000 = 1,030,000) → 1,035,000.
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, packSn: 'HWSN-A', accuChgMah: 1_035_000, accuDsgMah: 1_010_000 }]);

  const rec = createRecorder(store as any, () => {});
  rec.rollupLifetime();

  const t = rec.getLifetimeTotals();
  // Continuity: the counter picks up from the migrated held value (30k mAh
  // chg) plus this rollup's fresh advance (5k mAh) = 35k mAh — NOT reset to 0
  // and NOT re-counted from scratch against a fresh (unmigrated) baseline.
  const expectedChg = 35_000 * PACK_MAH_TO_WH;
  assert.ok(Math.abs(total(t, 'fleet_battery_charge_wh') - expectedChg) < 1e-6,
    `migrated counter must continue from the legacy held value; got ${total(t, 'fleet_battery_charge_wh')}, expected ${expectedChg}`);

  // The legacy rows are gone (migrated, not duplicated); the new packSn-keyed
  // rows exist.
  const row = (key: string) => {
    const raw2 = new DatabaseSync(DB_PATH);
    const r = raw2.prepare(`SELECT wh FROM lifetime_totals WHERE metric_key = ?`).get(key) as { wh: number } | undefined;
    raw2.close();
    return r;
  };
  assert.equal(row('pack_base_DPU_A_1_chg'), undefined, 'legacy baseline row must be deleted after migration');
  assert.equal(row('pack_lastwh_DPU_A_1_chg'), undefined, 'legacy held row must be deleted after migration');
  assert.ok(row('pack_baseid_DPU_A:HWSN-A_chg') !== undefined, 'new packSn-keyed baseline row must exist');
  assert.ok(row('pack_lastwhid_DPU_A:HWSN-A_chg') !== undefined, 'new packSn-keyed held row must exist');

  rec.close();
});

test('v1.4.4 — two packs swapping BMS-bus slots keep their own history (no cross-contamination)', () => {
  clearDb();
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_A']);
  // Pack A at slot 1, pack B at slot 2 — distinct hardware serials.
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [
    { num: 1, packSn: 'SN-A', accuChgMah: 1_000_000, accuDsgMah: 1_000_000 },
    { num: 2, packSn: 'SN-B', accuChgMah: 5_000_000, accuDsgMah: 5_000_000 },
  ]);
  const rec = createRecorder(store as any, () => {});
  rec.rollupLifetime(); // baselines captured: A@1M, B@5M — deltas 0

  // A charges +10k mAh; B charges +2k mAh. Still at their original slots.
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [
    { num: 1, packSn: 'SN-A', accuChgMah: 1_010_000, accuDsgMah: 1_000_000 },
    { num: 2, packSn: 'SN-B', accuChgMah: 5_002_000, accuDsgMah: 5_000_000 },
  ]);
  rec.rollupLifetime();
  const mid = rec.getLifetimeTotals();
  const midChg = total(mid, 'fleet_battery_charge_wh');
  assert.ok(Math.abs(midChg - 12_000 * PACK_MAH_TO_WH) < 1e-6, `pre-swap total should be 12k mAh chg, got ${midChg}`);

  // SWAP slots: pack A (SN-A) now reports num=2, pack B (SN-B) now reports
  // num=1 — a BMS rescan reordering the bus addresses. Registers advance a
  // little further for each pack, keyed to their OWN serial.
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [
    { num: 1, packSn: 'SN-B', accuChgMah: 5_003_000, accuDsgMah: 5_000_000 }, // B +1k more (total +3k)
    { num: 2, packSn: 'SN-A', accuChgMah: 1_015_000, accuDsgMah: 1_000_000 }, // A +5k more (total +15k)
  ]);
  rec.rollupLifetime();

  const after = rec.getLifetimeTotals();
  const afterChg = total(after, 'fleet_battery_charge_wh');
  // Expected TOTAL across both packs, tracked by SERIAL regardless of slot:
  // A: 15k mAh chg, B: 3k mAh chg → 18k mAh combined. If the bug were present
  // (keyed by slot), the pack now AT slot 1 (B, serial SN-B, register 5.003M)
  // would be diffed against slot 1's PRIOR baseline (A's baseline, 1.000M) —
  // a nonsensical multi-million-mAh "jump" the corrupt-read guard would either
  // freeze (under-counting) or, once "confirmed" over REBASELINE_SUSPECT_ROLLUPS,
  // silently re-baseline away — losing history either way. The fix keeps each
  // serial's own continuity regardless of which slot it's reported under.
  const expectedChg = 18_000 * PACK_MAH_TO_WH;
  assert.ok(Math.abs(afterChg - expectedChg) < 1e-6,
    `post-swap total must equal each pack's own continued delta by serial; got ${afterChg}, expected ${expectedChg} (pre-swap was ${midChg})`);
  assert.ok(afterChg > midChg, 'counter must keep advancing smoothly across a slot swap, not freeze or jump');

  rec.close();
});
