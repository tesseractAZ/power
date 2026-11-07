import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nca from '../src/nightChargeAdvisor.js';
import { computeNightChargePlan, buildNightChargeInputs, type NightChargePlan, type CushionPoolScale } from '../src/nightChargeAdvisor.js';
import * as cardText from '../../web/src/cards/nightChargeText.js';
import * as nfc from '../src/nightForceCharge.js';
import { armedForceChargeCeilingPct } from '../src/nightChargeActuator.js';
import { legacyIdentityCases, planDigest } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';

/**
 * v1.200.0 (A5) — THE YEAR, AS THE CUSHION RISES (plan-A5 §5 T15, T17).
 *
 * The line force-charge is ARMED on every qualifying night a write mode can force-charge, whatever the ask (the
 * ⌈L⌉ + 10 ≤ 100 cut decides only whether the plan may CLAIM the line). A night is CARRIED only where its own line
 * walk — its close capped at what the window can reach (H1) — closes at or above L − 0.05; otherwise it is DISCLOSED
 * (nearFull / closeUnder) and the force-charge still runs.
 *
 * T15 — the safety invariants, over legacyIdentity's year (1,104 cases) × ARB_OUTAGE_CUSHION_HOURS 4..20 × both bases
 * (nameplate, ×0.944), eligibility true, the live cost gate (cost objective and ARB_COST_MAX_SOC_PCT above 50). As
 * the cushion hours rise (h → h + 1, where the line does not fall):
 *  - M1  the armed force-charge target (armedWriteLevelPct) never falls;
 *  - M2  the panel ceiling (forceChargeModeOf on the record the plan arms) never falls;
 *  - M3′ an armed line never disarms;
 *  - M4  the expected close never lands under min(its last close, its own line) − 0.05 undisclosed;
 * and on every plan:
 *  - M4′ (I-A4′) no carried night's own (capped) expected close is under the line − 0.05 undisclosed;
 *  - the carrier rest: a qualifying night is armed or disclosed, never neither;
 *  - H1: a line walk's stated close is within the window's reach (the window-open pool plus what the window can
 *    deliver; the year's windows are overnight, no P50 sun), never under the 50% reserve, and a stated panel stop
 *    needs that reach;
 *  - the texts: a line-mode night under its line says so, a line above a full pool says so, an armed night never
 *    says "no force-charge";
 *  - (T19) lineNotHeldOf, the predicate every surface words by, and the card's mirror agree with the walk on every plan;
 *  - (T22) the spoken notice says a window-bound line night ends short of its level ("which ends before it gets there")
 *    only where the 50% floor lifts that level above the window's reach.
 * The expected close and the expected buy are NOT monotone in the line (a latching walk: a higher line starts earlier
 * and latches sooner): their falls are pinned as counts, not asserted (PIN_A5). With ARB_COST_MAX_SOC_PCT above 95
 * the start target can fall as the line crosses 90 (the cost ceiling to 95%): pinned, the ceiling still never falls.
 *
 * T17 — the identity: every plan A5 must not move is byte-identical to 962e4668 (fixtures/lineForceCharge.a5Identity
 * .json, generated there before the change, per (h, basis, cost gate, eligibility) group). Guarded: eligibility false
 * or absent; at eligibility true, no line ask, the backup leg's disclosure, a carried night in cost mode, and a
 * carried line-mode night that is not deliverable-bound and whose walk holds its line.
 * v1.202.0 — re-cut: a cost-mode line night is no longer guarded (its drawback past the stop is walked and disclosed); the
 * nameplate ('np') groups were regenerated with that guard on c692f30e and on v1.202.0 and are byte-identical; the 0.944
 * ('m') groups move by design (the walks on the measured pool) and are v1.202.0's own, pinned. 4 h — the live shape, no line
 * above 50 on the year — must be guarded whole. The suite checks a fixed sample of hours; A5_IDENTITY_FULL=1 checks
 * every group (the gates run it), and A5_IDENTITY_WRITE=1 writes the fixture (run on the base only).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures/lineForceCharge.a5Identity.json');
const CASES = legacyIdentityCases();
const HMIN = 4;
const HMAX = 20;
const TOL = 0.05;
const EPS = 1e-9;
type Basis = 'np' | 'm';
const SCALES: Record<Basis, CushionPoolScale | null> = { np: null, m: MEASURED_SCALE };
type Deps = (typeof CASES)[number]['deps'];
type Plan = NightChargePlan & {
  forceChargeLine?: { askPct: number; linePct: number };
  cushionShortfallCause?: 'envelope' | 'envelope+caps';
  cushionEnvelopeReason?: string;
  expectedForceChargeMode?: 'line';
  expectedLineCeilingStop?: { ceilingPct: number; startTargetPct: number };
};

/** The live cost gate (index.ts forceChargeOn): the cost objective and ARB_COST_MAX_SOC_PCT above the reserve maximum. */
const liveGate = (d: Deps): Deps => ({ ...d, forceChargeEligible: d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50 } as Deps);
/** (L1) ARB_COST_MAX_SOC_PCT raised to 100 on the year's cost cases at 90 or more (the fixture tops at 95). */
const cost100 = (d: Deps): Deps => (d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) >= 90 ? { ...d, costMaxSocPct: 100 } as Deps : d);
const planAt = (deps: Deps, basis: Basis, h: number, elig: boolean | undefined): Plan => computeNightChargePlan(buildNightChargeInputs({
  ...deps, outageCushionHours: h, ...(SCALES[basis] != null ? { cushionPoolScale: SCALES[basis] } : {}),
  ...(elig !== undefined ? { lineForceChargeEligible: elig } : {}),
} as never)) as Plan;

