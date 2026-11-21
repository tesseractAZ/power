/**
 * v1.209.0 (part C) — only the Cores in the panel's backup pool are counted for the force-charge's rate and sent ON.
 *
 * On 2026-11-16 a Core was out of the panel's backup pool. The pool's capacity and percent were the two-Core figures,
 * the force-charge's rate counted three Cores, and the start came late. The pool alarm (poolOut.ts, v1.208.0) knows the
 * count of slots out and, after a dwell of naming readings, which slots. This release reads that latched verdict
 * (poolOutRead), turns it into the slots an ON may go to and the count the rate is timed with (forceChargePoolSlots),
 * and keeps a slot left out from the ON and from the ON's re-issue. A failure of the ON names such a slot only when the
 * ON took on no slot at all: a failure shorter than the ON's own list is read everywhere as "it took on the others".
 *
 * Two rules outrank everything else, and most of this file states them as properties over every input:
 *  1. UNKNOWN EQUALS THE RELEASE BEFORE. With no standing alarm for the panel (no tracker state, no episode, a read that
 *     throws) every list, count and decision is the one v1.208.0 makes.
 *  2. THE TWO USES FAIL SAFE IN OPPOSITE DIRECTIONS. For the RATE a doubtful slot is counted OUT (the start comes
 *     earlier). For the ON TARGETS a doubtful slot is sent ON (a withheld ON costs a Core its charge for the night): a
 *     slot is left out only when it is NAMED, nothing stands against the latch (no clear dwell, no fewer-short and no
 *     other-set streak), and the newest reading whose CAPACITY could be judged is recent.
 *
 * Sections: (1) poolOutRead — the six fields, and its agreement with the alarm's fault token and with pool_out_mask;
 * (1b) the store's contained reader; (2) forceChargePoolSlots over every input; (3) rule 1; (3b) the real tracker's
 * doubt, end to end (the fold, the read, the slots, the ON); (4) the start decision, the slots it takes out itself and
 * the count its fallback rate takes; (5) the ON verify, the whole failure and every reader of it; (6) the integrator,
 * as source pins on index.ts (it is not reachable from a unit test); (7) the record's field.
 *
 * NOT asserted here, and reported with this file instead of pinned:
 *  - a verified verdict, or a failure's slot list, when the ONLY slots of ours reading ON are themselves named out of the
 *    pool (the verify takes any slot of ours reading ON as proof that the ON took somewhere): side C of section 5's
 *    exhaustive comparison;
 *  - the read's `countAtMost` while a larger count sits BEHIND a same-count streak (`episode.change.more`);
 *  - which slots are withheld while the capacity still reads short and every slot, the named one included, is seen
 *    carrying its share (the tracker's held contradiction): such readings keep the verdict's data time young;
 *  - the fallback rate with FORCE_CHARGE_KW_PER_CORE unset (a fixed figure, whatever the count);
 *  - the count the line-at-risk gate and the declined-start push's clock take (the ON targets' count: a recorded limit).
 *
 * Every src module is imported AFTER the environment below is set, as poolOutStore.test.ts does: section 1b builds a
 * real SnapshotStore, which keeps its files beside DB_PATH. Serials are the fixture's placeholders.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolOutState, PoolOutRead, PoolOutStreak } from '../src/poolOut.js';
import type { ForceChargeOpts, ForceChargeAction, ForceChargePoolSlots } from '../src/nightForceCharge.js';
import type { NightActuationState, ArmablePlan } from '../src/nightChargeActuator.js';
import type { Body } from './fixtures/poolOutFixtures.js';
import { withEnv } from './golden/support/env.js';

const ROOT = mkdtempSync(join(tmpdir(), 'ef-fc-pool-slots-'));
process.env.DB_PATH = join(ROOT, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(ROOT, 'shadow-witness.json');
process.env.SITE_TIMEZONE = 'America/Phoenix';
delete process.env.SUPERVISOR_TOKEN;
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { poolOutRead, poolOutTitle, poolOutAlertParts, poolOutSensorState, emptyPoolOutState, POOL_OUT_SENSOR_FRESH_MS } = await import('../src/poolOut.js');
const { poolRecordMetrics, POOL_OUT_MASK_UNIDENTIFIED } = await import('../src/poolOutRecord.js');
const { SHP2_SOURCE_SLOTS } = await import('../src/hwSpec.js');
const nfc = await import('../src/nightForceCharge.js');
const {
  forceChargePoolSlots, decideForceCharge, forceChargeBlockerClass, isForceChargeStartBlocker, FORCE_CHARGE_BLOCKER_WHY,
  FORCE_CHARGE_ON_VERIFY_AFTER_MS, FORCE_CHARGE_LINE_DECLINED_PERSIST_MS, forceChargeRateKw, forceChargeStartAtMs,
  forceChargeLineStartAtMs, forceChargeModeOf, forceChargeKwPerCore, planChargeCapKw, planRateFallbackKw, lineDeclinedPushStep,
  EMPTY_LINE_DECLINED_PUSH, LEGACY_CHARGE_CAP_KW, lineReOnDue, partialForceChargeOnFailureSlots, forceChargeNightOutcome,
  forceChargeOnFailureNight, armedLineStartClosed, lineStartClosedWords,
} = nfc;
const { buildNightForceChargeOnFailure } = await import('../src/notify.js');
const { emptyActuationState, coerceActuationState, armFromPlan } = await import('../src/nightChargeActuator.js');
const { armCycle, promoteCycle, coerceCycle, serializeCycle, emptyCycle, emptyLegState, asChargeLeg, carryCeilingPrior } = await import('../src/chargeCycle.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const fx = await import('./fixtures/poolOutFixtures.js');

const H = 3_600_000;
const MIN = 60_000;
const TZ = 'America/Phoenix';
const FRESH = POOL_OUT_SENSOR_FRESH_MS;

/** Every subset of the panel's three slots, ascending. */
const SUBSETS: number[][] = [[], [1], [2], [3], [1, 2], [1, 3], [2, 3], [1, 2, 3]];
const perms = (a: number[]): number[][] =>
  a.length <= 1 ? [[...a]] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
/** Every subset of {1,2,3} in every order: 16 lists. */
const CONNECTED: number[][] = SUBSETS.flatMap(perms);
const deepFreeze = <T>(v: T): T => {
  if (v != null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v as object)) deepFreeze(x); }
  return v;
};

/* ══ 1. poolOutRead: the latched verdict, and the doubt that stands against it ═══════════════════════ */

/** Slot 1 out, the alarm standing since minute 10 (raised and named by the real tracker). */
const EP = fx.withEpisode();
/** EP with its latched set and count replaced: the shapes a dwell-confirmed set change can leave. */
const latched = (slots: unknown, k: unknown, over: Record<string, unknown> = {}): PoolOutState =>
  ({ ...EP, episode: { ...EP.episode!, slots, k, ...over } }) as unknown as PoolOutState;
const twoOut = (seq: number): Body => fx.synthBody({ seq, capWh: fx.SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
/** Slot 2 out instead of slot 1: one Core's capacity short, slot 2 at 0 W, slots 1 and 3 carrying. */
const slot2Out = (seq: number): Body => fx.synthBody({ seq, capWh: 2 * fx.SLOT_WH, poolPct: 67.5, slots: [{ pct: 72, w: -1107 }, { pct: 65, w: 0 }, { pct: 63, w: -1061 }] });
/** Usable readings whose CAPACITY cannot be judged: one pack (6,144 Wh) short of three Cores, which is not a whole slot.
 *  The first kind still points at slot 1 by percent and power; the second has nothing else to go by. */
const capUnknownNaming = (seq: number): Body => fx.lostBody(seq, { capWh: fx.FULL_WH - 6144 });
const capUnknownQuiet = (seq: number): Body => fx.quietBody(seq, { capWh: fx.FULL_WH - 6144 });
/** States the real tracker reaches (the folds of poolOutText.test.ts). */
const REFERENCE = fx.withReference();
const STREAK = fx.fold(REFERENCE, fx.minutes(0, 5, fx.lostBody)).state;
const UNNAMED = fx.fold(REFERENCE, fx.minutes(0, 16, fx.quietLostBody)).state;
const TWO = fx.fold(REFERENCE, fx.minutes(0, 11, twoOut)).state;
const dip = (from: number) => [...fx.minutes(from, 2, fx.lostBody), ...fx.minutes(from + 2, 3, fx.healthyBody)];
const FLAP = fx.fold(REFERENCE, [...dip(0), ...dip(5), ...fx.minutes(10, 2, fx.lostBody)]).state;
const LARGER = fx.fold(UNNAMED, fx.minutes(16, 2, twoOut)).state;
const CLEARING = fx.fold(EP, fx.minutes(11, 3, fx.healthyBody)).state;
/** Two Cores named out, then three readings ONE slot short: fewer short than the latch, on its way through the dwell (episode.less). */
const LESS = fx.fold(TWO, fx.minutes(11, 3, fx.lostBody)).state;
/** Slot 1 named out, then three readings that name slot 2 instead: another set at the latched count (episode.change). */
const OTHER = fx.fold(EP, fx.minutes(11, 3, slot2Out)).state;
/** Slot 1 named out, then three readings TWO slots short: a different set that counts more slots short (episode.change, a larger k). */
const MORE = fx.fold(EP, fx.minutes(11, 3, twoOut)).state;

/** Every latched (slots, count) shape: named in full, partly named, not named (null and the empty list). */
const SHAPES: Array<{ slots: number[] | null; k: number; named: number[] }> = [
  { slots: [1], k: 1, named: [1] }, { slots: [2], k: 1, named: [2] }, { slots: [3], k: 1, named: [3] },
  { slots: [1, 2], k: 2, named: [1, 2] }, { slots: [1, 3], k: 2, named: [1, 3] }, { slots: [2, 3], k: 2, named: [2, 3] },
  { slots: [1, 2, 3], k: 3, named: [1, 2, 3] },
  { slots: [1], k: 2, named: [1] }, { slots: [3], k: 2, named: [3] }, { slots: [2], k: 3, named: [2] }, { slots: [1, 3], k: 3, named: [1, 3] },
  { slots: null, k: 1, named: [] }, { slots: null, k: 2, named: [] }, { slots: null, k: 3, named: [] },
  { slots: [], k: 1, named: [] }, { slots: [], k: 2, named: [] },
];
/** A read written in full, all six fields: nothing against the latch, and no larger count on its way, unless said. */
const verdict = (named: number[], count: number, asOfMs: number | null, over: Partial<PoolOutRead> = {}): PoolOutRead =>
  ({ named, count, countAtMost: count, returning: false, contested: false, asOfMs, ...over });
const noAlarm = (asOfMs: number | null): PoolOutRead => verdict([], 0, asOfMs);
const SIX = ['asOfMs', 'contested', 'count', 'countAtMost', 'named', 'returning'];
/** Values that are not a whole number of slots. */
const NOT_A_COUNT: unknown[] = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined, {}, [2], true];

test('★★★ no tracker state, and no episode standing: nothing named, nothing counted, nothing standing against a latch there is not', () => {
  assert.deepEqual(poolOutRead(null), { named: [], count: 0, countAtMost: 0, returning: false, contested: false, asOfMs: null }, 'the six fields');
  assert.deepEqual(poolOutRead(undefined), noAlarm(null));
  assert.deepEqual(poolOutRead(emptyPoolOutState()), noAlarm(null), 'a tracker that has folded nothing');
  assert.deepEqual(poolOutRead(REFERENCE), noAlarm(fx.at(-1)), 'a healthy pool: the data time alone');
  // Five minutes of a Core out, every reading naming slot 1: a streak, not yet an alarm. Nothing is read from it.
  assert.deepEqual([STREAK.episode, STREAK.streak?.slots, STREAK.streak?.k], [null, [1], 1], 'control: the streak names slot 1');
  assert.deepEqual(poolOutRead(STREAK), noAlarm(fx.at(4)), '★ a streak before its raise names nothing and counts nothing');
  // Every read has exactly the six fields, each one present (a caller tests two of them with `=== false`).
  for (const state of [null, undefined, emptyPoolOutState(), REFERENCE, STREAK, EP, UNNAMED, TWO, FLAP, LARGER, CLEARING, LESS, OTHER, MORE]) {
    const r = poolOutRead(state);
    assert.deepEqual(Object.keys(r).sort(), SIX);
    assert.deepEqual([Array.isArray(r.named), typeof r.count, typeof r.countAtMost, typeof r.returning, typeof r.contested], [true, 'number', 'number', 'boolean', 'boolean']);
  }
});

test('★★★ every latched shape: the named slots, the count (named or not), from the episode alone', () => {
  for (const { slots, k, named } of SHAPES) {
    assert.deepEqual(poolOutRead(latched(slots, k)), verdict(named, k, fx.at(10)), `slots ${JSON.stringify(slots)}, k ${k}`);
  }
  // The states the tracker itself reaches.
  assert.deepEqual(poolOutRead(EP), verdict([1], 1, fx.at(10)));
  assert.deepEqual(poolOutRead(UNNAMED), verdict([], 1, fx.at(15)), 'raised on the capacity alone: counted, not named');
  assert.deepEqual(poolOutRead(TWO), verdict([1, 3], 2, fx.at(10)));
});

test('★★★ the names and the count are the LATCHED ones: a set on its way through a dwell, and one reading\'s verdicts, name nothing — the doubt is reported BESIDE the latch', () => {
  // A flap raise: its readings point at slot 1 (episode.change), the title names none.
  assert.deepEqual([FLAP.episode?.how, FLAP.episode?.slots, FLAP.episode?.change?.slots], ['flap', null, [1]], 'control');
  assert.deepEqual(poolOutRead(FLAP), verdict([], 1, fx.at(11), { contested: true }), '★ never the pending set in `named`');
  // A LARGER count on its way through a dwell of its own: the latched count stands, and the larger one is the at-most.
  assert.deepEqual([LARGER.episode?.k, LARGER.episode?.change?.k, LARGER.episode?.change?.slots], [1, 2, [1, 3]], 'control');
  assert.deepEqual(poolOutRead(LARGER), verdict([], 1, fx.at(17), { countAtMost: 2, contested: true }), '★ never the pending count in `count`, never its slots in `named`');
  // The newest reading's own verdicts name slot 1 (EP.last); with the latched set emptied the read names none.
  assert.deepEqual(EP.last?.flow.set, [1], 'control: the newest reading points at slot 1');
  assert.deepEqual(poolOutRead(latched(null, 1)).named, []);
});

test('★★ returning: the clear dwell is running — and that alone; the names and the count stand through it', () => {
  assert.equal(CLEARING.episode?.clear != null, true, 'control: three healthy readings started the clear');
  assert.deepEqual(poolOutRead(CLEARING), verdict([1], 1, fx.at(13), { returning: true }), 'the alarm still stands and still names slot 1');
  const clear = CLEARING.episode!.clear;
  for (const { slots, k, named } of SHAPES) {
    assert.deepEqual(poolOutRead(latched(slots, k, { clear })), verdict(named, k, fx.at(10), { returning: true }));
    assert.equal(poolOutRead(latched(slots, k, { clear: null })).returning, false);
    assert.equal(poolOutRead(latched(slots, k, { clear: undefined })).returning, false);
  }
});

test('★★★ countAtMost: the latched count, raised by a different set on its way through the dwell that counts MORE slots short — never below the count, never by a hostile k', () => {
  const streak: PoolOutStreak = MORE.episode!.change!;
  assert.deepEqual([MORE.episode?.k, streak.k], [1, 2], 'control: the real tracker, slot 1 latched, two slots short on its way');
  const withChange = (count: unknown, k: unknown): PoolOutRead => poolOutRead(latched([1], count, { change: { ...streak, k } }));
  for (const count of [0, 1, 2, 3]) {
    for (const k of [0, 1, 2, 3, 4]) {
      const r = withChange(count, k);
      assert.equal(r.countAtMost, Math.max(count, k), `count ${count}, a change streak at ${k}`);
      assert.equal(r.count, count, 'the latched count is never moved by it');
      assert.equal(r.countAtMost >= r.count, true, '★ never below the count');
    }
  }
  // A k that is not a whole number of slots raises nothing; the streak still stands against the names.
  for (const bad of NOT_A_COUNT) {
    const r = withChange(2, bad);
    assert.deepEqual([r.count, r.countAtMost, r.contested], [2, 2, true], `a change streak with k ${String(bad)}`);
  }
  // A latched count that is not one is 0, and the streak's sound count is still the at-most.
  assert.deepEqual([withChange(1.5, 2).count, withChange(1.5, 2).countAtMost], [0, 2]);
  // With no change streak it is the count; a fewer-short streak (episode.less) neither lowers nor raises it.
  const less: PoolOutStreak = LESS.episode!.less!;
  assert.equal(less.k, 1, 'control: one slot short, under a latch of two');
  for (const { slots, k } of SHAPES) {
    assert.equal(poolOutRead(latched(slots, k)).countAtMost, k);
    assert.equal(poolOutRead(latched(slots, k, { less })).countAtMost, k, '★ fewer slots short on its way lowers nothing');
    for (const none of [null, undefined]) assert.equal(poolOutRead(latched(slots, k, { change: none })).countAtMost, k);
  }
  // The real tracker: a larger count on its way raises it; another set at the SAME count does not.
  assert.deepEqual(poolOutRead(MORE), verdict([1], 1, fx.at(13), { countAtMost: 2, contested: true }));
  assert.deepEqual(poolOutRead(OTHER), verdict([1], 1, fx.at(13), { contested: true }));
  // No episode: 0, whatever else the state holds.
  for (const quiet of [null, emptyPoolOutState(), REFERENCE, STREAK, { ...MORE, episode: null }]) assert.equal(poolOutRead(quiet).countAtMost, 0);
});

test('★★★ contested: fewer slots short than the latch, or another set, on its way through a dwell — true for either, false with neither, false with no episode', () => {
  const less: PoolOutStreak = LESS.episode!.less!;
  const change: PoolOutStreak = OTHER.episode!.change!;
  assert.deepEqual([LESS.episode?.less != null, LESS.episode?.change, LESS.episode?.clear], [true, null, null], 'control: the real tracker, fewer short on its way and nothing else');
  assert.deepEqual([OTHER.episode?.change != null, OTHER.episode?.change?.slots, OTHER.episode?.less, OTHER.episode?.clear], [true, [2], null, null], 'control: another set on its way and nothing else');
  const clear = CLEARING.episode!.clear;
  for (const { slots, k, named } of SHAPES) {
    const c = (over: Record<string, unknown>): PoolOutRead => poolOutRead(latched(slots, k, over));
    const tag = `slots ${JSON.stringify(slots)}, k ${k}`;
    assert.deepEqual(c({ less }), verdict(named, k, fx.at(10), { contested: true }), `★ episode.less — ${tag}`);
    assert.deepEqual(c({ change: { ...change, k } }), verdict(named, k, fx.at(10), { contested: true }), `★ episode.change — ${tag}`);
    assert.deepEqual(c({ less, change: { ...change, k } }), verdict(named, k, fx.at(10), { contested: true }), tag);
    for (const none of [null, undefined]) assert.deepEqual(c({ less: none, change: none }), verdict(named, k, fx.at(10)), `neither — ${tag}`);
    // The clear dwell is the other flag: it does not contest, and a contest does not start it.
    assert.deepEqual(c({ clear }), verdict(named, k, fx.at(10), { returning: true }), `the clear dwell alone — ${tag}`);
    assert.deepEqual(c({ clear, less }), verdict(named, k, fx.at(10), { returning: true, contested: true }), tag);
  }
  // The real tracker: the names and the count stand through the contest.
  assert.deepEqual(poolOutRead(LESS), verdict([1, 3], 2, fx.at(13), { contested: true }), '★ two named, one slot short for three readings');
  assert.deepEqual(poolOutRead(OTHER), verdict([1], 1, fx.at(13), { contested: true }), '★ slot 1 named, slot 2 pointed at for three readings');
  for (const settled of [EP, UNNAMED, TWO, CLEARING]) assert.equal(poolOutRead(settled).contested, false);
  // No episode: nothing to contest. A streak before its raise is not a contest.
  for (const quiet of [null, undefined, emptyPoolOutState(), REFERENCE, STREAK, { ...LESS, episode: null }, { ...OTHER, episode: null }]) {
    assert.equal(poolOutRead(quiet).contested, false);
  }
});

test('★★★ hostile state: a slot that is not an integer in 1..3 is left out, a count that is not a non-negative integer is 0', () => {
  const named = (slots: unknown): number[] => poolOutRead(latched(slots, 1)).named;
  assert.deepEqual(named([0, 4, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined, {}, [1], true, 2]), [2], 'only the real slot is kept');
  assert.deepEqual(named([3, 1]), [1, 3], 'ascending, whatever the state holds');
  assert.deepEqual(named([1, 1, 3, 3, 3]), [1, 3], 'each slot once');
  assert.deepEqual(named([SHP2_SOURCE_SLOTS + 1]), []);
  for (const notAList of ['1', 1, true, { 0: 1, length: 1 }, new Set([1])]) assert.deepEqual(named(notAList), [], `${String(notAList)}: not a list, nothing named`);
  const counts = (k: unknown): number[] => { const r = poolOutRead(latched([1], k)); return [r.count, r.countAtMost]; };
  for (const bad of NOT_A_COUNT) assert.deepEqual(counts(bad), [0, 0], `count ${String(bad)}`);
  assert.deepEqual([counts(0), counts(1), counts(2), counts(3)], [[0, 0], [1, 1], [2, 2], [3, 3]]);
  // The data time is lastCapMs, handed on as the state holds it; null with none. Never the newest usable reading's.
  assert.equal(poolOutRead({ ...EP, lastCapMs: null }).asOfMs, null);
  assert.equal(poolOutRead({ ...EP, lastCapMs: 12345 }).asOfMs, 12345);
  assert.equal(poolOutRead({ ...EP, lastCapMs: 12345, lastUsableMs: 99999 }).asOfMs, 12345, '★ lastCapMs, not lastUsableMs');
  assert.equal(poolOutRead({ ...EP, lastCapMs: null, lastUsableMs: 99999 }).asOfMs, null, '★ no judged capacity is no data time, whatever was usable');
  assert.equal(poolOutRead({ ...EP, lastUsableMs: null }).asOfMs, fx.at(10), 'and lastUsableMs is not read at all');
});

test('★★ a COPY, and pure: the read never aliases or alters the tracker\'s state, and takes no clock', () => {
  const state = deepFreeze(structuredClone(TWO));
  const before = JSON.stringify(state);
  const read = poolOutRead(state);
  assert.deepEqual(read.named, [1, 3]);
  assert.notEqual(read.named, state.episode!.slots, 'not the state\'s own array');
  read.named.push(2);
  read.named.length = 0;
  assert.deepEqual(state.episode!.slots, [1, 3], 'altering the read leaves the alarm\'s set alone');
  assert.deepEqual(poolOutRead(state).named, [1, 3], 'and the next read is whole');
  assert.equal(JSON.stringify(state), before);
  assert.equal(poolOutRead.length, 1, 'one argument: the state. No clock, as the alarm\'s title has none');
  // The contested states too: frozen, read, unchanged.
  for (const s of [LESS, OTHER, MORE]) {
    const frozen = deepFreeze(structuredClone(s));
    const was = JSON.stringify(frozen);
    assert.deepEqual(poolOutRead(frozen), poolOutRead(s));
    assert.equal(JSON.stringify(frozen), was);
  }
});

test('★★★ asOfMs is the DATA time of the newest reading whose CAPACITY could be judged: skipped bodies leave it, and so do usable ones with no capacity verdict', () => {
  // Thirty minutes of bodies from a panel the cloud lists offline, and thirty under the stale-shadow latch: none is an observation.
  for (const extra of [{ online: false }, { latched: true }]) {
    const blind = fx.fold(EP, fx.minutes(11, 30, fx.lostBody, extra)).state;
    assert.deepEqual(poolOutRead(blind), verdict([1], 1, fx.at(10)), JSON.stringify(extra));
  }
  // A reading with a capacity verdict moves it: short (the alarm's own readings), or whole (the start of the return).
  assert.equal(poolOutRead(fx.fold(EP, fx.minutes(11, 4, fx.lostBody)).state).asOfMs, fx.at(14));
  assert.equal(poolOutRead(CLEARING).asOfMs, fx.at(13));
  // ★ Thirty USABLE readings whose capacity cannot be judged: the newest usable reading moves on, the verdict's data time does not.
  for (const [label, make, cls] of [['percent and power still point at slot 1', capUnknownNaming, 'NOCAP'], ['nothing else to go by', capUnknownQuiet, 'HOLD']] as const) {
    const f = fx.fold(EP, fx.minutes(11, 30, make));
    assert.deepEqual([...new Set(f.steps.map((s) => `${s.skip}/${s.signals?.cap.v}/${s.signals?.cls}`))], [`null/unknown/${cls}`], `control: every body is used, and its capacity is not judged — ${label}`);
    assert.deepEqual([f.state.lastUsableMs, f.state.lastCapMs], [fx.at(40), fx.at(10)], `control — ${label}`);
    assert.deepEqual(poolOutRead(f.state), verdict([1], 1, fx.at(10)), `★ the alarm stands, names slot 1, and is no younger — ${label}`);
  }
  // It is the time the pool-out sensor measures its own freshness on: fresh to the same instant.
  const quiet = fx.fold(REFERENCE, fx.minutes(0, 20, capUnknownQuiet)).state;
  assert.deepEqual([quiet.episode, quiet.lastUsableMs], [null, fx.at(19)], 'control: no alarm, twenty usable readings with no capacity verdict');
  assert.deepEqual(poolOutRead(quiet), noAlarm(fx.at(-1)));
  assert.deepEqual([poolOutSensorState(quiet, fx.at(-1) + FRESH), poolOutSensorState(quiet, fx.at(-1) + FRESH + 1)], ['off', 'unknown']);
});

/** The slots and the count in an alarm's fault token ("out:1+3;k=2", "out:1+?;k=2", "out:?;k=1"). */
const faultOf = (token: string): { slots: number[]; k: number } => {
  const m = /^out:([^;]*);k=(\d+)$/.exec(token);
  assert.ok(m, token);
  return { slots: m![1].split('+').filter((s) => s !== '?').map(Number), k: Number(m![2]) };
};
const maskOf = (state: PoolOutState | null): number | null =>
  Object.fromEntries(poolRecordMetrics({ servedFullWh: null, diag: null, signals: null, state })).pool_out_mask as number | null;
const maskSlots = (mask: number): number[] => [1, 2, 3].filter((n) => Math.floor(mask / 2 ** (n - 1)) % 2 === 1);

test('★★★ AGREEMENT: the slots read are the slots in the alarm\'s fault token and the bits of pool_out_mask below 128 — every episode shape, contested or not', () => {
  assert.equal(POOL_OUT_MASK_UNIDENTIFIED, 128);
  const states: Array<[string, PoolOutState]> = [
    ...SHAPES.map(({ slots, k }): [string, PoolOutState] => [`slots ${JSON.stringify(slots)}, k ${k}`, latched(slots, k)]),
    ...SHAPES.map(({ slots, k }): [string, PoolOutState] => [`slots ${JSON.stringify(slots)}, k ${k}, clearing`, latched(slots, k, { clear: CLEARING.episode!.clear })]),
    ...SHAPES.map(({ slots, k }): [string, PoolOutState] => [`slots ${JSON.stringify(slots)}, k ${k}, fewer short on its way`, latched(slots, k, { less: LESS.episode!.less })]),
    ...SHAPES.map(({ slots, k }): [string, PoolOutState] => [`slots ${JSON.stringify(slots)}, k ${k}, more short on its way`, latched(slots, k, { change: { ...MORE.episode!.change!, k: k + 1 } })]),
    ['raised and named', EP], ['raised on capacity alone', UNNAMED], ['two named', TWO], ['a flap raise', FLAP], ['a larger count pending', LARGER], ['the clear running', CLEARING],
    ['fewer short on its way', LESS], ['another set on its way', OTHER], ['more short on its way', MORE],
    ['thirty readings with no capacity verdict', fx.fold(EP, fx.minutes(11, 30, capUnknownNaming)).state],
  ];
  for (const [label, state] of states) {
    const read = poolOutRead(state);
    const parts = poolOutAlertParts(state, { nowMs: state.last?.atMs ?? fx.at(10), timeZone: TZ });
    assert.ok(parts, `${label}: the alarm stands`);
    const fault = faultOf(parts!.fault);
    const mask = maskOf(state)!;
    assert.deepEqual(read.named, fault.slots, `${label}: the fault token ${parts!.fault}`);
    assert.deepEqual(read.named, maskSlots(mask), `${label}: pool_out_mask ${mask}`);
    assert.equal(read.count, fault.k, `${label}: the count is the token's k`);
    assert.equal(mask >= POOL_OUT_MASK_UNIDENTIFIED, read.count > read.named.length, `${label}: bit 128 is "a slot out is not identified"`);
    // …and the read is enough to rebuild the alarm's title, to the letter.
    assert.equal(poolOutTitle(read.count, read.named), parts!.title, label);
  }
  // No alarm: no alert, mask 0, nothing read. No tracker state: no mask row at all.
  for (const quiet of [REFERENCE, STREAK, emptyPoolOutState()]) {
    assert.equal(poolOutAlertParts(quiet, { nowMs: fx.at(10), timeZone: TZ }), null);
    assert.equal(maskOf(quiet), 0);
    assert.deepEqual([poolOutRead(quiet).named, poolOutRead(quiet).count], [[], 0]);
  }
  assert.equal(maskOf(null), null);
  assert.deepEqual([poolOutRead(null).named, poolOutRead(null).count], [[], 0]);
});

/* ══ 1b. the store's reader: the panel's own state, and contained ═════════════════════════════════════ */

test('★★★ store.poolOutRead: the standing alarm of THAT panel; no state reads as no alarm; a read that throws is null, said once at most, and never thrown', () => {
  const store = new SnapshotStore({ poolOutPath: null, poolEventsDir: null });
  const clock = { ms: 0 };
  store.setClock(() => clock.ms);
  const logged: string[] = [];
  store.setLogger((m) => logged.push(m));
  store.setWarnLogger((m) => logged.push(m));
  store.setDeviceList([{ sn: fx.PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 }] as never);
  const feed = (minute: number, make: (seq: number) => Body): void => { clock.ms = fx.at(minute); store.setDeviceQuota(fx.PANEL_SN, make(minute)); };
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), noAlarm(null), 'before any body: no alarm');
  for (let m = -15; m < 0; m++) feed(m, fx.healthyBody);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), noAlarm(fx.at(-1)), 'a healthy pool');
  for (let m = 0; m <= 10; m++) feed(m, fx.lostBody);
  const read = store.poolOutRead(fx.PANEL_SN);
  assert.deepEqual(read, verdict([1], 1, fx.at(10)), '★ slot 1 out, named after the dwell');
  assert.deepEqual(read, poolOutRead(store.poolRecord(fx.PANEL_SN).state), 'the pure reader over the state the recorder is given');
  read!.named.push(3);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN)!.named, [1], 'a copy each time');
  assert.deepEqual(store.poolOutRead('HD31XXX00XXX0002'), noAlarm(null), '★ another panel\'s serial: its own (empty) verdict, never this panel\'s');
  // Through the store too: bodies whose capacity cannot be judged do not keep the verdict young; one that can moves it, and
  // one naming another slot contests it.
  for (let m = 11; m <= 13; m++) feed(m, capUnknownNaming);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), verdict([1], 1, fx.at(10)), '★ three bodies with no capacity verdict: the data time stays');
  feed(14, slot2Out);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), verdict([1], 1, fx.at(14), { contested: true }), '★ a body that names slot 2: judged, and a contest');
  // The forced failure of poolOutStore.test.ts: a state that throws on any read.
  const said = logged.length;
  (store as unknown as { poolOutBySn: Map<string, unknown> }).poolOutBySn.set(fx.PANEL_SN, new Proxy({}, { get() { throw new Error('no state'); } }));
  assert.equal(store.poolOutRead(fx.PANEL_SN), null, '★ a verdict that cannot be read is null: the caller takes it as no alarm');
  assert.equal(store.poolOutRead(fx.PANEL_SN), null);
  assert.equal(store.poolOutRead(fx.PANEL_SN), null);
  // Three failed reads (three ticks): one line at most, at whatever level, and no serial in it.
  const lines = logged.slice(said);
  assert.equal(lines.length <= 1, true, `not a line on every tick:\n${lines.join('\n')}`);
  for (const l of lines) assert.equal(l.includes(fx.PANEL_SN), false, 'no serial in the line');
  // …and null is rule 1: every connected slot a target, every one counted.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], store.poolOutRead(fx.PANEL_SN), fx.at(11)), { targets: [1, 2, 3], leftOut: [], rateCount: 3, outCount: 0 });
});

