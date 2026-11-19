import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  poolDiagFromRaw, readEnum, renderEnum, renderErrorCode, decodeErrEntry, readErrList, renderErrEntries,
  BACKUP_CH_STA, FORCE_CHARGE_STA, POWER_STA, ERR_ENTRIES_SHOWN, ERR_ENTRIES_KEPT, type ErrList,
} from '../src/ecoflow/poolDiag.js';
import { parsePoolOutFile, serializePoolOutFile, poolOutDetail } from '../src/poolOut.js';
import { maskDeviceSerials } from '../src/notify.js';
import { synthBody, fold, minutes, withReference, lostBody, EMPTY_ERR_ENTRY, SLOT_WH, FULL_WH, PANEL_SN } from './fixtures/poolOutFixtures.js';

/**
 * v1.208.0 — the reader of what the panel reports about its backup pool (ecoflow/poolDiag.ts).
 *
 * On 2026-11-14 a Core left the pool and the add-on read none of the fields that could have said why. The reader takes
 * all of them, and three rules hold for each: a missing key is null (never false, never 0), an enum is taken as its name
 * or its integer, and no meaning is attached to a code.
 */

test('an empty body: every field is null — a missing key is never false and never 0', () => {
  const d = poolDiagFromRaw({});
  assert.deepEqual(d.pool, { pct: null, fullCapWh: null, remainWh: null, coherent: false });
  assert.equal(d.fullCapMcWh, null);
  assert.equal(d.reserveSoc, null);
  assert.equal(d.slots.length, 3);
  for (const s of d.slots) {
    const { slot, ...rest } = s;
    assert.ok(slot >= 1 && slot <= 3);
    for (const [key, v] of Object.entries(rest)) assert.equal(v, null, `slot ${slot} ${key}`);
  }
  assert.equal(d.errBackup, null);
  assert.equal(d.errMaster, null);
  assert.equal(d.errHall, null);
  for (const key of ['masterRlyErrFlg', 'ntcOverTempErr', 'powerSta', 'reasonOfStopDischar', 'reasonOsStopCharge', 'sysCurRunningState', 'gridSta'] as const) assert.equal(d[key], null, key);
  assert.deepEqual(d.rlyRealSta, [null, null, null, null]);
  assert.deepEqual(d.masterRlyCnt, [null, null, null, null]);
});

test('the shape of the one raw sample on record (2026-11-17): every field is read', () => {
  const body = synthBody({ seq: 1, slots: [{ pct: 59, w: -469.7 }, { pct: 41, w: -273.4 }, { pct: 40, w: -262.2 }], poolPct: 47 });
  body['pd303_mc.reasonOfStopDischar'] = 0;
  body['pd303_mc.reasonOsStopCharge'] = 0;
  body['pd303_mc.backupIncreInfo.ch1Info.backupRly1Cnt'] = 12;
  body['pd303_mc.backupIncreInfo.ch1Info.backupRly2Cnt'] = 13;
  const d = poolDiagFromRaw(body);
  assert.deepEqual(d.pool, { pct: 47, fullCapWh: FULL_WH, remainWh: Math.round(0.47 * FULL_WH), coherent: true });
  assert.equal(d.fullCapMcWh, FULL_WH);
  assert.equal(d.reserveSoc, 16);
  assert.deepEqual(d.slots[0], {
    slot: 1, pct: 59, isConnect: 1, hwConnect: 1, isAcOpen: 1, isEnable: 1, isPowerOutput: 1, isGridCharge: 0, isMpptCharge: 0,
    emsChgFlag: 1, chargeLimit: 0, multPackNum: 0, errorCodeNum: 0, fullCapWh: SLOT_WH, ratePowerW: 7200, devType: 81,
    outputPowerW: 469.7, inputW: 0, chWatt: -469.7, enableSet: 1,
    ctrlSta: { token: 'BACKUP_CH_DISCHARGE', index: 1, sent: null }, backupIsReady: true,
    forceChargeSta: { token: 'FORCE_CHARGE_OFF', index: 0, sent: null }, wakeUpChargeSta: 0, backupRly1Cnt: 12, backupRly2Cnt: 13,
  });
  assert.equal(d.slots[2].chWatt, -262.2);
  assert.equal(d.slots[1].backupRly1Cnt, null, 'a counter the body does not carry is null');
  assert.deepEqual(d.errBackup, { length: 20, count: 0, entries: [] });
  assert.deepEqual(d.errMaster, { length: 20, count: 0, entries: [] });
  assert.deepEqual(d.errHall, { length: 20, count: 0, entries: [] });
  assert.equal(d.masterRlyErrFlg, 0);
  assert.equal(d.ntcOverTempErr, 0);
  assert.deepEqual(d.powerSta, { token: 'LOAD_CH_ES_POWER', index: 1, sent: null });
  assert.equal(d.reasonOfStopDischar, 0);
  assert.equal(d.reasonOsStopCharge, 0);
  assert.equal(d.sysCurRunningState, 2);
  assert.equal(d.gridSta, 1);
  assert.deepEqual(d.rlyRealSta, [1, 1, 1, 1]);
  assert.deepEqual(d.masterRlyCnt, [966, 967, 5207, 5207]);
});

