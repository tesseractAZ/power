import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coherentBackupPool, backupPoolWithGraceHold, projectShp2, type Shp2Projection } from '../src/ecoflow/project.js';
import { poolDiagFromRaw } from '../src/ecoflow/poolDiag.js';
import {
  advancePoolOut, emptyPoolOutState, poolOutAlertId, poolOutTitle, parsePoolOutFile, serializePoolOutFile,
  type PoolOutState, type PoolObservation,
} from '../src/poolOut.js';
import {
  synthBody, bodiesFromRows, observe, fold, foldBodies, minutes, at, withReference, withEpisode, healthyBody, lostBody, quietLostBody, quietBody, rowMs,
  SLOT_WH, FULL_WH, PANEL_SN, CORE_SNS, MIN, type Body, type PanelRow, type Folded, type TimedBody,
} from './fixtures/poolOutFixtures.js';

/**
 * v1.208.0 — what the pool-out alarm must NOT fire on (poolOut.ts).
 *
 * One test per exclusion of the design, and the cases the adversarial reviews added. The rows quoted below are the
 * recorder's own 5-minute means of the nights named; the builder adds the capacity and the circuit vector to them
 * (fixtures/poolOutFixtures.ts says which parts are synthetic).
 *
 * Each test asserts three things where they apply: no raise, no streak left standing, and the signal that would have
 * been wrong reading "unknown" or "healthy" rather than "fault".
 */

const raised = (f: Folded): boolean => f.steps.some((s) => s.events.some((e) => e.type === 'raised'));
const quiet = (f: Folded, what: string): void => {
  assert.equal(raised(f), false, `${what}: raised`);
  assert.equal(f.state.episode, null, `${what}: an episode stands`);
  assert.equal(f.state.streak, null, `${what}: a streak stands`);
};
const classes = (f: Folded): string[] => [...new Set(f.steps.map((s) => s.skip ?? (s.signals?.cls as string)))];
const restart = (s: PoolOutState): PoolOutState => parsePoolOutFile(serializePoolOutFile(new Map([[PANEL_SN, s]]))).panels.get(PANEL_SN) as PoolOutState;
/** A reference adopted from fifteen healthy minutes ending just before `ms` (three Cores, 92,160 Wh). */
const referenceBefore = (ms: number): PoolOutState =>
  fold(emptyPoolOutState(), Array.from({ length: 15 }, (_, i) => observe(ms - (15 - i) * MIN, healthyBody(-1000 - i)))).state;
/** Series rows replayed at the full capacity, from a reference taken just before them. */
const replayRows = (rows: PanelRow[], edit: (b: TimedBody) => void = () => {}): Folded => {
  const bodies = bodiesFromRows(rows, () => FULL_WH);
  bodies.forEach(edit);
  return foldBodies(referenceBefore(rowMs(rows[0])), bodies);
};

/* ───────────────────────────── the design's exclusion table ───────────────────────────── */

test('★ full batteries idling: capacity healthy, nothing discharging, the percent consistent', () => {
  const f = fold(withReference(), minutes(0, 180, (seq) => synthBody({ seq, poolPct: 100, slots: [0, 1, 2].map(() => ({ pct: 100, w: 0 })) })));
  quiet(f, 'three hours at 100%');
  assert.deepEqual(classes(f), ['IN']);
  assert.deepEqual([f.steps[0].signals?.cap.v, f.steps[0].signals?.flow.v, f.steps[0].signals?.flow.reason, f.steps[0].signals?.pct.v], ['healthy', 'unknown', 'idle', 'consistent']);
});

