/**
 * v1.209.0 (part C) — only the Cores in the panel's backup pool are counted for the force-charge's rate and sent ON.
 *
 * On 2026-11-16 a Core was out of the panel's backup pool. The pool's capacity and percent were the two-Core figures,
 * the force-charge's rate counted three Cores, and the start came late. The pool alarm (poolOut.ts, v1.208.0) knows the
 * count of slots out and, after a dwell of naming readings, which slots. This release reads that latched verdict
 * (poolOutRead), turns it into the slots an ON may go to and the count the rate is timed with (forceChargePoolSlots),
 * and keeps a slot left out from the ON, from the ON's re-issue and from the ON's failure verdict.
 *
 * Two rules outrank everything else, and most of this file states them as properties over every input:
 *  1. UNKNOWN EQUALS THE RELEASE BEFORE. With no standing alarm for the panel (no tracker state, no episode, a read that
 *     throws) every list, count and decision is the one v1.208.0 makes.
 *  2. THE TWO USES FAIL SAFE IN OPPOSITE DIRECTIONS. For the RATE a doubtful slot is counted OUT (the start comes
 *     earlier). For the ON TARGETS a doubtful slot is sent ON (a withheld ON costs a Core its charge for the night): a
 *     slot is left out only when it is NAMED, the return dwell is not running, and the verdict's data time is recent.
 *
 * Sections: (1) poolOutRead, and its agreement with the alarm's fault token and with pool_out_mask; (1b) the store's
 * contained reader; (2) forceChargePoolSlots over every input; (3) rule 1; (4) the start decision; (5) the ON verify;
 * (6) the integrator, as source pins on index.ts (it is not reachable from a unit test); (7) the record's field.
 *
 * NOT asserted here, and reported with this file instead of pinned: how a failure verdict that leaves a slot of ours
 * out is WORDED downstream (as a failure on some slots, or on all); which slots are withheld while the alarm's capacity
 * verdict cannot be judged, or while fewer slots read short than the alarm names; and the count the FALLBACK rate takes.
 *
 * Every src module is imported AFTER the environment below is set, as poolOutStore.test.ts does: section 1b builds a
 * real SnapshotStore, which keeps its files beside DB_PATH. Serials are the fixture's placeholders.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolOutState, PoolOutRead } from '../src/poolOut.js';
import type { ForceChargeOpts, ForceChargeAction, ForceChargePoolSlots } from '../src/nightForceCharge.js';
import type { NightActuationState, ArmablePlan } from '../src/nightChargeActuator.js';
import type { Body } from './fixtures/poolOutFixtures.js';

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
  forceChargeKwPerCore, planChargeCapKw, lineDeclinedPushStep, EMPTY_LINE_DECLINED_PUSH, LEGACY_CHARGE_CAP_KW,
} = nfc;
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

/* ══ 1. poolOutRead: the latched verdict, and nothing else ══════════════════════════════════════════ */

/** Slot 1 out, the alarm standing since minute 10 (raised and named by the real tracker). */
const EP = fx.withEpisode();
/** EP with its latched set and count replaced: the shapes a dwell-confirmed set change can leave. */
const latched = (slots: unknown, k: unknown, over: Record<string, unknown> = {}): PoolOutState =>
  ({ ...EP, episode: { ...EP.episode!, slots, k, ...over } }) as unknown as PoolOutState;
