/**
 * poolOutFixtures.ts — v1.208.0: REST bodies for the pool-out tests.
 *
 * TWO KINDS OF BODY, BOTH SYNTHETIC IN PART:
 *  - bodyFromRow: one row of the recorder's 5-minute panel series (pool percent, reserve, per-slot percent, watts, AC input,
 *    solar, temperature) expanded to a REST body. The recorder stored neither the pool capacity, nor a flag, an error code
 *    or the circuit watts, so the builder ADDS them: the capacity the caller gives, a remainder computed from the percent,
 *    the flags of the one raw sample on record (2026-11-17, after the return), empty error lists, and a deterministic
 *    MOVING twelve-circuit vector. None of the added values was measured at the row's instant.
 *  - synthBody: a body built from scratch for one rule or boundary.
 *
 * WHY THE CIRCUIT VECTOR MOVES. The store calls a body new only when its content witness (shp2Shadow.ts) differs from
 * the previous one, and latches a stale shadow after five identical bodies. A fixture with a fixed vector would be read
 * as one body and four replays: no observation, a latch, and a test that is red whatever the code under test does.
 *
 * Serials are placeholders. Nothing here reads a clock.
 */
import { readFileSync } from 'node:fs';
import { projectShp2 } from '../../src/ecoflow/project.js';
import { shp2ContentWitness } from '../../src/shp2Shadow.js';
import { poolDiagFromRaw } from '../../src/ecoflow/poolDiag.js';
import { advancePoolOut, emptyPoolOutState, type PoolObservation, type PoolOutState, type PoolOutStep } from '../../src/poolOut.js';

export const PANEL_SN = 'HD31XXX00XXX0001';
export const CORE_SNS = ['Y711XXX00XXX0001', 'Y711XXX00XXX0002', 'Y711XXX00XXX0003'];
export const SLOT_WH = 30720;
export const FULL_WH = 3 * SLOT_WH;
export const MIN = 60_000;
/** An empty 8-byte error-list entry in base64 (the element form is NOT established; see poolDiag.ts decodeErrEntry). */
export const EMPTY_ERR_ENTRY = 'AAAAAAAAAAA=';

export type Body = Record<string, unknown>;

/** A deterministic twelve-circuit vector that never repeats: three channels carry the sequence number itself. SYNTHETIC. */
export function movingCircuits(seq: number): number[] {
  // Offset so that a negative sequence number (the minutes before a test's instant zero) is its own vector too.
  const s = Math.trunc(seq) + 1_000_000_000;
  const out: number[] = [s % 1000, Math.floor(s / 1000) % 1000, Math.floor(s / 1_000_000) % 1000];
  for (let i = 3; i < 12; i++) out.push(40 + 31 * i + ((s * (7 + i)) % 53));
  return out;
}

export interface SynthSlot {
  pct?: number | null;
  /** backupInfo.chWatt: negative while discharging. */
  w?: number | null;
  inW?: number | null;
  pvW?: number | null;
  temp?: number | null;
  isConnect?: number | null;
  hwConnect?: number | null;
  isAcOpen?: number | null;
  isEnable?: number | null;
  isPowerOutput?: number | null;
  errorCodeNum?: number | null;
  fullCap?: number | null;
  enableSet?: number | null;
  ctrlSta?: unknown;
  backupIsReady?: unknown;
}
export interface SynthOpts {
  /** The sequence number: it moves the circuit vector, so two bodies with different seq are different content. */
  seq: number;
  capWh?: number | null;
  poolPct?: number | null;
  remainWh?: number | null;
  reserve?: number | null;
  slots?: SynthSlot[];
  gridSta?: number | null;
  /** Keys set after everything else (a value of undefined deletes the key). */
  set?: Record<string, unknown>;
}

const put = (b: Body, key: string, v: unknown): void => { if (v !== null && v !== undefined) b[key] = v; };

