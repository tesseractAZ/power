import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNightChargePlan, type NightChargeInputs, type NightChargeHour } from '../src/nightChargeAdvisor.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargeAdvisor — the v1.37.0 ACCURACY contract for the pure sizing brain.
 *
 * Design: docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md §2. The recommendation is
 * safety-critical: UNDER-BUY is a safety miss (leaves the home at the floor with
 * no outage cushion), so these tests pin (a) the gates fail-safe to a null plan,
 * (b) the buy is sized so the WITH-BUY trough holds floor+cushion exactly, never
 * short, (c) worst-case monotonicity (more load ⇒ bigger buy), (d) every cap
 * (charge-power, pool-headroom, over-buy) binds with the right flag, and
 * (e) no efficiency constant is hard-coded (a real-constants case).
 *
 * Most cases use dischargeEff=legEff=0.9 for exact hand-arithmetic: with PV=0
 * and loadP90W=900 W the DC-bus drain is 900/0.9 = 1000 Wh = 1 kWh/hour.
 * ═════════════════════════════════════════════════════════════════════════ */

const HOUR = 3_600_000;
const B = 1_800_000 * HOUR; // arbitrary hour-aligned base epoch

/** Build an ascending hourly horizon of `n` hours from `startMs`, each with the
 *  given (constant, or per-hour) PV and load in watts. */
function mkHorizon(startMs: number, n: number, pvW: number | number[], loadW: number | number[]): NightChargeHour[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: startMs + i * HOUR,
    pvP10W: Array.isArray(pvW) ? pvW[i] : pvW,
    loadP90W: Array.isArray(loadW) ? loadW[i] : loadW,
  }));
}

function baseInputs(overrides: Partial<NightChargeInputs> = {}): NightChargeInputs {
  return {
    nowMs: B,
    fullKwh: 100,
    socNowPct: 30,
    reserveFloorPct: 10,
    cushionPct: 15, // floor+cushion = 25 kWh on a 100 kWh pool
    socCoherent: true,
    legEff: 0.9,
    dischargeEff: 0.9,
    chargeCapKw: 100, // effectively unbounded unless a test shrinks it
    window: { startMs: B + 3 * HOUR, endMs: B + 9 * HOUR }, // 6-hour window
    horizon: mkHorizon(B, 24, 0, 900), // PV 0, load 900 W ⇒ 1 kWh/h drain
    morningPvSurplusP90Kwh: null,
    confidenceTier: 'forecast',
    basisComplete: true,
    minBuyKwh: 1,
    ...overrides,
  };
}

// ── (a) Fail-safe gates → null plan, chargeTonight strictly false ──
for (const [name, ov] of [
  ['basis incomplete', { basisComplete: false }],
  ['SoC incoherent', { socCoherent: false }],
  ['climatology-only', { confidenceTier: 'climatology' as const }],
  ['no window', { window: null }],
  ['inverted window', { window: { startMs: B + 9 * HOUR, endMs: B + 3 * HOUR } }],
  ['empty horizon', { horizon: [] }],
  ['zero capacity', { fullKwh: 0 }],
] as const) {
  test(`gate — ${name} → null plan (no charge, no fabricated number)`, () => {
    const p = computeNightChargePlan(baseInputs(ov));
    assert.equal(p.chargeTonight, false, 'chargeTonight must be false');
    assert.equal(p.buyKwh, null, 'buyKwh must be null, never a best-effort number');
    assert.equal(p.targetSocPct, null);
    assert.equal(p.objective, 'none');
  });
}

// ── (b) Clean shortfall night: buy sizes the WITH-BUY trough to floor+cushion ──
test('clean shortfall — buy sized so plan trough holds floor+cushion exactly', () => {
  // socNow 30 kWh, 1 kWh/h drain, window ends B+9h.
  // packAtWindowEnd(no buy) = 30 − 9 = 21; trough over [B+9h, B+23h] = 21 − 15 = 6 kWh.
  // targetFloor = 25 kWh ⇒ requiredExtra = 19 kWh; target pack = 40 kWh (40%).
  // buyKwh = 19 / 0.9 = 21.11 kWh; with-buy trough = 40 − 15 = 25 kWh = floor+cushion.
  const p = computeNightChargePlan(baseInputs());
  assert.equal(p.chargeTonight, true);
  assert.equal(p.objective, 'resilience_cushion');
  assert.equal(p.requiredExtraKwh, 19);
  assert.equal(p.baselineMinSocPct, 6);
  assert.equal(p.targetSocPct, 40);
  assert.equal(p.bindingCap, 'requirement');
  assert.equal(p.cushionShortfall, false);
  assert.ok(Math.abs(p.buyKwh! - 19 / 0.9) < 0.02, `buyKwh ≈ 21.11, got ${p.buyKwh}`);
  // THE safety property: the plan's own trough is AT the floor+cushion line, never below.
  assert.ok(Math.abs(p.minProjSocPct! - 25) < 0.05, `plan trough ≈ 25%, got ${p.minProjSocPct}`);
  assert.ok(p.minProjSocPct! >= 25 - 1e-6, 'plan trough must NOT fall below floor+cushion');
});