const twoOut = (seq: number): Body => fx.synthBody({ seq, capWh: fx.SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
/** States the real tracker reaches (the folds of poolOutText.test.ts). */
const REFERENCE = fx.withReference();
const STREAK = fx.fold(REFERENCE, fx.minutes(0, 5, fx.lostBody)).state;
const UNNAMED = fx.fold(REFERENCE, fx.minutes(0, 16, fx.quietLostBody)).state;
const TWO = fx.fold(REFERENCE, fx.minutes(0, 11, twoOut)).state;
const dip = (from: number) => [...fx.minutes(from, 2, fx.lostBody), ...fx.minutes(from + 2, 3, fx.healthyBody)];
const FLAP = fx.fold(REFERENCE, [...dip(0), ...dip(5), ...fx.minutes(10, 2, fx.lostBody)]).state;
const LARGER = fx.fold(UNNAMED, fx.minutes(16, 2, twoOut)).state;
const CLEARING = fx.fold(EP, fx.minutes(11, 3, fx.healthyBody)).state;

/** Every latched (slots, count) shape: named in full, partly named, not named (null and the empty list). */
const SHAPES: Array<{ slots: number[] | null; k: number; named: number[] }> = [
  { slots: [1], k: 1, named: [1] }, { slots: [2], k: 1, named: [2] }, { slots: [3], k: 1, named: [3] },
  { slots: [1, 2], k: 2, named: [1, 2] }, { slots: [1, 3], k: 2, named: [1, 3] }, { slots: [2, 3], k: 2, named: [2, 3] },
  { slots: [1, 2, 3], k: 3, named: [1, 2, 3] },
  { slots: [1], k: 2, named: [1] }, { slots: [3], k: 2, named: [3] }, { slots: [2], k: 3, named: [2] }, { slots: [1, 3], k: 3, named: [1, 3] },
  { slots: null, k: 1, named: [] }, { slots: null, k: 2, named: [] }, { slots: null, k: 3, named: [] },
  { slots: [], k: 1, named: [] }, { slots: [], k: 2, named: [] },
];

test('★★★ no tracker state, and no episode standing: nothing named, nothing counted, never returning', () => {
  assert.deepEqual(poolOutRead(null), { named: [], count: 0, returning: false, asOfMs: null });
  assert.deepEqual(poolOutRead(undefined), { named: [], count: 0, returning: false, asOfMs: null });
  assert.deepEqual(poolOutRead(emptyPoolOutState()), { named: [], count: 0, returning: false, asOfMs: null }, 'a tracker that has folded nothing');
  assert.deepEqual(poolOutRead(REFERENCE), { named: [], count: 0, returning: false, asOfMs: fx.at(-1) }, 'a healthy pool: the data time alone');
  // Five minutes of a Core out, every reading naming slot 1: a streak, not yet an alarm. Nothing is read from it.
  assert.deepEqual([STREAK.episode, STREAK.streak?.slots, STREAK.streak?.k], [null, [1], 1], 'control: the streak names slot 1');
  assert.deepEqual(poolOutRead(STREAK), { named: [], count: 0, returning: false, asOfMs: fx.at(4) }, '★ a streak before its raise names nothing and counts nothing');
});

test('★★★ every latched shape: the named slots, the count (named or not), from the episode alone', () => {
  for (const { slots, k, named } of SHAPES) {
    assert.deepEqual(poolOutRead(latched(slots, k)), { named, count: k, returning: false, asOfMs: fx.at(10) }, `slots ${JSON.stringify(slots)}, k ${k}`);
  }
  // The states the tracker itself reaches.
  assert.deepEqual(poolOutRead(EP), { named: [1], count: 1, returning: false, asOfMs: fx.at(10) });
  assert.deepEqual(poolOutRead(UNNAMED), { named: [], count: 1, returning: false, asOfMs: fx.at(15) }, 'raised on the capacity alone: counted, not named');
  assert.deepEqual(poolOutRead(TWO), { named: [1, 3], count: 2, returning: false, asOfMs: fx.at(10) });
});

test('★★★ only the LATCHED set: a set still on its way through a dwell, and one reading\'s verdicts, name nothing', () => {
  // A flap raise: its readings point at slot 1 (episode.change), the title names none.
  assert.deepEqual([FLAP.episode?.how, FLAP.episode?.slots, FLAP.episode?.change?.slots], ['flap', null, [1]], 'control');
  assert.deepEqual(poolOutRead(FLAP), { named: [], count: 1, returning: false, asOfMs: fx.at(11) }, '★ never the pending set');
  // A LARGER count on its way through a dwell of its own: the latched count stands.
  assert.deepEqual([LARGER.episode?.k, LARGER.episode?.change?.k, LARGER.episode?.change?.slots], [1, 2, [1, 3]], 'control');
  assert.deepEqual(poolOutRead(LARGER), { named: [], count: 1, returning: false, asOfMs: fx.at(17) }, '★ never the pending count');
  // The newest reading's own verdicts name slot 1 (EP.last); with the latched set emptied the read names none.
  assert.deepEqual(EP.last?.flow.set, [1], 'control: the newest reading points at slot 1');
  assert.deepEqual(poolOutRead(latched(null, 1)).named, []);
});

test('★★ returning: the clear dwell is running — and that alone; the names and the count stand through it', () => {
  assert.equal(CLEARING.episode?.clear != null, true, 'control: three healthy readings started the clear');
  assert.deepEqual(poolOutRead(CLEARING), { named: [1], count: 1, returning: true, asOfMs: fx.at(13) }, 'the alarm still stands and still names slot 1');
  const clear = CLEARING.episode!.clear;
  for (const { slots, k, named } of SHAPES) {
    assert.deepEqual(poolOutRead(latched(slots, k, { clear })), { named, count: k, returning: true, asOfMs: fx.at(10) });
    assert.equal(poolOutRead(latched(slots, k, { clear: null })).returning, false);
    assert.equal(poolOutRead(latched(slots, k, { clear: undefined })).returning, false);
  }
});

test('★★★ hostile state: a slot that is not an integer in 1..3 is left out, a count that is not a non-negative integer is 0', () => {
  const named = (slots: unknown): number[] => poolOutRead(latched(slots, 1)).named;
  assert.deepEqual(named([0, 4, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined, {}, [1], true, 2]), [2], 'only the real slot is kept');
  assert.deepEqual(named([3, 1]), [1, 3], 'ascending, whatever the state holds');
  assert.deepEqual(named([1, 1, 3, 3, 3]), [1, 3], 'each slot once');
  assert.deepEqual(named([SHP2_SOURCE_SLOTS + 1]), []);
  for (const notAList of ['1', 1, true, { 0: 1, length: 1 }, new Set([1])]) assert.deepEqual(named(notAList), [], `${String(notAList)}: not a list, nothing named`);
  const count = (k: unknown): number => poolOutRead(latched([1], k)).count;
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined, {}, [2], true]) assert.equal(count(bad), 0, `count ${String(bad)}`);
  assert.deepEqual([count(0), count(1), count(2), count(3)], [0, 1, 2, 3]);
  // The data time is handed on as the state holds it; null with none.
  assert.equal(poolOutRead({ ...EP, lastUsableMs: null }).asOfMs, null);
  assert.equal(poolOutRead({ ...EP, lastUsableMs: 12345 }).asOfMs, 12345);
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
});

