/**
 * poolDiag.ts — v1.208.0: what the panel reports about its backup pool, read from ONE REST body.
 *
 * On 2026-11-14 a Core left the panel's backup pool (the pool capacity fell from 92.16 to 61.44 kWh) and the
 * add-on logged nothing: of the fields the panel sends about a source slot it read seven, and it read none of
 * the three error lists. This reader takes every field the pool-out tracker (poolOut.ts), the recorder and the
 * change log use. It is PURE: one raw quota map in, one plain object out; no clock, no file, no network.
 *
 * Three rules hold for every field:
 *  - a missing key is null, never false and never 0 (a partial body must not read as "not connected");
 *  - an enum is taken as its name or as its integer, and a value that is neither is kept as "unrecognised";
 *  - NO MEANING is attached to a code, a flag or an error-list entry. No public table of them exists, so the
 *    renderers below quote the value as the panel sent it and nothing else.
 *
 * The pool trio here is the RAW one (the three unprefixed keys), with the coherence verdict beside it. The
 * projection serves a trio that the grace hold or the slew guard may have replaced with an older one; the
 * tracker must never read that.
 */
import { SHP2_SOURCE_SLOTS } from '../hwSpec.js';
import { coherentBackupPool } from './project.js';

type Quota = Record<string, unknown>;

/** The panel's channel control states, in the vendor's order (the index is the enum's integer). */
export const BACKUP_CH_STA: readonly string[] = ['BACKUP_CH_OFF', 'BACKUP_CH_DISCHARGE', 'BACKUP_CH_CHARGE', 'BACKUP_CH_EM_STOP', 'BACKUP_CH_STANDBY'];
/** The force-charge states. */
export const FORCE_CHARGE_STA: readonly string[] = ['FORCE_CHARGE_OFF', 'FORCE_CHARGE_ON'];
/** The panel's power states. */
export const POWER_STA: readonly string[] = ['LOAD_CH_EG_POWER', 'LOAD_CH_ES_POWER', 'LOAD_CH_OIL_POWER', 'LOAD_CH_STOP_EM', 'LOAD_CH_OFF_POWER'];

/** A token the panel may be quoted with: upper case letters, digits and underscores, at most 40 characters. */
const QUOTABLE_TOKEN = /^[A-Z0-9_]{1,40}$/;
/** The longest error-list entry rendered in hex, in bytes (an entry is 8 bytes on the one schema on record). */
export const ERR_ENTRY_MAX_BYTES = 16;
/** Error-list entries printed in one sentence before "+N more". */
export const ERR_ENTRIES_SHOWN = 4;
/** Non-empty error-list entries KEPT from one list (the panel sends lists of 20). The state file's parser accepts no
 *  longer list, so a reader that kept more would write a state the next start could not read. `count` still says how
 *  many there were. */
export const ERR_ENTRIES_KEPT = 64;

/** One enum field as read. */
export interface EnumReading {
  /** The member's name, as sent or looked up from a sent integer; null when the value cannot be quoted. */
  token: string | null;
  /** The member's integer in the vendor's enum; -1 when the value is not a known member. */
  index: number;
  /** The integer the panel sent, when it sent an integer. */
  sent: number | null;
}

/** One error list as read: its length and the entries that are not empty. */
export interface ErrList {
  /** How many entries the panel sent (20 in the one sample on record). */
  length: number;
  /** How many of them are not empty: `entries` holds the first ERR_ENTRIES_KEPT of these. */
  count: number;
  /** The non-empty entries in list order. `index` counts from 0, as the list is sent. `hex` is the entry's bytes in wire
   *  order, two digits a byte with a space between bytes; null when the entry could not be decoded. */
  entries: Array<{ index: number; hex: string | null }>;
}

/** One source slot (Energy<n>Info, ch<n>Info, ch<n>EnableSet and the slot's entry of backupInfo.chWatt). */
export interface PoolDiagSlot {
  slot: number;
  pct: number | null;
  isConnect: number | null;
  hwConnect: number | null;
  isAcOpen: number | null;
  isEnable: number | null;
  isPowerOutput: number | null;
  isGridCharge: number | null;
  isMpptCharge: number | null;
  emsChgFlag: number | null;
  chargeLimit: number | null;
  multPackNum: number | null;
  errorCodeNum: number | null;
  fullCapWh: number | null;
  ratePowerW: number | null;
  devType: number | null;
  outputPowerW: number | null;
  /** lcdInputWatts: the slot's AC input (0 while its own solar charges it). */
  inputW: number | null;
  /** backupInfo.chWatt for this slot: negative while the slot discharges into the house, positive while it charges. */
  chWatt: number | null;
  /** ch<n>EnableSet: the unprefixed key, else the pd303_mc one. */
  enableSet: number | null;
  ctrlSta: EnumReading | null;
  backupIsReady: boolean | null;
  forceChargeSta: EnumReading | null;
  wakeUpChargeSta: number | null;
  backupRly1Cnt: number | null;
  backupRly2Cnt: number | null;
}

