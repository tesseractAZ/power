/**
 * poolOut.ts — v1.208.0: a Core out of the panel's backup pool. The tracker, its state file's parser, and the words.
 *
 * WHAT HAPPENED. Sat 2026-11-14 23:35 MST the panel's pool capacity fell from 92.16 to 61.44 kWh: one Core's 30.72 kWh.
 * For 44.5 hours that slot delivered and took exactly 0 W while the other two carried the house, the pool percent became
 * the mean of two slots, and the panel went on listing three slots as connected with no error code. The add-on logged
 * nothing at the loss and nothing at the return.
 *
 * WHAT THIS MODULE IS. Pure functions over one REST body at a time (ecoflow/poolDiag.ts reads it): time and state are
 * arguments, nothing here reads a clock, a file or the network. The store folds each body through advancePoolOut and
 * persists the state; the alert, the return notice and the log lines are built here as text from that state.
 *
 * THE RULE IN ONE PARAGRAPH. Only the CAPACITY raises: the panel's pool capacity K against the sum E of its slots'
 * capacities, short by a whole number of slots. The pool percent (PCT) and each slot's share of the load (FLOW) can
 * NAME the slot and shorten the dwell from 15 minutes to 10; they never raise alone. The panel's flags (FLAG) are quoted
 * and nothing more: their meanings are unverified, so they never name a slot, never shorten a dwell and never block a
 * clear. A raise needs a dwell, a clear needs capacity evidence held for a dwell, and neither is made by a restart, a
 * skipped body, a stale shadow, a missing panel or age.
 *
 * NOT ESTABLISHED (one event and one raw sample are on record): the fault-time value of every flag but two, and whether
 * the lost slot's own capacity changes. The two: the slot stayed listed as connected (the add-on's membership history
 * follows that flag and holds no change in those hours) with no error code (the source-error rule reads it and did not
 * fire). The capacity rule itself was checked against 4,114 hourly rows of Home Assistant's statistics: 4,060 at 92.2 kWh,
 * 44 at 61.4 (this event) and the other 10 in six earlier dips: four of minutes (one to 0.0 kWh, three to 61.4 kWh) and
 * two of tens of minutes (to 30.7 kWh). Their causes are not established here, and a drop that lasts a dwell raises
 * whatever its cause: that is why capacity alone needs the full 15 minutes.
 */
import { SHP2_SOURCE_SLOTS } from './hwSpec.js';
import { zonedParts, type SiteParts } from './siteTime.js';
import { type PoolDiag, type PoolDiagSlot, type ErrList, ERR_ENTRIES_KEPT, renderEnum, renderErrorCode, renderErrEntries } from './ecoflow/poolDiag.js';

/* ───────────────────────────── constants ───────────────────────────── */

/** CAP: the capacity is "equal" within this many Wh (one sixth of a pack). */
export const POOL_OUT_CAP_TOLERANCE_WH = 1024;
/** PCT: the pool percent matches a mean within this many points. */
export const POOL_OUT_PCT_MATCH_PTS = 0.75;
/** PCT: the pool percent is apart from a mean beyond this many points. */
export const POOL_OUT_PCT_APART_PTS = 1.5;
/** FLOW: a slot delivering less than this fraction of its expected share carries no share. */
export const POOL_OUT_FLOW_SHARE_MIN = 0.2;
/** FLOW: a slot is judged only when its expected share is at least this many watts. */
export const POOL_OUT_FLOW_MIN_EXPECTED_W = 150;
/** FLOW: the pool is judged only while it discharges at least this many watts in total. */
export const POOL_OUT_FLOW_MIN_TOTAL_W = 300;
/** FLOW: a slot taking more than this many watts is charging, and nothing is judged. */
export const POOL_OUT_FLOW_CHARGING_W = 50;

/** Raise with a second signal: this many STRONG observations… */
export const POOL_OUT_STRONG_MIN_OBS = 6;
/** …spanning at least this long. */
export const POOL_OUT_STRONG_MIN_MS = 10 * 60_000;
/** Raise on capacity alone: this many counted observations of any raising class… */
export const POOL_OUT_SLOW_MIN_OBS = 15;
/** …spanning at least this long. */
export const POOL_OUT_SLOW_MIN_MS = 15 * 60_000;
/** A streak whose next counted observation comes later than this starts again (data time on both sides). */
export const POOL_OUT_STREAK_MAX_GAP_MS = 15 * 60_000;
/** A streak is reset only by this many consecutive IN observations… */
export const POOL_OUT_IN_RESET_OBS = 3;
/** …spanning at least this long. */
export const POOL_OUT_IN_RESET_MS = 2 * 60_000;
/** The tracker's own memory of body witnesses: a body is counted only if absent from it. */
export const POOL_OUT_WITNESS_RING = 30;
/** Flap rule: this many confirmed loss steps… */
export const POOL_OUT_FLAP_STEPS = 3;
/** …each of at least this many consecutive fault observations… */
export const POOL_OUT_FLAP_STEP_MIN_OBS = 2;
/** …inside this window raise. */
export const POOL_OUT_FLAP_WINDOW_MS = 60 * 60_000;
/** A body skipped for the same reason this many polls running is turned into a vote (where one is defined). */
export const POOL_OUT_SKIP_CONVERT_POLLS = 5;
/** No usable observation for this long while the panel is fresh: one WARN line. */
export const POOL_OUT_BLIND_WARN_MS = 30 * 60_000;
/** Clear on capacity alone: this many CAP-healthy observations… */
export const POOL_OUT_CLEAR_MIN_OBS = 18;
/** …spanning at least this long. */
export const POOL_OUT_CLEAR_MIN_MS = 30 * 60_000;
/** Clear with power or percent evidence for the returned slot: this many… */
export const POOL_OUT_FAST_CLEAR_MIN_OBS = 6;
/** …spanning at least this long. */
export const POOL_OUT_FAST_CLEAR_MIN_MS = 10 * 60_000;
/** The reference is adopted after CAP has read healthy for this many observations… */
export const POOL_OUT_ADOPT_MIN_OBS = 6;
/** …spanning at least this long. */
export const POOL_OUT_ADOPT_MIN_MS = 10 * 60_000;
/** Critical by the grid needs this many consecutive usable observations with no grid… */
export const POOL_OUT_GRID_READINGS = 3;
/** …each no older than this at the last of them. */
export const POOL_OUT_GRID_MAX_AGE_MS = 5 * 60_000;
/** The Home Assistant sensor reads OFF only while the newest capacity verdict is at most this old. */
export const POOL_OUT_SENSOR_FRESH_MS = 15 * 60_000;
/** The detail says "No new panel reading since…" once the newest usable observation is older than this. */
export const POOL_OUT_STALE_NOTE_MS = 5 * 60_000;
/** A held contradiction, a NOCAP reading or an unexplained capacity is logged at most this often. */
export const POOL_OUT_NOTE_EVERY_MS = 30 * 60_000;
/** An end record (the return notice's content) is kept this long. */
export const POOL_OUT_END_KEEP_MS = 24 * 60 * 60_000;
/** A percent step of at least this many points… */
export const POOL_OUT_STEP_MIN_PTS = 3;
/** …between two readings at most this far apart is a membership step (no energy flow moves the pool that fast). */
export const POOL_OUT_STEP_MAX_GAP_MS = 5 * 60_000;
/** Set changes remembered per episode. */
const POOL_OUT_CHANGES_KEPT = 8;

/** The alert's id on the house panel; a secondary panel's is this plus "-<panel serial>" (the existing convention). */
export const POOL_OUT_ALERT_ID = 'shp2-pool-out';

/* ───────────────────────────── types ───────────────────────────── */

/** One REST body of one panel, as the store hands it over. `atMs` is DATA time: when the body was received. */
export interface PoolObservation {
  atMs: number;
  /** O1: the panel is listed online. */
  online: boolean;
  /** The body's content witness (shp2Shadow.ts shp2ContentWitness); null when none can be formed. */
  witness: string | null;
  /** The store's shadow latch AFTER this poll. */
  latched: boolean;
  diag: PoolDiag;
  /** The add-on's grid verdict for this panel at this body (gridState.ts); null when none exists. */
  grid: { present: boolean; presenceUnknown: boolean } | null;
}

export type PoolOutClass = 'STRONG' | 'SLOW' | 'NOCAP' | 'IN' | 'HOLD';
export type PoolSkipReason = 'offline' | 'no-witness' | 'latched' | 'replayed' | 'no-capacity' | 'zero-capacity' | 'incoherent' | 'no-roster' | 'no-isconnect';
/** Why the capacity could not be judged for the blind WARN: a body that was skipped, or one whose capacity verdict is unknown. */
export type PoolBlindReason = PoolSkipReason | 'no-slot-capacity' | 'listed-mismatch' | 'over' | 'not-slot-sized';
export type PoolGridReading = 'present' | 'absent' | 'unknown';
/** Why CAP itself names a slot. */
export type PoolCapWhy = 'not-connected' | 'not-listed' | 'no-capacity' | 'all-out';

export interface CapVerdict {
  v: 'fault' | 'healthy' | 'unknown';
  reason: 'no-capacity' | 'no-slot-capacity' | 'listed-mismatch' | 'over' | 'not-slot-sized' | null;
  /** K: the panel's raw pool capacity. */
  countedWh: number | null;
  /** E: the sum over the roster of each slot's capacity (its reference value when the current one is 0 or absent). */
  expectedWh: number | null;
  /** How many slots the difference matches. */
  k: number | null;
  /** The set CAP names by its own evidence (a slot not connected, not listed, or without its capacity). */
  named: number[] | null;
  why: PoolCapWhy | null;
  /** Every set of k slots whose capacities match the difference. */
  candidates: number[][];
}
export interface PctVerdict {
  v: 'fault' | 'consistent' | 'unknown';
  set: number[] | null;
  poolPct: number | null;
  meanAll: number | null;
  /** Slots whose absence the pool percent would show (the percent is evidence for them when it is consistent). */
  separable: number[];
}
export interface FlowSlot { slot: number; w: number; expectedW: number; v: 'fault' | 'healthy' | 'unjudged' }
export interface FlowVerdict {
  v: 'fault' | 'healthy' | 'partial' | 'unknown';
  reason: 'missing' | 'charging' | 'idle' | 'no-headroom' | null;
  /** The slots that carry no share. */
  set: number[];
  totalW: number | null;
  slots: FlowSlot[];
}
/** One slot value that differs from the slot's reference value or from every other slot's current value. */
export interface PoolFlagItem {
  slot: number;
  key: string;
  value: string;
  /** The other slots' values, when this one differs from all of them. */
  others: string[] | null;
  /** The slot's own reference value, when this one differs from it. */
  earlier: string | null;
}
export interface FlagVerdict {
  /** fault: a value differs from its reference AND from every other slot, or a slot reports an error code. Never healthy. */
  v: 'fault' | 'unknown';
  items: PoolFlagItem[];
  codes: Array<{ slot: number; code: number }>;
}
/** The observation that named a set (kept for the alarm's "observed" sentence and for the return notice). */
export interface PoolOutEvidence {
  atMs: number;
  by: 'flow' | 'pct' | 'cap';
  slots: number[];
  /** by flow: every roster slot's delivered watts. */
  w: Array<{ slot: number; w: number }> | null;
  /** by pct: the pool percent. */
  poolPct: number | null;
  /** by flow and by pct: every roster slot's percent at that observation. */
  pcts: Array<{ slot: number; pct: number }> | null;
  /** by cap: why. */
  why: PoolCapWhy | null;
}
export interface PoolSignals {
  roster: number[];
  cap: CapVerdict;
  pct: PctVerdict;
  flow: FlowVerdict;
  flag: FlagVerdict;
  cls: PoolOutClass;
  /** The out set this observation names (all k slots), or null: the count only. */
  named: number[] | null;
  evidence: PoolOutEvidence | null;
}

