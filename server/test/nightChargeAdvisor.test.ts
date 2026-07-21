import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNightChargePlan,
  buildNightChargeInputs,
  resolveCheapWindow,
  scoreNightOutcome,
  nightChargeStateFields,
  getLatestNightChargePlan,
  setLatestNightChargePlan,
  createNightChargeAdvisor,
  nightWindowBounds,
  fmtPhoenixDayHm,
  type NightChargeInputs,
  type NightChargeHour,
  type NightChargePlan,
  type NightChargeInputDeps,
  type NightOutcomeActuals,
} from '../src/nightChargeAdvisor.js';

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

/* ═══════════════════════════════════════════════════════════════════════════
 * WS1 — advisor plumbing tests (holder, state fields, input assembly, window
 * resolution, EV de-dup, scoring). Design §2/§3/§4.1.
 * ═════════════════════════════════════════════════════════════════════════ */

// A tariff period resolver stub: OVERNIGHT (id 'overnight') from local 23:00 to
// 05:00, everything else 'off_peak'. Hours computed in America/Phoenix so the
// test exercises the same Intl path the real resolver uses.
function phoenixHour(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
}
function overnightPeriodIdAt(ms: number): string {
  const h = phoenixHour(ms);
  return h >= 23 || h < 5 ? 'overnight' : 'off_peak';
}

// A real, hour-aligned Phoenix evening (21:00 MST on 2026-07-17) so the resolved
// overnight window lands deterministically at +2 h (23:00) inside the band —
// the arbitrary `B` epoch resolves to an unpredictable local hour.
const EVE = Date.parse('2026-07-18T04:00:00Z');

function baseDeps(overrides: Partial<NightChargeInputDeps> = {}): NightChargeInputDeps {
  return {
    nowMs: EVE,
    fullKwh: 100,
    socNowPct: 30,
    reserveFloorPct: 10,
    cushionPct: 15,
    socCoherent: true,
    legEff: 0.9,
    dischargeEff: 0.9,
    chargeCapKw: 100,
    periodIdAt: overnightPeriodIdAt,
    cheapPeriodId: 'overnight',
    windowScanHours: 30,
    bandHours: mkHorizon(EVE, 24, 0, 900).map((h) => ({ ts: h.ts, pvP10W: h.pvP10W, loadP90W: h.loadP90W })),
    dayRollups: [],
    realizedDailyErrHalfFrac: 0.1,
    nextRechargeMs: null,
    ev: null,
    evMaxLoadW: 11520,
    confidenceTier: 'forecast',
    forecastPresent: true,
    calScoredDays: 30,
    minCalScoredDays: 14,
    bandCoverageFrac: 0.95,
    morningPvSurplusP90Kwh: null,
    minBuyKwh: 1,
    ...overrides,
  };
}

// ── holder round-trips ──
test('holder — set/get latest plan round-trips', () => {
  const plan = computeNightChargePlan(baseInputs());
  setLatestNightChargePlan(plan);
  assert.strictEqual(getLatestNightChargePlan(), plan);
});

// ── resolveCheapWindow: finds the next contiguous OVERNIGHT run ──
test('window — resolveCheapWindow returns the next 23:00→05:00 overnight run', () => {
  // Pick a real Phoenix evening: 2026-07-17 21:00 MST = 2026-07-18 04:00 UTC.
  const evening = Date.parse('2026-07-18T04:00:00Z'); // 21:00 America/Phoenix
  const win = resolveCheapWindow(overnightPeriodIdAt, evening, 'overnight', 30);
  assert.ok(win, 'a window must resolve');
  assert.equal(phoenixHour(win!.startMs), 23, 'window starts at local 23:00');
  assert.equal(phoenixHour(win!.endMs), 5, 'window ends at local 05:00');
  assert.equal((win!.endMs - win!.startMs) / HOUR, 6, 'overnight window is 6 h');
});

test('window — resolveCheapWindow returns null when the period never matches', () => {
  const win = resolveCheapWindow(() => 'off_peak', B, 'overnight', 12);
  assert.equal(win, null);
});