export interface PoolDiag {
  /** The RAW pool trio (never the held one) and whether the three agree (coherentBackupPool). */
  pool: { pct: number | null; fullCapWh: number | null; remainWh: number | null; coherent: boolean };
  /** The pd303_mc copy of the pool capacity (the trio above is the unprefixed family). */
  fullCapMcWh: number | null;
  reserveSoc: number | null;
  slots: PoolDiagSlot[];
  errBackup: ErrList | null;
  errMaster: ErrList | null;
  errHall: ErrList | null;
  masterRlyErrFlg: number | null;
  ntcOverTempErr: number | null;
  powerSta: EnumReading | null;
  reasonOfStopDischar: number | null;
  reasonOsStopCharge: number | null;
  sysCurRunningState: number | null;
  gridSta: number | null;
  /** rly1RealSta..rly4RealSta. */
  rlyRealSta: Array<number | null>;
  /** masterRly1Cnt..masterRly4Cnt. */
  masterRlyCnt: Array<number | null>;
}

/** A number as the panel sent it: a finite number, a numeric string, or a boolean (1 / 0). A missing key is null. */
function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A boolean as the panel sent it (true / false, 1 / 0, or their strings). A missing key is null. */
function boolOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return null;
}

/** Read one enum value against its member list. PURE. */
export function readEnum(v: unknown, members: readonly string[]): EnumReading | null {
  if (v === undefined || v === null) return null;
  const asInt = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null;
  if (asInt != null) {
    if (Number.isInteger(asInt) && asInt >= 0 && asInt < members.length) return { token: members[asInt], index: asInt, sent: asInt };
    return { token: null, index: -1, sent: Number.isFinite(asInt) ? asInt : null };
  }
  if (typeof v === 'string') {
    const at = members.indexOf(v);
    if (at >= 0) return { token: v, index: at, sent: null };
    return { token: QUOTABLE_TOKEN.test(v) ? v : null, index: -1, sent: null };
  }
  return { token: null, index: -1, sent: null };
}

/** An enum value in words: the token verbatim, an integer outside the table as "value N", anything else as unrecognised. */
export function renderEnum(r: EnumReading): string {
  if (r.token != null) return r.token;
  if (r.sent != null) return `value ${r.sent}`;
  return 'an unrecognised value';
}

/** A slot's own error code in words. The number and nothing else: no band, no gloss. */
export function renderErrorCode(n: number): string {
  return `error code ${n}`;
}

/** Bytes in wire order, two digits a byte, a space between bytes ("00 00 02 A1"). Never one unbroken 16-character token:
 *  the phone-push masker (notify.ts maskDeviceSerials) shortens those, and the repository's serial scan flags them. */
function spacedHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function hexBytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

export type ErrEntry = { kind: 'empty' } | { kind: 'bytes'; hex: string } | { kind: 'unrecognised' };

/**
 * Decode one error-list entry. The element form the cloud uses is NOT ESTABLISHED (the one sample on record masks the
 * arrays), so four forms are accepted: a base64 string, a byte array, a hex string, a number. An absent, empty or
 * all-zero entry is empty. Anything else is "unrecognised": reported with its index, never guessed at.
 *
 * A string of hex digits is also valid base64. Two spellings of zero are settled first (all "0": zero in hex; all "A"
 * with padding: zero in base64), then sixteen hex digits read as hex (an 8-byte entry in base64 always ends "="), then
 * base64, then hex of any even length.
 */
export function decodeErrEntry(v: unknown): ErrEntry {
  if (v === undefined || v === null) return { kind: 'empty' };
  let bytes: number[] | null = null;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) return { kind: 'unrecognised' };
    bytes = [];
    for (let i = 7; i >= 0; i--) bytes.push(Math.floor(v / 2 ** (8 * i)) % 256);
  } else if (Array.isArray(v)) {
    if (!v.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) return { kind: 'unrecognised' };
    bytes = v as number[];
  } else if (typeof v === 'string') {
    if (v === '' || /^0+$/.test(v)) return { kind: 'empty' };
    if (/^A+={0,2}$/.test(v) && v.length % 4 === 0) return { kind: 'empty' };
    if (/^[0-9A-Fa-f]{16}$/.test(v)) bytes = hexBytes(v);
    else if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0) bytes = [...Buffer.from(v, 'base64')];
    else if (/^(?:[0-9A-Fa-f]{2})+$/.test(v)) bytes = hexBytes(v);
    else return { kind: 'unrecognised' };
  } else {
    return { kind: 'unrecognised' };
  }
  if (bytes.every((b) => b === 0)) return { kind: 'empty' };
  if (bytes.length > ERR_ENTRY_MAX_BYTES) return { kind: 'unrecognised' };
  return { kind: 'bytes', hex: spacedHex(bytes) };
}

/** Read one error list. Null when the key is absent or is not a list (it could not be read). PURE. */
export function readErrList(v: unknown): ErrList | null {
  if (!Array.isArray(v)) return null;
  const entries: ErrList['entries'] = [];
  let count = 0;
  v.forEach((e, index) => {
    const d = decodeErrEntry(e);
    if (d.kind === 'empty') return;
    count += 1;
    if (entries.length < ERR_ENTRIES_KEPT) entries.push({ index, hex: d.kind === 'bytes' ? d.hex : null });
  });
  return { length: v.length, count, entries };
}

