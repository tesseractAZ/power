/**
 * v1.204.0 — panelPvBasis.ts on synthetic rows: the resolver (one source per slot-hour, never 0 W in a
 * daylight gap), the freeze detector, G11's charge proof, G3, the constants' fit, the balance window's
 * night clip, the map of record, admission. The recorded plant is replayed in panelPvBasisRecord.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOUR_COVER_MIN_S, UC_THRESHOLD, CONSTANTS_MIN_DAYS,
  acInSeconds, bridgeVerified, buildSlotDay, buildSlotHours, buildUcDay, chargeProofAt, fitPlantConstants, freezeSpans,
  hourEstimateWh, resolveSlotHour, siteHourStarts, slotDaySource, slotMapOfDay, slotMapOfRecord, windowBalance,
  admittedSlotDays, assembleUcTable, upperCheck,
  type PlantConstants, type Pt, type SlotHour, type UcTable,
} from '../src/panelPvBasis.js';
import { siteDayStartMs } from '../src/siteTime.js';
import type { MembershipHistory } from '../src/membershipHistory.js';
import { recordSources } from './fixtures/panelPvRecordFixtures.js';

const H = 3_600_000;
const DAY = '2026-11-02';
const T0 = siteDayStartMs(DAY);
const noonSun = (ms: number): boolean => { const h = ((ms - T0) / H) % 24; return h >= 7 && h < 17.5; };

const hour = (o: Partial<SlotHour> = {}): SlotHour => ({
  startMs: T0 + 12 * H, sun: true, pct0: 50, pct1: 52, outWh: 400, inWh: 0, acInS: 0,
  fieldWh: 2000, fieldCovS: 3600, frozen: false, coreRawWh: 0, coreCovS: 0, ...o,
});
const ctx = { g3: true, provedUnderCharge: false, admitted: true };

test('★★★ resolver: the Core wins with 3,500 s of its own pv_total and loses at 3,499 to a complete field hour', () => {
  const at = (cov: number) => resolveSlotHour(hour({ coreRawWh: 1900 * cov / 3600, coreCovS: cov }), ctx);
  assert.deepEqual(at(HOUR_COVER_MIN_S).source, 'core');
  assert.ok(Math.abs((at(HOUR_COVER_MIN_S).w as number) - 1900) < 1e-9, 'the Core hour is its mean over the covered part');
  assert.deepEqual(at(HOUR_COVER_MIN_S - 1), { source: 'field', w: 2000 });
});

test('★★★ resolver: a partial Core hour only without a field hour; a daylight gap is a gap, never 0 W', () => {
  assert.equal(resolveSlotHour(hour({ coreRawWh: 500, coreCovS: 1800 }), ctx).source, 'field');
  assert.deepEqual(resolveSlotHour(hour({ coreRawWh: 500, coreCovS: 1800, fieldWh: null, fieldCovS: 1200 }), ctx), { source: 'core-partial', w: 1000 });
  assert.deepEqual(resolveSlotHour(hour({ fieldWh: null, fieldCovS: 3499 }), ctx), { source: 'gap', w: null });
  assert.deepEqual(resolveSlotHour(hour(), { ...ctx, admitted: false }), { source: 'gap', w: null }, 'an unadmitted field day is a gap for the planning model');
  assert.deepEqual(resolveSlotHour(hour(), { ...ctx, g3: false }), { source: 'gap', w: null }, 'G3');
  assert.deepEqual(resolveSlotHour(hour({ frozen: true }), ctx), { source: 'gap', w: null }, 'a frozen daylight hour');
});

test('★★ resolver: night hours take the field as read', () => {
  assert.deepEqual(resolveSlotHour(hour({ sun: false, fieldWh: 0 }), ctx), { source: 'field', w: 0 });
  assert.deepEqual(resolveSlotHour(hour({ sun: false, fieldWh: 15 }), ctx), { source: 'field', w: 15 });
});

test('★★★ G11: an AC-in daylight hour is a gap before the slot is proved under charge, the field after', () => {
  const h = hour({ acInS: 61 });
  assert.equal(resolveSlotHour(h, ctx).source, 'gap');
  assert.equal(resolveSlotHour(h, { ...ctx, provedUnderCharge: true }).source, 'field');
  assert.equal(resolveSlotHour(hour({ acInS: 60 }), ctx).source, 'field', 'at most 60 s is not a charge hour');
  assert.equal(resolveSlotHour(hour({ acInS: 3000, sun: false, fieldWh: 0 }), ctx).source, 'field', 'G11 is a daylight rule');
  // The meter's AC in, seconds: rows above 25 W held until the next row.
  const pts: Pt[] = [{ ts: T0, value: 0 }, { ts: T0 + 100_000, value: 30 }, { ts: T0 + 400_000, value: 10 }, { ts: T0 + 1_400_000, value: 2000 }];
  assert.equal(acInSeconds(pts, T0, T0 + H), 300);
});

test('★★★ G11 proof: ≥ 30 min at ≥ 1 kW AC in, at night, with the field ≤ 20 W throughout', () => {
  const night = () => false;
  const run = (minutes: number, kw: number, fieldW: number, sun: (ms: number) => boolean = night): number | null => {
    const w: Pt[] = [];
    const f: Pt[] = [];
    for (let m = 0; m <= minutes; m += 5) { w.push({ ts: T0 + m * 60_000, value: kw * 1000 }); f.push({ ts: T0 + m * 60_000, value: fieldW }); }
    return chargeProofAt(w, f, sun);
  };
  assert.equal(run(30, 1.2, 0), T0 + 30 * 60_000);
  assert.equal(run(25, 1.2, 0), null, 'under 30 min');
  assert.equal(run(40, 0.9, 0), null, 'under 1 kW');
  assert.equal(run(40, 1.2, 35), null, 'the field read the charge');
  assert.equal(run(40, 1.2, 0, () => true), null, 'in daylight');
});

test('★★★ the freeze detector: 2,400 W restated every 300 s for 3 h is a gap from its second restatement; one restatement is not', () => {
  const sun = () => true;
  const rows: Pt[] = [];
  for (let k = 0; k <= 36; k++) rows.push({ ts: T0 + 9 * H + k * 300_000, value: 2400 });
  const spans = freezeSpans(rows, sun);
  assert.deepEqual(spans, [{ fromMs: T0 + 9 * H, toMs: T0 + 12 * H }]);
  assert.deepEqual(freezeSpans(rows.slice(0, 2), sun), [], 'one restatement pair');
  assert.deepEqual(freezeSpans(rows.slice(0, 3), sun), [{ fromMs: T0 + 9 * H, toMs: T0 + 9 * H + 600_000 }], 'the 10th minute');
  // A live field (it moves by ≥ 0.5 W), a dark one (≤ 50 W) and night rows are not frozen.
  assert.deepEqual(freezeSpans(rows.map((p, i) => ({ ...p, value: 2400 + (i % 2) })), sun), []);
  assert.deepEqual(freezeSpans(rows.map((p) => ({ ...p, value: 40 })), sun), []);
  assert.deepEqual(freezeSpans(rows, () => false), []);
  // In the hour table the frozen hours are gaps, on either MPPT field.
  const series = { pct: [{ ts: T0 - 60_000, value: 50 }], srcW: [], field: rows.map((p) => ({ ...p })), hv: rows, lv: [] };
  const hs = buildSlotHours([T0 + 9 * H, T0 + 10 * H, T0 + 12 * H, T0 + 13 * H], series, () => null, sun);
  assert.deepEqual(hs.map((h) => h.frozen), [true, true, true, false]);
  assert.equal(resolveSlotHour({ ...hs[0], fieldWh: 2400 }, ctx).source, 'gap');
});

test('★★★ G3: ≥ 80 % of the slot-day\'s daylight bridge windows measured for THAT day\'s Core, and the field trusted', () => {
  const rows = (measured: number, other: number, n: number) => [
    ...Array.from({ length: measured }, () => ({ sn: 'C2', panelSn: 'P', slot: 2, basis: 'measured' })),
    ...Array.from({ length: other }, () => ({ sn: 'C9', panelSn: 'P', slot: 2, basis: 'measured' })),
    ...Array.from({ length: n - measured - other }, () => ({ sn: 'C2', panelSn: 'P', slot: 2, basis: 'inferred' })),
    ...Array.from({ length: 50 }, () => ({ sn: 'C2', panelSn: 'P', slot: 2, basis: 'night' })),
  ];
  assert.equal(bridgeVerified(rows(80, 0, 100), 'P', 2, 'C2', true).g3, true);
  assert.equal(bridgeVerified(rows(79, 0, 100), 'P', 2, 'C2', true).g3, false, '0.79');
  assert.equal(bridgeVerified(rows(0, 100, 100), 'P', 2, 'C2', true).g3, false, 'windows booked for another Core');
  assert.equal(bridgeVerified(rows(100, 0, 100), 'P', 2, 'C2', false).g3, false, 'the field not trusted now');
  assert.equal(bridgeVerified(rows(100, 0, 100), 'P', 2, null, true).g3, false, 'no Core the record vouches for');
});

test('★★★ one Core per slot-day from the record: a swap day is off-roster; the map of record is the entry in force at the end of E−1', () => {
  const h: MembershipHistory = { entries: [
    { fp: 'A,B', atMs: siteDayStartMs('2026-10-01'), slots: { 'P:1': 'A', 'P:2': 'B' } },
    { fp: 'A,C', atMs: siteDayStartMs('2026-10-10') + 5 * H, slots: { 'P:1': 'A', 'P:2': 'C' } },
  ] };
  assert.deepEqual(slotMapOfDay(h, 'P', '2026-10-09'), { 1: 'A', 2: 'B' });
  assert.equal(slotMapOfDay(h, 'P', '2026-10-10'), null, 'the swap day');
  assert.deepEqual(slotMapOfDay(h, 'P', '2026-10-11'), { 1: 'A', 2: 'C' });
  assert.equal(slotMapOfDay(h, 'P', '2026-09-30'), null, 'before the record');
  assert.deepEqual(slotMapOfRecord(h, 'P', '2026-10-10'), { 1: 'A', 2: 'B' });
  assert.deepEqual(slotMapOfRecord(h, 'P', '2026-10-11'), { 1: 'A', 2: 'C' });
  // A flicker (a membership held under 15 min) is folded away: not a change.
  const f: MembershipHistory = { entries: [
    ...h.entries.slice(0, 1),
    { fp: 'A', atMs: siteDayStartMs('2026-10-05') + 3 * H, slots: { 'P:1': 'A' } },
    { fp: 'A,B', atMs: siteDayStartMs('2026-10-05') + 3 * H + 60_000, slots: { 'P:1': 'A', 'P:2': 'B' } },
  ] };
  assert.deepEqual(slotMapOfDay(f, 'P', '2026-10-05'), { 1: 'A', 2: 'B' });
  assert.deepEqual(slotMapOfRecord(f, 'P', '2026-10-06'), { 1: 'A', 2: 'B' });
});

/** Synthetic days of one slot whose constants are known: pv in daylight, a night charge, the percent
 *  following est = ΔE + c·O − g·I + e exactly (fractional percent). */
