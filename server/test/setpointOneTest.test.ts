import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNightChargePlan, buildNightChargeInputs, chargeReservePct,
  type NightChargeInputs, type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { armFromPlan, clampReserveTarget, emptyActuationState, RESERVE_WRITE_MAX_PCT } from '../src/nightChargeActuator.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';

/**
 * v1.196.0 — ONE TEST: THE OVERNIGHT WRITE SETPOINT IS THE LEG'S OWN ARM TEST.
 *
 * On the islanded-outage basis (and a disabled cushion) the overnight leg's cushion test is the
 * pack AT the window close against reserve + cushion: the outage energy lives in the line. The
 * write setpoint was solved instead on the whole-house walk from the close to the next recharge
 * (P10 PV / P90 load) against that same line — a whole day of whole-house drain AND the outage
 * cushion on top of it. On a plant whose walk falls under the line from any start the setpoint was
 * 100% on every charge night and the panel was written its 50% maximum, while the plan was sized on
 * the line (here 30.45%): ~18 kWh of pack charged above what the plan asked for, and in cost mode a
 * sub-50% cost ceiling bought past itself into the morning sun.
 *
 * The scenario: a 92.16 kWh pool, a 10% floor, a 1.445 kW islanded load × 8 h × 1.5 ÷ 0.92 =
 * 18.85 kWh cushion (the line 30.45%), 25% at 21:00, a 23:00–05:00 window, a 3.6 kW P90 house all
 * day with no sun — the walk to the next 23:00 drains ~70 kWh, more than full less the line.
 */

const H = 3_600_000;
const B = Date.UTC(2026, 9, 20, 4); // 21:00 MST, 2026-10-19
const horizon = (loadP90W: number) =>
  Array.from({ length: 30 }, (_, i) => ({ ts: B + i * H, pvP10W: 0, loadP90W, loadP50W: loadP90W / 1.35, pvP50W: 0 }));
const inputs = (o: Partial<NightChargeInputs> = {}): NightChargeInputs => ({
  nowMs: B, fullKwh: 92.16, socNowPct: 25, reserveFloorPct: 10, cushionPct: 15, socCoherent: true,
  islandedLoadKw: 1.445, outageCushionHours: 8, islandedLoadSafety: 1.5,
  legEff: 0.927, dischargeEff: 0.92, chargeCapKw: 10, gridInputCapKw: null,
  window: { startMs: B + 2 * H, endMs: B + 8 * H }, horizon: horizon(3600),
  morningPvSurplusP90Kwh: null, confidenceTier: 'forecast', basisComplete: true, minBuyKwh: 1,
  objectiveMode: 'resilience',
  ...o,
});
const plan = (o: Partial<NightChargeInputs> = {}): NightChargePlan => computeNightChargePlan(inputs(o));
const COST55 = { objectiveMode: 'cost', costMaxSocPct: 90, morningPvSurplusP50Kwh: 55, morningPvSurplusP90Kwh: 70, forceChargeEligible: true } as const;

test('★★★ THE MEASURED DEFECT: a resilience night writes its cushion line (31%), not the 50% maximum', () => {
  const p = plan();
  assert.equal(p.cushionBasis, 'islanded-outage');
  assert.equal(p.cushionKwh, 18.85, '1.445 kW × 8 h × 1.5 ÷ 0.92');
  assert.equal(p.cushionLineSocPct, 30.45);
  assert.equal(p.chargeTonight, true);
  // What the plan is sized on, unchanged: the pack at the close lifted to the line.
  assert.equal(p.targetSocPct, 30.5);
  assert.equal(p.cushionTroughSocPct, 30.45);
  assert.equal(p.buyKwh, 27.56);
  assert.equal(p.cushionShortfall, false);
  // The write: the line, to the whole percent above it (was 100, written 50).
  assert.equal(p.setpointSocPct, 31);
  assert.equal(clampReserveTarget(p.setpointSocPct!), 31);
  assert.equal(chargeReservePct(p), 31);
  assert.equal(armFromPlan(emptyActuationState(), '2026-10-19', p, B, 10)!.targetPct, 31, 'the reserve the actuator arms');
  assert.equal(p.expectedWriteLevelPct, 31);
  assert.equal(p.expectedBuyKwh, 12.22, 'the expected draw to 31% (it was 31.11 kWh, to 50%)');
  assert.match(p.rationale, / The reserve is set to 31% \(the resilience requirement\)\. /);
  assert.doesNotMatch(p.rationale, /asks for|only accepts/);
  // The premise: the whole-house walk from the arrival falls under the line (disclosed, not tested).
  assert.ok(p.minProjSocPct! < p.cushionLineSocPct!, `whole-house trough ${p.minProjSocPct}%`);
});

