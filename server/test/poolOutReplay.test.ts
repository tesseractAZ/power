import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectShp2, type Shp2Projection } from '../src/ecoflow/project.js';
import { shp2ContentWitness, advanceContentFreshness, isContentStale, advanceShadowLatch, advanceBodySeen, type ContentFreshness, type ShadowLatch, type BodySeen } from '../src/shp2Shadow.js';
import {
  emptyPoolOutState, poolOutAlertParts, poolOutEndText, poolOutLatestEnd, poolOutSeverity, poolOutTitle,
  parsePoolOutFile, serializePoolOutFile, type PoolOutState,
} from '../src/poolOut.js';
import { shortenDetail } from '../src/ttsService.js';
import {
  loadPoolFixture, bodiesFromRows, capacityAt, foldBodies, PANEL_SN, CORE_SNS, FULL_WH, SLOT_WH, MIN, type TimedBody, type Folded,
} from './fixtures/poolOutFixtures.js';

/**
 * v1.208.0 — the loss of Sat 2026-11-14 23:35 MST and the return of Mon 2026-11-16 20:08 MST, replayed through the
 * real reader and the real tracker.
 *
 * THE FIXTURES ARE SYNTHETIC IN PART, and say so. Their rows are the recorder's 5-minute means of the panel's own
 * series; the recorder stored neither the pool capacity, nor a flag, nor the circuit watts at the time. The builder
 * expands each row to five 60 s bodies and adds the capacity (from the two instants Home Assistant's history gives), a
 * remainder, the flags of the one raw sample on record, empty error lists and a MOVING twelve-circuit vector. What these
 * tests establish is therefore the tracker's behaviour on that model of the night — not the panel's poll-level behaviour,
 * which nobody recorded.
 *
 * Every "the alarm is there at T" is paired with "it is not there one body earlier", and the control tests below hold
 * on the fixture alone: each body is new content, the shadow latch stays clear, and the capacity reads 61,440 Wh after
 * the loss.
 */

const TZ = 'America/Phoenix';
const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());
const LOSS = loadPoolFixture('pool-loss-1114');
const RETURN = loadPoolFixture('pool-return-1116');
const lossBodies = bodiesFromRows(LOSS.rows, (t) => capacityAt(LOSS.capacity, t));
const returnBodies = bodiesFromRows(RETURN.rows, (t) => capacityAt(RETURN.capacity, t));
const stateAt = (f: Folded, bodies: TimedBody[], isoTime: string): PoolOutState => {
  const i = bodies.findIndex((b) => b.atMs === Date.parse(isoTime));
  assert.ok(i >= 0, `no body at ${isoTime}`);
  return f.steps[i].state;
};
const eventsOf = (f: Folded): Array<[string, string | null]> => f.steps.flatMap((s) => s.events.map((e) => [e.type, iso(e.atMs)] as [string, string | null]));

test('the fixtures: fifteen rows each, placeholder serials only, and they say what is synthetic', () => {
  for (const [fx, first, last] of [[LOSS, '2026-11-15T06:00Z', '2026-11-15T07:10Z'], [RETURN, '2026-11-17T02:30Z', '2026-11-17T03:40Z']] as const) {
    assert.equal(fx.rows.length, 15);
    assert.deepEqual([fx.rows[0][0], fx.rows[14][0]], [first, last]);
    assert.match(fx.note, /^SYNTHETIC IN PART\./);
    assert.match(fx.note, /MOVING twelve-circuit vector/);
    assert.equal(fx.panelSn, PANEL_SN);
    assert.deepEqual(fx.coreSns, CORE_SNS);
    assert.deepEqual(fx.capacity, { fullWh: FULL_WH, shortWh: 2 * SLOT_WH, shortFromIso: '2026-11-15T06:35:12Z', shortUntilIso: '2026-11-17T03:08:03Z' });
    assert.equal(fx.columns.length, 18);
    for (const row of fx.rows) assert.equal(row.length, 18);
  }
  for (const sn of [PANEL_SN, ...CORE_SNS]) assert.match(sn.slice(4), /^[X0]{10}[0-9]{2}$/, 'the placeholder shape: letters as X, digits as 0, a two-digit index');
});