test('★★★ store.poolOutRead: a verdict that cannot be read is SAID — one line, at warn, with what the tick then does; the same failure is said once', () => {
  const store = new SnapshotStore({ poolOutPath: null, poolEventsDir: null });
  const infos: string[] = [];
  const warns: string[] = [];
  store.setLogger((m) => infos.push(m));
  store.setWarnLogger((m) => warns.push(m));
  const states = (store as unknown as { poolOutBySn: Map<string, unknown> }).poolOutBySn;
  states.set(fx.PANEL_SN, new Proxy({}, { get() { throw new Error('no state'); } }));
  const said = [infos.length, warns.length];
  // Three ticks of the force-charge, and a planner pass: four reads that fail the same way.
  for (let read = 0; read < 4; read++) assert.equal(store.poolOutRead(fx.PANEL_SN), null);
  assert.deepEqual(warns.slice(said[1]), [
    'pool-out: the standing alarm\'s slots could not be read for the force-charge (no state) — every connected slot is counted for its rate and sent ON.',
  ], '★ said once, at warn: a verdict taken as "no alarm" is never taken so in silence');
  assert.deepEqual(infos.slice(said[0]), [], 'and not at info as well');
  for (const l of warns) assert.equal(l.includes(fx.PANEL_SN), false, 'no serial in the line');
  // A failure of another kind is another line; the first one is still not repeated.
  states.set(fx.PANEL_SN, new Proxy({}, { get() { throw new Error('another failure'); } }));
  assert.equal(store.poolOutRead(fx.PANEL_SN), null);
  assert.equal(store.poolOutRead(fx.PANEL_SN), null);
  assert.deepEqual(warns.slice(said[1]).map((l) => /\(([^)]*)\)/.exec(l)?.[1]), ['no state', 'another failure']);
  // A read that succeeds says nothing.
  states.delete(fx.PANEL_SN);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), noAlarm(null));
  assert.equal(warns.length - said[1], 2);
});

/* ══ 2. forceChargePoolSlots: every input ═══════════════════════════════════════════════════════════ */

const NOW = Date.UTC(2026, 10, 21, 10, 0); // 03:00 MST, inside an overnight window
/** A sound read a minute old with nothing standing against it; `countAtMost` is the count unless given. */
const read = (over: Partial<PoolOutRead> = {}): PoolOutRead => {
  const r = { named: [] as number[], count: 0, returning: false, contested: false, asOfMs: (NOW - MIN) as number | null, ...over };
  return { ...r, countAtMost: over.countAtMost ?? r.count };
};
/** A verdict object as a grid builds it: any field may be absent, or not what the type says. */
type Loose = Record<string, unknown>;
const loose = (pool: Loose): PoolOutRead => pool as unknown as PoolOutRead;
/** The verdict's data time, and whether an ON may act on it at NOW: at most the freshness limit old, and not ahead. */
const AGES: Array<{ label: string; asOfMs: number | null; fresh: boolean }> = [
  { label: 'no data time', asOfMs: null, fresh: false },
  { label: 'not a number', asOfMs: Number.NaN, fresh: false },
  { label: 'one ms ahead of now', asOfMs: NOW + 1, fresh: false },
  { label: 'an hour ahead of now', asOfMs: NOW + H, fresh: false },
  { label: 'now', asOfMs: NOW, fresh: true },
  { label: 'one ms old', asOfMs: NOW - 1, fresh: true },
  { label: 'a minute old', asOfMs: NOW - MIN, fresh: true },
  { label: 'one ms under the limit', asOfMs: NOW - FRESH + 1, fresh: true },
  { label: 'exactly the limit', asOfMs: NOW - FRESH, fresh: true },
  { label: 'one ms over the limit', asOfMs: NOW - FRESH - 1, fresh: false },
  { label: 'a day old', asOfMs: NOW - 24 * H, fresh: false },
];
/** A flag of the read (`returning`, `contested`): false, true, or the key absent. Only `false` lets an ON act. */
const FLAGS: Array<{ label: string; set: (key: string) => Loose; isFalse: boolean }> = [
  { label: 'false', set: (key) => ({ [key]: false }), isFalse: true },
  { label: 'true', set: (key) => ({ [key]: true }), isFalse: false },
  { label: 'absent', set: () => ({}), isFalse: false },
];
/** `countAtMost` against a count: below it, equal to it, above it, absent, and not a whole number. `whole` is what it may add. */
const atMostsFor = (count: number): Array<{ label: string; set: Loose; whole: number }> => [
  ...(count >= 1 ? [{ label: 'below', set: { countAtMost: count - 1 }, whole: count - 1 }] : []),
  { label: 'equal', set: { countAtMost: count }, whole: count },
  { label: 'above', set: { countAtMost: count + 1 }, whole: count + 1 },
  { label: 'absent', set: {}, whole: 0 },
  { label: 'not a whole number', set: { countAtMost: 1.5 }, whole: 0 },
];
/** One verdict of the grid, with what the specification says of it, stated from the values it was built from. */
interface GridPool {
  pool: PoolOutRead;
  named: number[];
  /** The count the rate takes: the larger of the count and a sound `countAtMost`. */
  counted: number;
  /** An ON may act on it: a name, `returning` false, `contested` false, and a recent data time. */
  mayAct: boolean;
  /** One key per (named, count, countAtMost): the rate must not depend on anything else. */
  rateKey: string;
}
/** Every verdict: each named set, each count 0..4 (below, at and above the names; above the panel's three), each
 *  `countAtMost`, `returning` and `contested` each false, true and absent, each age. */
const POOLS: GridPool[] = SUBSETS.flatMap((named) => [0, 1, 2, 3, 4].flatMap((count) => atMostsFor(count).flatMap((most) =>
  FLAGS.flatMap((returning) => FLAGS.flatMap((contested) => AGES.map(({ asOfMs, fresh }): GridPool => ({
    pool: loose({ named, count, ...most.set, ...returning.set('returning'), ...contested.set('contested'), asOfMs }),
    named,
    counted: Math.max(count, most.whole),
    mayAct: named.length > 0 && returning.isFalse && contested.isFalse && fresh,
    rateKey: `${JSON.stringify(named)}, count ${count}, countAtMost ${most.label}`,
  })))))));
/** One check inside a large grid: the message is built only when the check fails. */
const check = (ok: boolean, say: () => string): void => { if (!ok) assert.fail(say()); };
const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

test('the pool-out sensor\'s own freshness limit is the ON\'s: 15 minutes', () => {
  assert.equal(POOL_OUT_SENSOR_FRESH_MS, 15 * MIN);
  // 8 named sets × (4 + 4 × 5) counts and at-mosts × 3 × 3 flags × 11 ages.
  assert.deepEqual([CONNECTED.length, POOLS.length], [16, 8 * 24 * 9 * 11], 'the grid below: 16 connected lists × 19,008 verdicts');
  assert.equal(POOLS.filter((g) => g.mayAct).length, 7 * 24 * 5, 'an ON may act on 840 of them: a name, both flags false, one of the five recent ages');
});

test('★★★ EXHAUSTIVE: targets and leftOut partition `connected` in its order; a slot is left out only when named, not returning, not contested and fresh', () => {
  let cases = 0;
  let withheld = 0;
  for (const connected of CONNECTED) {
    for (const g of POOLS) {
      cases++;
      const p = forceChargePoolSlots(connected, g.pool, NOW);
      const tag = (): string => `connected ${JSON.stringify(connected)}, pool ${JSON.stringify(g.pool)} → ${JSON.stringify(p)}`;
      // A partition, order kept.
      check(sameList(connected.filter((n) => p.targets.includes(n)), p.targets), () => `targets in order — ${tag()}`);
      check(sameList(connected.filter((n) => p.leftOut.includes(n)), p.leftOut), () => `leftOut in order — ${tag()}`);
      check(p.targets.length + p.leftOut.length === connected.length, () => `every connected slot is in exactly one — ${tag()}`);
      check(!p.targets.some((n) => p.leftOut.includes(n)), () => `disjoint — ${tag()}`);
      // The ON's rule, stated on its own.
      check(sameList(p.leftOut, g.mayAct ? connected.filter((n) => g.named.includes(n)) : []), () => `★ leftOut — ${tag()}`);
      if (p.leftOut.length > 0) {
        withheld++;
        check(p.leftOut.every((n) => g.named.includes(n)), () => `only a NAMED slot is withheld — ${tag()}`);
        check(g.pool.returning === false && g.pool.contested === false, () => `★ withheld with a flag that is not false — ${tag()}`);
      }
    }
  }
  assert.equal(cases, 16 * 19_008);
  assert.ok(withheld > 0, 'the grid does withhold somewhere');
});

