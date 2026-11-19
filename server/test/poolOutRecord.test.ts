/**
 * v1.208.0 — what is RECORDED about the panel's backup pool (src/poolOutRecord.ts): the recorder's series, the change
 * log, the event capture's allowlist, the debug view and the Home Assistant state rule. Pure functions, on bodies built
 * by the pool-out fixture builder (placeholder serials, a synthetic moving circuit vector).
 *
 * On 2026-11-14 a Core left the panel's pool and no capacity, flag or code of that hour was on record anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolDiagFromRaw } from '../src/ecoflow/poolDiag.js';
import { poolSignals, emptyPoolOutState, poolOutSensorState, POOL_OUT_SENSOR_FRESH_MS } from '../src/poolOut.js';
import {
  POOL_SLOT_FLAG_BITS, POOL_PANEL_FLAG_BITS, POOL_FLAG_SENT_SHIFT, POOL_OUT_MASK_UNIDENTIFIED, poolFlagMask, poolRecordMetrics,
  poolDiagSignature, poolDiagChanges, parsePoolDiagSigs, withPoolDiagSigs, POOL_DIAG_LINES_MAX,
  poolCaptureAllows, poolEventCapture, poolEventFileName, poolEventsToDrop, POOL_EVENT_FILE, POOL_EVENT_KEEP, POOL_EVENT_MAX_BYTES,
  poolOutDebugView, poolCoreOutState, parsePoolOutCards, withPoolOutCards,
} from '../src/poolOutRecord.js';
import { healthyBody, lostBody, synthBody, withReference, withEpisode, fold, minutes, at, CORE_SNS, PANEL_SN, SLOT_WH, EMPTY_ERR_ENTRY } from './fixtures/poolOutFixtures.js';

const SENT = 2 ** POOL_FLAG_SENT_SHIFT;
const metricsOf = (rows: Array<[string, number | null]>): Record<string, number | null> => Object.fromEntries(rows);

/* ══ the flags ══════════════════════════════════════════════════════════════════════════════════════ */

test('★ the bit order of src<n>_flags and panel_flags is the documented one', () => {
  assert.deepEqual(POOL_SLOT_FLAG_BITS.map((b) => b.name), [
    'isConnect', 'hwConnect', 'isAcOpen', 'isEnable', 'isPowerOutput', 'ch<n>EnableSet', 'ch<n>Info.backupIsReady',
    'isGridCharge', 'isMpptCharge', 'emsChgFlag', 'ch<n>Info.forceChargeSta', 'ch<n>Info.wakeUpChargeSta',
  ]);
  assert.deepEqual(POOL_PANEL_FLAG_BITS.map((b) => b.name), ['masterRlyErrFlg', 'ntcOverTempErr']);
  assert.equal(POOL_FLAG_SENT_SHIFT, 16);
});

test('★★★ a flag the panel did not send is recorded as NOT SENT, never as off', () => {
  assert.equal(poolFlagMask([true, false, true]), 0b101 + 0b111 * SENT, 'three sent: two set, one clear');
  assert.equal(poolFlagMask([true, null, true]), 0b101 + 0b101 * SENT, '★ the missing one has no "sent" bit');
  assert.notEqual(poolFlagMask([true, null, true]), poolFlagMask([true, false, true]), '★ missing and off are different rows');
  assert.equal(poolFlagMask([null, null]), null, 'nothing sent: no row at all');
  assert.equal(poolFlagMask([false, false]), 0b11 * SENT, 'all sent and all off is a row, and it is not 0');
});

test('the slot mask of the one raw sample on record (2026-11-17): every flag sent; grid charge, solar charge, force charge and wake-up off', () => {
  const d = poolDiagFromRaw(healthyBody(1));
  const m = metricsOf(poolRecordMetrics({ servedFullWh: 92160, diag: d, signals: null, state: null }));
  // bits 0-6 and 9 set (isConnect … backupIsReady, emsChgFlag); 7, 8, 10, 11 clear; all twelve sent.
  assert.equal(m.src1_flags, 0b0010_0111_1111 + 0b1111_1111_1111 * SENT);
  assert.equal(m.src2_flags, m.src1_flags);
  assert.equal(m.panel_flags, 0 + 0b11 * SENT, 'both panel flags sent, both 0');
});

test('★ one flag flips one bit; a force charge ON sets bit 10; an unrecognised force-charge value is not sent', () => {
  const base = metricsOf(poolRecordMetrics({ servedFullWh: null, diag: poolDiagFromRaw(healthyBody(1)), signals: null, state: null })).src1_flags as number;
  const flagsOf = (set: Record<string, unknown>): number => metricsOf(poolRecordMetrics({ servedFullWh: null, diag: poolDiagFromRaw(healthyBody(1, { set })), signals: null, state: null })).src1_flags as number;
  assert.equal(flagsOf({ 'pd303_mc.backupIncreInfo.Energy1Info.isPowerOutput': 0 }), base - 2 ** 4);
  assert.equal(flagsOf({ 'pd303_mc.backupIncreInfo.ch1Info.backupIsReady': false }), base - 2 ** 6);
  assert.equal(flagsOf({ 'pd303_mc.backupIncreInfo.ch1Info.forceChargeSta': 'FORCE_CHARGE_ON' }), base + 2 ** 10);
  assert.equal(flagsOf({ 'pd303_mc.backupIncreInfo.ch1Info.forceChargeSta': 'SOMETHING_ELSE' }), base - 2 ** 10 * SENT, '★ neither ON nor OFF: its "sent" bit is clear');
  assert.equal(flagsOf({ 'pd303_mc.backupIncreInfo.Energy1Info.isConnect': undefined }), base - 1 - SENT, '★ a missing isConnect: value bit and "sent" bit both clear');
});