test('★ control: every fixture body is NEW content and the shadow latch stays clear (the real shadow functions)', () => {
  for (const bodies of [lossBodies, returnBodies]) {
    assert.equal(bodies.length, 75);
    let fresh: ContentFreshness | undefined;
    let latch: ShadowLatch | undefined;
    let seen: BodySeen | undefined;
    let prevAt = Number.NEGATIVE_INFINITY;
    for (const b of bodies) {
      assert.equal(b.atMs - prevAt === MIN || prevAt === Number.NEGATIVE_INFINITY, true, 'one body a minute');
      prevAt = b.atMs;
      const witness = shp2ContentWitness(projectShp2(b.body));
      assert.notEqual(witness, null);
      fresh = advanceContentFreshness(fresh, witness, b.atMs);
      latch = advanceShadowLatch(latch, fresh, isContentStale(fresh, b.atMs));
      const step = advanceBodySeen(seen, witness, latch != null);
      seen = step.seen;
      assert.equal(latch, undefined, `latched at ${iso(b.atMs)}`);
      assert.equal(step.isNew, true, `not new at ${iso(b.atMs)}`);
    }
  }
});

test('★ control: the projection reads 92,160 Wh before the loss, 61,440 Wh after it, and 92,160 Wh again after the return', () => {
  const capAt = (bodies: TimedBody[], isoTime: string): number | null => {
    const b = bodies.find((x) => x.atMs === Date.parse(isoTime));
    assert.ok(b, isoTime);
    const p = projectShp2(b.body) as Shp2Projection;
    assert.notEqual(p.backupBatPercent, null, 'a coherent trio');
    return p.backupFullCapWh;
  };
  assert.equal(capAt(lossBodies, '2026-11-15T06:34:00Z'), 92160);
  assert.equal(capAt(lossBodies, '2026-11-15T06:35:00Z'), 92160, 'twelve seconds before the loss');
  assert.equal(capAt(lossBodies, '2026-11-15T06:36:00Z'), 61440);
  assert.equal(capAt(lossBodies, '2026-11-15T07:14:00Z'), 61440);
  assert.equal(capAt(returnBodies, '2026-11-17T03:08:00Z'), 61440, 'three seconds before the return');
  assert.equal(capAt(returnBodies, '2026-11-17T03:09:00Z'), 92160);
  // The bodies carry the placeholder serials and no other serial-shaped token.
  const text = JSON.stringify([...lossBodies, ...returnBodies].map((b) => b.body));
  const shaped = new Set(text.match(/(?<![A-Za-z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])/g) ?? []);
  assert.deepEqual([...shaped].sort(), [...CORE_SNS].sort());
});

const loss = foldBodies(emptyPoolOutState(), lossBodies);

