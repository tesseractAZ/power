import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNightChargePlan, type NightChargeInputs, type NightChargePlan } from '../src/nightChargeAdvisor.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { buildApsREvModel } from '../src/tariff.js';
import { runMiddayShadowEvening, shadowCycleConfig, middayShadowPreview, type MiddayShadowRecord } from '../src/middayShadow.js';
import { goldenPlan } from './fixtures/overnightTextCases.js';

/**
 * v1.196.0 — THE "NO PLAN TONIGHT" PUSH NAMES WHAT REFUSED THE PLAN.
 *
 * v1.148.0 named the failed basis gate (basisBlockedBy) and put it in the rationale; the comment
 * there said the string reached the 21:30 notification and the spoken advisory. Neither carried it:
 * the push was one fixed sentence ("the forecast/telemetry basis is incomplete") for a band-coverage
 * miss, incoherent SoC telemetry, a climatology tier and a night with no panel reading at all, and
 * that shape is never spoken. `NightChargePlan.basisBlockedBy` was declared and never set, so the
 * mid-day preview's "not armed — the plan basis is incomplete (…)" could never name it either.
 */

const COVERAGE = 'PV band coverage 72% < 78% (forecast present, tier=forecast, calDays 14/14)';
const TAIL = ', so nothing will be charged. (This confirms the evening job ran; the reserve floor is unchanged.)';
const push = (p: NightChargePlan | null) => buildNightChargeMessage(p, 'insufficient_basis');

test('★★★ a basis-gate refusal carries the gate on the plan, and the push states it', () => {
  const p = goldenPlan({ bandCoverageFrac: 0.72, calScoredDays: 14 });
  assert.equal(p.basisComplete, false);
  assert.equal(p.basisBlockedBy, COVERAGE, 'was undefined: declared and never set');
  assert.equal(p.rationale, `No plan — forecast/telemetry basis incomplete (${COVERAGE}); nothing will be charged.`);
  const m = push(p);
  assert.equal(m.title, 'Night-charge: no plan tonight');
  assert.equal(m.body, `No overnight charge plan tonight — the forecast/telemetry basis is incomplete: ${COVERAGE}${TAIL}`);
  assert.equal(m.severity, 'info');
  assert.equal(m.dedupId, 'night_charge_plan');
});

/** A complete, chargeable night (zeroCushion.test.ts's shape) to break one precondition of. */
const H = 3_600_000;
const B = 1_788_400_000_000;
const inputs = (o: Partial<NightChargeInputs> = {}): NightChargeInputs => ({
  nowMs: B, fullKwh: 100, socNowPct: 30, reserveFloorPct: 10, cushionPct: 15, socCoherent: true,
  legEff: 0.9, dischargeEff: 0.9, chargeCapKw: 100, gridInputCapKw: null,
  window: { startMs: B + 3 * H, endMs: B + 9 * H },
  horizon: Array.from({ length: 24 }, (_, i) => ({ ts: B + i * H, pvP10W: 0, loadP90W: 900 })),
  morningPvSurplusP90Kwh: null, confidenceTier: 'forecast', basisComplete: true, minBuyKwh: 1,
  ...o,
});

test('★★★ every precondition the planner refuses on is named the same way, on the plan and in the push', () => {
  const cases: Array<[Partial<NightChargeInputs>, string]> = [
    [{ socCoherent: false }, 'SoC telemetry incoherent (% vs remaining/full mismatch)'],
    [{ confidenceTier: 'climatology' }, 'horizon is climatology-only (no real forecast)'],
    [{ fullKwh: 0 }, 'pool capacity unavailable'],
    [{ socNowPct: Number.NaN }, 'current SoC unavailable'],
    [{ reserveFloorPct: Number.NaN }, 'reserve floor / outage cushion is not a finite non-negative number'],
    [{ cushionPct: -1 }, 'reserve floor / outage cushion is not a finite non-negative number'],
    [{ legEff: 0 }, 'efficiency/charge-power configuration is not a finite number'],
    [{ chargeCapKw: Number.NaN }, 'efficiency/charge-power configuration is not a finite number'],
    [{ horizon: [] }, 'empty forecast horizon'],
  ];
  for (const [o, why] of cases) {
    const p = computeNightChargePlan(inputs(o));
    assert.equal(p.basisComplete, false, why);
    assert.equal(p.basisBlockedBy, why);
    assert.ok(p.rationale.startsWith(`No plan — ${why}`), p.rationale);
    assert.equal(push(p).body, `No overnight charge plan tonight — the forecast/telemetry basis is incomplete: ${why}${TAIL}`);
  }
  // The golden's incomplete-basis night (overnightTextCases 'incomplete basis').
  assert.equal(goldenPlan({ socCoherent: false }).basisBlockedBy, 'SoC telemetry incoherent (% vs remaining/full mismatch)');
});

