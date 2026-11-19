/**
 * poolOutRecord.ts — v1.208.0: what is RECORDED about the panel's backup pool, beside the alarm (poolOut.ts).
 *
 * On 2026-11-14 a Core left the panel's pool and no flag, code or capacity of that hour was on record anywhere: the
 * recorder stored neither the pool capacity nor any slot flag, and the log held no line. Everything here is so the next
 * event can be read back: the recorder's series, one log line per change of a field the panel reports, one file of the
 * panel's own keys at the first fault reading, the raise and the end, and the debug view.
 *
 * PURE: values in, values out. The store (snapshot.ts) holds the state, writes the files and logs the lines.
 * NO MEANING is attached to a flag or a code here either: a value is recorded and quoted as the panel sent it.
 * No serial enters or leaves this module: a slot is "slot N", a panel is its role.
 */
import { type PoolDiag, type PoolDiagSlot, type ErrList, renderEnum, renderErrEntries } from './ecoflow/poolDiag.js';
import { type PoolOutState, type PoolSignals, type PoolSkipReason, poolOutSeverity, poolOutSensorState } from './poolOut.js';

/* ───────────────────────────── the recorder's series ───────────────────────────── */

/** A flag as one bit: sent and not 0 is set, sent and 0 is clear, not sent is null (never clear). */
const flag = (v: number | boolean | null): boolean | null => (v == null ? null : v === true || (typeof v === 'number' && v !== 0));

/**
 * The slot flags of `src<n>_flags`, in BIT ORDER (bit 0 first). The value recorded is
 *   bits + 65536 × sent
 * where bit i of `bits` is the flag's value and bit i of `sent` says the panel sent that flag in this body. A missing
 * key is therefore never recorded as "off": its `sent` bit is clear. `<n>` in a name is the slot number.
 */
export const POOL_SLOT_FLAG_BITS: ReadonlyArray<{ name: string; of: (s: PoolDiagSlot) => boolean | null }> = [
  { name: 'isConnect', of: (s) => flag(s.isConnect) },
  { name: 'hwConnect', of: (s) => flag(s.hwConnect) },
  { name: 'isAcOpen', of: (s) => flag(s.isAcOpen) },
  { name: 'isEnable', of: (s) => flag(s.isEnable) },
  { name: 'isPowerOutput', of: (s) => flag(s.isPowerOutput) },
  { name: 'ch<n>EnableSet', of: (s) => flag(s.enableSet) },
  { name: 'ch<n>Info.backupIsReady', of: (s) => flag(s.backupIsReady) },
  { name: 'isGridCharge', of: (s) => flag(s.isGridCharge) },
  { name: 'isMpptCharge', of: (s) => flag(s.isMpptCharge) },
  { name: 'emsChgFlag', of: (s) => flag(s.emsChgFlag) },
  // Set for FORCE_CHARGE_ON, clear for FORCE_CHARGE_OFF; a value that is neither counts as not sent.
  { name: 'ch<n>Info.forceChargeSta', of: (s) => (s.forceChargeSta == null || s.forceChargeSta.index < 0 ? null : s.forceChargeSta.index === 1) },
  { name: 'ch<n>Info.wakeUpChargeSta', of: (s) => flag(s.wakeUpChargeSta) },
];
/** The panel flags of `panel_flags`, in bit order, recorded the same way. */
export const POOL_PANEL_FLAG_BITS: ReadonlyArray<{ name: string; of: (d: PoolDiag) => boolean | null }> = [
  { name: 'masterRlyErrFlg', of: (d) => flag(d.masterRlyErrFlg) },
  { name: 'ntcOverTempErr', of: (d) => flag(d.ntcOverTempErr) },
];
/** `sent` sits this many bits above `bits`. */
export const POOL_FLAG_SENT_SHIFT = 16;
/** `pool_out_mask`: bit (slot − 1) for each slot the alarm names out; this bit when a slot out is not identified. */
export const POOL_OUT_MASK_UNIDENTIFIED = 128;

/** One recorded mask from flag values in bit order; null when the panel sent none of them. PURE. */
export function poolFlagMask(values: ReadonlyArray<boolean | null>): number | null {
  let bits = 0;
  let sent = 0;
  values.forEach((v, i) => {
    if (v == null) return;
    sent += 2 ** i;
    if (v) bits += 2 ** i;
  });
  return sent === 0 ? null : bits + sent * 2 ** POOL_FLAG_SENT_SHIFT;
}