function syntheticDays(n: number, k: PlantConstants, chargeHoursPerNight: number, capWh = 30_720): Array<{ day: string; hours: SlotHour[] }> {
  const out: Array<{ day: string; hours: SlotHour[] }> = [];
  let pct = 40;
  for (let d = 0; d < n; d++) {
    const day = new Date(Date.UTC(2026, 7, 21 + d)).toISOString().slice(0, 10);
    const hours: SlotHour[] = [];
    for (const startMs of siteHourStarts(day)) {
      const hod = Math.round(((startMs - siteDayStartMs(day)) / H));
      const sun = hod >= 7 && hod <= 17;
      const pv = sun ? 3000 * Math.sin(Math.PI * (hod - 6) / 12) * (1 + 0.1 * Math.sin(d)) : 0;
      const out_ = 600 + 400 * Math.cos(hod + d) + (sun ? 200 : 0);
      const inn = !sun && hod >= 0 && hod < chargeHoursPerNight ? 1500 + 100 * (d % 3) : 0;
      const dE = pv - (sun ? k.cd : k.cn) * out_ + k.g * inn - (sun ? k.ed : k.en);
      const pct1 = pct + (dE / capWh) * 100;
      hours.push({ startMs, sun, pct0: pct, pct1, outWh: out_, inWh: inn, acInS: 0, fieldWh: pv, fieldCovS: 3600, frozen: false, coreRawWh: pv, coreCovS: 3600 });
      pct = pct1;
    }
    out.push({ day, hours });
  }
  return out;
}
const K: PlantConstants = { cd: 1.07, cn: 1.1, g: 0.92, ed: 80, en: 55, days: 0, firstDay: '', lastDay: '', chargeHours: 0, capacityWh: 30_720 };