/** The slot values FLAG compares (rendered as the panel sent them; null: not sent). */
export type PoolFlagValues = Record<string, string | null>;
export interface PoolOutBaseline {
  adoptedAtMs: number;
  roster: number[];
  slotCapWh: Record<string, number>;
  poolCapWh: number;
  flags: Record<string, PoolFlagValues>;
}
export interface PoolOutBefore { atMs: number; capWh: number; pct: number | null }
export interface PoolOutRun { firstMs: number; lastMs: number; n: number }
export interface PoolOutStreak {
  firstMs: number;
  lastMs: number;
  /** Counted observations (STRONG or SLOW). */
  counted: number;
  strong: number;
  firstStrongMs: number | null;
  lastStrongMs: number | null;
  /** Counted observations since the last IN (the flap rule's "consecutive"). */
  run: number;
  /** This streak already counted as a loss step. */
  stepped: boolean;
  k: number;
  slots: number[] | null;
  /** Two observations of this streak named different sets: the set is not established. */
  conflict: boolean;
  /** The readings that named `slots`: a set is latched into the title only from POOL_OUT_STRONG_MIN_OBS of them
   *  spanning POOL_OUT_STRONG_MIN_MS, never from one reading. */
  names: PoolOutRun | null;
  countedWh: number;
  expectedWh: number;
  before: PoolOutBefore | null;
  evidence: PoolOutEvidence | null;
  /** A LARGER count read inside this streak, on its way through a dwell of its own. `k` here is the SMALLEST count
   *  this streak's readings support ("at least k slots short"); a reading that is more slots short counts toward this
   *  dwell, leaves this count, capacity and names alone, and is tallied here. */
  more: PoolOutStreak | null;
}
export interface PoolOutClearRun extends PoolOutRun {
  /** The first CAP-healthy observation of the run. */
  first: { atMs: number; capWh: number; pct: number | null };
  /** Slots seen carrying their share. */
  flowOk: number[];
  /** Slots the percent vouched for (consistent while the slot was separable). */
  pctOk: number[];
  /** An observation had every slot carrying its share. */
  allFlow: boolean;
  evidence: PoolOutEvidence | null;
}
export interface PoolOutEpisode {
  /** The first fault observation of the streak that raised (a flap raise: of its first loss step). */
  sinceMs: number;
  raisedAtMs: number;
  how: 'strong' | 'slow' | 'flap';
  /** Loss steps counted by a flap raise. */
  flapSteps: number;
  /** LATCHED: changes only on a dwell-confirmed set change. */
  k: number;
  /** LATCHED: the slots named out (all k, or fewer when a later one was not identified), or null. */
  slots: number[] | null;
  rosterSize: number;
  /** The reference pool capacity at the raise. */
  baselineWh: number;
  /** E and K of the dwell-confirmed observation (the severity reads these, never the live figure). */
  expectedWh: number;
  countedWh: number;
  /** A raise by the FLAP rule has no dwell behind it: its count and its capacity are those of the two readings of its
   *  third step. This is that step's tally, going on through a dwell of counted readings at the latched count or above
   *  it; until it has met one, the severity does not read the capacity. Null: the capacity is dwell-confirmed (every
   *  raise by a dwell, and every dwell-confirmed set change). */
  unconfirmed: PoolOutStreak | null;
  before: PoolOutBefore | null;
  /** The newest counted (STRONG or SLOW) observation: the return notice's "before" percent. */
  lastFault: { atMs: number; pct: number | null; capWh: number | null };
  evidence: PoolOutEvidence | null;
  /** Critical by the grid; persisted, scoped to the episode. */
  gridCritical: boolean;
  gridAbsentAtMs: number | null;
  /** A set that differs from the latched one at the latched count or above it, on its way through the dwell. */
  change: PoolOutStreak | null;
  /** FEWER slots short than the latched count, on its way through the dwell (`k`: the largest of the counts read, so
   *  "at most k short"). One reading at the latched count or above it ends it. */
  less: PoolOutStreak | null;
  clear: PoolOutClearRun | null;
  changes: Array<{ atMs: number; k: number; slots: number[] | null }>;
}
export interface PoolOutEnd {
  kind: 'returned' | 'capacity-only';
  /** When the clear dwell completed. */
  atMs: number;
  /** The first CAP-healthy observation of that dwell. */
  backAtMs: number;
  sinceMs: number;
  k: number;
  slots: number[] | null;
  rosterSize: number;
  capWh: number;
  remainWh: number | null;
  pct: number | null;
  pctBefore: number | null;
  pctBeforeAtMs: number | null;
  pctAfter: number | null;
  pctAfterAtMs: number | null;
  evidence: PoolOutEvidence | null;
  slotPct: Array<{ slot: number; pct: number | null }>;
}
/** The newest usable observation, kept for the alarm text and the debug view. */
export interface PoolOutLast {
  atMs: number;
  cls: PoolOutClass;
  cap: { v: CapVerdict['v']; reason: CapVerdict['reason']; countedWh: number | null; expectedWh: number | null; k: number | null };
  pct: { v: PctVerdict['v']; set: number[] | null };
  flow: { v: FlowVerdict['v']; reason: FlowVerdict['reason']; set: number[]; totalW: number | null };
  flagFault: boolean;
  pool: { pct: number | null; fullCapWh: number | null; remainWh: number | null; coherent: boolean };
  slots: Array<{ slot: number; pct: number | null; isConnect: number | null; w: number | null; errorCodeNum: number | null }>;
  flags: PoolFlagItem[];
  panelFlags: Array<{ key: string; value: number }>;
  errLists: { backup: ErrList | null; master: ErrList | null; hall: ErrList | null };
  grid: PoolGridReading;
}
/** What happened in THIS process (never persisted): the boot orphan sweep holds this alert until one is true. */
export interface PoolOutProc {
  raised: boolean;
  cleanDwell: boolean;
  clean: PoolOutRun | null;
}
export interface PoolOutState {
  v: 1;
  baseline: PoolOutBaseline | null;
  /** The current run of CAP-healthy observations (the reference is adopted from it). */
  healthy: PoolOutRun | null;
  /** The current run of "capacity above the reference" observations (a grown roster is adopted from it). */
  grow: PoolOutRun | null;
  /** Keys of the last POOL_OUT_WITNESS_RING body witnesses. */
  ring: string[];
  skip: { reason: PoolSkipReason; n: number } | null;
  /** Since when the capacity could not be judged on a fresh panel, and the newest such body (`lastMs`: a gap in the
   *  bodies themselves, a restart or an outage, is not time the panel was fresh, and starts the clock again). */
  blind: { sinceMs: number; lastMs: number; warned: boolean } | null;
  /** The newest usable observation. */
  lastUsableMs: number | null;
  /** The newest usable observation whose capacity verdict was healthy or fault. */
  lastCapMs: number | null;
  lastHealthy: PoolOutBefore | null;
  inRun: PoolOutRun | null;
  streak: PoolOutStreak | null;
  /** First-fault times of the confirmed loss steps inside the flap window. */
  flaps: number[];
  episode: PoolOutEpisode | null;
  ends: PoolOutEnd[];
  last: PoolOutLast | null;
  /** The grid readings of the last POOL_OUT_GRID_READINGS usable observations. */
  grid: Array<{ atMs: number; g: PoolGridReading }>;
  /** When each kind of note was last logged. */
  noted: Record<string, number>;
  proc: PoolOutProc;
}

export type PoolOutEvent =
  | { type: 'first-fault'; atMs: number }
  | { type: 'raised'; atMs: number; how: 'strong' | 'slow' | 'flap' }
  | { type: 'set-changed'; atMs: number }
  | { type: 'severity'; atMs: number; severity: 'warning' | 'critical' }
  | { type: 'cleared'; atMs: number; kind: 'returned' | 'capacity-only' }
  | { type: 'baseline'; atMs: number }
  | { type: 'blind'; atMs: number; reason: PoolBlindReason };
export interface PoolOutLog { level: 'info' | 'warn'; text: string }
export interface PoolOutStep {
  state: PoolOutState;
  /** Null when the body was skipped. */
  signals: PoolSignals | null;
  /** Why the body was skipped; null when it was used (as it came, or converted). */
  skip: PoolSkipReason | null;
  /** How a body that would have been skipped was turned into a vote. */
  converted: 'all-out' | 'cap-unknown' | 'not-listed' | null;
  events: PoolOutEvent[];
  logs: PoolOutLog[];
  /** Something changed that is worth writing at once (the store otherwise refreshes the file at most once a minute,
   *  and only while a streak or an episode stands). */
  changed: boolean;
}

/* ───────────────────────────── small helpers ───────────────────────────── */

const sameSet = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function subsetsOfSize(items: number[], size: number): number[][] {
  if (size === 0) return [[]];
  if (size > items.length) return [];
  const out: number[][] = [];
  for (let i = 0; i <= items.length - size; i++) {
    for (const rest of subsetsOfSize(items.slice(i + 1), size - 1)) out.push([items[i], ...rest]);
  }
  return out;
}

const slotOf = (diag: PoolDiag, n: number): PoolDiagSlot | undefined => diag.slots.find((x) => x.slot === n);

