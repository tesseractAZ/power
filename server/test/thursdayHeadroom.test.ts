import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveCheapWindow, nextFullCheapWindow, longGapAhead,
  buildNightChargeInputs, computeNightChargePlan,
  pessimisticPrePeakSurplus, PRE_PEAK_SURPLUS_MAX_HOURS,
} from '../src/nightChargeAdvisor.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';

/**
 * v1.186.0 — the long-gap ("Thursday rule") ceiling keeps a PESSIMISTIC solar headroom.
 *
 * Production, 2026-09-24→25: the long-gap night set the solar headroom aside, bought
 * ~56.8 kWh to reach 90%, the pool was full before 11:00 on a sunny Thursday-into-Friday,
 * and the Cores curtailed 12.27 kWh of PV that day. The ceiling is now
 * min(ARB_COST_MAX_SOC_PCT, full − the P10 surplus from window close to the evening
 * on-peak start). P10 is the LOW-PV quantile (analytics.ts ForecastBand.p10W,
 * "10th-percentile PV (worst case, cloudy)"; P90 is the best case).
 */

const H = 3_600_000;
const model = buildApsREvModel();
const periodIdAt = (ts: number): string => rateAt(model, ts).periodId;
const isOnPeakAt = (ts: number): boolean => rateAt(model, ts).isOnPeak;
/** hh:00 MST on 2026-09-`day` (MST = UTC-7, no DST in Phoenix). */
const mstAt = (day: number, hh: number) => Date.UTC(2026, 8, day, hh + 7, 0);
const EVE = mstAt(24, 21) + 30 * 60_000; // Thu 2026-09-24 21:30 MST — the plan's fire time
const POOL = 92.16;

/* ══ the calendar: 09-24 IS a long-gap night, and its window closes Fri 05:00 ════ */

const tonight = resolveCheapWindow(periodIdAt, EVE, 'overnight', 30)!;
const WEND = tonight.endMs;

test('09-24 is a long-gap night; the window closes Fri 05:00 and Friday\'s on-peak opens 16:00', () => {
  assert.equal(WEND, mstAt(25, 5));
  assert.equal(longGapAhead(tonight, nextFullCheapWindow(periodIdAt, tonight.endMs, 'overnight')), true);
  assert.equal(isOnPeakAt(mstAt(25, 15)), false);
  assert.equal(isOnPeakAt(mstAt(25, 16)), true);
});

/* ══ the pessimistic pre-peak surplus ═══════════════════════════════════ */

/** A sunny Friday: P10 watts by MST hour, against the forecast house load. */
const SUNNY_P10: Record<number, number> = {
  5: 0, 6: 500, 7: 2000, 8: 5000, 9: 7000, 10: 8000, 11: 8500, 12: 8500,
  13: 8000, 14: 7000, 15: 5500, 16: 9000, 17: 1000, 18: 0,
};
const LOAD: Record<number, number> = {
  5: 2500, 6: 2500, 7: 2500, 8: 2500, 9: 2800, 10: 3000, 11: 3100, 12: 3400,
  13: 3900, 14: 4400, 15: 5000, 16: 5200, 17: 5300, 18: 4500,
};
const hoursOf = (p10: Record<number, number>) =>
  Object.keys(p10).map(Number).map((hh) => ({ ts: mstAt(25, hh), p10W: p10[hh], loadW: LOAD[hh] }));
/** max(0, P10 − load) over 05:00-15:00 by hand — 16:00 is on-peak and excluded. */
const SUNNY_EXPECTED = [0, 0, 0, 2500, 4200, 5000, 5400, 5100, 4100, 2600, 500]
  .reduce((a, b) => a + b, 0) / 1000; // 29.4 kWh

test('★★★ the surplus is summed from window close to the on-peak START — the peak hours are excluded', () => {
  const r = pessimisticPrePeakSurplus({ hours: hoursOf(SUNNY_P10), windowEndMs: WEND, isOnPeakAt });
  assert.equal(r.untilMs, mstAt(25, 16), 'bounded by Friday\'s 16:00 on-peak start');
  assert.equal(r.kwh, SUNNY_EXPECTED, 'the 16:00 hour (3.8 kWh of P10 surplus) is NOT headroom');
});