// Tue 2026-11-10 23:00–23:15 MST: the force-charge window opens and slot 3 switches on late (0 W for ten minutes
// while slots 1 and 2 take 7.2 kW each).
const LATE_ON: PanelRow[] = [
  ['2026-11-11T06:00Z', 42, 50, 44, 40.5, 41, 4731.4, 4775.8, 2370.5, 6164.8, 6227.5, 3468.7, 0, 0, 0, 29, 28, 29],
  ['2026-11-11T06:05Z', 43, 50, 46, 42.5, 41, 7186.4, 7154, 0, 7193.2, 7168.4, 0, 0, 0, 0, 29, 28, 29],
  ['2026-11-11T06:10Z', 44.5, 50, 47.5, 44.5, 41, 7205.5, 7180.6, 0, 7199, 7199.2, 0, 0, 0, 0, 29, 28, 29],
  ['2026-11-11T06:15Z', 46, 50, 49.5, 46.5, 41, 6875.9, 6853.7, 2816.8, 6889.4, 6840.4, 2816.5, 0, 0, 0, 29, 28, 29],
];
// Fri 2026-11-13 04:20–04:35 and 23:20–23:35 MST: slot 1 stops at 89 % and at 85 % while the others go on charging.
const CEILING_STOP: PanelRow[] = [
  ['2026-11-13T11:20Z', 84.5, 50, 87.5, 85.5, 81, 6008.5, 6001, 6004.6, 5991.8, 6000.8, 6007.2, 0, 0, 0, 30, 29, 30],
  ['2026-11-13T11:25Z', 86, 50, 89, 87, 82.5, 4483.4, 6244.4, 6201.2, 4396.3, 6443, 6462.8, 0, 0, 0, 30, 29, 30],
  ['2026-11-13T11:30Z', 87, 50, 89, 88, 83, 0, 7132.1, 7160.9, 0, 7120.3, 7152.7, 0, 0, 0, null, 29, 30],
  ['2026-11-13T11:35Z', 87, null, null, 88, null, null, null, null, null, null, null, null, null, null, 30, null, null],
];
const CEILING_STOP_2: PanelRow[] = [
  ['2026-11-14T06:20Z', 79, 50, 83, 79, 75, 5940.9, 5935, 5938.5, 5930.6, 5924.8, 5932.4, 0, 0, 0, 29, 28, 30],
  ['2026-11-14T06:25Z', 80.5, 50, 84.5, 80.5, 76, 5946, 5956.3, 5975.3, 5935.4, 5963.2, 5969.2, 0, 0, 0, 29.7, 29, 30],
  ['2026-11-14T06:30Z', 82, 50, 85, 82.5, 77.5, 0, 7171, 7198.7, 0, 7162.6, 7222.2, 0, 0, 0, 30, 29, 30],
  ['2026-11-14T06:35Z', 83, 50, 85, 84.5, 79.5, 0, 7337, 7185.3, 0, 7293.8, 7272.2, 0, 0, 0, 30, 29, 30],
];

test('★ a night charge with a late-ON slot (2026-11-10 23:05): one slot at 0 W while the others charge is no loss', () => {
  const f = replayRows(LATE_ON);
  quiet(f, 'late ON');
  assert.deepEqual(classes(f), ['IN']);
  // The power is not judged at all while any slot charges, and the percent stays the mean of all three.
  assert.deepEqual([...new Set(f.steps.map((s) => `${s.signals?.cap.v}/${s.signals?.flow.v}/${s.signals?.flow.reason}/${s.signals?.pct.v}`))], ['healthy/unknown/charging/consistent']);
});

test('★ a ceiling stop (2026-11-13 04:30 and 23:30): one slot stopped while the others charge on is no loss — and a flag on it changes nothing', () => {
  for (const rows of [CEILING_STOP, CEILING_STOP_2]) {
    const plain = replayRows(rows);
    quiet(plain, rows[0][0]);
    assert.deepEqual(classes(plain), ['IN']);
    assert.equal(plain.steps.some((s) => s.signals?.flow.v === 'fault' || s.signals?.pct.v === 'fault'), false);
    // The same nights with slot 1's channel state and ready flag reading differently from its reference and from the
    // other slots while it is stopped (what those keys read then was never recorded).
    const flagged = replayRows(rows, (b) => {
      if ((b.body['backupInfo.chWatt'] as Array<number | null>)[0] !== 0) return;
      b.body['pd303_mc.backupIncreInfo.ch1Info.ctrlSta'] = 'BACKUP_CH_STANDBY';
      b.body['pd303_mc.backupIncreInfo.ch1Info.backupIsReady'] = false;
      b.body['pd303_mc.backupIncreInfo.Energy1Info.isPowerOutput'] = 0;
    });
    assert.equal(flagged.steps.some((s) => s.signals?.flag.v === 'fault'), true, 'control: the flags do vote');
    quiet(flagged, `${rows[0][0]} with flags`);
    assert.deepEqual(classes(flagged), ['IN']);
  }
});