/** The non-empty entries of one list in words: "entry 3 is 00 00 02 A1", at most ERR_ENTRIES_SHOWN, then "+N more". */
export function renderErrEntries(list: ErrList): string {
  const shown = list.entries.slice(0, ERR_ENTRIES_SHOWN).map((e) => `entry ${e.index} is ${e.hex ?? 'an unrecognised value'}`);
  const more = list.count - shown.length;
  return more > 0 ? `${shown.join(', ')}, +${more} more` : shown.join(', ');
}

/** Every field the pool-out tracker, the recorder and the change log read, from one raw REST quota map. PURE. */
export function poolDiagFromRaw(q: Quota): PoolDiag {
  const pct = numOf(q['backupIncreInfo.backupBatPer']);
  const fullCapWh = numOf(q['backupIncreInfo.backupFullCap']);
  const remainWh = numOf(q['backupIncreInfo.backupDischargeRmainBatCap']);
  const chWatt = Array.isArray(q['backupInfo.chWatt']) ? (q['backupInfo.chWatt'] as unknown[]) : [];
  const slots: PoolDiagSlot[] = [];
  for (let n = 1; n <= SHP2_SOURCE_SLOTS; n++) {
    const e = `pd303_mc.backupIncreInfo.Energy${n}Info.`;
    const c = `pd303_mc.backupIncreInfo.ch${n}Info.`;
    slots.push({
      slot: n,
      pct: numOf(q[`${e}batteryPercentage`]),
      isConnect: numOf(q[`${e}isConnect`]),
      hwConnect: numOf(q[`${e}hwConnect`]),
      isAcOpen: numOf(q[`${e}isAcOpen`]),
      isEnable: numOf(q[`${e}isEnable`]),
      isPowerOutput: numOf(q[`${e}isPowerOutput`]),
      isGridCharge: numOf(q[`${e}isGridCharge`]),
      isMpptCharge: numOf(q[`${e}isMpptCharge`]),
      emsChgFlag: numOf(q[`${e}emsChgFlag`]),
      chargeLimit: numOf(q[`${e}chargeLimit`]),
      multPackNum: numOf(q[`${e}multPackNum`]),
      errorCodeNum: numOf(q[`${e}errorCodeNum`]),
      fullCapWh: numOf(q[`${e}devInfo.fullCap`]),
      ratePowerW: numOf(q[`${e}devInfo.ratePower`]),
      devType: numOf(q[`${e}devInfo.type`]),
      outputPowerW: numOf(q[`${e}outputPower`]),
      inputW: numOf(q[`${e}lcdInputWatts`]),
      chWatt: numOf(chWatt[n - 1]),
      enableSet: numOf(q[`ch${n}EnableSet`]) ?? numOf(q[`pd303_mc.ch${n}EnableSet`]),
      ctrlSta: readEnum(q[`${c}ctrlSta`], BACKUP_CH_STA),
      backupIsReady: boolOf(q[`${c}backupIsReady`]),
      forceChargeSta: readEnum(q[`${c}forceChargeSta`], FORCE_CHARGE_STA),
      wakeUpChargeSta: numOf(q[`${c}wakeUpChargeSta`]),
      backupRly1Cnt: numOf(q[`${c}backupRly1Cnt`]),
      backupRly2Cnt: numOf(q[`${c}backupRly2Cnt`]),
    });
  }
  const coherent = coherentBackupPool(pct, fullCapWh, remainWh).fullCapWh != null;
  return {
    pool: { pct, fullCapWh, remainWh, coherent },
    fullCapMcWh: numOf(q['pd303_mc.backupIncreInfo.backupFullCap']),
    reserveSoc: numOf(q['backupReserveSoc']),
    slots,
    errBackup: readErrList(q['pd303_mc.backupIncreInfo.errcode.errCode']),
    errMaster: readErrList(q['pd303_mc.masterIncreInfo.errcode.errCode']),
    errHall: readErrList(q['pd303_mc.loadIncreInfo.hall1IncreInfo.errcode.errCode']),
    masterRlyErrFlg: numOf(q['pd303_mc.masterIncreInfo.masterRlyErrFlg']),
    ntcOverTempErr: numOf(q['pd303_mc.ntcOverTempErr']),
    powerSta: readEnum(q['pd303_mc.powerSta'], POWER_STA),
    reasonOfStopDischar: numOf(q['pd303_mc.reasonOfStopDischar']),
    reasonOsStopCharge: numOf(q['pd303_mc.reasonOsStopCharge']),
    sysCurRunningState: numOf(q['pd303_mc.sysCurRunningState']),
    gridSta: numOf(q['pd303_mc.masterIncreInfo.gridSta']),
    rlyRealSta: [1, 2, 3, 4].map((k) => numOf(q[`pd303_mc.rly${k}RealSta`])),
    masterRlyCnt: [1, 2, 3, 4].map((k) => numOf(q[`pd303_mc.masterIncreInfo.masterRly${k}Cnt`])),
  };
}
