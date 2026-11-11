import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import * as nca from '../src/nightChargeAdvisor.js';
import {
  computeNightChargePlan, buildNightChargeInputs, cushionLineKwh, outageCushionKwh, askOf, middayReentryLinePct,
  floorCushionLinePct, chargeReservePct,
  type NightChargeInputs, type NightChargeInputDeps, type NightChargePlan, type CushionPoolScale,
} from '../src/nightChargeAdvisor.js';
import { clampReserveTarget, RESERVE_WRITE_MAX_PCT } from '../src/nightChargeActuator.js';
import { runwayDrainW, runwayPoolOverheadW, runwayEnergyBasis, resetPoolEnergyBasisForTesting, RUNWAY_DISCHARGE_EFFICIENCY } from '../src/analytics.js';
import { PoolEnergyBasisTracker } from '../src/poolEnergyBasis.js';
import { OPTIONS } from '../src/config.js';
import { SHP2_SOURCE_SLOTS } from '../src/hwSpec.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { Shp2Projection } from '../src/ecoflow/project.js';
import { legacyIdentityCases, planDigest } from './fixtures/legacyIdentityFixtures.js';
import { FIGURE_FIELDS, figuresOf, MEASURED_SCALE, type Figures } from './fixtures/measuredCushionLineFigures.js';
import { STANDBY_SETS, standbyFigures, STANDBY_FIGURES_PATH } from './fixtures/cushionStandbyFigures.js';
import { withEnv } from './golden/support/env.js';

/**
 * v1.201.0 — THE ISLANDED-OUTAGE CUSHION COUNTS THE CORES' STANDBY DRAW FOR ITS HOURS.
 *
 * The cushion is the energy to carry the islanded load through the configured outage:
 * H × L × k ÷ η (outageCushionKwh), L the 7-day mean panel load. On an island the Cores' inverters form the
 * grid and their electronics draw whether or not the backup circuits load — the runway's fitted pool overhead
 * (~267 W over 30 clean pack-only spans; 270 W at the defaults for three Cores, analytics.ts). That draw never
 * appears in panel_load, so the cushion was short by it for its hours: on the reference plant 13.94 kWh lasts
 * 3.71 h of the 4 at k·L + 270 W.
 *
 * The fix (nightChargeAdvisor.ts plausibleStandbyW, cushionStandbyKwh): on the islanded-outage basis the
 * cushion is round2(H·L·k/η + H·w/1000), w the runway's figure for the connected Cores (index.ts
 * cushionStandbyOverheadW, the planner's second runway-basis door). Additive (the runway's own drain at its
 * default marginal efficiency), not × k, not ÷ η; divided by the measured capacity scale with the load leg, once.
 * Absent ⇒ v1.200.1's plan byte for byte; 0 ⇒ the same numbers and words; a figure that is no reading ⇒ the
 * same, recorded 'implausible'.
 *
 * These tests, in the plan's order (§6.4): S1 the reference plant; S2 the formula; S3 the guarantee; S4 the
 * fail-safe; S5 the monotone and ≥-w0 sets; S6 the scope and the panel-percent tripwire; S7 agreement and the
 * legs; S8 the year at (0.944, 270) and (nameplate, 270) with A's carrier invariant and the figures file; S9 the
 * parity with the runway; S10 the ledger helper (the recorder round trip is cushionStandbyLedger.test.ts);
 * S11 the plumbing.
 *
 * v1.202.0 — the plan's WALKS count the pool on the measured capacity and drain the same standby figure
 * (nightChargeAdvisor.ts plannerPoolKwh, walkStandbyW): the cushion, its line and every write pinned here are B's; the
 * kWh figures (the requirement, the buys), the arrival and a hold's no-buy setpoint are the walks', re-measured. Where w
 * rises the walks drain more: what is written, the line, the requirement, the worst-case buy and the cost ceiling still
 * never fall; a hold's setpoint (its no-buy prediction) and the expected figures may (measuredPlannerWalks.test.ts T12).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');
const CASES = legacyIdentityCases();
const caseOf = (label: string) => {
  const c = CASES.find((x) => x.label === label);
  assert.ok(c, `case ${label}`);
  return c;
};
const S944: CushionPoolScale = MEASURED_SCALE;
const MEASURED_KWH = 92.16 * 0.944; // 86.99904
const written = (p: NightChargePlan): number | null => (p.setpointSocPct != null ? clampReserveTarget(p.setpointSocPct) : null);
type StandbyPlan = NightChargePlan & { cushionStandby?: { w: number; kwh: number; basis: 'runway-overhead' | 'implausible' } };
const SB = (p: NightChargePlan): StandbyPlan => p as StandbyPlan;
/** A plan's digest without its cushionStandby key: what the plan says apart from the standby. */
const digestWithoutStandby = (p: NightChargePlan): string => {
  const { cushionStandby: _s, ...rest } = SB(p);
  return planDigest(rest as NightChargePlan);
};
/** v1.203.0 — the panel's hold point the plans below are made with: the planner's own (undefined) everywhere but the year sweeps of
 *  S5–S8, which measure the standby's effect and keep their v1.202.0 counts on the planner with no hold point (onV1202: 0). The +1
 *  itself is accounted on the same year, scales, figures and modes by reserveHoldPoint.test.ts, and in the figures regenerated for
 *  it (S8 case by case). */
let HOLD: number | undefined;
/** Run `f` on the planner with no hold point (v1.202.0's lines), restoring the planner's own after. */
const onV1202 = (f: () => void): void => { HOLD = 0; try { f(); } finally { HOLD = undefined; } };
/** A year case planned with an optional scale, standby figure and line force-charge eligibility. */
const yearPlan = (deps: NightChargeInputDeps, scale?: CushionPoolScale | null, w?: unknown, line?: boolean): StandbyPlan =>
  SB(computeNightChargePlan(buildNightChargeInputs({
    ...deps,
    ...(scale != null ? { cushionPoolScale: scale } : {}),
    ...(w !== undefined ? { cushionStandbyW: w } : {}),
    ...(line !== undefined ? { lineForceChargeEligible: line } : {}),
  } as NightChargeInputDeps), ...(HOLD !== undefined ? [HOLD] : [])));

/** measuredCushionLine.test.ts's scenario: a 92.16 kWh pool, a 10% floor, 1.445 kW × 8 h × 1.5 ÷ 0.92 =
 *  18.85 kWh of cushion, 25% at 21:00, a 23:00–05:00 window, a 3.6 kW P90 house and no sun. */
const H = 3_600_000;
const B = Date.UTC(2026, 9, 20, 4); // 21:00 MST, 2026-10-19
const horizon = (loadP90W: number) =>
  Array.from({ length: 30 }, (_, i) => ({ ts: B + i * H, pvP10W: 0, loadP90W, loadP50W: loadP90W / 1.35, pvP50W: 0 }));
const inputs = (o: Partial<NightChargeInputs> & { cushionStandbyW?: unknown } = {}): NightChargeInputs => ({
  nowMs: B, fullKwh: 92.16, socNowPct: 25, reserveFloorPct: 10, cushionPct: 15, socCoherent: true,
  islandedLoadKw: 1.445, outageCushionHours: 8, islandedLoadSafety: 1.5,
  legEff: 0.927, dischargeEff: 0.92, chargeCapKw: 10, gridInputCapKw: null,
  window: { startMs: B + 2 * H, endMs: B + 8 * H }, horizon: horizon(3600),
  morningPvSurplusP90Kwh: null, confidenceTier: 'forecast', basisComplete: true, minBuyKwh: 1,
  objectiveMode: 'resilience',
  ...o,
} as NightChargeInputs);
const plan = (o: Partial<NightChargeInputs> & { cushionStandbyW?: unknown } = {}): StandbyPlan => SB(computeNightChargePlan(inputs(o), ...(HOLD !== undefined ? [HOLD] : [])));
const COST55 = { objectiveMode: 'cost', costMaxSocPct: 90, morningPvSurplusP50Kwh: 55, morningPvSurplusP90Kwh: 70, forceChargeEligible: true } as const;

/* ══ S1 — the reference plant ═════════════════════════════════════════════════ */