export interface PoolRecordInput {
  /** The pool capacity as SERVED (the projection's, which the grace hold or the slew guard may have replaced). */
  servedFullWh: number | null | undefined;
  /** The reader's view of the newest REST body; null when none has been read in this process. */
  diag: PoolDiag | null;
  /** The tracker's verdicts on that body; null when it was skipped (no usable observation). */
  signals: PoolSignals | null;
  /** The tracker's state for this panel; null when it has none. */
  state: PoolOutState | null;
}

/**
 * The recorder's pool series for one panel, as [metric, value]; a null value writes no row. PURE.
 *   backup_full_wh        the pool capacity as served
 *   backup_full_raw_wh    the panel's raw capacity, before any hold
 *   backup_pct_raw        the panel's raw pool percent, before any hold
 *   src<n>_full_wh        slot n's own capacity
 *   src<n>_flags          slot n's flags (POOL_SLOT_FLAG_BITS)
 *   src<n>_err            slot n's errorCodeNum
 *   src<n>_ctrl           slot n's control state as its enum index; −1 for a value outside the enum
 *   err_backup_n, err_master_n, err_hall_n   non-empty entries in each error list
 *   panel_flags           the panel's flags (POOL_PANEL_FLAG_BITS)
 *   pool_counted_slots    slots the panel's capacity counts, on a reading the tracker could judge
 *   pool_out_mask         the slots the standing alarm names out (0: no alarm stands)
 */
export function poolRecordMetrics(p: PoolRecordInput): Array<[string, number | null]> {
  const out: Array<[string, number | null]> = [['backup_full_wh', p.servedFullWh ?? null]];
  const d = p.diag;
  if (d) {
    out.push(['backup_full_raw_wh', d.pool.fullCapWh], ['backup_pct_raw', d.pool.pct]);
    for (const s of d.slots) {
      out.push(
        [`src${s.slot}_full_wh`, s.fullCapWh],
        [`src${s.slot}_flags`, poolFlagMask(POOL_SLOT_FLAG_BITS.map((b) => b.of(s)))],
        [`src${s.slot}_err`, s.errorCodeNum],
        [`src${s.slot}_ctrl`, s.ctrlSta ? s.ctrlSta.index : null],
      );
    }
    const entries = (l: ErrList | null): number | null => (l ? l.count : null);
    out.push(
      ['err_backup_n', entries(d.errBackup)], ['err_master_n', entries(d.errMaster)], ['err_hall_n', entries(d.errHall)],
      ['panel_flags', poolFlagMask(POOL_PANEL_FLAG_BITS.map((b) => b.of(d)))],
    );
  }
  const cap = p.signals?.cap;
  out.push(['pool_counted_slots', cap == null || p.signals == null ? null
    : cap.v === 'healthy' ? p.signals.roster.length
      : cap.v === 'fault' && cap.k != null ? p.signals.roster.length - cap.k : null]);
  const ep = p.state?.episode;
  out.push(['pool_out_mask', p.state == null ? null : ep == null ? 0
    : (ep.slots ?? []).reduce((a, n) => a + 2 ** (n - 1), 0) + (ep.slots == null || ep.slots.length < ep.k ? POOL_OUT_MASK_UNIDENTIFIED : 0)]);
  return out;
}

/* ───────────────────────────── the change log ───────────────────────────── */

/** The last value LOGGED for every field of the change log, as text; persisted, so a restart compares with it. */
export type PoolDiagSig = Record<string, string>;

const NOT_SENT = 'not sent';
const text = (v: number | boolean | null): string => (v == null ? NOT_SENT : String(v));
const listText = (l: ErrList | null): string => (l == null ? 'not read' : l.count === 0 ? 'empty' : renderErrEntries(l));

/**
 * The relay counters and relay states. They are CARRIED, not logged one line a change: the master relays had switched
 * 966, 967, 5,207 and 5,207 times by 2026-11-17, about thirty times a day, so a line a change would be most of this log.
 * Their change since the last line is said in one line whenever another field changes, and at every tracker event.
 */
const CARRIED = /^(?:masterRly\dCnt|rly\dRealSta|slot \d+ ch\d+Info\.backupRly\dCnt)$/;
/** More changes than this in ONE body are said in one line, not one each: a body missing a whole block of keys changes
 *  up to 64 fields at once, and as many again when the block returns. Nothing is left out of that line. */