test('★ a stale shadow: a fault-looking body replayed for an hour is one observation, then none', () => {
  const body = lostBody(1);
  // The store latches the shadow at the fifth identical body; before and after that the tracker's own ring skips it.
  const f = fold(withReference(), Array.from({ length: 60 }, (_, i) => observe(at(i), body, { latched: i >= 4 })));
  assert.deepEqual(f.steps.slice(0, 6).map((s) => s.skip), [null, 'replayed', 'replayed', 'replayed', 'latched', 'latched']);
  assert.equal(raised(f), false);
  assert.equal(f.state.streak?.counted, 1);
  // The panel comes back live and healthy: the one counted reading goes nowhere.
  quiet(fold(f.state, minutes(60, 3, healthyBody)), 'after the shadow');
});

test('★ an incoherent trio: the new capacity with the old remainder for three polls is no observation', () => {
  // 61,440 Wh arrives with the remainder of 92,160 Wh at 67 %: the percent and remainder / capacity are 33 points apart.
  const torn = (seq: number): Body => lostBody(seq, { poolPct: 67, remainWh: Math.round(0.67 * FULL_WH) });
  assert.equal(poolDiagFromRaw(torn(0)).pool.coherent, false);
  assert.equal((projectShp2(torn(0)) as Shp2Projection).backupFullCapWh, null, 'the projection nulls the same trio');
  const f = fold(withReference(), [...minutes(0, 3, torn), ...minutes(3, 10, healthyBody)]);
  assert.deepEqual(f.steps.slice(0, 3).map((s) => s.skip), ['incoherent', 'incoherent', 'incoherent']);
  quiet(f, 'three torn polls');
});

test('★ a slew-held step: the tracker reads the RAW trio — the served one holds the old capacity for ten minutes', () => {
  // Slot 1 out at 99 % while slots 2 and 3 sit at 19 %: the pool reads 19. When slot 1 returns it reads 46: a rise of
  // 27 points in one poll, which the projection's slew guard replaces with the held trio (the OLD capacity).
  const out = (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 19, slots: [{ pct: 99, w: 0 }, { pct: 19, w: -600 }, { pct: 19, w: -600 }] });
  const back = (seq: number): Body => synthBody({ seq, capWh: FULL_WH, poolPct: 46, slots: [{ pct: 99, w: -900 }, { pct: 19, w: -150 }, { pct: 19, w: -150 }] });
  const ep = fold(withReference(), minutes(0, 11, out));
  assert.equal(raised(ep), true);
  const lastOut = poolDiagFromRaw(out(10)).pool;
  const firstBack = poolDiagFromRaw(back(11)).pool;
  const held = { pct: lastOut.pct as number, fullCapWh: lastOut.fullCapWh as number, remainWh: lastOut.remainWh as number, atMs: at(10) };
  const served = backupPoolWithGraceHold(coherentBackupPool(firstBack.pct, firstBack.fullCapWh, firstBack.remainWh), held, at(11));
  assert.deepEqual([served.source, served.out.fullCapWh, served.out.pct], ['held', 2 * SLOT_WH, 19], 'control: the served trio is the held one');
  assert.deepEqual([firstBack.fullCapWh, firstBack.pct, firstBack.coherent], [FULL_WH, 46, true], 'the raw trio is the new one');
  // The tracker counts the return from its first body and clears ten minutes later, on the raw readings.
  const ret = fold(ep.state, minutes(11, 11, back));
  assert.deepEqual([ret.steps[0].signals?.cap.v, ret.steps[0].signals?.cap.countedWh], ['healthy', FULL_WH]);
  assert.deepEqual(ret.steps.flatMap((s) => s.events), [{ type: 'cleared', atMs: at(21), kind: 'returned' }]);
  // The same in the other direction: the loss from a healthy pool is a drop of 27, served as the OLD (full) capacity,
  // and the tracker's streak starts at the first raw body all the same.
  const full = { pct: firstBack.pct as number, fullCapWh: FULL_WH, remainWh: firstBack.remainWh as number, atMs: at(21) };
  assert.equal(backupPoolWithGraceHold(coherentBackupPool(lastOut.pct, lastOut.fullCapWh, lastOut.remainWh), full, at(22)).source, 'held');
  assert.equal(advancePoolOut(ret.state, observe(at(22), out(22))).state.streak?.counted, 1);
});