/** At or above the line less the tolerance, the edge included (nightChargeAdvisor LINE_CLOSE_EDGE_EPS: float). */
const holds = (e: number | null | undefined, l: number): boolean => e == null || e >= l - TOL - EPS;
const UNDER_NOTE = /NOTE: on the median load the pool is expected to close at ~[\d.]+%, under tonight's [\d.]+% outage line, so the cushion is not fully held — residual risk remains\./;
const ABOVE_NOTE = /NOTE: tonight's [\d.]+% outage line is above a full pool, so no charge can hold it — residual risk remains\./;
const MARGIN_NOTE = /NOTE: tonight's [\d.]+% outage line is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin; the cushion is not assured — residual risk remains\./;

interface Row {
  line: number | null; armed: boolean; cause: string | null; reason: string | null; sf: boolean; E: number | null; buy: number | null;
  bound: boolean; target: number | null; ceil: number | null; qual: boolean; kind: string | null;
}

interface Sweep {
  /** Asserted 0. */
  m1: number; m2: number; m3: number; m4: number; undisclosedUnder: number; carrierRest: number;
  reachOver: number; stopUnreached: number; underFloor: number; textMissing: number; noForceCharge: number;
  /** Pinned. */
  armed: number; carried: number; nearFull: number; closeUnder: number;
  kinds: { closeUnder: number; aboveFull: number; nearFull: number };
  eFalls: number; eFallsNonBoundGt5: number; eFallMaxNonBound: number; buyFalls: number; closeUnderVanish: number;
  /** The largest step falls of the stated close (after any walk) and of the expected buy, and where (label basis h → h + 1). */
  eFallMax: { d: number; at: string }; buyFallMax: { d: number; at: string };
  meanBuyQual: Record<number, number | null>;
  /** T19 — plans lineNotHeldOf and the card's lineNotHeldOfCard were checked on, and those either disagreed with the walk. */
  parity: { checked: number; mismatch: number };
  /** T22 — window-bound line-mode plans, those the spoken notice says end short of their level (chargeEndsShortOfLevel),
   *  and those where it would say so of a close above the reserve, or not of one floored at it. */
  spoken: { boundLine: number; endsShort: number; mismatch: number };
  ex: string[];
}
type NotHeldFn = (p: unknown) => string | null;
const serverKind = (nca as unknown as { lineNotHeldOf?: NotHeldFn }).lineNotHeldOf;
const cardKind = (cardText as unknown as { lineNotHeldOfCard?: NotHeldFn }).lineNotHeldOfCard;
const endsShort = (nca as unknown as { chargeEndsShortOfLevel?: (p: unknown) => boolean }).chargeEndsShortOfLevel;