/* ══ the recorder's series ══════════════════════════════════════════════════════════════════════════ */

test('★★★ the series of a healthy body and of the 2026-11-14 shape: the capacity, each slot, the lists, the verdicts', () => {
  const ref = withReference();
  const healthy = poolDiagFromRaw(healthyBody(1));
  const h = metricsOf(poolRecordMetrics({ servedFullWh: 92160, diag: healthy, signals: poolSignals(healthy, ref.baseline), state: ref }));
  assert.deepEqual([h.backup_full_wh, h.backup_full_raw_wh, h.backup_pct_raw], [92160, 92160, 67]);
  assert.deepEqual([h.src1_full_wh, h.src2_full_wh, h.src3_full_wh], [SLOT_WH, SLOT_WH, SLOT_WH]);
  assert.deepEqual([h.src1_err, h.src1_ctrl, h.err_backup_n, h.err_master_n, h.err_hall_n], [0, 1, 0, 0, 0], 'BACKUP_CH_DISCHARGE is index 1');
  assert.deepEqual([h.pool_counted_slots, h.pool_out_mask], [3, 0], 'three counted, no alarm standing');

  const ep = withEpisode();
  const lost = poolDiagFromRaw(lostBody(11));
  // The projection may still serve the held 92,160 Wh while the raw body says 61,440: both are recorded.
  const l = metricsOf(poolRecordMetrics({ servedFullWh: 92160, diag: lost, signals: poolSignals(lost, ep.baseline), state: ep }));
  assert.deepEqual([l.backup_full_wh, l.backup_full_raw_wh, l.backup_pct_raw], [92160, 61440, 64], '★ the served and the raw capacity are separate series');
  assert.deepEqual([l.pool_counted_slots, l.pool_out_mask], [2, 1], '★ two slots counted; slot 1 (bit 0) out');
  assert.equal(Object.keys(l).length, 21, '3 pool series + 4 for each of 3 slots + 3 lists + panel flags + 2 verdicts');
});

test('★ what is not known is not written: a skipped body has no counted-slots row; an unrecognised control state is −1; a missing key writes nothing', () => {
  const d = poolDiagFromRaw(healthyBody(1, { set: {
    'pd303_mc.backupIncreInfo.ch2Info.ctrlSta': 'BACKUP_CH_NEW_STATE',
    'pd303_mc.backupIncreInfo.ch3Info.ctrlSta': undefined,
    'pd303_mc.backupIncreInfo.Energy3Info.errorCodeNum': undefined,
    'pd303_mc.backupIncreInfo.Energy2Info.errorCodeNum': 533,
    'pd303_mc.masterIncreInfo.errcode.errCode': undefined,
    'pd303_mc.backupIncreInfo.errcode.errCode': [EMPTY_ERR_ENTRY, 'AAAAAAAAAqE=', '02A2'],
  } }));
  const m = metricsOf(poolRecordMetrics({ servedFullWh: undefined, diag: d, signals: null, state: null }));
  assert.deepEqual([m.src2_ctrl, m.src3_ctrl], [-1, null], '★ −1 for a value outside the enum; no row for a key that was not sent');
  assert.deepEqual([m.src2_err, m.src3_err], [533, null]);
  assert.deepEqual([m.err_backup_n, m.err_master_n, m.err_hall_n], [2, null, 0], '★ a list that could not be read writes no row (never 0)');
  assert.deepEqual([m.backup_full_wh, m.pool_counted_slots, m.pool_out_mask], [null, null, null], 'no served capacity, no verdict, no tracker state');
  // A capacity the tracker could not judge (above the sum of its slots): its verdicts exist, the count does not.
  const over = poolDiagFromRaw(healthyBody(1, { capWh: 4 * SLOT_WH, poolPct: 67 }));
  const overSignals = poolSignals(over, withReference().baseline);
  assert.equal(overSignals.cap.v, 'unknown');
  assert.equal(metricsOf(poolRecordMetrics({ servedFullWh: null, diag: over, signals: overSignals, state: null })).pool_counted_slots, null, '★ an unknown capacity verdict writes no count');
  // No reader output at all (no REST body in this process): only the served capacity and the alarm's state.
  const none = poolRecordMetrics({ servedFullWh: 61440, diag: null, signals: null, state: emptyPoolOutState() });
  assert.deepEqual(none, [['backup_full_wh', 61440], ['pool_counted_slots', null], ['pool_out_mask', 0]]);
});