// ── buildNightChargeInputs: assembly + a plan that matches a direct compute ──
test('buildInputs — assembles a complete-basis input that sizes a real buy', () => {
  const evening = Date.parse('2026-07-18T04:00:00Z'); // 21:00 Phoenix
  const bandHours = Array.from({ length: 24 }, (_, i) => ({
    ts: Math.floor(evening / HOUR) * HOUR + i * HOUR,
    pvP10W: 0,
    loadP90W: 900,
  }));
  const inputs = buildNightChargeInputs(baseDeps({ nowMs: evening, bandHours }));
  assert.equal(inputs.basisComplete, true);
  assert.ok(inputs.window, 'window resolved');
  assert.equal(phoenixHour(inputs.window!.startMs), 23);
  const plan = computeNightChargePlan(inputs);
  assert.equal(plan.chargeTonight, true);
});

// ── climatology → basisComplete false → null plan ──
test('buildInputs — climatology tier forces basisComplete false ⇒ null plan', () => {
  const inputs = buildNightChargeInputs(baseDeps({ confidenceTier: 'climatology' }));
  assert.equal(inputs.basisComplete, false);
  const plan = computeNightChargePlan(inputs);
  assert.equal(plan.chargeTonight, false);
  assert.equal(plan.buyKwh, null);
});

// ── thin/low-coverage/insufficient-cal basis all fail basisComplete ──
for (const [name, ov] of [
  ['low band coverage', { bandCoverageFrac: 0.5 }],
  ['too few scored days', { calScoredDays: 5 }],
  ['no forecast present', { forecastPresent: false }],
] as const) {
  test(`buildInputs — ${name} ⇒ basisComplete false`, () => {
    const inputs = buildNightChargeInputs(baseDeps(ov));
    assert.equal(inputs.basisComplete, false);
  });
}

// ── P10/P90 selection: band PV is used verbatim; beyond-24h is synthesized ──
test('buildInputs — beyond-24h hours synthesize widened daily P10 (PV) / P90 (load)', () => {
  const bandHours = mkHorizon(B, 24, 500, 900).map((h) => ({ ts: h.ts, pvP10W: h.pvP10W, loadP90W: h.loadP90W }));
  // A day-1 rollup starting right after the band (hour 24).
  const dayRollups = [{
    daysAhead: 1,
    hours: mkHorizon(B + 24 * HOUR, 24, 1000, 800).map((h) => ({ ts: h.ts, pvW: h.pvP10W, loadW: h.loadP90W })),
  }];
  const errFrac = 0.2;
  const inputs = buildNightChargeInputs(baseDeps({
    nowMs: B, bandHours, dayRollups, realizedDailyErrHalfFrac: errFrac, nextRechargeMs: B + 48 * HOUR,
  }));
  // Band hour 0 → PV verbatim 500, load verbatim 900.
  const band0 = inputs.horizon.find((h) => h.ts === B)!;
  assert.equal(band0.pvP10W, 500);
  assert.equal(band0.loadP90W, 900);
  // Beyond-24h hour 24: widen = errFrac·√1 = 0.2 ⇒ PV×0.8, load×1.2.
  const beyond = inputs.horizon.find((h) => h.ts === B + 24 * HOUR)!;
  assert.ok(Math.abs(beyond.pvP10W - 1000 * 0.8) < 1e-6, `synth P10 PV ${beyond.pvP10W}`);
  assert.ok(Math.abs(beyond.loadP90W - 800 * 1.2) < 1e-6, `synth P90 load ${beyond.loadP90W}`);
});

// ── EV de-dup: subtracting embedded EV yields a lower charging-hour load ──
test('buildInputs — EV de-dup subtracts the embedded EV before adding the p90 block', () => {
  // Base curve embeds 3000 W historical EV in the charge hour (hour 2). The
  // committed p90 block is a single 11520 W hour placed at hour 2.
  const mk = (embeddedAt2: number) => {
    const bandHours = mkHorizon(B, 24, 0, 900).map((h, i) => ({
      ts: h.ts,
      pvP10W: 0,
      loadP90W: i === 2 ? 900 + embeddedAt2 : 900,
      embeddedEvW: i === 2 ? embeddedAt2 : 0,
    }));
    return buildNightChargeInputs(baseDeps({
      nowMs: B,
      bandHours,
      ev: { p90SessionKwh: 11.52, chargeStartMs: B + 2 * HOUR, sessionCount: 40 },
    }));
  };
  const deduped = mk(3000);
  const chargeHour = deduped.horizon.find((h) => h.ts === B + 2 * HOUR)!;
  // 900 base (embedded 3000 removed) + 11520 EV block = 12420 W. NOT 900+3000+11520.
  assert.ok(Math.abs(chargeHour.loadP90W - (900 + 11520)) < 1e-6,
    `de-duped charge-hour load ${chargeHour.loadP90W} must exclude the double-counted embedded EV`);
});

