import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selfHealQuorum, evaluateSelfHeal, freshSelfHealState,
  type SelfHealConfig, type SelfHealState,
} from '../src/sessionSelfHeal.js';
import { decideCollapseSurfacing, isElectricallyIdle } from '../src/messageRateFloor.js';

/**
 * v1.157.0 — an idle Core's HELD rate collapse no longer votes for a session rebuild.
 *
 * 2026-09-13: three Cores' collapses surfaced at 21:31 while the packs discharged, the
 * 21:35 heal restored the session, and the packs reached reserve two minutes later.
 * decideCollapseSurfacing holds a surfaced collapse through idleness, and an idle Core
 * cannot clear the 10 msg/min recovery bar, so the three held collapses kept a quorum all
 * night: heals at 22:35, 23:35, 00:35 and 01:35 changed nothing and the cap stood the
 * healer down at 02:35, leaving the alarm-path panel's genuine wedges on the last slot.
 *
 * Placeholder identities only: the repo is public.
 */

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 4, 0); // 21:00 MST on 2026-09-13; m = minutes after 21:00
const CFG: SelfHealConfig = { minStarvedDevices: 2, starvedForMs: 20 * MIN, cooldownMs: 60 * MIN, maxPerDay: 6 };
const PANEL = 'PANEL';
const ALARM_PATH: ReadonlySet<string> = new Set([PANEL]);

