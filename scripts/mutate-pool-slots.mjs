#!/usr/bin/env node
/**
 * mutate-pool-slots.mjs — committed harness for v1.209.0 (part C): only the Cores in the panel's backup pool are counted
 * for the force-charge's rate and sent ON.
 *
 * On 2026-11-16 a Core was out of the panel's backup pool, the force-charge's rate counted three Cores, and the start came
 * late. The pool alarm's latched verdict is now read (poolOut.ts poolOutRead, through SnapshotStore.poolOutRead), turned
 * into the slots an ON may go to and the count the rate is timed with (nightForceCharge.ts forceChargePoolSlots), and
 * followed by the start, the line re-ON and the ON verify. The two uses fail safe in opposite directions: the RATE counts
 * a doubtful slot OUT, the ON keeps a doubtful slot IN. Each mutant below removes or moves one rule of that.
 *
 * (R) THE READ (poolOut.ts poolOutRead): the names (a list only, whole slots of the panel's three, each once, ascending,
 *     a copy); the count and what is no count; the at-most (the larger of the count and the other set's on its way);
 *     returning; contested, each half; the data time (the newest reading whose capacity could be judged); no episode.
 * (N) THE STORE'S READER (snapshot.ts): that panel's own state; a read that throws is null, and said.
 * (S) THE SELECTION (nightForceCharge.ts forceChargePoolSlots): what "no alarm" is; the larger of the two counts; a slot
 *     left out only when named, not returning, not contested and fresh, each side of the freshness window; named AND
 *     connected; the slots short and not identified; the cap that keeps the rate's count at 1; the targets.
 * (D) THE START AND THE RE-ON (decideForceCharge, lineReOnDue): a slot left out is no candidate; "every slot left out"
 *     against "no slots connected", and its class; the fallback rate's count (never raised, a whole number of 1 or
 *     more, on a cost night and on a line night).
 * (V) THE ON VERIFY (verifyForceChargeOn): the exemption; what a verified verdict names out of the pool and at the
 *     ceiling; a re-issue never to a slot out of the pool; a failure with no slot of ours reading ON names the exempt
 *     slots too, in the ON's order, and a slot at the ceiling is not added back; with nothing to re-issue the failure
 *     is declared after the grace, once, with no noRetry; each verdict carries its own list.
 * (A) THE RECORD (nightChargeActuator.ts forceChargeLeftOutSlots): null by default, coerced on load, null for an empty
 *     list, and not carried to the next night (armFromPlan, chargeCycle.ts carryCeilingPrior).
 * (X) THE WIRING (index.ts): the tick's read of the verdict, the list handed on, the slots reading ON handed on as
 *     read, the two fields of the decision's options, the write-ahead persist, the morning summary's field, the planner's
 *     count, the once-a-night line (its guard, its key, its memory, its two figures). `slotCount: pool.rateCount` is
 *     mutant lxvi of mutate-force-charge.mjs.
 * (W) THE WORDS OF THE ON AND OF ITS VERIFY (index.ts): the fallback's count, each count named as what it is, the slot
 *     left out, a slot out of the pool never listed as reading ON.
 * index.ts cannot be imported by a test: (X) and (W) are held by the source pins of test/forceChargePoolSlots.test.ts.
 *
 *   node scripts/mutate-pool-slots.mjs [--only <id prefix>]
 *
 * ★ Every id starts PSL- (no other harness uses it). Anchor-asserted (each anchor matches exactly once); every mutant must
 *   TYPECHECK (one that does not is reported INVALID and fails the run); the subset alone decides (no full-suite step), and
 *   the failing tests of each mutant are named. Run with MUTATE_CONCURRENCY=3, on a GREEN tree.
 *
 * Not written, because no input tells them apart:
 *  - poolOutRead: the `typeof … === 'number'` half beside each Number.isInteger test (Number.isInteger of what is no
 *    number is false); `k >= 0` against `k > 0` in the count's check (0 is 0 either way).
 *  - forceChargePoolSlots: `pool == null ||` in the early return (a null verdict counts 0 and names nothing: the half
 *    only narrows the type); `named.length > 0 &&` in the slots left out (with no name there is no named slot connected);
 *    the `typeof` test and the Number.isFinite test of the data time, each alone (the other one and the two comparisons
 *    refuse null, NaN and both infinities); `k > 0` against `k >= 0` in its count check.
 *  - decideForceCharge: `o.rateSlotCount != null &&` beside Number.isInteger (null is no integer).
 *  - verifyForceChargeOn: `&& !o.slotsOn!.includes(n)` in the exempt slots a failure names (they are computed only when
 *    no slot of ours reads ON); `outOff.length > 0 ? … : pending` against the filter alone (the same slots in the same
 *    order); `slots: failed` against `slots: ours` in the failure with nothing to re-issue (every slot of ours is then
 *    out of the pool and reads OFF).
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const PO = resolve(SERVER, 'src/poolOut.ts');
const SN = resolve(SERVER, 'src/snapshot.ts');
const NF = resolve(SERVER, 'src/nightForceCharge.ts');
const NA = resolve(SERVER, 'src/nightChargeActuator.ts');
const CC = resolve(SERVER, 'src/chargeCycle.ts');
const IX = resolve(SERVER, 'src/index.ts');

const SUBSET = ['test/forceChargePoolSlots.test.ts'];

const NL = "\n";

/* poolOutRead (poolOut.ts), line by line. */
const R_ASOF = "  const asOfMs = state?.lastCapMs ?? null;";
const R_EP = "  const ep = state?.episode;";
const R_NOEP = "  if (ep == null) return { named: [], count: 0, countAtMost: 0, returning: false, contested: false, asOfMs };";
const R_SLOTS = "  const slots: unknown[] = Array.isArray(ep.slots) ? ep.slots : [];";
const R_NAMED = "  const named = [...new Set(slots.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= SHP2_SOURCE_SLOTS))]";
const R_SORT = "    .sort((a, b) => a - b);";
const R_WHOLE = "  const whole = (k: unknown): number => (typeof k === 'number' && Number.isInteger(k) && k >= 0 ? k : 0);";
const R_COUNT = "  const count = whole(ep.k);";
const R_RET1 = "    named, count, countAtMost: Math.max(count, whole(ep.change?.k)),";
const R_RET2 = "    returning: ep.clear != null, contested: ep.less != null || ep.change != null, asOfMs,";

/* SnapshotStore.poolOutRead (snapshot.ts). */
const N_READ = "      return poolOutRead(this.poolOutBySn.get(sn));";
const N_FAIL = "      this.poolOutFailed(\"the standing alarm's slots could not be read for the force-charge\", e, 'every connected slot is counted for its rate and sent ON');";

/* forceChargePoolSlots (nightForceCharge.ts), line by line. */
const S_NAMED = "  const named: readonly number[] = pool != null && Array.isArray(pool.named) ? pool.named : [];";
const S_WHOLE = "  const whole = (k: unknown): number => (typeof k === 'number' && Number.isInteger(k) && k > 0 ? k : 0);";
const S_COUNT = "  const count = pool != null ? Math.max(whole(pool.count), whole(pool.countAtMost)) : 0;";
const S_EARLY_IF = "  if (pool == null || (count === 0 && named.length === 0)) {";
const S_EARLY_RET = "    return { targets: [...connected], leftOut: [], rateCount: connected.length, outCount: 0 };";
const S_FRESH = "  const fresh = typeof asOfMs === 'number' && Number.isFinite(asOfMs) && nowMs - asOfMs >= 0 && nowMs - asOfMs <= POOL_OUT_SENSOR_FRESH_MS;";
const S_LEFT = "  const leftOut = named.length > 0 && pool.returning === false && pool.contested === false && fresh ? namedConnected : [];";
const S_OUT = "  const outCount = Math.max(0, Math.min(namedConnected.length + Math.max(0, count - named.length), connected.length - 1));";
const S_TARGETS = "    targets: connected.filter((n) => !leftOut.includes(n)),";
const S_RATE = "    rateCount: connected.length - outCount,";
const S_OUTC = "    outCount,";