test('★★★ the constants: recovered from rows that follow them; none below 21 days or 20 charge hours, or without a capacity', () => {
  const fit = fitPlantConstants(syntheticDays(25, K, 2), 30_720);
  const c = fit.constants!;
  assert.equal(fit.days, 25);
  assert.equal(fit.chargeHours, 50);
  for (const [a, b] of [[c.cd, K.cd], [c.cn, K.cn], [c.g, K.g], [c.ed, K.ed], [c.en, K.en]]) assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  assert.equal(fitPlantConstants(syntheticDays(CONSTANTS_MIN_DAYS - 1, K, 2), 30_720).constants, null, '20 days');
  assert.equal(fitPlantConstants(syntheticDays(25, K, 0), 30_720).constants, null, 'no night charge: g is not measured');
  const few = fitPlantConstants(syntheticDays(25, K, 2).map((d, i) => (i < 15 ? { ...d, hours: d.hours.map((h) => ({ ...h, inWh: 0 })) } : d)), 30_720);
  assert.equal(few.chargeHours, 20);
  assert.ok(few.constants != null, 'exactly 20 charge hours');
  const fewer = fitPlantConstants(syntheticDays(25, K, 2).map((d, i) => (i < 16 ? { ...d, hours: d.hours.map((h) => ({ ...h, inWh: 0 })) } : d)), 30_720);
  assert.equal(fewer.chargeHours, 18);
  assert.equal(fewer.constants, null, '18 charge hours: g is measured on too few (the fit would solve)');
  assert.equal(fitPlantConstants(syntheticDays(25, K, 2), null).constants, null, 'no capacity');
  // A day missing the Core's own meter in one hour is not a fit day.
  const days = syntheticDays(22, K, 2);
  days[3].hours[12] = { ...days[3].hours[12], coreCovS: 3000 };
  assert.equal(fitPlantConstants(days, 30_720).days, 21);
  // The estimate closes the balance on those rows: est − truth = 0.
  for (const h of days[5].hours) assert.ok(Math.abs((hourEstimateWh(h, K, 30_720) as number) - (h.sun ? h.coreRawWh : 0)) < 1e-6);
});

