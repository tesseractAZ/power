/**
 * v1.204.0 — the panel-measured solar basis replayed on the RECORDED plant (test/fixtures/panelPvRecord.json),
 * on the SPECIFIED basis: the panel's per-source fullCap (30,720 Wh nameplate per slot) in the constants' fit
 * and in the check, and the constants fitted on the days the membership record vouches each Core sat in its
 * slot (from 2026-08-21, the swap entry that carries the slot map). Every figure below is what the module
 * computes on the record; the replay pins it so a later change that moves one is seen.
 *
 * The evening E is the site day of the evening decision that owns the window (M1): Saturday's plan for the
 * Monday window is judged as of Saturday, and reads the same at Saturday 22:30, Sunday 00:30 and Sunday
 * 09:30. The record ends 2026-11-06 18:03 site time, so 2026-11-06 is never a whole day here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleUcTable, upperCheck, admittedSlotDays, windowBalance, isFieldDay, UC_THRESHOLD,
  type UcVerdict,
} from '../src/panelPvBasis.js';
import { addDaysYmd } from '../src/siteTime.js';
import { EVENINGS, RECORD, eveningTimes, recordFit, recordSources, type RecordOptions } from './fixtures/panelPvRecordFixtures.js';

const run = (E: string, o: RecordOptions = {}) => {
  const { table } = assembleUcTable(recordSources(E, o), E);
  return { v: upperCheck(table, E), adm: admittedSlotDays(table, E), table };
};
const admCounts = (adm: Map<number, Set<string>>): number[] => [...adm.keys()].sort().map((s) => adm.get(s)!.size);

test('★★★ the constants on the specified basis (nameplate fullCap, the record-vouched days from 2026-08-21)', () => {
  const want: Record<number, [number, number, number, number, number, number, number]> = {
    // [days, chargeHours, cd, cn, g, ed, en]
    1: [51, 97, 1.0787, 1.0920, 0.9362, 51.4, 49.4],
    2: [51, 96, 1.0904, 1.1011, 0.9498, 83.3, 57.4],
    3: [51, 95, 1.0586, 1.1412, 0.9300, 150.7, 76.8],
  };
  for (const s of [1, 2, 3]) {
    const f = recordFit(s, `C${s}`);
    const k = f.constants!;
    assert.ok(k, `slot ${s} has constants`);
    const [days, ch, cd, cn, g, ed, en] = want[s];
    assert.equal(f.days, days, `slot ${s} days`);
    assert.equal(f.chargeHours, ch, `slot ${s} charge hours`);
    assert.equal(k.firstDay, '2026-08-21');
    assert.equal(k.lastDay, '2026-10-13', 'the last whole day of the Cores\' own meter (it stops 10-14 23:52)');
    assert.equal(k.capacityWh, 30_720);
    for (const [got, exp, name] of [[k.cd, cd, 'cd'], [k.cn, cn, 'cn'], [k.g, g, 'g']] as const) assert.ok(Math.abs(got - exp) < 1e-4, `slot ${s} ${name} ${got}`);
    for (const [got, exp, name] of [[k.ed, ed, 'ed'], [k.en, en, 'en']] as const) assert.ok(Math.abs(got - exp) < 0.06, `slot ${s} ${name} ${got}`);
  }
});

test('★★★ the evening table 10-16..11-07: refused while fewer than 7 field days (counted from 10-20), then the balance per evening', () => {
  // [state, reason code or ratio, field days, max7, admitted per slot]
  const want: Record<string, [UcVerdict['state'], string | number, number, number | null, number]> = {
    '2026-10-16': ['refused', 'too-few-field-days', 0, null, 0],
    '2026-10-17': ['refused', 'too-few-field-days', 0, null, 0],
    '2026-10-18': ['refused', 'too-few-field-days', 0, null, 0],
    '2026-10-19': ['refused', 'too-few-field-days', 0, null, 0],
    '2026-10-20': ['refused', 'too-few-field-days', 0, null, 0],
    '2026-10-21': ['refused', 'too-few-field-days', 1, null, 0],
    '2026-10-22': ['refused', 'too-few-field-days', 2, null, 0],
    '2026-10-23': ['refused', 'too-few-field-days', 3, null, 0],
    '2026-10-24': ['refused', 'too-few-field-days', 4, null, 0],
    '2026-10-25': ['refused', 'too-few-field-days', 4, null, 0],
    '2026-10-26': ['refused', 'too-few-field-days', 5, null, 0],
    '2026-10-27': ['refused', 'too-few-field-days', 6, null, 0],
    '2026-10-28': ['pass', 0.9882, 7, 0.9882, 7],
    '2026-10-29': ['pass', 0.9997, 8, 0.9997, 8],
    '2026-10-30': ['pass', 1.0044, 9, 1.0044, 9],
    '2026-10-31': ['pass', 1.0044, 9, 1.0044, 9],
    '2026-11-01': ['pass', 1.0247, 10, 1.0247, 10],
    '2026-11-02': ['pass', 1.0285, 11, 1.0285, 11],
    '2026-11-03': ['pass', 0.9954, 12, 1.0285, 12],
    '2026-11-04': ['pass', 1.0039, 12, 1.0285, 13],
    '2026-11-05': ['pass', 1.0041, 12, 1.0285, 14],
    '2026-11-06': ['pass', 1.0097, 12, 1.0285, 15],
    '2026-11-07': ['pass', 1.0097, 11, 1.0285, 15],
  };
  assert.deepEqual(EVENINGS, Object.keys(want));
  for (const E of EVENINGS) {
    const { v, adm } = run(E);
    const [state, r, n, max7, a] = want[E];
    assert.equal(v.state, state, `${E} state`);
    assert.equal(v.basis, 'panel', `${E}: every slot takes the field`);
    assert.equal(v.checks.fieldDays, n, `${E} field days`);
    assert.equal(v.checks.max7, max7, `${E} max7`);
    assert.deepEqual(admCounts(adm), [a, a, a], `${E} admitted days per slot`);
    if (state === 'refused') {
      assert.equal(v.reason?.code, r, `${E} reason`);
      if (v.reason?.code === 'too-few-field-days') {
        assert.equal(v.reason.n, n);
        assert.equal(v.reason.firstFieldDay, n > 0 ? '2026-10-20' : null, 'the count names its first day');
      }
    } else {
      assert.equal(v.reason, null);
      assert.equal(v.checks.ratio, r, `${E} ratio`);
      assert.ok((v.checks.max7 as number) <= UC_THRESHOLD);
    }
  }
});

test('★★ the honest record: 0 dark windows and 0 of the 45 Core-era windows above 1.04 (in sample for the Core era)', () => {
  const dark = EVENINGS.map((E) => run(E).v.checks.ratio).filter((r): r is number => r != null);
  assert.equal(Math.min(...dark), 0.9882);
  assert.equal(Math.max(...dark), 1.0285);
  // The Core era: every 7 consecutive whole days (within 14 site days) on which all three Cores covered
  // their daylight, the truth being the Cores' own meter.
  const t1 = run('2026-09-28').table;
  const t2 = run('2026-10-15').table;
  const days = new Map([...t1.days, ...t2.days]);
  const core = [...days.keys()].sort().filter((d) => [1, 2, 3].every((s) => {
    const x = days.get(d)!.slots.get(s);
    return x != null && x.complete && x.estDayWh != null && x.coreDaylightHours >= 0.8 * x.daylightHours;
  }));
  assert.equal(core.length, 51);
  const table = { ...t2, days };
  const ratios: number[] = [];
  for (let i = 6; i < core.length; i++) {
    const w = core.slice(i - 6, i + 1);
    if (addDaysYmd(w[0], 13) < w[6]) continue;
    ratios.push(windowBalance(table, w, [1, 2, 3]).ratio);
  }
  ratios.sort((a, b) => a - b);
  assert.equal(ratios.length, 45);
  assert.ok(Math.abs(ratios[0] - 0.9900) < 5e-5 && Math.abs(ratios[ratios.length - 1] - 1.0291) < 5e-5, `${ratios[0]}..${ratios[ratios.length - 1]}`);
  assert.equal(ratios.filter((r) => r > UC_THRESHOLD).length, 0);
});

test('★★★ M1: Saturday 10-31 judged as of Saturday passes at 1.0044 and reads the same at Sat 22:30, Sun 00:30 and Sun 09:30', () => {
  const t = eveningTimes('2026-10-31');
  const at = [t.t2130, t.t2230, t.t0030, t.nextDay0930].map((ms) => run('2026-10-31', { knownAtMs: ms }));
  for (const { v, adm } of at) {
    assert.equal(v.state, 'pass');
    assert.equal(v.checks.ratio, 1.0044);
    assert.deepEqual(v, at[0].v, 'one verdict, figures included');
    assert.deepEqual([...adm.entries()].map(([s, d]) => [s, [...d].sort()]), [...at[0].adm.entries()].map(([s, d]) => [s, [...d].sort()]));
  }
  // The window's own start day (Monday 11-02) as E would refuse that Saturday for staleness: the newest
  // whole day it can have seen is Thursday's (Friday's rows were partial), two days before E−2.
  const wrong = run('2026-11-02', { knownAtMs: t.t2230 }).v;
  assert.equal(wrong.state, 'refused');
  assert.equal(wrong.reason?.code, 'stale');
});

test('★★★ L3: 21:30, 22:30 and 00:30 of every evening read one verdict and one admitted set (data known at each instant)', () => {
  for (const E of EVENINGS) {
    const t = eveningTimes(E);
    const base = run(E, { knownAtMs: t.t2130 });
    for (const ms of [t.t2230, t.t0030]) {
      const x = run(E, { knownAtMs: ms });
      assert.deepEqual(x.v, base.v, `${E}`);
      assert.deepEqual(admCounts(x.adm), admCounts(base.adm));
    }
  }
});

test('★★★ M5: a judged-bad day planted on 11-03 refuses E+1..E+14 — G4 (a night field hour above 20 W) and G6 (the vendor 1.7 kWh below the field) each', () => {
  for (const [o, code] of [
    [{ nightReading: { slot: 2, day: '2026-11-03', w: 35 } }, 'night-reading'],
    [{ vendor: { '2026-11-03': 44_000 } }, 'vendor-mismatch'],
  ] as const) {
    assert.equal(run('2026-11-03', o).v.state, 'pass', 'the evening before the day is untouched');
    for (const E of ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']) {
      const { v } = run(E, o);
      assert.equal(v.state, 'refused', `${code} ${E}`);
      assert.equal(v.reason?.code, code);
      assert.equal((v.reason as { day: string }).day, '2026-11-03');
      assert.equal((v.reason as { lastHeldDay: string }).lastHeldDay, '2026-11-17', 'the reason names the day the hold ends');
    }
  }
  const g4 = run('2026-11-04', { nightReading: { slot: 2, day: '2026-11-03', w: 35 } }).v.reason;
  assert.deepEqual(g4, { code: 'night-reading', slot: 2, day: '2026-11-03', hourStartMs: (g4 as { hourStartMs: number }).hourStartMs, w: 35, acInWh: 0, lastHeldDay: '2026-11-17' },
    'G4 carries the slot\'s AC in for that hour (the figure the reason prints beside the add-on\'s force-charge state)');
  // The hold runs its 14 days and no further: planted on 10-21, refused to 11-04, passing 11-05.
  const o = { nightReading: { slot: 2, day: '2026-10-21', w: 35 } };
  assert.equal(run('2026-10-22', o).v.reason?.code, 'night-reading', 'a hold outranks the count');
  assert.equal(run('2026-11-04', o).v.reason?.code, 'night-reading');
  assert.equal(run('2026-11-05', o).v.state, 'pass');
});

test('★★★ M4: with slot 1 treated as reporting through its Core on every dark day, G6 sums every slot\'s field: 0 judged-bad days, the other two slots judged', () => {
  const o = { coreSourced: { slots: [1], fromDay: '2026-10-20', toDay: '2026-11-05' } };
  // Through the evening after the last such day (11-06: E−1 = 11-05); on 11-06 slot 1 takes the field again.
  for (const E of EVENINGS.filter((e) => e >= '2026-10-28' && e <= '2026-11-06')) {
    const { v, table } = run(E, o);
    assert.equal(v.state, 'pass', E);
    assert.deepEqual(v.checks.fieldSlots, [2, 3]);
    assert.equal(v.basis, 'mixed');
    for (const d of table.days.values()) if (d.day >= '2026-10-20' && d.day <= '2026-11-05') assert.notEqual(d.vendorOk, false, `${d.day}: not judged bad`);
  }
});

test('★★ G10: a day the field reads 3 % above the slot\'s Core refuses that slot for 30 days; 1 % does not', () => {
  const hi = { coreSourced: { slots: [1], fromDay: '2026-10-26', toDay: '2026-10-26', fieldOverCore: 1.03 } };
  for (const E of ['2026-10-28', '2026-11-05']) {
    assert.deepEqual(run(E, hi).v.reason, { code: 'overlap-hold', slot: 1, day: '2026-10-26', ratio: 1.03, lastHeldDay: '2026-11-25' });
  }
  const lo = { coreSourced: { slots: [1], fromDay: '2026-10-26', toDay: '2026-10-26', fieldOverCore: 1.01 } };
  assert.equal(run('2026-11-05', lo).v.state, 'pass');
});

test('★★★ the hysteresis: a ×1.10 week (10-27..10-29) holds the refusal until 7 later windows pass', () => {
  const o = { fault: { scale: 1.10, fromDay: '2026-10-27', toDay: '2026-10-29' } };
  const states = EVENINGS.filter((e) => e >= '2026-10-28').map((E) => {
    const { v } = run(E, o);
    return `${E.slice(5)} ${v.state === 'pass' ? 'P' : 'R'} ${v.checks.ratio} ${v.checks.max7}`;
  });
  assert.deepEqual(states, [
    '10-28 P 1.0044 1.0044',
    '10-29 P 1.0312 1.0312',
    '10-30 R 1.0459 1.0459',
    '10-31 R 1.0459 1.0459',
    '11-01 R 1.0668 1.0668',
    '11-02 R 1.077 1.077',
    '11-03 R 1.0428 1.077',
    '11-04 R 1.0521 1.077',
    '11-05 R 1.034 1.077',
    '11-06 R 1.0222 1.077',
    '11-07 R 1.0222 1.077',
  ], 'the current window passes from 11-05, the refusal holds while a failed one is among the last 7');
  // Admission: no faulted day re-enters the planning model, and the window that failed keeps its days out.
  const { adm } = run('2026-11-07', o);
  for (const days of adm.values()) for (const d of ['2026-10-23', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-31', '2026-11-01']) assert.ok(!days.has(d), d);
  assert.deepEqual(admCounts(adm), [4, 4, 4]);
});

test('★★★ planted step faults on the field (the vendor scaled with them, so G6 is blind), from each start 10-27..11-03: the first refusing evening', () => {
  const starts = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'];
  const firstRefusal = (scale: number, slots?: number[]): Array<string | null> => starts.map((s0) => {
    for (let E = addDaysYmd(s0, 1); E <= '2026-11-07'; E = addDaysYmd(E, 1)) if (!run(E, { fault: { scale, fromDay: s0, slots } }).v.ok) return E.slice(5);
    return null;
  });
  const table: Array<[string, number, number[] | undefined, Array<string | null>]> = [
    ['×1.03 all', 1.03, undefined, ['11-01', '11-02', null, null, null, null, null, null]],
    ['×1.05 all', 1.05, undefined, ['11-01', '11-01', '11-02', '11-06', '11-06', '11-06', '11-06', null]],
    ['×1.10 all', 1.10, undefined, ['10-30', '11-01', '11-01', '11-02', '11-02', '11-04', '11-05', '11-06']],
    ['×1.25 all', 1.25, undefined, ['10-29', '10-30', '11-01', '11-01', '11-01', '11-03', '11-04', '11-04']],
    ['×1.25 slot 1', 1.25, [1], ['10-30', '11-01', '11-01', '11-02', '11-02', '11-05', '11-05', '11-06']],
    ['×1.25 slot 2', 1.25, [2], ['11-01', '11-01', '11-01', '11-02', '11-02', '11-05', '11-05', '11-06']],
    ['×1.25 slot 3', 1.25, [3], ['11-01', '11-01', '11-01', '11-02', '11-02', '11-05', '11-05', '11-06']],
    ['×1.10 slot 1', 1.10, [1], ['11-01', '11-02', '11-06', '11-06', '11-06', null, null, null]],
    ['×1.10 slot 2', 1.10, [2], ['11-01', '11-02', '11-06', null, null, null, null, null]],
    ['×1.10 slot 3', 1.10, [3], ['11-01', '11-02', '11-06', null, null, null, null, null]],
  ];
  for (const [label, scale, slots, want] of table) assert.deepEqual(firstRefusal(scale, slots), want, label);
});

test('★★ M3: a planted ×1.10 refusal carries figures only — the balance, its daylight-only form and the night residual — and no cause', () => {
  const { v } = run('2026-11-01', { fault: { scale: 1.10, fromDay: '2026-10-28' } });
  assert.deepEqual(v.reason, { code: 'balance', windowEnd: '2026-10-31', ratio: 1.0613, daylightRatio: 1.0207, nightResidualKwhPerNight: -1.65, threshold: 1.04 });
  const honest = run('2026-11-01').v.checks;
  assert.equal(honest.balanceDaylightRatio, 0.9855, 'the honest week reads below 1 on daylight alone; the nights carry the rest');
  assert.equal(honest.nightResidualKwhPerNight, -1.65);
  assert.equal(honest.blindBandPct, 1.5, 'a sustained over-read below 1.04/R − 1 is not caught: disclosed');
});

test('★★ capacity: fit and check both on the held per-Core capacities move a window ≤ 1.1 % from nameplate; a lost pack on one slot ≤ 0.8 %', () => {
  let maxHeld = 0;
  let maxLost = 0;
  for (const E of EVENINGS.filter((e) => e >= '2026-10-28')) {
    const a = run(E).v.checks.ratio!;
    const b = run(E, { capacity: 'held' }).v.checks.ratio!;
    const c = run(E, { evalCapacity: { 1: 30_720, 2: 30_720 * 1.25, 3: 30_720 } }).v.checks.ratio!;
    maxHeld = Math.max(maxHeld, Math.abs(b / a - 1));
    maxLost = Math.max(maxLost, Math.abs(c / a - 1));
    assert.equal(run(E, { capacity: 'held' }).v.state, 'pass');
  }
  assert.ok(maxHeld < 0.011 && maxHeld > 0.009, `held vs nameplate ${maxHeld}`);
  assert.ok(maxLost < 0.008 && maxLost > 0.006, `lost pack ${maxLost}`);
});

test('★★ slot 3 removed on 10-28: a restart (whole days count again from 10-29), then the two-slot balance', () => {
  const o = { removed: { slots: [3], fromDay: '2026-10-28' } };
  assert.equal(run('2026-10-28', o).v.state, 'pass', 'as of 10-28 the record still had slot 3 at the end of 10-27');
  for (const E of ['2026-10-29', '2026-11-04', '2026-11-05']) {
    assert.deepEqual(run(E, o).v.reason, { code: 'restart', slot: null, day: '2026-10-29', kind: 'slot-set-changed' }, E);
  }
  const { v, adm } = run('2026-11-06', o);
  assert.equal(v.state, 'pass');
  assert.deepEqual(v.checks.fieldSlots, [1, 2]);
  assert.equal(v.checks.ratio, 1.0151);
  assert.deepEqual([...adm.keys()].sort(), [1, 2], 'admission is for the slots of the map of record');
});

test('★★ L1: one reason per clause, in precedence — the record, the capacity, the constants (before a restart), a restart, a stale or missing vendor day', () => {
  assert.deepEqual(run('2026-11-05', { noMembership: true }).v.reason, { code: 'no-membership-record' });
  assert.deepEqual(run('2026-11-05', { capacity: { 1: 30_720, 2: 30_720 } }).v.reason, { code: 'no-capacity', slot: 3 });
  // A Core swapped into slot 2 on 10-30: it has no constants (no whole day of its own meter in the slot),
  // and that, not the restart, is the reason.
  assert.deepEqual(run('2026-11-05', { entries: [{ fromDay: '2026-10-30', slots: { 1: 'C1', 2: 'C9', 3: 'C3' } }] }).v.reason,
    { code: 'no-constants', slot: 2, days: 0, chargeHours: 0, needDays: 21, needChargeHours: 20 });
  // Another Core in slot 2 for 10-25..10-26, then the measured Core back: a restart from 10-27.
  const back = { entries: [{ fromDay: '2026-10-25', slots: { 1: 'C1', 2: 'C9', 3: 'C3' } }, { fromDay: '2026-10-27', slots: { 1: 'C1', 2: 'C2', 3: 'C3' } }] };
  assert.deepEqual(run('2026-10-28', back).v.reason, { code: 'restart', slot: 2, day: '2026-10-27', kind: 'core-changed' });
  assert.equal(run('2026-11-03', back).v.state, 'pass');
  // Staleness: the vendor rows of 11-04 and 11-05 missing.
  assert.deepEqual(run('2026-11-07', { vendor: { '2026-11-04': null, '2026-11-05': null } }).v.reason, { code: 'stale', newest: '2026-11-03', minNewest: '2026-11-05' });
  // A missing vendor row is not a pass: the day is not counted, and the count names why.
  const nv = run('2026-10-28', { vendor: { '2026-10-27': null } }).v;
  assert.equal(nv.reason?.code, 'too-few-field-days');
  assert.deepEqual((nv.reason as { uncounted: Array<{ day: string; cause: string }> }).uncounted.find((u) => u.day === '2026-10-27'), { day: '2026-10-27', cause: 'no-vendor-row' });
});

test('★★★ (owner) 1.040 is strict: a window reading exactly the threshold passes, a hair above refuses', () => {
  const E = '2026-10-28';
  const { table } = assembleUcTable(recordSources(E), E);
  const v = upperCheck(table, E);
  assert.equal(v.state, 'pass');
  // The one full window as of 10-28 (7 field days): its exact ratio.
  const M = table.mapAsOf(E)!;
  const F = v.checks.fieldSlots;
  const days: string[] = [];
  for (let d = addDaysYmd(E, -1); days.length < 7; d = addDaysYmd(d, -1)) if (isFieldDay(table.days.get(d), F, M)) days.unshift(d);
  const exact = windowBalance(table, days, F).ratio;
  assert.equal(Math.round(exact * 1e4) / 1e4, v.checks.max7);
  const at = (threshold: number) => { const t = assembleUcTable(recordSources(E, { threshold }), E).table; return upperCheck(t, E); };
  assert.equal(at(exact).state, 'pass', 'at the threshold: refused only ABOVE it');
  assert.equal(at(exact - 1e-9).reason?.code, 'balance', 'a hair above: refused');
});

test('★★★ a day a slot\'s Core covered is no field day for that slot, though the panel read it too (the window counts field days only)', () => {
  // Slot 1 on its Core 10-21..10-23 (the panel's field present and the vendor row matching); E−1 on the field, so slot 1 takes it.
  const v = run('2026-10-28', { coreSourced: { slots: [1], fromDay: '2026-10-21', toDay: '2026-10-23' } }).v;
  assert.equal(v.reason?.code, 'too-few-field-days');
  const r = v.reason as { n: number; uncounted: Array<{ day: string; cause: string; slot?: number }> };
  assert.equal(r.n, 4);
  for (const day of ['2026-10-21', '2026-10-22', '2026-10-23']) assert.deepEqual(r.uncounted.find((u) => u.day === day), { day, cause: 'core-day', slot: 1 });
  assert.equal(run('2026-10-28').v.state, 'pass', 'the same evening on the record: 7 field days');
});

test('★★ Core-only days never count, and a day with partial rows names its cause', () => {
  const v = run('2026-10-27').v;
  assert.equal(v.reason?.code, 'too-few-field-days');
  const u = (v.reason as { uncounted: Array<{ day: string; cause: string; slot?: number; what?: string }> }).uncounted;
  assert.deepEqual(u.find((x) => x.day === '2026-10-13'), { day: '2026-10-13', cause: 'core-day', slot: 1 });
  assert.deepEqual(u.find((x) => x.day === '2026-10-24'), { day: '2026-10-24', cause: 'slot-incomplete', slot: 1, what: 'meter', frozenHours: 0 });
  assert.deepEqual(u.find((x) => x.day === '2026-10-19'), { day: '2026-10-19', cause: 'slot-incomplete', slot: 1, what: 'bridge', frozenHours: 0 }, 'G3: no bridge windows before 10-20');
});

test('★★ the record\'s own panel series: no frozen hour; no daylight AC-in hour since the Cores went dark, and no G11 proof yet (the field has never been seen under AC charge)', () => {
  const dark = Date.UTC(2026, 9, 15, 7);
  for (const s of ['1', '2', '3']) {
    assert.equal(RECORD.hours[s].filter((h) => h[9] === 1).length, 0, `slot ${s} frozen hours`);
    assert.equal(RECORD.hours[s].filter((h) => h[0] >= dark && h[1] === 1 && h[6] > 60).length, 0, `slot ${s} daylight AC-in hours since 10-15`);
    assert.ok(RECORD.hours[s].filter((h) => h[0] < dark && h[1] === 1 && h[6] > 60).length >= 4, `slot ${s}: the Core era's mid-day charge (10-10) is in the record`);
    assert.deepEqual(RECORD.proofDays[s], []);
  }
});

test('the fixture carries slot numbers and aliases only', () => {
  const txt = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'panelPvRecord.json'), 'utf8');
  const cores = new Set<string>();
  for (const e of RECORD.membership.entries) for (const v of Object.values(e.slots ?? {})) cores.add(v);
  for (const rows of Object.values(RECORD.bridge)) for (const r of rows) cores.add(r[1]);
  assert.deepEqual([...cores].sort(), ['C1', 'C2', 'C3']);
  assert.equal(RECORD.panel, 'P1');
  assert.ok(!/[A-Z0-9]{16}/.test(txt), 'no serial-length token');
});