export const POOL_DIAG_LINES_MAX = 12;

/**
 * Every field of the change log from one body: the discrete ones the reader takes (flags, enums, codes, counts,
 * capacities, the three error lists). The continuous readings (percents, watts, the remaining energy, the reserve
 * setpoint) are not here: they move every body and have recorder series of their own. PURE.
 */
export function poolDiagSignature(d: PoolDiag): PoolDiagSig {
  const sig: PoolDiagSig = {
    'backupIncreInfo.backupFullCap': text(d.pool.fullCapWh),
    'pd303_mc.backupIncreInfo.backupFullCap': text(d.fullCapMcWh),
  };
  for (const s of d.slots) {
    const n = s.slot;
    const at = (key: string): string => `slot ${n} ${key}`;
    sig[at('isConnect')] = text(s.isConnect);
    sig[at('hwConnect')] = text(s.hwConnect);
    sig[at('isAcOpen')] = text(s.isAcOpen);
    sig[at('isEnable')] = text(s.isEnable);
    sig[at('isPowerOutput')] = text(s.isPowerOutput);
    sig[at('isGridCharge')] = text(s.isGridCharge);
    sig[at('isMpptCharge')] = text(s.isMpptCharge);
    sig[at('emsChgFlag')] = text(s.emsChgFlag);
    sig[at('chargeLimit')] = text(s.chargeLimit);
    sig[at('multPackNum')] = text(s.multPackNum);
    sig[at('errorCodeNum')] = text(s.errorCodeNum);
    sig[at('devInfo.fullCap')] = text(s.fullCapWh);
    sig[at('devInfo.ratePower')] = text(s.ratePowerW);
    sig[at('devInfo.type')] = text(s.devType);
    sig[at(`ch${n}EnableSet`)] = text(s.enableSet);
    sig[at(`ch${n}Info.ctrlSta`)] = s.ctrlSta == null ? NOT_SENT : renderEnum(s.ctrlSta);
    sig[at(`ch${n}Info.backupIsReady`)] = text(s.backupIsReady);
    sig[at(`ch${n}Info.forceChargeSta`)] = s.forceChargeSta == null ? NOT_SENT : renderEnum(s.forceChargeSta);
    sig[at(`ch${n}Info.wakeUpChargeSta`)] = text(s.wakeUpChargeSta);
    sig[at(`ch${n}Info.backupRly1Cnt`)] = text(s.backupRly1Cnt);
    sig[at(`ch${n}Info.backupRly2Cnt`)] = text(s.backupRly2Cnt);
  }
  sig['backup error list'] = listText(d.errBackup);
  sig['master error list'] = listText(d.errMaster);
  sig['hall error list'] = listText(d.errHall);
  sig.masterRlyErrFlg = text(d.masterRlyErrFlg);
  sig.ntcOverTempErr = text(d.ntcOverTempErr);
  sig.powerSta = d.powerSta == null ? NOT_SENT : renderEnum(d.powerSta);
  sig.reasonOfStopDischar = text(d.reasonOfStopDischar);
  sig.reasonOsStopCharge = text(d.reasonOsStopCharge);
  sig.sysCurRunningState = text(d.sysCurRunningState);
  sig.gridSta = text(d.gridSta);
  d.rlyRealSta.forEach((v, i) => { sig[`rly${i + 1}RealSta`] = text(v); });
  d.masterRlyCnt.forEach((v, i) => { sig[`masterRly${i + 1}Cnt`] = text(v); });
  return sig;
}

export interface PoolDiagChange {
  /** One line per change, old value to new, the slot as "slot N". Never a serial: no field here holds one. */
  lines: string[];
  /** The signature to keep: what was logged. A carried field keeps its last LOGGED value until a line says its change. */
  sig: PoolDiagSig;
  changed: boolean;
}

/**
 * Compare one body with the last signature on record. PURE.
 *  - No signature on record (the first reading ever, or its file lost): nothing is called a change. One line says a
 *    first reading was taken, and a slot's error code or a non-empty error list already standing is said at once: at
 *    first sight, before any debounce.
 *  - Otherwise one line per field whose value differs from the one last logged. Compared with the PERSISTED signature,
 *    a restart neither invents a change (nothing differs) nor loses one (what changed while the add-on was down
 *    differs at the first body).
 *  - `flush` (a tracker event) says the carried fields' change even when nothing else changed.
 */
