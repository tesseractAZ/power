import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nca from '../src/nightChargeAdvisor.js';
import {
  computeNightChargePlan, buildNightChargeInputs, chargeLevelPct, chargeReservePct, statedBuyKwh,
  type NightChargeInputs, type NightChargePlan, type CushionPoolScale,
} from '../src/nightChargeAdvisor.js';
import * as nfc from '../src/nightForceCharge.js';
import {
  decideForceCharge, desiredForceChargeCeilingPct, forceChargeCommandsOf, forceChargeStopPct,
  FORCE_CHARGE_MIN_RUN_MS, FORCE_CHARGE_JIT_BUFFER_MS, type ForceChargeOpts, type ForceChargeAction,
} from '../src/nightForceCharge.js';
import * as act from '../src/nightChargeActuator.js';
import {
  armFromPlan, coerceActuationState, emptyActuationState, nightChargeSpokenNotice, RESERVE_WRITE_MAX_PCT,
  MAX_SPOKEN_ADVISORY_CHARS, type NightActuationState, type ArmablePlan,
} from '../src/nightChargeActuator.js';
import { armCycle, emptyCycle, asChargeLeg } from '../src/chargeCycle.js';
import { liveRefreshOutcome, applyLiveRefresh } from '../src/morningRefresh.js';
import * as notify from '../src/notify.js';
import { buildNightChargeMessage, buildNightForceChargeOnFailure, buildNightChargeMorningSummary } from '../src/notify.js';
import { eveningAnnouncement } from '../src/chargeAnnounce.js';
import { legacyIdentityCases, planDigest } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';
import { goldenPlan } from './fixtures/overnightTextCases.js';
import * as cardText from '../../web/src/cards/nightChargeText.js';
import { chargeLegStep } from '../src/physics/chargeLeg.js';
import { costLegSizing, shadowCycleConfig, summariseLeg, middayShadowAnnounceInput } from '../src/middayShadow.js';
import { buildMiddayPlanMessage as middayPushOf } from '../src/chargeText.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';
import { pvSurplusFromBand } from '../src/chargeTaper.js';

/**
 * v1.200.0 — AN OUTAGE-CUSHION LINE ABOVE THE PANEL'S 50% RESERVE IS CARRIED BY THE NIGHT FORCE-CHARGE TO
 * THE WINDOW CLOSE, OR DISCLOSED.
 *
 * The panel accepts a backup reserve of at most 50% (RESERVE_WRITE_MAX_PCT). A charge night whose
 * islanded-outage line, asked to the whole percent above it (⌈L⌉), is above 50 wrote 50 and claimed the
 * cushion held (no shortfall): 13 charge plans of legacyIdentity's year on the nameplate line, 24 on the
 * measured one (measuredCushionLine.test.ts). Of them, 10 / 15 had no cost force-charge stop at or above
 * the line and closed near 50 — a realized strike, and an unheld cushion. One (2026-10-29 21:30 at 0.944:
 * setpoint = target = 66) said nothing about the 50% write and had no cost stop covering the line (T4).
 *
 * The fix, in three parts:
 *  - THE PLAN (nightChargeAdvisor.ts): such a plan ARMS `forceChargeLine { askPct: ⌈L⌉, linePct: L }`
 *    wherever a write mode can force-charge it (lineForceChargeEligible, never the backup leg), whatever the
 *    ask. (A5) It CLAIMS the line (carried) only where ⌈L⌉ + 10 ≤ 100 and its own line walk — capped at what
 *    the window can reach — closes at or above L − 0.05; otherwise it DISCLOSES (cushionShortfall, cause
 *    'envelope': nearFull / closeUnder, and the force-charge still runs; advisory and the backup leg arm
 *    nothing). No sizing figure moves.
 *  - THE RECORD (nightChargeActuator.ts): the line's ask in its own field beside the cost ceiling; the
 *    tick composes the mode from the LIVE gates (forceChargeModeOf).
 *  - THE TICK (nightForceCharge.ts): in line mode the force-charge starts timed to reach ⌈L⌉ + 5 twenty
 *    minutes before the close, has no software stop and runs to the window close; the panel ceiling is at
 *    least ⌈L⌉ + 10. The close guarantee is lineForceChargeClose.test.ts.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const H = 3_600_000;
const M = 60_000;
const S944: CushionPoolScale = MEASURED_SCALE;
const GOLDEN = JSON.parse(readFileSync(resolve(HERE, 'fixtures/legacyIdentity.golden.json'), 'utf8')) as { digests: Record<string, string> };
/** Measured when the change was made (v1.200.0): the 2027-01-04 21:30 line night's expected walk. v1.202.0 — on the
 *  measured pool (the walks' kWh are more of its points) it reaches the 80% panel ceiling, where the panel switches it off:
 *  ~80% at the close, 28.23 kWh (v1.200.0's walks on nameplate: 78.4%, 28.18 kWh, to the close with no stop). */
const PIN_T1 = { level: 80, startMs: Date.UTC(2027, 0, 5, 10, 25), buyKwh: 28.23, at: '03:25' };
/** Measured (v1.200.0 review): 2026-10-29 21:30 at 0.944, the expected close once the walk latches at the 80%
 *  panel ceiling and the house draws it back for the rest of the window (before the review it read 80).
 *  v1.202.0 — on the measured pool the house's drain is more points of it: drawn under 71% before the cutoff, the walk
 *  switches it back on (A's re-ON), and it closes ~79.7% (69.6% with no re-ON; v1.200.0's walks on nameplate: 72.1%, no re-ON). */
const PIN_T2_CLOSE = 79.7;
/** Measured when the change was made (v1.200.0): the year's carried / disclosed split, nameplate and 0.944.
 *  v1.202.0 — re-measured with the walks on the measured pool: 24 line-mode plans at 0.944 (25), 35 expected rises (36);
 *  `costCloseUnder`, the cost-dominant carried nights whose walk past the stop closes under the line, each sized short (its
 *  caps note stands) and naming that close in one NOTE. */
// v1.203.0 — and the lines in (49, 50] (8 on nameplate, 7 at 0.944), which the 50% reserve holds at 49: each carried, in line mode
// (lineMode +5 / +5), its expected buy above v1.202.0's (expectedRose +9).
// v1.205.0 — a cost-carried night's close past its stop is capped at the window's reach (H1, as a line walk's): three more of the
// nights sized short on each pool name a close under their line (costCloseUnder 2 → 5); none held flips.
const PIN_T4 = { carried: [30, 44], disclosedOn: [0, 0], lineMode: [19, 29], costCloseUnder: [5, 5], expectedRose: 44 };
/** Measured (v1.200.0 review) on the same year: carried plans whose setpoint is the force-charge's own ask; and of
 *  the line-mode plans with an expected figure, those whose expected buy exceeds the worst case (and the de-biased
 *  one), with and without a predicted window EV. */
/** (review 2, finding 4) `ceilingStop` — the line-mode plans whose expected walk reaches the panel ceiling (the panel
 *  switches Charge Now off there): 2026-10-29 21:30 and 13:00 and 2027-01-04 +1 01:30, at both scales. (A5, H1) 2026-10-29
 *  +1 01:30 left the list: its window cannot deliver the walk's lift, and the most it can reach (~63.9%) is under the
 *  80% ceiling, so no stop is stated (T21b). */
/** v1.202.0 — re-measured on the measured pool: 38 line-mode plans with an expected figure (39), 25 over the worst case (24),
 *  21 over the de-biased one (20), 19 with no EV (20); 8 walks reach the panel ceiling (6): on the measured pool the same
 *  lift is more points, and 2027-01-04 21:30 and 13:00 at 0.944 reach the 80% ceiling too (T1). */
// v1.203.0 — with the lines in (49, 50]: their setpoint is the 50% write and their ask 51 (setpointIsAsk unchanged); 10 more line-mode
// plans with an expected figure, 3 of them over the worst case.
const PIN_T4_REVIEW = { setpointIsAsk: 32, expLine: 48, expOverWorst: 28, expOverDebiased: 22, expLineNoEv: 26, expOverWorstNoEv: 14, ceilingStop: 8 };

/** The sizing fields no part of v1.200.0 may move (I-A1). */
const SIZING = ['chargeTonight', 'buyKwh', 'buyKwhDebiased', 'requiredExtraKwh', 'targetSocPct', 'setpointSocPct',
  'costCeilingSocPct', 'cushionTroughSocPct', 'cushionLineSocPct', 'bindingCap', 'minProjSocPct'] as const;
const sizing = (p: NightChargePlan) => Object.fromEntries(SIZING.map((k) => [k, p[k] ?? null]));

const CASES = legacyIdentityCases();
const caseOf = (label: string) => CASES.find((c) => c.label === label)!;
const yearPlan = (label: string, line: boolean | undefined, scale: CushionPoolScale | null = S944): NightChargePlan => {
  const c = caseOf(label);
  const deps = { ...c.deps, ...(scale != null ? { cushionPoolScale: scale } : {}), ...(line !== undefined ? { lineForceChargeEligible: line } : {}) };
  return computeNightChargePlan(buildNightChargeInputs(deps as never));
};
type LinePlan = NightChargePlan & {
  forceChargeLine?: { askPct: number; linePct: number };
  cushionShortfallCause?: 'envelope' | 'envelope+caps';
  expectedForceChargeMode?: 'line';
  cushionEnvelopeReason?: string;
  expectedLineCeilingStop?: { ceilingPct: number; startTargetPct: number };
};
const L = (p: NightChargePlan): LinePlan => p as LinePlan;

/* ══ T1 — the 2027-01-04 21:30 shape at 0.944 (line 55.55) ═════════════════════════════════════════ */

test('★★★ T1 2027-01-04 21:30 at 0.944: eligible ⇒ carried {56, 55.55} to the window close; sizing untouched', () => {
  const base = yearPlan('2027-01-04 21:30', undefined);
  const p = L(yearPlan('2027-01-04 21:30', true));
  // The defect as it stands: a charge night, the line 55.55, written 50, no shortfall, nothing past the 50% reserve
  // (v1.202.0: ~0.1 kWh expected to it, the pool opening at ~49.9% of the measured pool; "no charge expected" on nameplate).
  assert.equal(base.chargeTonight, true);
  assert.equal(base.cushionLineSocPct, 55.55);
  assert.equal(chargeReservePct(base), 50);
  assert.equal(base.cushionShortfall, false);
  assert.match(base.rationale, /^Charge to ~50% in the 23:00–05:00 window: ~0\.1 kWh expected\. /);

  assert.deepEqual(p.forceChargeLine, { askPct: 56, linePct: 55.55 });
  assert.deepEqual(Object.keys(p.forceChargeLine!), ['askPct', 'linePct'], 'one whole percent and the line — no capacity, no load');
  assert.equal(p.cushionShortfall, false, 'carried: the plan claims the cushion, and the force-charge holds it');
  assert.equal('cushionShortfallCause' in p, false);
  assert.equal(chargeReservePct(p), 50, 'the written reserve is still the panel maximum');
  assert.deepEqual(sizing(p), sizing(base), 'I-A1: no sizing figure moves');
  assert.equal(p.expectedForceChargeMode, 'line');
  // The expected walk: the reserve leg tops the pool up to the reserve (it opens ~49.9%), the house draws it, the line
  // force-charge starts timed to 61% twenty minutes before the 05:00 close and runs until the panel's 80% ceiling.
  assert.equal(p.expectedWriteLevelPct, PIN_T1.level);
  assert.equal(p.expectedForceChargeStartMs, PIN_T1.startMs);
  assert.equal(p.expectedBuyKwh, PIN_T1.buyKwh);
  assert.ok(p.expectedWriteLevelPct! >= 61, 'the expected close is at least the timed level');
  assert.equal(chargeLevelPct(p), p.expectedWriteLevelPct, 'every line states the expected close');
  // The rationale (§5.7 wording; v1.202.0, the walk reaching the panel ceiling: the review-2 sentence).
  assert.deepEqual(p.expectedLineCeilingStop, { ceilingPct: 80, startTargetPct: 61 });
  assert.ok(p.rationale.includes(
    `The reserve is set to 50%, the most the panel accepts as a backup reserve; tonight's 55.55% outage line is above it, so the panel's force-charge switches on at ~${PIN_T1.at} and runs until the panel switches it off at its 80% ceiling; the add-on switches it back on if the pool falls under 61% before the window closes (at most twice), ~${PIN_T1.level}% expected at the close. After the window the reserve returns to 30% and the house can draw the pool down as usual.`),
  p.rationale);
  assert.doesNotMatch(p.rationale, /only accepts a backup reserve up to 50%|residual risk|charge\/pool caps/);
  assert.match(p.rationale, new RegExp(`^Charge to ~${PIN_T1.level}% in the `), 'the headline names the expected close');
});

test('★★★ T1 not eligible (advisory) ⇒ DISCLOSED: cushionShortfall with the cause "envelope", the sized trough unchanged', () => {
  const base = yearPlan('2027-01-04 21:30', undefined);
  const p = L(yearPlan('2027-01-04 21:30', false));
  assert.equal(p.cushionShortfall, true);
  assert.equal(p.cushionShortfallCause, 'envelope');
  assert.equal('forceChargeLine' in p, false);
  assert.equal('expectedForceChargeMode' in p, false);
  assert.equal(p.cushionTroughSocPct, base.cushionTroughSocPct, 'L1: the trough stays the sized one');
  assert.equal(p.cushionTroughSocPct, 55.55);
  assert.deepEqual(sizing(p), sizing(base));
  assert.equal(p.expectedBuyKwh, base.expectedBuyKwh, 'advisory: the expected walk is today\'s');
  assert.ok(p.rationale.includes("The reserve is set to 50%, the most the panel accepts as a backup reserve; tonight's 55.55% outage line is above it and no force-charge runs in advisory mode, so the cushion is not fully held — residual risk remains."), p.rationale);
  assert.doesNotMatch(p.rationale, /charge\/pool caps/, 'the caps note only where the sizing itself fell short');
  assert.doesNotMatch(p.rationale, /only accepts a backup reserve up to 50%/, 'one sentence about the envelope, not two');
});

test('★★★ T1 absent ⇒ v1.199.1 byte for byte (the nameplate golden digest; the measured figures unchanged)', () => {
  const c = caseOf('2027-01-04 21:30');
  assert.equal(planDigest(computeNightChargePlan(buildNightChargeInputs(c.deps))), GOLDEN.digests[c.label]);
  const p = yearPlan('2027-01-04 21:30', undefined);
  assert.equal('forceChargeLine' in p || 'cushionShortfallCause' in p || 'expectedForceChargeMode' in p, false);
});

/* ══ T2 — 2026-10-29 21:30 at 0.944: the plan that said nothing about the 50% write ═════════════════ */

