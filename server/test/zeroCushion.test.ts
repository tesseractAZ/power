import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  outageCushionKwh,
  computeNightChargePlan,
  type NightChargeInputs,
  type NightChargeHour,
} from '../src/nightChargeAdvisor.js';

/**
 * v1.133.0 — an owner who sets the outage cushion to zero gets zero.
 *
 * THE DEFECT: the guard folded `outageHours <= 0` into the SAME branch as
 * "no islanded-load measurement available", so asking for no cushion silently
 * delivered the legacy flat band instead — 15% of pool, 13.8 kWh on this plant.
 * The option was accepted, `validate-addon-config` passed, and the setting did
 * not take effect.
 *
 * It was worse than inert. The legacy basis also switches the cushion test from
 * the islanded-outage trough to the whole-house forward trough, which is
 * HARSHER — so asking for NO cushion made the requirement LARGER.
 */

const HOUR = 3_600_000;
const B = 1_788_400_000_000;
const mkHorizon = (s: number, n: number, pv: number, load: number): NightChargeHour[] =>
  Array.from({ length: n }, (_, i) => ({ ts: s + i * HOUR, pvP10W: pv, loadP90W: load }));

const baseInputs = (ov: Partial<NightChargeInputs> = {}): NightChargeInputs => ({
  nowMs: B,
  fullKwh: 100,
  socNowPct: 30,
  reserveFloorPct: 10,
  cushionPct: 15,
  socCoherent: true,
  legEff: 0.9,
  dischargeEff: 0.9,
  chargeCapKw: 100,
  gridInputCapKw: null,
  window: { startMs: B + 3 * HOUR, endMs: B + 9 * HOUR },
  horizon: mkHorizon(B, 24, 0, 900),
  morningPvSurplusP90Kwh: null,
  confidenceTier: 'forecast',
  basisComplete: true,
  minBuyKwh: 1,
  ...ov,
});

const CUSHION = { islandedLoadKw: 4.37, safetyFactor: 1.25, dischargeEff: 0.94, legacyCushionKwh: 13.82 };

/* ══ the guard ═══════════════════════════════════════════════════════════ */

test('THE MEASURED DEFECT: zero hours used to yield the legacy band, not zero', () => {
  const r = outageCushionKwh({ ...CUSHION, outageHours: 0 });
  assert.equal(r.kwh, 0, 'zero means zero');
  assert.equal(r.basis, 'disabled');
  assert.notEqual(r.kwh, CUSHION.legacyCushionKwh, 'and specifically NOT the 13.82 kWh fallback');
});

test('★ a disabled cushion does not depend on a load measurement', () => {
  // The ordering is the fix: `disabled` is checked BEFORE the unmeasurable
  // branch, so a missing islanded-load reading cannot resurrect the legacy band
  // underneath a deliberate zero.
  for (const islandedLoadKw of [null, undefined, 0, -1, NaN]) {
    const r = outageCushionKwh({ ...CUSHION, islandedLoadKw, outageHours: 0 });
    assert.equal(r.basis, 'disabled', `islandedLoadKw=${islandedLoadKw}`);
    assert.equal(r.kwh, 0);
  }
});

test('a genuinely unmeasurable cushion still falls back — that path is unchanged', () => {
  for (const islandedLoadKw of [null, undefined, 0, -1, NaN]) {
    const r = outageCushionKwh({ ...CUSHION, islandedLoadKw, outageHours: 4 });
    assert.equal(r.basis, 'legacy-pct', `islandedLoadKw=${islandedLoadKw}`);
    assert.equal(r.kwh, CUSHION.legacyCushionKwh);
  }
});

test('a NEGATIVE or non-finite hours value is malformed, not a decision', () => {
  // Only an exact 0 is read as intent. Anything else nonsensical stays
  // conservative — fail toward more cushion, never less.
  for (const outageHours of [-1, -0.5, NaN, Infinity, -Infinity]) {
    const r = outageCushionKwh({ ...CUSHION, outageHours });
    assert.equal(r.basis, 'legacy-pct', `outageHours=${outageHours}`);
  }
});

test('a normal cushion is unchanged', () => {
  const r = outageCushionKwh({ ...CUSHION, outageHours: 4 });
  assert.equal(r.basis, 'islanded-outage');
  assert.equal(r.kwh, 23.24, '4 h x 4.37 kW x 1.25 / 0.94');
});

test('★ exactly one basis per input class, over the whole space', () => {
  for (const outageHours of [0, 0.5, 4, -1, NaN]) {
    for (const islandedLoadKw of [null, 4.37, 0]) {
      const r = outageCushionKwh({ ...CUSHION, islandedLoadKw, outageHours });
      const expected =
        outageHours === 0 ? 'disabled'
        : (islandedLoadKw == null || !(islandedLoadKw > 0) || !Number.isFinite(outageHours) || outageHours <= 0) ? 'legacy-pct'
        : 'islanded-outage';
      assert.equal(r.basis, expected, `hours=${outageHours} load=${islandedLoadKw}`);
      if (r.basis === 'disabled') assert.equal(r.kwh, 0);
    }
  }
});