test('★★ asOfMs is the DATA time of the newest usable reading: skipped bodies leave it, and the alarm stands through them', () => {
  // Thirty minutes of bodies from a panel the cloud lists offline, and thirty under the stale-shadow latch: none is an observation.
  for (const extra of [{ online: false }, { latched: true }]) {
    const blind = fx.fold(EP, fx.minutes(11, 30, fx.lostBody, extra)).state;
    assert.deepEqual(poolOutRead(blind), { named: [1], count: 1, returning: false, asOfMs: fx.at(10) }, JSON.stringify(extra));
  }
  // A usable body moves it.
  assert.equal(poolOutRead(fx.fold(EP, fx.minutes(11, 4, fx.lostBody)).state).asOfMs, fx.at(14));
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

test('★★★ AGREEMENT: the slots read are the slots in the alarm\'s fault token and the bits of pool_out_mask below 128 — every episode shape', () => {
  assert.equal(POOL_OUT_MASK_UNIDENTIFIED, 128);
  const states: Array<[string, PoolOutState]> = [
    ...SHAPES.map(({ slots, k }): [string, PoolOutState] => [`slots ${JSON.stringify(slots)}, k ${k}`, latched(slots, k)]),
    ...SHAPES.map(({ slots, k }): [string, PoolOutState] => [`slots ${JSON.stringify(slots)}, k ${k}, clearing`, latched(slots, k, { clear: CLEARING.episode!.clear })]),
    ['raised and named', EP], ['raised on capacity alone', UNNAMED], ['two named', TWO], ['a flap raise', FLAP], ['a larger count pending', LARGER], ['the clear running', CLEARING],
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
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), { named: [], count: 0, returning: false, asOfMs: null }, 'before any body: no alarm');
  for (let m = -15; m < 0; m++) feed(m, fx.healthyBody);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN), { named: [], count: 0, returning: false, asOfMs: fx.at(-1) }, 'a healthy pool');
  for (let m = 0; m <= 10; m++) feed(m, fx.lostBody);
  const read = store.poolOutRead(fx.PANEL_SN);
  assert.deepEqual(read, { named: [1], count: 1, returning: false, asOfMs: fx.at(10) }, '★ slot 1 out, named after the dwell');
  assert.deepEqual(read, poolOutRead(store.poolRecord(fx.PANEL_SN).state), 'the pure reader over the state the recorder is given');
  read!.named.push(3);
  assert.deepEqual(store.poolOutRead(fx.PANEL_SN)!.named, [1], 'a copy each time');
  assert.deepEqual(store.poolOutRead('HD31XXX00XXX0002'), { named: [], count: 0, returning: false, asOfMs: null }, '★ another panel\'s serial: its own (empty) verdict, never this panel\'s');
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

/* ══ 2. forceChargePoolSlots: every input ═══════════════════════════════════════════════════════════ */

const NOW = Date.UTC(2026, 10, 21, 10, 0); // 03:00 MST, inside an overnight window
const read = (over: Partial<PoolOutRead> = {}): PoolOutRead => ({ named: [], count: 0, returning: false, asOfMs: NOW - MIN, ...over });
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
/** Every verdict: each named set, each count 0..4 (below, at and above the names; above the panel's three), returning or not, each age. */
const POOLS: Array<{ pool: PoolOutRead; fresh: boolean }> = SUBSETS.flatMap((named) => [0, 1, 2, 3, 4].flatMap((count) =>
  [false, true].flatMap((returning) => AGES.map(({ asOfMs, fresh }) => ({ pool: { named, count, returning, asOfMs }, fresh })))));

test('the pool-out sensor\'s own freshness limit is the ON\'s: 15 minutes', () => {
  assert.equal(POOL_OUT_SENSOR_FRESH_MS, 15 * MIN);
  assert.deepEqual([CONNECTED.length, POOLS.length], [16, 880], 'the grid below: 16 connected lists × 880 verdicts');
});

test('★★★ EXHAUSTIVE: targets and leftOut partition `connected` in its order; a slot is left out only when named, not returning and fresh', () => {
  let cases = 0;
  let withheld = 0;
  for (const connected of CONNECTED) {
    for (const { pool, fresh } of POOLS) {
      cases++;
      const p = forceChargePoolSlots(connected, pool, NOW);
      const tag = `connected ${JSON.stringify(connected)}, pool ${JSON.stringify(pool)}`;
      // A partition, order kept.
      assert.deepEqual(connected.filter((n) => p.targets.includes(n)), p.targets, `targets in order — ${tag}`);
      assert.deepEqual(connected.filter((n) => p.leftOut.includes(n)), p.leftOut, `leftOut in order — ${tag}`);
      assert.equal(p.targets.length + p.leftOut.length, connected.length, `every connected slot is in exactly one — ${tag}`);
      assert.equal(p.targets.some((n) => p.leftOut.includes(n)), false, `disjoint — ${tag}`);
      // The ON's rule, stated on its own.
      const mayAct = pool.named.length > 0 && pool.returning === false && fresh;
      assert.deepEqual(p.leftOut, mayAct ? connected.filter((n) => pool.named.includes(n)) : [], `leftOut — ${tag}`);
      if (p.leftOut.length > 0) {
        withheld++;
        assert.equal(p.leftOut.every((n) => pool.named.includes(n)), true, `only a NAMED slot is withheld — ${tag}`);
      }
    }
  }
  assert.equal(cases, 16 * 880);
  assert.ok(withheld > 0, 'the grid does withhold somewhere');
});

test('★★★ EXHAUSTIVE: rateCount = connected − outCount; never under 1 while a slot is connected, 0 with none, never above the connected count', () => {
  let cases = 0;
  let floored = 0;
  for (const connected of CONNECTED) {
    for (const { pool } of POOLS) {
      cases++;
      const p = forceChargePoolSlots(connected, pool, NOW);
      const tag = `connected ${JSON.stringify(connected)}, pool ${JSON.stringify(pool)}`;
      const n = connected.length;
      assert.equal(Number.isInteger(p.rateCount) && Number.isInteger(p.outCount), true, tag);
      assert.equal(p.rateCount, n - p.outCount, `rateCount is connected less outCount — ${tag}`);
      assert.equal(p.outCount >= 0, true, `outCount is never negative — ${tag}`);
      assert.equal(p.rateCount <= n, true, `never above the connected count — ${tag}`);
      assert.equal(p.rateCount >= (n > 0 ? 1 : 0), true, `★ never under 1 while a slot is connected — ${tag}`);
      if (n === 0) assert.deepEqual([p.rateCount, p.outCount], [0, 0], `none connected stays 0 ("unknown" downstream) — ${tag}`);
      // The count out, from the specification: the named slots that are connected, plus the slots short and not identified.
      const namedConnected = connected.filter((s) => pool.named.includes(s)).length;
      const wanted = namedConnected + Math.max(0, pool.count - pool.named.length);
      const noAlarm = pool.count === 0 && pool.named.length === 0;
      const expected = n === 0 ? 0 : noAlarm ? n : Math.max(1, n - wanted);
      assert.equal(p.rateCount, expected, `rateCount — ${tag}`);
      if (n > 0 && !noAlarm && n - wanted < 1) floored++;
    }
  }
  assert.equal(cases, 16 * 880);
  assert.ok(floored > 0, 'the grid reaches the floor of 1');
});

test('★★★ EXHAUSTIVE: the RATE counts a doubtful slot out — its count does not depend on the verdict\'s age or on the return dwell; only the ON does', () => {
  for (const connected of CONNECTED) {
    for (const named of SUBSETS) {
      for (const count of [0, 1, 2, 3, 4]) {
        const rates = new Set<string>();
        for (const returning of [false, true]) {
          for (const { asOfMs } of AGES) {
            const p = forceChargePoolSlots(connected, { named, count, returning, asOfMs }, NOW);
            rates.add(`${p.rateCount}/${p.outCount}`);
            // A slot kept as a target on a doubtful verdict is still counted OUT of the rate.
            const namedConnected = connected.filter((n) => named.includes(n)).length;
            if (p.leftOut.length === 0 && namedConnected > 0 && connected.length > namedConnected) {
              assert.equal(p.outCount >= namedConnected, true, `connected ${JSON.stringify(connected)}, named ${JSON.stringify(named)}, count ${count}`);
            }
          }
        }
        assert.equal(rates.size, 1, `one rate count for every age and both dwell states — connected ${JSON.stringify(connected)}, named ${JSON.stringify(named)}, count ${count}: ${[...rates].join(' ')}`);
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
  const at = (asOfMs: number | null): ForceChargePoolSlots => forceChargePoolSlots([1, 2, 3], { named: [1], count: 1, returning: false, asOfMs }, NOW);
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
  for (const { pool } of POOLS) assert.deepEqual(forceChargePoolSlots([], pool, NOW), { targets: [], leftOut: [], rateCount: 0, outCount: 0 }, JSON.stringify(pool));
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

test('★★ a verdict object that is not a sound read withholds nothing, and never breaks the count', () => {
  const hostile: unknown[] = [
    { named: [1], count: 1, returning: undefined, asOfMs: NOW }, { named: [1], count: 1, returning: null, asOfMs: NOW },
    { named: [1], count: 1, returning: 0, asOfMs: NOW }, { named: [1], count: 1, returning: 'false', asOfMs: NOW },
    { named: [1], count: 1, returning: false, asOfMs: String(NOW) }, { named: [1], count: 1, returning: false },
    { named: '1', count: 1, returning: false, asOfMs: NOW }, { named: null, count: 1, returning: false, asOfMs: NOW },
    { count: 1, returning: false, asOfMs: NOW }, { named: [], count: 1.5, returning: false, asOfMs: NOW },
    { named: [], count: -2, returning: false, asOfMs: NOW }, { named: [], count: '1', returning: false, asOfMs: NOW }, {},
  ];
  for (const pool of hostile) {
    for (const connected of CONNECTED) {
      const p = forceChargePoolSlots(connected, pool as PoolOutRead, NOW);
      const tag = `connected ${JSON.stringify(connected)}, pool ${JSON.stringify(pool)}`;
      assert.deepEqual(p.leftOut, [], `nothing withheld — ${tag}`);
      assert.deepEqual(p.targets, connected, `every connected slot a target — ${tag}`);
      assert.equal(p.rateCount >= (connected.length > 0 ? 1 : 0) && p.rateCount <= connected.length && p.rateCount === connected.length - p.outCount, true, tag);
    }
  }
});

/* ══ 3. rule 1: no verdict is the release before ═════════════════════════════════════════════════════ */

/** Every way "no standing alarm" reaches forceChargePoolSlots. */
const NO_VERDICT: Array<[string, PoolOutRead | null | undefined]> = [
  ['null (the store\'s read failed)', null], ['undefined', undefined],
  ['no tracker state', poolOutRead(null)], ['an empty tracker', poolOutRead(emptyPoolOutState())],
  ['a healthy pool', poolOutRead(REFERENCE)], ['a streak before its raise', poolOutRead(STREAK)],
  ['nothing counted, nothing named', { named: [], count: 0, returning: false, asOfMs: null }],
  ['the same on a recent reading', { named: [], count: 0, returning: false, asOfMs: NOW }],
  ['the same, marked returning', { named: [], count: 0, returning: true, asOfMs: NOW }],
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

/** The tick's composition, as section 6 pins it in index.ts: the list the decision is given, the rate's count, the slots left out. */
const tickCompose = (hwSlots: number[], pool: PoolOutRead | null | undefined, nowMs: number) => {
  const p = forceChargePoolSlots(hwSlots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS), pool, nowMs);
  return { pool: p, connectedSlots: p.leftOut.length > 0 ? p.targets : hwSlots, slotCount: p.rateCount, poolOutSlots: p.leftOut };
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
/** A failure verdict as [kind, slots, noRetry]. The slots are what this file states; how a failure that leaves a slot of
 *  ours out is WORDED downstream (as a failure on some slots, or on all) is not asserted here. */
const failureOf = (a: ForceChargeAction): unknown[] => (a.kind === 'onFailed' ? [a.kind, a.slots, a.noRetry === true] : [a.kind]);

test('★★★ RULE 1 at the tick: with no verdict the decision is given the connected list itself, the old count, and no slot left out — and decides as before', () => {
  const lists: number[][] = [[1, 2, 3], [3, 1, 2], [2], [], [1, 3, 7], [0, 2]];
  for (const [label, pool] of NO_VERDICT) {
    for (const hw of lists) {
      const c = tickCompose(hw, pool, NOW);
      assert.equal(c.connectedSlots, hw, `${label}: the list above itself, not a filtered copy — ${JSON.stringify(hw)}`);
      assert.equal(c.slotCount, hw.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS).length, `${label}: the count v1.208.0 passed — ${JSON.stringify(hw)}`);
      assert.deepEqual(c.poolOutSlots, []);
      // The decision: every stage of a night, with the new field and without it.
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
      ];
      for (const [s, t, before] of stages) {
        const now = decideForceCharge(s, t, { ...before, connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots });
        assert.deepEqual(now, decideForceCharge(s, t, before), `${label}, ${JSON.stringify(hw)}, t ${t}`);
        if (now.kind === 'onVerified') assert.equal('outOfPool' in now, false, 'the old shape, no new key');
      }
    }
  }
});

/* ══ 4. the start: a slot left out is no candidate ═══════════════════════════════════════════════════ */

test('★★ the control: three connected, no alarm — ON to all three; none connected — "no battery slots are connected"', () => {
  assert.deepEqual(decideForceCharge(verifiedNight(), MID, startOpts()), { kind: 'on', slots: [1, 2, 3] });
  const none = decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: [] }));
  assert.deepEqual(none, { kind: 'none', why: 'no battery slots are connected' });
  assert.equal(forceChargeBlockerClass(whyOf(none)), 'noSlots');
});

test('★★★ EXHAUSTIVE: a slot left out is never in an ON\'s slots; the ON goes to exactly the targets, in order', () => {
  let ons = 0;
  let refusals = 0;
  for (const hw of CONNECTED) {
    for (const { pool } of POOLS) {
      const c = tickCompose(hw, pool, NOW);
      const a = decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots }));
      const tag = `connected ${JSON.stringify(hw)}, pool ${JSON.stringify(pool)}`;
      if (a.kind === 'on') {
        ons++;
        assert.equal(a.slots.some((n) => c.pool.leftOut.includes(n)), false, `★ an ON to a slot left out — ${tag}`);
        assert.deepEqual(a.slots, c.pool.targets, `the ON's slots are the targets — ${tag}`);
        assert.equal(a.slots.every((n) => hw.includes(n)), true, tag);
      } else {
        refusals++;
        assert.equal(a.kind, 'none', tag);
        assert.equal(c.pool.targets.length, 0, `a refusal only with no target — ${tag}`);
        assert.equal(whyOf(a), hw.length === 0 ? FORCE_CHARGE_BLOCKER_WHY.noSlots : FORCE_CHARGE_BLOCKER_WHY.noPoolSlots, tag);
      }
    }
  }
  assert.ok(ons > 0 && refusals > 0, `${ons} ONs, ${refusals} refusals`);
});

