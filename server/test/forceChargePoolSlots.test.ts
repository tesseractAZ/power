/**
 * v1.209.0 (part C) — only the Cores in the panel's backup pool are counted for the force-charge's rate and sent ON.
 *
 * On 2026-11-16 a Core was out of the panel's backup pool. The pool's capacity and percent were the two-Core figures,
 * the force-charge's rate counted three Cores, and the start came late. The pool alarm (poolOut.ts, v1.208.0) knows the
 * count of slots out and, after a dwell of naming readings, which slots. This release reads that latched verdict
 * (poolOutRead), turns it into the slots an ON may go to and the count the rate is timed with (forceChargePoolSlots),
 * and keeps a slot left out from the ON and from the ON's re-issue. Only a slot IN THE POOL that reads ON proves the ON
 * took: a slot the alarm names out proves nothing, whatever its Charge Now reads. A failure of the ON names such a slot
 * exactly when no slot in the pool reads ON: a failure shorter than the ON's own list is read everywhere as "it took on
 * the others".
 *
 * Two rules outrank everything else, and most of this file states them as properties over every input:
 *  1. UNKNOWN EQUALS THE RELEASE BEFORE. With no standing alarm for the panel (no tracker state, no episode, a read that
 *     throws) every list, count and decision is the one v1.208.0 makes.
 *  2. THE TWO USES FAIL SAFE IN OPPOSITE DIRECTIONS. For the RATE a doubtful slot is counted OUT (the start comes
 *     earlier). For the ON TARGETS a doubtful slot is sent ON (a withheld ON costs a Core its charge for the night): a
 *     slot is left out only when it is NAMED, nothing stands against the latch (no clear dwell, no fewer-short and no
 *     other-set streak, and the newest usable reading not showing every slot carrying its share), and the newest
 *     COUNTED reading of the standing alarm is recent.
 *
 * Sections: (1) poolOutRead — the six fields, and its agreement with the alarm's fault token and with pool_out_mask;
 * (1b) the store's contained reader; (2) forceChargePoolSlots over every input; (3) rule 1; (3b) the real tracker's
 * doubt, end to end (the fold, the read, the slots, the ON); (4) the start decision, the slots it takes out itself and
 * the count its fallback rate takes; (5) the ON verify — the proof it takes, the whole failure and every reader of it,
 * the push's sentence for a slot listed because it is out of the pool; (6) the integrator, as source pins on index.ts
 * (it is not reachable from a unit test), and the morning summary's clause for the slots the ON was not sent to;
 * (7) the record's field.
 *
 * NOT asserted here, and reported with this file instead of pinned:
 *  - whether a slot is left out while the newest counted reading shows the NAMED slot carrying its share and the flow as
 *    a whole is not "every slot carrying" (another slot too small to judge, or another slot at fault with the percent
 *    still pointing at the named one): such a reading is counted, keeps the data time young and is not a contest;
 *  - how long the doubt of a held contradiction lasts: it is the NEWEST reading's alone, and one counted reading whose
 *    flow cannot be judged (an idle pool, or a charging one — the named slot's own Core charging included) ends it and
 *    makes the verdict young again;
 *  - the proof the verify takes from a slot the alarm names on a verdict the ON may NOT act on (stale, contested or
 *    returning): the verify is handed only the slots left out, so such a slot reading ON counts as a slot in the pool;
 *  - a line night's re-ON readback check (lineReOnCheckDue): it has no pool rule, so a re-ON slot named out since the
 *    re-ON and reading ON counts as a slot that took it;
 *  - the head sentence of the ON-failure push and log ("still reads slot(s) … OFF") for a listed slot that reads ON: the
 *    added sentence says why the slot is listed, the head is as it was;
 *  - the read's `countAtMost` for a chain deeper than the eight streaks the read walks (the tracker builds at most three);
 *  - the punctuation and the exact wording of the morning summary's clause for a slot left out, and the order it lists
 *    slots in when the record's list is not ascending: what the clause names, where it stands and when it is absent are
 *    stated, the sentence itself is the cost night account's;
 *  - the fallback rate with FORCE_CHARGE_KW_PER_CORE unset (a fixed figure, whatever the count);
 *  - the count the line-at-risk gate and the declined-start push's clock take (the ON targets' count: a recorded limit);
 *  - the recorded limits of the release: a streak before its raise is not counted out of the rate, and a slot left out at
 *    the ON, or exempted at the verify, is not switched on later that night when its Core returns.
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

const { poolOutRead, poolOutTitle, poolOutAlertParts, emptyPoolOutState, POOL_OUT_SENSOR_FRESH_MS } = await import('../src/poolOut.js');
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
const { buildNightForceChargeOnFailure, buildNightChargeMorningSummary } = await import('../src/notify.js');
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
/** The tracker's HELD CONTRADICTION: the capacity one Core short while every slot, slot 1 included, carries its share
 *  (the healthy hour's watts and percents at the two-Core capacity). Class HOLD: judged, not counted. */
const holdBody = (seq: number): Body => fx.healthyBody(seq, { capWh: 2 * fx.SLOT_WH });
/** The capacity one Core short, the pool percent the mean of slots 2 and 3 (it points at slot 1), and every slot
 *  carrying its share of the load. Class STRONG: counted. The percent alone names no slot that is seen carrying. */
const pctNamesFlowCarries = (seq: number): Body =>
  fx.synthBody({ seq, capWh: 2 * fx.SLOT_WH, poolPct: 64, slots: [{ pct: 72, w: -799 }, { pct: 65, w: -699 }, { pct: 63, w: -670 }] });
/** The capacity one Core short and counted, the flow NOT judged as a whole: slot 1 at the reserve percent, so no share
 *  is expected of it (its flow is not judged), while slots 2 and 3 carry theirs. The percent points at slot 1. */
const flowPartNotJudged = (seq: number): Body =>
  fx.synthBody({ seq, capWh: 2 * fx.SLOT_WH, poolPct: 64, slots: [{ pct: 16, w: 0 }, { pct: 65, w: -1107 }, { pct: 63, w: -1061 }] });
/** The capacity one Core short and counted while slots 2 and 3 CHARGE: no flow is judged on a charging pool. */
const chargingLost = (seq: number): Body =>
  fx.synthBody({ seq, capWh: 2 * fx.SLOT_WH, poolPct: 64, slots: [{ pct: 72, w: 0 }, { pct: 65, w: 1500, inW: 1500 }, { pct: 63, w: 1500, inW: 1500 }] });
/** A capacity that cannot be judged (one pack short) while every slot carries its share. */
const capUnknownCarrying = (seq: number): Body => fx.healthyBody(seq, { capWh: fx.FULL_WH - 6144 });
/** Slot 1 named out, then thirty readings held as a contradiction. */
const HELD = fx.fold(EP, fx.minutes(11, 30, holdBody)).state;
/** Slot 1 named out, then three quiet readings at the full capacity: the clear dwell running, and no flow to judge. */
const CLEARING_QUIET = fx.fold(EP, fx.minutes(11, 3, fx.quietBody)).state;
/** Slot 1 named out; two readings naming slot 2 at the same count (episode.change, k 1); then ONE reading two slots
 *  short, which the tracker tallies UNDER that streak (episode.change.more, k 2). */