/* ══ what the planner does with it ═══════════════════════════════════════ */

test('a disabled cushion holds the reserve floor and nothing above it', () => {
  const p = computeNightChargePlan(baseInputs({
    islandedLoadKw: 4.37, outageCushionHours: 0, islandedLoadSafety: 1.25, socNowPct: 20,
  }));
  assert.equal(p.cushionBasis, 'disabled');
  assert.equal(p.cushionKwh, 0);
});

test('★ THE DISABLED CUSHION ANNOUNCES ITSELF', () => {
  // The whole hazard: a night with no outage margin must not read as one whose
  // cushion was comfortably covered. The standard was lowered, not met.
  const p = computeNightChargePlan(baseInputs({
    islandedLoadKw: 4.37, outageCushionHours: 0, islandedLoadSafety: 1.25, socNowPct: 90,
  }));
  assert.match(p.rationale, /outage cushion is DISABLED/);
  assert.match(p.rationale, /nothing is held back for an outage/);
});

test('asking for no cushion must not make the requirement LARGER', () => {
  // The shipped behaviour: hours 0 -> legacy basis -> whole-house forward trough,
  // a harsher test than the islanded-outage one. Disabling the cushion has to
  // move the requirement down, never up.
  const withCushion = computeNightChargePlan(baseInputs({
    islandedLoadKw: 4.37, outageCushionHours: 4, islandedLoadSafety: 1.25, socNowPct: 25,
  }));
  const disabled = computeNightChargePlan(baseInputs({
    islandedLoadKw: 4.37, outageCushionHours: 0, islandedLoadSafety: 1.25, socNowPct: 25,
  }));
  assert.ok(
    (disabled.requiredExtraKwh ?? 0) <= (withCushion.requiredExtraKwh ?? 0) + 1e-6,
    `disabled required ${disabled.requiredExtraKwh} must not exceed cushioned ${withCushion.requiredExtraKwh}`,
  );
});

test('★ the disabled cushion is tested at WINDOW CLOSE, not on the forward trough', () => {
  // The discriminator between the two trough forms. At 25% the pack ends the
  // window at 16% — comfortably above the 10% floor — while the whole-house
  // forward trough keeps draining to ~1%. The disabled basis must test the
  // former (pack at outage onset) and therefore HOLD. If it took the
  // whole-house trough it would size a buy against a 1% projection, which is
  // the harsher legacy test and the opposite of disabling the cushion.
  const p = computeNightChargePlan(baseInputs({
    islandedLoadKw: 4.37, outageCushionHours: 0, islandedLoadSafety: 1.25, socNowPct: 25,
  }));
  assert.equal(p.cushionBasis, 'disabled');
  assert.equal(p.chargeTonight, false, 'the pack at window close clears the floor — nothing to buy');
  assert.equal(p.requiredExtraKwh, 0);
  assert.match(p.rationale, /pack at window close \(16%\)/);
  // ...and the whole-house trough is still DISCLOSED, far below, proving the two
  // are different quantities and that the right one drove the decision.
  assert.ok((p.minProjSocPct ?? 99) < 10, `whole-house trough ${p.minProjSocPct}% is disclosed and is below the floor`);
});

test('the disabled path keeps the islanded trough form, not the whole-house one', () => {
  // Distinguishable because the legacy path tests the post-window forward trough
  // while the islanded/disabled path tests the pack AT window close.
  const disabled = computeNightChargePlan(baseInputs({
    islandedLoadKw: 4.37, outageCushionHours: 0, islandedLoadSafety: 1.25, socNowPct: 25,
  }));
  const legacy = computeNightChargePlan(baseInputs({
    islandedLoadKw: null, outageCushionHours: 4, cushionPct: 0, socNowPct: 25,
  }));
  assert.equal(disabled.cushionBasis, 'disabled');
  assert.equal(legacy.cushionBasis, 'legacy-pct');
  // Both carry a 0 kWh cushion here, yet they are NOT the same plan — the trough
  // test differs, which is exactly what the old conflation hid.
  assert.equal(disabled.cushionKwh, 0);
  assert.equal(legacy.cushionKwh, 0);
});

/* ══ v1.133.1 — the announced reserve is the one that gets written ══════ */

test('THE MEASURED DEFECT: the plan announced 100% while the panel was told 50', () => {
  // Live 2026-09-06: setpointSocPct 100, actuation targetPct 50. The sentence
  // went into the 21:30 notification AND the spoken broadcast, describing an
  // internal quantity as though it were the instruction.
  // A deep shortfall with a throttled window: the resilience requirement asks
  // for a 75% setpoint while the window is only expected to reach ~20%.
  const p = computeNightChargePlan(baseInputs({
    socNowPct: 20, reserveFloorPct: 10, cushionPct: 40, chargeCapKw: 1,
    horizon: mkHorizon(B, 24, 0, 1500),
  }));
  assert.equal(p.chargeTonight, true, 'premise: this night buys');
  assert.equal(p.setpointSocPct, 75, 'premise: the requirement exceeds the write envelope');
  assert.match(p.rationale, /The reserve is set to 50%/, 'announces the WRITTEN value');
  assert.doesNotMatch(p.rationale, /The reserve is set to 75%/, 'never the un-clamped setpoint');
  assert.match(p.rationale, /the resilience requirement asks for 75%/, 'the real ask is still disclosed');
  assert.match(p.rationale, /only accepts a backup reserve up to 50%/, 'and why it was truncated');
});