test('★★★ EXHAUSTIVE: rateCount = connected − outCount, on the larger of the count and a sound countAtMost; never under 1 while a slot is connected, 0 with none, never above the connected count', () => {
  let cases = 0;
  let floored = 0;
  let raised = 0;
  for (const connected of CONNECTED) {
    for (const g of POOLS) {
      cases++;
      const p = forceChargePoolSlots(connected, g.pool, NOW);
      const tag = (): string => `connected ${JSON.stringify(connected)}, pool ${JSON.stringify(g.pool)} → ${JSON.stringify(p)}`;
      const n = connected.length;
      check(Number.isInteger(p.rateCount) && Number.isInteger(p.outCount), tag);
      check(p.rateCount === n - p.outCount, () => `rateCount is connected less outCount — ${tag()}`);
      check(p.outCount >= 0, () => `outCount is never negative — ${tag()}`);
      check(p.rateCount <= n, () => `never above the connected count — ${tag()}`);
      check(p.rateCount >= (n > 0 ? 1 : 0), () => `★ never under 1 while a slot is connected — ${tag()}`);
      if (n === 0) check(p.rateCount === 0 && p.outCount === 0, () => `none connected stays 0 ("unknown" downstream) — ${tag()}`);
      // The count out, from the specification: the named slots that are connected, plus the slots short and not identified.
      const namedConnected = connected.filter((s) => g.named.includes(s)).length;
      const wanted = namedConnected + Math.max(0, g.counted - g.named.length);
      const none = g.counted === 0 && g.named.length === 0;
      const expected = n === 0 ? 0 : none ? n : Math.max(1, n - wanted);
      check(p.rateCount === expected, () => `★ rateCount, wanted ${expected} — ${tag()}`);
      if (n > 0 && !none && n - wanted < 1) floored++;
      // A larger count on its way lowers the rate's count below what the latched count alone gives.
      const byCountAlone = n === 0 ? 0 : Math.max(1, n - (namedConnected + Math.max(0, (g.pool.count as number) - g.named.length)));
      if ((g.pool.count as number) > 0 && p.rateCount < byCountAlone) raised++;
    }
  }
  assert.equal(cases, 16 * 19_008);
  assert.ok(floored > 0, 'the grid reaches the floor of 1');
  assert.ok(raised > 0, 'and a countAtMost above the count takes a further slot out of the rate');
});

test('★★★ EXHAUSTIVE: the RATE counts a doubtful slot out — its count does not depend on the verdict\'s age, on the return dwell or on a contest; only the ON does', () => {
  for (const connected of CONNECTED) {
    const rates = new Map<string, Set<string>>();
    for (const g of POOLS) {
      const p = forceChargePoolSlots(connected, g.pool, NOW);
      const seen = rates.get(g.rateKey) ?? new Set<string>();
      seen.add(`${p.rateCount}/${p.outCount}`);
      rates.set(g.rateKey, seen);
      // A slot kept as a target on a doubtful verdict is still counted OUT of the rate.
      const namedConnected = connected.filter((n) => g.named.includes(n)).length;
      if (p.leftOut.length === 0 && namedConnected > 0 && connected.length > namedConnected) {
        check(p.outCount >= namedConnected, () => `connected ${JSON.stringify(connected)}, pool ${JSON.stringify(g.pool)} → ${JSON.stringify(p)}`);
      }
    }
    assert.equal(rates.size, 8 * 24, 'one group per named set, count and countAtMost');
    for (const [key, seen] of rates) {
      assert.equal(seen.size, 1, `one rate count for every age, and for returning and contested each false, true and absent — connected ${JSON.stringify(connected)}, ${key}: ${[...seen].join(' ')}`);
    }
  }
  // …and a larger countAtMost never RAISES the rate's count: doubt only ever takes a slot out.
  for (const connected of CONNECTED) {
    for (const named of SUBSETS) {
      for (const count of [0, 1, 2, 3]) {
        const at = (countAtMost: number): number => forceChargePoolSlots(connected, read({ named, count, countAtMost }), NOW).rateCount;
        assert.equal(at(count + 1) <= at(count), true, `connected ${JSON.stringify(connected)}, named ${JSON.stringify(named)}, count ${count}`);
        assert.equal(at(count + 2) <= at(count + 1), true);
        for (let below = 0; below < count; below++) assert.equal(at(below), at(count), '★ a countAtMost below the count changes nothing: never below the count');
      }
    }
  }
});

test('★★★ the 2026-11-16 shape: three connected, slot 1 named out on a recent verdict — two targets, two counted', () => {
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 1 }), NOW), { targets: [2, 3], leftOut: [1], rateCount: 2, outCount: 1 });
  assert.deepEqual(forceChargePoolSlots([3, 1, 2], read({ named: [1], count: 1 }), NOW), { targets: [3, 2], leftOut: [1], rateCount: 2, outCount: 1 }, 'the order of `connected` is kept');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1, 3], count: 2 }), NOW), { targets: [2], leftOut: [1, 3], rateCount: 1, outCount: 2 });
  // The read of the real tracker's state, a minute after its newest reading.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(EP), fx.at(11)), { targets: [2, 3], leftOut: [1], rateCount: 2, outCount: 1 });
});

test('★★★ the freshness boundary: left out at exactly the limit; one ms over, ahead of now, or with no data time the slot is sent ON — and still counted out of the rate', () => {
  const at = (asOfMs: number | null): ForceChargePoolSlots => forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 1, asOfMs }), NOW);
  const OUT = { targets: [2, 3], leftOut: [1], rateCount: 2, outCount: 1 };
  const SENT = { targets: [1, 2, 3], leftOut: [], rateCount: 2, outCount: 1 };
  assert.deepEqual(at(NOW), OUT);
  assert.deepEqual(at(NOW - FRESH), OUT, 'exactly the limit: still a verdict the ON acts on');
  assert.deepEqual(at(NOW - FRESH - 1), SENT, '★ one ms over: the slot is sent ON');
  assert.deepEqual(at(NOW + 1), SENT, '★ a data time ahead of now is not fresh');
  assert.deepEqual(at(null), SENT, '★ no data time: nothing is withheld');
  assert.deepEqual(at(Number.NaN), SENT);
  assert.deepEqual(at(Number.POSITIVE_INFINITY), SENT);
  // The return dwell: the capacity reads whole again. The ON goes to the slot; the rate goes on counting it out.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 1, returning: true }), NOW), SENT, '★ returning: sent ON, counted out');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(CLEARING), fx.at(14)), SENT, 'the real tracker, three healthy readings into its clear');
  // A contest: readings since the latch disagree with it. The same: sent ON, counted out.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 1, contested: true }), NOW), SENT, '★ contested: sent ON, counted out');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 1, contested: true, returning: true }), NOW), SENT);
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(OTHER), fx.at(14)), SENT, 'the real tracker, three readings that name slot 2 instead');
  // An alarm standing through thirty minutes of skipped bodies: the verdict is 31 minutes old by its data time.
  const blind = fx.fold(EP, fx.minutes(11, 30, fx.lostBody, { online: false })).state;
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(blind), fx.at(41)), SENT, '★ an alarm that stood through a blind half hour withholds nothing');
});

test('★★★ a slot out but NOT IDENTIFIED lowers the rate and withholds nothing', () => {
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ count: 1 }), NOW), { targets: [1, 2, 3], leftOut: [], rateCount: 2, outCount: 1 });
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ count: 2 }), NOW), { targets: [1, 2, 3], leftOut: [], rateCount: 1, outCount: 2 });
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ count: 3 }), NOW), { targets: [1, 2, 3], leftOut: [], rateCount: 1, outCount: 2 }, '★ never 0: a count of 0 lifts the rate\'s bound');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ count: 7 }), NOW), { targets: [1, 2, 3], leftOut: [], rateCount: 1, outCount: 2 });
  assert.deepEqual(forceChargePoolSlots([2], read({ count: 1 }), NOW), { targets: [2], leftOut: [], rateCount: 1, outCount: 0 }, 'one connected: counted, the floor');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(UNNAMED), fx.at(16)), { targets: [1, 2, 3], leftOut: [], rateCount: 2, outCount: 1 }, 'the real tracker, raised on the capacity alone');
  // Partly named: the named slot is left out, the unidentified one only counted.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 2 }), NOW), { targets: [2, 3], leftOut: [1], rateCount: 1, outCount: 2 });
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 2, asOfMs: null }), NOW), { targets: [1, 2, 3], leftOut: [], rateCount: 1, outCount: 2 });
  // A slot MORE on its way through the dwell is such a slot: counted out, and withholding nothing of its own.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ count: 1, countAtMost: 2 }), NOW), { targets: [1, 2, 3], leftOut: [], rateCount: 1, outCount: 2 }, '★ countAtMost above the count: one more out of the rate');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 1, countAtMost: 2 }), NOW), { targets: [2, 3], leftOut: [1], rateCount: 1, outCount: 2 }, 'the pure function: the at-most alone is no contest');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 1, countAtMost: 2, contested: true }), NOW), { targets: [1, 2, 3], leftOut: [], rateCount: 1, outCount: 2 }, 'as the tracker hands it on: contested with it');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ count: 0, countAtMost: 1 }), NOW), { targets: [1, 2, 3], leftOut: [], rateCount: 2, outCount: 1 }, 'an at-most with no count is not "no alarm"');
});

test('★★ a named slot that is not connected is not counted twice: it was never a candidate and never in the count', () => {
  assert.deepEqual(forceChargePoolSlots([2, 3], read({ named: [1], count: 1 }), NOW), { targets: [2, 3], leftOut: [], rateCount: 2, outCount: 0 }, 'slot 1 named, slot 1 not connected: the two connected are the two in the pool');
  assert.deepEqual(forceChargePoolSlots([3, 2], read({ named: [1], count: 1 }), NOW), { targets: [3, 2], leftOut: [], rateCount: 2, outCount: 0 });
  assert.deepEqual(forceChargePoolSlots([2, 3], read({ named: [1], count: 2 }), NOW), { targets: [2, 3], leftOut: [], rateCount: 1, outCount: 1 }, 'and one more, not identified, is counted');
  assert.deepEqual(forceChargePoolSlots([2, 3], read({ named: [1, 2], count: 2 }), NOW), { targets: [3], leftOut: [2], rateCount: 1, outCount: 1 });
});

test('★★★ every connected slot named: none is a target, and the rate still counts one (the floor), not zero', () => {
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], read({ named: [1, 2, 3], count: 3 }), NOW), { targets: [], leftOut: [1, 2, 3], rateCount: 1, outCount: 2 });
  assert.deepEqual(forceChargePoolSlots([2], read({ named: [2], count: 1 }), NOW), { targets: [], leftOut: [2], rateCount: 1, outCount: 0 });
  assert.deepEqual(forceChargePoolSlots([1, 3], read({ named: [1, 3], count: 2 }), NOW), { targets: [], leftOut: [1, 3], rateCount: 1, outCount: 1 });
  // No slot connected: nothing to leave out, and the count stays 0 whatever the alarm says.
  for (const g of POOLS) {
    const p = forceChargePoolSlots([], g.pool, NOW);
    check(isDeepStrictEqual(p, { targets: [], leftOut: [], rateCount: 0, outCount: 0 }), () => `${JSON.stringify(g.pool)} → ${JSON.stringify(p)}`);
  }
});

test('★★ pure: frozen inputs are left as they were, and the lists handed back are new ones', () => {
  const connected = deepFreeze([3, 1, 2]);
  const pool = deepFreeze(read({ named: [1], count: 1 }));
  const p = forceChargePoolSlots(connected, pool, NOW);
  assert.deepEqual([connected, pool.named], [[3, 1, 2], [1]]);
  assert.notEqual(p.targets, connected);
  assert.notEqual(p.leftOut, pool.named);
  const again = forceChargePoolSlots(connected, null, NOW);
  assert.notEqual(again.targets, connected, 'a copy with no verdict too');
  again.targets.push(9);
  assert.deepEqual(connected, [3, 1, 2]);
  assert.deepEqual(forceChargePoolSlots(connected, pool, NOW), p, 'the same answer twice');
});

test('★★★ a verdict object that is not a sound read withholds nothing — a flag that is missing, or anything but false, fails toward sending ON — and never breaks the count', () => {
  const SOUND: Loose = { named: [1], count: 1, countAtMost: 1, returning: false, contested: false, asOfMs: NOW };
  const OUT = { targets: [2, 3], leftOut: [1], rateCount: 2, outCount: 1 };
  const SENT = { targets: [1, 2, 3], leftOut: [], rateCount: 2, outCount: 1 };
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], loose(SOUND), NOW), OUT, 'control: the sound read leaves slot 1 out');
  const without = (...keys: string[]): Loose => Object.fromEntries(Object.entries(SOUND).filter(([k]) => !keys.includes(k)));
  // ★ Each flag is tested `=== false`: missing, it withholds nothing — and the slot is still counted out of the rate.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], loose(without('contested')), NOW), SENT, '★ no `contested`');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], loose(without('returning')), NOW), SENT, '★ no `returning`');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], loose(without('contested', 'returning')), NOW), SENT);
  const hostile: Array<[string, Loose]> = [
    ['contested missing', without('contested')], ['returning missing', without('returning')], ['both flags missing', without('contested', 'returning')],
    ...[undefined, null, 0, '', 'false', 1, 'no', {}, []].flatMap((v): Array<[string, Loose]> => [
      [`contested ${JSON.stringify(v)}`, { ...SOUND, contested: v }], [`returning ${JSON.stringify(v)}`, { ...SOUND, returning: v }],
    ]),
    ['a data time that is a string', { ...SOUND, asOfMs: String(NOW) }], ['no data time', without('asOfMs')],
    ['names that are a string', { ...SOUND, named: '1' }], ['names that are null', { ...SOUND, named: null }], ['no names', without('named')],
    ['a count that is a fraction', { ...SOUND, named: [], count: 1.5, countAtMost: 1.5 }], ['a negative count', { ...SOUND, named: [], count: -2, countAtMost: -2 }],
    ['a count that is a string', { ...SOUND, named: [], count: '1', countAtMost: '1' }], ['an empty object', {}],
  ];
  for (const [label, pool] of hostile) {
    for (const connected of CONNECTED) {
      const p = forceChargePoolSlots(connected, loose(pool), NOW);
      const tag = `${label}: connected ${JSON.stringify(connected)}, pool ${JSON.stringify(pool)}`;
      assert.deepEqual(p.leftOut, [], `nothing withheld — ${tag}`);
      assert.deepEqual(p.targets, connected, `every connected slot a target — ${tag}`);
      assert.equal(p.rateCount >= (connected.length > 0 ? 1 : 0) && p.rateCount <= connected.length && p.rateCount === connected.length - p.outCount, true, tag);
    }
  }
  // A countAtMost that is missing, or not a whole number of slots, is ignored: the count stands, and the ON's rule with it.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], loose(without('countAtMost')), NOW), OUT, 'no `countAtMost`: the count');
  for (const bad of [...NOT_A_COUNT, 0]) assert.deepEqual(forceChargePoolSlots([1, 2, 3], loose({ ...SOUND, countAtMost: bad }), NOW), OUT, `countAtMost ${String(bad)}`);
  // A sound one above the count is taken; and it stands in for a count that is not sound.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], loose({ ...SOUND, countAtMost: 2 }), NOW), { targets: [2, 3], leftOut: [1], rateCount: 1, outCount: 2 });
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], loose({ ...SOUND, count: 1.5, countAtMost: 2 }), NOW), { targets: [2, 3], leftOut: [1], rateCount: 1, outCount: 2 });
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], loose({ ...SOUND, named: [], count: 'x', countAtMost: 1 }), NOW), { targets: [1, 2, 3], leftOut: [], rateCount: 2, outCount: 1 });
});

/* ══ 3. rule 1: no verdict is the release before ═════════════════════════════════════════════════════ */

/** Every way "no standing alarm" reaches forceChargePoolSlots. */
const NO_VERDICT: Array<[string, PoolOutRead | null | undefined]> = [
  ['null (the store\'s read failed)', null], ['undefined', undefined],
  ['no tracker state', poolOutRead(null)], ['an empty tracker', poolOutRead(emptyPoolOutState())],
  ['a healthy pool', poolOutRead(REFERENCE)], ['a streak before its raise', poolOutRead(STREAK)],
  ['a healthy pool, then twenty readings with no capacity verdict', poolOutRead(fx.fold(REFERENCE, fx.minutes(0, 20, capUnknownQuiet)).state)],
  ['nothing counted, nothing named', noAlarm(null)],
  ['the same on a recent reading', noAlarm(NOW)],
  ['the same, marked returning', { ...noAlarm(NOW), returning: true }],
  ['the same, marked contested', { ...noAlarm(NOW), contested: true }],
  ['the same, with neither flag', loose({ named: [], count: 0, countAtMost: 0, asOfMs: NOW })],
  ['the same, with no at-most', loose({ named: [], count: 0, returning: false, contested: false, asOfMs: NOW })],
  ['the same, with an at-most that is not a count', loose({ named: [], count: 0, countAtMost: 1.5, returning: false, contested: false, asOfMs: NOW })],
];

test('★★★ RULE 1: with no verdict, the result is { targets: connected, leftOut: [], rateCount: connected.length, outCount: 0 } for every input', () => {
  const lists: number[][] = [...CONNECTED, [7], [0, 1], [1, 3, 7], [1, 1, 2], [3, 2, 1, 4], [2.5], [-1, 2]];
  for (const [label, pool] of NO_VERDICT) {
    for (const connected of lists) {
      for (const nowMs of [NOW, 0, fx.at(11), Number.NaN]) {
        const p = forceChargePoolSlots(connected, pool, nowMs);
        assert.deepEqual(p, { targets: connected, leftOut: [], rateCount: connected.length, outCount: 0 }, `${label}, connected ${JSON.stringify(connected)}, now ${nowMs}`);
        assert.notEqual(p.targets, connected, 'a copy');
      }
    }
  }
});

/** The tick's composition, as section 6 pins it in index.ts: the list the decision is given, the rate's count (the live
 *  rate's and the fallback rate's), the slots left out. */
const tickCompose = (hwSlots: number[], pool: PoolOutRead | null | undefined, nowMs: number) => {
  const p = forceChargePoolSlots(hwSlots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS), pool, nowMs);
  return { pool: p, connectedSlots: p.leftOut.length > 0 ? p.targets : hwSlots, slotCount: p.rateCount, poolOutSlots: p.leftOut, rateSlotCount: p.rateCount };
};

const WIN_START = Date.UTC(2026, 10, 21, 6, 0); // 23:00 MST on the 20th
const WIN_END = WIN_START + 6 * H;              // 05:00 MST
const MID = WIN_START + 2 * H;
/** A cost night whose reserve write was applied and verified: the kind the force-charge rides. */
const verifiedNight = (over: Partial<NightActuationState> = {}): NightActuationState => ({
  ...emptyActuationState(),
  day: '2026-11-20', targetPct: 50, buyKwh: 40,
  windowStartMs: WIN_START, windowEndMs: WIN_END,
  applyAttemptedAtMs: WIN_START - 5 * MIN, attemptBaselinePct: 16,
  appliedAtMs: WIN_START - 5 * MIN, priorReservePct: 16, applyVerifiedAtMs: WIN_START + MIN,
  forceChargeCeilingPct: 90,
  ...over,
});
/** A live readback before the ON: nothing reads ON, the ceiling reads the night's, the pool far enough under the target that the start is due at MID. */
const startOpts = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: true, gridPresent: true, gridStaLost: false,
  slotsOn: [], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 90, poolSocPct: 20, fullKwh: 92,
  ...over,
});
const ON_AT = WIN_END - 100 * MIN;
const DUE = ON_AT + FORCE_CHARGE_ON_VERIFY_AFTER_MS;
/** The same night with its force-charge switched ON at ON_AT, the ON not yet proven by a readback. */
const onNight = (over: Partial<NightActuationState> = {}): NightActuationState => verifiedNight({
  forceChargeCeilingAttemptedAtMs: WIN_START + MIN, forceChargeCeilingPriorPct: 100,
  forceChargeOnAtMs: ON_AT, forceChargeSlots: [1, 2, 3],
  ...over,
});
/** A live readback mid-charge: the pool short of the target, every Core well under the panel's 90% ceiling. */
const runOpts = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: true, gridPresent: true, gridStaLost: false,
  slotsOn: [1, 2, 3], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 90, poolSocPct: 62, fullKwh: 92,
  slotSocPct: { 1: 62, 2: 61, 3: 63 },
  ...over,
});
const whyOf = (a: ForceChargeAction): string | undefined => (a as { why?: string }).why;
/** A failure verdict as [kind, slots, noRetry]. */
const failureOf = (a: ForceChargeAction): unknown[] => (a.kind === 'onFailed' ? [a.kind, a.slots, a.noRetry === true] : [a.kind]);
/** The per-Core option set for one block, as limits.test.ts sets it: withEnv restores the variable in its own finally. */
const PER_CORE_KW = 4;
const withPerCore = <T>(fn: () => T): Promise<T> => withEnv({ FORCE_CHARGE_KW_PER_CORE: String(PER_CORE_KW) }, fn);

