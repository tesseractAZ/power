import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  confirmDefectivePack, markPackPresent, getConfirmedRecord, listConfirmedRecords,
  retireAbsentPacks, clearConfirmedPack, _resetDefectivePackLatchForTests,
  DEFECTIVE_PACK_ABSENT_RETIRE_MS,
  DEFECTIVE_PACK_ABSOLUTE_RETIRE_MS,
} from '../src/defectivePackLatch.js';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.108.0 — the defective-pack LATCH.
 *
 * MOTIVATING INCIDENT (2026-08-24): the first day the TOU window let the bench
 * bank charge, `pack-defective-…` fired and resolved THREE times — one [High]
 * push + one Resolved push per charge burst — because leg 3 of the live
 * signature (sibling median >= 100 W) tracks the charger's duty cycle. A
 * confirmed diagnosis must not un-confirm because charging paused.
 */

const PACK_SN = 'Y712ZABA4H350037';
const DEV_SN = 'Y711ZABA9H3T0489';

const rec = (over: Record<string, unknown> = {}) => ({
  packSn: PACK_SN, deviceSn: DEV_SN, deviceName: 'Core 4', packNum: 1,
  socPct: 1, siblingMedianSocPct: 48, packAbsW: 0, siblingMedianAbsW: 380,
  deviantCell: 31, deltaMv: -106, ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dplatch-'));
  _resetDefectivePackLatchForTests(join(dir, 'latch.json'));
});

test('confirm is idempotent and keeps the FIRST evidence snapshot', () => {
  confirmDefectivePack(rec(), 1_000);
  confirmDefectivePack(rec({ socPct: 5, deltaMv: -20 }), 2_000);
  const r = getConfirmedRecord(PACK_SN)!;
  assert.equal(r.confirmedAtMs, 1_000);
  assert.equal(r.socPct, 1, 'first confirmation evidence is the RMA snapshot');
  assert.equal(listConfirmedRecords().length, 1);
});

test('confirmations persist across a reload (deploy must not un-confirm)', () => {
  const path = join(dir, 'latch.json');
  confirmDefectivePack(rec(), 1_000);
  _resetDefectivePackLatchForTests(path); // simulate restart
  const r = getConfirmedRecord(PACK_SN);
  assert.ok(r, 'record survives');
  assert.equal(r!.confirmedAtMs, 1_000);
});

test('a corrupt sidecar fails toward v1.101.0 behavior (empty, never throws)', () => {
  const path = join(dir, 'latch.json');
  writeFileSync(path, '{not json');
  _resetDefectivePackLatchForTests(path);
  assert.equal(getConfirmedRecord(PACK_SN), null);
  // and it recovers: a new confirm writes a fresh valid file
  confirmDefectivePack(rec(), 5_000);
  assert.ok(existsSync(path));
  assert.equal(JSON.parse(readFileSync(path, 'utf8'))[0].packSn, PACK_SN);
});

/** The chassis is online and reported a pack list — its silence IS evidence. */
const evaluable = (...sns: string[]) => ({ evaluableDeviceSns: new Set(sns) });
const CORE = rec().deviceSn;

test('retire: a pack absent past the horizon retires; a present one never does', () => {
  confirmDefectivePack(rec(), 1_000);
  markPackPresent(PACK_SN, 10_000, CORE);
  retireAbsentPacks({ nowMs: 10_000 + DEFECTIVE_PACK_ABSENT_RETIRE_MS - 1, ...evaluable(CORE) });
  assert.ok(getConfirmedRecord(PACK_SN), 'inside the horizon: kept');
  const retired = retireAbsentPacks({ nowMs: 10_000 + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 1, ...evaluable(CORE) });
  assert.equal(getConfirmedRecord(PACK_SN), null, 'past the horizon: retired');
  assert.deepEqual(retired.map((r) => r.packSn), [PACK_SN], 'the retired record is returned for logging');
});

