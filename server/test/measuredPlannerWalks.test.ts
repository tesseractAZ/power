import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nca from '../src/nightChargeAdvisor.js';
import {
  computeNightChargePlan, buildNightChargeInputs, askOf, lineNotHeldOf, LINE_CARRY_CLOSE_TOLERANCE_PCT,
  type NightChargeInputs, type NightChargeInputDeps, type NightChargePlan, type CushionPoolScale,
} from '../src/nightChargeAdvisor.js';
import { clampReserveTarget, RESERVE_WRITE_MAX_PCT } from '../src/nightChargeActuator.js';
import { forceChargeModeOf, forceChargeStopPct, forceChargeStartAtMs, FORCE_CHARGE_MIN_RUN_MS, FORCE_CHARGE_LINE_HEADROOM_PCT } from '../src/nightForceCharge.js';
import { heldImportEstimate } from '../src/middayShadow.js';
import { buildNightChargeMessage } from '../src/notify.js';
import * as cardText from '../../web/src/cards/nightChargeText.js';
import { legacyIdentityCases, planDigest } from './fixtures/legacyIdentityFixtures.js';
import {
  FIG_GROUPS, FIG_HOURS, FIG_STANDBY_EXTRA_W, FIG_STANDBY_GROUPS, figKey, figStandbyKey, figGroups, figPlan, figToken, parseToken, stateDeps,
  PLANNER_WALKS_FIGURES_PATH, type FigState, type FigBasis,
} from './fixtures/measuredPlannerWalksFigures.js';

/**
 * v1.202.0 — THE NIGHT-CHARGE PLAN'S WALKS ON THE PACKS' MEASURED CAPACITY, WITH THE CORES' STANDBY.
 *
 * One planning pool at the top of the sizing (nightChargeAdvisor.ts plannerPoolKwh): the panel's nameplate figure × the
 * measured scale, on every basis whose scale is plausible ('measured', 'held', 'min-known'); every walk, clamp and kWh per
 * percent follows from it, and the line is plain reserve + cushion on it (the same percent as v1.201.0's). The walks drain
 * B's one standby figure (plausibleStandbyW) on every discharge leg; B's hiLift rule covers it. Three reads keep the panel's
 * figure: the tick's mirror (tickPoolKwh), the cost room (the morning surplus × pool ÷ panel: v1.201.0's percent) and the
 * plan's record (planPool). And a line night the cost force-charge carries walks its drawback past the stop, disclosed where
 * it closes under the line.
 *
 * In the order of the release's items: T1 the reference plant; T2 applied once; T3 the line; T4 / T4b the fail-safes; T5 the
 * resilience floor of every write and the minimum-buy hold's bound; T6 the cost room's conversion at v1.201.0's percent, and
 * T6b the de-bias's gate at 0, 90 and 336 W (measuredPlannerWalks.figures.json `mainStandby`, frozen on c692f30e); T7 the tick's
 * mirror; T8 the year against v1.201.0 (measuredPlannerWalks.figures.json `main`, frozen on c692f30e); T9 the figures as
 * measured (its `c` part); T10 the shadow's pool; T11 / T11b the legacy band and a disabled cushion, and as their walks'
 * standby rises; T12 the walk standby's monotone set; T13 no line night under its line undisclosed; T14 the cost-carried
 * drawback; T15 the ledger.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = legacyIdentityCases();
const caseOf = (label: string) => {
  const c = CASES.find((x) => x.label === label);
  assert.ok(c, label);
  return c;
};
const S944: CushionPoolScale = { scale: 0.944, basis: 'measured' };
const N = 92.16;
const POOL = Math.round(N * 0.944 * 1000) / 1000; // 86.999
const written = (p: NightChargePlan): number | null => (p.chargeTonight && p.setpointSocPct != null ? clampReserveTarget(p.setpointSocPct) : null);
const yearPlan = (deps: NightChargeInputDeps, o: { scale?: unknown; w?: unknown; st?: FigState; h?: number } = {}): NightChargePlan =>
  computeNightChargePlan(buildNightChargeInputs({
    ...(o.st != null ? stateDeps(deps, o.st) : deps),
    ...(o.h != null ? { outageCushionHours: o.h } : {}),
    ...(o.scale !== undefined ? { cushionPoolScale: o.scale } : {}),
    ...(o.w !== undefined ? { cushionStandbyW: o.w } : {}),
  } as NightChargeInputDeps));
const HOURS = Array.from({ length: 17 }, (_, i) => 4 + i);
const clock = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms - 7 * 3_600_000).toISOString().slice(11, 16));

/* ══ T1 — the reference plant ═══════════════════════════════════════════════════════════════════════════ */

test('★★★ T1 THE REFERENCE PLANT at ×0.944 with 270 W, a write mode: the resilience night writes 34 and sizes 28.50 kWh (26.22 on v1.201.0); the cost night keeps its 80.4% ceiling, 80% stop, 50% write and 02:43 start', () => {
  const at = (label: string) => yearPlan(caseOf(label).deps, { scale: S944, w: 270, st: 'write' });
  const r = at('2026-10-12 resilience');
  assert.deepEqual(r.planPool, { kwh: POOL, standbyW: 270 }, 'the pool and the standby the walks counted');
  assert.deepEqual([r.cushionLineSocPct, written(r)], [33.26, 34], 'the line and the write: v1.201.0\'s');
  // The walks: the requirement and the worst case on the measured pool, the drain to the window open with the standby.
  assert.deepEqual([r.requiredExtraKwh, r.buyKwh], [26.42, 28.5], 'v1.201.0: 24.30 and 26.22 kWh');
  assert.deepEqual([r.expectedStartSocPct, r.preWindowMinSocPct], [43.7, 14.6], 'v1.201.0: 44.9 and 17.6%');
  assert.ok(r.rationale.includes('(P10 PV, P90 load including any committed EV session and the Cores\' ~270 W standby, no grid) of ~28.5 kWh'), r.rationale);
  assert.ok(r.rationale.includes('with the grid present (median load, PV and the Cores\' standby, never below the 16% reserve)'), r.rationale);
  assert.ok(r.rationale.includes('With the grid present the SHP2 defends the 16% reserve, so the pool should hold ~16%'), 'the dip under the reserve is now stated as the worst case it is');
  const c = at('2026-10-12 cost');
  assert.deepEqual([c.costCeilingSocPct, forceChargeStopPct(c.costCeilingSocPct!), written(c)], [80.4, 80, 50], 'the cost ceiling, its stop and the write: v1.201.0\'s');
  assert.equal(clock(c.expectedForceChargeStartMs), '02:43');
  assert.deepEqual([c.expectedBuyKwh, c.buyKwh], [34.1, 63.51], 'v1.201.0: 34.88 and 63.92 kWh');
  assert.match(c.rationale, /^Charge to ~80% in the 00:00–05:00 window: ~34\.1 kWh expected\./);
  const s = at('2026-09-29 sunny 60%');
  assert.deepEqual([s.costCeilingSocPct, written(s), clock(s.expectedForceChargeStartMs)], [77.7, 50, '02:54']);
  const r30 = at('2026-09-29 resilience 30%');
  assert.deepEqual([written(r30), r30.buyKwh, r30.expectedBuyKwh], [34, 23.66, 9.01], 'v1.201.0: 34, 22.59, 8.80');
});

/* ══ T2 — applied once ══════════════════════════════════════════════════════════════════════════════════ */

/** The plan on the panel's figure N with the scale s, against the plan on a pool of N · s with no scale and every morning
 *  surplus × s (the cost room's own conversion): the same plan wherever no force-charge leg is walked (the tick's mirror
 *  is the panel's figure, N against N · s, and is held by T7). */
const scaledSurplus = (d: NightChargeInputDeps, s: number): NightChargeInputDeps => {
  const x = d as NightChargeInputDeps & Record<string, unknown>;
  const m = (v: unknown) => (typeof v === 'number' ? v * s : v);
  const load = x.costSurplusLoad as { p50Kwh?: number | null; p90Kwh?: number | null } | null | undefined;
  return {
    ...d, fullKwh: d.fullKwh * s,
    ...('morningPvSurplusP90Kwh' in x ? { morningPvSurplusP90Kwh: m(x.morningPvSurplusP90Kwh) } : {}),
    ...('morningPvSurplusP50Kwh' in x ? { morningPvSurplusP50Kwh: m(x.morningPvSurplusP50Kwh) } : {}),
    ...('prePeakPvSurplusP10Kwh' in x ? { prePeakPvSurplusP10Kwh: m(x.prePeakPvSurplusP10Kwh) } : {}),
    ...(load != null ? { costSurplusLoad: { ...load, p50Kwh: m(load.p50Kwh), p90Kwh: m(load.p90Kwh) } } : {}),
  } as NightChargeInputDeps;
};
const T2_FIELDS = ['chargeTonight', 'buyKwh', 'requiredExtraKwh', 'targetSocPct', 'setpointSocPct', 'cushionLineSocPct', 'cushionTroughSocPct',
  'costCeilingSocPct', 'bindingCap', 'cushionShortfall', 'expectedStartSocPct', 'minProjSocPct', 'baselineMinSocPct', 'preWindowMinSocPct'] as const;