/** One REST body. Defaults: a healthy three-Core pool at 60 % carrying 500 W a slot, reserve 16, grid present. */
export function synthBody(o: SynthOpts): Body {
  const slots = o.slots ?? [{}, {}, {}];
  const b: Body = {};
  const filled = slots.map((s) => ({
    pct: s.pct === undefined ? 60 : s.pct,
    w: s.w === undefined ? -500 : s.w,
    inW: s.inW === undefined ? 0 : s.inW,
    pvW: s.pvW === undefined ? 0 : s.pvW,
    temp: s.temp === undefined ? 29 : s.temp,
    isConnect: s.isConnect === undefined ? 1 : s.isConnect,
    hwConnect: s.hwConnect === undefined ? 1 : s.hwConnect,
    isAcOpen: s.isAcOpen === undefined ? 1 : s.isAcOpen,
    isEnable: s.isEnable === undefined ? 1 : s.isEnable,
    isPowerOutput: s.isPowerOutput === undefined ? 1 : s.isPowerOutput,
    errorCodeNum: s.errorCodeNum === undefined ? 0 : s.errorCodeNum,
    fullCap: s.fullCap === undefined ? SLOT_WH : s.fullCap,
    enableSet: s.enableSet === undefined ? 1 : s.enableSet,
    ctrlSta: s.ctrlSta === undefined ? 'BACKUP_CH_DISCHARGE' : s.ctrlSta,
    backupIsReady: s.backupIsReady === undefined ? true : s.backupIsReady,
  }));
  const capWh = o.capWh === undefined ? filled.reduce((a, s) => a + (s.fullCap ?? 0), 0) : o.capWh;
  const known = filled.filter((s) => s.pct != null);
  const poolPct = o.poolPct === undefined ? (known.length ? known.reduce((a, s) => a + (s.pct as number), 0) / known.length : null) : o.poolPct;
  const remainWh = o.remainWh === undefined ? (capWh != null && poolPct != null ? Math.round((poolPct / 100) * capWh) : null) : o.remainWh;
  put(b, 'backupIncreInfo.backupBatPer', poolPct);
  put(b, 'backupIncreInfo.backupFullCap', capWh);
  put(b, 'backupIncreInfo.backupDischargeRmainBatCap', remainWh);
  put(b, 'pd303_mc.backupIncreInfo.backupFullCap', capWh);
  put(b, 'backupReserveSoc', o.reserve === undefined ? 16 : o.reserve);
  b['backupInfo.chWatt'] = filled.map((s) => s.w);
  b['loadInfo.hall1Watt'] = movingCircuits(o.seq);
  b['wattInfo.gridWatt'] = 0;
  put(b, 'pd303_mc.masterIncreInfo.gridSta', o.gridSta === undefined ? 1 : o.gridSta);
  b['pd303_mc.masterIncreInfo.masterRlyErrFlg'] = 0;
  b['pd303_mc.ntcOverTempErr'] = 0;
  b['pd303_mc.powerSta'] = 'LOAD_CH_ES_POWER';
  b['pd303_mc.sysCurRunningState'] = 2;
  [966, 967, 5207, 5207].forEach((n, i) => { b[`pd303_mc.masterIncreInfo.masterRly${i + 1}Cnt`] = n; b[`pd303_mc.rly${i + 1}RealSta`] = 1; });
  for (const key of ['pd303_mc.backupIncreInfo.errcode.errCode', 'pd303_mc.masterIncreInfo.errcode.errCode', 'pd303_mc.loadIncreInfo.hall1IncreInfo.errcode.errCode']) {
    b[key] = Array.from({ length: 20 }, () => EMPTY_ERR_ENTRY);
  }
  filled.forEach((s, i) => {
    const n = i + 1;
    const e = `pd303_mc.backupIncreInfo.Energy${n}Info.`;
    const c = `pd303_mc.backupIncreInfo.ch${n}Info.`;
    b[`${e}devInfo.modelInfo.sn`] = CORE_SNS[i] ?? '';
    put(b, `${e}batteryPercentage`, s.pct);
    put(b, `${e}isConnect`, s.isConnect);
    put(b, `${e}hwConnect`, s.hwConnect);
    put(b, `${e}isAcOpen`, s.isAcOpen);
    put(b, `${e}isEnable`, s.isEnable);
    put(b, `${e}isPowerOutput`, s.isPowerOutput);
    b[`${e}isGridCharge`] = 0;
    b[`${e}isMpptCharge`] = 0;
    b[`${e}emsChgFlag`] = 1;
    b[`${e}chargeLimit`] = 0;
    b[`${e}multPackNum`] = 0;
    put(b, `${e}errorCodeNum`, s.errorCodeNum);
    put(b, `${e}devInfo.fullCap`, s.fullCap);
    b[`${e}devInfo.ratePower`] = 7200;
    b[`${e}devInfo.type`] = 81;
    put(b, `${e}emsBatTemp`, s.temp);
    put(b, `${e}lcdInputWatts`, s.inW);
    put(b, `${e}outputPower`, s.w == null ? null : Math.max(0, -s.w));
    put(b, `${e}pvHeightChargeWatts`, s.pvW);
    b[`${e}pvLowChargeWatts`] = 0;
    put(b, `${c}ctrlSta`, s.ctrlSta);
    put(b, `${c}backupIsReady`, s.backupIsReady);
    b[`${c}forceChargeSta`] = 'FORCE_CHARGE_OFF';
    b[`${c}wakeUpChargeSta`] = 0;
    put(b, `ch${n}EnableSet`, s.enableSet);
    put(b, `pd303_mc.ch${n}EnableSet`, s.enableSet);
    b[`ch${n}ForceCharge`] = 'FORCE_CHARGE_OFF';
  });
  for (const [key, v] of Object.entries(o.set ?? {})) {
    if (v === undefined) delete b[key];
    else b[key] = v;
  }
  return b;
}