function sweep(basis: Basis, depsOf: (d: Deps) => Deps): Sweep {
  const s: Sweep = {
    m1: 0, m2: 0, m3: 0, m4: 0, undisclosedUnder: 0, carrierRest: 0, reachOver: 0, stopUnreached: 0, underFloor: 0, textMissing: 0, noForceCharge: 0,
    armed: 0, carried: 0, nearFull: 0, closeUnder: 0, kinds: { closeUnder: 0, aboveFull: 0, nearFull: 0 },
    eFalls: 0, eFallsNonBoundGt5: 0, eFallMaxNonBound: 0, buyFalls: 0, closeUnderVanish: 0, eFallMax: { d: 0, at: '' }, buyFallMax: { d: 0, at: '' },
    meanBuyQual: {}, parity: { checked: 0, mismatch: 0 },
    spoken: { boundLine: 0, endsShort: 0, mismatch: 0 }, ex: [],
  };
  const buySum: Record<number, number> = {};
  const qualN: Record<number, number> = {};
  const note = (m: string) => { if (s.ex.length < 12) s.ex.push(m); };
  for (const c of CASES) {
    const deps = depsOf(c.deps);
    const gates = { cost: deps.forceChargeEligible === true, line: true };
    let prev: Row | null = null;
    for (let h = HMIN; h <= HMAX; h++) {
      const p = planAt(deps, basis, h, true);
      const ask = p.forceChargeLine?.askPct ?? null;
      const mode = nfc.forceChargeModeOf({ forceChargeCeilingPct: armedForceChargeCeilingPct(p), forceChargeLineAskPct: ask } as never, gates);
      const L = p.cushionLineSocPct ?? null;
      const E = p.expectedWriteLevelPct ?? null;
      const lineMode = p.expectedForceChargeMode === 'line';
      // v1.202.0 — a night the cost force-charge carries closes where its walk past the stop ends (expectedCloseAfterStopPct,
      // present where under the line); its level E is the stop.
      const closeAfter = (p as Plan & { expectedCloseAfterStopPct?: number }).expectedCloseAfterStopPct ?? null;
      const closeE = lineMode ? E : (closeAfter ?? E);
      const r: Row = {
        line: L, armed: p.forceChargeLine != null, cause: p.cushionShortfallCause ?? null, reason: p.cushionEnvelopeReason ?? null,
        sf: p.cushionShortfall === true, E, buy: p.expectedBuyKwh ?? null, bound: p.expectedDeliverableBound === true,
        target: p.chargeTonight ? nfc.armedWriteLevelPct(p as never, gates) : null,
        ceil: p.chargeTonight && mode != null ? mode.panelCeilingPct : null,
        qual: p.forceChargeLine != null || p.cushionShortfallCause != null,
        kind: L == null || p.forceChargeLine == null ? null
          : !lineMode ? (closeAfter != null && !holds(closeAfter, L) ? 'closeUnder' : null)
            : L > 100 ? 'aboveFull' : !holds(E, L) ? 'closeUnder' : p.cushionEnvelopeReason === 'nearFull' ? 'nearFull' : null,
      };
      const where = `${c.label} ${basis} ${h} h`;
      if (serverKind != null && cardKind != null) {
        s.parity.checked += 1;
        if (serverKind(p) !== r.kind || cardKind(p) !== r.kind) { s.parity.mismatch += 1; note(`${where}: walk ${r.kind}, server ${serverKind(p)}, card ${cardKind(p)}`); }
      }
      // Per plan: the carry, the carrier rest, the reach, the texts.
      if (r.armed) {
        s.armed += 1;
        if (r.cause == null) s.carried += 1;
        if (/no force-charge/.test(p.rationale)) { s.noForceCharge += 1; note(`${where}: an armed night says "no force-charge"`); }
      }
      if (r.reason === 'nearFull') s.nearFull += 1;
      if (r.reason === 'closeUnder') s.closeUnder += 1;
      if (r.kind != null) s.kinds[r.kind as keyof Sweep['kinds']] += 1;
      if (r.armed && !r.sf && L != null && !holds(closeE, L)) { s.undisclosedUnder += 1; note(`${where}: carried, ~${closeE}% under ${L}%, undisclosed`); }
      // v1.202.0 — a cost-carried night disclosed by its walk past the stop says so in the rationale.
      if (!lineMode && r.kind === 'closeUnder' && !UNDER_NOTE.test(p.rationale)) { s.textMissing += 1; note(`${where}: no under-line NOTE (cost-carried)`); }
      if (r.qual) { qualN[h] = (qualN[h] ?? 0) + 1; buySum[h] = (buySum[h] ?? 0) + (r.buy ?? 0); }
      if (L != null && p.chargeTonight && p.cushionBasis === 'islanded-outage' && Math.min(100, Math.ceil(L - 1e-9)) > 50
        && (p.requiredExtraKwh ?? 0) > 0 && !r.qual) { s.carrierRest += 1; note(`${where}: qualifying, neither armed nor disclosed`); }
      if (lineMode && L != null) {
        if (r.kind === 'closeUnder' && !UNDER_NOTE.test(p.rationale)) { s.textMissing += 1; note(`${where}: no under-line NOTE`); }
        if (r.kind === 'aboveFull' && !ABOVE_NOTE.test(p.rationale)) { s.textMissing += 1; note(`${where}: no above-full NOTE`); }
        if (r.kind === 'nearFull' && !MARGIN_NOTE.test(p.rationale)) { s.textMissing += 1; note(`${where}: no margin NOTE`); }
        if (r.kind == null && (UNDER_NOTE.test(p.rationale) || ABOVE_NOTE.test(p.rationale) || MARGIN_NOTE.test(p.rationale))) { s.textMissing += 1; note(`${where}: a NOTE on a held line`); }
        // H1 — the window's reach on a deliverable-bound walk: the window-open pool plus what the window delivers
        // (expectedBuyKwh × legEff on a bound walk), no P50 sun in an overnight window; never under the reserve.
        if (r.bound && E != null && p.expectedStartSocPct != null && r.buy != null) {
          // v1.202.0 — a percent of the plan's own pool (NightChargePlan.planPool: the measured capacity where a scale moved it).
          const poolKwh = (p as Plan & { planPool?: { kwh: number } }).planPool?.kwh ?? deps.fullKwh;
          const reach = p.expectedStartSocPct + ((r.buy * (deps.legEff ?? 0.927)) / poolKwh) * 100;
          if (E > Math.max(50, reach) + 0.15) { s.reachOver += 1; note(`${where}: ~${E}% stated, reach ${reach.toFixed(1)}%`); }
          if (p.expectedLineCeilingStop != null && reach < p.expectedLineCeilingStop.ceilingPct - 0.15) {
            s.stopUnreached += 1; note(`${where}: a ${p.expectedLineCeilingStop.ceilingPct}% stop stated, reach ${reach.toFixed(1)}%`);
          }
        }
        if (E != null && E < 50 - EPS) { s.underFloor += 1; note(`${where}: ~${E}% under the reserve`); }
        // T22 — the spoken notice's "which ends before it gets there": a bound line walk's level is its reach (H1), so only
        // a level floored at the 50% reserve ends short.
        if (r.bound && endsShort != null) {
          s.spoken.boundLine += 1;
          const short = endsShort(p);
          if (short) s.spoken.endsShort += 1;
          if (short !== (E == null || E <= 50)) { s.spoken.mismatch += 1; note(`${where}: ~${E}%, ends short ${short}`); }
        }
      }
      // Per step (h − 1 → h), where the line did not fall.
      if (prev != null && !(prev.line != null && L != null && L < prev.line - EPS)) {
        const fell = (a: number | null, b: number | null) => a != null && (b == null || b < a - EPS);
        if (fell(prev.target, r.target)) { s.m1 += 1; note(`${where}: target ${prev.target} → ${r.target}`); }
        if (fell(prev.ceil, r.ceil)) { s.m2 += 1; note(`${where}: ceiling ${prev.ceil} → ${r.ceil}`); }
        if (prev.armed && !r.armed) { s.m3 += 1; note(`${where}: disarmed`); }
        if (prev.E != null && E != null && L != null && !r.sf && E < Math.min(prev.E, L) - TOL) { s.m4 += 1; note(`${where}: ~${prev.E} → ~${E}% under ${L}%, undisclosed`); }
        if (fell(prev.E, E)) {
          s.eFalls += 1;
          const dAll = Math.round((prev.E! - (E ?? 0)) * 10) / 10;
          if (dAll > s.eFallMax.d) s.eFallMax = { d: dAll, at: `${c.label} ${basis} ${h - 1} → ${h} h` };
          if (!prev.bound) {
            const d = prev.E! - (E ?? 0);
            if (d > 5) s.eFallsNonBoundGt5 += 1;
            s.eFallMaxNonBound = Math.max(s.eFallMaxNonBound, Math.round(d * 10) / 10);
          }
        }
        if (fell(prev.buy, r.buy)) {
          s.buyFalls += 1;
          const dBuy = Math.round((prev.buy! - (r.buy ?? 0)) * 100) / 100;
          if (dBuy > s.buyFallMax.d) s.buyFallMax = { d: dBuy, at: `${c.label} ${basis} ${h - 1} → ${h} h` };
        }
        if (prev.reason === 'closeUnder' && !r.sf) s.closeUnderVanish += 1;
      }
      prev = r;
    }
  }
  for (let h = HMIN; h <= HMAX; h++) s.meanBuyQual[h] = qualN[h] ? Math.round((buySum[h] / qualN[h]) * 100) / 100 : null;
  return s;
}

