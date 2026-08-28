import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibratedBuyDebiasFactor, computeNightChargePlan, buildNightChargeInputs } from '../src/nightChargeAdvisor.js';

/**
 * v1.112.0 — the buy de-bias (design §3.4's lane, first live producer).
 *
 * The 08-26/27 night announced ~21.6 kWh and delivered ~35.8 (1.66× under-
 * prediction). The de-bias corrects the ANNOUNCEMENT from realized nights;
 * the raw physics estimate stays on plan.buyKwh (the ledger + learner input)
 * so the learner can never feed on its own output, and chargeTonight
 * thresholds on the raw figure so learned data never flips a decision.
 */

const night = (buy: number, delivered: number, over: Record<string, unknown> = {}) => ({
  buy_kwh: buy, delivered_kwh: delivered, actuated: 1, scored: 1, cushion_shortfall: 0, ...over,
});

test('median of realized/planned over eligible nights, rounded to 3 places', () => {
  const rows = [1.2, 1.5, 1.66, 1.7, 1.4, 1.3, 1.6].map((r) => night(20, 20 * r));
  const out = calibratedBuyDebiasFactor(rows);
  assert.equal(out.basis, 'measured');
  assert.equal(out.samples, 7);
  assert.equal(out.factor, 1.5, 'median of the seven ratios');
});

test('below minSamples: factor 1.0 (uncalibrated), basis default', () => {
  const rows = [night(20, 33), night(20, 34)];
  const out = calibratedBuyDebiasFactor(rows);
  assert.deepEqual(out, { factor: 1.0, basis: 'default', samples: 2 });
});

test('FLOOR at 1.0: systematic OVER-prediction never shrinks the announcement', () => {
  const rows = Array.from({ length: 8 }, () => night(20, 14)); // ratio 0.7
  const out = calibratedBuyDebiasFactor(rows);
  assert.equal(out.factor, 1.0, 'raw physics estimate is the lower bound');
  assert.equal(out.basis, 'measured');
});

test('CAP: pathological nights cannot run the announcement away', () => {
  const rows = Array.from({ length: 8 }, () => night(5, 25)); // ratio 5
  assert.equal(calibratedBuyDebiasFactor(rows).factor, 1.75);
});

test('eligibility: unactuated, unscored, shortfall-disclosed, tiny-plan, and null-delivered nights are all excluded', () => {
  const noise = [
    night(20, 40, { actuated: 0 }),
    night(20, 40, { scored: 0 }),
    night(20, 40, { cushion_shortfall: 1 }),
    night(1, 30),                       // plan below minPlanKwh: ratio 30 would poison
    night(20, null as any),             // delivered missing
    night(null as any, 30),             // plan missing
  ];
  const good = Array.from({ length: 7 }, () => night(20, 30)); // ratio 1.5
  const out = calibratedBuyDebiasFactor([...noise, ...good]);
  assert.equal(out.samples, 7, 'only the eligible nights count');
  assert.equal(out.factor, 1.5);
});

// ── through the plan: announcement carries the factor, raw stays raw ─────────

function planWith(factor?: number) {
  const nowMs = Date.UTC(2026, 7, 27, 4, 30); // 21:30 MST
  const winStart = Date.UTC(2026, 7, 27, 6, 0);
  const winEnd = Date.UTC(2026, 7, 27, 12, 0);
  const deps: any = {
    nowMs, fullKwh: 92.16, socNowPct: 20, reserveFloorPct: 10, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2, gridInputCapKw: null,
    periodIdAt: (ms: number) => (ms >= winStart && ms < winEnd ? 'offpeak' : 'onpeak'),
    cheapPeriodId: 'offpeak', windowScanHours: 30,
    bandHours: Array.from({ length: 24 }, (_, h) => ({
      ts: nowMs + h * 3_600_000, pvP10W: 0, pvP50W: 0, pvP90W: 0,
      loadP10W: 3000, loadP50W: 3000, loadP90W: 3000, embeddedEvW: 0,
    })),
    dayRollups: [], realizedDailyErrHalfFrac: null, nextRechargeMs: null,
    ev: null, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 5,
    bandCoverageFrac: 1, morningPvSurplusP90Kwh: null, minBuyKwh: 1,
    ...(factor != null ? { buyDebiasFactor: factor } : {}),
  };
  return computeNightChargePlan(buildNightChargeInputs(deps));
}

test('plan: debiased = raw × factor; raw buyKwh untouched; rationale discloses the calibration', () => {
  const cal = planWith(1.66);
  const raw = planWith(undefined);
  assert.ok(cal.chargeTonight && cal.buyKwh != null, `expected a charging plan, got: ${cal.rationale}`);
  assert.equal(cal.buyKwh, raw.buyKwh, 'the RAW estimate must not move with the factor');
  assert.equal(cal.buyKwhDebiased, Math.round(cal.buyKwh! * 1.66 * 100) / 100);
  assert.match(cal.rationale, /realized-buy calibration/);
  assert.match(cal.rationale, new RegExp(`Buy ~${Math.round(cal.buyKwhDebiased! * 10) / 10}`), 'headline uses the debiased figure');
});

test('plan: factor 1 (or absent) is invisible — no calibration note, debiased === raw', () => {
  const p = planWith(undefined);
  assert.equal(p.buyDebiasFactor, 1);
  assert.equal(p.buyKwhDebiased, p.buyKwh);
  assert.doesNotMatch(p.rationale, /calibration/);
});