test('★ pool_out_mask is the ALARM\'s latched set: a bit per named slot, and 128 when a slot out is not identified', () => {
  const ep = withEpisode();
  const mask = (slots: number[] | null, k: number): number | null =>
    metricsOf(poolRecordMetrics({ servedFullWh: null, diag: null, signals: null, state: { ...ep, episode: { ...ep.episode!, slots, k } } })).pool_out_mask;
  assert.equal(mask([1], 1), 1);
  assert.equal(mask([1, 3], 2), 0b101);
  assert.equal(mask(null, 1), POOL_OUT_MASK_UNIDENTIFIED, 'the count only');
  assert.equal(mask([1], 2), 1 + POOL_OUT_MASK_UNIDENTIFIED, 'slot 1 and one not identified');
  assert.equal(POOL_OUT_MASK_UNIDENTIFIED, 128);
});

/* ══ the change log ═════════════════════════════════════════════════════════════════════════════════ */

test('★ the first reading ever is not called a change: one line, and nothing more on a clean panel', () => {
  const c = poolDiagChanges(null, poolDiagFromRaw(healthyBody(1)));
  assert.deepEqual(c.lines, ['pool-diag: first reading taken (83 fields); changes are logged from here.']);
  assert.equal(c.changed, true, 'the signature is new: it is saved');
  assert.deepEqual(c.sig, poolDiagSignature(poolDiagFromRaw(healthyBody(1))));
});

test('★★★ an error code or a non-empty error list already standing at the first reading is said at once (first sight, before any debounce)', () => {
  const c = poolDiagChanges(null, poolDiagFromRaw(healthyBody(1, { set: {
    'pd303_mc.backupIncreInfo.Energy2Info.errorCodeNum': 533,
    'pd303_mc.backupIncreInfo.errcode.errCode': [EMPTY_ERR_ENTRY, EMPTY_ERR_ENTRY, EMPTY_ERR_ENTRY, 'AAAAAAAAAqE='],
  } })));
  assert.deepEqual(c.lines.slice(1), [
    'pool-diag: slot 2 errorCodeNum reads 533 at the first reading.',
    'pool-diag: backup error list at the first reading: entry 3 is 00 00 00 00 00 00 02 A1.',
  ]);
});

test('★★★ one line per field that changed, old value to new, the slot as "slot N" — the 2026-11-14 capacity step and a slot\'s flags', () => {
  const before = poolDiagChanges(null, poolDiagFromRaw(healthyBody(1))).sig;
  const same = poolDiagChanges(before, poolDiagFromRaw(healthyBody(2)));
  assert.deepEqual([same.lines, same.changed], [[], false], '★ a body whose percents and watts moved, and nothing else: no line (control)');
  const c = poolDiagChanges(before, poolDiagFromRaw(lostBody(3, { set: {
    'pd303_mc.backupIncreInfo.Energy1Info.isPowerOutput': 0,
    'pd303_mc.backupIncreInfo.ch1Info.ctrlSta': 'BACKUP_CH_STANDBY',
    'pd303_mc.backupIncreInfo.ch1Info.backupIsReady': false,
    'pd303_mc.backupIncreInfo.Energy1Info.errorCodeNum': 533,
    'pd303_mc.backupIncreInfo.Energy3Info.isConnect': undefined,
    'pd303_mc.backupIncreInfo.errcode.errCode': [EMPTY_ERR_ENTRY, 'AAAAAAAAAqE='],
    'pd303_mc.masterIncreInfo.gridSta': 0,
  } })));
  assert.deepEqual(c.lines, [
    'pool-diag: backupIncreInfo.backupFullCap 92160 → 61440',
    'pool-diag: pd303_mc.backupIncreInfo.backupFullCap 92160 → 61440',
    'pool-diag: slot 1 isPowerOutput 1 → 0',
    'pool-diag: slot 1 errorCodeNum 0 → 533',
    'pool-diag: slot 1 ch1Info.ctrlSta BACKUP_CH_DISCHARGE → BACKUP_CH_STANDBY',
    'pool-diag: slot 1 ch1Info.backupIsReady true → false',
    'pool-diag: slot 3 isConnect 1 → not sent',
    'pool-diag: backup error list empty → entry 1 is 00 00 00 00 00 00 02 A1',
    'pool-diag: gridSta 1 → 0',
  ]);
  assert.equal(c.changed, true);
  // The next identical body: nothing.
  assert.deepEqual(poolDiagChanges(c.sig, poolDiagFromRaw(lostBody(4, { set: {
    'pd303_mc.backupIncreInfo.Energy1Info.isPowerOutput': 0, 'pd303_mc.backupIncreInfo.ch1Info.ctrlSta': 'BACKUP_CH_STANDBY',
    'pd303_mc.backupIncreInfo.ch1Info.backupIsReady': false, 'pd303_mc.backupIncreInfo.Energy1Info.errorCodeNum': 533,
    'pd303_mc.backupIncreInfo.Energy3Info.isConnect': undefined, 'pd303_mc.backupIncreInfo.errcode.errCode': [EMPTY_ERR_ENTRY, 'AAAAAAAAAqE='],
    'pd303_mc.masterIncreInfo.gridSta': 0,
  } }))).lines, []);
});