test('★★★ every connected slot left out: a refusal of its own — its words, its class, a blocker; never "no battery slots are connected"', () => {
  const W = FORCE_CHARGE_BLOCKER_WHY;
  assert.equal(W.noPoolSlots, 'every connected battery slot is left out: the pool alarm names its Core out of the panel\'s backup pool');
  const c = tickCompose([1, 2, 3], read({ named: [1, 2, 3], count: 3 }), NOW);
  assert.deepEqual([c.connectedSlots, c.poolOutSlots], [[], [1, 2, 3]]);
  const a = decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots }));
  assert.deepEqual(a, { kind: 'none', why: W.noPoolSlots });
  assert.equal(forceChargeBlockerClass(whyOf(a)), 'noPoolSlots', '★ its own class');
  assert.notEqual(forceChargeBlockerClass(whyOf(a)), 'noSlots');
  assert.equal(isForceChargeStartBlocker(whyOf(a)), true, 'a blocker: a line night held by it is pushed, not silent');
  // One connected slot, and it is the one named.
  const one = tickCompose([2], read({ named: [2], count: 1 }), NOW);
  assert.equal(whyOf(decideForceCharge(verifiedNight(), MID, startOpts({ connectedSlots: one.connectedSlots, poolOutSlots: one.poolOutSlots }))), W.noPoolSlots);
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