/** One row of the recorder's 5-minute panel series: [ts_iso_utc, backup_pct, backup_reserve, src1..3_pct, src1..3_w,
 *  src1..3_in_w, src1..3_pv_w, src1..3_temp]; a blank cell is null. */
export type PanelRow = [string, ...Array<number | null>];
export const rowMs = (row: PanelRow): number => Date.parse(row[0].replace('Z', ':00Z'));

/** One REST body from one series row at one capacity. A blank cell leaves its key out of the body. */
export function bodyFromRow(row: PanelRow, capWh: number, seq: number): Body {
  const v = row.slice(1) as Array<number | null>;
  return synthBody({
    seq,
    capWh,
    poolPct: v[0],
    reserve: v[1],
    slots: [0, 1, 2].map((i) => ({ pct: v[2 + i], w: v[5 + i], inW: v[8 + i], pvW: v[11 + i], temp: v[14 + i] })),
  });
}

export interface PoolFixture {
  note: string;
  source: string;
  panelSn: string;
  coreSns: string[];
  columns: string[];
  capacity: { fullWh: number; shortWh: number; shortFromIso: string; shortUntilIso: string };
  rows: PanelRow[];
}
export function loadPoolFixture(name: 'pool-loss-1114' | 'pool-return-1116'): PoolFixture {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')) as PoolFixture;
}

/** The capacity the panel counted at an instant, per a fixture's two recorded instants. */
export function capacityAt(cap: PoolFixture['capacity'], atMs: number): number {
  return atMs >= Date.parse(cap.shortFromIso) && atMs < Date.parse(cap.shortUntilIso) ? cap.shortWh : cap.fullWh;
}

export interface TimedBody { atMs: number; body: Body }
/** Each row as five bodies a minute apart, from the row's own instant, at the capacity of that minute. */
export function bodiesFromRows(rows: PanelRow[], capWhAt: (atMs: number) => number): TimedBody[] {
  const out: TimedBody[] = [];
  for (const row of rows) {
    for (let k = 0; k < 5; k++) {
      const atMs = rowMs(row) + k * MIN;
      out.push({ atMs, body: bodyFromRow(row, capWhAt(atMs), Math.round(atMs / MIN)) });
    }
  }
  return out;
}