/** A short key for one witness string (cyrb53): the ring holds thirty of these, not thirty payload fingerprints. */
export function poolWitnessKey(witness: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < witness.length; i++) {
    const ch = witness.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const extendRun = (run: PoolOutRun | null, atMs: number): PoolOutRun =>
  run ? { firstMs: run.firstMs, lastMs: atMs, n: run.n + 1 } : { firstMs: atMs, lastMs: atMs, n: 1 };
const runMet = (run: PoolOutRun | null, minObs: number, minMs: number): boolean =>
  run != null && run.n >= minObs && run.lastMs - run.firstMs >= minMs;

/* ───────────────────────────── the four signals ───────────────────────────── */

/** The roster the signals are judged over: the reference's, or the slots listed connected when no reference exists. */
export function poolRoster(diag: PoolDiag, baseline: PoolOutBaseline | null): number[] {
  if (baseline) return [...baseline.roster];
  return diag.slots.filter((x) => x.isConnect === 1).map((x) => x.slot).sort((a, b) => a - b);
}

/** Each roster slot's capacity: its current one, else its reference one. Null entries: neither exists. */
function slotCaps(diag: PoolDiag, roster: number[], baseline: PoolOutBaseline | null): Array<number | null> {
  return roster.map((n) => {
    const cur = slotOf(diag, n)?.fullCapWh ?? null;
    if (cur != null && cur > 0) return cur;
    const ref = baseline?.slotCapWh[String(n)] ?? null;
    return ref != null && ref > 0 ? ref : null;
  });
}

interface SignalOpts { allOut?: boolean; capUnknown?: boolean; notListed?: number[] }

function capVerdict(diag: PoolDiag, roster: number[], baseline: PoolOutBaseline | null, opts: SignalOpts): CapVerdict {
  const none = { k: null, named: null, why: null, candidates: [] as number[][] };
  const caps = slotCaps(diag, roster, baseline);
  const expectedWh = caps.every((c) => c != null) ? (caps as number[]).reduce((a, b) => a + b, 0) : null;
  if (opts.allOut) {
    // The capacity read zero for POOL_OUT_SKIP_CONVERT_POLLS polls running, with a reference: every slot is out.
    return { v: 'fault', reason: null, countedWh: 0, expectedWh: expectedWh ?? baseline?.poolCapWh ?? null, k: roster.length, named: [...roster], why: 'all-out', candidates: [[...roster]] };
  }
  const countedWh = opts.capUnknown ? null : diag.pool.fullCapWh;
  if (countedWh == null) return { v: 'unknown', reason: 'no-capacity', countedWh: null, expectedWh, ...none };
  if (expectedWh == null) return { v: 'unknown', reason: 'no-slot-capacity', countedWh, expectedWh: null, ...none };
  const notListed = opts.notListed ?? [];
  const notConnected = roster.filter((n) => { const c = slotOf(diag, n)?.isConnect ?? null; return c != null && c !== 1; });
  const lostCap = roster.filter((n) => !((slotOf(diag, n)?.fullCapWh ?? 0) > 0));
  const short = expectedWh - countedWh;
  if (Math.abs(short) <= POOL_OUT_CAP_TOLERANCE_WH) {
    // Equal — but a slot the panel does not list as connected, at an unchanged capacity, is neither state.
    if (notConnected.length === 0 && notListed.length === 0) return { v: 'healthy', reason: null, countedWh, expectedWh, ...none };
    return { v: 'unknown', reason: 'listed-mismatch', countedWh, expectedWh, ...none };
  }
  if (short < 0) return { v: 'unknown', reason: 'over', countedWh, expectedWh, ...none };
  // Short: by a whole number of slots? A proper subset only — every slot out is the zero-capacity conversion above.
  let candidates: number[][] = [];
  for (let size = 1; size < roster.length && candidates.length === 0; size++) {
    candidates = subsetsOfSize(roster, size).filter((set) => {
      const sum = set.reduce((a, n) => a + (caps[roster.indexOf(n)] as number), 0);
      return Math.abs(short - sum) <= POOL_OUT_CAP_TOLERANCE_WH;
    });
  }
  if (candidates.length === 0) return { v: 'unknown', reason: 'not-slot-sized', countedWh, expectedWh, ...none };
  const own = [...new Set([...notConnected, ...notListed, ...lostCap])].sort((a, b) => a - b);
  const named = own.length > 0 && candidates.some((c) => sameSet(c, own)) ? own : null;
  const why: PoolCapWhy | null = named == null ? null
    : named.every((n) => notListed.includes(n)) ? 'not-listed'
      : named.every((n) => notConnected.includes(n)) ? 'not-connected' : 'no-capacity';
  return { v: 'fault', reason: null, countedWh, expectedWh, k: candidates[0].length, named, why, candidates };
}

function pctVerdict(diag: PoolDiag, roster: number[], baseline: PoolOutBaseline | null, k: number | null, opts: SignalOpts): PctVerdict {
  const poolPct = diag.pool.pct;
  const pcts = roster.map((n) => slotOf(diag, n)?.pct ?? null);
  const unknown: PctVerdict = { v: 'unknown', set: null, poolPct, meanAll: null, separable: [] };
  if (opts.allOut || poolPct == null || roster.length < 2 || pcts.some((p) => p == null)) return unknown;
  // The pool percent is the capacity-weighted mean of its slots (equal thirds on equal Cores).
  const caps = slotCaps(diag, roster, baseline);
  const weights = caps.every((c) => c != null) ? (caps as number[]) : roster.map(() => 1);
  const meanOf = (keep: number[]): number => {
    let num = 0;
    let den = 0;
    for (const n of keep) { const i = roster.indexOf(n); num += weights[i] * (pcts[i] as number); den += weights[i]; }
    return num / den;
  };
  const without = (set: number[]): number[] => roster.filter((n) => !set.includes(n));
  const meanAll = meanOf(roster);
  const separable = roster.filter((n) => Math.abs(poolPct - meanOf(without([n]))) > POOL_OUT_PCT_APART_PTS);
  const apart = Math.abs(poolPct - meanAll);
  if (apart <= POOL_OUT_PCT_MATCH_PTS) return { v: 'consistent', set: null, poolPct, meanAll, separable };
  if (apart > POOL_OUT_PCT_APART_PTS) {
    // The size comes from CAP when CAP gave one; otherwise the smallest size that matches at all.
    const sizes = k != null ? [k] : roster.slice(1).map((_, i) => i + 1);
    for (const size of sizes) {
      if (size < 1 || size >= roster.length) continue;
      const matches = subsetsOfSize(roster, size).filter((set) => Math.abs(poolPct - meanOf(without(set))) <= POOL_OUT_PCT_MATCH_PTS);
      if (matches.length === 1) return { v: 'fault', set: matches[0], poolPct, meanAll, separable };
      if (matches.length > 1) break;
    }
  }
  return { v: 'unknown', set: null, poolPct, meanAll, separable };
}

function flowVerdict(diag: PoolDiag, roster: number[]): FlowVerdict {
  const unknown = (reason: FlowVerdict['reason'], totalW: number | null = null): FlowVerdict => ({ v: 'unknown', reason, set: [], totalW, slots: [] });
  const rows = roster.map((n) => slotOf(diag, n));
  const reserve = diag.reserveSoc;
  if (reserve == null || rows.some((r) => r == null || r.chWatt == null || r.inputW == null || r.pct == null)) return unknown('missing');
  const slots = rows as PoolDiagSlot[];
  if (slots.some((r) => (r.chWatt as number) > POOL_OUT_FLOW_CHARGING_W || (r.inputW as number) > POOL_OUT_FLOW_CHARGING_W)) return unknown('charging');
  const delivered = slots.map((r) => Math.max(0, -(r.chWatt as number)));
  const totalW = delivered.reduce((a, b) => a + b, 0);
  if (totalW < POOL_OUT_FLOW_MIN_TOTAL_W) return unknown('idle', totalW);
  const headroom = slots.map((r) => Math.max(0, (r.pct as number) - reserve));
  const headroomAll = headroom.reduce((a, b) => a + b, 0);
  if (!(headroomAll > 0)) return unknown('no-headroom', totalW);
  const judged: FlowSlot[] = slots.map((r, i) => {
    const expectedW = (totalW * headroom[i]) / headroomAll;
    const v: FlowSlot['v'] = expectedW < POOL_OUT_FLOW_MIN_EXPECTED_W ? 'unjudged'
      : delivered[i] < POOL_OUT_FLOW_SHARE_MIN * expectedW ? 'fault' : 'healthy';
    return { slot: r.slot, w: delivered[i], expectedW, v };
  });
  const set = judged.filter((j) => j.v === 'fault').map((j) => j.slot);
  const v: FlowVerdict['v'] = set.length > 0 ? 'fault' : judged.every((j) => j.v === 'healthy') ? 'healthy' : 'partial';
  return { v, reason: null, set, totalW, slots: judged };
}

/** The keys FLAG compares, as the panel names them (n: the slot). */
const FLAG_KEYS: Array<{ key: (n: number) => string; of: (s: PoolDiagSlot) => string | null }> = [
  { key: () => 'isConnect', of: (s) => (s.isConnect == null ? null : String(s.isConnect)) },
  { key: () => 'hwConnect', of: (s) => (s.hwConnect == null ? null : String(s.hwConnect)) },
  { key: () => 'isEnable', of: (s) => (s.isEnable == null ? null : String(s.isEnable)) },
  { key: (n) => `ch${n}EnableSet`, of: (s) => (s.enableSet == null ? null : String(s.enableSet)) },
  { key: () => 'isAcOpen', of: (s) => (s.isAcOpen == null ? null : String(s.isAcOpen)) },
  { key: () => 'isPowerOutput', of: (s) => (s.isPowerOutput == null ? null : String(s.isPowerOutput)) },
  { key: (n) => `ch${n}Info.backupIsReady`, of: (s) => (s.backupIsReady == null ? null : String(s.backupIsReady)) },
  { key: (n) => `ch${n}Info.ctrlSta`, of: (s) => (s.ctrlSta == null ? null : renderEnum(s.ctrlSta)) },
  { key: () => 'devInfo.fullCap', of: (s) => (s.fullCapWh == null ? null : String(s.fullCapWh)) },
];

/** One slot's FLAG values, keyed by position in FLAG_KEYS (the key's name carries the slot number, so it is not the key). */
export function poolFlagValues(slot: PoolDiagSlot): PoolFlagValues {
  const out: PoolFlagValues = {};
  FLAG_KEYS.forEach((f, i) => { out[String(i)] = f.of(slot); });
  return out;
}

function flagVerdict(diag: PoolDiag, roster: number[], baseline: PoolOutBaseline | null): FlagVerdict {
  const rows = roster.map((n) => slotOf(diag, n)).filter((r): r is PoolDiagSlot => r != null);
  const items: PoolFlagItem[] = [];
  let vote = false;
  for (const r of rows) {
    const ref = baseline?.flags[String(r.slot)] ?? null;
    FLAG_KEYS.forEach((f, i) => {
      const value = f.of(r);
      if (value == null) return;
      const siblings = rows.filter((o) => o.slot !== r.slot).map((o) => f.of(o));
      const fromOthers = siblings.length > 0 && siblings.every((v) => v !== value);
      const was = ref ? ref[String(i)] ?? null : null;
      const fromRef = was != null && was !== value;
      if (!fromOthers && !fromRef) return;
      if (fromOthers && fromRef) vote = true;
      items.push({
        slot: r.slot,
        key: f.key(r.slot),
        value,
        others: fromOthers ? [...new Set(siblings.map((v) => v ?? 'not sent'))] : null,
        earlier: fromRef ? was : null,
      });
    });
  }
  const codes = rows.filter((r) => r.errorCodeNum != null && r.errorCodeNum !== 0).map((r) => ({ slot: r.slot, code: r.errorCodeNum as number }));
  return { v: vote || codes.length > 0 ? 'fault' : 'unknown', items, codes };
}

/** The class of one observation. FLAG has no say in it. */
function classify(cap: CapVerdict, pct: PctVerdict, flow: FlowVerdict): PoolOutClass {
  if (cap.v === 'fault') {
    if (pct.v === 'fault' || flow.v === 'fault') return 'STRONG';
    // Capacity short while every slot carries its share is a contradiction: held, not counted.
    return flow.v === 'healthy' ? 'HOLD' : 'SLOW';
  }
  if (cap.v === 'healthy') return 'IN';
  if (cap.reason === 'listed-mismatch') return 'HOLD';
  if (pct.v === 'fault' && flow.v === 'fault' && pct.set != null && sameSet(pct.set, flow.set)) return 'NOCAP';
  if (pct.v === 'consistent' && flow.v === 'healthy') return 'IN';
  return 'HOLD';
}

/** The set one observation names: only CAP's own evidence, PCT and FLOW may name, they must agree, and it must be k slots. */
function namedSet(cap: CapVerdict, pct: PctVerdict, flow: FlowVerdict): number[] | null {
  if (cap.v !== 'fault' || cap.k == null) return null;
  const namers: number[][] = [];
  if (cap.named) namers.push(cap.named);
  if (pct.v === 'fault' && pct.set) namers.push(pct.set);
  if (flow.v === 'fault') namers.push(flow.set);
  if (namers.length === 0) return null;
  const set = namers[0];
  if (!namers.every((n) => sameSet(n, set))) return null;
  if (set.length !== cap.k || !cap.candidates.some((c) => sameSet(c, set))) return null;
  // The percent alone does not name a slot that is seen carrying its share.
  if (flow.slots.some((f) => f.v === 'healthy' && set.includes(f.slot))) return null;
  return set;
}

function evidenceOf(atMs: number, diag: PoolDiag, roster: number[], named: number[], cap: CapVerdict, pct: PctVerdict, flow: FlowVerdict): PoolOutEvidence {
  const blank = { w: null, poolPct: null, pcts: null, why: null };
  if (flow.v === 'fault' && sameSet(flow.set, named)) {
    return { atMs, by: 'flow', slots: named, ...blank, w: flow.slots.map((f) => ({ slot: f.slot, w: Math.round(f.w) })), pcts: roster.map((n) => ({ slot: n, pct: slotOf(diag, n)?.pct as number })) };
  }
  if (pct.v === 'fault' && pct.set != null && sameSet(pct.set, named)) {
    return { atMs, by: 'pct', slots: named, ...blank, poolPct: pct.poolPct, pcts: roster.map((n) => ({ slot: n, pct: slotOf(diag, n)?.pct as number })) };
  }
  return { atMs, by: 'cap', slots: named, ...blank, why: cap.why };
}

/**
 * The four signals of one body against the reference, and the class they add up to. PURE.
 * `opts` carries a blind conversion (advancePoolOut decides it): every slot out, the capacity unknown, or slots the
 * panel no longer lists.
 */
export function poolSignals(diag: PoolDiag, baseline: PoolOutBaseline | null, atMs = 0, opts: SignalOpts = {}): PoolSignals {
  const roster = poolRoster(diag, baseline);
  const cap = capVerdict(diag, roster, baseline, opts);
  const pct = pctVerdict(diag, roster, baseline, cap.v === 'fault' ? cap.k : null, opts);
  const flow = flowVerdict(diag, roster);
  const flag = flagVerdict(diag, roster, baseline);
  const cls = classify(cap, pct, flow);
  const named = namedSet(cap, pct, flow);
  return { roster, cap, pct, flow, flag, cls, named, evidence: named ? evidenceOf(atMs, diag, roster, named, cap, pct, flow) : null };
}

/* ───────────────────────────── the fold ───────────────────────────── */

export function emptyPoolOutState(): PoolOutState {
  return {
    v: 1, baseline: null, healthy: null, grow: null, ring: [], skip: null, blind: null, lastUsableMs: null, lastCapMs: null,
    lastHealthy: null, inRun: null, streak: null, flaps: [], episode: null, ends: [], last: null, grid: [], noted: {},
    proc: { raised: false, cleanDwell: false, clean: null },
  };
}

const kwh = (wh: number): string => (wh / 1000).toFixed(1);
const pctText = (p: number): string => `${Number.isInteger(p) ? p : Number(p.toFixed(1))}%`;
const watts = (w: number): string => Math.round(w).toLocaleString('en-US');
function listText(items: Array<string | number>): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
const slotWord = (slots: number[]): string => `${slots.length === 1 ? 'slot' : 'slots'} ${listText(slots)}`;

/** The four verdicts in one log clause. Never a serial: this module is never given one. */
export function poolVerdictsText(sig: PoolSignals): string {
  const cap = sig.cap.v === 'fault'
    ? `capacity fault (${kwh(sig.cap.countedWh ?? 0)} of ${sig.cap.expectedWh == null ? '?' : kwh(sig.cap.expectedWh)} kWh, ${sig.cap.k} slot${sig.cap.k === 1 ? '' : 's'} short${sig.cap.named ? `, ${slotWord(sig.cap.named)} by the panel's own listing` : ''})`
    : sig.cap.v === 'healthy' ? `capacity healthy (${kwh(sig.cap.countedWh ?? 0)} kWh)`
      : `capacity unknown (${sig.cap.reason}${sig.cap.countedWh != null ? `, ${kwh(sig.cap.countedWh)} kWh` : ''}${sig.cap.expectedWh != null ? ` against ${kwh(sig.cap.expectedWh)} kWh` : ''})`;
  const pct = sig.pct.v === 'fault' ? `percent fault (${slotWord(sig.pct.set ?? [])})` : `percent ${sig.pct.v}`;
  const flow = sig.flow.v === 'fault' ? `power fault (${slotWord(sig.flow.set)})` : `power ${sig.flow.v}${sig.flow.reason ? ` (${sig.flow.reason})` : ''}`;
  const flag = sig.flag.v === 'fault'
    ? `flags differ (${[...sig.flag.codes.map((c) => `slot ${c.slot} ${renderErrorCode(c.code)}`), ...sig.flag.items.map((i) => `slot ${i.slot} ${i.key} ${i.value}`)].join(', ')})`
    : 'flags no vote';
  return `${cap}; ${pct}; ${flow}; ${flag}`;
}

function gridReading(obs: PoolObservation): PoolGridReading {
  const sta = obs.diag.gridSta;
  if (obs.grid == null || sta == null) return 'unknown';
  // Absent needs BOTH the add-on's verdict (absent, and not merely unheard) and the panel's own numeric reading.
  if (obs.grid.present === false && !obs.grid.presenceUnknown && sta !== 1) return 'absent';
  if (obs.grid.present === true && sta === 1) return 'present';
  return 'unknown';
}

function summarize(obs: PoolObservation, sig: PoolSignals, grid: PoolGridReading): PoolOutLast {
  const d = obs.diag;
  const panelFlags: Array<{ key: string; value: number }> = [];
  for (const [key, value] of [['masterRlyErrFlg', d.masterRlyErrFlg], ['ntcOverTempErr', d.ntcOverTempErr], ['reasonOfStopDischar', d.reasonOfStopDischar], ['reasonOsStopCharge', d.reasonOsStopCharge]] as Array<[string, number | null]>) {
    if (value != null && value !== 0) panelFlags.push({ key, value });
  }
  return {
    atMs: obs.atMs,
    cls: sig.cls,
    cap: { v: sig.cap.v, reason: sig.cap.reason, countedWh: sig.cap.countedWh, expectedWh: sig.cap.expectedWh, k: sig.cap.k },
    pct: { v: sig.pct.v, set: sig.pct.set },
    flow: { v: sig.flow.v, reason: sig.flow.reason, set: sig.flow.set, totalW: sig.flow.totalW },
    flagFault: sig.flag.v === 'fault',
    pool: { ...d.pool },
    slots: sig.roster.map((n) => {
      const r = slotOf(d, n);
      return { slot: n, pct: r?.pct ?? null, isConnect: r?.isConnect ?? null, w: r?.chWatt == null ? null : Math.max(0, -r.chWatt), errorCodeNum: r?.errorCodeNum ?? null };
    }),
    flags: sig.flag.items,
    panelFlags,
    errLists: { backup: d.errBackup, master: d.errMaster, hall: d.errHall },
    grid,
  };
}

function baselineFrom(obs: PoolObservation, roster: number[], capWh: number): PoolOutBaseline {
  const slotCapWh: Record<string, number> = {};
  const flags: Record<string, PoolFlagValues> = {};
  for (const n of roster) {
    const r = slotOf(obs.diag, n);
    if (r?.fullCapWh != null && r.fullCapWh > 0) slotCapWh[String(n)] = r.fullCapWh;
    if (r) flags[String(n)] = poolFlagValues(r);
  }
  return { adoptedAtMs: obs.atMs, roster: [...roster], slotCapWh, poolCapWh: capWh, flags };
}

/** What a reference means for the capacity rule (its flags are refreshed in silence). */
const baselineShape = (b: PoolOutBaseline): string => JSON.stringify([b.roster, b.roster.map((n) => b.slotCapWh[String(n)] ?? null), b.poolCapWh]);

function newStreak(obs: PoolObservation, sig: PoolSignals, before: PoolOutBefore | null): PoolOutStreak {
  return {
    firstMs: obs.atMs, lastMs: obs.atMs, counted: 0, strong: 0, firstStrongMs: null, lastStrongMs: null, run: 0, stepped: false,
    k: sig.cap.k as number, slots: null, conflict: false, names: null, countedWh: sig.cap.countedWh as number, expectedWh: sig.cap.expectedWh as number,
    before, evidence: null, more: null,
  };
}

/** The naming of a streak starts again (its count moved, or two readings named different sets). */
function forgetNames(st: PoolOutStreak, conflict: boolean): void {
  st.slots = null;
  st.conflict = conflict;
  st.names = null;
  st.evidence = null;
}

/** One STRONG or SLOW observation toward a streak's dwell: nothing about its count, its capacity or its names. */
function countDwell(st: PoolOutStreak, obs: PoolObservation, sig: PoolSignals): void {
  st.lastMs = obs.atMs;
  st.counted += 1;
  st.run += 1;
  if (sig.cls === 'STRONG') {
    st.strong += 1;
    st.firstStrongMs ??= obs.atMs;
    st.lastStrongMs = obs.atMs;
  }
}

/** What a reading AT the streak's own count says: the capacity the severity will read, and the set it names. */
function countNames(st: PoolOutStreak, obs: PoolObservation, sig: PoolSignals): void {
  st.countedWh = sig.cap.countedWh as number;
  st.expectedWh = sig.cap.expectedWh as number;
  if (sig.named == null || st.conflict) return;
  if (st.slots != null && !sameSet(st.slots, sig.named)) { forgetNames(st, true); return; }
  st.slots = sig.named;
  st.names = extendRun(st.names, obs.atMs);
  if (sig.evidence && (st.evidence == null || st.evidence.by !== 'flow' || sig.evidence.by === 'flow')) st.evidence = sig.evidence;
}

const withinStreakGap = (st: PoolOutStreak, atMs: number): boolean => atMs - st.lastMs >= 0 && atMs - st.lastMs <= POOL_OUT_STREAK_MAX_GAP_MS;

/** A tally's dwell starts again from `atMs`: nothing counted yet (its count, capacity and names are left alone). */
function restartTally(st: PoolOutStreak, atMs: number): void {
  st.firstMs = atMs;
  st.lastMs = atMs;
  st.counted = 0;
  st.strong = 0;
  st.firstStrongMs = null;
  st.lastStrongMs = null;
  st.run = 0;
}

/**
 * Count one STRONG or SLOW observation into a streak (the pre-raise streak, or an episode's pending set change).
 *
 * A streak's count is the SMALLEST its readings support: "at least k slots short". The count, the capacity and the
 * names a raise latches must each rest on a dwell of their own, never on the one reading that completes it:
 *  - a reading MORE slots short counts toward this dwell (the pool is at least this short) and changes nothing else
 *    here; the larger count runs a dwell of its own in `more`;
 *  - a reading FEWER slots short takes the streak over (every reading so far was at least that short), with its
 *    naming started again; the count it replaces keeps its tally in `more`.
 */
function countInto(st: PoolOutStreak, obs: PoolObservation, sig: PoolSignals): void {
  const k = sig.cap.k as number;
  if (k < st.k) {
    st.more = { ...st, before: null, more: st.more };
    st.k = k;
    forgetNames(st, false);
  }
  countDwell(st, obs, sig);
  if (k > st.k) {
    if (st.more != null && !withinStreakGap(st.more, obs.atMs)) st.more = null;
    st.more ??= newStreak(obs, sig, null);
    countInto(st.more, obs, sig);
    return;
  }
  countNames(st, obs, sig);
}

/** Has a streak earned a raise (or a set change)? */
function dwellMet(st: PoolOutStreak): 'strong' | 'slow' | null {
  if (st.strong >= POOL_OUT_STRONG_MIN_OBS && st.firstStrongMs != null && st.lastStrongMs != null && st.lastStrongMs - st.firstStrongMs >= POOL_OUT_STRONG_MIN_MS) return 'strong';
  if (st.counted >= POOL_OUT_SLOW_MIN_OBS && st.lastMs - st.firstMs >= POOL_OUT_SLOW_MIN_MS) return 'slow';
  return null;
}

/** The set a streak may put in the title: the one its readings named, on the STRONG dwell's count and span of them.
 *  One reading naming a slot names nothing. */
function confirmedNames(st: PoolOutStreak): number[] | null {
  if (st.conflict || st.slots == null) return null;
  return runMet(st.names, POOL_OUT_STRONG_MIN_OBS, POOL_OUT_STRONG_MIN_MS) ? st.slots : null;
}

/** The LARGEST count in a streak's chain whose own readings have met a dwell (null: none has). */
function confirmedCount(st: PoolOutStreak | null): PoolOutStreak | null {
  let top: PoolOutStreak | null = null;
  for (let m = st; m != null; m = m.more) if (dwellMet(m) != null) top = m;
  return top;
}

/** Does an observation's (count, set) say what the latched set already says? A count-only reading never un-names a slot. */
function agreesWithLatch(ep: PoolOutEpisode, k: number, named: number[] | null): boolean {
  if (k !== ep.k) return false;
  if (named == null) return true;
  return ep.slots != null && sameSet(ep.slots, named);
}

/** The severity of a standing episode. Critical only on qualified readings: the DWELL-CONFIRMED capacity under half the
 *  reference, or the grid known absent (the flag advancePoolOut sets from three consecutive readings). */
export function poolOutSeverity(state: PoolOutState): 'warning' | 'critical' | null {
  const ep = state.episode;
  if (!ep) return null;
  // A flap raise's capacity is two readings' (PoolOutEpisode.unconfirmed): no dwell has confirmed it, so it decides nothing.
  if (ep.unconfirmed == null && ep.countedWh < ep.baselineWh / 2) return 'critical';
  return ep.gridCritical ? 'critical' : 'warning';
}

/** The blind clock at one more body whose capacity could not be judged. It runs only across bodies that follow one
 *  another: after a gap longer than the streak gap (a restart, an outage, a clock set back) it starts again, so the
 *  WARN never counts minutes in which no body was read as minutes "while the panel is fresh". */
function blindClock(blind: PoolOutState['blind'], atMs: number): NonNullable<PoolOutState['blind']> {
  const carried = blind != null && atMs - blind.lastMs >= 0 && atMs - blind.lastMs <= POOL_OUT_STREAK_MAX_GAP_MS;
  return carried ? { ...blind, lastMs: atMs } : { sinceMs: atMs, lastMs: atMs, warned: false };
}

/**
 * Fold one REST body into the tracker. PURE: the state in, the state out, with what happened (events), what to log,
 * and whether the change is worth writing at once.
 */
export function advancePoolOut(prev: PoolOutState, obs: PoolObservation): PoolOutStep {
  const s: PoolOutState = { ...structuredClone({ ...prev, proc: undefined }), proc: { ...prev.proc, clean: prev.proc.clean ? { ...prev.proc.clean } : null } } as PoolOutState;
  const events: PoolOutEvent[] = [];
  const logs: PoolOutLog[] = [];
  let changed = false;
  const note = (kind: string, text: string, level: PoolOutLog['level'] = 'info'): void => {
    const at = s.noted[kind];
    if (at != null && obs.atMs - at >= 0 && obs.atMs - at < POOL_OUT_NOTE_EVERY_MS) return;
    s.noted[kind] = obs.atMs;
    logs.push({ level, text });
  };
  const severityBefore = poolOutSeverity(s);
  const gridCriticalBefore = s.episode?.gridCritical === true;

  const keptEnds = s.ends.filter((e) => obs.atMs - e.atMs <= POOL_OUT_END_KEEP_MS);
  if (keptEnds.length !== s.ends.length) { s.ends = keptEnds; changed = true; }

  /* ── the gates O1–O4: which bodies are observations ── */
  let reason: PoolSkipReason | null = null;
  const roster = poolRoster(obs.diag, s.baseline);
  const missing = roster.filter((n) => (slotOf(obs.diag, n)?.isConnect ?? null) == null);
  if (!obs.online) reason = 'offline';
  else if (obs.witness == null) reason = 'no-witness';
  else {
    const key = poolWitnessKey(obs.witness);
    const seen = s.ring.includes(key);
    if (!seen) s.ring = [...s.ring, key].slice(-POOL_OUT_WITNESS_RING);
    if (obs.latched) reason = 'latched';
    else if (seen) reason = 'replayed';
    else if (obs.diag.pool.fullCapWh == null) reason = 'no-capacity';
    else if (obs.diag.pool.fullCapWh <= 0) reason = 'zero-capacity';
    else if (!obs.diag.pool.coherent) reason = 'incoherent';
    else if (roster.length === 0) reason = 'no-roster';
    else if (missing.length > 0) reason = 'no-isconnect';
  }
  s.skip = reason == null ? null : { reason, n: s.skip?.reason === reason ? s.skip.n + 1 : 1 };

  /* ── no silent blindness: a reason that persists becomes a vote, where one is defined ── */
  let opts: SignalOpts | null = reason == null ? {} : null;
  let converted: PoolOutStep['converted'] = null;
  if (reason != null && s.skip != null && s.skip.n >= POOL_OUT_SKIP_CONVERT_POLLS && roster.length > 0) {
    if (reason === 'zero-capacity' && s.baseline != null) { opts = { allOut: true }; converted = 'all-out'; }
    else if (reason === 'no-capacity') { opts = { capUnknown: true }; converted = 'cap-unknown'; }
    else if (reason === 'no-isconnect') { opts = { notListed: missing }; converted = 'not-listed'; }
    if (converted != null && s.skip.n === POOL_OUT_SKIP_CONVERT_POLLS) {
      logs.push({ level: 'warn', text: `pool-out: ${POOL_OUT_SKIP_CONVERT_POLLS} panel readings running were not usable (${reason}); from here they are read as ${converted === 'all-out' ? 'a capacity of zero, every slot out' : converted === 'cap-unknown' ? 'capacity unknown, percent and power still judged' : `${slotWord(missing)} not listed by the panel`}.` });
    }
  }

  if (opts == null) {
    /* ── skipped: no counter moves in either direction ── */
    const fresh = obs.online && !obs.latched;
    if (!fresh) s.blind = null;
    else {
      s.blind = blindClock(s.blind, obs.atMs);
      if (!s.blind.warned && obs.atMs - s.blind.sinceMs >= POOL_OUT_BLIND_WARN_MS) {
        s.blind.warned = true;
        changed = true;
        events.push({ type: 'blind', atMs: obs.atMs, reason: reason as PoolSkipReason });
        // The same words as the unjudged reading's line below: the clock runs through both, so "no usable reading
        // for 30 min" was said of half an hour in which ten readings were usable and unjudged.
        logs.push({ level: 'warn', text: `pool-out: no capacity verdict for ${Math.round((obs.atMs - s.blind.sinceMs) / 60_000)} min while the panel is fresh (${reason}); a Core leaving the pool cannot be seen until one arrives.` });
      }
    }
    return { state: s, signals: null, skip: reason, converted: null, events, logs, changed };
  }

  /* ── a usable observation ── */
  const sig = poolSignals(obs.diag, s.baseline, obs.atMs, opts);
  const { cap, pct, flow } = sig;
  // No silent blindness, the other half: a reading that can be used but whose CAPACITY cannot be judged leaves the
  // alarm as blind as a skipped one. The same clock runs through both; a capacity verdict ends it.
  if (cap.v !== 'unknown') s.blind = null;
  else {
    s.blind = blindClock(s.blind, obs.atMs);
    if (!s.blind.warned && obs.atMs - s.blind.sinceMs >= POOL_OUT_BLIND_WARN_MS) {
      s.blind.warned = true;
      changed = true;
      events.push({ type: 'blind', atMs: obs.atMs, reason: cap.reason as PoolBlindReason });
      logs.push({ level: 'warn', text: `pool-out: no capacity verdict for ${Math.round((obs.atMs - s.blind.sinceMs) / 60_000)} min while the panel is fresh (${cap.reason}); a Core leaving the pool cannot be seen until one arrives.` });
    }
  }
  const grid = gridReading(obs);
  s.last = summarize(obs, sig, grid);
  s.lastUsableMs = obs.atMs;
  if (cap.v !== 'unknown') s.lastCapMs = obs.atMs;
  s.grid = [...s.grid, { atMs: obs.atMs, g: grid }].slice(-POOL_OUT_GRID_READINGS);
  const verdicts = poolVerdictsText(sig);
  const counted = sig.cls === 'STRONG' || sig.cls === 'SLOW';
  const before = s.lastHealthy;

  /* ── the reference ── */
  if (cap.v === 'healthy') {
    s.healthy = extendRun(s.healthy, obs.atMs);
    s.lastHealthy = { atMs: obs.atMs, capWh: cap.countedWh as number, pct: obs.diag.pool.coherent ? obs.diag.pool.pct : null };
    // The boot sweep's hold: healthy capacity proves a Core is back only against a roster of EVERY slot of the panel.
    // A roster that leaves a slot out (no reference on file and a slot not listed as connected) cannot say it.
    s.proc.clean = roster.length === SHP2_SOURCE_SLOTS ? extendRun(s.proc.clean, obs.atMs) : null;
    if (runMet(s.proc.clean, POOL_OUT_CLEAR_MIN_OBS, POOL_OUT_CLEAR_MIN_MS)) s.proc.cleanDwell = true;
  } else if (cap.v === 'fault') {
    s.healthy = null;
    s.proc.clean = null;
  }
  s.grow = cap.reason === 'over' ? extendRun(s.grow, obs.atMs) : null;
  // No reference is taken while a streak or an episode stands. A streak whose last counted reading is past the streak
  // gap is over (the next counted reading starts a new one), so it holds nothing back: one stale short body followed
  // by readings that only hold would otherwise keep a grown pool from ever being adopted.
  const streakLive = s.streak != null && withinStreakGap(s.streak, obs.atMs);
  if (!streakLive && s.episode == null) {
    if (cap.v === 'healthy' && runMet(s.healthy, POOL_OUT_ADOPT_MIN_OBS, POOL_OUT_ADOPT_MIN_MS)) {
      const next = baselineFrom(obs, roster, cap.countedWh as number);
      if (s.baseline == null || baselineShape(s.baseline) !== baselineShape(next)) {
        logs.push({ level: 'info', text: `pool-out: reference ${s.baseline == null ? 'adopted' : 'updated'} — ${slotWord(next.roster)}, ${kwh(next.poolCapWh)} kWh${s.baseline == null ? '' : ` (was ${slotWord(s.baseline.roster)}, ${kwh(s.baseline.poolCapWh)} kWh)`}.` });
        // Adopted with NO reference before it (a first start, or a lost state file) while the panel does not list
        // every slot as connected: a Core already out in that shape is outside this reference, and nothing here can
        // tell its slot from an empty one. Said once, at warn.
        const leftOut = poolReferenceLeavesOut(obs.diag, next.roster);
        if (s.baseline == null && leftOut.length > 0) {
          logs.push({ level: 'warn', text: `pool-out: this reference has none on record before it and leaves out ${slotWord(leftOut)}, which the panel does not list as connected — a Core in ${leftOut.length === 1 ? 'that slot' : 'those slots'} that is out of the pool is not counted here, and is not seen leaving.` });
        }
        events.push({ type: 'baseline', atMs: obs.atMs });
        s.baseline = next;
        changed = true;
      } else if (JSON.stringify(s.baseline.flags) !== JSON.stringify(next.flags)) {
        s.baseline = { ...s.baseline, flags: next.flags };
      }
    } else if (cap.reason === 'over' && runMet(s.grow, POOL_OUT_ADOPT_MIN_OBS, POOL_OUT_ADOPT_MIN_MS)) {
      // The capacity has read above the reference for the adoption dwell. If the slots now listed connected add up
      // to it, the roster grew (a Core joined, or came back after a reference taken without it): adopt the larger one.
      const listed = obs.diag.slots.filter((x) => x.isConnect === 1 && (x.fullCapWh ?? 0) > 0);
      const sum = listed.reduce((a, x) => a + (x.fullCapWh as number), 0);
      if (Math.abs(sum - (cap.countedWh as number)) <= POOL_OUT_CAP_TOLERANCE_WH) {
        const next = baselineFrom(obs, listed.map((x) => x.slot).sort((a, b) => a - b), cap.countedWh as number);
        logs.push({ level: 'info', text: `pool-out: reference enlarged — ${slotWord(next.roster)}, ${kwh(next.poolCapWh)} kWh (was ${s.baseline ? `${slotWord(s.baseline.roster)}, ${kwh(s.baseline.poolCapWh)} kWh` : 'none'}); the panel's capacity has matched its listed slots for ${Math.round(((s.grow as PoolOutRun).lastMs - (s.grow as PoolOutRun).firstMs) / 60_000)} min.` });
        events.push({ type: 'baseline', atMs: obs.atMs });
        s.baseline = next;
        s.grow = null;
        s.healthy = null;
        changed = true;
      }
    }
  }

  /* ── notes that are logged and recorded, never alarmed ── */
  if (sig.cls === 'NOCAP') note('nocap', `pool-out: percent and power both point at ${slotWord(pct.set ?? [])} while the capacity cannot be compared — recorded, not alarmed (${verdicts}).`);
  if (cap.v === 'fault' && sig.cls === 'HOLD') note('contradiction', `pool-out: the capacity is ${cap.k} slot${cap.k === 1 ? '' : 's'} short while every slot carries its share — held, not counted (${verdicts}).`);
  if (cap.reason === 'not-slot-sized') note('not-slot-sized', `pool-out: the capacity differs from its slots by an amount that is not a whole slot — held (${verdicts}).`);
  if (cap.reason === 'listed-mismatch') note('listed-mismatch', `pool-out: a slot is not listed as connected while the capacity is unchanged — held (${verdicts}).`);
  if (cap.reason === 'no-slot-capacity') note('no-slot-capacity', `pool-out: a slot reports no capacity of its own and none is on record for it, so the pool's capacity cannot be compared — held (${verdicts}).`);
  if (cap.reason === 'over') note('over', `pool-out: the capacity reads above the sum of the slots the reference counts — held (${verdicts}).`);
  if (cap.v !== 'fault' && (pct.v === 'fault' || flow.v === 'fault') && sig.cls !== 'NOCAP') note('alone', `pool-out: percent or power points at a slot while the capacity does not — recorded, not alarmed (${verdicts}).`);

  if (s.episode == null) {
    /* ── before a raise: the streak ── */
    if (counted) {
      s.inRun = null;
      if (s.streak != null && !(obs.atMs - s.streak.lastMs >= 0 && obs.atMs - s.streak.lastMs <= POOL_OUT_STREAK_MAX_GAP_MS)) {
        logs.push({ level: 'info', text: `pool-out: streak restarted — ${Math.round((obs.atMs - s.streak.lastMs) / 60_000)} min since its last counted reading.` });
        s.streak = null;
      }
      if (s.streak == null) {
        s.streak = newStreak(obs, sig, before);
        events.push({ type: 'first-fault', atMs: obs.atMs });
        logs.push({ level: 'info', text: `pool-out: streak started (${sig.cls}) — ${verdicts}.` });
        changed = true;
      }
      const st = s.streak;
      countInto(st, obs, sig);
      let how: 'strong' | 'slow' | 'flap' | null = dwellMet(st);
      if (!st.stepped && st.run >= POOL_OUT_FLAP_STEP_MIN_OBS) {
        // A confirmed loss step. The third inside the window raises: a Core that keeps leaving and rejoining.
        st.stepped = true;
        s.flaps = [...s.flaps.filter((t) => st.firstMs - t >= 0 && st.firstMs - t <= POOL_OUT_FLAP_WINDOW_MS), st.firstMs];
        changed = true;
        if (how == null && s.flaps.length >= POOL_OUT_FLAP_STEPS) how = 'flap';
      }
      if (how != null) {
        // WHAT IS LATCHED: the largest count whose OWN readings have met a dwell (the streak's own, the smallest, when
        // no larger one has), with that count's capacity and the set its readings named on a dwell of their own. Never
        // the count, the capacity or the name of the one reading that completes the dwell. A larger count still on its
        // way goes on as the episode's pending change.
        const confirmed = confirmedCount(st);
        const top = confirmed ?? st;
        const slots = confirmedNames(top);
        // A set its readings agree on but have not yet named for a dwell is not thrown away: it goes on as the pending
        // change, and is latched (and logged) when its own readings complete the naming dwell.
        const pending = slots == null && top.slots != null && !top.conflict ? { ...top, before: null } : top.more;
        s.episode = {
          sinceMs: how === 'flap' ? s.flaps[0] : st.firstMs, raisedAtMs: obs.atMs, how, flapSteps: how === 'flap' ? s.flaps.length : 0,
          k: top.k, slots, rosterSize: roster.length,
          baselineWh: s.baseline?.poolCapWh ?? top.expectedWh, expectedWh: top.expectedWh, countedWh: top.countedWh,
          // No count's readings have met a dwell (only the flap rule raises so): the step's own tally goes on toward one.
          unconfirmed: confirmed == null ? { ...st, before: null, more: null } : null,
          before: st.before, lastFault: { atMs: obs.atMs, pct: obs.diag.pool.coherent ? obs.diag.pool.pct : null, capWh: cap.countedWh },
          evidence: slots ? top.evidence : null, gridCritical: false, gridAbsentAtMs: null, change: pending, less: null, clear: null, changes: [],
        };
        s.streak = null;
        s.flaps = [];
        s.inRun = null;
        s.proc.raised = true;
        changed = true;
        events.push({ type: 'raised', atMs: obs.atMs, how });
        logs.push({ level: 'warn', text: `pool-out: RAISED (${how}) — ${poolOutTitle(top.k, slots)}; first fault reading ${new Date(s.episode.sinceMs).toISOString()}; ${verdicts}.` });
      }
    } else if (sig.cls === 'IN') {
      if (s.streak != null) {
        s.streak.run = 0;
        s.inRun = extendRun(s.inRun, obs.atMs);
        if (runMet(s.inRun, POOL_OUT_IN_RESET_OBS, POOL_OUT_IN_RESET_MS)) {
          logs.push({ level: 'info', text: `pool-out: streak ended after ${s.streak.counted} counted reading${s.streak.counted === 1 ? '' : 's'} — ${s.inRun.n} consecutive readings in (${verdicts}).` });
          s.streak = null;
          s.inRun = null;
          changed = true;
        }
      }
    } else if (sig.cls === 'NOCAP' || cap.v === 'fault') {
      // Not counted, but evidence against "in": a run of healthy readings does not reach across it.
      s.inRun = null;
    }
  } else {
    /* ── an episode stands: its set, its clear ── */
    const ep = s.episode;
    if (cap.v === 'fault' && ep.clear != null) { ep.clear = null; changed = true; }
    // The newest COUNTED reading: a held contradiction (capacity short, every slot carrying) is no "before" for a return.
    if (counted) ep.lastFault = { atMs: obs.atMs, pct: obs.diag.pool.coherent ? obs.diag.pool.pct : null, capWh: cap.countedWh };
    /** A dwell-confirmed set change: the count, its capacity (the severity reads it) and the set, logged. */
    const setChanged = (to: PoolOutStreak, named: number[] | null, slots: number[] | null): void => {
      logs.push({ level: 'warn', text: `pool-out: set changed — ${poolOutTitle(ep.k, ep.slots)} → ${poolOutTitle(to.k, slots)}; ${verdicts}.` });
      ep.changes = [...ep.changes, { atMs: obs.atMs, k: to.k, slots }].slice(-POOL_OUT_CHANGES_KEPT);
      ep.k = to.k;
      ep.slots = slots;
      ep.countedWh = to.countedWh;
      ep.expectedWh = to.expectedWh;
      if (named != null) ep.evidence = to.evidence;
      events.push({ type: 'set-changed', atMs: obs.atMs });
      changed = true;
    };
    if (counted && (cap.k as number) < ep.k) {
      /* FEWER slots short than the latch says: a Core back while another is still out. "At most k short" needs a dwell
         of readings that say so, and one reading at the latched count (below) ends it. */
      const k = cap.k as number;
      if (ep.less != null && !withinStreakGap(ep.less, obs.atMs)) ep.less = null;
      ep.less ??= newStreak(obs, sig, null);
      const ls = ep.less;
      if (k > ls.k) { ls.k = k; forgetNames(ls, false); }
      countDwell(ls, obs, sig);
      if (k === ls.k) countNames(ls, obs, sig);
      if (dwellMet(ls) != null) {
        const named = confirmedNames(ls);
        ep.less = null;
        ep.change = null;
        ep.unconfirmed = null; // this count's own readings have met a dwell
        setChanged(ls, named, named);
      }
    } else if (counted) {
      ep.less = null;
      if (ep.unconfirmed != null) {
        /* A FLAP raise's capacity on its way to a dwell: every counted reading at the latched count or above it, by the
           streak's own rules (it starts again after the streak gap, and after the healthy readings that end a streak,
           below). Until the dwell is met the severity does not read the capacity. */
        const un = ep.unconfirmed;
        if (un.counted === 0 || !withinStreakGap(un, obs.atMs)) restartTally(un, obs.atMs);
        countDwell(un, obs, sig);
        if (dwellMet(un) != null) {
          ep.unconfirmed = null;
          changed = true;
          logs.push({ level: 'info', text: `pool-out: the capacity behind this alarm (${kwh(ep.countedWh)} kWh, raised by the flap rule) has now read ${ep.k} slot${ep.k === 1 ? '' : 's'} short or more for a full dwell — confirmed (${verdicts}).` });
        }
      }
      // A pending change whose last reading is more than the streak gap old is over, whatever this reading says.
      if (ep.change != null && !withinStreakGap(ep.change, obs.atMs)) ep.change = null;
      if (!agreesWithLatch(ep, cap.k as number, sig.named)) {
        ep.change ??= newStreak(obs, sig, null);
        countInto(ep.change, obs, sig);
        const top = confirmedCount(ep.change);
        if (top != null && top.k > ep.k) {
          // A LARGER count, on a dwell of its own readings (a still larger one on its way stays pending). A named slot
          // is never un-named by a later reading that only counts: it stays, with the rest "not identified".
          const named = confirmedNames(top);
          ep.change = top.more;
          ep.unconfirmed = null; // this count's own readings have met a dwell
          setChanged(top, named, named ?? ep.slots);
        } else if (ep.change.k === ep.k) {
          // The SAME count: only the name can differ, and a name needs a dwell of readings that agree on it. Readings
          // that name different sets establish none, and the naming starts again.
          const ch = ep.change;
          const named = confirmedNames(ch);
          if (ch.conflict) ep.change = ch.more;
          else if (named != null && !(ep.slots != null && sameSet(named, ep.slots))) {
            ep.change = ch.more;
            setChanged(ch, named, named);
          }
        }
      } else if (ep.change != null && ep.change.k === ep.k) {
        /* The reading says what the latch says, while another NAME is on its way at the latched count.
           - It NAMES the latched set: the pending name is contradicted, and its naming is over. (Readings naming two
             slots by turns used to let each complete "a dwell of its own readings", and the title flipped between them.)
           - It only COUNTS: the pool is still this many short, which says nothing against the pending name, so that
             name does not age out between its readings (a slot that discharges for four minutes in every twenty is
             named by each burst, more than the streak gap apart). */
        if (sig.named != null) ep.change = ep.change.more;
        else ep.change.lastMs = obs.atMs;
      }
    }
    if (cap.v === 'healthy') {
      /* The clear: capacity evidence held for a dwell. PCT, FLOW and FLAG may shorten or be logged; none can block. */
      const first = ep.clear == null;
      const run: PoolOutClearRun = ep.clear ?? {
        firstMs: obs.atMs, lastMs: obs.atMs, n: 0,
        first: { atMs: obs.atMs, capWh: cap.countedWh as number, pct: obs.diag.pool.coherent ? obs.diag.pool.pct : null },
        flowOk: [], pctOk: [], allFlow: false, evidence: null,
      };
      run.lastMs = obs.atMs;
      run.n += 1;
      const carrying = flow.slots.filter((f) => f.v === 'healthy').map((f) => f.slot);
      const vouched = pct.v === 'consistent' ? pct.separable : [];
      run.flowOk = [...new Set([...run.flowOk, ...carrying])].sort((a, b) => a - b);
      run.pctOk = [...new Set([...run.pctOk, ...vouched])].sort((a, b) => a - b);
      if (flow.v === 'healthy') run.allFlow = true;
      const subject = ep.slots ?? [];
      if (subject.length > 0 && run.evidence?.by !== 'flow') {
        if (subject.every((n) => carrying.includes(n))) {
          run.evidence = { atMs: obs.atMs, by: 'flow', slots: subject, w: flow.slots.map((f) => ({ slot: f.slot, w: Math.round(f.w) })), poolPct: null, pcts: roster.map((n) => ({ slot: n, pct: slotOf(obs.diag, n)?.pct as number })), why: null };
        } else if (run.evidence == null && subject.every((n) => vouched.includes(n))) {
          run.evidence = { atMs: obs.atMs, by: 'pct', slots: subject, w: null, poolPct: pct.poolPct, pcts: roster.map((n) => ({ slot: n, pct: slotOf(obs.diag, n)?.pct as number })), why: null };
        }
      }
      ep.clear = run;
      // The healthy readings that end a streak (three, spanning two minutes) start a flap raise's tally again as well.
      if (ep.unconfirmed != null && ep.unconfirmed.counted > 0 && runMet(run, POOL_OUT_IN_RESET_OBS, POOL_OUT_IN_RESET_MS)) restartTally(ep.unconfirmed, obs.atMs);
      if (first) {
        changed = true;
        logs.push({ level: 'info', text: `pool-out: the capacity reads the sum of its slots again (${kwh(cap.countedWh as number)} kWh) — the alarm stands until that has held (${verdicts}).` });
      }
      // Evidence for the returned slot: each named slot seen carrying its share, or vouched for by the percent.
      // With no slot (or not all of them) named, only "every slot carries its share" on one reading will do.
      const evidenced = ep.slots != null && ep.slots.length === ep.k
        ? ep.slots.every((n) => run.flowOk.includes(n) || run.pctOk.includes(n))
        : run.allFlow;
      const fast = evidenced && runMet(run, POOL_OUT_FAST_CLEAR_MIN_OBS, POOL_OUT_FAST_CLEAR_MIN_MS);
      const slow = runMet(run, POOL_OUT_CLEAR_MIN_OBS, POOL_OUT_CLEAR_MIN_MS);
      if (fast || slow) {
        const kind: PoolOutEnd['kind'] = evidenced ? 'returned' : 'capacity-only';
        const end: PoolOutEnd = {
          kind, atMs: obs.atMs, backAtMs: run.firstMs, sinceMs: ep.sinceMs, k: ep.k, slots: ep.slots, rosterSize: ep.rosterSize,
          capWh: cap.countedWh as number, remainWh: obs.diag.pool.coherent ? obs.diag.pool.remainWh : null, pct: obs.diag.pool.coherent ? obs.diag.pool.pct : null,
          pctBefore: ep.lastFault.pct, pctBeforeAtMs: ep.lastFault.atMs, pctAfter: run.first.pct, pctAfterAtMs: run.first.atMs,
          evidence: run.evidence, slotPct: subject.map((n) => ({ slot: n, pct: slotOf(obs.diag, n)?.pct ?? null })),
        };
        if (pct.v === 'fault' || flow.v === 'fault' || sig.flag.v === 'fault') {
          logs.push({ level: 'info', text: `pool-out: cleared on the capacity while another signal still differs — it does not hold the clear (${verdicts}).` });
        }
        logs.push({ level: 'warn', text: `pool-out: CLEARED (${kind}) — ${poolOutTitle(ep.k, ep.slots)}; the capacity has read ${kwh(end.capWh)} kWh for ${run.n} readings over ${Math.round((run.lastMs - run.firstMs) / 60_000)} min; ${verdicts}.` });
        s.ends = [...s.ends, end].slice(-4);
        s.episode = null;
        s.streak = null;
        s.flaps = [];
        s.inRun = null;
        s.healthy = { firstMs: run.firstMs, lastMs: run.lastMs, n: run.n };
        s.proc.cleanDwell = true;
        changed = true;
        events.push({ type: 'cleared', atMs: obs.atMs, kind });
      }
    }
  }

  /* ── the grid, for the severity: three consecutive usable observations either way; unknown holds ── */
  if (s.episode != null && s.grid.length >= POOL_OUT_GRID_READINGS) {
    const ep = s.episode;
    if (s.grid.every((r) => r.g === 'absent' && obs.atMs - r.atMs >= 0 && obs.atMs - r.atMs <= POOL_OUT_GRID_MAX_AGE_MS)) {
      if (!ep.gridCritical) { ep.gridCritical = true; ep.gridAbsentAtMs = obs.atMs; changed = true; }
    } else if (s.grid.every((r) => r.g === 'present')) {
      if (ep.gridCritical) { ep.gridCritical = false; ep.gridAbsentAtMs = null; changed = true; }
    }
  }
  const severityAfter = poolOutSeverity(s);
  if (severityAfter != null && severityBefore != null && severityAfter !== severityBefore) {
    events.push({ type: 'severity', atMs: obs.atMs, severity: severityAfter });
    // WHY, from what moved in this step: the grid flag, or else the capacity the severity reads (a set change, or a
    // flap raise's capacity confirmed). Two Cores out and one back is not "the grid reads present again".
    const gridCriticalNow = s.episode?.gridCritical === true;
    const why = severityAfter === 'critical'
      ? (gridCriticalNow && !gridCriticalBefore ? 'the panel and the add-on both report no grid' : 'the confirmed capacity is under half the reference')
      : (gridCriticalBefore && !gridCriticalNow ? 'the grid reads present again' : 'the confirmed capacity is no longer under half the reference');
    logs.push({ level: 'warn', text: `pool-out: severity ${severityBefore} → ${severityAfter} (${why}).` });
  }

  return { state: s, signals: sig, skip: null, converted, events, logs, changed };
}

/* ───────────────────────────── surfaces other than the alert ───────────────────────────── */

/** The Home Assistant binary sensor: ON during an episode; OFF only while the newest capacity verdict is recent; else
 *  unknown. And never OFF on a capacity that reads SHORT with no healthy reading inside the capacity-alone dwell before
 *  it: a shortfall held without an alarm (every slot still carrying its share), or one with no healthy reading on
 *  record at all, is neither state. */
export function poolOutSensorState(state: PoolOutState, nowMs: number): 'on' | 'off' | 'unknown' {
  if (state.episode != null) return 'on';
  const capMs = state.lastCapMs;
  if (capMs == null || !(nowMs - capMs >= 0 && nowMs - capMs <= POOL_OUT_SENSOR_FRESH_MS)) return 'unknown';
  const healthyMs = state.lastHealthy?.atMs ?? null;
  if (healthyMs !== capMs && (healthyMs == null || capMs - healthyMs > POOL_OUT_SLOW_MIN_MS)) return 'unknown';
  return 'off';
}

/** v1.209.0 — what the STANDING alarm says of this panel's slots, for a caller that decides with it (the force-charge's
 *  rate and its ON targets: nightForceCharge.ts forceChargePoolSlots). */
export interface PoolOutRead {
  /** The slots the standing alarm names (its title's slots): ascending integers 1..SHP2_SOURCE_SLOTS, a COPY; [] with none. */
  named: number[];
  /** The latched count of slots out, named or not; 0 with no episode. */
  count: number;
  /** The capacity reads whole again and the clear dwell is running: the alarm still stands and still names its slots. */
  returning: boolean;
  /** DATA time of the newest usable observation; null with none. */
  asOfMs: number | null;
}

/**
 * v1.209.0 — the standing alarm's verdict on the panel's slots. PURE.
 *
 * Built from the LATCHED fields only — `episode.k`, `episode.slots`, `episode.clear` — and `lastUsableMs`: the two the
 * alarm's title and fault token are built from (poolOutTitle, poolOutFault), so the slots named here are the slots the
 * title names. Never from one reading's verdicts (PoolSignals), a streak before its raise, or a set still on its way
 * through a dwell (`episode.change`): none of those has been confirmed, and this output decides which slots a
 * force-charge is sent to. For the same reason every slot and the count are checked again here, whatever the state
 * holds: a slot that is not an integer in 1..SHP2_SOURCE_SLOTS is left out, and a count that is not a non-negative
 * integer is 0.
 *
 * No clock argument: the title has none, and the tracker's rule is that age ends no alarm. A caller that must not act
 * on an old verdict reads `asOfMs` (forceChargePoolSlots does, for the slots it leaves out of an ON).
 *
 * No state, or no episode standing: nothing named, nothing counted.
 */
export function poolOutRead(state: PoolOutState | null | undefined): PoolOutRead {
  const asOfMs = state?.lastUsableMs ?? null;
  const ep = state?.episode;
  if (ep == null) return { named: [], count: 0, returning: false, asOfMs };
  const slots: unknown[] = Array.isArray(ep.slots) ? ep.slots : [];
  const named = [...new Set(slots.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= SHP2_SOURCE_SLOTS))]
    .sort((a, b) => a - b);
  const count = typeof ep.k === 'number' && Number.isInteger(ep.k) && ep.k >= 0 ? ep.k : 0;
  return { named, count, returning: ep.clear != null, asOfMs };
}