test('★ a slot whose keys are missing reads null, not "not connected" (the projection reads the same body as false)', () => {
  const body = synthBody({ seq: 2, slots: [{}, { isConnect: null, hwConnect: null, isAcOpen: null, pct: null, fullCap: null }, {}] });
  const d = poolDiagFromRaw(body);
  assert.equal(d.slots[1].isConnect, null);
  assert.equal(d.slots[1].hwConnect, null);
  assert.equal(d.slots[1].isAcOpen, null);
  assert.equal(d.slots[1].pct, null);
  assert.equal(d.slots[1].fullCapWh, null);
  assert.equal(d.slots[0].isConnect, 1);
  // An explicit 0 is a value.
  assert.equal(poolDiagFromRaw(synthBody({ seq: 3, slots: [{ isConnect: 0 }, {}, {}] })).slots[0].isConnect, 0);
});

test('numbers: a finite number, a numeric string, a boolean as 1 / 0; a list or an object is not a number', () => {
  const read = (v: unknown): number | null => poolDiagFromRaw({ 'pd303_mc.ntcOverTempErr': v }).ntcOverTempErr;
  assert.equal(read(3), 3);
  assert.equal(read('3'), 3);
  assert.equal(read(true), 1);
  assert.equal(read(false), 0);
  assert.equal(read(''), null);
  assert.equal(read('  '), null);
  assert.equal(read('abc'), null);
  assert.equal(read(Number.NaN), null);
  assert.equal(read(Number.POSITIVE_INFINITY), null);
  assert.equal(read([]), null, 'Number([]) is 0: an empty list must not read as zero');
  assert.equal(read([7]), null, 'Number([7]) is 7: a list must not read as its element');
  assert.equal(read({}), null);
  assert.equal(read(null), null);
  assert.equal(read(undefined), null);
});

test('backupIsReady: true / false, 1 / 0 and their strings; anything else, and a missing key, is null', () => {
  const read = (v: unknown): boolean | null => poolDiagFromRaw({ 'pd303_mc.backupIncreInfo.ch2Info.backupIsReady': v }).slots[1].backupIsReady;
  assert.equal(read(true), true);
  assert.equal(read(false), false);
  assert.equal(read(1), true);
  assert.equal(read(0), false);
  assert.equal(read('true'), true);
  assert.equal(read('false'), false);
  assert.equal(read('yes'), null);
  assert.equal(read(2), null);
  assert.equal(read(undefined), null);
});

test('ch<n>EnableSet: the unprefixed key, else the pd303_mc one', () => {
  assert.equal(poolDiagFromRaw({ ch2EnableSet: 2, 'pd303_mc.ch2EnableSet': 1 }).slots[1].enableSet, 2);
  assert.equal(poolDiagFromRaw({ 'pd303_mc.ch2EnableSet': 1 }).slots[1].enableSet, 1);
  assert.equal(poolDiagFromRaw({}).slots[1].enableSet, null);
});

test('backupInfo.chWatt: each slot its own entry; no list, or a short one, is null for the slots it lacks', () => {
  assert.deepEqual(poolDiagFromRaw({ 'backupInfo.chWatt': [-505, 0, 7100] }).slots.map((s) => s.chWatt), [-505, 0, 7100]);
  assert.deepEqual(poolDiagFromRaw({ 'backupInfo.chWatt': [-505] }).slots.map((s) => s.chWatt), [-505, null, null]);
  assert.deepEqual(poolDiagFromRaw({ 'backupInfo.chWatt': '[-505,0,0]' }).slots.map((s) => s.chWatt), [null, null, null]);
});