test('★★★ T2 APPLIED ONCE — on the year (the fixture\'s state, every hour 4-20, 270 W) the plan at ×0.944 is the plan on a pool of N × 0.944, surplus for surplus', () => {
  // A morning surplus is not in the walks: the ledger's surplus columns state the energy as given, so they are not compared.
  let plans = 0;
  const differ: string[] = [];
  for (const h of [4, 8, 12, 16, 20]) for (const c of CASES) {
    const deps = { ...c.deps, outageCushionHours: h, cushionStandbyW: 270 } as NightChargeInputDeps;
    if (!(Number.isFinite(deps.fullKwh) && deps.fullKwh > 0)) continue;
    const p = yearPlan(deps, { scale: S944 });
    const q = yearPlan(scaledSurplus(deps, 0.944));
    plans += 1;
    for (const f of T2_FIELDS) if (JSON.stringify(p[f] ?? null) !== JSON.stringify(q[f] ?? null)) differ.push(`${c.label} ${h} h ${f}: ${p[f]} vs ${q[f]}`);
    if (p.expectedForceChargeStartMs === undefined && q.expectedForceChargeStartMs === undefined) {
      for (const f of ['expectedBuyKwh', 'expectedWriteLevelPct'] as const) {
        if (JSON.stringify(p[f] ?? null) !== JSON.stringify(q[f] ?? null)) differ.push(`${c.label} ${h} h ${f}: ${p[f]} vs ${q[f]}`);
      }
    }
  }
  assert.ok(plans >= 5000, `${plans} plans`);
  assert.deepEqual(differ.slice(0, 8), [], `${differ.length} figures differ`);
  // And where the clamp at the pool's top binds: the legacy band's whole-house walk (its setpoint's arm test) on a sunny
  // day, P10 PV of 12-30 kW from 09:00 to 15:00, fills the pool before the evening trough. On the year the clamp moves no setpoint (measured at ×0.944 and ×0.8, 4-20 h).
  const sunny: string[] = [];
  let sunnyPlans = 0;
  const hourOf = (ms: number): number => new Date(ms - 7 * 3_600_000).getUTCHours();
  for (const c of CASES) {
    if (yearPlan(c.deps).cushionBasis !== 'legacy-pct') continue;
    for (const pv of [12_000, 20_000, 30_000]) {
      const d = c.deps as NightChargeInputDeps & { bandHours: Array<{ ts: number; pvP10W: number; pvP50W?: number }> };
      const deps = { ...d, cushionStandbyW: 270, bandHours: d.bandHours.map((x) => (hourOf(x.ts) >= 9 && hourOf(x.ts) <= 15 ? { ...x, pvP10W: pv, pvP50W: Math.max(pv, x.pvP50W ?? 0) } : x)) } as NightChargeInputDeps;
      const p = yearPlan(deps, { scale: S944 });
      const q = yearPlan(scaledSurplus(deps, 0.944));
      sunnyPlans += 1;
      for (const f of T2_FIELDS) if (JSON.stringify(p[f] ?? null) !== JSON.stringify(q[f] ?? null)) sunny.push(`${c.label} ${pv} W ${f}: ${p[f]} vs ${q[f]}`);
    }
  }
  assert.ok(sunnyPlans >= 400, `${sunnyPlans} sunny plans`);
  assert.deepEqual(sunny.slice(0, 8), [], `${sunny.length} sunny figures differ`);
});

/* ══ T3 — the line ══════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ T3 (pin) THE LINE is v1.201.0\'s percent on every plan of the year: floor + 100 · cushion ÷ (N · s) on an islanded-outage row, floor + band on the legacy band; the ask is ⌈line⌉', () => {
  let n = 0;
  for (const s of [0.944, 0.9, 0.8]) for (const h of [4, 8, 12, 16, 20]) for (const c of CASES) {
    const p = yearPlan(c.deps, { scale: { scale: s, basis: 'measured' }, w: 270, st: 'write', h });
    if (p.cushionLineSocPct == null) continue;
    n += 1;
    const want = p.cushionBasis === 'islanded-outage' ? p.reserveFloorPct + (100 * p.cushionKwh!) / (c.deps.fullKwh * s)
      : p.cushionBasis === 'legacy-pct' ? p.reserveFloorPct + p.cushionPct : p.reserveFloorPct;
    assert.ok(Math.abs(p.cushionLineSocPct - want) <= 0.0051, `${c.label} ${s} ${h} h: line ${p.cushionLineSocPct} vs ${want}`);
    // The ask is ⌈the unrounded line⌉ (askOf): within the line's own 0.005 of rounding of ⌈the stated line⌉.
    if (p.forceChargeLine != null) {
      const a = p.forceChargeLine.askPct;
      assert.ok([askOf(((p.cushionLineSocPct - 0.005) / 100) * POOL, POOL), askOf(((p.cushionLineSocPct + 0.005) / 100) * POOL, POOL)].includes(a), `${c.label}: the ask ${a} for ${p.cushionLineSocPct}`);
    }
  }
  assert.ok(n > 12_000, `${n} lines`);
});

/* ══ T4 — the fail-safes ════════════════════════════════════════════════════════════════════════════════ */

const GOLDEN = JSON.parse(readFileSync(resolve(HERE, 'fixtures/legacyIdentity.golden.json'), 'utf8')) as { digests: Record<string, string> };
const withoutScale = (p: NightChargePlan): string => {
  const { cushionPoolScale: _s, ...rest } = p;
  return planDigest(rest as NightChargePlan);
};

test('★★★ T4 (pin) FAIL-SAFE — no scale, one that is no reading, or a unit scale, with no standby: the golden plan byte for byte (the key aside), and no planPool', () => {
  for (const c of CASES) {
    for (const sc of [undefined, null, { scale: Number.NaN, basis: 'measured' }, { scale: Number.POSITIVE_INFINITY, basis: 'measured' },
      { scale: Number.NEGATIVE_INFINITY, basis: 'measured' }, { scale: -1, basis: 'measured' }, { scale: 0.3, basis: 'measured' },
      { scale: 1.2, basis: 'measured' }, { scale: 1, basis: 'nameplate' }, { scale: 1, basis: 'measured' }, { scale: '0.9', basis: 'measured' }]) {
      const p = yearPlan(c.deps, { scale: sc });
      assert.equal(sc == null ? planDigest(p) : withoutScale(p), GOLDEN.digests[c.label], `${c.label} ${JSON.stringify(sc)}`);
      assert.equal('planPool' in p, false, `${c.label} ${JSON.stringify(sc)}: no planPool`);
      // The key, too, is v1.201.0's: only an islanded-outage line records a unit or ignored scale.
      if (sc != null && p.cushionBasis !== 'islanded-outage') assert.equal('cushionPoolScale' in p, false, `${c.label} ${JSON.stringify(sc)}: no key`);
    }
  }
});

test('★★★ T4 every basis whose scale is plausible walks at its own scale: held and min-known are the measured plan at the same scale, the key\'s basis aside', () => {
  for (const h of [4, 12]) for (const c of CASES) {
    for (const s of [0.92, 0.9]) {
      const m = yearPlan(c.deps, { scale: { scale: s, basis: 'measured' }, w: 270, st: 'write', h });
      for (const basis of ['held', 'min-known'] as const) {
        const p = yearPlan(c.deps, { scale: { scale: s, basis }, w: 270, st: 'write', h });
        assert.equal(withoutScale(p), withoutScale(m), `${c.label} ${h} h ${basis} ${s}`);
        if (m.planPool != null) assert.deepEqual(p.cushionPoolScale, { scale: s, basis });
      }
    }
  }
  // The walks move on a substitute: the pool and the requirement are the scale's, not nameplate's.
  const r = yearPlan(caseOf('2026-10-12 resilience').deps, { scale: { scale: 0.92, basis: 'held' }, w: 270, st: 'write' });
  assert.deepEqual(r.planPool, { kwh: Math.round(N * 0.92 * 1000) / 1000, standbyW: 270 });
  assert.deepEqual(r.cushionPoolScale, { scale: 0.92, basis: 'held' });
});

test('★★★ T4b THE WALK STANDBY\'S FAIL-SAFE — a figure that is no reading (NaN, −1, above 1500 W, not a number) walks at 0 W: the 0 W plan, the standby key aside', () => {
  const noKey = (p: NightChargePlan): string => {
    const { cushionStandby: _s, ...rest } = p as NightChargePlan & { cushionStandby?: unknown };
    return planDigest(rest as NightChargePlan);
  };
  for (const h of [4, 12]) for (const c of CASES) for (const sc of [undefined, S944]) {
    const zero = yearPlan(c.deps, { scale: sc, w: 0, st: 'write', h });
    for (const w of [Number.NaN, -1, 2000, '270']) {
      const p = yearPlan(c.deps, { scale: sc, w, st: 'write', h });
      assert.equal(noKey(p), noKey(zero), `${c.label} ${h} h ${String(w)}`);
      assert.equal(p.planPool?.standbyW ?? 0, 0);
    }
    if (sc == null) assert.equal(noKey(zero), noKey(yearPlan(c.deps, { st: 'write', h })), `${c.label}: 0 W is no figure`);
  }
});

/* ══ T5 — the resilience floor of every write; the minimum-buy hold ════════════════════════════════════ */