test('★★ the surplus is the P10 field — a P50/P90-sized day is not read', () => {
  const r = pessimisticPrePeakSurplus({
    hours: hoursOf(SUNNY_P10).map((h) => ({ ...h, p50W: 20_000, p90W: 30_000 })),
    windowEndMs: WEND, isOnPeakAt,
  });
  assert.equal(r.kwh, SUNNY_EXPECTED);
});

test('★★★ absence is not evidence: no covered hour, or a non-finite P10/load, ⇒ null', () => {
  assert.equal(pessimisticPrePeakSurplus({ hours: [], windowEndMs: WEND, isOnPeakAt }).kwh, null);
  const bad = hoursOf(SUNNY_P10);
  bad[4] = { ...bad[4], p10W: Number.NaN };
  assert.equal(pessimisticPrePeakSurplus({ hours: bad, windowEndMs: WEND, isOnPeakAt }).kwh, null);
  const badLoad = hoursOf(SUNNY_P10);
  badLoad[4] = { ...badLoad[4], loadW: Number.NaN };
  assert.equal(pessimisticPrePeakSurplus({ hours: badLoad, windowEndMs: WEND, isOnPeakAt }).kwh, null);
  // Hours outside the span do not count as coverage.
  const outside = [{ ts: mstAt(25, 17), p10W: 9000, loadW: 1000 }];
  assert.equal(pessimisticPrePeakSurplus({ hours: outside, windowEndMs: WEND, isOnPeakAt }).kwh, null);
});

test('★★ with no on-peak ahead (holiday/weekend) the span is capped at the morning-surplus horizon', () => {
  assert.equal(PRE_PEAK_SURPLUS_MAX_HOURS, 14);
  const r = pessimisticPrePeakSurplus({ hours: hoursOf(SUNNY_P10), windowEndMs: WEND, isOnPeakAt: () => false });
  assert.equal(r.untilMs, WEND + 14 * H);
  assert.ok(r.kwh! > SUNNY_EXPECTED, 'the 16:00-18:00 hours now count');
});

/* ══ the planner ═════════════════════════════════════════════════════════ */

function deps(over: Record<string, unknown> = {}) {
  return {
    gridInputCapKw: null, nowMs: EVE, fullKwh: POOL, socNowPct: 50,
    reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 10,
    periodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: Array.from({ length: 30 }, (_, i) => ({ ts: mstAt(24, 21) + i * H, pvP10W: 0, loadP90W: 1500 })),
    dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: null,
    ev: null, evMaxLoadW: 11520, confidenceTier: 'forecast', forecastPresent: true,
    calScoredDays: 30, minCalScoredDays: 7, bandCoverageFrac: 0.9,
    morningPvSurplusP90Kwh: 43.5, morningPvSurplusP50Kwh: 23, minBuyKwh: 0, buyDebiasFactor: 1,
    islandedLoadKw: 4.47, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90, longGapAhead: true,
    ...over,
  } as never;
}
const plan = (over: Record<string, unknown> = {}): any => computeNightChargePlan(buildNightChargeInputs(deps(over)));
const pctOf = (surplus: number) => Math.round(((POOL - surplus) / POOL) * 1000) / 10;

test('★★★ 09-24 reproduced: a sunny long-gap night keeps the P10 headroom — the ceiling drops below 90', () => {
  const p10 = pessimisticPrePeakSurplus({ hours: hoursOf(SUNNY_P10), windowEndMs: WEND, isOnPeakAt }).kwh;
  const p = plan({ prePeakPvSurplusP10Kwh: p10 });
  const before = plan({ prePeakPvSurplusP10Kwh: null }); // the v1.168.0 behaviour
  assert.equal(before.costCeilingSocPct, 90, 'the headroom set aside: the 09-24 buy to 90%');
  assert.equal(p.longGapAhead, true);
  assert.equal(p.costCeilingSocPct, pctOf(SUNNY_EXPECTED), 'full − the P10 pre-peak surplus');
  assert.ok(p.costCeilingSocPct < 90);
  assert.equal(p.costCeilingBasis, 'pv-headroom');
  assert.equal(p.costCeilingSurplusBasis, 'p10');
  assert.equal(p.costCeilingSurplusKwh, SUNNY_EXPECTED);
  assert.equal(p.targetSocPct, pctOf(SUNNY_EXPECTED), 'the pack is filled only to the ceiling');
  assert.equal(before.targetSocPct, 90);
  assert.ok(p.buyKwh < before.buyKwh - 15, `the buy shrinks by the room left for the sun (${p.buyKwh} vs ${before.buyKwh})`);
  assert.match(p.rationale, /pessimistic \(P10\) solar surplus before the evening peak/);
  assert.doesNotMatch(p.rationale, /set aside/);
});

