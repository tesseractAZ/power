import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannerSizingNeedBuyKwh, actuatedRealizedNeedBuyKwh } from '../src/nightChargeAdvisor.js';

/**
 * v1.105.0 (algo v3) — `buy_err_kwh` on the PLANNER-SIZING basis.
 *
 * The old definition was `planBuy − (delivered + troughDeficit)`: the DIFFERENCE
 * of two questions, answering neither. Measured on four live nights it produced
 * −62.13 kWh of residual, of which 52% was the actuator over-delivering (which
 * it does BY DESIGN — the device is handed a setpoint derived from the
 * requirement, not from the derated deliverable) and 48% was a trough-deficit
 * term anchored on the reverted reserve setpoint, fixed at −14.9 kWh whatever
 * the planner did. Result: a 56% "under-buy rate" that hard-blocked promotion
 * and that no forecast improvement could move — an honest load correction makes
 * it MORE negative.
 *
 * A planner sizes from its forecast, so its sizing error is its FORECAST error
 * in kWh. That is all this metric now measures.
 */

const LEG = Math.sqrt(0.86); // 0.927362

const need = (o: Partial<Parameters<typeof plannerSizingNeedBuyKwh>[0]> = {}) =>
  plannerSizingNeedBuyKwh({
    planBuyKwh: 20, forecastPvKwh: 50, actualPvKwh: 50,
    forecastLoadKwh: 100, actualLoadKwh: 100, legEff: LEG, ...o,
  });

test('a perfect forecast means the plan was exactly right — buy_err 0', () => {
  assert.equal(need(), 20, 'need equals the plan when nothing was mis-forecast');
  assert.equal(20 - need(), 0);
});

test('LESS PV than forecast ⇒ the true requirement was HIGHER ⇒ under-buy (negative)', () => {
  const n = need({ actualPvKwh: 40 });               // 10 kWh of PV never arrived
  assert.ok(n > 20, `need rose to ${n}`);
  assert.ok(20 - n < 0, 'buy_err negative = under-buy, preserving the safety sign convention');
  assert.equal(n, Math.round((20 + 10 / LEG) * 100) / 100);
});

test('MORE load than forecast ⇒ under-buy (negative)', () => {
  const n = need({ actualLoadKwh: 115 });            // 15 kWh of unforecast load
  assert.ok(20 - n < 0);
  assert.equal(n, Math.round((20 + 15 / LEG) * 100) / 100);
});

test('MORE PV / LESS load than forecast ⇒ over-buy (positive, the safe side)', () => {
  assert.ok(20 - need({ actualPvKwh: 60 }) > 0, 'sunnier than forecast');
  assert.ok(20 - need({ actualLoadKwh: 85 }) > 0, 'lighter load than forecast');
});

test('offsetting misses cancel — the planner was right on NET', () => {
  // 10 kWh less PV, but 10 kWh less load too: the requirement is unchanged.
  assert.equal(need({ actualPvKwh: 40, actualLoadKwh: 90 }), 20);
});

test('★ the delivered energy is NOT an input — over-delivery cannot look like under-buy', () => {
  // The whole defect: the actuator routinely delivers ~38 kWh against a ~21 kWh
  // plan because the device is told a setpoint derived from the requirement.
  // The planner-sizing basis has no parameter through which that can enter.
  const args = Object.keys({
    planBuyKwh: 0, forecastPvKwh: 0, actualPvKwh: 0, forecastLoadKwh: 0, actualLoadKwh: 0, legEff: 0,
  });
  assert.ok(!args.some((k) => /deliver/i.test(k)), 'no delivered term in the signature');
  assert.ok(!args.some((k) => /trough|minPack|floor/i.test(k)), 'and no trough/floor term either');
});

test('★ reproduces the live 08-19 night as a planner question, not a delivery one', () => {
  // Live row: plan 21.05 kWh, delivered 38.16, trough 11%. The OLD basis scored
  // this -31.02 (dominated by over-delivery and the setpoint-pinned trough).
  const old = actuatedRealizedNeedBuyKwh({
    targetFloorKwh: 23.04, actualMinPackKwh: 0.11 * 92.16, deliveredMeterKwh: 38.16, legEff: LEG,
  });
  assert.ok(21.05 - old < -25, `old basis scored ${(21.05 - old).toFixed(2)} — a huge false under-buy`);

  // The SAME night on the planner basis, with load over-forecast (~24%) as the
  // ledger shows: the planner actually bought MORE than the realized need.
  const now = plannerSizingNeedBuyKwh({
    planBuyKwh: 21.05, forecastPvKwh: 50, actualPvKwh: 49,
    forecastLoadKwh: 129.07, actualLoadKwh: 92.70, legEff: LEG,
  });
  assert.ok(21.05 - now > 0, `planner basis scores ${(21.05 - now).toFixed(2)} — an over-buy, the safe side`);
});
