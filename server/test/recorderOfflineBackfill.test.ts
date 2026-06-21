import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

/**
 * v0.48.0 — FIX A: offline-at-deploy backfill.
 *
 * When v0.45.0 deployed with a member core ALREADY cloud-offline, that core's
 * packs were absent from every snapshot AND never got a pack_lastwh_* row (the
 * held hold is only written on a live sighting). It DID get a v0.13.0
 * pack_base_* baseline (captured pre-deploy) plus recorded
 * pack{N}_lifetime_chg_mah/_dsg_mah register history. Without a held value the
 * offline-carry loop skips it, so the live sum stays below the boot-seeded
 * floor and BOTH battery counters freeze ("Battery in/out today = 0 kWh").
 *
 * The backfill reconstructs each such member pack's held delta ONCE from its
 * LAST recorded register, persists it via savePackLastWh, and lets the existing
 * carry loop sum it. A spare (failing the sourceSns filter) is NEVER backfilled
 * or summed. The read-only debug path performs ZERO backfill writes.
 *
 * Hermetic single-test file: the module-load DB_PATH is a fresh dir, and we
 * seed that SAME db with pre-deploy state before creating the recorder, exactly
 * as a real upgrade-over-existing-/data/ecoflow.db would present.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-offline-backfill-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const DB_PATH = process.env.DB_PATH;

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

/**
 * Seed the db with PRE-DEPLOY state: a captured per-pack baseline (pack_base_*)
 * and recorded register history (pack{N}_lifetime_chg/dsg_mah) — but NO
 * pack_lastwh_* held row (those didn't exist before v0.45.0). This is exactly
 * what a member core that was online pre-v0.45.0 then offline at deploy looks
 * like in /data/ecoflow.db.
 */