export interface ObsExtra {
  online?: boolean;
  latched?: boolean;
  witness?: string | null;
  grid?: PoolObservation['grid'];
}
/** The observation the store would hand the tracker for one body: the real reader, the real projection, the real witness. */
export function observe(atMs: number, body: Body, extra: ObsExtra = {}): PoolObservation {
  return {
    atMs,
    online: extra.online ?? true,
    latched: extra.latched ?? false,
    witness: extra.witness === undefined ? shp2ContentWitness(projectShp2(body)) : extra.witness,
    diag: poolDiagFromRaw(body),
    grid: extra.grid === undefined ? { present: true, presenceUnknown: false } : extra.grid,
  };
}

export interface Folded { state: PoolOutState; steps: PoolOutStep[] }
/** Fold a list of observations through the real tracker. */
export function fold(state: PoolOutState, observations: PoolObservation[]): Folded {
  const steps: PoolOutStep[] = [];
  let s = state;
  for (const o of observations) {
    const step = advancePoolOut(s, o);
    steps.push(step);
    s = step.state;
  }
  return { state: s, steps };
}
export const foldBodies = (state: PoolOutState, bodies: TimedBody[], extra: ObsExtra = {}): Folded =>
  fold(state, bodies.map((b) => observe(b.atMs, b.body, extra)));

/** Sat 2026-11-14 23:00 MST: the instant the rule tests count their minutes from. */
export const T0 = Date.UTC(2026, 10, 15, 6, 0, 0);
export const at = (minutes: number): number => T0 + Math.round(minutes * MIN);

/** A healthy three-Core body (the shape of the hour before the loss). */
export const healthyBody = (seq: number, o: Partial<SynthOpts> = {}): Body =>
  synthBody({ seq, slots: [{ pct: 72, w: -710 }, { pct: 66, w: -637 }, { pct: 63, w: -601 }], poolPct: 67, ...o });
/** Slot 1 out, the shape of 2026-11-14: one Core's capacity short, slot 1 at 0 W, the pool the mean of slots 2 and 3. */
export const lostBody = (seq: number, o: Partial<SynthOpts> = {}): Body =>
  synthBody({ seq, capWh: 2 * SLOT_WH, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -1107 }, { pct: 63, w: -1061 }], poolPct: 64, ...o });
/** One Core's capacity short with nothing else to go by: every slot idle at one percent (capacity alone). */
export const quietLostBody = (seq: number, o: Partial<SynthOpts> = {}): Body =>
  synthBody({ seq, capWh: 2 * SLOT_WH, slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0 }, { pct: 60, w: 0 }], poolPct: 60, ...o });
/** All three in and idle at one percent: capacity healthy, nothing else to judge. */
export const quietBody = (seq: number, o: Partial<SynthOpts> = {}): Body =>
  synthBody({ seq, slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0 }, { pct: 60, w: 0 }], poolPct: 60, ...o });

/** `count` observations a minute apart from minute `from`, each from `make(seq)`. */
export function minutes(from: number, count: number, make: (seq: number) => Body, extra: ObsExtra = {}): PoolObservation[] {
  return Array.from({ length: count }, (_, i) => observe(at(from + i), make(from + i), extra));
}

/** A state with the reference adopted: fifteen healthy minutes ending just before minute 0. */
export function withReference(make: (seq: number) => Body = healthyBody): PoolOutState {
  return fold(emptyPoolOutState(), minutes(-15, 15, make)).state;
}

/** A state with slot 1 out and the alarm standing since minute 10 (raised by the 10-minute dwell), at minute `upTo`. */
export function withEpisode(upTo = 10): PoolOutState {
  return fold(withReference(), minutes(0, upTo + 1, lostBody)).state;
}
