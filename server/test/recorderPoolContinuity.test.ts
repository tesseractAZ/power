import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1.193.0 — Battery Energy In / Out across a Core leaving the pool AND rejoining it, a restart, and
 * a failed write of the floors.
 *
 * Before: the battery floors are pool-relative (the member packs' deltas from their baselines) and
 * the published value was the floor, so every change of the pool reached Home Assistant as a step.
 * A Core leaving stepped the counters DOWN to the new pool's sum once the change was sustained (HA:
 * below 90 % of the last reading, a meter reset, the whole new reading booked again). A Core
 * rejoining stepped them UP at the very next read, before any rollup saw the change (the BMS sum's
 * members were the live set while no change was pending): its packs entered with their whole history
 * since their baselines, the energy already published once plus its cycling on the bench, which HA
 * books as energy. On this plant one leave-and-rejoin booked 10,240 Wh in HA for 512 Wh of real
 * energy.
 *
 * Now the members are the accepted roster until a change holds for three rollups (a joiner counts
 * from the re-seed), and each re-seed carries the published value by a basis shift committed with
 * the floors and the accepted roster (the bms_membership row) in one transaction; the roster file
 * follows the commit, for an older release, and is read only while there is no row.
 *
 * Packs are 32 × 3.2 V: 1 mAh = 0.1024 Wh. Test serials are placeholders.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-pool-continuity-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { haTotalIncreasing } = await import('./helpers/haTotalIncreasing.js');