test('★★★ a line RE-ON is an ON target too: a slot of ours named out is not switched back on; on a doubtful verdict it is', () => {
  // A line night whose verified ON the panel switched off at its 80% ceiling; the pool back under the start target.
  const latchedOff = verifiedNight({
    forceChargeCeilingPct: null, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55, forceChargeRides: true,
    forceChargeOnAtMs: WIN_START + 2 * H, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: WIN_START + 2 * H + 5 * MIN,
    forceChargeMode: 'line', forceChargeCeilingSyncedPct: 80, forceChargeOnLastAttemptMs: WIN_START + 2 * H,
  } as Partial<NightActuationState>);
  const t = WIN_END - H;
  const o = (c: ReturnType<typeof tickCompose>): ForceChargeOpts => ({
    ...startOpts({ enabled: false, ceilingReadbackPct: 80, poolSocPct: 60, fullKwh: 92.16, chargeRateKw: 14, slotSocPct: { 1: 60, 2: 60, 3: 60 } }),
    lineEnabled: true, connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots,
  } as ForceChargeOpts);
  assert.deepEqual(decideForceCharge(latchedOff, t, o(tickCompose([1, 2, 3], null, t))), { kind: 'lineReOn', slots: [1, 2, 3] }, 'control: no alarm, all three switched back on');
  assert.deepEqual(decideForceCharge(latchedOff, t, o(tickCompose([1, 2, 3], { named: [1], count: 1, returning: false, asOfMs: t - MIN }, t))), { kind: 'lineReOn', slots: [2, 3] }, '★ slot 1 named out: not switched back on');
  assert.deepEqual(decideForceCharge(latchedOff, t, o(tickCompose([1, 2, 3], { named: [1], count: 1, returning: true, asOfMs: t - MIN }, t))), { kind: 'lineReOn', slots: [1, 2, 3] }, 'the return dwell running: switched back on');
  assert.deepEqual(decideForceCharge(latchedOff, t, o(tickCompose([1, 2, 3], { named: [1], count: 1, returning: false, asOfMs: t - FRESH - 1 }, t))), { kind: 'lineReOn', slots: [1, 2, 3] }, 'a verdict past the limit: switched back on');
});