const UNDER = fx.fold(EP, [...fx.minutes(11, 2, slot2Out), ...fx.minutes(13, 1, twoOut)]).state;
/** The counts of the streaks standing against the latch, from episode.change down its `more` chain. */
const chainOf = (state: PoolOutState): number[] => {
  const ks: number[] = [];
  for (let st: PoolOutStreak | null | undefined = state.episode?.change, depth = 0; st != null && depth < 32; st = st.more, depth++) ks.push(st.k);
  return ks;
};

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
  // ★ No episode is no data time: the age a caller measures is the standing alarm's, and there is none. Not the newest
  // usable reading's time, and not the newest judged capacity's, both of which this healthy tracker holds.
  assert.deepEqual([REFERENCE.episode, REFERENCE.lastUsableMs, REFERENCE.lastCapMs, REFERENCE.last?.flow.v], [null, fx.at(-1), fx.at(-1), 'healthy'], 'control: a healthy pool, judged a minute ago, every slot carrying');
  assert.deepEqual(poolOutRead(REFERENCE), noAlarm(null), '★ a healthy pool: nothing, and no data time');
  // Five minutes of a Core out, every reading naming slot 1: a streak, not yet an alarm. Nothing is read from it.
  assert.deepEqual([STREAK.episode, STREAK.streak?.slots, STREAK.streak?.k, STREAK.lastCapMs], [null, [1], 1, fx.at(4)], 'control: the streak names slot 1');
  assert.deepEqual(poolOutRead(STREAK), noAlarm(null), '★ a streak before its raise names nothing, counts nothing, and has no data time');
  for (const quiet of [{ ...EP, episode: null }, { ...HELD, episode: null }, { ...EP, episode: undefined } as unknown as PoolOutState]) {
    assert.deepEqual(poolOutRead(quiet), noAlarm(null), 'a state with every field of a standing alarm but the episode');
  }
  // Every read has exactly the six fields, each one present (a caller tests two of them with `=== false`).
  for (const state of [null, undefined, emptyPoolOutState(), REFERENCE, STREAK, EP, UNNAMED, TWO, FLAP, LARGER, CLEARING, CLEARING_QUIET, LESS, OTHER, MORE, HELD, UNDER]) {
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

test('★★ returning: the clear dwell is running — and that alone; the names and the count stand through it, and the data time stays at the last counted reading', () => {
  // Three readings at the full capacity with no flow to judge (an idle pool): the clear dwell, and nothing else.
  assert.deepEqual([CLEARING_QUIET.episode?.clear != null, CLEARING_QUIET.last?.cap.v, CLEARING_QUIET.last?.flow.v, CLEARING_QUIET.lastCapMs], [true, 'healthy', 'unknown', fx.at(13)], 'control: three healthy readings started the clear');
  assert.deepEqual(poolOutRead(CLEARING_QUIET), verdict([1], 1, fx.at(10), { returning: true }), '★ the alarm still stands and still names slot 1; a healthy reading is not a counted one, and moves no data time');
  // Three healthy readings that also show every slot carrying its share: returning, and contested as well.
  assert.deepEqual([CLEARING.episode?.clear != null, CLEARING.last?.flow.v], [true, 'healthy'], 'control');
  assert.deepEqual(poolOutRead(CLEARING), verdict([1], 1, fx.at(10), { returning: true, contested: true }));
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
  for (const quiet of [null, emptyPoolOutState(), REFERENCE, STREAK, { ...MORE, episode: null }, { ...UNDER, episode: null }]) assert.equal(poolOutRead(quiet).countAtMost, 0);
});

test('★★★ countAtMost reads the CHAIN: a larger count tallied UNDER a same-count streak is the at-most; one later same-count reading does not lower it; a hostile chain neither raises it nor hangs the read', () => {
  // The real tracker: two readings name slot 2 at the latched count, then ONE reading is two slots short. The tracker
  // keeps the streak's count at the smallest its readings support (1) and tallies the larger count under it.
  assert.deepEqual([UNDER.episode?.k, UNDER.episode?.slots, UNDER.episode?.change?.k, UNDER.episode?.change?.slots, UNDER.episode?.change?.more?.k], [1, [1], 1, [2], 2], 'control: a streak at the latched count, a count of two under it');
  assert.deepEqual(chainOf(UNDER), [1, 2]);
  assert.deepEqual(poolOutRead(UNDER), verdict([1], 1, fx.at(13), { countAtMost: 2, contested: true }), '★ the count under the streak is the at-most: episode.change.k alone is 1');
  // ★ One more reading at the latched count: the larger count still stands under the streak, and still counts.
  const later = fx.fold(UNDER, fx.minutes(14, 1, slot2Out)).state;
  assert.deepEqual(chainOf(later), [1, 2], 'control: the chain is as it was');
  assert.deepEqual(poolOutRead(later), verdict([1], 1, fx.at(14), { countAtMost: 2, contested: true }), '★ one later same-count reading does not lower it');
  // The same with no slot named at all (raised on the capacity alone).
  const unnamedUnder = fx.fold(UNNAMED, [...fx.minutes(16, 2, slot2Out), ...fx.minutes(18, 1, twoOut), ...fx.minutes(19, 1, slot2Out)]).state;
  assert.deepEqual([unnamedUnder.episode?.slots, chainOf(unnamedUnder)], [null, [1, 2]], 'control');
  assert.deepEqual(poolOutRead(unnamedUnder), verdict([], 1, fx.at(19), { countAtMost: 2, contested: true }));

  // Every chain, built on the tracker's own streak: the at-most is the largest sound count anywhere in it, never under the latched one.
  const streak: PoolOutStreak = MORE.episode!.change!;
  const chained = (ks: unknown[]): PoolOutStreak | null =>
    ks.reduceRight<PoolOutStreak | null>((more, k) => ({ ...streak, k: k as number, more }), null);
  const withChain = (count: number, ks: unknown[]): PoolOutRead => poolOutRead(latched([1], count, { change: chained(ks) }));
  for (const count of [0, 1, 2, 3]) {
    for (const a of [0, 1, 2, 3]) {
      for (const b of [0, 1, 2, 3]) {
        for (const c of [0, 1, 2, 3]) {
          const r = withChain(count, [a, b, c]);
          assert.deepEqual([r.count, r.countAtMost, r.contested], [count, Math.max(count, a, b, c), true], `count ${count}, chain ${a} → ${b} → ${c}`);
        }
      }
    }
  }
  assert.equal(withChain(1, [1, 2]).countAtMost, 2, '★ a larger count UNDER a same-count streak');
  assert.equal(withChain(1, [1, 1, 3]).countAtMost, 3, 'and two streaks down');
  assert.equal(withChain(2, [1, 2, 1]).countAtMost, 2);
  // At every place of the eight streaks the read walks: the change streak itself, and seven chained under it.
  for (let place = 1; place <= 8; place++) {
    const ks = [...Array.from({ length: place - 1 }, () => 1), 3];
    assert.equal(withChain(1, ks).countAtMost, 3, `★ a count of three at place ${place} of the chain`);
  }
  // A k in the chain that is not a whole number of slots raises nothing, and does not hide a sound one under it.
  for (const bad of NOT_A_COUNT) {
    assert.equal(withChain(1, [bad]).countAtMost, 1, `chain ${String(bad)}`);
    assert.equal(withChain(1, [1, bad]).countAtMost, 1, `chain 1 → ${String(bad)}`);
    assert.equal(withChain(1, [bad, 2]).countAtMost, 2, `★ chain ${String(bad)} → 2: the sound count under it is read`);
    assert.equal(withChain(1, [1, bad, 3]).countAtMost, 3);
  }
  // A `more` that is absent (a state written before the field), and one that is not a streak at all.
  for (const none of [undefined, null]) assert.equal(poolOutRead(latched([1], 1, { change: { ...streak, k: 1, more: none } })).countAtMost, 1);
  for (const junk of ['x', 7, true, [], {}]) assert.equal(poolOutRead(latched([1], 1, { change: { ...streak, k: 1, more: junk } })).countAtMost, 1, `more ${JSON.stringify(junk)}`);
  // ★ A chain that loops on itself is read to its bound and no further: the read returns, with the counts it met.
  const loop = { ...streak, k: 1, more: null as PoolOutStreak | null };
  loop.more = loop;
  assert.deepEqual(poolOutRead(latched([1], 1, { change: loop })), verdict([1], 1, fx.at(10), { contested: true }), 'a streak chained to itself');
  const loop2 = { ...streak, k: 1, more: { ...streak, k: 2, more: null as PoolOutStreak | null } };
  loop2.more.more = loop2;
  assert.equal(poolOutRead(latched([1], 1, { change: loop2 })).countAtMost, 2);
  // The chain is read and left alone: a frozen state, the same read twice.
  const frozen = deepFreeze(structuredClone(UNDER));
  const was = JSON.stringify(frozen);
  assert.deepEqual(poolOutRead(frozen), poolOutRead(UNDER));
  assert.equal(JSON.stringify(frozen), was);
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
  for (const settled of [EP, UNNAMED, TWO, CLEARING_QUIET]) assert.equal(poolOutRead(settled).contested, false);
  // No episode: nothing to contest. A streak before its raise is not a contest; nor is a healthy pool whose every slot carries.
  for (const quiet of [null, undefined, emptyPoolOutState(), REFERENCE, STREAK, { ...LESS, episode: null }, { ...OTHER, episode: null }, { ...HELD, episode: null }]) {
    assert.equal(poolOutRead(quiet).contested, false);
  }
});

/** A state whose newest usable reading has the flow verdict `v` (every other field as the tracker left it). */
const withFlow = (state: PoolOutState, v: unknown): PoolOutState =>
  ({ ...state, last: { ...state.last!, flow: { ...state.last!.flow, v } } }) as unknown as PoolOutState;

test('★★★ contested, the third way: the NEWEST usable reading shows every slot carrying its share — doubt at once, with no streak and no dwell; a flow that is not judged is none', () => {
  assert.deepEqual([EP.last?.flow.v, EP.episode?.less, EP.episode?.change, EP.episode?.clear], ['fault', null, null, null], 'control: the alarm\'s own readings show slot 1 carrying nothing, and nothing stands against the latch');
  // The real tracker, one reading after the raise: the capacity still one Core short, every slot carrying (class HOLD).
  const one = fx.fold(EP, fx.minutes(11, 1, holdBody));
  assert.deepEqual([one.steps[0].skip, one.steps[0].signals?.cls, one.steps[0].signals?.cap.v, one.steps[0].signals?.flow.v], [null, 'HOLD', 'fault', 'healthy'], 'control: held as a contradiction, not counted');
  assert.deepEqual([one.state.episode?.less, one.state.episode?.change, one.state.episode?.clear], [null, null, null], 'control: no streak, no clear — the flow is all that stands against the latch');
  assert.deepEqual(poolOutRead(one.state), verdict([1], 1, fx.at(10), { contested: true }), '★ contested on the FIRST such reading');
  // Every latched shape, with the newest reading's flow verdict set: "every slot carrying" contests; a flow that could
  // not be judged at all (an idle pool, a charging one, a reading without the figures) does not. (What a flow that is
  // judged in part says of a named slot is not stated here: see the header.)
  for (const { slots, k, named } of SHAPES) {
    const tag = `slots ${JSON.stringify(slots)}, k ${k}`;
    assert.deepEqual(poolOutRead(withFlow(latched(slots, k), 'healthy')), verdict(named, k, fx.at(10), { contested: true }), `★ every slot carrying — ${tag}`);
    assert.deepEqual(poolOutRead(withFlow(latched(slots, k), 'unknown')), verdict(named, k, fx.at(10)), `a flow that is not judged is no contest — ${tag}`);
    // A newest reading that is missing, or holds no flow verdict, contests nothing (and breaks nothing).
    for (const last of [null, undefined, {}, { flow: null }, { flow: {} }, { flow: { v: true } }, { flow: { v: 'HEALTHY' } }]) {
      assert.deepEqual(poolOutRead({ ...latched(slots, k), last } as unknown as PoolOutState), verdict(named, k, fx.at(10)), `last ${JSON.stringify(last)} — ${tag}`);
    }
    // It is one flag with the two streaks: any of the three sets it, and the clear dwell is still the other flag.
    assert.deepEqual(poolOutRead(withFlow(latched(slots, k, { clear: CLEARING.episode!.clear }), 'healthy')), verdict(named, k, fx.at(10), { returning: true, contested: true }), tag);
    assert.deepEqual(poolOutRead(withFlow(latched(slots, k, { less: LESS.episode!.less }), 'fault')), verdict(named, k, fx.at(10), { contested: true }), tag);
  }
  // No episode: a healthy pool's every reading shows every slot carrying, and that is no contest of anything.
  assert.equal(poolOutRead(withFlow(REFERENCE, 'healthy')).contested, false);
  assert.equal(poolOutRead(withFlow({ ...EP, episode: null }, 'healthy')).contested, false);
  // The states the tracker reaches: held readings contest; so do healthy ones (the return dwell runs beside it).
  assert.deepEqual([HELD.last?.cls, HELD.last?.flow.v, HELD.episode?.less, HELD.episode?.change, HELD.episode?.clear], ['HOLD', 'healthy', null, null, null], 'control');
  assert.deepEqual(poolOutRead(HELD), verdict([1], 1, fx.at(10), { contested: true }), '★ thirty held readings: contested, and no younger');
  assert.equal(poolOutRead(CLEARING).contested, true);
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
});

test('★★★ asOfMs is episode.lastFault.atMs and nothing else: handed on when it is a finite number, null when it is not — and with no data time nothing is left out of an ON', () => {
  const withFault = (lastFault: unknown, over: Partial<PoolOutState> = {}): PoolOutState => ({ ...latched([1], 1, { lastFault }), ...over });
  const SENT = { targets: [1, 2, 3], leftOut: [], rateCount: 2, outCount: 1 };
  assert.deepEqual(EP.episode?.lastFault.atMs, fx.at(10), 'control: the newest counted reading of the standing alarm');
  assert.equal(poolOutRead(withFault({ atMs: 12345, pct: null, capWh: null })).asOfMs, 12345);
  assert.equal(poolOutRead(withFault({ atMs: 0, pct: null, capWh: null })).asOfMs, 0, 'a finite number is handed on as it stands');
  // ★ Neither the newest usable reading's time nor the newest judged capacity's is read: set to anything, or to nothing.
  assert.equal(poolOutRead(withFault({ atMs: 12345, pct: null, capWh: null }, { lastCapMs: 99999, lastUsableMs: 99999 })).asOfMs, 12345, '★ not lastCapMs, not lastUsableMs');
  assert.equal(poolOutRead({ ...EP, lastCapMs: null, lastUsableMs: null }).asOfMs, fx.at(10), '★ with neither on the state, the episode\'s own time');
  assert.equal(poolOutRead({ ...EP, lastCapMs: fx.at(40), lastUsableMs: fx.at(40) }).asOfMs, fx.at(10), '★ and both moved on: still the episode\'s own time');
  // The newest reading's own time (state.last.atMs) is not it either.
  assert.equal(poolOutRead({ ...EP, last: { ...EP.last!, atMs: fx.at(40) } }).asOfMs, fx.at(10));
  // ★ Hostile values: no data time. The names and the count stand; an ON leaves nothing out on them, at any clock; the rate still counts the slot out.
  const hostile: unknown[] = [
    undefined, null, {}, { atMs: null }, { atMs: undefined }, { atMs: Number.NaN }, { atMs: Number.POSITIVE_INFINITY }, { atMs: Number.NEGATIVE_INFINITY },
    { atMs: '12345' }, { atMs: String(fx.at(10)) }, { atMs: [fx.at(10)] }, { atMs: {} }, { atMs: true }, { atMs: new Date(fx.at(10)) }, 'x', fx.at(10), true, [],
  ];
  for (const lastFault of hostile) {
    const state = withFault(lastFault, { lastCapMs: fx.at(10), lastUsableMs: fx.at(10) });
    const r = poolOutRead(state);
    assert.deepEqual(r, verdict([1], 1, null), `lastFault ${JSON.stringify(lastFault)}: the alarm stands, with no data time`);
    for (const now of [fx.at(10), fx.at(10) + 1, fx.at(11), 0, 12345, Number.NaN]) {
      assert.deepEqual(forceChargePoolSlots([1, 2, 3], r, now), SENT, `★ nothing left out, the slot still counted out — lastFault ${JSON.stringify(lastFault)}, now ${now}`);
    }
  }
  // The control: the same state with its sound time leaves slot 1 out a minute later.
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(withFault(EP.episode!.lastFault)), fx.at(11)), { targets: [2, 3], leftOut: [1], rateCount: 2, outCount: 1 });
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

test('★★★ asOfMs is the DATA time of the newest COUNTED reading of the standing alarm: skipped bodies leave it, usable ones with no capacity verdict leave it, readings held as a contradiction leave it, healthy ones leave it', () => {
  // Thirty minutes of bodies from a panel the cloud lists offline, and thirty under the stale-shadow latch: none is an observation.
  for (const extra of [{ online: false }, { latched: true }]) {
    const blind = fx.fold(EP, fx.minutes(11, 30, fx.lostBody, extra)).state;
    assert.deepEqual(poolOutRead(blind), verdict([1], 1, fx.at(10)), JSON.stringify(extra));
  }
  // A COUNTED reading moves it: the capacity short, and a slot's percent or power at fault (STRONG) or no flow to judge (SLOW).
  for (const [label, make, cls] of [['slot 1 at no power', fx.lostBody, 'STRONG'], ['an idle pool', fx.quietLostBody, 'SLOW'], ['a charging pool', chargingLost, 'STRONG']] as const) {
    const f = fx.fold(EP, fx.minutes(11, 4, make));
    assert.deepEqual([...new Set(f.steps.map((s) => `${s.skip}/${s.signals?.cap.v}/${s.signals?.cls}`))], [`null/fault/${cls}`], `control — ${label}`);
    f.steps.forEach((step, i) => assert.deepEqual(poolOutRead(step.state), verdict([1], 1, fx.at(11 + i)), `★ each counted reading is the data time — ${label}, minute ${11 + i}`));
    assert.equal(f.state.episode?.lastFault.atMs, fx.at(14), 'the tracker\'s own record of it');
  }
  // ★ A HEALTHY capacity is judged and not counted: it starts the return, and leaves the data time where it was.
  assert.deepEqual([CLEARING.lastCapMs, CLEARING_QUIET.lastCapMs], [fx.at(13), fx.at(13)], 'control: three judged readings since the last counted one');
  assert.deepEqual([poolOutRead(CLEARING).asOfMs, poolOutRead(CLEARING_QUIET).asOfMs], [fx.at(10), fx.at(10)]);
  // ★ Thirty USABLE readings whose capacity cannot be judged: the newest usable reading moves on, the verdict's data time does not.
  for (const [label, make, cls] of [['percent and power still point at slot 1', capUnknownNaming, 'NOCAP'], ['nothing else to go by', capUnknownQuiet, 'HOLD']] as const) {
    const f = fx.fold(EP, fx.minutes(11, 30, make));
    assert.deepEqual([...new Set(f.steps.map((s) => `${s.skip}/${s.signals?.cap.v}/${s.signals?.cls}`))], [`null/unknown/${cls}`], `control: every body is used, and its capacity is not judged — ${label}`);
    assert.deepEqual([f.state.lastUsableMs, f.state.lastCapMs], [fx.at(40), fx.at(10)], `control — ${label}`);
    assert.deepEqual(poolOutRead(f.state), verdict([1], 1, fx.at(10)), `★ the alarm stands, names slot 1, and is no younger — ${label}`);
  }
  // ★ Thirty readings HELD AS A CONTRADICTION (the capacity one Core short while every slot, slot 1 included, carries
  // its share): each one is a judged capacity, so the newest judged capacity moves on with them — and none is counted,
  // so the verdict's data time stays where the last counted reading put it.
  const held = fx.fold(EP, fx.minutes(11, 30, holdBody));
  assert.deepEqual([...new Set(held.steps.map((s) => `${s.skip}/${s.signals?.cap.v}/${s.signals?.cap.k}/${s.signals?.flow.v}/${s.signals?.cls}`))], ['null/fault/1/healthy/HOLD'], 'control: every body is used, its capacity judged one slot short, and held');
  held.steps.forEach((step, i) => {
    assert.deepEqual([step.state.lastUsableMs, step.state.lastCapMs, step.state.episode?.lastFault.atMs], [fx.at(11 + i), fx.at(11 + i), fx.at(10)], `control, minute ${11 + i}: judged, not counted`);
    assert.equal(poolOutRead(step.state).asOfMs, fx.at(10), `★ minute ${11 + i}: no younger for a held reading`);
  });
  // No alarm: no data time, whatever the tracker has judged. (The pool-out sensor's freshness is another clock, and is not read here.)
  const quiet = fx.fold(REFERENCE, fx.minutes(0, 20, capUnknownQuiet)).state;
  assert.deepEqual([quiet.episode, quiet.lastUsableMs, quiet.lastCapMs], [null, fx.at(19), fx.at(-1)], 'control: no alarm, twenty usable readings with no capacity verdict');
  assert.deepEqual(poolOutRead(quiet), noAlarm(null));
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
    ['thirty readings held as a contradiction', HELD], ['a larger count under a same-count streak', UNDER], ['the clear running on an idle pool', CLEARING_QUIET],
    ['the percent pointing at slot 1 while every slot carries', fx.fold(EP, fx.minutes(11, 5, pctNamesFlowCarries)).state],
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
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), noAlarm(null), 'a healthy pool: no alarm, and no data time');
  for (let m = 0; m <= 9; m++) feed(m, fx.lostBody);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), noAlarm(null), 'ten minutes of a Core out: a streak, not yet an alarm');
  feed(10, fx.lostBody);
  const read = store.poolOutRead(fx.PANEL_SN);
  assert.deepEqual(read, verdict([1], 1, fx.at(10)), '★ slot 1 out, named after the dwell');
  assert.deepEqual(read, poolOutRead(store.poolRecord(fx.PANEL_SN).state), 'the pure reader over the state the recorder is given');
  read!.named.push(3);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN)!.named, [1], 'a copy each time');
  assert.deepEqual(store.poolOutRead('HD31XXX00XXX0002'), noAlarm(null), '★ another panel\'s serial: its own (empty) verdict, never this panel\'s');
  // Through the store too: bodies whose capacity cannot be judged do not keep the verdict young; a body held as a
  // contradiction does not either, and is doubt at once; a counted one moves the data time; one naming another slot
  // is counted and contests the names.
  for (let m = 11; m <= 13; m++) feed(m, capUnknownNaming);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), verdict([1], 1, fx.at(10)), '★ three bodies with no capacity verdict: the data time stays');
  feed(14, holdBody);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), verdict([1], 1, fx.at(10), { contested: true }), '★ one body with every slot carrying: contested at once, and no younger');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], store.poolOutRead(fx.PANEL_SN), fx.at(14)), { targets: [1, 2, 3], leftOut: [], rateCount: 2, outCount: 1 }, '★ slot 1 is sent ON on it, and still counted out of the rate');
  feed(15, fx.lostBody);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), verdict([1], 1, fx.at(15)), 'one counted body that shows slot 1 at no power: the verdict is young again, and uncontested');
  assert.deepEqual(forceChargePoolSlots([1, 2, 3], store.poolOutRead(fx.PANEL_SN), fx.at(15)), { targets: [2, 3], leftOut: [1], rateCount: 2, outCount: 1 });
  feed(16, slot2Out);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), verdict([1], 1, fx.at(16), { contested: true }), '★ a body that names slot 2: counted, and a contest');
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