test('★★★ the balance window: a positive night total is clipped, a negative one kept (the nights may only lower the estimate)', () => {
  const mk = (estDay: number, estNight: number, truth: number) => ({ estDayWh: estDay, estNightWh: estNight, truthWh: truth, truthDaylightWh: truth });
  const table = (night: number): UcTable => ({
    days: new Map(['a', 'b'].map((d) => [d, { day: d, map: { 1: 'C' }, slots: new Map([[1, mk(10_000, night, 10_000) as never]]), vendorWh: null, fieldAllWh: null, vendorDiffWh: null, vendorOk: true }])),
    mapAsOf: () => ({ 1: 'C' }), constantsOf: () => null, capacityKnown: () => true,
  });
  assert.equal(windowBalance(table(+500), ['a', 'b'], [1]).ratio, 1, 'a positive night total is clipped to 0');
  assert.equal(windowBalance(table(-500), ['a', 'b'], [1]).ratio, 20_000 / 19_000, 'a negative one lowers the estimate');
  assert.equal(windowBalance(table(-500), ['a', 'b'], [1]).nightResidualKwhPerNight, -0.5);
  assert.equal(windowBalance(table(+500), ['a', 'b'], [1]).daylightRatio, 1);
});

test('★★ a slot-day: complete only when every hour resolves with the slot\'s percent and meter; the source of its daylight', () => {
  const hours = siteHourStarts(DAY).map((startMs) => hour({ startMs, sun: noonSun(startMs) || noonSun(startMs + H), fieldWh: noonSun(startMs) ? 2000 : 0 }));
  const ok = buildSlotDay(1, DAY, hours, { core: 'C', g3: true, provedUnderCharge: false, constants: K, capacityWh: 30_720 });
  assert.equal(ok.complete, true);
  assert.equal(slotDaySource(ok), 'panel');
  const gap = buildSlotDay(1, DAY, hours.map((h, i) => (i === 12 ? { ...h, fieldWh: null, fieldCovS: 3000 } : h)), { core: 'C', g3: true, provedUnderCharge: false, constants: K, capacityWh: 30_720 });
  assert.equal(gap.complete, false);
  assert.deepEqual(gap.incomplete, { startMs: hours[12].startMs, cause: 'coverage' });
  assert.equal(gap.estDayWh, null, 'no estimate on an incomplete day');
  const core = buildSlotDay(1, DAY, hours.map((h) => ({ ...h, coreRawWh: h.fieldWh as number, coreCovS: 3600 })), { core: 'C', g3: false, provedUnderCharge: false, constants: K, capacityWh: 30_720 });
  assert.equal(core.complete, true, 'its Core resolves every hour');
  assert.equal(slotDaySource(core), 'core');
  const night = buildSlotDay(1, DAY, hours.map((h, i) => (i === 2 ? { ...h, fieldWh: 35 } : h)), { core: 'C', g3: true, provedUnderCharge: false, constants: K, capacityWh: 30_720 });
  assert.deepEqual(night.nightMax, { w: 35, startMs: hours[2].startMs, acInWh: 0 });
  // G6 sums every slot's field (M4), whatever source the resolver chose; absent with a field gap.
  const d = buildUcDay(DAY, { 1: 'C', 2: 'D' }, new Map([[1, ok], [2, core]]), (ok.fieldAllWh as number) * 2);
  assert.equal(d.vendorOk, true);
  assert.equal(buildUcDay(DAY, { 1: 'C', 2: 'D' }, new Map([[1, ok], [2, gap]]), 1).vendorOk, null, 'not evaluable: never a pass');
  assert.equal(buildUcDay(DAY, { 1: 'C' }, new Map([[1, ok]]), null).vendorOk, null, 'no vendor row: never a pass');
});