test('★★★ the RATE: with a Core counted out the bound is two Cores\', the start comes earlier, and the count is never the 0 that lifts the bound', () => {
  const LEG = Math.sqrt(0.86);
  const perCore = forceChargeKwPerCore();
  const rateOf = (c: ReturnType<typeof tickCompose>): number => forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 1, legEff: LEG, slotCount: c.slotCount })!;
  const all = tickCompose([1, 2, 3], null, NOW);
  const named = tickCompose([1, 2, 3], read({ named: [1], count: 1 }), NOW);
  const unnamed = tickCompose([1, 2, 3], read({ count: 1 }), NOW);
  const stale = tickCompose([1, 2, 3], read({ named: [1], count: 1, asOfMs: NOW - 24 * H }), NOW);
  assert.equal(rateOf(all), 16 * LEG, 'three Cores: the grid cap less the house binds, as before');
  for (const c of [named, unnamed, stale]) assert.equal(rateOf(c), 2 * perCore, 'two Cores in the pool: bounded by what two take');
  // Timed on the two-Core pool the panel reports (61.44 kWh), 50% → 90%.
  const start = (rate: number): number => forceChargeStartAtMs(WIN_END, 90, 50, 61.44, rate);
  assert.ok(start(rateOf(named)) < start(rateOf(all)) - 30 * MIN, 'the start is more than half an hour earlier');
  const between = start(rateOf(all)) - 10 * MIN;
  const at = (c: ReturnType<typeof tickCompose>): ForceChargeAction => decideForceCharge(verifiedNight(), between,
    startOpts({ poolSocPct: 50, fullKwh: 61.44, chargeRateKw: rateOf(c), connectedSlots: c.connectedSlots, poolOutSlots: c.poolOutSlots }));
  assert.equal(at(all).kind, 'none', 'timed for three, this minute is too early');
  assert.deepEqual(at(named), { kind: 'on', slots: [2, 3] }, '★ timed for two: already due, and sent to the two in the pool');
  assert.deepEqual(at(unnamed), { kind: 'on', slots: [1, 2, 3] }, '★ a slot out but not identified: the earlier start, and ON to all three');
  assert.deepEqual(at(stale), { kind: 'on', slots: [1, 2, 3] }, '★ a verdict a day old: the earlier start, and ON to all three');
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
  // Named out, and reading ON: nothing was exempted.
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