test('★★★ a cloudy forecast still gets the full long-gap buy to 90', () => {
  const cloudy: Record<number, number> = Object.fromEntries(Object.keys(SUNNY_P10).map((k) => [k, 1200]));
  const p10 = pessimisticPrePeakSurplus({ hours: hoursOf(cloudy), windowEndMs: WEND, isOnPeakAt }).kwh;
  assert.equal(p10, 0, 'P10 never clears the load');
  const p = plan({ prePeakPvSurplusP10Kwh: p10 });
  const before = plan({ prePeakPvSurplusP10Kwh: null });
  assert.equal(p.costCeilingSocPct, 90);
  assert.equal(p.costCeilingBasis, 'max-soc');
  assert.equal(p.costCeilingSurplusBasis, 'p10');
  assert.equal(p.buyKwh, before.buyKwh, 'the same buy the Thursday rule always made');
  assert.equal(p.targetSocPct, before.targetSocPct);
  // A small P10 surplus (under 10% of the pool) leaves the owner's ceiling binding.
  assert.equal(plan({ prePeakPvSurplusP10Kwh: 5 }).costCeilingSocPct, 90);
  // A negative input is no surplus, never extra room above full.
  const neg = plan({ prePeakPvSurplusP10Kwh: -8 });
  assert.equal(neg.costCeilingSocPct, 90);
  assert.equal(neg.costCeilingSurplusKwh, 0, 'the ledger records no surplus, not a negative one');
});

test('★★★ an unknown P10 keeps the headroom set aside (the full buy), and says so', () => {
  for (const v of [null, undefined, Number.NaN]) {
    const p = plan({ prePeakPvSurplusP10Kwh: v });
    assert.equal(p.costCeilingSocPct, 90);
    assert.equal(p.costCeilingSurplusBasis, 'none');
    assert.equal(p.costCeilingSurplusKwh, null);
    assert.match(p.rationale, /morning-solar headroom is set aside/);
  }
});

test('★★★ a normal night ignores the P10 entirely — the median path is unchanged', () => {
  const a = plan({ longGapAhead: false });
  const b = plan({ longGapAhead: false, prePeakPvSurplusP10Kwh: 60 });
  assert.equal(a.costCeilingSocPct, pctOf(23), 'the median still sizes a normal night');
  assert.equal(b.costCeilingSocPct, a.costCeilingSocPct);
  assert.equal(b.costCeilingSurplusBasis, 'p50');
  assert.equal(b.buyKwh, a.buyKwh);
});

test('★★ the P10 headroom never pushes the cost target below the resilience target', () => {
  const res = plan({ objectiveMode: 'resilience', prePeakPvSurplusP10Kwh: 90 });
  const cost = plan({ prePeakPvSurplusP10Kwh: 90 });
  assert.ok(cost.targetSocPct >= res.targetSocPct, `${cost.targetSocPct} ≥ ${res.targetSocPct}`);
  assert.equal(res.costCeilingSocPct ?? null, null, 'resilience mode reads no ceiling');
});

/* ══ integration pins (index.ts has no seam a unit test can drive) ════════ */

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('★★★ index.ts feeds the P10 band, bounded by the tariff on-peak, into the planner deps', () => {
  assert.ok(INDEX.includes('prePeakP10Hours.push({ ts: pb.ts, p10W: pb.p10W, loadW: fh.forecastLoadW });'),
    'the LOW-PV quantile, against the same forecast load as the median');
  assert.ok(INDEX.includes('isOnPeakAt: (ts) => rateAt(tariffModel, ts).isOnPeak,'),
    'the span stops at the tariff\'s own on-peak start');
  assert.ok(INDEX.includes('morningPvSurplusP50Kwh, longGapAhead: nightLongGapAhead, prePeakPvSurplusP10Kwh,'),
    'computed AND passed — an input computed and never passed is the v1.125.0 trap');
});
