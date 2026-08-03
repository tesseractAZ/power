import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNightChargePlan,
  buildNightChargeInputs,
  nightChargeStateFields,
  type NightChargeInputs,
  type NightChargeHour,
  type NightChargePlan,
  type NightChargeInputDeps,
  type BindingCap,
  BINDING_CAPS,
} from '../src/nightChargeAdvisor.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { armFromPlan, emptyActuationState, clampReserveTarget } from '../src/nightChargeActuator.js';
import { nightChargePlanIfFresh } from '../src/telnet/dataProvider.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargeAdvisor — EV CONTENTION (v1.60.0).
 *
 * THE MEASURED DEFECT (night of 2026-08-02→03): the planner announced 10% → 36%
 * (~36 kWh buy). At 03:00 `panel_load` was 14.0 kW (EVSE ~11.5 kW + ~2.5 kW
 * baseline) and the packs were receiving only ~2.8 kW — arrival ~31–32%, not
 * 36%. The buy was rate-limited by what the EVSE left on the shared grid input,
 * and the planner did not model that at all: it assumed the full chChargeWatt
 * was available to the packs no matter what the house was drawing.
 *
 * These tests pin the SAFETY contract of the fix:
 *  (a) contention predicted ⇒ the buy AND the target are derated and the
 *      shortfall is reported (never a promise the window cannot keep);
 *  (b) no EV prediction ⇒ fall back to the pre-v1.60.0 behaviour and DISCLOSE
 *      that contention is unmodelled — never claim a prediction;
 *  (c) a predicted ZERO EV draw is a different, stronger claim than NO
 *      prediction, and the two must never collapse (null ≠ 0);
 *  (d) the new `bindingCap` value renders on every consumer surface — no blank,
 *      no `undefined`.
 *
 * ★ The fix models contention. It NEVER commands the EV charger: no test here
 *   asserts a pause/throttle/reschedule, because no such code path exists —
 *   that circuit is not this add-on's to write.
 *
 * Arithmetic (legEff = dischargeEff = 0.9, 100 kWh pool, floor 10 + cushion 15
 * ⇒ 25 kWh line, chargeCap 10 kW, grid-input envelope 15 kW):
 *   window = 6 h, first 3 h carry the car (13.0 kW = 2.5 base + 10.5 EVSE),
 *   last 3 h are quiet (1.8 kW).
 *   contended rates  = clamp(15 − 13, 0, 10) = 2 kW  ×3 h
 *                    + clamp(15 − 1.8, 0, 10) = 10 kW ×3 h
 *   deliverable lift = (3·2 + 3·10)·0.9 = 32.4 kWh
 *   EV-blind lift    =  10·6·0.9         = 54.0 kWh   ⇒ derate 21.6 kWh
 * ═════════════════════════════════════════════════════════════════════════ */

const HOUR = 3_600_000;
const B = 1_800_000 * HOUR; // arbitrary hour-aligned base epoch

/** Hour indices 3,4,5 of the horizon are the contended (car-charging) hours. */
const EV_HOURS = new Set([3, 4, 5]);
const EV_W = 10_500; // the EVSE component
const BASE_W = 2_500; // house baseline while the car charges
const QUIET_W = 1_800; // every other hour

/**
 * The measured-defect horizon. `evKnown` selects whether each WINDOW hour
 * carries an `evP90W` attribution (a covering EVSE prediction) or leaves it
 * undefined (no prediction covers that hour). `withEv=false` removes the car
 * from the load curve entirely — the ordinary quiet night.
 */
function mkHorizon(opts: { withEv: boolean; evKnown: boolean }): NightChargeHour[] {
  return Array.from({ length: 24 }, (_, i): NightChargeHour => {
    const carHour = opts.withEv && EV_HOURS.has(i);
    // Post-window hours run heavier (3.0 kW) so the overnight trough genuinely
    // needs a large buy — that is what makes the deliverable ceiling bind.
    const post = i >= 9;
    const loadP90W = carHour ? BASE_W + EV_W : post ? 3_000 : QUIET_W;
    const h: NightChargeHour = { ts: B + i * HOUR, pvP10W: 0, loadP90W };
    if (opts.evKnown) h.evP90W = carHour ? EV_W : 0;
    return h;
  });
}