function seedPreDeploy(
  sn: string,
  num: number,
  base: { chgMah: number; dsgMah: number },
  lastReg: { chgMah: number; dsgMah: number },
) {
  const raw = new DatabaseSync(DB_PATH);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, sn TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS lifetime_totals (metric_key TEXT PRIMARY KEY, wh REAL NOT NULL DEFAULT 0, last_integrated_ts INTEGER NOT NULL DEFAULT 0);
  `);
  const now = Date.now();
  const up = raw.prepare(
    `INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)
     ON CONFLICT(metric_key) DO UPDATE SET wh = excluded.wh, last_integrated_ts = excluded.last_integrated_ts`,
  );
  // Baseline rows (note: pack_base_* stores the baseline mAh in the `wh` column).
  up.run(`pack_base_${sn}_${num}_chg`, base.chgMah, now - 10 * 24 * 60 * 60 * 1000);
  up.run(`pack_base_${sn}_${num}_dsg`, base.dsgMah, now - 10 * 24 * 60 * 60 * 1000);
  // Register history: a couple of points, last one being the value just before
  // the core went cloud-offline (a few days ago).
  const ins = raw.prepare(`INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)`);
  const t1 = now - 7 * 24 * 60 * 60 * 1000;
  const t2 = now - 3 * 24 * 60 * 60 * 1000; // last point before offline
  ins.run(t1, sn, `pack${num}_lifetime_chg_mah`, base.chgMah + (lastReg.chgMah - base.chgMah) / 2);
  ins.run(t2, sn, `pack${num}_lifetime_chg_mah`, lastReg.chgMah);
  ins.run(t1, sn, `pack${num}_lifetime_dsg_mah`, base.dsgMah + (lastReg.dsgMah - base.dsgMah) / 2);
  ins.run(t2, sn, `pack${num}_lifetime_dsg_mah`, lastReg.dsgMah);
  raw.close();
}

function lifetimeRow(metricKey: string): { wh: number } | undefined {
  const raw = new DatabaseSync(DB_PATH);
  const row = raw.prepare(`SELECT wh FROM lifetime_totals WHERE metric_key = ?`).get(metricKey) as { wh: number } | undefined;
  raw.close();
  return row;
}

test('offline-at-deploy member is backfilled from history (counters unfreeze); spare never is; debug is read-only', () => {
  // Seed the offline member DPU_B (absent at deploy) with a baseline + history:
  //   baseline chg=2,000,000 dsg=2,000,000 mAh; last recorded chg=2,030,000 dsg=2,090,000.
  //   → held delta: chg=30,000 mAh, dsg=90,000 mAh (NET DISCHARGED, surfacing the deficit).
  seedPreDeploy('DPU_B', 1, { chgMah: 2_000_000, dsgMah: 2_000_000 }, { chgMah: 2_030_000, dsgMah: 2_090_000 });
  // Seed a SPARE DPU_S the SAME way — but it will NOT be an SHP2 source, so it
  // must never be backfilled or summed.
  seedPreDeploy('DPU_S', 1, { chgMah: 5_000_000, dsgMah: 5_000_000 }, { chgMah: 5_500_000, dsgMah: 5_900_000 });

  // Pre-deploy state has NO pack_lastwh_* rows for either (the live bug).
  assert.equal(lifetimeRow('pack_lastwh_DPU_B_1_chg'), undefined, 'precondition: no held row for B yet');

  // Live snapshot at deploy: SHP2 lists DPU_A (online) and DPU_B (offline) as
  // connected sources. DPU_S is NOT a source (spare). DPU_B + DPU_S are ABSENT
  // from the device map (cloud-offline / spare not in the live home feed).
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device('SHP2', ['DPU_A', 'DPU_B']);
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, accuChgMah: 1_000_000, accuDsgMah: 1_000_000 }]);
  // DPU_B absent (offline at deploy). DPU_S absent (spare, also offline).

  const rec = createRecorder(store as any, () => {});

  // ── Read-only debug FIRST: it must NOT backfill (no pack_lastwh_* write). ──
  const dbg0 = rec.batteryLifetimeDebug();
  assert.equal(lifetimeRow('pack_lastwh_DPU_B_1_chg'), undefined,
    'batteryLifetimeDebug must NOT backfill (read-only path performs no writes)');
  assert.ok(!dbg0.packs.some((p) => p.backfilledFromHistory),
    'read-only debug must report no backfilledFromHistory packs');

  // ── Mutating rollup: backfills DPU_B from history; DPU_A captures baseline. ──
  rec.rollupLifetime();

  // The backfill wrote a held row for the offline member B.
  assert.ok(lifetimeRow('pack_lastwh_DPU_B_1_chg') !== undefined,
    'backfill must persist a pack_lastwh_* row for the offline-at-deploy member');
  // The spare must NOT have been backfilled.
  assert.equal(lifetimeRow('pack_lastwh_DPU_S_1_chg'), undefined,
    'spare (not an SHP2 source) must NEVER be backfilled');

  const t = rec.getLifetimeTotals();
  const chargeWh = total(t, 'fleet_battery_charge_wh');
  const dischargeWh = total(t, 'fleet_battery_discharge_wh');

  // Fleet = DPU_A (fresh, deltas 0 this snapshot — just captured baseline) +
  //         DPU_B (backfilled held: chg 30,000 mAh, dsg 90,000 mAh).
  const expectedChg = 30_000 * PACK_MAH_TO_WH;
  const expectedDsg = 90_000 * PACK_MAH_TO_WH;
  assert.ok(Math.abs(chargeWh - expectedChg) < 1e-6,
    `charge must INCLUDE the backfilled B contribution; got ${chargeWh}, expected ${expectedChg}`);
  assert.ok(Math.abs(dischargeWh - expectedDsg) < 1e-6,
    `discharge must INCLUDE the backfilled B contribution; got ${dischargeWh}, expected ${expectedDsg}`);
  // Counters are NOT frozen below the floor — discharge (net-discharged window)
  // surfaces above charge, the whole point of the fix.
  assert.ok(dischargeWh > chargeWh, 'net-discharged deficit must surface (discharge > charge)');
  assert.ok(dischargeWh > 0, 'discharge counter must NOT be frozen at 0');

  // Debug confirms B is an offline-held member, flagged backfilledFromHistory.
  const dbg = rec.batteryLifetimeDebug();
  assert.ok(dbg.offlineHeldMembers.includes('DPU_B|1'),
    `DPU_B|1 should be an offline-held member, got ${dbg.offlineHeldMembers.join(',')}`);
  const bPack = dbg.packs.find((p) => p.sn === 'DPU_B' && p.num === 1 && p.heldFromLastKnown);
  assert.ok(bPack, 'DPU_B held pack present in debug breakdown');
  // The spare appears nowhere as a contributing pack.
  assert.ok(!dbg.packs.some((p) => p.sn === 'DPU_S' && (p.passesFilter || p.heldFromLastKnown)),
    'spare DPU_S must never be summed or held');
  assert.ok(!dbg.offlineHeldMembers.some((k) => k.startsWith('DPU_S|')),
    'spare DPU_S must never be an offline-held member');

  // ── Backfill is once-per-pack: a SECOND rollup must NOT double-count B. ──
  rec.rollupLifetime();
  const t2 = rec.getLifetimeTotals();
  assert.ok(Math.abs(total(t2, 'fleet_battery_charge_wh') - expectedChg) < 1e-6,
    'second rollup must not double-count the backfilled hold (charge stable)');
  assert.ok(Math.abs(total(t2, 'fleet_battery_discharge_wh') - expectedDsg) < 1e-6,
    'second rollup must not double-count the backfilled hold (discharge stable)');

  rec.close();
});