// ── Hold when the projected trough already clears floor+cushion ──
test('hold — projected trough already ≥ floor+cushion ⇒ no buy', () => {
  // Light load: 450 W ⇒ 0.5 kWh/h drain. Start 80 kWh. Trough = 80 − 9·0.5(to windowEnd? )
  // packAtWindowEnd = 80 − 9·0.5 = 75.5; trough = 75.5 − 15·0.5 = 68 kWh = 68% ≫ 25%.
  const p = computeNightChargePlan(baseInputs({ socNowPct: 80, horizon: mkHorizon(B, 24, 0, 450) }));
  assert.equal(p.chargeTonight, false);
  assert.equal(p.objective, 'none');
  assert.equal(p.buyKwh, 0, 'explicit 0 buy, not null — basis IS complete');
  assert.equal(p.requiredExtraKwh, 0);
  assert.ok(p.baselineMinSocPct! > 25);
});

// ── (c) Worst-case monotonicity: more load ⇒ strictly bigger buy ──
test('monotonicity — a heavier (EV) load night sizes a strictly bigger buy', () => {
  const nonEv = computeNightChargePlan(baseInputs({ horizon: mkHorizon(B, 24, 0, 900) }));
  const evNight = computeNightChargePlan(baseInputs({ horizon: mkHorizon(B, 24, 0, 1800) }));
  assert.ok(evNight.buyKwh! > nonEv.buyKwh!, `EV night buy ${evNight.buyKwh} must exceed non-EV ${nonEv.buyKwh}`);
});

// ── (d1) Charge-power cap: tiny charger ⇒ bindingCap chargePower + cushionShortfall ──
test('cap — charge-power limit bounds the buy below need and flags the shortfall', () => {
  // chargeCapKw 1 over a 6 h window = 6 kWh gross; window house load 6·0.9 = 5.4 kWh;
  // lift ≤ (6 − 5.4)·0.9 = 0.54 kWh ≪ required 19 ⇒ capped, cushion NOT met.
  const p = computeNightChargePlan(baseInputs({ chargeCapKw: 1, minBuyKwh: 0.1 }));
  assert.equal(p.bindingCap, 'chargePower');
  assert.equal(p.cushionShortfall, true, 'caps prevented meeting floor+cushion — must be surfaced');
  assert.ok(p.minProjSocPct! < 25, 'with only the capped buy, trough stays below floor+cushion');
  assert.ok(/residual risk/i.test(p.rationale), 'rationale must disclose the residual risk');
});

// ── (d2) Pool-headroom cap: pack already near full ⇒ can't add the needed lift ──
test('cap — pool-headroom limit bounds the buy when the pack is near full', () => {
  // window [B, B+1h] (1 h); hour B flux 0 so packAtWindowEnd = socNow = 98 (headroom 2).
  // Post-window heavy drain (18000 W ⇒ 20 kWh/h) drives the trough to 0 ⇒ requiredExtra 25,
  // but lift is capped at headroom 2.
  const horizon = [
    { ts: B, pvP10W: 0, loadP90W: 0 },
    ...mkHorizon(B + HOUR, 6, 0, 18000),
  ];
  const p = computeNightChargePlan(baseInputs({
    socNowPct: 98, window: { startMs: B, endMs: B + HOUR }, horizon, minBuyKwh: 0.1,
  }));
  assert.equal(p.bindingCap, 'poolHeadroom');
  assert.equal(p.cushionShortfall, true);
  assert.ok(p.targetSocPct! <= 100 + 1e-6, 'target never exceeds full');
});

// ── (d3) Over-buy ceiling: buy exceeds morning-PV headroom ⇒ flagged, but KEPT ──
test('cap — over-buy ceiling flags an accepted clip; resilience still wins', () => {
  // Same clean shortfall (target 40 kWh) but morning P90 surplus 70 kWh ⇒ ceiling = 30 kWh.
  // Target 40 > 30 ⇒ over-buy flag, yet the buy is unchanged (resilience floor wins).
  const clean = computeNightChargePlan(baseInputs());
  const clipped = computeNightChargePlan(baseInputs({ morningPvSurplusP90Kwh: 70 }));
  assert.equal(clipped.bindingCap, 'overBuy');
  assert.equal(clipped.cushionShortfall, false, 'over-buy is NOT a shortfall — the buy is met');
  assert.equal(clipped.buyKwh, clean.buyKwh, 'resilience wins: the buy is not reduced by the ceiling');
  assert.ok(/clip/i.test(clipped.rationale));
});