test('★★★ RULE 1 at the tick: with no verdict the decision is given the connected list itself, the old count, and no slot left out — and decides as before, on the fallback rate too', async () => {
  const lists: number[][] = [[1, 2, 3], [3, 1, 2], [2], [], [1, 3, 7], [0, 2]];
  const perCoreBefore = forceChargeKwPerCore();
  const pass = (label0: string): void => {
    for (const [label, pool] of NO_VERDICT) {
      for (const hw of lists) {
        const c = tickCompose(hw, pool, NOW);
        const inRange = hw.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS).length;
        assert.equal(c.connectedSlots, hw, `${label}: the list above itself, not a filtered copy — ${JSON.stringify(hw)}`);
        assert.equal(c.slotCount, inRange, `${label}: the count v1.208.0 passed — ${JSON.stringify(hw)}`);
        assert.equal(c.rateSlotCount, inRange, `${label}: and the fallback's count is the same — ${JSON.stringify(hw)}`);
        assert.deepEqual(c.poolOutSlots, []);
        // The decision: every stage of a night, with the new fields and without them.
        const stages: Array<[NightActuationState, number, ForceChargeOpts]> = [
          [verifiedNight(), MID, startOpts({ connectedSlots: hw })],
          [verifiedNight(), WIN_START - 1, startOpts({ connectedSlots: hw })],
          [verifiedNight(), MID, startOpts({ connectedSlots: hw, ceilingReadbackPct: 100 })],
          [verifiedNight(), MID, startOpts({ connectedSlots: hw, slotsOn: [2] })],
          [onNight(), ON_AT + 3 * MIN, runOpts({ connectedSlots: hw })],
          [onNight(), DUE, runOpts({ connectedSlots: hw, slotsOn: [1, 3] })],
          [onNight({ forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: DUE }), DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, runOpts({ connectedSlots: hw, slotsOn: [] })],
          [onNight(), DUE, runOpts({ connectedSlots: hw, slotsOn: [1, 3], slotSocPct: { 1: 70, 2: 90, 3: 71 } })],
          [onNight(), WIN_END, runOpts({ connectedSlots: hw })],
          // A start timed on the FALLBACK rate (no live rate), at every half hour of the window: the minute it comes is the rate's.
          ...Array.from({ length: 12 }, (_, i): [NightActuationState, number, ForceChargeOpts] =>
            [verifiedNight(), WIN_START + i * 30 * MIN, startOpts({ connectedSlots: hw, poolSocPct: 50, fullKwh: 61.44, chargeRateKw: null })]),
        ];
        for (const [s, t, before] of stages) {
          const now = decideForceCharge(s, t, { ...before, connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots, rateSlotCount: c.rateSlotCount });
          assert.deepEqual(now, decideForceCharge(s, t, before), `${label0}: ${label}, ${JSON.stringify(hw)}, t ${t}`);
          if (now.kind === 'onVerified') assert.equal('outOfPool' in now, false, 'the old shape, no new key');
        }
      }
    }
  };
  pass('FORCE_CHARGE_KW_PER_CORE as it stands');
  // …and with the per-Core option set, where the fallback rate is slots × that rate and so takes a count at all.
  await withPerCore(() => {
    assert.equal(planRateFallbackKw(2), 2 * PER_CORE_KW, 'control: the fallback now follows the slot count');
    pass(`FORCE_CHARGE_KW_PER_CORE ${PER_CORE_KW}`);
  });
  assert.equal(forceChargeKwPerCore(), perCoreBefore, 'the option is back as it was');
});

/* ══ 3b. the real tracker's doubt, end to end: the fold, the read, the slots, the ON ═════════════════ */

/** A cost night whose window holds the pool fixture's clock (its minute 0 is an hour after the open), the reserve write
 *  verified, the pool far under the target: a start is due at every minute the folds below reach. */
const FX_NIGHT = verifiedNight({
  day: '2026-11-14', windowStartMs: fx.T0 - H, windowEndMs: fx.T0 + 5 * H,
  applyAttemptedAtMs: fx.T0 - H - 5 * MIN, appliedAtMs: fx.T0 - H - 5 * MIN, applyVerifiedAtMs: fx.T0 - H + MIN,
});
/** One tick over a state of the real tracker: the read, the composition, and the ON the decision makes of it. */
const tickOn = (state: PoolOutState, nowMs: number) => {
  const c = tickCompose([1, 2, 3], poolOutRead(state), nowMs);
  return { pool: c.pool, action: decideForceCharge(FX_NIGHT, nowMs, startOpts({ chargeRateKw: 5, connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots, rateSlotCount: c.rateSlotCount })) };
};
const SLOT_1_OUT = { targets: [2, 3], leftOut: [1], rateCount: 2, outCount: 1 };
const SLOT_1_SENT = { targets: [1, 2, 3], leftOut: [], rateCount: 2, outCount: 1 };

test('★★★ (a) the capacity cannot be judged: the verdict\'s data time stays at the last judged reading — slot 1 is left out up to 15 minutes after it, sent ON after that, and counted out of the rate throughout', () => {
  assert.deepEqual(tickOn(EP, fx.at(11)), { pool: SLOT_1_OUT, action: { kind: 'on', slots: [2, 3] } }, 'control: the alarm a minute old leaves slot 1 out');
  for (const [label, make] of [['percent and power still point at slot 1', capUnknownNaming], ['nothing else to go by', capUnknownQuiet]] as const) {
    const f = fx.fold(EP, fx.minutes(11, 45, make));
    assert.equal(f.steps.every((s) => s.skip == null && s.signals?.cap.v === 'unknown'), true, `control: forty-five usable readings, none with a capacity verdict — ${label}`);
    assert.deepEqual([f.state.lastUsableMs, f.state.lastCapMs], [fx.at(55), fx.at(10)], `control — ${label}`);
    let left = 0;
    let sent = 0;
    f.steps.forEach((step, i) => {
      const minute = 11 + i;
      assert.deepEqual(poolOutRead(step.state), verdict([1], 1, fx.at(10)), `minute ${minute}: the alarm stands, uncontested, and its data time does not move — ${label}`);
      const t = tickOn(step.state, fx.at(minute));
      const withheld = minute <= 25; // the reading of minute 10, and fifteen minutes
      assert.deepEqual(t.pool, withheld ? SLOT_1_OUT : SLOT_1_SENT, `★ minute ${minute} — ${label}`);
      assert.deepEqual(t.action, { kind: 'on', slots: withheld ? [2, 3] : [1, 2, 3] }, `★ minute ${minute}: the ON — ${label}`);
      if (withheld) left++; else sent++;
    });
    assert.deepEqual([left, sent], [15, 30]);
    // To the millisecond, on the last state.
    assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(f.state), fx.at(10) + FRESH), SLOT_1_OUT, `exactly fifteen minutes after the last judged reading: still left out — ${label}`);
    assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(f.state), fx.at(10) + FRESH + 1), SLOT_1_SENT, `★ one ms later: sent ON, and still counted out of the rate — ${label}`);
    // One reading that judges the capacity short again makes the verdict young again.
    const judged = fx.fold(f.state, fx.minutes(56, 1, fx.lostBody)).state;
    assert.deepEqual(poolOutRead(judged), verdict([1], 1, fx.at(56)));
    assert.deepEqual(tickOn(judged, fx.at(57)).pool, SLOT_1_OUT, `a judged reading: left out again — ${label}`);
  }
  // The control: the same forty-five minutes of readings that DO judge the capacity short keep the verdict young, and slot 1 out.
  const short = fx.fold(EP, fx.minutes(11, 45, fx.lostBody)).state;
  assert.deepEqual(poolOutRead(short), verdict([1], 1, fx.at(55)));
  assert.deepEqual(tickOn(short, fx.at(56)), { pool: SLOT_1_OUT, action: { kind: 'on', slots: [2, 3] } });
});

/**
 * Fold thirty minutes of `make` onto `from`, from minute 11, and check every minute's read, composition and ON: while a
 * streak stands against the latch (`during`), and once the tracker's dwell has latched the new set (`after`). The contest
 * must run unbroken from the first reading, and must settle. How long the dwell is belongs to the tracker's own tests.
 */
const walkContest = (
  from: PoolOutState, make: (seq: number) => Body, standing: (state: PoolOutState) => boolean,
  during: (minute: number) => { read: PoolOutRead; pool: ForceChargePoolSlots },
  after: (minute: number) => { read: PoolOutRead; pool: ForceChargePoolSlots },
): { contested: number; settledAt: number | null } => {
  const f = fx.fold(from, fx.minutes(11, 30, make));
  let contested = 0;
  let settledAt: number | null = null;
  f.steps.forEach((step, i) => {
    const minute = 11 + i;
    const pending = standing(step.state);
    if (pending) assert.equal(settledAt, null, `minute ${minute}: the contest runs unbroken until it settles`);
    else settledAt ??= minute;
    if (pending) contested++;
    const want = pending ? during(minute) : after(minute);
    assert.deepEqual(poolOutRead(step.state), want.read, `minute ${minute}: the read (${pending ? 'contested' : 'settled'})`);
    const t = tickOn(step.state, fx.at(minute));
    assert.deepEqual(t.pool, want.pool, `★ minute ${minute}: the slots (${pending ? 'contested' : 'settled'})`);
    assert.deepEqual(t.action, { kind: 'on', slots: want.pool.targets }, `★ minute ${minute}: the ON goes to the targets`);
  });
  return { contested, settledAt };
};

test('★★★ (b) two Cores named, then readings ONE slot short: contested — neither named slot is left out, and the rate still counts two out', () => {
  assert.deepEqual(tickOn(TWO, fx.at(11)), { pool: { targets: [2], leftOut: [1, 3], rateCount: 1, outCount: 2 }, action: { kind: 'on', slots: [2] } }, 'control: before the doubt, both named slots are left out');
  const w = walkContest(TWO, fx.lostBody, (s) => s.episode?.less != null,
    // Slot 3 may be back (slot 1 still reads out): which of the two is in is not established. Both are sent ON; both stay counted out.
    (minute) => ({ read: verdict([1, 3], 2, fx.at(minute), { contested: true }), pool: { targets: [1, 2, 3], leftOut: [], rateCount: 1, outCount: 2 } }),
    // The dwell has latched the smaller set: slot 1 out, on a verdict the ON acts on again.
    (minute) => ({ read: verdict([1], 1, fx.at(minute)), pool: SLOT_1_OUT }));
  assert.ok(w.contested >= 3 && w.settledAt != null, `the contest stood for ${w.contested} readings and settled at minute ${w.settledAt}`);
  // The rate through the contest: one Core's, never the two a "one slot back" reading would give before its dwell.
  const perCore = forceChargeKwPerCore();
  assert.equal(forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 1, legEff: Math.sqrt(0.86), slotCount: tickOn(LESS, fx.at(14)).pool.rateCount }), perCore);
});

test('★★★ (c) a different set on its way through the dwell: contested — nothing is left out; one that counts MORE slots short raises the count the rate takes out', () => {
  assert.deepEqual(tickOn(EP, fx.at(11)).pool, SLOT_1_OUT, 'control: before the doubt, slot 1 is left out');
  // Another slot at the SAME count: the readings name slot 2, the latch names slot 1.
  const same = walkContest(EP, slot2Out, (s) => s.episode?.change != null,
    (minute) => ({ read: verdict([1], 1, fx.at(minute), { contested: true }), pool: SLOT_1_SENT }),
    (minute) => ({ read: verdict([2], 1, fx.at(minute)), pool: { targets: [1, 3], leftOut: [2], rateCount: 2, outCount: 1 } }));
  assert.ok(same.contested >= 3 && same.settledAt != null, `${same.contested} readings, settled at minute ${same.settledAt}`);
  // MORE slots short: the readings count two (slots 1 and 3), the latch counts one. The doubtful extra slot is counted OUT at once.
  const more = walkContest(EP, twoOut, (s) => s.episode?.change != null,
    (minute) => ({ read: verdict([1], 1, fx.at(minute), { countAtMost: 2, contested: true }), pool: { targets: [1, 2, 3], leftOut: [], rateCount: 1, outCount: 2 } }),
    (minute) => ({ read: verdict([1, 3], 2, fx.at(minute)), pool: { targets: [2], leftOut: [1, 3], rateCount: 1, outCount: 2 } }));
  assert.ok(more.contested >= 3 && more.settledAt != null, `${more.contested} readings, settled at minute ${more.settledAt}`);
  // The rate the tick computes with each count: two Cores' bound at the same count, one Core's with the larger count on its way.
  const perCore = forceChargeKwPerCore();
  const rateOf = (state: PoolOutState, minute: number): number => forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 1, legEff: Math.sqrt(0.86), slotCount: tickOn(state, fx.at(minute)).pool.rateCount })!;
  assert.deepEqual([rateOf(EP, 11), rateOf(OTHER, 14), rateOf(MORE, 14)], [2 * perCore, 2 * perCore, perCore], '★ the larger count on its way is in the rate before it is in the title');
  // Not named at all with a larger count on its way; and a flap raise whose readings point at slot 1: contested, counted, nothing to leave out.
  assert.deepEqual(tickOn(LARGER, fx.at(18)), { pool: { targets: [1, 2, 3], leftOut: [], rateCount: 1, outCount: 2 }, action: { kind: 'on', slots: [1, 2, 3] } });
  assert.deepEqual(tickOn(FLAP, fx.at(12)), { pool: SLOT_1_SENT, action: { kind: 'on', slots: [1, 2, 3] } });
});

/* ══ 4. the start: a slot left out is no candidate, and the fallback rate has a count of its own ═════ */

test('★★ the control: three connected, no alarm — ON to all three; none connected — "no battery slots are connected"', () => {
  assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts()), { kind: 'on', slots: [1, 2, 3] });
  const none = decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: [] }));
  assert.deepEqual(none, { kind: 'none', why: 'no battery slots are connected' });
  assert.equal(forceChargeBlockerClass(whyOf(none)), 'noSlots');
});

test('★★★ EXHAUSTIVE: a slot left out is never in an ON\'s slots; the ON goes to exactly the targets, in order', () => {
  let ons = 0;
  let refusals = 0;
  let cases = 0;
  // The decision is a function of what the tick hands it: one call per distinct composition.
  const decided = new Map<string, ForceChargeAction>();
  for (const hw of CONNECTED) {
    for (const g of POOLS) {
      cases++;
      const c = tickCompose(hw, g.pool, NOW);
      const key = JSON.stringify([c.connectedSlots, c.poolOutSlots, c.rateSlotCount]);
      let a = decided.get(key);
      if (a == null) {
        a = decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots, rateSlotCount: c.rateSlotCount }));
        decided.set(key, a);
      }
      const act = a;
      const tag = (): string => `connected ${JSON.stringify(hw)}, pool ${JSON.stringify(g.pool)} → ${JSON.stringify(act)}`;
      if (act.kind === 'on') {
        ons++;
        check(!act.slots.some((n) => c.pool.leftOut.includes(n)), () => `★ an ON to a slot left out — ${tag()}`);
        check(sameList(act.slots, c.pool.targets), () => `the ON's slots are the targets — ${tag()}`);
        check(act.slots.every((n) => hw.includes(n)), tag);
        // ★ Only a verdict an ON may act on takes a slot out of it: on any doubt the ON goes to every connected slot.
        if (!g.mayAct) check(sameList(act.slots, hw), () => `★ a slot withheld on a verdict the ON may not act on — ${tag()}`);
      } else {
        refusals++;
        check(act.kind === 'none', tag);
        check(c.pool.targets.length === 0, () => `a refusal only with no target — ${tag()}`);
        check(whyOf(act) === (hw.length === 0 ? FORCE_CHARGE_BLOCKER_WHY.noSlots : FORCE_CHARGE_BLOCKER_WHY.noPoolSlots), tag);
        if (hw.length > 0) check(g.mayAct, () => `★ every slot refused on a verdict the ON may not act on — ${tag()}`);
      }
    }
  }
  assert.equal(cases, 16 * 19_008);
  assert.ok(ons > 0 && refusals > 0, `${ons} ONs, ${refusals} refusals`);
});

test('★★★ the decision takes a slot left out, out ITSELF: handed every connected slot and the slots left out, the ON goes to the rest — with none left, the pool refusal', () => {
  const W = FORCE_CHARGE_BLOCKER_WHY;
  assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: [1, 2, 3], poolOutSlots: [1] })), { kind: 'on', slots: [2, 3] }, '★ handed all three');
  assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: [1, 2, 3], poolOutSlots: [1, 2, 3] })), { kind: 'none', why: W.noPoolSlots }, '★ and all three left out');
  let ons = 0;
  let refusals = 0;
  for (const connected of CONNECTED) {
    for (const out of SUBSETS) {
      const a = decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: connected, poolOutSlots: out }));
      const rest = connected.filter((n) => !out.includes(n));
      const tag = `connected ${JSON.stringify(connected)}, left out ${JSON.stringify(out)} → ${JSON.stringify(a)}`;
      if (rest.length > 0) {
        ons++;
        assert.deepEqual(a, { kind: 'on', slots: rest }, tag);
      } else {
        refusals++;
        assert.equal(a.kind, 'none', tag);
        // Nothing connected and nothing left out is "no battery slots are connected", as before; slots connected and each left out is the pool's.
        // (None connected WITH a list of slots left out is not a state the tick composes, and is not stated here.)
        if (out.length === 0) assert.equal(whyOf(a), W.noSlots, tag);
        else if (connected.length > 0) assert.equal(whyOf(a), W.noPoolSlots, tag);
      }
      // The list the tick hands in (the slots left out already taken out of it) decides the same.
      if (connected.length > 0) assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: rest, poolOutSlots: out })), a, tag);
      // …and the slots left out change nothing but the candidates: a list that names none of the connected slots is no list.
      if (!connected.some((n) => out.includes(n)) && connected.length > 0) assert.deepEqual(a, decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: connected })), tag);
    }
  }
  assert.ok(ons > 0 && refusals > 0, `${ons} ONs, ${refusals} refusals`);
});

test('★★★ every connected slot left out: a refusal of its own — its words, its class, a blocker; never "no battery slots are connected"', () => {
  const W = FORCE_CHARGE_BLOCKER_WHY;
  assert.equal(W.noPoolSlots, 'every connected battery slot is left out: the pool alarm names its Core out of the panel\'s backup pool');
  const c = tickCompose([1, 2, 3], read({ named: [1, 2, 3], count: 3 }), NOW);
  assert.deepEqual([c.connectedSlots, c.poolOutSlots], [[], [1, 2, 3]]);
  const a = decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots, rateSlotCount: c.rateSlotCount }));
  assert.deepEqual(a, { kind: 'none', why: W.noPoolSlots });
  assert.equal(forceChargeBlockerClass(whyOf(a)), 'noPoolSlots', '★ its own class');
  assert.notEqual(forceChargeBlockerClass(whyOf(a)), 'noSlots');
  assert.equal(isForceChargeStartBlocker(whyOf(a)), true, 'a blocker: a line night held by it is pushed, not silent');
  // One connected slot, and it is the one named.
  const one = tickCompose([2], read({ named: [2], count: 1 }), NOW);
  assert.equal(whyOf(decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: one.connectedSlots, poolOutSlots: one.poolOutSlots, rateSlotCount: one.rateSlotCount }))), W.noPoolSlots);
  // On any doubt there is no such refusal: the same three names contested, returning, or past the limit, and the ON goes to all three.
  for (const doubt of [{ contested: true }, { returning: true }, { asOfMs: NOW - FRESH - 1 }, { asOfMs: null }]) {
    const d = tickCompose([1, 2, 3], read({ named: [1, 2, 3], count: 3, ...doubt }), NOW);
    assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: d.connectedSlots, poolOutSlots: d.poolOutSlots, rateSlotCount: d.rateSlotCount })), { kind: 'on', slots: [1, 2, 3] }, JSON.stringify(doubt));
  }
  // The class matcher goes by prefix: no entry may begin with another's text, the new one included.
  const entries = Object.entries(W);
  for (const [ka, wa] of entries) for (const [kb, wb] of entries) if (ka !== kb) assert.equal(wa.startsWith(wb), false, `${ka} begins with ${kb}`);
  for (const [k, w] of entries) assert.equal(forceChargeBlockerClass(`${w} and whatever follows`), k);
});

test('★★ without the new field — absent, null or empty — no candidate is "no battery slots are connected", as before', () => {
  for (const poolOutSlots of [undefined, null, [] as number[]]) {
    const o = startOpts({ connectedSlots: [], ...(poolOutSlots === undefined ? {} : { poolOutSlots }) });
    assert.deepEqual(decideForceCharge(verifiedNight(), MID, o), { kind: 'none', why: FORCE_CHARGE_BLOCKER_WHY.noSlots }, String(poolOutSlots));
  }
  // …and an out-of-range list with no slot left out is the same refusal (only real slots are candidates).
  assert.equal(whyOf(decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: [0, 7] }))), FORCE_CHARGE_BLOCKER_WHY.noSlots);
});