export function poolDiagChanges(prev: PoolDiagSig | null, diag: PoolDiag, flush = false): PoolDiagChange {
  const cur = poolDiagSignature(diag);
  if (prev == null) {
    const lines = [`pool-diag: first reading taken (${Object.keys(cur).length} fields); changes are logged from here.`];
    for (const s of diag.slots) {
      if (s.errorCodeNum != null && s.errorCodeNum !== 0) lines.push(`pool-diag: slot ${s.slot} errorCodeNum reads ${s.errorCodeNum} at the first reading.`);
    }
    for (const key of ['backup error list', 'master error list', 'hall error list']) {
      if (cur[key] !== 'empty' && cur[key] !== 'not read') lines.push(`pool-diag: ${key} at the first reading: ${cur[key]}.`);
    }
    return { lines, sig: cur, changed: true };
  }
  let lines: string[] = [];
  const sig: PoolDiagSig = {};
  const carried: string[] = [];
  const moved: string[] = [];
  for (const key of Object.keys(cur)) {
    const was = prev[key];
    if (CARRIED.test(key)) {
      sig[key] = was ?? cur[key];
      if (was !== cur[key]) carried.push(key);
      continue;
    }
    sig[key] = cur[key];
    if (was !== cur[key]) moved.push(`${key} ${was ?? 'not on record'} → ${cur[key]}`);
  }
  lines = moved.length > POOL_DIAG_LINES_MAX
    ? [`pool-diag: ${moved.length} fields changed in one reading: ${moved.join('; ')}`]
    : moved.map((m) => `pool-diag: ${m}`);
  if (carried.length > 0 && (lines.length > 0 || flush)) {
    lines.push(`pool-diag: relay counters and states since the last line: ${carried.map((key) => `${key} ${prev[key] ?? 'not on record'} → ${cur[key]}`).join(', ')}`);
    for (const key of carried) sig[key] = cur[key];
  }
  return { lines, sig, changed: lines.length > 0 || Object.keys(sig).length !== Object.keys(prev).length };
}

/** The signatures in the state file's `diag` object (one per panel serial); a malformed entry is left out. PURE. */
export function parsePoolDiagSigs(fileText: string): Map<string, PoolDiagSig> {
  const out = new Map<string, PoolDiagSig>();
  let raw: unknown;
  try { raw = JSON.parse(fileText); } catch { return out; }
  const diag = (raw as { diag?: unknown } | null)?.diag;
  if (typeof diag !== 'object' || diag === null || Array.isArray(diag)) return out;
  for (const [sn, value] of Object.entries(diag).slice(0, 8)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || sn.length === 0 || sn.length > 64) continue;
    const entries = Object.entries(value);
    if (entries.length > 200 || !entries.every(([k, v]) => k.length <= 80 && typeof v === 'string' && v.length <= 400)) continue;
    out.set(sn, Object.fromEntries(entries) as PoolDiagSig);
  }
  return out;
}

/** The state file's text with the signatures beside the tracker's panels (poolOut.ts serializePoolOutFile). PURE. */
export function withPoolDiagSigs(fileText: string, sigs: ReadonlyMap<string, PoolDiagSig>): string {
  return JSON.stringify({ ...(JSON.parse(fileText) as Record<string, unknown>), diag: Object.fromEntries(sigs) });
}

/** What a standing alarm is shown under, latched at its raise: the alert's id and the panel's name. The id of a
 *  secondary panel holds that panel's serial, so a card never leaves the data folder and is in no view. */
export interface PoolOutCard { id: string; device: string }

/** The cards in the state file's `cards` object (one per panel serial); a malformed entry is left out. PURE. */
export function parsePoolOutCards(fileText: string, idStem: string): Map<string, PoolOutCard> {
  const out = new Map<string, PoolOutCard>();
  let raw: unknown;
  try { raw = JSON.parse(fileText); } catch { return out; }
  const cards = (raw as { cards?: unknown } | null)?.cards;
  if (typeof cards !== 'object' || cards === null || Array.isArray(cards)) return out;
  for (const [sn, value] of Object.entries(cards).slice(0, 8)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || sn.length === 0 || sn.length > 64) continue;
    const { id, device } = value as { id?: unknown; device?: unknown };
    if (typeof id !== 'string' || typeof device !== 'string' || device.length > 200) continue;
    // Only an id this alarm can have: the bare stem, or the stem and this panel's own serial.
    if (id !== idStem && id !== `${idStem}-${sn}`) continue;
    out.set(sn, { id, device });
  }
  return out;
}