test('★★★ cost mode: a sub-50% cost ceiling is written as itself (40), not the 50% maximum', () => {
  const p = plan(COST55);
  assert.equal(p.costCeilingSocPct, 40.3, '92.16 − 55 kWh of morning surplus');
  assert.equal(p.targetSocPct, 40.3);
  assert.equal(p.setpointSocPct, 40.3);
  assert.equal(chargeReservePct(p), 40, 'was 50: ~8.9 kWh of pack bought past the ceiling into the morning sun');
  assert.equal(p.expectedWriteLevelPct, 40);
  assert.equal(p.buyKwh, 34.46);
  assert.doesNotMatch(p.rationale, / The reserve is set to/, 'the ask is the arrival: nothing to disclose');
});

test('★★★ cost mode, charge-rate bound: the write is the cost target (40.3), never the derated arrival (34.6)', () => {
  const p = plan({ ...COST55, chargeCapKw: 3 });
  assert.equal(p.bindingCap, 'chargePower');
  assert.equal(p.targetSocPct, 34.6, 'what 6 h at 3 kW delivers');
  assert.equal(p.setpointSocPct, 40.3);
  assert.equal(chargeReservePct(p), 40);
  // A 40.3% ask written as 40 is a whole-percent write, not the envelope: no "only accepts up to 50%".
  assert.match(p.rationale, / The reserve is set to 40% \(tonight's cost target\)\. /);
  assert.doesNotMatch(p.rationale, /only accepts|resilience requirement asks/);
});

test('★★★ cost mode with no surplus known: the 90% cost target is the ask, named as such, written 50', () => {
  const p = plan({ objectiveMode: 'cost', costMaxSocPct: 90, forceChargeEligible: true });
  assert.equal(p.costCeilingSocPct, 90);
  assert.equal(p.targetSocPct, 76.9);
  assert.equal(p.setpointSocPct, 90);
  assert.equal(chargeReservePct(p), RESERVE_WRITE_MAX_PCT);
  assert.match(p.rationale, / The reserve is set to 50% — tonight's cost target asks for 90%, but the panel only accepts a backup reserve up to 50%\. /);
  assert.doesNotMatch(p.rationale, /resilience requirement asks/);
});

test('★★★ a cushion-shortfall night writes the line (31%), above the derated arrival (28.6%)', () => {
  // A 2 kW charger delivers 6 h × 2 × 0.927 = 11.1 kWh of pack: the arrival misses the line. The
  // write is the requirement, never the arrival (v1.60.0): with full power the device reaches it.
  const p = plan({ chargeCapKw: 2 });
  assert.equal(p.cushionShortfall, true);
  assert.equal(p.bindingCap, 'chargePower');
  assert.equal(p.targetSocPct, 28.6);
  assert.equal(p.cushionTroughSocPct, 28.58);
  assert.equal(p.setpointSocPct, 31);
  assert.equal(chargeReservePct(p), 31);
  assert.match(p.rationale, / The reserve is set to 31% \(the resilience requirement\)\. /);
});

test('★★ a disabled cushion: the line is the floor, and the write is the floor (no raise)', () => {
  const p = plan({ outageCushionHours: 0 });
  assert.equal(p.cushionBasis, 'disabled');
  assert.equal(p.cushionLineSocPct, 10);
  assert.equal(p.setpointSocPct, 10);
  assert.equal(chargeReservePct(p), 10);
  assert.equal(p.expectedBuyKwh, 0, 'the grid-present panel already holds its floor');
});

test('★★★ unchanged: the legacy-pct band keeps the walk — its arm test is the walk (setpoint 100, written 50)', () => {
  const p = plan({ islandedLoadKw: null });
  assert.equal(p.cushionBasis, 'legacy-pct');
  assert.equal(p.setpointSocPct, 100);
  assert.equal(chargeReservePct(p), 50);
  assert.match(p.rationale, /the resilience requirement asks for 100%, but the panel only accepts a backup reserve up to 50%/);
});

test('★★★ unchanged: the backup leg keeps the walk its arm test is — never the derated arrival', () => {
  // A 3 kW charger cannot lift the walk to the next 23:00 (2 kW P90 all day) over the line: the
  // arrival is 38.4%, the walk asks 82.3%, and the panel is told its 50% maximum. Written on the
  // pack-at-close rule it would be the 38% arrival: a backup that stops short at full power.
  const p = plan({ windowSpec: { kind: 'overnight', role: 'backup' }, horizon: horizon(2000), chargeCapKw: 3 });
  assert.equal(p.cushionShortfall, true);
  assert.equal(p.targetSocPct, 38.4);
  assert.equal(p.setpointSocPct, 82.3);
  assert.equal(chargeReservePct(p), 50);
});

test('★★★ SWEEP: a year of overnight plans — every pack-at-close charge night writes at least min(50, its line), and never under its arrival', () => {
  let resilience = 0; let cost = 0; let ceilBinds = 0; let atMax = 0;
  for (const c of legacyIdentityCases()) {
    const p = computeNightChargePlan(buildNightChargeInputs(c.deps));
    if (!p.chargeTonight || p.setpointSocPct == null) continue;
    if (p.cushionBasis !== 'islanded-outage' && p.cushionBasis !== 'disabled') continue;
    const line = p.cushionLineSocPct!;
    const written = clampReserveTarget(p.setpointSocPct);
    assert.ok(written >= Math.min(RESERVE_WRITE_MAX_PCT, line) - 1e-9, `${c.label}: writes ${written} under its ${line}% line`);
    assert.ok(p.setpointSocPct >= p.targetSocPct!, `${c.label}: setpoint ${p.setpointSocPct} under the arrival ${p.targetSocPct}`);
    if (p.objective === 'resilience_cushion') {
      resilience++;
      // The resilience ask is the line to the whole percent above it, or the arrival where higher.
      // (cushionLineSocPct is the line to 0.01; the planner ceils the exact one.)
      if (p.setpointSocPct !== p.targetSocPct) {
        assert.ok(Number.isInteger(p.setpointSocPct) && p.setpointSocPct > p.targetSocPct!, `${c.label}: ${p.setpointSocPct}`);
        assert.ok(p.setpointSocPct >= line - 0.005 && p.setpointSocPct < line + 1.005, `${c.label}: ${p.setpointSocPct} vs line ${line}`);
      }
      if (written > RESERVE_WRITE_MAX_PCT - 1e-9) atMax++;
    } else cost++;
    // A line with a fraction under .5, and an arrival under it: Math.round alone would write under the line.
    if (line < RESERVE_WRITE_MAX_PCT && Math.round(line) < line && Math.round(p.targetSocPct!) < line) ceilBinds++;
  }
  assert.ok(resilience >= 100, `${resilience} resilience charge nights`);
  assert.ok(cost >= 300, `${cost} cost charge nights`);
  assert.ok(ceilBinds >= 5, `${ceilBinds} nights the whole-percent ask keeps above the line`);
  assert.ok(atMax < resilience / 2, `${atMax} of ${resilience} resilience nights still write the maximum`);
});
