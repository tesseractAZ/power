import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNightChargePlan,
  holdIsStarved,
  type NightChargeInputs,
  type NightChargeHour,
} from '../src/nightChargeAdvisor.js';

/**
 * v1.132.0 — five places where the system recorded a true thing in a way that
 * read as a different, false thing.
 *
 * The motivating row is 2026-09-04. A Friday overnight window is ONE hour on
 * this tariff, so the engine sized the full requirement — the whole pool — and
 * could deliver ~0 kWh through it. The ledger row printed:
 *
 *   "Hold — the projected shortfall (0.0 kWh) is below the 1 kWh minimum-buy
 *    threshold; no meaningful charge."
 *
 * Every word is defensible and the sentence is the opposite of what happened:
 * `buyKwh` is the DELIVERABLE, not the shortfall, and "no meaningful charge"
 * describes a quiet night rather than a window that physically cannot serve.
 */

const HOUR = 3_600_000;
const B = 1_788_400_000_000;

function mkHorizon(startMs: number, hours: number, pvW: number, loadW: number): NightChargeHour[] {
  return Array.from({ length: hours }, (_, i) => ({ ts: startMs + i * HOUR, pvP10W: pvW, loadP90W: loadW }));
}

function baseInputs(overrides: Partial<NightChargeInputs> = {}): NightChargeInputs {
  return {
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
    ...overrides,
  };
}

/* ══ 1. the hold that could not serve vs the hold with nothing to buy ═════ */

test('THE MEASURED DEFECT: a one-hour window that cannot serve says so', () => {
  // Friday's shape: a 1-hour window, a pool deep enough to need a real buy, and
  // a charge rate that cannot possibly close the gap inside it.
  const p = computeNightChargePlan(baseInputs({
    window: { startMs: B + 3 * HOUR, endMs: B + 4 * HOUR }, // ONE hour
    chargeCapKw: 0.5,                                        // 0.5 kWh into a 1 h window
    socNowPct: 30,
  }));
  assert.equal(p.chargeTonight, false, 'premise: this night holds');
  assert.match(p.rationale, /cannot serve the need/, 'names the real reason');
  assert.doesNotMatch(p.rationale, /projected shortfall/, 'no longer misnames the deliverable');
  assert.doesNotMatch(p.rationale, /no meaningful charge/, 'that phrase described the OTHER hold');
});

test('a genuinely tiny need still reads as a tiny need', () => {
  // A real but trivial shortfall: the trough dips just under floor+cushion, the
  // window and charge rate can cover it easily, and the buy lands under the
  // 1 kWh minimum. This hold must NOT claim the window is at fault.
  const p = computeNightChargePlan(baseInputs({ socNowPct: 48.5 }));
  assert.equal(p.chargeTonight, false, 'premise: this holds');
  assert.match(p.rationale, /genuinely small/, 'names the need, not the window');
  assert.doesNotMatch(p.rationale, /cannot serve the need/);
});

test('★ the three holds are never confusable', () => {
  // There are exactly three ways to hold, and they mean different things:
  //   (a) no shortfall at all      -> the early return, "no charge needed"
  //   (b) a tiny genuine shortfall -> "the projected need is genuinely small"
  //   (c) a starved window         -> "the window cannot serve the need"
  // (a) is the pre-existing early hold; (b) and (c) are what v1.132.0 split
  // apart. No plan may match more than one.
  const shapes: Array<[string, Partial<NightChargeInputs>, 'none' | 'tiny' | 'starved']> = [
    ['1h window, throttled', { window: { startMs: B + 3 * HOUR, endMs: B + 4 * HOUR }, chargeCapKw: 0.5 }, 'starved'],
    ['2h window, throttled', { window: { startMs: B + 3 * HOUR, endMs: B + 5 * HOUR }, chargeCapKw: 0.4 }, 'starved'],
    ['tiny shortfall', { socNowPct: 48.5 }, 'tiny'],
    ['tinier shortfall', { socNowPct: 48.8 }, 'tiny'],
    ['no shortfall', { socNowPct: 49.5 }, 'none'],
    ['full pack', { socNowPct: 100 }, 'none'],
  ];
  for (const [name, ov, expected] of shapes) {
    const p = computeNightChargePlan(baseInputs(ov));
    assert.equal(p.chargeTonight, false, `${name}: premise is a hold`);
    const starved = /cannot serve the need/.test(p.rationale);
    const tiny = /genuinely small/.test(p.rationale);
    const none = /no charge needed/.test(p.rationale);
    assert.equal([starved, tiny, none].filter(Boolean).length, 1, `${name}: exactly one cause in "${p.rationale.slice(0, 90)}"`);
    assert.equal(starved ? 'starved' : tiny ? 'tiny' : 'none', expected, name);
  }
});