/* decideForceCharge and lineReOnDue (nightForceCharge.ts). */
const D_WHY = "  noPoolSlots: 'every connected battery slot is left out: the pool alarm names its Core out of the panel\\'s backup pool',";
const D_SLOTS = "  const slots = o.connectedSlots.filter((n) => Number.isInteger(n) && n >= 1 && n <= SHP2_SOURCE_SLOTS && !(o.poolOutSlots != null && o.poolOutSlots.includes(n)));";
const D_NONE = "  if (slots.length === 0) return { kind: 'none', why: o.poolOutSlots != null && o.poolOutSlots.length > 0 ? W.noPoolSlots : W.noSlots };";
const D_RATE = "  const rateSlots = o.rateSlotCount != null && Number.isInteger(o.rateSlotCount) && o.rateSlotCount >= 1 ? Math.min(slots.length, o.rateSlotCount) : slots.length;";
const D_LINE_START = "    if (nowMs < forceChargeLineStartAtMs(endMs, mode.startTargetPct, o.poolSocPct, o.fullKwh, o.chargeRateKw, o.evDisplacedKwh, rateSlots)) {";
const D_COST_START = "  if (nowMs < forceChargeStartAtMs(endMs, target, o.poolSocPct, o.fullKwh, o.chargeRateKw, o.evDisplacedKwh, rateSlots)) { // window checked above";
const D_REON = "  const slots = ours.filter((n) => !o.slotsOn!.includes(n) && o.connectedSlots.includes(n) && coreBelowStop(n) && !(o.poolOutSlots != null && o.poolOutSlots.includes(n)));";

/* verifyForceChargeOn (nightForceCharge.ts). */
const V_NOTON = "  const notOn = ours.filter((n) => !o.slotsOn!.includes(n) && !atCeiling(n) && !outOfPool(n));";
const V_OUT = "    const out = off.filter(outOfPool);";
const V_RET_IF = "    return out.length > 0";
const V_RET_SPLIT = "      ? { kind: 'onVerified', atCeiling: off.filter((n) => !outOfPool(n)), outOfPool: out }";
const V_JUDGED = "  const judged = ours.some(outOfPool) ? ours.filter((n) => !outOfPool(n)) : ours;";
const V_OUTOFF = "  const outOff = anyOn ? [] : ours.filter((n) => outOfPool(n) && !o.slotsOn!.includes(n));";
const V_FAILED = "  const failed = outOff.length > 0 ? ours.filter((n) => pending.includes(n) || outOff.includes(n)) : pending;";
const V_FAILED0 = "  if (failed.length === 0) return { kind: 'none' };";
const V_ONCE = "  if (s.forceChargeOnFailedAtMs != null) return { kind: 'none' };";
const V_GRACE = "  if (since < FORCE_CHARGE_ON_VERIFY_AFTER_MS) return { kind: 'none' };";
const V_EMPTY = "  if (pending.length === 0) return { kind: 'onFailed', slots: failed };";
const V_NORETRY = "      return { kind: 'onFailed', slots: failed, noRetry: true };";
const V_RETRY = "    return { kind: 'onRetry', slots: pending };";
const V_LAST = "\n  return { kind: 'onFailed', slots: failed };\n}";

/* The record (nightChargeActuator.ts, chargeCycle.ts). */
const A_DEFAULT = "    forceChargeLeftOutSlots: null,";
const A_COERCE = "    forceChargeLeftOutSlots: nonEmptySlotList(o.forceChargeLeftOutSlots),";
const A_NONEMPTY = "  return slots != null && slots.length > 0 ? slots : null;";
const A_CARRY = "        ? prev.forceChargeCeilingPriorPct : null,";
const C_CARRY = "  return { ...to, forceChargeCeilingPriorPct: from.forceChargeCeilingPriorPct, forceChargeCeilingRestoredAtMs: null,";

/* index.ts: the planner, the tick, the ON, the ON verified, the morning summary. */
const X_PLAN = "  const planConnectedSlots = planHwSlots == null ? null : forceChargePoolSlots(planHwSlots, store.poolOutRead(shp2.sn), nowMs).rateCount;";
const X_POOL = "  const pool = forceChargePoolSlots(hwSlots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS), store.poolOutRead(shp2.sn), nowMs);";
const X_CONN = "  const connectedSlots = pool.leftOut.length > 0 ? pool.targets : hwSlots;";
const X_GRIDSTA = "    gridStaLost: sp != null && typeof sp.gridSta === 'number' && sp.gridSta !== 1,";
const X_SLOTSON = "    slotsOn,";
const X_POS = "    poolOutSlots: pool.leftOut,";
const X_RSC = "    rateSlotCount: pool.rateCount,";
const X_GUARD = "      if (pool.leftOut.length > 0 || pool.outCount > 0) {";
const X_KEY = "        const poolKey = `${pool.rateCount}|${pool.outCount}|${pool.leftOut.join(',')}`;";
const X_HAS = "        if (!forceChargeWhyLogged.reasons.has(poolKey)) {";
const X_ADD = "          forceChargeWhyLogged.reasons.add(poolKey);";
const X_LINE = "          app.log.info(`night-charge: force-charge for ${state.day}: the pool alarm stands for this panel — its charge rate counts ${pool.rateCount} of the ${pool.rateCount + pool.outCount} connected Core(s)${pool.leftOut.length > 0 ? `, and an ON is not sent to slot(s) ${pool.leftOut.join(',')} (the alarm names their Core out of the backup pool)` : ''}.`);";
const X_PERSIST = "    persistNightActuation({ ...nightActuationMem, ...onStamp, forceChargeLeftOutSlots: pool.leftOut.length > 0 ? [...pool.leftOut] : null });";
const X_SUMMARY = "        leftOutSlots: state.forceChargeLeftOutSlots,";
const W_FALLBACK = "    const fallbackSlots = pool.rateCount >= 1 ? Math.min(slotsNow, pool.rateCount) : slotsNow;";
const W_BOUND = "    const boundCores = pool.outCount > 0 ? `${pool.rateCount} Core(s) counted in the pool` : `${slotsNow} connected Core(s)`;";
const W_FBCORES = "    const fallbackCores = pool.outCount > 0 ? `${fallbackSlots} Core(s) counted in the pool` : `${slotsNow} connected Core(s)`;";
const W_FB_IF = "      : (planRateFallbackKw(fallbackSlots) === FORCE_CHARGE_PLAN_RATE_KW";
const W_NOTE = "    const leftOutNote = pool.leftOut.length > 0 ? `; slot(s) ${pool.leftOut.join(',')} left out: the pool alarm names its Core out of the backup pool` : '';";
const W_VOUT = "    const outOfPool = action.outOfPool ?? [];";
const W_VON = "    const on = (state.forceChargeSlots ?? []).filter((n) => !action.atCeiling.includes(n) && !outOfPool.includes(n));";

/* A fragment two lines above carry: the slots left out, taken out of a list of ON candidates. */
const LEFT_OUT_FILTER = " && !(o.poolOutSlots != null && o.poolOutSlots.includes(n))";

/** A mutant's line: `line` with `from` (in it exactly once) replaced by `to`, and the marker. Throws on a fragment that is not there. */
const swap = (line, from, to) => {
  if (line.split(from).length !== 2) throw new Error(`swap: ${JSON.stringify(from)} is not in the line exactly once: ${line}`);
  return `${line.replace(from, () => to)} /* MUTANT */`;
};