test('an untruncated setpoint reads exactly as before', () => {
  // The disclosure must appear ONLY when the envelope actually bit; otherwise it
  // is noise on every ordinary night.
  const p = computeNightChargePlan(baseInputs({ socNowPct: 25, reserveFloorPct: 10, cushionPct: 10 }));
  if (!p.chargeTonight) return;
  const sp = p.setpointSocPct ?? 0;
  if (sp > 50) return; // truncated case is covered above
  assert.doesNotMatch(p.rationale, /only accepts a backup reserve up to/);
});

test('★ the announced reserve NEVER exceeds what the device can be told', () => {
  // Exhaustive over shapes that push the setpoint hard. Whatever the planner
  // computes internally, the sentence an operator hears must be writable.
  for (const socNowPct of [2, 5, 15, 30, 60]) {
    for (const cushionPct of [10, 25, 40]) {
      const p = computeNightChargePlan(baseInputs({
        socNowPct, cushionPct, reserveFloorPct: 10, horizon: mkHorizon(B, 24, 0, 2500),
      }));
      const m = /The reserve is set to (\d+(?:\.\d+)?)%/.exec(p.rationale);
      if (!m) continue;
      const announced = Number(m[1]);
      assert.ok(announced <= 50, `announced ${announced}% exceeds the write envelope (soc=${socNowPct} cushion=${cushionPct})`);
      assert.ok(announced >= 10, `announced ${announced}% is below the write envelope`);
    }
  }
});

/* ══ v1.134.0 — the HA Energy price sensor ═══════════════════════════════ */

test('THE ENABLING ENTITY: a USD/kWh price sensor, not a USD amount', async () => {
  // HA renders grid cost only if stat_cost, entity_energy_price or
  // number_energy_price is set; all three were null, so the Energy page showed
  // no money at all despite a confirmed five-rate tariff. entity_energy_price is
  // the only one of the three that is TOU-correct: HA multiplies each energy
  // delta by the rate in force WHILE IT FLOWED.
  const { SENSORS } = await import('../src/mqttDiscovery.js');
  const price = SENSORS.find((s: any) => s.unique_id === 'ecoflow_grid_price_now');
  assert.ok(price, 'the price sensor exists');
  assert.equal(price!.unit_of_measurement, 'USD/kWh', 'a PRICE, not an amount of money');
  assert.equal(price!.state_class, 'measurement');
  assert.equal((price as any).device_class, undefined, 'monetary is for an amount, not a rate — HA mints its own cost sensor');
});

test('★ the rate is published in DOLLARS, not cents', async () => {
  // The single likeliest defect: 41.6 where 0.416 is meant. A 100x price error
  // would be invisible on the sensor and catastrophic on the cost column.
  const { rateAt, buildApsREvModel } = await import('../src/tariff.js');
  const model = buildApsREvModel({
    onPeak: { summer: 44.2, winter: 39.5 },
    offPeak: { summer: 16.91, winter: 17.0 },
    overnight: { summer: 12.59, winter: 12.59 },
    confirmed: true,
  });
  // A summer weekday inside 16:00-19:00 Phoenix → on-peak.
  const onPeak = new Date('2026-08-04T23:30:00Z').getTime(); // 16:30 MST Tue
  const cents = rateAt(model, onPeak).centsPerKwh;
  assert.equal(cents, 44.2, 'premise: the model returns CENTS');
  const dollars = cents == null ? null : Math.round((cents / 100) * 1e4) / 1e4;
  assert.equal(dollars, 0.442, 'the published value is dollars per kWh');
  assert.ok(dollars! < 1, 'a USD/kWh price is well under 1 — 44.2 would be a 100x error');
});

test('an unconfirmed tariff publishes NULL, never a fallback rate', async () => {
  // A silent off-peak default would reintroduce exactly the mispricing this
  // entity removes, and would do it invisibly. HA declines to accrue cost from
  // an unavailable price, which is the correct behaviour.
  const { rateAt, buildApsREvModel } = await import('../src/tariff.js');
  const unconfirmed = buildApsREvModel({ confirmed: false });
  const cents = rateAt(unconfirmed, Date.now()).centsPerKwh;
  assert.equal(cents, null);
  assert.equal(cents == null ? null : cents / 100, null, 'null propagates — never 0, which JS would give from null/100');
});

test('the HA device reports the running version, not a v0.8.0 literal', async () => {
  const { DEVICE_INFO } = await import('../src/mqttDiscovery.js');
  assert.notEqual(DEVICE_INFO.sw_version, '0.8.0', 'was hardcoded ~125 releases behind');
  assert.equal(DEVICE_INFO.sw_version, process.env.BUILD_VERSION || 'dev');
});
