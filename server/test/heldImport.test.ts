import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApsREvModel, rateAt } from '../src/tariff.js';
import { heldImportEstimate, heldSpan, heldImportText, replaceCentsPerKwh } from '../src/middayShadow.js';
import { chooseChargeCycle, nextOnPeakStartMs } from '../src/chargeWindows.js';

/**
 * v1.192.0 — WHAT A HELD RESERVE SENDS TO THE GRID. The SHP2 does not discharge the pool below its
 * backup reserve, so while a leg's write holds it, house load the pool would have carried down to
 * the owner's reserve comes from the grid at that hour's rate; the pool keeps that energy and the
 * next charge buys that much less. The figures below are worked by hand.
 */

const H = 3_600_000;
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const D_EFF = 0.94;
const LEG_EFF = 0.927;
const RATES = buildApsREvModel({
  confirmed: true,
  onPeak: { summer: 39.5, winter: 39.5 }, superOffPeak: { summer: null, winter: 8.2 },
  overnight: { summer: 12.59, winter: 12.59 }, offPeak: { summer: 17, winter: 17 },
});
const cents = (ms: number): number | null => rateAt(RATES, ms).centsPerKwh;

/** Hours from `fromMs`, flat load and PV (W) unless `at` says otherwise. */
function hours(fromMs: number, n: number, at: (i: number) => { loadW: number; pvW: number }) {
  return Array.from({ length: n }, (_, i) => ({ ts: fromMs + i * H, loadP50W: at(i).loadW, pvP50W: at(i).pvW }));
}

const base = {
  fullKwh: 100, floorPct: 10, dischargeEff: D_EFF, legEff: LEG_EFF, centsAt: () => 12.59, replaceCentsPerKwh: 8.2,
};

test('★★★ a pool held at 50% sends to the grid what it would have carried below 50%, at the hour\'s rate; the pool keeps it for the next charge', () => {
  // 100 kWh, 60% at the open, 2 kW for 8 h, no sun. The free pool carries all 16 kWh (60 → 43 kWh);
  // the held one carries only (60 − 50) × 0.94 = 9.4 kWh, so 6.6 kWh comes from the grid.
  const from = phx(10, 14, 23);
  const h = heldImportEstimate({
    ...base, hours: hours(from, 8, () => ({ loadW: 2000, pvW: 0 })), fromMs: from, untilMs: from + 8 * H,
    startSocPct: 60, holdPct: 50,
  })!;
  assert.equal(h.kwh, 6.6);
  assert.equal(h.importUsd, 0.83, '6.6 kWh × 12.59¢');
  // Kept: 6.6 / 0.94 = 7.02 kWh in the pack, which the next charge does not buy: 7.02 / 0.927 × 8.2¢.
  assert.equal(h.creditUsd, 0.62);
  assert.equal(h.netUsd, 0.21);
  assert.deepEqual([h.fromMs, h.untilMs], [from, from + 8 * H]);
});

test('★★★ the lift to the reserve is the leg\'s own draw, not held import: from 30% every hour\'s load is held import', () => {
  const from = phx(10, 14, 23);
  const h = heldImportEstimate({
    ...base, hours: hours(from, 8, () => ({ loadW: 2000, pvW: 0 })), fromMs: from, untilMs: from + 8 * H,
    startSocPct: 30, holdPct: 50,
  })!;
  // The 20 kWh lift is not in it; the free pool (30 → 13 kWh) never reaches its 10% floor.
  assert.equal(h.kwh, 16);
  assert.equal(h.importUsd, 2.01);
  assert.equal(h.creditUsd, 1.51, 'all 16 / 0.94 kWh kept: 17.02 / 0.927 × 8.2¢');
});