test('the discriminator is the shortfall, NOT which cap is labelled', () => {
  // `poolHeadroom` binds both a starved window AND a nearly-full pack, which are
  // opposite situations — keying the wording off bindingCap got this wrong.
  const starvedPlan = computeNightChargePlan(baseInputs({
    window: { startMs: B + 3 * HOUR, endMs: B + 4 * HOUR }, chargeCapKw: 0.5,
  }));
  const tinyPlan = computeNightChargePlan(baseInputs({ socNowPct: 48.5 }));
  assert.match(starvedPlan.rationale, /cannot serve the need/);
  assert.match(tinyPlan.rationale, /genuinely small/);
  // Same verdict for both (a hold), opposite explanations, and the deliverable
  // is what separates them: starved has requirement > deliverable.
  assert.ok((starvedPlan.requiredExtraKwh ?? 0) > (starvedPlan.buyKwh ?? 0), 'starved: need exceeds deliverable');
  assert.ok((tinyPlan.requiredExtraKwh ?? 0) <= (tinyPlan.buyKwh ?? 0) + 1e-6, 'tiny: deliverable covers the need');
});

test('a capped hold reports the requirement it could not meet', () => {
  const p = computeNightChargePlan(baseInputs({
    window: { startMs: B + 3 * HOUR, endMs: B + 4 * HOUR },
    chargeCapKw: 0.5,
  }));
  assert.equal(p.chargeTonight, false);
  // Either a concrete kWh requirement or the honest "more than the pool can hold".
  assert.match(p.rationale, /against a requirement of (~[\d.]+ kWh|more than the pool can hold)/);
});

/* ══ 2. a windowless night is not an incomplete basis ════════════════════ */

test('THE MEASURED DEFECT: no cheap window is not a broken basis', () => {
  // Saturday has no overnight window on this tariff. Reporting basisComplete
  // false made HA say "basis incomplete" about a perfectly healthy basis, and
  // made a routine windowless Saturday indistinguishable from a data outage.
  const p = computeNightChargePlan(baseInputs({ window: null }));
  assert.equal(p.chargeTonight, false, 'still no buy — nothing changed about the decision');
  assert.equal(p.basisComplete, true, 'the forecast/telemetry basis was fine');
  assert.match(p.rationale, /no valid cheap charge window/);
});

test('a genuinely incomplete basis still reports incomplete', () => {
  // The distinction only helps if the real failure still reads as a failure.
  for (const ov of [
    { basisComplete: false },
    { socCoherent: false },
    { confidenceTier: 'climatology' as const },
    { fullKwh: 0 },
  ]) {
    const p = computeNightChargePlan(baseInputs(ov));
    assert.equal(p.chargeTonight, false);
    assert.equal(p.basisComplete, false, `${JSON.stringify(ov)} must still read as incomplete`);
  }
});

test('★ a windowless night is the ONLY null plan that keeps basisComplete', () => {
  const cases: Array<[string, Partial<NightChargeInputs>, boolean]> = [
    ['no window', { window: null }, true],
    ['zero-length window', { window: { startMs: B + 3 * HOUR, endMs: B + 3 * HOUR } }, true],
    ['basis incomplete', { basisComplete: false }, false],
    ['SoC incoherent', { socCoherent: false }, false],
    ['climatology only', { confidenceTier: 'climatology' as const }, false],
    ['no pool capacity', { fullKwh: 0 }, false],
    ['empty horizon', { horizon: [] }, false],
  ];
  for (const [name, ov, expected] of cases) {
    const p = computeNightChargePlan(baseInputs(ov));
    assert.equal(p.basisComplete, expected, name);
  }
});

/* ══ 3. the discriminator itself, over its whole input space ═════════════ */

test('★ holdIsStarved keys off the SHORTFALL, never off a cap label', () => {
  // The bug this replaced: keying the wording off `bindingCap`. `poolHeadroom`
  // is the label on BOTH a starved window and a nearly-full pack — opposite
  // situations. The predicate takes no cap at all, so it cannot regress that way.
  const legEff = 0.9;
  for (const meetable of [true, false]) {
    for (const requiredExtraKwh of [0, 0.5, 5, 40, 92.16]) {
      for (const deliverableKwh of [0, 0.5, 5, 40, 92.16]) {
        const got = holdIsStarved({ meetable, requiredExtraKwh, deliverableKwh, legEff });
        const want = !meetable || requiredExtraKwh / legEff > deliverableKwh + 1e-6;
        assert.equal(got, want, `meetable=${meetable} req=${requiredExtraKwh} deliv=${deliverableKwh}`);
      }
    }
  }
});

test('an unmeetable requirement is starved no matter what the numbers say', () => {
  // !meetable carries a PLACEHOLDER requirement (the full-pack proxy), which on
  // a nearly-full pack is ~0 and would otherwise compare as comfortably covered.
  assert.equal(holdIsStarved({ meetable: false, requiredExtraKwh: 0, deliverableKwh: 99, legEff: 0.9 }), true);
});

test('the comparison converts pack-side lift to the meter side', () => {
  // requiredExtraKwh is PACK-side; deliverableKwh is METER-side. At legEff 0.9 a
  // 9 kWh requirement needs 10 kWh at the meter — a raw comparison would call
  // 9.5 kWh of delivery sufficient when it is 0.5 kWh short.
  assert.equal(holdIsStarved({ meetable: true, requiredExtraKwh: 9, deliverableKwh: 9.5, legEff: 0.9 }), true);
  assert.equal(holdIsStarved({ meetable: true, requiredExtraKwh: 9, deliverableKwh: 10.1, legEff: 0.9 }), false);
});

test('an exactly-covered requirement is not starved (no off-by-epsilon)', () => {
  assert.equal(holdIsStarved({ meetable: true, requiredExtraKwh: 9, deliverableKwh: 10, legEff: 0.9 }), false);
});