test('★ the pool trio is the RAW one, with the coherence verdict beside it', () => {
  // A new capacity with the old remainder: 61,440 Wh with the remainder of 92,160 at 67 %. The percent and the
  // remainder disagree by more than five points, so the trio is not coherent — and the raw figures are still served.
  const d = poolDiagFromRaw({ 'backupIncreInfo.backupBatPer': 67, 'backupIncreInfo.backupFullCap': 61440, 'backupIncreInfo.backupDischargeRmainBatCap': 61747 });
  assert.deepEqual(d.pool, { pct: 67, fullCapWh: 61440, remainWh: 61747, coherent: false });
  assert.equal(poolDiagFromRaw({ 'backupIncreInfo.backupBatPer': 0, 'backupIncreInfo.backupFullCap': 0, 'backupIncreInfo.backupDischargeRmainBatCap': 0 }).pool.coherent, false,
    'a capacity of zero is not a coherent trio');
  assert.equal(poolDiagFromRaw({ 'backupIncreInfo.backupBatPer': 64, 'backupIncreInfo.backupFullCap': 61440, 'backupIncreInfo.backupDischargeRmainBatCap': 39322 }).pool.coherent, true);
  assert.equal(poolDiagFromRaw({ 'backupIncreInfo.backupFullCap': 61440 }).pool.coherent, false, 'one member alone is not a trio');
});

/* ───────────── enums: the name or the integer ───────────── */

test('an enum is read as its name or as its integer', () => {
  assert.deepEqual(readEnum('BACKUP_CH_STANDBY', BACKUP_CH_STA), { token: 'BACKUP_CH_STANDBY', index: 4, sent: null });
  assert.deepEqual(readEnum(4, BACKUP_CH_STA), { token: 'BACKUP_CH_STANDBY', index: 4, sent: 4 });
  assert.deepEqual(readEnum('4', BACKUP_CH_STA), { token: 'BACKUP_CH_STANDBY', index: 4, sent: 4 });
  assert.deepEqual(readEnum(0, BACKUP_CH_STA), { token: 'BACKUP_CH_OFF', index: 0, sent: 0 });
  assert.deepEqual(readEnum(1, FORCE_CHARGE_STA), { token: 'FORCE_CHARGE_ON', index: 1, sent: 1 });
  assert.deepEqual(readEnum('LOAD_CH_STOP_EM', POWER_STA), { token: 'LOAD_CH_STOP_EM', index: 3, sent: null });
  assert.equal(readEnum(undefined, BACKUP_CH_STA), null);
  assert.equal(readEnum(null, BACKUP_CH_STA), null);
  // The vendor's order is the enum's integer.
  assert.deepEqual([...BACKUP_CH_STA], ['BACKUP_CH_OFF', 'BACKUP_CH_DISCHARGE', 'BACKUP_CH_CHARGE', 'BACKUP_CH_EM_STOP', 'BACKUP_CH_STANDBY']);
  assert.deepEqual([...POWER_STA], ['LOAD_CH_EG_POWER', 'LOAD_CH_ES_POWER', 'LOAD_CH_OIL_POWER', 'LOAD_CH_STOP_EM', 'LOAD_CH_OFF_POWER']);
});

test('★ rendering an enum: a token verbatim, an integer outside the table as "value N", anything else unrecognised', () => {
  assert.equal(renderEnum(readEnum('BACKUP_CH_STANDBY', BACKUP_CH_STA)!), 'BACKUP_CH_STANDBY');
  assert.equal(renderEnum(readEnum(2, BACKUP_CH_STA)!), 'BACKUP_CH_CHARGE');
  // A name the table does not hold is still quoted, as sent, when it is a plain upper-case token…
  assert.deepEqual(readEnum('BACKUP_CH_FAULT_X9', BACKUP_CH_STA), { token: 'BACKUP_CH_FAULT_X9', index: -1, sent: null });
  assert.equal(renderEnum(readEnum('BACKUP_CH_FAULT_X9', BACKUP_CH_STA)!), 'BACKUP_CH_FAULT_X9');
  assert.equal(renderEnum(readEnum('A'.repeat(40), BACKUP_CH_STA)!), 'A'.repeat(40));
  // …and never when it is anything else: lower case, punctuation, 41 characters.
  for (const odd of ['backup_ch_off', 'BACKUP CH OFF', 'BACKUP-CH', '<b>X</b>', 'A'.repeat(41), '']) {
    assert.deepEqual(readEnum(odd, BACKUP_CH_STA), { token: null, index: -1, sent: null }, JSON.stringify(odd));
    assert.equal(renderEnum(readEnum(odd, BACKUP_CH_STA)!), 'an unrecognised value');
  }
  assert.deepEqual(readEnum(7, BACKUP_CH_STA), { token: null, index: -1, sent: 7 });
  assert.equal(renderEnum(readEnum(7, BACKUP_CH_STA)!), 'value 7');
  assert.equal(renderEnum(readEnum(5, BACKUP_CH_STA)!), 'value 5', 'one past the last member');
  assert.equal(renderEnum(readEnum(-1, BACKUP_CH_STA)!), 'value -1');
  assert.equal(renderEnum(readEnum(true, BACKUP_CH_STA)!), 'an unrecognised value');
  assert.equal(renderEnum(readEnum({ a: 1 }, BACKUP_CH_STA)!), 'an unrecognised value');
});