test('★ a restart: nothing is invented at boot, and a streak is carried only across 15 minutes of DATA time', () => {
  // A first start with no file, the pool healthy: nothing.
  quiet(fold(emptyPoolOutState(), minutes(0, 60, healthyBody)), 'first start');
  // A restart with the reference on file, the pool healthy: nothing, and the first body is an ordinary reading.
  const ref = restart(withReference());
  const first = advancePoolOut(ref, observe(at(0), healthyBody(0)));
  assert.deepEqual([first.skip, first.signals?.cls, first.events, first.logs], [null, 'IN', [], []]);
  // Five STRONG readings on file, then a restart that takes 20 minutes: the sixth reading does not complete the old
  // streak (it would: six STRONG spanning 24 minutes), it starts a new one.
  const five = restart(fold(withReference(), minutes(0, 5, lostBody)).state);
  assert.equal(five.streak?.strong, 5);
  const late = fold(five, [observe(at(24), lostBody(24))]);
  assert.equal(raised(late), false);
  assert.deepEqual([late.state.streak?.firstMs, late.state.streak?.strong], [at(24), 1]);
  // The same five, and the Core is back when the add-on returns: the streak ends on three healthy readings.
  quiet(fold(five, minutes(6, 3, healthyBody)), 'healthy after the restart');
  // A file that cannot be read is no state: the tracker starts empty and a healthy pool raises nothing.
  assert.equal(parsePoolOutFile('{"v":1,"panels":{"HD31XXX00XXX0001":{"v":1,"episode":{"k":1}}}}').panels.size, 0);
});

test('★ dark Cores whose slots serve the house: no input is a Core\'s own telemetry, and the id holds no Core serial', () => {
  const o: PoolObservation = observe(at(0), healthyBody(0));
  assert.deepEqual(Object.keys(o).sort(), ['atMs', 'diag', 'grid', 'latched', 'online', 'witness']);
  // The body carries the Cores' serials; nothing the tracker is handed does.
  assert.equal(JSON.stringify(healthyBody(0)).includes(CORE_SNS[0]), true, 'control');
  for (const sn of [PANEL_SN, ...CORE_SNS]) assert.equal(JSON.stringify(o).includes(sn), false);
  // Whatever the Cores themselves report, or do not, a panel body with three slots carrying the house is IN.
  quiet(fold(withReference(), minutes(0, 60, healthyBody)), 'three slots serving the house');
  // The roster mute demotes an alert whose id contains the serial of an off-panel Core: this id cannot match one.
  for (const id of [poolOutAlertId(PANEL_SN, true), poolOutAlertId(PANEL_SN, false)]) {
    for (const sn of CORE_SNS) assert.equal(id.includes(sn), false);
  }
});

test('★ a partial body: a roster slot with no isConnect key is no observation', () => {
  // The whole Energy2Info block is missing (a partial cloud payload) for four polls.
  const partial = (seq: number): Body => {
    const b = healthyBody(seq);
    for (const key of Object.keys(b)) if (key.startsWith('pd303_mc.backupIncreInfo.Energy2Info.')) delete b[key];
    return b;
  };
  assert.equal((projectShp2(partial(0)) as Shp2Projection).sources[1].isConnected, false, 'control: the projection reads the same body as "not connected"');
  const f = fold(withReference(), [...minutes(0, 4, partial), ...minutes(4, 10, healthyBody)]);
  assert.deepEqual(f.steps.slice(0, 4).map((s) => s.skip), ['no-isconnect', 'no-isconnect', 'no-isconnect', 'no-isconnect']);
  quiet(f, 'four partial polls');
  // Only the documented (unprefixed) half of the body, for an hour: held from the fifth poll (the capacity did not move), never raised.
  const half = (seq: number): Body => {
    const b = healthyBody(seq);
    for (const key of Object.keys(b)) if (key.startsWith('pd303_mc.')) delete b[key];
    return b;
  };
  const h = fold(withReference(), minutes(0, 60, half));
  quiet(h, 'an hour of half bodies');
  assert.deepEqual(classes(h), ['no-isconnect', 'HOLD']);
});