test('★ THE DEFECT: an absent pack whose CHASSIS is dark is HELD, never retired', () => {
  // A Core powered down and boxed for RMA is exactly the Core that stays
  // cloud-dark for days — so the warranty diagnosis it was pulled for was what
  // got deleted. markPackPresent lives inside a loop gated on
  // `!d.online || !d.projection`, while retireAbsentPacks ran unconditionally:
  // one side of the decision was gated on evidence and the other was not.
  confirmDefectivePack(rec(), 1_000);
  markPackPresent(PACK_SN, 10_000, CORE);
  for (let t = 1; t <= 60; t++) {
    retireAbsentPacks({ nowMs: 10_000 + t * 60 * 60_000, ...evaluable() }); // chassis dark
  }
  assert.ok(
    getConfirmedRecord(PACK_SN),
    'the record must survive 60 h of chassis darkness — absence of evidence is not evidence of departure',
  );
});

test('★ a pack MOVED to another chassis is judged by where it was LAST SEEN', () => {
  // rec().deviceSn is frozen at first confirmation, and this plant's motivating
  // history is a pack that moved chassis (2026-08-20: the fault followed the
  // pack to another Core). Keying on rec.deviceSn would mean a pack confirmed
  // in Core A, moved to Core B, with Core A gone, could NEVER retire.
  confirmDefectivePack(rec(), 1_000);   // confirmed in CORE (== rec().deviceSn)
  const CORE_B = 'Y711ZABA9H3T9999';
  markPackPresent(PACK_SN, 10_000, CORE_B);   // then moved to CORE_B

  // While CORE_B keeps reporting it, the clock refreshes and it is kept.
  markPackPresent(PACK_SN, 10_000 + DEFECTIVE_PACK_ABSENT_RETIRE_MS, CORE_B);
  retireAbsentPacks({ nowMs: 10_000 + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 1, ...evaluable(CORE_B) });
  assert.ok(getConfirmedRecord(PACK_SN), 'still reported by its new chassis: kept');

  // Now the discriminating case. CORE_B is online and has stopped reporting the
  // pack; CORE (the ORIGINAL chassis, frozen in rec.deviceSn) is decommissioned
  // and absent from the evaluable set. Keying on rec.deviceSn would find an
  // unevaluable host and HOLD FOREVER — a guaranteed never-retire path. Keying
  // on the last-seen chassis correctly reads CORE_B's silence as evidence.
  retireAbsentPacks({ nowMs: 10_000 + 4 * DEFECTIVE_PACK_ABSENT_RETIRE_MS, ...evaluable(CORE_B) });
  assert.equal(
    getConfirmedRecord(PACK_SN), null,
    'the LAST SEEN chassis is evaluable and silent about the pack: retired',
  );
});

test('the absolute backstop retires a record whose chassis never returns', () => {
  // The realistic RMA ships the chassis WITH the pack, so the host SN may never
  // re-enter the evaluable set. Without this a record could never retire, and a
  // repaired pack returning under the same serial would re-attach a standing
  // annunciate:true warning that isNeverMutedAlert exempts from every mute path.
  confirmDefectivePack(rec(), 1_000);
  markPackPresent(PACK_SN, 10_000, CORE);
  retireAbsentPacks({ nowMs: 20_000, ...evaluable() });   // arms the frozen clock
  assert.ok(getConfirmedRecord(PACK_SN), 'held while inside the backstop');
  const retired = retireAbsentPacks({
    nowMs: 20_000 + DEFECTIVE_PACK_ABSOLUTE_RETIRE_MS + 1, ...evaluable(),
  });
  assert.equal(getConfirmedRecord(PACK_SN), null, 'past the absolute backstop: retired');
  assert.equal(retired.length, 1);
});