test('★★ no hold, no estimate: a leg that writes nothing, no start, a missing hour, an empty span', () => {
  const from = phx(10, 15, 10);
  const hs = hours(from, 5, () => ({ loadW: 2000, pvW: 0 }));
  const o = { ...base, hours: hs, fromMs: from, untilMs: from + 5 * H, startSocPct: 40, holdPct: 50 };
  assert.ok(heldImportEstimate(o) != null);
  assert.equal(heldImportEstimate({ ...o, holdPct: null }), null);
  assert.equal(heldImportEstimate({ ...o, startSocPct: null }), null);
  assert.equal(heldImportEstimate({ ...o, hours: hs.filter((_, i) => i !== 2) }), null, 'a partial sum is not an estimate');
  assert.equal(heldImportEstimate({ ...o, hours: hs.map((x, i) => (i === 1 ? { ...x, loadP50W: null } : x)) }), null);
  assert.equal(heldImportEstimate({ ...o, untilMs: from }), null);
});

test('★★ a hold at or under the pool\'s level all span sends nothing; a hold under the owner\'s reserve holds at the reserve', () => {
  const from = phx(10, 14, 23);
  const hs = hours(from, 6, () => ({ loadW: 1000, pvW: 0 }));
  const o = { ...base, hours: hs, fromMs: from, untilMs: from + 6 * H };
  assert.equal(heldImportEstimate({ ...o, startSocPct: 90, holdPct: 50 })!.kwh, 0, '90% − 6.4 kWh stays above 50%');
  assert.equal(heldImportEstimate({ ...o, startSocPct: 12, holdPct: 5 })!.kwh, 0, 'a 5% write holds nothing the 10% reserve does not');
});

test('★★ sun lifts both pools alike: the held one carries the house again from above its hold', () => {
  // 50% held from 50%: an hour of 5 kW sun over a 1 kW house (+5 kWh into each pack, 4 / 0.94 net), then
  // 2 kW of house for 2 h, which the held pool carries from the sun's share down to 50%.
  const from = phx(10, 15, 10);
  const h = heldImportEstimate({
    ...base, hours: hours(from, 3, (i) => (i === 0 ? { loadW: 1000, pvW: 5000 } : { loadW: 2000, pvW: 0 })),
    fromMs: from, untilMs: from + 3 * H, startSocPct: 50, holdPct: 50,
  })!;
  // In the pack: +5 − 1/0.94 = 3.936 kWh of headroom; the 2 h draw 4.255 kWh; 0.319 kWh over → 0.3 AC.
  assert.equal(h.kwh, 0.3);
});

test('★★★ a full pool spills the sun the free one stores: only what the pool keeps is credited', () => {
  // A 40 kWh pool at 50% held at 75%: the lift takes it to 30 kWh, the first hour's house load (2 kW)
  // is held import, then 12 kWh of sun fills the held pool (spilling 2 kWh) while the free one stores it.
  const from = phx(10, 14, 23);
  const h = heldImportEstimate({
    ...base, fullKwh: 40, centsAt: cents,
    hours: hours(from, 2, (i) => (i === 0 ? { loadW: 2000, pvW: 0 } : { loadW: 0, pvW: 12000 })),
    fromMs: from, untilMs: from + 2 * H, startSocPct: 50, holdPct: 75,
  })!;
  assert.equal(h.kwh, 2);
  // Held 40 − free (20 − 2.128 + 12 = 29.872) − lift 10 = 0.128 kWh kept, not the 2.128 drawn:
  // 0.128 / 0.927 × 8.2¢ = $0.01 (all 2.128 would be $0.19).
  assert.equal(h.creditUsd, 0.01);
  assert.equal(h.importUsd, 0.25, '2 kWh at 12.59¢ (23:00 is overnight)');
});

test('★★ the hours\' own rates, and nothing priced when a rate is not known; the credit needs the cost window\'s rate', () => {
  // 22:00–00:00: off-peak (17¢) then overnight (12.59¢).
  const from = phx(10, 14, 22);
  const o = {
    ...base, centsAt: cents, hours: hours(from, 2, () => ({ loadW: 2000, pvW: 0 })),
    fromMs: from, untilMs: from + 2 * H, startSocPct: 50, holdPct: 50,
  };
  const h = heldImportEstimate(o)!;
  assert.equal(h.kwh, 4);
  assert.equal(h.importUsd, 0.59, '2 kWh × 17¢ + 2 kWh × 12.59¢');
  const unpriced = heldImportEstimate({ ...o, centsAt: () => null })!;
  assert.equal(unpriced.kwh, 4);
  assert.deepEqual([unpriced.importUsd, unpriced.netUsd], [null, null]);
  const noCredit = heldImportEstimate({ ...o, replaceCentsPerKwh: null })!;
  assert.deepEqual([noCredit.creditUsd, noCredit.netUsd], [null, null]);
  assert.equal(noCredit.importUsd, 0.59);
});