// Fri 2026-10-30 01:20–01:25 MST: slot 2 one point above the 16 % reserve carries 121 W while the others carry 480 W.
const NEAR_RESERVE: PanelRow[] = [
  ['2026-10-30T08:20Z', 19, 16, 20, 17, 20, -1246.1, -417.8, -1104.3, 0, 0, 0, 0, 0, 0, 29, 28, 29.5],
  ['2026-10-30T08:25Z', 19, 16, 20, 17, 20, -480.4, -121, -484, 0, 0, 0, 0, 0, 0, 29, 28, 29],
];
// Mon 2026-11-09 22:55–23:05 MST: the reserve moves from 16 to 29 inside the bin and the pool stops discharging.
const RESERVE_MOVED: PanelRow[] = [
  ['2026-11-10T05:55Z', 30.5, 16, 32, 30, 29.5, -1118.3, -977.5, -968.2, 0, 0, 0, 0, 0, 0, 29, 28, 29],
  ['2026-11-10T06:00Z', 30, 29, 32, 30, 29, -461.4, -404, -374.9, 0, 0, 0, 0, 0, 0, 29, 28, 29],
  ['2026-11-10T06:05Z', 30, 29, 32, 30, 29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 29, 28, 29],
];

test('★ a slot near the reserve (2026-10-30 01:25): its small share is not "no share" — it is not judged under 150 W expected', () => {
  const f = replayRows(NEAR_RESERVE);
  quiet(f, 'near the reserve');
  assert.equal(f.steps.some((s) => s.signals?.flow.v === 'fault'), false);
  const row2 = f.steps[5].signals!.flow;
  assert.deepEqual(row2.slots.map((s) => [s.slot, Math.round(s.expectedW), s.v]), [[1, 482, 'healthy'], [2, 121, 'unjudged'], [3, 482, 'healthy']]);
  // A slot AT the reserve carries nothing by design: with the capacity short as well, it is still not the slot named.
  const atReserve = fold(withReference(), minutes(0, 20, (seq) => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 19, slots: [{ pct: 20, w: -540 }, { pct: 16, w: 0 }, { pct: 20, w: -545 }] })));
  assert.equal(atReserve.steps.some((s) => s.signals?.flow.v === 'fault'), false);
  assert.equal(poolOutTitle(atReserve.state.episode!.k, atReserve.state.episode!.slots), 'Core out of the backup pool: slot not identified', 'raised on the capacity alone, at 15 minutes, naming nobody');
  assert.equal(atReserve.state.episode!.raisedAtMs, at(15));
});

test('★ the reserve moved inside a reading (2026-11-09 23:00): shares against the new reserve are low, not absent', () => {
  const f = replayRows(RESERVE_MOVED);
  quiet(f, 'reserve moved');
  assert.equal(f.steps.some((s) => s.signals?.flow.v === 'fault'), false);
  // Slot 1 delivers 461 W of an expected 930 W: half its share, far above a fifth.
  const moved = f.steps[5].signals!.flow.slots[0];
  assert.deepEqual([Math.round(moved.w), Math.round(moved.expectedW), moved.v], [461, 930, 'healthy']);
});

/* ───────────────────────────── the cases the reviews added ───────────────────────────── */

test('★ FLAG alone for an hour: a slot whose flags differ, and an error code, with the capacity healthy', () => {
  const f = fold(withReference(), minutes(0, 60, (seq) => healthyBody(seq, {
    slots: [{ pct: 72, w: -710 }, { pct: 66, w: -637, ctrlSta: 'BACKUP_CH_STANDBY', backupIsReady: false, isAcOpen: 0, isPowerOutput: 0, errorCodeNum: 533 }, { pct: 63, w: -601 }],
  })));
  assert.equal(f.steps.every((s) => s.signals?.flag.v === 'fault'), true, 'control: FLAG reads fault on every body');
  quiet(f, 'FLAG alone');
  assert.deepEqual(classes(f), ['IN']);
});