test('★★★ the refusal writes NOTHING: no ceiling sync on a night whose every slot is left out', () => {
  // The panel's ceiling reads 100, the night wants 90: with a candidate the first step is the ceiling write.
  const drifted = { ceilingReadbackPct: 100 };
  assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts({ ...drifted, connectedSlots: [2, 3], poolOutSlots: [1] })), { kind: 'syncCeiling', pct: 90, prior: 100 }, 'control: two targets, the ceiling is synced');
  assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts({ ...drifted, connectedSlots: [], poolOutSlots: [1, 2, 3] })), { kind: 'none', why: FORCE_CHARGE_BLOCKER_WHY.noPoolSlots }, '★ no target, no write');
  assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts({ ...drifted, connectedSlots: [1, 2, 3], poolOutSlots: [1, 2, 3] })), { kind: 'none', why: FORCE_CHARGE_BLOCKER_WHY.noPoolSlots }, '★ nor when handed every connected slot');
});

test('★★★ "Charge Now already on" on a slot LEFT OUT still declines the start — and comes before the new refusal', () => {
  // Slot 1 is named out and left out; someone's Charge Now reads ON for it. slotsOn is not filtered: the start is declined.
  const c = tickCompose([1, 2, 3], read({ named: [1], count: 1 }), NOW);
  assert.deepEqual([c.connectedSlots, c.poolOutSlots], [[2, 3], [1]]);
  const a = decideForceCharge(verifiedNight(), MID, startOpts({ slotsOn: [1], connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots }));
  assert.equal(a.kind, 'none');
  assert.equal(whyOf(a), 'Charge Now is already ON for slot(s) 1 — that is the operator\'s, never taken over');
  assert.equal(forceChargeBlockerClass(whyOf(a)), 'alreadyOn');
  // With that slot reading OFF the same night starts on the other two.
  assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots })), { kind: 'on', slots: [2, 3] });
  // Every slot left out and one reading ON: still the operator's Charge Now, not the pool refusal.
  const all = decideForceCharge(verifiedNight(), MID, startOpts({ slotsOn: [3], connectedSlots: [], poolOutSlots: [1, 2, 3] }));
  assert.equal(forceChargeBlockerClass(whyOf(all)), 'alreadyOn');
});

test('★★ a LINE night held by it: the new class pushes once it has held ten minutes, once a night, apart from "no slots connected"', () => {
  // A line night (no cost ceiling, a 56% ask), the line gate on, every connected slot left out.
  const line = verifiedNight({ forceChargeCeilingPct: null, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55, forceChargeRides: true });
  const o = { ...startOpts({ enabled: false, ceilingReadbackPct: 80, poolSocPct: 50, fullKwh: 92.16, chargeRateKw: 14 }), lineEnabled: true } as ForceChargeOpts;
  const t = WIN_END - 2 * H;
  assert.equal(decideForceCharge(line, WIN_END - 30 * MIN, o).kind, 'on', 'control: the line night starts with its slots in');
  const held = decideForceCharge(line, t, { ...o, connectedSlots: [], poolOutSlots: [1, 2, 3] });
  assert.deepEqual(held, { kind: 'none', why: FORCE_CHARGE_BLOCKER_WHY.noPoolSlots });
  let st = EMPTY_LINE_DECLINED_PUSH;
  const step = (why: string | undefined, at: number) => { const r = lineDeclinedPushStep(st, why, at); st = r.state; return r.push; };
  assert.equal(step(whyOf(held), t), null, 'the first tick starts the clock');
  assert.equal(step(whyOf(held), t + FORCE_CHARGE_LINE_DECLINED_PERSIST_MS - 1), null);
  assert.equal(step(whyOf(held), t + FORCE_CHARGE_LINE_DECLINED_PERSIST_MS), 'noPoolSlots', '★ pushed as its own class');
  assert.equal(step(whyOf(held), t + 2 * FORCE_CHARGE_LINE_DECLINED_PERSIST_MS), null, 'once a night');
  // "No slots connected" is another class with a clock of its own: it has not been pushed by this one.
  assert.equal(step(FORCE_CHARGE_BLOCKER_WHY.noSlots, t + 3 * FORCE_CHARGE_LINE_DECLINED_PERSIST_MS), null);
  assert.equal(step(FORCE_CHARGE_BLOCKER_WHY.noSlots, t + 4 * FORCE_CHARGE_LINE_DECLINED_PERSIST_MS), 'noSlots');
});

/** A line night whose verified ON the panel switched off at its 80% ceiling; the pool back under the start target. */
const latchedOffNight = (over: Partial<NightActuationState> = {}): NightActuationState => verifiedNight({
  forceChargeCeilingPct: null, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55, forceChargeRides: true,
  forceChargeOnAtMs: WIN_START + 2 * H, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: WIN_START + 2 * H + 5 * MIN,
  forceChargeMode: 'line', forceChargeCeilingSyncedPct: 80, forceChargeOnLastAttemptMs: WIN_START + 2 * H,
  ...over,
} as Partial<NightActuationState>);
/** The live readback of that night an hour before the close: every slot OFF, every Core at 60% under the 80% ceiling. */
const reOnOpts = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  ...startOpts({ enabled: false, ceilingReadbackPct: 80, poolSocPct: 60, fullKwh: 92.16, chargeRateKw: 14, slotSocPct: { 1: 60, 2: 60, 3: 60 } }),
  lineEnabled: true, ...over,
} as ForceChargeOpts);

test('★★★ a line RE-ON is an ON target too: a slot of ours named out is not switched back on; on a doubtful verdict it is', () => {
  const latchedOff = latchedOffNight();
  const t = WIN_END - H;
  const o = (c: ReturnType<typeof tickCompose>): ForceChargeOpts => reOnOpts({ connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots, rateSlotCount: c.rateSlotCount });
  const named = (over: Partial<PoolOutRead> = {}): PoolOutRead => ({ named: [1], count: 1, countAtMost: 1, returning: false, contested: false, asOfMs: t - MIN, ...over });
  assert.deepEqual(decideForceCharge(latchedOff, t, o(tickCompose([1, 2, 3], null, t))), { kind: 'lineReOn', slots: [1, 2, 3] }, 'control: no alarm, all three switched back on');
  assert.deepEqual(decideForceCharge(latchedOff, t, o(tickCompose([1, 2, 3], named(), t))), { kind: 'lineReOn', slots: [2, 3] }, '★ slot 1 named out: not switched back on');
  assert.deepEqual(decideForceCharge(latchedOff, t, o(tickCompose([1, 2, 3], named({ returning: true }), t))), { kind: 'lineReOn', slots: [1, 2, 3] }, 'the return dwell running: switched back on');
  assert.deepEqual(decideForceCharge(latchedOff, t, o(tickCompose([1, 2, 3], named({ contested: true }), t))), { kind: 'lineReOn', slots: [1, 2, 3] }, '★ contested: switched back on');
  assert.deepEqual(decideForceCharge(latchedOff, t, o(tickCompose([1, 2, 3], named({ asOfMs: t - FRESH - 1 }), t))), { kind: 'lineReOn', slots: [1, 2, 3] }, 'a verdict past the limit: switched back on');
  // ★ Handed every connected slot AND the slot left out, the re-ON takes it out itself.
  assert.deepEqual(decideForceCharge(latchedOff, t, reOnOpts({ connectedSlots: [1, 2, 3], poolOutSlots: [1] })), { kind: 'lineReOn', slots: [2, 3] });
  assert.deepEqual(decideForceCharge(latchedOff, t, reOnOpts({ connectedSlots: [1, 2, 3], poolOutSlots: [1, 2, 3] })), { kind: 'none' }, 'every slot of ours left out: no re-ON at all');
});

test('★★★ EXHAUSTIVE: lineReOnDue never returns a slot left out — every list of ours, every readback, every connected list, every list left out', () => {
  const t = WIN_END - H;
  let cases = 0;
  let due = 0;
  for (const ours of SUBSETS.filter((s) => s.length > 0)) {
    const s = latchedOffNight({ forceChargeSlots: ours });
    for (const slotsOn of SUBSETS) {
      for (const connected of SUBSETS) {
        for (const out of SUBSETS) {
          cases++;
          const o = reOnOpts({ slotsOn, connectedSlots: connected, poolOutSlots: out });
          const r = lineReOnDue(s, t, o, ours);
          const tag = `ours ${JSON.stringify(ours)}, ON ${JSON.stringify(slotsOn)}, connected ${JSON.stringify(connected)}, left out ${JSON.stringify(out)} → ${JSON.stringify(r)}`;
          if (r != null) {
            due++;
            assert.equal(r.slots.some((n) => out.includes(n)), false, `★ a re-ON to a slot left out — ${tag}`);
          }
          // The slots of ours reading OFF and connected (every Core is under the ceiling here), less the slots left out.
          const want = ours.filter((n) => !slotsOn.includes(n) && connected.includes(n) && !out.includes(n));
          assert.deepEqual(r, want.length > 0 ? { kind: 'lineReOn', slots: want } : null, tag);
          // Nothing else is due on this record: the decision returns that re-ON, or nothing.
          assert.deepEqual(decideForceCharge(s, t, o), r ?? { kind: 'none' }, tag);
          // A list that names no slot of ours, an empty one, null and none at all: the release before.
          if (!ours.some((n) => out.includes(n))) {
            const before = lineReOnDue(s, t, reOnOpts({ slotsOn, connectedSlots: connected }), ours);
            assert.deepEqual(r, before, `no slot of ours left out: as before — ${tag}`);
            assert.deepEqual(lineReOnDue(s, t, reOnOpts({ slotsOn, connectedSlots: connected, poolOutSlots: null }), ours), before, tag);
          }
        }
      }
    }
  }
  assert.equal(cases, 7 * 8 * 8 * 8);
  assert.ok(due > 0);
});

test('★★★ the RATE: with a Core counted out the bound is two Cores\', the start comes earlier, and the count is never the 0 that lifts the bound', () => {
  const LEG = Math.sqrt(0.86);
  const perCore = forceChargeKwPerCore();
  const rateOf = (c: ReturnType<typeof tickCompose>): number => forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 1, legEff: LEG, slotCount: c.slotCount })!;
  const all = tickCompose([1, 2, 3], null, NOW);
  const named = tickCompose([1, 2, 3], read({ named: [1], count: 1 }), NOW);
  const unnamed = tickCompose([1, 2, 3], read({ count: 1 }), NOW);
  const stale = tickCompose([1, 2, 3], read({ named: [1], count: 1, asOfMs: NOW - 24 * H }), NOW);
  const contested = tickCompose([1, 2, 3], read({ named: [1], count: 1, contested: true }), NOW);
  const returning = tickCompose([1, 2, 3], read({ named: [1], count: 1, returning: true }), NOW);
  assert.equal(rateOf(all), 16 * LEG, 'three Cores: the grid cap less the house binds, as before');
  for (const c of [named, unnamed, stale, contested, returning]) assert.equal(rateOf(c), 2 * perCore, 'two Cores in the pool: bounded by what two take');
  // Timed on the two-Core pool the panel reports (61.44 kWh), 50% → 90%.
  const start = (rate: number): number => forceChargeStartAtMs(WIN_END, 90, 50, 61.44, rate);
  assert.ok(start(rateOf(named)) < start(rateOf(all)) - 30 * MIN, 'the start is more than half an hour earlier');
  const between = start(rateOf(all)) - 10 * MIN;
  const at = (c: ReturnType<typeof tickCompose>): ForceChargeAction => decideForceCharge(verifiedNight(), between,
    startOpts({ poolSocPct: 50, fullKwh: 61.44, chargeRateKw: rateOf(c), connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots, rateSlotCount: c.rateSlotCount }));
  assert.equal(at(all).kind, 'none', 'timed for three, this minute is too early');
  assert.deepEqual(at(named), { kind: 'on', slots: [2, 3] }, '★ timed for two: already due, and sent to the two in the pool');
  assert.deepEqual(at(unnamed), { kind: 'on', slots: [1, 2, 3] }, '★ a slot out but not identified: the earlier start, and ON to all three');
  assert.deepEqual(at(stale), { kind: 'on', slots: [1, 2, 3] }, '★ a verdict a day old: the earlier start, and ON to all three');
  assert.deepEqual(at(contested), { kind: 'on', slots: [1, 2, 3] }, '★ a contested verdict: the earlier start, and ON to all three');
  assert.deepEqual(at(returning), { kind: 'on', slots: [1, 2, 3] }, '★ the return dwell running: the earlier start, and ON to all three');
  // A larger count on its way: one Core's rate, at once.
  const more = tickCompose([1, 2, 3], read({ named: [1], count: 1, countAtMost: 2, contested: true }), NOW);
  assert.deepEqual([more.slotCount, more.rateSlotCount, rateOf(more)], [1, 1, perCore]);
  // Every slot counted out: one Core's rate, never the unbounded rate a count of 0 gives.
  const allOut = tickCompose([1, 2, 3], read({ count: 3 }), NOW);
  assert.equal(allOut.slotCount, 1);
  assert.equal(rateOf(allOut), perCore);
  assert.equal(forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 1, legEff: LEG, slotCount: 0 }), 16 * LEG, 'control: a count of 0 is "unknown", no bound');
  // The planner's charge cap takes the same count.
  assert.equal(planChargeCapKw(0, named.slotCount, LEG), (2 * perCore) / LEG);
  assert.equal(planChargeCapKw(0, all.slotCount, LEG), (3 * perCore) / LEG);
  assert.equal(planChargeCapKw(0, null, LEG), LEGACY_CHARGE_CAP_KW, 'the slots unknown stay unknown');
});

/** The first minute tick of the window at which the decision is an ON, and the slots it goes to. */
const firstOn = (s: NightActuationState, o: ForceChargeOpts): { atMs: number; slots: number[] } => {
  for (let t = WIN_START; t < WIN_END; t += MIN) {
    const a = decideForceCharge(s, t, o);
    if (a.kind === 'on') return { atMs: t, slots: a.slots };
  }
  return assert.fail('no ON in the window');
};
/** The first minute tick at or after a computed start. */
const tickAtOrAfter = (startMs: number): number => Math.max(WIN_START, Math.ceil(startMs / MIN) * MIN);
/** Values of rateSlotCount that are not a whole number of 1 or more: each is "no count". */
const NO_RATE_COUNT: unknown[] = [undefined, null, 0, 1.5, Number.NaN, -1, Number.POSITIVE_INFINITY, '2', true, [2]];

test('★★★ rateSlotCount: with no live rate and FORCE_CHARGE_KW_PER_CORE set, the start is timed for the Cores counted in the pool — earlier than for the ON\'s slots, exactly a two-slot night\'s; it never raises the count', async () => {
  const perCoreBefore = forceChargeKwPerCore();
  await withPerCore(() => {
    assert.deepEqual([forceChargeKwPerCore(), planRateFallbackKw(3), planRateFallbackKw(2), planRateFallbackKw(1)], [PER_CORE_KW, 3 * PER_CORE_KW, 2 * PER_CORE_KW, PER_CORE_KW], 'control: the fallback rate follows the count');
    // No live rate (chargeRateKw null); a two-Core pool as the panel reports it, 50% → the night's 90%.
    const o = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => startOpts({ poolSocPct: 50, fullKwh: 61.44, chargeRateKw: null, ...over });
    const startFor = (slots: number): number => tickAtOrAfter(forceChargeStartAtMs(WIN_END, 90, 50, 61.44, null, null, slots));
    const three = firstOn(verifiedNight(), o());
    const twoSlotNight = firstOn(verifiedNight(), o({ connectedSlots: [2, 3] }));
    const counted = firstOn(verifiedNight(), o({ rateSlotCount: 2 }));
    assert.deepEqual([three.atMs, twoSlotNight.atMs], [startFor(3), startFor(2)], 'control: each night starts on its own slot count');
    assert.ok(startFor(2) <= startFor(3) - 30 * MIN, 'control: the two starts are more than half an hour apart');
    assert.ok(counted.atMs < three.atMs, '★ a count of 2 on three slots: EARLIER than three slots with no count');
    assert.equal(counted.atMs, twoSlotNight.atMs, '★ and exactly the start of a two-slot night');
    assert.deepEqual(counted.slots, [1, 2, 3], 'the ON still goes to all three: the count is the rate\'s alone');
    // One step further: a count of 1.
    const one = firstOn(verifiedNight(), o({ rateSlotCount: 1 }));
    assert.equal(one.atMs, startFor(1));
    assert.ok(one.atMs <= counted.atMs);
    assert.equal(one.atMs, firstOn(verifiedNight(), o({ connectedSlots: [2] })).atMs, 'the start of a one-slot night');
    // ★ It never RAISES the count: 5 on two slots, 3 on two, 3 on three and 4 on three are each no count.
    for (const [connectedSlots, rateSlotCount] of [[[2, 3], 5], [[2, 3], 3], [[2, 3], 2], [[1, 2, 3], 3], [[1, 2, 3], 4], [[2], 2]] as Array<[number[], number]>) {
      assert.deepEqual(firstOn(verifiedNight(), o({ connectedSlots, rateSlotCount })), firstOn(verifiedNight(), o({ connectedSlots })), `★ ${rateSlotCount} on ${JSON.stringify(connectedSlots)}`);
    }
    // ★ Absent, null, 0, a fraction, NaN and anything else that is not a whole number of 1 or more: the ON's own slot count.
    for (const none of NO_RATE_COUNT) {
      const a = firstOn(verifiedNight(), o(none === undefined ? {} : { rateSlotCount: none as number }));
      assert.deepEqual(a, three, `rateSlotCount ${String(none)}`);
    }
    // The count is taken against the ON's OWN slots, after a slot left out is taken out: 2 of [2,3] is no bound, 1 is.
    assert.equal(firstOn(verifiedNight(), o({ connectedSlots: [1, 2, 3], poolOutSlots: [1], rateSlotCount: 2 })).atMs, twoSlotNight.atMs);
    assert.deepEqual(firstOn(verifiedNight(), o({ connectedSlots: [1, 2, 3], poolOutSlots: [1], rateSlotCount: 1 })), { atMs: startFor(1), slots: [2, 3] });
    // With a LIVE rate the count changes nothing: that rate already carries it.
    for (const rateSlotCount of [1, 2, 3, 5]) {
      assert.deepEqual(firstOn(verifiedNight(), o({ chargeRateKw: 9, rateSlotCount })), firstOn(verifiedNight(), o({ chargeRateKw: 9 })), `a live rate, count ${rateSlotCount}`);
    }
    // The tick's composition: the count it hands in is what the start is timed for, and what its ON line reports
    // (index.ts fallbackSlots: the lower of the ON's slots and the count; section 6 pins the expression).
    const compositions: Array<[string, PoolOutRead | null, number, number[]]> = [
      ['no alarm', null, 3, [1, 2, 3]],
      ['slot 1 named on a recent verdict', read({ named: [1], count: 1 }), 2, [2, 3]],
      ['a slot out, not identified', read({ count: 1 }), 2, [1, 2, 3]],
      ['slot 1 named on a verdict a day old', read({ named: [1], count: 1, asOfMs: NOW - 24 * H }), 2, [1, 2, 3]],
      ['slot 1 named, contested', read({ named: [1], count: 1, contested: true }), 2, [1, 2, 3]],
      ['slot 1 named, the return dwell running', read({ named: [1], count: 1, returning: true }), 2, [1, 2, 3]],
      ['slot 1 named and one more not identified', read({ named: [1], count: 2 }), 1, [2, 3]],
      ['slot 1 named, a second slot on its way', read({ named: [1], count: 1, countAtMost: 2, contested: true }), 1, [1, 2, 3]],
      ['two out, neither identified', read({ count: 2 }), 1, [1, 2, 3]],
    ];
    for (const [label, pool, fallbackSlots, slots] of compositions) {
      const c = tickCompose([1, 2, 3], pool, NOW);
      const slotsNow = c.connectedSlots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS).length;
      assert.equal(c.pool.rateCount >= 1 ? Math.min(slotsNow, c.pool.rateCount) : slotsNow, fallbackSlots, `the count the ON line reports — ${label}`);
      assert.deepEqual(firstOn(verifiedNight(), o({ connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots, rateSlotCount: c.rateSlotCount })), { atMs: startFor(fallbackSlots), slots }, `★ ${label}`);
    }
  });
  assert.equal(forceChargeKwPerCore(), perCoreBefore, 'the option is back as it was');
});