const ZERO = (s: Sweep) => ({
  m1: s.m1, m2: s.m2, m3: s.m3, m4: s.m4, undisclosedUnder: s.undisclosedUnder, carrierRest: s.carrierRest,
  reachOver: s.reachOver, stopUnreached: s.stopUnreached, underFloor: s.underFloor, textMissing: s.textMissing, noForceCharge: s.noForceCharge,
});
const PINNED = (s: Sweep) => ({
  armed: s.armed, carried: s.carried, nearFull: s.nearFull, closeUnder: s.closeUnder, kinds: s.kinds,
  eFalls: s.eFalls, eFallsNonBoundGt5: s.eFallsNonBoundGt5, eFallMaxNonBound: s.eFallMaxNonBound, buyFalls: s.buyFalls,
  closeUnderVanish: s.closeUnderVanish, eFallMax: s.eFallMax, buyFallMax: s.buyFallMax, meanBuyQual: s.meanBuyQual,
});
const ALL_ZERO = { m1: 0, m2: 0, m3: 0, m4: 0, undisclosedUnder: 0, carrierRest: 0, reachOver: 0, stopUnreached: 0, underFloor: 0, textMissing: 0, noForceCharge: 0 };

/** Measured on the landed A5 (emulated, the planner over the year), the live cost gate: what is pinned, not asserted.
 *  `armed` / `carried` — plans with forceChargeLine, and of them those with no envelope cause; `nearFull` / `closeUnder`
 *  — the reasons; `kinds` — lineNotHeldOf over every line-mode plan (closeUnder: the reason's, the near-full lines' under
 *  their walk, and carried nights whose sizing fell short); `eFalls` — h steps whose expected close falls (any amount),
 *  of them `eFallsNonBoundGt5` by more than 5 points after a walk that was not deliverable-bound, the largest such fall
 *  `eFallMaxNonBound` (2027-08-09 21:30, 13 → 14 h on nameplate, 71.8 → 52.9%; 12 → 13 h at 0.944, 77.2 → 57.3%, both
 *  now 'closeUnder'); `eFallMax` — the largest fall after any walk: after a window-bound one, whose stated level was a
 *  cost target the window could not reach, to the line walk's close capped at its reach and floored at the 50% reserve
 *  (2026-11-13 13:00 on nameplate, 15 → 16 h, 90 → 50%, the buy unchanged at 7.2 kWh; 2027-05-28 21:30 at 0.944, 19 → 20 h,
 *  93.8 → 50%, 14.81 kWh both; 13:00 the same); `buyFalls` — steps whose expected buy falls, the largest `buyFallMax`;
 *  `closeUnderVanish` — a 'closeUnder' disclosure gone at
 *  the next hour (its walk rose above the rising line); `meanBuyQual` — the mean expected buy per armed or disclosed plan,
 *  per hour (not monotone: the set grows with h).
 *  v1.202.0 — re-measured. On nameplate (no scale, no standby: v1.201.0's walks) only the cost-carried nights whose walk past
 *  the stop closes under their line move: 17 more 'closeUnder' (carried 4819 → 4802, kinds 777 → 794, a disclosure that
 *  vanishes at the next hour 6 → 11). At 0.944 the walks are on the measured pool too (v1.201.0: armed 5664, carried 5030,
 *  closeUnder 32, kinds 895 / 194 / 209, eFalls 395, eFallsNonBoundGt5 18, eFallMaxNonBound 19.9, buyFalls 138,
 *  closeUnderVanish 4, buyFallMax 9.24 at 2027-01-27 21:30 16 → 17 h). */
