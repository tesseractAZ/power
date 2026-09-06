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