test('★★★ rateSlotCount on a LINE night: the same, through forceChargeLineStartAtMs', async () => {
  const perCoreBefore = forceChargeKwPerCore();
  await withPerCore(() => {
    const line = verifiedNight({ forceChargeCeilingPct: null, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55, forceChargeRides: true });
    const o = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts =>
      ({ ...startOpts({ enabled: false, ceilingReadbackPct: 80, poolSocPct: 50, fullKwh: 92.16, chargeRateKw: null, ...over }), lineEnabled: true });
    const mode = forceChargeModeOf(line, { cost: false, line: true });
    assert.deepEqual([mode?.kind, mode?.kind === 'line' ? mode.startTargetPct : null], ['line', 61], 'control: a line night, timed to 61% twenty minutes before the close');
    const startFor = (slots: number): number => tickAtOrAfter(forceChargeLineStartAtMs(WIN_END, 61, 50, 92.16, null, null, slots));
    const three = firstOn(line, o());
    const twoSlotNight = firstOn(line, o({ connectedSlots: [2, 3] }));
    const counted = firstOn(line, o({ rateSlotCount: 2 }));
    assert.deepEqual([three.atMs, twoSlotNight.atMs], [startFor(3), startFor(2)], 'control: each night starts on its own slot count');
    assert.ok(startFor(2) <= startFor(3) - 20 * MIN, 'control: the two starts are well apart');
    assert.ok(counted.atMs < three.atMs, '★ EARLIER with a count of 2 than with three slots and no count');
    assert.deepEqual(counted, { atMs: twoSlotNight.atMs, slots: [1, 2, 3] }, '★ the start of a two-slot line night, the ON to all three');
    assert.deepEqual(firstOn(line, o({ rateSlotCount: 1 })), { atMs: startFor(1), slots: [1, 2, 3] });
    // It never raises the count…
    for (const [connectedSlots, rateSlotCount] of [[[2, 3], 5], [[2, 3], 3], [[1, 2, 3], 3], [[1, 2, 3], 4]] as Array<[number[], number]>) {
      assert.deepEqual(firstOn(line, o({ connectedSlots, rateSlotCount })), firstOn(line, o({ connectedSlots })), `★ ${rateSlotCount} on ${JSON.stringify(connectedSlots)}`);
    }
    // …and what is not a whole number of 1 or more is no count.
    for (const none of NO_RATE_COUNT) {
      assert.deepEqual(firstOn(line, o(none === undefined ? {} : { rateSlotCount: none as number })), three, `rateSlotCount ${String(none)}`);
    }
    // With a slot left out as well, and with a live rate.
    assert.deepEqual(firstOn(line, o({ connectedSlots: [1, 2, 3], poolOutSlots: [1], rateSlotCount: 1 })), { atMs: startFor(1), slots: [2, 3] });
    assert.deepEqual(firstOn(line, o({ chargeRateKw: 9, rateSlotCount: 1 })), firstOn(line, o({ chargeRateKw: 9 })));
  });
  assert.equal(forceChargeKwPerCore(), perCoreBefore, 'the option is back as it was');
});

/* ══ 5. the ON verify: a slot of ours named out after the ON ═════════════════════════════════════════ */

test('★★★ a slot of ours named out after the ON is exempt: verified on the others, reported as out of the pool — never as at the ceiling', () => {
  // The ON went to 1, 2 and 3; the alarm then named slot 1. Slots 2 and 3 read ON.
  assert.deepEqual(decideForceCharge(onNight(), ON_AT + 3 * MIN, runOpts({ slotsOn: [2, 3], connectedSlots: [2, 3], poolOutSlots: [1] })),
    { kind: 'onVerified', atCeiling: [], outOfPool: [1] }, 'no grace needed: a readback that shows the others ON is proof');
  // Its Core reads at the panel's ceiling as well: still out of the pool, never "switched off by the panel itself".
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [2, 3], poolOutSlots: [1], slotSocPct: { 1: 99, 2: 61, 3: 63 } })),
    { kind: 'onVerified', atCeiling: [], outOfPool: [1] }, '★ never in atCeiling as well');
  // One slot out of the pool, another at the ceiling: each under its own name.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [3], poolOutSlots: [1], slotSocPct: { 1: 62, 2: 90, 3: 63 } })),
    { kind: 'onVerified', atCeiling: [2], outOfPool: [1] });
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [2], poolOutSlots: [1, 3] })), { kind: 'onVerified', atCeiling: [], outOfPool: [1, 3] });
  // The control: the same readings with no slot named are a re-issue to slot 1 once the grace is over.
  assert.deepEqual(decideForceCharge(onNight(), ON_AT + 3 * MIN, runOpts({ slotsOn: [2, 3] })), { kind: 'none' });
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [2, 3] })), { kind: 'onRetry', slots: [1] });
});

test('★★★ the key is ABSENT unless a slot is exempted for the pool: the old shape for every reading that names none', () => {
  // Named out, and reading ON beside the two in the pool: nothing was exempted.
  const on = decideForceCharge(onNight(), DUE, runOpts({ poolOutSlots: [1] }));
  assert.deepEqual(on, { kind: 'onVerified', atCeiling: [] });
  assert.equal('outOfPool' in on, false);
  // Named out, and not ours.
  const notOurs = decideForceCharge(onNight({ forceChargeSlots: [2, 3] }), DUE, runOpts({ slotsOn: [2, 3], connectedSlots: [2, 3], poolOutSlots: [1] }));
  assert.deepEqual(notOurs, { kind: 'onVerified', atCeiling: [] });
  assert.equal('outOfPool' in notOurs, false);
  // The ceiling exemption alone keeps its shape.
  const ceiling = decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [1, 3], slotSocPct: { 1: 70, 2: 90, 3: 71 }, poolOutSlots: [] }));
  assert.deepEqual(ceiling, { kind: 'onVerified', atCeiling: [2] });
  assert.equal('outOfPool' in ceiling, false);
});

const RETRIED = { forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: DUE };
/** The tick on which the re-issue has had its grace: the failure verdict, if the ON still has not taken. */
const JUDGED = DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS;

test('★★★ a slot out of the pool is in no RE-ISSUE; a failure names it exactly when NO slot of ours reads ON', () => {
  const o = (slotsOn: number[]): ForceChargeOpts => runOpts({ slotsOn, poolOutSlots: [1] });
  const retried = onNight(RETRIED);
  // Slot 3 reads ON; 1 (out of the pool) and 2 read OFF: only slot 2 is re-issued, then only slot 2 has failed.
  assert.deepEqual(decideForceCharge(onNight(), DUE - 1, o([3])), { kind: 'none' }, 'inside the grace');
  assert.deepEqual(decideForceCharge(onNight(), DUE, o([3])), { kind: 'onRetry', slots: [2] }, '★ the re-issue: not slot 1');
  assert.deepEqual(failureOf(decideForceCharge(retried, JUDGED, o([3]))), ['onFailed', [2], false], '★ slot 3 took it: a failure on slot 2, and slot 1 stays out of it');
  // Nothing reads ON: the re-issue is for 2 and 3 only — and the failure names all three, for the ON took nowhere.
  assert.deepEqual(decideForceCharge(onNight(), DUE - 1, o([])), { kind: 'none' }, 'inside the grace');
  assert.deepEqual(decideForceCharge(onNight(), DUE, o([])), { kind: 'onRetry', slots: [2, 3] }, '★ the re-issue: never slot 1');
  assert.deepEqual(failureOf(decideForceCharge(retried, JUDGED, o([]))), ['onFailed', [1, 2, 3], false], '★ the WHOLE failure: slot 1 named with the others');
  // Too close to the close for a re-issue: the forfeit, by the same rule.
  assert.deepEqual(failureOf(decideForceCharge(onNight(), WIN_END - 10 * MIN, o([3]))), ['onFailed', [2], true]);
  assert.deepEqual(failureOf(decideForceCharge(onNight(), WIN_END - 10 * MIN, o([]))), ['onFailed', [1, 2, 3], true], '★ whole, with none reading ON');
  // The failure's list keeps the order of the ON's own list, whatever order that is.
  assert.deepEqual(decideForceCharge(onNight({ ...RETRIED, forceChargeSlots: [3, 1, 2] }), JUDGED, o([])), { kind: 'onFailed', slots: [3, 1, 2] });
  assert.deepEqual(decideForceCharge(onNight({ forceChargeSlots: [3, 1, 2] }), DUE, o([])), { kind: 'onRetry', slots: [3, 2] });
  // The re-issue rides the start's gates, as before: with the grid not known present it waits, and is no failure yet.
  assert.deepEqual(decideForceCharge(onNight(), DUE, { ...o([]), gridPresent: null }), { kind: 'none' });
  // The controls, with no slot named: slot 1 is in each.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [3] })), { kind: 'onRetry', slots: [1, 2] });
  assert.deepEqual(decideForceCharge(retried, JUDGED, runOpts({ slotsOn: [] })), { kind: 'onFailed', slots: [1, 2, 3] });
  // …and a list that is empty, null or names no slot of ours is no list.
  for (const poolOutSlots of [[], null, [4], [0]] as Array<number[] | null>) {
    assert.deepEqual(decideForceCharge(retried, JUDGED, runOpts({ slotsOn: [3], poolOutSlots })), { kind: 'onFailed', slots: [1, 2] }, JSON.stringify(poolOutSlots));
  }
});

/** The record as the integrator persists a failure verdict: its time, and a copy of its slots. */
const withFailure = (s: NightActuationState, atMs: number, a: ForceChargeAction): NightActuationState => {
  assert.equal(a.kind, 'onFailed');
  return { ...s, forceChargeOnFailedAtMs: atMs, forceChargeOnFailedSlots: a.kind === 'onFailed' ? [...a.slots] : null };
};
/** The ON-failure push of a verdict, built as the integrator builds it. */
const failurePush = (s: NightActuationState, a: ForceChargeAction): string => {
  assert.equal(a.kind, 'onFailed');
  if (a.kind !== 'onFailed') return '';
  return buildNightForceChargeOnFailure({
    day: s.day, slots: a.slots, ourSlots: s.forceChargeSlots, retries: s.forceChargeOnRetries, noRetry: a.noRetry === true,
    ...forceChargeOnFailureNight(s),
  }).body;
};

test('★★★ the WHOLE failure and its readers: the ON took on no slot, one of ours out of the pool — every slot named, no "on those slot(s)", the closure "not taken"', () => {
  const retried = onNight(RETRIED);
  // The ON went to 1, 2 and 3; the re-issue is spent and has had its grace; nothing reads ON; the alarm names slot 1.
  const whole = decideForceCharge(retried, JUDGED, runOpts({ slotsOn: [], poolOutSlots: [1] }));
  assert.deepEqual(whole, { kind: 'onFailed', slots: [1, 2, 3] }, '★ every slot of ours, the exempt one too');
  const wholeRecord = withFailure(retried, JUDGED, whole);
  // Reader 1: a failure shorter than the ON's list is "the ON took on the others". This one is not shorter.
  assert.equal(partialForceChargeOnFailureSlots({ forceChargeSlots: retried.forceChargeSlots, forceChargeOnFailedSlots: [1, 2, 3] }), null, '★ not a partial failure');
  assert.equal(partialForceChargeOnFailureSlots(wholeRecord), null);
  // Reader 2: the night's outcome, as the morning summary takes it.
  const outcome = forceChargeNightOutcome(wholeRecord, true);
  assert.deepEqual([outcome.kind, outcome.kind === 'failed' ? outcome.partialSlots : 'n/a'], ['failed', null]);
  // Reader 3: the push. The whole-failure sentence, every slot named, and never "on those slot(s)".
  const push = failurePush(retried, whole);
  assert.match(push, /still reads slot\(s\) 1, 2, 3 OFF after 1 re-issue\(s\)\. /);
  assert.match(push, /Tonight's buy above the \d+% reserve \(toward ~\d+(?:\.\d)?%\) will not happen; the reserve charge is unaffected\./, '★ the whole-failure sentence');
  assert.equal(push.includes('on those slot(s)'), false, '★ never the partial sentence');
  // Once a night: with the failure on the record nothing more is judged.
  assert.deepEqual(decideForceCharge(wholeRecord, JUDGED + MIN, runOpts({ slotsOn: [], poolOutSlots: [1] })), { kind: 'none' });
  // …and a late apply on a slot in the pool still verifies it, slot 1 named as out of the pool.
  assert.deepEqual(decideForceCharge(wholeRecord, JUDGED + 5 * MIN, runOpts({ slotsOn: [2, 3], poolOutSlots: [1] })), { kind: 'onVerified', atCeiling: [], outOfPool: [1] });

  // The PARTIAL case beside it: slot 3 reads ON. The failure is slot 2's; slot 1 is in no failure.
  const part = decideForceCharge(retried, JUDGED, runOpts({ slotsOn: [3], poolOutSlots: [1] }));
  assert.deepEqual(part, { kind: 'onFailed', slots: [2] });
  const partRecord = withFailure(retried, JUDGED, part);
  assert.deepEqual(partialForceChargeOnFailureSlots(partRecord), [2]);
  const partOutcome = forceChargeNightOutcome(partRecord, true);
  assert.deepEqual([partOutcome.kind, partOutcome.kind === 'failed' ? partOutcome.partialSlots : 'n/a'], ['failed', [2]]);
  const partPush = failurePush(retried, part);
  assert.match(partPush, /still reads slot\(s\) 2 OFF after 1 re-issue\(s\)\. /);
  assert.match(partPush, /will not happen on those slot\(s\); the reserve charge is unaffected\./);

  // The control, no slot named: the release before, the same whole failure.
  const before = decideForceCharge(retried, JUDGED, runOpts({ slotsOn: [] }));
  assert.deepEqual(before, whole);
  assert.equal(failurePush(retried, before), push, 'and the same push, to the letter');
});

test('★★★ the WHOLE failure on a LINE night: the served closure is "notTaken", never "partTaken", and the push says the add-on adds nothing above the reserve', () => {
  const lineOn = onNight({
    forceChargeCeilingPct: null, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55, forceChargeRides: true,
    forceChargeMode: 'line', forceChargeCeilingSyncedPct: 80, ...RETRIED,
  } as Partial<NightActuationState>);
  const o = (over: Partial<ForceChargeOpts>): ForceChargeOpts =>
    ({ ...runOpts({ enabled: false, ceilingReadbackPct: 80, poolSocPct: 52, slotSocPct: { 1: 52, 2: 52, 3: 52 }, ...over }), lineEnabled: true });
  const G = { cost: false, line: true };
  assert.equal(armedLineStartClosed(lineOn, JUDGED, G), null, 'control: before the verdict the run is not closed');
  const whole = decideForceCharge(lineOn, JUDGED, o({ slotsOn: [], poolOutSlots: [1] }));
  assert.deepEqual(whole, { kind: 'onFailed', slots: [1, 2, 3] });
  const closure = armedLineStartClosed(withFailure(lineOn, JUDGED, whole), JUDGED + MIN, G);
  assert.deepEqual(closure, { windowStartMs: WIN_START, why: 'notTaken', writeStands: true }, '★ notTaken: an ON warned of on EVERY slot');
  assert.match(lineStartClosedWords('the line', 'notTaken'), /has not taken effect: unless it applies late, none runs$/);
  const push = failurePush(lineOn, whole);
  assert.match(push, /still reads slot\(s\) 1, 2, 3 OFF after 1 re-issue\(s\)\. /);
  assert.match(push, /has not taken effect: unless it applies late, the add-on adds nothing above the \d+% reserve/, '★ the whole-failure sentence');
  assert.equal(push.includes('on those slot(s)'), false, '★ never the partial sentence');
  assert.match(push, /Charge Now switched on for slot\(s\) 1, 2, 3 in the EcoFlow app/);
  // The partial case: slot 3 reads ON.
  const part = decideForceCharge(lineOn, JUDGED, o({ slotsOn: [3], poolOutSlots: [1] }));
  assert.deepEqual(part, { kind: 'onFailed', slots: [2] });
  assert.deepEqual(armedLineStartClosed(withFailure(lineOn, JUDGED, part), JUDGED + MIN, G), { windowStartMs: WIN_START, why: 'partTaken' });
  assert.match(failurePush(lineOn, part), /has not taken effect on those slot\(s\)/);
  // The control, no slot named: the same closure and the same push as the whole failure above.
  const before = decideForceCharge(lineOn, JUDGED, o({ slotsOn: [] }));
  assert.deepEqual(before, whole);
  assert.deepEqual(armedLineStartClosed(withFailure(lineOn, JUDGED, before), JUDGED + MIN, G), closure);
  assert.equal(failurePush(lineOn, before), push);
});

test('★★★ every slot of ours out of the pool and none reading ON: nothing to re-issue — nothing inside the grace, then ONE failure naming every slot of ours with no noRetry flag, then nothing', () => {
  const o = runOpts({ slotsOn: [], connectedSlots: [], poolOutSlots: [1, 2, 3] });
  const WHOLE = { kind: 'onFailed', slots: [1, 2, 3] };
  assert.deepEqual(decideForceCharge(onNight(), ON_AT + 3 * MIN, o), { kind: 'none' }, 'inside the grace');
  assert.deepEqual(decideForceCharge(onNight(), DUE - 1, o), { kind: 'none' }, 'one ms inside it');
  const failed = decideForceCharge(onNight(), DUE, o);
  assert.deepEqual(failed, WHOLE, '★ the grace over: the failure, every slot of ours');
  assert.equal('noRetry' in failed, false, '★ no noRetry flag: that one says the window was too short for a re-issue');
  assert.deepEqual(decideForceCharge(onNight(), DUE + 30 * MIN, o), WHOLE, 'the same on any later tick, until it is on the record');
  const late = decideForceCharge(onNight(), WIN_END - 10 * MIN, o);
  assert.deepEqual(late, WHOLE, '★ inside the re-issue cutoff too');
  assert.equal('noRetry' in late, false, '★ and still no noRetry flag: no re-issue was ever due');
  // Never a re-issue, at any minute of the run: there is no slot one may be sent to. And never verified.
  for (let t = ON_AT; t < WIN_END; t += MIN) {
    const kind = decideForceCharge(onNight(), t, o).kind;
    assert.equal(kind === 'none' || kind === 'onFailed', true, `minute ${(t - ON_AT) / MIN}: ${kind}`);
  }
  // The grace runs from the last attempt, as for every verdict.
  const attempted = onNight({ forceChargeOnLastAttemptMs: ON_AT + 5 * MIN });
  assert.deepEqual(decideForceCharge(attempted, ON_AT + 5 * MIN + FORCE_CHARGE_ON_VERIFY_AFTER_MS - 1, o), { kind: 'none' });
  assert.deepEqual(decideForceCharge(attempted, ON_AT + 5 * MIN + FORCE_CHARGE_ON_VERIFY_AFTER_MS, o), WHOLE);
  // A failure that is not held behind the re-issue's gates: there is no re-issue to gate.
  assert.deepEqual(decideForceCharge(onNight(), DUE, { ...o, vitalsRed: true }), WHOLE);
  // No live readback: absence is not evidence, as before.
  assert.deepEqual(decideForceCharge(onNight(), DUE, { ...o, slotsOn: null }), { kind: 'none' });
  // ★ Once the failure is on the record: nothing, for the rest of the night.
  const recorded = withFailure(onNight(), DUE, failed);
  for (const t of [DUE + MIN, DUE + 30 * MIN, WIN_END - 10 * MIN]) assert.deepEqual(decideForceCharge(recorded, t, o), { kind: 'none' }, `t ${t}`);
  // Its readers: the whole failure, and after no re-issue at all.
  assert.equal(partialForceChargeOnFailureSlots(recorded), null);
  const push = failurePush(onNight(), failed);
  assert.match(push, /still reads slot\(s\) 1, 2, 3 OFF after 0 re-issue\(s\)\. /);
  assert.equal(push.includes('too close to the window end'), false, 'the push does not say the window was too short');
  assert.equal(push.includes('on those slot(s)'), false);
  // Every list of ours, with every list that holds it: 'none', then the failure naming the ON's own list, then 'none'.
  for (const ours of SUBSETS.filter((s) => s.length > 0)) {
    for (const out of SUBSETS.filter((s) => ours.every((n) => s.includes(n)))) {
      const s = onNight({ forceChargeSlots: ours });
      const opts = runOpts({ slotsOn: [], poolOutSlots: out });
      const tag = `ours ${JSON.stringify(ours)}, out of the pool ${JSON.stringify(out)}`;
      assert.deepEqual(decideForceCharge(s, DUE - 1, opts), { kind: 'none' }, tag);
      assert.deepEqual(decideForceCharge(s, DUE, opts), { kind: 'onFailed', slots: ours }, tag);
      assert.deepEqual(decideForceCharge({ ...s, forceChargeOnFailedAtMs: DUE, forceChargeOnFailedSlots: [...ours] }, DUE + MIN, opts), { kind: 'none' }, tag);
    }
  }
  // One slot of ours still in the pool: it is what a re-issue is sent to, and what verifies the ON.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [], poolOutSlots: [1, 3] })), { kind: 'onRetry', slots: [2] });
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [2], poolOutSlots: [1, 3] })), { kind: 'onVerified', atCeiling: [], outOfPool: [1, 3] });
  // The control of v1.186.0: every Core at the ceiling and none reading ON is a re-issue to all, never a verdict.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [], slotSocPct: { 1: 90, 2: 90, 3: 90 } })), { kind: 'onRetry', slots: [1, 2, 3] });
  // …and with one of them out of the pool as well, the re-issue leaves that one out, and the failure after it names all three.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [], slotSocPct: { 1: 90, 2: 90, 3: 90 }, poolOutSlots: [1] })), { kind: 'onRetry', slots: [2, 3] });
  assert.deepEqual(decideForceCharge(onNight(RETRIED), JUDGED, runOpts({ slotsOn: [], slotSocPct: { 1: 90, 2: 90, 3: 90 }, poolOutSlots: [1] })), { kind: 'onFailed', slots: [1, 2, 3] });
});