/* ───────────── a slot's error code: the number, nothing else ───────────── */

test('★ an error code is "error code N" and nothing else — no band, no gloss, whatever the number', () => {
  for (const n of [1, 17, 461, 500, 533, 599, 600, 65535]) assert.equal(renderErrorCode(n), `error code ${n}`);
});

/* ───────────── the error lists: four accepted element forms ───────────── */

// Eight bytes DE AD BE EF 00 00 00 01 in each accepted form.
const BYTES = [0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 1];
const SPACED = 'DE AD BE EF 00 00 00 01';

test('an error-list entry is accepted as base64, as a byte list, as hex and as a number', () => {
  assert.deepEqual(decodeErrEntry(Buffer.from(BYTES).toString('base64')), { kind: 'bytes', hex: SPACED });
  assert.deepEqual(decodeErrEntry(BYTES), { kind: 'bytes', hex: SPACED });
  assert.deepEqual(decodeErrEntry('DEADBEEF00000001'), { kind: 'bytes', hex: SPACED });
  assert.deepEqual(decodeErrEntry('deadbeef00000001'), { kind: 'bytes', hex: SPACED }, 'lower-case hex');
  assert.deepEqual(decodeErrEntry(673), { kind: 'bytes', hex: '00 00 00 00 00 00 02 A1' }, 'a number is its own value in hex, eight bytes');
  assert.deepEqual(decodeErrEntry(0xdeadbeef), { kind: 'bytes', hex: '00 00 00 00 DE AD BE EF' });
});

test('★ wire order: the first byte sent is the first byte printed', () => {
  assert.deepEqual(decodeErrEntry([0x02, 0xa1, 0, 0, 0, 0, 0, 0]), { kind: 'bytes', hex: '02 A1 00 00 00 00 00 00' });
  assert.deepEqual(decodeErrEntry([0, 0, 0, 0, 0, 0, 0x02, 0xa1]), { kind: 'bytes', hex: '00 00 00 00 00 00 02 A1' });
  assert.deepEqual(decodeErrEntry(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString('base64')), { kind: 'bytes', hex: '01 02 03 04 05 06 07 08' });
});

test('an absent, empty or all-zero entry is empty, in every form', () => {
  for (const empty of [undefined, null, '', EMPTY_ERR_ENTRY, 'AAAA', '0000000000000000', '00', '0', 0, [], [0, 0, 0, 0, 0, 0, 0, 0], Buffer.alloc(8).toString('base64'), Buffer.alloc(6).toString('base64')]) {
    assert.deepEqual(decodeErrEntry(empty), { kind: 'empty' }, JSON.stringify(empty));
  }
  // Twelve zero bytes in base64 are sixteen "A"s, which are also sixteen hex digits: zero wins.
  assert.equal(Buffer.alloc(12).toString('base64'), 'A'.repeat(16));
  assert.deepEqual(decodeErrEntry('A'.repeat(16)), { kind: 'empty' });
});