const PIN_A5: Record<Basis, ReturnType<typeof PINNED>> = {
  np: {
    armed: 5262, carried: 4802, nearFull: 418, closeUnder: 42, kinds: { closeUnder: 794, aboveFull: 95, nearFull: 175 },
    eFalls: 384, eFallsNonBoundGt5: 29, eFallMaxNonBound: 18.9, buyFalls: 136, closeUnderVanish: 11,
    eFallMax: { d: 40, at: '2026-11-13 13:00 np 15 → 16 h' }, buyFallMax: { d: 9.25, at: '2026-10-13 13:00 np 10 → 11 h' },
    meanBuyQual: { 4: null, 5: 40.35, 6: 29.96, 7: 32.29, 8: 28.89, 9: 30.44, 10: 32.1, 11: 32.09, 12: 32.44, 13: 33.09, 14: 33.23, 15: 34.07, 16: 35.18, 17: 35.87, 18: 36.18, 19: 36.99, 20: 37.66 },
  },
  m: {
    armed: 5687, carried: 5023, nearFull: 602, closeUnder: 62, kinds: { closeUnder: 873, aboveFull: 194, nearFull: 210 },
    eFalls: 484, eFallsNonBoundGt5: 29, eFallMaxNonBound: 19.6, buyFalls: 163, closeUnderVanish: 15,
    eFallMax: { d: 43.8, at: '2027-05-28 21:30 m 19 → 20 h' }, buyFallMax: { d: 8.26, at: '2027-01-27 21:30 m 16 → 17 h' },
    meanBuyQual: { 4: null, 5: 30.41, 6: 27.56, 7: 29.77, 8: 28.8, 9: 31.08, 10: 31.43, 11: 31.35, 12: 31.6, 13: 32.32, 14: 32.88, 15: 33.96, 16: 35.07, 17: 35.29, 18: 36.14, 19: 36.77, 20: 37.01 },
  },
};
/** (T22) Measured on the landed change: window-bound line-mode plans of the year at 4-20 h (the live cost gate), and those
 *  whose stated close is the 50% floor above the window's reach (every one disclosed: T15) — the only ones the spoken
 *  notice says end short. The rest state the capped close, which the window reaches as it closes. */