test('★★★ a slot at the panel\'s ceiling is NOT added back: with no slot reading ON a failure names the slots under the ceiling and the slots out of the pool, never the one the panel holds at its ceiling', () => {
  const retried = onNight(RETRIED);
  // Slot 2's Core reads the night's 90% ceiling; 1 and 3 are well under it. Nothing reads ON.
  const o = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => runOpts({ slotsOn: [], slotSocPct: { 1: 62, 2: 90, 3: 63 }, ...over });
  // The release before, no slot named: the re-issue and the failure are slots 1 and 3.
  assert.deepEqual(decideForceCharge(onNight(), DUE, o()), { kind: 'onRetry', slots: [1, 3] }, 'control');
  assert.deepEqual(decideForceCharge(retried, JUDGED, o()), { kind: 'onFailed', slots: [1, 3] }, '★ no slot named: slot 2 is in no failure');
  assert.deepEqual(failureOf(decideForceCharge(onNight(), WIN_END - 10 * MIN, o())), ['onFailed', [1, 3], true], 'nor in the forfeit');
  // A list that names no slot of ours, an empty one and null: the same.
  for (const poolOutSlots of [[], null, [4]] as Array<number[] | null>) {
    assert.deepEqual(decideForceCharge(retried, JUDGED, o({ poolOutSlots })), { kind: 'onFailed', slots: [1, 3] }, JSON.stringify(poolOutSlots));
  }
  // Slot 1 named out: the re-issue is slot 3 alone; the failure names slot 1 (out of the pool) and slot 3 — still not slot 2.
  assert.deepEqual(decideForceCharge(onNight(), DUE, o({ poolOutSlots: [1] })), { kind: 'onRetry', slots: [3] });
  assert.deepEqual(decideForceCharge(retried, JUDGED, o({ poolOutSlots: [1] })), { kind: 'onFailed', slots: [1, 3] }, '★ slot 1 named: slot 2 is still in no failure');
  assert.deepEqual(failureOf(decideForceCharge(onNight(), WIN_END - 10 * MIN, o({ poolOutSlots: [1] }))), ['onFailed', [1, 3], true]);
  // The slot at the ceiling is itself the one named: it is out of the pool, and named as that.
  assert.deepEqual(decideForceCharge(retried, JUDGED, o({ poolOutSlots: [2] })), { kind: 'onFailed', slots: [1, 2, 3] }, 'named out of the pool, it is in the whole failure whatever its Core reads');
  // With slot 3 reading ON the failure is slot 1's alone: neither the slot at the ceiling nor a slot out of the pool is in it.
  assert.deepEqual(decideForceCharge(retried, JUDGED, o({ slotsOn: [3] })), { kind: 'onFailed', slots: [1] });
  assert.deepEqual(decideForceCharge(retried, JUDGED, o({ slotsOn: [3], poolOutSlots: [2] })), { kind: 'onFailed', slots: [1] });
});

test('★★★ the OFF is untouched: it goes to every slot the ON was sent to, a slot out of the pool included, and is never delayed', () => {
  const o = runOpts({ slotsOn: [2, 3], connectedSlots: [2, 3], poolOutSlots: [1] });
  assert.deepEqual(decideForceCharge(onNight(), WIN_END, o), { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' });
  assert.deepEqual(decideForceCharge(onNight(), DUE, { ...o, poolSocPct: 90 }), { kind: 'off', slots: [1, 2, 3], reason: 'target' });
  assert.deepEqual(decideForceCharge(onNight(), DUE, { ...o, gridPresent: false }), { kind: 'off', slots: [1, 2, 3], reason: 'gridLoss' });
  assert.deepEqual(decideForceCharge(onNight(), DUE, { ...o, enabled: false }), { kind: 'off', slots: [1, 2, 3], reason: 'disabled' });
  // The OFF's own verify watches slot 1 too.
  const off = onNight({ forceChargeOffAtMs: WIN_END, forceChargeOffLastAttemptMs: WIN_END, forceChargeOffReason: 'windowEnd' });
  assert.deepEqual(decideForceCharge(off, WIN_END + MIN, { ...o, slotsOn: [] }), { kind: 'offVerified' });
  assert.equal(decideForceCharge(off, WIN_END + MIN, { ...o, slotsOn: [1] }).kind, 'none', 'slot 1 still reading ON is waited for, then re-sent: it is ours');
  // One shot: once verified, the ON is not judged again whatever the alarm names later.
  const verified = onNight({ forceChargeOnVerifiedAtMs: ON_AT + 3 * MIN });
  for (const poolOutSlots of [[], [1], [1, 2, 3]]) assert.deepEqual(decideForceCharge(verified, DUE + 30 * MIN, runOpts({ slotsOn: [], poolOutSlots })), { kind: 'none' });
  // A failure with every slot of ours out of the pool does not hold the OFF either.
  assert.deepEqual(decideForceCharge(onNight(), WIN_END, runOpts({ slotsOn: [], connectedSlots: [], poolOutSlots: [1, 2, 3] })), { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' });
});

/**
 * The pool exemption against the ceiling's, over 7 lists of ours × 8 readbacks × 8 lists out of the pool × 8 lists at
 * the ceiling × 5 stages (17,920 cases). Each case is decided twice: with the slots named out of the pool, and — the
 * release before — with those same slots read as at the panel's ceiling instead.
 *
 * SIDE A, a slot of ours reads ON: the two are the same verdict, to the letter (a verified one names each exempt
 * slot as what it is). A slot at the ceiling is treated as in the release before.
 * SIDE B, NO slot of ours reads ON and a slot of ours is named out — the one place they differ:
 *  - neither is ever verified, and each is 'none' where the other is;
 *  - a re-issue goes to the release-before's slots LESS the named ones (the same slots unless every slot of ours is
 *    exempt, where the release before re-issues to all of ours); with none left there is no re-issue, and the
 *    failure is declared in its place, naming every slot of ours, with no noRetry flag;
 *  - a failure names the release-before's slots PLUS the named ones, in the ON's order (its noRetry flag unchanged,
 *    and never set where every slot of ours is named).
 *
 * SIDE C, stated only in part (reported with this file): the ONLY slots of ours reading ON are themselves named out of
 * the pool, and the ceiling exemption's verdict on those readings is a verified one or a failure. Whether a slot out of
 * the pool reading ON shows that the ON took anywhere is the open question; what is stated of these cases is what
 * holds whichever way it is answered — never verified over a slot in the pool that reads OFF under the ceiling, and a
 * failure names every such slot. Where that verdict is 'none' or a re-issue, the case is on side A. (To state side C
 * as built: it is side A's comparison, to the letter.)
 */
test('★★★ EXHAUSTIVE: the pool exemption against the ceiling\'s — the same to the letter while a slot of ours reads ON; with none reading ON a re-issue leaves the named slots out and a failure names them too', () => {
  const stages: Array<[string, Partial<NightActuationState>, number]> = [
    ['inside the grace', {}, ON_AT + 3 * MIN], ['the re-issue due', {}, DUE], ['after the re-issue', RETRIED, JUDGED],
    ['past the re-issue cutoff', {}, WIN_END - 10 * MIN], ['after the warning', { ...RETRIED, forceChargeOnFailedAtMs: DUE + 20 * MIN }, DUE + 30 * MIN],
  ];
  let cases = 0;
  let sideA = 0;
  let sideB = 0;
  let sideC = 0;
  const kinds = new Set<string>();
  const differences = new Map<string, number>();
  const differ = (what: string): void => { differences.set(what, (differences.get(what) ?? 0) + 1); };
  for (const ours of SUBSETS.filter((s) => s.length > 0)) {
    for (const slotsOn of SUBSETS) {
      for (const outOfPool of SUBSETS) {
        for (const atCeiling of SUBSETS) {
          for (const [label, over, t] of stages) {
            cases++;
            const s = onNight({ forceChargeSlots: ours, ...over });
            const socs = (hot: number[]): Record<number, number> => Object.fromEntries([1, 2, 3].map((n) => [n, hot.includes(n) ? 95 : 60]));
            const a = decideForceCharge(s, t, runOpts({ slotsOn, slotSocPct: socs(atCeiling), poolOutSlots: outOfPool }));
            // The release before, with the named slots read as at the ceiling.
            const base = decideForceCharge(s, t, runOpts({ slotsOn, slotSocPct: socs([...atCeiling, ...outOfPool]) }));
            const tag = `${label}: ours ${JSON.stringify(ours)}, ON ${JSON.stringify(slotsOn)}, out of the pool ${JSON.stringify(outOfPool)}, at the ceiling ${JSON.stringify(atCeiling)} → ${JSON.stringify(a)} (as at the ceiling: ${JSON.stringify(base)})`;
            kinds.add(a.kind);
            const oursOn = ours.filter((n) => slotsOn.includes(n));
            const oursOff = ours.filter((n) => !slotsOn.includes(n));
            const named = ours.filter((n) => outOfPool.includes(n));

            /* What holds of every verdict. */
            if (a.kind === 'onVerified') {
              assert.equal(oursOn.length > 0, true, `★ verified with no slot of ours reading ON — ${tag}`);
              const out = a.outOfPool ?? [];
              assert.equal('outOfPool' in a, out.length > 0, `the key only when a slot is exempted — ${tag}`);
              assert.deepEqual(out, oursOff.filter((n) => outOfPool.includes(n)), `outOfPool — ${tag}`);
              assert.deepEqual(a.atCeiling, oursOff.filter((n) => !outOfPool.includes(n)), `atCeiling — ${tag}`);
              assert.equal(a.atCeiling.every((n) => atCeiling.includes(n)), true, `a slot listed at the ceiling is at it — ${tag}`);
            } else if (a.kind === 'onRetry') {
              assert.equal(a.slots.length > 0 && a.slots.every((n) => oursOff.includes(n)), true, `a re-issue goes to slots of ours reading OFF — ${tag}`);
              assert.equal(a.slots.some((n) => outOfPool.includes(n)), false, `★ a slot out of the pool re-issued — ${tag}`);
            } else if (a.kind === 'onFailed') {
              assert.equal(a.slots.length > 0 && a.slots.every((n) => oursOff.includes(n)), true, `a failure names slots of ours reading OFF — ${tag}`);
              assert.deepEqual(ours.filter((n) => a.slots.includes(n)), a.slots, `in the ON's own order — ${tag}`);
              if (oursOn.some((n) => !outOfPool.includes(n))) assert.equal(a.slots.some((n) => outOfPool.includes(n)), false, `a slot of ours in the pool reads ON: the exempt slot stays out of the failure — ${tag}`);
              // While a slot in the pool reads OFF under the ceiling, a slot at the ceiling is in no failure unless it is named out of the pool.
              if (oursOff.some((n) => !outOfPool.includes(n) && !atCeiling.includes(n))) {
                assert.equal(a.slots.some((n) => atCeiling.includes(n) && !outOfPool.includes(n)), false, `★ a slot at the ceiling added back to a failure — ${tag}`);
              }
            } else {
              assert.deepEqual(a, { kind: 'none' }, tag);
            }
            // Rule 1 inside the verify: a list that names no slot of ours changes nothing; nor does an empty or absent one.
            if (named.length === 0) {
              assert.deepEqual(a, decideForceCharge(s, t, runOpts({ slotsOn, slotSocPct: socs(atCeiling) })), `no slot of ours named: the release before — ${tag}`);
            }

            /* SIDE C: the only slots of ours reading ON are themselves named out of the pool, and the verdict — this one, or the
               ceiling exemption's on the same readings — is a verified one or a failure. */
            const judgedOnIt = (x: ForceChargeAction): boolean => x.kind === 'onVerified' || x.kind === 'onFailed';
            if (oursOn.length > 0 && oursOn.every((n) => outOfPool.includes(n)) && (judgedOnIt(a) || judgedOnIt(base))) {
              sideC++;
              const inPoolOffUnder = oursOff.filter((n) => !outOfPool.includes(n) && !atCeiling.includes(n));
              if (a.kind === 'onVerified') assert.deepEqual(inPoolOffUnder, [], `never verified over a slot in the pool that reads OFF under the ceiling — ${tag}`);
              if (a.kind === 'onFailed') assert.equal(inPoolOffUnder.every((n) => a.slots.includes(n)), true, `a failure names every slot in the pool that reads OFF under the ceiling — ${tag}`);
              continue;
            }

            if (oursOn.length > 0 || named.length === 0) {
              /* SIDE A: the same verdict as the ceiling exemption gives. */
              sideA++;
              if (base.kind === 'onVerified') {
                assert.equal(a.kind, 'onVerified', tag);
                if (a.kind === 'onVerified') assert.deepEqual([...a.atCeiling, ...(a.outOfPool ?? [])].sort(), [...base.atCeiling].sort(), `the same slots exempt, each under its own name — ${tag}`);
              } else {
                assert.deepEqual(a, base, `★ a slot of ours reads ON, or none is named: to the letter — ${tag}`);
              }
              continue;
            }

            /* SIDE B: no slot of ours reads ON, and a slot of ours is named out of the pool. */
            sideB++;
            assert.notEqual(a.kind, 'onVerified', `★ never verified with none reading ON — ${tag}`);
            assert.notEqual(base.kind, 'onVerified', tag);
            if (base.kind === 'onRetry') {
              const left = base.slots.filter((n) => !named.includes(n));
              // Nothing left to re-issue to: the failure in its place, every slot of ours, and no noRetry key at all.
              assert.deepEqual(a, left.length > 0 ? { kind: 'onRetry', slots: left } : { kind: 'onFailed', slots: ours }, `★ the re-issue, less the named slots — ${tag}`);
              if (left.length === 0) differ('a failure where the ceiling exemption re-issues (every slot of ours named)');
              else if (left.length < base.slots.length) differ('a re-issue that leaves the named slots out');
            } else if (base.kind === 'onFailed') {
              const left = base.slots.filter((n) => !named.includes(n));
              const slots = ours.filter((n) => left.includes(n) || named.includes(n));
              const want = { kind: 'onFailed', slots, ...(left.length > 0 && base.noRetry === true ? { noRetry: true } : {}) };
              assert.deepEqual(a, want, `★ the failure, with the named slots — ${tag}`);
              if (slots.length > base.slots.length) differ('a failure that names the named slots too');
              if (base.noRetry === true && left.length === 0) differ('no noRetry flag where every slot of ours is named');
              // With no slot of ours at the ceiling it is the WHOLE failure: every slot of ours.
              if (!ours.some((n) => atCeiling.includes(n) && !outOfPool.includes(n))) assert.deepEqual(a.kind === 'onFailed' ? a.slots : null, ours, `★ the whole failure — ${tag}`);
            } else {
              assert.deepEqual(a, { kind: 'none' }, `'none' where the ceiling exemption is — ${tag}`);
              assert.deepEqual(base, { kind: 'none' }, tag);
            }
            // The verdicts differ from the ceiling exemption's ONLY here, on side B.
            if (!isDeepStrictEqual(a, base)) differ('side B in all');
          }
        }
      }
    }
  }
  assert.equal(cases, 7 * 8 * 8 * 8 * 5);
  assert.deepEqual([...kinds].sort(), ['none', 'onFailed', 'onRetry', 'onVerified'], 'every verdict is reached');
  assert.equal(sideA + sideB + sideC, cases, 'every case is on one side');
  assert.ok(sideA > 0 && sideB > 0 && sideC > 0, `${sideA} cases on side A, ${sideB} on side B, ${sideC} on side C`);
  // Each difference is reached, and they are all the difference there is.
  for (const what of ['a re-issue that leaves the named slots out', 'a failure where the ceiling exemption re-issues (every slot of ours named)', 'a failure that names the named slots too', 'no noRetry flag where every slot of ours is named', 'side B in all']) {
    assert.ok((differences.get(what) ?? 0) > 0, `reached: ${what}`);
  }
});

/* ══ 6. the integrator (index.ts) ════════════════════════════════════════════════════════════════════ */

/** index.ts with its comment lines removed: a pin is on code, never on a sentence in a comment. */
const CODE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const section = (from: string, to: string): string => {
  const a = CODE.indexOf(from);
  assert.ok(a >= 0, `index.ts has ${from}`);
  const b = CODE.indexOf(to, a + from.length);
  assert.ok(b > a, `index.ts has ${to} after ${from}`);
  return CODE.slice(a, b);
};
const count = (text: string, needle: string): number => text.split(needle).length - 1;
const TICK = section('async function runForceChargeTick(', 'async function escalateForceChargeStuck(');
const PLANNER = section('async function recomputeNightChargePlan(', '\n}\n');
const SUMMARY = section('function sendRestoreSummary(', '\n}\n');
const branch = (kind: string): string => {
  const at = TICK.indexOf(`if (action.kind === '${kind}') {`);
  assert.ok(at > 0, `runForceChargeTick handles '${kind}'`);
  return TICK.slice(at, TICK.indexOf('\n  }\n', at));
};

test('★★★ index.ts: the tick reads the pool verdict of the panel it writes to, on its own clock, and hands the TARGETS on as connectedSlots', () => {
  const hw = "  const hwSlots = (sources ?? [])\n    .filter((c) => c?.hwConnect === true).map((c) => Number(c.slot)).filter(Number.isInteger);\n";
  const pool = '  const pool = forceChargePoolSlots(hwSlots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS), store.poolOutRead(shp2.sn), nowMs);\n';
  assert.ok(TICK.includes(hw), 'the hwConnect list, as v1.208.0 built connectedSlots');
  assert.ok(TICK.includes(pool), 'forceChargePoolSlots on that list (the slots of 1..3), store.poolOutRead(shp2.sn), nowMs');
  // The targets whenever a slot is left out. With none left out the list itself (rule 1 by construction), or the targets, which are then the same slots.
  const handed = /\n  const connectedSlots = (?:pool\.leftOut\.length > 0 \? pool\.targets : hwSlots|pool\.targets);\n/.exec(TICK);
  assert.ok(handed, 'connectedSlots is the targets');
  assert.equal(count(TICK, 'const connectedSlots = '), 1, 'declared once: every reader below takes the targets');
  assert.equal(/\bconnectedSlots = /.test(TICK.replace('const connectedSlots = ', '')), false, 'and never reassigned');
  // One read, of the panel the ON is written to, with the tick's clock.
  assert.equal(count(TICK, 'store.poolOutRead('), 1);
  assert.equal(count(TICK, 'forceChargePoolSlots('), 1);
  assert.ok(TICK.includes('  const nowMs = Date.now();\n') && TICK.includes('  const shp2 = findShp2(store.get().devices);\n'));
  assert.ok(TICK.includes("await setChannelForceCharge({ sn: shp2.sn, slot, on: true, source: { ua: 'night-force-charge' } })"), 'the ON is written to that same panel');
  // In order: the list, the verdict, the targets, the options, the decision.
  const order = [hw, pool, handed![0], '  const fcOpts: ForceChargeOpts = {\n', '  const action = decideForceCharge(state, nowMs, fcOpts);\n'].map((s) => TICK.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), order.join(' < '));
  // The whole file: the tick and the planner, no third reader.
  assert.equal(count(CODE, 'store.poolOutRead('), 2);
  assert.equal(count(CODE, 'forceChargePoolSlots('), 2);
});

test('★★★ index.ts: the rate takes rateCount; the decision is given leftOut as poolOutSlots after slotSocPct, and rateCount as rateSlotCount on the line after it', () => {
  assert.match(TICK, /  const chargeRateKw = forceChargeRateKw\(\{\n    gridCapKw, houseLoadKw, legEff: Math\.sqrt\(DISPATCH_ROUND_TRIP_EFFICIENCY\),\n    slotCount: pool\.rateCount,\n  \}\);\n/);
  assert.equal(TICK.includes('slotCount: connectedSlots'), false, 'no longer the connected count');
  const fcOpts = TICK.slice(TICK.indexOf('  const fcOpts: ForceChargeOpts = {\n'), TICK.indexOf('\n  };\n', TICK.indexOf('  const fcOpts: ForceChargeOpts = {\n')));
  assert.match(fcOpts, /\n    connectedSlots,\n    slotSocPct,[^\n]*\n    poolOutSlots: pool\.leftOut,[^\n]*\n    rateSlotCount: pool\.rateCount,[^\n]*\n    vitalsRed: /, '★ connectedSlots, slotSocPct, the slots left out, then the fallback rate\'s count');
  assert.equal(count(TICK, 'poolOutSlots:'), 1, 'passed once, to the decision that can start or re-issue an ON: the blind call, which only switches OFF, has none');
  assert.equal(count(TICK, 'rateSlotCount:'), 1, 'and the count with it, once');
  assert.equal(count(CODE, 'rateSlotCount'), 1, 'the tick is its one reader in the integrator: the live rate takes the same count as slotCount above');
  // The lines the mutation harnesses anchor around it are as they were.
  assert.ok(fcOpts.includes("    reservePct: typeof sp?.backupReserveSoc === 'number' ? sp.backupReserveSoc : null,\n    connectedSlots,\n"));
  assert.ok(fcOpts.includes('    chargeRateKw,\n    evDisplacedKwh,\n'));
});

test('★★★ index.ts: slotsOn and the per-slot percents are NOT filtered — every slot the panel lists, left out or not', () => {
  const statement = (head: string): string => { const at = TICK.indexOf(head); assert.ok(at > 0, head); return TICK.slice(at, TICK.indexOf(';\n', at) + 1); };
  const slotsOn = statement('const slotsOn = ');
  assert.equal(slotsOn, "const slotsOn = sources == null ? null\n    : sources.filter((c) => c?.forceCharge === 'FORCE_CHARGE_ON').map((c) => Number(c.slot)).filter(Number.isInteger);");
  const socs = statement('const slotSocPct');
  assert.equal(socs, "const slotSocPct: Record<number, number | null> | null = sources == null ? null\n    : Object.fromEntries(sources\n      .filter((c) => Number.isInteger(Number(c?.slot)))\n      .map((c) => [Number(c.slot), typeof c?.batteryPercentage === 'number' && Number.isFinite(c.batteryPercentage) ? c.batteryPercentage : null]));");
  for (const s of [slotsOn, socs]) for (const word of ['pool', 'leftOut', 'targets', 'hwSlots', 'hwConnect']) assert.equal(s.includes(word), false, `${word} in ${s.slice(0, 24)}…`);
  const fcOpts = TICK.slice(TICK.indexOf('  const fcOpts: ForceChargeOpts = {\n'), TICK.indexOf('\n  };\n', TICK.indexOf('  const fcOpts: ForceChargeOpts = {\n')));
  assert.ok(fcOpts.includes('\n    slotsOn,\n'), 'handed on as read');
  assert.equal(count(TICK, 'const slotsOn = '), 1);
  assert.equal(count(TICK, 'const slotSocPct'), 1);
});

test('★★★ index.ts: the slots left out are stamped in the SAME write-ahead persist as the ON, before any ON write, and nowhere else', () => {
  const on = branch('on');
  const persist = '    persistNightActuation({ ...nightActuationMem, ...onStamp, forceChargeLeftOutSlots: pool.leftOut.length > 0 ? [...pool.leftOut] : null });\n';
  const at = on.indexOf(persist);
  const write = on.indexOf("await setChannelForceCharge({ sn: shp2.sn, slot, on: true, source: { ua: 'night-force-charge' } })");
  assert.ok(at > 0 && write > at, 'one persist carries the ON and the slots left out, ahead of the first write');
  assert.equal(count(on, '...onStamp'), 1, 'the ON stamp is persisted once');
  assert.equal(count(on.slice(0, at), 'await '), 0, 'nothing is awaited between the decision and that persist');
  assert.equal(count(CODE, 'forceChargeLeftOutSlots:'), 1, 'written in one place: null with none, never an empty list, never carried by another handler');
  // Later persists of the tick spread the live record, so the field rides along.
  assert.ok(on.includes('    persistNightActuation({ ...nightActuationMem, forceChargeOnLastAttemptMs: Date.now() });\n'));
});

/** The once-a-night line as the fixes word it, and the guard, key and once-a-night memory around it (comment lines are stripped from CODE). */
const POOL_LINE = "          app.log.info(`night-charge: force-charge for ${state.day}: the pool alarm stands for this panel — its charge rate counts ${pool.rateCount} of the ${pool.rateCount + pool.outCount} connected Core(s)${pool.leftOut.length > 0 ? `, and an ON is not sent to slot(s) ${pool.leftOut.join(',')} (the alarm names their Core out of the backup pool)` : ''}.`);\n";
const POOL_SAID = "      if (pool.leftOut.length > 0 || pool.outCount > 0) {\n        const poolKey = `${pool.rateCount}|${pool.outCount}|${pool.leftOut.join(',')}`;\n        if (!forceChargeWhyLogged.reasons.has(poolKey)) {\n          forceChargeWhyLogged.reasons.add(poolKey);\n"
  + POOL_LINE + '        }\n      }\n';

test('★★★ index.ts: the once-a-night line states the rate\'s count of the connected Cores, and the slots an ON is not sent to — no count of Cores out, and no slot "named" that the alarm has not named', () => {
  const said = TICK.indexOf(POOL_SAID);
  assert.ok(said > 0, 'the reworded line, under the same guard, the same key and the same once-a-night memory');
  assert.ok(said > TICK.indexOf('    if (live && action.why) {\n') && said < TICK.indexOf("  if (action.kind === 'syncCeiling') {"), 'inside the declined-start block, before the ON');
  assert.equal(count(CODE, 'the pool alarm stands for this panel'), 1, 'said in one place');
  // ★ No count of Cores out: outCount appears only inside the sum that is the connected count, never as "names N Core(s)".
  assert.equal(POOL_LINE.includes('names ${'), false);
  assert.equal(count(POOL_LINE, 'pool.outCount'), 1);
  assert.ok(POOL_LINE.includes('of the ${pool.rateCount + pool.outCount} connected Core(s)'));
  assert.equal(/names \$\{/.test(TICK.slice(said, said + POOL_SAID.length)), false);
  assert.equal(TICK.includes('names ${pool.outCount}'), false, 'nowhere in the tick');
  assert.equal(/counts \$\{pool\.rateCount\} Core\(s\) for its rate/.test(TICK), false, 'the first wording is gone');
  // The alarm "names" only the slots left out, which it does name: that clause is inside the leftOut guard.
  assert.ok(POOL_LINE.includes("${pool.leftOut.length > 0 ? `, and an ON is not sent to slot(s) ${pool.leftOut.join(',')} (the alarm names their Core out of the backup pool)` : ''}"));
  assert.equal(count(POOL_LINE, 'names'), 1);
  // The words themselves, on compositions the tick reaches: the template pinned above (the source's own text), evaluated.
  const template = POOL_LINE.slice(POOL_LINE.indexOf('`') + 1, POOL_LINE.lastIndexOf('`'));
  const say = new Function('state', 'pool', `return \`${template}\`;`) as (state: { day: string }, pool: ForceChargePoolSlots) => string;
  const HEAD = 'night-charge: force-charge for 2026-11-20: the pool alarm stands for this panel — its charge rate counts ';
  const said1 = (pool: ForceChargePoolSlots): string => say({ day: '2026-11-20' }, pool);
  assert.equal(said1(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 1 }), NOW)), `${HEAD}2 of the 3 connected Core(s), and an ON is not sent to slot(s) 1 (the alarm names their Core out of the backup pool).`);
  assert.equal(said1(forceChargePoolSlots([1, 2, 3], read({ named: [1, 3], count: 2 }), NOW)), `${HEAD}1 of the 3 connected Core(s), and an ON is not sent to slot(s) 1,3 (the alarm names their Core out of the backup pool).`);
  assert.equal(said1(forceChargePoolSlots([1, 2, 3], read({ count: 1 }), NOW)), `${HEAD}2 of the 3 connected Core(s).`, 'a slot out and not identified: counted, and nothing is said to be named');
  assert.equal(said1(forceChargePoolSlots([1, 2, 3], read({ count: 3 }), NOW)), `${HEAD}1 of the 3 connected Core(s).`, 'the floor of one: no "3 Core(s) out" beside a rate that counts one');
  assert.equal(said1(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 1, contested: true }), NOW)), `${HEAD}2 of the 3 connected Core(s).`, 'a contested name: counted out, sent ON, and not said to be left out');
  assert.equal(said1(forceChargePoolSlots([1, 2, 3], read({ named: [1], count: 2 }), NOW)), `${HEAD}1 of the 3 connected Core(s), and an ON is not sent to slot(s) 1 (the alarm names their Core out of the backup pool).`, 'one named and one not: only the named slot is said to be named');
});

