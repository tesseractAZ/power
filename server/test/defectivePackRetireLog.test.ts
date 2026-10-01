/**
 * v1.187.1 — an automatic retirement of a confirmed-defective pack is logged through the structured
 * logger, with the record's identity in words (general-3).
 *
 * 2026-09-29 ~23:05: the latch retired Core 4 pack 1's record (the RMA'd pack had left the Core).
 * The only trace was a bare console.warn line — no time, no level, not JSON — so a JSON-line parser
 * or a level >= 40 triage could not see that a warranty diagnosis had been deleted, and its time
 * could only be inferred from the neighbouring lines. The latch now logs through a sink the alert
 * monitor wires to its warn logger (app.log.warn: pino, timestamped, level 40); unwired it falls
 * back to console.warn. The monitor's wiring is pinned in v1187_1gWiring.test.ts.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmDefectivePack, markPackPresent, getConfirmedRecord, retireAbsentPacks, _resetDefectivePackLatchForTests,
  setDefectivePackRetireLog, defectivePackRetiredLine, DEFECTIVE_PACK_ABSENT_RETIRE_MS, DEFECTIVE_PACK_ABSOLUTE_RETIRE_MS,
  isoOrRaw,
} from '../src/defectivePackLatch.js';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const PACK = 'PACKXXX00XXX0037';
const CORE = 'COREXXX00XXX0004';
const CONFIRMED = Date.UTC(2026, 7, 24, 16, 1, 42);
const rec = () => ({
  packSn: PACK, deviceSn: CORE, deviceName: 'Core 4', packNum: 1,
  socPct: 1, siblingMedianSocPct: 86, packAbsW: 1, siblingMedianAbsW: 350, deviantCell: 31, deltaMv: -115,
});

let lines: string[] = [];
let consoleLines: string[] = [];
const origWarn = console.warn;
beforeEach(() => {
  _resetDefectivePackLatchForTests(join(mkdtempSync(join(tmpdir(), 'dp-retire-log-')), 'latch.json'));
  lines = [];
  consoleLines = [];
  console.warn = (...a: unknown[]) => { consoleLines.push(a.map(String).join(' ')); };
  setDefectivePackRetireLog((m) => lines.push(m));
});
afterEach(() => {
  console.warn = origWarn;
  setDefectivePackRetireLog((m) => console.warn(m));
});

test('★★★ the retirement goes to the wired sink (the structured log), not to a bare console.warn', () => {
  confirmDefectivePack(rec(), CONFIRMED);
  markPackPresent(PACK, CONFIRMED + 1_000, CORE);
  retireAbsentPacks({ nowMs: CONFIRMED + 1_000 + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 1, evaluableDeviceSns: new Set([CORE]) });
  assert.equal(getConfirmedRecord(PACK), null, 'retired');
  assert.equal(lines.length, 1);
  assert.equal(consoleLines.length, 0, 'nothing on bare stderr');
  assert.equal(lines[0], defectivePackRetiredLine({ ...rec(), confirmedAtMs: CONFIRMED }, true));
});

test('★★★ the line names the record in words — pack serial, Core and slot, chassis, confirmation date — then the evidence', () => {
  const line = defectivePackRetiredLine({ ...rec(), confirmedAtMs: CONFIRMED }, true);
  assert.ok(line.startsWith(`defective-pack: RETIRING the confirmed-defective record for pack ${PACK} (Core 4 pack 1, chassis ${CORE}, confirmed 2026-08-24T16:01:42.000Z) — `), line);
  assert.ok(line.includes(`absent for over ${DEFECTIVE_PACK_ABSENT_RETIRE_MS / 3_600_000} h from the pack list of a chassis that was online and reporting.`), line);
  assert.ok(line.endsWith(`Evidence at confirmation: ${JSON.stringify({ ...rec(), confirmedAtMs: CONFIRMED })}`), line);
  assert.equal(DEFECTIVE_PACK_ABSENT_RETIRE_MS / 3_600_000, 48);
});

test('★★ the backstop retirement says it was the backstop', () => {
  confirmDefectivePack(rec(), CONFIRMED);
  markPackPresent(PACK, CONFIRMED + 1_000, CORE);
  const none = new Set<string>();
  // The chassis goes dark: the absence clock is held, the backstop clock runs.
  retireAbsentPacks({ nowMs: CONFIRMED + 2_000, evaluableDeviceSns: none });
  const pastBackstop = CONFIRMED + 2_000 + DEFECTIVE_PACK_ABSOLUTE_RETIRE_MS + 1;
  retireAbsentPacks({ nowMs: pastBackstop, evaluableDeviceSns: none });
  retireAbsentPacks({ nowMs: pastBackstop + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 1, evaluableDeviceSns: none });
  assert.equal(getConfirmedRecord(PACK), null);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`its chassis has not been evaluable for over ${DEFECTIVE_PACK_ABSOLUTE_RETIRE_MS / 86_400_000} days (the backstop).`), lines[0]);
  assert.ok(!lines[0].includes('online and reporting'));
});

test('★ unwired (a test, a tool), the line still reaches console.warn', () => {
  setDefectivePackRetireLog((m) => console.warn(m));
  confirmDefectivePack(rec(), CONFIRMED);
  markPackPresent(PACK, CONFIRMED + 1_000, CORE);
  retireAbsentPacks({ nowMs: CONFIRMED + 1_000 + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 1, evaluableDeviceSns: new Set([CORE]) });
  assert.equal(consoleLines.length, 1);
  assert.ok(consoleLines[0].includes(`RETIRING the confirmed-defective record for pack ${PACK}`));
});

/* ══ (review) a corrupt confirmation time cannot stop the tick ══════════════ */