const PIN_SPOKEN: Record<Basis, { boundLine: number; endsShort: number; mismatch: number }> = {
  np: { boundLine: 919, endsShort: 206, mismatch: 0 },
  m: { boundLine: 962, endsShort: 226, mismatch: 0 }, // v1.202.0 — on the measured pool (v1.201.0: 1037, 224)
};
/** (L1) ARB_COST_MAX_SOC_PCT 100 on the year's cost cases at 90 or more: the start-target falls as a line crosses 90%. */
const PIN_A5_COST100: Record<Basis, { m1: number }> = { np: { m1: 14 }, m: { m1: 19 } };

const swept = new Map<string, Sweep>();
const sweepLive = (basis: Basis): Sweep => {
  if (!swept.has(basis)) swept.set(basis, sweep(basis, liveGate));
  return swept.get(basis)!;
};

for (const basis of ['np', 'm'] as const) {
  test(`★★★ T15 the year at 4-20 h (${basis === 'np' ? 'nameplate' : '×0.944'}), live cost gate: the force-charge never disarms and its target and ceiling never fall as the cushion rises; no carried night closes under its line undisclosed; the stated close within the window's reach`, () => {
    const s = sweepLive(basis);
    assert.deepEqual(ZERO(s), ALL_ZERO, s.ex.join('\n'));
    assert.deepEqual(PINNED(s), PIN_A5[basis]);
  });
  test(`★★ T15 (L1) ARB_COST_MAX_SOC_PCT 100 (${basis === 'np' ? 'nameplate' : '×0.944'}): the ceiling never falls and no line disarms; the start target falls only as a line crosses 90% (pinned)`, () => {
    const s = sweep(basis, (d) => liveGate(cost100(d)));
    const { m1, ...rest } = ZERO(s);
    const { m1: _m1, ...zero } = ALL_ZERO;
    assert.deepEqual(rest, zero, s.ex.join('\n'));
    assert.deepEqual({ m1 }, PIN_A5_COST100[basis]);
  });
  test(`★★ T19 (${basis === 'np' ? 'nameplate' : '×0.944'}) lineNotHeldOf and the card's lineNotHeldOfCard agree with the walk on every plan of the year at 4-20 h`, () => {
    const s = sweepLive(basis);
    assert.deepEqual(s.parity, { checked: CASES.length * (HMAX - HMIN + 1), mismatch: 0 }, s.ex.join('\n'));
  });
  test(`★★ T22 (${basis === 'np' ? 'nameplate' : '×0.944'}) the spoken notice says a window-bound line night ends short of its level only where that level is the 50% floor above the window's reach`, () => {
    const s = sweepLive(basis);
    assert.deepEqual(s.spoken, PIN_SPOKEN[basis], s.ex.join('\n'));
  });
}