test('buildInputs — a heavier committed EV session sizes a strictly bigger buy', () => {
  const noEv = computeNightChargePlan(buildNightChargeInputs(baseDeps()));
  const evNight = computeNightChargePlan(buildNightChargeInputs(baseDeps({
    ev: { p90SessionKwh: 26.2, chargeStartMs: EVE + 9 * HOUR, sessionCount: 40 },
  })));
  assert.ok(evNight.chargeTonight);
  assert.ok(evNight.buyKwh! > noEv.buyKwh!, `EV night buy ${evNight.buyKwh} > non-EV ${noEv.buyKwh}`);
});

test('buildInputs — EV block clamps per hour at evMaxLoadW and spills forward', () => {
  // 26.2 kWh session at 11520 W cap ⇒ 11.52 + 11.52 + 3.16 kWh over 3 hours.
  const bandHours = mkHorizon(B, 24, 0, 0).map((h) => ({ ts: h.ts, pvP10W: 0, loadP90W: 0 }));
  const inputs = buildNightChargeInputs(baseDeps({
    nowMs: B,
    bandHours,
    ev: { p90SessionKwh: 26.2, chargeStartMs: B + 2 * HOUR, sessionCount: 40 },
  }));
  const h2 = inputs.horizon.find((h) => h.ts === B + 2 * HOUR)!;
  const h3 = inputs.horizon.find((h) => h.ts === B + 3 * HOUR)!;
  const h4 = inputs.horizon.find((h) => h.ts === B + 4 * HOUR)!;
  assert.equal(h2.loadP90W, 11520, 'hour 2 clamped at EV_MAX_LOAD_W');
  assert.equal(h3.loadP90W, 11520, 'hour 3 clamped at EV_MAX_LOAD_W');
  assert.ok(Math.abs(h4.loadP90W - (26200 - 11520 - 11520)) < 1e-6, `spill remainder ${h4.loadP90W}`);
});

// ── nightChargeStateFields: 12 h staleness guard ──
test('stateFields — fresh complete plan surfaces numbers + charge_tonight', () => {
  const plan = computeNightChargePlan(baseInputs());
  const now = plan.generatedAt + 1 * HOUR; // 1 h old ⇒ fresh
  const s = nightChargeStateFields(plan, now);
  assert.equal(s.charge_tonight, true);
  assert.equal(s.night_charge_target_soc_percent, plan.targetSocPct);
  assert.equal(s.night_charge_buy_kwh, plan.buyKwh);
  assert.ok(s.night_charge_window_start, 'window start HH:MM present');
  assert.match(s.night_charge_window_start!, /^\d{2}:\d{2}$/);
});

test('stateFields — a plan older than 12 h is stale ⇒ numbers null, charge_tonight false', () => {
  const plan = computeNightChargePlan(baseInputs());
  const now = plan.generatedAt + 13 * HOUR; // > 12 h ⇒ stale
  const s = nightChargeStateFields(plan, now);
  assert.equal(s.charge_tonight, false, 'stale ⇒ never a lingering ON');
  assert.equal(s.night_charge_target_soc_percent, null);
  assert.equal(s.night_charge_buy_kwh, null);
});

test('stateFields — incomplete-basis plan is never fresh (numbers null, charge_tonight false)', () => {
  const plan = computeNightChargePlan(baseInputs({ basisComplete: false }));
  const s = nightChargeStateFields(plan, plan.generatedAt);
  assert.equal(s.charge_tonight, false);
  assert.equal(s.night_charge_target_soc_percent, null);
  assert.equal(s.night_charge_buy_kwh, null);
});

test('stateFields — null plan ⇒ all null, charge_tonight strictly false', () => {
  const s = nightChargeStateFields(null, B);
  assert.equal(s.charge_tonight, false);
  assert.equal(s.night_charge_target_soc_percent, null);
  assert.equal(s.night_charge_buy_kwh, null);
  assert.equal(s.night_charge_window_start, null);
  assert.equal(s.night_charge_window_end, null);
});