/** The boot orphan sweep may resolve this alert only once the tracker has, IN THIS PROCESS, raised or seen a full clear
 *  dwell of healthy capacity — or when the END of that alarm is on file: no episode standing, and an end record dated
 *  at or after the push being resolved (`pushedAtMs`). A lost state file must not push a "Resolved" that nothing
 *  observed; an end the tracker itself recorded IS the observation, and it is the only release there is on a panel
 *  with an empty slot, whose roster can never earn the clean dwell. An end older than the push is another episode's. */
export function poolOutOrphanHoldReleased(state: PoolOutState, pushedAtMs?: number): boolean {
  if (state.proc.raised || state.proc.cleanDwell) return true;
  const end = state.episode == null ? poolOutLatestEnd(state) : null;
  return end != null && pushedAtMs != null && end.atMs >= pushedAtMs;
}

/** The slots a reference leaves out of what the panel's data holds (every slot of the panel has a block in it): a Core
 *  out of the pool in one of them is not counted against that reference, and is not seen leaving. */
export function poolReferenceLeavesOut(diag: PoolDiag, roster: number[]): number[] {
  return diag.slots.map((x) => x.slot).filter((n) => !roster.includes(n));
}

/** The alert id: the bare stem for the house panel, the stem plus the panel's serial for a secondary one. */
export function poolOutAlertId(panelSn: string, housePanel: boolean): string {
  return housePanel ? POOL_OUT_ALERT_ID : `${POOL_OUT_ALERT_ID}-${panelSn}`;
}