test('the two readings of a hex-looking string: sixteen hex digits are hex, a shorter one is base64', () => {
  // An 8-byte entry in base64 always ends "=", so sixteen hex digits cannot be one.
  assert.deepEqual(decodeErrEntry('0000000000000533'), { kind: 'bytes', hex: '00 00 00 00 00 00 05 33' });
  // "00000001" is four hex bytes or six base64 bytes; base64 is the form this cloud uses for bytes elsewhere.
  assert.deepEqual(decodeErrEntry('00000001'), { kind: 'bytes', hex: [...Buffer.from('00000001', 'base64')].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') });
  // Hex of an even length that is not valid base64 (its length is not a multiple of four) is read as hex.
  assert.deepEqual(decodeErrEntry('02A1FF'), { kind: 'bytes', hex: '02 A1 FF' });
});

test('anything that cannot be decoded is unrecognised — reported, never guessed at', () => {
  for (const odd of ['not base64!', 'ABC', 'zz', -1, 1.5, Number.MAX_SAFE_INTEGER + 2, [256], [1, 'a'], [1.5], { type: 'Buffer', data: [1] }, true]) {
    assert.deepEqual(decodeErrEntry(odd), { kind: 'unrecognised' }, JSON.stringify(odd));
  }
  // More bytes than an entry holds: not rendered.
  assert.deepEqual(decodeErrEntry(Array.from({ length: 17 }, () => 1)), { kind: 'unrecognised' });
  assert.equal(decodeErrEntry(Array.from({ length: 16 }, () => 1)).kind, 'bytes');
});

test('a list: its length and its non-empty entries with their positions (counted from 0); not a list is null', () => {
  const list = Array.from({ length: 20 }, () => EMPTY_ERR_ENTRY) as unknown[];
  list[3] = Buffer.from([0, 0, 0, 0, 0, 0, 0x02, 0xa1]).toString('base64');
  list[7] = 'not base64!';
  assert.deepEqual(readErrList(list), { length: 20, count: 2, entries: [{ index: 3, hex: '00 00 00 00 00 00 02 A1' }, { index: 7, hex: null }] });
  assert.deepEqual(readErrList([]), { length: 0, count: 0, entries: [] });
  assert.equal(readErrList(undefined), null);
  assert.equal(readErrList('AAAA'), null);
  assert.equal(readErrList({ 0: 'AAAA' }), null);
  // The three lists come from their own keys.
  const d = poolDiagFromRaw({
    'pd303_mc.backupIncreInfo.errcode.errCode': [1],
    'pd303_mc.masterIncreInfo.errcode.errCode': [0, 2],
    'pd303_mc.loadIncreInfo.hall1IncreInfo.errcode.errCode': [0, 0, 3],
  });
  assert.deepEqual(d.errBackup, { length: 1, count: 1, entries: [{ index: 0, hex: '00 00 00 00 00 00 00 01' }] });
  assert.deepEqual(d.errMaster, { length: 2, count: 1, entries: [{ index: 1, hex: '00 00 00 00 00 00 00 02' }] });
  assert.deepEqual(d.errHall, { length: 3, count: 1, entries: [{ index: 2, hex: '00 00 00 00 00 00 00 03' }] });
});

test('★★ a list keeps at most 64 non-empty entries and still says how many there were: the state it goes into must be readable at the next start', () => {
  assert.equal(ERR_ENTRIES_KEPT, 64);
  // The panel sends lists of 20. A list of 100 with every entry set: 64 kept, in list order, and the count is 100.
  const full = readErrList(Array.from({ length: 100 }, (_, i) => i + 1)) as ErrList;
  assert.deepEqual([full.length, full.count, full.entries.length, full.entries[0].index, full.entries[63].index], [100, 100, 64, 0, 63]);
  assert.equal(renderErrEntries(full), 'entry 0 is 00 00 00 00 00 00 00 01, entry 1 is 00 00 00 00 00 00 00 02, entry 2 is 00 00 00 00 00 00 00 03, entry 3 is 00 00 00 00 00 00 00 04, +96 more');
  // Sixty-four is kept whole; the sixty-fifth is counted and not kept. Empty entries take no place.
  const at64 = readErrList(Array.from({ length: 200 }, (_, i) => (i % 2 === 0 && i < 128 ? 7 : 0))) as ErrList;
  assert.deepEqual([at64.count, at64.entries.length, at64.entries[63].index], [64, 64, 126]);
  const at65 = readErrList(Array.from({ length: 200 }, (_, i) => (i % 2 === 0 && i < 130 ? 7 : 0))) as ErrList;
  assert.deepEqual([at65.count, at65.entries.length, at65.entries[63].index], [65, 64, 126]);
  // Through the tracker and the state file: an alarm standing with such a list on its newest reading is restored.
  const noisy = (seq: number): Record<string, unknown> => ({ ...lostBody(seq), 'pd303_mc.loadIncreInfo.hall1IncreInfo.errcode.errCode': Array.from({ length: 100 }, (_, i) => i + 1) });
  const st = fold(withReference(), minutes(0, 11, noisy)).state;
  assert.notEqual(st.episode, null);
  assert.deepEqual([st.last?.errLists.hall?.count, st.last?.errLists.hall?.entries.length], [100, 64]);
  const back = parsePoolOutFile(serializePoolOutFile(new Map([[PANEL_SN, st]])));
  assert.deepEqual([back.rejected, back.panels.get(PANEL_SN)?.episode != null, back.panels.get(PANEL_SN)?.last?.errLists.hall?.count], [0, true, 100]);
  assert.equal(poolOutDetail(st, { nowMs: st.last!.atMs, timeZone: 'America/Phoenix' }).includes('Its hall error list holds 100 entries: entry 0 is 00 00 00 00 00 00 00 01, entry 1 is 00 00 00 00 00 00 00 02, entry 2 is 00 00 00 00 00 00 00 03, entry 3 is 00 00 00 00 00 00 00 04, +96 more.'), true);
  // A file that holds a longer list than this code keeps, or a count below its entries, is not one this code wrote.
  const json = JSON.parse(serializePoolOutFile(new Map([[PANEL_SN, st]])));
  json.panels[PANEL_SN].last.errLists.hall.entries.push({ index: 64, hex: null });
  assert.equal(parsePoolOutFile(JSON.stringify(json)).rejected, 1);
  json.panels[PANEL_SN].last.errLists.hall.entries.length = 3;
  json.panels[PANEL_SN].last.errLists.hall.count = 2;
  assert.equal(parsePoolOutFile(JSON.stringify(json)).rejected, 1);
  // A file written before the count existed kept every entry: its count is their number.
  delete json.panels[PANEL_SN].last.errLists.hall.count;
  assert.equal(parsePoolOutFile(JSON.stringify(json)).panels.get(PANEL_SN)?.last?.errLists.hall?.count, 3);
});

test('★ rendering a list: each entry with its index, at most four, then "+N more"; an undecodable one says so', () => {
  assert.equal(renderErrEntries({ length: 20, count: 1, entries: [{ index: 3, hex: '00 00 00 00 00 00 02 A1' }] }), 'entry 3 is 00 00 00 00 00 00 02 A1');
  assert.equal(renderErrEntries({ length: 20, count: 2, entries: [{ index: 3, hex: '00 00 00 00 00 00 02 A1' }, { index: 7, hex: null }] }),
    'entry 3 is 00 00 00 00 00 00 02 A1, entry 7 is an unrecognised value');
  const six = { length: 20, count: 6, entries: [0, 1, 2, 3, 4, 5].map((index) => ({ index, hex: `00 0${index}` })) };
  assert.equal(ERR_ENTRIES_SHOWN, 4);
  assert.equal(renderErrEntries(six), 'entry 0 is 00 00, entry 1 is 00 01, entry 2 is 00 02, entry 3 is 00 03, +2 more');
  assert.equal(renderErrEntries({ length: 20, count: 4, entries: six.entries.slice(0, 4) }), 'entry 0 is 00 00, entry 1 is 00 01, entry 2 is 00 02, entry 3 is 00 03');
});

test('★ an entry in hex is never one unbroken 16-character token: the phone-push masker would shorten it', () => {
  // notify.ts maskDeviceSerials shows any 16-character upper-case token of letters and digits as its last characters:
  // an entry printed as sixteen hex digits in a row would reach the phone cut to four.
  const unbroken = 'DEADBEEF000000A1';
  assert.notEqual(maskDeviceSerials(`entry 3 is ${unbroken}`), `entry 3 is ${unbroken}`, 'control: the masker does cut the unbroken form');
  const d = decodeErrEntry(unbroken);
  assert.equal(d.kind, 'bytes');
  const text = renderErrEntries({ length: 20, count: 1, entries: [{ index: 3, hex: d.kind === 'bytes' ? d.hex : null }] });
  assert.equal(text, 'entry 3 is DE AD BE EF 00 00 00 A1');
  assert.equal(maskDeviceSerials(text), text);
  assert.equal(/[A-Za-z0-9]{16}/.test(text), false);
});