test('stateFields — window formats as HH:MM in America/Phoenix', () => {
  // window 23:00–05:00 Phoenix on 2026-07-17→18.
  const start = Date.parse('2026-07-18T06:00:00Z'); // 23:00 Phoenix
  const end = Date.parse('2026-07-18T12:00:00Z'); // 05:00 Phoenix
  const plan: NightChargePlan = { ...computeNightChargePlan(baseInputs()), window: { startMs: start, endMs: end }, generatedAt: start };
  const s = nightChargeStateFields(plan, start + HOUR);
  assert.equal(s.night_charge_window_start, '23:00');
  assert.equal(s.night_charge_window_end, '05:00');
});

// ── scoreNightOutcome: §3.1 columns ──
test('scoreOutcome — err fractions, signed buy error, soc-min error, plan-traj breach', () => {
  const plan = computeNightChargePlan(baseInputs()); // charging plan, minProj ≈ 25%
  const actuals: NightOutcomeActuals = {
    actualPvKwh: 12, forecastPvKwh: 10, // +20%
    actualLoadKwh: 18, forecastLoadKwh: 20, // −10%
    actualMinSocPct: 22, actualMinSocTsMs: B + 20 * HOUR,
    realizedNeedBuyKwh: plan.buyKwh! - 3, // planned 3 kWh MORE than needed ⇒ +3 over-buy
  };
  const s = scoreNightOutcome(plan, actuals);
  assert.ok(Math.abs(s.pvErrFrac! - 0.2) < 1e-6, `pvErrFrac ${s.pvErrFrac}`);
  assert.ok(Math.abs(s.loadErrFrac! - -0.1) < 1e-6, `loadErrFrac ${s.loadErrFrac}`);
  assert.ok(Math.abs(s.buyErrKwh! - 3) < 1e-6, `buyErrKwh ${s.buyErrKwh} (+ = over-bought)`);
  assert.ok(Math.abs(s.socMinErrPct! - (plan.minProjSocPct! - 22)) < 1e-6);
  assert.equal(s.planTrajFloorBreached, false, 'plan trough held floor+cushion');
});

test('scoreOutcome — a cushion-shortfall plan trajectory reads planTrajFloorBreached true', () => {
  // charge-power capped so the plan trough sits below floor+cushion (cushionShortfall).
  const plan = computeNightChargePlan(baseInputs({ chargeCapKw: 1, minBuyKwh: 0.1 }));
  assert.equal(plan.cushionShortfall, true);
  const s = scoreNightOutcome(plan, {
    actualPvKwh: null, forecastPvKwh: null, actualLoadKwh: null, forecastLoadKwh: null,
    actualMinSocPct: null, actualMinSocTsMs: null, realizedNeedBuyKwh: null,
  });
  assert.equal(s.planTrajFloorBreached, true, 'plan trajectory would breach floor+cushion');
});

test('scoreOutcome — null plan / missing actuals fail null-safe', () => {
  const s = scoreNightOutcome(null, {
    actualPvKwh: null, forecastPvKwh: null, actualLoadKwh: null, forecastLoadKwh: null,
    actualMinSocPct: null, actualMinSocTsMs: null, realizedNeedBuyKwh: null,
  });
  assert.equal(s.pvErrFrac, null);
  assert.equal(s.loadErrFrac, null);
  assert.equal(s.buyErrKwh, null);
  assert.equal(s.socMinErrPct, null);
  assert.equal(s.planTrajFloorBreached, null);
});

test('scoreOutcome — under-buy surfaces as a NEGATIVE buy error (the safety miss)', () => {
  const plan = computeNightChargePlan(baseInputs());
  const s = scoreNightOutcome(plan, {
    actualPvKwh: null, forecastPvKwh: null, actualLoadKwh: null, forecastLoadKwh: null,
    actualMinSocPct: null, actualMinSocTsMs: null,
    realizedNeedBuyKwh: plan.buyKwh! + 5, // needed 5 kWh MORE than planned ⇒ under-buy
  });
  assert.ok(s.buyErrKwh! < 0, `under-buy must be negative, got ${s.buyErrKwh}`);
  assert.ok(Math.abs(s.buyErrKwh! + 5) < 1e-6);
});