// ── (e) No hard-coded efficiency: the REAL constants change the numbers coherently ──
test('efficiency is injected, not hard-coded — real 0.86 RTE constants size coherently', () => {
  const legEff = Math.sqrt(0.86); // ≈ 0.9274
  const dischargeEff = 0.94;
  const p = computeNightChargePlan(baseInputs({ legEff, dischargeEff }));
  assert.ok(p.chargeTonight);
  // buyKwh = requiredExtra / legEff; requiredExtra depends on the 0.94 drain trough.
  assert.ok(Math.abs(p.buyKwh! - p.requiredExtraKwh! / legEff) < 0.02,
    `buyKwh must equal requiredExtra/legEff (meter > pack); got ${p.buyKwh} vs ${p.requiredExtraKwh! / legEff}`);
  // With-buy trough still holds the 25% line (within rounding).
  assert.ok(p.minProjSocPct! >= 25 - 0.2, `plan trough ${p.minProjSocPct}% must hold ~25%`);
});

// ── REGRESSION (v1.37.0 review, CONFIRMED critical #2): deep shortfall must NOT
//    truncate the buy at floor+cushion — the DC-bus 0-clamp on the baseline once
//    hid the true (below-empty) deficit and under-bought on the exact night the
//    feature exists for. Sizing now solves against the with-buy re-sim trough. ──
test('regression — deep shortfall (baseline drains below empty) sizes the FULL need, not a truncated buy', () => {
  // socNow 10 kWh, 2 kWh/h drain: the no-buy trough clamps to 0 well before the
  // real trough. True need to hold the 25 kWh floor+cushion against the 30 kWh
  // post-window drain is a 55 kWh pack lift (meter ~61) — NOT the 25 kWh the old
  // targetFloor-minus-clamped-baseline would have produced.
  const p = computeNightChargePlan(baseInputs({ socNowPct: 10, horizon: mkHorizon(B, 24, 0, 1800) }));
  assert.equal(p.chargeTonight, true);
  assert.equal(p.cushionShortfall, false, 'the buy is feasible here — cushion IS met, not a shortfall');
  assert.ok(Math.abs(p.requiredExtraKwh! - 55) < 0.1, `required pack lift ≈ 55 kWh (full need), got ${p.requiredExtraKwh}`);
  assert.ok(Math.abs(p.buyKwh! - 55 / 0.9) < 0.1, `meter buy ≈ 61.1 kWh, got ${p.buyKwh}`);
  // The plan's own trajectory holds the line — never truncated below it.
  assert.ok(p.minProjSocPct! >= 25 - 0.05, `plan trough must hold 25%, got ${p.minProjSocPct}`);
});

// ── REGRESSION (v1.37.0 review, CONFIRMED critical #1): a mid-window PV surge
//    that clamps the pack to FULL erases the lift; the re-sim trough then sits
//    below floor+cushion, and cushionShortfall MUST fire (it once stayed false,
//    presenting a below-cushion plan as "requirement met"). ──
test('regression — full-clamp erasing the lift MUST flag cushionShortfall (not "met")', () => {
  // packAtWindowEnd(no buy) = 50 (start 50, PV=load=0 pre/at window). Post-window:
  // hour A a +60 kWh PV surge (clamps to full 100 for any buy), hour B a −80 kWh
  // deficit → trough 20 kWh (20%) regardless of the buy: unreachable by charging.
  const horizon = [
    { ts: B, pvP10W: 0, loadP90W: 0 },                                 // now→windowEnd flat
    ...Array.from({ length: 3 }, (_, i) => ({ ts: B + (i + 1) * HOUR, pvP10W: 0, loadP90W: 0 })),
    { ts: B + 4 * HOUR, pvP10W: 60000, loadP90W: 0 },                  // window-end +60 kWh surge
    { ts: B + 5 * HOUR, pvP10W: 0, loadP90W: 72000 },                  // −80 kWh deficit (÷0.9)
    ...mkHorizon(B + 6 * HOUR, 6, 0, 0),
  ];
  const p = computeNightChargePlan(baseInputs({
    socNowPct: 50, window: { startMs: B + 3 * HOUR, endMs: B + 4 * HOUR }, horizon, minBuyKwh: 0.1,
  }));
  assert.equal(p.cushionShortfall, true, 'the buy cannot lift the post-surge trough — MUST be flagged');
  assert.notEqual(p.bindingCap, 'requirement', 'bindingCap must never claim the requirement was met');
  assert.ok(p.minProjSocPct! < 25, `plan trough stays below floor+cushion, got ${p.minProjSocPct}`);
  assert.ok(/residual risk/i.test(p.rationale), 'rationale must disclose the residual risk');
});

// ── Meter-vs-pack invariant: the buy at the meter always exceeds the pack lift ──
test('invariant — buyKwh (meter) ≥ requiredExtraKwh (pack) on any charging night', () => {
  for (const load of [700, 900, 1200, 1500, 2000]) {
    const p = computeNightChargePlan(baseInputs({ horizon: mkHorizon(B, 24, 0, load) }));
    if (p.chargeTonight) {
      assert.ok(p.buyKwh! >= p.requiredExtraKwh! - 1e-9,
        `meter buy ${p.buyKwh} must be ≥ pack lift ${p.requiredExtraKwh} (charge loss)`);
    }
  }
});