test('★ an evaluable chassis CLEARS the frozen clock — darkness must be CONTINUOUS', () => {
  // The clearing must happen on the evaluable branch of retireAbsentPacks itself.
  // Routing it through markPackPresent (which also clears) would leave the branch
  // untested — the chassis has to come back WITHOUT the pack being re-seen.
  const H = 60 * 60_000;
  confirmDefectivePack(rec(), 0);
  markPackPresent(PACK_SN, 0, CORE);                       // seen = 0
  retireAbsentPacks({ nowMs: 1 * H, ...evaluable() });      // dark: freeze armed at 1 h
  retireAbsentPacks({ nowMs: 2 * H, ...evaluable(CORE) });  // chassis back (pack NOT seen) -> freeze cleared
  retireAbsentPacks({ nowMs: 3 * H, ...evaluable() });      // dark again: freeze re-armed at 3 h

  // Just past the backstop measured from the FIRST arming. Cumulative reading
  // would retire here; continuous reading still has 2 h to run.
  retireAbsentPacks({ nowMs: 1 * H + DEFECTIVE_PACK_ABSOLUTE_RETIRE_MS + 1, ...evaluable() });
  assert.ok(
    getConfirmedRecord(PACK_SN),
    'the backstop measures CONTINUOUS unevaluability, not cumulative',
  );
});

test('★ retirement is LOGGED with its full evidence snapshot before the delete', () => {
  // A warranty diagnosis destroyed with no breadcrumb is why this had to be
  // settled by reading code rather than by looking at the system.
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    confirmDefectivePack(rec(), 1_000);
    markPackPresent(PACK_SN, 10_000, CORE);
    retireAbsentPacks({ nowMs: 10_000 + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 1, ...evaluable(CORE) });
  } finally {
    console.warn = orig;
  }
  const line = lines.find((l) => l.includes('RETIRING'));
  assert.ok(line, `expected a RETIRING warn line, got ${JSON.stringify(lines)}`);
  assert.ok(line!.includes(PACK_SN), 'the log must carry the pack serial');
  assert.ok(line!.includes('confirmedAtMs'), 'the log must carry the evidence snapshot, not just the id');
});

test('retire clock arms at first sighting after a restart, not at epoch', () => {
  const path = join(dir, 'latch.json');
  confirmDefectivePack(rec(), 1_000);
  _resetDefectivePackLatchForTests(path); // restart drops the in-memory presence clock
  const now = 100 * DEFECTIVE_PACK_ABSENT_RETIRE_MS;
  retireAbsentPacks({ nowMs: now, ...evaluable(CORE) });  // first pass ARMS the clock
  assert.ok(getConfirmedRecord(PACK_SN), 'must not retire on the arming pass');
  retireAbsentPacks({ nowMs: now + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 1, ...evaluable(CORE) });
  assert.equal(getConfirmedRecord(PACK_SN), null);
});

test('markPackPresent is a no-op for unconfirmed SNs (healthy fleet never accumulates)', () => {
  markPackPresent('Y712ZABA4H350028', 1_000, 'Y711ZABA9H3T0489');
  assert.equal(listConfirmedRecords().length, 0);
});

test('operator clear removes the record and reports whether one existed', () => {
  confirmDefectivePack(rec(), 1_000);
  assert.equal(clearConfirmedPack(PACK_SN), true);
  assert.equal(clearConfirmedPack(PACK_SN), false);
  assert.equal(getConfirmedRecord(PACK_SN), null);
});

// ── integration: the flap kill, end to end through computeAlerts ─────────────

