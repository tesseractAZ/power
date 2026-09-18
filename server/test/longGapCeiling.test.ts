import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveCheapWindow, nextFullCheapWindow, longGapAhead, FULL_CHEAP_WINDOW_MIN_MS, LONG_GAP_MS,
  buildNightChargeInputs, computeNightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';

/**
 * v1.168.0 — THE THURSDAY RULE and the MEDIAN surplus (owner: "proceed with the change
 * tonight", 2026-09-17).
 *
 * Measured over 8 weeks (wf_5bec76fe-34e): filling to ~90% on the night before a long
 * run of no cheap windows beats the solar-headroom ceiling by ~$1/week, and the P90
 * morning surplus the ceiling left room for was too cautious EVERY night (32.6 kWh
 * planned on 09-17 against measured Friday surpluses of 7.7-24.2 kWh, median ~16).
 */

const H = 3_600_000;
const model = buildApsREvModel();
const periodIdAt = (ts: number): string => rateAt(model, ts).periodId;
/** 21:30 MST on a 2026-09 date (MST = UTC-7, no DST in Phoenix). */
const at2130 = (day: number) => Date.UTC(2026, 8, day + 1, 4, 30); // 21:30 MST on Sep `day` = 04:30Z next day
const mst = (ms: number) => new Date(ms - 7 * H).toISOString().slice(0, 16).replace('T', ' ');

const gapAt = (nowMs: number) => {
  const tonight = resolveCheapWindow(periodIdAt, nowMs, 'overnight', 30);
  const next = tonight ? nextFullCheapWindow(periodIdAt, tonight.endMs, 'overnight') : null;
  return { tonight, next, long: longGapAhead(tonight, next) };
};

/* ══ the calendar ════════════════════════════════════════════════════════ */

test('★★★ Thursday night is a long gap: the next FULL window is Monday 00:00, stepping over Friday\'s 1 hour', () => {
  const g = gapAt(at2130(17)); // Thu 2026-09-17
  assert.equal(mst(g.tonight!.startMs), '2026-09-17 23:00');
  assert.equal(mst(g.tonight!.endMs), '2026-09-18 05:00');
  assert.equal(mst(g.next!.startMs), '2026-09-21 00:00', 'Friday 23:00-24:00 is stepped over');
  assert.equal(g.long, true);
});

test('★★★ Monday-Wednesday and Sunday nights are NOT long gaps (the next window is ~18 h away)', () => {
  for (const day of [14, 15, 16]) { // Mon, Tue, Wed
    const g = gapAt(at2130(day));
    assert.equal(g.long, false, `Sep ${day}`);
    assert.equal(g.next!.startMs - g.tonight!.endMs, 18 * H);
  }
  const sun = gapAt(at2130(20)); // Sun 2026-09-20: tonight is Mon 00:00-05:00
  assert.equal(mst(sun.tonight!.startMs), '2026-09-21 00:00');
  assert.equal(sun.long, false);
});

test('★★ Friday\'s 1-hour window is never a long-gap night — it is not a full window', () => {
  const g = gapAt(at2130(18)); // Fri 2026-09-18
  assert.equal(g.tonight!.endMs - g.tonight!.startMs, H);
  assert.equal(g.long, false, 'filling to 90% from a 1-hour window is not what was measured');
});

test('the thresholds', () => {
  assert.equal(FULL_CHEAP_WINDOW_MIN_MS, 3 * H);
  assert.equal(LONG_GAP_MS, 24 * H);
  const w = { startMs: 0, endMs: 6 * H };
  assert.equal(longGapAhead(w, { startMs: 6 * H + 24 * H, endMs: 0 }), false, 'exactly a day is not MORE than a day');
  assert.equal(longGapAhead(w, { startMs: 6 * H + 24 * H + 1, endMs: 0 }), true);
  assert.equal(longGapAhead(w, null), true, 'no full window within the scan at all');
  assert.equal(longGapAhead(null, null), false, 'no window tonight — no rule');
  assert.equal(longGapAhead({ startMs: 0, endMs: 3 * H - 1 }, null), false);
});

/* ══ the planner ═════════════════════════════════════════════════════════ */

const POOL = 92.16;
const EVE = at2130(15); // a Tue
const overnightPeriodIdAt = (ms: number): string | null => {
  const h = new Date(ms).getUTCHours();
  return h >= 6 && h < 12 ? 'overnight' : 'other';
};
const mkHorizon = (from: number, hours: number, pvW: number, loadW: number) =>
  Array.from({ length: hours }, (_, i) => ({ ts: from + i * H, pvP10W: pvW, loadP90W: loadW }));
