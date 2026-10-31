import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1.96.0 — two data-integrity defects the 2026-08-20 pack/DPU swap exposed.
 *
 * 1. MEMBERSHIP ROLLOVER. The emitted lifetime battery counters are a monotone
 *    high-water floor. When Core 3 left the SHP2 source list its five packs
 *    dropped out of the live sum, leaving the live value ~904 kWh BELOW the
 *    pinned floor — so `fleet_battery_charge_wh` / `_discharge_wh` read FLAT for
 *    an estimated ~35 days, with no log line and no alert, while the live sum
 *    slowly climbed back. The floors must re-seed when membership changes.
 *
 * 2. ORPHANED HELD ROWS. Held rows are keyed (chassisSn, packSn) but the carry
 *    gate only checked the CHASSIS. After the swap, five rows worth ~937 kWh sat
 *    under Core 3 for packs that now live in Core 4 — dormant only because Core 3
 *    is off-panel. Re-wiring it would re-add all five in ONE 5-min rollup
 *    (~520x the fleet's physical charge ceiling) with no rate guard.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-membership-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { haTotalIncreasing } = await import('./helpers/haTotalIncreasing.js');

/** A lifetime_totals row / lifetime_basis shift as committed (another connection). */
function committed(key: string): { row: number | null; shift: number | null } {
  const raw = new DatabaseSync(process.env.DB_PATH!);
  try {
    const r = raw.prepare(`SELECT wh FROM lifetime_totals WHERE metric_key = ?`).get(key) as { wh: number } | undefined;
    const b = raw.prepare(`SELECT shift_wh FROM lifetime_basis WHERE metric_key = ?`).get(key) as { shift_wh: number } | undefined;
    return { row: r?.wh ?? null, shift: b?.shift_wh ?? null };
  } finally {
    raw.close();
  }
}

const PACK_MAH_TO_WH = (32 * 3.2) / 1_000;

function makeStore(snap: any) {
  const ee = new EventEmitter() as any;
  ee.snap = snap;
  ee.get = () => ee.snap;
  return ee;
}

/** A DPU whose pack serials are given EXPLICITLY, so a pack can move chassis. */
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

// v1.193.0 — changed: this test asserted the published counter "must step DOWN to the new pool". Home
// Assistant books a step below 90 % of the last reading as a meter reset, the whole new reading again
// (4,096 Wh of phantom energy here; about 12,043 kWh on the live Battery Energy In by 2026-09-07).
// The floors still re-seed to the new pool (the row); the published counter continues from its last
// value, the difference carried as a basis shift written with the floors.
test('membership rollover — the lifetime floors RE-SEED instead of freezing when a member leaves; v1.193.0: the published counters continue (basis shift)', () => {
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device(['DPU_A', 'DPU_B']);
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, packSn: 'PA1', chg: 1_000_000, dsg: 1_000_000 }]);
  store.snap.devices.DPU_B = dpuDevice('DPU_B', [{ num: 1, packSn: 'PB1', chg: 2_000_000, dsg: 2_000_000 }]);

  const lines: string[] = [];
  const rec = createRecorder(store as any, (m: string) => lines.push(m));
  const published: number[] = [];
  const read = () => { const t = rec.getLifetimeTotals(); published.push(total(t, 'fleet_battery_charge_wh')); return t; };
  rec.rollupLifetime();                                    // baselines, deltas 0 — seeds the fingerprint

  // Both members accumulate: A +40k mAh, B +40k mAh (4,096 Wh each).
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, packSn: 'PA1', chg: 1_040_000, dsg: 1_040_000 }]);
  store.snap.devices.DPU_B = dpuDevice('DPU_B', [{ num: 1, packSn: 'PB1', chg: 2_040_000, dsg: 2_040_000 }]);
  rec.rollupLifetime();
  read();
  const highWater = published[published.length - 1];
  assert.ok(Math.abs(highWater - 80_000 * PACK_MAH_TO_WH) < 1e-6, `floor built to ${highWater}`);

  // B leaves the panel entirely (physically re-wired). The live sum is now A only.
  store.snap.devices.SHP2 = shp2Device(['DPU_A']);
  delete store.snap.devices.DPU_B;
  // v1.188.1 (review) — the change must hold for three rollups (a one-poll isConnect flicker is not
  // a rollover): until then the floor holds and B's held packs stay in the sum.
  rec.rollupLifetime();
  read();
  rec.rollupLifetime();
  read();
  assert.ok(Math.abs(published[published.length - 1] - highWater) < 1e-6, 'not re-seeded before the change is sustained');
  assert.ok(Math.abs((committed('fleet_battery_charge_wh').row ?? 0) - highWater) < 1e-6, 'the floor row still describes A + B');
  rec.rollupLifetime();

  // The floors re-seeded to the A-only sum, and the shift went into the same commit (read before any
  // publish: the shift is the re-seed's own, not the guard's backstop).
  const c = committed('fleet_battery_charge_wh');
  const d = committed('fleet_battery_discharge_wh');
  assert.ok(Math.abs((c.row ?? 0) - 40_000 * PACK_MAH_TO_WH) < 1e-6, `floor re-seeded to the A-only sum, got ${c.row}`);
  assert.ok(Math.abs((c.shift ?? 0) - 40_000 * PACK_MAH_TO_WH) < 1e-6, `Battery Energy In shift +4,096 Wh committed with it, got ${c.shift}`);
  assert.ok(Math.abs((d.shift ?? 0) - 40_000 * PACK_MAH_TO_WH) < 1e-6, `Battery Energy Out likewise, got ${d.shift}`);

  const t = read();
  const after = published[published.length - 1];
  assert.ok(Math.abs(after - highWater) < 1e-6, `★★★ the published counter continues at ${highWater} (was: stepped down to 4,096, a meter reset), got ${after}`);
  assert.equal(t.fleet_battery_charge_wh.shiftWh, 40_000 * PACK_MAH_TO_WH);
  assert.equal(t.fleet_battery_charge_wh.heldWh, 0, 'continued by the shift, not held by the guard');
  assert.ok(Math.abs(total(t, 'fleet_battery_discharge_wh') - highWater) < 1e-6, 'Battery Energy Out continues likewise');
  const reseed = lines.filter((l) => l.includes('v1.96.0 SHP2 pool membership changed'));
  assert.equal(reseed.length, 1);
  assert.match(reseed[0], /charge 8192 -> 4096 Wh/);
  assert.match(reseed[0], /continue from their last values \(basis shift \+4096 \/ \+4096 Wh, now 4096 \/ 4096 Wh\)/);
  assert.ok(!reseed[0].includes('meter reset'), 'the step is no longer described as a harmless reset');
  assert.deepEqual(lines.filter((l) => l.includes('WARN lifetime counter')), [], 'the guard\'s backstop never fires on a known re-seed');

  // A +5k mAh: the counter advances from the continued value (512 Wh), not from the new pool's 4,096.
  store.snap.devices.DPU_A = dpuDevice('DPU_A', [{ num: 1, packSn: 'PA1', chg: 1_045_000, dsg: 1_045_000 }]);
  read();
  assert.ok(Math.abs(published[published.length - 1] - 85_000 * PACK_MAH_TO_WH) < 1e-6, `8,704 Wh after A's +512, got ${published[published.length - 1]}`);
  rec.rollupLifetime();
  read();
  const ha = haTotalIncreasing(published);
  assert.equal(ha.resets, 0, `Home Assistant reads no meter reset (was 1, booking 4,096 Wh again): ${published.join(', ')}`);
  assert.ok(Math.abs(ha.sum - 5_000 * PACK_MAH_TO_WH) < 1e-6, `HA books exactly A's 512 Wh after the high water, got ${ha.sum}`);
  rec.close();
});