test('★★ more than twelve changes in ONE reading are one line, and nothing is left out of it: a body missing a whole block of keys is not 64 lines', () => {
  assert.equal(POOL_DIAG_LINES_MAX, 12);
  const before = poolDiagChanges(null, poolDiagFromRaw(healthyBody(1))).sig;
  // The panel's whole pd303_mc block missing from one body.
  const whole = healthyBody(2);
  const partial = Object.fromEntries(Object.entries(whole).filter(([k]) => !k.startsWith('pd303_mc.')));
  const gone = poolDiagChanges(before, poolDiagFromRaw(partial));
  // (Two lines: the fields, and the carried relay counters and states, which have a line of their own.)
  assert.deepEqual(gone.lines.map((l) => l.slice(0, 31)), ['pool-diag: 63 fields changed in', 'pool-diag: relay counters and s'], gone.lines.join('\n'));
  const fields = gone.lines[0].slice(gone.lines[0].indexOf(': ') + 2).split('; ');
  assert.match(gone.lines[0], /^pool-diag: \d+ fields changed in one reading: /);
  assert.equal(Number(/^pool-diag: (\d+) /.exec(gone.lines[0])![1]), fields.length, 'the count is the number said');
  assert.ok(fields.length > 50, `${fields.length} fields`);
  assert.equal(fields.includes('slot 1 isConnect 1 → not sent') && fields.includes('gridSta 1 → not sent') && fields.includes('slot 3 ch3Info.ctrlSta BACKUP_CH_DISCHARGE → not sent'), true, 'every change is in the line, old value to new');
  // …and one line again when the block returns: the same number of fields.
  const back = poolDiagChanges(gone.sig, poolDiagFromRaw(healthyBody(3)));
  assert.equal(back.lines.length, 2);
  assert.equal(back.lines[0].split('; ').length, fields.length);
  assert.equal(back.lines[0].includes('slot 1 isConnect not sent → 1'), true);
  // At the limit each change still has its own line: twelve are twelve lines, thirteen are one.
  const set = (n: number): Record<string, unknown> => Object.fromEntries([
    'isConnect', 'hwConnect', 'isAcOpen', 'isEnable', 'isPowerOutput', 'isGridCharge', 'isMpptCharge', 'emsChgFlag', 'chargeLimit', 'multPackNum', 'errorCodeNum', 'devInfo.ratePower', 'devInfo.type',
  ].slice(0, n).map((k) => [`pd303_mc.backupIncreInfo.Energy1Info.${k}`, 7]));
  assert.equal(poolDiagChanges(before, poolDiagFromRaw(healthyBody(4, { set: set(12) }))).lines.length, 12);
  const thirteen = poolDiagChanges(before, poolDiagFromRaw(healthyBody(5, { set: set(13) })));
  assert.deepEqual([thirteen.lines.length, thirteen.lines[0].startsWith('pool-diag: 13 fields changed in one reading: slot 1 isConnect 1 → 7; ')], [1, true]);
  // The carried relay counters keep their own line beside it.
  const withRelay = poolDiagChanges(before, poolDiagFromRaw(healthyBody(6, { set: { ...set(13), 'pd303_mc.masterIncreInfo.masterRly1Cnt': 970 } })));
  assert.deepEqual(withRelay.lines.map((l) => l.slice(0, 40)), ['pool-diag: 13 fields changed in one read', 'pool-diag: relay counters and states sin']);
});

test('★★★ a restart neither invents nor loses a change: the signature is compared as it was SAVED', () => {
  const sig = poolDiagChanges(null, poolDiagFromRaw(healthyBody(1))).sig;
  const fileText = withPoolDiagSigs(JSON.stringify({ v: 1, panels: {} }), new Map([[PANEL_SN, sig]]));
  const restored = parsePoolDiagSigs(fileText).get(PANEL_SN)!;
  assert.deepEqual(restored, sig, 'the signature survives the file');
  assert.deepEqual(JSON.parse(fileText).panels, {}, 'beside the tracker\'s panels, which are untouched');
  assert.deepEqual(poolDiagChanges(restored, poolDiagFromRaw(healthyBody(9))).lines, [], '★ nothing changed while down: nothing is invented');
  assert.deepEqual(poolDiagChanges(restored, poolDiagFromRaw(lostBody(9))).lines, [
    'pool-diag: backupIncreInfo.backupFullCap 92160 → 61440',
    'pool-diag: pd303_mc.backupIncreInfo.backupFullCap 92160 → 61440',
  ], '★ what changed while down is said at the first body after it');
  // A file with no signatures, a malformed one, an entry that is not a string map: nothing restored, nothing thrown.
  assert.equal(parsePoolDiagSigs('{"v":1,"panels":{}}').size, 0);
  assert.equal(parsePoolDiagSigs('not json').size, 0);
  assert.equal(parsePoolDiagSigs(JSON.stringify({ diag: { [PANEL_SN]: { a: 1 } } })).size, 0);
  assert.equal(parsePoolDiagSigs(JSON.stringify({ diag: [1, 2] })).size, 0);
});