/** A latch file holding one record whose confirmedAtMs is out of Date's range (a corrupt or
 *  hand-edited file: ensureLoaded checks only that it is a number). */
function corruptLatch(confirmedAtMs: number): void {
  const path = join(mkdtempSync(join(tmpdir(), 'dp-retire-corrupt-')), 'latch.json');
  writeFileSync(path, JSON.stringify([{ ...rec(), confirmedAtMs }]));
  _resetDefectivePackLatchForTests(path);
}

test('★★ isoOrRaw: an ISO time, or the number itself when Date cannot render it', () => {
  assert.equal(isoOrRaw(CONFIRMED), '2026-08-24T16:01:42.000Z');
  assert.equal(isoOrRaw(1e20), '100000000000000000000');
  assert.equal(isoOrRaw(Infinity), 'Infinity');
  assert.equal(isoOrRaw(-1e20), '-100000000000000000000');
});

test('★★★ a corrupt confirmedAtMs (1e20) is retired and logged — no RangeError escapes into the tick', () => {
  corruptLatch(1e20);
  markPackPresent(PACK, CONFIRMED, CORE);
  assert.doesNotThrow(() => retireAbsentPacks({ nowMs: CONFIRMED + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 1, evaluableDeviceSns: new Set([CORE]) }));
  assert.equal(getConfirmedRecord(PACK), null, 'deleted, so the next tick does not meet it again');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`for pack ${PACK} (Core 4 pack 1, chassis ${CORE}, confirmed 100000000000000000000) — `), lines[0]);
});

test('★★★ a sink that throws does not block the delete or the tick: the record falls back to console.warn', () => {
  setDefectivePackRetireLog(() => { throw new Error('sink down (test)'); });
  confirmDefectivePack(rec(), CONFIRMED);
  markPackPresent(PACK, CONFIRMED + 1_000, CORE);
  assert.doesNotThrow(() => retireAbsentPacks({ nowMs: CONFIRMED + 1_000 + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 1, evaluableDeviceSns: new Set([CORE]) }));
  assert.equal(getConfirmedRecord(PACK), null, 'deleted');
  assert.equal(consoleLines.length, 1);
  assert.equal(consoleLines[0], `defective-pack: RETIRING confirmed record ${JSON.stringify({ ...rec(), confirmedAtMs: CONFIRMED })}`);
});

test('★★★ the quiescent pack-defective alert with a corrupt confirmedAtMs: computeAlerts does not throw, the alert stands', () => {
  corruptLatch(1e20);
  const cells = (v: number) => new Array(32).fill(v);
  const pack = (num: number, soc: number, packSn: string) => ({
    num, soc, soh: 100, actSoh: 100, inputWatts: 0, outputWatts: 0, cycles: 100, temp: 30, maxCellTemp: 30, minCellTemp: 30,
    cellVoltagesMv: cells(3330), maxVolDiffMv: 0, packSn,
  });
  const devices = {
    [CORE]: {
      sn: CORE, deviceName: 'Core 4', productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
      projection: { kind: 'dpu', soc: 50, packs: [pack(1, 48, PACK), pack(2, 49, 'PACKXXX00XXX0002'), pack(3, 47, 'PACKXXX00XXX0003')] },
    },
  } as unknown as Record<string, DeviceSnapshot>;
  let alerts: ReturnType<typeof computeAlerts> = [];
  assert.doesNotThrow(() => { alerts = computeAlerts(devices, undefined, { present: true, backstopping: true } as never); });
  const a = alerts.find((x) => x.id === `pack-defective-${CORE}-1`);
  assert.ok(a, 'the latched diagnosis still stands');
  assert.match(a!.detail, /was confirmed defective on 9999999999: /, a!.detail);
});