test('★ the loss: raised at the 06:46:00Z body — 10 min 48 s after it — as a warning naming slot 1', () => {
  assert.deepEqual(eventsOf(loss), [
    ['baseline', '2026-11-15T06:10:00.000Z'],
    ['first-fault', '2026-11-15T06:36:00.000Z'],
    ['raised', '2026-11-15T06:46:00.000Z'],
  ]);
  // Not there one body earlier; there at 06:46.
  const before = stateAt(loss, lossBodies, '2026-11-15T06:45:00Z');
  assert.equal(before.episode, null);
  assert.deepEqual([before.streak?.strong, before.streak?.counted, iso(before.streak?.firstMs)], [10, 10, '2026-11-15T06:36:00.000Z']);
  const raised = stateAt(loss, lossBodies, '2026-11-15T06:46:00Z');
  const ep = raised.episode!;
  assert.deepEqual([ep.how, ep.k, ep.slots, iso(ep.sinceMs), iso(ep.raisedAtMs)], ['strong', 1, [1], '2026-11-15T06:36:00.000Z', '2026-11-15T06:46:00.000Z']);
  assert.deepEqual([ep.countedWh, ep.expectedWh, ep.baselineWh], [61440, 92160, 92160]);
  assert.deepEqual([iso(ep.before?.atMs), ep.before?.capWh], ['2026-11-15T06:35:00.000Z', 92160]);
  assert.equal(ep.raisedAtMs - Date.parse(LOSS.capacity.shortFromIso), 10 * MIN + 48_000);
  assert.equal(poolOutSeverity(raised), 'warning');
  // The first body after the loss is STRONG: capacity one slot short, the percent and the power both naming slot 1.
  const first = loss.steps[lossBodies.findIndex((b) => b.atMs === Date.parse('2026-11-15T06:36:00Z'))].signals!;
  assert.deepEqual([first.cls, first.cap.v, first.cap.k, first.pct.set, first.flow.set, first.named], ['STRONG', 'fault', 1, [1], [1], [1]]);
  // Every body of the hour is an observation, and from 06:36 every one is STRONG.
  assert.equal(loss.steps.every((s) => s.skip === null), true);
  assert.deepEqual([...new Set(loss.steps.slice(36).map((s) => s.signals?.cls))], ['STRONG']);
  assert.deepEqual([...new Set(loss.steps.slice(0, 35).map((s) => s.signals?.cls))], ['IN']);
});

test('★ the alert at 06:46Z, word for word', () => {
  const raised = stateAt(loss, lossBodies, '2026-11-15T06:46:00Z');
  const parts = poolOutAlertParts(raised, { nowMs: Date.parse('2026-11-15T06:46:20Z'), timeZone: TZ })!;
  assert.deepEqual([parts.severity, parts.title, parts.fault], ['warning', 'Core out of the backup pool: slot 1', 'out:1;k=1']);
  assert.equal(parts.detail, [
    "The panel's backup capacity reads 61.4 kWh: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots.",
    'It first read under the sum of its slots at 23:36; the last reading at 92.2 kWh was at 23:35.',
    'At 23:46 slot 1 delivered 0 W while slots 2 and 3 delivered 1,083 W and 1,030 W.',
    'Slot 1 is listed as connected and reads 72%.',
    "The panel's cloud data carries no error code for slot 1 and three empty error lists.",
    'Cause not established.',
    'Backup now: 39.0 kWh of 61.4 kWh counted (63.5%).',
    'The grid is present.',
  ].join(' '));
  assert.equal(shortenDetail(parts.detail), "The panel's backup capacity reads 61.4 kWh: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots.");
  assert.deepEqual(parts.facts.map((f) => `${f.label}: ${f.value}`), [
    'Counted now: 61.4 kWh', 'Before: 92.2 kWh', 'Out: slot 1 (72%, 0 W, listed)',
    'Signals: capacity fault; percent fault; power fault; flags no vote', 'Panel codes: none read', 'Grid: present', 'Since: 23:36',
  ]);
});

test('★ the episode stands for the rest of the hour and across the 43 hours to the return fixture', () => {
  assert.equal(poolOutTitle(loss.state.episode!.k, loss.state.episode!.slots), 'Core out of the backup pool: slot 1');
  assert.equal(loss.steps.slice(47).every((s) => s.events.length === 0 && s.state.episode != null), true);
  // The first body of the return fixture, 43 hours later: the same episode, the same identity.
  const next = foldBodies(loss.state, returnBodies.slice(0, 1)).state;
  assert.deepEqual([iso(next.episode?.sinceMs), next.episode?.slots, poolOutSeverity(next)], ['2026-11-15T06:36:00.000Z', [1], 'warning']);
});