test('★★★ admission: an unjudged day, day E and later never enter; a day in a failed window never enters', () => {
  // On the record (fixtures): as of 10-27 there are 6 field days and no judged window — none admitted.
  const as = (E: string, o = {}) => { const { table } = assembleUcTable(recordSources(E, o), E); return admittedSlotDays(table, E); };
  for (const days of as('2026-10-27').values()) assert.equal(days.size, 0);
  const at28 = as('2026-10-28');
  for (const days of at28.values()) {
    assert.deepEqual([...days].sort(), ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-25', '2026-10-26', '2026-10-27']);
    for (const d of days) assert.ok(d < '2026-10-28', 'day E never enters');
  }
  // A ×1.25 burst from 10-30: refused 11-01, and no faulted day is admitted then or after.
  for (const E of ['2026-11-01', '2026-11-03', '2026-11-05']) {
    for (const days of as(E, { fault: { scale: 1.25, fromDay: '2026-10-30' } }).values()) {
      for (const d of days) assert.ok(d < '2026-10-30' || d > '2026-11-30', `${E}: ${d} is faulted`);
    }
  }
});

test('★★ the threshold is the code constant 1.04 (not an option), and the module reads no owner option', () => {
  assert.equal(UC_THRESHOLD, 1.04);
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/panelPvBasis.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['config.js', 'limits.js', 'option(', 'process.env', 'RUNWAY_', 'DISPATCH_', 'runwayDrainW', 'runwayPoolOverheadW', 'analytics']) {
    assert.ok(!code.includes(banned), `panelPvBasis.ts reads ${banned}`);
  }
  // And so the verdict on the record does not move with an option: the same at any RUNWAY_POOL_OVERHEAD_FLOOR_W.
  const E = '2026-11-05';
  const { table } = assembleUcTable(recordSources(E), E);
  const before = upperCheck(table, E);
  const prev = process.env.RUNWAY_POOL_OVERHEAD_FLOOR_W;
  try {
    for (const w of ['0', '270', '400', '1500']) {
      process.env.RUNWAY_POOL_OVERHEAD_FLOOR_W = w;
      const { table: t } = assembleUcTable(recordSources(E), E);
      assert.deepEqual(upperCheck(t, E), before);
    }
  } finally {
    if (prev === undefined) delete process.env.RUNWAY_POOL_OVERHEAD_FLOOR_W; else process.env.RUNWAY_POOL_OVERHEAD_FLOOR_W = prev;
  }
});