test('★★★ T5 THE RESILIENCE FLOOR OF EVERY WRITE at s ∈ {1, 0.97, 0.944, 0.9, 0.8}: an islanded or disabled charge night writes at least min(50, ⌈line⌉); a hold with a requirement is the window that cannot serve it (disclosed) or a minimum-buy hold within minBuy · legEff of the line', () => {
  let n = 0, starved = 0, minBuyHolds = 0, maxGapPts = 0;
  for (const s of [1, 0.97, 0.944, 0.9, 0.8]) for (const h of [4, 8, 12, 16, 20]) for (const c of CASES) {
    const deps = { ...stateDeps(c.deps, 'write'), outageCushionHours: h, cushionStandbyW: 270, cushionPoolScale: { scale: s, basis: 'measured' } } as NightChargeInputDeps;
    const p = computeNightChargePlan(buildNightChargeInputs(deps));
    if (p.cushionLineSocPct == null || (p.cushionBasis !== 'islanded-outage' && p.cushionBasis !== 'disabled')) continue;
    if (p.chargeTonight) {
      n += 1;
      assert.ok(written(p)! >= Math.min(RESERVE_WRITE_MAX_PCT, Math.ceil(p.cushionLineSocPct - 1e-9)), `${c.label} ${s} ${h} h: line ${p.cushionLineSocPct}, written ${written(p)}`);
    } else if ((p.requiredExtraKwh ?? 0) > 0 && p.cushionBasis === 'islanded-outage') {
      if (p.cushionShortfall) {
        // The window cannot serve the need: disclosed, and said so.
        starved += 1;
        assert.match(p.rationale, /The window cannot serve the need|charge\/pool caps prevent fully meeting the cushion/, `${c.label} ${s} ${h} h`);
        continue;
      }
      // F2 — a minimum-buy hold. The pack at the close rises by at most what the lift adds, so its no-buy pack is under
      // the line by at most the requirement: under minBuy · legEff (the buy is under the minimum), i.e. that many points of
      // the planning pool.
      minBuyHolds += 1;
      const inputs = buildNightChargeInputs(deps);
      const pool = p.planPool?.kwh ?? inputs.fullKwh;
      assert.ok(p.requiredExtraKwh! <= inputs.minBuyKwh * inputs.legEff + 0.005, `${c.label} ${s} ${h} h: ${p.requiredExtraKwh} kWh, a minimum buy of ${inputs.minBuyKwh}`);
      assert.match(p.rationale, /under the [\d.]+ kWh minimum-buy threshold — the projected need is genuinely small/, `${c.label}: a minimum-buy hold says so`);
      maxGapPts = Math.max(maxGapPts, (p.requiredExtraKwh! / pool) * 100);
    }
  }
  assert.ok(n > 15_000, `${n} charge nights`);
  assert.deepEqual({ starved, minBuyHolds, maxGapPts: Math.round(maxGapPts * 1000) / 1000 }, PIN_T5_MINBUY);
  assert.ok(PIN_T5_MINBUY.maxGapPts < ((1 * Math.sqrt(0.86)) / (N * 0.8)) * 100, 'under the bound at the smallest pool swept');
});
/** Measured (v1.202.0): the year's islanded holds with a requirement at the five scales and five hours — those the window
 *  cannot serve (disclosed) and the minimum-buy holds — and the largest requirement of a minimum-buy hold in points of its
 *  pool (the bound at a 1 kWh minimum buy is about 1.07 points on the measured pool, 1.26 at ×0.8). */
const PIN_T5_MINBUY = { starved: 0, minBuyHolds: 85, maxGapPts: 1.194 };

/* ══ T6 / T6b — the cost room's conversion at v1.201.0's percent; the de-bias's gate at other standby figures ══════════ */

const FIG = JSON.parse(readFileSync(PLANNER_WALKS_FIGURES_PATH, 'utf8')) as {
  cases: number; main: { generatedAt: string; groups: Record<string, string> }; c: { generatedAt: string; groups: Record<string, string> };
  mainStandby: { generatedAt: string; groups: Record<string, string> };
};
/** The groups as this tree plans them, computed once for T6, T8 and T9. */
let nowGroups: Record<string, string> | null = null;
const groupsNow = (): Record<string, string> => (nowGroups ??= figGroups());
/** The cost stops that fall against v1.201.0 in the figures' groups: each a night v1.201.0's walks disclosed short of its
 *  line (so its de-bias kept the raw surplus) that the walks on the measured pool hold, so the de-bias v1.201.0 applies to
 *  every night that holds its line applies — never the room itself (the de-biased headroom is wider than the raw one). */
const PIN_T6_STOP_FALLS = [
  'write|m|8 2027-02-10 +1 01:30', 'write|held|8 2027-02-10 +1 01:30', 'write|held|8 2027-05-28 21:30', 'write|held|12 2026-11-30 +1 01:30',
  'write|mk|12 2026-11-30 +1 01:30', 'fixture|m|8 2027-02-10 +1 01:30',
];

/** Measured against c692f30e over 4-20 h in a write mode with 270 W: the cost writes the same gate lowers, all on a
 *  substitute scale (v1.201.0's writes 50, 50, 45). */
const PIN_T6_WRITE_FALLS: ReadonlyArray<{ label: string; h: number; basis: CushionPoolScale['basis']; scale: number; written: number }> = [
  { label: '2026-10-13 +1 01:30', h: 6, basis: 'held', scale: 0.92, written: 43 },
  { label: '2026-10-13 +1 01:30', h: 6, basis: 'min-known', scale: 0.9, written: 44 },
  { label: '2027-07-12 +1 01:30', h: 7, basis: 'min-known', scale: 0.9, written: 43 },
];

test('★★★ T6 THE COST ROOM\'S CONVERSION IS v1.201.0\'s: COST55\'s 40.3% and the reference plant\'s 80.4% ceilings; against v1.201.0 in its figures no cost write falls, and every stop that does is the de-bias\'s gate (pinned), as are the substitute scales\' three cost write falls; every cost write at or above ⌈line⌉', () => {
  const i = (o: Partial<NightChargeInputs> = {}): NightChargeInputs => ({
    nowMs: Date.UTC(2026, 9, 20, 4), fullKwh: N, socNowPct: 25, reserveFloorPct: 10, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 1.445, outageCushionHours: 8, islandedLoadSafety: 1.5, legEff: 0.927, dischargeEff: 0.92, chargeCapKw: 10, gridInputCapKw: null,
    window: { startMs: Date.UTC(2026, 9, 20, 6), endMs: Date.UTC(2026, 9, 20, 12) },
    horizon: Array.from({ length: 30 }, (_, k) => ({ ts: Date.UTC(2026, 9, 20, 4) + k * 3_600_000, pvP10W: 0, loadP90W: 3600, loadP50W: 3600 / 1.35, pvP50W: 0 })),
    morningPvSurplusP90Kwh: 70, morningPvSurplusP50Kwh: 55, confidenceTier: 'forecast', basisComplete: true, minBuyKwh: 1,
    objectiveMode: 'cost', costMaxSocPct: 90, forceChargeEligible: true, ...o,
  } as NightChargeInputs);
  for (const sc of [undefined, S944, { scale: 0.8, basis: 'held' } as CushionPoolScale]) {
    for (const w of [undefined, 270]) {
      const p = computeNightChargePlan(i({ ...(sc ? { cushionPoolScale: sc } : {}), ...(w != null ? { cushionStandbyW: w } : {}) }));
      assert.deepEqual([p.costCeilingSocPct, p.costCeilingSurplusKwh], [40.3, 55], `${JSON.stringify(sc)} ${w}: 100 − 100 · 55 ÷ 92.16, the surplus as given`);
    }
  }
  assert.equal(FIG.cases, CASES.length);
  const falls: string[] = [];
  let costWrites = 0;
  for (const [st, b] of FIG_GROUPS) for (const h of FIG_HOURS) {
    const k = figKey(st, b, h);
    const mainT = FIG.main.groups[k].split(','), cT = groupsNow()[k].split(',');
    CASES.forEach((c, idx) => {
      const x = parseToken(mainT[idx]), y = parseToken(cT[idx]);
      if (x.charge && y.charge) assert.ok(y.written! >= x.written!, `${k} ${c.label}: write ${x.written} → ${y.written}`);
      assert.ok(!(x.charge && !y.charge), `${k} ${c.label}: a charge night held`);
      if (x.stop != null && y.stop != null && y.stop < x.stop - 1e-9) {
        falls.push(`${k} ${c.label}`);
        const p = figPlan(c.deps, st, b, h);
        assert.ok(p.costCeilingSurplusKwh! > p.costCeilingSurplusRawKwh! + 0.005 && !p.cushionShortfall, `${k} ${c.label}: a stop fall is the de-bias applied on a night that holds its line`);
      }
      if (y.stop != null && y.written != null) {
        costWrites += 1;
        const p = figPlan(c.deps, st, b, h);
        assert.ok(y.written >= Math.min(RESERVE_WRITE_MAX_PCT, Math.ceil(p.cushionLineSocPct! - 1e-9)), `${k} ${c.label}: a cost write under ⌈line⌉`);
      }
    });
  }
  assert.ok(costWrites > 1000, `${costWrites} cost writes`);
  assert.deepEqual(falls, PIN_T6_STOP_FALLS);
  // The same gate between the figures' hours: on a held or lowest-known scale it lowers three cost writes of the 4-20 h
  // year (none at ×0.944 measured, none of a resilience night), each to ⌈line⌉. v1.201.0's writes, measured on c692f30e
  // in a write mode with 270 W: 50, 50 and 45.
  for (const f of PIN_T6_WRITE_FALLS) {
    const p = yearPlan(caseOf(f.label).deps, { scale: { scale: f.scale, basis: f.basis }, w: 270, st: 'write', h: f.h });
    const at = `${f.label} ${f.h} h ${f.basis}`;
    assert.equal(p.objective, 'cost_arbitrage', at);
    assert.equal(written(p), f.written, at);
    assert.equal(written(p), Math.ceil(p.cushionLineSocPct! - 1e-9), `${at}: the write is ⌈line⌉`);
    assert.ok(!p.cushionShortfall && p.costCeilingSurplusKwh! > p.costCeilingSurplusRawKwh! + 0.005, `${at}: the de-bias applied on a night that holds its line`);
  }
});