/* ══ T17 — the identity ══════════════════════════════════════════════════════════════════════════════ */

type Elig = 'true' | 'false' | 'absent';
type Gate = 'fixture' | 'live';
const ELIG: Record<Elig, boolean | undefined> = { true: true, false: false, absent: undefined };
const GATES: Record<Gate, (d: Deps) => Deps> = { fixture: (d) => d, live: liveGate };

/** A plan A5 must not move (see the header). Plain arithmetic, so the base (962e4668) classifies it alike.
 *  v1.202.0 — a line night the cost force-charge carries is no longer guarded on either side: v1.202.0 walks its drawback past
 *  the stop and discloses a close under the line (measuredPlannerWalks.test.ts pins those nights). */
function guarded(p: Plan, elig: Elig): boolean {
  if (elig !== 'true') return true;
  if (p.forceChargeLine == null) return p.cushionShortfallCause == null || p.cushionEnvelopeReason === 'backupLeg';
  if (p.expectedForceChargeMode !== 'line') return false;
  if (p.cushionShortfallCause != null) return false;
  if (p.expectedDeliverableBound === true) return false;
  return holds(p.expectedWriteLevelPct, p.cushionLineSocPct!);
}

function group(h: number, basis: Basis, gate: Gate, elig: Elig): { n: number; sha: string } {
  const lines: string[] = [];
  for (const c of CASES) {
    const p = planAt(GATES[gate](c.deps), basis, h, ELIG[elig]);
    if (guarded(p, elig)) lines.push(`${c.label}\t${planDigest(p)}`);
  }
  return { n: lines.length, sha: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 20) };
}
const keyOf = (h: number, basis: Basis, gate: Gate, elig: Elig) => `${h}|${basis}|${gate}|${elig}`;
const groupsAt = (hours: number[]) => hours.flatMap((h) => (['np', 'm'] as const).flatMap((basis) => (['fixture', 'live'] as const)
  .flatMap((gate) => (['true', 'false', 'absent'] as const).map((elig) => [h, basis, gate, elig] as const))));