test('★★★ (a) the capacity cannot be judged: the verdict\'s data time stays at the last COUNTED reading — slot 1 is left out up to 15 minutes after it, sent ON after that, and counted out of the rate throughout', () => {
  assert.deepEqual(tickOn(EP, fx.at(11)), { pool: SLOT_1_OUT, action: { kind: 'on', slots: [2, 3] } }, 'control: the alarm a minute old leaves slot 1 out');
  for (const [label, make] of [['percent and power still point at slot 1', capUnknownNaming], ['nothing else to go by', capUnknownQuiet]] as const) {
    const f = fx.fold(EP, fx.minutes(11, 45, make));
    assert.equal(f.steps.every((s) => s.skip == null && s.signals?.cap.v === 'unknown' && s.signals?.flow.v !== 'healthy'), true, `control: forty-five usable readings, none with a capacity verdict, none showing every slot carrying — ${label}`);
    assert.deepEqual([f.state.lastUsableMs, f.state.lastCapMs, f.state.episode?.lastFault.atMs], [fx.at(55), fx.at(10), fx.at(10)], `control — ${label}`);
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
    assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(f.state), fx.at(10) + FRESH), SLOT_1_OUT, `exactly fifteen minutes after the last counted reading: still left out — ${label}`);
    assert.deepEqual(forceChargePoolSlots([1, 2, 3], poolOutRead(f.state), fx.at(10) + FRESH + 1), SLOT_1_SENT, `★ one ms later: sent ON, and still counted out of the rate — ${label}`);
    // One counted reading (the capacity short, slot 1 at no power) makes the verdict young again.
    const counted = fx.fold(f.state, fx.minutes(56, 1, fx.lostBody)).state;
    assert.deepEqual(poolOutRead(counted), verdict([1], 1, fx.at(56)));
    assert.deepEqual(tickOn(counted, fx.at(57)).pool, SLOT_1_OUT, `a counted reading: left out again — ${label}`);
  }
  // The control: the same forty-five minutes of readings that ARE counted keep the verdict young, and slot 1 out.
  const short = fx.fold(EP, fx.minutes(11, 45, fx.lostBody)).state;
  assert.deepEqual(poolOutRead(short), verdict([1], 1, fx.at(55)));
  assert.deepEqual(tickOn(short, fx.at(56)), { pool: SLOT_1_OUT, action: { kind: 'on', slots: [2, 3] } });
});

test('★★★ (a2) the capacity reads short while EVERY slot, the named one included, carries its share (a held contradiction): doubt at once — slot 1 is sent ON on the FIRST such reading and on every one after, counted out of the rate throughout, and the verdict is no younger for any of them', () => {
  assert.deepEqual(tickOn(EP, fx.at(11)), { pool: SLOT_1_OUT, action: { kind: 'on', slots: [2, 3] } }, 'control: before the doubt, slot 1 is left out');
  const f = fx.fold(EP, fx.minutes(11, 45, holdBody));
  assert.deepEqual([...new Set(f.steps.map((s) => `${s.skip}/${s.signals?.cap.v}/${s.signals?.cap.k}/${s.signals?.pct.v}/${s.signals?.flow.v}/${s.signals?.cls}`))], ['null/fault/1/consistent/healthy/HOLD'], 'control: forty-five usable readings, the capacity one slot short, every slot carrying, each held and none counted');
  assert.equal(f.steps.every((s) => s.signals?.flow.slots.find((x) => x.slot === 1)?.v === 'healthy'), true, 'control: slot 1 itself is seen carrying its share on every one');
  const perCore = forceChargeKwPerCore();
  f.steps.forEach((step, i) => {
    const minute = 11 + i;
    // The newest judged capacity moves on with every reading; the newest counted one stays at minute 10; nothing runs a dwell against the latch.
    assert.deepEqual([step.state.lastCapMs, step.state.episode?.lastFault.atMs, step.state.episode?.less, step.state.episode?.change, step.state.episode?.clear], [fx.at(minute), fx.at(10), null, null, null], `control, minute ${minute}`);
    assert.deepEqual(poolOutRead(step.state), verdict([1], 1, fx.at(10), { contested: true }), `★ minute ${minute}: contested, the data time where the last counted reading put it`);
    const t = tickOn(step.state, fx.at(minute));
    assert.deepEqual(t, { pool: SLOT_1_SENT, action: { kind: 'on', slots: [1, 2, 3] } }, `★ minute ${minute}: slot 1 is sent ON, and still counted out of the rate`);
    assert.equal(forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 1, legEff: Math.sqrt(0.86), slotCount: t.pool.rateCount }), 2 * perCore, `minute ${minute}: the rate is two Cores'`);
  });
  // ★ The FIRST such reading, read at its own instant: one minute after a verdict the ON acted on.
  assert.deepEqual(tickOn(f.steps[0].state, fx.at(11)), { pool: SLOT_1_SENT, action: { kind: 'on', slots: [1, 2, 3] } }, '★ the first held reading');
  // ★ The age does not run from the newest JUDGED capacity. Twenty held readings, then one usable reading that shows
  // neither a capacity verdict nor a flow (an idle pool, a capacity that is not a whole slot short): the contest is over
  // with the reading that made it, the newest judged capacity is one minute old — and the newest COUNTED reading is
  // twenty-one minutes old, so nothing is left out.
  const then = fx.fold(fx.fold(EP, fx.minutes(11, 20, holdBody)).state, fx.minutes(31, 1, capUnknownQuiet));
  assert.deepEqual([then.steps[0].skip, then.steps[0].signals?.cap.v, then.steps[0].signals?.flow.v, then.state.lastCapMs, then.state.lastUsableMs], [null, 'unknown', 'unknown', fx.at(30), fx.at(31)], 'control');
  assert.deepEqual(poolOutRead(then.state), verdict([1], 1, fx.at(10)), 'uncontested again, and as old as its last counted reading');
  assert.deepEqual(tickOn(then.state, fx.at(31)), { pool: SLOT_1_SENT, action: { kind: 'on', slots: [1, 2, 3] } }, '★ twenty-one minutes after the last counted reading: sent ON, though a capacity was judged a minute ago');
  // Every slot carrying on a reading whose CAPACITY cannot be judged is the same doubt: contested, and no younger.
  const unjudged = fx.fold(EP, fx.minutes(11, 5, capUnknownCarrying));
  assert.equal(unjudged.steps.every((s) => s.skip == null && s.signals?.cap.v === 'unknown' && s.signals?.flow.v === 'healthy'), true, 'control');
  unjudged.steps.forEach((step, i) => {
    assert.deepEqual(poolOutRead(step.state), verdict([1], 1, fx.at(10), { contested: true }), `minute ${11 + i}`);
    assert.deepEqual(tickOn(step.state, fx.at(11 + i)).pool, SLOT_1_SENT, `★ minute ${11 + i}`);
  });
  // One counted reading that shows slot 1 at no power again: the verdict is young, uncontested, and the ON acts on it.
  const back = fx.fold(f.state, fx.minutes(56, 1, fx.lostBody)).state;
  assert.deepEqual(poolOutRead(back), verdict([1], 1, fx.at(56)));
  assert.deepEqual(tickOn(back, fx.at(57)), { pool: SLOT_1_OUT, action: { kind: 'on', slots: [2, 3] } });
});

test('★★★ (a3) the percent points at the named slot while the flow shows every slot carrying: a COUNTED reading, so the data time moves with it — and contested all the same, so slot 1 is sent ON', () => {
  const f = fx.fold(EP, fx.minutes(11, 20, pctNamesFlowCarries));
  assert.deepEqual([...new Set(f.steps.map((s) => `${s.skip}/${s.signals?.cap.v}/${s.signals?.cap.k}/${s.signals?.pct.v}/${JSON.stringify(s.signals?.pct.set)}/${s.signals?.flow.v}/${s.signals?.cls}/${JSON.stringify(s.signals?.named)}`))],
    ['null/fault/1/fault/[1]/healthy/STRONG/null'], 'control: twenty counted readings, the percent pointing at slot 1, every slot carrying, and so no slot named by any of them');
  f.steps.forEach((step, i) => {
    const minute = 11 + i;
    // Counted at the latched count with no name: nothing runs a dwell against the latch. The flow is all the doubt there is.
    assert.deepEqual([step.state.episode?.lastFault.atMs, step.state.episode?.slots, step.state.episode?.less, step.state.episode?.change, step.state.episode?.clear], [fx.at(minute), [1], null, null, null], `control, minute ${minute}`);
    assert.deepEqual(poolOutRead(step.state), verdict([1], 1, fx.at(minute), { contested: true }), `★ minute ${minute}: as young as the reading, and contested`);
    assert.deepEqual(tickOn(step.state, fx.at(minute)), { pool: SLOT_1_SENT, action: { kind: 'on', slots: [1, 2, 3] } }, `★ minute ${minute}: slot 1 is sent ON on a verdict a moment old, and still counted out of the rate`);
  });
});

