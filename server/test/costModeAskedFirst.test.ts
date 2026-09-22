import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNightChargePlan, buildNightChargeInputs } from '../src/nightChargeAdvisor.js';
import { armFromPlan, emptyActuationState } from '../src/nightChargeActuator.js';

/**
 * v1.174.0 — COST MODE IS ASKED BEFORE IT HOLDS (memory: "COST MODE MAY NEVER BE ASKED";
 * v1.168.0 follow-up #1). The resilience HOLD early return ran ahead of the cost block, so
 * a night whose pack already cleared floor+cushion at window close never bought toward the
 * cost ceiling — Thursday's 90% long-gap ceiling included.
 */
const POOL = 92.16, H = 3_600_000;
const EVE = Date.UTC(2026, 8, 18, 4, 30); // Thu 2026-09-17 21:30 MST
const overnight = (ms: number): string | null => { const h = new Date(ms).getUTCHours(); return h >= 6 && h < 12 ? 'overnight' : 'other'; };
const hz = (from: number, n: number, pvW: number, loadW: number) => Array.from({ length: n }, (_, i) => ({ ts: from + i * H, pvP10W: pvW, loadP90W: loadW }));
function deps(over: Record<string, unknown> = {}) {
  return {
    gridInputCapKw: null, nowMs: EVE, fullKwh: POOL, socNowPct: 70, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2, periodIdAt: overnight, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: hz(EVE, 30, 0, 1500), dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: null,
    ev: null, evMaxLoadW: 11520, confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 7, bandCoverageFrac: 0.9,
    morningPvSurplusP90Kwh: 32.6, morningPvSurplusP50Kwh: 16, minBuyKwh: 1, buyDebiasFactor: 1,
    islandedLoadKw: 4.47, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90, longGapAhead: true, ...over,
  } as never;
}
const plan = (over: Record<string, unknown> = {}): any => computeNightChargePlan(buildNightChargeInputs(deps(over)));

test('★★★ THE MEASURED DEFECT: a high-pack Thursday in cost mode buys toward the 90% ceiling', () => {
  const res = plan({ objectiveMode: 'resilience' });
  assert.equal(res.chargeTonight, false, 'premise: resilience needs nothing tonight');
  assert.match(res.rationale, /no charge needed/);
  const p = plan();
  assert.equal(p.chargeTonight, true);
  assert.equal(p.objective, 'cost_arbitrage');
  assert.ok(p.buyKwh > 1, `buy ${p.buyKwh}`);
  assert.equal(p.targetSocPct, 90);
  assert.equal(p.costCeilingSocPct, 90);
  assert.equal(p.longGapAhead, true);
  assert.equal(p.requiredExtraKwh, 0, 'resilience asked for nothing — the buy is economic');
  assert.equal(p.cushionShortfall, false);
  assert.match(p.rationale, /economic only/);
});

test('★★ the resilience hold is byte-identical (no cost fields, same rationale)', () => {
  const r = plan({ objectiveMode: 'resilience' });
  assert.equal(r.costCeilingSocPct ?? null, null);
  assert.equal(r.buyKwh, 0);
  assert.equal(r.setpointSocPct, r.targetSocPct);
});

test('★★ cost mode still HOLDS when the pack already sits at/above the ceiling — and says which ceiling', () => {
  const p = plan({ socNowPct: 100, longGapAhead: false, morningPvSurplusP50Kwh: 40 });
  assert.equal(p.chargeTonight, false);
  assert.equal(p.objective, 'none');
  assert.equal(p.buyKwh, 0);
  assert.equal(p.costCeilingBasis, 'pv-headroom', 'the ledger shows cost mode WAS asked');
  assert.ok(p.costCeilingSocPct != null);
  assert.match(p.rationale, /at or above tonight's [\d.]+% cost ceiling/);
  assert.match(p.rationale, /no charge needed/, 'classed with the no-shortfall hold (ledgerLegibility taxonomy)');
  assert.doesNotMatch(p.rationale, /genuinely small|cannot serve the need/);
});

test('★ ARB_MIN_BUY_KWH=0 never turns an at-ceiling night into "Buy ~0 kWh"', () => {
  const p = plan({ socNowPct: 100, longGapAhead: false, morningPvSurplusP50Kwh: 40, minBuyKwh: 0 });
  assert.equal(p.chargeTonight, false);
  assert.equal(p.objective, 'none');
});

test('★ a starved window toward the ceiling holds with the minimum-buy reason', () => {
  const p = plan({ chargeCapKw: 0.05 });
  assert.equal(p.chargeTonight, false);
  assert.match(p.rationale, /minimum buy/);
  assert.match(p.rationale, /no charge needed/);
});

test('★★★ the economic-only plan ARMS: reserve bounded, force-charge to the 90% ceiling', () => {
  const p = plan();
  const s = armFromPlan(emptyActuationState(), '2026-09-17', p, EVE, 16);
  assert.ok(s, 'armable');
  assert.equal(s!.forceChargeCeilingPct, 90);
  assert.equal(s!.targetPct, 50);
});

test('★★ an economic-only night never writes a reserve ABOVE a sub-50% cost ceiling', () => {
  // surplus 50 kWh ⇒ ceiling (92.16−50)/92.16 = 45.7%.
  const p = plan({ socNowPct: 56, longGapAhead: false, morningPvSurplusP50Kwh: 50 });
  assert.equal(p.chargeTonight, true, `premise: ${p.rationale}`);
  assert.equal(p.requiredExtraKwh, 0);
  assert.ok(p.setpointSocPct <= p.costCeilingSocPct + 0.05, `setpoint ${p.setpointSocPct} vs ceiling ${p.costCeilingSocPct}`);
  const s = armFromPlan(emptyActuationState(), '2026-09-17', p, EVE, 16);
  assert.ok(s!.targetPct! <= Math.round(p.costCeilingSocPct), `reserve ${s!.targetPct} vs ceiling ${p.costCeilingSocPct} (whole-number reserve)`);
  assert.doesNotMatch(p.rationale, /resilience requirement/);
});

test('★ cost mode is never LOWER than resilience, and never shortfalls where resilience held', () => {
  for (const socNowPct of [40, 55, 70, 85, 100]) for (const s50 of [null, 5, 16, 40]) for (const lg of [true, false]) {
    const r = plan({ objectiveMode: 'resilience', socNowPct, morningPvSurplusP50Kwh: s50, longGapAhead: lg });
    const c = plan({ socNowPct, morningPvSurplusP50Kwh: s50, longGapAhead: lg });
    assert.ok((c.targetSocPct ?? 0) >= (r.targetSocPct ?? 0) - 0.05, `${socNowPct}/${s50}/${lg}`);
    if (r.objective === 'none' && r.buyKwh === 0) assert.equal(c.cushionShortfall, false);
  }
});

import { buildNightChargeMessage } from '../src/notify.js';
test('★★ the charge notification names an economic-only buy — and only that', () => {
  const eco = buildNightChargeMessage(plan(), 'charge');
  assert.match(eco.body, /economic \(cost mode\)/);
  const needed = buildNightChargeMessage(plan({ socNowPct: 30 }), 'charge');
  assert.ok((plan({ socNowPct: 30 }).requiredExtraKwh ?? 0) > 0, 'premise: resilience needed a buy');
  assert.doesNotMatch(needed.body, /economic \(cost mode\)/);
  const res = buildNightChargeMessage(plan({ objectiveMode: 'resilience', socNowPct: 30 }), 'charge');
  assert.doesNotMatch(res.body, /economic/);
});