/** Measured against c692f30e (v1.201.0) in a write mode over 4-20 h at 0, 90 and 336 W (270 W is T6's), on every plausible
 *  basis: every cost stop and cost write that falls, v1.201.0's value (`was`) and v1.202.0's (`is`), and (`line`) every cost
 *  stop the lowered ceiling hands to the line force-charge (the ceiling's stop now within 10 points of the line's ask: the
 *  night is carried in line mode to the window close; `is` is that ceiling's stop); (`start`) on a night the line
 *  force-charge already carried, the start target its lower ceiling lowers (the larger of the ceiling and ⌈L⌉ + 5 on a
 *  line more than 10 points under full: `was` and `is` are the start targets); and (`ceiling`) every other cost ceiling
 *  that falls, where nothing the night does moves (the force-charge, or none, as at v1.201.0's ceiling; `was` and `is` are
 *  the ceilings). Each is the de-bias's gate — a night v1.201.0's walks sized short of its line, so its de-bias kept the
 *  raw surplus, whose sizing on the pool and the standby holds it — none of a resilience night, none on nameplate, no
 *  charge night held. */
type GateFall = { label: string; h: number; basis: CushionPoolScale['basis']; scale: number; w: number; kind: 'stop' | 'write' | 'line' | 'start' | 'ceiling'; was: number; is: number };
const PIN_T6B_FALLS: ReadonlyArray<GateFall> = [
  { label: '2027-05-28 21:30', h: 9, basis: 'measured', scale: 0.944, w: 0, kind: 'stop', was: 93.8, is: 93.5 },
  { label: '2027-07-12 13:00', h: 10, basis: 'measured', scale: 0.944, w: 0, kind: 'stop', was: 60, is: 58.5 },
  { label: '2027-05-07 21:30', h: 12, basis: 'measured', scale: 0.944, w: 90, kind: 'line', was: 73.8, is: 68.2 },
  { label: '2027-07-23 21:30', h: 18, basis: 'measured', scale: 0.944, w: 90, kind: 'start', was: 73.8, is: 73 },
  { label: '2026-11-30 +1 01:30', h: 14, basis: 'measured', scale: 0.944, w: 0, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2027-07-12 +1 01:30', h: 8, basis: 'measured', scale: 0.944, w: 90, kind: 'write', was: 45, is: 44 },
  { label: '2026-10-13 +1 01:30', h: 6, basis: 'measured', scale: 0.944, w: 336, kind: 'write', was: 50, is: 43 },
  { label: '2027-05-28 21:30', h: 8, basis: 'measured', scale: 0.944, w: 336, kind: 'stop', was: 93.8, is: 93.5 },
  { label: '2026-11-30 +1 01:30', h: 12, basis: 'measured', scale: 0.944, w: 336, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2027-03-19 21:30', h: 7, basis: 'held', scale: 0.92, w: 0, kind: 'stop', was: 61.5, is: 53.1 },
  { label: '2026-10-13 13:00', h: 10, basis: 'held', scale: 0.92, w: 0, kind: 'line', was: 70.7, is: 62.4 },
  { label: '2027-03-21 13:00', h: 9, basis: 'held', scale: 0.92, w: 0, kind: 'start', was: 68.6, is: 66 },
  { label: '2027-07-12 +1 01:30', h: 8, basis: 'held', scale: 0.92, w: 0, kind: 'write', was: 45, is: 44 },
  { label: '2026-11-30 +1 01:30', h: 14, basis: 'held', scale: 0.92, w: 0, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2027-07-12 +1 01:30', h: 8, basis: 'held', scale: 0.92, w: 90, kind: 'write', was: 45, is: 44 },
  { label: '2026-11-30 +1 01:30', h: 13, basis: 'held', scale: 0.92, w: 90, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2026-11-30 +1 01:30', h: 14, basis: 'held', scale: 0.92, w: 90, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2027-02-05 21:30', h: 19, basis: 'held', scale: 0.92, w: 90, kind: 'stop', was: 89, is: 87 },
  { label: '2027-07-12 +1 01:30', h: 7, basis: 'held', scale: 0.92, w: 336, kind: 'write', was: 45, is: 43 },
  { label: '2026-11-30 +1 01:30', h: 12, basis: 'held', scale: 0.92, w: 336, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2027-02-05 21:30', h: 17, basis: 'held', scale: 0.92, w: 336, kind: 'stop', was: 89, is: 87 },
  { label: '2027-07-12 +1 01:30', h: 8, basis: 'min-known', scale: 0.9, w: 0, kind: 'write', was: 45, is: 44 },
  { label: '2027-05-07 21:30', h: 12, basis: 'min-known', scale: 0.9, w: 0, kind: 'line', was: 73.8, is: 68.2 },
  { label: '2027-03-21 13:00', h: 9, basis: 'min-known', scale: 0.9, w: 0, kind: 'start', was: 68.6, is: 67 },
  { label: '2027-07-23 21:30', h: 18, basis: 'min-known', scale: 0.9, w: 0, kind: 'ceiling', was: 73.8, is: 68 },
  { label: '2027-07-12 +1 01:30', h: 8, basis: 'min-known', scale: 0.9, w: 90, kind: 'ceiling', was: 45, is: 44.5 },
  { label: '2026-11-30 +1 01:30', h: 13, basis: 'min-known', scale: 0.9, w: 0, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2026-11-30 +1 01:30', h: 14, basis: 'min-known', scale: 0.9, w: 0, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2027-02-10 +1 01:30', h: 8, basis: 'min-known', scale: 0.9, w: 90, kind: 'stop', was: 80, is: 76.6 },
  { label: '2027-02-19 21:30', h: 10, basis: 'min-known', scale: 0.9, w: 90, kind: 'stop', was: 82.9, is: 81.8 },
  { label: '2026-11-30 +1 01:30', h: 13, basis: 'min-known', scale: 0.9, w: 90, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2026-11-30 +1 01:30', h: 14, basis: 'min-known', scale: 0.9, w: 90, kind: 'stop', was: 75.9, is: 75.5 },
  { label: '2027-07-12 +1 01:30', h: 7, basis: 'min-known', scale: 0.9, w: 336, kind: 'write', was: 45, is: 44 },
  { label: '2026-11-30 +1 01:30', h: 12, basis: 'min-known', scale: 0.9, w: 336, kind: 'stop', was: 75.9, is: 75.5 },
];
const costStopOf = (p: NightChargePlan, deps: NightChargeInputDeps): number | null => parseToken(figToken(p, deps)).stop;
/** The sizing held the line: no shortfall, or only the envelope's (the line walk's disclosure, OR-ed in after the cost block;
 *  the de-bias reads the sized flag alone). */
const sizingHeld = (p: NightChargePlan): boolean => !p.cushionShortfall || p.cushionShortfallCause === 'envelope';

test('★★★ T6b THE DE-BIAS\'S GATE AT 0, 90 AND 336 W: against v1.201.0 at ×0.944 in its figures (the frozen `mainStandby`) no resilience write falls and no charge night holds, and every cost write or stop that falls, or that a lowered ceiling hands to the line force-charge, is pinned, as are the ceilings that fall beside them (a line night\'s start target, or nothing the night does); over 4-20 h on every plausible basis each pinned fall is the gate, a write to ⌈line⌉ and a stop at or above it; every cost write at or above min(50, ⌈line⌉) and every de-biased ceiling of a night whose sizing holds its line at or above it', () => {
  assert.equal(FIG.mainStandby.generatedAt.startsWith('c692f30e'), true);
  // The frozen figures' hours at ×0.944: the falls there are exactly the pinned ones.
  const atHours: string[] = [];
  let groups = 0;
  for (const [st, b] of FIG_STANDBY_GROUPS) for (const w of FIG_STANDBY_EXTRA_W) for (const h of FIG_HOURS) {
    const k = figStandbyKey(st, b, h, w);
    const mainT = FIG.mainStandby.groups[k].split(',');
    assert.equal(mainT.length, CASES.length, k);
    groups += 1;
    CASES.forEach((c, idx) => {
      const p = figPlan(c.deps, st, b, h, w);
      const x = parseToken(mainT[idx]), y = parseToken(figToken(p, stateDeps(c.deps, st)));
      assert.ok(!(x.charge && !y.charge), `${k} ${c.label}: a charge night held`);
      if (x.charge && y.charge && y.written! < x.written!) {
        assert.equal(p.objective, 'cost_arbitrage', `${k} ${c.label}: a resilience write fell ${x.written} → ${y.written}`);
        atHours.push(`${c.label}|${h}|${w}|write|${x.written}|${y.written}`);
      }
      if (x.stop != null && y.stop != null && y.stop < x.stop - 1e-9) atHours.push(`${c.label}|${h}|${w}|stop|${x.stop}|${y.stop}`);
      // A cost stop gone while the write stands: handed to the line force-charge. A fall where the ceiling's own stop is lower.
      if (x.stop != null && y.charge && y.stop == null && y.written === x.written && p.costCeilingSocPct != null) {
        const s = forceChargeStopPct(p.costCeilingSocPct);
        if (s < x.stop - 1e-9) {
          assert.equal(p.expectedForceChargeMode, 'line', `${k} ${c.label}: a cost stop gone with no line force-charge`);
          atHours.push(`${c.label}|${h}|${w}|line|${x.stop}|${s}`);
        }
      }
    });
  }
  assert.equal(groups, 15);
  const pinnedAtHours = PIN_T6B_FALLS.filter((f) => f.basis === 'measured' && (FIG_HOURS as readonly number[]).includes(f.h))
    .map((f) => `${f.label}|${f.h}|${f.w}|${f.kind}|${f.was}|${f.is}`);
  assert.deepEqual(atHours.sort(), pinnedAtHours.sort());
  // Every pinned fall, between the hours and on the substitute scales: the gate, a write at ⌈line⌉, a stop at or above it.
  for (const f of PIN_T6B_FALLS) {
    const deps = { ...stateDeps(caseOf(f.label).deps, 'write'), outageCushionHours: f.h, cushionStandbyW: f.w, cushionPoolScale: { scale: f.scale, basis: f.basis } } as NightChargeInputDeps;
    const p = computeNightChargePlan(buildNightChargeInputs(deps));
    const at = `${f.label} ${f.h} h ${f.basis} ${f.w} W`;
    const ceilL = Math.ceil(p.cushionLineSocPct! - 1e-9);
    assert.equal(p.objective, 'cost_arbitrage', at);
    assert.ok(sizingHeld(p) && p.costCeilingSurplusKwh! > p.costCeilingSurplusRawKwh! + 0.005, `${at}: the de-bias applied on a night whose sizing holds its line`);
    if (f.kind === 'write') {
      assert.equal(written(p), f.is, at);
      assert.equal(written(p), ceilL, `${at}: the write is ⌈line⌉`);
    } else if (f.kind === 'ceiling' || f.kind === 'start') {
      const ask = p.forceChargeLine?.askPct ?? null;
      const modeAt = (c: number) => {
        const m = forceChargeModeOf({ forceChargeCeilingPct: c, forceChargeLineAskPct: ask } as never, { cost: true, line: true });
        return m == null ? null : m.kind === 'line' ? ['line', m.startTargetPct, m.panelCeilingPct] : ['cost', forceChargeStopPct(m.targetPct)];
      };
      const now = modeAt(p.costCeilingSocPct!);
      assert.notEqual(now?.[0], 'cost', `${at}: a cost stop moved`);
      assert.ok(p.costCeilingSocPct! >= p.cushionLineSocPct! - LINE_CARRY_CLOSE_TOLERANCE_PCT - 1e-9, `${at}: the ceiling ${p.costCeilingSocPct} under the ${p.cushionLineSocPct}% line`);
      if (f.kind === 'ceiling') {
        assert.equal(p.costCeilingSocPct, f.is, at);
        assert.deepEqual(now, modeAt(f.was), `${at}: the force-charge as at v1.201.0's ${f.was}% ceiling`);
      } else {
        assert.deepEqual([p.expectedForceChargeMode, now?.[0], now?.[1]], ['line', 'line', f.is], `${at}: the line walk's start target`);
        assert.ok(f.is >= ceilL + FORCE_CHARGE_LINE_HEADROOM_PCT, `${at}: the start target ${f.is} under ⌈${p.cushionLineSocPct}⌉ + ${FORCE_CHARGE_LINE_HEADROOM_PCT}`);
      }
    } else if (f.kind === 'line') {
      assert.equal(p.expectedForceChargeMode, 'line', `${at}: carried in line mode`);
      assert.equal(costStopOf(p, stateDeps(caseOf(f.label).deps, 'write')), null, at);
      assert.equal(forceChargeStopPct(p.costCeilingSocPct!), f.is, at);
      assert.ok(f.is >= ceilL, `${at}: the ceiling's stop ${f.is} under ⌈${p.cushionLineSocPct}⌉`);
    } else {
      assert.equal(costStopOf(p, stateDeps(caseOf(f.label).deps, 'write')), f.is, at);
      assert.ok(f.is >= ceilL, `${at}: the stop ${f.is} under ⌈${p.cushionLineSocPct}⌉`);
    }
    assert.ok(f.is < f.was, at);
  }
  // The class, on every cost night of the 4-20 h year at these figures and scales.
  let costNights = 0, debiased = 0;
  for (const sc of [S944, { scale: 0.92, basis: 'held' } as CushionPoolScale, { scale: 0.9, basis: 'min-known' } as CushionPoolScale]) {
    for (const w of FIG_STANDBY_EXTRA_W) for (const h of HOURS) for (const c of CASES) {
      if (c.deps.objectiveMode !== 'cost') continue;
      const p = yearPlan(c.deps, { scale: sc, w, st: 'write', h });
      if (p.cushionLineSocPct == null || (p.cushionBasis !== 'islanded-outage' && p.cushionBasis !== 'disabled')) continue;
      const at = `${c.label} ${h} h ${sc.basis} ${w} W`;
      if (p.chargeTonight) {
        costNights += 1;
        assert.ok(written(p)! >= Math.min(RESERVE_WRITE_MAX_PCT, Math.ceil(p.cushionLineSocPct - 1e-9)), `${at}: line ${p.cushionLineSocPct}, written ${written(p)}`);
      }
      // The bound is on the morning-solar headroom: an owner's SoC ceiling under the line ('max-soc') is the owner's.
      if (p.costCeilingSocPct != null && p.costCeilingBasis === 'pv-headroom' && sizingHeld(p) && p.costCeilingSurplusKwh != null
        && p.costCeilingSurplusRawKwh != null && p.costCeilingSurplusKwh > p.costCeilingSurplusRawKwh + 0.005 && p.requiredExtraKwh! > 0) {
        debiased += 1;
        // (round1 of a ceiling at least the arrival, at or above the line.)
        assert.ok(p.costCeilingSocPct >= p.cushionLineSocPct - 0.05 - 1e-9, `${at}: a de-biased ceiling ${p.costCeilingSocPct} under the ${p.cushionLineSocPct}% line`);
      }
    }
  }
  assert.ok(costNights > 10_000 && debiased > 1_000, `${costNights} cost nights, ${debiased} de-biased ceilings`);
});

/* ══ T7 — the tick's mirror ═════════════════════════════════════════════════════════════════════════════ */

test('★★★ T7 THE MIRROR: the stated start is the minute the panel-figure tick comes due along the plan\'s own walk; a tick on the measured pool would come due no earlier', () => {
  const H = 3_600_000, M = 60_000;
  const W0 = Date.UTC(2026, 9, 13, 6); // 23:00 MST
  const hours = Array.from({ length: 8 }, (_, k) => ({ ts: W0 + k * H, pvP10W: 0, pvP50W: 0, loadP90W: 3000, loadP50W: 1500, evP90W: 0 }));
  const walk = (tickPoolKwh: number) => nca.expectedForceChargeStart({
    startKwh: 0.5 * POOL, reserveKwh: 0.5 * POOL, fullKwh: POOL, ceilingPct: 80, tickPoolKwh, hours, fromMs: W0, windowEndMs: W0 + 6 * H,
    dischargeEff: 0.94, chargeCapKw: 17, envelopeKw: 17, legEff: 0.927, standbyW: 270,
  })!;
  const onPanel = walk(N), onPool = walk(POOL);
  assert.ok(onPanel.startMs != null && onPool.startMs != null);
  assert.ok(onPanel.startMs <= onPool.startMs, `the panel figure counts more energy per point: ${clock(onPanel.startMs)} vs ${clock(onPool.startMs)}`);
  // The minute it starts is the minute forceChargeStartAtMs on the panel figure first comes due at the walked pool.
  const pct = (onPanel.packKwh / POOL) * 100;
  const due = forceChargeStartAtMs(W0 + 6 * H, 80, pct, N, (17 - 1.5) * 0.927, 0);
  assert.ok(onPanel.startMs >= due - M && onPanel.startMs <= due + M, `${clock(onPanel.startMs)} vs due ${clock(due)}`);
  // The sizing hands the walks the panel's figure as the tick's pool (runwayBasisContracts.test.ts pins the line).
  const src = readFileSync(resolve(HERE, '../src/nightChargeAdvisor.ts'), 'utf8');
  assert.ok(src.includes('runOn: lineRunOn, tickPoolKwh: panelFullKwh,'));
  assert.ok(FORCE_CHARGE_MIN_RUN_MS > 0);
});

/* ══ T8 / T9 — the year against v1.201.0; the figures ═══════════════════════════════════════════════════ */

/** Measured (v1.202.0) against measuredPlannerWalks.figures.json's `main` (c692f30e) over its groups: writes up, holds that
 *  charge, cost stops up and down; no write falls and no charge night holds (T6). */
const PIN_T8: Record<string, { wUp: number; holdToCharge: number; stopUp: number; stopDown: number }> = {
  'write|m': { wUp: 56, holdToCharge: 46, stopUp: 15, stopDown: 1 }, 'write|held': { wUp: 56, holdToCharge: 49, stopUp: 16, stopDown: 3 },
  'write|mk': { wUp: 56, holdToCharge: 48, stopUp: 18, stopDown: 1 }, 'write|np': { wUp: 56, holdToCharge: 21, stopUp: 5, stopDown: 0 },
  'advisory|m': { wUp: 56, holdToCharge: 46, stopUp: 0, stopDown: 0 }, 'stand|m': { wUp: 0, holdToCharge: 10, stopUp: 6, stopDown: 0 },
  'fixture|m': { wUp: 56, holdToCharge: 46, stopUp: 10, stopDown: 1 },
};

test('★★ T8 THE YEAR against v1.201.0 (c692f30e, the frozen `main` figures): writes rise and holds charge, as measured', () => {
  const got: Record<string, { wUp: number; holdToCharge: number; stopUp: number; stopDown: number }> = {};
  const now = groupsNow();
  for (const [st, b] of FIG_GROUPS) {
    const g = { wUp: 0, holdToCharge: 0, stopUp: 0, stopDown: 0 };
    for (const h of FIG_HOURS) {
      const k = figKey(st, b, h);
      const a = FIG.main.groups[k].split(','), z = now[k].split(',');
      a.forEach((t, idx) => {
        const x = parseToken(t), y = parseToken(z[idx]);
        if (x.charge && y.charge && y.written! > x.written!) g.wUp += 1;
        if (!x.charge && y.charge) g.holdToCharge += 1;
        if (x.stop != null && y.stop != null) { if (y.stop > x.stop + 1e-9) g.stopUp += 1; else if (y.stop < x.stop - 1e-9) g.stopDown += 1; }
      });
    }
    got[`${st}|${b}`] = g;
  }
  assert.deepEqual(got, PIN_T8);
});

test('★★★ T9 THE FIGURES as measured (measuredPlannerWalks.figures.json `c`), group by group', () => {
  assert.equal(FIG.c.generatedAt.startsWith('v1.202.0'), true);
  const now = groupsNow();
  const moved = Object.keys(FIG.c.groups).filter((k) => FIG.c.groups[k] !== now[k]);
  assert.deepEqual(moved, [], `${moved.length} group(s) moved`);
  assert.deepEqual(Object.keys(now), Object.keys(FIG.main.groups), 'the same groups as the frozen v1.201.0 part');
});

/* ══ T10 — the shadow's pool ════════════════════════════════════════════════════════════════════════════ */

test('★★ T10 THE SHADOW\'S POOL: the held-import walk drains the plan\'s standby from both pools — at the floors the held-minus-free import is unchanged; above them the free pool drains it too', () => {
  const H = 3_600_000;
  const t0 = Date.UTC(2026, 9, 15, 17); // 10:00 MST
  const hours = Array.from({ length: 6 }, (_, k) => ({ ts: t0 + k * H, pvP50W: 0, loadP50W: 1200 }));
  const est = (o: { startSocPct: number; standbyW?: number; fullKwh?: number }) => heldImportEstimate({
    hours, fromMs: t0, untilMs: t0 + 5 * H, startSocPct: o.startSocPct, holdPct: 40, floorPct: 20, fullKwh: o.fullKwh ?? POOL,
    dischargeEff: 0.94, legEff: 0.927, centsAt: () => 10, replaceCentsPerKwh: null, ...(o.standbyW != null ? { standbyW: o.standbyW } : {}),
  })!;
  // At the floors (the free pool already at its 20% floor, the held one at 40%): both turn the whole drain away, so the
  // standby adds the same import to both and the held-minus-free difference does not move.
  assert.equal(est({ startSocPct: 20, standbyW: 270 }).kwh, est({ startSocPct: 20 }).kwh);
  // Above them: the held pool, at its floor, turns the standby away to the grid while the free pool drains it from storage,
  // so the hold's extra import grows by it until the free pool reaches its own floor.
  const [a0, a1] = [est({ startSocPct: 30 }).kwh, est({ startSocPct: 30, standbyW: 270 }).kwh];
  assert.ok(a1 > a0, `${a0} → ${a1}`);
  // index.ts hands the shadow the plan's pool and standby (runwayBasisContracts.test.ts pins the line).
  const idx = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
  assert.ok(idx.includes('fullKwh: plan.planPool?.kwh ?? fullKwh, standbyW: plan.planPool?.standbyW ?? 0,'));
});

/* ══ T11 — the legacy band and a disabled cushion ═══════════════════════════════════════════════════════ */

test('★★ T11 THE LEGACY BAND AND A DISABLED CUSHION: the band\'s percent and the line unchanged, the walks on the pool, planPool present', () => {
  let legacy = 0;
  for (const c of CASES) {
    const base = yearPlan(c.deps);
    if (base.cushionBasis === 'islanded-outage' || base.requiredExtraKwh == null) continue;
    const p = yearPlan(c.deps, { scale: S944, w: 270 });
    assert.equal(p.cushionLineSocPct, base.cushionLineSocPct, c.label);
    assert.deepEqual(p.planPool, { kwh: POOL, standbyW: 270 }, c.label);
    assert.deepEqual(p.cushionPoolScale, S944, `${c.label}: the pool's scale, on every basis`);
    if (base.cushionBasis === 'legacy-pct') {
      legacy += 1;
      assert.ok(Math.abs(p.cushionKwh! - (POOL * p.cushionPct) / 100) < 0.006, `${c.label}: the band of the measured pool`);
    }
    if (base.chargeTonight) assert.ok(p.chargeTonight && written(p)! >= written(base)!, `${c.label}: the write`);
  }
  assert.equal(legacy, 148);
});

test('★★★ T11b THE LEGACY BAND AND A DISABLED CUSHION AS THE WALKS\' STANDBY RISES (0-1500 W in 30 W steps; no scale, ×0.944 measured, ×0.8 held): the requirement, the worst-case buy, a charge night\'s write and the cost ceiling never fall, and no charge night holds — B\'s hiLift rule extended to the walks\' standby', () => {
  // Their cushion counts no standby (standbyCounted is false), so only the walks' drain can push a night past the cliff the
  // legacy proxy sits under (2026-12-02 21:30 on nameplate: from 0 to 30 W the proxy would drop 85.23 kWh to 60.19).
  let cases = 0, plans = 0, unmeetable = 0;
  const falls: string[] = [];
  for (const c of CASES) for (const sc of [null, S944, { scale: 0.8, basis: 'held' } as CushionPoolScale]) {
    const o = sc != null ? { scale: sc } : {};
    let prev = yearPlan(c.deps, { ...o, w: 0 });
    if (prev.cushionBasis === 'islanded-outage') continue;
    cases += 1;
    for (let w = 30; w <= 1500; w += 30) {
      const p = yearPlan(c.deps, { ...o, w });
      plans += 1;
      if (p.cushionShortfall && p.requiredExtraKwh != null && p.bindingCap !== 'requirement') unmeetable += 1;
      const at = `${c.label} ${sc?.scale ?? 'np'} ${w} W`;
      const fell = (k: string, a: number | null | undefined, b: number | null | undefined) => {
        if (a != null && (b == null || b < a - 1e-9)) falls.push(`${at} ${k}: ${a} → ${b}`);
      };
      fell('requirement', prev.requiredExtraKwh, p.requiredExtraKwh);
      fell('worst-case buy', prev.buyKwh, p.buyKwh);
      fell('cost ceiling', prev.costCeilingSocPct, p.costCeilingSocPct);
      if (prev.chargeTonight) {
        if (!p.chargeTonight) falls.push(`${at}: a charge night holds`);
        else fell('write', written(prev), written(p));
      }
      prev = p;
    }
  }
  assert.ok(cases > 1000 && unmeetable > 10_000, `${cases} cases, ${unmeetable} unmeetable plans`);
  assert.deepEqual(falls.slice(0, 8), [], `${falls.length} falls in ${plans} plans`);
});

/* ══ T12 — the walk standby's monotone set ══════════════════════════════════════════════════════════════ */

/** Measured (v1.202.0): the disclosed nights that more modeled drain claims (disclosed at 0 W, carried at 270 W), at ×0.944
 *  over 4-20 h, in a write mode and on a standing 50 (critique defect 2): A's re-ON walk switching a latched night back on,
 *  or the 270 W cushion's higher line handing a cost-carried night to the line force-charge's own walk. Each holds its line
 *  by its own walk (T13). */
const PIN_T12_RECARRIED = {
  write: ['2027-03-01 13:00 11 h', '2027-05-06 21:30 13 h', '2026-10-19 21:30 15 h', '2026-11-29 +1 01:30 15 h', '2027-05-31 21:30 15 h',
    '2027-05-31 13:00 15 h', '2026-10-19 21:30 16 h', '2026-11-29 21:30 16 h', '2026-11-29 +1 01:30 16 h', '2027-05-31 21:30 16 h',
    '2027-05-31 13:00 16 h', '2027-06-07 21:30 16 h', '2027-06-07 13:00 16 h', '2027-08-09 21:30 16 h', '2026-11-29 13:00 17 h',
    '2026-12-14 21:30 18 h', '2026-12-14 13:00 18 h', '2027-01-26 21:30 19 h', '2027-01-26 +1 01:30 19 h', '2027-01-26 21:30 20 h',
    '2027-01-26 +1 01:30 20 h', '2027-03-01 21:30 20 h'],
  stand: ['2026-10-19 21:30 4 h', '2027-08-09 13:00 5 h', '2026-11-29 21:30 7 h', '2027-04-13 13:00 7 h', '2026-11-29 13:00 8 h',
    '2027-08-09 21:30 8 h', '2026-11-11 21:30 9 h', '2026-11-11 13:00 9 h', '2027-05-31 21:30 9 h', '2027-05-31 13:00 9 h',
    '2026-10-15 13:00 10 h', '2027-03-01 21:30 10 h', '2027-05-31 13:00 10 h', '2026-10-15 13:00 11 h', '2027-02-24 21:30 13 h',
    '2027-02-24 13:00 13 h', '2027-10-07 21:30 14 h', '2027-10-07 13:00 18 h', '2027-10-07 13:00 19 h'],
};

test('★★★ T12 THE WALK STANDBY, with B\'s hiLift rule extended: from 0 to 270 W no charge night\'s write, the requirement, the worst-case buy, the cost ceiling or a line night\'s ask falls, and no charge night holds; the claims more drain makes, pinned', () => {
  const reCarried: Record<'write' | 'stand', string[]> = { write: [], stand: [] };
  let n = 0;
  for (const st of ['write', 'stand'] as const) for (const h of HOURS) for (const c of CASES) {
    const z = yearPlan(c.deps, { scale: S944, w: 0, st, h });
    const p = yearPlan(c.deps, { scale: S944, w: 270, st, h });
    n += 1;
    for (const f of ['requiredExtraKwh', 'buyKwh', 'costCeilingSocPct', 'cushionLineSocPct'] as const) {
      const a = z[f], b = p[f];
      if (a != null) assert.ok(b != null && b >= a - 1e-9, `${c.label} ${st} ${h} h: ${f} ${a} → ${b}`);
    }
    if (z.chargeTonight) assert.ok(p.chargeTonight && written(p)! >= written(z)!, `${c.label} ${st} ${h} h: the write`);
    if (z.forceChargeLine != null) assert.ok(p.forceChargeLine != null && p.forceChargeLine.askPct >= z.forceChargeLine.askPct, `${c.label}: the ask`);
    if (z.cushionShortfall && !p.cushionShortfall) reCarried[st].push(`${c.label} ${h} h`);
  }
  assert.ok(n > 35_000);
  assert.deepEqual(reCarried, PIN_T12_RECARRIED);
});

/* ══ T13 / T14 — the line nights; the cost-carried drawback ═════════════════════════════════════════════ */

/** The drawback a night the cost force-charge carries walks past its stop, test-local, on the plan's own median basis: the
 *  plan's just-in-time start, then the run to the stop and the house's drain held at the written reserve, with no re-ON. */
function drawbackClose(p: NightChargePlan, deps: NightChargeInputDeps): number | null {
  const inputs = buildNightChargeInputs(deps);
  const pool = p.planPool?.kwh ?? inputs.fullKwh;
  const reservePct = clampReserveTarget(p.setpointSocPct!);
  const reserveKwh = (reservePct / 100) * pool;
  const env = inputs.gridInputCapKw != null && inputs.gridInputCapKw > 0 ? inputs.gridInputCapKw : null;
  const fromMs = Math.max(inputs.window!.startMs, inputs.nowMs);
  if (p.expectedStartSocPct == null || p.costCeilingSocPct == null) return null;
  const w = { hours: inputs.horizon, windowEndMs: inputs.window!.endMs, dischargeEff: inputs.dischargeEff, chargeCapKw: inputs.chargeCapKw, envelopeKw: env, legEff: inputs.legEff, standbyW: p.planPool?.standbyW ?? 0 };
  const jit = nca.expectedForceChargeStart({ startKwh: Math.max((p.expectedStartSocPct / 100) * pool, reserveKwh), reserveKwh, fullKwh: pool, ceilingPct: p.costCeilingSocPct, tickPoolKwh: inputs.fullKwh, fromMs, ...w });
  if (jit == null) return null;
  const stop = forceChargeStopPct(p.costCeilingSocPct);
  const r = nca.expectedLineForceChargeWalk({ startKwh: jit.packKwh, reserveKwh, fullKwh: pool, tickPoolKwh: inputs.fullKwh, startTargetPct: stop, panelCeilingPct: stop,
    fromMs: jit.startMs ?? inputs.window!.endMs - FORCE_CHARGE_MIN_RUN_MS, acceptKw: null, noReOn: true, runOn: jit.startMs != null, ...w });
  return r == null ? null : Math.max(reservePct, (r.closeKwh / pool) * 100);
}
const under = (close: number | null | undefined, line: number) => close != null && close < line - LINE_CARRY_CLOSE_TOLERANCE_PCT - 1e-9;

test('★★★ T13 NO LINE NIGHT UNDER ITS LINE UNDISCLOSED, in a write mode, advisory and on a standing 50, at ×0.944 and on nameplate with 270 W: the line walk\'s close, or a cost-carried night\'s walk past its stop', () => {
  let lineNights = 0;
  for (const st of ['write', 'advisory', 'stand'] as const) for (const sc of [S944, undefined]) for (const h of HOURS) for (const c of CASES) {
    const deps = { ...stateDeps(c.deps, st), outageCushionHours: h, cushionStandbyW: 270, ...(sc ? { cushionPoolScale: sc } : {}) } as NightChargeInputDeps;
    const p = computeNightChargePlan(buildNightChargeInputs(deps));
    if (p.forceChargeLine == null && p.cushionEnvelopeReason == null) continue;
    lineNights += 1;
    if (p.cushionShortfall) continue;
    assert.ok(!under(p.expectedWriteLevelPct, p.cushionLineSocPct!), `${c.label} ${st} ${h} h: ~${p.expectedWriteLevelPct}% under ${p.cushionLineSocPct}%`);
    if (p.forceChargeLine != null && p.expectedForceChargeMode !== 'line' && p.chargeTonight) {
      const close = drawbackClose(p, deps);
      assert.ok(!under(close, p.cushionLineSocPct!), `${c.label} ${st} ${h} h: cost-carried, closes ~${close?.toFixed(1)}% under ${p.cushionLineSocPct}%, undisclosed`);
    }
  }
  assert.ok(lineNights > 10_000, `${lineNights} line nights`);
});

/** Measured on c692f30e (v1.201.0) with the same test-local walk, nameplate, 270 W, a write mode, 4-20 h: the cost-carried line
 *  nights that closed under their line with nothing disclosed (23, all EV nights at 8 h or more). */
const PIN_T14_MAIN = [
  '2026-10-19 21:30|12', '2026-10-19 21:30|13', '2026-11-29 21:30|13', '2026-10-19 21:30|14', '2026-11-29 21:30|14', '2026-10-19 21:30|15',
  '2026-11-29 21:30|15', '2026-11-29 +1 01:30|15', '2026-11-29 13:00|16', '2027-01-27 21:30|16', '2026-12-14 21:30|17', '2027-01-26 21:30|17',
  '2027-01-26 13:00|17', '2026-12-14 13:00|18', '2027-01-26 21:30|18', '2027-01-26 13:00|18', '2027-01-26 +1 01:30|18', '2027-01-26 21:30|19',
  '2027-01-26 13:00|19', '2027-01-26 +1 01:30|19', '2027-01-26 21:30|20', '2027-01-26 13:00|20', '2027-01-26 +1 01:30|20',
];
/** Measured (v1.202.0): the cost-carried line nights whose walk past the stop closes under the line, ×0.944 and nameplate,
 *  270 W, a write mode, 4-20 h (the plan's own close, expectedCloseAfterStopPct): `disclosed`, those whose sizing held the
 *  line (cushionEnvelopeReason 'closeUnder'); `capped`, those whose sizing fell short, whose caps note stands and which name
 *  the close beside it, as a line-mode night does (lineNotHeldOf). */
const PIN_T14_C = { disclosed: { m: 28, np: 25 }, capped: { m: 57, np: 70 } };
const CLOSE_NOTE = (p: NightChargePlan): string => ` NOTE: on the median load the pool is expected to close at ~${p.expectedCloseAfterStopPct}%, under tonight's ${p.cushionLineSocPct}% outage line, so the cushion is not fully held — residual risk remains.`;
const CAPS_NOTE = ' NOTE: charge/pool caps prevent fully meeting the cushion — residual risk remains.';
const r1 = (n: number): number => Math.round(n * 10) / 10;
const closeRow = (p: NightChargePlan): string => `outage line ${r1(p.cushionLineSocPct!)}% is above the 50% the panel accepts as a reserve — ~${r1(p.expectedCloseAfterStopPct!)}% expected at the close, under the line (the cost force-charge's stop is ~${r1(p.expectedWriteLevelPct!)}%); residual risk remains`;

test('★★★ T14 A LINE NIGHT THE COST FORCE-CHARGE CARRIES walks its drawback past the stop: v1.201.0\'s 23 undisclosed nights are disclosed (closeUnder), and a night whose sizing fell short names its close beside the caps note, on every surface\'s words; disclosure only — the write, the mode, the stop and the buy are as without it', () => {
  for (const key of PIN_T14_MAIN) {
    const [label, h] = key.split('|');
    const p = yearPlan(caseOf(label).deps, { w: 270, st: 'write', h: Number(h) });
    assert.equal(p.cushionEnvelopeReason, 'closeUnder', key);
    assert.deepEqual([p.cushionShortfall, p.cushionShortfallCause, lineNotHeldOf(p)], [true, 'envelope', 'closeUnder'], key);
    assert.ok(p.expectedCloseAfterStopPct != null && p.expectedCloseAfterStopPct < p.cushionLineSocPct! - 0.05, key);
    assert.notEqual(p.expectedForceChargeMode, 'line', `${key}: still the cost force-charge`);
    assert.ok(p.rationale.includes(CLOSE_NOTE(p)), p.rationale);
  }
  // A night whose sizing fell short (2026-11-13 13:00 at 14 h on nameplate, a predicted EV binding the window): the caps note
  // stands, the close past the stop is named beside it on the rationale, the 21:30 notice, the card and the ARMED line; the
  // write, the mode, the stop and the buy are what the night planned before its close was named (the 50% write, the cost
  // force-charge to its 90% stop, 7.2 kWh expected), and the rest of its rationale names no line, as any cost-dominant night's.
  const sh = yearPlan(caseOf('2026-11-13 13:00').deps, { w: 270, st: 'write', h: 14 });
  assert.deepEqual([sh.cushionShortfall, sh.cushionShortfallCause ?? null, sh.cushionEnvelopeReason ?? null, lineNotHeldOf(sh)], [true, null, null, 'closeUnder']);
  assert.deepEqual([sh.cushionLineSocPct, sh.expectedCloseAfterStopPct, sh.expectedWriteLevelPct, written(sh), forceChargeStopPct(sh.costCeilingSocPct!)], [79.56, 57.2, 90, 50, 90]);
  assert.deepEqual([sh.expectedBuyKwh, sh.buyKwh, sh.bindingCap, sh.expectedForceChargeMode ?? null], [7.2, 1.41, 'evContention', null]);
  assert.equal(sh.forceChargeLine?.askPct, 80);
  assert.ok(sh.rationale.includes(CLOSE_NOTE(sh)) && sh.rationale.includes(CAPS_NOTE), sh.rationale);
  assert.equal(sh.rationale.split(' NOTE: on the median load').length, 2, 'the close named once');
  assert.doesNotMatch(sh.rationale.replace(CLOSE_NOTE(sh), ''), /outage line/, sh.rationale);
  const push = buildNightChargeMessage(sh, 'charge', null).body;
  assert.ok(push.includes("NOTE: on the median load the pool is expected to close at ~57.2%, under tonight's 79.6% outage line — residual risk remains."), push);
  assert.ok(push.includes('NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.'), push);
  assert.equal(cardText.lineNotHeldOfCard(sh as never), 'closeUnder');
  assert.equal(cardText.outageLineRow(sh as never, 50), closeRow(sh));
  assert.equal(closeRow(sh), "outage line 79.6% is above the 50% the panel accepts as a reserve — ~57.2% expected at the close, under the line (the cost force-charge's stop is ~90%); residual risk remains");
  // The ARMED line reads the same predicate and field (index.ts forceChargeArmNote): "Line NOT held: ~57.2% expected at the close."
  const idx = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
  assert.ok(idx.includes("  const closeAfter = lineNotHeldOf(plan) === 'closeUnder' ? plan?.expectedCloseAfterStopPct : null;\n"));
  assert.ok(idx.includes("    + (closeAfter != null ? ` Line NOT held: ~${round1(closeAfter)}% expected at the close.` : '');\n"));
  // A disclosed night's card row names its close too (2026-10-19 21:30 at 12 h, ×0.944: ~50% under the 52.7% line).
  const dc = yearPlan(caseOf('2026-10-19 21:30').deps, { scale: S944, w: 270, st: 'write', h: 12 });
  assert.deepEqual([dc.cushionEnvelopeReason, dc.expectedCloseAfterStopPct, dc.cushionLineSocPct, dc.expectedWriteLevelPct], ['closeUnder', 50, 52.7, 70]);
  assert.equal(cardText.outageLineRow(dc as never, 50), "outage line 52.7% is above the 50% the panel accepts as a reserve — ~50% expected at the close, under the line (the cost force-charge's stop is ~70%); residual risk remains");
  // The year: every plan with the field is a cost-carried night under its line, disclosed or capped, on every surface; and
  // every armed cost-carried night whose own walk past the stop closes under its line carries the field.
  const count = { disclosed: { m: 0, np: 0 }, capped: { m: 0, np: 0 } };
  for (const [b, sc] of [['m', S944], ['np', undefined]] as const) for (const h of HOURS) for (const c of CASES) {
    const deps = { ...stateDeps(c.deps, 'write'), outageCushionHours: h, cushionStandbyW: 270, ...(sc ? { cushionPoolScale: sc } : {}) } as NightChargeInputDeps;
    const p = computeNightChargePlan(buildNightChargeInputs(deps));
    const at = `${c.label} ${h} h ${b}`;
    if (p.forceChargeLine != null && p.expectedForceChargeMode !== 'line' && p.chargeTonight && p.cushionShortfall && p.expectedCloseAfterStopPct == null) {
      const close = drawbackClose(p, deps);
      assert.ok(close == null || r1(close) >= p.cushionLineSocPct! - LINE_CARRY_CLOSE_TOLERANCE_PCT - 1e-9, `${at}: sized short, closes ~${close?.toFixed(2)}% under ${p.cushionLineSocPct}%, the close not named`);
    }
    if (p.expectedCloseAfterStopPct == null) continue;
    const kind = p.cushionEnvelopeReason === 'closeUnder' ? 'disclosed' : 'capped';
    count[kind][b] += 1;
    if (kind === 'disclosed') assert.deepEqual([p.cushionShortfall, p.cushionShortfallCause], [true, 'envelope'], at);
    else {
      assert.deepEqual([p.cushionShortfall, p.cushionShortfallCause ?? null, p.cushionEnvelopeReason ?? null], [true, null, null], `${at}: the sizing fell short`);
      assert.ok(p.rationale.includes(CAPS_NOTE), `${at}: the caps note stands`);
    }
    assert.ok(p.expectedCloseAfterStopPct < p.cushionLineSocPct! - LINE_CARRY_CLOSE_TOLERANCE_PCT, at);
    assert.equal(lineNotHeldOf(p), 'closeUnder', at);
    assert.ok(p.rationale.includes(CLOSE_NOTE(p)), `${at}: the NOTE names the close`);
    assert.equal(cardText.outageLineRow(p as never, 50), closeRow(p), `${at}: the card names the close`);
    // The field is only the disclosure: with it set aside the plan is the claim the cost force-charge carries.
    assert.ok(forceChargeStopPct(p.costCeilingSocPct!) >= p.forceChargeLine!.askPct + 10, `${at}: cost-dominant`);
  }
  assert.deepEqual(count, PIN_T14_C);
});

/* ══ T15 — the ledger ═══════════════════════════════════════════════════════════════════════════════════ */

test('★★★ T15 THE LEDGER: plan_pool_kwh and plan_walk_standby_w on every sized row (the panel\'s figure and 0 W where the plan carries no planPool), NULL where nothing was sized; round-trip, an older row reads null, a re-issued plan replaces them', async () => {
  const cols = (nca as unknown as { planPoolLedgerColumns: (p: unknown, f: number) => Record<string, unknown> }).planPoolLedgerColumns;
  assert.deepEqual(cols(yearPlan(caseOf('2026-10-12 resilience').deps, { scale: S944, w: 270 }), N), { plan_pool_kwh: POOL, plan_walk_standby_w: 270 });
  assert.deepEqual(cols(yearPlan(caseOf('2026-10-12 resilience').deps), N), { plan_pool_kwh: N, plan_walk_standby_w: 0 });
  const hold = CASES.map((c) => yearPlan(c.deps, { scale: S944, w: 270 })).find((p) => !p.chargeTonight && p.requiredExtraKwh != null)!;
  assert.deepEqual(cols(hold, N), { plan_pool_kwh: POOL, plan_walk_standby_w: 270 }, 'a hold carries its pool too');
  const refused = computeNightChargePlan({ ...buildNightChargeInputs({ ...caseOf('2026-10-12 resilience').deps, cushionPoolScale: S944, cushionStandbyW: 270 } as never), basisComplete: false });
  assert.equal(refused.basisComplete, false);
  assert.deepEqual(cols(refused, N), { plan_pool_kwh: null, plan_walk_standby_w: null }, 'a refused plan counted no pool');
  const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-plan-pool-'));
  process.env.DB_PATH = join(tmp, 'ecoflow.db');
  const { createRecorder } = await import('../src/recorder.js');
  const { SnapshotStore } = await import('../src/snapshot.js');
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const base = (d: string) => ({ plan_date: d, issued_at_ms: 1, algo_version: '3', posture: 'auto', objective: 'resilience_cushion', rationale: 'x',
      confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 30, target_soc_pct: 33.3, buy_kwh: 28.5, required_extra_kwh: 26.42,
      reserve_floor_pct: 16, cushion_pct: 15, cushion_kwh: 15.02, binding_cap: 'requirement', cushion_shortfall: 0, pool_full_kwh: N });
    rec.recordNightPlan({ ...base('2026-11-09'), plan_pool_kwh: POOL, plan_walk_standby_w: 270 } as never);
    rec.recordNightPlan(base('2026-11-02') as never);
    const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
    assert.deepEqual([at('2026-11-09').plan_pool_kwh, at('2026-11-09').plan_walk_standby_w], [POOL, 270]);
    assert.deepEqual([at('2026-11-02').plan_pool_kwh, at('2026-11-02').plan_walk_standby_w], [null, null], 'unknown on an older row, never fabricated');
    rec.recordNightPlan({ ...base('2026-11-09'), issued_at_ms: 2, plan_pool_kwh: null, plan_walk_standby_w: null } as never);
    assert.deepEqual([at('2026-11-09').plan_pool_kwh, at('2026-11-09').plan_walk_standby_w], [null, null]);
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
  const recSrc = readFileSync(resolve(HERE, '../src/recorder.ts'), 'utf8');
  assert.ok(recSrc.includes("  'plan_pool_kwh', 'plan_walk_standby_w',\n"), 'the allowlist the upsert reads');
  assert.ok(recSrc.includes("    'plan_pool_kwh REAL', 'plan_walk_standby_w REAL',\n"), 'the column add for a deployed ledger');
  const idx = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
  const fn = idx.slice(idx.indexOf('function recordNightPlanRow('), idx.indexOf('\n}\n', idx.indexOf('function recordNightPlanRow(')));
  assert.equal(fn.split('    ...planPoolLedgerColumns(plan, extras.fullKwh),\n').length - 1, 1, 'written unconditionally, once');
});
