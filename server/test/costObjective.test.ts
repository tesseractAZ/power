import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  costModeTargetKwh, DEFAULT_COST_MAX_SOC_PCT,
  computeNightChargePlan, buildNightChargeInputs,
} from '../src/nightChargeAdvisor.js';

/**
 * v1.127.0 — the COST objective.
 *
 * MEASURED TARIFF (live, TARIFF_APS_RATES_CONFIRMED=true):
 *   overnight 13.1c · off-peak 17.0c · on-peak summer 41.6c · RTE 0.86
 *   => stored overnight energy delivers at 15.23c, beating off-peak by +1.77c
 *      and on-peak by +26.37c. Every rate beats it, so "always fill" is the
 *      naive answer — and the reason it is wrong is sunlight, not money: a
 *      curtailed morning kWh costs the full 15.23c paid for the grid kWh in its
 *      place, 8.6x the weekend-carry gain.
 */

const POOL = 92.16;
const RESERVE = POOL * 0.16;

/* ── the ceiling ──────────────────────────────────────────────────────────── */

test('THE CEILING IS SUNLIGHT: a known morning surplus caps the fill', () => {
  const r = costModeTargetKwh({
    fullKwh: POOL, reserveKwh: RESERVE, morningPvSurplusP90Kwh: 30,
    maxSocPct: 90, resilienceTargetKwh: 20,
  });
  assert.equal(r.ceilingBasis, 'pv-headroom');
  assert.ok(Math.abs(r.targetKwh - (POOL - 30)) < 0.02, `got ${r.targetKwh}`);
});

test('with NO forecast the SoC cap holds the line — never "fill because we could not see"', () => {
  const r = costModeTargetKwh({
    fullKwh: POOL, reserveKwh: RESERVE, morningPvSurplusP90Kwh: null,
    maxSocPct: 90, resilienceTargetKwh: 20,
  });
  assert.equal(r.ceilingBasis, 'max-soc');
  assert.ok(Math.abs(r.targetKwh - POOL * 0.9) < 0.02, `got ${r.targetKwh}`);
  assert.ok(r.targetKwh < POOL, 'must leave headroom');
});

test('a present forecast can only LOWER the ceiling, never raise it', () => {
  // A tiny surplus would imply a ceiling above the SoC cap; the cap must win.
  const r = costModeTargetKwh({
    fullKwh: POOL, reserveKwh: RESERVE, morningPvSurplusP90Kwh: 1,
    maxSocPct: 90, resilienceTargetKwh: 20,
  });
  assert.ok(r.targetKwh <= POOL * 0.9 + 0.02, `got ${r.targetKwh}, above the SoC cap`);
});

/* ── the safety property ──────────────────────────────────────────────────── */

test('★ COST MODE CAN NEVER BUY LESS THAN RESILIENCE — the safety invariant', () => {
  // Changing the objective must never shrink the margin. Sweep a wide range of
  // resilience answers, including ones above every ceiling.
  for (const resilience of [0, 10, 30, 50, 70, 85, POOL, POOL * 2]) {
    for (const surplus of [null, 0, 5, 30, 60, 200]) {
      const r = costModeTargetKwh({
        fullKwh: POOL, reserveKwh: RESERVE, morningPvSurplusP90Kwh: surplus,
        maxSocPct: 90, resilienceTargetKwh: resilience,
      });
      assert.ok(r.targetKwh >= resilience - 1e-6,
        `resilience ${resilience} / surplus ${surplus} -> cost target ${r.targetKwh} is LOWER`);
      assert.ok(r.targetKwh >= RESERVE - 1e-6, 'and never below the reserve floor');
    }
  }
});

test('an absurd surplus cannot drive the target below the reserve floor', () => {
  const r = costModeTargetKwh({
    fullKwh: POOL, reserveKwh: RESERVE, morningPvSurplusP90Kwh: 1000,
    maxSocPct: 90, resilienceTargetKwh: 0,
  });
  assert.ok(r.targetKwh >= RESERVE - 1e-6, `got ${r.targetKwh}, below the ${RESERVE.toFixed(1)} kWh floor`);
});

test('the SoC cap is clamped to a sane range', () => {
  for (const pct of [-50, 0, 150, 1e9]) {
    const r = costModeTargetKwh({
      fullKwh: POOL, reserveKwh: RESERVE, morningPvSurplusP90Kwh: null,
      maxSocPct: pct, resilienceTargetKwh: 0,
    });
    assert.ok(r.targetKwh >= RESERVE - 1e-6 && r.targetKwh <= POOL + 1e-6, `pct ${pct} -> ${r.targetKwh}`);
  }
});