test('★★★ (a4) a counted reading whose flow CANNOT BE JUDGED does not contest: an idle pool, a charging one, a named slot with no share expected of it — slot 1 stays left out, on a verdict as young as the reading', () => {
  const kinds: Array<[string, (seq: number) => Body, string]> = [
    ['an idle pool', fx.quietLostBody, 'null/fault/SLOW/unknown/idle'],
    ['a charging pool', chargingLost, 'null/fault/STRONG/unknown/charging'],
    ['no share expected of slot 1', flowPartNotJudged, 'null/fault/STRONG/partial/null'],
  ];
  for (const [label, make, shape] of kinds) {
    const f = fx.fold(EP, fx.minutes(11, 20, make));
    assert.deepEqual([...new Set(f.steps.map((s) => `${s.skip}/${s.signals?.cap.v}/${s.signals?.cls}/${s.signals?.flow.v}/${s.signals?.flow.reason}`))], [shape], `control — ${label}`);
    assert.equal(f.steps.some((s) => s.signals?.flow.slots.some((x) => x.slot === 1 && x.v === 'healthy')), false, `control: no reading shows slot 1 carrying — ${label}`);
    f.steps.forEach((step, i) => {
      const minute = 11 + i;
      assert.deepEqual(poolOutRead(step.state), verdict([1], 1, fx.at(minute)), `minute ${minute}: counted, and no contest — ${label}`);
      assert.deepEqual(tickOn(step.state, fx.at(minute)), { pool: SLOT_1_OUT, action: { kind: 'on', slots: [2, 3] } }, `minute ${minute}: slot 1 stays left out — ${label}`);
    });
  }
});

test('★★★ (a5) a larger count tallied UNDER a same-count streak is counted out of the rate from the reading that showed it, and the same-count readings after it do not put it back', () => {
  const perCore = forceChargeKwPerCore();
  const rateOf = (rateCount: number): number => forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 1, legEff: Math.sqrt(0.86), slotCount: rateCount })!;
  // Slot 1 latched. Minutes 11 and 12 name slot 2 at the same count; minute 13 is two slots short; minutes 14 to 18 name slot 2 again.
  const f = fx.fold(EP, [...fx.minutes(11, 2, slot2Out), ...fx.minutes(13, 1, twoOut), ...fx.minutes(14, 5, slot2Out)]);
  f.steps.forEach((step, i) => {
    const minute = 11 + i;
    const under = minute >= 13;
    assert.deepEqual([step.state.episode?.k, step.state.episode?.slots, chainOf(step.state)], [1, [1], under ? [1, 2] : [1]], `control, minute ${minute}: the latch stands, the streak against it is at its count${under ? ', a count of two under it' : ''}`);
    assert.deepEqual(poolOutRead(step.state), verdict([1], 1, fx.at(minute), { countAtMost: under ? 2 : 1, contested: true }), `★ minute ${minute}: the read`);
    const t = tickOn(step.state, fx.at(minute));
    assert.deepEqual(t.pool, { targets: [1, 2, 3], leftOut: [], rateCount: under ? 1 : 2, outCount: under ? 2 : 1 }, `★ minute ${minute}: ${under ? 'two' : 'one'} counted out of the rate, nothing left out of the ON`);
    assert.equal(rateOf(t.pool.rateCount), under ? perCore : 2 * perCore, `★ minute ${minute}: the rate`);
    assert.deepEqual(t.action, { kind: 'on', slots: [1, 2, 3] });
  });
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

/* ══ 5. the ON verify: a slot of ours named out after the ON, and what proves that the ON took ═══════ */

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

test('★★★ the verified verdict\'s lists: outOfPool holds EVERY slot of ours out of the pool, reading ON or OFF; atCeiling never holds one; the key is ABSENT with none — the old shape for every reading that names no slot of ours', () => {
  // ★ Named out, and reading ON beside the two in the pool: listed all the same. What a slot out of the pool reads is no part of the verdict.
  const on = decideForceCharge(onNight(), DUE, runOpts({ poolOutSlots: [1] }));
  assert.deepEqual(on, { kind: 'onVerified', atCeiling: [], outOfPool: [1] }, '★ every slot reads ON, slot 1 named out: it is listed');
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [2, 3], poolOutSlots: [1] })), on, 'the same verdict with slot 1 reading OFF');
  // Two named, one reading ON and one OFF: both listed, in the ON's own order.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [1, 2], poolOutSlots: [1, 3] })), { kind: 'onVerified', atCeiling: [], outOfPool: [1, 3] });
  assert.deepEqual(decideForceCharge(onNight({ forceChargeSlots: [3, 1, 2] }), DUE, runOpts({ slotsOn: [1, 2], poolOutSlots: [1, 3] })), { kind: 'onVerified', atCeiling: [], outOfPool: [3, 1] }, 'the order of the ON\'s list');
  // ★ atCeiling: the slots IN the pool that read OFF (each at the ceiling). A slot out of the pool is never in it —
  // reading OFF with its Core at the ceiling percent, or reading ON.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [3], poolOutSlots: [1], slotSocPct: { 1: 99, 2: 90, 3: 63 } })), { kind: 'onVerified', atCeiling: [2], outOfPool: [1] });
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [1, 3], poolOutSlots: [1], slotSocPct: { 1: 99, 2: 90, 3: 63 } })), { kind: 'onVerified', atCeiling: [2], outOfPool: [1] });
  // Every verified verdict of the grid: ours × the readback × the slots out of the pool × the slots at the ceiling.
  let verified = 0;
  for (const ours of SUBSETS.filter((s) => s.length > 0)) {
    for (const slotsOn of SUBSETS) {
      for (const out of SUBSETS) {
        for (const hot of SUBSETS) {
          const a = decideForceCharge(onNight({ forceChargeSlots: ours }), DUE, runOpts({ slotsOn, poolOutSlots: out, slotSocPct: Object.fromEntries([1, 2, 3].map((n) => [n, hot.includes(n) ? 95 : 60])) }));
          if (a.kind !== 'onVerified') continue;
          verified++;
          const tag = `ours ${JSON.stringify(ours)}, ON ${JSON.stringify(slotsOn)}, out of the pool ${JSON.stringify(out)}, at the ceiling ${JSON.stringify(hot)} → ${JSON.stringify(a)}`;
          const named = ours.filter((n) => out.includes(n));
          assert.deepEqual(a.outOfPool ?? [], named, `★ outOfPool is every slot of ours out of the pool — ${tag}`);
          assert.equal('outOfPool' in a, named.length > 0, `★ the key only with one — ${tag}`);
          assert.equal(a.atCeiling.some((n) => out.includes(n)), false, `★ atCeiling holds no slot out of the pool — ${tag}`);
          assert.deepEqual(a.atCeiling, ours.filter((n) => !slotsOn.includes(n) && !out.includes(n)), `atCeiling is the slots in the pool reading OFF — ${tag}`);
          assert.equal(a.atCeiling.every((n) => hot.includes(n)), true, `and each is at the ceiling — ${tag}`);
          assert.equal(ours.some((n) => slotsOn.includes(n) && !out.includes(n)), true, `★ a slot of ours IN THE POOL reads ON — ${tag}`);
        }
      }
    }
  }
  assert.ok(verified > 0);
  // The key is absent with no slot of ours out of the pool. Named out, and not ours:
  const notOurs = decideForceCharge(onNight({ forceChargeSlots: [2, 3] }), DUE, runOpts({ slotsOn: [2, 3], connectedSlots: [2, 3], poolOutSlots: [1] }));
  assert.deepEqual(notOurs, { kind: 'onVerified', atCeiling: [] });
  assert.equal('outOfPool' in notOurs, false);
  // The ceiling exemption alone keeps its shape; and an empty list, null, none, and a list of slots that are not ours.
  for (const poolOutSlots of [[], null, undefined, [4], [0], [7, 9]] as Array<number[] | null | undefined>) {
    const ceiling = decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [1, 3], slotSocPct: { 1: 70, 2: 90, 3: 71 }, ...(poolOutSlots === undefined ? {} : { poolOutSlots }) }));
    assert.deepEqual(ceiling, { kind: 'onVerified', atCeiling: [2] }, JSON.stringify(poolOutSlots));
    assert.equal('outOfPool' in ceiling, false, JSON.stringify(poolOutSlots));
  }
});

const RETRIED = { forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: DUE };
/** The tick on which the re-issue has had its grace: the failure verdict, if the ON still has not taken. */
const JUDGED = DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS;
/** A record with a failure verdict on it: its time, and its slots. */
const withFailureAt = (s: NightActuationState, atMs: number, slots: number[]): NightActuationState =>
  ({ ...s, forceChargeOnFailedAtMs: atMs, forceChargeOnFailedSlots: [...slots] });

test('★★★ only a slot IN THE POOL reading ON proves the ON took — the four examples, word for word on the action', () => {
  const retried = onNight(RETRIED);
  /* 1. The ON went to 1, 2 and 3. The one re-issue is spent and has had its grace. Slot 1 reads ON, and the alarm names
        slot 1 out of the pool: the ON took on no Core that can take a charge. The WHOLE failure. */
  const one = decideForceCharge(retried, JUDGED, runOpts({ slotsOn: [1], poolOutSlots: [1] }));
  assert.deepEqual(one, { kind: 'onFailed', slots: [1, 2, 3] }, '★ example 1: every slot of ours, the one reading ON too');
  assert.equal('noRetry' in one, false);
  assert.deepEqual(decideForceCharge(retried, JUDGED, runOpts({ slotsOn: [1] })), { kind: 'onFailed', slots: [2, 3] }, 'control: with no slot named, slot 1 reading ON makes it a failure of slots 2 and 3');
  assert.equal(partialForceChargeOnFailureSlots({ forceChargeSlots: [1, 2, 3], forceChargeOnFailedSlots: one.kind === 'onFailed' ? one.slots : null }), null, '★ and no reader takes it as "the ON took on the others"');

  /* 2. Slot 1 reads ON and is named out; slots 2 and 3 read OFF with their Cores at the panel's ceiling. Not verified:
        a re-issue to slots 2 and 3, then the whole failure. */
  const hot = { slotsOn: [1], slotSocPct: { 1: 62, 2: 90, 3: 95 } };
  assert.deepEqual(decideForceCharge(onNight(), ON_AT + 3 * MIN, runOpts(hot)), { kind: 'onVerified', atCeiling: [2, 3] }, 'control: with no slot named, slot 1 reading ON beside two at the ceiling is a verified ON');
  assert.deepEqual(decideForceCharge(onNight(), ON_AT + 3 * MIN, runOpts({ ...hot, poolOutSlots: [1] })), { kind: 'none' }, '★ example 2, inside the grace: NOT verified');
  assert.deepEqual(decideForceCharge(onNight(), DUE - 1, runOpts({ ...hot, poolOutSlots: [1] })), { kind: 'none' });
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ ...hot, poolOutSlots: [1] })), { kind: 'onRetry', slots: [2, 3] }, '★ example 2, the grace over: a re-issue to slots 2 and 3');
  assert.deepEqual(decideForceCharge(retried, JUDGED, runOpts({ ...hot, poolOutSlots: [1] })), { kind: 'onFailed', slots: [1, 2, 3] }, '★ example 2, after the re-issue: the whole failure');
  for (let t = ON_AT; t < WIN_END; t += MIN) {
    for (const s of [onNight(), retried, withFailureAt(retried, JUDGED, [1, 2, 3])]) {
      assert.notEqual(decideForceCharge(s, t, runOpts({ ...hot, poolOutSlots: [1] })).kind, 'onVerified', `★ never verified on a slot out of the pool, minute ${(t - ON_AT) / MIN}`);
    }
  }

  /* 3. Slot 1 reads ON; all three are named out. Nothing a re-issue may be sent to, and nothing that proves the ON:
        after the grace the failure, every slot of ours, with no noRetry flag. */
  const all = runOpts({ slotsOn: [1], poolOutSlots: [1, 2, 3] });
  assert.deepEqual(decideForceCharge(onNight(), DUE - 1, all), { kind: 'none' }, 'example 3, inside the grace');
  const three = decideForceCharge(onNight(), DUE, all);
  assert.deepEqual(three, { kind: 'onFailed', slots: [1, 2, 3] }, '★ example 3: after the grace, the failure');
  assert.equal('noRetry' in three, false, '★ with no noRetry flag');
  const threeLate = decideForceCharge(onNight(), WIN_END - 10 * MIN, all);
  assert.deepEqual(threeLate, { kind: 'onFailed', slots: [1, 2, 3] });
  assert.equal('noRetry' in threeLate, false, 'inside the re-issue cutoff too: no re-issue was ever due');
  for (let t = ON_AT; t < WIN_END; t += MIN) {
    const kind = decideForceCharge(onNight(), t, all).kind;
    assert.equal(kind === 'none' || kind === 'onFailed', true, `never verified, never a re-issue — minute ${(t - ON_AT) / MIN}: ${kind}`);
  }

  /* 4. Slot 2 reads ON and is in the pool; slots 1 and 3 are named out. Verified on slot 2. */
  const four = decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [2], poolOutSlots: [1, 3] }));
  assert.deepEqual(four, { kind: 'onVerified', atCeiling: [], outOfPool: [1, 3] }, '★ example 4');
  assert.deepEqual(decideForceCharge(onNight(), ON_AT + 3 * MIN, runOpts({ slotsOn: [2], poolOutSlots: [1, 3] })), four, 'with no grace: a slot in the pool reading ON is proof');
  // …and whatever the two named slots read, it is that verdict.
  for (const slotsOn of [[2], [1, 2], [2, 3], [1, 2, 3]]) assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn, poolOutSlots: [1, 3] })), four, `ON ${JSON.stringify(slotsOn)}`);
  // With slot 2 OFF, no reading of slots 1 and 3 verifies it.
  for (const slotsOn of [[], [1], [3], [1, 3]]) assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn, poolOutSlots: [1, 3] })), { kind: 'onRetry', slots: [2] }, `ON ${JSON.stringify(slotsOn)}`);
});