test('★★★ index.ts: the ON line names each count as what it is — the live rate\'s bound, and the fallback rate\'s own (fallbackSlots), which is what planRateFallbackKw is asked', () => {
  const on = branch('on');
  assert.ok(on.includes('    const slotsNow = connectedSlots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS).length;\n'), 'slotsNow, with its space back');
  assert.equal(count(CODE, 'const slotsNow ='), 1);
  assert.ok(on.includes(
    '    const fallbackSlots = pool.rateCount >= 1 ? Math.min(slotsNow, pool.rateCount) : slotsNow;\n'
    + '    const boundCores = pool.outCount > 0 ? `${pool.rateCount} Core(s) counted in the pool` : `${slotsNow} connected Core(s)`;\n'
    + '    const fallbackCores = pool.outCount > 0 ? `${fallbackSlots} Core(s) counted in the pool` : `${slotsNow} connected Core(s)`;\n'), '★ fallbackSlots, boundCores and fallbackCores, as written');
  // ★ The fallback rate is asked with the count the decision times it for, in both places — never with the ON's slot count.
  assert.equal(count(on, 'planRateFallbackKw(fallbackSlots)'), 2);
  assert.equal(count(CODE, 'planRateFallbackKw(slotsNow)'), 0);
  assert.equal(count(TICK, 'planRateFallbackKw('), 2, 'and nowhere else in the tick');
  assert.ok(on.includes('      : (planRateFallbackKw(fallbackSlots) === FORCE_CHARGE_PLAN_RATE_KW\n'));
  assert.ok(on.includes("        : `timed at the ${planRateFallbackKw(fallbackSlots)} kW fallback (${fallbackCores} × ${forceChargeKwPerCore()} kW; ${gridCapKw == null ? 'no grid-input cap configured' : 'no live house load'})`))\n"), 'the fallback clause names fallbackCores');
  assert.ok(on.includes('        ? `timed at ~${chargeRateKw.toFixed(1)} kW (bounded by ${boundCores} × ${forceChargeKwPerCore()} kW)`\n'), 'the live rate\'s clause names boundCores');
  assert.equal(count(on, '${boundCores}'), 1);
  assert.equal(count(on, '${fallbackCores}'), 1);
  // With nothing counted out both are the words of the release before, to the letter.
  assert.equal(count(on, ': `${slotsNow} connected Core(s)`;\n'), 2);
});

test('★★ index.ts: the logs name a slot left out as that, and never as "at the panel\'s ceiling"', () => {
  // The ON line: nothing added with no slot left out.
  const on = branch('on');
  assert.ok(on.includes("    const leftOutNote = pool.leftOut.length > 0 ? `; slot(s) ${pool.leftOut.join(',')} left out: the pool alarm names its Core out of the backup pool` : '';\n"));
  assert.equal(count(on, "${results.join(', ')}${leftOutNote};"), 2, 'both ON lines (the line night\'s and the cost night\'s) carry the clause after the per-slot results');
  // The verify's log.
  const v = branch('onVerified');
  assert.ok(v.includes('    const outOfPool = action.outOfPool ?? [];\n'));
  assert.ok(v.includes('    const on = (state.forceChargeSlots ?? []).filter((n) => !action.atCeiling.includes(n) && !outOfPool.includes(n));\n'), 'a slot out of the pool is not listed as reading ON');
  assert.ok(v.includes("${outOfPool.length > 0 ? `; slot(s) ${outOfPool.join(',')} out of the panel's backup pool (the pool alarm names it)` : ''}"));
  assert.ok(v.includes("${action.atCeiling.length > 0 ? `; slot(s) ${action.atCeiling.join(',')} already at the panel's ceiling (switched off by the panel itself)` : ''}"), 'the ceiling clause lists atCeiling only');
});

test('★★★ index.ts: the planner\'s charge cap takes the same count, from the same function, for the panel the plan is for', () => {
  assert.ok(PLANNER.includes("  const planHwSlots: number[] | null = Array.isArray(sp.sources)\n    ? sp.sources.filter((c: any) => c?.hwConnect === true && Number.isInteger(Number(c?.slot))).map((c: any) => Number(c.slot))\n    : null;\n"), 'the planner\'s own hwConnect list, unknown when the sources are');
  assert.ok(PLANNER.includes('  const planConnectedSlots = planHwSlots == null ? null : forceChargePoolSlots(planHwSlots, store.poolOutRead(shp2.sn), nowMs).rateCount;\n'), '★ rateCount: the tick\'s count');
  assert.ok(PLANNER.includes("  const chargeCapKw = planChargeCapKw(option<number>('ARB_CHARGE_CAP_KW'), planConnectedSlots, legEff);\n"), 'the cap line is as it was');
  assert.ok(PLANNER.includes('  const devs = store.get().devices;\n  const shp2 = findShp2(devs);\n'), 'the house panel of the plan');
  assert.equal(count(PLANNER, 'store.poolOutRead('), 1);
  assert.equal(/pool\.(targets|leftOut)|\.targets\b|\.leftOut\b/.test(PLANNER), false, 'the planner takes the count only: it sends nothing ON');
  // Read with the device map, before the function first awaits: the count belongs to the snapshot the plan is sized on.
  const firstAwait = PLANNER.search(/\bawait\b/);
  assert.ok(firstAwait > 0 && PLANNER.indexOf('store.poolOutRead(') < firstAwait, 'before the first await');
});

test('★★ index.ts: the morning summary is given the slots the ON was not sent to', () => {
  assert.match(SUMMARY, /cost: lineNight == null \? \{[^}]*\n\s+leftOutSlots: state\.forceChargeLeftOutSlots,[^}]*\} : null,/, 'from the record of the leg the summary is for');
});

/* ══ 7. the record: forceChargeLeftOutSlots ══════════════════════════════════════════════════════════ */

test('★★★ the record field: null by default, null on a record from before it, and never an empty list', () => {
  assert.equal(emptyActuationState().forceChargeLeftOutSlots, null);
  assert.equal('forceChargeLeftOutSlots' in emptyActuationState(), true, 'declared on the empty record');
  // A v1.208.0 record has no such key.
  const legacy = coerceActuationState({ day: '2026-11-20', forceChargeOnAtMs: ON_AT, forceChargeSlots: [1, 2, 3] });
  assert.equal(legacy.forceChargeLeftOutSlots, null);
  assert.deepEqual(legacy.forceChargeSlots, [1, 2, 3]);
  const lo = (v: unknown): number[] | null => coerceActuationState({ day: '2026-11-20', forceChargeOnAtMs: ON_AT, forceChargeSlots: [2, 3], forceChargeLeftOutSlots: v }).forceChargeLeftOutSlots;
  assert.deepEqual(lo([1]), [1]);
  assert.deepEqual(lo([1, 3]), [1, 3]);
  assert.deepEqual(lo([1, 2, 3]), [1, 2, 3]);
  // Garbage is dropped, never guessed.
  assert.deepEqual(lo([0, 2, 9, 'x', 3.5, null, -1, Number.NaN]), [2]);
  assert.deepEqual(lo([1, 2, 3, 4]), [1, 2, 3]);
  for (const none of [undefined, null, [], [0], [4], [1.5], ['1'], [null], [Number.NaN], [[1]], 'x', '1', 5, 1, true, {}, { 0: 1, length: 1 }]) {
    assert.equal(lo(none), null, `${JSON.stringify(none)}: null, never an empty list`);
  }
  // A malformed record is idle: nothing left out is fabricated.
  assert.equal(coerceActuationState({ forceChargeLeftOutSlots: [1] }).forceChargeLeftOutSlots, null);
  assert.equal(coerceActuationState(null).forceChargeLeftOutSlots, null);
});

/** A cost night whose ON went to slots 2 and 3 with slot 1 left out, fully resolved by the morning: OFF read back, reserve restored. */
const resolvedNight = (over: Partial<NightActuationState> = {}): NightActuationState => verifiedNight({
  forceChargeCeilingAttemptedAtMs: WIN_START + MIN, forceChargeCeilingPriorPct: 100,
  forceChargeOnAtMs: ON_AT, forceChargeSlots: [2, 3], forceChargeLeftOutSlots: [1], forceChargeOnVerifiedAtMs: ON_AT + 3 * MIN,
  forceChargeOffAtMs: WIN_END, forceChargeOffLastAttemptMs: WIN_END, forceChargeOffReason: 'windowEnd', forceChargeOffVerifiedAtMs: WIN_END + MIN,
  revertedAtMs: WIN_END + 5 * MIN, revertVerifiedAtMs: WIN_END + 6 * MIN,
  ...over,
});

test('★★★ the record field survives a restart, on the active leg and on a trailing one', () => {
  const n = resolvedNight();
  const back = coerceActuationState(JSON.parse(JSON.stringify(n)));
  assert.deepEqual(back.forceChargeLeftOutSlots, [1]);
  assert.deepEqual(back.forceChargeSlots, [2, 3], 'beside the slots the ON went to, and apart from them');
  assert.deepEqual(back, n, 'the whole record, field for field');
  const cycle = { active: asChargeLeg(n), pendingLegs: [], trailing: asChargeLeg({ ...n, day: '2026-11-19', forceChargeLeftOutSlots: [3], forceChargeSlots: [1, 2] }) };
  const file = coerceCycle(JSON.parse(JSON.stringify(serializeCycle(cycle))));
  assert.deepEqual([file.active.forceChargeLeftOutSlots, file.trailing?.forceChargeLeftOutSlots], [[1], [3]]);
  // The restarted record decides as the live one: slot 1 was never ours, and is never switched off or verified as ours.
  assert.deepEqual(decideForceCharge({ ...back, forceChargeOffAtMs: null, forceChargeOffLastAttemptMs: null, forceChargeOffReason: null, forceChargeOffVerifiedAtMs: null, revertedAtMs: null, revertVerifiedAtMs: null }, WIN_END, runOpts({ slotsOn: [2, 3] })),
    { kind: 'off', slots: [2, 3], reason: 'windowEnd' });
});

test('★★★ the record field is NOT carried to the next night: a new night starts with none left out', () => {
  const prev = resolvedNight();
  const ARM: ArmablePlan = { chargeTonight: true, basisComplete: true, buyKwh: 40, setpointSocPct: 50, costCeilingSocPct: 90, window: { startMs: WIN_START + 24 * H, endMs: WIN_END + 24 * H } };
  const next = armFromPlan(prev, '2026-11-21', ARM, WIN_END + 16 * H, 16, true);
  assert.ok(next, 'the next night arms over the resolved one');
  assert.equal(next!.forceChargeLeftOutSlots, null, '★ not last night\'s slot');
  assert.equal(next!.forceChargeSlots, null);
  assert.equal(next!.forceChargeCeilingPriorPct, 100, 'control: the one thing that IS carried, the unrestored ceiling original');
  // Through the charge cycle: the first leg, and a leg armed after it.
  const armed = armCycle({ ...emptyCycle(), active: asChargeLeg(prev) }, '2026-11-21', [
    { role: 'cost', kind: 'overnight', plan: ARM, forceChargeEnabled: true },
    { role: 'cost', kind: 'overnight', plan: { ...ARM, window: { startMs: WIN_START + 24 * H + MIN, endMs: WIN_END + 24 * H } }, forceChargeEnabled: true },
  ], WIN_END + 16 * H, 16);
  assert.deepEqual(armed.refused, []);
  assert.deepEqual(armed.legs.map((l) => l.forceChargeLeftOutSlots), [null, null]);
  // A pending leg promoted over a resolved leg that left a slot out: the ceiling original travels, the slot does not.
  const pending = asChargeLeg({ ...emptyActuationState(), day: '2026-11-20', targetPct: 50, buyKwh: 20, windowStartMs: WIN_END + 5 * H, windowEndMs: WIN_END + 10 * H });
  const step = promoteCycle({ active: asChargeLeg(prev), pendingLegs: [pending], trailing: null }, WIN_END + 10 * MIN, 16);
  assert.ok(step?.promoted, 'control: the resolved leg is promoted over');
  assert.equal(step!.cycle.active.forceChargeLeftOutSlots, null);
  assert.equal(step!.cycle.active.forceChargeCeilingPriorPct, 100, 'control');
  assert.equal(carryCeilingPrior(prev, emptyLegState()).forceChargeLeftOutSlots, null);
});