const src = (f: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/', f), 'utf8');

const member = (sn: string, deviceName: string) => ({ sn, deviceName });
const names = (ms: { deviceName: string }[]) => ms.map((m) => m.deviceName);

// ── the membership rule ──────────────────────────────────────────────────────

test('★ a held collapse on an idle Core does not count toward the heal quorum', () => {
  const surfaced = [member('CORE-A', 'Core A'), member('CORE-B', 'Core B'), member('CORE-C', 'Core C')];
  const q = selfHealQuorum(surfaced, new Set(['CORE-A', 'CORE-B', 'CORE-C']), ALARM_PATH);
  assert.equal(q.count, 0, 'the 09-13 overnight shape: three idle held Cores, zero votes');
  assert.deepEqual(q.counted, []);
  assert.deepEqual(names(q.idleExcluded), ['Core A', 'Core B', 'Core C']);
});

test('Cores that are moving power still count — a wedge on active hardware stays healable', () => {
  const q = selfHealQuorum([member('CORE-A', 'Core A'), member('CORE-B', 'Core B')], new Set(), ALARM_PATH);
  assert.equal(q.count, 2);
  assert.deepEqual(names(q.counted), ['Core A', 'Core B']);
  assert.deepEqual(q.idleExcluded, []);
});

test('★ the alarm-path panel counts by IDENTITY, even when it is in the idle set', () => {
  // The panel's projection has no power fields today, so it never reads idle. The rule must
  // not depend on that data shape: the panel is the alarm chain's input.
  const q = selfHealQuorum([member(PANEL, 'Panel')], new Set([PANEL]), ALARM_PATH);
  assert.equal(q.count, 1);
  assert.deepEqual(names(q.counted), ['Panel']);
  assert.deepEqual(q.idleExcluded, []);
});

test('a mixed tick counts the panel and the active Core, and names the idle one', () => {
  const surfaced = [member(PANEL, 'Panel'), member('CORE-A', 'Core A'), member('CORE-B', 'Core B')];
  const q = selfHealQuorum(surfaced, new Set(['CORE-B', 'NOT-SURFACED']), ALARM_PATH);
  assert.equal(q.count, 2);
  assert.deepEqual(names(q.counted), ['Panel', 'Core A']);
  assert.deepEqual(names(q.idleExcluded), ['Core B'], 'an idle device that never surfaced is irrelevant');
});

// ── minute-by-minute replays through the real decision functions ─────────────

interface Scripted {
  sn: string;
  name: string;
  collapsing: (m: number) => boolean;
  /** null = the projection carries no power fields (the panel). */
  watts: (m: number) => { in: number | null; out: number | null };
}

/**
 * Mirrors the rate-floor tick in index.ts: decideCollapseSurfacing owns the surfaced set,
 * idleness is read per tick with isElectricallyIdle, and evaluateSelfHeal receives either
 * the quorum count (v1.157.0) or every surfaced collapse (the pre-fix wiring).
 */
function replay(devices: Scripted[], lastMinute: number, state: SelfHealState, wiring: 'quorum' | 'all-surfaced') {
  const surfaced = new Set<string>();
  const heals: { m: number; reason: string; counted: string[] }[] = [];
  const reasons: string[] = [];
  const surfacedAt = new Map<number, string[]>();
  for (let m = 0; m <= lastMinute; m++) {
    const collapses: { sn: string; deviceName: string }[] = [];
    const idleSns = new Set<string>();
    for (const d of devices) {
      const collapsing = d.collapsing(m);
      const w = d.watts(m);
      const idle = isElectricallyIdle(w.in, w.out);
      const dec = decideCollapseSurfacing(collapsing, true, idle, surfaced.has(d.sn), collapsing);
      if (dec.surfaced) {
        surfaced.add(d.sn);
        collapses.push({ sn: d.sn, deviceName: d.name });
        if (idle) idleSns.add(d.sn);
      } else if (!collapsing) {
        surfaced.delete(d.sn);
      }
    }
    const alarmCriticalStarved = collapses.some((c) => ALARM_PATH.has(c.sn));
    const q = selfHealQuorum(collapses, idleSns, ALARM_PATH);
    const count = wiring === 'quorum' ? q.count : collapses.length;
    const v = evaluateSelfHeal(T0 + m * MIN, count, state, CFG, { alarmCriticalStarved });
    reasons.push(v.reason);
    if (v.heal) heals.push({ m, reason: v.reason, counted: names(q.counted) });
    surfacedAt.set(m, [...surfaced].sort());
  }
  return { heals, reasons, surfacedAt };
}

const inRange = (a: number, b: number) => (m: number) => m >= a && m < b;
const noPowerFields = () => ({ in: null, out: null });

/** 2026-09-13, m = minutes after 21:00. */
function night0913(): Scripted[] {
  const core = (sn: string, name: string): Scripted => ({
    sn, name,
    collapsing: inRange(31, 604),                                   // 21:31 → 07:04
    watts: (m) => (m < 37 ? { in: 0, out: 2600 } : { in: 0, out: 0 }), // reserve reached 21:37
  });
  return [
    { sn: PANEL, name: 'Panel', collapsing: inRange(15, 41), watts: noPowerFields }, // 21:15 → 21:41
    core('CORE-A', 'Core A'), core('CORE-B', 'Core B'), core('CORE-C', 'Core C'),
  ];
}
/** The heal before the night, at 17:59 (heal 1 of the rolling window). */
function budgetWithEarlierHeal(atMinute: number): SelfHealState {
  const st = freshSelfHealState();
  st.healTimesMs = [T0 + atMinute * MIN];
  st.lastHealMs = T0 + atMinute * MIN;
  return st;
}

test('THE DEFECT, replayed: counting every surfaced collapse reproduces 09-13 to the minute', () => {
  const st = budgetWithEarlierHeal(-181);
  const r = replay(night0913(), 640, st, 'all-surfaced');
  assert.deepEqual(r.heals.map((h) => h.m), [35, 95, 155, 215, 275],
    'heals at 21:35, 22:35, 23:35, 00:35 and 01:35, exactly as logged');
  assert.match(r.heals[1].reason, /3 devices starved 59m .*heal 3\/6/);
  assert.match(r.reasons[335], /daily cap reached \(6\/6/, 'the 02:35 stand-down');
});

test('★★★ the 09-13 night now heals ONCE, and the alerts still hold', () => {
  const st = budgetWithEarlierHeal(-181);
  const r = replay(night0913(), 640, st, 'quorum');
  assert.equal(r.heals.length, 1, 'no rebuilds of a healthy session after the packs idle');
  assert.equal(r.heals[0].m, 35, 'the 21:35 heal, which did restore the session, still fires');
  assert.match(r.heals[0].reason, /4 devices starved 20m .*heal 2\/6/);
  assert.deepEqual(r.heals[0].counted, ['Panel', 'Core A', 'Core B', 'Core C']);
  assert.ok(!r.reasons.some((x) => /daily cap/.test(x)), 'the healer never stands down');
  assert.equal(st.healTimesMs.length, 2, 'four heals of budget left for the panel');
  assert.deepEqual(r.surfacedAt.get(300), ['CORE-A', 'CORE-B', 'CORE-C'],
    'the alert set is untouched: the held collapses still surface');
});

test('★★ a panel-only wedge with idle Cores still heals on schedule (09-14 21:42)', () => {
  const idleCore = (sn: string, name: string): Scripted => ({
    sn, name, collapsing: inRange(39, 200), watts: () => ({ in: 0, out: 0 }),
  });
  const devices: Scripted[] = [
    { sn: PANEL, name: 'Panel', collapsing: inRange(22, 48), watts: noPowerFields }, // 21:22 → 21:48
    idleCore('CORE-A', 'Core A'), idleCore('CORE-B', 'Core B'), idleCore('CORE-C', 'Core C'),
  ];
  const st = budgetWithEarlierHeal(-61); // the 19:59 heal
  const r = replay(devices, 120, st, 'quorum');
  assert.deepEqual(r.heals.map((h) => h.m), [42]);
  assert.match(r.heals[0].reason, /1 devices starved 20m .*heal 2\/6/);
  assert.deepEqual(r.heals[0].counted, ['Panel']);
  for (const [m, s] of r.surfacedAt) {
    assert.ok(!s.some((sn) => sn.startsWith('CORE')), `idle Cores never enter the surfaced set (m=${m})`);
  }
});

test('★★ a wedge on two Cores that are moving power still heals, panel healthy', () => {
  const activeCore = (sn: string, name: string): Scripted => ({
    sn, name, collapsing: inRange(0, 200), watts: () => ({ in: 0, out: 1500 }),
  });
  const devices: Scripted[] = [
    { sn: PANEL, name: 'Panel', collapsing: () => false, watts: noPowerFields },
    activeCore('CORE-A', 'Core A'), activeCore('CORE-B', 'Core B'),
  ];
  const r = replay(devices, 120, freshSelfHealState(), 'quorum');
  assert.deepEqual(r.heals.map((h) => h.m), [20, 80], 'dwell, then the cooldown binds');
  assert.match(r.heals[0].reason, /2 devices starved 20m/);
  assert.deepEqual(r.heals[0].counted, ['Core A', 'Core B']);
});

test('pinned trade-off: a counted Core that reads idle for one tick restarts the dwell', () => {
  const devices: Scripted[] = [
    { sn: 'CORE-A', name: 'Core A', collapsing: inRange(0, 60), watts: () => ({ in: 0, out: 1500 }) },
    { sn: 'CORE-B', name: 'Core B', collapsing: inRange(0, 60), watts: (m) => (m === 10 ? { in: 0, out: 0 } : { in: 0, out: 1500 }) },
  ];
  const r = replay(devices, 45, freshSelfHealState(), 'quorum');
  assert.deepEqual(r.heals.map((h) => h.m), [31], 'onset reset at m=10, re-latched at m=11');
  assert.match(r.reasons[10], /only 1 device\(s\) starved/);
});

// ── the production wiring, which the pure tests above cannot reach ───────────

test('★★★ index.ts feeds the quorum count to evaluateSelfHeal and leaves the alert set whole', () => {
  // A comment is not a mechanism: match against code lines only.
  const code = src('index.ts').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  assert.match(code, /evaluateSelfHeal\(\s*now,\s*healQuorum\.count,\s*selfHealState,/,
    'the heal decision receives the quorum count');
  assert.ok(!/evaluateSelfHeal\(\s*now,\s*collapses\.length/.test(code),
    'never every surfaced collapse');
  assert.ok(code.includes('    const healQuorum = selfHealQuorum(collapses, idleSurfacedSns, alarmPathSns);'));

  // The alert set and the alarm-path exception read the UNFILTERED collapses.
  assert.ok(code.includes('    setRateFloorCollapses(collapses);'));
  assert.ok(code.includes(
    '    const alarmCriticalStarved = alarmPathSns.size > 0 && collapses.some((c) => alarmPathSns.has(c.sn));'));

  // Idle membership is recorded inside the surfacing branch, conditionally, exactly once.
  const open = code.indexOf('      if (dec.surfaced) {\n');
  const close = code.indexOf('      } else if (!r.collapsing) {', open);
  assert.ok(open > 0 && close > open, 'the surfacing branch is located, its condition unchanged');
  const branch = code.slice(open, close);
  assert.ok(branch.includes('surfacedCollapses.add(sn);'));
  assert.ok(branch.includes('collapses.push({ sn, deviceName: name, rate: r.rate, baseline: r.baseline });'));
  assert.ok(branch.includes('        if (idle) idleSurfacedSns.add(sn);'));
  assert.equal(code.split('idleSurfacedSns.add(').length - 1, 1);

  // The idle set is per tick; the exclusion-edge set outlives ticks.
  const tick = code.indexOf('const rateFloorTick = setInterval(');
  const perTick = code.indexOf('    const idleSurfacedSns = new Set<string>();');
  assert.ok(tick > 0 && perTick > tick && perTick < code.indexOf('    setRateFloorCollapses(collapses);', tick));
  const edgeSet = code.indexOf('const healIdleExcluded = new Set<string>();');
  assert.ok(edgeSet > 0 && edgeSet < tick);

  // The exclusion logs once per edge and re-arms when the device stops being excluded.
  const loop = code.indexOf('    for (const m of healQuorum.idleExcluded) {');
  const guard = code.indexOf('      if (!healIdleExcluded.has(m.sn)) {', loop);
  const line = code.indexOf('no longer counts toward the heal quorum', loop);
  assert.ok(loop > 0 && guard > loop && line > guard, 'the info line sits behind the edge guard');
  assert.ok(code.includes('      if (!healQuorum.idleExcluded.some((m) => m.sn === sn)) healIdleExcluded.delete(sn);'));

  // Every heal names who voted for it.
  assert.ok(code.includes(
    "app.log.warn(`self-heal: ${healVerdict.reason} [counted: ${healQuorum.counted.map((m) => m.deviceName).join(', ')}]`);"));
});