test('★ PCT alone, FLOW alone, and both together for an hour — with the capacity healthy nothing raises (it is logged)', () => {
  // The pool percent reads the mean of slots 2 and 3; nothing discharges.
  const pctOnly = fold(withReference(), minutes(0, 60, (seq) => synthBody({ seq, poolPct: 64, slots: [{ pct: 72, w: 0 }, { pct: 65, w: 0 }, { pct: 63, w: 0 }] })));
  assert.deepEqual([pctOnly.steps[0].signals?.pct.v, pctOnly.steps[0].signals?.pct.set, pctOnly.steps[0].signals?.cap.v], ['fault', [1], 'healthy']);
  quiet(pctOnly, 'PCT alone');
  // Slot 1 carries nothing while the others carry the house; the percent is the mean of all three.
  const flowOnly = fold(withReference(), minutes(0, 60, (seq) => synthBody({ seq, poolPct: 67, slots: [{ pct: 72, w: 0 }, { pct: 66, w: -1107 }, { pct: 63, w: -1061 }] })));
  assert.deepEqual([flowOnly.steps[0].signals?.flow.v, flowOnly.steps[0].signals?.flow.set, flowOnly.steps[0].signals?.pct.v], ['fault', [1], 'consistent']);
  quiet(flowOnly, 'FLOW alone');
  // Both — the whole 2026-11-14 signature except the capacity.
  const both = fold(withReference(), minutes(0, 60, (seq) => lostBody(seq, { capWh: FULL_WH })));
  quiet(both, 'PCT and FLOW with the capacity healthy');
  assert.deepEqual(classes(both), ['IN']);
  assert.equal(both.steps.flatMap((s) => s.logs).filter((l) => l.text.includes('percent or power points at a slot while the capacity does not')).length, 2, 'logged, at most every 30 minutes');
});

test('★ percent and power agreeing while the capacity cannot be compared (NOCAP): recorded for an hour, never alarmed', () => {
  const f = fold(withReference(), minutes(0, 60, (seq) => lostBody(seq, { capWh: FULL_WH + 5000 })));
  assert.deepEqual(classes(f), ['NOCAP']);
  quiet(f, 'NOCAP');
  assert.equal(f.state.last?.cls, 'NOCAP', 'recorded on the newest reading');
});

test('★ capacity short while every slot carries its share (a contradiction): held for an hour, logged twice, never raised', () => {
  const f = fold(withReference(), minutes(0, 60, (seq) => healthyBody(seq, { capWh: 2 * SLOT_WH })));
  assert.deepEqual(classes(f), ['HOLD']);
  quiet(f, 'contradiction');
  assert.equal(f.steps.flatMap((s) => s.logs).filter((l) => l.text.includes('while every slot carries its share')).length, 2);
});

test('★ a capacity that is not a whole slot short (one pack: 6,144 Wh), or above the reference: held, never raised', () => {
  const pack = fold(withReference(), minutes(0, 60, (seq) => quietBody(seq, { capWh: FULL_WH - 6144 })));
  assert.deepEqual([pack.steps[0].signals?.cap.v, pack.steps[0].signals?.cap.reason], ['unknown', 'not-slot-sized']);
  quiet(pack, 'one pack short');
  const over = fold(withReference(), minutes(0, 60, (seq) => quietBody(seq, { capWh: FULL_WH + 6144 })));
  assert.deepEqual([over.steps[0].signals?.cap.v, over.steps[0].signals?.cap.reason], ['unknown', 'over']);
  quiet(over, 'one pack over');
  assert.equal(over.state.baseline?.poolCapWh, FULL_WH, 'and the reference is not moved to a capacity its slots do not add up to');
});

test('★ a coherent one-Core-short reading for one poll (seen 2026-06-22 01:09Z) or for 14 minutes of hardware work: no raise', () => {
  // One sample: capacity 61.4 kWh, remainder 41.8 kWh, pool 68 %, between healthy readings.
  const blip = (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 68, remainWh: 41800, slots: [0, 1, 2].map(() => ({ pct: 68, w: 0 })) });
  assert.equal(poolDiagFromRaw(blip(0)).pool.coherent, true);
  const one = fold(withReference(), [...minutes(0, 1, blip), ...minutes(1, 3, quietBody)]);
  assert.equal(one.steps[0].signals?.cls, 'SLOW');
  quiet(one, 'one coherent short reading');
  // Fifteen readings spanning 14 minutes on the capacity alone, then the capacity is back.
  const dip = fold(withReference(), [...minutes(0, 15, quietLostBody), ...minutes(15, 3, quietBody)]);
  assert.equal(dip.steps[14].state.streak?.counted, 15);
  quiet(dip, 'a 14-minute dip');
});

