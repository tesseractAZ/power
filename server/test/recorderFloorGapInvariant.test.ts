import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

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
const PACK_MAH_TO_WH = (32 * 3.2) / 1_000;

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
/** v1.193.0 — the committed floor row and basis shift of a key (another connection). */
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

test('gap invariant — a floor left above the live sum is repaired even when the fingerprint NEVER changes', () => {
  // Process 1: a two-member pool builds the floor.
  const s1 = makeStore({ generatedAt: Date.now(), devices: {} as any });
  s1.snap.devices.SHP2 = shp2Device(['BIG1', 'BIG2']);
  s1.snap.devices.BIG1 = dpuDevice('BIG1', [{ num: 1, packSn: 'B1', chg: 1_000_000, dsg: 1_000_000 }]);
  s1.snap.devices.BIG2 = dpuDevice('BIG2', [{ num: 1, packSn: 'B2', chg: 1_000_000, dsg: 1_000_000 }]);
  const rec1 = createRecorder(s1 as any, () => {});
  rec1.rollupLifetime();
  // v1.193.0 — BIG2 only charged: the discharge floor (4,096) is BIG1's alone, so below it is the
  // charge floor that sits above the live sum, and the discharge counter advances past its floor.
  s1.snap.devices.BIG1 = dpuDevice('BIG1', [{ num: 1, packSn: 'B1', chg: 1_040_000, dsg: 1_040_000 }]);
  s1.snap.devices.BIG2 = dpuDevice('BIG2', [{ num: 1, packSn: 'B2', chg: 1_040_000, dsg: 1_000_000 }]);
  rec1.rollupLifetime();
  const peak = total(rec1.getLifetimeTotals(), 'fleet_battery_charge_wh');
  assert.ok(peak > 4000, `floor built to ${peak}`);

  // Poison the state exactly as v1.96.0 did: record the fingerprint for the
  // SMALLER pool without repairing the floor.
  // v1.193.0 — the roster lived in the file alone then: this release reads the file only while the
  // database holds no committed roster (the first boot after an upgrade), so the row goes too.
  writeFileSync(join(dirname(process.env.DB_PATH!), 'bms-membership.json'),
    JSON.stringify({ fp: 'BIG1', at: 'x' }));
  {
    const raw = new DatabaseSync(process.env.DB_PATH!);
    try { raw.exec(`DELETE FROM bms_membership`); } finally { raw.close(); }
  }

  // Process 2: only BIG1 on the panel. The fingerprint MATCHES, so any repair
  // keyed on a fingerprint change is unreachable — only the gap can drive it.
  const s2 = makeStore({ generatedAt: Date.now(), devices: {} as any });
  s2.snap.devices.SHP2 = shp2Device(['BIG1']);
  s2.snap.devices.BIG1 = dpuDevice('BIG1', [{ num: 1, packSn: 'B1', chg: 1_040_000, dsg: 1_040_000 }]);
  const lines: string[] = [];
  const rec2 = createRecorder(s2 as any, (m: string) => lines.push(m));

  rec2.rollupLifetime();
  const midway = total(rec2.getLifetimeTotals(), 'fleet_battery_charge_wh');
  assert.ok(Math.abs(midway - peak) < 1e-6, `one rollup of gap must NOT repair (peak ${peak}, midway ${midway})`);
  assert.ok(Math.abs((committed('fleet_battery_charge_wh').row ?? 0) - peak) < 1e-6, 'one rollup of gap: the floor row is untouched');

  // BIG1 discharges 5k mAh before the next rollup: Battery Energy Out reads 4,608 at once (pending).
  s2.snap.devices.BIG1 = dpuDevice('BIG1', [{ num: 1, packSn: 'B1', chg: 1_040_000, dsg: 1_045_000 }]);
  assert.ok(Math.abs(total(rec2.getLifetimeTotals(), 'fleet_battery_discharge_wh') - 45_000 * PACK_MAH_TO_WH) < 1e-6, 'out 4,608 before the re-seed');
  rec2.rollupLifetime();
  // v1.193.0 — changed: this asserted the published value "must step the floor down". The FLOOR still
  // re-seeds to the live sum (its row), so the counter advances again at once rather than staying
  // pinned until the live sum climbs back; the published value continues from the peak (a basis
  // shift committed with the floor: a step down below 90 % is Home Assistant's meter reset).
  const c = committed('fleet_battery_charge_wh');
  assert.ok(Math.abs((c.row ?? 0) - 40_000 * PACK_MAH_TO_WH) < 1e-6, `a SUSTAINED gap re-seeds the floor to the live sum (peak ${peak}, row ${c.row})`);
  assert.ok(Math.abs((c.shift ?? 0) - (peak - 40_000 * PACK_MAH_TO_WH)) < 1e-6, `the shift went into the same commit (${c.shift})`);
  const t = rec2.getLifetimeTotals();
  const after = total(t, 'fleet_battery_charge_wh');
  assert.ok(Math.abs(after - peak) < 1e-6, `★★★ the published counter continues at the peak (was: stepped down to ${40_000 * PACK_MAH_TO_WH}), got ${after}`);
  assert.equal(t.fleet_battery_charge_wh.heldWh, 0, 'continued by the shift, not held by the guard');
  // Battery Energy Out had no gap: its floor re-seeds to the live 4,608 it already published (the
  // floor as this rollup ratchets it), so its shift is 0 and nothing is held.
  const out = committed('fleet_battery_discharge_wh');
  assert.ok(Math.abs((out.row ?? 0) - 45_000 * PACK_MAH_TO_WH) < 1e-6 && out.shift === 0, `out: row 4,608, shift 0 (${out.row}, ${out.shift})`);
  assert.ok(Math.abs(total(t, 'fleet_battery_discharge_wh') - 45_000 * PACK_MAH_TO_WH) < 1e-6, 'out continues at 4,608');
  assert.equal(t.fleet_battery_discharge_wh.heldWh, 0, 'out: nothing held (a re-seed from the floor before its ratchet would shift −512 Wh)');
  assert.match(lines.find((l) => l.includes('v1.98.0 lifetime battery floor sat')) ?? '', /discharge 4608 -> 4608 Wh\)\. v1\.193\.0 — the published Battery Energy In \/ Out continue from their last values \(basis shift \+4096 \/ \+0 Wh/);
  assert.deepEqual(lines.filter((l) => l.includes('WARN lifetime counter')), []);

  // The re-seeded floor advances at once: BIG1 +5k mAh is +512 Wh published.
  s2.snap.devices.BIG1 = dpuDevice('BIG1', [{ num: 1, packSn: 'B1', chg: 1_045_000, dsg: 1_045_000 }]);
  assert.ok(Math.abs(total(rec2.getLifetimeTotals(), 'fleet_battery_charge_wh') - (peak + 5_000 * PACK_MAH_TO_WH)) < 1e-6, 'peak + 512 Wh');
  rec2.close();
});