test('★★★ end to end, on a verdict the ON acts on: the real tracker names slot 1 after the ON; the tick hands it on as left out; slot 1 reading ON beside two Cores at the ceiling is NOT a verified ON, and beside two slots reading OFF the failure is whole', () => {
  // The ON went to all three at minute -20, before the alarm; the alarm rose at minute 10 and names slot 1.
  const fxOn: NightActuationState = { ...FX_NIGHT, forceChargeCeilingAttemptedAtMs: fx.T0 - H + MIN, forceChargeCeilingPriorPct: 100, forceChargeOnAtMs: fx.at(-20), forceChargeSlots: [1, 2, 3] };
  const c = tickCompose([1, 2, 3], poolOutRead(EP), fx.at(11));
  assert.deepEqual([c.connectedSlots, c.poolOutSlots, c.rateSlotCount], [[2, 3], [1], 2], 'control: a verdict a minute old, uncontested — slot 1 is left out');
  const o = (over: Partial<ForceChargeOpts>): ForceChargeOpts => runOpts({ connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots, rateSlotCount: c.rateSlotCount, ...over });
  const atCeiling = { 1: 62, 2: 90, 3: 95 };
  // Slot 1 reads ON; slots 2 and 3 read OFF with their Cores at the panel's ceiling.
  assert.deepEqual(decideForceCharge(fxOn, fx.at(11), runOpts({ slotsOn: [1], slotSocPct: atCeiling })), { kind: 'onVerified', atCeiling: [2, 3] }, 'control: with no alarm the same readings are a verified ON');
  assert.deepEqual(decideForceCharge(fxOn, fx.at(11), o({ slotsOn: [1], slotSocPct: atCeiling })), { kind: 'onRetry', slots: [2, 3] }, '★ not verified: the one slot reading ON is out of the pool');
  const retried: NightActuationState = { ...fxOn, forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: fx.at(-5) };
  assert.deepEqual(decideForceCharge(retried, fx.at(11), o({ slotsOn: [1], slotSocPct: atCeiling })), { kind: 'onFailed', slots: [1, 2, 3] }, '★ and after the re-issue, the whole failure');
  // Slot 1 reads ON; slots 2 and 3 read OFF under the ceiling.
  assert.deepEqual(decideForceCharge(retried, fx.at(11), o({ slotsOn: [1] })), { kind: 'onFailed', slots: [1, 2, 3] }, '★ the whole failure, not a failure of slots 2 and 3');
  assert.deepEqual(decideForceCharge(retried, fx.at(11), runOpts({ slotsOn: [1] })), { kind: 'onFailed', slots: [2, 3] }, 'control: with no alarm');
  // Slots 2 and 3 read ON: verified on them, slot 1 listed as out of the pool whatever it reads.
  for (const slotsOn of [[2, 3], [1, 2, 3]]) assert.deepEqual(decideForceCharge(fxOn, fx.at(11), o({ slotsOn })), { kind: 'onVerified', atCeiling: [], outOfPool: [1] }, `ON ${JSON.stringify(slotsOn)}`);
});