function baseInputs(overrides: Partial<NightChargeInputs> = {}): NightChargeInputs {
  return {
    nowMs: B,
    fullKwh: 100,
    socNowPct: 40,
    reserveFloorPct: 10,
    cushionPct: 15,
    socCoherent: true,
    legEff: 0.9,
    dischargeEff: 0.9,
    chargeCapKw: 10,
    gridInputCapKw: 15,
    window: { startMs: B + 3 * HOUR, endMs: B + 9 * HOUR },
    horizon: mkHorizon({ withEv: true, evKnown: true }),
    morningPvSurplusP90Kwh: null,
    confidenceTier: 'forecast',
    basisComplete: true,
    minBuyKwh: 1,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// (a) Contention predicted ⇒ buy + target derated, shortfall reported
// ═══════════════════════════════════════════════════════════════════════════

test('EV contention — the same night is met without the car and SHORT with it', () => {
  // The counterfactual: identical inputs, contention modelling switched off
  // (this is exactly the pre-v1.60.0 planner, and exactly the 2026-08-02 bug).
  const blind = computeNightChargePlan(baseInputs({ gridInputCapKw: null }));
  const contended = computeNightChargePlan(baseInputs());

  // EV-blind: the requirement (43.36 kWh lift) sits under the 54 kWh EV-blind
  // ceiling, so the old planner cheerfully promises 75% and no shortfall.
  assert.equal(blind.bindingCap, 'requirement');
  assert.equal(blind.cushionShortfall, false);
  assert.equal(blind.targetSocPct, 75);
  assert.ok(Math.abs(blind.buyKwh! - 43.36 / 0.9) < 0.05, `EV-blind buy ≈ 48.2, got ${blind.buyKwh}`);

  // Contended: the window can deliver only 32.4 kWh of lift, so the honest
  // arrival is 66.4% and the cushion is NOT met.
  assert.equal(contended.bindingCap, 'evContention');
  assert.equal(contended.cushionShortfall, true, 'the shortfall must be reported, not absorbed');
  assert.equal(contended.targetSocPct, 66.4);
  assert.equal(contended.buyKwh, 36); // 32.4 kWh lift / 0.9 leg efficiency

  // THE property: modelling contention only ever moves the promise DOWN.
  assert.ok(contended.buyKwh! < blind.buyKwh!, 'buy must be derated, never inflated');
  assert.ok(contended.targetSocPct! < blind.targetSocPct!, 'target must be derated, never inflated');
  assert.ok(contended.minProjSocPct! < contended.reserveFloorPct + contended.cushionPct);
});

test('EV contention — the disclosure quantifies the car, the rate and the derate', () => {
  const p = computeNightChargePlan(baseInputs());
  const ev = p.evContention!;
  assert.equal(ev.basis, 'predicted');
  assert.equal(ev.windowEvKwh, 31.5); // 3 h × 10.5 kW
  assert.equal(ev.peakEvKw, 10.5);
  assert.equal(ev.minChargeRateKw, 2); // 15 kW envelope − 13 kW house
  assert.equal(ev.derateKwh, 21.6); // 54.0 EV-blind − 32.4 contended
  assert.match(p.rationale, /EV charging is predicted inside the window/);
  assert.match(p.rationale, /31\.5 kWh/);
  assert.match(p.rationale, /2 kW for the packs/);
});

test('EV contention — a bigger predicted EV draw can only shrink the buy', () => {
  // Monotone in the car's appetite: more EV ⇒ less left for the packs.
  const heavier = mkHorizon({ withEv: true, evKnown: true }).map((h) =>
    EV_HOURS.has(Math.round((h.ts - B) / HOUR))
      ? { ...h, loadP90W: h.loadP90W + 1_000, evP90W: (h.evP90W ?? 0) + 1_000 }
      : h,
  );
  const base = computeNightChargePlan(baseInputs());
  const worse = computeNightChargePlan(baseInputs({ horizon: heavier }));
  assert.ok(worse.buyKwh! < base.buyKwh!, `heavier EV ⇒ smaller deliverable buy (${worse.buyKwh} < ${base.buyKwh})`);
  assert.ok(worse.evContention!.derateKwh! > base.evContention!.derateKwh!);
  assert.equal(worse.cushionShortfall, true);
});

test('EV contention — a quiet window is untouched by the envelope model', () => {
  // No car in the load curve ⇒ the envelope never bites ⇒ byte-identical sizing
  // to the EV-blind planner. Contention modelling must not tax ordinary nights.
  const horizon = mkHorizon({ withEv: false, evKnown: true });
  const withEnvelope = computeNightChargePlan(baseInputs({ horizon }));
  const withoutEnvelope = computeNightChargePlan(baseInputs({ horizon, gridInputCapKw: null }));
  assert.equal(withEnvelope.buyKwh, withoutEnvelope.buyKwh);
  assert.equal(withEnvelope.targetSocPct, withoutEnvelope.targetSocPct);
  assert.equal(withEnvelope.bindingCap, withoutEnvelope.bindingCap);
  assert.equal(withEnvelope.evContention!.derateKwh, 0);
  assert.equal(withEnvelope.evContention!.windowEvKwh, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) No EV prediction ⇒ today's behaviour + an honest "not modelled"
// ═══════════════════════════════════════════════════════════════════════════

test('no EV prediction — quiet night falls back to the pre-v1.60.0 plan exactly', () => {
  const horizon = mkHorizon({ withEv: false, evKnown: false });
  const fallback = computeNightChargePlan(baseInputs({ horizon }));
  const legacy = computeNightChargePlan(baseInputs({ horizon, gridInputCapKw: null }));
  assert.equal(fallback.buyKwh, legacy.buyKwh);
  assert.equal(fallback.targetSocPct, legacy.targetSocPct);
  assert.equal(fallback.requiredExtraKwh, legacy.requiredExtraKwh);
  assert.equal(fallback.bindingCap, legacy.bindingCap);
  assert.equal(fallback.cushionShortfall, legacy.cushionShortfall);
  // …and it does NOT claim a prediction it never had.
  assert.equal(fallback.evContention!.basis, 'unavailable');
  assert.equal(fallback.evContention!.windowEvKwh, null);
  assert.equal(fallback.evContention!.peakEvKw, null);
  assert.doesNotMatch(fallback.rationale, /EV charging is predicted/);
});

test('no EV prediction — an UNPREDICTED heavy window still derates, but is never attributed to the EV', () => {
  // The car IS in the load curve (a rollup-synthesized hour beyond the
  // predictor's 24 h reach), but nothing tells us it is the car. The derate is
  // physics and still applies; the ATTRIBUTION must not be invented.
  const unknown = computeNightChargePlan(baseInputs({ horizon: mkHorizon({ withEv: true, evKnown: false }) }));
  const known = computeNightChargePlan(baseInputs());
  assert.equal(unknown.buyKwh, known.buyKwh, 'sizing is driven by load, not by the attribution');
  assert.equal(unknown.targetSocPct, known.targetSocPct);
  assert.equal(unknown.cushionShortfall, true);

  assert.equal(unknown.bindingCap, 'chargePower', 'must NOT claim evContention without a covering prediction');
  assert.equal(unknown.evContention!.basis, 'unavailable');
  assert.equal(unknown.evContention!.windowEvKwh, null, 'a missing prediction is null, never 0');
  assert.equal(unknown.evContention!.derateKwh, 21.6, 'the derate is still disclosed — it is physics');
  assert.doesNotMatch(unknown.rationale, /EV charging is predicted/);
  assert.match(unknown.rationale, /no EVSE prediction covers this window/);
  assert.match(unknown.rationale, /NOT modelled/);
});

test('no EV prediction — PARTIAL window coverage is not a prediction', () => {
  // One uncovered window hour is enough: we do not know what the car does then.
  const horizon = mkHorizon({ withEv: true, evKnown: true });
  delete horizon[7].evP90W; // a window hour with no covering prediction
  const p = computeNightChargePlan(baseInputs({ horizon }));
  assert.equal(p.evContention!.basis, 'unavailable');
  assert.equal(p.evContention!.windowEvKwh, null);
  assert.notEqual(p.bindingCap, 'evContention');
});

test('no envelope configured — contention is not modelled and not claimed', () => {
  for (const cap of [null, 0, Number.NaN, -5] as Array<number | null>) {
    const p = computeNightChargePlan(baseInputs({ gridInputCapKw: cap }));
    assert.equal(p.evContention!.derateKwh, null, `derate must be null (not 0) for envelope=${cap}`);
    assert.equal(p.evContention!.minChargeRateKw, null);
    assert.notEqual(p.bindingCap, 'evContention');
    // Basis is still honest: the EVSE prediction itself DID cover the window.
    assert.equal(p.evContention!.basis, 'predicted');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) predicted-ZERO ≠ NO-prediction
// ═══════════════════════════════════════════════════════════════════════════

test('predicted-zero EV draw is a different claim from no prediction at all', () => {
  const quiet = mkHorizon({ withEv: false, evKnown: true }); // evP90W = 0 everywhere
  const silent = mkHorizon({ withEv: false, evKnown: false }); // evP90W absent
  const predictedZero = computeNightChargePlan(baseInputs({ horizon: quiet }));
  const noPrediction = computeNightChargePlan(baseInputs({ horizon: silent }));

  // Identical SIZING (both windows are genuinely quiet)…
  assert.equal(predictedZero.buyKwh, noPrediction.buyKwh);
  assert.equal(predictedZero.targetSocPct, noPrediction.targetSocPct);

  // …but NOT identical CLAIMS.
  assert.equal(predictedZero.evContention!.basis, 'predicted');
  assert.equal(predictedZero.evContention!.windowEvKwh, 0);
  assert.equal(predictedZero.evContention!.peakEvKw, 0);

  assert.equal(noPrediction.evContention!.basis, 'unavailable');
  assert.equal(noPrediction.evContention!.windowEvKwh, null);
  assert.notEqual(noPrediction.evContention!.windowEvKwh, 0, 'null must never collapse to 0');
  assert.notEqual(predictedZero.evContention!.basis, noPrediction.evContention!.basis);
});

test('buildInputs — a missing EVSE report leaves every hour UNATTRIBUTED (never 0)', () => {
  const inputs = buildNightChargeInputs(evDeps({ ev: null }));
  assert.ok(inputs.horizon.length > 0);
  assert.ok(
    inputs.horizon.every((h) => h.evP90W == null),
    'no ev report ⇒ no hour may claim a 0 kW EV prediction',
  );
  assert.equal(computeNightChargePlan(inputs).evContention!.basis, 'unavailable');
});

test('buildInputs — an EVSE report that predicts nothing DOES attribute 0 to every band hour', () => {
  // p90SessionKwh null ⇒ no committed block is placed, but the predictor ran:
  // the embedded expected-value EV (0 here) is a real predicted zero.
  const inputs = buildNightChargeInputs(evDeps({ ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 } }));
  assert.ok(inputs.horizon.every((h) => h.evP90W === 0));
  assert.equal(computeNightChargePlan(inputs).evContention!.basis, 'predicted');
});

test('buildInputs — the committed EV block becomes that hour\'s EV attribution', () => {
  const start = B + 4 * HOUR;
  const inputs = buildNightChargeInputs(
    evDeps({ ev: { p90SessionKwh: 15, chargeStartMs: start, sessionCount: 8 } }),
  );
  const blockHour = inputs.horizon.find((h) => h.ts === start)!;
  // 15 kWh session, clamped to EV_MAX_LOAD_W = 11 520 W in the first hour.
  assert.equal(blockHour.evP90W, 11_520);
  assert.equal(blockHour.loadP90W, QUIET_W + 11_520, 'the block rides on top of the EV-clean base');
  // The spill hour carries the remaining 3.48 kWh.
  const spill = inputs.horizon.find((h) => h.ts === start + HOUR)!;
  assert.ok(Math.abs(spill.evP90W! - 3_480) < 1e-6, `spill hour ≈ 3480 W, got ${spill.evP90W}`);
  // An hour the block never reached keeps its (zero) embedded prediction.
  assert.equal(inputs.horizon.find((h) => h.ts === B)!.evP90W, 0);
});

/** Minimal deps for the input-assembly tests: a flat quiet band, an always-cheap
 *  period resolver so the window resolves deterministically. */
function evDeps(overrides: Partial<NightChargeInputDeps> = {}): NightChargeInputDeps {
  return {
    nowMs: B,
    fullKwh: 100,
    socNowPct: 40,
    reserveFloorPct: 10,
    cushionPct: 15,
    socCoherent: true,
    legEff: 0.9,
    dischargeEff: 0.9,
    chargeCapKw: 10,
    gridInputCapKw: 15,
    periodIdAt: (ts: number) => ((ts - B) / HOUR >= 3 && (ts - B) / HOUR < 9 ? 'overnight' : 'off_peak'),
    cheapPeriodId: 'overnight',
    windowScanHours: 30,
    bandHours: Array.from({ length: 24 }, (_, i) => ({
      ts: B + i * HOUR,
      pvP10W: 0,
      loadP90W: QUIET_W,
      embeddedEvW: 0,
    })),
    dayRollups: [],
    realizedDailyErrHalfFrac: 0.1,
    nextRechargeMs: null,
    ev: null,
    evMaxLoadW: 11_520,
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

// ═══════════════════════════════════════════════════════════════════════════
// (d) Every consumer renders the new bindingCap — no blank, no `undefined`
// ═══════════════════════════════════════════════════════════════════════════

/** Every member of the BindingCap union. BINDING_CAPS is exported from src and
 *  is exhaustiveness-checked THERE by `tsc --noEmit` (server/test/ is outside
 *  tsconfig's `include`, so a type-level assertion written here would prove
 *  nothing), which is why this list is derived rather than retyped. */
const ALL_CAPS: readonly BindingCap[] = [...BINDING_CAPS, null];

function mkPlan(overrides: Partial<NightChargePlan> = {}): NightChargePlan {
  return {
    generatedAt: B,
    basisComplete: true,
    objective: 'resilience_cushion',
    chargeTonight: true,
    buyKwh: 36,
    targetSocPct: 66.4,
    requiredExtraKwh: 100,
    setpointSocPct: 75,
    bindingCap: 'evContention',
    cushionShortfall: true,
    evContention: {
      basis: 'predicted',
      windowEvKwh: 31.5,
      peakEvKw: 10.5,
      minChargeRateKw: 2,
      derateKwh: 21.6,
    },
    minProjSocPct: 16.4,
    minProjSocTsMs: B + 23 * HOUR,
    baselineMinSocPct: 0,
    projSocAtWindowStartPct: 34,
    preWindowMinSocPct: 34,
    confidenceTier: 'forecast',
    window: { startMs: B + 3 * HOUR, endMs: B + 9 * HOUR },
    reserveFloorPct: 10,
    cushionPct: 15,
    rationale: 'test',
    ...overrides,
  };
}

test('consumer (notify) — the evContention cap renders a quantified EV note', () => {
  const msg = buildNightChargeMessage(mkPlan(), 'charge');
  assert.match(msg.body, /EV charging is predicted inside the window/);
  assert.match(msg.body, /31\.5 kWh/);
  assert.match(msg.body, /10\.5 kW/);
  assert.match(msg.body, /2 kW for the packs/);
});

test('consumer (notify) — an UNMODELLED contention renders a warning, not reassurance', () => {
  const msg = buildNightChargeMessage(
    mkPlan({
      bindingCap: 'chargePower',
      evContention: { basis: 'unavailable', windowEvKwh: null, peakEvKw: null, minChargeRateKw: null, derateKwh: 21.6 },
    }),
    'charge',
  );
  assert.match(msg.body, /no EVSE prediction covers this window/);
  assert.match(msg.body, /NOT modelled/);
  assert.doesNotMatch(msg.body, /EV charging is predicted/);
});

test('consumer (notify) — no bindingCap can leak `undefined`/`null` into the message', () => {
  for (const cap of ALL_CAPS) {
    for (const ev of [
      null,
      { basis: 'predicted' as const, windowEvKwh: 31.5, peakEvKw: 10.5, minChargeRateKw: 2, derateKwh: 21.6 },
      { basis: 'predicted' as const, windowEvKwh: 0, peakEvKw: 0, minChargeRateKw: 10, derateKwh: 0 },
      { basis: 'unavailable' as const, windowEvKwh: null, peakEvKw: null, minChargeRateKw: null, derateKwh: null },
    ]) {
      for (const shape of ['charge', 'hold'] as const) {
        const msg = buildNightChargeMessage(mkPlan({ bindingCap: cap, evContention: ev }), shape);
        const text = `${msg.title} ${msg.body}`;
        assert.doesNotMatch(text, /undefined|\[object Object\]|NaN/, `cap=${cap} shape=${shape}`);
        assert.doesNotMatch(text, /~null|null kWh|null%/, `cap=${cap} shape=${shape}`);
      }
    }
  }
});

test('consumer (TUI freshness gate) — an evContention plan reaches the terminal unchanged', () => {
  const p = mkPlan({ generatedAt: B - 60_000 });
  assert.equal(nightChargePlanIfFresh(p, B), p);
  assert.equal(nightChargePlanIfFresh(p, B)!.bindingCap, 'evContention');
  assert.equal(nightChargePlanIfFresh(p, B)!.evContention!.derateKwh, 21.6);
});

test('consumer (ledger/API) — the plan serializes with the contention block intact', () => {
  // The /api/night-charge/status route and the plan snapshot both JSON-serialize
  // the plan whole; a non-serializable or undefined-valued field would silently
  // vanish from the owner-facing surfaces.
  const round = JSON.parse(JSON.stringify(computeNightChargePlan(baseInputs()))) as NightChargePlan;
  assert.equal(round.bindingCap, 'evContention');
  assert.deepEqual(round.evContention, {
    basis: 'predicted',
    windowEvKwh: 31.5,
    peakEvKw: 10.5,
    minChargeRateKw: 2,
    derateKwh: 21.6,
  });
  // `undefined` would be dropped by JSON.stringify — null must survive.
  const unknown = JSON.parse(
    JSON.stringify(computeNightChargePlan(baseInputs({ horizon: mkHorizon({ withEv: true, evKnown: false }) }))),
  ) as NightChargePlan;
  assert.ok('windowEvKwh' in unknown.evContention!, 'the null must survive serialization');
  assert.equal(unknown.evContention!.windowEvKwh, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// (e) THE WRITE SETPOINT vs THE PREDICTION
//
// `backupReserveSoc` is an instruction, not a promise: the device charges as
// fast as physics allows and stops at the reserve. Before contention modelling
// the achievable arrival WAS the requirement whenever the buy was deliverable,
// so one number served both roles. Once the arrival is derated they diverge,
// and writing the derated number would cap the charge at a guess — if the
// predicted EV session never plugs in, the full rate was available all night
// and the device would still have stopped short. That is a model-induced
// under-buy on the resilience buy, so the setpoint is derived from the
// REQUIREMENT and the prediction keeps its own field.
// ═══════════════════════════════════════════════════════════════════════════

test('setpoint — the contended night asks for the requirement, predicts the arrival', () => {
  const p = computeNightChargePlan(baseInputs());
  // 15 post-window hours × 3.333 kWh/h = 50 kWh of drain below the 25 kWh
  // floor+cushion line ⇒ the window must close at 75 kWh (75%) to hold it.
  assert.equal(p.setpointSocPct, 75, 'the ask is the requirement, not the deliverable arrival');
  assert.equal(p.targetSocPct, 66.4, 'the prediction stays the contention-derated arrival');
  assert.ok(p.setpointSocPct! > p.targetSocPct!, 'a capped night must ask for more than it expects');
  // …and the EV-blind planner, which CAN deliver the requirement, lands on the
  // same ask — the setpoint is exactly what the pre-contention write asked for.
  const blind = computeNightChargePlan(baseInputs({ gridInputCapKw: null }));
  assert.equal(blind.setpointSocPct, 75, 'the setpoint must not regress below the pre-v1.60.0 write');
  assert.match(p.rationale, /reserve is set to 75% \(the resilience requirement\)/);
  assert.match(p.rationale, /only expected to reach ~66\.4%/);
});

test('setpoint — an uncapped night has NO divergence to disclose', () => {
  const blind = computeNightChargePlan(baseInputs({ gridInputCapKw: null }));
  assert.equal(blind.bindingCap, 'requirement');
  assert.equal(blind.setpointSocPct, blind.targetSocPct, 'nothing capped the buy ⇒ ask == expectation');
  assert.doesNotMatch(blind.rationale, /resilience requirement/, 'no spurious distinction');

  const quiet = computeNightChargePlan(baseInputs({ horizon: mkHorizon({ withEv: false, evKnown: true }) }));
  assert.equal(quiet.setpointSocPct, quiet.targetSocPct);
});

test('setpoint — never below the arrival we already predict, on any shape of night', () => {
  const cases: Array<[string, Partial<NightChargeInputs>]> = [
    ['contended', {}],
    ['EV-blind', { gridInputCapKw: null }],
    ['quiet window', { horizon: mkHorizon({ withEv: false, evKnown: true }) }],
    ['unpredicted heavy window', { horizon: mkHorizon({ withEv: true, evKnown: false }) }],
    ['hold night', { socNowPct: 95, horizon: mkHorizon({ withEv: false, evKnown: true }).map((h) => ({ ...h, loadP90W: 200 })) }],
    ['tiny envelope', { gridInputCapKw: 13.05 }],
  ];
  for (const [name, ov] of cases) {
    const p = computeNightChargePlan(baseInputs(ov));
    if (p.setpointSocPct == null || p.targetSocPct == null) continue;
    assert.ok(
      p.setpointSocPct >= p.targetSocPct - 1e-9,
      `${name}: setpoint ${p.setpointSocPct} must never sit below the predicted arrival ${p.targetSocPct}`,
    );
  }
});

test('consumer (actuator) — the bounded write arms from the SETPOINT, not the prediction', () => {
  const p = mkPlan({ setpointSocPct: 41.2, targetSocPct: 31.4, window: { startMs: B + HOUR, endMs: B + 7 * HOUR } });
  const armed = armFromPlan(emptyActuationState(), '2026-08-03', p, B, 10);
  assert.ok(armed, 'a charge plan with a setpoint must arm');
  assert.equal(armed!.targetPct, 41, 'clampReserveTarget(41.2) — the requirement, NOT the derated 31.4');
  assert.notEqual(armed!.targetPct, clampReserveTarget(p.targetSocPct!), 'writing the prediction is the regression');
  // The [10,50] envelope is untouched by any of this.
  const huge = armFromPlan(emptyActuationState(), '2026-08-03', mkPlan({ setpointSocPct: 88, window: { startMs: B + HOUR, endMs: B + 7 * HOUR } }), B, 10);
  assert.equal(huge!.targetPct, 50, 'the device bound still clamps the ask');
  // A plan with no setpoint cannot arm at all (fail-closed, unchanged).
  assert.equal(armFromPlan(emptyActuationState(), '2026-08-03', mkPlan({ setpointSocPct: null }), B, 10), null);
});

test('consumer (HA/MQTT) — the write entity carries the ask, a separate entity carries the expectation', () => {
  const p = mkPlan({ setpointSocPct: 41.2, targetSocPct: 31.4, generatedAt: B });
  const f = nightChargeStateFields(p, B);
  assert.equal(f.night_charge_target_soc_percent, 41, 'the entity an automation WRITES from is the setpoint (clamped)');
  assert.equal(f.night_charge_expected_soc_percent, 31.4, 'the prediction keeps its own entity');
  // Out-of-range asks are published inside the device bound, so an automation
  // is never handed a value backupReserveSoc cannot take.
  assert.equal(nightChargeStateFields(mkPlan({ setpointSocPct: 88, generatedAt: B }), B).night_charge_target_soc_percent, 50);
  // Stale / null plans still emit BOTH keys as null (never a missing key).
  const stale = nightChargeStateFields(p, B + 13 * HOUR);
  assert.equal(stale.night_charge_target_soc_percent, null);
  assert.equal(stale.night_charge_expected_soc_percent, null);
});

test('consumer (notify) — the announcement names the ask AND the expectation when they differ', () => {
  const sup = { cancelDeadlineText: 'tonight at 22:55', targetPct: 41 };
  const diverged = buildNightChargeMessage(mkPlan({ setpointSocPct: 41.2, targetSocPct: 31.4 }), 'charge', sup);
  assert.match(diverged.body, /raises the backup reserve to 41%/);
  assert.match(diverged.body, /only expected to reach ~31\.4%/);
  assert.match(diverged.body, /the reserve is the ask, not a forecast/);

  // Equal numbers ⇒ no clutter.
  const agreed = buildNightChargeMessage(mkPlan({ setpointSocPct: 41, targetSocPct: 41 }), 'charge', sup);
  assert.match(agreed.body, /raises the backup reserve to 41%/);
  assert.doesNotMatch(agreed.body, /expected to reach/);

  // A prediction ABOVE the ask is just the [10,50] clamp talking — not a
  // shortfall, and it must not produce a backwards "expect more than we ask".
  const clamped = buildNightChargeMessage(mkPlan({ setpointSocPct: 88, targetSocPct: 75 }), 'charge', { ...sup, targetPct: 50 });
  assert.doesNotMatch(clamped.body, /expected to reach/);
});

// ── The contention must never silently swallow a night ────────────────────────
test('a contention-driven sub-threshold buy still discloses the shortfall', () => {
  // The car charges through the WHOLE window and the envelope sits barely above
  // the house draw ⇒ almost nothing is deliverable, so the buy falls under the
  // minimum-buy threshold. That must NOT read as a tidy "nothing worth buying"
  // — the cushion is still missed.
  const allNight = mkHorizon({ withEv: true, evKnown: true }).map((h, i) =>
    i >= 3 && i < 9 ? { ...h, loadP90W: BASE_W + EV_W, evP90W: EV_W } : h,
  );
  const p = computeNightChargePlan(baseInputs({ horizon: allNight, gridInputCapKw: 13.05 }));
  assert.equal(p.chargeTonight, false);
  assert.equal(p.cushionShortfall, true);
  assert.match(p.rationale, /residual risk remains/);
  assert.match(p.rationale, /EV charging is predicted inside the window/);
});