test('★★★ a slot out of the pool is in no re-issue and in no failure\'s slots', () => {
  const o = (slotsOn: number[]): ForceChargeOpts => runOpts({ slotsOn, poolOutSlots: [1] });
  // Slot 3 reads ON; 1 (out of the pool) and 2 read OFF: only slot 2 is re-issued, then only slot 2 has failed.
  assert.deepEqual(decideForceCharge(onNight(), DUE - 1, o([3])), { kind: 'none' }, 'inside the grace');
  assert.deepEqual(decideForceCharge(onNight(), DUE, o([3])), { kind: 'onRetry', slots: [2] }, '★ not slot 1');
  const retried = onNight({ forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: DUE });
  assert.deepEqual(failureOf(decideForceCharge(retried, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, o([3]))), ['onFailed', [2], false], '★ not slot 1');
  // Nothing reads ON: the re-issue and the failure are for 2 and 3.
  assert.deepEqual(decideForceCharge(onNight(), DUE, o([])), { kind: 'onRetry', slots: [2, 3] });
  assert.deepEqual(failureOf(decideForceCharge(retried, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, o([]))), ['onFailed', [2, 3], false]);
  // Too close to the close for a re-issue: the forfeit names the slots still off, less the one out of the pool.
  assert.deepEqual(failureOf(decideForceCharge(onNight(), WIN_END - 10 * MIN, o([3]))), ['onFailed', [2], true]);
  // The controls, with no slot named: slot 1 is in each.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [3] })), { kind: 'onRetry', slots: [1, 2] });
  assert.deepEqual(decideForceCharge(retried, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, runOpts({ slotsOn: [] })), { kind: 'onFailed', slots: [1, 2, 3] });
});

test('★★★ every slot of ours out of the pool and none reading ON: NOT verified — and nothing re-issued, nothing judged failed', () => {
  const o = runOpts({ slotsOn: [], connectedSlots: [], poolOutSlots: [1, 2, 3] });
  const retried = onNight({ forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: DUE });
  for (const [s, t] of [[onNight(), ON_AT + 3 * MIN], [onNight(), DUE], [onNight(), DUE + 30 * MIN], [retried, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS], [onNight(), WIN_END - 10 * MIN]] as Array<[NightActuationState, number]>) {
    assert.deepEqual(decideForceCharge(s, t, o), { kind: 'none' }, `t ${t}`);
  }
  // The rule that a verified verdict needs a slot of ours reading ON is unchanged: one reading ON verifies, the rest out of the pool.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [2], connectedSlots: [], poolOutSlots: [1, 2, 3] })), { kind: 'onVerified', atCeiling: [], outOfPool: [1, 3] });
  // The control of v1.186.0: every Core at the ceiling and none reading ON is a re-issue to all, never a verdict.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [], slotSocPct: { 1: 90, 2: 90, 3: 90 } })), { kind: 'onRetry', slots: [1, 2, 3] });
  // …and with one of them out of the pool as well, the re-issue leaves that one out.
  assert.deepEqual(decideForceCharge(onNight(), DUE, runOpts({ slotsOn: [], slotSocPct: { 1: 90, 2: 90, 3: 90 }, poolOutSlots: [1] })), { kind: 'onRetry', slots: [2, 3] });
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
});