test('★★★ a slot out of the pool is in no RE-ISSUE; a failure names it exactly when NO slot of ours IN THE POOL reads ON — whatever the slot itself reads', () => {
  const o = (slotsOn: number[]): ForceChargeOpts => runOpts({ slotsOn, poolOutSlots: [1] });
  const retried = onNight(RETRIED);
  // ★ The named slot ITSELF reads ON, and no slot in the pool does: it proves nothing. The re-issue and the failure are
  // those of the same night with slot 1 reading OFF (below), to the letter.
  assert.deepEqual(decideForceCharge(onNight(), DUE - 1, o([1])), { kind: 'none' }, 'inside the grace');
  assert.deepEqual(decideForceCharge(onNight(), DUE, o([1])), { kind: 'onRetry', slots: [2, 3] }, '★ the re-issue: slots 2 and 3, never slot 1');
  assert.deepEqual(failureOf(decideForceCharge(retried, JUDGED, o([1]))), ['onFailed', [1, 2, 3], false], '★ the WHOLE failure: slot 1 reading ON did not make it a failure of the others only');
  assert.deepEqual(failureOf(decideForceCharge(onNight(), WIN_END - 10 * MIN, o([1]))), ['onFailed', [1, 2, 3], true], '★ whole in the forfeit too');
  for (const [s, t] of [[onNight(), DUE - 1], [onNight(), DUE], [retried, JUDGED], [onNight(), WIN_END - 10 * MIN]] as Array<[NightActuationState, number]>) {
    assert.deepEqual(decideForceCharge(s, t, o([1])), decideForceCharge(s, t, o([])), `★ slot 1 reading ON is slot 1 reading OFF — t ${t}`);
    // Beside a slot in the pool that reads ON it changes nothing either: the failure is slot 2's.
    assert.deepEqual(decideForceCharge(s, t, o([1, 3])), decideForceCharge(s, t, o([3])), `t ${t}`);
  }
  assert.deepEqual(decideForceCharge(retried, JUDGED, o([1, 3])), { kind: 'onFailed', slots: [2] }, 'slot 3, in the pool, took it: partial, and slot 1 stays out of the failure');
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
/** The ON-failure push of a verdict, built as the integrator builds it: the verdict's slots, the record's, and the slots
 *  the tick left out for the pool alarm (index.ts hands `pool.leftOut` on as `outOfPoolSlots`; section 6 pins it). */
const failurePush = (s: NightActuationState, a: ForceChargeAction, leftOut: readonly number[] = []): string => {
  assert.equal(a.kind, 'onFailed');
  if (a.kind !== 'onFailed') return '';
  return buildNightForceChargeOnFailure({
    day: s.day, slots: a.slots, ourSlots: s.forceChargeSlots, retries: s.forceChargeOnRetries, noRetry: a.noRetry === true,
    ...forceChargeOnFailureNight(s),
    outOfPoolSlots: leftOut,
  }).body;
};
/** The sentence the push ends with for the listed slots that are out of the pool. */
const outNote = (slots: string): string =>
  ` Slot(s) ${slots} are listed because the pool alarm names their Core out of the backup pool: a Core out of the pool takes no charge, whatever its Charge Now reads.`;

test('★★★ the WHOLE failure and its readers: the ON took on no slot in the pool, one of ours out of it — every slot named, no "on those slot(s)", the closure "not taken"; the same whether the named slot reads OFF or ON', () => {
  const retried = onNight(RETRIED);
  // The control, no slot named and nothing reading ON: the release before's whole failure, and its push.
  const before = decideForceCharge(retried, JUDGED, runOpts({ slotsOn: [] }));
  assert.deepEqual(before, { kind: 'onFailed', slots: [1, 2, 3] });
  const pushBefore = failurePush(retried, before);
  // The ON went to 1, 2 and 3; the re-issue is spent and has had its grace; the alarm names slot 1. No slot in the pool
  // reads ON — with slot 1 reading OFF, and with slot 1 reading ON.
  for (const slotsOn of [[], [1]]) {
    const tag = `slot 1 reading ${slotsOn.length > 0 ? 'ON' : 'OFF'}`;
    const whole = decideForceCharge(retried, JUDGED, runOpts({ slotsOn, poolOutSlots: [1] }));
    assert.deepEqual(whole, { kind: 'onFailed', slots: [1, 2, 3] }, `★ every slot of ours, the exempt one too — ${tag}`);
    assert.deepEqual(whole, before, `the verdict of the release before with nothing reading ON — ${tag}`);
    const wholeRecord = withFailure(retried, JUDGED, whole);
    // Reader 1: a failure shorter than the ON's list is "the ON took on the others". This one is not shorter.
    assert.equal(partialForceChargeOnFailureSlots({ forceChargeSlots: retried.forceChargeSlots, forceChargeOnFailedSlots: [1, 2, 3] }), null, '★ not a partial failure');
    assert.equal(partialForceChargeOnFailureSlots(wholeRecord), null, `★ ${tag}`);
    // Reader 2: the night's outcome, as the morning summary takes it.
    const outcome = forceChargeNightOutcome(wholeRecord, true);
    assert.deepEqual([outcome.kind, outcome.kind === 'failed' ? outcome.partialSlots : 'n/a'], ['failed', null], tag);
    // Reader 3: the push. The whole-failure sentence, every slot named, never "on those slot(s)" — and, last, why slot 1 is listed.
    const push = failurePush(retried, whole, [1]);
    assert.match(push, /still reads slot\(s\) 1, 2, 3 OFF after 1 re-issue\(s\)\. /);
    assert.match(push, /Tonight's buy above the \d+% reserve \(toward ~\d+(?:\.\d)?%\) will not happen; the reserve charge is unaffected\./, `★ the whole-failure sentence — ${tag}`);
    assert.equal(push.includes('on those slot(s)'), false, `★ never the partial sentence — ${tag}`);
    assert.equal(push, pushBefore + outNote('1'), `★ the push of the release before, to the letter, and the sentence for slot 1 after it — ${tag}`);
    // Once a night: with the failure on the record nothing more is judged.
    assert.deepEqual(decideForceCharge(wholeRecord, JUDGED + MIN, runOpts({ slotsOn, poolOutSlots: [1] })), { kind: 'none' }, tag);
    // …and a late apply on a slot in the pool still verifies it, slot 1 named as out of the pool, whatever it reads.
    assert.deepEqual(decideForceCharge(wholeRecord, JUDGED + 5 * MIN, runOpts({ slotsOn: [...slotsOn, 2, 3], poolOutSlots: [1] })), { kind: 'onVerified', atCeiling: [], outOfPool: [1] }, tag);
    // A late "apply" on slot 1 alone is none: it is not in the pool.
    assert.deepEqual(decideForceCharge(wholeRecord, JUDGED + 5 * MIN, runOpts({ slotsOn: [1], poolOutSlots: [1] })), { kind: 'none' }, tag);
  }
  // ★ What the same readings were before the slot was named: slot 1 reading ON made it a failure of slots 2 and 3 —
  // read by every reader as "the ON took on slot 1".
  const partBefore = decideForceCharge(retried, JUDGED, runOpts({ slotsOn: [1] }));
  assert.deepEqual(partBefore, { kind: 'onFailed', slots: [2, 3] }, 'control: with no slot named');
  assert.deepEqual(partialForceChargeOnFailureSlots(withFailure(retried, JUDGED, partBefore)), [2, 3]);
  assert.match(failurePush(retried, partBefore), /will not happen on those slot\(s\); the reserve charge is unaffected\./);

  // The PARTIAL case beside it: slot 3, in the pool, reads ON. The failure is slot 2's; slot 1 is in no failure, whatever it reads.
  for (const slotsOn of [[3], [1, 3]]) {
    const part = decideForceCharge(retried, JUDGED, runOpts({ slotsOn, poolOutSlots: [1] }));
    assert.deepEqual(part, { kind: 'onFailed', slots: [2] });
    const partRecord = withFailure(retried, JUDGED, part);
    assert.deepEqual(partialForceChargeOnFailureSlots(partRecord), [2]);
    const partOutcome = forceChargeNightOutcome(partRecord, true);
    assert.deepEqual([partOutcome.kind, partOutcome.kind === 'failed' ? partOutcome.partialSlots : 'n/a'], ['failed', [2]]);
    const partPush = failurePush(retried, part, [1]);
    assert.match(partPush, /still reads slot\(s\) 2 OFF after 1 re-issue\(s\)\. /);
    assert.match(partPush, /will not happen on those slot\(s\); the reserve charge is unaffected\./);
    assert.equal(partPush.includes('are listed because'), false, 'slot 1 is not listed, so nothing is said of it');
    assert.equal(partPush, failurePush(retried, part), 'the push of the release before, to the letter');
  }
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
  // The control, no slot named and nothing reading ON: the release before's whole failure, its closure and its push.
  const before = decideForceCharge(lineOn, JUDGED, o({ slotsOn: [] }));
  assert.deepEqual(before, { kind: 'onFailed', slots: [1, 2, 3] });
  const NOT_TAKEN = { windowStartMs: WIN_START, why: 'notTaken', writeStands: true };
  assert.deepEqual(armedLineStartClosed(withFailure(lineOn, JUDGED, before), JUDGED + MIN, G), NOT_TAKEN);
  const pushBefore = failurePush(lineOn, before);
  assert.match(lineStartClosedWords('the line', 'notTaken'), /has not taken effect: unless it applies late, none runs$/);
  // Slot 1 named out, and no slot in the pool reading ON — with slot 1 reading OFF, and with slot 1 reading ON.
  for (const slotsOn of [[], [1]]) {
    const tag = `slot 1 reading ${slotsOn.length > 0 ? 'ON' : 'OFF'}`;
    const whole = decideForceCharge(lineOn, JUDGED, o({ slotsOn, poolOutSlots: [1] }));
    assert.deepEqual(whole, { kind: 'onFailed', slots: [1, 2, 3] }, tag);
    const closure = armedLineStartClosed(withFailure(lineOn, JUDGED, whole), JUDGED + MIN, G);
    assert.deepEqual(closure, NOT_TAKEN, `★ notTaken: an ON warned of on EVERY slot — ${tag}`);
    const push = failurePush(lineOn, whole, [1]);
    assert.match(push, /still reads slot\(s\) 1, 2, 3 OFF after 1 re-issue\(s\)\. /);
    assert.match(push, /has not taken effect: unless it applies late, the add-on adds nothing above the \d+% reserve/, `★ the whole-failure sentence — ${tag}`);
    assert.equal(push.includes('on those slot(s)'), false, `★ never the partial sentence — ${tag}`);
    assert.match(push, /Charge Now switched on for slot\(s\) 1, 2, 3 in the EcoFlow app/);
    assert.equal(push, pushBefore + outNote('1'), `★ the push of the release before, to the letter, and the sentence for slot 1 after it — ${tag}`);
  }
  // ★ What slot 1 reading ON was before it was named: a failure of slots 2 and 3, served as "part taken".
  const partBefore = decideForceCharge(lineOn, JUDGED, o({ slotsOn: [1] }));
  assert.deepEqual(partBefore, { kind: 'onFailed', slots: [2, 3] }, 'control: with no slot named');
  assert.deepEqual(armedLineStartClosed(withFailure(lineOn, JUDGED, partBefore), JUDGED + MIN, G), { windowStartMs: WIN_START, why: 'partTaken' }, 'control');
  // The partial case: slot 3, in the pool, reads ON.
  for (const slotsOn of [[3], [1, 3]]) {
    const part = decideForceCharge(lineOn, JUDGED, o({ slotsOn, poolOutSlots: [1] }));
    assert.deepEqual(part, { kind: 'onFailed', slots: [2] });
    assert.deepEqual(armedLineStartClosed(withFailure(lineOn, JUDGED, part), JUDGED + MIN, G), { windowStartMs: WIN_START, why: 'partTaken' });
    assert.match(failurePush(lineOn, part, [1]), /has not taken effect on those slot\(s\)/);
    assert.equal(failurePush(lineOn, part, [1]), failurePush(lineOn, part), 'slot 1 is not listed: the push of the release before');
  }
});

test('★★★ the ON-failure push says which listed slots are out of the pool: one sentence, last, word for word — on a cost night and on a line night; only slots that are listed, ascending, each once; with none, the body of the release before to the letter', () => {
  const NOTE_1 = ' Slot(s) 1 are listed because the pool alarm names their Core out of the backup pool: a Core out of the pool takes no charge, whatever its Charge Now reads.';
  assert.equal(outNote('1'), NOTE_1);
  const costNight = onNight(RETRIED);
  const lineNight = onNight({
    forceChargeCeilingPct: null, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55, forceChargeRides: true,
    forceChargeMode: 'line', forceChargeCeilingSyncedPct: 80, ...RETRIED,
  } as Partial<NightActuationState>);
  assert.deepEqual([forceChargeOnFailureNight(costNight), forceChargeOnFailureNight(lineNight)], [{ ceilingPct: 90, lineLinePct: null }, { ceilingPct: null, lineLinePct: 55.55 }], 'control: a cost night names its stop, a line night its line');
  type Push = Parameters<typeof buildNightForceChargeOnFailure>[0];
  /** Each slot's Core as the handler joins it: slot 1's work mode and own reserve differ from the other two's. */
  const CORES: NonNullable<Push['cores']> = [
    { slot: 1, label: 'Core 1', online: true, workMode: 1, backupSocPct: 20 },
    { slot: 2, label: 'Core 2', online: true, workMode: 3, backupSocPct: 10 },
    { slot: 3, label: 'Core 3', online: false, workMode: 3, backupSocPct: 10 },
  ];
  /** Every shape the handler builds a push from: each night, each failure list (whole and partial), with and without a re-issue, with and without the Cores. */
  const inputs: Array<[string, Push]> = [];
  for (const [night, s] of [['a cost night', costNight], ['a line night', lineNight]] as Array<[string, NightActuationState]>) {
    for (const ours of [[1, 2, 3], [3, 1, 2], [2, 3]]) {
      for (const slots of [[1, 2, 3], [2, 3], [1], [3, 1], [1, 3, 1]]) {
        for (const noRetry of [false, true]) {
          for (const cores of [undefined, null, CORES]) {
            inputs.push([`${night}, ours ${JSON.stringify(ours)}, failed ${JSON.stringify(slots)}, noRetry ${noRetry}, cores ${cores == null ? String(cores) : 'given'}`, {
              day: s.day, slots, ourSlots: ours, retries: noRetry ? 0 : 1, noRetry, ...forceChargeOnFailureNight(s), ...(cores === undefined ? {} : { cores }),
            }]);
          }
        }
      }
    }
  }
  assert.equal(inputs.length, 2 * 3 * 5 * 2 * 3);
  let said = 0;
  for (const [label, input] of inputs) {
    const base = buildNightForceChargeOnFailure(input);
    assert.equal('outOfPoolSlots' in input, false, 'control: the call without the argument');
    // ★ Absent, null, an empty list, and a list with none of the failed slots: IDENTICAL, body and all, over the same inputs.
    const none: Array<readonly number[] | null | undefined> = [undefined, null, [], [4], [0, 7], [1, 2, 3].filter((n) => !input.slots.includes(n))];
    for (const outOfPoolSlots of none) {
      const same = buildNightForceChargeOnFailure({ ...input, outOfPoolSlots });
      assert.equal(same.body, base.body, `★ ${JSON.stringify(outOfPoolSlots)}: the body of the call without it — ${label}`);
      assert.deepEqual(same, base, `and the whole message — ${label}`);
    }
    // ★ With slots of the failure among them: the body of the release before, and ONE sentence after it, naming those slots only.
    for (const out of SUBSETS.filter((s) => s.length > 0).flatMap(perms)) {
      const listed = [...new Set(input.slots)].filter((n) => out.includes(n)).sort((a, b) => a - b);
      if (listed.length === 0) continue;
      said++;
      for (const outOfPoolSlots of [out, [...out, ...out], [...out, 9, 0, 4]]) {
        const m = buildNightForceChargeOnFailure({ ...input, outOfPoolSlots });
        assert.equal(m.body, base.body + outNote(listed.join(', ')), `★ ${JSON.stringify(outOfPoolSlots)} — ${label}`);
        assert.deepEqual({ ...m, body: '' }, { ...base, body: '' }, `the title, the severity and the dedup id are as they were — ${label}`);
        assert.equal(m.body.split('are listed because the pool alarm names').length - 1, 1, 'said once');
      }
    }
  }
  assert.ok(said > 0);
  // Word for word, whole: the whole failure of the four examples (slot 1 named out, no slot in the pool reading ON).
  const bodies: string[] = [];
  for (const [label, night] of [['a cost night', { ceilingPct: 90, lineLinePct: null }], ['a line night', { ceilingPct: null, lineLinePct: 55.55 }]] as Array<[string, Pick<Push, 'ceilingPct' | 'lineLinePct'>]>) {
    const args: Push = { day: '2026-11-20', slots: [1, 2, 3], ourSlots: [1, 2, 3], retries: 1, noRetry: false, ...night };
    const without = buildNightForceChargeOnFailure(args).body;
    const withIt = buildNightForceChargeOnFailure({ ...args, outOfPoolSlots: [1] }).body;
    assert.equal(withIt, without + NOTE_1, `★ ${label}: the sentence, word for word, after the body of the release before`);
    assert.equal(without.endsWith('check the SHP2 cloud link.'), true, `control: the push's own last sentence — ${label}`);
    assert.equal(withIt.endsWith(`check the SHP2 cloud link.${NOTE_1}`), true, `★ ${label}: last in the body`);
    bodies.push(withIt);
  }
  assert.match(bodies[0], /Tonight's buy above the \d+% reserve \(toward ~\d+(?:\.\d)?%\) will not happen; /, 'control: the cost night\'s words');
  assert.match(bodies[1], /Tonight's force-charge for the 55\.6% outage line has not taken effect: unless it applies late/, 'control: the line night\'s words');
  // Ascending, each once, and only the listed ones — whatever order and however often either list holds a slot.
  const sentence = (slots: number[], outOfPoolSlots: number[]): string =>
    buildNightForceChargeOnFailure({ day: '2026-11-20', slots, ourSlots: [1, 2, 3], retries: 1, noRetry: false, ceilingPct: 90, outOfPoolSlots }).body.split('check the SHP2 cloud link.')[1];
  assert.equal(sentence([3, 1, 2], [3, 1]), outNote('1, 3'), '★ ascending');
  assert.equal(sentence([3, 1, 2], [3, 3, 1, 1, 3]), outNote('1, 3'), '★ each once');
  assert.equal(sentence([3, 3, 1, 2], [3]), outNote('3'), 'and once for a slot the failure lists twice');
  assert.equal(sentence([2, 3], [1, 2]), outNote('2'), '★ only a slot that is among the failed ones');
  assert.equal(sentence([1, 2, 3], [3, 2, 1]), outNote('1, 2, 3'));
  assert.equal(sentence([2, 3], [1]), '', 'none of the failed slots: nothing');
});

test('★★★ every slot of ours out of the pool: nothing to re-issue, and nothing that proves the ON whatever the slots read — nothing inside the grace, then ONE failure naming every slot of ours with no noRetry flag, then nothing', () => {
  const o = runOpts({ slotsOn: [], connectedSlots: [], poolOutSlots: [1, 2, 3] });
  const WHOLE = { kind: 'onFailed', slots: [1, 2, 3] };
  // ★ Whatever the three slots read — none ON, some ON, every one ON — at every minute of the run: never verified,
  // never a re-issue, and the verdict of the same minute with none reading ON, to the letter.
  for (const slotsOn of SUBSETS) {
    for (let t = ON_AT; t < WIN_END; t += MIN) {
      for (const s of [onNight(), onNight(RETRIED), withFailureAt(onNight(), DUE, [1, 2, 3])]) {
        const a = decideForceCharge(s, t, { ...o, slotsOn });
        assert.equal(a.kind === 'none' || a.kind === 'onFailed', true, `ON ${JSON.stringify(slotsOn)}, minute ${(t - ON_AT) / MIN}: ${a.kind}`);
        assert.deepEqual(a, decideForceCharge(s, t, o), `★ ON ${JSON.stringify(slotsOn)}, minute ${(t - ON_AT) / MIN}: as with none reading ON`);
        if (a.kind === 'onFailed') assert.deepEqual([a.slots, 'noRetry' in a], [[1, 2, 3], false]);
      }
    }
  }
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
  const push = failurePush(onNight(), failed, [1, 2, 3]);
  assert.match(push, /still reads slot\(s\) 1, 2, 3 OFF after 0 re-issue\(s\)\. /);
  assert.equal(push.includes('too close to the window end'), false, 'the push does not say the window was too short');
  assert.equal(push.includes('on those slot(s)'), false);
  assert.equal(push, failurePush(onNight(), failed) + outNote('1, 2, 3'), 'and, last, that all three are listed because their Core is out of the pool');
  // Every list of ours, with every list that holds it, and every readback: 'none', then the failure naming the ON's own list, then 'none'.
  for (const ours of SUBSETS.filter((s) => s.length > 0)) {
    for (const out of SUBSETS.filter((s) => ours.every((n) => s.includes(n)))) {
      for (const slotsOn of SUBSETS) {
        const s = onNight({ forceChargeSlots: ours });
        const opts = runOpts({ slotsOn, poolOutSlots: out });
        const tag = `ours ${JSON.stringify(ours)}, out of the pool ${JSON.stringify(out)}, ON ${JSON.stringify(slotsOn)}`;
        assert.deepEqual(decideForceCharge(s, DUE - 1, opts), { kind: 'none' }, tag);
        assert.deepEqual(decideForceCharge(s, DUE, opts), { kind: 'onFailed', slots: ours }, `★ ${tag}`);
        assert.deepEqual(decideForceCharge({ ...s, forceChargeOnFailedAtMs: DUE, forceChargeOnFailedSlots: [...ours] }, DUE + MIN, opts), { kind: 'none' }, tag);
      }
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
  // ★ The only slot reading ON is the one named out: no proof. Slot 1 named and reading ON, slot 2 at the ceiling, slot 3
  // under it: the re-issue is slot 3's, the failure names slots 1 and 3 — and slot 2, held at the ceiling, is still in neither.
  assert.deepEqual(decideForceCharge(onNight(), DUE, o({ slotsOn: [1], poolOutSlots: [1] })), { kind: 'onRetry', slots: [3] });
  assert.deepEqual(decideForceCharge(retried, JUDGED, o({ slotsOn: [1], poolOutSlots: [1] })), { kind: 'onFailed', slots: [1, 3] }, '★ slot 1 reading ON: the same failure as with it reading OFF');
  assert.deepEqual(decideForceCharge(retried, JUDGED, o({ slotsOn: [1] })), { kind: 'onFailed', slots: [3] }, 'control: with no slot named, slot 1 reading ON leaves a failure of slot 3 alone');
  // The slot at the ceiling is the one named, and it reads ON: out of the pool, it proves nothing — the whole failure.
  assert.deepEqual(decideForceCharge(retried, JUDGED, o({ slotsOn: [2], poolOutSlots: [2] })), { kind: 'onFailed', slots: [1, 2, 3] });
  assert.deepEqual(decideForceCharge(retried, JUDGED, o({ slotsOn: [2] })), { kind: 'onFailed', slots: [1, 3] }, 'control: with no slot named');
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
 * the ceiling × 5 stages (17,920 cases). Each case is decided with the slots named out of the pool, and — the release
 * before — with those same slots read as at the panel's ceiling instead; and each of the two again with the named
 * slots reading OFF (the same readback, less the named slots).
 *
 * WHAT A NAMED SLOT READS IS NO PART OF THE VERDICT. In every case the pool exemption's verdict is, to the letter, its
 * verdict with the named slots reading OFF: a slot the alarm names out of the pool proves nothing by reading ON.
 *
 * SIDE A — a slot of ours IN THE POOL reads ON, or no slot of ours is named: the two exemptions agree to the letter.
 *   'none', a re-issue and a failure are the same object. A verified verdict is verified in both, with the same slots
 *   exempt for reading OFF, each under its own name: `atCeiling` is the ceiling exemption's list less the named
 *   slots, and `outOfPool` is every named slot of ours, reading ON or OFF (the key absent with none).
 * SIDE B — a slot of ours is named, and NO slot of ours reads ON: neither is ever verified, and each is 'none' where
 *   the other is. A re-issue goes to the ceiling exemption's slots LESS the named ones (the same slots unless every
 *   slot of ours is exempt, where the ceiling exemption re-issues to all of ours); with none left there is no
 *   re-issue, and the failure is declared in its place, naming every slot of ours, with no noRetry flag. A failure
 *   names the ceiling exemption's slots PLUS the named ones, in the ON's order (its noRetry flag unchanged, and never
 *   set where every slot of ours is named).
 * SIDE C — a slot of ours is named, and the ONLY slots of ours reading ON are named ones. The ceiling exemption takes
 *   such a slot as proof that the ON took somewhere; the pool exemption does not:
 *   - where the ceiling exemption VERIFIES (every slot in the pool reads OFF at the ceiling), the pool exemption never
 *     does. It is 'none' inside the grace and after the warning; otherwise a re-issue to the slots of ours in the
 *     pool, and after it the failure naming every slot of ours (with no slot of ours in the pool: that failure in the
 *     re-issue's place, with no noRetry flag);
 *   - where the ceiling exemption is 'none' or a re-issue, the two are the same to the letter;
 *   - where it is a failure — a PARTIAL one to every reader, a slot of ours reading ON — the pool exemption's failure
 *     names those slots PLUS every named one, with the same noRetry flag: the WHOLE failure, unless a slot in the pool
 *     is held at the ceiling.
 *   In every case of side C the verdict is also side B's rule over the ceiling exemption's verdict on the readback
 *   less the named slots.
 */
test('★★★ EXHAUSTIVE: the pool exemption against the ceiling\'s — the same to the letter while a slot of ours IN THE POOL reads ON; with none, a slot named out proves nothing whatever it reads: never verified, a re-issue without it, a failure that names it', () => {
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
  /** Side B's rule: what the pool exemption makes of the ceiling exemption's verdict while no slot of ours reads ON. */
  const fromCeiling = (base: ForceChargeAction, ours: number[], named: number[]): ForceChargeAction => {
    if (base.kind === 'onRetry') {
      const left = base.slots.filter((n) => !named.includes(n));
      // Nothing left to re-issue to: the failure in its place, every slot of ours, and no noRetry key at all.
      return left.length > 0 ? { kind: 'onRetry', slots: left } : { kind: 'onFailed', slots: ours };
    }
    if (base.kind === 'onFailed') {
      const left = base.slots.filter((n) => !named.includes(n));
      const slots = ours.filter((n) => left.includes(n) || named.includes(n));
      return { kind: 'onFailed', slots, ...(left.length > 0 && base.noRetry === true ? { noRetry: true } : {}) };
    }
    return base;
  };
  const partialOf = (ours: number[], failed: number[]): number[] | null => partialForceChargeOnFailureSlots({ forceChargeSlots: ours, forceChargeOnFailedSlots: failed });
  for (const ours of SUBSETS.filter((s) => s.length > 0)) {
    for (const slotsOn of SUBSETS) {
      for (const outOfPool of SUBSETS) {
        for (const atCeiling of SUBSETS) {
          for (const [label, over, t] of stages) {
            cases++;
            const s = onNight({ forceChargeSlots: ours, ...over });
            const socs = (hot: number[]): Record<number, number> => Object.fromEntries([1, 2, 3].map((n) => [n, hot.includes(n) ? 95 : 60]));
            const oursOn = ours.filter((n) => slotsOn.includes(n));
            const oursOff = ours.filter((n) => !slotsOn.includes(n));
            const named = ours.filter((n) => outOfPool.includes(n));
            const inPool = ours.filter((n) => !outOfPool.includes(n));
            const inPoolOn = oursOn.filter((n) => !outOfPool.includes(n));
            const namedOn = oursOn.filter((n) => outOfPool.includes(n));
            /** The same readback with the named slots reading OFF. */
            const readOff = slotsOn.filter((n) => !named.includes(n));
            const a = decideForceCharge(s, t, runOpts({ slotsOn, slotSocPct: socs(atCeiling), poolOutSlots: outOfPool }));
            // The release before, with the named slots read as at the ceiling.
            const base = decideForceCharge(s, t, runOpts({ slotsOn, slotSocPct: socs([...atCeiling, ...outOfPool]) }));
            const tag = `${label}: ours ${JSON.stringify(ours)}, ON ${JSON.stringify(slotsOn)}, out of the pool ${JSON.stringify(outOfPool)}, at the ceiling ${JSON.stringify(atCeiling)} → ${JSON.stringify(a)} (as at the ceiling: ${JSON.stringify(base)})`;
            kinds.add(a.kind);

            /* ★ What a named slot reads is no part of the verdict. */
            assert.deepEqual(a, decideForceCharge(s, t, runOpts({ slotsOn: readOff, slotSocPct: socs(atCeiling), poolOutSlots: outOfPool })), `★ a named slot reading ON is a named slot reading OFF — ${tag}`);

            /* What holds of every verdict. */
            if (a.kind === 'onVerified') {
              assert.equal(inPoolOn.length > 0, true, `★ verified with no slot of ours IN THE POOL reading ON — ${tag}`);
              assert.deepEqual(a.outOfPool ?? [], named, `★ outOfPool is every slot of ours out of the pool, reading ON or OFF — ${tag}`);
              assert.equal('outOfPool' in a, named.length > 0, `the key only when a slot of ours is out of the pool — ${tag}`);
              assert.deepEqual(a.atCeiling, oursOff.filter((n) => !outOfPool.includes(n)), `atCeiling — ${tag}`);
              assert.equal(a.atCeiling.every((n) => atCeiling.includes(n)), true, `a slot listed at the ceiling is at it — ${tag}`);
              assert.equal(a.atCeiling.some((n) => outOfPool.includes(n)), false, `★ atCeiling never holds a slot out of the pool — ${tag}`);
            } else if (a.kind === 'onRetry') {
              assert.equal(a.slots.length > 0 && a.slots.every((n) => oursOff.includes(n)), true, `a re-issue goes to slots of ours reading OFF — ${tag}`);
              assert.equal(a.slots.some((n) => outOfPool.includes(n)), false, `★ a slot out of the pool re-issued — ${tag}`);
            } else if (a.kind === 'onFailed') {
              assert.equal(a.slots.length > 0 && a.slots.every((n) => oursOff.includes(n) || named.includes(n)), true, `a failure names slots of ours that read OFF or are out of the pool — ${tag}`);
              assert.deepEqual(ours.filter((n) => a.slots.includes(n)), a.slots, `in the ON's own order — ${tag}`);
              if (inPoolOn.length > 0) assert.equal(a.slots.some((n) => outOfPool.includes(n)), false, `a slot of ours in the pool reads ON: the exempt slot stays out of the failure — ${tag}`);
              else assert.equal(named.every((n) => a.slots.includes(n)), true, `★ no slot of ours in the pool reads ON: every slot out of the pool is named, whatever it reads — ${tag}`);
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

            if (named.length === 0 || inPoolOn.length > 0) {
              /* SIDE A: the same verdict as the ceiling exemption gives. */
              sideA++;
              if (base.kind === 'onVerified') {
                assert.equal(a.kind, 'onVerified', tag);
                if (a.kind === 'onVerified') {
                  assert.deepEqual(a.atCeiling, base.atCeiling.filter((n) => !named.includes(n)), `atCeiling is the ceiling exemption's list less the named slots — ${tag}`);
                  assert.deepEqual([...a.atCeiling, ...(a.outOfPool ?? []).filter((n) => !slotsOn.includes(n))].sort(), [...base.atCeiling].sort(), `the same slots exempt for reading OFF, each under its own name — ${tag}`);
                  if (named.length === 0) assert.deepEqual(a, base, tag);
                }
              } else {
                assert.deepEqual(a, base, `★ a slot of ours in the pool reads ON, or none is named: to the letter — ${tag}`);
              }
              continue;
            }

            if (namedOn.length === 0) {
              /* SIDE B: a slot of ours is named out of the pool, and no slot of ours reads ON. */
              sideB++;
              assert.notEqual(a.kind, 'onVerified', `★ never verified with none reading ON — ${tag}`);
              assert.notEqual(base.kind, 'onVerified', tag);
              assert.deepEqual(a, fromCeiling(base, ours, named), `★ the ceiling exemption's verdict: a re-issue less the named slots, a failure with them — ${tag}`);
              if (base.kind === 'onRetry') {
                const left = base.slots.filter((n) => !named.includes(n));
                if (left.length === 0) {
                  assert.deepEqual([a.kind, 'noRetry' in a], ['onFailed', false], tag);
                  differ('a failure where the ceiling exemption re-issues (every slot of ours named)');
                } else if (left.length < base.slots.length) differ('a re-issue that leaves the named slots out');
              } else if (base.kind === 'onFailed') {
                assert.equal(a.kind, 'onFailed', tag);
                if (a.kind === 'onFailed' && a.slots.length > base.slots.length) differ('a failure that names the named slots too');
                if (base.noRetry === true && inPool.length === 0) {
                  assert.equal('noRetry' in a, false, tag);
                  differ('no noRetry flag where every slot of ours is named');
                }
                // With no slot of ours in the pool at the ceiling it is the WHOLE failure: every slot of ours.
                if (!inPool.some((n) => atCeiling.includes(n))) assert.deepEqual(a.kind === 'onFailed' ? a.slots : null, ours, `★ the whole failure — ${tag}`);
              } else {
                assert.deepEqual([a, base], [{ kind: 'none' }, { kind: 'none' }], `'none' where the ceiling exemption is — ${tag}`);
              }
              if (!isDeepStrictEqual(a, base)) differ('side B in all');
              continue;
            }

            /* SIDE C: a slot of ours is named, and the only slots of ours reading ON are named ones. */
            sideC++;
            assert.notEqual(a.kind, 'onVerified', `★ never verified on a slot out of the pool reading ON — ${tag}`);
            // Side B's rule, over the ceiling exemption's verdict on the readback less the named slots.
            const baseOff = decideForceCharge(s, t, runOpts({ slotsOn: readOff, slotSocPct: socs([...atCeiling, ...outOfPool]) }));
            assert.notEqual(baseOff.kind, 'onVerified', tag);
            assert.deepEqual(a, fromCeiling(baseOff, ours, named), `★ as with the named slots reading OFF — ${tag}`);
            if (base.kind === 'onVerified') {
              // The ceiling exemption verifies: every slot of ours in the pool reads OFF with its Core at the ceiling, and a named slot reads ON.
              assert.equal(inPool.every((n) => oursOff.includes(n) && atCeiling.includes(n)), true, `control — ${tag}`);
              const want: ForceChargeAction = label === 'inside the grace' || label === 'after the warning' ? { kind: 'none' }
                : inPool.length === 0 ? { kind: 'onFailed', slots: ours }
                  : label === 'the re-issue due' ? { kind: 'onRetry', slots: inPool }
                    : label === 'after the re-issue' ? { kind: 'onFailed', slots: ours }
                      : { kind: 'onFailed', slots: ours, noRetry: true };
              assert.deepEqual(a, want, `★ where the ceiling exemption verifies on a slot out of the pool — ${tag}`);
              differ(a.kind === 'none' ? 'nothing yet where the ceiling exemption verifies'
                : a.kind === 'onRetry' ? 'a re-issue where the ceiling exemption verifies' : 'the whole failure where the ceiling exemption verifies');
            } else if (base.kind === 'onFailed') {
              // To every reader the ceiling exemption's failure is partial: a slot of ours reads ON.
              assert.notEqual(partialOf(ours, base.slots), null, `control — ${tag}`);
              const slots = ours.filter((n) => base.slots.includes(n) || named.includes(n));
              assert.deepEqual(a, { kind: 'onFailed', slots, ...(base.noRetry === true ? { noRetry: true } : {}) }, `★ the ceiling exemption's failure, and every named slot — ${tag}`);
              if (!inPool.some((n) => atCeiling.includes(n))) {
                assert.deepEqual(slots, ours, `★ the whole failure — ${tag}`);
                assert.equal(partialOf(ours, slots), null, `★ and no reader takes it as "the ON took on the others" — ${tag}`);
                differ('a whole failure where the ceiling exemption\'s is partial');
              } else {
                differ('a failure that names the named slots beside a slot held at the ceiling');
              }
            } else {
              assert.deepEqual(a, base, `'none' and a re-issue: to the letter — ${tag}`);
              if (base.kind === 'onRetry') assert.equal(base.slots.some((n) => named.includes(n)), false, tag);
            }
            assert.equal(isDeepStrictEqual(a, base), base.kind === 'none' || base.kind === 'onRetry', `on side C the two differ exactly where the ceiling exemption judges the ON — ${tag}`);
          }
        }
      }
    }
  }
  assert.equal(cases, 7 * 8 * 8 * 8 * 5);
  assert.deepEqual([...kinds].sort(), ['none', 'onFailed', 'onRetry', 'onVerified'], 'every verdict is reached');
  assert.equal(sideA + sideB + sideC, cases, 'every case is on one side');
  // The sides are a property of the grid alone (which slots are named, and which read ON): 9,200 + 3,640 + 5,080.
  assert.deepEqual([sideA, sideB, sideC], [9_200, 3_640, 5_080], `${sideA} cases on side A, ${sideB} on side B, ${sideC} on side C`);
  // Each difference is reached, and they are all the difference there is.
  for (const what of [
    'a re-issue that leaves the named slots out', 'a failure where the ceiling exemption re-issues (every slot of ours named)',
    'a failure that names the named slots too', 'no noRetry flag where every slot of ours is named', 'side B in all',
    'nothing yet where the ceiling exemption verifies', 'a re-issue where the ceiling exemption verifies', 'the whole failure where the ceiling exemption verifies',
    'a whole failure where the ceiling exemption\'s is partial', 'a failure that names the named slots beside a slot held at the ceiling',
  ]) {
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

test('★★★ index.ts: the ON-failure handler says which listed slots are out of the pool — one more warn line under its guard, after the two existing lines and before the push; and the push is handed pool.leftOut as its LAST argument', () => {
  const f = branch('onFailed');
  // The two warn lines of the release before: a night with a line ask, and every other night.
  const lineWarn = "    if (lineLogPct(state) != null) app.log.warn(`night-charge: force-charge ON for ${state.day}'s ${lineLogPct(state)}% outage line has NOT taken effect — slot(s) ${failedSlots.text} still read FORCE_CHARGE_OFF after ";
  const costWarn = '    else app.log.warn(`night-charge: force-charge ON NEVER TOOK EFFECT for ${state.day} — slot(s) ${failedSlots.text} still read FORCE_CHARGE_OFF after ';
  // ★ The added line, as written, and its guard: the slots of the failure that the tick left out for the pool alarm.
  const added = '    const outListed = action.slots.filter((n) => pool.leftOut.includes(n));\n'
    + "    if (outListed.length > 0) app.log.warn(`night-charge: of those, slot(s) ${outListed.join(',')} are listed because the pool alarm names their Core out of the panel's backup pool (a Core out of the pool takes no charge, whatever its Charge Now and its percent read): no slot in the pool took the ON.`);\n";
  const push = '      await sendNotification(loadNotifyConfig(), buildNightForceChargeOnFailure({\n';
  const at = [lineWarn, costWarn, added, '    try {\n', push].map((x) => f.indexOf(x));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `★ in order: the line night's warn, the other nights' warn, the added line, the push — ${at.join(' < ')}`);
  // Directly between the second warn line and the push's try: nothing else is said or done there.
  assert.ok(f.includes(`${added}    try {\n${push}`), '★ the added line is the statement before the push');
  assert.equal(f.slice(f.indexOf(costWarn), f.indexOf(added)).split('\n').length, 2, 'and the statement after the second warn line');
  for (const once of [lineWarn, costWarn, added, push]) assert.equal(count(f, once), 1, `once: ${once.slice(0, 60)}…`);
  assert.equal(count(CODE, 'are listed because the pool alarm names their Core out of the panel\'s backup pool'), 1, 'said in one place in the integrator');
  assert.equal(count(CODE, 'const outListed = '), 1);
  // At warn, as the two lines above it; and nothing is awaited before it (the record and the ledger stamp come first, the push after).
  assert.equal(count(f.slice(0, f.indexOf(added) + added.length), 'await '), 0, 'no await before the added line');
  assert.ok(f.indexOf('    persistNightActuation({ ...nightActuationMem, forceChargeOnFailedAtMs: nowMs, forceChargeOnFailedSlots: [...action.slots] });\n') < f.indexOf(lineWarn), 'the record is written before any of the three lines');
  // The line's words on the handler's own values: the template pinned above, evaluated.
  const template = added.slice(added.indexOf('`') + 1, added.lastIndexOf('`'));
  const say = new Function('outListed', `return \`${template}\`;`) as (outListed: number[]) => string;
  assert.equal(say([1]), 'night-charge: of those, slot(s) 1 are listed because the pool alarm names their Core out of the panel\'s backup pool (a Core out of the pool takes no charge, whatever its Charge Now and its percent read): no slot in the pool took the ON.');
  assert.equal(say([1, 3]).startsWith('night-charge: of those, slot(s) 1,3 are listed because '), true);
  // ★ The guard on what the verify hands on: a whole failure with a slot left out says it; a failure that lists none does not.
  const outListed = (slots: number[], leftOut: number[]): number[] => slots.filter((n) => leftOut.includes(n));
  const wholeOut = decideForceCharge(onNight(RETRIED), JUDGED, runOpts({ slotsOn: [1], poolOutSlots: [1] }));
  const partOut = decideForceCharge(onNight(RETRIED), JUDGED, runOpts({ slotsOn: [3], poolOutSlots: [1] }));
  const wholeNone = decideForceCharge(onNight(RETRIED), JUDGED, runOpts({ slotsOn: [] }));
  assert.deepEqual([wholeOut.kind === 'onFailed' && outListed(wholeOut.slots, [1]), partOut.kind === 'onFailed' && outListed(partOut.slots, [1]), wholeNone.kind === 'onFailed' && outListed(wholeNone.slots, [])], [[1], [], []]);

  // ★ The push: the arguments of the release before, in their order, and outOfPoolSlots: pool.leftOut after them — the last.
  assert.match(f, /      await sendNotification\(loadNotifyConfig\(\), buildNightForceChargeOnFailure\(\{\n        day: state\.day, slots: action\.slots, ourSlots: state\.forceChargeSlots, retries: state\.forceChargeOnRetries,\n        noRetry: action\.noRetry === true,\n        \.\.\.forceChargeOnFailureNight\(state\),\n        cores: slotCores,\n        outOfPoolSlots: pool\.leftOut,[^\n]*\n      \}\)\);\n/, '★ outOfPoolSlots: pool.leftOut is the last argument');
  assert.equal(count(TICK, 'outOfPoolSlots:'), 1, 'handed on once');
  assert.equal(count(CODE, 'outOfPoolSlots'), 1, 'and read nowhere else in the integrator');
  assert.equal(count(CODE, 'buildNightForceChargeOnFailure({'), 1, 'the one push of an ON failure');
  // It is the list the DECISION was given (fcOpts.poolOutSlots), so a slot the verify listed for the pool is a slot the push names.
  assert.ok(TICK.includes('    poolOutSlots: pool.leftOut,'), 'the same list the verify was handed');
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

test('★★★ the morning summary names the slots the ON was not sent to: one clause, in every account of a force-charge that was switched ON, directly before the close\'s figures — and with none, the account without the field, to the letter', () => {
  type Summary = Parameters<typeof buildNightChargeMorningSummary>[0];
  type Outcome = NonNullable<Summary['forceCharge']>;
  type Close = NonNullable<Summary['cost']>;
  /** A cost night's summary (no outage line on the record): the reserve raised to 50, the force-charge toward ~80, which the evening notice named. */
  const say = (forceCharge: Outcome, cost: Partial<Close>): { title: string; body: string } => {
    const m = buildNightChargeMorningSummary({
      day: '2026-11-20', targetPct: 50, restorePct: 16, expectedKwh: 20, forceCharge,
      cost: { announcedLevelPct: 80, poolPct: 79, readLate: false, offReason: null, offAtMs: null, onReissues: 0, ...cost },
    });
    return { title: m.title, body: m.body };
  };
  /** Every account of a force-charge that was switched ON: it ran, it was never confirmed, it did not take effect (on every slot, or on some). */
  const switchedOn: Array<[string, Outcome]> = [
    ['ran', { kind: 'ran', stopPct: 80, expectedLeg: true }],
    ['never confirmed', { kind: 'unconfirmed', stopPct: 80, expectedLeg: true }],
    ['did not take effect', { kind: 'failed', stopPct: 80, expectedLeg: true, partialSlots: null }],
    ['did not take effect on slot 2', { kind: 'failed', stopPct: 80, expectedLeg: true, partialSlots: [2] }],
  ];
  /** How the force-charge ended (no OFF on the record, the window close, its stop, the grid lost), and how the close was read. */
  const offs: Array<Partial<Close>> = [
    { offReason: null, offAtMs: null }, { offReason: 'windowEnd', offAtMs: WIN_END },
    { offReason: 'target', offAtMs: WIN_END - 30 * MIN }, { offReason: 'gridLoss', offAtMs: WIN_END - 30 * MIN },
  ];
  const closes: Array<Partial<Close>> = [{ poolPct: 79, readLate: false }, { poolPct: 79, readLate: true }, { poolPct: null, readLate: false }];
  /** Lists that name no slot: the field absent, null, empty, and entries that are no slot of a panel. */
  const NONE: Array<number[] | null | undefined> = [undefined, null, [], [0], [-1, 2.5], [Number.NaN, Number.POSITIVE_INFINITY]];
  const prefixOf = (a: string, b: string): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  let accounts = 0;
  const shapes = new Set<string>();
  for (const [label, forceCharge] of switchedOn) {
    for (const off of offs) {
      for (const close of closes) {
        for (const onReissues of [0, 1]) {
          const cost: Partial<Close> = { ...off, ...close, onReissues };
          const tag = `${label}, ${JSON.stringify(cost)}`;
          const base = say(forceCharge, cost);
          assert.equal('leftOutSlots' in cost, false, 'control: the account without the field');
          assert.equal(base.body.includes('not switched on'), false, `control: nothing is said of a slot left out — ${tag}`);
          // ★ With no slot to name: the account without the field, title and body.
          for (const leftOutSlots of NONE) {
            assert.deepEqual(say(forceCharge, leftOutSlots === undefined ? cost : { ...cost, leftOutSlots }), base, `★ ${JSON.stringify(leftOutSlots)} — ${tag}`);
          }
          // ★ With slots: the same account and ONE clause more, naming those slots, directly before what the close read.
          for (const slots of [[1], [3], [1, 3], [1, 2, 3]]) {
            const named = say(forceCharge, { ...cost, leftOutSlots: slots });
            assert.equal(named.title, base.title, `the title is as it was — ${tag}`);
            assert.notEqual(named.body, base.body, `★ slot(s) ${slots.join(', ')} are named — ${tag}`);
            const at = prefixOf(base.body, named.body);
            const added = named.body.slice(at, named.body.length - (base.body.length - at));
            assert.equal(named.body, base.body.slice(0, at) + added + base.body.slice(at), `one insertion, the rest of the account to the letter — ${tag}`);
            assert.ok(added.includes(`slot(s) ${slots.join(', ')} not switched on`), `★ the clause names the slots, as the summary lists slots — ${tag}: ${added}`);
            assert.ok(/pool alarm/.test(added) && /backup pool/.test(added), `and says why — ${tag}: ${added}`);
            assert.equal(count(named.body, 'not switched on'), 1, `said once — ${tag}`);
            assert.match(base.body.slice(at), /^(?:; )?the pool (?:read|reads|was not read)\b/, `★ directly before the close's figures — ${tag}`);
            // An entry that is no slot is not named beside the slots that are.
            assert.deepEqual(say(forceCharge, { ...cost, leftOutSlots: [0, ...slots, 2.5, -3, Number.NaN] }), named, `only whole slots of 1 or more — ${tag}`);
          }
          accounts++;
          shapes.add(base.body.replace(/\d/g, '#'));
        }
      }
    }
  }
  assert.equal(accounts, 4 * 4 * 3 * 2);
  assert.ok(shapes.size >= 4 * 4, `the accounts differ: ${shapes.size} wordings`);
  // The four accounts by name, on a night that ended at the window close: each is the one it is said to be.
  const atClose = { offReason: 'windowEnd', offAtMs: WIN_END };
  assert.match(say(switchedOn[0][1], atClose).body, /and force-charge ran toward ~80% until the window close/);
  assert.match(say(switchedOn[1][1], atClose).body, /was switched ON but the panel never confirmed it/);
  assert.match(say(switchedOn[1][1], { offReason: 'target', offAtMs: WIN_END - 30 * MIN }).body, /with no readback showing every slot ON/);
  assert.match(say(switchedOn[2][1], atClose).body, /was switched ON but did not take effect, /);
  assert.match(say(switchedOn[3][1], atClose).body, /did not take effect on slot\(s\) 2 /);
  // A force-charge that never started was sent to no slot: nothing is said of a slot left out, whatever the field holds.
  const never: Outcome = { kind: 'neverStarted', stopPct: 80, expectedLeg: true };
  assert.match(say(never, atClose).body, /never started/, 'control');
  for (const off of offs) assert.deepEqual(say(never, { ...off, leftOutSlots: [1] }), say(never, off));
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