test('membership rollover — a STABLE roster still ratchets monotonically (no spurious re-seed)', () => {
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device(['DPU_C']);
  store.snap.devices.DPU_C = dpuDevice('DPU_C', [{ num: 1, packSn: 'PC1', chg: 1_000_000, dsg: 1_000_000 }]);
  const rec = createRecorder(store as any, () => {});
  // The previous test's roster is persisted (bms-membership.json): three rollups settle the change
  // to this roster (v1.188.1 review: a change is re-seeded only once it holds for three).
  rec.rollupLifetime();
  rec.rollupLifetime();
  rec.rollupLifetime();

  store.snap.devices.DPU_C = dpuDevice('DPU_C', [{ num: 1, packSn: 'PC1', chg: 1_040_000, dsg: 1_040_000 }]);
  rec.rollupLifetime();
  const peak = total(rec.getLifetimeTotals(), 'fleet_battery_charge_wh');

  // Same roster, device transiently gone: the monotone floor must HOLD.
  delete store.snap.devices.DPU_C;
  rec.rollupLifetime();
  const held = total(rec.getLifetimeTotals(), 'fleet_battery_charge_wh');
  assert.ok(held >= peak - 1e-9, `stable roster must not regress (${held} vs ${peak})`);
});

test('orphan guard — a held row is NOT carried once its pack lives in another chassis', () => {
  const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
  store.snap.devices.SHP2 = shp2Device(['DPU_X', 'DPU_Y']);          // roster CONSTANT throughout
  store.snap.devices.DPU_X = dpuDevice('DPU_X', [{ num: 1, packSn: 'MOVER', chg: 1_000_000, dsg: 1_000_000 }]);
  store.snap.devices.DPU_Y = dpuDevice('DPU_Y', [{ num: 1, packSn: 'STAY', chg: 3_000_000, dsg: 3_000_000 }]);

  const rec = createRecorder(store as any, () => {});
  rec.rollupLifetime();
  // v1.193.0 — the previous test's roster stays the BMS sum's members until this one holds for three
  // rollups (a Core that joins counts from the re-seed, bmsMembersOf): settle X and Y in first, so the
  // scenario below runs with both as members, as it did when a pending change summed the live set.
  rec.rollupLifetime();
  rec.rollupLifetime();

  // MOVER accumulates 400k mAh while still in X, creating a held row under X.
  store.snap.devices.DPU_X = dpuDevice('DPU_X', [{ num: 1, packSn: 'MOVER', chg: 1_040_000, dsg: 1_040_000 }]);
  rec.rollupLifetime();
  const beforeMove = total(rec.getLifetimeTotals(), 'fleet_battery_charge_wh');

  // MOVER is physically relocated into Y. X now holds nothing; Y holds both.
  store.snap.devices.DPU_X = dpuDevice('DPU_X', []);
  store.snap.devices.DPU_Y = dpuDevice('DPU_Y', [
    { num: 1, packSn: 'STAY', chg: 3_000_000, dsg: 3_000_000 },
    { num: 2, packSn: 'MOVER', chg: 1_040_000, dsg: 1_040_000 },
  ]);
  rec.rollupLifetime();
  const afterMove = total(rec.getLifetimeTotals(), 'fleet_battery_charge_wh');

  // MOVER's 400k mAh must be counted ONCE. Without the guard the stale X row is
  // carried alongside the live Y reading and the total roughly doubles.
  assert.ok(
    afterMove < beforeMove + 20_000 * PACK_MAH_TO_WH,
    `moved pack must not be double-counted (before ${beforeMove}, after ${afterMove})`,
  );
});

/* v1.97.0 — the case v1.96.0 MISSED, caught by live verification.
 *
 * v1.96.0 recorded the membership fingerprint on its first observation without
 * re-seeding, so it protected future rollovers but left the EXISTING freeze
 * untouched — after deploy the emitted floor still sat ~902 MWh above the live
 * sum, exactly the condition the release was written to fix. A gap that large is
 * not the transient dip held-carry smooths; it is an unrecorded rollover. */