/**
 * THE DELIVERY POLICY, in one place. As decided for this release: this alarm is pushed at once at any hour, with no
 * quiet-hours hold (the detail is the push body), and it is spoken as every alarm is today: a critical, outside quiet
 * hours. To change it, change POOL_OUT_PUSH_IN_QUIET_HOURS, or this function, and nothing else.
 *
 * WHAT READS IT. `pushNow` for the quiet hours: alerts.ts stamps Alert.pushInQuietHours from it, and the alert monitor
 * reads that flag in the three places an alert can be kept from being pushed at once: the notify quiet hours, the push
 * debounce, and the hold after a send that failed (the send is tried again after 20 s, then at waits that double to
 * 10 minutes, and the digest never stands in for it). `speak`: NOTHING reads it
 * in this release. Speech is the broadcast's, by the rules it applies to every alert (broadcast.ts), and this output
 * states what those rules give for this alarm under the shipped options; test/poolOutDelivery.test.ts pins it to those
 * rules and options. A change to `speak` here changes no speech until the broadcast is made to read it.
 */
export const POOL_OUT_PUSH_IN_QUIET_HOURS = true;
export function poolOutDelivery(severity: 'warning' | 'critical', inQuietHours: boolean): { pushNow: boolean; speak: boolean } {
  return {
    pushNow: POOL_OUT_PUSH_IN_QUIET_HOURS || !inQuietHours,
    speak: severity === 'critical' && !inQuietHours,
  };
}