test('★★★ a complete plan carries no basisBlockedBy key: charge, hold and windowless plans are unchanged', () => {
  const charge = computeNightChargePlan(inputs());
  const hold = computeNightChargePlan(inputs({ socNowPct: 95 }));
  const windowless = computeNightChargePlan(inputs({ window: null }));
  assert.equal(charge.chargeTonight, true);
  assert.equal(hold.chargeTonight, false);
  assert.equal(hold.basisComplete, true);
  assert.equal(windowless.basisComplete, true, 'no cheap window is not a basis failure (v1.132.0)');
  for (const p of [charge, hold, windowless, goldenPlan({})]) {
    assert.equal('basisBlockedBy' in p, false, p.rationale);
    assert.equal(JSON.stringify(p).includes('basisBlockedBy'), false);
  }
});

test('★★★ a null plan is the panel\'s pool readings missing — not an incomplete basis', () => {
  for (const shape of ['charge', 'hold', 'insufficient_basis'] as const) {
    assert.deepEqual(buildNightChargeMessage(null, shape), {
      severity: 'info', dedupId: 'night_charge_plan', title: 'Night-charge: no plan tonight',
      body: `No overnight charge plan tonight — the panel's pool readings (capacity, state of charge, reserve) are unavailable${TAIL}`,
    });
  }
});

test('★★ a refused plan with no reason — issued before v1.196.0, or a caller that named no gate — reads as before', () => {
  const before = 'No overnight charge plan tonight — the forecast/telemetry basis is incomplete, so nothing will be charged. '
    + '(This confirms the evening job ran; the reserve floor is unchanged.)';
  const p = goldenPlan({ bandCoverageFrac: 0.72, calScoredDays: 14 });
  const { basisBlockedBy: _drop, ...older } = p;
  assert.equal(push(older as NightChargePlan).body, before);
  // The input gate with no reason given: the key is there, null — never a fabricated reason.
  const unnamed = computeNightChargePlan(inputs({ basisComplete: false }));
  assert.equal('basisBlockedBy' in unnamed, true);
  assert.equal(unnamed.basisBlockedBy, null);
  assert.equal(push(unnamed).body, before);
});

test('★★ the mid-day preview\'s "not armed" line names the gate (middayShadow read a field nothing set)', async () => {
  const refused = goldenPlan({ bandCoverageFrac: 0.72, calScoredDays: 14 });
  const r = await runMiddayShadowEvening({
    nowMs: Date.UTC(2026, 9, 15, 4, 30), day: '2026-10-14', model: buildApsREvModel(), cfg: shadowCycleConfig('cost', 90),
    mode: 'supervised', chgMaxSocPcts: [100],
    sizeLeg: async () => ({ plan: refused, windowPvP50Kwh: null, windowLoadP50Kwh: null }),
    armProbe: () => ({ armed: [], refused: [] }),
  }) as MiddayShadowRecord;
  const expected = `not armed — the plan basis is incomplete (${COVERAGE})`;
  assert.equal(r.cost!.disposition, expected);
  assert.equal(r.backup!.disposition, expected);
  // The legs keep the gate, and the mid-day "no plan" push the preview shows states it, as the
  // overnight push does (chargeText.buildMiddayPlanMessage).
  assert.equal(r.cost!.basisBlockedBy, COVERAGE);
  assert.equal(r.backup!.basisBlockedBy, COVERAGE);
  const preview = middayShadowPreview(r, buildApsREvModel())!;
  assert.equal(preview.push.title, 'Charge plan: no plan for tomorrow 10am–3pm');
  assert.equal(preview.push.body, `No charge plan for tomorrow 10am–3pm — the forecast/telemetry basis is incomplete: ${COVERAGE}${TAIL}`);
  // A complete leg carries no gate key: the record of a planned night is unchanged — even from a plan
  // object that carries a stray one (the gate is read only on a refused plan).
  const planned = await runMiddayShadowEvening({
    nowMs: Date.UTC(2026, 9, 15, 4, 30), day: '2026-10-14', model: buildApsREvModel(), cfg: shadowCycleConfig('cost', 90),
    mode: 'supervised', chgMaxSocPcts: [100],
    sizeLeg: async () => ({ plan: { ...goldenPlan({}), basisBlockedBy: COVERAGE }, windowPvP50Kwh: null, windowLoadP50Kwh: null }),
    armProbe: () => ({ armed: [], refused: [] }),
  }) as MiddayShadowRecord;
  assert.equal(planned.cost!.basisComplete, true);
  assert.equal('basisBlockedBy' in planned.cost!, false);
});