/* ── end-to-end through the planner ───────────────────────────────────────── */

const HOUR = 3_600_000;
const EVE = Date.UTC(2026, 8, 8, 4, 30); // Tue 21:30 MST
const overnightPeriodIdAt = (ms: number): string | null => {
  const h = new Date(ms).getUTCHours();
  return h >= 6 && h < 12 ? 'overnight' : 'other';   // 23:00-05:00 MST
};
const mkHorizon = (from: number, hours: number, pvW: number, loadW: number) =>
  Array.from({ length: hours }, (_, i) => ({ ts: from + i * HOUR, pvP10W: pvW, loadP90W: loadW }));

function deps(over: Record<string, unknown> = {}) {
  return {
    gridInputCapKw: null, nowMs: EVE, fullKwh: POOL, socNowPct: 40,
    reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2,
    periodIdAt: overnightPeriodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: mkHorizon(EVE, 30, 0, 1500),
    dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: null,
    ev: null, evMaxLoadW: 11520, confidenceTier: 'forecast', forecastPresent: true,
    calScoredDays: 30, minCalScoredDays: 7, bandCoverageFrac: 0.9,
    morningPvSurplusP90Kwh: null, minBuyKwh: 0, buyDebiasFactor: 1,
    islandedLoadKw: 4.47, outageCushionHours: 4, islandedLoadSafety: 1.25,
    ...over,
  } as never;
}

test('THE FIX END-TO-END: cost mode buys MORE than resilience on the same night', () => {
  const res: any = computeNightChargePlan(buildNightChargeInputs(deps({ objectiveMode: 'resilience' })));
  const cost: any = computeNightChargePlan(buildNightChargeInputs(deps({ objectiveMode: 'cost' })));
  assert.ok((cost.buyKwh ?? 0) > (res.buyKwh ?? 0),
    `cost ${cost.buyKwh} should exceed resilience ${res.buyKwh}`);
  assert.equal(cost.objective, 'cost_arbitrage');
  assert.equal(res.objective === 'cost_arbitrage', false);
});

test('cost mode never returns a LOWER target than resilience, across many nights', () => {
  for (const socNowPct of [5, 20, 40, 60, 80, 95]) {
    for (const surplus of [null, 10, 40]) {
      const res: any = computeNightChargePlan(buildNightChargeInputs(
        deps({ objectiveMode: 'resilience', socNowPct, morningPvSurplusP90Kwh: surplus })));
      const cost: any = computeNightChargePlan(buildNightChargeInputs(
        deps({ objectiveMode: 'cost', socNowPct, morningPvSurplusP90Kwh: surplus })));
      const r = res.targetSocPct ?? 0, c = cost.targetSocPct ?? 0;
      assert.ok(c >= r - 0.05, `soc ${socNowPct} surplus ${surplus}: cost ${c}% < resilience ${r}%`);
    }
  }
});

test('cost mode respects the morning-solar headroom rather than flagging itself over-buy', () => {
  const cost: any = computeNightChargePlan(buildNightChargeInputs(
    deps({ objectiveMode: 'cost', socNowPct: 80, morningPvSurplusP90Kwh: 25 })));
  assert.notEqual(cost.bindingCap, 'overBuy',
    'the headroom is the ceiling the target is BUILT from, not a line it crossed');
  assert.ok((cost.targetSocPct ?? 0) <= ((POOL - 25) / POOL) * 100 + 0.5,
    `target ${cost.targetSocPct}% exceeds the solar headroom`);
});

test('the default is unchanged — resilience unless explicitly switched', () => {
  const d: any = deps();
  delete (d as Record<string, unknown>).objectiveMode;
  const p: any = computeNightChargePlan(buildNightChargeInputs(d));
  assert.notEqual(p.objective, 'cost_arbitrage');
});

test('the rationale names the objective and which ceiling bound it', () => {
  const cost: any = computeNightChargePlan(buildNightChargeInputs(
    deps({ objectiveMode: 'cost', socNowPct: 30, morningPvSurplusP90Kwh: 25 })));
  if (cost.chargeTonight) {
    assert.match(String(cost.rationale), /Objective: COST/);
    assert.match(String(cost.rationale), /morning-solar headroom|state-of-charge ceiling/);
    assert.ok(cost.costCeilingBasis === 'pv-headroom' || cost.costCeilingBasis === 'max-soc');
  }
});