/** The state file's text with the cards beside the tracker's panels. PURE. */
export function withPoolOutCards(fileText: string, cards: ReadonlyMap<string, PoolOutCard>): string {
  return JSON.stringify({ ...(JSON.parse(fileText) as Record<string, unknown>), cards: Object.fromEntries(cards) });
}

/* ───────────────────────────── the event capture ───────────────────────────── */

export type PoolEventKind = 'first-fault' | 'raised' | 'ended';
/** Capture files kept; the oldest go first. */
export const POOL_EVENT_KEEP = 20;
/** The largest capture file, in bytes. */
export const POOL_EVENT_MAX_BYTES = 64 * 1024;
/** A capture file's name: its instant in UTC (dashes throughout, so the name sorts by time and holds no unbroken
 *  sixteen-character token, the shape of a device serial), its kind, and "-p<N>" for a panel other than the house panel. */
export const POOL_EVENT_FILE = /^pool-event-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-(?:first-fault|raised|ended)(?:-p\d)?\.json$/;

const CAPTURE_PREFIXES = ['pd303_mc.backupIncreInfo.', 'pd303_mc.masterIncreInfo.'];
const CAPTURE_KEYS: ReadonlySet<string> = new Set([
  'pd303_mc.loadIncreInfo.hall1IncreInfo.errcode.errCode',
  // What the capacity and power rules read: the pool trio and each slot's watts.
  'backupIncreInfo.backupBatPer', 'backupIncreInfo.backupFullCap', 'backupIncreInfo.backupDischargeRmainBatCap', 'backupInfo.chWatt',
]);
/** A key whose last name is one of these is never captured, wherever it sits. */
const CAPTURE_NEVER: ReadonlySet<string> = new Set(['sn', 'chName', 'area', 'localTime', 'timeZone']);
const primitive = (v: unknown): boolean => v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string';
/** A string with the shape of an identifier: twelve or more letters and digits and nothing else. */
const ID_SHAPED = /^[A-Za-z0-9]{12,}$/;
/** …and one that is hex digits only, which is how an error-list entry may be sent (sixteen of them): not an identifier. */
const HEX_ONLY = /^[0-9A-Fa-f]+$/;
/** A list element that may be captured: a primitive that is not shaped like an identifier (an entry in hex is kept). */
const listElement = (v: unknown): boolean => primitive(v) && !(typeof v === 'string' && ID_SHAPED.test(v) && !HEX_ONLY.test(v));

/**
 * May this key of the panel's REST body go into a capture file? An ALLOWLIST: the panel's backup and master blocks, the
 * three error lists, the pool trio and slot watts, and the top-level scalars (a key with no dot, or one name under
 * pd303_mc). A key ending `.sn`, and chName, area, localTime and timeZone anywhere, never; nor a string value shaped
 * like an identifier, whatever its key, alone or as an element of a list (a list holding one is left out whole). PURE.
 */
export function poolCaptureAllows(key: string, value: unknown): boolean {
  if (CAPTURE_NEVER.has(key.slice(key.lastIndexOf('.') + 1))) return false;
  if (typeof value === 'string' && ID_SHAPED.test(value)) return false;
  const listed = CAPTURE_KEYS.has(key) || CAPTURE_PREFIXES.some((p) => key.startsWith(p));
  if (listed) return primitive(value) || (Array.isArray(value) && value.length <= 64 && value.every(listElement));
  const top = !key.includes('.') || (key.startsWith('pd303_mc.') && !key.slice('pd303_mc.'.length).includes('.'));
  return top && value !== null && primitive(value);
}

/**
 * The capture files to delete so that at most `keep` remain. The oldest "first-fault" captures go first: one is written
 * at every streak start, so a capacity that dips for a reading every few minutes writes one each time, and oldest-first
 * alone let those push the capture of a RAISE out of the files kept. A raise or an end goes only when no older
 * first-fault capture is left to take, and the newest file never goes. `names` are the files on disk (any order). PURE.
 */