// v1.203.0 — every write below that was the line's whole percent is that and one point more: the panel holds the pool one point under
// a reserve it charged up to (PANEL_RESERVE_HOLD_UNDERSHOOT_PCT), so the pool it holds is the line's whole percent.
test('★★★ S1 THE REFERENCE PLANT: 2026-10-12 resilience at ×0.944 with 270 W — cushion 13.94 → 15.02, line 32.02 → 33.26, written 34 → 35 (v1.203.0: the panel\'s point)', () => {
  const deps = caseOf('2026-10-12 resilience').deps;
  const before = yearPlan(deps, S944);
  assert.deepEqual([before.cushionKwh, before.cushionLineSocPct, written(before)], [13.94, 32.02, 34]);
  // v1.202.0 — on the measured pool (v1.201.0's walks on nameplate: 23.38 and 25.22 kWh).
  assert.deepEqual([before.requiredExtraKwh, before.buyKwh, before.targetSocPct], [24.25, 26.16, 32]);
  assert.equal('cushionStandby' in before, false);

  const p = yearPlan(deps, S944, 270);
  // 13.94 + 4 h × 0.27 kW = 15.02 kWh: the runway's figure for its hours, added — not × 1.25, not ÷ 0.94.
  assert.deepEqual(p.cushionStandby, { w: 270, kwh: 1.08, basis: 'runway-overhead' });
  assert.equal(p.cushionKwh, 15.02);
  // The line: 16 + 100 × 15.02 ÷ (92.16 × 0.944) = 16 + 1502 ÷ 86.99904 = 33.2647%.
  assert.equal(p.cushionLineSocPct, 33.26);
  assert.equal(p.setpointSocPct, 35);
  assert.equal(written(p), 35);
  assert.equal(chargeReservePct(p), 35);
  assert.equal(floorCushionLinePct(p), 33.26, 'every surface states the one line');
  // v1.202.0 — the walks drain the 270 W too, on the measured pool (v1.201.0: 24.3 and 26.22 kWh). v1.203.0 — what is sized does not
  // move; the expected walk runs to the 35% write.
  assert.deepEqual([p.requiredExtraKwh, p.buyKwh, p.targetSocPct, p.expectedWriteLevelPct], [26.42, 28.5, 33.3, 35]);
  assert.equal(p.cushionShortfall, false);
  // The pool the panel holds under the 35% write, 34%, holds the whole cushion on the measured capacity: (34 − 16)% × 86.999 =
  // 15.66 ≥ 15.02 kWh, 4.17 h at k·L + 270 W = 2.62 × 1.25 ÷ 0.94 + 0.27 = 3.754 kW. v1.202.0's 34% write held 33%: 17% × 86.999 =
  // 14.79 kWh, 3.94 h — under the cushion it was sized on, as the 08-31…09-17 charge-ups closed (11 of 11 at R − 1).
  const drainKw = (2.62 * 1.25) / 0.94 + 0.27;
  const held = ((35 - 1 - 16) / 100) * MEASURED_KWH;
  const heldBefore = ((34 - 1 - 16) / 100) * MEASURED_KWH;
  assert.ok(held >= 15.02 && heldBefore < 15.02, `${held} / ${heldBefore}`);
  assert.deepEqual([Math.round((held / drainKw) * 100) / 100, Math.round((heldBefore / drainKw) * 100) / 100], [4.17, 3.94]);
  // The rationale states the figure as the runway's, as part of what the line is sized on (R6) — as printed.
  assert.ok(p.rationale.includes("the 16% reserve floor plus 4 h of islanded backup load (15 kWh, 1.1 kWh of it the runway's 270 W standby figure, 17.3% of the packs' measured capacity at ×0.944 of nameplate)"), p.rationale);
  assert.match(p.rationale, / The reserve is set to 35% \(the resilience requirement: one point above the 33\.26% outage line's whole percent, since the panel holds the pool one point under a reserve it charges up to\)\. /);

  // On nameplate (the live basis while no pack ratio has been measured): 31.13 → 32.30, written 33 → 34 (v1.203.0: 32 → 33 before).
  const np0 = yearPlan(deps);
  const np = yearPlan(deps, null, 270);
  assert.deepEqual([np0.cushionLineSocPct, written(np0)], [31.13, 33]);
  assert.deepEqual([np.cushionKwh, np.cushionLineSocPct, written(np)], [15.02, 32.3, 34]);
  assert.ok(np.rationale.includes("plus 4 h of islanded backup load (15 kWh, 1.1 kWh of it the runway's 270 W standby figure)"), np.rationale);
  assert.doesNotMatch(np.rationale, /measured capacity/);
});

/* ══ S2 — the formula ═════════════════════════════════════════════════════════ */

test('★★★ S2 THE FORMULA: additive, not × k (15.29 ruled out), not ÷ η (15.09 ruled out); the runway\'s own drain at its default marginal efficiency', () => {
  const { cushionStandbyKwh, plausibleStandbyW } = nca as unknown as Record<string, (...a: unknown[]) => unknown>;
  assert.equal(typeof cushionStandbyKwh, 'function');
  assert.deepEqual(cushionStandbyKwh({ cushionBasis: 'islanded-outage', outageHours: 4, standby: plausibleStandbyW(270) }),
    { w: 270, kwh: 1.08, basis: 'runway-overhead' });
  assert.deepEqual(cushionStandbyKwh({ cushionBasis: 'islanded-outage', outageHours: 8, standby: plausibleStandbyW(270) }),
    { w: 270, kwh: 2.16, basis: 'runway-overhead' });
  for (const basis of ['legacy-pct', 'disabled'] as const) {
    assert.equal(cushionStandbyKwh({ cushionBasis: basis, outageHours: 4, standby: plausibleStandbyW(270) }), null, basis);
  }
  assert.equal(cushionStandbyKwh({ cushionBasis: 'islanded-outage', outageHours: 4, standby: null }), null);
  // The reference: 13.94 + 1.08 = 15.02. k on the overhead would be 13.94 + 1.35 = 15.29; ÷ η 13.94 + 1.149 = 15.09.
  const p = yearPlan(caseOf('2026-10-12 resilience').deps, S944, 270);
  assert.equal(p.cushionKwh, 15.02);
  assert.notEqual(p.cushionKwh, 15.29);
  assert.notEqual(p.cushionKwh, 15.09);
  // The runway's drain, runwayDrainW(load, O) = max(load ÷ 0.94, O + load ÷ η_m): at η_m = 0.94 the cushion is
  // H × that drain at the safety-factored load, to its two roundings (≤ 0.01 kWh).
  assert.equal(RUNWAY_DISCHARGE_EFFICIENCY, 0.94);
  let n = 0;
  for (const L of [0.4, 1.1, 2.62, 3.3, 5]) {
    for (const hours of [1, 4, 8, 12]) {
      for (const O of [0, 90, 270, 517.5, 1500]) {
        const c = outageCushionKwh({ islandedLoadKw: L, outageHours: hours, safetyFactor: 1.25, dischargeEff: 0.94, legacyCushionKwh: 9 });
        const s = cushionStandbyKwh({ cushionBasis: c.basis, outageHours: hours, standby: plausibleStandbyW(O) }) as { kwh: number };
        const total = Math.round((c.kwh + s.kwh) * 100) / 100;
        const runway = (hours * runwayDrainW(1.25 * L * 1000, O, 0.94)) / 1000;
        assert.ok(Math.abs(total - runway) <= 0.01 + 1e-9, `L ${L} H ${hours} O ${O}: ${total} vs ${runway}`);
        n += 1;
      }
    }
  }
  assert.equal(n, 100);
});

/* ══ S3 — the guarantee ═══════════════════════════════════════════════════════ */

test('★★★ S3 THE GUARANTEE (property): wherever the write is under the 50% envelope, (written − floor)% of the measured capacity ≥ H·(k·L/η + O/1000) − 0.005', () => {
  const { cushionStandbyKwh, plausibleStandbyW } = nca as unknown as Record<string, (...a: unknown[]) => { kwh: number; basis: string } | null>;
  let checked = 0;
  let truncated = 0;
  for (const N of [30.72, 61.44, 92.16, 122.88]) {
    for (const floor of [10, 16, 22, 30]) {
      for (const L of [0.35, 0.9, 1.6, 2.62, 3.7, 5]) {
        for (const hours of [1, 2, 4, 8, 12]) {
          for (const O of [0, 45, 270, 333.3, 900, 1500]) {
            for (const s of [0.5, 0.63, 0.8, 0.9, 0.944, 1]) {
              const c = outageCushionKwh({ islandedLoadKw: L, outageHours: hours, safetyFactor: 1.25, dischargeEff: 0.94, legacyCushionKwh: 0 });
              const sb = cushionStandbyKwh({ cushionBasis: c.basis, outageHours: hours, standby: plausibleStandbyW(O) })!;
              const cushionKwh = Math.round((c.kwh + sb.kwh) * 100) / 100;
              const line = cushionLineKwh({ reserveKwh: (N * floor) / 100, cushionKwh, cushionBasis: c.basis, poolScale: { scale: s, basis: 'measured' } });
              const w = clampReserveTarget(askOf(line.kwh, N)); // the planner's lineAskPct, as the actuator writes it
              if (w >= RESERVE_WRITE_MAX_PCT && (line.kwh / N) * 100 > RESERVE_WRITE_MAX_PCT) { truncated += 1; continue; }
              const held = ((w - floor) / 100) * N * s;
              const need = hours * ((L * 1.25) / 0.94 + O / 1000);
              assert.ok(held >= need - 0.005, `N ${N} f ${floor} L ${L} H ${hours} O ${O} s ${s}: written ${w} holds ${held} of ${need}`);
              checked += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 10_000 && truncated > 5_000, `${checked} checked, ${truncated} over the envelope`);
  // …and on every islanded charge night of the year at (0.944, 270) written under the envelope.
  let n = 0;
  for (const c of CASES) {
    const p = yearPlan(c.deps, S944, 270);
    if (p.cushionBasis !== 'islanded-outage' || !p.chargeTonight || written(p)! >= RESERVE_WRITE_MAX_PCT) continue;
    const need = (c.deps.outageCushionHours ?? 4) * ((c.deps.islandedLoadKw! * 1.25) / 0.94 + 0.27);
    const atScale = ((written(p)! - p.reserveFloorPct) / 100) * c.deps.fullKwh * 0.944;
    assert.ok(atScale >= need - 0.005, `${c.label}: written ${written(p)} holds ${atScale} of ${need}`);
    n += 1;
  }
  assert.ok(n >= 150, `${n} nights`);
});

/* ══ S4 — the fail-safe (I-B0) ════════════════════════════════════════════════ */

test('★★★ S4 FAIL-SAFE — absent (undefined, null) is v1.200.1\'s plan byte for byte, with no new key', () => {
  for (const [label, scale] of [['2026-10-12 resilience', S944], ['2026-10-12 resilience', null], ['2027-01-04 21:30', S944]] as const) {
    const base = yearPlan(caseOf(label).deps, scale);
    assert.equal('cushionStandby' in base, false);
    for (const w of [undefined, null]) {
      const p = yearPlan(caseOf(label).deps, scale, w);
      assert.equal(planDigest(p), planDigest(base), `${label} ${w}`);
      assert.equal('cushionStandby' in p, false);
    }
  }
});

test('★★★ S4 FAIL-SAFE — 0 W moves no number and no word (the key says 0); NaN, ±∞, −1, 1500.001, 1e6 and \'270\' are no reading: today\'s plan, recorded \'implausible\'', () => {
  const REJECTED: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -1e-9, 1500.001, 1e6, '270', { w: 270 }, true];
  for (const scale of [S944, null]) {
    for (const c of CASES) {
      const base = yearPlan(c.deps, scale);
      const islanded = base.cushionBasis === 'islanded-outage';
      const zero = yearPlan(c.deps, scale, 0);
      assert.equal(digestWithoutStandby(zero), planDigest(base), `${c.label}: 0 W moved the plan`);
      if (islanded) assert.deepEqual(zero.cushionStandby, { w: 0, kwh: 0, basis: 'runway-overhead' });
      else assert.equal('cushionStandby' in zero, false, `${c.label}: a key off the islanded-outage basis`);
      for (const w of c.label.endsWith('21:30') ? REJECTED : [Number.NaN, 1e6, '270']) {
        const p = yearPlan(c.deps, scale, w);
        assert.equal(digestWithoutStandby(p), planDigest(base), `${c.label} ${String(w)}: the plan moved`);
        if (islanded) assert.deepEqual(p.cushionStandby, { w: 0, kwh: 0, basis: 'implausible' }, `${c.label} ${String(w)}`);
        else assert.equal('cushionStandby' in p, false);
      }
    }
  }
  // 1500 W is accepted (the options' own upper clamp), and a hair above it is float noise.
  const deps = caseOf('2026-10-12 resilience').deps;
  assert.deepEqual(yearPlan(deps, S944, 1500).cushionStandby, { w: 1500, kwh: 6, basis: 'runway-overhead' });
  assert.equal(yearPlan(deps, S944, 1500 + 1e-10).cushionStandby?.basis, 'runway-overhead');
  assert.equal((nca as unknown as Record<string, number>).CUSHION_STANDBY_PLAUSIBLE_MAX_W, 1500);
});

/* ══ S5 — the monotone set and the ≥-w0 set (I-B2) ════════════════════════════ */

/** Measured when the change was made (v1.201.0): the expected buy is not monotone in w (a higher write starts the
 *  just-in-time force-charge earlier, from a level that draws less) — 2027-08-09 13:00 at 0.944. */
const PIN_S5_FALL = { label: '2027-08-09 13:00', from: 570, to: 600, expected: [0.19, 0.02] }; // v1.202.0 (v1.201.0: 3.43 → 3.27)
const STEPS_30 = Array.from({ length: 51 }, (_, i) => i * 30);
const S075: CushionPoolScale = Object.freeze({ scale: 0.75, basis: 'measured' }) as CushionPoolScale;
const scaleTag = (s: CushionPoolScale | null): string => (s == null ? 'np' : s.scale === 0.944 ? 'm' : `s${s.scale}`);

/**
 * The I-B2 sweep: every islanded-outage case at w = 0…1500 W in 30 W steps, per scale. HARD, on every step: the
 * monotone set (line, setpoint, requirement, worst-case buy, cost ceiling) never falls as w rises, nor the write,
 * no charge night holds, no disclosed shortfall vanishes — except where v1.200.0's line walk, not monotone in the ask,
 * closes a night it disclosed 'closeUnder' at or above its higher line (carried, A5's own rule) — and no figure the
 * w = 0 plan lacks appears (a hold that charges aside). RETURNED: the ≥-w0 set's falls below the w = 0 plan (expected
 * buy, its write level, target SoC and the rest of the set), as `label|scale|w|field`, and those re-carried nights,
 * as `label|scale|w`, for the caller to pin.
 * v1.202.0 — the walks drain the same w (walkStandbyW), so a HOLD's setpoint (its no-buy prediction at the close) falls
 * as w rises, and the arrival (target SoC), the expected buy and its write level are disclosures that may fall below the
 * w = 0 plan: the setpoint is in the monotone set on charge nights only (I-C4, over what is written), and the ≥-w0 set's
 * falls of those disclosures are counted by field (`softUnderW0`), the rest returned as before (`underW0`).
 */
function sweepW(
  cases: ReadonlyArray<{ label: string; deps: NightChargeInputDeps }>,
  scales: ReadonlyArray<CushionPoolScale | null>,
  o: { line?: boolean; steps?: readonly number[]; deps?: (d: NightChargeInputDeps) => NightChargeInputDeps; only?: (zero: StandbyPlan, top: StandbyPlan) => boolean } = {},
): { plans: number; underW0: string[]; softUnderW0: Record<string, number>; holdSetpointFalls: number; expectedFalls: number; crossings: number; reCarried: string[] } {
  const steps = o.steps ?? STEPS_30;
  const atLeast = ['cushionLineSocPct', 'setpointSocPct', 'buyKwh', 'buyKwhDebiased', 'requiredExtraKwh', 'expectedBuyKwh',
    'expectedWriteLevelPct', 'costCeilingSocPct', 'targetSocPct'] as const;
  /** v1.202.0 — disclosures the walks' standby moves: counted below the w = 0 plan, not returned one by one. */
  const soft = new Set<string>(['expectedBuyKwh', 'expectedWriteLevelPct', 'targetSocPct']);
  const monotone = ['cushionLineSocPct', 'setpointSocPct', 'requiredExtraKwh', 'buyKwh', 'costCeilingSocPct'] as const;
  const out = { plans: 0, underW0: [] as string[], softUnderW0: {} as Record<string, number>, holdSetpointFalls: 0, expectedFalls: 0, crossings: 0, reCarried: [] as string[] };
  for (const c of cases) {
    const deps = o.deps ? o.deps(c.deps) : c.deps;
    for (const scale of scales) {
      const tag = `${c.label}|${scaleTag(scale)}`;
      const zero = yearPlan(deps, scale, 0, o.line);
      if (zero.cushionBasis !== 'islanded-outage') continue;
      if (o.only && !o.only(zero, yearPlan(deps, scale, steps[steps.length - 1], o.line))) continue;
      let prev = zero;
      for (const w of steps.slice(1)) {
        const p = yearPlan(deps, scale, w, o.line);
        out.plans += 1;
        const holdToCharge = !zero.chargeTonight && p.chargeTonight;
        for (const f of atLeast) {
          const a = zero[f] as number | null | undefined, b = p[f] as number | null | undefined;
          if (a == null) { if (!holdToCharge) assert.equal(b ?? null, null, `${tag} w ${w}: ${f} appeared`); continue; }
          if (b != null && b >= a - 1e-9) continue;
          // v1.202.0 — a hold's setpoint is its no-buy prediction (counted with the hold falls below); the disclosures, by field.
          if (f === 'setpointSocPct' && !(zero.chargeTonight && p.chargeTonight)) continue;
          if (soft.has(f)) out.softUnderW0[f] = (out.softUnderW0[f] ?? 0) + 1;
          else out.underW0.push(`${tag}|${w}|${f}`);
        }
        for (const f of monotone) {
          const a = prev[f] as number | null | undefined, b = p[f] as number | null | undefined;
          if (a == null) continue;
          // v1.202.0 — the setpoint over what is written: a hold's (its no-buy prediction) falls with the walks' drain.
          if (f === 'setpointSocPct' && !(prev.chargeTonight && p.chargeTonight)) {
            if (b != null && b < a - 1e-9) out.holdSetpointFalls += 1;
            continue;
          }
          assert.ok(b != null && b >= a - 1e-9, `${tag} w ${w}: ${f} fell ${a} → ${b} as w rose`);
        }
        const wa = written(prev), wb = written(p);
        if (prev.chargeTonight && p.chargeTonight && wa != null) assert.ok(wb! >= wa, `${tag} w ${w}: write ${wa} → ${wb}`);
        assert.ok(!(prev.chargeTonight && !p.chargeTonight), `${tag} w ${w}: a charge night became a hold (buy ${prev.buyKwh} → ${p.buyKwh}, line ${prev.cushionLineSocPct} → ${p.cushionLineSocPct})`);
        const q = p as StandbyPlan & { forceChargeLine?: unknown; cushionShortfallCause?: unknown };
        const reCarried = (prev as StandbyPlan & { cushionEnvelopeReason?: unknown }).cushionEnvelopeReason === 'closeUnder'
          && q.forceChargeLine != null && q.cushionShortfallCause == null && p.expectedWriteLevelPct! >= p.cushionLineSocPct! - 0.05;
        if (prev.cushionShortfall && !p.cushionShortfall) {
          assert.ok(reCarried, `${tag} w ${w}: a disclosed shortfall vanished`);
          out.reCarried.push(`${tag}|${w}`);
        }
        if (prev.expectedBuyKwh != null && p.expectedBuyKwh != null && p.expectedBuyKwh < prev.expectedBuyKwh - 1e-9) out.expectedFalls += 1;
        if (prev.cushionLineSocPct! <= 100 && p.cushionLineSocPct! > 100) out.crossings += 1;
        prev = p;
      }
    }
  }
  return out;
}

test('★★★ S5 MONOTONE — on the year, w = 0…1500 in 30 W steps on both bases: line, setpoint, write, requirement, worst-case buy and cost ceiling never fall as w rises; expected buy, write level and target SoC never fall below the w = 0 plan', () => {
  // v1.203.0 — on the planner with no hold point: this test measures the standby's effect (see HOLD).
  onV1202(() => {
  const out = sweepW(CASES, [null, S944]);
  assert.ok(out.plans > 70_000, `${out.plans} plans`);
  assert.deepEqual(out.underW0, [], 'nothing under the w = 0 plan (no line force-charge eligibility passed)');
  assert.deepEqual(out.reCarried, [], 'no disclosed shortfall vanishes');
  assert.ok(out.expectedFalls > 0, 'the expected buy is not monotone in w: the set it is held in is ≥ the w = 0 plan');
  // v1.202.0 — the walks drain w too: a hold's no-buy setpoint falls as w rises, and the arrival and the expected buy can
  // fall below the w = 0 plan (disclosures). What is written and sized does not (the monotone set, asserted in the sweep).
  assert.deepEqual([out.softUnderW0, out.holdSetpointFalls], [{ targetSocPct: 17_752, expectedBuyKwh: 366 }, 6416]);
  // The example (critique B R2): 0.19 → 0.02 kWh from 570 to 600 W (v1.201.0: 3.43 → 3.27), while the line, setpoint and buy rise.
  const deps = caseOf(PIN_S5_FALL.label).deps;
  const a = yearPlan(deps, S944, PIN_S5_FALL.from), b = yearPlan(deps, S944, PIN_S5_FALL.to);
  assert.deepEqual([a.expectedBuyKwh, b.expectedBuyKwh], PIN_S5_FALL.expected);
  assert.ok(b.cushionLineSocPct! > a.cushionLineSocPct! && b.buyKwh! >= a.buyKwh!);
  assert.ok(b.expectedBuyKwh! >= yearPlan(deps, S944, 0).expectedBuyKwh!, 'never under the w = 0 plan');
  });
});

/** v1.202.0 — re-measured with the walks on the measured pool and draining w (the figures below are v1.202.0's; the
 *  v1.201.0 account follows). Measured on v1.200.1 (v1.201.0), with lineForceChargeEligible true (a write mode; index.ts passes it on every live
 *  leg): the ≥-w0 set's falls on the S5 sweep — the expected write level of the carried 2027-01-04 line nights at
 *  0.944 from 1050 W (78.4% at 0 W; 78.3% at 1050 W, 77.5% at 1500 W), and of the disclosed 2027-01-12 +1 01:30 night
 *  (an EV, the caps note at every figure) from 570 W on nameplate and 390 W at 0.944, where its line comes within 10
 *  points of the 70% cost ceiling: the line force-charge takes over from the cost force-charge, and the level stated
 *  goes from the cost ceiling (70%) to the close its line walk expects (50%), the expected buy unchanged (35.34 kWh).
 *  And with the year's 4 h cases at 8, 12, 14 and 16 h at 270 W: the plans whose expected buy or write level falls
 *  below the 0 W plan, and the armed lines the standby disarms — none (v1.200.0 arms a line whatever its ask). */
const PIN_S5_LINE = {
  labels: ['2027-01-04 21:30', '2027-01-04 13:00'], fromW: 1050, levels: [80, 76.8, 74.9], swept: [2391, 17_900],
  handOff: { label: '2027-01-12 +1 01:30', fromW: { np: 570, m: 390 }, levels: [70, 50], expectedBuyKwh: 35.34 },
  hours: { 8: { m: [30, 0], np: [23, 0] }, 12: { m: [57, 0], np: [52, 0] }, 14: { m: [81, 0], np: [66, 0] }, 16: { m: [106, 0], np: [88, 0] } } as Record<number, Record<'m' | 'np', [number, number]>>,
  example8: { label: '2027-04-13 21:30', expectedBuyKwh: [38.5, 44.33], expectedWriteLevelPct: [72.3, 79.1] },
  example16: { label: '2026-10-26 21:30', expectedBuyKwh: [56.29, 56.29], expectedWriteLevelPct: [96.5, 97] },
  /** v1.202.0 — the ≥-w0 set's disclosure falls with the walks draining w, the holds' setpoint falls, and the one night A's
   *  re-ON walk re-carries as w rises (the critique's claim flip in a write mode; measuredPlannerWalks.test.ts T12). */
  soft: { targetSocPct: 3110, expectedWriteLevelPct: 434, expectedBuyKwh: 52 }, holdSetpointFalls: 336, reCarried: ['2026-10-13 13:00|m|420'],
};

test('★★★ S5 LINE NIGHTS — with line force-charge eligibility (a write mode) the monotone set holds as w rises; the expected buy and its write level are ≥ the w = 0 plan except on carried line nights, as measured', () => {
  // v1.203.0 — on the planner with no hold point: this test measures the standby's effect (see HOLD).
  onV1202(() => {
  // Eligibility moves only a plan whose line is above the envelope (carried or disclosed): every other plan is the
  // S5 plan byte for byte (I-A0 / I-A1), checked here at both ends of the sweep. A line that qualifies at some figure
  // qualifies at 1500 W (the line only rises, no charge night holds), so the sweep takes the cases that do.
  const onLine = (p: StandbyPlan): boolean => {
    const q = p as StandbyPlan & { forceChargeLine?: unknown; cushionEnvelopeReason?: unknown };
    return q.forceChargeLine != null || q.cushionEnvelopeReason != null;
  };
  let offLine = 0;
  for (const c of CASES) {
    for (const scale of [null, S944]) {
      for (const w of [0, 1500]) {
        const p = yearPlan(c.deps, scale, w, true);
        if (p.cushionBasis !== 'islanded-outage' || onLine(p)) continue;
        assert.equal(planDigest(p), planDigest(yearPlan(c.deps, scale, w)), `${c.label} ${scaleTag(scale)} ${w} W: eligibility moved a plan off the line`);
        offLine += 1;
      }
    }
  }
  const out = sweepW(CASES, [null, S944], { line: true, only: (zero, top) => onLine(zero) || onLine(top) });
  assert.deepEqual([offLine, out.plans], PIN_S5_LINE.swept, '[plans off the line, checked identical; line-night plans swept]');
  const ho = PIN_S5_LINE.handOff;
  // v1.202.0 — the expected write level is a disclosure the walks' drain moves (counted in softUnderW0, with the carried
  // 2027-01-04 nights and the 2027-01-12 hand-off among them); nothing else of the ≥-w0 set falls under the w = 0 plan.
  assert.deepEqual(out.underW0, [], 'the ≥-w0 set under the w = 0 plan, the disclosures aside');
  assert.deepEqual([out.softUnderW0, out.holdSetpointFalls], [PIN_S5_LINE.soft, PIN_S5_LINE.holdSetpointFalls]);
  assert.deepEqual(out.reCarried, PIN_S5_LINE.reCarried, 'the one disclosed night a higher w re-carries (A\'s re-ON walk)');
  for (const [s, scale] of [['np', null], ['m', S944]] as const) {
    const [x, y] = [ho.fromW[s] - 30, ho.fromW[s]].map((w) => yearPlan(caseOf(ho.label).deps, scale, w, true) as StandbyPlan & { expectedForceChargeMode?: unknown });
    assert.deepEqual([x.expectedWriteLevelPct, y.expectedWriteLevelPct], ho.levels, `${s}: the level stated`);
    assert.deepEqual([x.expectedBuyKwh, y.expectedBuyKwh, x.cushionShortfall, y.cushionShortfall], [ho.expectedBuyKwh, ho.expectedBuyKwh, true, true], `${s}: the same energy, disclosed`);
    assert.deepEqual([x.expectedForceChargeMode ?? null, y.expectedForceChargeMode], [null, 'line'], `${s}: the cost force-charge, then the line's`);
  }
  const deps = caseOf(PIN_S5_LINE.labels[0]).deps;
  const [z, a, b] = [0, PIN_S5_LINE.fromW, 1500].map((w) => yearPlan(deps, S944, w, true) as StandbyPlan & { forceChargeLine?: unknown });
  assert.deepEqual([z, a, b].map((p) => p.expectedWriteLevelPct), PIN_S5_LINE.levels);
  assert.ok([z, a, b].every((p) => p.forceChargeLine != null), 'carried by the line force-charge at every figure');
  assert.ok(b.cushionLineSocPct! > z.cushionLineSocPct! && written(b)! >= written(z)! && b.buyKwh! >= z.buyKwh!, 'the line, write and buy rise');

  // Longer cushions at 270 W on the 4 h cases: the run-to-close walk is not monotone in the ask; an armed line stays
  // armed at any ask (A5), disclosed 'nearFull' within 10 points of full. The sizing figures and the write never fall.
  for (const [H, byScale] of Object.entries(PIN_S5_LINE.hours)) {
    for (const [name, scale] of [['m', S944], ['np', null]] as const) {
      let fell = 0, dropped = 0;
      for (const c of CASES) {
        if ((c.deps.outageCushionHours ?? 4) !== 4) continue;
        const d = { ...c.deps, outageCushionHours: Number(H) };
        const b0 = yearPlan(d, scale, undefined, true) as StandbyPlan & { forceChargeLine?: unknown; cushionEnvelopeReason?: unknown };
        if (b0.cushionBasis !== 'islanded-outage') continue;
        const p = yearPlan(d, scale, 270, true) as StandbyPlan & { forceChargeLine?: unknown; cushionEnvelopeReason?: unknown };
        for (const f of ['cushionLineSocPct', 'setpointSocPct', 'requiredExtraKwh', 'buyKwh', 'costCeilingSocPct'] as const) {
          // v1.202.0 — the setpoint over what is written: a hold's is its no-buy prediction, which the walks' drain lowers.
          if (f === 'setpointSocPct' && !(b0.chargeTonight && p.chargeTonight)) continue;
          const x = b0[f] as number | null | undefined, y = p[f] as number | null | undefined;
          if (x != null) assert.ok(y != null && y >= x - 1e-9, `${c.label} ${H} h ${name}: ${f} fell ${x} → ${y}`);
        }
        if (b0.chargeTonight) assert.ok(p.chargeTonight && written(p)! >= written(b0)!, `${c.label} ${H} h ${name}: the write`);
        if ((['expectedBuyKwh', 'expectedWriteLevelPct'] as const).some((f) => b0[f] != null && !(p[f] != null && p[f]! >= b0[f]! - 1e-9))) fell += 1;
        if (b0.forceChargeLine != null && p.forceChargeLine == null) dropped += 1;
        // v1.202.0 — a night the cost force-charge carries closes where its walk past the stop ends (expectedCloseAfterStopPct).
        const closeOf = (p as StandbyPlan & { expectedCloseAfterStopPct?: number }).expectedCloseAfterStopPct ?? p.expectedWriteLevelPct!;
        if ((p.forceChargeLine != null || p.cushionEnvelopeReason != null) && closeOf < p.cushionLineSocPct! - 0.05 - 1e-9) {
          assert.equal(p.cushionShortfall, true, `${c.label} ${H} h ${name}: a line night under its line, undisclosed`);
        }
      }
      assert.deepEqual([fell, dropped], byScale[name], `${H} h ${name}: [under the 0 W plan, armed lines disarmed]`);
    }
  }
  const e8 = caseOf(PIN_S5_LINE.example8.label).deps;
  const [x8, y8] = [undefined, 270].map((w) => yearPlan({ ...e8, outageCushionHours: 8 }, S944, w, true) as StandbyPlan & { forceChargeLine?: unknown });
  assert.deepEqual([x8.expectedBuyKwh, y8.expectedBuyKwh], PIN_S5_LINE.example8.expectedBuyKwh);
  assert.deepEqual([x8.expectedWriteLevelPct, y8.expectedWriteLevelPct], PIN_S5_LINE.example8.expectedWriteLevelPct);
  assert.ok(x8.forceChargeLine != null && y8.forceChargeLine != null, 'carried at both figures');
  const e16 = caseOf(PIN_S5_LINE.example16.label).deps;
  const [x16, y16] = [undefined, 270].map((w) => yearPlan({ ...e16, outageCushionHours: 16 }, null, w, true) as StandbyPlan & { forceChargeLine?: unknown; cushionEnvelopeReason?: unknown });
  assert.deepEqual([x16.expectedBuyKwh, y16.expectedBuyKwh], PIN_S5_LINE.example16.expectedBuyKwh);
  assert.deepEqual([x16.expectedWriteLevelPct, y16.expectedWriteLevelPct], PIN_S5_LINE.example16.expectedWriteLevelPct);
  assert.deepEqual([x16.forceChargeLine != null, y16.forceChargeLine != null, x16.cushionEnvelopeReason ?? null, y16.cushionEnvelopeReason], [true, true, null, 'nearFull'], 'still armed past an ask of 90, and disclosed');
  });
});

/** Measured (v1.201.0 review): where the standby lifts the line past 100% of the pool. v1.202.0 — re-measured with the
 *  walks on the pool and draining w (v1.201.0's figure in a comment where it moved). */
const PIN_S5_CLIFF = {
  // 2027-02-09 21:30 at 12 h on ×0.75: [line, requirement, worst-case buy, target, shortfall] at 560 and 570 W (560 W:
  // 84.67 and 91.3 kWh in v1.201.0).
  a: { label: '2027-02-09 21:30', hours: 12, at560: [99.98, 85.09, 91.75, 100, false], at570: [100.15, 99.04, 106.8, 100, true] },
  // 2027-02-01 21:30 at 47.65 h on ×0.944, a 40 kWh minimum buy: [charge, buy, requirement, written] at 0 and 270 W (0 W:
  // 42.04 and 38.98 kWh in v1.201.0).
  b: { label: '2027-02-01 21:30', hours: 47.65, minBuyKwh: 40, at0: [true, 42.47, 39.38, 50], at270: [true, 84.88, 78.71, 50] },
  // 2027-02-09 21:30 at 14 h on ×0.75, unmeetable at 0 W: v1.200.1's proxy [requirement, buy, target] — on the measured
  // pool (61.27, 66.06, 94.6 on v1.201.0's walks) — then full effort.
  c: { label: '2027-02-09 21:30', hours: 14, proxy: [50.67, 54.64, 91.2], full: [99.04, 106.8, 100] },
  // (d) [crossings, plans] over 12/20/30 h × three scales, and with eligibility at 20 h; there the nights its line walk
  // re-carries ('closeUnder' at one figure, closing at or above the higher line at the next) — v1.202.0's five; v1.200.1's
  // walks re-carried 2027-01-26 21:30 and 13:00 at 750 W and 2027-04-26 21:30 and 13:00 at 600 W, on ×0.75.
  sweep: [2159, 21_590], sweepLine: [1136, 11_360],
  reCarried: ['2026-10-15 13:00|s0.75|450', '2026-11-11 21:30|s0.75|150', '2026-11-11 13:00|s0.75|150', '2027-02-24 21:30|s0.75|450', '2027-02-24 13:00|s0.75|450'],
};

test('★★★ S5 THE POOL CLIFF — where the standby lifts the line past 100% of the pool, the requirement and the buy do not fall and a charge night does not hold; with no figure or 0 W, v1.200.1\'s plan', () => {
  // (a) 10 W more carries the line past the pool: the requirement and the buy rise to the window's full effort.
  const A = PIN_S5_CLIFF.a;
  const at = (w: number) => yearPlan({ ...caseOf(A.label).deps, outageCushionHours: A.hours }, S075, w);
  const [a560, a570] = [at(560), at(570)];
  assert.deepEqual([a560.cushionLineSocPct, a560.requiredExtraKwh, a560.buyKwh, a560.targetSocPct, a560.cushionShortfall], A.at560);
  assert.deepEqual([a570.cushionLineSocPct, a570.requiredExtraKwh, a570.buyKwh, a570.targetSocPct, a570.cushionShortfall], A.at570);
  assert.equal(a570.bindingCap, 'poolHeadroom');
  // (b) under a 40 kWh minimum buy the 0 W charge night stays a charge night at 270 W, written 50.
  const Bc = PIN_S5_CLIFF.b;
  const bt = (w: number | undefined) => yearPlan({ ...caseOf(Bc.label).deps, outageCushionHours: Bc.hours, minBuyKwh: Bc.minBuyKwh } as NightChargeInputDeps, S944, w);
  const [b0, bAbsent, b270] = [bt(0), bt(undefined), bt(270)];
  assert.equal(digestWithoutStandby(b0), planDigest(bAbsent));
  assert.deepEqual([b0.chargeTonight, b0.buyKwh, b0.requiredExtraKwh, written(b0)], Bc.at0);
  assert.deepEqual([b270.chargeTonight, b270.buyKwh, b270.requiredExtraKwh, written(b270)], Bc.at270);
  assert.ok(b270.cushionLineSocPct! > 100 && b270.cushionShortfall === true, 'the line is past the pool, and disclosed');
  assert.doesNotMatch(b270.rationale, /^Hold — |minimum-buy threshold/, 'not the minimum-buy hold');
  // (c) a line already past the pool at 0 W: no figure, 0 W and a figure that is no reading keep v1.200.1's proxy,
  // number for number; any figure above 0 W sizes the window's full effort.
  const C = PIN_S5_CLIFF.c;
  const ct = (w: unknown) => yearPlan({ ...caseOf(C.label).deps, outageCushionHours: C.hours }, S075, w);
  const cAbsent = ct(undefined);
  assert.ok(cAbsent.cushionLineSocPct! > 100 && cAbsent.cushionShortfall === true);
  assert.deepEqual([cAbsent.requiredExtraKwh, cAbsent.buyKwh, cAbsent.targetSocPct], C.proxy);
  for (const w of [0, Number.NaN, -1, 1e6]) assert.equal(digestWithoutStandby(ct(w)), planDigest(cAbsent), `${w} W`);
  for (const w of [1, 270]) {
    const p = ct(w);
    assert.deepEqual([p.requiredExtraKwh, p.buyKwh, p.targetSocPct], C.full, `${w} W`);
  }
  // (d) the sweep across the cliff, in 150 W steps: the year at 12, 20 and 30 h on ×0.75, ×0.944 and nameplate under a
  // 40 kWh minimum buy, every case whose line crosses 100% between 0 and 1500 W — the monotone set holds, no charge
  // night holds, and nothing falls under the w = 0 plan; with eligibility (a write mode, 20 h) the monotone set too.
  const crossing = (zero: StandbyPlan, top: StandbyPlan) => zero.cushionLineSocPct! <= 100 && top.cushionLineSocPct! > 100;
  const STEPS_150 = STEPS_30.filter((w) => w % 150 === 0);
  let plans = 0, crossings = 0;
  for (const hours of [12, 20, 30]) {
    const deps = (d: NightChargeInputDeps) => ({ ...d, outageCushionHours: hours, minBuyKwh: 40 }) as NightChargeInputDeps;
    const out = sweepW(CASES, [S075, S944, null], { deps, only: crossing, steps: STEPS_150 });
    assert.deepEqual(out.underW0, [], `${hours} h: under the w = 0 plan`);
    assert.deepEqual(out.reCarried, [], `${hours} h: no disclosed shortfall vanishes`);
    plans += out.plans;
    crossings += out.crossings;
  }
  assert.deepEqual([crossings, plans], PIN_S5_CLIFF.sweep, 'the crossings swept, and the plans');
  const line = sweepW(CASES, [S075, S944, null], { line: true, steps: STEPS_150, deps: (d) => ({ ...d, outageCushionHours: 20, minBuyKwh: 40 }) as NightChargeInputDeps, only: crossing });
  assert.deepEqual([line.crossings, line.plans], PIN_S5_CLIFF.sweepLine, 'with eligibility');
  assert.deepEqual(line.reCarried, PIN_S5_CLIFF.reCarried, 'with eligibility: the shortfalls that vanish are the line walk re-carrying its night');
});

/* ══ S6 — the scope ═══════════════════════════════════════════════════════════ */

test('★★★ S6 SCOPE — the legacy band and a disabled cushion count no standby in their cushion at any w, and carry no key; v1.202.0, their walks drain it', () => {
  // v1.202.0 — the cushion (B's term) is the islanded-outage cushion's alone; the plan's WALKS drain the figure on every
  // basis (walkStandbyW, NightChargePlan.planPool.standbyW). So the band and a disabled cushion keep their line and carry no
  // cushionStandby; their walks' figures move with w, and at 0 W they are as with no figure.
  for (const o of [{ islandedLoadKw: null }, { outageCushionHours: 0 }] as const) {
    for (const scale of [undefined, S944]) {
      const base = plan({ ...o, ...(scale ? { cushionPoolScale: scale } : {}) });
      assert.equal(planDigest(plan({ ...o, ...(scale ? { cushionPoolScale: scale } : {}), cushionStandbyW: 0 })), planDigest(base), `${JSON.stringify(o)} at 0 W`);
      for (const w of [270, 1500]) {
        const p = plan({ ...o, ...(scale ? { cushionPoolScale: scale } : {}), cushionStandbyW: w });
        assert.equal('cushionStandby' in p, false);
        assert.deepEqual([p.cushionKwh, p.cushionLineSocPct], [base.cushionKwh, base.cushionLineSocPct], `${JSON.stringify(o)} at ${w} W: the cushion and its line`);
        assert.equal(p.planPool?.standbyW, w, 'the walks drain it');
        assert.ok(written(p)! >= written(base)! && p.requiredExtraKwh! >= base.requiredExtraKwh! - 1e-9, `${JSON.stringify(o)} at ${w} W: the write and the requirement`);
      }
    }
  }
  // On the year: every legacy-pct and null plan keeps its cushion, line and no key at 270 W, and writes no lower.
  let legacy = 0;
  for (const c of CASES) {
    const base = yearPlan(c.deps, S944);
    if (base.cushionBasis === 'islanded-outage') continue;
    const p = yearPlan(c.deps, S944, 270);
    assert.deepEqual([p.cushionKwh, p.cushionLineSocPct, 'cushionStandby' in p], [base.cushionKwh, base.cushionLineSocPct, false], c.label);
    if (base.chargeTonight) assert.ok(p.chargeTonight && written(p)! >= written(base)!, `${c.label}: the write`);
    if (base.cushionBasis === 'legacy-pct') legacy += 1;
  }
  assert.equal(legacy, 148);
});

test('★★★ S6 SCOPE — the cost formula is untouched: a cost target above the line is written as before (COST55: 40.3%, written 40)', () => {
  const base = plan({ ...COST55, cushionPoolScale: S944 });
  const p = plan({ ...COST55, cushionPoolScale: S944, cushionStandbyW: 270 });
  assert.deepEqual([p.costCeilingSocPct, p.setpointSocPct, chargeReservePct(p)], [40.3, 40.3, 40]);
  // v1.202.0 — the cost target, not the line, sizes the buy; the walks drain the 270 W on the way to it, so the buy rises
  // with it (33.86 → 34.78 kWh) and the expected draw to 40% with the drain to the window open (20.33 → 20.91 kWh).
  assert.deepEqual([base.buyKwh, p.buyKwh], [33.86, 34.78], 'the cost target, not the line, sizes the buy');
  assert.deepEqual([base.expectedBuyKwh, p.expectedBuyKwh], [20.33, 20.91]);
  // The line it is bounded below by moved: 10 + 100 × (18.85 + 8 × 0.27) ÷ 86.999 = 34.15%.
  assert.equal(p.cushionKwh, 21.01);
  assert.equal(p.cushionLineSocPct, 34.15);
  assert.ok(p.requiredExtraKwh! > base.requiredExtraKwh!);
});

/** Measured (v1.201.0 review): the year's cost charge nights at 270 W against v1.200.1 at the same scale — those whose
 *  cost ceiling is at or above the new line's whole-percent ask, ⌈line⌉ (nothing moves), and those whose ceiling sits
 *  between the new line and ⌈line⌉ (the write rises to ⌈line⌉: the setpoint is max(target, ⌈line⌉)). */
const PIN_S6_COST = {
  // v1.202.0 — `rose`: a write the walks' drain lifts (2027-06-04 13:00: the window, an EV sharing it, no longer reaches the
  // line, so the shortfall keeps the raw surplus and the ceiling rises 42.7 → 51.5%, written 43 → 50).
  m: { atOrAboveAsk: 414, between: ['2027-03-21 21:30', '2027-03-21 +1 01:30'], rose: ['2027-06-04 13:00'] },
  np: { atOrAboveAsk: 417, between: ['2027-08-09 13:00'], rose: ['2027-06-04 13:00'] },
  // v1.202.0 — the buy rises with the walks' drain (20.28 → 21.28 kWh; v1.201.0: 20.28 both).
  example: { label: '2027-08-09 13:00', costCeilingSocPct: 49.2, line: [46.71, 49.05], written: [49, 50], buyKwh: [20.28, 21.28] },
};

test('★★★ S6 SCOPE — on the year, a cost night whose cost ceiling is at or above ⌈the new line⌉ writes what it did (v1.202.0: or more, where its de-bias falls away) and buys no less; one between the line and ⌈line⌉ writes ⌈line⌉', () => {
  // v1.203.0 — on the planner with no hold point: this test measures the standby's effect (see HOLD).
  onV1202(() => {
  const rose: Record<'m' | 'np', string[]> = { m: [], np: [] };
  for (const [name, scale] of [['m', S944], ['np', null]] as const) {
    let atOrAbove = 0;
    const between: string[] = [];
    for (const c of CASES) {
      const b = yearPlan(c.deps, scale);
      if (b.cushionBasis !== 'islanded-outage' || !b.chargeTonight || b.objective !== 'cost_arbitrage') continue;
      const p = yearPlan(c.deps, scale, 270);
      assert.equal(p.chargeTonight, true, `${c.label} ${name}`);
      if (p.costCeilingSocPct == null) continue;
      const ask = askOf((p.cushionLineSocPct! / 100) * c.deps.fullKwh, c.deps.fullKwh);
      if (p.costCeilingSocPct >= ask) {
        atOrAbove += 1;
        // v1.202.0 — no lower write, no lower buy (the walks drain w on the way to the target). A write rises where the
        // drain leaves the window short of the line, so the de-bias keeps the raw surplus and the ceiling rises with it.
        assert.ok(written(p)! >= written(b)!, `${c.label} ${name}: the cost target writes ${written(b)} → ${written(p)}`);
        if (written(p)! > written(b)!) rose[name].push(c.label);
        assert.ok(p.buyKwh! >= b.buyKwh! - 1e-9, `${c.label} ${name}: the buy ${b.buyKwh} → ${p.buyKwh}`);
      } else if (p.costCeilingSocPct > p.cushionLineSocPct!) {
        between.push(c.label);
        assert.equal(written(p), Math.min(RESERVE_WRITE_MAX_PCT, ask), `${c.label} ${name}: ⌈line⌉`);
        assert.ok(written(p)! >= written(b)! && p.buyKwh! >= b.buyKwh!, `${c.label} ${name}`);
      }
    }
    assert.equal(atOrAbove, PIN_S6_COST[name].atOrAboveAsk, `${name}: cost ceilings at or above ⌈line⌉`);
    assert.deepEqual(rose[name], PIN_S6_COST[name].rose, `${name}: the cost writes that rise`);
    assert.deepEqual(between, PIN_S6_COST[name].between, `${name}: cost ceilings between the line and ⌈line⌉`);
  }
  const E = PIN_S6_COST.example;
  const [b, p] = [undefined, 270].map((w) => yearPlan(caseOf(E.label).deps, null, w));
  assert.deepEqual([b.costCeilingSocPct, p.costCeilingSocPct], [E.costCeilingSocPct, E.costCeilingSocPct]);
  assert.deepEqual([b.cushionLineSocPct, p.cushionLineSocPct], E.line);
  assert.deepEqual([written(b), written(p)], E.written);
  assert.deepEqual([b.buyKwh, p.buyKwh], E.buyKwh);
  });
});

test('★★★ S6 (I-B3, the tripwire) — the standby is divided by the scale with the load leg, once: line = floor + 100 · cushion ÷ (pool · s) on every islanded row', () => {
  let n = 0;
  for (const c of CASES) {
    for (const scale of [S944, null]) {
      const base = yearPlan(c.deps, scale);
      if (base.cushionBasis !== 'islanded-outage') continue;
      const p = yearPlan(c.deps, scale, 270);
      const s = scale?.scale ?? 1;
      const hours = c.deps.outageCushionHours ?? 4;
      // The row's own columns (panel-% form): reserve_floor_pct + 100 · cushion_kwh ÷ (pool_full_kwh · cushion_pool_scale).
      const panelPct = p.reserveFloorPct + (100 * p.cushionKwh!) / (c.deps.fullKwh * s);
      assert.ok(Math.abs(panelPct - p.cushionLineSocPct!) <= 0.005 + 1e-9, `${c.label} s ${s}: ${panelPct} vs ${p.cushionLineSocPct}`);
      // Counted once, before the conversion: the cushion less H·w is the cushion without it.
      assert.ok(Math.abs(p.cushionKwh! - (hours * 270) / 1000 - base.cushionKwh!) <= 0.005 + 1e-9, `${c.label}: ${p.cushionKwh} vs ${base.cushionKwh}`);
      // The line moved by the standby's own share of the measured capacity: 100 · H·w/1000 ÷ (N·s).
      const shift = (100 * (hours * 0.27)) / (c.deps.fullKwh * s);
      assert.ok(Math.abs(p.cushionLineSocPct! - base.cushionLineSocPct! - shift) <= 0.01 + 1e-9, `${c.label}: shift ${p.cushionLineSocPct! - base.cushionLineSocPct!} vs ${shift}`);
      n += 1;
    }
  }
  assert.equal(n, 2 * 702);
  // By hand on the reference: 16 + 100 × 15.02 ÷ 86.99904 = 33.2647 (33.20 if the standby skipped s; 33.34 if s
  // divided it twice: 1.08 ÷ 0.944 = 1.1441 kWh before the line's own ÷ 0.944).
  const p = yearPlan(caseOf('2026-10-12 resilience').deps, S944, 270);
  assert.equal(p.cushionLineSocPct, 33.26);
  assert.equal(Math.round((16 + (100 * (13.94 / 0.944 + 1.08)) / 92.16) * 100) / 100, 33.2, 'the standby not divided by s');
  assert.equal(Math.round((16 + (100 * (13.94 + 1.08 / 0.944)) / MEASURED_KWH) * 100) / 100, 33.34, 'the standby divided by s twice');
});

/* ══ S7 — agreement and the legs ══════════════════════════════════════════════ */

/** Measured when the change was made (v1.201.0) at (0.944, 270): the hold that becomes a charge. */
// v1.202.0 — on the measured pool 2027-05-20 21:30 already charges with no standby (v1.201.0's case: a 1.76 kWh charge);
// 2026-10-25 21:30 is the year's first night between the lines: its pack at the close, 42.1%, holds the 41.74% line and not
// the 42.98% one.
const PIN_S7_HOLD = { label: '2026-10-25 21:30', buyKwh: 2.02 };

test('★★ S7 AGREEMENT — a hold whose pack at the close sits between the two lines charges; a charge-bound night that held the old line discloses a shortfall and still writes the line', () => {
  // v1.203.0 — on the planner with no hold point: this test measures the standby's effect (see HOLD).
  onV1202(() => {
  const deps = caseOf(PIN_S7_HOLD.label).deps;
  const before = yearPlan(deps, S944);
  const p = yearPlan(deps, S944, 270);
  assert.equal(before.chargeTonight, false);
  assert.equal(before.cushionTroughSocPct! >= before.cushionLineSocPct!, true, 'the pack at the close held the old line');
  assert.equal(p.chargeTonight, true);
  assert.ok(p.cushionTroughSocPct! >= p.cushionLineSocPct! - 1e-9, 'the buy lifts it to the new one');
  assert.equal(p.buyKwh, PIN_S7_HOLD.buyKwh);
  assert.ok(before.cushionTroughSocPct! < p.cushionLineSocPct!, 'between the lines');
  // A 2.4 kW charger lifts the scenario's pack to the 30.45% line exactly, not to the 32.80% line with the standby.
  const old = plan({ chargeCapKw: 2.4 });
  assert.deepEqual([old.cushionShortfall, old.cushionTroughSocPct, old.cushionLineSocPct], [false, 30.45, 30.45]);
  const sb = plan({ chargeCapKw: 2.4, cushionStandbyW: 270 });
  assert.equal(sb.cushionKwh, 21.01);
  assert.equal(sb.cushionLineSocPct, 32.8);
  assert.equal(sb.cushionShortfall, true);
  assert.equal(sb.bindingCap, 'chargePower');
  assert.equal(sb.setpointSocPct, 33, 'the write is the line, not the arrival');
  assert.match(sb.rationale, /NOTE: charge\/pool caps prevent fully meeting the cushion — residual risk remains\./);
  // Every resilience charge night of the year writes at least ⌈its line⌉ (or the envelope).
  let n = 0;
  for (const c of CASES) {
    const q = yearPlan(c.deps, S944, 270);
    if (q.cushionBasis !== 'islanded-outage' || !q.chargeTonight || q.requiredExtraKwh === 0) continue;
    n += 1;
    assert.ok(written(q)! >= Math.min(RESERVE_WRITE_MAX_PCT, Math.ceil(q.cushionLineSocPct! - 0.005 - 1e-9)), `${c.label}: line ${q.cushionLineSocPct}, written ${written(q)}`);
  }
  assert.ok(n >= 250, `${n} nights`);
  });
});

test('★★ S7 LEGS — the backup leg asks more against the higher line; the mid-day T_mid line term is ⌈the new line⌉; the re-entry line is not a cushion', () => {
  const backup = (o: Partial<NightChargeInputs> & { cushionStandbyW?: unknown } = {}) => plan({
    objectiveMode: 'resilience', forceChargeEligible: false, windowSpec: { kind: 'overnight', role: 'backup' },
    horizon: horizon(900), chargeCapKw: 12, ...o,
  });
  const b0 = backup();
  const b1 = backup({ cushionStandbyW: 270 });
  assert.deepEqual([b0.cushionLineSocPct, b0.setpointSocPct, b0.requiredExtraKwh, b0.cushionTroughSocPct], [30.45, 53.8, 31.6, 30.45]);
  // The walk to the horizon end drains the same energy from any start, so the pack it asks for rises by the
  // line's own 2.34 points (2.16 kWh on 92.16).
  // v1.202.0 — and the walk itself drains the 270 W for every hour to the horizon end (56.1% and 33.58 kWh with v1.201.0's walks).
  assert.deepEqual([b1.cushionLineSocPct, b1.setpointSocPct, b1.requiredExtraKwh, b1.cushionTroughSocPct], [32.8, 62.6, 40.13, 32.8]);
  assert.equal(b1.cushionShortfall, false);
  // The mid-day leg: no load after the window, so R is the line itself and T_mid's line term sets it.
  const mid = (o: Partial<NightChargeInputs> & { cushionStandbyW?: unknown } = {}) => plan({
    objectiveMode: 'cost', costMaxSocPct: 90, forceChargeEligible: true, socNowPct: 20,
    window: { startMs: B + 2 * H, endMs: B + 7 * H },
    windowSpec: { kind: 'super_off_peak', role: 'cost', window: { startMs: B + 2 * H, endMs: B + 7 * H } },
    horizon: Array.from({ length: 30 }, (_, i) => ({ ts: B + i * H, pvP10W: 0, loadP90W: i < 7 ? 600 : 0, loadP50W: i < 7 ? 450 : 0, pvP50W: 0 })),
    ...o,
  });
  const m0 = mid();
  const m1 = mid({ cushionStandbyW: 270 });
  assert.deepEqual([m0.reserveTargetBasis, m0.setpointSocPct], ['line', 31]);
  // v1.202.0 — with the walks draining the 270 W, the hours after the window are no longer free: the resilience walk to the
  // next open (R) asks 40%, above ⌈the new line⌉ = 33, and sets T_mid (v1.201.0's walks: the line term, 33).
  assert.deepEqual([m1.reserveTargetBasis, m1.setpointSocPct, m1.cushionLineSocPct], ['resilience', 40, 32.8]);
  assert.ok(m1.setpointSocPct! >= Math.ceil(m1.cushionLineSocPct!), 'T_mid at or above ⌈the new line⌉');
  assert.equal(middayReentryLinePct(30, 10), 35, 'floor + 25: unchanged, and not on the cushion');
});

/* ══ S8 — the year ════════════════════════════════════════════════════════════ */

/** Measured when the change was made (v1.201.0), against the v1.200.1 plan at the same scale (no standby), at
 *  0.944 and on nameplate: writes raised, shortfalls disclosed, holds that charge, charges that hold, and the charge
 *  plans whose line is over the 50% envelope with no shortfall (no line force-charge eligibility passed).
 *  v1.202.0 — re-measured with the walks on the pool and draining the figure (v1.201.0: writtenUp 156 / 162, shortfallOn 5,
 *  holdToCharge 3, overEnvelope [24, 36] / [13, 23]); `soft`: the walks' disclosures and the holds' setpoints that fall. */
const PIN_S8 = {
  m: { islanded: 702, lineUp: 702, writtenUp: 163, shortfallOn: 12, holdToCharge: 15, chargeToHold: 0, overEnvelope: [22, 36], soft: { targetSocPct: 169, expectedBuyKwh: 4, setpointSocPct: 85 }, reCarried: 0 },
  np: { islanded: 702, lineUp: 702, writtenUp: 163, shortfallOn: 10, holdToCharge: 9, chargeToHold: 0, overEnvelope: [13, 21], soft: { targetSocPct: 190, expectedBuyKwh: 5, setpointSocPct: 94 }, reCarried: 0 },
};
/** Measured (v1.201.0): A's carrier on the B year — qualifying plans, carried (eligible), and the rest (neither
 *  carried nor disclosed), at 0.944 and on nameplate. */
const PIN_S8_CARRIER = { m: { qualifying: 53, carried: 53, rest: 0 }, np: { qualifying: 40, carried: 40, rest: 0 } };
/** Measured (v1.201.0 review): the same year in the states the add-on runs — lineForceChargeEligible true (a write
 *  mode) and false (advisory) — against v1.200.1 in the same state: writes raised, shortfalls disclosed (the
 *  envelope's included), holds that charge, charges that hold, and the plans the line force-charge carries. */
/** v1.202.0 — re-measured as PIN_S8 (v1.201.0: writtenUp 156 / 162, shortfallOn 5 on, 15 / 18 off, holdToCharge 3). */
const PIN_S8_LIVE = {
  on: {
    m: { writtenUp: 163, shortfallOn: 13, holdToCharge: 15, chargeToHold: 0, carried: [37, 53], carryDropped: 0, soft: { targetSocPct: 169, expectedBuyKwh: 6, setpointSocPct: 85, expectedWriteLevelPct: 6 }, reCarried: 0 },
    np: { writtenUp: 163, shortfallOn: 10, holdToCharge: 9, chargeToHold: 0, carried: [22, 40], carryDropped: 0, soft: { targetSocPct: 190, expectedBuyKwh: 5, setpointSocPct: 94, expectedWriteLevelPct: 4 }, reCarried: 0 },
  },
  off: {
    m: { writtenUp: 163, shortfallOn: 24, holdToCharge: 15, chargeToHold: 0, carried: [0, 0], carryDropped: 0, soft: { targetSocPct: 169, expectedBuyKwh: 4, setpointSocPct: 85 }, reCarried: 0 },
    np: { writtenUp: 163, shortfallOn: 21, holdToCharge: 9, chargeToHold: 0, carried: [0, 0], carryDropped: 0, soft: { targetSocPct: 190, expectedBuyKwh: 5, setpointSocPct: 94 }, reCarried: 0 },
  },
};

test('★★★ S8 THE YEAR at (0.944, 270) and (nameplate, 270) against v1.200.1: nothing written or sized falls, the counts as measured; A\'s carrier holds (rest = 0)', () => {
  // v1.203.0 — on the planner with no hold point: this test measures the standby's effect (see HOLD).
  onV1202(() => {
  // v1.202.0 — against the same plan with no figure (the walks then drain none): the line, a charge night's setpoint and
  // write, the requirement, the worst-case buy and the cost ceiling never fall; the walks' disclosures (the expected buy,
  // its level, the arrival) and a hold's no-buy setpoint may, counted (`soft`); a shortfall can vanish only where A's
  // re-ON walk re-carries its night (counted). The legacy band keeps its cushion and line and carries no key.
  for (const [name, scale] of [['m', S944], ['np', null]] as const) {
    const k = { islanded: 0, lineUp: 0, writtenUp: 0, shortfallOn: 0, holdToCharge: 0, chargeToHold: 0, overEnvelope: [0, 0], soft: {} as Record<string, number>, reCarried: 0 };
    const carrier = { qualifying: 0, carried: 0, rest: 0 };
    let eightHourMoved = 0;
    const overEnvelope = (p: NightChargePlan) => p.chargeTonight && p.cushionBasis === 'islanded-outage' && p.cushionLineSocPct! > RESERVE_WRITE_MAX_PCT + 0.05 && !p.cushionShortfall;
    for (const c of CASES) {
      const b = yearPlan(c.deps, scale);
      const p = yearPlan(c.deps, scale, 270);
      if (b.cushionBasis !== 'islanded-outage') {
        assert.deepEqual([p.cushionKwh, p.cushionLineSocPct, 'cushionStandby' in p], [b.cushionKwh, b.cushionLineSocPct, false], c.label);
        if (b.chargeTonight) assert.ok(p.chargeTonight && written(p)! >= written(b)!, `${c.label}: the write`);
        continue;
      }
      k.islanded += 1;
      if (p.cushionLineSocPct! > b.cushionLineSocPct! + 1e-9) k.lineUp += 1;
      for (const f of ['cushionLineSocPct', 'setpointSocPct', 'requiredExtraKwh', 'buyKwh', 'buyKwhDebiased', 'costCeilingSocPct', 'expectedBuyKwh', 'expectedWriteLevelPct', 'targetSocPct'] as const) {
        const x = b[f] as number | null | undefined, y = p[f] as number | null | undefined;
        if (x == null) continue;
        if (y != null && y >= x - 1e-9) continue;
        const softF = f === 'expectedBuyKwh' || f === 'expectedWriteLevelPct' || f === 'targetSocPct' || (f === 'setpointSocPct' && !(b.chargeTonight && p.chargeTonight));
        assert.ok(softF, `${c.label} ${name}: ${f} fell ${x} → ${y}`);
        k.soft[f] = (k.soft[f] ?? 0) + 1;
      }
      if (b.chargeTonight && p.chargeTonight) assert.ok(written(p)! >= written(b)!, `${c.label} ${name}: the write`);
      if (b.chargeTonight && p.chargeTonight && written(p)! > written(b)!) k.writtenUp += 1;
      if (!b.cushionShortfall && p.cushionShortfall) k.shortfallOn += 1;
      if (b.cushionShortfall && !p.cushionShortfall) k.reCarried += 1;
      if (!b.chargeTonight && p.chargeTonight) k.holdToCharge += 1;
      if (b.chargeTonight && !p.chargeTonight) k.chargeToHold += 1;
      if (overEnvelope(b)) k.overEnvelope[0] += 1;
      if (overEnvelope(p)) k.overEnvelope[1] += 1;
      if ((c.deps.outageCushionHours ?? 4) === 8 && p.cushionKwh! - b.cushionKwh! > 2.15) eightHourMoved += 1;
      // I-B4 — A's carrier invariant on the B year: an over-envelope line that is not economic-only is carried
      // by the line force-charge (eligible) or disclosed (cause 'envelope'); never neither.
      const qualifies = p.chargeTonight && (p.requiredExtraKwh ?? 0) > 0
        && askOf((p.cushionLineSocPct! / 100) * c.deps.fullKwh, c.deps.fullKwh) > RESERVE_WRITE_MAX_PCT;
      if (qualifies) {
        carrier.qualifying += 1;
        const on = yearPlan(c.deps, scale, 270, true) as StandbyPlan & { forceChargeLine?: unknown; cushionShortfallCause?: unknown };
        const off = yearPlan(c.deps, scale, 270, false) as StandbyPlan & { cushionShortfallCause?: unknown };
        if (on.forceChargeLine != null) carrier.carried += 1;
        if (on.forceChargeLine == null && on.cushionShortfallCause == null) carrier.rest += 1;
        if (off.cushionShortfallCause == null) carrier.rest += 1;
      }
    }
    assert.ok(eightHourMoved > 50, `${name}: the 8 h cases move by 2.16 kWh (${eightHourMoved})`);
    assert.deepEqual(k, PIN_S8[name], `${name}: the year's counts`);
    assert.equal(carrier.rest, 0, `${name}: an over-envelope line neither carried nor disclosed`);
    assert.deepEqual(carrier, PIN_S8_CARRIER[name], `${name}: the carrier's counts`);
  }
  });
});

test('★★★ S8 THE YEAR in a write mode and in advisory mode (eligibility true / false): nothing written or sized falls either, the counts as measured', () => {
  // v1.203.0 — on the planner with no hold point: this test measures the standby's effect (see HOLD).
  onV1202(() => {
  for (const [state, line] of [['on', true], ['off', false]] as const) {
    for (const [name, scale] of [['m', S944], ['np', null]] as const) {
      const k = { writtenUp: 0, shortfallOn: 0, holdToCharge: 0, chargeToHold: 0, carried: [0, 0], carryDropped: 0, soft: {} as Record<string, number>, reCarried: 0 };
      for (const c of CASES) {
        const b = yearPlan(c.deps, scale, undefined, line) as StandbyPlan & { forceChargeLine?: unknown };
        const p = yearPlan(c.deps, scale, 270, line) as StandbyPlan & { forceChargeLine?: unknown };
        if (b.cushionBasis !== 'islanded-outage') continue;
        for (const f of ['cushionLineSocPct', 'setpointSocPct', 'requiredExtraKwh', 'buyKwh', 'buyKwhDebiased', 'costCeilingSocPct', 'expectedBuyKwh', 'expectedWriteLevelPct', 'targetSocPct'] as const) {
          const x = b[f] as number | null | undefined, y = p[f] as number | null | undefined;
          if (x == null) continue;
          if (y != null && y >= x - 1e-9) continue;
          // v1.202.0 — as above: the walks' disclosures and a hold's setpoint are counted; what is written and sized is held.
          const softF = f === 'expectedBuyKwh' || f === 'expectedWriteLevelPct' || f === 'targetSocPct' || (f === 'setpointSocPct' && !(b.chargeTonight && p.chargeTonight));
          assert.ok(softF, `${c.label} ${state} ${name}: ${f} fell ${x} → ${y}`);
          k.soft[f] = (k.soft[f] ?? 0) + 1;
        }
        if (b.chargeTonight && p.chargeTonight) assert.ok(written(p)! >= written(b)!, `${c.label} ${state} ${name}: the write`);
        if (b.chargeTonight && p.chargeTonight && written(p)! > written(b)!) k.writtenUp += 1;
        if (!b.cushionShortfall && p.cushionShortfall) k.shortfallOn += 1;
        if (b.cushionShortfall && !p.cushionShortfall) k.reCarried += 1;
        if (!b.chargeTonight && p.chargeTonight) k.holdToCharge += 1;
        if (b.chargeTonight && !p.chargeTonight) k.chargeToHold += 1;
        if (b.forceChargeLine != null) k.carried[0] += 1;
        if (p.forceChargeLine != null) k.carried[1] += 1;
        if (b.forceChargeLine != null && p.forceChargeLine == null) k.carryDropped += 1;
      }
      assert.deepEqual(k, PIN_S8_LIVE[state][name], `${state} ${name}: the year's counts`);
    }
  }
  });
});

/** Measured on v1.200.1 (v1.201.0): the year's line nights (an ask above the 50% reserve: armed, or disclosed unarmed)
 *  without the standby and at 270 W, in the states the add-on runs — a write mode (lineForceChargeEligible true, the cost
 *  force-charge on the live gate: the cost objective and ARB_COST_MAX_SOC_PCT above 50), advisory (both off), and a write
 *  mode with the reserve already reading 50% (v1.200.1's stand) — by how the night is carried: the line force-charge or a
 *  cost force-charge that already stops 10 points above the line, '+caps' where the sizing's caps note discloses it,
 *  'closeUnder' where its line walk closes under the line; 'advisory' disclosed with nothing armed. `under` counts the
 *  line nights whose expected close is under the line less 0.05, `undisclosed` those of them with no shortfall
 *  disclosed; `closeFell` / `buyFell` the line nights (at both figures) whose expected close / expected buy falls. */
/** v1.202.0 — re-measured with the walks on the pool and draining the figure, and with a cost-carried night judged on its
 *  close past the stop ('cost closeUnder', disclosed: v1.202.0's walk of the drawback). In a write mode the walks' drain
 *  lowers 3 closes on nameplate and 5 at 0.944 (2 expected buys), every one a disclosure; no line night is under its line
 *  undisclosed in any state. `under` reads a cost-carried night's close past the stop wherever the plan names it (whether
 *  or not its sizing fell short: a '+caps' night is under by that close too, beside its caps note).
 *  v1.205.0 — that close capped at the window's reach (H1, as a line walk's): more nights sized short are under by it, on both
 *  sides of the standby (write [2, 6] → [6, 9] and [3, 7] → [8, 10]; standing [74, 83] → [85, 94] and [73, 86] → [84, 94]), so
 *  fewer are newly under at 270 W; no night's mode or reason moves. */
const PIN_S8_MODES = {
  write: {
    np: { nights: [22, 40], crossed: 18, before: { cost: 3, 'cost+caps': 7, line: 10, 'line+caps': 2 }, after: { cost: 8, 'cost+caps': 9, line: 16, 'line+caps': 7 }, under: [6, 9], undisclosed: [0, 0], newUnder: ['2026-10-29 +1 01:30', '2026-11-13 21:30', '2027-05-16 +1 01:30'], closeFell: 3, buyFell: 0 },
    m: { nights: [37, 53], crossed: 16, before: { cost: 6, 'cost+caps': 9, line: 16, 'line+caps': 6 }, after: { cost: 11, 'cost closeUnder': 1, 'cost+caps': 11, line: 22, 'line+caps': 8 }, under: [8, 10], undisclosed: [0, 0], newUnder: ['2026-10-13 13:00', '2026-10-29 +1 01:30'], closeFell: 5, buyFell: 2 },
  },
  advisory: {
    np: { nights: [22, 40], crossed: 18, before: { advisory: 22 }, after: { advisory: 40 }, under: [22, 37], undisclosed: [0, 0], newUnder: 15, closeFell: 0, buyFell: 0 },
    m: { nights: [37, 53], crossed: 16, before: { advisory: 37 }, after: { advisory: 53 }, under: [37, 53], undisclosed: [0, 0], newUnder: 16, closeFell: 0, buyFell: 0 },
  },
  stand: {
    np: { nights: [659, 669], crossed: 10, before: { 'stand cost': 149, 'stand cost closeUnder': 4, 'stand cost+caps': 52, 'stand line': 302, 'stand line closeUnder': 1, 'stand line+caps': 151 }, after: { 'stand cost': 132, 'stand cost closeUnder': 3, 'stand cost+caps': 54, 'stand line': 316, 'stand line closeUnder': 4, 'stand line+caps': 160 }, under: [85, 94], undisclosed: [0, 0], newUnder: 12, closeFell: 146, buyFell: 26 },
    m: { nights: [665, 674], crossed: 9, before: { 'stand cost': 144, 'stand cost closeUnder': 4, 'stand cost+caps': 50, 'stand line': 314, 'stand line closeUnder': 2, 'stand line+caps': 151 }, after: { 'stand cost': 126, 'stand cost closeUnder': 6, 'stand cost+caps': 46, 'stand line': 332, 'stand line closeUnder': 2, 'stand line+caps': 162 }, under: [84, 94], undisclosed: [0, 0], newUnder: 13, closeFell: 181, buyFell: 31 },
  },
};

test('★★★ S8 THE LINE NIGHTS by mode: more nights carry a line above 50 at 270 W; none is left undisclosed under its line; the closes and expected buys that fall, counted', () => {
  // v1.203.0 — on the planner with no hold point: this test measures the standby's effect (see HOLD).
  onV1202(() => {
  const gate = (d: NightChargeInputDeps) => d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50;
  const STATES: Record<keyof typeof PIN_S8_MODES, (d: NightChargeInputDeps) => NightChargeInputDeps> = {
    write: (d) => ({ ...d, lineForceChargeEligible: true, forceChargeEligible: gate(d) }) as NightChargeInputDeps,
    advisory: (d) => ({ ...d, lineForceChargeEligible: false, forceChargeEligible: false }) as NightChargeInputDeps,
    stand: (d) => ({ ...d, lineForceChargeEligible: true, forceChargeEligible: gate(d), reserveFloorPct: 50 }) as NightChargeInputDeps,
  };
  type LP = StandbyPlan & { forceChargeLine?: unknown; cushionEnvelopeReason?: string; expectedForceChargeMode?: string; lineReserveStands?: true };
  const lineMode = (p: LP): string | null => {
    if (p.forceChargeLine == null) return p.cushionEnvelopeReason != null ? p.cushionEnvelopeReason : null;
    const how = p.expectedForceChargeMode === 'line' ? 'line' : 'cost';
    return `${p.lineReserveStands === true ? 'stand ' : ''}${how}${p.cushionEnvelopeReason != null ? ` ${p.cushionEnvelopeReason}` : p.cushionShortfall ? '+caps' : ''}`;
  };
  // v1.202.0 — a night the cost force-charge carries closes where its walk past the stop ends (expectedCloseAfterStopPct).
  const closeOf = (p: LP): number | null | undefined => (p as LP & { expectedCloseAfterStopPct?: number }).expectedCloseAfterStopPct ?? p.expectedWriteLevelPct;
  const under = (p: LP) => lineMode(p) != null && closeOf(p) != null && closeOf(p)! < p.cushionLineSocPct! - 0.05 - 1e-9;
  const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  for (const [state, of] of Object.entries(STATES) as Array<[keyof typeof PIN_S8_MODES, (d: NightChargeInputDeps) => NightChargeInputDeps]>) {
    for (const [name, scale] of [['np', null], ['m', S944]] as const) {
      const k = { nights: [0, 0], crossed: 0, before: {} as Record<string, number>, after: {} as Record<string, number>, under: [0, 0], undisclosed: [0, 0], newUnder: [] as string[], closeFell: 0, buyFell: 0 };
      for (const c of CASES) {
        const b = yearPlan(of(c.deps), scale) as LP, p = yearPlan(of(c.deps), scale, 270) as LP;
        if (p.cushionBasis !== 'islanded-outage') continue;
        const mb = lineMode(b), mp = lineMode(p);
        if (mb != null) { k.nights[0] += 1; k.before[mb] = (k.before[mb] ?? 0) + 1; }
        if (mp != null) { k.nights[1] += 1; k.after[mp] = (k.after[mp] ?? 0) + 1; }
        if (mb == null && mp != null) k.crossed += 1;
        assert.ok(!(mb != null && mp == null), `${c.label} ${state} ${name}: a line night left the line`);
        if (under(b)) { k.under[0] += 1; if (!b.cushionShortfall) k.undisclosed[0] += 1; }
        if (under(p)) { k.under[1] += 1; if (!p.cushionShortfall) k.undisclosed[1] += 1; if (!under(b)) k.newUnder.push(c.label); }
        if (mb != null && mp != null && p.expectedWriteLevelPct! < b.expectedWriteLevelPct! - 1e-9) k.closeFell += 1;
        if (mb != null && mp != null && p.expectedBuyKwh! < b.expectedBuyKwh! - 1e-9) k.buyFell += 1;
      }
      const pin = PIN_S8_MODES[state][name];
      const got = { ...k, before: sorted(k.before), after: sorted(k.after), newUnder: typeof pin.newUnder === 'number' ? k.newUnder.length : k.newUnder };
      assert.deepEqual(got, pin, `${state} ${name}`);
      assert.equal(k.undisclosed[1], 0, `${state} ${name}: a line night under its line with nothing disclosed`);
    }
  }
  });
});

test('★★★ S8 THE YEAR, case by case: the figures as measured (cushionStandby.figures.json)', () => {
  const FIGURES = JSON.parse(readFileSync(STANDBY_FIGURES_PATH, 'utf8')) as {
    fields: string[]; sets: Record<string, { scale: CushionPoolScale | null; w: number; figures: Record<string, Figures> }>;
  };
  assert.deepEqual(FIGURES.fields, [...FIGURE_FIELDS]);
  assert.deepEqual(Object.keys(FIGURES.sets), Object.keys(STANDBY_SETS));
  const labels = CASES.map((c) => c.label);
  for (const [name, set] of Object.entries(STANDBY_SETS)) {
    const pinned = FIGURES.sets[name];
    assert.deepEqual([pinned.scale, pinned.w], [set.scale, set.w], name);
    assert.deepEqual(Object.keys(pinned.figures), labels, `${name}: the same cases, in the same order`);
    const got = standbyFigures(set);
    const moved = labels.filter((l) => JSON.stringify(got[l]) !== JSON.stringify(pinned.figures[l]));
    assert.deepEqual(moved.map((l) => [l, pinned.figures[l], got[l]]).slice(0, 5), [], `${name}: ${moved.length} case(s) moved`);
  }
  // Spot one by hand: the reference night at (0.944, 270).
  // v1.203.0 — written 35: the 33.26% line's whole percent and the panel's point (34 on v1.202.0).
  assert.deepEqual(FIGURES.sets.m270.figures['2026-10-12 resilience'].slice(0, 4), [1, 33.26, 35, 35]);
  assert.deepEqual(figuresOf(yearPlan(caseOf('2026-10-12 resilience').deps, S944, 270)), FIGURES.sets.m270.figures['2026-10-12 resilience']);
});

/* ══ S9 — parity with the runway (R3) ═════════════════════════════════════════ */

/** A panel with three source slots: per slot isConnected, hwConnect and sn, and the Cores' packs at 0.944. */
function fleetOf(slots: Array<{ isConnected?: boolean; hwConnect?: boolean; sn?: string | null } | null>, sourcesPresent = true) {
  const panel = {
    sn: 'PANEL', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: B,
    projection: {
      kind: 'shp2', backupBatPercent: 25, backupFullCapWh: 92_160, backupRemainWh: 0.25 * 92_160, backupReserveSoc: 16,
      circuits: [], pairedCircuits: [], sourceWatts: [], strategy: {},
      ...(sourcesPresent ? {
        sources: slots.map((s, i) => (s == null ? null : { slot: i + 1, sn: s.sn === undefined ? `CORE-${i + 1}` : s.sn, isConnected: s.isConnected ?? false, hwConnect: s.hwConnect ?? false, fullCap: 30_720 })),
      } : {}),
    },
  } as unknown as DeviceSnapshot & { projection: Shp2Projection };
  const devs: Record<string, DeviceSnapshot> = { PANEL: panel };
  slots.forEach((_, i) => {
    const sn = `CORE-${i + 1}`;
    devs[sn] = {
      sn, deviceName: sn, online: true, lastSeenMs: B,
      projection: { kind: 'dpu', soc: 25, packCount: 5, packs: [1, 2, 3, 4, 5].map((num) => ({ num, soc: 25, designCapMah: 60_000, fullCapMah: 56_640 })) },
    } as unknown as DeviceSnapshot;
  });
  return { devs, panel };
}
const BOTH = { isConnected: true, hwConnect: true };
const FLEETS: Array<[string, ReturnType<typeof fleetOf>]> = [
  ['0 connected', fleetOf([{}, {}, {}])],
  ['1 connected', fleetOf([BOTH, {}, {}])],
  ['2 connected', fleetOf([BOTH, BOTH, {}])],
  ['3 connected', fleetOf([BOTH, BOTH, BOTH])],
  ['isConnected without hwConnect', fleetOf([{ isConnected: true }, { isConnected: true }, { isConnected: true }])],
  ['hwConnect without isConnected', fleetOf([{ hwConnect: true }, { hwConnect: true }, BOTH])],
  ['a null sn', fleetOf([BOTH, { ...BOTH, sn: null }, BOTH])],
  ['a partial frame (a null slot)', fleetOf([BOTH, null, BOTH])],
  ['a partial frame (no sources)', fleetOf([BOTH, BOTH, BOTH], false)],
];

test('★★ S9 PARITY (a) — the cushion tracker counts the Cores the runway counts, from the same snapshot', () => {
  const counts: Record<string, number> = {};
  for (const [name, f] of FLEETS) {
    resetPoolEnergyBasisForTesting();
    const cushion = new PoolEnergyBasisTracker({ path: null }).evaluate(f.devs, f.panel, B); // index.ts measuredCushionScale's read
    const runway = runwayEnergyBasis(f.devs, f.panel, B);
    assert.equal(cushion.connectedCores, runway.connectedCores, name);
    assert.equal(runwayPoolOverheadW(cushion.connectedCores, true), runway.overheadW, `${name}: the cushion's figure is the runway's`);
    counts[name] = cushion.connectedCores;
  }
  resetPoolEnergyBasisForTesting();
  assert.deepEqual(Object.values(counts), [0, 1, 2, 3, 3, 1, 2, 2, 0]);
});

/** index.ts's door and its call line, as written there, evaluated against `analytics` (a fresh import). */
function doorProbe(analytics: { runwayPoolOverheadW: (n: number, r: boolean) => number }) {
  const index = readFileSync(resolve(SRC, 'index.ts'), 'utf8');
  const start = index.indexOf('function cushionStandbyOverheadW(');
  assert.ok(start > 0, 'the door');
  const door = index.slice(start, index.indexOf('\n}\n', start) + 2);
  const call = index.split('\n').find((l) => /^\s+const cushionStandbyW = /.test(l));
  assert.ok(call, 'the call line');
  const ts = `function __probe(runwayPoolOverheadW, cushionPoolScale, fullWh, sp, devs, shp2, nowMs) {\n${door}\n${call}\nreturn cushionStandbyW;\n}`;
  const js = transformSync(ts, { loader: 'ts' }).code;
  return new Function(`${js}\nreturn __probe;`)() as (...a: unknown[]) => number;
}

test('★★ S9 PARITY (b) — the door at a per-Core figure where the count matters (200 W: 270/270/400/600 for 0–3 Cores), counting the tracker\'s Cores', async () => {
  let seq = 0;
  const fresh = async () => withEnv({ RUNWAY_CORE_OVERHEAD_W: '200', RUNWAY_POOL_OVERHEAD_FLOOR_W: undefined },
    async () => (await import(`${pathToFileURL(resolve(SRC, 'analytics.ts')).href}?standby=${++seq}`)) as typeof import('../src/analytics.js'));
  const a = await fresh();
  assert.deepEqual([0, 1, 2, 3].map((n) => a.runwayPoolOverheadW(n, true)), [270, 270, 400, 600]);
  assert.equal(a.runwayPoolOverheadW(0, false), 0);
  const probe = doorProbe(a);
  const got: Record<string, number> = {};
  for (const [name, f] of FLEETS) {
    const b = new PoolEnergyBasisTracker({ path: null }).evaluate(f.devs, f.panel, B);
    const scale = { scale: b.capacityScale, basis: b.capacityBasis, connectedCores: b.connectedCores };
    got[name] = probe(a.runwayPoolOverheadW, scale, f.panel.projection.backupFullCapWh, f.panel.projection, f.devs, f.panel, B);
    // A tracker that threw (null) counts no Core: the runway's floor.
    assert.equal(probe(a.runwayPoolOverheadW, null, 92_160, f.panel.projection, f.devs, f.panel, B), 270, `${name}: a tracker that threw`);
  }
  assert.deepEqual(Object.values(got), [270, 270, 400, 600, 600, 270, 400, 400, 270]);
});

test('★★ S9 PARITY (c) — the plausible maximum is the floor option\'s upper clamp and three slots at the per-Core clamp', () => {
  const row = (name: string) => OPTIONS[name] as unknown as { clamp: { min: number; max: number } };
  assert.equal((nca as unknown as Record<string, number>).CUSHION_STANDBY_PLAUSIBLE_MAX_W, row('RUNWAY_POOL_OVERHEAD_FLOOR_W').clamp.max);
  assert.equal((nca as unknown as Record<string, number>).CUSHION_STANDBY_PLAUSIBLE_MAX_W, SHP2_SOURCE_SLOTS * row('RUNWAY_CORE_OVERHEAD_W').clamp.max);
  assert.deepEqual([row('RUNWAY_POOL_OVERHEAD_FLOOR_W').clamp.min, row('RUNWAY_CORE_OVERHEAD_W').clamp.min], [0, 0]);
});

/* ══ S10 — the ledger helper; the log line ════════════════════════════════════ */

test('★★ S10 LEDGER — three columns, from the plan\'s field: the figure, its basis and its energy; null off the islanded-outage basis', () => {
  const cols = (nca as unknown as { cushionStandbyLedgerColumns: (p: unknown) => Record<string, unknown> }).cushionStandbyLedgerColumns;
  assert.deepEqual(cols(plan({ cushionStandbyW: 270 })), { cushion_standby_w: 270, cushion_standby_basis: 'runway-overhead', cushion_standby_kwh: 2.16 });
  assert.deepEqual(cols(plan({ cushionStandbyW: Number.NaN })), { cushion_standby_w: 0, cushion_standby_basis: 'implausible', cushion_standby_kwh: 0 });
  for (const p of [plan(), plan({ islandedLoadKw: null, cushionStandbyW: 270 }), plan({ outageCushionHours: 0, cushionStandbyW: 270 }),
    plan({ basisComplete: false, cushionStandbyW: 270 })]) {
    assert.deepEqual(cols(p), { cushion_standby_w: null, cushion_standby_basis: null, cushion_standby_kwh: null });
  }
  // A row is self-describing: the cushion less its standby is the cushion without it, to its rounding.
  const p = plan({ cushionStandbyW: 270 });
  assert.ok(Math.abs(p.cushionKwh! - (cols(p).cushion_standby_kwh as number) - plan().cushionKwh!) <= 0.005);
});

test('★★ the log line (live legs, on change): the figure the door evaluated and the Cores it is the runway\'s figure for — no claim that tonight\'s cushion counts it', () => {
  const text = (nca as unknown as { cushionStandbyLogText: (w: number, n: number) => string }).cushionStandbyLogText;
  assert.equal(text(270, 3), "night-charge: the Cores' standby figure for the outage cushion is 270 W (the runway's figure for 3 connected Core(s)); an islanded-outage cushion counts it for its hours");
  assert.equal(text(180.5, 0), "night-charge: the Cores' standby figure for the outage cushion is 181 W (the runway's figure for 0 connected Core(s)); an islanded-outage cushion counts it for its hours");
});

/** index.ts's door, its call, the on-change key and the log block, as written there, evaluated against `analytics`
 *  with a recording log: one closure per process (the module-level last-logged key). */
function logProbe(analytics: { runwayPoolOverheadW: (n: number, r: boolean) => number }) {
  const index = readFileSync(resolve(SRC, 'index.ts'), 'utf8');
  const start = index.indexOf('function cushionStandbyOverheadW(');
  const door = index.slice(start, index.indexOf('\n}\n', start) + 2);
  const decl = index.split('\n').filter((l) => /^let lastLoggedCushionStandby\w*/.test(l));
  assert.equal(decl.length, 1, 'one module-level last-logged key');
  const lines = index.split('\n');
  const from = lines.findIndex((l) => /^\s+const cushionStandbyW = /.test(l));
  const to = lines.findIndex((l, i) => i > from && /^ {2}\}$/.test(l));
  assert.ok(from > 0 && to > from && to - from <= 6, `the call and its log block (${from}..${to})`);
  const block = lines.slice(from, to + 1).join('\n');
  const ts = `function __make(runwayPoolOverheadW, cushionStandbyLogText, app) {\n${decl[0]}\n${door}\nreturn (cushionPoolScale, fullWh, shadowLeg) => {\n${block}\nreturn cushionStandbyW;\n};\n}`;
  const js = transformSync(ts, { loader: 'ts' }).code;
  const logged: string[] = [];
  const make = new Function(`${js}\nreturn __make;`)() as (...a: unknown[]) => (s: unknown, f: number, shadow: boolean) => number;
  const leg = make(analytics.runwayPoolOverheadW, nca.cushionStandbyLogText, { log: { info: (m: string) => logged.push(m) } });
  return { leg, logged };
}

test('★★ the log line is keyed on the figure AND the Core count it names: a Core that connects, drops or returns re-logs at 270 W; a shadow leg never logs', async () => {
  const sc = (n: number | null) => (n == null ? null : { scale: 0.944, basis: 'measured', connectedCores: n });
  const { leg, logged } = logProbe({ runwayPoolOverheadW });
  // At the defaults (a 270 W floor, 90 W per Core) the figure is 270 W for 0-3 Cores: a boot on a partial frame
  // (0 Cores listed), then the Cores, one dropping and returning; a repeated reading does not re-log.
  for (const n of [0, 1, 3, 3, 2, 3]) assert.equal(leg(sc(n), 92_160, false), 270);
  assert.deepEqual(logged.map((m) => m.match(/for (\d) connected/)?.[1]), ['0', '1', '3', '2', '3']);
  assert.ok(logged.every((m) => m.includes(' is 270 W (')), 'the figure');
  leg(sc(1), 92_160, true);
  leg(null, 92_160, true);
  assert.equal(logged.length, 5, 'a shadow leg never logs');
  // A tracker that threw counts no Core: the runway's floor, named for 0 Cores.
  leg(null, 92_160, false);
  assert.equal(logged.at(-1), "night-charge: the Cores' standby figure for the outage cushion is 270 W (the runway's figure for 0 connected Core(s)); an islanded-outage cushion counts it for its hours");
});

/* ══ S11 — the plumbing ═══════════════════════════════════════════════════════ */

test('★★ S11 PLUMBING — buildNightChargeInputs forwards the figure; absent, the inputs carry no key', () => {
  const c = caseOf('2026-10-12 resilience');
  const fwd = (deps: unknown) => buildNightChargeInputs(deps as NightChargeInputDeps) as NightChargeInputs & { cushionStandbyW?: unknown };
  assert.equal('cushionStandbyW' in fwd(c.deps), false);
  assert.equal(fwd({ ...c.deps, cushionStandbyW: 270 }).cushionStandbyW, 270);
  assert.equal(fwd({ ...c.deps, cushionStandbyW: null }).cushionStandbyW, null);
  assert.equal(fwd({ ...c.deps, cushionStandbyW: Number.NaN }).cushionStandbyW, Number.NaN, 'forwarded as given: the planner judges it');
  // End to end through the builder, the hold plan carries the key too (a pack over both lines).
  const hold = yearPlan({ ...c.deps, socNowPct: 95 }, S944, 270);
  assert.equal(hold.chargeTonight, false);
  assert.deepEqual(hold.cushionStandby, { w: 270, kwh: 1.08, basis: 'runway-overhead' });
  assert.equal(hold.cushionKwh, 15.02);
  assert.equal(hold.cushionLineSocPct, 33.26);
});