/* ───────────────────────────── the state file ───────────────────────────── */

class Bad extends Error {}
const need = (ok: boolean): void => { if (!ok) throw new Bad(); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Record<string, unknown> => { need(isObj(v)); return v as Record<string, unknown>; };
const num = (v: unknown): number => { need(typeof v === 'number' && Number.isFinite(v)); return v as number; };
const numN = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const count = (v: unknown): number => { const n = num(v); need(Number.isInteger(n) && n >= 0); return n; };
const bool = (v: unknown): boolean => { need(typeof v === 'boolean'); return v as boolean; };
const str = (v: unknown): string => { need(typeof v === 'string' && v.length <= 200); return v as string; };
const strN = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
const oneOf = <T extends string>(v: unknown, of: readonly T[]): T => { need(typeof v === 'string' && (of as readonly string[]).includes(v)); return v as T; };
const arr = <T>(v: unknown, each: (x: unknown) => T, max = 64): T[] => { need(Array.isArray(v) && (v as unknown[]).length <= max); return (v as unknown[]).map(each); };
const slotNum = (v: unknown): number => { const n = num(v); need(Number.isInteger(n) && n >= 1 && n <= SHP2_SOURCE_SLOTS); return n; };
const slotSet = (v: unknown): number[] => { const a = arr(v, slotNum, SHP2_SOURCE_SLOTS); need(a.every((x, i) => i === 0 || x > a[i - 1])); return a; };
const slotSetN = (v: unknown): number[] | null => (v === null || v === undefined ? null : slotSet(v));
const orNull = <T>(v: unknown, each: (x: unknown) => T): T | null => (v === null || v === undefined ? null : each(v));

const CAP_WHY = ['not-connected', 'not-listed', 'no-capacity', 'all-out'] as const;
const GRID = ['present', 'absent', 'unknown'] as const;
const SKIPS = ['offline', 'no-witness', 'latched', 'replayed', 'no-capacity', 'zero-capacity', 'incoherent', 'no-roster', 'no-isconnect'] as const;

const readRun = (v: unknown): PoolOutRun => { const o = obj(v); return { firstMs: num(o.firstMs), lastMs: num(o.lastMs), n: count(o.n) }; };
const readBefore = (v: unknown): PoolOutBefore => { const o = obj(v); return { atMs: num(o.atMs), capWh: num(o.capWh), pct: numN(o.pct) }; };
const readEvidence = (v: unknown): PoolOutEvidence => {
  const o = obj(v);
  return {
    atMs: num(o.atMs), by: oneOf(o.by, ['flow', 'pct', 'cap'] as const), slots: slotSet(o.slots),
    w: orNull(o.w, (x) => arr(x, (y) => { const r = obj(y); return { slot: slotNum(r.slot), w: num(r.w) }; }, SHP2_SOURCE_SLOTS)),
    poolPct: numN(o.poolPct),
    pcts: orNull(o.pcts, (x) => arr(x, (y) => { const r = obj(y); return { slot: slotNum(r.slot), pct: num(r.pct) }; }, SHP2_SOURCE_SLOTS)),
    why: orNull(o.why, (x) => oneOf(x, CAP_WHY)),
  };
};
const readStreak = (v: unknown, depth = 0): PoolOutStreak => {
  const o = obj(v);
  // A chain of larger counts is at most one streak per slot deep.
  need(depth < SHP2_SOURCE_SLOTS);
  return {
    firstMs: num(o.firstMs), lastMs: num(o.lastMs), counted: count(o.counted), strong: count(o.strong),
    firstStrongMs: numN(o.firstStrongMs), lastStrongMs: numN(o.lastStrongMs), run: count(o.run), stepped: bool(o.stepped),
    k: count(o.k), slots: slotSetN(o.slots), conflict: bool(o.conflict), names: orNull(o.names, readRun),
    countedWh: num(o.countedWh), expectedWh: num(o.expectedWh),
    before: orNull(o.before, readBefore), evidence: orNull(o.evidence, readEvidence),
    more: orNull(o.more, (x) => readStreak(x, depth + 1)),
  };
};
const readErrList = (v: unknown): ErrList => {
  const o = obj(v);
  const entries = arr(o.entries, (x) => { const e = obj(x); return { index: count(e.index), hex: strN(e.hex) }; }, ERR_ENTRIES_KEPT);
  // `count` is the number of non-empty entries the panel sent; a file written before it existed kept every one.
  const n = o.count == null ? entries.length : count(o.count);
  need(n >= entries.length);
  return { length: count(o.length), count: n, entries };
};
const readFlagItem = (v: unknown): PoolFlagItem => {
  const o = obj(v);
  return { slot: slotNum(o.slot), key: str(o.key), value: str(o.value), others: orNull(o.others, (x) => arr(x, str, SHP2_SOURCE_SLOTS)), earlier: strN(o.earlier) };
};
const readLast = (v: unknown): PoolOutLast => {
  const o = obj(v);
  const cap = obj(o.cap);
  const pct = obj(o.pct);
  const flow = obj(o.flow);
  const pool = obj(o.pool);
  const lists = obj(o.errLists);
  return {
    atMs: num(o.atMs), cls: oneOf(o.cls, ['STRONG', 'SLOW', 'NOCAP', 'IN', 'HOLD'] as const),
    cap: {
      v: oneOf(cap.v, ['fault', 'healthy', 'unknown'] as const),
      reason: orNull(cap.reason, (x) => oneOf(x, ['no-capacity', 'no-slot-capacity', 'listed-mismatch', 'over', 'not-slot-sized'] as const)),
      countedWh: numN(cap.countedWh), expectedWh: numN(cap.expectedWh), k: orNull(cap.k, count),
    },
    pct: { v: oneOf(pct.v, ['fault', 'consistent', 'unknown'] as const), set: slotSetN(pct.set) },
    flow: {
      v: oneOf(flow.v, ['fault', 'healthy', 'partial', 'unknown'] as const),
      reason: orNull(flow.reason, (x) => oneOf(x, ['missing', 'charging', 'idle', 'no-headroom'] as const)),
      set: slotSet(flow.set), totalW: numN(flow.totalW),
    },
    flagFault: bool(o.flagFault),
    pool: { pct: numN(pool.pct), fullCapWh: numN(pool.fullCapWh), remainWh: numN(pool.remainWh), coherent: bool(pool.coherent) },
    slots: arr(o.slots, (x) => { const r = obj(x); return { slot: slotNum(r.slot), pct: numN(r.pct), isConnect: numN(r.isConnect), w: numN(r.w), errorCodeNum: numN(r.errorCodeNum) }; }, SHP2_SOURCE_SLOTS),
    flags: arr(o.flags, readFlagItem),
    panelFlags: arr(o.panelFlags, (x) => { const r = obj(x); return { key: str(r.key), value: num(r.value) }; }, 8),
    errLists: { backup: orNull(lists.backup, readErrList), master: orNull(lists.master, readErrList), hall: orNull(lists.hall, readErrList) },
    grid: oneOf(o.grid, GRID),
  };
};
const readEpisode = (v: unknown): PoolOutEpisode => {
  const o = obj(v);
  const lf = obj(o.lastFault);
  const k = count(o.k);
  need(k >= 1);
  return {
    sinceMs: num(o.sinceMs), raisedAtMs: num(o.raisedAtMs), how: oneOf(o.how, ['strong', 'slow', 'flap'] as const), flapSteps: count(o.flapSteps),
    k, slots: slotSetN(o.slots), rosterSize: count(o.rosterSize), baselineWh: num(o.baselineWh), expectedWh: num(o.expectedWh), countedWh: num(o.countedWh),
    // Absent (a file written before the field existed): confirmed, as every raise then was taken to be.
    unconfirmed: orNull(o.unconfirmed, (x) => readStreak(x)),
    before: orNull(o.before, readBefore), lastFault: { atMs: num(lf.atMs), pct: numN(lf.pct), capWh: numN(lf.capWh) },
    evidence: orNull(o.evidence, readEvidence), gridCritical: bool(o.gridCritical), gridAbsentAtMs: numN(o.gridAbsentAtMs),
    change: orNull(o.change, (x) => readStreak(x)),
    less: orNull(o.less, (x) => readStreak(x)),
    clear: orNull(o.clear, (x) => {
      const c = obj(x);
      const f = obj(c.first);
      return {
        ...readRun(c), first: { atMs: num(f.atMs), capWh: num(f.capWh), pct: numN(f.pct) },
        flowOk: slotSet(c.flowOk), pctOk: slotSet(c.pctOk), allFlow: bool(c.allFlow), evidence: orNull(c.evidence, readEvidence),
      };
    }),
    changes: arr(o.changes, (x) => { const c = obj(x); return { atMs: num(c.atMs), k: count(c.k), slots: slotSetN(c.slots) }; }, POOL_OUT_CHANGES_KEPT),
  };
};
const readEnd = (v: unknown): PoolOutEnd => {
  const o = obj(v);
  return {
    kind: oneOf(o.kind, ['returned', 'capacity-only'] as const), atMs: num(o.atMs), backAtMs: num(o.backAtMs), sinceMs: num(o.sinceMs),
    k: count(o.k), slots: slotSetN(o.slots), rosterSize: count(o.rosterSize), capWh: num(o.capWh), remainWh: numN(o.remainWh), pct: numN(o.pct),
    pctBefore: numN(o.pctBefore), pctBeforeAtMs: numN(o.pctBeforeAtMs), pctAfter: numN(o.pctAfter), pctAfterAtMs: numN(o.pctAfterAtMs),
    evidence: orNull(o.evidence, readEvidence),
    slotPct: arr(o.slotPct, (x) => { const r = obj(x); return { slot: slotNum(r.slot), pct: numN(r.pct) }; }, SHP2_SOURCE_SLOTS),
  };
};
const readBaseline = (v: unknown): PoolOutBaseline => {
  const o = obj(v);
  const roster = slotSet(o.roster);
  need(roster.length >= 1);
  const caps = obj(o.slotCapWh);
  const flags = obj(o.flags);
  const slotCapWh: Record<string, number> = {};
  const outFlags: Record<string, PoolFlagValues> = {};
  for (const n of roster) {
    if (caps[String(n)] != null) slotCapWh[String(n)] = num(caps[String(n)]);
    if (flags[String(n)] != null) {
      const f = obj(flags[String(n)]);
      const vals: PoolFlagValues = {};
      for (const [key, val] of Object.entries(f).slice(0, 32)) vals[str(key)] = strN(val);
      outFlags[String(n)] = vals;
    }
  }
  const poolCapWh = num(o.poolCapWh);
  need(poolCapWh > 0);
  return { adoptedAtMs: num(o.adoptedAtMs), roster, slotCapWh, poolCapWh, flags: outFlags };
};

/** One panel's tracker state from a parsed value; null when anything in it is not what this version writes. PURE. */
export function poolOutStateFrom(value: unknown): PoolOutState | null {
  try {
    const o = obj(value);
    need(o.v === 1);
    const noted: Record<string, number> = {};
    for (const [key, val] of Object.entries(o.noted == null ? {} : obj(o.noted)).slice(0, 16)) noted[str(key)] = num(val);
    return {
      v: 1,
      baseline: orNull(o.baseline, readBaseline),
      healthy: orNull(o.healthy, readRun),
      grow: orNull(o.grow, readRun),
      ring: arr(o.ring, str, POOL_OUT_WITNESS_RING),
      skip: orNull(o.skip, (x) => { const k = obj(x); return { reason: oneOf(k.reason, SKIPS), n: count(k.n) }; }),
      blind: orNull(o.blind, (x) => { const b = obj(x); return { sinceMs: num(b.sinceMs), lastMs: b.lastMs == null ? num(b.sinceMs) : num(b.lastMs), warned: bool(b.warned) }; }),
      lastUsableMs: numN(o.lastUsableMs),
      lastCapMs: numN(o.lastCapMs),
      lastHealthy: orNull(o.lastHealthy, readBefore),
      inRun: orNull(o.inRun, readRun),
      streak: orNull(o.streak, (x) => readStreak(x)),
      flaps: arr(o.flaps, num, 8),
      episode: orNull(o.episode, readEpisode),
      ends: arr(o.ends, readEnd, 8),
      last: orNull(o.last, readLast),
      grid: arr(o.grid, (x) => { const g = obj(x); return { atMs: num(g.atMs), g: oneOf(g.g, GRID) }; }, POOL_OUT_GRID_READINGS),
      noted,
      proc: { raised: false, cleanDwell: false, clean: null },
    };
  } catch (e) {
    if (e instanceof Bad) return null;
    throw e;
  }
}

/** One panel's state as the file holds it: everything except what happened in this process. PURE. */
export function poolOutStateJson(state: PoolOutState): Record<string, unknown> {
  const { proc: _proc, ...rest } = state;
  void _proc;
  return rest;
}

/**
 * The state file's text into one state per panel (keyed by the panel's serial, which never leaves the data folder).
 * An unreadable file is no state at all; a panel whose entry is not valid is left out and named in `rejected` by its
 * position only. Nothing is invented: a panel with no entry starts with emptyPoolOutState(). PURE.
 */
export function parsePoolOutFile(text: string): { panels: Map<string, PoolOutState>; rejected: number } {
  const panels = new Map<string, PoolOutState>();
  let rejected = 0;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { panels, rejected: 1 }; }
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.panels)) return { panels, rejected: 1 };
  for (const [sn, value] of Object.entries(raw.panels).slice(0, 8)) {
    const st = poolOutStateFrom(value);
    if (st == null || sn.length === 0 || sn.length > 64) rejected += 1;
    else panels.set(sn, st);
  }
  return { panels, rejected };
}