export function poolEventsToDrop(names: ReadonlyArray<string>, keep: number = POOL_EVENT_KEEP): string[] {
  const all = names.filter((n) => POOL_EVENT_FILE.test(n)).sort();
  const over = all.length - keep;
  if (over <= 0) return [];
  // The newest file (the one just written) is never the one to go.
  const older = all.slice(0, -1);
  const drop = older.filter((n) => /-first-fault(?:-p\d)?\.json$/.test(n)).slice(0, over);
  const rest = older.filter((n) => !drop.includes(n));
  return [...drop, ...rest.slice(0, over - drop.length)];
}

/** A capture file's name. `panelIndex` 0 is the house panel; another panel is its position among the panels (2, 3…). */
export function poolEventFileName(kind: PoolEventKind, atMs: number, panelIndex: number): string {
  const stamp = new Date(atMs).toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
  return `pool-event-${stamp}-${kind}${panelIndex >= 2 && panelIndex <= 9 ? `-p${panelIndex}` : ''}.json`;
}

/** One capture file's text: the allowlisted keys of one REST body, with what the tracker made of it. At most
 *  POOL_EVENT_MAX_BYTES: keys past the limit are left out and `truncated` says so. PURE. */
export function poolEventCapture(p: { kind: PoolEventKind; atMs: number; panel: string; verdicts: string | null; raw: Record<string, unknown> }): string {
  const head = { v: 1, kind: p.kind, at: new Date(p.atMs).toISOString(), panel: p.panel, verdicts: p.verdicts };
  const keys: Record<string, unknown> = {};
  let size = Buffer.byteLength(JSON.stringify({ ...head, truncated: false, keys })) + 8;
  let truncated = false;
  for (const key of Object.keys(p.raw).sort()) {
    const value = p.raw[key];
    if (!poolCaptureAllows(key, value)) continue;
    const add = Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(JSON.stringify(value)) + 2;
    if (size + add > POOL_EVENT_MAX_BYTES) { truncated = true; continue; }
    keys[key] = value;
    size += add;
  }
  return JSON.stringify({ ...head, truncated, keys });
}

/* ───────────────────────────── the debug view and the Home Assistant field ───────────────────────────── */

export interface PoolOutPanelView {
  /** The panel's ROLE ("house panel", "panel 2"): never its serial. */
  panel: string;
  state: PoolOutState | null;
  diag: PoolDiag | null;
  diagAtMs: number | null;
  signals: PoolSignals | null;
  skip: PoolSkipReason | null;
}

/** GET /api/debug/pool-out: the reference, the four verdicts with their inputs, the streak, the episode, the newest
 *  reading as the reader took it, and the capture files by index. No serial is in it. PURE. */
export function poolOutDebugView(panels: ReadonlyArray<PoolOutPanelView>, captures: ReadonlyArray<string>, nowMs: number): Record<string, unknown> {
  return {
    generatedAt: nowMs,
    panels: panels.map((p) => ({
      panel: p.panel,
      sensor: p.state ? poolOutSensorState(p.state, nowMs) : 'unknown',
      severity: p.state ? poolOutSeverity(p.state) : null,
      baseline: p.state?.baseline ?? null,
      verdicts: p.signals == null ? null : {
        class: p.signals.cls, named: p.signals.named, roster: p.signals.roster,
        capacity: p.signals.cap, percent: p.signals.pct, power: p.signals.flow, flags: p.signals.flag,
      },
      lastSkip: p.skip,
      skipRun: p.state?.skip ?? null,
      blind: p.state?.blind ?? null,
      streak: p.state?.streak ?? null,
      flapSteps: p.state?.flaps ?? [],
      episode: p.state?.episode ?? null,
      ends: p.state?.ends ?? [],
      lastUsableMs: p.state?.lastUsableMs ?? null,
      lastCapacityVerdictMs: p.state?.lastCapMs ?? null,
      lastDiagAtMs: p.diagAtMs,
      lastDiag: p.diag,
    })),
    captures: captures.map((name, index) => ({ index, name })),
  };
}

/**
 * The plant's "Core Out of Backup Pool" state from each panel's own (poolOut.ts poolOutSensorState): ON when any panel
 * has an alarm standing; OFF only when every panel reads off (each on a capacity verdict at most 15 minutes old); in
 * every other case unknown, published as null. No panel is unknown, never OFF. PURE.
 */
export function poolCoreOutState(panels: ReadonlyArray<'on' | 'off' | 'unknown'>): 'ON' | 'OFF' | null {
  if (panels.includes('on')) return 'ON';
  return panels.length > 0 && panels.every((p) => p === 'off') ? 'OFF' : null;
}