test('v1.193.0 — both floors above the live sum: both re-seed, and BOTH basis shifts commit with them (no guard backstop)', () => {
  // The state a release before v1.193.0 left (the v1.96.0 freeze): both floor rows seeded against a
  // pool that no longer exists, here 10 kWh above BIG1's live sum, no basis shifts, and the rows as
  // the last values published.
  const IN = 'fleet_battery_charge_wh';
  const OUT = 'fleet_battery_discharge_wh';
  {
    const raw = new DatabaseSync(process.env.DB_PATH!);
    try {
      raw.exec(`UPDATE lifetime_totals SET wh = wh + 10000 WHERE metric_key IN ('${IN}', '${OUT}'); DELETE FROM lifetime_basis;`);
    } finally { raw.close(); }
  }
  const live = 45_000 * PACK_MAH_TO_WH;
  const rows = { in: committed(IN).row ?? NaN, out: committed(OUT).row ?? NaN };
  assert.ok(Math.abs(rows.in - live - 10_000) < 1e-6 && Math.abs(rows.out - live - 10_000) < 1e-6, `both rows 10 kWh above the live 4,608 (${rows.in}, ${rows.out})`);
  writeFileSync(join(dirname(process.env.DB_PATH!), '.emit-highwater.json'), JSON.stringify({ [IN]: rows.in, [OUT]: rows.out }));

  const s3 = makeStore({ generatedAt: Date.now(), devices: {} as any });
  s3.snap.devices.SHP2 = shp2Device(['BIG1']);
  s3.snap.devices.BIG1 = dpuDevice('BIG1', [{ num: 1, packSn: 'B1', chg: 1_045_000, dsg: 1_045_000 }]);
  const lines: string[] = [];
  const rec3 = createRecorder(s3 as any, (m: string) => lines.push(m));
  rec3.rollupLifetime();
  rec3.rollupLifetime();
  // Read before any read could rebase: both shifts went into the floors' commit.
  const c = committed(IN);
  const d = committed(OUT);
  assert.ok(Math.abs((c.row ?? 0) - live) < 1e-6 && Math.abs((c.shift ?? 0) - 10_000) < 1e-6, `in: row 4,608, shift +10,000 (${c.row}, ${c.shift})`);
  assert.ok(Math.abs((d.row ?? 0) - live) < 1e-6 && Math.abs((d.shift ?? 0) - 10_000) < 1e-6,
    `★★★ out: row 4,608, shift +10,000 in the same commit (${d.row}, ${d.shift}); without it only the guard's backstop catches the step, a WARN and a write of its own`);
  const t = rec3.getLifetimeTotals();
  assert.ok(Math.abs(total(t, IN) - rows.in) < 1e-6 && Math.abs(total(t, OUT) - rows.out) < 1e-6, 'both continue from the last published values');
  assert.equal(t[IN].heldWh, 0);
  assert.equal(t[OUT].heldWh, 0);
  assert.match(lines.find((l) => l.includes('v1.98.0 lifetime battery floor sat')) ?? '', /basis shift \+10000 \/ \+10000 Wh/);
  assert.deepEqual(lines.filter((l) => l.includes('WARN lifetime counter')), [], 'the re-seed shifted both counters; the guard never had to');
  rec3.close();
});