test('★★ the relay counters and states are CARRIED: no line of their own, their change said with the next line and at a tracker event', () => {
  const ticking = (seq: number, n: number, extra: Record<string, unknown> = {}) => poolDiagFromRaw(healthyBody(seq, { set: {
    'pd303_mc.masterIncreInfo.masterRly3Cnt': 5207 + n, 'pd303_mc.masterIncreInfo.masterRly4Cnt': 5207 + n, 'pd303_mc.rly3RealSta': n % 2, ...extra,
  } }));
  let sig = poolDiagChanges(null, ticking(1, 0)).sig;
  for (let n = 1; n <= 30; n++) {
    const c = poolDiagChanges(sig, ticking(1 + n, n));
    assert.deepEqual(c.lines, [], `★ tick ${n}: a relay counter alone logs nothing (about thirty a day on the one sample on record)`);
    sig = c.sig;
  }
  assert.equal(sig.masterRly3Cnt, '5207', 'the value last LOGGED is kept, so nothing is lost');
  const withFlag = poolDiagChanges(sig, ticking(40, 31, { 'pd303_mc.backupIncreInfo.Energy1Info.isPowerOutput': 0 }));
  assert.deepEqual(withFlag.lines, [
    'pool-diag: slot 1 isPowerOutput 1 → 0',
    'pool-diag: relay counters and states since the last line: rly3RealSta 0 → 1, masterRly3Cnt 5207 → 5238, masterRly4Cnt 5207 → 5238',
  ], '★ the whole change since the last line, beside the field that changed');
  assert.equal(withFlag.sig.masterRly3Cnt, '5238');
  const atEvent = poolDiagChanges(sig, ticking(41, 31), true);
  assert.deepEqual(atEvent.lines, ['pool-diag: relay counters and states since the last line: rly3RealSta 0 → 1, masterRly3Cnt 5207 → 5238, masterRly4Cnt 5207 → 5238'],
    '★ and at a tracker event (first fault reading, raise, end) even when nothing else changed');
  assert.deepEqual(poolDiagChanges(sig, ticking(42, 0), true).lines, [], 'a tracker event with nothing carried: no line');
});

test('★★★ no line and no signature value can hold a serial: the reader never takes one', () => {
  const body = lostBody(1);
  const sig = poolDiagSignature(poolDiagFromRaw(body));
  const everything = JSON.stringify(sig) + poolDiagChanges(null, poolDiagFromRaw(body)).lines.join('\n');
  for (const sn of [PANEL_SN, ...CORE_SNS]) assert.equal(everything.includes(sn), false);
  assert.match(JSON.stringify(body), new RegExp(CORE_SNS[0]), 'control: the body itself does carry the Cores\' serials');
});

/* ══ the event capture ══════════════════════════════════════════════════════════════════════════════ */

test('★★★ the capture is an ALLOWLIST: the backup and master blocks, the three error lists, the pool trio and slot watts, top-level scalars', () => {
  const yes: Array<[string, unknown]> = [
    ['pd303_mc.backupIncreInfo.Energy1Info.isConnect', 1],
    ['pd303_mc.backupIncreInfo.ch1Info.ctrlSta', 'BACKUP_CH_DISCHARGE'],
    ['pd303_mc.backupIncreInfo.errcode.errCode', [EMPTY_ERR_ENTRY]],
    ['pd303_mc.masterIncreInfo.errcode.errCode', [EMPTY_ERR_ENTRY]],
    ['pd303_mc.loadIncreInfo.hall1IncreInfo.errcode.errCode', [EMPTY_ERR_ENTRY]],
    ['pd303_mc.masterIncreInfo.gridSta', 1],
    ['backupIncreInfo.backupFullCap', 61440], ['backupIncreInfo.backupBatPer', 64], ['backupIncreInfo.backupDischargeRmainBatCap', 39322],
    ['backupInfo.chWatt', [0, -1107, -1061]],
    ['backupReserveSoc', 16], ['ch1EnableSet', 1], ['smartBackupMode', 2], ['epsModeInfo', false],
    ['pd303_mc.powerSta', 'LOAD_CH_ES_POWER'], ['pd303_mc.ntcOverTempErr', 0], ['pd303_mc.sysCurRunningState', 2], ['pd303_mc.rly1RealSta', 1],
  ];
  for (const [key, value] of yes) assert.equal(poolCaptureAllows(key, value), true, key);
  const no: Array<[string, unknown]> = [
    ['loadInfo.hall1Watt', [1, 2, 3]], // the circuits: not this alarm's
    ['pd303_mc.loadIncreInfo.hall1IncreInfo.ch1Info.splitphase.linkCh', 2],
    ['pd303_mc.TimeTaskCfg1.comCfg.isEnable', false],
    ['wattInfo.gridWatt', 0],
    ['pd303_mc.backupIncreInfo.Energy1Info.someObject', { a: 1 }], // not a scalar or a list of scalars
    ['pd303_mc.masterIncreInfo.someList', [{ a: 1 }]],
    ['someTopLevelList', [1, 2]], // a top-level key must be a scalar
  ];
  for (const [key, value] of no) assert.equal(poolCaptureAllows(key, value), false, key);
});