/** The state file's text. PURE. */
export function serializePoolOutFile(panels: Map<string, PoolOutState>): string {
  const out: Record<string, unknown> = {};
  for (const [sn, st] of panels) out[sn] = poolOutStateJson(st);
  return JSON.stringify({ v: 1, panels: out });
}

/* ───────────────────────────── the words ───────────────────────────── */

export interface PoolOutTextCtx {
  /** The instant the text is built for (the alert pass, or the push). */
  nowMs: number;
  /** The site's IANA time zone. */
  timeZone: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** An instant's local date and clock in a zone (siteTime.ts zonedParts; the names are fixed lists, not the runtime's). */
function wallParts(ms: number, timeZone: string): { ymd: string; hm: string; weekday: string; monthDay: string } | null {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  let p: SiteParts;
  try {
    p = zonedParts(ms, timeZone);
  } catch {
    // A zone the runtime does not know: UTC, never a throw while an alert is being worded.
    p = zonedParts(ms, 'UTC');
  }
  const two = (n: number): string => String(n).padStart(2, '0');
  return { ymd: p.ymd, hm: `${two(p.hour)}:${two(p.minute)}`, weekday: WEEKDAYS[p.dow], monthDay: `${MONTHS[p.month - 1]} ${p.day}` };
}

/** A clock time in the site's zone: "23:35" on the day the text is built, "Sat 23:35" within six days of it, "Nov 14 23:35" beyond. */
export function poolOutWhen(ms: number, ctx: PoolOutTextCtx): string {
  const at = wallParts(ms, ctx.timeZone);
  if (!at) return 'an unknown time';
  const now = wallParts(ctx.nowMs, ctx.timeZone);
  if (now && now.ymd === at.ymd) return at.hm;
  if (Math.abs(ctx.nowMs - ms) < 6 * 24 * 60 * 60_000) return `${at.weekday} ${at.hm}`;
  return `${at.monthDay} ${at.hm}`;
}

/** A duration in hours and minutes: "44 h 33 min", "12 min". */
export function poolOutDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`;
}

const coresHead = (k: number): string => (k === 1 ? 'Core' : `${k} Cores`);
function slotsTail(k: number, slots: number[] | null): string {
  if (slots == null || slots.length === 0) return k === 1 ? 'slot not identified' : 'slots not identified';
  if (slots.length >= k) return slotWord(slots);
  const rest = k - slots.length;
  return `${slotWord(slots)} and ${rest === 1 ? 'one' : rest} not identified`;
}

/** The alert's title. STABLE: built from the latched count and set only (the digest prints the title alone, and the
 *  announcement's identity is id + title + fault). */
export function poolOutTitle(k: number, slots: number[] | null): string {
  return `${coresHead(k)} out of the backup pool: ${slotsTail(k, slots)}`;
}

/** The alert's `fault` token: the latched set and count. No code and no reading goes in it. */
export function poolOutFault(k: number, slots: number[] | null): string {
  const named = slots == null || slots.length === 0 ? '?' : slots.length >= k ? slots.join('+') : `${slots.join('+')}+?`;
  return `out:${named};k=${k}`;
}

/** "it first read under that sum at Sat 23:35, 44 h 33 min earlier": two instants and the time between them. True for
 *  every path into an episode — one that read short without a break, one with healthy readings between its short ones,
 *  a flap — where "after 44 h 33 min under it" was true only for the first. */
function underSince(sinceMs: number, backMs: number, ctx: PoolOutTextCtx): string {
  return `it first read under that sum at ${poolOutWhen(sinceMs, ctx)}, ${poolOutDuration(backMs - sinceMs)} earlier`;
}

function leadSentence(ep: PoolOutEpisode, last: PoolOutLast | null, ctx: PoolOutTextCtx): string {
  const slotsOf = (k: number): string => `${k} slot${k === 1 ? '' : 's'}`;
  if (last == null) {
    return `The panel's backup capacity read ${kwh(ep.countedWh)} kWh at ${poolOutWhen(ep.raisedAtMs, ctx)}: ${kwh(ep.expectedWh - ep.countedWh)} kWh, the capacity of ${slotsOf(ep.k)}, under the ${kwh(ep.expectedWh)} kWh of its ${slotsOf(ep.rosterSize)}.`;
  }
  const n = slotsOf(last.slots.length);
  const { countedWh, expectedWh } = last.cap;
  if (last.cap.v === 'fault' && countedWh != null && expectedWh != null && last.cap.k != null) {
    return `The panel's backup capacity reads ${kwh(countedWh)} kWh: ${kwh(expectedWh - countedWh)} kWh, the capacity of ${slotsOf(last.cap.k)}, under the ${kwh(expectedWh)} kWh of its ${n}.`;
  }
  if (last.cap.v === 'healthy' && countedWh != null && ep.clear != null) {
    // The clear is pending: say what the panel reads NOW, never the stale shortfall. ONE reading is said as one reading
    // (a single stale body is a reading too, and "has read … since" would then stand for as long as nothing follows it).
    if (ep.clear.n < 2) return `One reading, at ${poolOutWhen(ep.clear.firstMs, ctx)}, has the panel's backup capacity at ${kwh(countedWh)} kWh, the sum of its ${n}.`;
    return `The panel's backup capacity has read ${kwh(countedWh)} kWh, the sum of its ${n}, since ${poolOutWhen(ep.clear.firstMs, ctx)}; ${underSince(ep.sinceMs, ep.clear.firstMs, ctx)}.`;
  }
  if (countedWh == null) return "The panel's data carries no backup capacity right now.";
  if (expectedWh == null) return `The panel's backup capacity reads ${kwh(countedWh)} kWh; its ${n} do not all report a capacity.`;
  return `The panel's backup capacity reads ${kwh(countedWh)} kWh; its ${n} add up to ${kwh(expectedWh)} kWh.`;
}

function sinceSentence(ep: PoolOutEpisode, ctx: PoolOutTextCtx): string {
  const since = poolOutWhen(ep.sinceMs, ctx);
  const head = ep.how === 'flap'
    ? `It has read under the sum of its slots ${ep.flapSteps} times since ${since}`
    : `It first read under the sum of its slots at ${since}`;
  // `before` is the last whole reading BEFORE the streak that raised (a flap raise: before its last step), and the
  // sentence says so: it stands on while the clear is pending on one reading, beside a newer reading at the same figure.
  return ep.before
    ? `${head}; the last reading at ${kwh(ep.before.capWh)} kWh before ${ep.how === 'flap' ? 'the latest of them' : 'that'} was at ${poolOutWhen(ep.before.atMs, ctx)}.`
    : `${head}; no earlier reading at the full capacity is on record.`;
}

function observedSentence(ep: PoolOutEpisode, ctx: PoolOutTextCtx): string {
  const ev = ep.evidence;
  if (ep.slots == null || ev == null) {
    const head = ep.k === 1 ? 'Which slot is not established' : 'Which slots are not established';
    // A set the readings agree on, on its way to the naming dwell (the pending change at the latched count): the one
    // push this alarm gets says what they point at, where "the readings do not single out one slot" was false of them.
    // (Readings that named different sets leave no pending change behind them: its naming was started again.)
    const pend = ep.change != null && ep.change.k === ep.k && ep.change.slots != null && ep.change.names != null ? ep.change : null;
    if (pend != null && pend.names != null && pend.slots != null) {
      const n = pend.names.n;
      return `${head}: ${n} reading${n === 1 ? '' : 's'} since ${poolOutWhen(pend.names.firstMs, ctx)} point${n === 1 ? 's' : ''} at ${slotWord(pend.slots)}, and a slot is named only from ${POOL_OUT_STRONG_MIN_OBS} such readings over ${POOL_OUT_STRONG_MIN_MS / 60_000} minutes.`;
    }
    return `${head}: no slot has been named by ${POOL_OUT_STRONG_MIN_OBS} readings over ${POOL_OUT_STRONG_MIN_MS / 60_000} minutes.`;
  }
  const at = poolOutWhen(ev.atMs, ctx);
  if (ev.by === 'flow' && ev.w != null) {
    const out = ev.w.filter((x) => ev.slots.includes(x.slot));
    const rest = ev.w.filter((x) => !ev.slots.includes(x.slot));
    return `At ${at} ${slotWord(out.map((x) => x.slot))} delivered ${listText(out.map((x) => `${watts(x.w)} W`))} while ${slotWord(rest.map((x) => x.slot))} delivered ${listText(rest.map((x) => `${watts(x.w)} W`))}.`;
  }
  if (ev.by === 'pct' && ev.pcts != null && ev.poolPct != null) {
    const out = ev.pcts.filter((x) => ev.slots.includes(x.slot));
    const rest = ev.pcts.filter((x) => !ev.slots.includes(x.slot));
    return `At ${at} the pool read ${pctText(ev.poolPct)}: the mean of ${slotWord(rest.map((x) => x.slot))} (${listText(rest.map((x) => pctText(x.pct)))}), not of all ${ev.pcts.length} with ${slotWord(out.map((x) => x.slot))} (${listText(out.map((x) => pctText(x.pct)))}).`;
  }
  const many = ev.slots.length > 1;
  if (ev.why === 'all-out') return `At ${at} the panel's backup capacity read 0.0 kWh.`;
  if (ev.why === 'not-listed') return `At ${at} the panel's data held no connection flag for ${slotWord(ev.slots)}.`;
  if (ev.why === 'not-connected') return `At ${at} ${slotWord(ev.slots)} ${many ? 'were' : 'was'} not listed as connected to the panel.`;
  return `At ${at} ${slotWord(ev.slots)} reported no capacity of ${many ? 'their' : 'its'} own.`;
}

const LIST_NAMES: Array<[keyof PoolOutLast['errLists'], string]> = [['backup', 'backup'], ['master', 'master'], ['hall', 'hall']];