// ── createNightChargeAdvisor: update() builds → computes → latches → returns ──
test('advisor — update() computes, latches the holder, and getStatus() returns it', () => {
  const advisor = createNightChargeAdvisor({ buildInputs: () => baseDeps() });
  const plan = advisor.update();
  assert.equal(plan.chargeTonight, true);
  assert.strictEqual(advisor.getStatus(), plan);
  assert.strictEqual(getLatestNightChargePlan(), plan);
});

test('advisor — climatology basis latches a null plan (charge_tonight false)', () => {
  const advisor = createNightChargeAdvisor({ buildInputs: () => baseDeps({ confidenceTier: 'climatology' }) });
  const plan = advisor.update();
  assert.equal(plan.chargeTonight, false);
  assert.equal(plan.buyKwh, null);
});


/* ── v1.38.0 review regression: EV de-dup must be ATOMIC with the re-add ─────
 * Stripping the embedded expected-value EV without placing the committed p90
 * block would erase a real charging night from the sizing basis and UNDER-buy.
 * When no committed block will be placed (ev=null), the embedded EV must be KEPT. */
test('regression — buildNightChargeInputs keeps embedded EV in load when NO committed block is placed', () => {
  const startMs = B;
  const bandHours = Array.from({ length: 12 }, (_, i) => ({
    ts: startMs + i * HOUR, pvP10W: 0, loadP90W: 3000, embeddedEvW: 2000, // 2 kW expected EV inside the 3 kW load
  }));
  const periodIdAt = (ts: number) => {
    const h = Math.floor((ts - startMs) / HOUR) % 24;
    return h >= 2 && h < 8 ? 'overnight' : 'off';
  };
  const common = {
    nowMs: startMs, fullKwh: 92.16, socNowPct: 30, reserveFloorPct: 10, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2,
    periodIdAt, cheapPeriodId: 'overnight', dayRollups: [], realizedDailyErrHalfFrac: 0.2, nextRechargeMs: null,
    evMaxLoadW: 11520, confidenceTier: 'forecast' as const, forecastPresent: true, calScoredDays: 20,
    minCalScoredDays: 14, bandCoverageFrac: 0.95, morningPvSurplusP90Kwh: null, minBuyKwh: 1,
  };
  const withoutEv = buildNightChargeInputs({ ...common, bandHours, ev: null });
  // With no committed block, the 2 kW embedded EV must NOT be stripped → 3000 W preserved.
  const cheap = withoutEv.horizon.find((h) => h.loadP90W > 0);
  assert.ok(cheap, 'horizon has load hours');
  assert.ok(Math.abs(cheap!.loadP90W - 3000) < 1, `embedded EV kept when no block placed (got ${cheap!.loadP90W})`);

  const withEv = buildNightChargeInputs({ ...common, bandHours, ev: { p90SessionKwh: 20, chargeStartMs: startMs + 3 * HOUR, sessionCount: 12 } });
  // v1.39.0: the strip is atomic PER-HOUR with the re-add — only hours the
  // committed p90 block actually covers are de-duped. Hours before the block
  // KEEP their embedded EV (hour 0's 2 kW may be a DIFFERENT predicted
  // session; erasing it under-buys — the confirmed v1.38 defect).
  const preBlock = withEv.horizon.find((h) => h.ts === startMs)!;
  assert.ok(Math.abs(preBlock.loadP90W - 3000) < 1, `pre-block hour keeps embedded EV (got ${preBlock.loadP90W})`);
  // Hour AT the block start: embedded stripped, p90 watts laid on → 3000 − 2000 + 11520.
  const blockHour = withEv.horizon.find((h) => h.ts === startMs + 3 * HOUR)!;
  assert.ok(Math.abs(blockHour.loadP90W - 12520) < 1, `block hour = clean base + p90 block (got ${blockHour.loadP90W})`);
  // Second block hour: remaining 20 − 11.52 = 8.48 kWh → 3000 − 2000 + 8480.
  const blockHour2 = withEv.horizon.find((h) => h.ts === startMs + 4 * HOUR)!;
  assert.ok(Math.abs(blockHour2.loadP90W - 9480) < 1, `block spill hour (got ${blockHour2.loadP90W})`);
  // After the block exhausts: embedded kept again — never strip without replacing.
  const postBlock = withEv.horizon.find((h) => h.ts === startMs + 5 * HOUR)!;
  assert.ok(Math.abs(postBlock.loadP90W - 3000) < 1, `post-block hour keeps embedded EV (got ${postBlock.loadP90W})`);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.39.0 review-fix regressions (post-merge adversarial review of v1.37–v1.38)
 * ═════════════════════════════════════════════════════════════════════════ */

// ── HIGH: mid-window recompute must credit only the REMAINING window ──
test('v1.39.0 — mid-window plan caps charge power by the REMAINING window hours', () => {
  // Window [B+3h, B+9h] (6 h). Evaluate at B+6h — 3 h remain. chargeCapKw 2,
  // legEff 0.9, window-hour load 0 (horizon load starts after the window) ⇒
  // remaining-cap = 2·3·0.9 = 5.4 kWh. The pre-fix full-window credit would
  // have been 2·6·0.9 = 10.8 kWh. Post-window drain: 1800 W ⇒ 2 kWh/h from
  // B+9h, so the trough collapses and requiredExtra ≫ cap ⇒ bindingCap
  // 'chargePower' with the buy bounded by the 5.4 kWh REMAINING credit.
  const midNow = B + 6 * HOUR;
  const horizon: NightChargeHour[] = [
    ...Array.from({ length: 3 }, (_, i) => ({ ts: B + (6 + i) * HOUR, pvP10W: 0, loadP90W: 0 })), // window hrs left
    ...Array.from({ length: 15 }, (_, i) => ({ ts: B + (9 + i) * HOUR, pvP10W: 0, loadP90W: 1800 })),
  ];
  const p = computeNightChargePlan(baseInputs({ nowMs: midNow, socNowPct: 10, chargeCapKw: 2, horizon, minBuyKwh: 0.1 }));
  assert.equal(p.bindingCap, 'chargePower');
  assert.equal(p.cushionShortfall, true);
  // lift ≤ 5.4 kWh ⇒ buy = lift/legEff ≤ 6.0 kWh — NOT the ~12 kWh a
  // full-window credit would have allowed.
  assert.ok(p.buyKwh! <= 5.4 / 0.9 + 0.01, `buy ${p.buyKwh} must be capped by the remaining window (≤6.0)`);
  assert.ok(/residual risk/i.test(p.rationale), 'undeliverable remainder must be disclosed');
});

test('v1.39.0 — pre-window evaluation still credits the full window (no regression)', () => {
  // Same clean shortfall as the canonical case (evaluated at B, window B+3..B+9):
  // the remaining window IS the full window, so numbers are unchanged.
  const p = computeNightChargePlan(baseInputs());
  assert.equal(p.requiredExtraKwh, 19);
  assert.equal(p.bindingCap, 'requirement');
  assert.ok(Math.abs(p.buyKwh! - 19 / 0.9) < 0.02);
});

// ── LOW: non-finite floor/cushion must fail CLOSED, not max-buy ──
for (const [name, ov] of [
  ['NaN cushionPct', { cushionPct: NaN }],
  ['NaN reserveFloorPct', { reserveFloorPct: NaN }],
  ['negative cushionPct', { cushionPct: -5 }],
  ['NaN chargeCapKw', { chargeCapKw: NaN }],
] as const) {
  test(`v1.39.0 — degenerate config (${name}) → null plan, never a confident max-buy`, () => {
    const p = computeNightChargePlan(baseInputs(ov as Partial<NightChargeInputs>));
    assert.equal(p.chargeTonight, false);
    assert.equal(p.buyKwh, null, 'must be null — the pre-fix path resolved to the FULL pool headroom');
    assert.equal(p.objective, 'none');
  });
}

// ── MED: a run straddling the scan edge keeps its true END ──
test('v1.39.0 — resolveCheapWindow: window found at the scan edge is not end-truncated', () => {
  // Saturday-evening shape: the next overnight run starts 27 h out and runs 5 h
  // (hours 27..31). A 30 h scan finds the start at h=27; the END (h=32) lies
  // past the scan horizon and must still be resolved exactly.
  const from = B;
  const periodIdAt = (ts: number): string => {
    const h = Math.round((ts - B) / HOUR);
    return h >= 27 && h < 32 ? 'overnight' : 'off_peak';
  };
  const win = resolveCheapWindow(periodIdAt, from, 'overnight', 30);
  assert.ok(win, 'window resolves');
  assert.equal((win!.startMs - B) / HOUR, 27);
  assert.equal((win!.endMs - B) / HOUR, 32, 'end must be the true run end, not the scan horizon');
});

// ── MED: far-window honesty — the pre-window carry is measured and disclosed ──
test('v1.39.0 — pre-window dip below floor+cushion is measured and disclosed', () => {
  // Window opens 27 h out (weekend shape). Heavy drain before it: the pack
  // dips well below floor+cushion long before the window opens. The plan must
  // (a) expose preWindowMinSocPct, (b) expose projSocAtWindowStartPct, and
  // (c) say so in the rationale — even on a HOLD.
  const windowStart = B + 27 * HOUR;
  const windowEnd = B + 32 * HOUR;
  // Drain 2 kWh/h for 10 h (30 → 10%), then PV recovers the pack before the window.
  const horizon: NightChargeHour[] = Array.from({ length: 40 }, (_, i) => {
    const ts = B + i * HOUR;
    if (i < 10) return { ts, pvP10W: 0, loadP90W: 1800 };       // deep pre-window drain
    if (i < 27) return { ts, pvP10W: 6000, loadP90W: 900 };     // recovery before window
    return { ts, pvP10W: 0, loadP90W: 450 };                    // light overnight
  });
  const p = computeNightChargePlan(baseInputs({
    window: { startMs: windowStart, endMs: windowEnd },
    horizon,
  }));
  assert.ok(p.preWindowMinSocPct != null && p.preWindowMinSocPct <= 11,
    `pre-window trough ~10% must be measured (got ${p.preWindowMinSocPct})`);
  assert.ok(p.projSocAtWindowStartPct != null && p.projSocAtWindowStartPct > 50,
    `window-entry SoC reflects the recovery (got ${p.projSocAtWindowStartPct})`);
  assert.ok(/before the charge window opens/i.test(p.rationale),
    'the un-protectable pre-window dip must be disclosed in the rationale');
});

// ── nightWindowBounds: the single source of truth for scoring spans ──
test('v1.39.0 — nightWindowBounds resolves the Phoenix night clock exactly', () => {
  const b = nightWindowBounds('2026-07-18')!;
  const day = Date.UTC(2026, 6, 18) + 7 * HOUR; // Phoenix midnight
  assert.equal(b.windowStartMs, day + 23 * HOUR);
  assert.equal(b.windowEndMs, day + 29 * HOUR);
  assert.equal(b.onpeakStartMs, day + 16 * HOUR);
  assert.equal(b.onpeakEndMs, day + 19 * HOUR);
  assert.equal(b.completeMs, day + 45 * HOUR, 'a night completes at D+1 21:00 Phoenix');
  assert.equal(nightWindowBounds('garbage'), null);
  assert.equal(nightWindowBounds('2026-7-8'), null, 'strict YYYY-MM-DD only');
});

// ── display honesty: far windows are day-qualified ──
test('v1.39.0 — state fields day-qualify a window ≥24 h away', () => {
  const nowMs = Date.parse('2026-07-18T04:30:00Z'); // Sat 21:30 Phoenix
  const monStart = Date.parse('2026-07-20T07:00:00Z'); // Mon 00:00 Phoenix (~50.5 h out)
  assert.match(fmtPhoenixDayHm(monStart, nowMs), /^Mon 00:00$/);
  assert.equal(fmtPhoenixDayHm(nowMs + 2 * HOUR, nowMs), fmtPhoenixDayHm(nowMs + 2 * HOUR, nowMs).slice(-5),
    'near instants stay bare HH:MM');
  const plan = computeNightChargePlan(baseInputs());
  setLatestNightChargePlan(plan);
  const fields = nightChargeStateFields({ ...plan, window: { startMs: monStart, endMs: monStart + 5 * HOUR } }, nowMs);
  assert.match(String(fields.night_charge_window_start), /^Mon /,
    'a weekend plan must not present Monday\'s window as a date-less tonight');
});