test('★★★ EXHAUSTIVE: the exemption is the ceiling\'s — the verdict with slots named out equals the verdict with those slots at the ceiling, each named as what it is', () => {
  const retried = { forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: DUE };
  const stages: Array<[string, Partial<NightActuationState>, number]> = [
    ['inside the grace', {}, ON_AT + 3 * MIN], ['the re-issue due', {}, DUE], ['after the re-issue', retried, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS],
    ['past the re-issue cutoff', {}, WIN_END - 10 * MIN], ['after the warning', { ...retried, forceChargeOnFailedAtMs: DUE + 20 * MIN }, DUE + 30 * MIN],
  ];
  let cases = 0;
  const kinds = new Set<string>();
  for (const ours of SUBSETS.filter((s) => s.length > 0)) {
    for (const slotsOn of SUBSETS) {
      for (const outOfPool of SUBSETS) {
        for (const atCeiling of SUBSETS) {
          for (const [label, over, t] of stages) {
            cases++;
            const s = onNight({ forceChargeSlots: ours, ...over });
            const socs = (hot: number[]): Record<number, number> => Object.fromEntries([1, 2, 3].map((n) => [n, hot.includes(n) ? 95 : 60]));
            const a = decideForceCharge(s, t, runOpts({ slotsOn, slotSocPct: socs(atCeiling), poolOutSlots: outOfPool }));
            const tag = `${label}: ours ${JSON.stringify(ours)}, ON ${JSON.stringify(slotsOn)}, out of the pool ${JSON.stringify(outOfPool)}, at the ceiling ${JSON.stringify(atCeiling)} → ${JSON.stringify(a)}`;
            kinds.add(a.kind);
            const oursOn = ours.filter((n) => slotsOn.includes(n));
            const oursOff = ours.filter((n) => !slotsOn.includes(n));
            if (a.kind === 'onVerified') {
              assert.equal(oursOn.length > 0, true, `★ verified with no slot of ours reading ON — ${tag}`);
              const out = a.outOfPool ?? [];
              assert.equal('outOfPool' in a, out.length > 0, `the key only when a slot is exempted — ${tag}`);
              assert.deepEqual(out, oursOff.filter((n) => outOfPool.includes(n)), `outOfPool — ${tag}`);
              assert.deepEqual(a.atCeiling, oursOff.filter((n) => !outOfPool.includes(n)), `atCeiling — ${tag}`);
              assert.equal(a.atCeiling.every((n) => atCeiling.includes(n)), true, `a slot listed at the ceiling is at it — ${tag}`);
            } else if (a.kind === 'onRetry' || a.kind === 'onFailed') {
              assert.equal(a.slots.length > 0, true, `never an empty re-issue or failure — ${tag}`);
              assert.equal(a.slots.every((n) => ours.includes(n)), true, tag);
              assert.equal(a.slots.some((n) => outOfPool.includes(n)), false, `★ a slot out of the pool re-issued or failed — ${tag}`);
            } else {
              assert.deepEqual(a, { kind: 'none' }, tag);
            }
            // The differential: the release before, with the named slots read as at the ceiling.
            const base = decideForceCharge(s, t, runOpts({ slotsOn, slotSocPct: socs([...atCeiling, ...outOfPool]) }));
            if (base.kind === 'onVerified') {
              assert.equal(a.kind, 'onVerified', tag);
              if (a.kind === 'onVerified') assert.deepEqual([...a.atCeiling, ...(a.outOfPool ?? [])].sort(), [...base.atCeiling].sort(), tag);
            } else if (base.kind === 'onRetry') {
              const left = base.slots.filter((n) => !outOfPool.includes(n));
              assert.deepEqual(a, left.length > 0 ? { kind: 'onRetry', slots: left } : { kind: 'none' }, tag);
            } else if (base.kind === 'onFailed') {
              const left = base.slots.filter((n) => !outOfPool.includes(n));
              assert.deepEqual(failureOf(a), left.length > 0 ? ['onFailed', left, base.noRetry === true] : ['none'], tag);
            } else {
              assert.deepEqual(a, base, tag);
            }
            // Rule 1 inside the verify: a set that names no slot of ours changes nothing; nor does an empty or absent one.
            if (!ours.some((n) => outOfPool.includes(n))) {
              assert.deepEqual(a, decideForceCharge(s, t, runOpts({ slotsOn, slotSocPct: socs(atCeiling) })), `no slot of ours named: the release before — ${tag}`);
            }
          }
        }
      }
    }
  }
  assert.equal(cases, 7 * 8 * 8 * 8 * 5);
  assert.deepEqual([...kinds].sort(), ['none', 'onFailed', 'onRetry', 'onVerified'], 'every verdict is reached');
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

test('★★★ index.ts: the rate takes rateCount; the decision is given leftOut as poolOutSlots, after slotSocPct', () => {
  assert.match(TICK, /  const chargeRateKw = forceChargeRateKw\(\{\n    gridCapKw, houseLoadKw, legEff: Math\.sqrt\(DISPATCH_ROUND_TRIP_EFFICIENCY\),\n    slotCount: pool\.rateCount,\n  \}\);\n/);
  assert.equal(TICK.includes('slotCount: connectedSlots'), false, 'no longer the connected count');
  const fcOpts = TICK.slice(TICK.indexOf('  const fcOpts: ForceChargeOpts = {\n'), TICK.indexOf('\n  };\n', TICK.indexOf('  const fcOpts: ForceChargeOpts = {\n')));
  assert.match(fcOpts, /\n    connectedSlots,\n    slotSocPct,[^\n]*\n    poolOutSlots: pool\.leftOut,[^\n]*\n/, 'connectedSlots, slotSocPct, then the new field');
  assert.equal(count(TICK, 'poolOutSlots:'), 1, 'passed once, to the decision that can start or re-issue an ON: the blind call, which only switches OFF, has none');
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

test('★★ index.ts: the logs name a slot left out as that, once a night before the ON, and never as "at the panel\'s ceiling"', () => {
  // Once a night, through the declined-start memory, keyed on numbers only.
  const said = TICK.indexOf("      if (pool.leftOut.length > 0 || pool.outCount > 0) {\n        const poolKey = `${pool.rateCount}|${pool.outCount}|${pool.leftOut.join(',')}`;\n        if (!forceChargeWhyLogged.reasons.has(poolKey)) {\n          forceChargeWhyLogged.reasons.add(poolKey);\n");
  assert.ok(said > 0, 'the once-a-night line, guarded on a slot left out or counted out');
  assert.ok(said > TICK.indexOf('    if (live && action.why) {\n') && said < TICK.indexOf("  if (action.kind === 'syncCeiling') {"), 'inside the declined-start block');
  // The ON line: nothing added with no slot left out; the rate note says "connected" unless a Core is counted out.
  const on = branch('on');
  assert.ok(on.includes("    const leftOutNote = pool.leftOut.length > 0 ? `; slot(s) ${pool.leftOut.join(',')} left out: the pool alarm names its Core out of the backup pool` : '';\n"));
  assert.ok(on.includes('    const boundCores = pool.outCount > 0 ? `${pool.rateCount} Core(s) in the pool` : `${slotsNow} connected Core(s)`;\n'));
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