const MUTANTS = [
  /* ── R: poolOutRead ── */
  {
    id: 'PSL-R-i. ★★★ the data time is the newest usable reading\'s',
    file: PO,
    find: R_ASOF,
    to: "  const asOfMs = state?.lastUsableMs ?? null; /* MUTANT */",
    why: 'Readings whose capacity cannot be judged keep the verdict young: a named Core is left out of the ON all night on an alarm no reading has confirmed since.',
  },
  {
    id: 'PSL-R-ii. ★★★ no verdict carries a data time',
    file: PO,
    find: R_ASOF,
    to: "  const asOfMs = null; /* MUTANT */",
    why: 'No verdict is ever fresh: no slot is left out, and an ON is written every night to a Core that is out of the pool.',
  },
  {
    id: 'PSL-R-iii. ★★★ a panel with no tracker state throws in the read',
    file: PO,
    find: R_EP,
    to: "  const ep = state!.episode; /* MUTANT */",
    why: 'On a panel with no tracker state the read throws: the store takes it as no verdict and warns of a failure on an install where nothing failed.',
  },
  {
    id: 'PSL-R-iv. ★★★ with no alarm standing, at most one slot is out',
    file: PO,
    find: R_NOEP,
    to: swap(R_NOEP, 'countAtMost: 0', 'countAtMost: 1'),
    why: 'On every night with no alarm the rate counts a Core out: every start comes early and every plan\'s charge cap is a Core short.',
  },
  {
    id: 'PSL-R-v. ★★ with no alarm standing the read has no data time',
    file: PO,
    find: R_NOEP,
    to: swap(R_NOEP, 'asOfMs };', 'asOfMs: null };'),
    why: 'The read of a healthy pool carries no data time: nothing that reads it can tell a pool judged a minute ago from a panel never read.',
  },
  {
    id: 'PSL-R-vi. ★★★ a slot list that is no list is taken as one',
    file: PO,
    find: R_SLOTS,
    to: "  const slots: unknown[] = ep.slots ?? []; /* MUTANT */",
    why: 'A state whose slot list is not a list throws in the read: the store takes it as no verdict, and the rate counts every connected Core while one is out.',
  },
  {
    id: 'PSL-R-vii. ★★★ slot 0 is named',
    file: PO,
    find: R_NAMED,
    to: swap(R_NAMED, 'n >= 1 && ', 'n >= 0 && '),
    why: 'A latched slot 0 is counted among the names: the slot that is short and not identified is no longer counted, and the rate counts a Core that takes no charge.',
  },
  {
    id: 'PSL-R-viii. ★★★ slot 4 is named on a panel of three',
    file: PO,
    find: R_NAMED,
    to: swap(R_NAMED, 'n <= SHP2_SOURCE_SLOTS', 'n <= SHP2_SOURCE_SLOTS + 1'),
    why: 'A latched slot 4 is counted among the names: the slot that is short and not identified is no longer counted out of the rate.',
  },
  {
    id: 'PSL-R-ix. ★★★ slot 3 is never named',
    file: PO,
    find: R_NAMED,
    to: swap(R_NAMED, 'n <= SHP2_SOURCE_SLOTS', 'n < SHP2_SOURCE_SLOTS'),
    why: 'A Core out on slot 3 is never left out: an ON is written to it every night, and the record never says a slot was left out.',
  },
  {
    id: 'PSL-R-x. ★★★ a slot number that is not whole is named',
    file: PO,
    find: R_NAMED,
    to: swap(R_NAMED, 'Number.isInteger(n) && ', ''),
    why: 'A latched slot 1.5 is counted among the names: it hides a slot that is short and not identified from the rate.',
  },
  {
    id: 'PSL-R-xi. ★★★ a slot latched twice is named twice',
    file: PO,
    find: R_NAMED,
    to: "  const named = [...slots.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= SHP2_SOURCE_SLOTS)] /* MUTANT */",
    why: 'With two Cores out and one identified twice, the names fill the count: the second Core stays in the rate.',
  },
  {
    id: 'PSL-R-xii. ★★ the names are not ascending',
    file: PO,
    find: R_NAMED + NL + R_SORT,
    to: `${R_NAMED}; /* MUTANT */`,
    why: 'A set latched out of order is handed on out of order: the list no longer reads as the alarm\'s title and fault token do.',
  },
  {
    id: 'PSL-R-xiii. ★★★ the names are the tracker\'s own array',
    file: PO,
    find: R_RET1,
    to: "    named: Array.isArray(ep.slots) && ep.slots.length === named.length && ep.slots.every((n, i) => n === named[i]) ? ep.slots : named, count, countAtMost: Math.max(count, whole(ep.change?.k)), /* MUTANT */",
    why: 'A caller that alters the list it was handed alters the standing alarm\'s latched set: the title then names other slots.',
  },
  {
    id: 'PSL-R-xiv. ★★ a count that is not whole is handed on',
    file: PO,
    find: R_WHOLE,
    to: swap(R_WHOLE, 'Number.isInteger(k) && ', ''),
    why: 'A damaged state\'s count of 1.5 slots is handed on as read: only the caller\'s own check keeps it out of the charge rate.',
  },
  {
    id: 'PSL-R-xv. ★★ a negative count is handed on',
    file: PO,
    find: R_WHOLE,
    to: swap(R_WHOLE, 'k >= 0', 'k >= -1'),
    why: 'A damaged state\'s count of -1 is handed on as read: only the caller\'s own check keeps it out of the charge rate.',
  },
  {
    id: 'PSL-R-xvi. ★★★ the latched count is never read',
    file: PO,
    find: R_COUNT,
    to: "  const count = 0; /* MUTANT */",
    why: 'An alarm raised on the capacity alone, with no slot named, counts nothing out: the start is timed for a Core that takes no charge.',
  },
  {
    id: 'PSL-R-xvii. ★★★ the count is the one on its way through the dwell',
    file: PO,
    find: R_COUNT,
    to: "  const count = whole(ep.change?.k ?? ep.k); /* MUTANT */",
    why: 'A set that no dwell has confirmed is read as the latched count: the read and the alarm\'s title state different numbers of Cores out.',
  },
  {
    id: 'PSL-R-xviii. ★★★ the at-most is the count alone',
    file: PO,
    find: R_RET1,
    to: swap(R_RET1, 'Math.max(count, whole(ep.change?.k))', 'count'),
    why: 'A second Core on its way out of the pool is not counted until its dwell ends: for those minutes the start is timed for a Core that takes no charge.',
  },
  {
    id: 'PSL-R-xix. ★★★ the at-most is the other set\'s count alone',
    file: PO,
    find: R_RET1,
    to: swap(R_RET1, 'Math.max(count, whole(ep.change?.k))', 'whole(ep.change?.k)'),
    why: 'With no other set on its way the at-most reads 0, below the count: a reader that takes it alone counts every Core back in.',
  },
  {
    id: 'PSL-R-xx. ★★★ the at-most takes the fewer-short streak\'s count',
    file: PO,
    find: R_RET1,
    to: swap(R_RET1, 'whole(ep.change?.k)', 'whole(ep.less?.k)'),
    why: 'A larger set on its way through the dwell raises nothing: the second Core on its way out is not counted out of the rate.',
  },
  {
    id: 'PSL-R-xxi. ★★★ never returning',
    file: PO,
    find: R_RET2,
    to: swap(R_RET2, 'returning: ep.clear != null', 'returning: false'),
    why: 'A Core whose capacity reads whole again is still left out through the clear dwell: an ON that falls in those minutes leaves it uncharged for the night.',
  },
  {
    id: 'PSL-R-xxii. ★★★ returning is inverted',
    file: PO,
    find: R_RET2,
    to: swap(R_RET2, 'returning: ep.clear != null', 'returning: ep.clear == null'),
    why: 'Every standing alarm reads as returning: no named Core is ever left out, and an ON is written to a Core that is out of the pool.',
  },
  {
    id: 'PSL-R-xxiii. ★★★ fewer slots short on its way is no contest',
    file: PO,
    find: R_RET2,
    to: swap(R_RET2, 'contested: ep.less != null || ep.change != null', 'contested: ep.change != null'),
    why: 'Two Cores named and one back: while the smaller set runs its dwell both are still left out, and the Core that returned is sent no ON.',
  },
  {
    id: 'PSL-R-xxiv. ★★★ another set on its way is no contest',
    file: PO,
    find: R_RET2,
    to: swap(R_RET2, 'contested: ep.less != null || ep.change != null', 'contested: ep.less != null'),
    why: 'Readings name another slot than the latch does: the latched slot is still left out of the ON, on a name that may be wrong.',
  },

  /* ── N: the store's reader ── */
  {
    id: 'PSL-N-i. ★★★ a panel with no state reads another panel\'s alarm',
    file: SN,
    find: N_READ,
    to: "      return poolOutRead(this.poolOutBySn.get(sn) ?? [...this.poolOutBySn.values()][0]); /* MUTANT */",
    why: 'On an install with two panels the house panel takes the other panel\'s alarm: its Core is left out of an ON on a verdict about another panel.',
  },
  {
    id: 'PSL-N-ii. ★★★ a read that throws is thrown on',
    file: SN,
    find: N_FAIL,
    to: `${N_FAIL} if (e != null) throw e; /* MUTANT */`,
    why: 'A tracker state that cannot be read throws into the force-charge tick: that tick decides nothing, neither a start nor a stop.',
  },
  {
    id: 'PSL-N-iii. ★★★ a read that throws is contained in silence',
    file: SN,
    find: N_FAIL,
    to: "      void e; /* MUTANT */",
    why: 'A verdict that cannot be read is taken as no alarm with nothing in the log: the rate counts every connected Core night after night and nothing says why.',
  },

  /* ── S: forceChargePoolSlots ── */
  {
    id: 'PSL-S-i. ★★ names that are no list are taken as one',
    file: NF,
    find: S_NAMED,
    to: "  const named: readonly number[] = pool != null ? pool.named : []; /* MUTANT */",
    why: 'A verdict whose names are not a list throws in the tick, or withholds an ON on a string: the selection no longer fails toward sending ON.',
  },
  {
    id: 'PSL-S-ii. ★★ a count that is not whole is counted',
    file: NF,
    find: S_WHOLE,
    to: swap(S_WHOLE, 'Number.isInteger(k) && ', ''),
    why: 'A count of 1.5 slots gives the rate a count that is no number of Cores.',
  },
  {
    id: 'PSL-S-iii. ★★★ the at-most is not read',
    file: NF,
    find: S_COUNT,
    to: swap(S_COUNT, 'Math.max(whole(pool.count), whole(pool.countAtMost))', 'whole(pool.count)'),
    why: 'A second Core on its way out of the pool is not counted out of the rate: the start is timed for a Core that takes no charge.',
  },
  {
    id: 'PSL-S-iv. ★★★ the count is not read',
    file: NF,
    find: S_COUNT,
    to: swap(S_COUNT, 'Math.max(whole(pool.count), whole(pool.countAtMost))', 'whole(pool.countAtMost)'),
    why: 'A verdict with no at-most counts nothing out: a Core out and not identified stays in the rate.',
  },
  {
    id: 'PSL-S-v. ★★★ the smaller of the two counts',
    file: NF,
    find: S_COUNT,
    to: swap(S_COUNT, 'Math.max(', 'Math.min('),
    why: 'Doubt counts a Core back IN: with a second Core on its way out the rate still counts it.',
  },
  {
    id: 'PSL-S-vi. ★★★ "no alarm" on the count alone',
    file: NF,
    find: S_EARLY_IF,
    to: "  if (pool == null || count === 0) { /* MUTANT */",
    why: 'An alarm that names a slot beside a count that cannot be read is taken as no alarm: the named Core is sent ON and counted for the rate.',
  },
  {
    id: 'PSL-S-vii. ★★★ "no alarm" on the names alone',
    file: NF,
    find: S_EARLY_IF,
    to: "  if (pool == null || named.length === 0) { /* MUTANT */",
    why: 'A Core out and not identified is taken as no alarm: the rate counts every connected Core and the start comes late, as on 2026-11-16.',
  },
  {
    id: 'PSL-S-viii. ★★★ with no alarm the rate\'s count is 0',
    file: NF,
    find: S_EARLY_RET,
    to: swap(S_EARLY_RET, 'rateCount: connected.length', 'rateCount: 0'),
    why: 'A count of 0 is "unknown" to the rate: no per-Core bound on any night, the fastest rate and the latest start.',
  },
  {
    id: 'PSL-S-ix. ★★★ a named slot with no Core connected is left out',
    file: NF,
    find: S_LEFT,
    to: swap(S_LEFT, 'fresh ? namedConnected : []', 'fresh ? [...named] : []'),
    why: 'The record and the morning summary name a slot left out where no Core is connected and nothing was withheld.',
  },
  {
    id: 'PSL-S-x. ★★★ a named slot with no Core connected is counted out',
    file: NF,
    find: S_OUT,
    to: swap(S_OUT, 'namedConnected.length + ', 'named.length + '),
    why: 'With slot 1 named and only slots 2 and 3 connected the rate is timed for one Core, not the two in the pool.',
  },
  {
    id: 'PSL-S-xi. ★★★ a returning slot is left out',
    file: NF,
    find: S_LEFT,
    to: swap(S_LEFT, ' && pool.returning === false', ''),
    why: 'A Core whose capacity reads whole again is sent no ON: it is not charged that night.',
  },
  {
    id: 'PSL-S-xii. ★★★ a verdict with no `returning` flag withholds',
    file: NF,
    find: S_LEFT,
    to: swap(S_LEFT, 'pool.returning === false', '!pool.returning'),
    why: 'A verdict missing the flag withholds an ON: the test no longer fails toward sending ON.',
  },
  {
    id: 'PSL-S-xiii. ★★★ a contested slot is left out',
    file: NF,
    find: S_LEFT,
    to: swap(S_LEFT, ' && pool.contested === false', ''),
    why: 'While readings disagree with the latched names the named Core is left out: a Core that may be back in the pool is sent no ON.',
  },
  {
    id: 'PSL-S-xiv. ★★★ a verdict with no `contested` flag withholds',
    file: NF,
    find: S_LEFT,
    to: swap(S_LEFT, 'pool.contested === false', '!pool.contested'),
    why: 'A verdict missing the flag withholds an ON: the test no longer fails toward sending ON.',
  },
  {
    id: 'PSL-S-xv. ★★★ a verdict of any age withholds',
    file: NF,
    find: S_LEFT,
    to: swap(S_LEFT, ' && fresh', ''),
    why: 'An alarm that stood through hours of bodies that could not be judged still withholds its named slot: a Core back in the pool gets no charge.',
  },
  {
    id: 'PSL-S-xvi. ★★★ a data time ahead of now is fresh',
    file: NF,
    find: S_FRESH,
    to: swap(S_FRESH, ' && nowMs - asOfMs >= 0', ''),
    why: 'A verdict dated ahead of the tick\'s clock withholds an ON: a clock that stepped back leaves a Core uncharged.',
  },
  {
    id: 'PSL-S-xvii. ★★ a verdict of the tick\'s own instant is not fresh',
    file: NF,
    find: S_FRESH,
    to: swap(S_FRESH, 'nowMs - asOfMs >= 0', 'nowMs - asOfMs > 0'),
    why: 'A verdict read on the tick\'s own millisecond is not acted on: an ON is written to the Core it names out.',
  },
  {
    id: 'PSL-S-xviii. ★★ a verdict exactly at the limit is stale',
    file: NF,
    find: S_FRESH,
    to: swap(S_FRESH, '<= POOL_OUT_SENSOR_FRESH_MS', '< POOL_OUT_SENSOR_FRESH_MS'),
    why: 'At exactly fifteen minutes the pool-out sensor still reads the verdict as current and the ON no longer acts on it: the two disagree.',
  },
  {
    id: 'PSL-S-xix. ★★ a verdict one millisecond past the limit is fresh',
    file: NF,
    find: S_FRESH,
    to: swap(S_FRESH, '<= POOL_OUT_SENSOR_FRESH_MS', '<= POOL_OUT_SENSOR_FRESH_MS + 1'),
    why: 'A verdict the pool-out sensor already reads as unknown still withholds an ON.',
  },
  {
    id: 'PSL-S-xx. ★★★ the freshness window has no far side',
    file: NF,
    find: S_FRESH,
    to: swap(S_FRESH, ' && nowMs - asOfMs <= POOL_OUT_SENSOR_FRESH_MS', ''),
    why: 'After a day with the panel offline the alarm\'s named slot is still left out of the ON.',
  },
  {
    id: 'PSL-S-xxi. ★★★ a slot short and not identified is not counted',
    file: NF,
    find: S_OUT,
    to: swap(S_OUT, ' + Math.max(0, count - named.length)', ''),
    why: 'A Core out that no reading has named stays in the rate: the start is timed for a Core that takes no charge.',
  },
  {
    id: 'PSL-S-xxii. ★★ a count below the names takes a named slot back',
    file: NF,
    find: S_OUT,
    to: swap(S_OUT, 'Math.max(0, count - named.length)', '(count - named.length)'),
    why: 'Two Cores named beside a count of one are timed as one out: a named Core is counted for the rate.',
  },
  {
    id: 'PSL-S-xxiii. ★★★ the slots not identified are counted against the connected names',
    file: NF,
    find: S_OUT,
    to: swap(S_OUT, 'count - named.length', 'count - namedConnected.length'),
    why: 'A named Core that is not connected is counted again as a slot not identified: the rate is timed for one Core fewer than the pool holds.',
  },
  {
    id: 'PSL-S-xxiv. ★★★ every named slot is counted twice',
    file: NF,
    find: S_OUT,
    to: swap(S_OUT, 'Math.max(0, count - named.length)', 'count'),
    why: 'One Core named out of three times the charge for one Core.',
  },
  {
    id: 'PSL-S-xxv. ★★★ the count may reach 0',
    file: NF,
    find: S_OUT,
    to: swap(S_OUT, 'connected.length - 1', 'connected.length'),
    why: 'With every connected Core counted out the count is 0, which the rate reads as unknown: no bound, the fastest rate and the latest start on the night the most Cores are out.',
  },
  {
    id: 'PSL-S-xxvi. ★★ with no slot connected the count out is -1',
    file: NF,
    find: S_OUT,
    to: "  const outCount = Math.min(namedConnected.length + Math.max(0, count - named.length), connected.length - 1); /* MUTANT */",
    why: 'With no slot connected and an alarm standing the rate\'s count reads 1, not 0: the rate is bounded for one Core where the slots are unknown.',
  },
  {
    id: 'PSL-S-xxvii. ★★★ the targets hold the slot left out',
    file: NF,
    find: S_TARGETS,
    to: "    targets: [...connected], /* MUTANT */",
    why: 'Every reader of the connected list counts, as an ON target, a Core that is sent no ON.',
  },
  {
    id: 'PSL-S-xxviii. ★★★ the rate counts every connected slot',
    file: NF,
    find: S_RATE,
    to: "    rateCount: connected.length, /* MUTANT */",
    why: 'The rate is timed for three Cores with two in the pool: the late start of 2026-11-16.',
  },
  {
    id: 'PSL-S-xxix. ★★ the count out is reported as 0',
    file: NF,
    find: S_RATE + NL + S_OUTC,
    to: `${S_RATE}\n    outCount: 0, /* MUTANT */`,
    why: 'Beside a lowered rate count the count out reads 0: neither the once-a-night line nor the ON line says the rate counts fewer Cores than are connected.',
  },

  /* ── D: the start and the line re-ON ── */
  {
    id: 'PSL-D-i. ★★★ the start keeps a slot left out',
    file: NF,
    find: D_SLOTS,
    to: swap(D_SLOTS, LEFT_OUT_FILTER, ''),
    why: 'Handed every connected slot beside the slots left out, the start writes an ON to a Core the alarm names out of the pool.',
  },
  {
    id: 'PSL-D-ii. ★★★ every slot left out is "no battery slots are connected"',
    file: NF,
    find: D_NONE,
    to: swap(D_NONE, 'o.poolOutSlots != null && o.poolOutSlots.length > 0 ? W.noPoolSlots : W.noSlots', 'W.noSlots'),
    why: 'A night whose every connected Core is named out of the pool is told as a panel with no battery connected.',
  },
  {
    id: 'PSL-D-iii. ★★★ no slot connected is "the pool alarm names its Core out"',
    file: NF,
    find: D_NONE,
    to: swap(D_NONE, 'o.poolOutSlots != null && o.poolOutSlots.length > 0 ? W.noPoolSlots : W.noSlots', 'W.noPoolSlots'),
    why: 'A panel with no Core connected is told that the pool alarm names its Cores out, with no alarm standing.',
  },
  {
    id: 'PSL-D-iv. ★★★ an empty list of slots left out is a list',
    file: NF,
    find: D_NONE,
    to: swap(D_NONE, 'o.poolOutSlots.length > 0', 'o.poolOutSlots.length >= 0'),
    why: 'The tick always hands in a list: with no slot connected and none left out the refusal names the pool alarm.',
  },
  {
    id: 'PSL-D-iv(b). ★★★ every slot left out is no refusal at all',
    file: NF,
    find: D_NONE,
    to: swap(D_NONE, 'slots.length === 0', 'slots.length === 0 && !(o.poolOutSlots != null && o.poolOutSlots.length > 0)'),
    why: 'With every connected Core named out of the pool the night goes on to its ceiling write and an ON to no slot: a force-charge stamped on the record that was sent nowhere.',
  },
  {
    id: 'PSL-D-v. ★★★ the new refusal begins with another one\'s words',
    file: NF,
    find: D_WHY,
    to: "  noPoolSlots: 'no battery slots are connected to the pool: the pool alarm names each Core out of the panel\\'s backup pool', /* MUTANT */",
    why: 'The class of a refusal is matched by prefix: every slot left out is read as "no slots connected", and is pushed under that class and its once-a-night memory.',
  },
  {
    id: 'PSL-D-vi. ★★★ the rate count may raise the fallback\'s count',
    file: NF,
    find: D_RATE,
    to: swap(D_RATE, 'Math.min(slots.length, o.rateSlotCount)', 'o.rateSlotCount'),
    why: 'A count above the ON\'s own slots times the fallback rate for Cores that are sent no ON: the start comes late.',
  },
  {
    id: 'PSL-D-vii. ★★★ the rate count is not read',
    file: NF,
    find: D_RATE,
    to: swap(D_RATE, 'Math.min(slots.length, o.rateSlotCount)', 'slots.length'),
    why: 'With no live rate the start is timed for every slot sent ON while the alarm counts one of them out: the start comes late.',
  },
  {
    id: 'PSL-D-viii. ★★ a rate count of 0 is a count',
    file: NF,
    find: D_RATE,
    to: swap(D_RATE, 'o.rateSlotCount >= 1', 'o.rateSlotCount >= 0'),
    why: 'A count of 0 times the start for no Core: the fallback drops to the fixed figure whatever the per-Core option says.',
  },
  {
    id: 'PSL-D-ix. ★★★ a rate count of 1 is no count',
    file: NF,
    find: D_RATE,
    to: swap(D_RATE, 'o.rateSlotCount >= 1', 'o.rateSlotCount >= 2'),
    why: 'With two of three Cores counted out the fallback rate is timed for all three: the latest start on the night most Cores are out.',
  },
  {
    id: 'PSL-D-x. ★★ a rate count that is not whole is a count',
    file: NF,
    find: D_RATE,
    to: swap(D_RATE, 'Number.isInteger(o.rateSlotCount) && ', ''),
    why: 'A count of 1.5 Cores reaches the fallback rate, which then drops to the fixed figure.',
  },
  {
    id: 'PSL-D-xi. ★★★ a line night\'s start is timed for the ON\'s slots',
    file: NF,
    find: D_LINE_START,
    to: swap(D_LINE_START, 'rateSlots)) {', 'slots.length)) {'),
    why: 'On a line night with no live rate the start is timed for every slot sent ON while the alarm counts one out: the pool is short of the outage line at the close.',
  },
  {
    id: 'PSL-D-xii. ★★★ a cost night\'s start is timed for the ON\'s slots',
    file: NF,
    find: D_COST_START,
    to: swap(D_COST_START, 'rateSlots)) {', 'slots.length)) {'),
    why: 'On a cost night with no live rate the start is timed for every slot sent ON while the alarm counts one out: the window closes short of the target.',
  },
  {
    id: 'PSL-D-xiii. ★★★ a line re-ON goes to a slot left out',
    file: NF,
    find: D_REON,
    to: swap(D_REON, LEFT_OUT_FILTER, ''),
    why: 'A line night\'s re-ON is written to a Core the alarm names out of the pool, and spends the night\'s re-ON budget on it.',
  },

  /* ── V: the ON verify ── */
  {
    id: 'PSL-V-i. ★★★ a slot out of the pool is not exempt',
    file: NF,
    find: V_NOTON,
    to: swap(V_NOTON, ' && !outOfPool(n)', ''),
    why: 'A Core that left the pool after the ON is re-issued, then reported as a failed ON, where the ON took on every Core in the pool.',
  },
  {
    id: 'PSL-V-ii. ★★ a named slot reading ON is reported out of the pool',
    file: NF,
    find: V_OUT,
    to: "    const out = ours.filter(outOfPool); /* MUTANT */",
    why: 'A named slot that reads ON is logged as out of the pool and not as switched on.',
  },
  {
    id: 'PSL-V-iii. ★★★ no slot is ever reported out of the pool',
    file: NF,
    find: V_OUT,
    to: "    const out: number[] = []; /* MUTANT */",
    why: 'A Core out of the pool is logged as already at the panel\'s ceiling, switched off by the panel itself.',
  },
  {
    id: 'PSL-V-iv. ★★ every verified verdict carries the key',
    file: NF,
    find: V_RET_IF,
    to: "    return out.length >= 0 /* MUTANT */",
    why: 'On every night with no alarm the verified verdict carries an empty out-of-the-pool list: its shape is no longer that of the release before.',
  },
  {
    id: 'PSL-V-v. ★★★ a slot out of the pool is listed at the ceiling as well',
    file: NF,
    find: V_RET_SPLIT,
    to: swap(V_RET_SPLIT, 'off.filter((n) => !outOfPool(n))', 'off'),
    why: 'A Core out of the pool is logged twice, once as switched off by the panel at its ceiling.',
  },
  {
    id: 'PSL-V-vi. ★★★ a re-issue may go to a slot out of the pool',
    file: NF,
    find: V_JUDGED,
    to: "  const judged = ours; /* MUTANT */",
    why: 'With every Core in the pool at the ceiling and none reading ON, the re-issue is also written to the Core out of the pool; with every Core out, to all of them.',
  },
  {
    id: 'PSL-V-vii. ★★★ a failure never names the exempt slots',
    file: NF,
    find: V_OUTOFF,
    to: "  const outOff: number[] = []; /* MUTANT */",
    why: 'An ON that took on no slot is reported as failed on SOME slots: the push says "on those slot(s)" and the morning summary reads the rest as taken.',
  },
  {
    id: 'PSL-V-viii. ★★★ a failure names the exempt slots whatever reads ON',
    file: NF,
    find: V_OUTOFF,
    to: swap(V_OUTOFF, 'anyOn ? [] : ', ''),
    why: 'With a Core in the pool reading ON, the partial failure also names the Core out of the pool, which was never judged.',
  },
  {
    id: 'PSL-V-ix. ★★★ a slot at the ceiling is added back to a failure',
    file: NF,
    find: V_OUTOFF,
    to: swap(V_OUTOFF, 'outOfPool(n) && ', ''),
    why: 'With no slot reading ON, a Core the panel itself holds at its ceiling is reported with the rest as an ON that did not take.',
  },
  {
    id: 'PSL-V-x. ★★ a failure lists its slots out of the ON\'s order',
    file: NF,
    find: V_FAILED,
    to: swap(V_FAILED, 'ours.filter((n) => pending.includes(n) || outOff.includes(n))', '[...pending, ...outOff]'),
    why: 'The push and the record read "slot(s) 2, 3, 1" for an ON sent to 1, 2 and 3.',
  },
  {
    id: 'PSL-V-xi. ★★★ with nothing to re-issue, nothing is judged',
    file: NF,
    find: V_FAILED0,
    to: "  if (pending.length === 0) return { kind: 'none' }; /* MUTANT */",
    why: 'An ON whose every slot is out of the pool, none reading ON, is never judged: no failure and no push, all night.',
  },
  {
    id: 'PSL-V-xii. ★★★ the failure with nothing to re-issue repeats',
    file: NF,
    find: V_ONCE,
    to: "  if (s.forceChargeOnFailedAtMs != null && pending.length > 0) return { kind: 'none' }; /* MUTANT */",
    why: 'With every slot out of the pool the failure is declared again on every tick after it is on the record: the warning repeats each minute to the close.',
  },
  {
    id: 'PSL-V-xiii. ★★★ the failure with nothing to re-issue skips the grace',
    file: NF,
    find: V_GRACE,
    to: "  if (since < FORCE_CHARGE_ON_VERIFY_AFTER_MS && pending.length > 0) return { kind: 'none' }; /* MUTANT */",
    why: 'With every slot out of the pool the failure is declared on the ON\'s own tick, before any readback could show the ON.',
  },
  {
    id: 'PSL-V-xiv. ★★★ a re-issue to no slot',
    file: NF,
    find: V_EMPTY,
    to: "  /* MUTANT */",
    why: 'With every slot out of the pool the one re-issue is spent on no slot at all, and the failure waits a second grace.',
  },
  {
    id: 'PSL-V-xv. ★★★ the failure with nothing to re-issue is flagged noRetry',
    file: NF,
    find: V_EMPTY,
    to: "  if (pending.length === 0) return { kind: 'onFailed', slots: failed, noRetry: true }; /* MUTANT */",
    why: 'The failure push says the window was too short for a re-issue, where no re-issue was ever due.',
  },
  {
    id: 'PSL-V-xv(b). ★★★ the failure with nothing to re-issue names no slot',
    file: NF,
    find: V_EMPTY,
    to: "  if (pending.length === 0) return { kind: 'onFailed', slots: pending }; /* MUTANT */",
    why: 'With every slot out of the pool the failure carries an empty list: the push names no slot, and the record reads as a failure from before the list was kept.',
  },
  {
    id: 'PSL-V-xvi. ★★★ the forfeit carries the re-issue\'s list',
    file: NF,
    find: V_NORETRY,
    to: "      return { kind: 'onFailed', slots: pending, noRetry: true }; /* MUTANT */",
    why: 'Too close to the close for a re-issue and no slot reading ON: the failure leaves the Core out of the pool off its list, and reads as an ON that took there.',
  },
  {
    id: 'PSL-V-xvii. ★★★ the re-issue carries the failure\'s list',
    file: NF,
    find: V_RETRY,
    to: "    return { kind: 'onRetry', slots: failed }; /* MUTANT */",
    why: 'With no slot reading ON the re-issue is written to the Core out of the pool as well.',
  },
  {
    id: 'PSL-V-xviii. ★★★ the failure after the re-issue carries the re-issue\'s list',
    file: NF,
    find: V_LAST,
    to: "\n  return { kind: 'onFailed', slots: pending }; /* MUTANT */\n}",
    why: 'An ON that took on no slot is reported as failed on the slots in the pool only: the whole failure reads as a partial one.',
  },

  /* ── A: the record ── */
  {
    id: 'PSL-A-i. ★★ an empty record holds an empty list',
    file: NA,
    find: A_DEFAULT,
    to: "    forceChargeLeftOutSlots: [], /* MUTANT */",
    why: 'A night with no slot left out carries an empty list, not null: "none" has two forms, and a reader that tests for null reads a slot left out.',
  },
  {
    id: 'PSL-A-ii. ★★★ the field is not restored',
    file: NA,
    find: A_COERCE,
    to: "    forceChargeLeftOutSlots: null, /* MUTANT */",
    why: 'A restart between the ON and the morning loses the slots left out: the summary and the ledger no longer name them.',
  },
  {
    id: 'PSL-A-iii. ★★★ the field is restored as stored',
    file: NA,
    find: A_COERCE,
    to: "    forceChargeLeftOutSlots: Array.isArray(o.forceChargeLeftOutSlots) && (o.forceChargeLeftOutSlots as unknown[]).length > 0 ? (o.forceChargeLeftOutSlots as number[]) : null, /* MUTANT */",
    why: 'A damaged record\'s entries reach the morning summary and the ledger as slots left out.',
  },
  {
    id: 'PSL-A-iv. ★★★ the field is restored from the ON\'s slots',
    file: NA,
    find: A_COERCE,
    to: "    forceChargeLeftOutSlots: nonEmptySlotList(o.forceChargeSlots), /* MUTANT */",
    why: 'After a restart the summary names the slots the ON was sent to as the slots it was not sent to.',
  },
  {
    id: 'PSL-A-v. ★★ a stored list with no slot in it stays a list',
    file: NA,
    find: A_NONEMPTY,
    to: "  return slots != null && slots.length >= 0 ? slots : null; /* MUTANT */",
    why: 'After a restart "none left out" is an empty list where the ON stamped null.',
  },
  {
    id: 'PSL-A-vi. ★★★ one slot left out is none',
    file: NA,
    find: A_NONEMPTY,
    to: "  return slots != null && slots.length > 1 ? slots : null; /* MUTANT */",
    why: 'One slot left out, the usual case, is dropped at a restart.',
  },
  {
    id: 'PSL-A-vii. ★★★ the field is carried to the next night',
    file: NA,
    find: A_CARRY,
    to: "        ? prev.forceChargeCeilingPriorPct : null, forceChargeLeftOutSlots: prev.forceChargeLeftOutSlots, /* MUTANT */",
    why: 'Last night\'s slot left out rides into tonight\'s record: the next summary names a slot that was sent its ON.',
  },
  {
    id: 'PSL-A-viii. ★★★ the field travels with the ceiling original to the next leg',
    file: CC,
    find: C_CARRY,
    to: "  return { ...to, forceChargeLeftOutSlots: from.forceChargeLeftOutSlots, forceChargeCeilingPriorPct: from.forceChargeCeilingPriorPct, forceChargeCeilingRestoredAtMs: null, /* MUTANT */",
    why: 'A leg promoted over one that left a slot out starts with that slot on its record.',
  },

  /* ── X: index.ts, the wiring ── */
  {
    id: 'PSL-X-i. ★★★ the tick reads no verdict',
    file: IX,
    find: X_POOL,
    to: swap(X_POOL, 'store.poolOutRead(shp2.sn)', 'null'),
    why: 'The alarm is never read: three Cores are counted for the rate and sent ON with one out of the pool, as before this release.',
  },
  {
    id: 'PSL-X-ii. ★★ slots outside the panel\'s three are handed in',
    file: IX,
    find: X_POOL,
    to: swap(X_POOL, 'hwSlots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS)', 'hwSlots'),
    why: 'A slot number outside 1 to 3 in the panel\'s list is counted for the rate.',
  },
  {
    id: 'PSL-X-iii. ★★★ the verdict\'s age is not measured on the tick\'s clock',
    file: IX,
    find: X_POOL,
    to: swap(X_POOL, ', nowMs);', ', 0);'),
    why: 'Every verdict reads as ahead of the clock: no slot is ever left out of an ON.',
  },
  {
    id: 'PSL-X-iv. ★★★ the targets never reach the decision',
    file: IX,
    find: X_CONN,
    to: "  const connectedSlots = hwSlots; /* MUTANT */",
    why: 'Every reader of the connected list but the start\'s own filter still counts the Core left out: the line-at-risk gate and the declined-start push time a start for three.',
  },
  {
    id: 'PSL-X-v. ★★★ the slots left out are handed on as the connected ones',
    file: IX,
    find: X_CONN,
    to: "  const connectedSlots = pool.leftOut.length > 0 ? pool.leftOut : hwSlots; /* MUTANT */",
    why: 'The ON\'s candidates are the Cores out of the pool, each then refused: no force-charge at all on a night with a slot left out.',
  },
  {
    id: 'PSL-X-v(b). ★★★ the slots reading ON are filtered by the slots left out',
    file: IX,
    find: X_GRIDSTA + NL + X_SLOTSON,
    to: `${X_GRIDSTA}\n    slotsOn: slotsOn == null ? null : slotsOn.filter((n) => !pool.leftOut.includes(n)), /* MUTANT */`,
    why: 'A Charge Now that reads ON on a slot left out no longer declines the start: the add-on starts a force-charge of its own beside an operator\'s.',
  },
  {
    id: 'PSL-X-vi. ★★★ the decision is not given the slots left out',
    file: IX,
    find: X_POS,
    to: "    poolOutSlots: null, /* MUTANT */",
    why: 'A Core that leaves the pool after the ON is re-issued and reported as a failed ON, and a night whose every slot is left out is told as "no battery slots are connected".',
  },
  {
    id: 'PSL-X-vii. ★★★ the decision is given the targets as the slots left out',
    file: IX,
    find: X_POS,
    to: "    poolOutSlots: pool.targets, /* MUTANT */",
    why: 'The Cores in the pool are the ones refused and exempted: no ON goes anywhere while a slot is left out.',
  },
  {
    id: 'PSL-X-viii. ★★★ the decision is not given the rate\'s count',
    file: IX,
    find: X_RSC,
    to: "    rateSlotCount: null, /* MUTANT */",
    why: 'With no live rate the start is timed for every slot sent ON while the alarm counts one of them out.',
  },
  {
    id: 'PSL-X-ix. ★★★ the decision is given the count OUT as the rate\'s count',
    file: IX,
    find: X_RSC,
    to: "    rateSlotCount: pool.outCount, /* MUTANT */",
    why: 'The fallback rate is timed for the Cores counted out of the pool, not for those in it.',
  },
  {
    id: 'PSL-X-x. ★★★ the slots left out are never stamped',
    file: IX,
    find: X_PERSIST,
    to: swap(X_PERSIST, 'forceChargeLeftOutSlots: pool.leftOut.length > 0 ? [...pool.leftOut] : null', 'forceChargeLeftOutSlots: null'),
    why: 'The record never holds the slots left out: the morning summary and the ledger say nothing of a Core that was sent no ON.',
  },
  {
    id: 'PSL-X-xi. ★★ an empty list is stamped',
    file: IX,
    find: X_PERSIST,
    to: swap(X_PERSIST, 'forceChargeLeftOutSlots: pool.leftOut.length > 0 ? [...pool.leftOut] : null', 'forceChargeLeftOutSlots: [...pool.leftOut]'),
    why: 'Every ON with nothing left out stamps an empty list where the field\'s "none" is null.',
  },
  {
    id: 'PSL-X-xii. ★★★ the slots left out are stamped in a write of their own',
    file: IX,
    find: X_PERSIST,
    to: "    persistNightActuation({ ...nightActuationMem, ...onStamp }); persistNightActuation({ ...nightActuationMem, forceChargeLeftOutSlots: pool.leftOut.length > 0 ? [...pool.leftOut] : null }); /* MUTANT */",
    why: 'A restart between the two writes leaves an ON on the record with its slots left out lost.',
  },
  {
    id: 'PSL-X-xiii. ★★★ the morning summary is not given the slots left out',
    file: IX,
    find: X_SUMMARY,
    to: "        leftOutSlots: null, /* MUTANT */",
    why: 'The morning summary never names a slot the ON was not sent to.',
  },
  {
    id: 'PSL-X-xiv. ★★★ the morning summary is given the ON\'s slots',
    file: IX,
    find: X_SUMMARY,
    to: "        leftOutSlots: state.forceChargeSlots, /* MUTANT */",
    why: 'The morning summary names the slots the ON was sent to as not switched on.',
  },
  {
    id: 'PSL-X-xv. ★★★ the morning summary is given the failed slots',
    file: IX,
    find: X_SUMMARY,
    to: "        leftOutSlots: state.forceChargeOnFailedSlots, /* MUTANT */",
    why: 'A slot whose ON failed is told as one the pool alarm named out of the pool.',
  },
  {
    id: 'PSL-X-xvi. ★★★ the planner counts every connected Core',
    file: IX,
    find: X_PLAN,
    to: "  const planConnectedSlots = planHwSlots == null ? null : planHwSlots.length; /* MUTANT */",
    why: 'The plan caps the charge for every connected Core while the pool holds fewer: it states a night the tick cannot deliver.',
  },
  {
    id: 'PSL-X-xvii. ★★★ the planner reads no verdict',
    file: IX,
    find: X_PLAN,
    to: swap(X_PLAN, 'store.poolOutRead(shp2.sn)', 'null'),
    why: 'The plan\'s charge cap never follows the alarm: the plan and the tick\'s rate are two models while a Core is out.',
  },
  {
    id: 'PSL-X-xviii. ★★★ the planner counts the ON targets',
    file: IX,
    find: X_PLAN,
    to: swap(X_PLAN, '.rateCount;', '.targets.length;'),
    why: 'On a doubtful verdict the plan counts a Core the tick\'s rate counts out: the plan is for a rate the tick does not time with.',
  },
  {
    id: 'PSL-X-xix. ★★★ the planner counts the Cores out',
    file: IX,
    find: X_PLAN,
    to: swap(X_PLAN, '.rateCount;', '.outCount;'),
    why: 'The plan\'s charge cap is for the Cores counted out of the pool; with none out it is the legacy cap.',
  },
  {
    id: 'PSL-X-xx. ★★★ the once-a-night line needs a slot left out',
    file: IX,
    find: X_GUARD,
    to: "      if (pool.leftOut.length > 0) { /* MUTANT */",
    why: 'A Core out and not identified lowers the rate, and nothing in the log says why the start came early.',
  },
  {
    id: 'PSL-X-xxi. ★★★ the once-a-night line needs a count out',
    file: IX,
    find: X_GUARD,
    to: "      if (pool.outCount > 0) { /* MUTANT */",
    why: 'One connected Core, named out: the count out is 0 at its floor, the ON is withheld, and the line that says so is never written.',
  },
  {
    id: 'PSL-X-xxii. ★★ the once-a-night line is said with no alarm',
    file: IX,
    find: X_GUARD,
    to: "      if (pool.leftOut.length >= 0 || pool.outCount > 0) { /* MUTANT */",
    why: 'Every night\'s log says the pool alarm stands for this panel, with none standing.',
  },
  {
    id: 'PSL-X-xxiii. ★★ the line\'s key carries the clock',
    file: IX,
    find: X_KEY,
    to: "        const poolKey = `${nowMs}|${pool.rateCount}|${pool.outCount}|${pool.leftOut.join(',')}`; /* MUTANT */",
    why: 'The line is written on every tick the start is declined: once a minute through the night.',
  },
  {
    id: 'PSL-X-xxiv. ★★ the line\'s key leaves out the slots',
    file: IX,
    find: X_KEY,
    to: "        const poolKey = `${pool.rateCount}|${pool.outCount}`; /* MUTANT */",
    why: 'A slot left out later in the night, at the same counts, is never said.',
  },
  {
    id: 'PSL-X-xxv. ★★ the line is not held to once a night',
    file: IX,
    find: X_HAS,
    to: "        if (poolKey.length > 0) { /* MUTANT */",
    why: 'The line is written on every tick the start is declined.',
  },
  {
    id: 'PSL-X-xxvi. ★★ the line\'s key is never remembered',
    file: IX,
    find: X_ADD,
    to: "          /* MUTANT */",
    why: 'The line is written on every tick the start is declined.',
  },
  {
    id: 'PSL-X-xxvii. ★★ the line states the count out as the connected count',
    file: IX,
    find: X_LINE,
    to: swap(X_LINE, 'of the ${pool.rateCount + pool.outCount} connected Core(s)', 'of the ${pool.outCount} connected Core(s)'),
    why: 'The log says the rate counts "2 of the 1 connected Core(s)".',
  },
  {
    id: 'PSL-X-xxviii. ★★ the line says a slot is named where none is',
    file: IX,
    find: X_LINE,
    to: swap(X_LINE, '${pool.leftOut.length > 0 ? ', '${pool.leftOut.length >= 0 ? '),
    why: 'With a Core out and not identified the log says an ON is not sent to "slot(s) " and that the alarm names their Core.',
  },

  /* ── W: index.ts, the words of the ON and of its verify ── */
  {
    id: 'PSL-W-i. ★★ the ON line\'s fallback count is the ON\'s slot count',
    file: IX,
    find: W_FALLBACK,
    to: "    const fallbackSlots = slotsNow; /* MUTANT */",
    why: 'The ON line states a fallback rate for every slot sent ON, where the start was timed for the Cores counted in the pool.',
  },
  {
    id: 'PSL-W-ii. ★★ the fallback sentence is picked on the ON\'s slot count',
    file: IX,
    find: W_FB_IF,
    to: swap(W_FB_IF, 'planRateFallbackKw(fallbackSlots)', 'planRateFallbackKw(slotsNow)'),
    why: 'The ON line asks the fallback rate of a count the start was not timed for.',
  },
  {
    id: 'PSL-W-iii. ★★ the live rate\'s bound is always "connected Core(s)"',
    file: IX,
    find: W_BOUND,
    to: swap(W_BOUND, 'pool.outCount > 0', 'pool.outCount < 0'),
    why: 'With a Core counted out the ON line says the rate is bounded by three connected Cores, beside a rate two Cores take.',
  },
  {
    id: 'PSL-W-iv. ★★ the fallback clause names the ON\'s slot count as the Cores in the pool',
    file: IX,
    find: W_FBCORES,
    to: swap(W_FBCORES, '${fallbackSlots} Core(s) counted in the pool', '${slotsNow} Core(s) counted in the pool'),
    why: 'The ON line says "3 Core(s) counted in the pool" beside a fallback rate timed for two.',
  },
  {
    id: 'PSL-W-v. ★★ the ON line does not name the slot left out',
    file: IX,
    find: W_NOTE,
    to: "    const leftOutNote = ''; /* MUTANT */",
    why: 'The ON line lists the slots written and says nothing of the connected slot it was not sent to.',
  },
  {
    id: 'PSL-W-vi. ★★ the verify log reads no slot as out of the pool',
    file: IX,
    find: W_VOUT,
    to: "    const outOfPool: number[] = []; /* MUTANT */",
    why: 'A Core out of the pool is logged among the slots that read FORCE_CHARGE_ON.',
  },
  {
    id: 'PSL-W-vii. ★★ a slot out of the pool is listed as reading ON',
    file: IX,
    find: W_VON,
    to: swap(W_VON, ' && !outOfPool.includes(n)', ''),
    why: 'A Core out of the pool is logged as reading FORCE_CHARGE_ON, and again as out of the pool.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs). Each mutant runs the whole
// subset, with its failing tests named; the subset alone decides.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({
  name: 'mutate-pool-slots', mutants: MUTANTS.map((m) => ({ ...m, tests: SUBSET })), subset: SUBSET, root: REPO,
  perMutantTests: true, typecheck: true, fullSuite: false,
});