function deps(over: Record<string, unknown> = {}) {
  return {
    gridInputCapKw: null, nowMs: EVE, fullKwh: POOL, socNowPct: 20,
    reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2,
    periodIdAt: overnightPeriodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: mkHorizon(EVE, 30, 0, 1500),
    dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: null,
    ev: null, evMaxLoadW: 11520, confidenceTier: 'forecast', forecastPresent: true,
    calScoredDays: 30, minCalScoredDays: 7, bandCoverageFrac: 0.9,
    morningPvSurplusP90Kwh: 32.6, minBuyKwh: 0, buyDebiasFactor: 1,
    islandedLoadKw: 4.47, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90,
    ...over,
  } as never;
}
const plan = (over: Record<string, unknown> = {}): any => computeNightChargePlan(buildNightChargeInputs(deps(over)));
const pctOf = (surplus: number) => Math.round(((POOL - surplus) / POOL) * 1000) / 10;

test('★★★ the cost ceiling leaves room for the MEDIAN surplus, not the P90', () => {
  const p = plan({ morningPvSurplusP50Kwh: 16 });
  assert.equal(p.costCeilingSocPct, pctOf(16), 'full − 16 kWh median, not full − 32.6 kWh P90');
  assert.equal(p.costCeilingSurplusKwh, 16);
  assert.equal(p.costCeilingBasis, 'pv-headroom');
});

test('★★ no median ⇒ the P90 stands in (never "no headroom at all")', () => {
  assert.equal(plan({ morningPvSurplusP50Kwh: null }).costCeilingSocPct, pctOf(32.6));
  assert.equal(plan({}).costCeilingSocPct, pctOf(32.6), 'an older caller that never passes it');
  assert.equal(plan({ morningPvSurplusP50Kwh: Number.NaN }).costCeilingSocPct, pctOf(32.6));
});

test('★★★ THE THURSDAY RULE: before a long gap the ceiling is the owner\'s SoC ceiling, whatever the sun', () => {
  const p = plan({ morningPvSurplusP50Kwh: 16, longGapAhead: true });
  assert.equal(p.costCeilingSocPct, 90, 'the owner\'s ARB_COST_MAX_SOC_PCT');
  assert.equal(p.costCeilingBasis, 'max-soc');
  assert.equal(p.longGapAhead, true);
  assert.equal(p.costCeilingSurplusKwh, null, 'the headroom is set aside, and the plan says so');
  assert.match(p.rationale, /morning-solar headroom is set aside/);
  // …and never PAST the owner's ceiling.
  assert.equal(plan({ longGapAhead: true, costMaxSocPct: 85 }).costCeilingSocPct, 85);
});

test('★★ a normal night reports no long gap, and the rationale does not claim one', () => {
  const p = plan({ morningPvSurplusP50Kwh: 16, longGapAhead: false });
  assert.equal(p.longGapAhead, false);
  assert.doesNotMatch(p.rationale, /set aside/);
});

test('★★ resilience mode is untouched by either input', () => {
  const a = plan({ objectiveMode: 'resilience' });
  const b = plan({ objectiveMode: 'resilience', morningPvSurplusP50Kwh: 1, longGapAhead: true });
  assert.equal(a.buyKwh, b.buyKwh);
  assert.equal(a.targetSocPct, b.targetSocPct);
  assert.equal(b.costCeilingSocPct ?? null, null);
});

/* ══ integration pins (index.ts has no seam a unit test can drive) ════════ */

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('★★★ index.ts computes the median surplus and the long gap, and hands BOTH to the planner', () => {
  assert.ok(INDEX.includes('morningSurplusP50Kwh += Math.max(0, pb.p50W - fh.forecastLoadW) / 1000;'),
    'the median over the same hours as the P90');
  assert.ok(INDEX.includes('nextFullCheapWindow(periodIdAt, window.endMs, NIGHT_CHEAP_PERIOD_ID)'),
    'the long gap is read from the tariff calendar, after tonight\'s window');
  assert.ok(INDEX.includes('morningPvSurplusP50Kwh, longGapAhead: nightLongGapAhead,'),
    'both reach the planner deps — an input computed and never passed is the v1.125.0 trap');
});