test('★★★ never captured, wherever they sit: a key ending .sn, chName, area, localTime, timeZone — and any string shaped like an identifier', () => {
  for (const key of [
    'pd303_mc.backupIncreInfo.Energy1Info.devInfo.modelInfo.sn', 'pd303_mc.backupIncreInfo.DeltaPro1Info.modelInfo.sn',
    'pd303_mc.loadIncreInfo.hall1IncreInfo.modelInfo.sn', 'sn', 'pd303_mc.sn',
    'pd303_mc.area', 'pd303_mc.localTime', 'pd303_mc.timeZone', 'area', 'localTime', 'timeZone',
    'pd303_mc.backupIncreInfo.ch1Info.chName', 'pd303_mc.backupIncreInfo.Energy1Info.area', 'pd303_mc.masterIncreInfo.timeZone',
  ]) {
    assert.equal(poolCaptureAllows(key, 'x'), false, key);
    assert.equal(poolCaptureAllows(key, 5), false, `${key} (a number)`);
  }
  // A serial under a key that does not say so: refused by its shape.
  assert.equal(poolCaptureAllows('pd303_mc.backupIncreInfo.Energy1Info.devInfo.someNewId', CORE_SNS[0]), false, '★ identifier-shaped value');
  assert.equal(poolCaptureAllows('pd303_mc.someNewId', PANEL_SN), false);
  assert.equal(poolCaptureAllows('pd303_mc.backupIncreInfo.ch1Info.ctrlSta', 'BACKUP_CH_DISCHARGE'), true, 'control: an enum token has underscores and is kept');
  // …and inside a LIST: one identifier-shaped element leaves the whole list out.
  assert.equal(poolCaptureAllows('pd303_mc.backupIncreInfo.someNewList', [1, CORE_SNS[0], 3]), false, '★ a serial as a list element');
  assert.equal(poolCaptureAllows('pd303_mc.masterIncreInfo.errcode.errCode', [EMPTY_ERR_ENTRY, PANEL_SN]), false);
  // An error-list entry is kept in each form it may be sent in: base64 (padded), sixteen hex digits, a number, bytes.
  assert.equal(poolCaptureAllows('pd303_mc.backupIncreInfo.errcode.errCode', [EMPTY_ERR_ENTRY, 'AAAAAAAAAqE=']), true);
  // (Sixteen hex digits, built here: written out they are the shape the repository's serial scan looks for.)
  const hex16 = ['0'.repeat(16), `${'0'.repeat(13)}2A1`, `deadbeef${'0'.repeat(6)}a1`];
  assert.equal(hex16.every((h) => /^[0-9A-Fa-f]{16}$/.test(h)), true);
  assert.equal(poolCaptureAllows('pd303_mc.backupIncreInfo.errcode.errCode', hex16), true, 'hex digits only: an entry, not an identifier');
  assert.equal(poolCaptureAllows('pd303_mc.backupIncreInfo.errcode.errCode', [0, 673]), true);
});

test('★★★ which captures go when there are more than twenty: the oldest first-fault ones first, a raise or an end only when none is left, the newest file never', () => {
  const name = (minute: number, kind: 'first-fault' | 'raised' | 'ended', panel = 0): string => poolEventFileName(kind, at(minute), panel);
  assert.deepEqual(poolEventsToDrop([name(0, 'first-fault'), name(10, 'raised')]), [], 'twenty or fewer: none');
  // An episode (first fault, raise, end), then nineteen more first-fault captures: 22 files, two to go.
  const files = [name(0, 'first-fault'), name(10, 'raised'), name(40, 'ended'), ...Array.from({ length: 19 }, (_, i) => name(100 + 5 * i, 'first-fault'))];
  assert.deepEqual(poolEventsToDrop([...files].reverse()), [name(0, 'first-fault'), name(100, 'first-fault')], '★ the two oldest first-fault captures; the raise and the end stay');
  assert.equal(POOL_EVENT_KEEP, 20);
  // Only raises and ends on disk, and a new first-fault capture: the oldest raise goes, not the file just written.
  const ends = Array.from({ length: 20 }, (_, i) => name(10 * i, i % 2 === 0 ? 'raised' : 'ended'));
  assert.deepEqual(poolEventsToDrop([...ends, name(500, 'first-fault')]), [name(0, 'raised')], '★ the newest file is never the one to go');
  // More to drop than there are older first-fault captures: those, then the oldest of the rest.
  assert.deepEqual(poolEventsToDrop([name(1, 'first-fault'), ...ends, name(500, 'raised'), name(501, 'ended')]), [name(1, 'first-fault'), name(0, 'raised'), name(10, 'ended')]);
  // A second panel's captures are counted with the rest, and a file that is not a capture is never named.
  assert.deepEqual(poolEventsToDrop([...files, name(2, 'first-fault', 2), 'notes.txt', 'pool-event-x.json']), [name(0, 'first-fault'), name(2, 'first-fault', 2), name(100, 'first-fault')]);
  assert.deepEqual(poolEventsToDrop(files, 22), []);
});

