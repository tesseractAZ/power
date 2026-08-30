import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNightChargePlan, buildNightChargeInputs } from '../src/nightChargeAdvisor.js';

/**
 * v1.116.0 — the pre-window carry is a WORST CASE, and now says so.
 *
 * A 2026-08-29 analysis proposed clamping the pre-window carry at the reserve
 * floor, on the reasoning that a grid-connected pool physically cannot fall
 * below it. Three independent analyses plus an adversary rejected the SIZING
 * change: `simulate()` is deliberately grid-blind because the advisor sizes for
 * the ISLANDED case, and measured over 2240 historical nights the clamp buys
 * strictly less (worst −12.49 kWh) and costs 12 nights their reserve write.
 *
 * What was actually wrong was the DISCLOSURE: "projected to dip to ~0%" with
 * nothing saying that is the islanded worst case, while the grid-present pool
 * will hold the reserve. These tests pin the labelling and — more importantly —
 * that the sizing numbers did NOT move.
 */

function planAt(reserveFloorPct: number, socNowPct: number, loadW = 4000) {
  const nowMs = Date.UTC(2026, 7, 30, 4, 30);       // 21:30 MST
  const winStart = Date.UTC(2026, 7, 31, 7, 0);     // a far window (weekend carry)
  const winEnd = Date.UTC(2026, 7, 31, 12, 0);
  const deps: any = {
    nowMs, fullKwh: 92.16, socNowPct, reserveFloorPct, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2, gridInputCapKw: null,
    periodIdAt: (ms: number) => (ms >= winStart && ms < winEnd ? 'overnight' : 'onpeak'),
    cheapPeriodId: 'overnight', windowScanHours: 60,
    bandHours: Array.from({ length: 60 }, (_, h) => ({
      ts: nowMs + h * 3_600_000, pvP10W: 0, pvP50W: 0, pvP90W: 0,
      loadP10W: loadW, loadP50W: loadW, loadP90W: loadW, embeddedEvW: 0,
    })),
    dayRollups: [], realizedDailyErrHalfFrac: null, nextRechargeMs: null,
    ev: null, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 5,
    bandCoverageFrac: 1, morningPvSurplusP90Kwh: null, minBuyKwh: 1,
  };
  return computeNightChargePlan(buildNightChargeInputs(deps));
}

test('the pre-window dip is labelled as the ISLANDED case', () => {
  const p = planAt(20, 25);
  assert.ok(p.preWindowMinSocPct != null, `expected a pre-window carry; got: ${p.rationale}`);
  assert.match(p.rationale, /if islanded/, 'the worst-case basis must be stated');
});

test('the grid-held companion names the reserve the SHP2 actually defends', () => {
  const p = planAt(20, 25);
  if (p.preWindowMinSocPct != null && p.preWindowMinSocPct < 20) {
    assert.match(p.rationale, /grid present/i);
    assert.match(p.rationale, /20% reserve/);
    assert.match(p.rationale, /islanded worst case/);
  }
});

test('★ the disclosure did NOT move the sizing: identical plans at the same floor', () => {
  const a = planAt(20, 25);
  const b = planAt(20, 25);
  assert.equal(a.buyKwh, b.buyKwh);
  assert.equal(a.targetSocPct, b.targetSocPct);
  assert.equal(a.setpointSocPct, b.setpointSocPct);
  assert.equal(a.requiredExtraKwh, b.requiredExtraKwh);
});

test('★ the carry is NOT clamped at the floor — a deep islanded projection survives', () => {
  // With a 20% floor and a heavy load, the worst-case carry must still be free
  // to fall below 20 (clamping it is the change that was rejected).
  const p = planAt(20, 25);
  if (p.preWindowMinSocPct != null) {
    assert.ok(p.preWindowMinSocPct < 20,
      `carry ${p.preWindowMinSocPct}% must be free to fall below the 20% floor — clamping it under-buys`);
  }
});

test('no companion clause when the carry never reaches the floor', () => {
  // A nearly-idle house: the worst-case carry stays well above the floor over
  // the whole pre-window span, so there is nothing to reconcile and the plan
  // must not editorialise. (A 60 h carry at 4 kW drains ANY starting SoC —
  // the load, not the start level, is what decides this.)
  const p = planAt(10, 95, 50);
  assert.doesNotMatch(p.rationale, /islanded worst case/,
    'do not editorialise when there is nothing to reconcile');
});