/** The codes, lists and flags as the panel sent them, and whether anything was quoted. NO meaning is attached to any. */
function codeSentences(ep: PoolOutEpisode, last: PoolOutLast): { text: string[]; quoted: boolean } {
  const text: string[] = [];
  const subject = ep.slots != null && ep.slots.length > 0 ? ep.slots : null;
  const codes = last.slots.filter((x) => x.errorCodeNum != null && x.errorCodeNum !== 0);
  for (const c of codes) text.push(`The panel reports ${renderErrorCode(c.errorCodeNum as number)} for slot ${c.slot}.`);
  const withEntries = LIST_NAMES.filter(([key]) => (last.errLists[key]?.count ?? 0) > 0);
  const unread = LIST_NAMES.filter(([key]) => last.errLists[key] == null);
  for (const [key, name] of withEntries) {
    const list = last.errLists[key] as ErrList;
    text.push(`Its ${name} error list holds ${list.count} ${list.count === 1 ? 'entry' : 'entries'}: ${renderErrEntries(list)}.`);
  }
  if (codes.length === 0 && withEntries.length === 0) {
    const judged = last.slots.filter((x) => subject == null || subject.includes(x.slot));
    const who = subject ? slotWord(subject) : 'any slot';
    const code = judged.length > 0 && judged.every((x) => x.errorCodeNum === 0) ? `no error code for ${who}` : `no error-code reading for ${who}`;
    text.push(unread.length === 0
      ? `The panel's cloud data carries ${code} and three empty error lists.`
      : `The panel's cloud data carries ${code}; its error lists could not all be read.`);
  } else if (unread.length > 0) {
    text.push(`Its ${listText(unread.map(([, name]) => name))} error ${unread.length === 1 ? 'list' : 'lists'} could not be read.`);
  }
  const flags = last.flags.filter((f) => subject == null || subject.includes(f.slot));
  for (const slot of [...new Set(flags.map((f) => f.slot))]) {
    const items = flags.filter((f) => f.slot === slot).map((f) => {
      const why = f.others != null ? ` (the other ${f.others.length === 1 && last.slots.length === 2 ? 'slot' : 'slots'}: ${listText(f.others)})` : f.earlier != null ? ` (earlier: ${f.earlier})` : '';
      return `${f.key} ${f.value}${why}`;
    });
    text.push(`It also reports for slot ${slot}: ${items.join(', ')}.`);
  }
  if (last.panelFlags.length > 0) text.push(`The panel also reports ${listText(last.panelFlags.map((f) => `${f.key} ${f.value}`))}.`);
  return { text, quoted: codes.length > 0 || withEntries.length > 0 || flags.length > 0 || last.panelFlags.length > 0 };
}

/**
 * The alert's detail. Every sentence states what was read and when, so it is true in every branch: after a restart,
 * during a stale shadow, with the slot unidentified, with the lists unreadable, while the clear is pending. Sentences
 * that read "now" come from the newest usable observation, and the last sentence says so when that one is old.
 */
export function poolOutDetail(state: PoolOutState, ctx: PoolOutTextCtx): string {
  const ep = state.episode;
  if (!ep) return '';
  const last = state.last;
  const out: string[] = [leadSentence(ep, last, ctx)];
  // A critical raised by the grid says so second: the reason for the severity, straight after what is read. (The
  // voice reads poolOutSpoken, which carries it too.)
  const gridSecond = ep.gridCritical && ep.gridAbsentAtMs != null;
  if (gridSecond) out.push(`The panel reported no grid at ${poolOutWhen(ep.gridAbsentAtMs as number, ctx)}.`);
  // The title carries the LATCHED count and the lead states the newest reading. When that reading is short by another
  // count (a second Core's first minutes; a Core back while another is out), the detail says which the alarm stands at.
  if (last != null && last.cap.v === 'fault' && last.cap.k != null && last.cap.k !== ep.k) {
    out.push(`This alarm counts ${ep.k} Core${ep.k === 1 ? '' : 's'} out: the capacity has not read ${last.cap.k} slot${last.cap.k === 1 ? '' : 's'} short for a full dwell (10 to 15 minutes of readings).`);
  }
  // The pending-clear lead carries the "first read under" instant itself, from its second reading on.
  if (!(last != null && last.cap.v === 'healthy' && ep.clear != null && ep.clear.n >= 2)) out.push(sinceSentence(ep, ctx));
  out.push(observedSentence(ep, ctx));
  if (last != null) {
    for (const n of ep.slots ?? []) {
      const r = last.slots.find((x) => x.slot === n);
      if (!r) continue;
      const listed = r.isConnect == null ? "has no connection flag in the panel's data" : r.isConnect === 1 ? 'is listed as connected' : 'is not listed as connected';
      out.push(`Slot ${n} ${listed} and ${r.pct == null ? 'has no percent reported' : `reads ${pctText(r.pct)}`}.`);
    }
    const codes = codeSentences(ep, last);
    out.push(...codes.text);
    out.push(codes.quoted
      ? 'Cause not established: the values above are quoted as the panel sent them, and no meaning is on record for them.'
      : 'Cause not established.');
    out.push(last.pool.coherent && last.pool.remainWh != null && last.pool.fullCapWh != null && last.pool.pct != null
      ? `Backup now: ${kwh(last.pool.remainWh)} kWh of ${kwh(last.pool.fullCapWh)} kWh counted (${pctText(last.pool.pct)}).`
      : "Backup now: the panel's pool figures cannot be read together right now.");
    if (gridSecond) { if (last.grid === 'present') out.push('Its newest reading shows the grid present.'); }
    else if (last.grid === 'present') out.push('The grid is present.');
    else if (last.grid === 'absent') out.push(`The panel reported no grid at ${poolOutWhen(last.atMs, ctx)}.`);
    else out.push('Grid presence is not known right now.');
    if (ctx.nowMs - last.atMs > POOL_OUT_STALE_NOTE_MS) out.push(`No new panel reading since ${poolOutWhen(last.atMs, ctx)}.`);
  } else {
    out.push('Cause not established.');
    out.push('The newest panel reading is not on record.');
  }
  return out.join(' ');
}

/** The spoken message of a critical says the title twice around its detail, and the first of two spoken passes has
 *  17 s on the install it was measured on, where 318 characters rendered in 12.8 to 13.9 s (plus about 1.5 s after a
 *  change of voice): 354 characters is the most that fits. The detail's own lead ran this alarm's criticals to 349–446.
 *  test/poolOutAlert.test.ts builds every shape and holds each at or under this figure. */
export const POOL_OUT_SPOKEN_MESSAGE_MAX_CHARS = 345;

/**
 * What the broadcast READS after the title, in place of the first 200 characters of the detail: the capacity in one
 * short sentence, and the grid in a second when the alarm is critical by it. The push and the card keep the whole
 * detail. Every figure is a reading with its tense or its time, as in the detail.
 */
export function poolOutSpoken(state: PoolOutState, ctx: PoolOutTextCtx): string {
  const ep = state.episode;
  if (!ep) return '';
  const last = state.last;
  const { countedWh, expectedWh } = last?.cap ?? { countedWh: null, expectedWh: null };
  let lead: string;
  if (last != null && last.cap.v === 'fault' && countedWh != null && expectedWh != null) {
    lead = `Backup capacity reads ${kwh(countedWh)} of ${kwh(expectedWh)} kWh.`;
  } else if (last != null && last.cap.v === 'healthy' && countedWh != null && expectedWh != null && ep.clear != null) {
    // The clear is pending: what the panel reads now. One reading is said as one reading, as the detail says it.
    lead = ep.clear.n < 2
      ? `Backup capacity read ${kwh(countedWh)} of ${kwh(expectedWh)} kWh at ${poolOutWhen(ep.clear.firstMs, ctx)}.`
      : `Backup capacity has read ${kwh(countedWh)} of ${kwh(expectedWh)} kWh since ${poolOutWhen(ep.clear.firstMs, ctx)}.`;
  } else {
    // No newest reading, or one whose capacity cannot be compared: the newest SHORT reading, in the past tense.
    lead = `Backup capacity read ${kwh(ep.lastFault.capWh ?? ep.countedWh)} of ${kwh(ep.expectedWh)} kWh at ${poolOutWhen(ep.lastFault.atMs, ctx)}.`;
  }
  return ep.gridCritical && ep.gridAbsentAtMs != null ? `${lead} No grid reported at ${poolOutWhen(ep.gridAbsentAtMs, ctx)}.` : lead;
}

export interface PoolOutAlertParts {
  severity: 'warning' | 'critical';
  title: string;
  fault: string;
  detail: string;
  /** What the broadcast reads after the title (poolOutSpoken); the detail is the push body and the card. */
  spoken: string;
  facts: Array<{ label: string; value: string }>;
}

/** Everything the alert carries except its id, device and serial (the caller has those). Null when no episode stands. */
export function poolOutAlertParts(state: PoolOutState, ctx: PoolOutTextCtx): PoolOutAlertParts | null {
  const ep = state.episode;
  const severity = poolOutSeverity(state);
  if (!ep || !severity) return null;
  const last = state.last;
  const facts: Array<{ label: string; value: string }> = [];
  if (last?.cap.countedWh != null) facts.push({ label: 'Counted now', value: `${kwh(last.cap.countedWh)} kWh` });
  facts.push({ label: 'Before', value: `${kwh(ep.before?.capWh ?? ep.baselineWh)} kWh` });
  facts.push({
    label: 'Out',
    value: ep.slots == null ? `not identified (${ep.k} slot${ep.k === 1 ? '' : 's'})` : ep.slots.map((n) => {
      const r = last?.slots.find((x) => x.slot === n);
      const bits = [r?.pct != null ? pctText(r.pct) : null, r?.w != null ? `${watts(r.w)} W` : null, r == null ? null : r.isConnect == null ? 'no connection flag' : r.isConnect === 1 ? 'listed' : 'not listed'].filter((b) => b != null);
      return bits.length ? `slot ${n} (${bits.join(', ')})` : `slot ${n}`;
    }).join('; '),
  });
  if (last) {
    facts.push({ label: 'Signals', value: `capacity ${last.cap.v}; percent ${last.pct.v}; power ${last.flow.v}; flags ${last.flagFault ? 'differ' : 'no vote'}` });
    const codes = last.slots.filter((x) => x.errorCodeNum != null && x.errorCodeNum !== 0).map((x) => `${renderErrorCode(x.errorCodeNum as number)} (slot ${x.slot})`);
    const entries = LIST_NAMES.map(([key, name]) => ({ name, n: last.errLists[key]?.count ?? 0 })).filter((x) => x.n > 0).map((x) => `${x.name} list ${x.n}`);
    facts.push({ label: 'Panel codes', value: [...codes, ...entries].join('; ') || 'none read' });
    // While the episode is critical by the grid the fact says so; a newest reading that shows the grid present is
    // said beside it, as the detail says it (the critical ends at the third such reading).
    facts.push({ label: 'Grid', value: ep.gridCritical ? (last.grid === 'present' ? 'not detected; present on the newest reading' : 'not detected') : last.grid === 'present' ? 'present' : last.grid === 'absent' ? 'not detected on the newest reading' : 'not known' });
  }
  facts.push({ label: 'Since', value: poolOutWhen(ep.sinceMs, ctx) });
  return { severity, title: poolOutTitle(ep.k, ep.slots), fault: poolOutFault(ep.k, ep.slots), detail: poolOutDetail(state, ctx), spoken: poolOutSpoken(state, ctx), facts };
}

/** The newest end record: what the resolve hook of this alert (and only this one) sends in place of the stale detail. */
export function poolOutLatestEnd(state: PoolOutState): PoolOutEnd | null {
  return state.ends.length > 0 ? state.ends[state.ends.length - 1] : null;
}

/**
 * The return notice: one title per end kind, and a body that states the capacities, the duration, the slot's percent and
 * the percent step. Every figure carries its time, because a resolve push waits for quiet hours to end.
 */
export function poolOutEndText(end: PoolOutEnd, ctx: PoolOutTextCtx): { title: string; body: string } {
  const n = `${end.rosterSize} slot${end.rosterSize === 1 ? '' : 's'}`;
  const named = end.slots != null && end.slots.length > 0 ? end.slots : null;
  const title = end.kind === 'returned'
    ? `${coresHead(end.k)} back in the backup pool: ${slotsTail(end.k, end.slots)}`
    : `Backup pool capacity back at the sum of its ${n}`;
  const out: string[] = [
    `The panel's backup capacity has read ${kwh(end.capWh)} kWh, the sum of its ${n}, since ${poolOutWhen(end.backAtMs, ctx)}; ${underSince(end.sinceMs, end.backAtMs, ctx)}.`,
  ];
  const reads = named ? end.slotPct.filter((x) => x.pct != null) : [];
  const ev = end.evidence;
  if (end.kind === 'returned' && ev?.by === 'flow' && ev.w != null) {
    const back = ev.w.filter((x) => ev.slots.includes(x.slot));
    const pcts = (ev.pcts ?? []).filter((x) => ev.slots.includes(x.slot));
    out.push(`At ${poolOutWhen(ev.atMs, ctx)} ${slotWord(back.map((x) => x.slot))} delivered ${listText(back.map((x) => `${watts(x.w)} W`))}${pcts.length === back.length ? ` and read ${listText(pcts.map((x) => pctText(x.pct)))}` : ''}.`);
  } else if (end.kind === 'returned' && ev?.by === 'pct' && ev.pcts != null && ev.poolPct != null) {
    const back = ev.pcts.filter((x) => ev.slots.includes(x.slot));
    out.push(`At ${poolOutWhen(ev.atMs, ctx)} the pool read ${pctText(ev.poolPct)}, the mean of all ${ev.pcts.length} slots with ${slotWord(back.map((x) => x.slot))} (${listText(back.map((x) => pctText(x.pct)))}).`);
  } else if (end.kind === 'returned' && named != null && named.length === end.k) {
    // Every named slot was confirmed, but not all of them by one kind of evidence on one reading (that is `ev`).
    out.push(`Since then readings have confirmed ${slotWord(named)}, each by its power or by the pool percent.`);
  } else if (end.kind === 'returned') {
    out.push('Since then a reading has shown every slot carrying its share of the load.');
  } else {
    out.push(`No reading since then confirms ${named ? slotWord(named) : 'the slot'} by its power or by the pool percent: the capacity alone is the evidence.`);
    if (reads.length > 0) {
      out.push(`${reads.length === 1 ? `Slot ${reads[0].slot}` : `Slots ${listText(reads.map((x) => x.slot))}`} read ${listText(reads.map((x) => pctText(x.pct as number)))} at ${poolOutWhen(end.atMs, ctx)}.`);
    }
  }
  if (end.pctBefore != null && end.pctAfter != null && end.pctBeforeAtMs != null && end.pctAfterAtMs != null) {
    const step = end.pctAfter - end.pctBefore;
    const adjacent = end.pctAfterAtMs - end.pctBeforeAtMs >= 0 && end.pctAfterAtMs - end.pctBeforeAtMs <= POOL_OUT_STEP_MAX_GAP_MS;
    if (adjacent && Math.abs(step) >= POOL_OUT_STEP_MIN_PTS) {
      // The percent is the remaining energy over the capacity, and the capacity changed between these two readings:
      // true whatever else flowed in those minutes, where "not charging" was not (a pool can gain 3 points in 5).
      out.push(`The pool percent read ${pctText(end.pctBefore)} before and ${pctText(end.pctAfter)} after: the capacity it is a percent of changed between those two readings, so that step is not a measure of ${step > 0 ? 'charging' : 'discharge'}.`);
    } else if (Math.abs(step) >= 1) {
      out.push(`The pool percent read ${pctText(end.pctBefore)} at ${poolOutWhen(end.pctBeforeAtMs, ctx)} and ${pctText(end.pctAfter)} at ${poolOutWhen(end.pctAfterAtMs, ctx)}.`);
    }
  }
  if (end.remainWh != null && end.pct != null) {
    out.push(`Backup at ${poolOutWhen(end.atMs, ctx)}: ${kwh(end.remainWh)} kWh of ${kwh(end.capWh)} kWh counted (${pctText(end.pct)}).`);
  }
  return { title, body: out.join(' ') };
}