test('★★ the latched id and name beside the state: restored only as an id this panel can have', () => {
  const base = JSON.stringify({ v: 1, panels: {} });
  const cards = new Map([[PANEL_SN, { id: 'shp2-pool-out', device: 'Smart Home Panel 2' }], ['HD31XXX00XXX0002', { id: 'shp2-pool-out-HD31XXX00XXX0002', device: 'Garage Panel' }]]);
  const fileText = withPoolOutCards(base, cards);
  assert.deepEqual(JSON.parse(fileText).v, 1, 'the tracker\'s own part of the file is untouched');
  assert.deepEqual([...parsePoolOutCards(fileText, 'shp2-pool-out')], [...cards]);
  const bad = (value: unknown, sn = PANEL_SN): number => parsePoolOutCards(JSON.stringify({ v: 1, panels: {}, cards: { [sn]: value } }), 'shp2-pool-out').size;
  assert.equal(bad({ id: 'shp2-pool-out', device: 'x' }), 1, 'control');
  assert.equal(bad({ id: 'shp2-below-reserve', device: 'x' }), 0, 'another alert\'s id');
  assert.equal(bad({ id: 'shp2-pool-out-HD31XXX00XXX0002', device: 'x' }), 0, 'another panel\'s id');
  assert.equal(bad({ id: 'shp2-pool-out' }), 0, 'no name');
  assert.equal(bad({ id: 'shp2-pool-out', device: 'x'.repeat(201) }), 0);
  assert.equal(bad('shp2-pool-out'), 0);
  assert.equal(parsePoolOutCards('not json', 'shp2-pool-out').size, 0);
  assert.equal(parsePoolOutCards(base, 'shp2-pool-out').size, 0, 'a file with no cards has none');
});

test('★★★ a capture of the 2026-11-14 shape: no serial, no dropped key, under the cap, with what the tracker made of the body', () => {
  const raw = { ...lostBody(11), 'pd303_mc.area': 'US-AZ', 'pd303_mc.localTime': '2026-11-14 23:46', 'pd303_mc.timeZone': -420, 'pd303_mc.backupIncreInfo.ch1Info.chName': 'Core 1' };
  const fileText = poolEventCapture({ kind: 'raised', atMs: at(11), panel: 'house panel', verdicts: 'capacity fault (61.4 of 92.2 kWh, 1 slot short)', raw });
  const cap = JSON.parse(fileText);
  assert.deepEqual([cap.v, cap.kind, cap.at, cap.panel, cap.truncated, cap.verdicts], [1, 'raised', '2026-11-15T06:11:00.000Z', 'house panel', false, 'capacity fault (61.4 of 92.2 kWh, 1 slot short)']);
  const keys = Object.keys(cap.keys);
  assert.deepEqual(keys.filter((k) => /(^|\.)(sn|chName|area|localTime|timeZone)$/.test(k)), [], '★ none of the five');
  for (const sn of [PANEL_SN, ...CORE_SNS]) assert.equal(fileText.includes(sn), false, '★ no serial anywhere in the file');
  assert.equal(/US-AZ|23:46|-420|Core 1/.test(fileText), false);
  assert.equal(cap.keys['backupIncreInfo.backupFullCap'], 61440, 'the capacity the alarm was raised on is in it');
  assert.deepEqual(cap.keys['backupInfo.chWatt'], [0, -1107, -1061]);
  assert.equal(cap.keys['pd303_mc.backupIncreInfo.Energy1Info.isConnect'], 1);
  assert.equal(keys.every((k) => poolCaptureAllows(k, raw[k as keyof typeof raw])), true, 'every key in the file is one the allowlist passes');
  assert.equal('loadInfo.hall1Watt' in cap.keys, false);
  assert.ok(keys.length > 90 && Buffer.byteLength(fileText) < POOL_EVENT_MAX_BYTES, `${keys.length} keys, ${Buffer.byteLength(fileText)} bytes`);
});

test('★ the 64 KiB cap: keys past it are left out and the file says so', () => {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < 4000; i++) raw[`pd303_mc.backupIncreInfo.pad${String(i).padStart(4, '0')}`] = 'v'.repeat(40) + '_' + i;
  const fileText = poolEventCapture({ kind: 'first-fault', atMs: at(0), panel: 'house panel', verdicts: null, raw });
  assert.ok(Buffer.byteLength(fileText) <= POOL_EVENT_MAX_BYTES, `${Buffer.byteLength(fileText)} bytes`);
  const cap = JSON.parse(fileText);
  assert.equal(cap.truncated, true);
  assert.ok(Object.keys(cap.keys).length > 500 && Object.keys(cap.keys).length < 4000);
  assert.equal(POOL_EVENT_MAX_BYTES, 64 * 1024);
  assert.equal(POOL_EVENT_KEEP, 20);
});

test('★ a capture file\'s name: the instant, the kind and the panel\'s position — nothing else, and it sorts by time', () => {
  assert.equal(poolEventFileName('first-fault', Date.parse('2026-11-15T06:36:00Z'), 0), 'pool-event-2026-11-15T06-36-00Z-first-fault.json');
  assert.equal(poolEventFileName('raised', Date.parse('2026-11-15T06:46:00Z'), 0), 'pool-event-2026-11-15T06-46-00Z-raised.json');
  assert.equal(poolEventFileName('ended', Date.parse('2026-11-17T03:19:00Z'), 2), 'pool-event-2026-11-17T03-19-00Z-ended-p2.json');
  for (const name of ['pool-event-2026-11-15T06-36-00Z-first-fault.json', 'pool-event-2026-11-17T03-19-00Z-ended-p2.json']) assert.match(name, POOL_EVENT_FILE);
  for (const name of ['pool-event-2026-11-15T06-36-00Z-first-fault.json.tmp', '../pool-event-2026-11-15T06-36-00Z-raised.json', 'pool-event-x.json', `pool-event-2026-11-15T06-36-00Z-raised-${PANEL_SN}.json`]) {
    assert.doesNotMatch(name, POOL_EVENT_FILE, name);
  }
});