const packFull = (num: number, soc: number, inW: number, cells: number[], packSn?: string) => ({
  num, soc, soh: 100, actSoh: 100, inputWatts: inW, outputWatts: 0, cycles: 100,
  temp: 30, maxCellTemp: 30, minCellTemp: 30,
  cellVoltagesMv: cells,
  maxVolDiffMv: Math.max(...cells) - Math.min(...cells),
  ...(packSn ? { packSn } : {}),
});
const ok = () => new Array(32).fill(3330);
const bad = () => { const c = new Array(32).fill(3125); c[30] = 3019; return c; };
const fleet = (packs: any[]): Record<string, DeviceSnapshot> => ({
  [DEV_SN]: {
    sn: DEV_SN, deviceName: 'Core 4', productName: 'DELTA Pro Ultra', online: true, lastSeenMs: Date.now(),
    projection: { kind: 'dpu', soc: 40, packs } as any,
  } as any,
});
/** Charging burst: siblings move real power — the live signature holds. */
const burstPacks = () => [
  packFull(1, 1, 0, bad(), PACK_SN),
  packFull(2, 48, 420, ok(), 'SIB2'), packFull(3, 49, 380, ok(), 'SIB3'),
  packFull(4, 45, 358, ok(), 'SIB4'), packFull(5, 49, 351, ok(), 'SIB5'),
];
/** Between bursts: same broken pack, but the bank is idle — leg 3 fails. */
const idlePacks = () => [
  packFull(1, 1, 0, bad(), PACK_SN),
  packFull(2, 48, 0, ok(), 'SIB2'), packFull(3, 49, 0, ok(), 'SIB3'),
  packFull(4, 45, 0, ok(), 'SIB4'), packFull(5, 49, 0, ok(), 'SIB5'),
];
const grid = { present: true, backstopping: true };
const find = (alerts: any[]) => alerts.find((x) => x.id === `pack-defective-${DEV_SN}-1`);

test('THE FLAP KILL: once confirmed during a burst, the alert HOLDS through the idle trough', () => {
  const a1 = find(computeAlerts(fleet(burstPacks()), undefined, grid));
  assert.ok(a1, 'fires during the burst (live signature)');
  const a2 = find(computeAlerts(fleet(idlePacks()), undefined, grid));
  assert.ok(a2, 'STILL PRESENT while the bank idles — this resolve/refire cycle is the 08-24 push storm');
  assert.notEqual(a2!.annunciate, false, 'the latched emission stays never-muted');
  assert.match(a2!.detail, /confirmed defective on \d{4}-\d{2}-\d{2}/);
  assert.match(a2!.detail, /latched/);
  assert.equal(a2!.sourcePackSn, PACK_SN, 'physical identity stays stamped');
});

test('no confirmation ever happened => idle bank emits nothing (v1.101.0 false-positive guard intact)', () => {
  const a = find(computeAlerts(fleet(idlePacks()), undefined, grid));
  assert.equal(a, undefined, 'an idle bank alone must never raise the diagnosis');
});

test('the latch follows the PACK, not the slot: no packSn => legs-only behavior', () => {
  // Same shapes but with no packSn reported: burst fires (legs), idle clears.
  const strip = (packs: any[]) => packs.map(({ packSn, ...rest }) => rest);
  assert.ok(find(computeAlerts(fleet(strip(burstPacks())), undefined, grid)), 'legs-only still fires');
  assert.equal(find(computeAlerts(fleet(strip(idlePacks())), undefined, grid)), undefined,
    'without a physical identity nothing may latch');
});

test('pack removed from the fleet => the alert clears (RMA exit path)', () => {
  find(computeAlerts(fleet(burstPacks()), undefined, grid)); // confirm
  const withoutPack1 = burstPacks().slice(1).map((p, i) => ({ ...p, num: i + 1 }));
  const a = find(computeAlerts(fleet(withoutPack1), undefined, grid));
  assert.equal(a, undefined, 'no emission once the pack is gone');
  assert.ok(getConfirmedRecord(PACK_SN), 'but the record retires on the 48 h clock, not instantly');
});

test('operator clear silences the latched emission immediately', () => {
  find(computeAlerts(fleet(burstPacks()), undefined, grid)); // confirm
  clearConfirmedPack(PACK_SN);
  assert.equal(find(computeAlerts(fleet(idlePacks()), undefined, grid)), undefined);
});