const WH = (mah: number) => mah * ((32 * 3.2) / 1_000);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function makeStore(snap: any) {
  const ee = new EventEmitter() as any;
  ee.snap = snap;
  ee.get = () => ee.snap;
  return ee;
}
function dpuDevice(sn: string, packSn: string, mah: number) {
  return {
    sn, deviceName: sn, productName: 'DPU', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 50, packCount: 1,
      packs: [{
        num: 1, soc: 50, soh: 100, actSoh: 100, inputWatts: 0, outputWatts: 0, temp: 20,
        cycles: 10, remainTimeMin: null, packSn, designCapMah: 50_000,
        fullCapMah: 50_000, remainCapMah: 25_000, accuChgMah: mah, accuDsgMah: mah,
        cellTemps: [], mosTemps: [], ptcTemps: [], hwBoardTemp: null, curResTemp: null,
        minCellTemp: null, maxCellTemp: null, minMosTemp: null, maxMosTemp: null, cellVoltagesMv: [],
        minCellVoltageMv: null, maxCellVoltageMv: null, maxVolDiffMv: null, balanceState: 0,
        packVoltageMv: null, adBatVoltageMv: null, ocvMv: null,
      }],
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
/** The committed floor row and basis shift (another connection). */
function committed(key: string): { row: number | null; shift: number | null; owed: number | null } {
  const raw = new DatabaseSync(process.env.DB_PATH!);
  try {
    const r = raw.prepare(`SELECT wh FROM lifetime_totals WHERE metric_key = ?`).get(key) as { wh: number } | undefined;
    const b = raw.prepare(`SELECT shift_wh, owed_wh FROM lifetime_basis WHERE metric_key = ?`).get(key) as { shift_wh: number; owed_wh: number } | undefined;
    return { row: r?.wh ?? null, shift: b?.shift_wh ?? null, owed: b?.owed_wh ?? null };
  } finally {
    raw.close();
  }
}
const ROSTER_FILE = join(dirname(process.env.DB_PATH!), 'bms-membership.json');
const rosterFile = (): string => JSON.parse(readFileSync(ROSTER_FILE, 'utf8')).fp;
/** The committed accepted roster (the bms_membership row, another connection). */
function rosterRow(): string | null {
  const raw = new DatabaseSync(process.env.DB_PATH!);
  try {
    const r = raw.prepare(`SELECT fp FROM bms_membership WHERE id = 1`).get() as { fp: string } | undefined;
    return r?.fp ?? null;
  } finally {
    raw.close();
  }
}
function sql(stmt: string): void {
  const raw = new DatabaseSync(process.env.DB_PATH!);
  try { raw.exec(stmt); } finally { raw.close(); }
}
const batteryWarns = () => lines.filter((l) => l.includes('WARN lifetime counter fleet_battery'));
const IN = 'fleet_battery_charge_wh';
const OUT = 'fleet_battery_discharge_wh';

// One plant across the file (DB_PATH is captured at import): A and B on the panel.
const store = makeStore({ generatedAt: Date.now(), devices: {} as any });
const published: number[] = [];
const lines: string[] = [];
let rec = createRecorder(store as any, (m: string) => lines.push(m));
const read = (): number => {
  const t = rec.getLifetimeTotals();
  const v = t[IN].persistedWh + t[IN].pendingWh;
  assert.ok(near(t[OUT].persistedWh + t[OUT].pendingWh, v), 'in and out move together on this plant');
  published.push(v);
  return v;
};

test('★★★ a Core leaving and rejoining: Battery Energy In never steps, and HA books exactly the home\'s energy', () => {
  store.snap.devices.SHP2 = shp2Device(['DPU_A', 'DPU_B']);
  store.snap.devices.DPU_A = dpuDevice('DPU_A', 'PA1', 1_000_000);
  store.snap.devices.DPU_B = dpuDevice('DPU_B', 'PB1', 2_000_000);
  rec.rollupLifetime();
  read();
  // Both Cores charge 40k mAh in the home.
  store.snap.devices.DPU_A = dpuDevice('DPU_A', 'PA1', 1_040_000);
  store.snap.devices.DPU_B = dpuDevice('DPU_B', 'PB1', 2_040_000);
  rec.rollupLifetime();
  assert.ok(near(read(), WH(80_000)), '8,192 Wh');

  // B comes off the panel (it stays online, on the bench).
  store.snap.devices.SHP2 = shp2Device(['DPU_A']);
  for (let i = 0; i < 2; i++) { rec.rollupLifetime(); assert.ok(near(read(), WH(80_000)), `leave rollup ${i + 1}: 8,192 Wh`); }
  // A charges 5k mAh in the window before the third rollup: read at once (pending over the floor).
  store.snap.devices.DPU_A = dpuDevice('DPU_A', 'PA1', 1_045_000);
  assert.ok(near(read(), WH(85_000)), 'A +5k mAh: 8,704 Wh');
  rec.rollupLifetime();
  const t3 = rec.getLifetimeTotals();
  assert.ok(near(t3[IN].persistedWh + t3[IN].pendingWh, WH(85_000)), `leave rollup 3: 8,704 Wh (was 4,608: a meter reset), got ${t3[IN].persistedWh + t3[IN].pendingWh}`);
  assert.equal(t3[IN].heldWh, 0, 'the shift carries the old pool as this rollup ratcheted it (A\'s +512 Wh in it): nothing held');
  published.push(t3[IN].persistedWh + t3[IN].pendingWh);
  assert.ok(near(committed(IN).row ?? 0, WH(45_000)) && near(committed(IN).shift ?? 0, WH(40_000)), `row 4,608, shift +4,096 (${committed(IN).row}, ${committed(IN).shift})`);
  assert.match(lines.find((l) => l.includes('v1.96.0 SHP2 pool membership changed')) ?? '', /charge 8704 -> 4608 Wh/);
  rec.rollupLifetime();

  // B cycles 20k mAh on the bench, then rejoins the panel.
  store.snap.devices.DPU_B = dpuDevice('DPU_B', 'PB1', 2_060_000);
  store.snap.devices.SHP2 = shp2Device(['DPU_A', 'DPU_B']);
  assert.ok(near(read(), WH(85_000)), `★★★ the read at the rejoin, before any rollup: 8,704 Wh (was 10,752: +6,144 Wh of B's history in one read), got ${published[published.length - 1]}`);
  for (let i = 0; i < 3; i++) { rec.rollupLifetime(); assert.ok(near(read(), WH(85_000)), `rejoin rollup ${i + 1}: 8,704 Wh`); }
  // The re-seed counted B from its baseline (row 10,752) and shifted the difference away.
  assert.ok(near(committed(IN).row ?? 0, WH(105_000)), `row = A 4,608 + B 6,144 = 10,752 (${committed(IN).row})`);
  assert.ok(near(committed(IN).shift ?? 0, WH(-20_000)), `shift +4,096 − 6,144 = −2,048 (${committed(IN).shift})`);
  const reseeds = lines.filter((l) => l.includes('v1.96.0 SHP2 pool membership changed'));
  assert.equal(reseeds.length, 2, 'the leave and the rejoin');
  assert.match(reseeds[1], /\(DPU_A -> DPU_A,DPU_B\).*charge 4608 -> 10752 Wh.*basis shift -6144 \/ -6144 Wh, now -2048 \/ -2048 Wh/);
  // A re-seed's shift is explained: never owed, so no later rise is taken back against it.
  assert.equal(committed(IN).owed, 0, 'the re-seeds owe nothing (Battery Energy In)');
  assert.equal(committed('fleet_battery_discharge_wh').owed, 0, 'the re-seeds owe nothing (Battery Energy Out)');
  assert.ok(lines.some((l) => l.includes('a Core that joined counts from the re-seed')), 'the pending line says how a joiner counts');
  // B now counts in the home from the re-seed.
  store.snap.devices.DPU_B = dpuDevice('DPU_B', 'PB1', 2_070_000);
  assert.ok(near(read(), WH(95_000)), 'B +10k mAh in the home: 9,728 Wh');
  rec.rollupLifetime();
  assert.ok(near(read(), WH(95_000)));

  const ha = haTotalIncreasing(published);
  assert.equal(ha.resets, 0, `no meter reset (was one at the leave): ${published.join(', ')}`);
  assert.equal(ha.dips, 0, 'no negative hour');
  assert.ok(near(ha.sum, WH(95_000)), `HA books 40k + 40k + 5k + 10k mAh = 9,728 Wh, the home's energy (was 10,240 Wh over the leave and rejoin alone), got ${ha.sum}`);
  assert.deepEqual(lines.filter((l) => l.includes('WARN lifetime counter')), [], 'the re-seeds shifted explicitly; the guard never had to');
  assert.equal(rosterFile(), 'DPU_A,DPU_B');
});

test('★★★ a restart after the rejoin re-seed publishes the continued value (the shift is loaded before the first read)', () => {
  rec.close();
  rec = createRecorder(store as any, (m: string) => lines.push(m));
  const t = rec.getLifetimeTotals();
  assert.ok(near(t[IN].persistedWh + t[IN].pendingWh, WH(95_000)), `9,728 Wh (the row alone would publish 11,776), got ${t[IN].persistedWh + t[IN].pendingWh}`);
  assert.ok(near(t[IN].shiftWh ?? NaN, WH(-20_000)), 'shiftWh −2,048 in the details');
  assert.equal(t[IN].heldWh, 0, 'continued by the persisted shift, not held by the guard');
  published.push(t[IN].persistedWh + t[IN].pendingWh);
});

test('★★★ the floors and their shifts commit together: a failed write leaves both, and the roster file, as they were; the next process re-seeds the same change', () => {
  const before = { in: committed(IN), out: committed(OUT) };
  assert.ok(near(before.in.row ?? 0, WH(115_000)) && near(before.in.shift ?? 0, WH(-20_000)), 'row 11,776, shift −2,048');
  // Every write to lifetime_basis fails from here (its rows stay).
  const raw = new DatabaseSync(process.env.DB_PATH!);
  raw.exec(`CREATE TRIGGER basis_fail_ins BEFORE INSERT ON lifetime_basis BEGIN SELECT RAISE(ABORT, 'injected basis write failure'); END;
    CREATE TRIGGER basis_fail_upd BEFORE UPDATE ON lifetime_basis BEGIN SELECT RAISE(ABORT, 'injected basis write failure'); END;`);
  raw.close();

  // B leaves again: the third rollup re-seeds the floors to A alone (4,608) with a +7,168 Wh shift.
  store.snap.devices.SHP2 = shp2Device(['DPU_A']);
  for (let i = 0; i < 3; i++) { rec.rollupLifetime(); assert.ok(near(read(), WH(95_000)), `leave rollup ${i + 1}: 9,728 Wh`); }
  assert.ok(lines.some((l) => l.includes('lifetime battery floor write failed (injected basis write failure)')), 'the failure is logged');
  assert.deepEqual({ in: committed(IN), out: committed(OUT) }, before, '★★★ nothing committed: the floor rows did not move without their shifts');
  assert.equal(rosterFile(), 'DPU_A,DPU_B', 'the roster file follows the commit only');
  assert.equal(rosterRow(), 'DPU_A,DPU_B', 'the committed roster did not move without its floors');
  assert.ok(near(read(), WH(95_000)), 'this process publishes the continued value from memory');
  rec.close(); // the final rollup fails the same way

  // The failure clears; the next process starts from the committed state and re-seeds again.
  const raw2 = new DatabaseSync(process.env.DB_PATH!);
  raw2.exec(`DROP TRIGGER basis_fail_ins; DROP TRIGGER basis_fail_upd;`);
  raw2.close();
  rec = createRecorder(store as any, (m: string) => lines.push(m));
  assert.ok(near(read(), WH(95_000)), 'the first read after the restart: B is still in the accepted roster');
  for (let i = 0; i < 3; i++) { rec.rollupLifetime(); assert.ok(near(read(), WH(95_000)), `re-seed again, rollup ${i + 1}: 9,728 Wh`); }
  assert.ok(near(committed(IN).row ?? 0, WH(45_000)), `row 4,608 (${committed(IN).row})`);
  assert.ok(near(committed(IN).shift ?? 0, WH(50_000)), `shift −2,048 + 7,168 = +5,120 (${committed(IN).shift})`);
  assert.ok(near(committed(OUT).shift ?? 0, WH(50_000)), 'Battery Energy Out likewise');
  assert.equal(rosterFile(), 'DPU_A');
  assert.equal(rosterRow(), 'DPU_A');

  const ha = haTotalIncreasing(published);
  assert.equal(ha.resets, 0);
  assert.equal(ha.dips, 0);
  assert.ok(near(ha.sum, WH(95_000)), `HA's total is still the home's 9,728 Wh, got ${ha.sum}`);
  assert.deepEqual(lines.filter((l) => l.includes('WARN lifetime counter')), []);
  rec.close();
});

test('★★★ a rejoin whose floor commit fails publishes no step; a rebase of another counter meanwhile commits only its own shift', () => {
  rec = createRecorder(store as any, (m: string) => lines.push(m));
  assert.ok(near(read(), WH(95_000)), '9,728 Wh, A alone accepted');
  // Home Consumption has a published value (its row set from another connection).
  sql(`INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES ('fleet_load_wh', 100000, ${Date.now()})
       ON CONFLICT(metric_key) DO UPDATE SET wh = excluded.wh`);
  rec.getLifetimeTotals();
  // The battery floor rows stop accepting writes (a transient failure of the floors' transaction).
  sql(`CREATE TRIGGER floors_fail BEFORE UPDATE ON lifetime_totals WHEN NEW.metric_key LIKE 'fleet_battery%'
       BEGIN SELECT RAISE(ABORT, 'injected floor failure'); END;`);

  // B rejoins (nothing cycled since it left): the third rollup re-seeds the floors UP to A + B
  // (11,776) with a −7,168 Wh shift, in memory only.
  store.snap.devices.SHP2 = shp2Device(['DPU_A', 'DPU_B']);
  for (let i = 0; i < 3; i++) {
    rec.rollupLifetime();
    assert.ok(near(read(), WH(95_000)), `★★★ rejoin rollup ${i + 1}: 9,728 Wh (pending over the stale row instead of the in-memory floor: 16,896), got ${published[published.length - 1]}`);
  }
  assert.ok(lines.some((l) => l.includes('lifetime battery floor write failed (injected floor failure)')));
  const stale = { row: WH(45_000), shift: WH(50_000) };
  const isStale = (c: { row: number | null; shift: number | null }) => near(c.row ?? NaN, stale.row) && near(c.shift ?? NaN, stale.shift);
  assert.ok(isStale(committed(IN)) && isStale(committed(OUT)), 'nothing of the re-seed committed');
  assert.equal(rosterRow(), 'DPU_A');

  // An unexplained 10 kWh drop on Home Consumption: the read rebases it and writes its shift at once.
  sql(`UPDATE lifetime_totals SET wh = 90000 WHERE metric_key = 'fleet_load_wh'`);
  const t = rec.getLifetimeTotals();
  assert.equal(t.fleet_load_wh.persistedWh + t.fleet_load_wh.pendingWh, 100_000, 'Home Consumption continues');
  assert.equal(committed('fleet_load_wh').shift, 10_000, 'its shift is written at once');
  assert.ok(isStale(committed(IN)) && isStale(committed(OUT)),
    `★★★ the battery shifts are not written without their floors (the old row with the new shift: ${JSON.stringify(committed(IN))})`);
  assert.ok(near(t[IN].persistedWh + t[IN].pendingWh, WH(95_000)));
  published.push(t[IN].persistedWh + t[IN].pendingWh);
  rec.close(); // the final rollup's floor write fails the same way

  // The failure clears; the next process starts from the committed state and re-seeds again.
  sql(`DROP TRIGGER floors_fail;`);
  rec = createRecorder(store as any, (m: string) => lines.push(m));
  assert.ok(near(read(), WH(95_000)), `★★★ the first read after the restart: 9,728 Wh, got ${published[published.length - 1]}`);
  for (let i = 0; i < 3; i++) { rec.rollupLifetime(); assert.ok(near(read(), WH(95_000)), `re-seed again, rollup ${i + 1}: 9,728 Wh`); }
  assert.ok(near(committed(IN).row ?? 0, WH(115_000)) && near(committed(IN).shift ?? 0, WH(-20_000)), `row 11,776, shift −2,048 (${JSON.stringify(committed(IN))})`);
  assert.equal(rosterRow(), 'DPU_A,DPU_B');
  assert.deepEqual(batteryWarns(), [], 'no rebase of a battery counter: the shifts and floors stayed a matched pair');
  const ha = haTotalIncreasing(published);
  assert.equal(ha.resets, 0);
  assert.ok(near(ha.sum, WH(95_000)), `HA's total is still 9,728 Wh, got ${ha.sum}`);
});

test('★★★ a crash between the floors\' commit and the roster file write: the next process reads the committed roster, not the stale file', () => {
  // B leaves; the third rollup re-seeds to A alone and commits floors, shifts and roster.
  store.snap.devices.SHP2 = shp2Device(['DPU_A']);
  for (let i = 0; i < 3; i++) { rec.rollupLifetime(); assert.ok(near(read(), WH(95_000)), `leave rollup ${i + 1}: 9,728 Wh`); }
  const settled = { in: committed(IN), out: committed(OUT) };
  assert.ok(near(settled.in.row ?? 0, WH(45_000)) && near(settled.in.shift ?? 0, WH(50_000)), `row 4,608, shift +5,120 (${JSON.stringify(settled.in)})`);
  assert.equal(rosterRow(), 'DPU_A');
  const reseeds = lines.filter((l) => l.includes('v1.96.0 SHP2 pool membership changed')).length;
  // The process died after the COMMIT, before the file was written: the file still names B.
  writeFileSync(ROSTER_FILE, JSON.stringify({ fp: 'DPU_A,DPU_B', at: 'x' }));
  rec.close();

  rec = createRecorder(store as any, (m: string) => lines.push(m));
  assert.ok(near(read(), WH(95_000)),
    `★★★ 9,728 Wh (from the stale file B is summed again over the committed floor: 16,896, then shifted a second time), got ${published[published.length - 1]}`);
  assert.ok(lines.some((l) => l.includes('bms-membership.json reads DPU_A,DPU_B, the committed roster DPU_A')), 'the disagreement is logged');
  for (let i = 0; i < 3; i++) { rec.rollupLifetime(); assert.ok(near(read(), WH(95_000)), `rollup ${i + 1}: 9,728 Wh`); }
  assert.equal(lines.filter((l) => l.includes('v1.96.0 SHP2 pool membership changed')).length, reseeds, 'the change is not re-seeded a second time');
  assert.deepEqual({ in: committed(IN), out: committed(OUT) }, settled, 'the floors and shifts stand');
  assert.equal(rosterFile(), 'DPU_A', 'the file is rewritten after the next commit');
  const ha = haTotalIncreasing(published);
  assert.equal(ha.resets, 0);
  assert.equal(ha.dips, 0);
  assert.ok(near(ha.sum, WH(95_000)), `HA's total is still the home's 9,728 Wh, got ${ha.sum}`);
  assert.deepEqual(batteryWarns(), []);
  rec.close();
});

test('★ an unreadable, unwritable roster file: the committed roster stands, and the file is retried after each commit until it lands', () => {
  // A directory in the file's place: reading it and writing it both fail, as root too.
  rmSync(ROSTER_FILE);
  mkdirSync(ROSTER_FILE);
  rec = createRecorder(store as any, (m: string) => lines.push(m));
  assert.ok(lines.some((l) => l.includes('bms-membership.json reads (none), the committed roster DPU_A')));
  assert.ok(near(read(), WH(95_000)), '9,728 Wh: A alone, from the committed roster');
  rec.rollupLifetime(); // committed; the file write fails
  rmSync(ROSTER_FILE, { recursive: true });
  rec.rollupLifetime();
  assert.equal(rosterFile(), 'DPU_A', 'written after the next commit');
  assert.ok(near(read(), WH(95_000)));
  assert.deepEqual(batteryWarns(), []);
  rec.close();
});