test('★★★ T2 2026-10-29 21:30 at 0.944 (line 65.95, setpoint = target = 66): the envelope is stated either way', () => {
  const base = yearPlan('2026-10-29 21:30', undefined);
  assert.equal(base.cushionLineSocPct, 65.95);
  assert.equal(base.setpointSocPct, 66);
  assert.equal(base.targetSocPct, 66);
  assert.doesNotMatch(base.rationale, /outage line|only accepts/, 'precondition: today the rationale is silent');
  const carried = L(yearPlan('2026-10-29 21:30', true));
  assert.deepEqual(carried.forceChargeLine, { askPct: 66, linePct: 65.95 });
  // (review 2) its expected walk reaches the 80% panel ceiling (a predicted EV pulls the start to the open): the
  // rationale says the panel switches it off there, never that it stays on until the window closes.
  assert.match(carried.rationale, /tonight's 65\.95% outage line is above it, so the panel's force-charge switches on at ~\S+ and runs until the panel switches it off at its 80% ceiling; the add-on switches it back on if the pool falls under 71% before the window closes \(at most twice\), ~[\d.]+% expected at the close\./);
  assert.doesNotMatch(carried.rationale, /stays on until the window closes/);
  const disclosed = L(yearPlan('2026-10-29 21:30', false));
  assert.equal(disclosed.cushionShortfallCause, 'envelope');
  assert.match(disclosed.rationale, /tonight's 65\.95% outage line is above it and no force-charge runs in advisory mode, so the cushion is not fully held — residual risk remains\./);
});

/* ══ T3 — what does not qualify, and the edges ═════════════════════════════════════════════════════ */

const B = Date.UTC(2026, 9, 20, 4); // 21:00 MST
const horizon = (loadP90W: number) =>
  Array.from({ length: 30 }, (_, i) => ({ ts: B + i * H, pvP10W: 0, loadP90W, loadP50W: loadP90W / 1.35, pvP50W: 0 }));
/** A 92.16 kWh pool, a 30% floor, 8 h × 2.09 kW × 1.25 ÷ 0.94 = 22.23 kWh of cushion (line 54.12%), 30% at
 *  21:00, a 23:00–05:00 window, a 2 kW P90 house, no sun, resilience. */
const inputs = (o: Partial<NightChargeInputs> & { lineForceChargeEligible?: boolean } = {}): NightChargeInputs => ({
  nowMs: B, fullKwh: 92.16, socNowPct: 30, reserveFloorPct: 30, cushionPct: 15, socCoherent: true,
  islandedLoadKw: 2.09, outageCushionHours: 8, islandedLoadSafety: 1.25,
  legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 17.8, gridInputCapKw: 17,
  window: { startMs: B + 2 * H, endMs: B + 8 * H }, horizon: horizon(2000),
  morningPvSurplusP90Kwh: null, confidenceTier: 'forecast', basisComplete: true, minBuyKwh: 1,
  objectiveMode: 'resilience',
  ...o,
} as NightChargeInputs);
const plan = (o: Parameters<typeof inputs>[0] = {}): LinePlan => L(computeNightChargePlan(inputs(o)));

test('★★★ T3 the scenario qualifies: line 54.12, ask 55 — carried when eligible, disclosed when not, today\'s when absent', () => {
  const absent = plan();
  assert.equal(absent.cushionLineSocPct, 54.12);
  assert.equal(absent.chargeTonight, true);
  assert.deepEqual(plan({ lineForceChargeEligible: true }).forceChargeLine, { askPct: 55, linePct: 54.12 });
  assert.equal(plan({ lineForceChargeEligible: false }).cushionShortfallCause, 'envelope');
  assert.equal(planDigest(plan({ lineForceChargeEligible: undefined })), planDigest(absent));
});

test('★★★ T3 non-qualifying: ask = 49 (v1.203.0; 50 qualifies), legacy-pct, disabled, economic-only cost, a hold — no field, no disclosure, today\'s plan', () => {
  const same = (o: Parameters<typeof inputs>[0], why: string) => {
    const a = plan(o);
    for (const e of [true, false]) {
      const p = plan({ ...o, lineForceChargeEligible: e });
      assert.equal(planDigest(p), planDigest(a), `${why} (eligible ${e})`);
    }
    return a;
  };
  // v1.203.0 — the edge is ask 49, not 50: the panel holds the pool one point under a reserve it charged up to, so the 50% write
  // holds 49 and a line in (49, 50] is the line force-charge's (lineNeedsForceCharge). 8 h × 1.64 kW: line 48.93, ask 49, written
  // 50 — the reserve holds it at 49; P-i (`>=` on the point) would carry it.
  const at49 = same({ islandedLoadKw: 1.64 }, 'ask 49');
  assert.equal(at49.cushionLineSocPct, 48.93);
  assert.equal(Math.ceil(at49.cushionLineSocPct! - 1e-9), 49);
  assert.equal(at49.setpointSocPct, 50, '⌈line⌉ + the panel\'s point');
  assert.equal(at49.chargeTonight, true);
  // 1.73 kW (line 49.97, ask 50): the 50% reserve holds 49, under it. Carried by the line force-charge, asked one point above the
  // reserve (51, the least it rides on), the write the 50% maximum; disclosed in advisory mode (v1.202.0: the reserve "held" it).
  const at50 = plan({ islandedLoadKw: 1.73, lineForceChargeEligible: true });
  assert.equal(at50.cushionLineSocPct, 49.97);
  assert.deepEqual(at50.forceChargeLine, { askPct: 51, linePct: 49.97 });
  assert.equal(at50.setpointSocPct, 50);
  assert.match(at50.rationale, /The reserve is set to 50%, the most the panel accepts as a backup reserve; the panel holds a pool it charges to that reserve at 49%, under tonight's 49\.97% outage line, so the panel's force-charge /);
  const at50Off = plan({ islandedLoadKw: 1.73, lineForceChargeEligible: false });
  assert.deepEqual([at50Off.cushionShortfallCause, at50Off.cushionEnvelopeReason, 'forceChargeLine' in at50Off], ['envelope', 'advisory', false]);
  assert.equal(computeNightChargePlan(inputs({ islandedLoadKw: 1.73, lineForceChargeEligible: true }), 0).forceChargeLine, undefined, 'v1.202.0: none');
  // …and 1.74 kW (line 50.08, ask 51) is above it.
  assert.deepEqual(plan({ islandedLoadKw: 1.74, lineForceChargeEligible: true }).forceChargeLine, { askPct: 51, linePct: 50.08 });
  // legacy-pct (no islanded measurement), a 25% band: the setpoint is the whole-house walk, not a line at the close.
  const legacy = same({ islandedLoadKw: null, cushionPct: 25 }, 'legacy-pct');
  assert.equal(legacy.cushionBasis, 'legacy-pct');
  // disabled: the line is the floor.
  assert.equal(same({ outageCushionHours: 0 }, 'disabled').cushionBasis, 'disabled');
  // economic-only cost: the pack already holds the line with no buy; the buy is the cost target's.
  const econ = same({ socNowPct: 92, objectiveMode: 'cost', costMaxSocPct: 100, forceChargeEligible: true }, 'economic-only');
  assert.equal(econ.chargeTonight, true);
  assert.equal(econ.requiredExtraKwh, 0, 'precondition: economic only (P-ii drops this test)');
  // a resilience hold: nothing is armed.
  assert.equal(same({ socNowPct: 95 }, 'hold').chargeTonight, false);
});

test('★★★ T3 the backup leg is DISCLOSED whatever the eligibility; (A5) ask + 10 > 100 is ARMED and disclosed (nearFull)', () => {
  const backup = { kind: 'overnight' as const, role: 'backup' as const };
  for (const e of [true, false]) {
    const p = plan({ windowSpec: backup, lineForceChargeEligible: e });
    assert.equal('forceChargeLine' in p, false, `backup (eligible ${e})`);
    assert.ok(p.cushionShortfallCause === 'envelope' || p.cushionShortfallCause === 'envelope+caps', `backup cause ${p.cushionShortfallCause}`);
    assert.match(p.rationale, /outage line is above it and the outage backup leg writes the reserve only, so the cushion is not fully held — residual risk remains\./);
  }
  // buildNightChargeInputs never hands the backup leg an eligible line (legForceChargeEligible).
  const c = caseOf('2027-01-04 21:30');
  assert.equal(buildNightChargeInputs({ ...c.deps, lineForceChargeEligible: true, windowSpec: backup } as never).lineForceChargeEligible, false);
  // 8 h × 5.4 kW: line 92.34, ask 93 — 93 + 10 > 100: no headroom for the panel ceiling over the line. (A5) The
  // force-charge is ARMED all the same (a higher line never switches it off), runs as a 90% line does (start 95,
  // ceiling 100), and the plan does not claim the line: disclosed, 'nearFull'.
  const high = plan({ islandedLoadKw: 5.4, lineForceChargeEligible: true });
  assert.equal(high.cushionLineSocPct, 92.34);
  assert.deepEqual(high.forceChargeLine, { askPct: 93, linePct: 92.34 });
  assert.equal(high.cushionShortfallCause, 'envelope', 'the sizing held the line: the envelope alone');
  assert.equal(high.cushionEnvelopeReason, 'nearFull');
  assert.equal(high.cushionShortfall, true);
  assert.equal(high.expectedForceChargeMode, 'line');
  assert.equal(high.expectedWriteLevelPct, 99.6);
  assert.deepEqual(high.expectedLineCeilingStop, { ceilingPct: 100, startTargetPct: 95 });
  assert.ok(high.rationale.includes("tonight's 92.34% outage line is above it, so the panel's force-charge switches on at ~01:33 and runs until the panel switches it off at its 100% ceiling; "
    + 'the add-on switches it back on if the pool falls under 95% before the window closes (at most twice), ~99.6% expected at the close. After the window the reserve returns to 30% and the house can draw the pool down as usual. '
    + "NOTE: tonight's 92.34% outage line is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin; the cushion is not assured — residual risk remains."), high.rationale);
  assert.doesNotMatch(high.rationale, /too close to a full pool|no force-charge|not held tonight/);
  // The ask the plan carries and the line it qualifies on are one expression (askOf).
  assert.equal(nca.askOf(54.12 / 100 * 92.16, 92.16), 55);
  assert.equal(nca.askOf(0.5 * 92.16, 92.16), 50, 'a line exactly at 50 asks 50');
});

test('★★★ T3 (review) a minimum-buy HOLD that is not economic-only is never carried or disclosed; ⌈L⌉ 90 is carried and (A5) 91 armed and disclosed', () => {
  // A 100 kWh minimum buy holds the 54.12% line's 36.7 kWh charge: chargeTonight false, though the pack does NOT
  // hold the line on its own (baselineHolds false) — nothing is armed, so nothing rides and nothing is claimed.
  const starved = plan({ minBuyKwh: 100 });
  assert.equal(starved.chargeTonight, false);
  assert.ok((starved.requiredExtraKwh ?? 0) > 0, 'precondition: not economic-only (the P-x mutant reaches it)');
  assert.equal(starved.cushionLineSocPct, 54.12);
  for (const e of [true, false]) {
    const p = plan({ minBuyKwh: 100, lineForceChargeEligible: e });
    assert.equal(planDigest(p), planDigest(starved), `a hold (eligible ${e}) moved`);
    assert.equal('forceChargeLine' in p, false);
    assert.equal(p.cushionShortfallCause ?? null, null);
  }
  // The edge of the panel ceiling's headroom: ⌈L⌉ + 10 ≤ 100 (P-xi: >= would disclose 90).
  const at90 = plan({ islandedLoadKw: 5.19, lineForceChargeEligible: true });
  assert.equal(at90.cushionLineSocPct, 89.91);
  assert.deepEqual(at90.forceChargeLine, { askPct: 90, linePct: 89.91 });
  assert.equal(at90.cushionShortfallCause ?? null, null);
  assert.equal(at90.cushionShortfall, false);
  const at91 = plan({ islandedLoadKw: 5.2, lineForceChargeEligible: true });
  assert.equal(at91.cushionLineSocPct, 90.03);
  assert.deepEqual(at91.forceChargeLine, { askPct: 91, linePct: 90.03 }, 'A5: armed, whatever the ask');
  assert.equal(at91.cushionShortfallCause, 'envelope');
  assert.equal(at91.cushionEnvelopeReason, 'nearFull');
  // Both run the same force-charge (start 95, ceiling 100) and walk alike: one claims the line, one does not.
  assert.equal(at91.expectedWriteLevelPct, at90.expectedWriteLevelPct);
  assert.deepEqual(at91.expectedLineCeilingStop, at90.expectedLineCeilingStop);
  assert.deepEqual(at90.expectedLineCeilingStop, { ceilingPct: 100, startTargetPct: 95 });
});

test('★★★ T3 the envelope is OR-ed in AFTER the cost block: a disclosed cost night keeps its de-biased ceiling', () => {
  // A cost night over the envelope (line 54.12) whose de-biased morning surplus widens the headroom: the
  // cost ceiling reads the SIZED flag (debiasedCostSurplusKwh), so the disclosure must not move it (P-iv).
  const cost = {
    objectiveMode: 'cost' as const, costMaxSocPct: 90, forceChargeEligible: true, morningPvSurplusP50Kwh: 20, morningPvSurplusP90Kwh: 30,
    costSurplusLoad: { factor: 0.8, basis: 'measured' as const, samples: 10, p50Kwh: 35, p90Kwh: 45 },
  };
  const absent = plan(cost);
  assert.equal(absent.chargeTonight, true);
  assert.ok((absent.requiredExtraKwh ?? 0) > 0, 'precondition: not economic-only');
  assert.equal(absent.costCeilingSurplusKwh, 35, 'precondition: the de-biased surplus set the ceiling');
  const disclosed = plan({ ...cost, lineForceChargeEligible: false });
  assert.equal(disclosed.cushionShortfallCause, 'envelope');
  assert.equal(disclosed.costCeilingSocPct, absent.costCeilingSocPct);
  assert.equal(disclosed.costCeilingSurplusKwh, 35);
});

/* ══ T4 — the year (I-A1, I-A4, I-A5, I-A6) ══════════════════════════════════════════════════════════ */

test('★★★ T4 the year: no sizing figure moves, every over-envelope charge plan is carried or disclosed, counts as measured', () => {
  const counts: Record<string, number> = {};
  const add = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  let expectedRose = 0;
  for (const c of CASES) {
    for (const [scaleName, scale] of [['np', null], ['m', S944]] as const) {
      const deps = scale != null ? { ...c.deps, cushionPoolScale: scale } : c.deps;
      const base = computeNightChargePlan(buildNightChargeInputs(deps));
      const on = L(computeNightChargePlan(buildNightChargeInputs({ ...deps, lineForceChargeEligible: true } as never)));
      const off = L(computeNightChargePlan(buildNightChargeInputs({ ...deps, lineForceChargeEligible: false } as never)));
      for (const [k, p] of [['on', on], ['off', off]] as const) {
        assert.deepEqual(sizing(p), sizing(base), `${c.label} ${scaleName} ${k}: I-A1`);
        assert.equal(p.cushionTroughSocPct ?? null, base.cushionTroughSocPct ?? null, `${c.label}: I-A5 trough`);
        assert.ok(!(base.cushionShortfall && !p.cushionShortfall), `${c.label}: I-A5 a shortfall vanished`);
        if (p.cushionShortfall !== base.cushionShortfall) assert.ok(p.cushionShortfallCause != null, `${c.label}: a new shortfall names its cause`);
      }
      // Review 16 — the defect's own counts (v1.199.1's plans, no eligibility): over-envelope charge plans that
      // CLAIMED the cushion; of them, those with no cost force-charge stop at or above the line; and the SILENT
      // ones — no statement of the 50% write AND no cost stop covering the line.
      if (base.chargeTonight && base.cushionBasis === 'islanded-outage' && (base.cushionLineSocPct ?? 0) > 50.05 && !base.cushionShortfall) {
        add(`claimed.${scaleName}`);
        const fcCovers = base.costCeilingSocPct != null && forceChargeStopPct(base.costCeilingSocPct) >= base.cushionLineSocPct!;
        if (!fcCovers) add(`claimedNoFc.${scaleName}`);
        if (!fcCovers && !/only accepts a backup reserve up to 50%/.test(base.rationale)) add(`silent.${scaleName}`);
      }
      const lineAsk = base.cushionLineSocPct != null ? Math.ceil(base.cushionLineSocPct - 1e-9) : 0;
      // v1.203.0 — the overnight leg's test: the line's whole percent and the panel's point above 50 (nca.lineNeedsForceCharge), a
      // line in (49, 50] included. (The case's own line, not its round2: the ask of the planner's own figures.)
      const qualifies = base.chargeTonight && base.cushionBasis === 'islanded-outage' && (base.requiredExtraKwh ?? 0) > 0
        && nca.lineNeedsForceCharge(nca.askOf((base.cushionLineSocPct! / 100) * c.deps.fullKwh, c.deps.fullKwh));
      assert.ok(Math.abs(lineAsk - (qualifies ? Math.ceil(base.cushionLineSocPct! - 1e-9) : lineAsk)) < 1e-9);
      const at2130 = c.label.endsWith('21:30');
      if (qualifies) {
        add(`q.${scaleName}`); if (at2130) add(`q2130.${scaleName}`);
        if (base.cushionShortfall) add(`sized.${scaleName}`);
        // I-A4 — the carrier invariant (tripwire): carried, or disclosed; never neither.
        assert.ok(on.forceChargeLine != null || on.cushionShortfallCause != null, `${c.label} ${scaleName}: uncarried and undisclosed (eligible)`);
        assert.ok(off.cushionShortfallCause != null, `${c.label} ${scaleName}: undisclosed (not eligible)`);
        if (on.forceChargeLine != null) add(`carried.${scaleName}`); else add(`disclosedOn.${scaleName}`);
        if (on.expectedForceChargeMode === 'line') add(`lineMode.${scaleName}`);
        // Review 8 — ONE ask: where the setpoint is the line's own ask (the line binds it), the force-charge
        // carries that very percent (askOf on both paths).
        if (on.forceChargeLine != null && on.setpointSocPct === on.forceChargeLine.askPct) add('setpointIsAsk');
        // Review 10 — on a line night the expected buy runs to the close (the overshoot), so it usually EXCEEDS
        // the worst-case figure the plan is sized on — with or without a predicted EV.
        if (on.expectedForceChargeMode === 'line' && on.expectedBuyKwh != null) {
          add('expLine');
          const noEv = !((on.evContention?.windowEvKwh ?? 0) > 0);
          if (noEv) add('expLineNoEv');
          if (on.expectedBuyKwh > (on.buyKwh ?? Infinity)) { add('expOverWorst'); if (noEv) add('expOverWorstNoEv'); }
          if (on.expectedBuyKwh > (on.buyKwhDebiased ?? Infinity)) add('expOverDebiased');
        }
        // Review 2 (finding 4) — a walk that reaches the panel ceiling (the panel switches Charge Now off there) is
        // worded so, never "stays on until the window closes"; a walk that stays under it keeps those words.
        if (on.expectedForceChargeMode === 'line' && on.expectedForceChargeStartMs != null) {
          if (on.expectedLineCeilingStop != null) {
            add('ceilingStop');
            assert.doesNotMatch(on.rationale, /stays on until the window closes|to the window close and takes it/, `${c.label} ${scaleName}`);
            assert.match(on.rationale, /runs until the panel switches it off at its \d+% ceiling; the add-on switches it back on if the pool falls under \d+% before the window closes \(at most twice\)/, `${c.label} ${scaleName}`);
          } else {
            assert.doesNotMatch(on.rationale, /the panel switches it off at its/, `${c.label} ${scaleName}`);
            assert.match(on.rationale, /stays on until the window closes/, `${c.label} ${scaleName}`);
          }
        }
        // R6d — the line sentence only in line mode: a cost-dominant night's cost force-charge already
        // clears ⌈L⌉ + 10, and its rationale says nothing of the line.
        // v1.202.0 — unless its walk past the stop closes under the line (lineNotHeldOf 'closeUnder', whether or not its sizing
        // fell short): then the one NOTE that names that close is added, and nothing else.
        if (on.forceChargeLine != null && on.expectedForceChargeMode !== 'line') {
          const closeNote = lineNotHeldOf(on) === 'closeUnder'
            ? ` NOTE: on the median load the pool is expected to close at ~${(on as { expectedCloseAfterStopPct?: number }).expectedCloseAfterStopPct}%, under tonight's ${on.cushionLineSocPct}% outage line, so the cushion is not fully held — residual risk remains.`
            : '';
          if (closeNote !== '') {
            add(`costCloseUnder.${scaleName}`);
            assert.deepEqual([base.cushionShortfall, on.cushionShortfallCause ?? null], [true, null], `${c.label} ${scaleName}: sized short, its caps note stands`);
            assert.equal(on.rationale.split(closeNote).length, 2, `${c.label} ${scaleName}: the close named once`);
          }
          const rest = closeNote !== '' ? on.rationale.replace(closeNote, '') : on.rationale;
          assert.doesNotMatch(rest, /outage line/, `${c.label} ${scaleName}: a cost-dominant night names the line`);
          assert.equal(rest, base.rationale, `${c.label}: a cost-dominant carried night reads as today`);
        }
      } else {
        assert.equal(planDigest(on), planDigest(base), `${c.label} ${scaleName}: a non-qualifying plan moved (eligible)`);
        assert.equal(planDigest(off), planDigest(base), `${c.label} ${scaleName}: a non-qualifying plan moved (not eligible)`);
      }
      // I-A6 — with eligibility the expected buy never falls below v1.199.1 (pinned, not assumed: L6).
      if (base.expectedBuyKwh != null && on.expectedBuyKwh != null) {
        assert.ok(on.expectedBuyKwh >= base.expectedBuyKwh - 1e-9, `${c.label} ${scaleName}: expected buy fell ${base.expectedBuyKwh} → ${on.expectedBuyKwh}`);
        if (on.expectedBuyKwh > base.expectedBuyKwh + 1e-9) expectedRose += 1;
      }
      assert.equal(off.expectedBuyKwh ?? null, base.expectedBuyKwh ?? null, `${c.label}: not eligible, the expected figure is today's`);
    }
  }
  // Design A measured qualifying 22 (nameplate) / 37 (0.944), 8 / 13 at 21:30, 9 / 13 already a sizing shortfall.
  // v1.202.0 — 15 at 0.944 on the measured pool: its walks drain more points before the window.
  // v1.203.0 — 30 / 44: the lines in (49, 50] qualify (the 50% reserve holds them at 49), 3 / 3 of them at 21:30, 4 / 2 sized short.
  assert.deepEqual(
    { q: [counts['q.np'], counts['q.m']], q2130: [counts['q2130.np'], counts['q2130.m']], sized: [counts['sized.np'], counts['sized.m']] },
    { q: [30, 44], q2130: [11, 16], sized: [13, 17] },
  );
  assert.deepEqual(
    { carried: [counts['carried.np'] ?? 0, counts['carried.m'] ?? 0], disclosedOn: [counts['disclosedOn.np'] ?? 0, counts['disclosedOn.m'] ?? 0],
      lineMode: [counts['lineMode.np'] ?? 0, counts['lineMode.m'] ?? 0], costCloseUnder: [counts['costCloseUnder.np'] ?? 0, counts['costCloseUnder.m'] ?? 0], expectedRose },
    PIN_T4,
  );
  assert.deepEqual(
    { claimed: [counts['claimed.np'] ?? 0, counts['claimed.m'] ?? 0], claimedNoFc: [counts['claimedNoFc.np'] ?? 0, counts['claimedNoFc.m'] ?? 0],
      silent: [counts['silent.np'] ?? 0, counts['silent.m'] ?? 0] },
    { claimed: [13, 22], claimedNoFc: [10, 14], silent: [0, 1] },
    'the defect: 13 / 22 (v1.202.0; 24 on v1.199.1\'s walks) claimed the cushion over the envelope; 10 / 14 (15) with no cost stop at the line; 0 / 1 silent (2026-10-29 21:30 at 0.944)',
  );
  assert.deepEqual(
    { setpointIsAsk: counts.setpointIsAsk ?? 0, expLine: counts.expLine ?? 0, expOverWorst: counts.expOverWorst ?? 0,
      expOverDebiased: counts.expOverDebiased ?? 0, expLineNoEv: counts.expLineNoEv ?? 0, expOverWorstNoEv: counts.expOverWorstNoEv ?? 0,
      ceilingStop: counts.ceilingStop ?? 0 },
    PIN_T4_REVIEW,
  );
});

/* ══ T5 — arm and record ═══════════════════════════════════════════════════════════════════════════ */

const WIN_START = Date.UTC(2026, 8, 17, 6, 0); // 23:00 MST
const WIN_END = WIN_START + 6 * H;             // 05:00 MST
const LINE = { askPct: 56, linePct: 55.55 };
const armable = (o: Partial<ArmablePlan> & { forceChargeLine?: typeof LINE | null } = {}): ArmablePlan => ({
  chargeTonight: true, basisComplete: true, buyKwh: 28.3, costCeilingSocPct: null, setpointSocPct: 56,
  window: { startMs: WIN_START, endMs: WIN_END }, forceChargeLine: LINE, ...o,
} as ArmablePlan);
type LineState = NightActuationState & {
  forceChargeLineAskPct: number | null; forceChargeLinePct: number | null;
  forceChargeCeilingSyncedPct: number | null; forceChargeMode: 'cost' | 'line' | null;
};
const arm = (p: ArmablePlan, cost?: boolean, line?: boolean): LineState | null =>
  (armFromPlan as (...a: unknown[]) => NightActuationState | null)(emptyActuationState(), '2026-09-16', p, WIN_START - 2 * H, 30, cost, null, line) as LineState | null;

test('★★★ T5 the record keeps the cost ceiling and the line\'s ask in SEPARATE fields; rides = cost or line', () => {
  const lineOnly = arm(armable(), false, true)!;
  assert.equal(lineOnly.forceChargeLineAskPct, 56);
  assert.equal(lineOnly.forceChargeLinePct, 55.55);
  assert.equal(lineOnly.forceChargeCeilingPct, null, 'the cost ceiling keeps its meaning');
  assert.equal(lineOnly.forceChargeRides, true, 'the line rides the night');
  assert.equal(lineOnly.targetPct, 50);
  const both = arm(armable({ costCeilingSocPct: 60, setpointSocPct: 60 }), true, true)!;
  assert.equal(both.forceChargeCeilingPct, 60, 'A-i: never one stored max(cost, ask)');
  assert.equal(both.forceChargeLineAskPct, 56);
  assert.equal(both.forceChargeRides, true);
  // The line gate off (advisory): no ask recorded; rides only on the cost gate.
  const off = arm(armable(), false, false)!;
  assert.equal(off.forceChargeLineAskPct, null, 'A-ii: the line rides only on its gate');
  assert.equal(off.forceChargeRides, false);
  // Cost off at arm (ARB_COST_MAX_SOC_PCT 50): the line alone.
  const costOff = arm(armable({ costCeilingSocPct: 90, setpointSocPct: 90 }), false, true)!;
  assert.equal(costOff.forceChargeCeilingPct, 90);
  assert.equal(costOff.forceChargeLineAskPct, 56);
  assert.equal(costOff.forceChargeRides, true, 'A-iv: rides ⇐ the line');
  // A plan with no line: today's record exactly (the four new fields null).
  const plain = arm(armable({ forceChargeLine: null, costCeilingSocPct: 90 }), true, true)!;
  assert.deepEqual([plain.forceChargeLineAskPct, plain.forceChargeLinePct, plain.forceChargeCeilingSyncedPct, plain.forceChargeMode], [null, null, null, null]);
  // Omitted gates (every caller before v1.200.0): no line recorded.
  assert.equal(arm(armable())!.forceChargeLineAskPct, null);
  // The empty record has the four fields, null.
  const e = emptyActuationState() as LineState;
  assert.deepEqual([e.forceChargeLineAskPct, e.forceChargeLinePct, e.forceChargeCeilingSyncedPct, e.forceChargeMode], [null, null, null, null]);
});

test('★★★ T5 the backup strip drops the line; a cost leg keeps it (armCycle)', () => {
  const p = armable();
  const r = armCycle(emptyCycle(), '2026-09-16', [
    { role: 'backup', kind: 'overnight', plan: p, forceChargeEnabled: true, lineForceChargeEnabled: true } as never,
  ], WIN_START - 2 * H, 30);
  assert.equal(r.legs.length, 1);
  assert.equal((r.legs[0] as LineState).forceChargeLineAskPct, null, 'A-iii: a backup leg never force-charges the line');
  assert.equal(r.legs[0].forceChargeRides, false);
  const cost = armCycle(emptyCycle(), '2026-09-16', [
    { role: 'cost', kind: 'overnight', plan: p, forceChargeEnabled: false, lineForceChargeEnabled: true } as never,
  ], WIN_START - 2 * H, 30);
  assert.equal((cost.legs[0] as LineState).forceChargeLineAskPct, 56);
});

test('★★★ T5 coercion: a finite ask is kept (ceil, [51, 100]); a non-number is dropped; the synced ceiling only in [80, 100]', () => {
  const raw = (o: Record<string, unknown>) => coerceActuationState(JSON.parse(JSON.stringify({ ...emptyActuationState(), day: '2026-09-16', ...o }))) as LineState;
  assert.equal(raw({ forceChargeLineAskPct: 56 }).forceChargeLineAskPct, 56);
  assert.equal(raw({ forceChargeLineAskPct: 55.2 }).forceChargeLineAskPct, 56, 'never lowered');
  assert.equal(raw({ forceChargeLineAskPct: 40 }).forceChargeLineAskPct, 51);
  assert.equal(raw({ forceChargeLineAskPct: 150 }).forceChargeLineAskPct, 100);
  assert.equal(raw({ forceChargeLineAskPct: '56' }).forceChargeLineAskPct, null);
  assert.equal(raw({}).forceChargeLineAskPct, null);
  assert.equal(raw({ forceChargeLinePct: 55.55 }).forceChargeLinePct, 55.55);
  assert.equal(raw({ forceChargeLinePct: 'x' }).forceChargeLinePct, null);
  assert.equal(raw({ forceChargeCeilingSyncedPct: 88 }).forceChargeCeilingSyncedPct, 88);
  assert.equal(raw({ forceChargeCeilingSyncedPct: 20 }).forceChargeCeilingSyncedPct, null, 'a synced value the panel cannot hold is no ceiling');
  assert.equal(raw({ forceChargeMode: 'line' }).forceChargeMode, 'line');
  assert.equal(raw({ forceChargeMode: 'cost' }).forceChargeMode, 'cost');
  assert.equal(raw({ forceChargeMode: 'bogus' }).forceChargeMode, null);
});

/* ══ T6 — decide ═══════════════════════════════════════════════════════════════════════════════════ */

const night = (over: Partial<LineState> = {}): LineState => ({
  ...emptyActuationState(),
  day: '2026-09-16', targetPct: 50, buyKwh: 28,
  windowStartMs: WIN_START, windowEndMs: WIN_END,
  applyAttemptedAtMs: WIN_START - 5 * M, attemptBaselinePct: 30,
  appliedAtMs: WIN_START - 5 * M, priorReservePct: 30,
  applyVerifiedAtMs: WIN_START + M,
  forceChargeCeilingPct: null, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55,
  forceChargeCeilingSyncedPct: null, forceChargeMode: null, forceChargeRides: true,
  ...over,
} as LineState);
const onNight = (over: Partial<LineState> = {}): LineState => night({
  forceChargeOnAtMs: WIN_START + 2 * H, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: WIN_START + 2 * H + 5 * M,
  forceChargeMode: 'line', ...over,
});
const fo = (over: Partial<ForceChargeOpts> & { lineEnabled?: boolean } = {}): ForceChargeOpts => ({
  enabled: false, lineEnabled: true, gridPresent: true, gridStaLost: false,
  slotsOn: [], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 80, poolSocPct: 50, fullKwh: 92.16, chargeRateKw: 14,
  ...over,
} as ForceChargeOpts);
/** The first tick (one a minute across the window) whose decision is `on`, as minutes before the close. */
const firstOnBeforeClose = (s: LineState, o: ForceChargeOpts): number | null => {
  for (let t = WIN_START; t < WIN_END; t += M) if (decideForceCharge(s, t, o).kind === 'on') return (WIN_END - t) / M;
  return null;
};

test('★★★ T6 forceChargeModeOf: cost alone is today; the line; cost-dominant at ⌈L⌉ + 10; the live gates decide', () => {
  const mode = (c: number | null, ask: number | null, cost: boolean, line: boolean) =>
    nfc.forceChargeModeOf({ forceChargeCeilingPct: c, forceChargeLineAskPct: ask } as never, { cost, line });
  assert.deepEqual(mode(90, null, true, true), { kind: 'cost', targetPct: 90, panelCeilingPct: 90 });
  assert.deepEqual(mode(72.8, null, true, false), { kind: 'cost', targetPct: 72.8, panelCeilingPct: 80 });
  assert.deepEqual(mode(null, 56, false, true), { kind: 'line', targetPct: 56, askPct: 56, startTargetPct: 61, panelCeilingPct: 80 });
  assert.deepEqual(mode(66, 56, true, true), { kind: 'cost', targetPct: 66, panelCeilingPct: 80 }, 'a cost stop at ⌈L⌉ + 10 already clears the line');
  assert.deepEqual(mode(65.9, 56, true, true), { kind: 'line', targetPct: 65.9, askPct: 56, startTargetPct: 65.9, panelCeilingPct: 80 }, 'F-vi: under ⌈L⌉ + 10 the line runs to the close');
  assert.deepEqual(mode(90, 56, false, true), { kind: 'line', targetPct: 56, askPct: 56, startTargetPct: 61, panelCeilingPct: 80 }, 'R4: the cost gate off ⇒ the ask, never the cost ceiling');
  assert.deepEqual(mode(48, 56, true, true), { kind: 'line', targetPct: 56, askPct: 56, startTargetPct: 61, panelCeilingPct: 80 });
  assert.deepEqual(mode(null, 78, false, true), { kind: 'line', targetPct: 78, askPct: 78, startTargetPct: 83, panelCeilingPct: 88 }, 'F-v: ⌈L⌉ + 10, never + 5');
  assert.deepEqual(mode(null, 90, false, true), { kind: 'line', targetPct: 90, askPct: 90, startTargetPct: 95, panelCeilingPct: 100 });
  assert.equal(mode(90, 56, false, false), null, 'advisory: no mode');
  assert.equal(mode(null, null, true, true), null);
  assert.equal(mode(50, null, true, true), null, 'a cost ceiling at the reserve is no mode');
  assert.equal(nfc.FORCE_CHARGE_LINE_HEADROOM_PCT, 5);
  assert.equal(nfc.lineForceChargeEnabled({ mode: 'advisory' }), false);
  assert.equal(nfc.lineForceChargeEnabled({ mode: 'supervised' }), true);
  assert.equal(nfc.lineForceChargeEnabled({ mode: 'auto' }), true);
});

test('★★★ T6 a cost-dominant record decides exactly as today (the line rides no tick there)', () => {
  const s = (ask: number | null) => night({ forceChargeCeilingPct: 90, forceChargeLineAskPct: ask, forceChargeLinePct: ask == null ? null : 55.55 });
  for (const pool of [20, 45, 60, 85, 89, 90, 95]) {
    for (let t = WIN_START - H; t <= WIN_END + H; t += 20 * M) {
      for (const ceil of [80, 90]) {
        const o = fo({ enabled: true, poolSocPct: pool, ceilingReadbackPct: ceil });
        assert.deepEqual(decideForceCharge(s(56), t, o), decideForceCharge(s(null), t, o), `pool ${pool} t ${(t - WIN_START) / M}`);
        const on = { forceChargeOnAtMs: WIN_START + H, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: WIN_START + H + 5 * M };
        assert.deepEqual(decideForceCharge({ ...s(56), ...on }, t, o), decideForceCharge({ ...s(null), ...on }, t, o));
      }
    }
  }
});

test('★★★ T6 I-A2: a record with no line ask decides exactly as before, whatever the line gate', () => {
  for (const target of [null, 40, 48, 50, 51, 60, 80.4, 90, 100]) {
    for (const pool of [null, 0, 30, 49, 50, 51, 61, 79, 80, 90, 100]) {
      for (let t = WIN_START - 30 * M; t <= WIN_END + 30 * M; t += 25 * M) {
        for (const enabled of [true, false]) {
          for (const onAt of [null, WIN_START + H]) {
            const s = night({ forceChargeCeilingPct: target, forceChargeLineAskPct: null, forceChargeLinePct: null, forceChargeOnAtMs: onAt, forceChargeSlots: onAt == null ? null : [1, 2, 3] });
            const base = decideForceCharge(s, t, { ...fo({ enabled, poolSocPct: pool }), lineEnabled: undefined } as ForceChargeOpts);
            for (const line of [true, false]) assert.deepEqual(decideForceCharge(s, t, fo({ enabled, lineEnabled: line, poolSocPct: pool })), base);
          }
        }
      }
    }
  }
});

test('★★★ T6 the start: a 1-point lift STARTS (outside the dead zone), timed to ⌈L⌉ + 5 at the close − 20 min', () => {
  // ⌈L⌉ 51 from a 50% pool: 6 points to 56% of 92.16 kWh = 5.53 kWh at 14 kW = 23.7 min, + the 15 min buffer,
  // counted back from 20 min before the close: 58.7 min ⇒ the first whole-minute tick 58 min before it.
  assert.equal(firstOnBeforeClose(night({ forceChargeLineAskPct: 51, forceChargeLinePct: 50.08 }), fo({ poolSocPct: 50 })), 58);
  // Today's path for the same ask as a cost ceiling: 0.92 kWh ⇒ 19 min before the close, in the dead zone — never.
  assert.equal(firstOnBeforeClose(night({ forceChargeCeilingPct: 51, forceChargeLineAskPct: null }), fo({ enabled: true, lineEnabled: false, poolSocPct: 50 })), null);
  // A pool at ⌈L⌉ + 3 still starts (F-iv): 2 points ⇒ 7.9 min + 15 + 20 ⇒ 42 min before the close.
  assert.equal(firstOnBeforeClose(night({ forceChargeLineAskPct: 51 }), fo({ poolSocPct: 54 })), 42);
  // At or above the start target: due at the close − 20 − 15 min; under the panel ceiling still due.
  assert.equal(firstOnBeforeClose(night(), fo({ poolSocPct: 61 })), 35);
  assert.equal(firstOnBeforeClose(night(), fo({ poolSocPct: 79 })), 35);
  // At the panel ceiling the panel would not import: nothing starts.
  assert.equal(firstOnBeforeClose(night(), fo({ poolSocPct: 80 })), null);
  const why = (decideForceCharge(night(), WIN_END - 2 * H, fo({ poolSocPct: 80 })) as { why?: string }).why ?? '';
  assert.match(why, /80% panel ceiling/);
  // The helper: the same start, counted back from 20 min before the end.
  assert.equal(nfc.forceChargeLineStartAtMs(WIN_END, 61, 61, 92.16, 14, null, 3), WIN_END - FORCE_CHARGE_MIN_RUN_MS - FORCE_CHARGE_JIT_BUFFER_MS);
});

test('★★★ T6 line mode has no software stop: ON to the window close; OFF at windowEnd (and the other OFF triggers)', () => {
  for (const pool of [56, 61, 70, 79, 80, 95]) {
    const a = decideForceCharge(onNight(), WIN_END - 10 * M, fo({ poolSocPct: pool, slotsOn: [1, 2, 3] }));
    assert.notEqual(a.kind, 'off', `pool ${pool}: ${JSON.stringify(a)}`);
  }
  // With a cost ceiling under ⌈L⌉ + 10 riding too (line mode, target max(60, 56)): no stop at 60 either (F-x).
  const both = onNight({ forceChargeCeilingPct: 60 });
  for (const pool of [60, 66, 75]) assert.notEqual(decideForceCharge(both, WIN_END - 10 * M, fo({ enabled: true, poolSocPct: pool, slotsOn: [1, 2, 3] })).kind, 'off', `cost 60 + line, pool ${pool}`);
  assert.deepEqual(decideForceCharge(onNight(), WIN_END, fo({ poolSocPct: 70 })), { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' });
  assert.equal((decideForceCharge(onNight(), WIN_END - H, fo({ gridPresent: false })) as { reason?: string }).reason, 'gridLoss');
  // The cost mode keeps today's stop at its target.
  const cost = onNight({ forceChargeCeilingPct: 90, forceChargeMode: 'cost' });
  assert.deepEqual(decideForceCharge(cost, WIN_END - H, fo({ enabled: true, poolSocPct: 90 })), { kind: 'off', slots: [1, 2, 3], reason: 'target' });
});

test('★★★ T6 the panel ceiling is max(80, ⌈L⌉ + 10): ask 78 syncs 88, and the own-write list names 88', () => {
  const s = night({ forceChargeLineAskPct: 78, forceChargeLinePct: 77.1 });
  assert.deepEqual(decideForceCharge(s, WIN_START + H, fo({ ceilingReadbackPct: 100 })), { kind: 'syncCeiling', pct: 88, prior: 100 });
  const synced = { ...s, forceChargeCeilingAttemptedAtMs: WIN_START + H, forceChargeCeilingPriorPct: 100, forceChargeCeilingSyncedPct: 88 };
  assert.deepEqual(forceChargeCommandsOf(synced).ceilingPcts, [88], 'settings drift: our own 88 write is not foreign');
  // With a cost ceiling under the line as well, still 88 (F-ix: never desired(cost)).
  assert.deepEqual(forceChargeCommandsOf({ ...synced, forceChargeCeilingPct: 60 }).ceilingPcts, [88]);
  // A record from before the field: the value the sync always wrote.
  assert.deepEqual(forceChargeCommandsOf({ ...synced, forceChargeCeilingSyncedPct: null, forceChargeCeilingPct: 85.3 } as never).ceilingPcts, [desiredForceChargeCeilingPct(85.3)]);
  assert.equal(forceChargeStopPct(85.3), 85);
});

test('★★★ T6 R4 — the gates are read LIVE each tick: a restart with an option flipped, both directions', () => {
  const persisted = () => coerceActuationState(JSON.parse(JSON.stringify(onNight({ forceChargeCeilingPct: 90, forceChargeMode: 'cost' })))) as LineState;
  assert.equal(persisted().forceChargeLineAskPct, 56);
  // Cost gate on: a cost-dominant night stops at its target (today).
  assert.equal((decideForceCharge(persisted(), WIN_END - H, fo({ enabled: true, poolSocPct: 91 })) as { reason?: string }).reason, 'target');
  // ARB_COST_MAX_SOC_PCT set to 50 and a restart: the cost force-charge is off; the line runs to the close.
  assert.notEqual(decideForceCharge(persisted(), WIN_END - H, fo({ enabled: false, poolSocPct: 91 })).kind, 'off');
  // Advisory and a restart: both gates off — 'disabled' OFF.
  assert.deepEqual(decideForceCharge(persisted(), WIN_END - H, fo({ enabled: false, lineEnabled: false, poolSocPct: 70 })), { kind: 'off', slots: [1, 2, 3], reason: 'disabled' });
  // Before the ON: the cost gate off ⇒ the start is timed to the line's 61%, never the 90% cost ceiling (F-viii).
  const pre = night({ forceChargeCeilingPct: 90, forceChargeRides: true });
  // 11 points = 10.14 kWh at 14 kW = 43.4 min + 15 + 20 ⇒ 78 min before the close.
  assert.equal(firstOnBeforeClose(pre, fo({ enabled: false, poolSocPct: 50, ceilingReadbackPct: 80 })), 78);
  // …and with it on, today's 90% cost path (its ceiling 90, its start hours earlier).
  assert.deepEqual(decideForceCharge(pre, WIN_START + H, fo({ enabled: true, ceilingReadbackPct: 80 })), { kind: 'syncCeiling', pct: 90, prior: 80 });
  assert.ok(firstOnBeforeClose(pre, fo({ enabled: true, poolSocPct: 50, ceilingReadbackPct: 90 }))! > 150);
});

test('★★★ T6 L2 — a malformed line stamp while ON: a finite ask keeps riding; a non-number with the cost gate off is a disabled OFF', () => {
  const rec = (ask: unknown) => coerceActuationState(JSON.parse(JSON.stringify({ ...onNight(), forceChargeLineAskPct: ask }))) as LineState;
  assert.notEqual(decideForceCharge(rec(55.5), WIN_END - H, fo({ poolSocPct: 70 })).kind, 'off');
  assert.deepEqual(decideForceCharge(rec('56'), WIN_END - H, fo({ poolSocPct: 70 })), { kind: 'off', slots: [1, 2, 3], reason: 'disabled' });
});

test('★★★ T6 (review) the LINE re-ON: a verified ON the panel switched off at its ceiling, the pool back under ⌈L⌉ + 5 — switched back on, under the start\'s gates, within the budget', () => {
  // The night's ON verified; the panel latched the slots OFF at its 80% ceiling; a late EV drew the pool to 60%.
  const latched = onNight({ forceChargeCeilingSyncedPct: 80, forceChargeOnLastAttemptMs: WIN_START + 2 * H });
  const t = WIN_END - H;
  const o = (over: Partial<ForceChargeOpts> = {}) => fo({ poolSocPct: 60, slotsOn: [], slotSocPct: { 1: 60, 2: 60, 3: 60 }, ceilingReadbackPct: 80, ...over });
  assert.deepEqual(decideForceCharge(latched, t, o()), { kind: 'lineReOn', slots: [1, 2, 3] });
  assert.equal(nfc.FORCE_CHARGE_LINE_REON_MAX, 2);
  // Under the START target (⌈L⌉ + 5 = 61), not the line: 61 is not yet; 60.9 is.
  assert.equal(decideForceCharge(latched, t, o({ poolSocPct: 61 })).kind, 'none');
  assert.equal(decideForceCharge(latched, t, o({ poolSocPct: 60.9 })).kind, 'lineReOn');
  // Only ours that read OFF, are connected, and whose Core is under the ceiling.
  assert.deepEqual(decideForceCharge(latched, t, o({ slotsOn: [1], slotSocPct: { 1: 62, 2: 80, 3: 58 } })), { kind: 'lineReOn', slots: [3] });
  assert.deepEqual(decideForceCharge(latched, t, o({ connectedSlots: [1, 2] })), { kind: 'lineReOn', slots: [1, 2] });
  assert.deepEqual(decideForceCharge({ ...latched, forceChargeSlots: [2] }, t, o()), { kind: 'lineReOn', slots: [2] });
  assert.equal(decideForceCharge(latched, t, o({ slotsOn: [1, 2, 3] })).kind, 'none', 'still ON: nothing to switch back');
  // The start's own gates (a re-ON is a new grid-charge write).
  for (const [label, bad] of [
    ['grid unknown', { gridPresent: null }], ['vitals red', { vitalsRed: true }], ['incoherent SoC', { socCoherent: false }],
    ['no slot readback', { slotsOn: null }], ['no pool reading', { poolSocPct: null }], ['no ceiling readback', { ceilingReadbackPct: null }],
    ['a ceiling readback out of the panel range', { ceilingReadbackPct: 70 }], ['a ceiling the pool is not under', { poolSocPct: 60, ceilingReadbackPct: 80, slotSocPct: { 1: 60, 2: 60, 3: 60 } } as never],
  ] as Array<[string, Partial<ForceChargeOpts>]>) {
    if (label.startsWith('a ceiling the pool')) continue;
    assert.equal(decideForceCharge(latched, t, o(bad)).kind, 'none', label);
  }
  assert.equal((decideForceCharge(latched, t, o({ gridPresent: false })) as { reason?: string }).reason, 'gridLoss', 'grid absent: the OFF, never a re-ON');
  // The budget: two a night, FORCE_CHARGE_ON_VERIFY_AFTER_MS apart (from the ON's writes, then each re-ON's).
  assert.equal(decideForceCharge({ ...latched, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: t - 15 * M }, t, o()).kind, 'lineReOn');
  assert.equal(decideForceCharge({ ...latched, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: t - 15 * M + 1 }, t, o()).kind, 'none');
  assert.equal(decideForceCharge({ ...latched, forceChargeLineReOns: 2, forceChargeLineReOnAtMs: t - H }, t, o()).kind, 'none', 'spent');
  assert.equal(decideForceCharge({ ...latched, forceChargeOnLastAttemptMs: t - 15 * M + 1 }, t, o()).kind, 'none', 'not within the ON\'s own grace');
  // Never inside the last FORCE_CHARGE_ON_RETRY_CUTOFF_MS (a re-ON shares each slot's cooldown with the close's OFF).
  assert.equal(decideForceCharge(latched, WIN_END - nfc.FORCE_CHARGE_ON_RETRY_CUTOFF_MS - 1, o()).kind, 'lineReOn');
  assert.equal(decideForceCharge(latched, WIN_END - nfc.FORCE_CHARGE_ON_RETRY_CUTOFF_MS, o()).kind, 'none');
  // Never before the ON verified (the ON verify owns that), never after an OFF, never in cost mode.
  assert.notEqual(decideForceCharge({ ...latched, forceChargeOnVerifiedAtMs: null }, t, o()).kind, 'lineReOn');
  assert.equal(decideForceCharge({ ...latched, forceChargeOnVerifiedAtMs: null, forceChargeOnFailedAtMs: t - H, forceChargeOnRetries: 1 }, t, o()).kind, 'none',
    'over a failed ON (the warning went): never a re-ON');
  assert.notEqual(decideForceCharge({ ...latched, forceChargeOffAtMs: t - M, forceChargeOffReason: 'onPeakGuard' }, t, o()).kind, 'lineReOn');
  const cost = onNight({ forceChargeCeilingPct: 90, forceChargeMode: 'cost', forceChargeCeilingSyncedPct: 90 });
  assert.equal(decideForceCharge(cost, t, o({ enabled: true, ceilingReadbackPct: 90 })).kind, 'none', 'a cost night has its own stop: no re-ON');
  assert.equal(decideForceCharge({ ...latched, forceChargeLineAskPct: null } as LineState, t, o({ enabled: true })).kind, 'none', 'a record with no line: today (no re-ON)');
  // The count survives a restart, as a count.
  for (const [raw, want] of [[2, 2], [1.5, 1], [-1, 0], ['2', 0], [undefined, 0]] as const) {
    assert.equal((coerceActuationState(JSON.parse(JSON.stringify({ ...latched, forceChargeLineReOns: raw }))) as LineState).forceChargeLineReOns, want, String(raw));
  }
  // index.ts executes it write-ahead: the budget is spent BEFORE the writes; all rate-limited hands it back.
  const exec = INDEX.slice(INDEX.indexOf("if (action.kind === 'lineReOn') {"), INDEX.indexOf("if (action.kind === 'onFailed') {"));
  const spend = exec.indexOf('forceChargeLineReOns: nightActuationMem.forceChargeLineReOns + 1,');
  const write = exec.indexOf("on: true, source: { ua: 'night-force-charge-line-reon' }");
  assert.ok(spend > 0 && write > spend, 'spent before the writes');
  // (review 2) …and a re-ON handed back stamps no slots: there is nothing for its readback check to judge.
  assert.ok(exec.includes('...(allLimited ? { forceChargeLineReOns: Math.max(0, nightActuationMem.forceChargeLineReOns - 1), forceChargeLineReOnSlots: null } : {}),'));
});

test('★★★ T6 (review) the expected walk is the tick\'s: at the panel ceiling the slots latch OFF and the house draws the pool, until the re-ON — the stated close is no longer the ceiling', () => {
  // 2026-10-29 21:30 at 0.944: a ~36 kWh P90 EV pulls the start to the window open; the walk reaches the 80%
  // ceiling hours before the close. It once held there (a close of 80%); the panel does not.
  const p = L(yearPlan('2026-10-29 21:30', true));
  assert.equal(p.expectedForceChargeMode, 'line');
  assert.equal(p.expectedWriteLevelPct, PIN_T2_CLOSE, 'drawn back under ⌈L⌉ + 5 = 71 and switched back on (v1.202.0, the measured pool)');
  assert.ok(p.expectedWriteLevelPct! < 80 && p.expectedWriteLevelPct! >= 71 - 1, String(p.expectedWriteLevelPct));
  // (review 2) the walk reaches the ceiling, so the plan says the panel's own stop and the re-ON, never "stays on".
  assert.deepEqual(p.expectedLineCeilingStop, { ceilingPct: 80, startTargetPct: 71 });
  assert.ok(p.rationale.includes(`runs until the panel switches it off at its 80% ceiling; the add-on switches it back on if the pool falls under 71% before the window closes (at most twice), ~${PIN_T2_CLOSE}% expected at the close.`), p.rationale);
  assert.ok(p.rationale.includes(`the force-charge for the outage line switches on at ~23:00 and the panel switches it off at its 80% ceiling, ~${PIN_T2_CLOSE}% expected at the close.`), p.rationale);
  assert.doesNotMatch(p.rationale, /stays on until the window closes|runs from ~\S+ to the window close/);
  // The walk itself. A quiet house until the last hour, when 6 kW arrives: the start (pool ≥ 61%) is due 35 min
  // before the close from ~70.4%, and the walk closes ~76.8% — under the 80% ceiling, which it does not reach
  // (review 2: ceilingReached false, so its texts keep "stays on until the window closes").
  const hours = Array.from({ length: 8 }, (_, i) => ({ ts: WIN_START + i * H, pvP10W: 0, pvP50W: 0, loadP90W: 4000, loadP50W: i === 5 ? 6000 : 300, evP90W: 0 }));
  const walk = (nca as unknown as { expectedLineForceChargeWalk: (o: unknown) => { closeKwh: number; startMs: number | null } }).expectedLineForceChargeWalk({
    startKwh: 0.75 * 92.16, reserveKwh: 0.5 * 92.16, fullKwh: 92.16, tickPoolKwh: 92.16, startTargetPct: 61, panelCeilingPct: 80,
    hours, fromMs: WIN_START, windowEndMs: WIN_END, dischargeEff: 0.94, chargeCapKw: 17, envelopeKw: 17, legEff: 0.927,
  });
  assert.equal(walk.startMs, WIN_END - 35 * M);
  assert.equal((walk as unknown as { ceilingReached: boolean }).ceilingReached, false, 'it never reached the ceiling');
  assert.ok(walk.closeKwh < 0.8 * 92.16 - 0.5, `the close ${(walk.closeKwh / 92.16 * 100).toFixed(1)}% is under the ceiling`);
  assert.ok(walk.closeKwh >= 0.61 * 92.16, `the close ${(walk.closeKwh / 92.16 * 100).toFixed(1)}% stays at or above the start target`);
  // An EV predicted for the whole window starts the walk at the open; a 9 kW median load then latches it at 80%
  // by ~02:45 and draws it under 61% before the last 20 min: the walk switches it back on, as the tick does
  // (closing ~64.4%, ~30.9 kWh bought); with no re-ON it would close ~56.5% on ~27.7 kWh.
  const evHours = Array.from({ length: 8 }, (_, i) => ({ ts: WIN_START + i * H, pvP10W: 0, pvP50W: 0, loadP90W: 9000, loadP50W: 9000, evP90W: 8000 }));
  const reOn = (nca as unknown as { expectedLineForceChargeWalk: (o: unknown) => { closeKwh: number; startMs: number | null; gridKwh: number } }).expectedLineForceChargeWalk({
    startKwh: 0.5 * 92.16, reserveKwh: 0.5 * 92.16, fullKwh: 92.16, tickPoolKwh: 92.16, startTargetPct: 61, panelCeilingPct: 80,
    hours: evHours, fromMs: WIN_START, windowEndMs: WIN_END, dischargeEff: 0.94, chargeCapKw: 17, envelopeKw: 17, legEff: 0.927,
  });
  assert.equal(reOn.startMs, WIN_START);
  assert.equal((reOn as unknown as { ceilingReached: boolean }).ceilingReached, true);
  assert.ok(reOn.closeKwh >= 0.61 * 92.16 && reOn.closeKwh < 0.8 * 92.16, `the close ${(reOn.closeKwh / 92.16 * 100).toFixed(2)}%`);
  assert.ok(reOn.gridKwh > 0.3 * 92.16 + 1, `bought again after the re-ON: ${reOn.gridKwh.toFixed(2)} kWh`);
});

test('★★★ T6 (review) the ON stamps the panel ceiling it read back: a line night that needed no sync verifies against the panel\'s ceiling, never desired(cost)', () => {
  // Cost gate on with c = 70 and an ask of 90: line mode, panel ceiling 100 — the panel already reads 100, so no sync.
  const s = night({ forceChargeCeilingPct: 70, forceChargeLineAskPct: 90, forceChargeLinePct: 89.4 });
  const gates = { cost: true, line: true };
  const pre = fo({ enabled: true, ceilingReadbackPct: 100, poolSocPct: 60 });
  let onAt: number | null = null;
  for (let t = WIN_START; t < WIN_END && onAt == null; t += M) {
    const a = decideForceCharge(s, t, pre);
    assert.notEqual(a.kind, 'syncCeiling');
    if (a.kind === 'on') onAt = t;
  }
  assert.ok(onAt != null);
  const stamp = nfc.forceChargeOnStamp(s, onAt!, [1, 2, 3], gates);
  assert.deepEqual(stamp, { forceChargeOnAtMs: onAt, forceChargeSlots: [1, 2, 3], forceChargeMode: 'line', forceChargeCeilingSyncedPct: 100 });
  const on = { ...s, ...stamp, forceChargeOnLastAttemptMs: onAt! };
  // Slot 2 refused the ON (reads OFF) with its Core at 84%: under the panel's 100, so NOT at the ceiling.
  const verify = fo({ enabled: true, ceilingReadbackPct: 100, poolSocPct: 62, slotsOn: [1, 3], slotSocPct: { 1: 60, 2: 84, 3: 55 } });
  assert.deepEqual(decideForceCharge(on, onAt! + 2 * M, verify), { kind: 'none' }, 'waits — never a false ON VERIFIED');
  assert.deepEqual(decideForceCharge(on, onAt! + 16 * M, verify), { kind: 'onRetry', slots: [2] }, 'then re-issues');
  // The record as the ON once persisted it (no ceiling stamp): desired(70) = 80 exempted slot 2 — the defect.
  assert.equal(decideForceCharge({ ...on, forceChargeCeilingSyncedPct: null }, onAt! + 2 * M, verify).kind, 'onVerified');
  // The mode stamp follows the LIVE gates; a cost night stamps its own ceiling (the fallback's value).
  assert.equal(nfc.forceChargeOnStamp(s, onAt!, [1], { cost: true, line: false }).forceChargeMode, 'cost');
  assert.equal(nfc.forceChargeOnStamp(s, onAt!, [1], { cost: true, line: false }).forceChargeCeilingSyncedPct, desiredForceChargeCeilingPct(70));
  assert.deepEqual(nfc.forceChargeOnStamp({ ...s, forceChargeCeilingSyncedPct: 85 } as LineState, onAt!, [1], { cost: false, line: false }),
    { forceChargeOnAtMs: onAt, forceChargeSlots: [1], forceChargeMode: null, forceChargeCeilingSyncedPct: 85 });
});

test('★★★ T6 (review) the cost gate turned off mid-run on a cost-dominant night: line mode lowers the panel ceiling to its own, and the pool stops by 80, never at the stale cost 90', () => {
  // Armed cost 90, ask 56 (cost-dominant: 90 ≥ 66); synced 90; ON in cost mode; then ARB_COST_MAX_SOC_PCT 50 + a restart.
  const s = onNight({ forceChargeCeilingPct: 90, forceChargeMode: 'cost', forceChargeCeilingAttemptedAtMs: WIN_START + 10 * M, forceChargeCeilingPriorPct: 100, forceChargeCeilingSyncedPct: 90 });
  const gatesOff = (pool: number, ceiling: number) => fo({ enabled: false, lineEnabled: true, poolSocPct: pool, slotsOn: [1, 2, 3], ceilingReadbackPct: ceiling });
  assert.deepEqual(decideForceCharge(s, WIN_END - 2 * H, gatesOff(60, 90)), { kind: 'syncCeiling', pct: 80, prior: 100 });
  // A minute-by-minute walk of the pool from 60, the panel's ceiling following our writes the minute after.
  let rec: LineState = s;
  let ceiling = 90;
  let pending: number | null = null;
  let pool = 60;
  let on = true;
  for (let t = WIN_END - 2 * H; t < WIN_END; t += M) {
    if (pending != null) { ceiling = pending; pending = null; }
    const a = decideForceCharge(rec, t, fo({ enabled: false, lineEnabled: true, poolSocPct: Math.round(pool), slotsOn: on ? [1, 2, 3] : [], ceilingReadbackPct: ceiling, slotSocPct: { 1: pool, 2: pool, 3: pool } }));
    assert.notEqual(a.kind, 'off', `no software stop in line mode (t − close ${(t - WIN_END) / M} min)`);
    if (a.kind === 'syncCeiling') { rec = { ...rec, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingSyncedPct: a.pct }; pending = a.pct; }
    if (on && pool < ceiling) pool = Math.min(ceiling, pool + 12 / 60 / 0.92); else on = false;
  }
  assert.ok(pool <= 80, `the pool stopped at ${pool.toFixed(1)}%, by the line mode's 80% ceiling`);
  assert.equal(rec.forceChargeCeilingSyncedPct, 80);
  // One write: once stamped at the mode's ceiling it never repeats, whatever the panel reads.
  const lowered = { ...s, forceChargeCeilingSyncedPct: 80 };
  for (const p of [60, 79, 85]) for (const c of [80, 90]) assert.notEqual(decideForceCharge(lowered, WIN_END - H, gatesOff(p, c)).kind, 'syncCeiling');
  // Only ever LOWER, and only in line mode: the cost gate on keeps today's stop at 90; a line night synced at its own never moves.
  assert.deepEqual(decideForceCharge(s, WIN_END - H, fo({ enabled: true, poolSocPct: 90, slotsOn: [1, 2, 3], ceilingReadbackPct: 90 })), { kind: 'off', slots: [1, 2, 3], reason: 'target' });
  assert.notEqual(decideForceCharge(s, WIN_END - H, fo({ enabled: true, poolSocPct: 70, slotsOn: [1, 2, 3], ceilingReadbackPct: 90 })).kind, 'syncCeiling');
  assert.notEqual(decideForceCharge(onNight({ forceChargeCeilingSyncedPct: 80 }), WIN_END - H, gatesOff(70, 80)).kind, 'syncCeiling');
  assert.notEqual(decideForceCharge(onNight({ forceChargeLineAskPct: 78, forceChargeCeilingSyncedPct: 88 }), WIN_END - H, gatesOff(70, 88)).kind, 'syncCeiling');
  assert.notEqual(decideForceCharge(onNight({ forceChargeLineAskPct: 78, forceChargeCeilingSyncedPct: 80 }), WIN_END - H, gatesOff(70, 80)).kind, 'syncCeiling', 'never RAISES while ON');
  // No live ceiling readback: nothing to write against (and no prior to keep).
  assert.notEqual(decideForceCharge(s, WIN_END - H, fo({ enabled: false, poolSocPct: 70, slotsOn: [1, 2, 3], ceilingReadbackPct: null })).kind, 'syncCeiling');
});

test('★★ T6 the why-texts (L8) and the ON-step texts in line mode', () => {
  const why = (s: LineState, o: ForceChargeOpts) => (decideForceCharge(s, WIN_START + H, o) as { why?: string }).why ?? '';
  assert.equal(why(night(), fo({ enabled: false, lineEnabled: false })),
    'disabled (NIGHT_CHARGE_MODE advisory; or, with no outage line above the reserve tonight, ARB_OBJECTIVE not cost or ARB_COST_MAX_SOC_PCT at or below the 50% reserve)');
  assert.equal(why(night({ forceChargeLineAskPct: null }), fo({ enabled: true })),
    'no force-charge target tonight (no cost ceiling and no outage line above the 50% reserve) — reserve-only night');
  // (Fix7 review 2) Both line-mode whys (the add-on log's "NOT starting", once a night) name the record's line round1(L), as
  // every other surface does (forceChargeLineNightPct): never the ask ⌈L⌉, up to a point above it. And the hold-off never says
  // the force-charge "stays on to the close": the panel switches each slot off at its ceiling (the measured shape).
  assert.equal(why(night(), fo({ poolSocPct: 50 })),
    'just in time — holding off so the pool reaches ~61% 20 min before the window closes, for the 55.6% outage line at the close');
  assert.equal(why(night(), fo({ poolSocPct: 80 })), 'the pool already reads the 80% panel ceiling — above tonight\'s 55.6% outage line');
  // The verifier's night (the CHANGELOG's example line): the ask 61, the line 60.03 — "60%", never "61%".
  const ex = night({ forceChargeLineAskPct: 61, forceChargeLinePct: 60.03 });
  assert.equal(why(ex, fo({ poolSocPct: 50 })),
    'just in time — holding off so the pool reaches ~66% 20 min before the window closes, for the 60% outage line at the close');
  assert.equal(why(ex, fo({ poolSocPct: 80 })), 'the pool already reads the 80% panel ceiling — above tonight\'s 60% outage line');
  // A record without the line names its ask, as forceChargeLineNightPct does on every surface.
  assert.match(why(night({ forceChargeLinePct: null }), fo({ poolSocPct: 50 })), /, for the 56% outage line at the close$/);
  for (const s of [night(), ex]) assert.doesNotMatch(why(s, fo({ poolSocPct: 50 })), /stays on/);
});

/** (Fix8) The "already at the panel ceiling" why's relation, parsed and checked against the numbers it names: the ceiling `c`
 *  above the line, at it, or the line above a full pool — by the line's actual order, with the line named so that the order
 *  shows (round1, or two decimals where one would read as the ceiling: lineBesidePct). */
const CEILING_WHY = /^the pool already reads the (\d+)% panel ceiling — (?:(above|at) tonight's ([\d.]+)% outage line|tonight's ([\d.]+)% outage line is above a full pool)$/;
const ceilingWhyHolds = (w: string, linePct: number, c: number): string | null => {
  const m = CEILING_WHY.exec(w);
  if (m == null) return `unparsed: ${w}`;
  if (Number(m[1]) !== c) return `names the ${m[1]}% ceiling, not ${c}%`;
  const n = Number(m[3] ?? m[4]);
  const shown = r1(linePct) === c ? Math.round(linePct * 100) / 100 : r1(linePct);
  if (n !== shown) return `names the line ${n}%, not ${shown}%`;
  if (m[2] === 'above') return linePct < c && n < c ? null : `"above" with the line ${linePct} and the ceiling ${c}`;
  if (m[2] === 'at') return linePct === c && n === c ? null : `"at" with the line ${linePct} and the ceiling ${c}`;
  return linePct > 100 && n > 100 && c === 100 ? null : `"above a full pool" with the line ${linePct}`;
};

test('★★★ T6 (Fix8) the "already at the panel ceiling" why words the order its numbers show — above the line, at it, or the line above a full pool: the real plans (a 101.57% line, a 100% one, a 99.99% one) through armFromPlan, and the edges against the 80% and 100% ceilings', () => {
  const why = (s: LineState, o: ForceChargeOpts, t = WIN_START + H) => (decideForceCharge(s, t, o) as { why?: string }).why ?? '';
  const ceilingOf = (c: number | null, ask: number, cost: boolean) =>
    (nfc.forceChargeModeOf({ forceChargeCeilingPct: c, forceChargeLineAskPct: ask } as never, { cost, line: true }) as { panelCeilingPct: number }).panelCeilingPct;
  // The real plans, armed by armFromPlan (the reserve then verified), their pool reading the panel's ceiling before the first ON.
  const real = (label: string, h: number, basis: 'np' | 'm') => {
    const p = yearPlanAt(label, h, basis);
    const cost = liveCost(label);
    const rec = (armFromPlan as (...a: unknown[]) => NightActuationState | null)(emptyActuationState(), '2027-01-01', p, p.generatedAt, 30, cost, null, true) as LineState | null;
    assert.ok(rec != null && rec.forceChargeLineAskPct === p.forceChargeLine!.askPct && rec.forceChargeLinePct === p.cushionLineSocPct, `${label}: armed with its line`);
    const c = ceilingOf(rec!.forceChargeCeilingPct, rec!.forceChargeLineAskPct!, cost);
    const live = { ...rec!, appliedAtMs: rec!.windowStartMs! - 5 * M, applyVerifiedAtMs: rec!.windowStartMs! + M } as LineState;
    return { p, c, w: why(live, fo({ enabled: cost, poolSocPct: c, ceilingReadbackPct: c }), rec!.windowStartMs! + 30 * M) };
  };
  // 2026-10-26 21:30, nameplate, 20 h: the 101.57% line, asked at 100 under a 100% ceiling. Its rationale says the line is above
  // a full pool, so no charge can hold it; the why said "the 100% panel ceiling — above tonight's 101.6% outage line".
  const c20 = real('2026-10-26 21:30', 20, 'np');
  assert.deepEqual([c20.p.cushionLineSocPct, c20.p.forceChargeLine?.askPct, c20.c], [101.57, 100, 100]);
  assert.ok(c20.p.rationale.includes("tonight's 101.57% outage line is above a full pool, so no charge can hold it"), c20.p.rationale);
  assert.equal(c20.w, "the pool already reads the 100% panel ceiling — tonight's 101.6% outage line is above a full pool");
  // 2026-12-30 21:30 at 0.944, 20 h: a 100% line — at the ceiling. 2027-02-10 21:30 at 0.944, 19 h: 99.99% — two decimals.
  const at100 = real('2026-12-30 21:30', 20, 'm');
  assert.deepEqual([at100.p.cushionLineSocPct, at100.c], [100, 100]);
  assert.equal(at100.w, "the pool already reads the 100% panel ceiling — at tonight's 100% outage line");
  const n9999 = real('2027-02-10 21:30', 19, 'm');
  assert.deepEqual([n9999.p.cushionLineSocPct, n9999.c], [99.99, 100]);
  assert.equal(n9999.w, "the pool already reads the 100% panel ceiling — above tonight's 99.99% outage line");
  // The edges (synthetic records). The 80% ceiling rides asks up to 70 only (⌈L⌉ + 10 ≤ 80; a cost ceiling riding in line mode
  // stays under ⌈L⌉ + 10); 100% asks of 90 and more. An ask of 80 or 81 syncs 90 or 91: neither 80 nor 100 is reachable there.
  const rows: Array<[number, number, number | null, string]> = [
    [55.55, 56, null, "above tonight's 55.6% outage line"], [55.55, 56, 60, "above tonight's 55.6% outage line"],
    [79.96, 80, null, "above tonight's 80% outage line"], [80, 80, null, "above tonight's 80% outage line"],
    [80.04, 81, null, "above tonight's 80% outage line"], [89.96, 90, null, "above tonight's 90% outage line"],
    [99.94, 100, null, "above tonight's 99.9% outage line"], [99.96, 100, null, "above tonight's 99.96% outage line"],
    [100, 100, null, "at tonight's 100% outage line"], [100.03, 100, null, "tonight's 100.03% outage line is above a full pool"],
    [101.57, 100, null, "tonight's 101.6% outage line is above a full pool"],
  ];
  for (const [line, ask, cost, tail] of rows) {
    const s = night({ forceChargeLineAskPct: ask, forceChargeLinePct: line, forceChargeCeilingPct: cost });
    const c = ceilingOf(cost, ask, cost != null);
    assert.equal(c, ask <= 70 ? 80 : ask >= 90 ? 100 : ask + 10, `ask ${ask}`);
    const w = why(s, fo({ enabled: cost != null, poolSocPct: c, ceilingReadbackPct: c }));
    assert.equal(w, `the pool already reads the ${c}% panel ceiling — ${tail}`, `line ${line}`);
    assert.equal(ceilingWhyHolds(w, line, c), null, `line ${line}: ${w}`);
  }
});

/* ══ T8 — the morning refresh never lowers or drops the line ═══════════════════════════════════════ */

test('★★ T8 a refresh with a lower cost ceiling, or none, keeps the line ask: the leg still rides the line', () => {
  const leg = asChargeLeg(night({ forceChargeCeilingPct: 60 }), { leg: 'cost', windowKind: 'super_off_peak', announcedLevelPct: 70, announcedExpectedKwh: 20 });
  const replan = (c: number | null, line: typeof LINE | null) => ({
    basisComplete: true, chargeTonight: true, setpointSocPct: 50, expectedWriteLevelPct: 62, expectedForceChargeStartMs: WIN_END - H,
    expectedBuyKwh: 12, buyKwh: 25, costCeilingSocPct: c, ...(line != null ? { forceChargeLine: line } : {}),
  }) as unknown as NightChargePlan;
  for (const [c, line] of [[52, null], [null, null], [52, { askPct: 52, linePct: 51.2 }]] as const) {
    const o = liveRefreshOutcome(leg, replan(c, line));
    assert.equal(o.disposition, 'lowered');
    assert.equal((o as { forceChargeLineAskPct?: number | null }).forceChargeLineAskPct, 56, 'the outcome carries the armed ask');
    const after = applyLiveRefresh(leg, o, WIN_START - 3 * H) as LineState;
    assert.equal(after.forceChargeCeilingPct, c, 'the cost ceiling is lowered or dropped, as before');
    assert.equal(after.forceChargeLineAskPct, 56, 'M-i / M-ii: never nulled, never lowered to the re-plan\'s');
    assert.equal(after.forceChargeLinePct, 55.55);
    const m = nfc.forceChargeModeOf(after as never, { cost: true, line: true });
    assert.equal(m?.kind, 'line');
    assert.equal(m?.targetPct, 56);
  }
  const replanLine = liveRefreshOutcome(leg, replan(52, { askPct: 52, linePct: 51.2 })) as { neededLineAskPct?: number | null };
  assert.equal(replanLine.neededLineAskPct, 52, 'what the re-plan asked is recorded, not applied');
});

/* ══ T9 — texts and parity ═════════════════════════════════════════════════════════════════════════ */

/** The 2026-10-12 evening as a resilience night with an 8 h × 4.5 kW island on a 30% floor: line > 50. */
const LINE_DEPS = { objectiveMode: 'resilience' as const, forceChargeEligible: false, islandedLoadKw: 4.5, outageCushionHours: 4, reserveFloorPct: 30, socNowPct: 40 };
const linePlan = (eligible: boolean | undefined) => L(goldenPlan({ ...LINE_DEPS, ...(eligible !== undefined ? { lineForceChargeEligible: eligible } : {}) } as never));

test('★★ T9 the supervised push: the title, the clause, the spoken notice and the card state ONE level, the expected close', () => {
  const p = linePlan(true);
  assert.equal(p.expectedForceChargeMode, 'line', JSON.stringify(p.forceChargeLine));
  const level = chargeLevelPct(p)!;
  const supervised = {
    cancelDeadlineText: 'tonight at 11:55 PM', targetPct: 50, forceChargeTargetPct: null,
    forceChargeLine: { askPct: p.forceChargeLine!.askPct, linePct: p.forceChargeLine!.linePct, panelCeilingPct: 80 },
  };
  const msg = buildNightChargeMessage(p, 'charge', supervised as never);
  const title = /~([\d.]+)%/.exec(msg.title)?.[1];
  assert.equal(Number(title), Math.round(level * 10) / 10, msg.title);
  assert.ok(msg.body.includes(`for tonight's ${Math.round(p.forceChargeLine!.linePct * 10) / 10}% outage line`), msg.body);
  assert.ok(msg.body.includes(`taking the pool to ~${Math.round(level * 10) / 10}%`), 'the clause names the title\'s level');
  assert.doesNotMatch(msg.body, /just long enough to|OFF when it gets there/, 'no software stop to promise');
  // The spoken notice names the same level, and the reserve clause.
  const ann = eveningAnnouncement({ cycle: 'overnight', plan: p, shape: 'charge', supervised: { ...supervised, cancelDeadlineTextEs: 'esta noche a las 11:55 PM' }, armRefused: null, mode: 'supervised' } as never);
  assert.ok(ann.spoken!.en.includes(`about ${Math.round(level)} percent`), ann.spoken!.en);
  assert.ok(ann.spoken!.en.endsWith(' The panel keeps only 50 percent in reserve. Cancel on the Power panel before then.')
    || ann.spoken!.en.includes(' The panel keeps only 50 percent in reserve.'), ann.spoken!.en);
  assert.ok(ann.spoken!.es.includes(' El panel solo mantiene el 50 por ciento en reserva.'), ann.spoken!.es);
  // The card's row names the line and the same level.
  const row = (cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow(p);
  assert.ok(row != null && row.includes(`~${Math.round(level * 10) / 10}%`), String(row));
});

test('★★★ T9 (review 2, finding 4) a line night whose expected walk reaches the panel ceiling: the rationale, the push and the card say the panel switches it off there and the add-on switches it back on — never "stays on until the window closes"', () => {
  // 2026-10-29 21:30 at 0.944: a predicted EV pulls the start to the open, the walk reaches the 80% ceiling and the house
  // draws it back (v1.202.0, on the measured pool: under the 71% start target, so the walk switches it back on, ~79.7% at
  // the close; v1.200.0's walks drew it to ~72.1% with no re-ON).
  const p = L(yearPlan('2026-10-29 21:30', true));
  assert.deepEqual(p.expectedLineCeilingStop, { ceilingPct: 80, startTargetPct: 71 });
  const supervised = {
    cancelDeadlineText: 'tonight at 11:55 PM', targetPct: 50, forceChargeTargetPct: null,
    forceChargeLine: { askPct: 66, linePct: 65.95, panelCeilingPct: 80 },
  };
  const msg = buildNightChargeMessage(p, 'charge', supervised as never);
  assert.match(msg.body, new RegExp(`Then, at ~\\S+, it switches the panel's force-charge ON for tonight's [\\d.]+% outage line \\(above the 50% the panel holds as a reserve\\); `
    + `the panel switches it off at its 80% force-charge ceiling, and the add-on switches it back on if the pool falls under 71% before the window closes \\(at most twice\\), `
    + `~${PIN_T2_CLOSE}% expected at the close\\. After the window the reserve returns to 30% and the house uses the pool as usual\\. `), msg.body);
  assert.doesNotMatch(msg.body, /keeps it on until the window closes|is the backstop/);
  const title = /~([\d.]+)%/.exec(msg.title)?.[1];
  assert.equal(Number(title), PIN_T2_CLOSE, 'one level: the title is the clause\'s close');
  const ct = cardText as unknown as { outageLineRow: (p: unknown) => string | null; LINE_REON_TIMES_TEXT: string };
  assert.equal(ct.outageLineRow(p), `outage line 66% is above the 50% reserve — the panel's force-charge runs until the panel switches it off at its 80% ceiling, `
    + `and the add-on switches it back on under 71% before the close (at most twice), ~${PIN_T2_CLOSE}% expected at the close`);
  assert.equal(ct.LINE_REON_TIMES_TEXT, nfc.lineReOnTimesWords(nfc.FORCE_CHARGE_LINE_REON_MAX), 'the card mirrors the server\'s re-ON budget');
  // A walk that stays under the ceiling (2027-06-22 21:30; v1.202.0 — 2027-01-04 21:30 now reaches it, T1): no field, and
  // the words are v1.200.0's.
  const under = L(yearPlan('2027-06-22 21:30', true));
  assert.equal('expectedLineCeilingStop' in under, false);
  const underMsg = buildNightChargeMessage(under, 'charge', { ...supervised, forceChargeLine: { askPct: 60, linePct: 59.1, panelCeilingPct: 80 } } as never);
  assert.match(underMsg.body, /keeps it on until the window closes, .*the panel's 80% force-charge ceiling is the backstop\. /);
  assert.match(ct.outageLineRow(under)!, /the panel's force-charge stays on to the window close, ~[\d.]+% expected at the close$/);
});

test('★★ T9 the spoken clause fits the 560-character bound at the longest deadline; never beside the shortfall or "toward"', () => {
  const longest = { en: 'Monday, December 28 at 11:55 PM', es: 'el lunes 28 de diciembre a las 11:55 PM' };
  const n = (o: Partial<Parameters<typeof nightChargeSpokenNotice>[0]> & { reserveOnlyPct?: number }) => {
    const t = nightChargeSpokenNotice({ levelPct: 69.4, reservePct: 50, expectedKwh: 17.6, deadlineText: longest.en, deadlineTextEs: longest.es, cushionShortfall: false, ...o } as never);
    return t;
  };
  const withClause = n({ reserveOnlyPct: 50 });
  assert.ok(withClause.en.includes(' The panel keeps only 50 percent in reserve.'));
  assert.ok(withClause.en.length + withClause.es.length <= MAX_SPOKEN_ADVISORY_CHARS, `${withClause.en.length + withClause.es.length}`);
  // Never beside the shortfall clause or "toward": on a short shape where it would still fit (no energy
  // figure, tonight's deadline), so the rule — not the length bound — is what keeps it out.
  const clause = ' The panel keeps only 50 percent in reserve.'.length + ' El panel solo mantiene el 50 por ciento en reserva.'.length;
  for (const o of [{ cushionShortfall: true }, { toward: true }]) {
    const short = { ...o, expectedKwh: null, deadlineText: 'tonight at 11:00 PM', deadlineTextEs: 'esta noche a las 11:00 PM' };
    const bare = n(short);
    assert.ok(bare.en.length + bare.es.length + clause <= MAX_SPOKEN_ADVISORY_CHARS, `precondition: it would fit (${bare.en.length + bare.es.length + clause})`);
    const t = n({ ...short, reserveOnlyPct: 50 });
    assert.ok(!t.en.includes('keeps only') && !t.es.includes('solo mantiene'), 'the clause only on the plain shape');
    assert.deepEqual(t, bare);
    assert.ok(n({ ...o, reserveOnlyPct: 50 }).en.length + n({ ...o, reserveOnlyPct: 50 }).es.length <= MAX_SPOKEN_ADVISORY_CHARS);
  }
  assert.deepEqual(n({}), n({ reserveOnlyPct: undefined }), 'absent: today\'s words');
});

test('★★ T9 envelope-only disclosure: the advisory push and the card name the envelope, never "charge/pool caps"', () => {
  const p = linePlan(false);
  assert.equal(p.cushionShortfallCause, 'envelope');
  const msg = buildNightChargeMessage(p, 'charge', null);
  assert.equal(p.cushionEnvelopeReason, 'advisory');
  assert.ok(msg.body.includes(`NOTE: tonight's ${Math.round(p.cushionLineSocPct! * 10) / 10}% outage line is above the 50% the panel accepts as a reserve, and no force-charge runs in advisory mode — residual risk remains.`), msg.body);
  assert.doesNotMatch(msg.body, /charge\/pool limits/);
  const ct = cardText as unknown as { capsShortfallShown: (p: unknown) => boolean; outageLineRow: (p: unknown) => string | null };
  assert.equal(ct.capsShortfallShown(p), false);
  assert.match(ct.outageLineRow(p)!, /— not held tonight \(advisory mode\); residual risk remains$/);
  // A sizing shortfall keeps its caps note, and an envelope on top of it says both.
  assert.equal(ct.capsShortfallShown({ cushionShortfall: true }), true);
  assert.equal(ct.capsShortfallShown({ cushionShortfall: true, cushionShortfallCause: 'envelope+caps' }), true);
  const both = buildNightChargeMessage({ ...p, cushionShortfallCause: 'envelope+caps' } as never, 'charge', null);
  assert.match(both.body, /charge\/pool limits/);
  assert.match(both.body, /outage line is above the 50% the panel accepts/);
  // The line sentence only in line mode: a carried cost-dominant plan says nothing of the line.
  assert.equal(ct.outageLineRow({ ...linePlan(true), expectedForceChargeMode: undefined }), null);
});

test('★★ T9 (review; A5) the envelope note is worded by its reason: a line above 90 under a 100% cost ceiling is ARMED in line mode (start 95, ceiling 100) and disclosed by the margin it lacks — never "no force-charge", never "not held tonight"', () => {
  // Line 92.34 (8 h × 5.4 kW), the cost objective to 100%, both gates on: ⌈L⌉ + 10 > 100, so the plan does not claim
  // the line ('nearFull'). (A5) The line force-charge is armed all the same and is the mode the tick runs: the cost stop
  // (100) is not ⌈L⌉ + 10 (103) or more, so line mode, its start timed to 95% under the panel's 100% ceiling.
  const nearFull = plan({ islandedLoadKw: 5.4, objectiveMode: 'cost', costMaxSocPct: 100, forceChargeEligible: true, lineForceChargeEligible: true });
  assert.equal(nearFull.cushionLineSocPct, 92.34);
  assert.equal(nearFull.cushionEnvelopeReason, 'nearFull');
  assert.equal(nearFull.cushionShortfallCause, 'envelope');
  assert.deepEqual(nearFull.forceChargeLine, { askPct: 93, linePct: 92.34 });
  const mode = nfc.forceChargeModeOf({ forceChargeCeilingPct: nearFull.costCeilingSocPct, forceChargeLineAskPct: 93 } as never, { cost: true, line: true });
  assert.deepEqual(mode, { kind: 'line', targetPct: 100, askPct: 93, startTargetPct: 95, panelCeilingPct: 100 });
  assert.equal(nearFull.expectedForceChargeMode, 'line');
  assert.equal(nearFull.expectedWriteLevelPct, 99.6);
  assert.equal((nca as unknown as { lineNotHeldOf: (p: unknown) => string | null }).lineNotHeldOf(nearFull), 'nearFull');
  const supervised = { cancelDeadlineText: 'by 23:00', targetPct: 50, forceChargeTargetPct: null, forceChargeLine: { askPct: 93, linePct: 92.34, panelCeilingPct: 100 } };
  const push = buildNightChargeMessage(nearFull, 'charge', supervised as never);
  assert.ok(push.body.includes("switches the panel's force-charge ON for tonight's 92.3% outage line (above the 50% the panel holds as a reserve); the panel switches it off at its 100% force-charge ceiling, "
    + 'and the add-on switches it back on if the pool falls under 95% before the window closes (at most twice), ~99.6% expected at the close.'), push.body);
  assert.ok(push.body.includes("NOTE: tonight's 92.3% outage line is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin — residual risk remains."), push.body);
  assert.doesNotMatch(push.body, /no force-charge|too close to a full pool|not held tonight/);
  assert.equal(Number(/~([\d.]+)%/.exec(push.title)?.[1]), 99.6, push.title);
  const ct = cardText as unknown as { outageLineRow: (p: unknown) => string | null };
  assert.equal(ct.outageLineRow(nearFull), "outage line 92.3% is above the 50% reserve — the panel's force-charge runs until the panel switches it off at its 100% ceiling, "
    + 'and the add-on switches it back on under 95% before the close (at most twice), ~99.6% expected at the close — within 10 points of a full pool, not held with its usual margin; residual risk remains');
  assert.doesNotMatch(ct.outageLineRow(nearFull)!, /not held tonight|no force-charge/);
  // The backup leg, and advisory: each its own words; the reason rides only beside a cause.
  const backup = plan({ windowSpec: { kind: 'overnight', role: 'backup' }, lineForceChargeEligible: true });
  assert.equal(backup.cushionEnvelopeReason, 'backupLeg');
  assert.ok(buildNightChargeMessage(backup, 'charge', null).body.includes('and the outage backup leg writes the reserve only — residual risk remains.'));
  assert.equal(plan({ lineForceChargeEligible: false }).cushionEnvelopeReason, 'advisory');
  for (const e of [true, undefined]) assert.equal('cushionEnvelopeReason' in plan({ lineForceChargeEligible: e }), false);
});

test('★★ T9 (review) a line night NOT expected to start (the pool stays at or above the panel ceiling): armed, never "stays on until the window closes"', () => {
  const quiet = Array.from({ length: 30 }, (_, i) => ({ ts: B + i * H, pvP10W: 0, loadP90W: 5000, loadP50W: 300, pvP50W: 0 }));
  const p = plan({ socNowPct: 90, horizon: quiet, lineForceChargeEligible: true });
  assert.equal(p.expectedForceChargeMode, 'line', JSON.stringify(p.forceChargeLine));
  assert.equal(p.expectedForceChargeStartMs, null, 'precondition: no start expected');
  assert.ok(p.rationale.includes('so the panel\'s force-charge is armed for it, but is not expected to start: the pool is expected to stay at or above the panel\'s 80% force-charge ceiling.'), p.rationale);
  assert.doesNotMatch(p.rationale, /stays on until the window closes|stands by/);
  assert.match(p.rationale, /the force-charge for the outage line is armed but not expected to start \(the pool is expected to stay at or above the panel's 80% force-charge ceiling\), and the house draws it to ~[\d.]+% by the close/);
  assert.doesNotMatch(p.rationale, /force-charge to [\d.]+% is not expected to start/, 'the expected close is no force-charge target');
  const ct = cardText as unknown as { outageLineRow: (p: unknown) => string | null };
  assert.equal(ct.outageLineRow(p), `outage line ${Math.round(p.forceChargeLine!.linePct * 10) / 10}% is above the 50% reserve — the panel's force-charge is armed for it, not expected to start (the pool stays at or above its ceiling)`);
  const push = buildNightChargeMessage(p, 'charge', { cancelDeadlineText: 'by 23:00', targetPct: 50, forceChargeTargetPct: null, forceChargeLine: { askPct: p.forceChargeLine!.askPct, linePct: p.forceChargeLine!.linePct, panelCeilingPct: 80 } } as never);
  assert.ok(push.body.includes("; it is not expected to start (the pool is expected to stay at or above the panel's 80% force-charge ceiling). "), push.body);
  assert.doesNotMatch(push.body, /on until the window closes/);
});

test('★★ T9 the ON failure on a line night (review): all slots ⇒ unless it applies late, the add-on adds nothing above the 50% reserve, and what can still lift the pool; some ⇒ the pool may close short — never "no action needed"', () => {
  const fail = (slots: number[], line: number | null) => buildNightForceChargeOnFailure({ day: '2026-09-16', slots, ourSlots: [1, 2, 3], retries: 1, noRetry: false, ceilingPct: line == null ? 90 : null, lineLinePct: line } as never);
  const all = fail([1, 2, 3], 55.55);
  // (Fix8 review 1) The ON is still watched after the warning, and a late apply is verified (verifyForceChargeOn reads onVerified
  // before its failure guard; the morning then says it ran): "has not taken effect", never "did not" or "will not happen".
  assert.equal(all.title, 'Night-charge: the outage-line force-charge has not taken effect');
  // (Fix8) The pool at the failure is not known to the push (it may read above the line): that it MAY close under. (Fix8 review 1)
  // And no floor that holds nothing islanded (the pool drains through the reserve in an outage): the add-on adds nothing above it.
  assert.ok(all.body.includes("Tonight's force-charge for the 55.6% outage line has not taken effect: unless it applies late, the add-on adds nothing above the 50% reserve, and the pool may close the window under the line."), all.body);
  assert.doesNotMatch(all.body, /will close the window near|will not happen|only the 50% reserve holds/);
  assert.ok(all.body.includes('Charge Now switched on for slot(s) 1, 2, 3 in the EcoFlow app can still lift the pool tonight (the add-on switches it off at the window close); if this repeats, check the SHP2 cloud link.'), all.body);
  // (Fix10 review 1) How far it gets depends on when it goes on: never a promise of the line.
  assert.doesNotMatch(all.body, /[Tt]o hold the line|holds? the line/);
  assert.doesNotMatch(all.body, /No action needed/);
  const some = fail([2], 55.55);
  // (Fix8 review 1) The other slots read ON or at the panel's ceiling (switched off by the panel: not charging): never "still charge".
  assert.ok(some.body.includes("Tonight's force-charge for the 55.6% outage line has not taken effect on those slot(s), so the pool may close the window short of the line."), some.body);
  assert.doesNotMatch(some.body, /near the 50% reserve|No action needed|still charge|will not happen/, 'never "near 50%", never "still charge"');
  assert.ok(some.body.includes('Charge Now switched on for slot(s) 2 in the EcoFlow app can still lift the pool tonight'), some.body);
  // A cost night's warning is today's, word for word.
  const cost = fail([2], null);
  assert.equal(cost.title, 'Night-charge: force-charge did not take effect');
  assert.ok(cost.body.includes("Tonight's buy above the 50% reserve (toward ~90%) will not happen on those slot(s); the reserve charge is unaffected. No action needed tonight — but if this repeats, check the SHP2 cloud link."), cost.body);
});

test('★★ T9 the declined start (L3; review): every all-night blocker is one; each CLASS pushes once it has held 10 min unbroken; the time quoted is the latest start that still reaches the line', () => {
  const declined = (notify as unknown as { buildLineForceChargeDeclinedStart: (o: unknown) => { title: string; body: string } })
    .buildLineForceChargeDeclinedStart({ day: '2026-09-16', linePct: 55.55, why: 'grid presence is unknown', latestStartText: '04:24' });
  // (Fix8) True in every outcome: the pool may already read above the line, or a person's Charge Now may lift it.
  // (Fix8 review 1) …and with the grid absent (a declined cause) the pool drains through the reserve: never "only the 50% reserve
  // holds it" — the add-on adds nothing above it, true islanded, under a person's Charge Now, and on the grid.
  assert.equal(declined.body, "Night-charge: the force-charge for tonight's 55.6% outage line cannot start yet — grid presence is unknown. If it has not started by ~04:24, the pool may close under the line; if it never starts, the add-on adds nothing above the 50% reserve.");
  // (Fix8 review 2) The title too: decideForceCharge decides every tick, so a held start may still come — "cannot start yet".
  assert.equal(declined.title, 'Night-charge: the force-charge for the outage line cannot start yet');
  // Which declines are blockers: the non-pool ones — and (review 17) no ceiling readback, no slot connected.
  const cls = nfc.forceChargeBlockerClass;
  for (const s of [night(), night({ applyVerifiedAtMs: WIN_START + M })]) {
    const w = (o: ForceChargeOpts) => ((decideForceCharge(s, WIN_END - 2 * H, o) as { why?: string }).why ?? '');
    for (const [o, want] of [
      [fo({ gridPresent: null }), 'gridPresence'], [fo({ vitalsRed: true }), 'vitals'], [fo({ slotsOn: [2] }), 'alreadyOn'], [fo({ slotsOn: null }), 'noReadback'],
      [fo({ socCoherent: false }), 'incoherent'], [fo({ gridStaLost: true }), 'gridSta'], [fo({ ceilingReadbackPct: null }), 'ceilingReadback'], [fo({ connectedSlots: [] }), 'noSlots'],
    ] as Array<[ForceChargeOpts, string]>) {
      assert.equal(cls(w(o)), want, w(o));
      assert.equal(nfc.isForceChargeStartBlocker(w(o)), true);
    }
    assert.equal(cls(w(fo({ poolSocPct: 50 }))), null, 'just in time is no blocker');
    assert.equal(cls(w(fo({ poolSocPct: 85 }))), null, 'at the panel ceiling is no blocker');
  }
  const refused = { ...night(), forceChargeCeilingAttemptedAtMs: WIN_START, forceChargeCeilingSyncRetries: 1 };
  assert.equal(cls((decideForceCharge(refused, WIN_START + H, fo({ ceilingReadbackPct: 100 })) as { why?: string }).why ?? ''), 'ceilingRefused');
  // The push: per class, once it has held FORCE_CHARGE_LINE_DECLINED_PERSIST_MS unbroken.
  const STALE = nfc.FORCE_CHARGE_BLOCKER_WHY.noReadback;
  const VITALS = nfc.FORCE_CHARGE_BLOCKER_WHY.vitals;
  assert.equal(nfc.FORCE_CHARGE_LINE_DECLINED_PERSIST_MS, 10 * M);
  let st = nfc.EMPTY_LINE_DECLINED_PUSH;
  const pushes: Array<[number, string]> = [];
  const tick = (t: number, why: string | null) => { const r = nfc.lineDeclinedPushStep(st, why, t); st = r.state; if (r.push) pushes.push([t, r.push]); };
  // 22:07: a stale readback for three ticks, then the start is merely timed — no push.
  const T0 = WIN_START - 53 * M;
  for (let i = 0; i < 3; i++) tick(T0 + i * M, STALE);
  for (let i = 3; i < 60; i++) tick(T0 + i * M, 'just in time — holding off');
  assert.deepEqual(pushes, [], 'a transient blocker never pushes');
  // 03:20: vitals critical, and it lasts: pushed once, 10 min in — the earlier transient did not spend it.
  const T1 = WIN_END - 100 * M;
  for (let i = 0; i <= 40; i++) tick(T1 + i * M, VITALS);
  assert.deepEqual(pushes, [[T1 + 10 * M, 'vitals']]);
  // A second, different class that persists pushes too; the same class again never does.
  for (let i = 41; i <= 60; i++) tick(T1 + i * M, STALE);
  for (let i = 61; i <= 80; i++) tick(T1 + i * M, VITALS);
  assert.deepEqual(pushes, [[T1 + 10 * M, 'vitals'], [T1 + 51 * M, 'noReadback']]);
  // A class that flickers (blocker, then not) never accumulates.
  st = nfc.EMPTY_LINE_DECLINED_PUSH; pushes.length = 0;
  for (let i = 0; i < 60; i++) tick(T0 + i * M, i % 5 === 4 ? null : STALE);
  assert.deepEqual(pushes, []);
  // index.ts steps it on every declined tick (lineDeclinedPushTick: a live night whose record carries a line ask,
  // keyed by the night and seeded from the record after a restart — lineForceChargeAtRisk.test.ts W5).
  assert.ok(INDEX.includes("    const dp = lineDeclinedPushTick(lineDeclinedPush, state, why, nowMs, "));
  assert.ok(INDEX.includes("    lineDeclinedPush = dp.mem;\n"));
  assert.ok(!INDEX.includes("'push:line-declined'"), 'no single per-night key');
  // The latest start (review 15): to ⌈L⌉ at the rate now, never after the dead zone; 2027-01-04 at 50.8%,
  // 14 kW: 4.79 kWh ⇒ 20.5 min + 15 ⇒ 35.5 min before the close — a start well after the 03:25 timed one.
  assert.equal(nfc.lineLatestStartMs(WIN_END, 56, 50.8, 92.16, 14, null, 3), WIN_END - ((0.052 * 92.16) / 14) * H - nfc.FORCE_CHARGE_JIT_BUFFER_MS);
  assert.equal(nfc.lineLatestStartMs(WIN_END, 56, 56, 92.16, 14, null, 3), WIN_END - FORCE_CHARGE_MIN_RUN_MS, 'at the ask: the last start the tick makes');
  assert.ok(INDEX.includes('      const latestAt = lineDeclinedLatestStartMs({\n'), 'the push quotes the latest start for ⌈L⌉');
});

/** (Fix12) A stale panel, as index.ts builds the tick's inputs with sp null: no slot readback, no connected slot, no coherent reading. */
const STALE_PANEL = { slotsOn: null, connectedSlots: [], slotSocPct: null, socCoherent: false, ceilingReadbackPct: null, poolSocPct: null, fullKwh: null, chargeRateKw: null } as Partial<ForceChargeOpts>;

test('★★★ T9 (Fix12) a stale panel is pushed as no readback, the fact it is, never as an incoherent reading; a fresh reading that fails coherence keeps its words; nothing is started, and the check order stays', () => {
  const W = nfc.FORCE_CHARGE_BLOCKER_WHY;
  const s = night();
  const t = WIN_START + H;
  const stale = decideForceCharge(s, t, fo(STALE_PANEL));
  assert.deepEqual(stale, { kind: 'none', why: W.noReadback });
  assert.equal(nfc.forceChargeBlockerClass((stale as { why: string }).why), 'noReadback', 'the push class, on real inputs at last');
  // A fresh panel whose SoC fails coherence: slots read, so the reading is there and is what fails.
  assert.deepEqual(decideForceCharge(s, t, fo({ socCoherent: false, slotsOn: [] })), { kind: 'none', why: W.incoherent });
  assert.deepEqual(decideForceCharge(s, t, fo({ socCoherent: false, slotsOn: [1] })), { kind: 'none', why: W.incoherent });
  assert.deepEqual(decideForceCharge(s, t, fo({ socCoherent: false, slotsOn: [], poolSocPct: null })), { kind: 'none', why: W.incoherent }, 'index.ts nulls the pool on an incoherent tick');
  // The order stays: red vitals first, then this, then the grid; a coherent night with no slot list keeps its own check, behind the grid.
  assert.deepEqual(decideForceCharge(s, t, fo({ ...STALE_PANEL, vitalsRed: true })), { kind: 'none', why: W.vitals });
  assert.deepEqual(decideForceCharge(s, t, fo({ ...STALE_PANEL, gridPresent: null })), { kind: 'none', why: W.noReadback });
  assert.deepEqual(decideForceCharge(s, t, fo({ slotsOn: null })), { kind: 'none', why: W.noReadback });
  assert.equal((decideForceCharge(s, t, fo({ slotsOn: null, gridPresent: null })) as { why: string }).why, `${W.gridPresence}unknown`);
  // The push, on the real step and the real body: the cause read, and no time later than the charge allows.
  let st = nfc.EMPTY_LINE_DECLINED_PUSH;
  const pushed: string[] = [];
  for (let i = 0; i <= 10; i++) { const r = nfc.lineDeclinedPushStep(st, (decideForceCharge(s, t + i * M, fo(STALE_PANEL)) as { why: string }).why, t + i * M); st = r.state; if (r.push) pushed.push(r.push); }
  assert.deepEqual(pushed, ['noReadback']);
  const body = (notify as unknown as { buildLineForceChargeDeclinedStart: (o: unknown) => { body: string } }).buildLineForceChargeDeclinedStart({ day: '2026-09-16', linePct: 55.55, why: W.noReadback, latestStartText: '4:11 AM' }).body;
  assert.ok(body.includes('cannot start yet — no live slot readback from the panel.'), body);
  assert.doesNotMatch(body, /incoherent/);
  // Only one expression moved in decideForceCharge: its kind stays 'none', and every other consumer of the why is the class, the log and the push.
  assert.ok(readFileSync(resolve(HERE, '../src/nightForceCharge.ts'), 'utf8').includes("  if (!o.socCoherent) return { kind: 'none', why: o.slotsOn == null ? W.noReadback : W.incoherent };\n"));
});

test('★★★ T9 (Fix14) the time the declined-start push quotes: one figure, each input erring early: a reading never above the reserve, the lower of the live and the deliverable rate, the EV\'s energy always; no time at or before now; the close less 20 min only with no capacity at all', () => {
  const latest = nfc.lineDeclinedLatestStartMs;
  const base = { nowMs: WIN_START, closeAtMs: WIN_END, askPct: 56, poolSocPct: null, liveFullWh: null, frozenFullWh: 92_160, rateKw: null, evDisplacedKwh: null, slotCount: 0 };
  // The finding: pool 50 to ask 56 at 10 kW: 33.2 min + the 15-min buffer: 04:11, where the fallback said 04:40.
  const stale = latest(base)!;
  assert.equal(stale, nfc.lineLatestStartMs(WIN_END, 56, 50, 92.16, 10, null, 0));
  assert.equal(Math.round((WIN_END - stale) / M), 48);
  assert.ok(stale < WIN_END - nfc.FORCE_CHARGE_MIN_RUN_MS, 'earlier than the last start');
  // The pool: a reading under the reserve is timed from the reading, which is earlier; at or above it, from the reserve, whatever it reads
  // at the push: the house draws it down there before the quoted time.
  const low = latest({ ...base, poolSocPct: 47 })!;
  assert.equal(low, nfc.lineLatestStartMs(WIN_END, 56, 47, 92.16, 10, null, 0));
  assert.ok(low < stale, 'earlier than from the reserve');
  for (const poolSocPct of [50, 50.5, 53, 56, 60, 62, 90]) assert.equal(latest({ ...base, poolSocPct }), stale, `pool ${poolSocPct}`);
  // A live capacity is the capacity, never the frozen one.
  assert.equal(latest({ ...base, liveFullWh: 80_000 }), nfc.lineLatestStartMs(WIN_END, 56, 50, 80, 10, null, 0));
  assert.equal(latest({ ...base, liveFullWh: 0 }), stale, 'a live zero is no capacity');
  // The rate: the lower of the two, either way round, on a live panel.
  const live = { ...base, poolSocPct: 53, liveFullWh: 92_160, slotCount: 3 };
  const at = (rate: number, ev: number | null) => nfc.lineLatestStartMs(WIN_END, 56, 50, 92.16, rate, ev, 3);
  assert.equal(latest({ ...live, rateKw: 14 }), at(10, null), 'a live 14 kW is over the deliverable 10: never later than it');
  assert.equal(latest({ ...live, rateKw: 10 }), at(10, null));
  assert.equal(latest({ ...live, rateKw: 7.42 }), at(7.42, null), 'a cap, a house or an EV on: the live rate sees it, the deliverable rate does not');
  assert.ok(at(7.42, null) < at(10, null), 'and it is the earlier');
  // The EV's energy, always: with a live rate on either side of the bound, and with none, where the plan rate stands.
  assert.equal(latest({ ...live, rateKw: 14, evDisplacedKwh: 4 }), at(10, 4), 'an EV ahead: the energy, which the live rate cannot see');
  assert.equal(latest({ ...live, rateKw: 7.42, evDisplacedKwh: 13 }), at(7.42, 13), 'the finding: the slow rate AND the energy');
  assert.ok(at(7.42, 13) < Math.min(at(10, 13), at(7.42, null)), 'earlier than either alone: neither runs late');
  assert.equal(latest({ ...live, evDisplacedKwh: 4 }), at(10, 4), 'no live rate: the plan rate, with the energy');
  assert.equal(latest({ ...base, evDisplacedKwh: 4 }), nfc.lineLatestStartMs(WIN_END, 56, 50, 92.16, 10, 4, 0));
  assert.notEqual(latest({ ...base, evDisplacedKwh: 4 }), stale);
  // The EV on: the live rate carries it and its energy counts it again. That errs early, and where it is gone by the push the guard has it.
  const twice = at(3.2, 20);
  assert.ok(twice < at(3.2, null));
  assert.equal(latest({ ...live, rateKw: 3.2, evDisplacedKwh: 20, nowMs: twice - 1 }), twice);
  assert.equal(latest({ ...live, rateKw: 3.2, evDisplacedKwh: 20, nowMs: twice }), null, 'no clock, never a time before the window');
  // The slots bound the rate: a one-Core home's frozen count moves the time, where its live rate is gone, and a live rate above what it delivers.
  assert.equal(latest({ ...base, frozenFullWh: 30_720, slotCount: 1 }), nfc.lineLatestStartMs(WIN_END, 56, 50, 30.72, 5.5, null, 1));
  assert.equal(latest({ ...live, slotCount: 1, rateKw: 7.42 }), nfc.lineLatestStartMs(WIN_END, 56, 50, 92.16, 5.5, null, 1));
  // No time at or before now: to the millisecond.
  assert.equal(latest({ ...base, nowMs: stale - 1 }), stale);
  assert.equal(latest({ ...base, nowMs: stale }), null, 'at now');
  assert.equal(latest({ ...base, nowMs: stale + 1 }), null, 'past');
  // No capacity at all: the last start, the one time the add-on can still name, and no push reaches it. No close: nothing.
  for (const frozenFullWh of [null, 0, Number.NaN]) assert.equal(latest({ ...base, frozenFullWh }), WIN_END - nfc.FORCE_CHARGE_MIN_RUN_MS, String(frozenFullWh));
  assert.equal(latest({ ...base, closeAtMs: null }), null);
  // The tick's wiring: now, the frozen projection and its connected count reach it, and only here.
  assert.ok(INDEX.includes(
    '      const latestAt = lineDeclinedLatestStartMs({\n'
    + "        nowMs, closeAtMs: writeWindowEndMs(state), askPct: state.forceChargeLineAskPct!, poolSocPct: socCoherent ? socNowPct : null,\n"
    + "        liveFullWh: fullWh, frozenFullWh: shp2.projection?.kind === 'shp2' ? shp2.projection.backupFullCapWh : null,\n"
    + '        rateKw: chargeRateKw, evDisplacedKwh,\n'
    + "        slotCount: sp != null ? connectedSlots.length : shp2.projection?.kind === 'shp2' ? (shp2.projection.sources ?? []).filter((c) => c?.hwConnect === true).length : 0,\n"
    + '      });\n'));
  assert.ok(INDEX.includes('latestStartText: latestAt != null ? fmtSiteClock(latestAt) : null,'));
  // The START keeps its rate and its EV energy, the double count included (it errs early, and it moves writes).
  assert.ok(INDEX.includes('    chargeRateKw,\n    evDisplacedKwh,\n    // v1.191.0 (S6, W5) — the run backstop of the tariff in effect'));
  const NFC_SRC = readFileSync(resolve(HERE, '../src/nightForceCharge.ts'), 'utf8');
  assert.ok(NFC_SRC.includes('if (nowMs < forceChargeLineStartAtMs(endMs, mode.startTargetPct, o.poolSocPct, o.fullKwh, o.chargeRateKw, o.evDisplacedKwh, slots.length)) {'));
});

/** (Fix13) index.ts's pushLineDeclinedIfDue over minute ticks: the real decision, the real tick, the real helper and the real body, with what
 *  the tick has at each minute. `frozen` is the projection a stale panel leaves: its nameplate and connected count. */
const declinedChain = (s: LineState, from: number, to: number, opts: (t: number) => ForceChargeOpts, frozen = { fullWh: 92_160, slots: 3 }) => {
  let mem: nfc.LineDeclinedPushMem = { day: null, st: nfc.EMPTY_LINE_DECLINED_PUSH };
  for (let t = from; t < to; t += M) {
    const o = opts(t);
    const a = decideForceCharge(s, t, o);
    assert.equal(a.kind, 'none', `no write on the walk: ${(WIN_END - t) / M} min out`);
    const why = (a as { why?: string }).why;
    const dp = nfc.lineDeclinedPushTick(mem, s, why, t, { cost: false, line: true });
    mem = dp.mem;
    if (dp.push != null) {
      const quoted = nfc.lineDeclinedLatestStartMs({
        nowMs: t, closeAtMs: WIN_END, askPct: s.forceChargeLineAskPct!, poolSocPct: o.socCoherent ? o.poolSocPct : null,
        liveFullWh: o.fullKwh != null ? o.fullKwh * 1000 : null, frozenFullWh: frozen.fullWh,
        rateKw: o.chargeRateKw, evDisplacedKwh: o.evDisplacedKwh, slotCount: o.slotsOn != null ? o.connectedSlots.length : frozen.slots,
      });
      const body = (notify as unknown as { buildLineForceChargeDeclinedStart: (o: unknown) => { body: string } }).buildLineForceChargeDeclinedStart({
        day: s.day, linePct: s.forceChargeLinePct, why: why!, latestStartText: quoted != null ? new Date(quoted).toISOString() : null,
      }).body;
      return { t, cls: dp.push, quoted, body };
    }
  }
  return null;
};
/** The finding's night: a 70.55 line, ask 71, the panel's ceiling read back, and the panel gone stale from `staleFromMin` before the close. */
const staleNight = (pool: number, staleFromMin: number) => {
  const s = night({ forceChargeLineAskPct: 71, forceChargeLinePct: 70.55 });
  const staleAt = WIN_END - staleFromMin * M + 5 * M; // index.ts's freshness: 5 min after the last report
  return declinedChain(s, WIN_END - staleFromMin * M - 30 * M, WIN_END - 25 * M, (t) => t < staleAt
    ? fo({ poolSocPct: pool, slotsOn: [], slotSocPct: { 1: pool, 2: pool, 3: pool }, ceilingReadbackPct: 81, chargeRateKw: 14 })
    : fo({ ...STALE_PANEL }));
};
const NO_CLOCK = 'The later it starts, the lower the pool may close, perhaps under the line; if it never starts, the add-on adds nothing above the 50% reserve.';

test('★★★ T9 (Fix13) a stale panel on a pool above the reserve: no clock already gone, words true in every outcome; the clock while it is still ahead', () => {
  for (const [pool, staleFromMin, pushedMin] of [[65, 85, 70], [62, 100, 85], [60, 110, 95]] as const) {
    const r = staleNight(pool, staleFromMin)!;
    assert.equal(r.cls, 'noReadback');
    assert.equal(r.t, WIN_END - pushedMin * M, `pool ${pool}`);
    assert.equal(r.quoted, null, 'the time from the reserve, 132 min out, is gone');
    assert.ok(r.body.endsWith(`cannot start yet — no live slot readback from the panel. ${NO_CLOCK}`), r.body);
    assert.doesNotMatch(r.body, /by ~/);
  }
  const ahead = staleNight(52, 200)!;
  assert.equal(ahead.t, WIN_END - 185 * M);
  assert.equal(ahead.quoted, nfc.lineLatestStartMs(WIN_END, 71, 50, 92.16, 10, null, 3), 'from the reserve at the plan rate');
  assert.ok(ahead.quoted! > ahead.t);
  assert.ok(ahead.body.includes('If it has not started by ~'), ahead.body);
  assert.doesNotMatch(ahead.body, /The later it starts/);
});

test('★★★ T9 (Fix13) one Core on a stale panel: its frozen count times the quote at what it delivers, where an empty slot list reads 10 kW', () => {
  const s = night({ forceChargeLineAskPct: 71, forceChargeLinePct: 70.55 });
  const opts = () => fo({ ...STALE_PANEL });
  const one = declinedChain(s, WIN_START + 30 * M, WIN_END - 25 * M, opts, { fullWh: 30_720, slots: 1 })!;
  assert.equal(one.quoted, nfc.lineLatestStartMs(WIN_END, 71, 50, 30.72, 5.5, null, 1));
  const unbounded = nfc.lineLatestStartMs(WIN_END, 71, 50, 30.72, 10, null, 1);
  assert.ok(one.quoted! < unbounded, 'earlier than the 10 kW an empty slot list reads');
  assert.equal(Math.round((WIN_END - one.quoted!) / M), 85, '6.45 kWh at 5.5 kW + the buffer');
});

test('★★★ T9 (Fix13) no capacity at all: the last start, and no push reaches it, for the decision declines on the clock from there and the clock is no blocker', () => {
  const s = night({ forceChargeLineAskPct: 71, forceChargeLinePct: 70.55 });
  const blind = { fullWh: 0, slots: 0 };
  const last = WIN_END - FORCE_CHARGE_MIN_RUN_MS;
  const r = declinedChain(s, WIN_END - 31 * M, WIN_END - M, () => fo({ ...STALE_PANEL }), blind)!;
  assert.deepEqual([r.t, r.quoted], [WIN_END - 21 * M, last], 'the last push there is: a minute before it');
  assert.equal(declinedChain(s, WIN_END - 30 * M, WIN_END - M, () => fo({ ...STALE_PANEL }), blind), null, 'a held 10 min that ends at the last start pushes nothing');
});

test('★★★ T9 (Fix13) the body: a line above the reserve with no time has no clock and no "the window close"; a line the reserve holds keeps its own sentence with or without one', () => {
  const build = (notify as unknown as { buildLineForceChargeDeclinedStart: (o: unknown) => { body: string } }).buildLineForceChargeDeclinedStart;
  const b = (linePct: number, latestStartText: string | null) => build({ day: '2026-09-16', linePct, why: 'grid presence is unknown', latestStartText }).body;
  assert.equal(b(55.55, null), `Night-charge: the force-charge for tonight's 55.6% outage line cannot start yet — grid presence is unknown. ${NO_CLOCK}`);
  assert.doesNotMatch(b(55.55, null), /window close|null|undefined/);
  assert.ok(b(55.55, '4:11 AM').endsWith('If it has not started by ~4:11 AM, the pool may close under the line; if it never starts, the add-on adds nothing above the 50% reserve.'));
  // v1.203.0 — a line the reserve holds is one at or under 49 (a 50% reserve holds the pool at 49): it keeps its own sentence; a line
  // stated at 50.00 is not held, and is told the pool may close under it.
  for (const t of [null, '4:11 AM']) assert.ok(b(49, t).endsWith('grid presence is unknown. If it never starts, the add-on adds nothing above the 50% reserve.'), String(t));
  assert.equal(b(50, null), `Night-charge: the force-charge for tonight's 50% outage line cannot start yet — grid presence is unknown. ${NO_CLOCK}`);
  assert.ok(b(49.5, '4:11 AM').endsWith('If it has not started by ~4:11 AM, the pool may close under the line; if it never starts, the add-on adds nothing above the 50% reserve.'));
});

test('★★★ v1.203.0 THE PANEL\'S HOLD in the ON failure and the declined start: a line in (49, 50] — the line force-charge\'s, since a 50% reserve holds the pool at 49 — is told the pool may close under it; a line at or under 49 is not', () => {
  const build = (notify as unknown as { buildLineForceChargeDeclinedStart: (o: unknown) => { body: string } }).buildLineForceChargeDeclinedStart;
  const on = (lineLinePct: number, slots: number[]) => buildNightForceChargeOnFailure({ day: '2026-09-16', slots, ourSlots: [1, 2, 3], retries: 1, noRetry: false, ceilingPct: null, lineLinePct } as never).body;
  for (const l of [49.5, 49.97, 50]) {
    assert.ok(on(l, [1, 2, 3]).includes(', and the pool may close the window under the line. '), `${l}: ${on(l, [1, 2, 3])}`);
    assert.ok(on(l, [2]).includes(', so the pool may close the window short of the line. '), `${l}: ${on(l, [2])}`);
    assert.ok(build({ day: '2026-09-16', linePct: l, why: 'grid presence is unknown', latestStartText: null }).body.endsWith(NO_CLOCK), `${l}`);
  }
  for (const l of [40, 48.5, 49]) {
    assert.doesNotMatch(on(l, [1, 2, 3]), /under the line|short of the line/, `${l}`);
    assert.doesNotMatch(on(l, [2]), /under the line|short of the line/, `${l}`);
    assert.doesNotMatch(build({ day: '2026-09-16', linePct: l, why: 'grid presence is unknown', latestStartText: '4:11 AM' }).body, /under the line/, `${l}`);
  }
});

test('★★ T9 the morning summary (review): "ran to the window close" only when the OFF was the window\'s; any other OFF says when and why', () => {
  const ran = nfc.forceChargeNightOutcome(onNight(), { cost: false, line: true } as never);
  const sum = (fc: unknown, close?: number) => buildNightChargeMorningSummary({ day: '2026-09-16', targetPct: 50, restorePct: 30, expectedKwh: 17.6, forceCharge: fc, ...(close != null ? { closePoolPct: close } : {}) } as never).body;
  assert.ok(sum(ran, 63).includes('force-charge ran to the window close for the 55.6% outage line; the pool read 63% at the close'), sum(ran, 63));
  const atClose = nfc.forceChargeNightOutcome(onNight({ forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd' }), { cost: false, line: true } as never);
  assert.ok(sum(atClose, 63).includes('force-charge ran to the window close for the 55.6% outage line'));
  for (const [reason, words] of [
    ['disabled', 'the force-charge was disabled by the options'], ['maxRun', 'the run backstop'], ['onPeakGuard', 'the on-peak guard, an hour before on-peak'],
    ['foreign', 'the reserve was set outside the add-on'], ['gridLoss', 'the grid was lost'],
  ] as const) {
    const fc = nfc.forceChargeNightOutcome(onNight({ forceChargeOffAtMs: WIN_END - 90 * M, forceChargeOffReason: reason }), { cost: false, line: false } as never);
    assert.equal(fc.kind, 'ran');
    const body = sum(fc, 58);
    assert.doesNotMatch(body, /to the window close/, `${reason}: ${body}`);
    assert.ok(body.includes(`force-charge ran for the 55.6% outage line until 3:30am (switched off: ${words}); the pool read 58% at the close`), body);
  }
  const never = nfc.forceChargeNightOutcome(night(), { cost: false, line: true } as never);
  assert.equal(never.kind, 'neverStarted');
  assert.match(sum(never), /force-charge for the 55\.6% outage line never started/);
  // A cost night's outcome is today's.
  const cost = nfc.forceChargeNightOutcome({ ...onNight({ forceChargeCeilingPct: 90, forceChargeLineAskPct: null, forceChargeLinePct: null, forceChargeMode: 'cost' }) }, true);
  assert.equal((cost as { stopPct?: number | null }).stopPct, 90);
  // The ARMED line.
  const note = (nfc as unknown as { forceChargeLineArmNote: (o: unknown) => string }).forceChargeLineArmNote({
    linePct: 55.55, startTargetPct: 61, panelCeilingPct: 80, expectedStartText: '04:01', timedByText: '04:40',
  });
  assert.equal(note, 'Force-charge: LINE — tonight\'s 55.6% outage line is above the 50% reserve: on from ~04:01 (timed to 61% by 04:40) to the window close; panel ceiling 80% as backstop.');
  // (review 2) a walk that reaches the panel ceiling: no backstop, the panel's stop and the re-ON named; index.ts passes it.
  const stopNote = (nfc as unknown as { forceChargeLineArmNote: (o: unknown) => string }).forceChargeLineArmNote({
    linePct: 65.95, startTargetPct: 71, panelCeilingPct: 80, expectedStartText: '23:00', timedByText: '04:40', ceilingStop: true,
  });
  assert.equal(stopNote, 'Force-charge: LINE — tonight\'s 66% outage line is above the 50% reserve: on from ~23:00 (timed to 71% by 04:40); '
    + 'expected to reach the panel\'s 80% ceiling, where the panel switches it off; switched back on under 71% before the close (at most twice).');
  assert.ok(INDEX.includes('      ceilingStop: plan?.expectedLineCeilingStop != null,\n'), 'index.ts passes the plan\'s ceiling stop to the 21:30 line');
});

/* ══ T10 — the gate ════════════════════════════════════════════════════════════════════════════════ */

test('★★ T10 the gate: a carried row closing at its line is clean; an envelope row is exempt; a carried row under is a strike, and counted', async () => {
  const { computeNightChargeReadiness, CURRENT_ALGO_VERSION, phoenixYmd } = await import('../src/nightChargeGate.js');
  const NOW = Date.UTC(2026, 9, 31, 4, 30);
  const row = (daysAgo: number, f: Record<string, unknown>) => ({
    plan_date: phoenixYmd(NOW - daysAgo * 86_400_000), algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast',
    issued_at_ms: NOW - daysAgo * 86_400_000, outcome_captured_at_ms: NOW - (daysAgo - 1) * 86_400_000,
    scored: 1, actuated: 1, cushion_shortfall: 0, plan_traj_floor_breached: 0, cushion_breached: 0,
    buy_err_kwh: 0.5, pv_err_frac: 0.05, load_err_frac: -0.05, pv_in_band: 1, load_in_band: 1, grid_home_coverage_frac: 0.95,
    reserve_floor_pct: 30, cushion_pct: 15, cushion_line_soc_pct: 55.55, cushion_trough_soc_pct: 55.55, window_kind: 'overnight',
    ...f,
  });
  const run = (f: Record<string, unknown>) => computeNightChargeReadiness([row(3, f)] as never, NOW).metrics;
  const held = run({ cushion_line_force_charge_pct: 56, window_close_soc_pct: 63, actual_min_soc_pct: 40 });
  assert.equal(held.activeStrikes, 0);
  assert.equal(held.lineForceChargeStrikes, 0);
  const envelope = run({ cushion_shortfall: 1, cushion_envelope_shortfall: 1, window_close_soc_pct: 50, actual_min_soc_pct: 40 });
  assert.equal(envelope.activeStrikes, 0, 'disclosed: physics, not fault');
  const under = run({ cushion_line_force_charge_pct: 56, window_close_soc_pct: 51, actual_min_soc_pct: 40 });
  assert.equal(under.activeStrikes, 1, 'G-i: a carried night that closed under its line is a strike (fail-closed)');
  assert.equal(under.lineForceChargeStrikes, 1);
  assert.equal(run({ window_close_soc_pct: 51, actual_min_soc_pct: 40 }).lineForceChargeStrikes, 0, 'a strike with no line force-charge is not counted as one');
});

/* ══ T11 — the ledger ══════════════════════════════════════════════════════════════════════════════ */

test('★★ T11 the plan columns: the ask where carried, the envelope flag where disclosed, NULL on a null plan', () => {
  const cols = (p: NightChargePlan | null) => (nca as unknown as { lineForceChargeLedgerColumns: (p: unknown) => Record<string, unknown> }).lineForceChargeLedgerColumns(p);
  assert.deepEqual(cols(yearPlan('2027-01-04 21:30', true)), { cushion_line_force_charge_pct: 56, cushion_envelope_shortfall: 0 });
  assert.deepEqual(cols(yearPlan('2027-01-04 21:30', false)), { cushion_line_force_charge_pct: null, cushion_envelope_shortfall: 1 });
  assert.deepEqual(cols(yearPlan('2027-01-04 21:30', undefined)), { cushion_line_force_charge_pct: null, cushion_envelope_shortfall: 0 });
  assert.deepEqual(cols(null), { cushion_line_force_charge_pct: null, cushion_envelope_shortfall: null });
  // Wiring: written unconditionally beside the line; force_charge_mode where force_charge_on_at_ms is.
  const fn = INDEX.slice(INDEX.indexOf('function recordNightPlanRow('), INDEX.indexOf('\n}\n', INDEX.indexOf('function recordNightPlanRow(')));
  assert.equal(fn.split('...lineForceChargeLedgerColumns(plan),').length - 1, 1);
  assert.match(INDEX, /stampLegOutcome\(state, \{ force_charge_on_at_ms: nowMs, force_charge_mode: [^}]+\}\)/);
  const rec = readFileSync(resolve(HERE, '../src/recorder.ts'), 'utf8');
  assert.ok(rec.includes("'cushion_line_force_charge_pct REAL', 'cushion_envelope_shortfall INTEGER',"));
  assert.ok(rec.includes("'cushion_line_force_charge_pct', 'cushion_envelope_shortfall',"));
  assert.ok(rec.includes("['force_charge_mode', 'TEXT']"));
});

test('★★ T11 the columns round-trip through the recorder, and an older row reads null', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ef-line-fc-'));
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = join(tmp, 'ecoflow.db');
  try {
    const { createRecorder } = await import('../src/recorder.js');
    const { SnapshotStore } = await import('../src/snapshot.js');
    const rec = createRecorder(new SnapshotStore(), () => {});
    try {
      const base = (d: string) => ({ plan_date: d, issued_at_ms: 1, algo_version: '3', posture: 'auto', objective: 'resilience_cushion', rationale: 'x',
        confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 30, target_soc_pct: 55.6, buy_kwh: 28, required_extra_kwh: 26,
        reserve_floor_pct: 30, cushion_pct: 15, cushion_kwh: 22.2, binding_cap: 'requirement', cushion_shortfall: 0,
        cushion_trough_soc_pct: 55.55, cushion_line_soc_pct: 55.55 });
      rec.recordNightPlan({ ...base('2027-01-04'), cushion_line_force_charge_pct: 56, cushion_envelope_shortfall: 0 } as never);
      rec.recordNightPlan(base('2027-01-03') as never);
      rec.recordNightOutcome('2027-01-04', { force_charge_mode: 'line' } as never);
      const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
      assert.equal(at('2027-01-04').cushion_line_force_charge_pct, 56);
      assert.equal(at('2027-01-04').cushion_envelope_shortfall, 0);
      assert.equal(at('2027-01-04').force_charge_mode, 'line');
      assert.equal(at('2027-01-03').cushion_line_force_charge_pct, null);
      assert.equal(at('2027-01-03').force_charge_mode, null);
    } finally { rec.close(); }
  } finally {
    if (prev === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ══ T12 — plumbing and wiring pins ════════════════════════════════════════════════════════════════ */

test('★★ T12 buildNightChargeInputs forwards the line gate (never on a backup leg); index.ts passes it on every leg and every tick', () => {
  const c = caseOf('2027-01-04 21:30');
  assert.equal(buildNightChargeInputs({ ...c.deps, lineForceChargeEligible: true } as never).lineForceChargeEligible, true);
  assert.equal(buildNightChargeInputs({ ...c.deps, lineForceChargeEligible: false } as never).lineForceChargeEligible, false);
  assert.equal('lineForceChargeEligible' in buildNightChargeInputs(c.deps) && buildNightChargeInputs(c.deps).lineForceChargeEligible !== undefined, false);
  assert.match(INDEX, /const lineForceChargeOn = \(role: ChargeLegRole = 'cost'\): boolean => legForceChargeEligible\(role, lineForceChargeEnabled\(\{ mode: NIGHT_CHARGE_MODE \}\)\);/);
  assert.ok(INDEX.includes('    lineForceChargeEligible: lineForceChargeOn(legRole),\n'), 'the planner input');
  assert.ok(INDEX.includes('lineEnabled: !opts.forceDisabled && lineForceChargeOn(legRoleOf(state)),'), 'the tick');
  assert.equal(INDEX.split('lineForceChargeEnabled: lineForceChargeOn(').length - 1, 2, 'both arm candidates');
  assert.ok(INDEX.includes('forceChargeCeilingSyncedPct: action.pct'), 'the sync persists what it wrote');
});

test('★★ T12 (review) the line-night surfaces are wired: the ON\'s mode stamp, the evening push\'s forceChargeLine, the morning close', () => {
  // W1 — the ON persists forceChargeOnStamp on the leg's LIVE gates (its behaviour: T6 above), and the ledger
  // and the ON-failure push read the mode it stamped.
  const tick = INDEX.slice(INDEX.indexOf('async function runForceChargeTick('), INDEX.indexOf('async function escalateForceChargeStuck('));
  assert.ok(tick.includes('const onStamp = forceChargeOnStamp(state, nowMs, action.slots, forceChargeGatesOn(legRoleOf(state)));\n'));
  assert.ok(tick.includes('    const onMode = onStamp.forceChargeMode;\n'));
  assert.ok(tick.includes('    persistNightActuation({ ...nightActuationMem, ...onStamp });\n'));
  assert.ok(tick.includes('stampLegOutcome(state, { force_charge_on_at_ms: nowMs, force_charge_mode: onMode });'));
  const stamped = nfc.forceChargeOnStamp(night(), WIN_END - H, [1, 2, 3], { cost: false, line: true });
  assert.equal(stamped.forceChargeMode, 'line');
  assert.equal(nfc.forceChargeOnStamp(night({ forceChargeCeilingPct: 90 }), WIN_END - H, [1], { cost: true, line: true }).forceChargeMode, 'cost');
  // (review 2) The ON-failure push's line sentence keys on the RECORD's line ask, never the stamped mode — a
  // cost-dominant night is stamped 'cost' and carries its line too (behaviour: lineForceChargeAtRisk.test.ts W5 #1).
  assert.ok(tick.includes('        ...forceChargeOnFailureNight(state),\n'));
  // W2 — the evening push's supervised context: the line force-charge on a line night, never a cost stop.
  const evening = INDEX.slice(INDEX.indexOf('async function runNightChargeEveningJobInner('), INDEX.indexOf('function shadowArmProbe('));
  assert.equal(evening.split('          ...armedForceChargeAnnouncement(armedCandidate, forceChargeGatesOn()),\n').length - 1, 1);
  const armedLine = night({ forceChargeRides: true });
  assert.deepEqual(nfc.armedForceChargeAnnouncement(armedLine, { cost: false, line: true }),
    { forceChargeTargetPct: null, forceChargeLine: { askPct: 56, linePct: 55.55, panelCeilingPct: 80 } });
  assert.deepEqual(nfc.armedForceChargeAnnouncement({ ...armedLine, forceChargeCeilingPct: 90 }, { cost: true, line: true }),
    { forceChargeTargetPct: 90, forceChargeLine: null }, 'cost-dominant: today\'s cost clause');
  assert.deepEqual(nfc.armedForceChargeAnnouncement(armedLine, { cost: false, line: false }), { forceChargeTargetPct: null, forceChargeLine: null });
  assert.deepEqual(nfc.armedForceChargeAnnouncement({ ...armedLine, forceChargeRides: false }, { cost: false, line: true }),
    { forceChargeTargetPct: null, forceChargeLine: null }, 'the stamp, never the option');
  // W3 — the morning account of a line night states where its pool read at the close (a fresh reading); (review 2)
  // on every night whose record carries a line ask (lineForceChargeAtRisk.test.ts W3).
  const restore = INDEX.slice(INDEX.indexOf('function sendRestoreSummary('), INDEX.indexOf('\n}\n', INDEX.indexOf('function sendRestoreSummary(')));
  assert.ok(restore.includes("      closePoolPct: lineNight != null ? freshPoolSocPct(nowMs) : null,\n"));
});

/* ══ A5 — the line force-charge armed on every qualifying night; carried only where its own reachable walk holds ═ */

type NotHeldFn = (p: unknown) => 'closeUnder' | 'aboveFull' | 'nearFull' | null;
const lineNotHeldOf = (p: unknown) => (nca as unknown as { lineNotHeldOf: NotHeldFn }).lineNotHeldOf(p);
/** A year case at `h` hours of cushion, eligibility as given, the LIVE cost gate (index.ts forceChargeOn: the cost
 *  objective and ARB_COST_MAX_SOC_PCT above 50) unless the fixture's own is asked for. */
const yearPlanAt = (label: string, h: number, basis: 'np' | 'm', o: { gate?: 'live' | 'fixture'; line?: boolean } = {}): LinePlan => {
  const c = caseOf(label);
  const deps: Record<string, unknown> = { ...c.deps, outageCushionHours: h, ...(basis === 'm' ? { cushionPoolScale: S944 } : {}) };
  if ((o.line ?? true) !== undefined) deps.lineForceChargeEligible = o.line ?? true;
  if ((o.gate ?? 'live') === 'live') deps.forceChargeEligible = deps.objectiveMode === 'cost' && ((deps.costMaxSocPct as number | undefined) ?? 90) > 50;
  return L(computeNightChargePlan(buildNightChargeInputs(deps as never)));
};
/** The supervised context the evening job passes: the armed record (armFromPlan) through armedForceChargeAnnouncement.
 *  A plan issued inside its window (a mid-window re-plan, which arms nothing) gets the record armFromPlan would write. */
const armedSupervised = (p: LinePlan, costGate: boolean) => {
  const rec = p.generatedAt < p.window!.startMs
    ? (armFromPlan as (...a: unknown[]) => NightActuationState | null)(emptyActuationState(), '2027-01-01', p, p.generatedAt, 30, costGate, null, true)
    : { ...emptyActuationState(), forceChargeRides: true, forceChargeCeilingPct: p.costCeilingSocPct ?? null,
      forceChargeLineAskPct: p.forceChargeLine?.askPct ?? null, forceChargeLinePct: p.forceChargeLine?.linePct ?? null } as NightActuationState;
  assert.ok(rec != null, 'armed');
  return {
    cancelDeadlineText: 'tonight at 11:00 PM', cancelDeadlineTextEs: 'esta noche a las 11:00 PM', targetPct: 50,
    ...nfc.armedForceChargeAnnouncement(rec!, { cost: costGate, line: true }),
  };
};
const liveCost = (label: string) => { const d = caseOf(label).deps as { objectiveMode?: string; costMaxSocPct?: number }; return d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50; };
const fixtureCost = (label: string) => (caseOf(label).deps as { forceChargeEligible?: boolean }).forceChargeEligible === true;
const r1 = (n: number) => Math.round(n * 10) / 10;

test('★★★ T13 closeUnder (2027-08-09 21:30, ×0.944, 13 h, live cost gate): armed, its own walk closes ~54.9% under the 68.85% line (v1.202.0, the measured pool; 57.3% before) — disclosed on every surface, and the force-charge still runs', () => {
  const p = yearPlanAt('2027-08-09 21:30', 13, 'm');
  assert.deepEqual(p.forceChargeLine, { askPct: 69, linePct: 68.85 }, 'armed');
  assert.equal(p.expectedForceChargeMode, 'line');
  assert.equal(p.expectedWriteLevelPct, 54.9);
  assert.equal(p.cushionShortfall, true);
  assert.equal(p.cushionShortfallCause, 'envelope', 'the sizing held the line: its own walk does not');
  assert.equal(p.cushionEnvelopeReason, 'closeUnder');
  assert.equal(lineNotHeldOf(p), 'closeUnder');
  assert.deepEqual(p.expectedLineCeilingStop, { ceilingPct: 80, startTargetPct: 74 });
  // The rationale: the line-mode sentence (what the force-charge does), then what it cannot hold.
  assert.ok(p.rationale.includes("tonight's 68.85% outage line is above it, so the panel's force-charge switches on at ~"), p.rationale);
  assert.ok(p.rationale.includes('runs until the panel switches it off at its 80% ceiling; the add-on switches it back on if the pool falls under 74% before the window closes (at most twice), ~54.9% expected at the close. '
    + 'After the window the reserve returns to '), p.rationale);
  assert.ok(p.rationale.includes(" NOTE: on the median load the pool is expected to close at ~54.9%, under tonight's 68.85% outage line, so the cushion is not fully held — residual risk remains."), p.rationale);
  assert.doesNotMatch(p.rationale, /no force-charge|not held tonight|too close to a full pool/);
  // The evening push: the line clause, then the NOTE; the title is the close.
  const sup = armedSupervised(p, liveCost('2027-08-09 21:30'));
  assert.deepEqual(sup.forceChargeLine, { askPct: 69, linePct: 68.85, panelCeilingPct: 80 });
  const msg = buildNightChargeMessage(p, 'charge', sup as never);
  assert.ok(msg.body.includes('the panel switches it off at its 80% force-charge ceiling, and the add-on switches it back on if the pool falls under 74% before the window closes (at most twice), ~54.9% expected at the close.'), msg.body);
  assert.ok(msg.body.includes(" NOTE: on the median load the pool is expected to close at ~54.9%, under tonight's 68.9% outage line — residual risk remains."), msg.body);
  assert.doesNotMatch(msg.body, /no force-charge|charge\/pool limits/);
  assert.equal(Number(/~([\d.]+)%/.exec(msg.title)?.[1]), 54.9, msg.title);
  // The card.
  const ct = cardText as unknown as { outageLineRow: (p: unknown) => string | null };
  assert.equal(ct.outageLineRow(p), "outage line 68.9% is above the 50% reserve — the panel's force-charge runs until the panel switches it off at its 80% ceiling, "
    + 'and the add-on switches it back on under 74% before the close (at most twice), ~54.9% expected at the close — under the line; residual risk remains');
  // The 21:30 ARMED line, as index.ts builds it.
  const note = (nfc as unknown as { forceChargeLineArmNote: (o: unknown) => string }).forceChargeLineArmNote({
    linePct: 68.85, startTargetPct: 74, panelCeilingPct: 80, expectedStartText: '23:00', timedByText: '04:40', ceilingStop: true,
    notHeld: { kind: lineNotHeldOf(p), closePct: p.expectedWriteLevelPct },
  });
  assert.ok(note.endsWith(' Line NOT held: ~54.9% expected at the close.'), note);
  // Spoken: the shortfall clause, never the plain shape's "keeps only 50 percent".
  const ann = eveningAnnouncement({ cycle: 'overnight', plan: p, shape: 'charge', supervised: sup, armRefused: null, mode: 'supervised' } as never);
  assert.ok(ann.spoken!.en.includes('Outage cushion not fully met.'), ann.spoken!.en);
  assert.ok(!ann.spoken!.en.includes('keeps only 50 percent'), ann.spoken!.en);
  assert.ok(ann.spoken!.en.includes('55 percent'), ann.spoken!.en);
  // The ledger: armed AND disclosed (A5: both columns set).
  const cols = (nca as unknown as { lineForceChargeLedgerColumns: (p: unknown) => Record<string, unknown> }).lineForceChargeLedgerColumns(p);
  assert.deepEqual(cols, { cushion_line_force_charge_pct: 69, cushion_envelope_shortfall: 1 });
  // One hour of cushion earlier the same night is carried, its walk at ~74.5% over the 64.79% line (77.2% on v1.200.0's walks).
  const h12 = yearPlanAt('2027-08-09 21:30', 12, 'm');
  assert.deepEqual([h12.forceChargeLine?.askPct, h12.expectedWriteLevelPct, h12.cushionShortfallCause ?? null], [65, 74.5, null]);
});

test('★★★ T14 no cut: as the cushion rises past ⌈L⌉ + 10 > 100 the force-charge stays armed — same start target, ceiling, close and buy — and the plan stops claiming the line', () => {
  const gates = (label: string) => ({ cost: liveCost(label), line: true });
  const startAndCeiling = (p: LinePlan, label: string) => {
    const m = nfc.forceChargeModeOf({ forceChargeCeilingPct: p.costCeilingSocPct, forceChargeLineAskPct: p.forceChargeLine!.askPct } as never, gates(label));
    return [nfc.armedWriteLevelPct(p as never, gates(label)), m?.panelCeilingPct ?? null];
  };
  // 2026-10-29 21:30, nameplate, 14 → 15 h (the line 89.39 → 93.63): at v1.199.1's cut 98.4% / 62.45 kWh → 50% / 19.88 kWh.
  const a14 = yearPlanAt('2026-10-29 21:30', 14, 'np');
  const a15 = yearPlanAt('2026-10-29 21:30', 15, 'np');
  assert.deepEqual([a14.cushionLineSocPct, a15.cushionLineSocPct], [89.39, 93.63]);
  assert.deepEqual([a14.forceChargeLine?.askPct, a15.forceChargeLine?.askPct], [90, 94], 'armed at both');
  assert.deepEqual(startAndCeiling(a14, '2026-10-29 21:30'), [95, 100]);
  assert.deepEqual(startAndCeiling(a15, '2026-10-29 21:30'), [95, 100]);
  assert.deepEqual([a14.expectedWriteLevelPct, a15.expectedWriteLevelPct], [92.8, 92.8]);
  assert.deepEqual([a14.expectedBuyKwh, a15.expectedBuyKwh], [62.45, 62.45]);
  assert.equal(a14.cushionShortfallCause ?? null, null, '14 h: carried (its caps note stands: the sizing fell short)');
  assert.equal(lineNotHeldOf(a14), null, '~92.8% holds 89.39%');
  assert.equal(a15.cushionEnvelopeReason, 'nearFull');
  assert.equal(lineNotHeldOf(a15), 'closeUnder', '15 h: the walk closes under 93.63% — the under-line NOTE, not the margin one');
  assert.ok(a15.rationale.includes("NOTE: on the median load the pool is expected to close at ~92.8%, under tonight's 93.63% outage line"), a15.rationale);
  assert.doesNotMatch(a15.rationale, /usual margin/);
  // 2027-07-30 21:30, nameplate, 15 → 16 h: 99.7% / 12.82 kWh at both (at v1.199.1: → 50% / 0).
  const b15 = yearPlanAt('2027-07-30 21:30', 15, 'np');
  const b16 = yearPlanAt('2027-07-30 21:30', 16, 'np');
  assert.deepEqual([b15.expectedWriteLevelPct, b16.expectedWriteLevelPct], [99.7, 99.7]);
  assert.deepEqual([b15.expectedBuyKwh, b16.expectedBuyKwh], [12.82, 12.82]);
  assert.deepEqual(startAndCeiling(b16, '2027-07-30 21:30'), [95, 100]);
  assert.equal(b16.cushionShortfallCause, 'envelope');
  assert.equal(lineNotHeldOf(b16), 'nearFull', 'the walk holds 93.72%, within 10 points of full: the margin NOTE');
  assert.ok(b16.rationale.includes("NOTE: tonight's 93.72% outage line is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin; the cushion is not assured — residual risk remains."), b16.rationale);
  // 2026-10-26 21:30, nameplate, 20 h: a 101.57% line, above a full pool.
  const c20 = yearPlanAt('2026-10-26 21:30', 20, 'np');
  assert.equal(c20.cushionLineSocPct, 101.57);
  assert.equal(c20.forceChargeLine?.askPct, 100);
  assert.equal(lineNotHeldOf(c20), 'aboveFull');
  assert.ok(c20.rationale.includes("NOTE: tonight's 101.57% outage line is above a full pool, so no charge can hold it — residual risk remains."), c20.rationale);
  assert.doesNotMatch(c20.rationale, /within 10 points/);
});

test('★★★ T16 the tick: a line within 10 points of full runs as a 90% line does (start 95, ceiling 100); its start and re-ON key on 95', () => {
  const mode = (c: number | null, ask: number, cost: boolean) => nfc.forceChargeModeOf({ forceChargeCeilingPct: c, forceChargeLineAskPct: ask } as never, { cost, line: true });
  const sc = (c: number | null, ask: number, cost: boolean) => { const m = mode(c, ask, cost) as { startTargetPct?: number; panelCeilingPct: number }; return [m.startTargetPct, m.panelCeilingPct]; };
  assert.deepEqual(sc(null, 89, false), [94, 99]);
  assert.deepEqual(sc(null, 90, false), [95, 100]);
  for (let ask = 91; ask <= 100; ask++) assert.deepEqual(sc(null, ask, false), [95, 100], `ask ${ask}`);
  // A cost ceiling of 98 (ARB_COST_MAX_SOC_PCT 96-100): ask 92 is near-full (95); ask 90 is not (⌈L⌉ + 10 = 100 ≤ 100): the cost's 98.
  assert.deepEqual(sc(98, 92, true), [95, 100]);
  assert.deepEqual(sc(98, 90, true), [98, 100], 'A5-viii: the near-full arm only above 100, never at it');
  // decideForceCharge at ask 98 (start 95): a pool above the start target and under the ceiling gets its ON at the "already
  // there" lead (the close less FORCE_CHARGE_MIN_RUN_MS and the JIT buffer), never before; a pool at 100 none at all.
  for (const pool of [96, 99.6]) {
    const s = night({ forceChargeLineAskPct: 98, forceChargeLinePct: 97.9 });
    const o = fo({ poolSocPct: pool, ceilingReadbackPct: 100 });
    assert.equal(firstOnBeforeClose(s, o), (FORCE_CHARGE_MIN_RUN_MS + FORCE_CHARGE_JIT_BUFFER_MS) / M, `pool ${pool}`);
  }
  assert.equal(firstOnBeforeClose(night({ forceChargeLineAskPct: 98, forceChargeLinePct: 97.9 }), fo({ poolSocPct: 100, ceilingReadbackPct: 100 })), null);
  // The line re-ON after the panel's stop at 100: under 95, never between 95 and the line.
  const latched = onNight({ forceChargeLineAskPct: 98, forceChargeLinePct: 97.9, forceChargeCeilingSyncedPct: 100, forceChargeOnLastAttemptMs: WIN_START + 2 * H });
  const o = (pool: number) => fo({ poolSocPct: pool, slotsOn: [], slotSocPct: { 1: pool, 2: pool, 3: pool }, ceilingReadbackPct: 100 });
  assert.equal(decideForceCharge(latched, WIN_END - H, o(94)).kind, 'lineReOn');
  assert.equal(decideForceCharge(latched, WIN_END - H, o(96)).kind, 'none', 'M4: no re-ON between 95 and a line of 96-100 (a residual, stated)');
});

test('★ T20 the carry tolerance is the scorer\'s; lineWalkHolds at its edge', async () => {
  const { REALIZED_CLOSE_TOLERANCE_PCT } = await import('../src/nightChargeGate.js');
  const n = nca as unknown as { LINE_CARRY_CLOSE_TOLERANCE_PCT: number; lineWalkHolds: (e: number | null, l: number) => boolean };
  assert.equal(n.LINE_CARRY_CLOSE_TOLERANCE_PCT, REALIZED_CLOSE_TOLERANCE_PCT);
  for (const l of [50.09, 68.85, 93.63]) {
    assert.equal(n.lineWalkHolds(l - 0.05, l), true, `${l}`);
    assert.equal(n.lineWalkHolds(l - 0.06, l), false, `${l}`);
    assert.equal(n.lineWalkHolds(null, l), true, 'no P50 basis: the walk\'s floor is the start target, above the line');
  }
  assert.equal(n.lineWalkHolds(68.9, 68.85), true);
  // (A5 fix) The edge in decimal literals — a round1 close against a round2 line, as the planner compares them. In binary
  // 50.35 − 0.05 is 50.300000000000004: a close exactly at L − 0.05 read as under it on 128 of these 501 pairs.
  for (const [e, l] of [[50.3, 50.35], [50.4, 50.45], [50.8, 50.85], [50.9, 50.95], [51.3, 51.35], [50.04, 50.09]] as const) {
    assert.equal(n.lineWalkHolds(e, l), true, `${e} at ${l} − 0.05`);
    assert.equal(lineNotHeldOf({ forceChargeLine: { askPct: Math.ceil(l), linePct: l }, expectedForceChargeMode: 'line', expectedWriteLevelPct: e, cushionLineSocPct: l }), null, `${e} / ${l}`);
  }
  const edge = Array.from({ length: 501 }, (_, i) => (500 + i) / 10).map((e) => [e, Math.round((e + 0.05) * 100) / 100] as const);
  assert.deepEqual(edge.filter(([e, l]) => !n.lineWalkHolds(e, l)), [], 'every close exactly at its line less 0.05 holds');
  assert.deepEqual(edge.filter(([e, l]) => n.lineWalkHolds(e, Math.round((l + 0.01) * 100) / 100)), [], 'and 0.01 under it does not');
  // …the card's mirror words the same edge alike (a carried edge night never shows "under the line")…
  const edgePlan = (e: number, l: number) => ({ forceChargeLine: { askPct: Math.ceil(l), linePct: l }, expectedForceChargeMode: 'line', expectedWriteLevelPct: e, cushionLineSocPct: l });
  const ctEdge = cardText as unknown as { lineNotHeldOfCard: NotHeldFn };
  const edgeUpTo100 = edge.filter(([, l]) => l + 0.01 <= 100);
  assert.deepEqual(edgeUpTo100.filter(([e, l]) => ctEdge.lineNotHeldOfCard(edgePlan(e, l)) !== null), [], 'the card: every edge close holds');
  assert.deepEqual(edgeUpTo100.filter(([e, l]) => ctEdge.lineNotHeldOfCard(edgePlan(e, Math.round((l + 0.01) * 100) / 100)) !== 'closeUnder'), [], 'the card: 0.01 under is under');
  assert.deepEqual(edgeUpTo100.filter(([e, l]) => lineNotHeldOf(edgePlan(e, l)) !== null), [], 'the server alike');
  // …and the scorer at the same edge: the realized close verdict and its no-reading branch (the armed-never-ran strike: T10b).
  const { realizedCushionBreach } = await import('../src/nightChargeGate.js');
  const closeRow = (close: number | null, low: number | null, line: number) => ({
    reserve_floor_pct: 30, cushion_pct: 15, cushion_line_soc_pct: line, actual_min_soc_pct: low, window_kind: 'overnight', window_close_soc_pct: close,
  });
  for (const [e, l] of [[50.3, 50.35], [50.8, 50.85], [51.3, 51.35]] as const) {
    assert.equal(realizedCushionBreach(closeRow(e, 40, l) as never), 0, `a ${e}% close at ${l} − 0.05: held`);
    assert.equal(realizedCushionBreach(closeRow(e - 0.1, 40, l) as never), 1, `${e - 0.1}: under`);
    assert.equal(realizedCushionBreach(closeRow(null, e, l) as never), 0, `no reading; a ${e}% low after the close: held`);
  }
  assert.deepEqual(edge.filter(([e, l]) => realizedCushionBreach(closeRow(e, 40, l) as never) !== 0), [], 'the scorer agrees on all 501');
});

test('★★★ T21 (H1) the stated close is what the window can reach: capped at the window-open pool plus the deliverable (and the P50 sun), never under the reserve; the panel\'s stop named only where reachable', () => {
  // (a) 2026-10-29 21:30, nameplate, 14 h: the walk closed ~98.4% at the 100% ceiling; the window delivers 57.92 kWh to a
  // pool opening at 30% of 92.16: 30 + 57.92 / 92.16 × 100 = 92.8%. No stop: the window cannot reach the ceiling.
  const a = yearPlanAt('2026-10-29 21:30', 14, 'np');
  assert.equal(a.expectedStartSocPct, 30);
  assert.equal(a.expectedDeliverableBound, true);
  assert.equal(a.expectedWriteLevelPct, 92.8);
  assert.equal(a.expectedWriteLevelPct, r1(30 + ((a.expectedBuyKwh! * 0.927) / 92.16) * 100));
  assert.equal('expectedLineCeilingStop' in a, false);
  assert.ok(a.rationale.includes("so the panel's force-charge switches on at ~23:00 and stays on until the window closes, taking the pool to ~92.8%."), a.rationale);
  assert.match(a.rationale, /^Charge toward ~92\.8% in the /);
  assert.doesNotMatch(a.rationale, /98\.4|the panel switches it off at its/);
  // (b) 2026-10-29 +1 01:30 at the fixture's own hours: the window from 01:30 cannot reach the walk's ~78.5%, no stop. On
  // nameplate the reach is ~63.9%, which holds the 63.94% line within the tolerance — no NOTE. At 0.944 (65.95) the same
  // deliverable is more points of the measured pool (v1.202.0): ~66.4%, over the line — carried, with the caps note (the
  // sizing fell short) and no under-line NOTE (v1.200.0's walks reached ~63.9% there, and said it was under).
  const bn = L(yearPlan('2026-10-29 +1 01:30', true, null));
  const bm = L(yearPlan('2026-10-29 +1 01:30', true));
  for (const b of [bn, bm]) {
    assert.equal(b.expectedDeliverableBound, true);
    assert.equal('expectedLineCeilingStop' in b, false);
  }
  assert.deepEqual([bn.expectedWriteLevelPct, bm.expectedWriteLevelPct], [63.9, 66.4]);
  assert.equal(bn.cushionLineSocPct, 63.94);
  assert.equal(lineNotHeldOf(bn), null);
  assert.doesNotMatch(bn.rationale, /NOTE: on the median load/);
  assert.equal(bm.cushionLineSocPct, 65.95);
  assert.equal(bm.cushionShortfallCause ?? null, null, 'carried');
  assert.equal(bm.cushionShortfall, true, 'the caps note');
  assert.equal(lineNotHeldOf(bm), null);
  assert.ok(bm.rationale.includes('NOTE: charge/pool caps prevent fully meeting the cushion — residual risk remains.'), bm.rationale);
  assert.doesNotMatch(bm.rationale, /NOTE: on the median load/);
  // …and the evening push of the carried night says the caps note (cause null), and nothing of a close under the line.
  const bmPush = buildNightChargeMessage(bm, 'charge', armedSupervised(bm, fixtureCost('2026-10-29 +1 01:30')) as never);
  assert.ok(bmPush.body.includes('charge/pool limits prevent fully meeting the cushion'), bmPush.body);
  assert.doesNotMatch(bmPush.body, /NOTE: on the median load/);
  // (c) The P50 sun in the window counts toward the reach (a mid-day window): a walk whose close is above the open plus the
  // deliverable but within the open plus the deliverable and the window's P50 PV keeps its close.
  const D0 = Date.UTC(2026, 9, 21, 17); // 10:00 MST
  const sunHours = Array.from({ length: 8 }, (_, i) => ({ ts: D0 + i * H, pvP10W: 1500, pvP50W: 3500, loadP90W: 2500, loadP50W: 1200, evP90W: 0 }));
  const ebuy = (deliverableKwh: number) => (nca as unknown as { expectedBuyFromPlan: (o: unknown) => { buyKwh: number | null; levelPct: number | null; deliverableBound?: boolean; mode?: string; ceilingStop?: true } }).expectedBuyFromPlan({
    setpointSocPct: 56, costCeilingSocPct: null, forceChargeEligible: false, forceChargeLine: { askPct: 66, linePct: 65.4 }, lineForceChargeEligible: true,
    tickPoolKwh: 92.16, startKwh: 0.55 * 92.16, deliverableKwh, fullKwh: 92.16, legEff: 0.927,
    window: { hours: sunHours, fromMs: D0, windowEndMs: D0 + 5 * H, dischargeEff: 0.94, chargeCapKw: 17.8, envelopeKw: 17, acceptKw: null },
  });
  const free = ebuy(1e6);
  assert.equal(free.mode, 'line');
  assert.equal(free.deliverableBound ?? false, false);
  const liftKwh = free.buyKwh! * 0.927;
  let pvKwh = 0;
  for (let t = D0; t < D0 + 5 * H; t += 5 * M) pvKwh += chargeLegStep(3.5 * (5 / 60), 0.927);
  const closeKwh = (free.levelPct! / 100) * 92.16;
  const lo = closeKwh - 0.55 * 92.16 - pvKwh;
  const hi = Math.min(liftKwh, closeKwh - 0.55 * 92.16);
  assert.ok(hi - lo > 1, `a deliverable that binds the walk below its close and above its close less the sun: (${lo.toFixed(2)}, ${hi.toFixed(2)})`);
  const d = Math.max(lo, 0) + (hi - Math.max(lo, 0)) / 2;
  const bound = ebuy(d);
  assert.equal(bound.deliverableBound, true);
  assert.equal(bound.levelPct, free.levelPct, 'the sun in the window reaches the walk\'s close: not capped');
  assert.ok(0.55 * 92.16 + d < closeKwh - 0.5, 'without the sun the reach would be under the close');
  // (A5 fix) …and the other side: a deliverable under `lo`, where even the sun leaves the reach under the walk's close. The
  // close is capped at exactly the open plus the deliverable plus the window's P50 PV (no more sun than the window has),
  // and the panel's stop the free walk reaches is not stated.
  assert.equal(free.ceilingStop, true, 'the free walk reaches the 80% ceiling');
  assert.ok(lo > 2, `room under lo (${lo.toFixed(2)})`);
  for (const dl of [0, 0.5, 1, lo - 1]) {
    const capped = ebuy(dl);
    assert.equal(capped.deliverableBound, true, `${dl}`);
    assert.equal(capped.levelPct, r1(((0.55 * 92.16 + dl + pvKwh) / 92.16) * 100), `deliverable ${dl.toFixed(2)}: the reach`);
    assert.ok(capped.levelPct! < free.levelPct!, `${dl}`);
    assert.equal(capped.ceilingStop, undefined, `deliverable ${dl.toFixed(2)}: no stop the window cannot reach`);
  }
  // (d) 2026-11-27 21:30, nameplate, 17 h: a one-hour window; the pool opens at ~42.7% and the window delivers 7.2 kWh:
  // the reach is under the 50% reserve, so the stated close is the reserve, under the 50.09% line — 'closeUnder'.
  const dd = yearPlanAt('2026-11-27 21:30', 17, 'np');
  assert.equal(dd.cushionLineSocPct, 50.09);
  assert.equal(dd.expectedWriteLevelPct, 50);
  assert.equal(dd.cushionEnvelopeReason, 'closeUnder');
  assert.equal(lineNotHeldOf(dd), 'closeUnder');
  // (e) 2027-02-15 21:30, nameplate, 18 h: the walk's ~79.2% capped to ~69.7%, still at or over the 69.24% line on the median walk.
  // v1.205.0 — no longer carried: counted from the end of the at-open allowance the window's reach does not hold it ('lateStart');
  // the stated close is the median's, unchanged (lineAtOpenAllowance.test.ts AO-4).
  const e = yearPlanAt('2027-02-15 21:30', 18, 'np');
  assert.equal(e.expectedWriteLevelPct, 69.7);
  assert.equal(e.cushionShortfallCause ?? null, 'envelope');
  assert.equal(e.cushionEnvelopeReason, 'lateStart');
  assert.equal(lineNotHeldOf(e), 'lateStart');
});

test('★★ T19 the worked nights on every surface: one level (title, clause, spoken, card = the expected close), the NOTE by what the walk cannot hold, never "no force-charge"', () => {
  const nights: Array<[string, number, 'np' | 'm', string, string, string, string]> = [
    // label, h, basis, kind, rationale NOTE, push NOTE, card tail
    ['2027-08-09 21:30', 13, 'm', 'closeUnder',
      " NOTE: on the median load the pool is expected to close at ~54.9%, under tonight's 68.85% outage line, so the cushion is not fully held — residual risk remains.",
      " NOTE: on the median load the pool is expected to close at ~54.9%, under tonight's 68.9% outage line — residual risk remains.",
      ' — under the line; residual risk remains'],
    ['2026-10-29 21:30', 15, 'np', 'closeUnder',
      " NOTE: on the median load the pool is expected to close at ~92.8%, under tonight's 93.63% outage line, so the cushion is not fully held — residual risk remains.",
      " NOTE: on the median load the pool is expected to close at ~92.8%, under tonight's 93.6% outage line — residual risk remains.",
      ' — under the line; residual risk remains'],
    ['2027-07-30 21:30', 16, 'np', 'nearFull',
      " NOTE: tonight's 93.72% outage line is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin; the cushion is not assured — residual risk remains.",
      " NOTE: tonight's 93.7% outage line is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin — residual risk remains.",
      ' — within 10 points of a full pool, not held with its usual margin; residual risk remains'],
    ['2026-10-26 21:30', 20, 'np', 'aboveFull',
      " NOTE: tonight's 101.57% outage line is above a full pool, so no charge can hold it — residual risk remains.",
      " NOTE: tonight's 101.6% outage line is above a full pool, so no charge can hold it — residual risk remains.",
      ' — the line is above a full pool; residual risk remains'],
  ];
  const ct = cardText as unknown as { outageLineRow: (p: unknown) => string | null; lineNotHeldOfCard: NotHeldFn };
  const armTail: Record<string, (e: number) => string> = {
    closeUnder: (e) => ` Line NOT held: ~${e}% expected at the close.`, aboveFull: () => ' Line NOT held: above a full pool.', nearFull: () => ' Line NOT held: within 10 points of a full pool.',
  };
  for (const [label, h, basis, kind, ratNote, pushNote, cardTail] of nights) {
    const where = `${label} ${basis} ${h} h`;
    const p = yearPlanAt(label, h, basis);
    const E = p.expectedWriteLevelPct!;
    assert.equal(lineNotHeldOf(p), kind, where);
    assert.equal(ct.lineNotHeldOfCard(p), kind, `${where}: the card's mirror`);
    assert.ok(p.rationale.includes(ratNote), `${where}: ${p.rationale}`);
    assert.doesNotMatch(p.rationale, /no force-charge|not held tonight|too close to a full pool/, where);
    const sup = armedSupervised(p, liveCost(label));
    assert.ok(sup.forceChargeLine != null, `${where}: the push names the line force-charge`);
    const msg = buildNightChargeMessage(p, 'charge', sup as never);
    assert.ok(msg.body.includes(pushNote), `${where}: ${msg.body}`);
    assert.doesNotMatch(msg.body, /no force-charge|too close to a full pool/, where);
    assert.equal(Number(/~([\d.]+)%/.exec(msg.title)?.[1]), r1(E), `${where}: the title is the close`);
    assert.ok(msg.body.includes(`~${r1(E)}%`), `${where}: the clause names it`);
    const row = ct.outageLineRow(p)!;
    assert.ok(row.endsWith(cardTail), `${where}: ${row}`);
    assert.ok(row.includes(`~${r1(E)}%`), `${where}: ${row}`);
    assert.doesNotMatch(row, /not held tonight|no force-charge/, where);
    const ann = eveningAnnouncement({ cycle: 'overnight', plan: p, shape: 'charge', supervised: sup, armRefused: null, mode: 'supervised' } as never);
    assert.ok(ann.spoken!.en.includes(`${Math.round(E)} percent`), `${where}: ${ann.spoken!.en}`);
    assert.ok(ann.spoken!.en.includes('Outage cushion not fully met.'), where);
    assert.ok(ann.spoken!.en.length + ann.spoken!.es.length <= MAX_SPOKEN_ADVISORY_CHARS, `${where}: ${ann.spoken!.en.length + ann.spoken!.es.length}`);
    const note = (nfc as unknown as { forceChargeLineArmNote: (o: unknown) => string }).forceChargeLineArmNote({
      linePct: p.cushionLineSocPct, startTargetPct: 95, panelCeilingPct: 100, expectedStartText: '23:00', timedByText: '04:40',
      ceilingStop: p.expectedLineCeilingStop != null, notHeld: { kind, closePct: E },
    });
    assert.ok(note.endsWith(armTail[kind](E)), `${where}: ${note}`);
  }
  // A held line (2027-08-09 at 12 h) and a night with no line: no tail anywhere.
  const held = yearPlanAt('2027-08-09 21:30', 12, 'm');
  assert.equal(lineNotHeldOf(held), null);
  assert.equal(ct.lineNotHeldOfCard(held), null);
  assert.doesNotMatch(ct.outageLineRow(held)!, /residual risk/);
  // (A5 fix) …and its evening push carries no not-held NOTE (or any residual-risk sentence): the force-charge carries it.
  const heldPush = buildNightChargeMessage(held, 'charge', armedSupervised(held, liveCost('2027-08-09 21:30')) as never).body;
  assert.ok(heldPush.includes('for tonight\'s 64.8% outage line') && heldPush.includes('~74.5% expected at the close'), heldPush);
  assert.doesNotMatch(heldPush, /NOTE: (on the median load|tonight's [\d.]+% outage line is)|not held|residual risk/, heldPush);
  assert.doesNotMatch(held.rationale, /NOTE: (on the median load|tonight's [\d.]+% outage line is)|not held|residual risk/, held.rationale);
  // A carried night whose walk holds but whose sizing fell short (2026-10-29 21:30 on nameplate at 14 h, ~92.8% over its
  // 89.39% line): the caps note alone — one residual-risk sentence, no line NOTE.
  const capped = yearPlanAt('2026-10-29 21:30', 14, 'np');
  assert.deepEqual([capped.cushionShortfall, capped.cushionShortfallCause ?? null, lineNotHeldOf(capped)], [true, null, null]);
  const cappedPush = buildNightChargeMessage(capped, 'charge', armedSupervised(capped, liveCost('2026-10-29 21:30')) as never).body;
  assert.equal((cappedPush.match(/residual risk/g) ?? []).length, 1, cappedPush);
  assert.ok(cappedPush.includes('NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.'), cappedPush);
  assert.doesNotMatch(cappedPush, /NOTE: (on the median load|tonight's [\d.]+% outage line is)|not held/, cappedPush);
  const plain =(nfc as unknown as { forceChargeLineArmNote: (o: unknown) => string }).forceChargeLineArmNote({
    linePct: 64.79, startTargetPct: 70, panelCeilingPct: 80, expectedStartText: '23:00', timedByText: '04:40', ceilingStop: true, notHeld: null,
  });
  assert.doesNotMatch(plain, /NOT held/);
});

test('★★ T19 the card warns on what the walk cannot hold, the cause or not (a carried night whose sizing fell short and whose walk closes under)', () => {
  const card = readFileSync(resolve(HERE, '../../web/src/cards/NightChargeCard.tsx'), 'utf8');
  assert.ok(card.includes("plan.cushionShortfallCause != null || lineNotHeldOfCard(plan) != null ? 'text-warn' : 'text-muted'"), 'the line row\'s class');
  const ct = cardText as unknown as { outageLineRow: (p: unknown) => string | null; lineNotHeldOfCard: NotHeldFn };
  // v1.202.0 — 2026-11-13 21:30 at 0.944 (2026-10-29 +1 01:30 now reaches its line on the measured pool, T21b).
  const bm = L(yearPlan('2026-11-13 21:30', true));
  assert.deepEqual([bm.cushionShortfall, bm.cushionShortfallCause ?? null], [true, null]);
  assert.equal(ct.lineNotHeldOfCard(bm), 'closeUnder');
  assert.ok(ct.outageLineRow(bm)!.endsWith(' — under the line; residual risk remains'), String(ct.outageLineRow(bm)));
  // The defensive row: an armed, disclosed night whose walk is not in line mode still says something.
  const odd = { cushionShortfall: true, cushionShortfallCause: 'envelope', cushionEnvelopeReason: 'nearFull', cushionLineSocPct: 92.34, forceChargeLine: { askPct: 93, linePct: 92.34 } };
  assert.match(ct.outageLineRow(odd)!, /^outage line 92\.3% is above the 50% the panel accepts as a reserve — /);
  assert.doesNotMatch(ct.outageLineRow(odd)!, /not held tonight|no force-charge/);
  // v1.202.0 — a night the cost force-charge carries whose walk past its stop closes under the line names that close and its
  // stop, whether its sizing held the line (disclosed, 'closeUnder') or fell short (no envelope cause, the caps row beside it);
  // a close at L − 0.05 holds, and its night has no row.
  const cost = { cushionShortfall: true, cushionLineSocPct: 52.7, forceChargeLine: { askPct: 53, linePct: 52.7 }, expectedWriteLevelPct: 70,
    expectedForceChargeStartMs: 1, expectedCloseAfterStopPct: 50 };
  const costRow = "outage line 52.7% is above the 50% the panel accepts as a reserve — ~50% expected at the close, under the line (the cost force-charge's stop is ~70%); residual risk remains";
  assert.equal(ct.outageLineRow({ ...cost, cushionShortfallCause: 'envelope', cushionEnvelopeReason: 'closeUnder' }), costRow, 'disclosed');
  assert.equal(ct.outageLineRow(cost), costRow, 'sized short');
  assert.equal(ct.lineNotHeldOfCard(cost), 'closeUnder');
  assert.equal(ct.outageLineRow({ ...cost, expectedCloseAfterStopPct: 52.65 }), null, 'held at L − 0.05');
  assert.equal(ct.outageLineRow({ ...cost, expectedCloseAfterStopPct: undefined, cushionShortfallCause: 'envelope', cushionEnvelopeReason: 'nearFull' }),
    'outage line 52.7% is above the 50% the panel accepts as a reserve — its force-charge runs, but the line is not claimed; residual risk remains');
});

test('★★ T19 the mid-day push and its shadow record: a leg with a line ask is never told "no force-charge carries it" — worded by what its walk cannot hold, or (L4) armed and not claimed when that is lost', async () => {
  const { buildMiddayPlanMessage } = await import('../src/chargeText.js');
  const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
  const cost = {
    windowStartMs: phx(10, 15, 10), windowEndMs: phx(10, 15, 15), levelPct: 89.6, reservePct: 50, expectedKwh: 34.1, buyKwh: 58.2,
    toward: false, forceCharge: true, charges: true, basisComplete: true, cushionShortfall: true, cushionShortfallCause: 'envelope' as const,
  };
  const input = (c: Record<string, unknown>) => ({
    nowMs: phx(10, 14, 21, 30), mode: 'supervised', cost: { ...cost, ...c }, backup: null, onPeak: { startMs: phx(10, 15, 16), endMs: phx(10, 15, 19) },
    refreshAtMs: phx(10, 15, 9, 30), costApplyAtMs: phx(10, 15, 10), backupApplyAtMs: null, costRestoreAtMs: phx(10, 15, 15), refused: null,
  });
  const body = (c: Record<string, unknown>) => buildMiddayPlanMessage(input(c) as never).body;
  // No line ask: v1.200.0's words, byte for byte.
  assert.ok(body({}).includes(' NOTE: the outage line is above the 50% the panel accepts as a reserve and no force-charge carries it on this leg — residual risk remains.'));
  const words: Record<string, string> = {
    closeUnder: " NOTE: on the median load this leg's pool is expected to close under its outage line — residual risk remains.",
    aboveFull: " NOTE: this leg's outage line is above a full pool, so no charge can hold it — residual risk remains.",
    nearFull: " NOTE: this leg's outage line is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin — residual risk remains.",
  };
  for (const [kind, w] of Object.entries(words)) {
    const b = body({ lineAskPct: 93, lineNotHeld: kind });
    assert.ok(b.includes(w), `${kind}: ${b}`);
    assert.doesNotMatch(b, /no force-charge carries it/, kind);
  }
  // A carried leg whose sizing fell short (no cause) and whose walk closes under: the NOTE beside the caps note.
  const capped = body({ cushionShortfallCause: undefined, lineAskPct: 66, lineNotHeld: 'closeUnder' });
  assert.ok(capped.includes('charge/pool limits prevent fully meeting the cushion') && capped.includes(words.closeUnder), capped);
  // (L4) The kind lost (a record from before it, or an unknown value dropped on restore): armed, never "no force-charge".
  const lost = body({ lineAskPct: 93 });
  assert.ok(lost.includes(" NOTE: this leg's outage line is above the 50% the panel accepts as a reserve; its force-charge runs, but the plan does not claim the line — residual risk remains."), lost);
  assert.doesNotMatch(lost, /no force-charge carries it/);
  // (A5 fix) A carried leg whose walk holds and whose sizing held (no cause, no kind, no shortfall): no NOTE at all.
  const heldLeg = body({ cushionShortfallCause: undefined, cushionShortfall: false, lineAskPct: 66 });
  assert.doesNotMatch(heldLeg, /NOTE|residual risk/, heldLeg);
  // …and beside it a backup leg that discloses its own line (its reserve write cannot hold it, nothing armed there): the
  // backup leg's sentence, whatever this leg's — held, or with a kind.
  const backup = { windowStartMs: phx(10, 14, 23), windowEndMs: phx(10, 15, 5), reservePct: 50, expectedKwh: 12.4, buyKwh: 20.1,
    cushionShortfall: true, cushionShortfallCause: 'envelope' as const };
  const withBackup = (c: Record<string, unknown>) => buildMiddayPlanMessage({ ...input(c), backup, backupApplyAtMs: phx(10, 14, 22, 55) } as never).body;
  const backupNote = ' NOTE: the outage line is above the 50% the panel accepts as a reserve and no force-charge carries it on the backup leg — residual risk remains.';
  const heldBeside = withBackup({ cushionShortfallCause: undefined, cushionShortfall: false, lineAskPct: 66 });
  assert.ok(heldBeside.includes(backupNote), heldBeside);
  assert.equal((heldBeside.match(/NOTE/g) ?? []).length, 1, heldBeside);
  assert.doesNotMatch(heldBeside, /no force-charge carries it on this leg/);
  const kindBeside = withBackup({ lineAskPct: 93, lineNotHeld: 'closeUnder' });
  assert.ok(kindBeside.includes(words.closeUnder) && kindBeside.includes(backupNote), kindBeside);
  assert.doesNotMatch(kindBeside, /no force-charge carries it on this leg/);
  // With no ask on this leg, as before: the backup leg's sentence (v1.200.0's words).
  assert.ok(withBackup({ cushionShortfallCause: undefined, cushionShortfall: false }).includes(backupNote));
  // The shadow record carries the kind beside the ask, and its restore keeps only the three values.
  const ms = await import('../src/middayShadow.js');
  const p = yearPlanAt('2027-08-09 21:30', 13, 'm');
  const leg = { role: 'cost', kind: 'super_off_peak', startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) };
  const sum = (ms as unknown as { summariseLeg: (l: unknown, s: unknown, a: unknown) => Record<string, unknown> }).summariseLeg(leg, { plan: p, windowPvP50Kwh: null, windowLoadP50Kwh: null }, { wouldArm: true, disposition: 'would arm' });
  assert.equal(sum.lineAskPct, 69);
  assert.equal(sum.lineNotHeld, 'closeUnder');
  const rec = { version: 1, day: '2026-10-14', computedAtMs: phx(10, 14, 21, 30), why: 'midday', mode: 'supervised', backup: null, cost: sum, refresh: null, note: null };
  const back = ms.coerceMiddayShadowRecord(JSON.parse(JSON.stringify(rec)))!;
  assert.equal((back.cost as unknown as Record<string, unknown>).lineNotHeld, 'closeUnder');
  const bogus = ms.coerceMiddayShadowRecord(JSON.parse(JSON.stringify({ ...rec, cost: { ...sum, lineNotHeld: 'tooHigh' } })))!;
  assert.equal('lineNotHeld' in bogus.cost!, false, 'an unknown value is dropped');
  const held = (ms as unknown as { summariseLeg: (l: unknown, s: unknown, a: unknown) => Record<string, unknown> }).summariseLeg(leg, { plan: yearPlanAt('2027-08-09 21:30', 12, 'm'), windowPvP50Kwh: null, windowLoadP50Kwh: null }, { wouldArm: true, disposition: 'would arm' });
  assert.equal('lineNotHeld' in held, false, 'a held line: no field');
  // …and the evening notice it would send is told both.
  const { buildApsREvModel } = await import('../src/tariff.js');
  const ann = ms.middayShadowAnnounceInput(back, buildApsREvModel())!;
  assert.equal((ann.cost as unknown as Record<string, unknown>).lineAskPct, 69);
  assert.equal((ann.cost as unknown as Record<string, unknown>).lineNotHeld, 'closeUnder');
  // (Fix7 review 1) …and the line itself beside the ask (the record's cushionLineSocPct: the plan's forceChargeLine.linePct),
  // the number the hold shape names; with no ask, none.
  assert.equal(p.forceChargeLine?.linePct, 68.85);
  assert.equal((ann.cost as unknown as Record<string, unknown>).linePct, 68.85);
  // (A5 final 1) Charge Now rides a leg the line force-charge is armed on whatever its stated level, as armFromPlan's
  // lineRides does: stated at the 50% reserve (H1's floor, or no start expected), it is still switched on just in time.
  // With no ask, the cost rule as before: named only where the level clears the reserve.
  const fcOf = (cost: Record<string, unknown>) => ms.middayShadowAnnounceInput({ ...back, cost: cost as never }, buildApsREvModel())!.cost.forceCharge;
  const noAsk: Record<string, unknown> = { ...back.cost };
  delete noAsk.lineAskPct;
  delete noAsk.lineNotHeld;
  assert.equal(fcOf({ ...back.cost, levelPct: 50, reservePct: 50 }), true, 'an armed leg stated at the reserve');
  assert.equal(fcOf({ ...back.cost, levelPct: 57.3, reservePct: 50 }), true);
  assert.equal(fcOf({ ...noAsk, levelPct: 50, reservePct: 50 }), false, 'no ask, at the reserve: no Charge Now');
  assert.equal(fcOf({ ...noAsk, levelPct: 57.3, reservePct: 50 }), true, 'no ask, above the reserve: Charge Now');
  assert.equal('linePct' in ms.middayShadowAnnounceInput({ ...back, cost: noAsk as never }, buildApsREvModel())!.cost, false, 'no ask: no line');
  const at50 = buildMiddayPlanMessage(ms.middayShadowAnnounceInput({ ...back, cost: { ...back.cost!, levelPct: 50, reservePct: 50 } }, buildApsREvModel())!).body;
  assert.ok(at50.includes(' SUPERVISED: at 10:00 AM the backup reserve is held at 50% and Charge Now switches on just in time; both are restored at 3:00 PM'), at50);
  // (Fix7, A5 final 2) …and a leg that expects to draw nothing (the reserve-hold shape): the line force-charge is armed on it all
  // the same (armFromPlan's lineRides), and the actuator switches Charge Now on if the sun falls short. The push names it,
  // armed and not expected to start, as the overnight held line clause does. With no ask, that shape byte for byte as before.
  const heldBody = (c: Record<string, unknown>) => body({ levelPct: 50, reservePct: 50, expectedKwh: 0.02, buyKwh: 1.3, cushionShortfall: false,
    cushionShortfallCause: undefined, ...c });
  const armedHeld = heldBody({ lineAskPct: 62, linePct: 61.24 });
  assert.ok(armedHeld.includes(': holding the backup reserve at 50% as a floor; no charge is expected.'), armedHeld);
  assert.ok(armedHeld.includes(' SUPERVISED: at 10:00 AM the backup reserve is held at 50%, and Charge Now is armed for the 61.2% outage line (not expected to start); both are restored at 3:00 PM, before the 4–7pm on-peak. Cancel from the charge card before 10:00 AM tomorrow.'), armedHeld);
  // (Fix7 review 1) The line is named as the overnight held clause names it (round1(L)), never the ask ⌈L⌉: 60.03% is "60%",
  // not 61. With the line lost (a record without it), the line unnumbered — the ask is never named as the line.
  assert.ok(heldBody({ lineAskPct: 61, linePct: 60.03 }).includes(', and Charge Now is armed for the 60% outage line (not expected to start); both'));
  const lineLost = heldBody({ lineAskPct: 62 });
  assert.ok(lineLost.includes(' SUPERVISED: at 10:00 AM the backup reserve is held at 50%, and Charge Now is armed for the outage line (not expected to start); both are restored at 3:00 PM'), lineLost);
  assert.doesNotMatch(lineLost, /62%/);
  const noAskHeld = heldBody({ forceCharge: false });
  assert.ok(noAskHeld.includes(' SUPERVISED: at 10:00 AM the backup reserve is held at 50%; it is restored at 3:00 PM, before the 4–7pm on-peak. Cancel from the charge card before 10:00 AM tomorrow.'), noAskHeld);
  assert.doesNotMatch(noAskHeld, /Charge Now/);
  // Advisory arms nothing: its tail is unchanged whatever the ask.
  assert.ok(buildMiddayPlanMessage({ ...input({ levelPct: 50, reservePct: 50, expectedKwh: 0.02, lineAskPct: 62 }), mode: 'advisory' } as never).body
    .includes(' Advisory only — the add-on will NOT charge.'));
});

test('★★ T22 (H1) the spoken notice of a window-bound line night: its level is the window\'s reach, so never "which ends before it gets there" — except where that reach is under the 50% reserve the level is floored at', () => {
  const spokenOf = (p: LinePlan, label: string) => eveningAnnouncement({
    cycle: 'overnight', plan: p, shape: 'charge', supervised: armedSupervised(p, liveCost(label)), armRefused: null, mode: 'supervised',
  } as never).spoken!;
  // 2026-10-29 21:30 on nameplate at 14 h (carried) and 15 h (disclosed), and 2026-10-26 21:30 at 20 h (a line above a
  // full pool): bound walks capped at the window's reach (~92.8%, ~97.4%), which the pool reaches as the window closes.
  for (const [label, h, level] of [['2026-10-29 21:30', 14, 93], ['2026-10-29 21:30', 15, 93], ['2026-10-26 21:30', 20, 97]] as const) {
    const p = yearPlanAt(label, h, 'np');
    assert.equal(p.expectedDeliverableBound, true, `${label} ${h} h`);
    assert.ok(p.expectedWriteLevelPct! > RESERVE_WRITE_MAX_PCT);
    const s = spokenOf(p, label);
    assert.ok(s.en.includes(`Charging the backup pool to about ${level} percent, `), `${label} ${h} h: ${s.en}`);
    assert.doesNotMatch(s.en, /ends before it gets there/, `${label} ${h} h`);
    assert.ok(s.es.includes(`hasta cerca del ${level} por ciento`), s.es);
    assert.doesNotMatch(s.es, /termina antes de alcanzar/, `${label} ${h} h`);
    assert.ok(s.en.length + s.es.length <= MAX_SPOKEN_ADVISORY_CHARS);
    assert.equal((nca as unknown as { chargeEndsShortOfLevel: (p: unknown) => boolean }).chargeEndsShortOfLevel(p), false);
  }
  // 2026-11-27 21:30 at 17 h: the window cannot finish even the reserve leg (it reaches ~49.9%), the level is floored at the
  // 50% reserve — the window does end before the pool gets there.
  const dd = yearPlanAt('2026-11-27 21:30', 17, 'np');
  assert.deepEqual([dd.expectedDeliverableBound, dd.expectedWriteLevelPct], [true, 50]);
  const sd = spokenOf(dd, '2026-11-27 21:30');
  assert.ok(sd.en.includes('toward 50 percent') && sd.en.includes(', which ends before it gets there.'), sd.en);
  assert.equal((nca as unknown as { chargeEndsShortOfLevel: (p: unknown) => boolean }).chargeEndsShortOfLevel(dd), true);
  // A night with no line walk keeps chargeIsWindowBound exactly (a cost night's level is its target, not its close).
  const ends = (nca as unknown as { chargeEndsShortOfLevel: (p: unknown) => boolean }).chargeEndsShortOfLevel;
  assert.equal(ends({ expectedDeliverableBound: true, expectedWriteLevelPct: 80 }), true);
  assert.equal(ends({ expectedDeliverableBound: false, expectedWriteLevelPct: 80 }), false);
  assert.equal(ends({ expectedDeliverableBound: false, expectedForceChargeMode: 'line', expectedWriteLevelPct: 50 }), false);
  assert.equal(ends({ expectedDeliverableBound: true, expectedForceChargeMode: 'line', expectedWriteLevelPct: null }), true);
  // Both overnight speakers read it (overnightTextGolden.test.ts holds the two argument lists equal).
  assert.match(INDEX, /\n\s+expectedKwh: statedBuyKwh\(plan\),\n\s+toward: chargeEndsShortOfLevel\(plan\),\n/);
});

test('★ T19 the source: the line-mode ON log names the panel\'s own stop and the re-ON, never "as the backstop" (L3); index.ts passes what the walk cannot hold to the 21:30 line', () => {
  const tick = INDEX.slice(INDEX.indexOf('const onLine = onLineMode?.kind === \'line\''), INDEX.indexOf('if (rejected > 0) app.log.warn(onLine);'));
  const lineArm = tick.slice(0, tick.indexOf("\n      : `night-charge: FORCE-CHARGE ON for ${state.day}"));
  assert.ok(lineArm.includes("and ON until the close (no software stop) unless the panel switches it off at its ${onLineMode.panelCeilingPct}% ceiling (switched back on under ${onLineMode.startTargetPct}% before the close, at most ${lineReOnTimesWords(FORCE_CHARGE_LINE_REON_MAX)})."), lineArm);
  assert.doesNotMatch(lineArm, /as the backstop/);
  assert.match(tick, /— stops at the target, with the panel's \$\{desiredForceChargeCeilingPct\(state\.forceChargeCeilingPct!\)\}% ceiling as the backstop\./, 'the cost ON log is today\'s');
  const arm = INDEX.slice(INDEX.indexOf('function forceChargeArmNote('), INDEX.indexOf('async function runForceChargeTick('));
  assert.ok(arm.includes('    const notHeld = lineNotHeldOf(plan);\n'), arm);
  assert.ok(arm.includes('      notHeld: notHeld != null ? { kind: notHeld, closePct: plan?.expectedWriteLevelPct ?? null } : null,\n'), arm);
});

/* ══ T23 — the mid-day re-entry hold never holds a leg the line force-charge is armed on ══════════════════════ */

/** The mid-day cost leg of middayShadow.test.ts (2026-10-15, the 10:00–15:00 super off-peak window, planned at 21:30 the
 *  evening before), its reserve floor, charge rate, pool and P50 sun varied: a leg that can bind on its window. */
const MID_H = 3_600_000;
const midPhx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const MID_MODEL = buildApsREvModel();
const MID_LEG = { role: 'cost', kind: 'super_off_peak', startMs: midPhx(10, 15, 10), endMs: midPhx(10, 15, 15) } as const;
const MID_SIZING = costLegSizing(MID_MODEL, MID_LEG, shadowCycleConfig('cost', 90), { chgMaxSocPcts: [80, 80], backupHold: null });
/** (A5 final 1) The 21:30 push the shadow would send for a mid-day leg (summariseLeg → middayShadowAnnounceInput →
 *  buildMiddayPlanMessage), supervised and armed. */
const middayLegPush = (p: LinePlan): string => middayPushOf(middayShadowAnnounceInput({
  version: 1, day: '2026-10-14', computedAtMs: midPhx(10, 14, 21, 30), why: 'midday', mode: 'supervised', backup: null,
  cost: summariseLeg(MID_LEG as never, { plan: p, windowPvP50Kwh: null, windowLoadP50Kwh: null } as never, { wouldArm: true, disposition: 'would arm' }),
  refresh: null, note: null,
} as never, MID_MODEL)!).body;
const CHARGE_NOW_RIDES = ' and Charge Now switches on just in time; both are restored at ';
const MID_P50_W = [0, 94, 608, 2647, 4725, 6276, 6635, 6695, 6243, 5274, 3938, 2057, 573, 21];
const MID_LOAD_W = [2188, 1864, 1646, 2068, 1851, 2158, 2202, 2927, 3228, 4020, 3435, 3738, 3205, 2978];
const middayLegPlan = (o: { floor: number; capKw: number; socPct: number; pvScale: number; h: number; basis: 'np' | 'm' }): LinePlan => {
  const now = midPhx(10, 14, 21, 30);
  const hourOf = (ts: number): number => (new Date(ts).getUTCHours() + 17) % 24;
  const loadW = (hh: number): number => (hh >= 5 && hh <= 18 ? MID_LOAD_W[hh - 5] : (hh >= 21 ? 2.8 : hh < 5 ? 2.2 : hh < 17 ? 2.6 : 3.4) * 1000);
  const pvW = (hh: number): number => o.pvScale * (hh >= 5 && hh <= 18 ? MID_P50_W[hh - 5] : 0);
  const hours: Array<{ ts: number; pvP10W: number; loadP90W: number; embeddedEvW: number; loadP50W: number; pvP50W: number }> = [];
  for (let ts = Math.floor(now / MID_H) * MID_H; ts < midPhx(10, 15, 23); ts += MID_H) {
    const hh = hourOf(ts);
    hours.push({ ts, pvP10W: pvW(hh) * 0.8, loadP90W: loadW(hh) * 1.35, embeddedEvW: 0, loadP50W: loadW(hh), pvP50W: pvW(hh) });
  }
  const winEnd = MID_SIZING.spec.window!.endMs;
  const loads = new Map(hours.map((x) => [x.ts, x.loadP50W]));
  const surplus = pvSurplusFromBand({
    hours: hours.map((x) => ({ ts: x.ts, p50W: x.pvP50W, p90W: x.pvP50W * 1.3 })),
    loadAt: (ts: number) => loads.get(ts), fromMs: winEnd, toMs: MID_SIZING.surplusEndMs ?? winEnd + 14 * MID_H,
  });
  return L(computeNightChargePlan(buildNightChargeInputs({
    nowMs: now, fullKwh: 92.16, socNowPct: o.socPct, reserveFloorPct: o.floor, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.62, outageCushionHours: o.h, islandedLoadSafety: 1.25, objectiveMode: 'cost', costMaxSocPct: 90,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: o.capKw, gridInputCapKw: 17, periodIdAt: (ts: number) => rateAt(MID_MODEL, ts).periodId,
    cheapPeriodId: 'overnight', windowScanHours: 30, bandHours: hours, dayRollups: [], realizedDailyErrHalfFrac: 0.1,
    nextRechargeMs: MID_SIZING.nextRechargeMs, ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 }, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 14, bandCoverageFrac: 0.85,
    morningPvSurplusP90Kwh: surplus.p90Kwh, morningPvSurplusP50Kwh: surplus.p50Kwh, longGapAhead: false, prePeakPvSurplusP10Kwh: null,
    minBuyKwh: 1, buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: true, lineForceChargeEligible: true, windowSpec: MID_SIZING.spec,
    ...(o.basis === 'm' ? { cushionPoolScale: S944 } : {}),
  } as never)));
};
const REENTRY_NOTE = /The re-entry hold does not apply: the force-charge for the outage line is armed, so the leg charges although ~[\d.]+% is under the [\d.]+% re-entry line \(the [\d.]+% reserve \+ 25\); after the restore the panel may hold the pool while the house buys from the grid into on-peak\./;

test('★★★ T23 the mid-day re-entry hold never holds a leg the line force-charge is armed on: more cushion never disarms it (a 31% floor, a 5 kW window: armed at 7 h, held from 8 h)', () => {
  const leg = (h: number) => middayLegPlan({ floor: 31, capKw: 5, socPct: 30, pvScale: 0, h, basis: 'np' });
  // 7 h: the line asks 58, cost-dominant (the 70% taper ceiling at ⌈L⌉ + 10 or above): toward ~70%.
  const h7 = leg(7);
  assert.deepEqual([h7.chargeTonight, h7.forceChargeLine, h7.expectedForceChargeMode ?? null, h7.expectedWriteLevelPct], [true, { askPct: 58, linePct: 57.46 }, null, 70]);
  // 8 h: ⌈L⌉ + 10 = 72 over the 70% ceiling, so line mode; the window-bound walk is capped at its reach, ~55.1% — under the
  // 56% re-entry line (31 + 25). The hold would write nothing and run no force-charge against a 61.24% line: it does not apply.
  for (const h of [8, 12, 16, 20]) {
    const p = leg(h);
    const where = `${h} h`;
    assert.equal(p.chargeTonight, true, where);
    assert.equal(p.forceChargeLine?.askPct, Math.min(100, Math.ceil(p.cushionLineSocPct! - 1e-9)), where);
    assert.equal(p.expectedForceChargeMode, 'line', where);
    assert.equal(p.expectedWriteLevelPct, 55.1, where);
    assert.equal('middayReentryHold' in p, false, where);
    assert.equal(lineNotHeldOf(p), p.cushionLineSocPct! > 100 ? 'aboveFull' : 'closeUnder', where);
    assert.match(p.rationale, REENTRY_NOTE, where);
    assert.ok(p.rationale.includes('~55.1% is under the 56% re-entry line (the 31% reserve + 25)'), where);
    assert.doesNotMatch(p.rationale, /^Hold/, where);
  }
  const h8 = leg(8);
  assert.deepEqual([h8.forceChargeLine, h8.cushionShortfall, h8.cushionShortfallCause ?? null], [{ askPct: 62, linePct: 61.24 }, true, null], 'carried with the caps note');
  assert.ok(h8.rationale.includes("NOTE: on the median load the pool is expected to close at ~55.1%, under tonight's 61.24% outage line"), h8.rationale);
  // A 46% floor (the re-entry line 71, over the 70% taper ceiling): with no line above 50 (1 h) nothing is armed and the leg
  // holds as before; at 2 h the line asks 54 and the cost-dominant force-charge is armed for it — the cost mode too is
  // never held: it charges toward ~70%, under the 71% re-entry line, and says so.
  const h1 = middayLegPlan({ floor: 46, capKw: 5, socPct: 30, pvScale: 0, h: 1, basis: 'np' });
  assert.deepEqual([h1.chargeTonight, h1.forceChargeLine ?? null, h1.middayReentryHold], [false, null, { arrivalPct: 70, linePct: 71 }]);
  assert.match(h1.rationale, /^Hold — the mid-day charge's write takes the pool only to ~70%, under the 71% re-entry line \(the 46% reserve \+ 25\)/);
  const h2 = middayLegPlan({ floor: 46, capKw: 5, socPct: 30, pvScale: 0, h: 2, basis: 'np' });
  assert.deepEqual([h2.chargeTonight, h2.forceChargeLine, h2.expectedForceChargeMode ?? null, h2.expectedWriteLevelPct, 'middayReentryHold' in h2],
    [true, { askPct: 54, linePct: 53.56 }, null, 70, false]);
  assert.ok(h2.rationale.includes('~70% is under the 71% re-entry line (the 46% reserve + 25)'), h2.rationale);
});

/** Measured on the landed change (the planner over the grid below): a qualifying leg is ARMED at every hour (none held),
 *  most carried with the caps note (the window binds: the sizing falls short); none held over its line. The same grid on
 *  b1fd7613 held 830 / 847 armed-qualifying legs, 61 / 61 of them one hour after the line was armed. As on the year, the
 *  stated close and the expected buy are not monotone in the line (a cost target the window cannot reach gives way to the
 *  line walk's capped close): `eFalls` / `buyFalls` count the steps they fall, pinned, not asserted. (A5 final 1) Every armed
 *  leg (`armedPushes`: armFromPlan's lineRides, = `armed`) is pushed with Charge Now; 5d7c7c75 left it out on 136 / 144 of them
 *  (stated at the 50% reserve). */
const PIN_T23: Record<'np' | 'm', { plans: number; armed: number; carried: number; nearFull: number; lineMode: number; reentryNotes: number; kinds: Record<string, number>; eFalls: number; buyFalls: number; armedPushes: number }> = {
  // v1.202.0 — `kinds` counts lineNotHeldOf, a cost-carried leg's close past its stop included wherever it is under the line,
  // whether or not the sizing fell short (60 legs more here and 55 at ×0.944 than when only a disclosed leg named it).
  // v1.205.0 — a cost-carried leg's close past its stop capped at the window's reach (H1): 27 more legs here and 21 at ×0.944 name a
  // close under their line, every one already disclosed (carried unchanged).
  np: { plans: 3400, armed: 2808, carried: 1836, nearFull: 972, lineMode: 2412, reentryNotes: 830, kinds: { closeUnder: 1685, aboveFull: 468 }, eFalls: 131, buyFalls: 71, armedPushes: 2808 },
  // v1.202.0 — re-measured with the walks on the measured pool (v1.201.0: reentryNotes 847, closeUnder 1495, no held
  // 'nearFull', eFalls 131, buyFalls 71): the same lift is more points of it, so fewer closes are under the line or the
  // re-entry line.
  m: { plans: 3400, armed: 2916, carried: 1764, nearFull: 1152, lineMode: 2460, reentryNotes: 559, kinds: { closeUnder: 1496, aboveFull: 648, nearFull: 4 }, eFalls: 127, buyFalls: 68, armedPushes: 2916 },
};

for (const basis of ['np', 'm'] as const) {
  test(`★★★ T23 (${basis === 'np' ? 'nameplate' : '×0.944'}) a mid-day leg grid at 4-20 h (floors 26-40, 4.5-10 kW, two pools, P50 sun ×0, 0.1, 0.3, 1): as the cushion rises the armed target and ceiling never fall, an armed line never disarms, no leg is held over a line above 50, a qualifying leg is armed or disclosed, no carried leg closes under its line undisclosed, an armed leg's push names Charge Now`, () => {
    const s = { m1: 0, m2: 0, m3: 0, m4: 0, undisclosedUnder: 0, heldOverLine: 0, carrierRest: 0, pushNoChargeNow: 0 };
    const pin = { plans: 0, armed: 0, carried: 0, nearFull: 0, lineMode: 0, reentryNotes: 0, kinds: {} as Record<string, number>, eFalls: 0, buyFalls: 0, armedPushes: 0 };
    const ex: string[] = [];
    const gates = { cost: true, line: true };
    for (const floor of [26, 30, 31, 35, 40]) for (const capKw of [4.5, 5, 6, 7, 10]) for (const pvScale of [0, 0.1, 0.3, 1]) for (const socPct of [30, 45]) {
      let prev: { line: number | null; armed: boolean; E: number | null; buy: number | null; target: number | null; ceil: number | null } | null = null;
      for (let h = 4; h <= 20; h++) {
        const p = middayLegPlan({ floor, capKw, socPct, pvScale, h, basis });
        const where = `floor ${floor}, ${capKw} kW, sun ×${pvScale}, pool ${socPct}%, ${h} h`;
        const note = (m: string) => { if (ex.length < 12) ex.push(`${where}: ${m}`); };
        const lineL = p.cushionLineSocPct ?? null;
        const E = p.expectedWriteLevelPct ?? null;
        const mode = nfc.forceChargeModeOf({ forceChargeCeilingPct: act.armedForceChargeCeilingPct(p), forceChargeLineAskPct: p.forceChargeLine?.askPct ?? null } as never, gates);
        const r = { line: lineL, armed: p.forceChargeLine != null, E, buy: p.expectedBuyKwh ?? null,
          target: p.chargeTonight ? nfc.armedWriteLevelPct(p as never, gates) : null, ceil: p.chargeTonight && mode != null ? mode.panelCeilingPct : null };
        pin.plans += 1;
        if (r.armed) { pin.armed += 1; if (p.cushionShortfallCause == null) pin.carried += 1; }
        if (p.cushionEnvelopeReason === 'nearFull') pin.nearFull += 1;
        if (p.expectedForceChargeMode === 'line') pin.lineMode += 1;
        if (REENTRY_NOTE.test(p.rationale)) pin.reentryNotes += 1;
        const k = lineNotHeldOf(p);
        if (k != null) pin.kinds[k] = (pin.kinds[k] ?? 0) + 1;
        if (p.middayReentryHold != null && lineL != null && Math.min(100, Math.ceil(lineL - 1e-9)) > 50) { s.heldOverLine += 1; note(`held over a ${lineL}% line`); }
        if (r.armed && p.cushionShortfall !== true && lineL != null && E != null && E < lineL - 0.05 - 1e-9) { s.undisclosedUnder += 1; note(`carried ~${E}% under ${lineL}%`); }
        if (lineL != null && p.chargeTonight && p.cushionBasis === 'islanded-outage' && Math.min(100, Math.ceil(lineL - 1e-9)) > 50
          && (p.requiredExtraKwh ?? 0) > 0 && !r.armed && p.cushionShortfallCause == null) { s.carrierRest += 1; note('qualifying, neither armed nor disclosed'); }
        // (A5 final 1) A leg the actuator arms the line force-charge on (armFromPlan's lineRides, both gates on) is pushed
        // with Charge Now, also where its stated level is the 50% reserve (H1's floor, or no start expected).
        if (act.armFromPlan(act.emptyActuationState(), '2026-10-14', p as never, midPhx(10, 14, 21, 30), floor, true, null, true)?.forceChargeLineAskPct != null) {
          pin.armedPushes += 1;
          const push = middayLegPush(p);
          if (!push.includes(CHARGE_NOW_RIDES)) { s.pushNoChargeNow += 1; note(`armed, pushed without Charge Now (level ~${p.expectedWriteLevelPct}%): ${push}`); }
        }
        if (prev != null && !(prev.line != null && lineL != null && lineL < prev.line - 1e-9)) {
          const fell = (a: number | null, b: number | null) => a != null && (b == null || b < a - 1e-9);
          if (fell(prev.target, r.target)) { s.m1 += 1; note(`target ${prev.target} → ${r.target}`); }
          if (fell(prev.ceil, r.ceil)) { s.m2 += 1; note(`ceiling ${prev.ceil} → ${r.ceil}`); }
          if (prev.armed && !r.armed) { s.m3 += 1; note('disarmed'); }
          if (prev.E != null && E != null && lineL != null && p.cushionShortfall !== true && E < Math.min(prev.E, lineL) - 0.05) { s.m4 += 1; note(`~${prev.E} → ~${E}% under ${lineL}%`); }
          if (fell(prev.E, E)) pin.eFalls += 1;
          if (fell(prev.buy, r.buy)) pin.buyFalls += 1;
        }
        prev = r;
      }
    }
    assert.deepEqual(s, { m1: 0, m2: 0, m3: 0, m4: 0, undisclosedUnder: 0, heldOverLine: 0, carrierRest: 0, pushNoChargeNow: 0 }, ex.join('\n'));
    assert.deepEqual(pin, PIN_T23[basis]);
  });
}

/** (Fix7, A5 final 2) The same grid with the pool at 90% and 95% at 21:30: an armed leg the sun carries expects to draw nothing
 *  and takes the reserve-hold shape ("no charge is expected"). Measured on the landed change: `armed` legs (armFromPlan's
 *  lineRides), `rides` pushed "Charge Now switches on just in time", `held` pushed in the hold shape and naming Charge Now armed
 *  for the line. Before this change every one of the `held` was pushed with no Charge Now (the A5 final-2 finding).
 *  (Fix7 review 1) The line it names is the plan's own, round1(L), as the overnight held clause and the rationale name it:
 *  `notAsk` of the `held` name a number other than the ask ⌈L⌉ — every one, so naming the ask fails them all (141349c7 did). */
const PIN_T23_HELD: Record<'np' | 'm', { armed: number; rides: number; held: number; notAsk: number }> = {
  np: { armed: 2738, rides: 2623, held: 115, notAsk: 115 },
  m: { armed: 2871, rides: 2736, held: 135, notAsk: 135 }, // v1.202.0 — on the measured pool (v1.201.0: 2838, 2733, 105, 105)
};
const CHARGE_NOW_ARMED_HELD = /^SUPERVISED: at 10:00 AM the backup reserve is held at 50%, and Charge Now is armed for the ([\d.]+)% outage line \(not expected to start\); both are restored at 3:00 PM/;

test('★★★ T23 (Fix7) the mid-day grid with the pool at 90% and 95%: every armed leg\'s push names Charge Now, in the charging shape and in the reserve-hold one (armed for the line, not expected to start)', () => {
  for (const basis of ['np', 'm'] as const) {
    const got = { armed: 0, rides: 0, held: 0, notAsk: 0 };
    const ex: string[] = [];
    for (const socPct of [90, 95]) for (const floor of [26, 30, 31, 35, 40]) for (const capKw of [4.5, 5, 6, 7, 10]) for (const pvScale of [0, 0.1, 0.3, 1]) {
      for (let h = 4; h <= 20; h++) {
        const p = middayLegPlan({ floor, capKw, socPct, pvScale, h, basis });
        const rec = act.armFromPlan(act.emptyActuationState(), '2026-10-14', p as never, midPhx(10, 14, 21, 30), floor, true, null, true);
        if (rec?.forceChargeLineAskPct == null) continue;
        got.armed += 1;
        const push = middayLegPush(p);
        const tail = push.slice(push.indexOf('SUPERVISED: '));
        const heldShape = push.includes('as a floor; no charge is expected.');
        const m = CHARGE_NOW_ARMED_HELD.exec(tail);
        if (!heldShape && push.includes(CHARGE_NOW_RIDES)) got.rides += 1;
        else if (heldShape && m != null && Number(m[1]) === Math.round(p.forceChargeLine!.linePct * 10) / 10) {
          got.held += 1;
          if (Number(m[1]) !== rec.forceChargeLineAskPct) got.notAsk += 1;
        } else if (ex.length < 8) ex.push(`${basis} pool ${socPct}%, floor ${floor}, ${capKw} kW, sun ×${pvScale}, ${h} h (line ${p.forceChargeLine?.linePct}, ask ${rec.forceChargeLineAskPct}): ${push}`);
      }
    }
    assert.deepEqual(ex, [], 'an armed leg pushed with no Charge Now');
    assert.equal(got.rides + got.held, got.armed);
    assert.deepEqual(got, PIN_T23_HELD[basis], basis);
  }
  // (Fix7 review 1) The CHANGELOG's example: the pool at 90% at 21:30, a 26% floor, 6 kW, the P50 sun, 9 h on nameplate — the
  // 60.03% line, ask 61. The push names the line as the rationale does (60%, the overnight clause's round1), not the ask.
  const ex9 = middayLegPlan({ floor: 26, capKw: 6, socPct: 90, pvScale: 1, h: 9, basis: 'np' });
  assert.deepEqual(ex9.forceChargeLine, { askPct: 61, linePct: 60.03 });
  assert.ok(ex9.rationale.includes('60.03% outage line'), ex9.rationale);
  const ex9Push = middayLegPush(ex9);
  assert.ok(ex9Push.includes(' SUPERVISED: at 10:00 AM the backup reserve is held at 50%, and Charge Now is armed for the 60% outage line (not expected to start); both are restored at 3:00 PM'), ex9Push);
});

/* ══ T10b — the gate: an armed line the plan disclosed whose force-charge never switched on is a strike ═══════════ */

test('★★★ T10b the gate (A5, M3): an ARMED, disclosed, actuated row whose force-charge never switched on and that closed under min(its line, 100) is a strike; one that ran, a line above a full pool held at 100, and a disclosure with nothing armed stay exempt', async () => {
  const { computeNightChargeReadiness, CURRENT_ALGO_VERSION, phoenixYmd } = await import('../src/nightChargeGate.js');
  assert.equal(CURRENT_ALGO_VERSION, 3, 'no scored column moves');
  const NOW = Date.UTC(2026, 9, 31, 4, 30);
  const row = (f: Record<string, unknown>) => ({
    plan_date: phoenixYmd(NOW - 3 * 86_400_000), algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast',
    issued_at_ms: NOW - 3 * 86_400_000, outcome_captured_at_ms: NOW - 2 * 86_400_000,
    scored: 1, actuated: 1, cushion_shortfall: 1, cushion_envelope_shortfall: 1, plan_traj_floor_breached: 0, cushion_breached: 1,
    buy_err_kwh: 0.5, pv_err_frac: 0.05, load_err_frac: -0.05, pv_in_band: 1, load_in_band: 1, grid_home_coverage_frac: 0.95,
    reserve_floor_pct: 30, cushion_pct: 15, cushion_line_soc_pct: 93.63, cushion_trough_soc_pct: 93.63, window_kind: 'overnight',
    cushion_line_force_charge_pct: 94, force_charge_on_at_ms: null, window_close_soc_pct: 50, actual_min_soc_pct: 40,
    ...f,
  });
  const run = (f: Record<string, unknown>) => computeNightChargeReadiness([row(f)] as never, NOW).metrics;
  // (a) armed, disclosed, actuated, never ON, closed at 50 under 93.63: a run-time fault, not physics.
  const a = run({});
  assert.equal(a.activeStrikes, 1);
  assert.equal(a.lineForceChargeStrikes, 1);
  // (A5 fix) …and the detector says it can count: an armed, actuated disclosed row is graded (strikesMeasurable 1), so a 0
  // beside such rows is a real zero — one that ran, and one that held its line, are checked and cleared.
  assert.equal(a.strikesMeasurable, 1, 'a strike beside "cannot count"');
  const ranAndHeld = computeNightChargeReadiness([row({ force_charge_on_at_ms: NOW - 3 * 86_400_000 + 3 * 3_600_000 }),
    row({ plan_date: phoenixYmd(NOW - 4 * 86_400_000), window_close_soc_pct: 95 })] as never, NOW).metrics;
  assert.deepEqual([ranAndHeld.activeStrikes, ranAndHeld.strikesMeasurable], [0, 1], 'checked and cleared, not unmeasured');
  // A disclosed row with nothing armed, or armed and never actuated, cannot strike: still 0 (nightChargeGate.test.ts).
  assert.equal(run({ cushion_line_force_charge_pct: null }).strikesMeasurable, 0);
  assert.equal(run({ actuated: null }).strikesMeasurable, 0);
  assert.equal(run({ actuated: 0 }).strikesMeasurable, 1, '(review 9) a write that never held is graded: lineNightUnheld.test.ts U2');
  // At the scorer's edge in decimal literals (a 50.35% line closing at 50.3): clean, as the rule states.
  assert.equal(run({ cushion_line_soc_pct: 50.35, cushion_line_force_charge_pct: 51, window_close_soc_pct: 50.3 }).activeStrikes, 0);
  assert.equal(run({ cushion_line_soc_pct: 50.35, cushion_line_force_charge_pct: 51, window_close_soc_pct: 50.2 }).activeStrikes, 1);
  // (b) the same night whose force-charge ran (and still closed under): the disclosure stands — exempt.
  assert.equal(run({ force_charge_on_at_ms: NOW - 3 * 86_400_000 + 3 * 3_600_000 }).activeStrikes, 0);
  // (c) a line above a full pool, never ON, the pool at 100 at the close: held as far as a pool can be — exempt; at 99.9, a strike.
  assert.equal(run({ cushion_line_soc_pct: 101.57, cushion_line_force_charge_pct: 100, window_close_soc_pct: 100 }).activeStrikes, 0);
  assert.equal(run({ cushion_line_soc_pct: 101.57, cushion_line_force_charge_pct: 100, window_close_soc_pct: 99.9 }).activeStrikes, 1);
  // At the line less the scorer's tolerance: clean; under it: a strike.
  assert.equal(run({ window_close_soc_pct: 93.58 }).activeStrikes, 0);
  assert.equal(run({ window_close_soc_pct: 93.57 }).activeStrikes, 1);
  // (d) a disclosure with nothing armed (advisory, the backup leg): exempt, as before.
  assert.equal(run({ cushion_line_force_charge_pct: null }).activeStrikes, 0);
  // (review 9) Not actuated: a write that never landed (actuated 0, or the missed push's disposition) is a run-time refusal, a strike
  // (lineNightUnheld.test.ts U2); a night cancelled before the write, or never armed, is exempt.
  assert.equal(run({ actuated: 0 }).activeStrikes, 1);
  assert.equal(run({ actuated: null }).activeStrikes, 0);
  // (e) no close reading: the lowest pool after the close decides where it holds the line; otherwise the stored flag (fail-closed).
  assert.equal(run({ window_close_soc_pct: null, cushion_breached: 1 }).activeStrikes, 1);
  assert.equal(run({ window_close_soc_pct: null, cushion_breached: 0 }).activeStrikes, 0);
  assert.equal(run({ window_close_soc_pct: null, actual_min_soc_pct: 94, cushion_breached: 1 }).activeStrikes, 0);
  // (f) the owner's cancel after the apply: the ledger has no cancel column (the restore's stamp is also every early
  // restore's), so the night reads as any actuated night — a strike when it closed under, as a carried night is.
  assert.equal(run({ actuation_reverted_at_ms: NOW - 3 * 86_400_000 + 3_600_000 }).activeStrikes, 1);
  assert.equal(run({ cushion_shortfall: 0, cushion_envelope_shortfall: 0, cushion_line_force_charge_pct: 69, cushion_line_soc_pct: 68.85, window_close_soc_pct: 57.3,
    actuation_reverted_at_ms: NOW - 3 * 86_400_000 + 3_600_000 }).activeStrikes, 1, 'the carried rule strikes it alike');
});

/* ══ T24 (Fix8) — THE LINE TEXTS AT THEIR EDGES ══════════════════════════════════════════════════════════════════════════ */

/** (Fix8) The matrix's lines and the asks the planner gives them (askOf: ⌈L⌉, at most 100), with the line stated at 50.00 and
 *  asked at 51 (its raw value a hair above the reserve: 2026-11-25 on nameplate at 11 h). */
const MATRIX: Array<[number, number]> = [[50, 51], ...[50.03, 50.05, 55.55, 79.96, 80, 80.04, 89.96, 90, 94.96, 95, 99.94, 99.96, 100, 101.57]
  .map((l): [number, number] => [l, Math.min(100, Math.ceil(l - 1e-9))])];
/** How a text names the line beside the whole-percent levels it orders it against (nfc.lineBesidePct): round1, as every surface
 *  names it, or two decimals where one would read as one of those levels and the line is not that level. */
const beside = (l: number, ...levels: number[]): number => (levels.includes(r1(l)) ? Math.round(l * 100) / 100 : r1(l));
/** v1.203.0 — how a text names a line beside the reserve: a line at or under 50 (one in (49, 50], the line force-charge's since the
 *  panel holds the pool one point under a reserve it charged up to) beside the 49% the panel holds too (nfc.lineAboveReserveWords). */
const besideReserve = (l: number): number => (l <= 50 ? beside(l, 49, 50, 100) : beside(l, 50, 100));
/** …and whether it is stated unnumbered: at either level it would read as. */
const unnumberedBesideReserve = (l: number): boolean => (l <= 50 ? !(besideReserve(l) > 49 && besideReserve(l) < 50) : besideReserve(l) <= 50);
/** v1.203.0 — a line the 50% reserve holds: the panel holds the pool at 49% under it (PANEL_RESERVE_HOLD_UNDERSHOOT_PCT), so only a
 *  line at or under 49. (v1.202.0 counted a line stated at 50.00 as held.) */
const heldByReserve = (l: number): boolean => l <= 49;
/** Every order relation a line text states, checked against the numbers it names. `named` — the number the text must give the
 *  line (null: the text orders the line against the reserve without a number, where `noNumber` allows it). */
const lineRelationErrors = (text: string, o: { line: number; named: number; noNumber?: boolean; where: string }): string[] => {
  const e: string[] = [];
  const num = (s: string): number => Number(s);
  const each = (re: RegExp, f: (m: RegExpExecArray) => string | null): void => {
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) { const err = f(m as RegExpExecArray); if (err != null) e.push(`${o.where}: ${err} — «${m[0]}»`); }
  };
  // The line's number, wherever the text names it.
  each(/(?:tonight's |the |for )([\d.]+)% outage line|outage line ([\d.]+)%|outage line is ([\d.]+)%|outage line \(([\d.]+)%\)/, (m) => {
    const n = num(m[1] ?? m[2] ?? m[3] ?? m[4]);
    return n === o.named ? null : `names the line ${n}%, not ${o.named}%`;
  });
  // v1.203.0 — above the 49% the panel holds under its 50% reserve (a line in (49, 50]): true of any line above 49, numbered or not.
  each(/(?:tonight's |outage line )([\d.]+)%? ?(?:outage line )?(?:is above|\(above) the 49% the panel holds the pool at under (?:a|its|the) 50%/, (m) => {
    const n = num(m[1]);
    return n > 49 && o.line > 49 ? null : `"above the 49% the panel holds" with the line ${n}% (${o.line})`;
  });
  each(/the panel holds a pool it charges to that reserve at (\d+)%, under tonight's ([\d.]+)% outage line/,
    (m) => (num(m[2]) > num(m[1]) && o.line > num(m[1]) ? null : `"the panel holds … at ${m[1]}%, under" the line ${m[2]}% (${o.line})`));
  each(/tonight's outage line is above the 49%|for tonight's outage line \(above the 49%|^outage line is above the 49%/, () => (o.noNumber === true ? null : 'the line unnumbered beside the hold'));
  // Above the 50% reserve (the 21:30 log, the push's clause, the notes, the card's rows).
  each(/tonight's ([\d.]+)% outage line is above the 50% (?:reserve|the panel accepts as a reserve)|tonight's ([\d.]+)% outage line \(above the 50% the panel holds as a reserve\)|outage line ([\d.]+)% is above the 50% (?:reserve|the panel accepts as a reserve)/, (m) => {
    const n = num(m[1] ?? m[2] ?? m[3]);
    return n > 50 && o.line > 50 ? null : `"above the 50% reserve" with the line ${n}% (${o.line})`;
  });
  each(/tonight's outage line is above the 50%|for tonight's outage line \(above the 50%|^outage line is above the 50%/, () => (o.noNumber === true ? null : 'the line unnumbered beside the reserve'));
  // The rationale's: "The reserve is set to 50%, the most the panel accepts as a backup reserve; tonight's N% outage line is above it".
  each(/The reserve is set to (\d+)%, the most the panel accepts as a backup reserve; tonight's ([\d.]+)% outage line is above it/,
    (m) => (num(m[2]) > num(m[1]) && o.line > num(m[1]) ? null : `"above the ${m[1]}% reserve" with the line ${m[2]}% (${o.line})`));
  each(/tonight's ([\d.]+)% outage line is above a full pool/, (m) => (num(m[1]) > 100 && o.line > 100 ? null : `"above a full pool" with ${m[1]}%`));
  each(/tonight's ([\d.]+)% outage line is within 10 points of a full pool/, (m) => (num(m[1]) >= 90 && num(m[1]) <= 100 && o.line > 90 && o.line <= 100 ? null : `"within 10 points" with ${m[1]}%`));
  each(/close at ~([\d.]+)%, under tonight's ([\d.]+)% outage line/, (m) => (num(m[1]) < num(m[2]) ? null : `${m[1]}% "under" ${m[2]}%`));
  each(/the pool reads ([\d.]+)%, under tonight's ([\d.]+)% outage line/, (m) => (num(m[1]) < num(m[2]) ? null : `${m[1]}% "under" ${m[2]}%`));
  each(/the pool reads ([\d.]+)%, under the ([\d.]+)% start target and (?:falling toward tonight's ([\d.]+)% outage line|not rising; tonight's outage line is ([\d.]+)%)/,
    (m) => (num(m[1]) < num(m[2]) && num(m[1]) >= num(m[3] ?? m[4]) ? null : `${m[1]}% under ${m[2]}% and toward/at ${m[3] ?? m[4]}%`));
  // (Fix8 review 1) The margin is the difference of the two numbers the text NAMES (the threshold and the line, each to one
  // decimal), so the text adds up by its own numbers: 61 − 55.6 = 5.4, never 5.5 off the raw 55.55.
  each(/the pool reads ([\d.]+)%, under ([\d.]+)%, ([\d.]+) points above tonight's ([\d.]+)% outage line/,
    (m) => (num(m[1]) < num(m[2]) && num(m[3]) === r1(num(m[2]) - num(m[4])) && num(m[3]) > 0 && num(m[2]) > num(m[4]) ? null : `margin ${m[0]}`));
  each(/the pool read ([\d.]+)% at the close, under the ([\d.]+)% outage line/, (m) => (num(m[1]) < num(m[2]) ? null : `${m[1]}% "under" ${m[2]}%`));
  each(/timed to ([\d.]+)% by [^;]*; expected to reach the panel's ([\d.]+)% ceiling/, (m) => (num(m[1]) < num(m[2]) ? null : `start target ${m[1]}% at or above the ${m[2]}% ceiling`));
  // A forecast the builder cannot know (the pool at the failure, a person's Charge Now): never stated as certain.
  each(/will close the window near|is expected to close under the line|close the window near the 50% reserve, under the line/, () => 'a definite close the builder cannot know');
  // (Fix8 review 1) A write the code still verifies late (the ON, the reserve, a re-ON: each is read again after its warning) is
  // never said not to happen, nor not to have taken effect for good; and the reserve is no floor while islanded (the pool drains
  // through it in an outage, the case the line is for): never "only the 50% reserve holds".
  each(/will not happen|did not take effect/, () => 'a final outcome a late apply contradicts');
  // (Fix8 review 2) …in a title too, and a start the code may still make (decideForceCharge decides every tick) is never said
  // not to come: "cannot start yet".
  each(/cannot start(?! yet)/, () => 'a start the code still makes said not to come');
  each(/only the 50% reserve holds|only the reserve holds/, () => 'a floor that holds nothing islanded');
  return e;
};

test('★★★ T24 (Fix8) the line texts at their edges: every text on the line force-charge path that orders the line against another level, or names it by a number, rendered through its real builder at lines from 50.00 to 101.57 — each relation true, the line named round1(L), or two decimals where one reads as the level (the rationale: the plan\'s own two decimals)', () => {
  const errs: string[] = [];
  const add = (text: string, o: Parameters<typeof lineRelationErrors>[1]) => errs.push(...lineRelationErrors(text, o));
  const base = L(yearPlan('2027-01-04 21:30', true));
  const advisoryBase = linePlan(false);
  const midBase = middayLegPlan({ floor: 26, capKw: 6, socPct: 90, pvScale: 1, h: 9, basis: 'np' });
  assert.equal(base.expectedForceChargeMode, 'line');
  for (const [line, ask] of MATRIX) {
    const m = nfc.forceChargeModeOf({ forceChargeCeilingPct: null, forceChargeLineAskPct: ask } as never, { cost: false, line: true }) as { startTargetPct: number; panelCeilingPct: number };
    const S = m.startTargetPct;
    const C = m.panelCeilingPct;
    const near = ask + 10 > 100;
    // v1.203.0 — named beside the 49% hold too at or under 50 (besideReserve), and held by the reserve only at or under 49.
    const atReserve = unnumberedBesideReserve(line);
    const held = heldByReserve(line);
    const where = (t: string) => `${t} @ ${line}`;
    // 1. decideForceCharge: "already at the panel ceiling" (ITEM 1), and the hold-off (no relation; round1).
    const s = night({ forceChargeLineAskPct: ask, forceChargeLinePct: line });
    const wCeil = (decideForceCharge(s, WIN_START + H, fo({ poolSocPct: C, ceilingReadbackPct: C })) as { why?: string }).why ?? '';
    const ce = ceilingWhyHolds(wCeil, line, C);
    if (ce != null) errs.push(`${where('ceiling why')}: ${ce}`);
    const wHold = (decideForceCharge(s, WIN_START + H, fo({ poolSocPct: 50, ceilingReadbackPct: C })) as { why?: string }).why ?? '';
    add(wHold, { line, named: r1(line), where: where('hold-off why') });
    // 2. The 21:30 log (forceChargeLineArmNote), every shape and every note.
    const kinds: Array<{ kind: 'closeUnder' | 'aboveFull' | 'nearFull'; closePct: number | null } | null> = [null, { kind: 'closeUnder', closePct: r1(line - 1) },
      ...(line > 100 ? [{ kind: 'aboveFull' as const, closePct: 100 }] : []), ...(near && line <= 100 ? [{ kind: 'nearFull' as const, closePct: 96 }] : [])];
    for (const ceilingStop of [false, true]) for (const notHeld of kinds) {
      const t = nfc.forceChargeLineArmNote({ linePct: line, startTargetPct: S, panelCeilingPct: C, expectedStartText: '03:25', timedByText: '04:40', ceilingStop, notHeld });
      add(t, { line, named: besideReserve(line), noNumber: atReserve, where: where(`21:30 ${ceilingStop ? 'stop' : 'plain'} ${notHeld?.kind ?? 'held'}`) });
      if (!/^Force-charge: LINE — tonight's (?:[\d.]+% )?outage line is above (?:the 50% reserve|the 49% the panel holds the pool at under a 50% reserve): /.test(t)) errs.push(`${where('21:30')}: ${t}`);
      // v1.203.0 — a line stated at the reserve (50.00) is unnumbered beside the 49% hold and the 50% reserve it would read as.
      if (atReserve && /^Force-charge: LINE — tonight's [\d.]+% outage line/.test(t)) errs.push(`${where('21:30')}: numbered at the reserve: ${t}`);
    }
    // 3. The line's number on the add-on's own log lines (index.ts: the ON, the re-ON, the ceiling lowering, the at-risk and the
    // declined-start lines): lineLogPct, round1 of the record's line, its ask where the line is unknown (read at the source below).
    const logPct = (nfc as unknown as { lineLogPct?: (s: unknown) => number | null }).lineLogPct;
    if (logPct?.(s) !== r1(line)) errs.push(`${where('log')}: ${logPct?.(s)}`);
    if (logPct?.(night({ forceChargeLineAskPct: ask, forceChargeLinePct: null })) !== ask) errs.push(`${where('log, no line')}: the ask`);
    // 4. The evening push and 5. the card: the line clause (armed and not expected to start; the panel's stop; on to the close)
    // and each note (lineNotHeldOf: under the line, above a full pool, within 10 points of it).
    const closes: Array<[string, number]> = [['held', Math.min(100, r1(line + 3))], ['closeUnder', r1(Math.min(line, 100) - 1)]];
    for (const [shape, E] of closes) for (const startMs of [base.expectedForceChargeStartMs!, null]) for (const stop of [false, true]) {
      const p = {
        ...base, cushionLineSocPct: line, forceChargeLine: { askPct: ask, linePct: line }, expectedWriteLevelPct: E, expectedForceChargeStartMs: startMs,
        ...(stop ? { expectedLineCeilingStop: { ceilingPct: C, startTargetPct: S } } : { expectedLineCeilingStop: undefined }),
        ...(near || shape === 'closeUnder' || line > 100 ? { cushionShortfallCause: 'envelope', cushionEnvelopeReason: near ? 'nearFull' : 'closeUnder' } : { cushionShortfallCause: undefined, cushionEnvelopeReason: undefined }),
      } as LinePlan;
      const sup = { cancelDeadlineText: 'tonight at 11:00 PM', targetPct: 50, forceChargeTargetPct: null, forceChargeLine: { askPct: ask, linePct: line, panelCeilingPct: C } };
      const body = buildNightChargeMessage(p as never, 'charge', sup as never).body;
      add(body, { line, named: besideReserve(line), noNumber: atReserve, where: where(`push ${shape} ${startMs == null ? 'no start' : stop ? 'stop' : 'plain'}`) });
      const row = (cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow(p);
      if (row == null) errs.push(`${where('card')}: no row`);
      else {
        add(row, { line, named: besideReserve(line), noNumber: atReserve, where: where(`card ${shape}`) });
        // v1.203.0 — …and on the card.
        if (atReserve && /^outage line [\d.]+% /.test(row)) errs.push(`${where('card')}: numbered at the reserve: ${row}`);
        if (row.includes('the line is above a full pool') && !(line > 100 && /^outage line ([\d.]+)%/.test(row) && Number(/^outage line ([\d.]+)%/.exec(row)![1]) > 100)) errs.push(`${where('card')}: ${row}`);
      }
    }
    // The advisory disclosure (nothing armed): the push's note and the card's row.
    const adv = { ...advisoryBase, cushionLineSocPct: line } as LinePlan;
    add(buildNightChargeMessage(adv as never, 'charge', null).body, { line, named: besideReserve(line), noNumber: atReserve, where: where('advisory push') });
    add((cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow(adv) ?? '', { line, named: besideReserve(line), noNumber: atReserve, where: where('advisory card') });
    // 6. The ON failure (every slot, some) and 7. the declined start: the line beside the 50% reserve; no definite close.
    // (Fix8 review 2) Each push's TITLE with its body: a title states the outcome too.
    for (const slots of [[1, 2, 3], [2]]) {
      const f = buildNightForceChargeOnFailure({ day: '2026-09-16', slots, ourSlots: [1, 2, 3], retries: 1, noRetry: false, ceilingPct: null, lineLinePct: line } as never);
      const b = f.body;
      add(`${f.title}\n${b}`, { line, named: beside(line, 50), where: where(`ON failure ${slots.length}`) });
      if (held && /under the line|short of the line/.test(b)) errs.push(`${where('ON failure')}: a line the reserve holds said to close under it`);
      // v1.203.0 — a line the reserve does not hold (the 50% reserve holds the pool at 49: every line here) is told it may.
      if (!held && !/may close the window (?:under|short of) the line/.test(b)) errs.push(`${where('ON failure')}: a line the reserve cannot hold not told the pool may close under it`);
    }
    const decM = notify.buildLineForceChargeDeclinedStart({ day: '2026-09-16', linePct: line, why: 'grid presence is unknown', latestStartText: '04:24' });
    const dec = decM.body;
    add(`${decM.title}\n${dec}`, { line, named: beside(line, 50), where: where('declined start') });
    if (held && /under the line/.test(dec)) errs.push(`${where('declined start')}: a line the reserve holds said to close under it`);
    if (!held && !/the pool may close under the line|perhaps under the line/.test(dec)) errs.push(`${where('declined start')}: a line the reserve cannot hold not told the pool may close under it`);
    // 8. The line at risk: whole-percent pool readings (the panel's) under the threshold, falling and flat; and 9. the morning
    // account's close; 10. the reserve-apply failure.
    const costDominant = !near; // a cost-dominant night needs its cost stop at ⌈L⌉ + 10 ≤ 100
    for (const [cause, T] of [['reOnSpent', S], ['reOnNotApplied', S], ...(costDominant ? [['costMode', ask + 5]] : [])] as Array<[string, number]>) {
      for (const P of [T - 1, Math.ceil(line - 0.05), Math.floor(line - 0.05 - 1e-9), Math.floor(line) - 3]) {
        if (!(P < T) || P < 0) continue;
        for (const refPct of [P + 1, P]) {
          const risk = { cause, offSlots: [1, 2, 3], onSlots: [], poolPct: P, refPct, thresholdPct: T, linePct: line, reOnNotAppliedSlots: cause === 'reOnNotApplied' ? [1, 2, 3] : null, panelOffAtMs: null, reOnRetryPossible: false };
          const a = notify.buildLineForceChargeAtRisk({ day: '2026-09-16', risk: risk as never, closeText: '5:00 AM', reOnCutoffText: '4:40 AM' });
          add(`${a.title}\n${a.body}`, { line, named: r1(line), where: where(`at risk ${cause} ${P}`) });
        }
      }
    }
    for (const X of [Math.floor(line - 0.05 - 1e-9), Math.ceil(line - 0.05), 100].filter((x) => x <= 100)) {
      const ran = nfc.forceChargeNightOutcome(onNight({ forceChargeLineAskPct: ask, forceChargeLinePct: line, forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd' }), { cost: false, line: true });
      const mm = buildNightChargeMorningSummary({ day: '2026-09-16', targetPct: 50, restorePct: 30, expectedKwh: 17.6, forceCharge: ran, closePoolPct: X, linePct: line } as never);
      const b = mm.body;
      add(`${mm.title}\n${b}`, { line, named: r1(line), where: where(`morning ${X}`) });
      if ((X < line - 0.05) !== /under the [\d.]+% outage line/.test(b)) errs.push(`${where('morning')}: close ${X} against ${line}: ${b}`);
    }
    // (Fix8 review 2) …and a night whose re-ON its readback check found not applied, a slot of ours then reading ON again a minute
    // later (the re-ON applied late, or Charge Now switched on in the app: forceChargeLineOnSeenAtMs, which the code cannot tell
    // apart): the count is what the check read, true in both outcomes — never "did not take effect". (The round-7 reviewer's night:
    // the panel's stop at close − 80 min, re-ON #1 at −70, checked at −55 with every slot OFF, the slots ON at −54.)
    const lateReOn = nfc.forceChargeNightOutcome(onNight({
      forceChargeLineAskPct: ask, forceChargeLinePct: line, forceChargeLinePanelOffAtMs: WIN_END - 80 * M, forceChargeLineReOns: 1,
      forceChargeLineReOnAtMs: WIN_END - 70 * M, forceChargeLineReOnSlots: [1, 2, 3], forceChargeLineReOnCheckedAtMs: WIN_END - 55 * M,
      forceChargeLineReOnNotAppliedSlots: [1, 2, 3], forceChargeLineReOnsNotApplied: 1, forceChargeLineOnSeenAtMs: WIN_END - 54 * M,
      forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd',
    }), { cost: false, line: true });
    const late = buildNightChargeMorningSummary({ day: '2026-09-16', targetPct: 50, restorePct: 30, expectedKwh: 17.6, forceCharge: lateReOn, closePoolPct: 62, linePct: line } as never);
    add(`${late.title}\n${late.body}`, { line, named: r1(line), where: where('morning, a re-ON checked not applied, then seen ON') });
    if (!late.body.includes("Charge Now was switched back on 1 time(s) after the panel's own stop (slot(s) still off at the readback check after 1 of them)")) errs.push(`${where('morning late re-ON')}: ${late.body}`);
    const apply = notify.buildNightChargeApplyFailure({ day: '2026-09-16', currentReservePct: 30, targetPct: 50, applyRetries: 2, expectedKwh: 20, linePct: line });
    add(`${apply.title}\n${apply.body}`, { line, named: r1(line), where: where('apply failure') });
    // (Fix9) …with the last start named, and with no start left, for every reason.
    for (const startClosed of [null, 'late', 'over', 'lateGuard', 'overGuard', 'noWrite', 'cancelled', 'reverted', 'foreign', 'noWindow', 'gatedOff', 'started']) {
      const a = notify.buildNightChargeApplyFailure({ day: '2026-09-16', currentReservePct: 30, targetPct: 50, applyRetries: 2, expectedKwh: 20, linePct: line, startClosed, startByText: '4:40 AM' } as never);
      add(`${a.title}\n${a.body}`, { line, named: r1(line), where: where(`apply failure ${startClosed ?? 'by 4:40 AM'}`) });
    }
    // (review 9) 12. The missed push, written and attempted; 13. the foreign push; 14. the close account; 15. the grid-loss and
    // cancelled accounts: the line beside the reserve (and the pool it is read against); a line the reserve holds never closed under.
    for (const [attempted, startClosed] of [[false, 'noWrite'], [false, 'late'], [false, 'over'], [true, null], [true, 'late']] as Array<[boolean, string | null]>) {
      const m = notify.buildNightChargeMissedApply({ day: '2026-09-16', role: 'cost', windowStartMs: WIN_START, windowEndMs: WIN_END, reason: 'the pool\'s charge reading was incoherent', reservePct: 30, nowMs: WIN_START + 31 * M,
        linePct: line, targetPct: 50, attempted, startClosed, startByText: '4:40 AM', closeText: '5:00 AM' } as never);
      add(`${m.title}\n${m.body}`, { line, named: beside(line, 50), where: where(`missed ${attempted} ${startClosed}`) });
      if (held && /under the line|under tonight's/.test(m.body) && !attempted) errs.push(`${where('missed')}: a line the reserve holds said to close under it`);
    }
    for (const started of [false, true]) {
      const f = notify.buildNightChargeForeignReserve({ day: '2026-09-16', pct: 40, targetPct: 50, restorePct: 30, line: { linePct: line, started, closeText: '5:00 AM' } } as never);
      add(`${f.title}\n${f.body}`, { line, named: beside(line, 50), where: where(`foreign ${started}`) });
      if (held && /under the line/.test(f.body)) errs.push(`${where('foreign')}: a line the reserve holds said to close under it`);
      // v1.203.0 — and a line the reserve does not hold (above the 49% it holds) is said to be one the pool may close under.
      if (!held && !f.body.includes('The pool may close under the line.')) errs.push(`${where('foreign')}: a line above the hold not said to be at risk`);
    }
    // (Fix9 review 2) …and a reading to one decimal: the line named beside it too, or "the 55.6% outage line. The pool reads 55.6%, under the line."
    for (const X of [Math.floor(line - 0.05 - 1e-9), 50, Math.ceil(line - 0.05), 100, r1(line - 0.03), r1(line + 0.03)].filter((x) => x <= 100)) {
      const acct = (notify as unknown as { buildLineNightCloseAccount: (o: unknown) => { title: string; body: string } }).buildLineNightCloseAccount({ day: '2026-09-16', linePct: line, cause: 'noWrite', closePoolPct: X });
      add(`${acct.title}\n${acct.body}`, { line, named: beside(line, 50, X), where: where(`close account ${X}`) });
      if ((X < line) !== /under the line/.test(acct.body)) errs.push(`${where('close account')}: ${X} against ${line}: ${acct.body}`);
      const printed = /the ([\d.]+)% outage line/.exec(acct.body);
      if (printed == null || (Number(printed[1]) === X && X !== line)) errs.push(`${where('close account')}: the order does not show: ${acct.body}`);
      for (const ended of ['gridLoss', 'cancelled'] as const) {
        const b = buildNightChargeMorningSummary({ day: '2026-09-16', targetPct: 50, restorePct: 30, expectedKwh: 17.6, ended, closePoolPct: X, linePct: line, closeText: '5:00 AM' } as never).body;
        for (const m of b.matchAll(/The pool reads ([\d.]+)%, (under|at or above) the ([\d.]+)% outage line/g)) {
          if (m[2] === 'under' ? !(Number(m[1]) < Number(m[3])) : !(Number(m[1]) >= Number(m[3]))) errs.push(`${where(`${ended} ${X}`)}: ${m[0]}`);
        }
      }
    }
    // 11. The mid-day push's reserve-hold shape: armed for the line (no relation), named round1(L).
    const mid = middayLegPush({ ...midBase, cushionLineSocPct: line, forceChargeLine: { askPct: ask, linePct: line } } as LinePlan);
    add(mid, { line, named: r1(line), where: where('mid-day') });
  }
  assert.deepEqual(errs.slice(0, 12), [], `${errs.length} false or misnamed`);
  // The add-on's own log lines name the line by lineLogPct (index.ts), never the record's raw two decimals.
  for (const needle of [
    '; for the ${lineLogPct(state) ?? onLineMode.askPct}% outage line: timed to reach',
    "back under the start target for the ${lineLogPct(state) ?? '?'}% outage line; switching them back ON",
    "so tonight runs for the ${lineLogPct(state) ?? '?'}% outage line under its own ceiling.",
    'outage line (${lineLogPct(state)}%) is AT RISK',
    "'s ${lineLogPct(state)}% outage line cannot start yet",
  ]) assert.ok(INDEX.includes(needle), needle);
  assert.doesNotMatch(INDEX, /\$\{state\.forceChargeLinePct \?\?|\(\$\{risk\.linePct\}%\)|\$\{declinedLinePct\}% outage line/);
});

/** (Fix8 review 2) v1.199.1's failure log lines, word for word: a night with no line ask keeps them. */
const COST_ON_FAILED_LOG = "app.log.warn(`night-charge: force-charge ON NEVER TOOK EFFECT for ${state.day} — slot(s) ${failedSlots.text} still read FORCE_CHARGE_OFF after ${state.forceChargeOnRetries} re-issue(s)${action.noRetry ? ` (none sent: under ${Math.round(FORCE_CHARGE_ON_RETRY_CUTOFF_MS / 60_000)} min of the window left, so the window-end OFF is never held behind one)` : ''}, and their Cores do not read at the panel's ceiling. Tonight's buy above the ${RESERVE_WRITE_MAX_PCT}% reserve is forfeited${all ? '' : ' on those slot(s)'}; the reserve charge is unaffected, and the OFF at the window close still runs.`);";
const COST_APPLY_FAILED_LOG = "app.log.error(`night-charge: write NEVER TOOK EFFECT — the cloud ACK'd backupReserveSoc ${state.targetPct}% but the device still reads ${currentReservePct ?? 'unknown'}% after ${state.applyRetries} retries. Tonight's charge (${buyFiguresLogText(expectedKwh, state.buyKwh)}) is forfeited; ledger corrected to actuated:0.`);";
const COST_APPLY_UNLANDED_LOG = "app.log.info(`night-charge: the ${state.day} write never took effect — after its re-issues the panel still reads the ${state.attemptBaselinePct}% it read before the write; its restore is a no-op and nothing of ours holds the reserve.`);";
const COST_ATTEMPT_UNLANDED_LOG = "app.log.info(`night-charge: the ${state.day} write attempt never landed — after its apply window the panel still reads the ${state.attemptBaselinePct}% it read before the attempt; nothing of ours holds the reserve.`);";

test('★★★ T24 (Fix8 review 2) the line-night failure LOG lines say only what holds in every outcome: on a night whose record carries a line ask the ON failure, the reserve-apply failure and the two proofs that the reserve write never landed "have NOT taken effect" (a late apply is still verified or adopted) — never "NEVER TOOK EFFECT", "is forfeited" nor "never landed"; a night with no line ask logs v1.199.1\'s lines word for word', () => {
  const block = (kind: string): string => {
    const start = INDEX.indexOf(`if (action.kind === '${kind}') {`);
    assert.ok(start > 0, kind);
    return INDEX.slice(start, INDEX.indexOf('\n    return;\n  }', start));
  };
  // The two "never landed" proofs (the tick after applyFailed, or an attempt past its apply window, with the baseline read).
  const proof = (fn: string): string => {
    const start = INDEX.indexOf(`if (${fn}(state, currentReservePct, nowMs)) {`);
    assert.ok(start > 0, fn);
    return INDEX.slice(start, INDEX.indexOf('    state = nightActuationMem;', start));
  };
  // Each branch keyed on the record's line ask (lineLogPct: forceChargeLineNightPct, round1), as its push is (forceChargeOnFailureNight,
  // linePct: forceChargeLineNightPct): line mode and a cost-dominant night alike.
  const branch = (b: string, log: 'warn' | 'error' | 'info'): { line: string; cost: string } => {
    const at = b.indexOf(`if (lineLogPct(state) != null) app.log.${log}(\`night-charge: `);
    const els = b.indexOf(`else app.log.${log}(`, at);
    assert.ok(at > 0 && els > at, `${log}: a line branch before the cost line`);
    return { line: b.slice(at, els), cost: b.slice(els + 'else '.length, b.indexOf('\n', els)) };
  };
  const final = /NEVER TOOK EFFECT|forfeited|will not happen|did not take effect/;
  const on = branch(block('onFailed'), 'warn');
  assert.equal(on.cost, COST_ON_FAILED_LOG);
  assert.doesNotMatch(on.line, final);
  assert.ok(on.line.includes("force-charge ON for ${state.day}'s ${lineLogPct(state)}% outage line has NOT taken effect — slot(s) ${failedSlots.text} still read FORCE_CHARGE_OFF after ${state.forceChargeOnRetries} re-issue(s)"), on.line);
  assert.ok(on.line.includes("Unless it applies late (a late apply is still verified), the add-on adds nothing above the ${RESERVE_WRITE_MAX_PCT}% reserve${all ? '' : ' on those slot(s)'}; the reserve charge is unaffected, and the OFF at the window close still runs."), on.line);
  const apply = branch(block('applyFailed'), 'error');
  assert.equal(apply.cost, COST_APPLY_FAILED_LOG);
  assert.doesNotMatch(apply.line, final);
  assert.ok(apply.line.includes("write has NOT taken effect — the cloud ACK'd backupReserveSoc ${state.targetPct}% but the device still reads ${currentReservePct ?? 'unknown'}% after ${state.applyRetries} retries."), apply.line);
  // (Fix9) The "waits on" arm only while a start can still come (T24 (Fix9) below).
  assert.ok(apply.line.includes("Tonight's charge (${buyFiguresLogText(expectedKwh, state.buyKwh)}) has not taken effect${lineStartClosed == null ? `: until the panel reads ${state.targetPct}% (a late apply, or the reserve set in the EcoFlow app, is still verified) the force-charge for the ${lineLogPct(state)}% outage line waits on it` : "), apply.line);
  assert.ok(apply.line.endsWith("; ledger corrected to actuated:0.`);\n    "), apply.line);
  // The class: the two proofs that a reserve write never landed (each is logged on a tick of the window, and a later reading of the
  // target still verifies the write — applyVerified — or adopts the attempt, as applyProvedUnlanded / attemptAdoptable say):
  // "has NOT taken effect" / "has NOT landed", and the force-charge for the line waits on that reading.
  const unlanded = branch(proof('applyProvedUnlanded'), 'info');
  assert.equal(unlanded.cost, COST_APPLY_UNLANDED_LOG);
  assert.doesNotMatch(unlanded.line, /never took effect|never landed|NEVER/);
  assert.ok(unlanded.line.includes("the ${state.day} write has NOT taken effect — after its re-issues the panel still reads the ${state.attemptBaselinePct}% it read before the write; ${applyStartClosed == null ? `until a reading of the target verifies it (a late apply, or the reserve set in the EcoFlow app), its restore is a no-op, nothing of ours holds the reserve, and the force-charge for the ${lineLogPct(state)}% outage line waits on it` : "), unlanded.line);
  const attempt = branch(proof('attemptProvedUnlanded'), 'info');
  assert.equal(attempt.cost, COST_ATTEMPT_UNLANDED_LOG);
  assert.doesNotMatch(attempt.line, /never took effect|never landed|NEVER/);
  assert.ok(attempt.line.includes("the ${state.day} write attempt has NOT landed — after its apply window the panel still reads the ${state.attemptBaselinePct}% it read before the attempt: nothing of ours holds the reserve, and ${attemptStartClosed == null ? `the force-charge for the ${lineLogPct(state)}% outage line waits on a reading of the target` : "), attempt.line);
  const unlandedNight = night({ applyVerifiedAtMs: null, applyEscalated: true, applyRetries: 2, applyLastAttemptMs: WIN_START + 20 * M });
  assert.equal(act.applyProvedUnlanded(unlandedNight, 30, WIN_START + 40 * M), true, 'proved on a tick of the window');
  const tick = (pct: number) => ({ mode: 'supervised', writeReady: true, currentReservePct: pct, socCoherent: true, vitalsRed: false, gridPresent: true }) as act.ActuationTickOpts;
  assert.equal(act.decideActuation(unlandedNight, WIN_START + 41 * M, tick(50)).kind, 'applyVerified', 'a later reading of the target verifies it');
  const attemptNight = night({ appliedAtMs: null, applyVerifiedAtMs: null, applyAttemptedAtMs: WIN_START, attemptBaselinePct: 30 });
  assert.equal(act.applyProvedUnlanded(attemptNight, 30, WIN_START + 40 * M), false);
  assert.equal(act.attemptProvedUnlanded(attemptNight, 30, WIN_START + 40 * M), true, 'proved on a tick of the window');
  const stamped = { ...attemptNight, attemptUnlandedAtMs: WIN_START + 40 * M } as LineState;
  assert.equal(act.attemptAdoptable(stamped, 50), true, 'a later reading of the target adopts it');
  assert.equal(act.decideActuation(stamped, WIN_START + 41 * M, tick(50)).kind, 'adopt', '…after the stamp');
  // Why: both are still read after the failure — the ON's verify reads onVerified before its failure guard (index.ts logs "after the
  // warning — it applied late"), and the apply ladder verifies a reading of the target after applyFailed.
  assert.ok(INDEX.includes("${state.forceChargeOnFailedAtMs != null ? ' (after the warning — it applied late)' : ''}"));
  const ok = (s: LineState) => (decideForceCharge(s, WIN_END - 2 * H, fo({ slotsOn: [1, 2, 3], poolSocPct: 55 })) as { kind: string }).kind;
  assert.equal(ok(night({ forceChargeOnAtMs: WIN_END - 3 * H, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: null, forceChargeMode: 'line',
    forceChargeOnFailedAtMs: WIN_END - 150 * M, forceChargeOnFailedSlots: [1, 2, 3], forceChargeOnRetries: 1 })), 'onVerified', 'a late apply after the ON failure is verified');
  // The key is the push's: lineLogPct is null exactly where forceChargeLineNightPct is.
  for (const [ask, l] of [[56, 55.55], [56, null], [50, 50], [null, null]] as Array<[number | null, number | null]>) {
    const s = { forceChargeLineAskPct: ask, forceChargeLinePct: l } as LineState;
    assert.equal(nfc.lineLogPct(s) == null, nfc.forceChargeLineNightPct(s) == null, `${ask}/${l}`);
  }
});

/** (Fix9) The two line-night log arms of each "waits on" site in index.ts: the line branch's template, split at its key. */
const lineArms = (line: string, key: string): { open: string; closed: string } => {
  const at = line.indexOf(`\${${key} == null ? `);
  assert.ok(at > 0, `${key}: the waits-on words keyed on it`);
  const sep = line.indexOf('` : ', at);
  return { open: line.slice(at, sep), closed: line.slice(sep) };
};

test('★★★ T24 (Fix9) a line night\'s force-charge "waits on" a reading of the target only while a start can still come — the checks decideForceCharge makes before a start (forceChargeStartClosed); a cancelled night, one 20 min or less from its close or past it, says no force-charge for the line starts, and why: the three index.ts log lines and the apply-failure push; a night with no line ask unchanged', () => {
  // The apply-failure push: until the close less 20 min (the last start the add-on makes) the force-charge waits on the write;
  // after it, or with no start left, the push says none starts and why (keyed and wired as the log line is: below).
  const push = (over: Record<string, unknown>) => notify.buildNightChargeApplyFailure({ day: '2026-09-16', currentReservePct: 30, targetPct: 50, applyRetries: 2, expectedKwh: 20, linePct: 55.55, ...over } as never);
  const head = 'The supervised reserve write for 2026-09-16 was accepted by the EcoFlow cloud but the Smart Home Panel 2 still reads 30% (target 50%) after 2 re-issues. '
    + "Tonight's planned charge (~20 kWh expected) has not taken effect: until the panel reads 50%, it keeps its normal reserve, under tonight's 55.6% outage line";
  for (const [why, sentence] of [
    ['late', 'No force-charge for the line starts: 20 min or less of the window is left.'],
    ['over', 'No force-charge for the line starts: the window has closed.'],
    ['lateGuard', 'No force-charge for the line starts: 20 min or less is left before the on-peak guard (an hour before on-peak).'],
    ['overGuard', 'No force-charge for the line starts: the on-peak guard (an hour before on-peak) has begun.'],
    ['cancelled', 'No force-charge for the line starts: the night was cancelled.'],
    ['gatedOff', 'No force-charge for the line starts while the options keep it off.'],
  ] as Array<[string, string]>) {
    const m = push({ startClosed: why, startByText: '4:40 AM' });
    assert.equal(m.body, `${head}. ${sentence} If this repeats, check the SHP2 cloud link.`, why);
    assert.equal(m.title, 'Night-charge: the reserve write has not taken effect');
    assert.doesNotMatch(m.body, /waits on|To let it start|To hold the line|as planned|No action needed|will not happen/);
  }
  assert.equal(push({ startClosed: null, startByText: '4:40 AM' }).body, `${head}, and the force-charge for the line waits on this write. `
    + 'To let it start, set the backup reserve to 50% in the EcoFlow app now: the sooner the panel reads it, the more of the line a start can reach. No force-charge starts after ~4:40 AM, and one that late may close under the line. If this repeats, check the SHP2 cloud link.');
  // (review 9) The time is the last start, never the way to hold the line: a start that late may close under it (and, with the
  // ceiling unsynced, a reading in its last minute starts nothing), so nothing there promises a start or the plan.
  assert.doesNotMatch(push({ startClosed: null, startByText: '4:40 AM' }).body, /as planned|the add-on starts|To hold the line|before ~4:40/);
  // A night with no line ask: v1.199.1's push whatever the key says (COST_TEXTS-pinned in lineForceChargeAtRisk W5 #6).
  const cost = (k: unknown) => JSON.stringify(notify.buildNightChargeApplyFailure({ day: '2026-10-12', currentReservePct: 16, targetPct: 50, applyRetries: 2, expectedKwh: 20, linePct: null, startClosed: k, startByText: '4:40 AM' } as never));
  assert.equal(cost('late'), cost(null));
  assert.equal(cost(null), JSON.stringify(notify.buildNightChargeApplyFailure({ day: '2026-10-12', currentReservePct: 16, targetPct: 50, applyRetries: 2, expectedKwh: 20 })));
  // index.ts: each of the three line-night log lines keys its "waits on" on the record and the gates now, in the line branch only;
  // the closed arm carries no "waits"; the cost lines are v1.199.1's (T24 Fix8 review 2 above).
  const KEY = 'forceChargeStartClosed(state, nowMs, forceChargeGatesOn(legRoleOf(state)))';
  const proof = (fn: string): string => INDEX.slice(INDEX.indexOf(`if (${fn}(state, currentReservePct, nowMs)) {`), INDEX.indexOf('    state = nightActuationMem;', INDEX.indexOf(`if (${fn}(state, currentReservePct, nowMs)) {`)));
  const failedBlock = INDEX.slice(INDEX.indexOf("if (action.kind === 'applyFailed') {"), INDEX.indexOf('\n    return;\n  }', INDEX.indexOf("if (action.kind === 'applyFailed') {")));
  for (const [b, key, log, open, closed] of [
    [proof('attemptProvedUnlanded'), 'attemptStartClosed', 'info', 'the force-charge for the ${lineLogPct(state)}% outage line waits on a reading of the target',
      'lineStartClosedWords(`the ${lineLogPct(state)}% outage line`, attemptStartClosed)}.`);'],
    [proof('applyProvedUnlanded'), 'applyStartClosed', 'info', 'until a reading of the target verifies it (a late apply, or the reserve set in the EcoFlow app), its restore is a no-op, nothing of ours holds the reserve, and the force-charge for the ${lineLogPct(state)}% outage line waits on it',
      '`nothing of ours holds the reserve, and ${lineStartClosedWords(`the ${lineLogPct(state)}% outage line`, applyStartClosed)}`}.`);'],
    [failedBlock, 'lineStartClosed', 'error', ': until the panel reads ${state.targetPct}% (a late apply, or the reserve set in the EcoFlow app, is still verified) the force-charge for the ${lineLogPct(state)}% outage line waits on it',
      '`, and ${lineStartClosedWords(`the ${lineLogPct(state)}% outage line`, lineStartClosed)}`}; ledger corrected to actuated:0.`);'],
  ] as Array<[string, string, string, string, string]>) {
    assert.ok(b.includes(`const ${key} = ${KEY};`), `${key}: keyed on the record and the gates now`);
    const at = b.indexOf(`if (lineLogPct(state) != null) app.log.${log}(\`night-charge: `);
    const line = b.slice(at, b.indexOf(`else app.log.${log}(`, at));
    const arms = lineArms(line, key);
    assert.ok(arms.open.includes(open), `${key} open: ${arms.open}`);
    assert.ok(arms.closed.includes(closed), `${key} closed: ${arms.closed}`);
    assert.doesNotMatch(arms.closed, /waits/);
    assert.equal(line.split('waits on').length - 1, 1, `${key}: "waits on" in the open arm only`);
  }
  assert.ok(failedBlock.includes('        startClosed: lineStartClosed,\n        startByText: state.windowEndMs != null ? fmtSiteClock(writeWindowEndMs(state)! - FORCE_CHARGE_MIN_RUN_MS) : null,\n'), failedBlock);
  const closedOf = (nfc as unknown as { forceChargeStartClosed?: (s: unknown, t: number, g: { cost: boolean; line: boolean }) => string | null }).forceChargeStartClosed;
  const wordsOf = (nfc as unknown as { lineStartClosedWords?: (line: string, why: string) => string }).lineStartClosedWords;
  assert.equal(typeof closedOf, 'function', 'nightForceCharge.forceChargeStartClosed');
  assert.equal(typeof wordsOf, 'function', 'nightForceCharge.lineStartClosedWords');
  const LINE_GATE = { cost: false, line: true };
  // The write proved unlanded or failed: the reserve not verified. The round-7 reviewer's probes are the cancelled night, the
  // applyFailed at the write end less 4 min, and the attempt proved unlanded two hours after the close.
  const failed = (over: Partial<LineState> = {}) => night({ applyVerifiedAtMs: null, applyEscalated: true, applyRetries: 2, ...over });
  const onPeak = WIN_END - 30 * M + act.ON_PEAK_RAISE_GUARD_MS; // on-peak 30 min after the close: its guard (an hour before) ends the writes 30 min early
  const cases: Array<[string, LineState, number, { cost: boolean; line: boolean }, string | null]> = [
    ['40 min into the window (T24 Fix8 review 2\'s night)', failed(), WIN_START + 40 * M, LINE_GATE, null],
    ['before the window opens', failed(), WIN_START - 30 * M, LINE_GATE, null],
    ['the last minute before the close less 20 min', failed(), WIN_END - 20 * M - 1, LINE_GATE, null],
    ['a cost-dominant night, the line gate off and the cost gate on', failed({ forceChargeCeilingPct: 70 }), WIN_START + 40 * M, { cost: true, line: false }, null],
    ['cancelled', failed({ cancelled: true }), WIN_START + 40 * M, LINE_GATE, 'cancelled'],
    ['the restore sent', failed({ revertedAtMs: WIN_START + 39 * M }), WIN_START + 40 * M, LINE_GATE, 'reverted'],
    ['the reserve set outside the add-on', failed({ foreignSettledAtMs: WIN_START + 39 * M }), WIN_START + 40 * M, LINE_GATE, 'foreign'],
    ['no window', failed({ windowStartMs: null, windowEndMs: null }), WIN_START + 40 * M, LINE_GATE, 'noWindow'],
    ['the close less 20 min', failed(), WIN_END - 20 * M, LINE_GATE, 'late'],
    ['applyFailed at the write end less 4 min', failed(), WIN_END - 4 * M, LINE_GATE, 'late'],
    ['the close', failed(), WIN_END, LINE_GATE, 'over'],
    ['two hours after the close', failed(), WIN_END + 2 * H, LINE_GATE, 'over'],
    ['the on-peak guard sooner than the close: its own less 20 min', failed({ nextOnPeakStartMs: onPeak }), WIN_END - 50 * M, LINE_GATE, 'lateGuard'],
    ['…and a minute before that', failed({ nextOnPeakStartMs: onPeak }), WIN_END - 51 * M, LINE_GATE, null],
    ['the on-peak guard reached, the window still open', failed({ nextOnPeakStartMs: onPeak }), WIN_END - 30 * M, LINE_GATE, 'overGuard'],
    ['a guard that binds nothing (on-peak over an hour after the close): the window\'s words', failed({ nextOnPeakStartMs: WIN_END + 2 * H }), WIN_END, LINE_GATE, 'over'],
    ['the line gate off (NIGHT_CHARGE_MODE advisory)', failed(), WIN_START + 40 * M, { cost: false, line: false }, 'gatedOff'],
    ['a force-charge of ours already on', onNight(), WIN_START + 3 * H, LINE_GATE, 'started'],
  ];
  for (const [what, s, t, gates, want] of cases) {
    assert.equal(closedOf!(s, t, gates), want, what);
    // The same predicate decideForceCharge uses: with the reserve write verified now (a late apply, or the reserve set by hand),
    // a start comes on a later tick exactly where none is closed — and a closed start never yields a blocker (no "cannot start yet").
    const verified = { ...s, applyVerifiedAtMs: t } as LineState;
    const o = fo({ enabled: gates.cost, lineEnabled: gates.line, poolSocPct: 50, ceilingReadbackPct: 80 });
    let started = false;
    for (let u = t; u < Math.max(t, WIN_END) + 3 * H && !started; u += M) {
      const a = decideForceCharge(verified, u, o) as { kind: string; why?: string };
      if (a.kind === 'on' || a.kind === 'syncCeiling') started = true;
      if (want != null) assert.equal(nfc.isForceChargeStartBlocker(a.why), false, `${what}: ${a.why}`);
    }
    assert.equal(started, want == null, `${what}: a start ${want == null ? 'comes' : 'never comes'}`);
  }
  // (review 9) No write issued past the apply window: none goes after it, and with no attempt on record no reading is adopted, so
  // appliedAtMs stays null (decideForceCharge waits for good). An attempt on record may still be adopted; the window's last moment
  // may still bring the write. Past the close or inside its last 20 min those keys stand, as for any record.
  const noWrite = night({ appliedAtMs: null, applyAttemptedAtMs: null, applyVerifiedAtMs: null });
  assert.equal(closedOf!(noWrite, WIN_START + act.APPLY_LATE_MS + 1, LINE_GATE), 'noWrite');
  assert.equal(closedOf!(noWrite, WIN_START + act.APPLY_LATE_MS, LINE_GATE), null);
  assert.equal(closedOf!(night({ appliedAtMs: null, applyVerifiedAtMs: null }), WIN_START + act.APPLY_LATE_MS + 1, LINE_GATE), null, 'an attempt on record');
  assert.equal(closedOf!(night({ applyAttemptedAtMs: null, applyVerifiedAtMs: null }), WIN_START + act.APPLY_LATE_MS + 1, LINE_GATE), null, 'applied');
  assert.equal(closedOf!(noWrite, WIN_END - 10 * M, LINE_GATE), 'late');
  assert.equal(closedOf!(noWrite, WIN_END, LINE_GATE), 'over');
  // The words, each true for the rest of the record ('gatedOff' while the options keep it off): never "waits", "yet", "may still".
  const L = 'the 55.6% outage line';
  const words: Record<string, string> = {
    cancelled: 'no force-charge for the 55.6% outage line starts: the night was cancelled',
    reverted: "no force-charge for the 55.6% outage line starts: the reserve's restore was sent",
    foreign: 'no force-charge for the 55.6% outage line starts: the reserve was changed',
    noWindow: 'no force-charge for the 55.6% outage line starts: the night has no charge window',
    over: 'no force-charge for the 55.6% outage line starts: the window has closed',
    late: 'no force-charge for the 55.6% outage line starts: 20 min or less of the window is left',
    overGuard: 'no force-charge for the 55.6% outage line starts: the on-peak guard (an hour before on-peak) has begun',
    lateGuard: 'no force-charge for the 55.6% outage line starts: 20 min or less is left before the on-peak guard (an hour before on-peak)',
    noWrite: 'no force-charge for the 55.6% outage line starts: no verified reserve write, and no reading of the target with every check clear, came in the apply window',
    gatedOff: 'no force-charge for the 55.6% outage line starts while the options keep it off',
    started: 'the force-charge for the 55.6% outage line was switched on earlier and does not start again',
  };
  for (const [why, w] of Object.entries(words)) {
    assert.equal(wordsOf!(L, why), w, why);
    assert.doesNotMatch(w, /waits|\byet\b|may still|as planned/);
  }
});

/** (Fix8) The rationale names the line by the plan's own two decimals (cushionLineSocPct). Over the year where the edges fall
 *  (9-20 h, both bases, the live cost gate, eligibility true and false), every relation it states is true but one: a line
 *  stated at 50.00 whose raw value a hair above the reserve is asked at 51 reads "tonight's 50% outage line is above it" —
 *  the A5 identity holds those plans (a residual, counted: the identity's guard would have to move with it). The push and
 *  the card of the same armed plans (armFromPlan's record) state none false. */
// v1.202.0 — on the measured pool (v1.201.0: 13,217 and 5,742), and with every cost-carried night whose walk past its stop
// closes under the line naming the line in its NOTE, whether or not its sizing fell short (79 plans more, each sized short:
// its NOTE stands beside the caps note).
// v1.203.0 — 2,106 plans more name the line: the reserve sentence of a line the write holds names it beside the point the write adds
// (one point above the line's whole percent, the panel holding a point under a reserve it charged up to). 108 more are armed: a line in
// (49, 50], which the 50% reserve holds at 49, is the line force-charge's, each named beside the 49% (besideReserve). The six lines
// stated at 50.00 and asked at 51 keep v1.202.0's rationale (keyed on the ask, which knows the side of 50 they lie on).
// v1.205.0 — 135 plans more name the line: a cost-carried night's close past its stop, capped at the window's reach (H1), under the
// line on nights already disclosed for their sizing (each NOTE beside the caps note); and 5 more: cost-carried nights disclosed
// 'lateStart' (the at-open allowance), whose NOTE names the line where nothing did.
const PIN_T24_YEAR = { plans: 15596, armed: 6108, stated50: 6 };

test('★★★ T24 (Fix8) the year at the edges: the rationale, the push and the card of every line plan state each relation true — but the rationale of a line stated at 50.00, counted', () => {
  const got = { plans: 0, armed: 0, stated50: 0 };
  const errs: string[] = [];
  for (const h of [9, 11, 14, 15, 17, 18, 19, 20]) for (const basis of ['np', 'm'] as const) for (const label of CASES.map((c) => c.label)) for (const elig of [true, false]) {
    const p = yearPlanAt(label, h, basis, { line: elig });
    if (p.cushionLineSocPct == null || !/outage line/.test(p.rationale)) continue;
    got.plans += 1;
    const line = p.cushionLineSocPct;
    const where = `${label} ${basis} ${h} h ${elig ? 'armed' : 'advisory'} (${line})`;
    const r = lineRelationErrors(p.rationale, { line, named: line, noNumber: false, where: `${where} rationale` });
    if (line <= 50 && r.length > 0 && r.every((x) => x.includes('"above the 50% reserve"'))) got.stated50 += 1;
    else errs.push(...r);
    if (p.forceChargeLine == null) continue;
    got.armed += 1;
    const atReserve = unnumberedBesideReserve(line);
    const sup = armedSupervised(p, liveCost(label));
    errs.push(...lineRelationErrors(buildNightChargeMessage(p, 'charge', sup as never).body, { line, named: besideReserve(line), noNumber: atReserve, where: `${where} push` }));
    const row = (cardText as unknown as { outageLineRow: (p: unknown) => string | null }).outageLineRow(p);
    if (row != null) errs.push(...lineRelationErrors(row, { line, named: besideReserve(line), noNumber: atReserve, where: `${where} card` }));
  }
  assert.deepEqual(errs.slice(0, 10), [], `${errs.length} false`);
  assert.deepEqual(got, PIN_T24_YEAR);
});