test('…and what the same dip DOES raise: 15 minutes on the capacity alone raises, names nobody, and clears when the capacity has held', () => {
  const dip = fold(withReference(), [...minutes(0, 25, quietLostBody), ...minutes(25, 40, quietBody)]);
  assert.deepEqual(dip.steps.flatMap((s) => s.events.map((e) => [e.type, e.atMs])), [['first-fault', at(0)], ['raised', at(15)], ['cleared', at(55)]]);
  assert.equal(dip.state.ends[0].kind, 'capacity-only');
});

// Mon 2026-11-16 00:50–01:25 MST, inside the episode: slot 1 out at 99 %, slots 2 and 3 charging at 7.2 kW, then
// slot 2 stops at its ceiling while slot 3 still charges.
const EVENT_CHARGE: PanelRow[] = [
  ['2026-11-16T07:50Z', 40, 50, 99, 39.5, 38.5, 0, 7130.2, 7223.2, 0, 7164.4, 7229, 0, 0, 0, 29, 29, 30],
  ['2026-11-16T07:55Z', 41.5, 50, 99, 41.5, 40.5, 0, 7235.4, 7164, 0, 7215.6, 7144, 0, 0, 0, 29, 29, 30],
  ['2026-11-16T08:20Z', 49.5, 50, 99, 49.5, 49.5, 0, 0, 5332.3, 0, 0, 5335.5, 0, 0, 0, 29, 30, 31],
  ['2026-11-16T08:25Z', 49, 50, 99, 49, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 29, 30, 31],
];

test('★ inside a real episode, a healthy slot that stops at its ceiling with its flags changed is never put in the title', () => {
  // Slot 1 is out and named. Then for twenty minutes nothing can name a slot by percent or power (the slots sit at one
  // percent and one of them is charging), while slot 2 — healthy, stopped at its ceiling — reads different flags.
  const stopped = (seq: number): Body => synthBody({
    seq, capWh: 2 * SLOT_WH, poolPct: 60,
    slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, ctrlSta: 'BACKUP_CH_STANDBY', backupIsReady: false, isPowerOutput: 0 }, { pct: 60, w: 5332, inW: 5335 }],
  });
  const f = fold(withEpisode(), minutes(11, 20, stopped));
  assert.deepEqual([f.steps[0].signals?.cls, f.steps[0].signals?.flag.v, f.steps[0].signals?.named], ['SLOW', 'fault', null]);
  assert.equal(f.steps[0].signals?.flag.items.every((i) => i.slot === 2), true);
  assert.equal(f.steps.some((s) => s.events.some((e) => e.type === 'set-changed')), false);
  assert.equal(poolOutTitle(f.state.episode!.k, f.state.episode!.slots), 'Core out of the backup pool: slot 1');
  // The recorded rows of that night, replayed inside the episode at the short capacity: no set change, no clear.
  const rows = bodiesFromRows(EVENT_CHARGE, () => 2 * SLOT_WH);
  const ep = fold(referenceBefore(rowMs(EVENT_CHARGE[0]) - 11 * MIN), Array.from({ length: 11 }, (_, i) => observe(rowMs(EVENT_CHARGE[0]) - (11 - i) * MIN, lostBody(-2000 - i)))).state;
  assert.equal(poolOutTitle(ep.episode!.k, ep.episode!.slots), 'Core out of the backup pool: slot 1');
  const night = foldBodies(ep, rows);
  assert.deepEqual(night.steps.flatMap((s) => s.events), []);
  assert.equal(poolOutTitle(night.state.episode!.k, night.state.episode!.slots), 'Core out of the backup pool: slot 1');
  // The 07:50Z row is the one where the percent, without CAP's count, would have named slots 1 and 3.
  assert.deepEqual([night.steps[0].signals?.cap.k, night.steps[0].signals?.pct.v, night.steps[0].signals?.cls], [1, 'unknown', 'SLOW']);
});