test('★★★ the plan\'s estimate holds: a 50% backup hold from ~55% at 23:00 sends ~9.5 kWh to the grid and adds ~$0.30 a weeknight', () => {
  // The 2026-10-14 fixture house (2.8 kW to midnight, 2.2 kW after), the 92.16 kWh pool, the 16% reserve.
  const from = phx(10, 14, 23);
  const until = phx(10, 15, 5);
  const h = heldImportEstimate({
    hours: hours(from, 6, (i) => ({ loadW: i === 0 ? 2800 : 2200, pvW: 0 })), fromMs: from, untilMs: until,
    startSocPct: 55, holdPct: 50, floorPct: 16, fullKwh: 92.16, dischargeEff: D_EFF, legEff: LEG_EFF,
    centsAt: cents, replaceCentsPerKwh: replaceCentsPerKwh(RATES, { role: 'cost', kind: 'super_off_peak', startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) }),
  })!;
  assert.equal(h.kwh, 9.47);
  assert.equal(h.importUsd, 1.19);
  assert.equal(h.creditUsd, 0.89);
  assert.equal(h.netUsd, 0.3);
  assert.match(heldImportText(h), /sends ~9\.5 kWh of house load to the grid \(median load and PV\), adding ~\$0\.30 to the bill against buying it back in the mid-day window\.$/);
});

test('★★ the hold is the write to the restore: the open to the close, or the on-peak guard when that is sooner', () => {
  const night = { startMs: phx(10, 14, 23), endMs: phx(10, 15, 5) };
  assert.deepEqual(heldSpan(night, nextOnPeakStartMs(RATES, night.startMs)), { fromMs: night.startMs, untilMs: night.endMs });
  const midday = { startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) };
  assert.deepEqual(heldSpan(midday, nextOnPeakStartMs(RATES, midday.startMs)), { fromMs: midday.startMs, untilMs: midday.endMs });
  // The chooser's legs for the fixture evening: the backup's hold ends before the cost leg's opens.
  const c = chooseChargeCycle(RATES, phx(10, 14, 21, 30), { costWindow: 'super_off_peak', objective: 'cost', costMaxSocPct: 90 });
  assert.ok(c.backup != null && c.cost != null);
  assert.ok(heldSpan(c.backup!, null).untilMs <= c.cost!.startMs);
});

test('★★ the text says what it costs, what it saves, or that it is not priced', () => {
  const h = { fromMs: 0, untilMs: H, kwh: 3.21, importUsd: 0.26, creditUsd: 0.38, netUsd: -0.12 };
  assert.match(heldImportText(h), /sends ~3\.2 kWh .*, saving ~\$0\.12 against buying it back in the mid-day window\.$/);
  assert.match(heldImportText({ ...h, netUsd: null }), /not priced \(the rates are not confirmed\)\.$/);
  assert.equal(heldImportText(null), '');
  assert.equal(heldImportText(undefined), '');
});

test('★★ the planner glue: a shadow leg is estimated on its own band, from the pool expected at the open, with the reserve it would write', () => {
  const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  // Only a leg that charges writes a reserve; a held plan holds nothing.
  assert.ok(INDEX.includes('holdPct: plan.chargeTonight && plan.setpointSocPct != null ? clampReserveTarget(plan.setpointSocPct) : null,'));
  assert.ok(INDEX.includes('startSocPct: plan.expectedStartSocPct ?? null,'));
  assert.ok(INDEX.includes('hours: bandHours, ...heldSpan(window, nextOnPeakStartMs(tariffModel, window.startMs)),'));
  assert.ok(INDEX.includes('replaceCentsPerKwh: shadowLeg.replaceCentsPerKwh ?? null,'));
  // …and the sized leg carries it to the record.
  assert.ok(INDEX.includes('heldImport: r.extras.heldImport ?? null,'));
});