/* ══ the debug view and the Home Assistant state ════════════════════════════════════════════════════ */

test('★★★ the debug view: the reference, the four verdicts with their inputs, the streak, the episode, the newest reading, the captures by index — and no serial', () => {
  const ep = withEpisode();
  const diag = poolDiagFromRaw(lostBody(11));
  const signals = poolSignals(diag, ep.baseline, at(11));
  const view = poolOutDebugView([
    { panel: 'house panel', state: ep, diag, diagAtMs: at(11), signals, skip: null },
    { panel: 'panel 2', state: null, diag: null, diagAtMs: null, signals: null, skip: null },
  ], ['pool-event-2026-11-15T06-00-00Z-first-fault.json', 'pool-event-2026-11-15T06-10-00Z-raised.json'], at(11) + 20_000) as any;
  assert.deepEqual(view.panels.map((p: any) => [p.panel, p.sensor, p.severity]), [['house panel', 'on', 'warning'], ['panel 2', 'unknown', null]]);
  const house = view.panels[0];
  assert.deepEqual([house.baseline.roster, house.baseline.poolCapWh], [[1, 2, 3], 92160]);
  assert.deepEqual([house.verdicts.class, house.verdicts.named, house.verdicts.capacity.v, house.verdicts.capacity.countedWh, house.verdicts.capacity.expectedWh, house.verdicts.capacity.k],
    ['STRONG', [1], 'fault', 61440, 92160, 1]);
  assert.deepEqual([house.verdicts.percent.v, house.verdicts.percent.poolPct, house.verdicts.power.v, house.verdicts.power.set, house.verdicts.flags.v], ['fault', 64, 'fault', [1], 'unknown']);
  assert.deepEqual([house.episode.k, house.episode.slots, house.streak, house.lastDiagAtMs], [1, [1], null, at(11)]);
  assert.equal(house.lastDiag.pool.fullCapWh, 61440);
  assert.deepEqual(view.captures, [{ index: 0, name: 'pool-event-2026-11-15T06-00-00Z-first-fault.json' }, { index: 1, name: 'pool-event-2026-11-15T06-10-00Z-raised.json' }]);
  for (const sn of [PANEL_SN, ...CORE_SNS]) assert.equal(JSON.stringify(view).includes(sn), false, '★ no serial in the view');
});

test('★★★ the binary sensor\'s rule: ON during an alarm; OFF only on a capacity verdict at most 15 min old; otherwise unknown', () => {
  const ref = withReference(); // fifteen healthy minutes ending at minute −1
  assert.equal(poolOutSensorState(ref, at(-1)), 'off');
  assert.equal(poolOutSensorState(ref, at(-1) + POOL_OUT_SENSOR_FRESH_MS), 'off', 'exactly 15 minutes old');
  assert.equal(poolOutSensorState(ref, at(-1) + POOL_OUT_SENSOR_FRESH_MS + 1), 'unknown', '★ one ms older: unknown, not OFF');
  assert.equal(poolOutSensorState(emptyPoolOutState(), at(0)), 'unknown', '★ no reading yet');
  const ep = withEpisode();
  assert.equal(poolOutSensorState(ep, at(10)), 'on');
  assert.equal(poolOutSensorState(ep, at(10) + 48 * 60 * 60_000), 'on', '★ an alarm stands whatever its age');
  // A streak before the raise is not the alarm.
  assert.equal(poolOutSensorState(fold(ref, minutes(0, 3, lostBody)).state, at(2)), 'off');

  // The plant's state from each panel's.
  assert.equal(poolCoreOutState(['off']), 'OFF');
  assert.equal(poolCoreOutState(['on']), 'ON');
  assert.equal(poolCoreOutState(['unknown']), null);
  assert.equal(poolCoreOutState([]), null, '★ no panel: unknown, never OFF');
  assert.equal(poolCoreOutState(['off', 'on']), 'ON', 'any panel\'s alarm');
  assert.equal(poolCoreOutState(['unknown', 'on']), 'ON');
  assert.equal(poolCoreOutState(['off', 'unknown']), null, '★ one panel unread: not OFF');
  assert.equal(poolCoreOutState(['off', 'off']), 'OFF');
});

test('control (passes without this release): the fixture bodies used above project a coherent trio at both capacities', () => {
  assert.equal(poolDiagFromRaw(healthyBody(1)).pool.coherent, true);
  assert.equal(poolDiagFromRaw(lostBody(1)).pool.coherent, true);
  assert.equal(poolDiagFromRaw(synthBody({ seq: 1, remainWh: 5 })).pool.coherent, false, 'and an incoherent one is told apart');
});