for (const [what, start] of [['in one process', (s: PoolOutState): PoolOutState => s], ['across a restart', (s: PoolOutState): PoolOutState => parsePoolOutFile(serializePoolOutFile(new Map([[PANEL_SN, s]]))).panels.get(PANEL_SN)!]] as const) {
  test(`★ the return (${what}): present at 03:18:00Z, cleared at the 03:19:00Z body — 10 min 57 s after it — as a return of slot 1`, () => {
    const ret = foldBodies(start(loss.state), returnBodies);
    assert.deepEqual(eventsOf(ret), [['cleared', '2026-11-17T03:19:00.000Z']]);
    const standing = stateAt(ret, returnBodies, '2026-11-17T03:18:00Z');
    assert.equal(poolOutTitle(standing.episode!.k, standing.episode!.slots), 'Core out of the backup pool: slot 1');
    assert.deepEqual([iso(standing.episode?.clear?.firstMs), standing.episode?.clear?.n], ['2026-11-17T03:09:00.000Z', 10]);
    const cleared = stateAt(ret, returnBodies, '2026-11-17T03:19:00Z');
    assert.equal(cleared.episode, null);
    const end = poolOutLatestEnd(cleared)!;
    assert.deepEqual([end.kind, iso(end.atMs), iso(end.backAtMs), iso(end.sinceMs), end.k, end.slots, end.capWh], [
      'returned', '2026-11-17T03:19:00.000Z', '2026-11-17T03:09:00.000Z', '2026-11-15T06:36:00.000Z', 1, [1], 92160,
    ]);
    assert.equal(end.atMs - Date.parse(RETURN.capacity.shortUntilIso), 10 * MIN + 57_000);
    assert.equal(poolOutAlertParts(cleared, { nowMs: end.atMs, timeZone: TZ }), null, 'the alert is gone');
    // Before the capacity came back: 35 counted bodies; then four in which the fixture's 5-minute row already carries
    // the returned slot's power while the capacity still reads 61,440 Wh (held: a contradiction, not a return).
    assert.deepEqual(ret.steps.slice(0, 35).map((s) => s.signals?.cls).filter((c) => c !== 'STRONG'), []);
    assert.deepEqual(ret.steps.slice(35, 39).map((s) => [s.signals?.cap.v, s.signals?.flow.v, s.signals?.cls]), Array(4).fill(['fault', 'healthy', 'HOLD']));
    assert.equal(ret.steps.slice(39).every((s) => s.signals?.cap.v === 'healthy'), true);
    // Nothing afterwards: no second clear, no new streak.
    assert.equal(ret.state.streak, null);
    assert.equal(ret.state.ends.length, 1);
  });
}

test('★ the return notice, word for word — the percent step named as membership, not charging', () => {
  const ret = foldBodies(loss.state, returnBodies);
  const end = poolOutLatestEnd(ret.state)!;
  assert.deepEqual(poolOutEndText(end, { nowMs: Date.parse('2026-11-17T03:19:20Z'), timeZone: TZ }), {
    title: 'Core back in the backup pool: slot 1',
    body: [
      "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 20:09; it first read under that sum at Sat 23:36, 44 h 33 min earlier.",
      'At 20:09 slot 1 delivered 874 W and read 99%.',
      'The pool percent read 47% before and 64% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.',
      'Backup at 20:19: 59.0 kWh of 92.2 kWh counted (64%).',
    ].join(' '),
  });
  assert.deepEqual([end.pctBefore, iso(end.pctBeforeAtMs), end.pctAfter, iso(end.pctAfterAtMs)], [47, '2026-11-17T03:04:00.000Z', 64, '2026-11-17T03:09:00.000Z']);
  // Sent after quiet hours end (06:00 on Tuesday), each figure still carries its own time.
  assert.equal(poolOutEndText(end, { nowMs: Date.parse('2026-11-17T13:00:00Z'), timeZone: TZ }).body.startsWith(
    "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since Mon 20:09; it first read under that sum at Sat 23:36, 44 h 33 min earlier. At Mon 20:09 slot 1 delivered 874 W and read 99%."), true);
});