const ALL_HOURS = Array.from({ length: HMAX - HMIN + 1 }, (_, i) => HMIN + i);
/** The suite's sample: 4 h (the live shape) whole, and hours across the range where line nights carry, latch and disclose. */
const SAMPLE_HOURS = [4, 6, 10, 14, 15, 17, 20];

if (process.env.A5_IDENTITY_WRITE === '1') {
  test('T17 (write) the identity fixture — run on the base only', () => {
    const groups: Record<string, { n: number; sha: string }> = {};
    let plans = 0;
    for (const [h, basis, gate, elig] of groupsAt(ALL_HOURS)) {
      const g = group(h, basis, gate, elig);
      groups[keyOf(h, basis, gate, elig)] = g;
      plans += g.n;
    }
    writeFileSync(FIXTURE, `${JSON.stringify({
      generatedOn: process.env.A5_IDENTITY_BASE ?? 'unknown', cases: CASES.length, plans,
      guard: 'eligibility false or absent; at eligibility true: no line ask, the backup disclosure, carried in line mode not deliverable-bound with E >= L - 0.05 (v1.202.0: no cost-mode line night)',
      groups,
    }, null, 1)}\n`);
  });
} else {
  const FX = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { generatedOn: string; cases: number; plans: number; groups: Record<string, { n: number; sha: string }> };
  const full = process.env.A5_IDENTITY_FULL === '1';
  test(`★★★ T17 the identity: every plan A5 must not move is byte-identical to ${FX.generatedOn}; 4 h (the live shape) whole (${full ? 'every hour' : `sample: ${SAMPLE_HOURS.join(', ')} h`})`, () => {
    assert.equal(FX.cases, CASES.length);
    assert.equal(Object.keys(FX.groups).length, ALL_HOURS.length * 12);
    let plans = 0;
    for (const [h, basis, gate, elig] of groupsAt(full ? ALL_HOURS : SAMPLE_HOURS)) {
      const k = keyOf(h, basis, gate, elig);
      const g = group(h, basis, gate, elig);
      assert.deepEqual(g, FX.groups[k], k);
      if (h === 4) assert.equal(g.n, CASES.length, `${k}: the live shape is guarded whole`);
      plans += g.n;
    }
    if (full) assert.equal(plans, FX.plans, 'every guarded plan of every group');
  });
}
