import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNightChargeInputs, computeNightChargePlan, eveningBasisDefers, cushionOnlyText, cushionOnlyFills, gapAfterWindowText, sizingBasisText,
  NO_PV_WORST_CASE_BASIS, NIGHT_PLAN_STALE_DEFER_UNTIL_MIN, LONG_GAP_MS,
  type NightChargeInputDeps, type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { armFromPlan, decideActuation, emptyActuationState, clampReserveTarget, revertDueMs, RESERVE_WRITE_MAX_PCT, PANEL_RESERVE_HOLD_UNDERSHOOT_PCT } from '../src/nightChargeActuator.js';
import { nextOnPeakStartMs } from '../src/chargeWindows.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { cushionOnlyNote, BASIS_INCOMPLETE_NOTE, HELD_TELEMETRY_MARKER } from '../src/nightLedgerScoring.js';
import { computeNightChargeReadiness, CURRENT_ALGO_VERSION } from '../src/nightChargeGate.js';
import { PoolEnergyBasisTracker, CAPACITY_SCALE_MIN, HELD_RATIO_MAX_AGE_MS } from '../src/poolEnergyBasis.js';
import * as web from '../../web/src/cards/nightChargeText.js';
import { legacyIdentityCases, planDigest, MODEL } from './fixtures/legacyIdentityFixtures.js';
import { darkDeps, darkPlan, darkToken, darkFigures, costGate, DARK_BASES, type DarkBasis } from './fixtures/cushionOnlyFigures.js';

/**
 * ★★★ v1.203.0 — THE CUSHION-ONLY PLAN: the fallback while the solar basis is refused.
 *
 * With the Cores dark on the vendor cloud every night plan was refused for a solar basis it could not have (0 scored
 * calibration days, a PV band of 0), and nothing charged overnight from 2026-10-16. Where the solar basis is refused, the live
 * overnight plan in a write mode on a fresh panel (index.ts cushionOnlyEligible) is now sized on the outage cushion alone: the
 * sizer as it is, every PV figure zeroed, resilience — but for the long-gap fill before a gap of more than a day after its
 * window (owner, 2026-11-08) — and no band widening. Here, by the design's numbering (re-cut for the critique and the owner's
 * decisions): T1 identity, T2 the qualification matrix, T3 no solar credit, T4 no cost but the long-gap fill, T5 the write,
 * T6 the actuator end to end, T7 the pool seed, T8 the ledger and the scorer, T9 the texts, T11 the source pins, T12 the
 * evening deferral, T13 the stale panel, T14 the dark year's figures, T15 Friday's long gap.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const CASES = legacyIdentityCases();
const caseOf = (label: string) => {
  const c = CASES.find((x) => x.label === label);
  assert.ok(c, label);
  return c;
};
const H = 3_600_000;
const plan = (d: NightChargeInputDeps): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(d));
const written = (p: NightChargePlan): number | null => (p.chargeTonight && p.setpointSocPct != null ? clampReserveTarget(p.setpointSocPct) : null);
const FIG = JSON.parse(readFileSync(resolve(HERE, 'fixtures/cushionOnlyFigures.json'), 'utf8')) as { generatedAt: string; cases: number; bases: Record<DarkBasis, string> };
/** The live-shaped resilience night with the Cores dark, on the seeded held ratio. */
const REF = caseOf('2026-10-12 resilience');
const refDark = (o: Partial<NightChargeInputDeps> = {}, basis: DarkBasis = 'held'): NightChargeInputDeps => ({ ...darkDeps(REF.deps, basis), ...o } as NightChargeInputDeps);
const SOLAR_REFUSAL_0 = 'only 0 scored calibration day(s), need 4 (a provisional plan on a widened solar band from 4; the full band from 14)';

/* ══ T1 — identity ══════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ T1 IDENTITY: with the fallback eligible on every case of the year, every night that plans today is byte-identical; only refused nights move, and every one was refused for its solar basis', () => {
  let same = 0, moved = 0;
  for (const c of CASES) {
    const before = plan(c.deps);
    const after = plan({ ...c.deps, cushionOnlyEligible: true, cushionOnlyFloorScale: CAPACITY_SCALE_MIN } as NightChargeInputDeps);
    if (planDigest(after) === planDigest(before)) { same += 1; continue; }
    moved += 1;
    assert.equal(before.basisComplete, false, `${c.label}: a night that plans today moved`);
    assert.ok(before.basisBlockedBy != null && before.basisBlockedBy !== 'no PV forecast available', `${c.label}: ${before.basisBlockedBy}`);
    assert.ok(after.cushionOnly != null || after.basisBlockedBy?.includes('; no cushion-only plan: '), `${c.label}: a cushion-only plan or its named refusal`);
    if (after.cushionOnly != null) assert.equal(after.cushionOnly.refusedBy, before.basisBlockedBy, c.label);
  }
  // Measured on the change: the fixture's refused nights are its "odd incomplete basis" ones.
  assert.deepEqual({ same, moved }, { same: CASES.length - PIN_T1_MOVED, moved: PIN_T1_MOVED });
});
/** The fixture's refused nights that qualify (its "odd incomplete basis": a young history, a coverage miss), as measured. */
const PIN_T1_MOVED = 79;

test('★★★ T1 THE DARK YEAR: v1.202.0 writes nothing on any case; with the fallback the year arms, as measured', () => {
  let armedBefore = 0, armed = 0;
  for (const c of CASES) {
    const deps = darkDeps(c.deps, 'held');
    const p0 = plan({ ...deps, cushionOnlyEligible: undefined } as NightChargeInputDeps);
    assert.equal(p0.basisComplete, false, `${c.label}: v1.202.0 refused it`);
    const onPeak = (p: NightChargePlan) => (p.window != null ? nextOnPeakStartMs(MODEL, p.window.startMs) : null);
    if (armFromPlan(emptyActuationState(), c.label, p0, deps.nowMs, deps.reserveFloorPct, costGate(c.deps), onPeak(p0), true)) armedBefore += 1;
    const p = plan(deps);
    if (armFromPlan(emptyActuationState(), c.label, p, deps.nowMs, deps.reserveFloorPct, costGate(c.deps), onPeak(p), true)) armed += 1;
  }
  assert.deepEqual({ armedBefore, armed }, { armedBefore: 0, armed: 504 });
});

/* ══ T2 — the qualification matrix ═══════════════════════════════════════════════════════════════════════ */

test('★★★ T2 QUALIFIES: every solar-basis refusal — no scored day, too few, a band-coverage miss, no widening for the count, the climatology tier — on the live overnight leg, a write mode, a fresh panel, a window and an islanded-outage cushion', () => {
  const reasons: Array<[string, Partial<NightChargeInputDeps>, boolean]> = [
    [SOLAR_REFUSAL_0, {}, true],
    ['only 9 scored calibration day(s), need 14', { calScoredDays: 9, provisionalMinCalScoredDays: undefined }, false],
    ['PV band coverage 70% < 78% (forecast present, tier=forecast, calDays 30/14)', { calScoredDays: 30, bandCoverageFrac: 0.7 }, false],
    ['no provisional band widening is defined for 4.5 scored calibration day(s)', { calScoredDays: 4.5, bandCoverageFrac: 0.85 }, false],
    ['forecast is climatology-tier (no site-specific history yet)', { confidenceTier: 'climatology', calScoredDays: 30, bandCoverageFrac: 0.85 }, false],
  ];
  for (const [why, o, transient] of reasons) {
    const before = plan({ ...refDark(o), cushionOnlyEligible: undefined } as NightChargeInputDeps);
    assert.equal(before.basisBlockedBy, why, 'the refusal v1.202.0 makes');
    assert.equal(before.basisTransient, transient);
    const p = plan(refDark(o));
    assert.equal(p.basisComplete, true, why);
    assert.deepEqual(p.cushionOnly, { refusedBy: why, transient, gapAfterMs: 18 * H, longGapAfter: false }, why);
    assert.equal(p.objective, p.chargeTonight ? 'resilience_cushion' : 'none', why);
    assert.equal('basisBlockedBy' in p, false, `${why}: a sized plan names no refusal`);
    const i = buildNightChargeInputs(refDark(o));
    assert.deepEqual([i.basisComplete, i.basisBlockedBy, i.basisTransient], [true, null, false], `${why}: the inputs carry no refusal`);
  }
});

test('★★★ T2 REFUSES AS BEFORE: no forecast, no window, the fallback not eligible (advisory, a stale panel, a shadow leg), the backup and mid-day legs — v1.202.0\'s refusal, byte for byte', () => {
  const same = (o: Partial<NightChargeInputDeps>, what: string) => {
    const p = plan(refDark(o));
    assert.equal(planDigest(p), planDigest(plan({ ...refDark(o), cushionOnlyEligible: undefined } as NightChargeInputDeps)), what);
    assert.equal(p.basisComplete, false, what);
    assert.equal(p.cushionOnly, undefined, what);
  };
  same({ bandHours: [], dayRollups: [], forecastPresent: false }, 'no forecast or load hours');
  same({ periodIdAt: () => 'off_peak' }, 'no window (a Saturday)');
  same({ cushionOnlyEligible: false }, 'not eligible: advisory mode, a stale panel at the last resort, a shadow leg');
  same({ windowSpec: { kind: 'overnight', role: 'backup' } }, 'the backup leg');
  const w = buildNightChargeInputs(refDark()).window!;
  same({ windowSpec: { kind: 'super_off_peak', role: 'cost', window: { startMs: w.startMs + 10 * H, endMs: w.startMs + 15 * H } } }, 'a mid-day leg');
  // The no-forecast refusal is its own, transient (a start-up's).
  const nf = plan(refDark({ bandHours: [], dayRollups: [], forecastPresent: false }));
  assert.deepEqual([nf.basisBlockedBy, nf.basisTransient], ['no PV forecast available', true]);
});

test('★★★ T2 REFUSED BY NAME: the legacy band, a disabled cushion, no ratio and no floor — each keeping the solar refusal\'s transience', () => {
  const by = (o: Partial<NightChargeInputDeps>, why: string, transient: boolean) => {
    const p = plan(refDark(o));
    assert.equal(p.basisComplete, false, why);
    assert.equal(p.basisBlockedBy, `${SOLAR_REFUSAL_0}; no cushion-only plan: ${why}`);
    assert.equal(p.rationale, `No plan — forecast/telemetry basis incomplete (${SOLAR_REFUSAL_0}; no cushion-only plan: ${why}); nothing will be charged.`);
    assert.equal(p.basisTransient, transient, `${why}: the deferral as before`);
    assert.equal(p.cushionOnly, undefined);
  };
  by({ islandedLoadKw: null }, 'no islanded-load measurement', true);
  by({ outageCushionHours: 0 }, 'the outage cushion is disabled', true);
  const np = { ...darkDeps(REF.deps, 'np', { floor: null }) } as NightChargeInputDeps;
  const p = plan(np);
  assert.equal(p.basisBlockedBy, `${SOLAR_REFUSAL_0}; no cushion-only plan: no pack capacity ratio is known and no capacity floor is set (the pool would be counted on nameplate)`);
  // A persistent solar refusal stays persistent.
  const nine = plan(refDark({ calScoredDays: 9, provisionalMinCalScoredDays: undefined, islandedLoadKw: null }));
  assert.deepEqual([nine.basisTransient, nine.basisBlockedBy], [false, 'only 9 scored calibration day(s), need 14; no cushion-only plan: no islanded-load measurement']);
});

test('★★★ T2 THE POOL: a known ratio as passed (held, min-known, measured); no ratio known — none, nameplate, no reading — the capacity floor, said so', () => {
  const at = (sc: unknown) => plan(refDark({ cushionPoolScale: sc as never }));
  const held = at({ scale: 0.944, basis: 'held' });
  assert.deepEqual(held.cushionPoolScale, { scale: 0.944, basis: 'held' });
  assert.equal(held.cushionOnly!.poolFloorScale, undefined);
  assert.deepEqual(at({ scale: 0.919, basis: 'min-known' }).cushionPoolScale, { scale: 0.919, basis: 'min-known' });
  assert.equal(at({ scale: 1, basis: 'measured' }).cushionOnly!.poolFloorScale, undefined, 'a measured ratio of 1 is a ratio');
  for (const sc of [undefined, null, { scale: 1, basis: 'nameplate' }, { scale: Number.NaN, basis: 'held' }, { scale: 0.3, basis: 'held' }]) {
    const d = { ...darkDeps(REF.deps, 'np'), ...(sc !== undefined ? { cushionPoolScale: sc } : {}) } as NightChargeInputDeps;
    const p = plan(d);
    assert.deepEqual(p.cushionPoolScale, { scale: CAPACITY_SCALE_MIN, basis: 'floor' }, JSON.stringify(sc));
    assert.equal(p.cushionOnly!.poolFloorScale, CAPACITY_SCALE_MIN);
    assert.match(p.rationale, / The pool is counted on the capacity floor, ×0\.80 of nameplate: no pack capacity ratio is known\.$/);
    assert.match(p.rationale, /% of the pool counted on the capacity floor, ×0\.800 of nameplate\)/);
    assert.doesNotMatch(p.rationale, /measured capacity at ×0\.800/);
  }
  // The floor holds more: a higher line than the held ratio's.
  assert.ok(plan(darkDeps(REF.deps, 'np')).cushionLineSocPct! > held.cushionLineSocPct!);
  // …and the full plan never takes the floor: a night that plans today counts its pool as it did.
  const full = plan({ ...REF.deps, cushionOnlyEligible: true, cushionOnlyFloorScale: CAPACITY_SCALE_MIN } as NightChargeInputDeps);
  assert.equal(planDigest(full), planDigest(plan(REF.deps)));
});

/* ══ T3 — no solar credit ══════════════════════════════════════════════════════════════════════════════ */

test('★★★ T3 NO SOLAR CREDIT: on the year, a cushion-only plan is the same plan whatever PV the band, the rollups and the surpluses carry (×0, ×0.5, ×1, ×3)', () => {
  let n = 0;
  for (const c of CASES) {
    const ref = darkPlan(c.deps, 'held');
    if (ref.cushionOnly == null) continue;
    n += 1;
    for (const k of [0.5, 1, 3]) assert.equal(planDigest(darkPlan(c.deps, 'held', { pv: k })), planDigest(ref), `${c.label} PV ×${k}`);
    const i = buildNightChargeInputs(darkDeps(c.deps, 'held', { pv: 1 }));
    assert.ok(i.horizon.every((h) => h.pvP10W === 0 && (h.pvP50W == null || h.pvP50W === 0)), `${c.label}: a PV hour`);
    assert.deepEqual([i.morningPvSurplusP90Kwh, i.morningPvSurplusP50Kwh, i.prePeakPvSurplusP10Kwh, i.costSurplusLoad, i.pvBandWiden], [null, null, null, null, undefined]);
  }
  assert.ok(n > 600, `${n} cushion-only plans`);
});

/* ══ T4 — no cost but the long-gap fill ═══════════════════════════════════════════════════════════════ */

test('★★★ T4 NO COST TARGET: every cushion-only plan but a long-gap night is resilience, with no cost ceiling, and arms none', () => {
  let n = 0;
  for (const c of CASES) {
    const deps = darkDeps(c.deps, 'held');
    const p = plan(deps);
    if (p.cushionOnly == null || p.cushionOnly.longGapAfter) continue;
    n += 1;
    assert.ok(p.objective === 'resilience_cushion' || p.objective === 'none', `${c.label}: ${p.objective}`);
    assert.equal(p.costCeilingSocPct ?? null, null, c.label);
    assert.equal(p.bindingCap === 'overBuy', false, `${c.label}: no over-buy flag with no solar surplus`);
    if (!p.chargeTonight || p.window == null) continue;
    const a = armFromPlan(emptyActuationState(), c.label, p, deps.nowMs, deps.reserveFloorPct, costGate(c.deps), nextOnPeakStartMs(MODEL, p.window.startMs), true);
    if (a) assert.equal(a.forceChargeCeilingPct, null, `${c.label}: no cost force-charge`);
  }
  assert.ok(n > 500, `${n}`);
});

/* ══ T5 — the write ═══════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ T5 THE WRITE: the pack-at-close leg\'s ⌈line⌉ + 1 (the panel\'s point), at most 50; a line the reserve cannot hold arms the line force-charge, and stands on a reserve reading 50', () => {
  let reserve = 0, line = 0, stood = 0;
  for (const c of CASES) {
    const deps = darkDeps(c.deps, 'held');
    const p = plan(deps);
    if (p.cushionOnly == null || !p.chargeTonight || p.cushionOnly.longGapAfter) continue;
    const L = p.cushionLineSocPct!;
    const w = written(p)!;
    if (p.forceChargeLine == null) {
      reserve += 1;
      assert.ok(w - PANEL_RESERVE_HOLD_UNDERSHOOT_PCT >= L - 0.005 && w - 2 < L + 0.01, `${c.label}: written ${w} for the ${L}% line`);
    } else {
      line += 1;
      assert.ok(L > 49 - 0.005, `${c.label}: a line the reserve holds armed the force-charge (${L})`);
      assert.equal(w, RESERVE_WRITE_MAX_PCT);
      // v1.200.1 — on a reserve already reading 50 the night stands with its ask.
      const st = plan({ ...deps, reserveFloorPct: 50 } as NightChargeInputDeps);
      if (st.chargeTonight && st.forceChargeLine != null && st.lineReserveStands === true) stood += 1;
    }
  }
  assert.deepEqual({ reserve, line, stood }, PIN_T5);
});
/** Measured on the dark year at ×0.944 held. */
const PIN_T5 = { reserve: 487, line: 56, stood: 56 };

/* ══ T6 — the actuator, end to end ══════════════════════════════════════════════════════════════════ */

test('★★★ T6 THE ACTUATOR: every armed cushion-only 21:30 plan writes its target at the open, restores the floor at revertDueMs and not a minute before; a cancel before the open writes nothing, after it restores; a grid loss restores at once', () => {
  let n = 0;
  for (const c of CASES.filter((x) => x.label.endsWith('21:30'))) {
    const deps = darkDeps(c.deps, 'held');
    const p = plan(deps);
    if (p.cushionOnly == null || !p.chargeTonight || p.window == null) continue;
    const a = armFromPlan(emptyActuationState(), c.label, p, deps.nowMs, deps.reserveFloorPct, costGate(c.deps), nextOnPeakStartMs(MODEL, p.window.startMs), true);
    if (a == null) continue;
    n += 1;
    const floor = deps.reserveFloorPct;
    const tick = { mode: 'supervised' as const, writeReady: false, currentReservePct: floor, socCoherent: true, vitalsRed: false, gridPresent: true };
    const open = Math.max(a.windowStartMs!, deps.nowMs);
    if (a.targetPct === floor) continue; // nothing to raise
    assert.deepEqual(decideActuation(a, open, tick), { kind: 'apply', targetPct: a.targetPct }, `${c.label}: the write at the open`);
    assert.equal(decideActuation({ ...a, cancelled: true }, open, tick).kind, 'none', `${c.label}: a cancel before the open writes nothing`);
    const applied = { ...a, applyAttemptedAtMs: open, attemptBaselinePct: floor, appliedAtMs: open, priorReservePct: floor, applyVerifiedAtMs: open + 60_000 };
    const due = revertDueMs(applied)!;
    const raised = { ...tick, currentReservePct: a.targetPct };
    assert.equal(decideActuation(applied, due - 60_000, raised).kind, 'none', `${c.label}: not a minute before`);
    assert.deepEqual(decideActuation(applied, due, raised), { kind: 'revert', restorePct: floor }, `${c.label}: the restore`);
    assert.deepEqual(decideActuation({ ...applied, cancelled: true }, open + 5 * 60_000, raised), { kind: 'revert', restorePct: floor }, `${c.label}: a cancel after the apply`);
    assert.deepEqual(decideActuation(applied, open + 5 * 60_000, { ...raised, gridPresent: false }), { kind: 'revert', restorePct: floor, gridLossAbort: true });
  }
  assert.ok(n > 150, `${n} armed 21:30 nights`);
});

/* ══ T7 — the pool seed ═════════════════════════════════════════════════════════════════════════════ */

const PANEL_SN = 'PANEL-TEST-1';
const CORES = ['CORE-A', 'CORE-B', 'CORE-C'];
const panel = () => ({
  sn: PANEL_SN, online: true, deviceName: 'Panel', productName: 'SHP2', lastSeenMs: 0,
  projection: { kind: 'shp2', sources: CORES.map((sn) => ({ sn, isConnected: true, fullCap: 30720 })) },
}) as never;
/** The Cores dark: no live reading, so each takes its held ratio (or the lowest known). */
const darkDevices = (): Record<string, never> => ({});
const liveDevices = (ratios: number[]): Record<string, never> => Object.fromEntries(CORES.map((sn, i) => [sn, {
  sn, online: true, projection: { kind: 'dpu', packCount: 1, packs: [{ fullCapMah: 60000 * ratios[i], designCapMah: 60000 }] },
}])) as never;

test('★★★ T7 THE SEED: a tracker with no ratio of its own takes the worker\'s per-Core ratios at their own timestamps — held ×0.944 until they age out, then the lowest known ×0.919, as the runway does; never over a ratio of its own', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ef-cushion-seed-'));
  try {
    const AT = Date.UTC(2026, 9, 15, 8, 54); // 2026-10-15 01:54 MST, the last complete reading
    const seed = join(tmp, 'pool-energy-basis.json');
    writeFileSync(seed, JSON.stringify({ v: 1, cores: { 'CORE-A': { ratio: 0.94, atMs: AT }, 'CORE-B': { ratio: 0.919, atMs: AT }, 'CORE-C': { ratio: 0.973, atMs: AT } },
      panels: { [PANEL_SN]: { scale: 0.5, pendingScale: null, pendingSinceMs: null } } }));
    const own = join(tmp, 'pool-energy-basis-cushion.json');
    const t = new PoolEnergyBasisTracker({ path: own, seedPath: seed });
    const before = t.evaluate(darkDevices(), panel(), AT + 25 * 24 * H);
    assert.equal(before.capacityBasis, 'held');
    assert.equal(Math.round(before.capacityScale * 1e4) / 1e4, Math.round(((0.94 + 0.919 + 0.973) / 3) * 1e4) / 1e4, 'the equal-weight mean, ×0.944');
    assert.ok(Math.abs(before.capacityScale - 0.944) < 0.0005);
    // The seeded entries keep their timestamps: they age out on the worker's schedule.
    const after = t.evaluate(darkDevices(), panel(), AT + HELD_RATIO_MAX_AGE_MS + 60_000);
    assert.deepEqual([after.capacityBasis, after.capacityScale], ['min-known', 0.919]);
    // Read-only: nothing of the seed is written while no live reading comes; the worker's file is never written.
    assert.equal(readFileSync(seed, 'utf8').includes('"scale":0.5'), true);
    assert.throws(() => readFileSync(own, 'utf8'), 'no file of its own until a live reading');
    // A live complete map: measured at once (this tracker had no applied figure to hold against), and persisted then.
    const live = t.evaluate(liveDevices([0.95, 0.95, 0.95]), panel(), AT + HELD_RATIO_MAX_AGE_MS + 120_000);
    assert.deepEqual([live.capacityBasis, Math.round(live.capacityScale * 1e4) / 1e4], ['measured', 0.95]);
    assert.ok(readFileSync(own, 'utf8').includes('0.95'));
    // The panels' figures are never seeded (the worker's 0.5 would have been an applied figure to hold under).
    assert.ok(live.capacityScale > 0.5);
    // A tracker with any ratio of its own is never seeded.
    const own2 = join(tmp, 'own2.json');
    writeFileSync(own2, JSON.stringify({ v: 1, cores: { 'CORE-A': { ratio: 0.99, atMs: AT + 29 * 24 * H } }, panels: {} }));
    const t2 = new PoolEnergyBasisTracker({ path: own2, seedPath: seed });
    const b2 = t2.evaluate(darkDevices(), panel(), AT + 29 * 24 * H + 60_000);
    assert.deepEqual([b2.capacityBasis, b2.capacityScale], ['min-known', 0.99], 'its own ratio for A, the lowest known — its own — for B and C: never the seed\'s');
    // A missing or corrupt seed seeds nothing: nameplate, as before (and the cushion-only plan counts its pool on the floor).
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{not json');
    for (const p of [bad, join(tmp, 'missing.json')]) {
      const t3 = new PoolEnergyBasisTracker({ path: join(tmp, `own-${p.length}.json`), seedPath: p });
      assert.equal(t3.evaluate(darkDevices(), panel(), AT).capacityBasis, 'nameplate', p);
    }
    const flo = plan({ ...darkDeps(REF.deps, 'np'), cushionPoolScale: { scale: 1, basis: 'nameplate' } } as NightChargeInputDeps);
    assert.deepEqual(flo.cushionPoolScale, { scale: CAPACITY_SCALE_MIN, basis: 'floor' });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

/* ══ T8 — the ledger and the scorer ═════════════════════════════════════════════════════════════════ */

test('★★★ T8 THE LEDGER: cushion_only_refused_by, written unconditionally by recordNightPlanRow (null on a full plan and on a refusal), in the allowlist and the column add; round-trip', async () => {
  const fn = INDEX.slice(INDEX.indexOf('function recordNightPlanRow('), INDEX.indexOf('\n}\n', INDEX.indexOf('function recordNightPlanRow(')));
  assert.equal(fn.split('    cushion_only_refused_by: plan.cushionOnly?.refusedBy ?? null,\n').length - 1, 1);
  const recSrc = readFileSync(resolve(HERE, '../src/recorder.ts'), 'utf8');
  assert.ok(recSrc.includes("  'cushion_only_refused_by',\n"), 'the allowlist the upsert reads');
  assert.ok(recSrc.includes("    'cushion_only_refused_by TEXT',\n"), 'the column add for a deployed ledger');
  const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-cushion-only-'));
  process.env.DB_PATH = join(tmp, 'ecoflow.db');
  const { createRecorder } = await import('../src/recorder.js');
  const { SnapshotStore } = await import('../src/snapshot.js');
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const base = (d: string) => ({ plan_date: d, issued_at_ms: 1, algo_version: '3', posture: 'supervised', objective: 'resilience_cushion', rationale: 'x',
      confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 17, target_soc_pct: 28.4, buy_kwh: 12, required_extra_kwh: 11,
      reserve_floor_pct: 16, cushion_pct: 15, cushion_kwh: 10.4, binding_cap: 'requirement', cushion_shortfall: 0, pool_full_kwh: 92.16 });
    rec.recordNightPlan({ ...base('2026-11-09'), cushion_only_refused_by: SOLAR_REFUSAL_0 } as never);
    rec.recordNightPlan(base('2026-11-02') as never);
    const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
    assert.equal(at('2026-11-09').cushion_only_refused_by, SOLAR_REFUSAL_0);
    assert.equal(at('2026-11-02').cushion_only_refused_by, null, 'an older row reads null');
    rec.recordNightPlan({ ...base('2026-11-09'), issued_at_ms: 2, cushion_only_refused_by: null } as never);
    assert.equal(at('2026-11-09').cushion_only_refused_by, null, 'a re-issued full plan clears it');
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('★★★ T8 THE SCORER: a cushion-only row is never scored, before the held branch and in every outcome, with its own note (the held marker kept); its realized verdict stands, and a close under its line is a strike that no cushion-only night clears', () => {
  const score = INDEX.slice(INDEX.indexOf('function scoreNightRow('), INDEX.indexOf('\nfunction ', INDEX.indexOf('function scoreNightRow(') + 10));
  const branch = '  } else if (y.cushion_only_refused_by != null) {';
  const at = score.indexOf(branch);
  assert.ok(at > 0 && at > score.indexOf('if (!hadBasis) {') && at < score.indexOf('} else if (heldVerdict != null) {'), 'right after the basis branch, before the held, coverage and actuals branches');
  assert.ok(score.includes('    scoreNotes = cushionOnlyNote(heldVerdict, deviceNameOf, y.cushion_only_refused_by);\n'));
  // Nothing in it sets the realized need or the score: they stay null and 0.
  const body = score.slice(at, score.indexOf('} else if (heldVerdict != null) {'));
  assert.doesNotMatch(body, /scored = 1|realizedNeedBuyKwh =/);
  assert.equal(cushionOnlyNote(null, (s) => s, SOLAR_REFUSAL_0),
    `not scored — a cushion-only plan (no solar basis: ${SOLAR_REFUSAL_0}): its buy was sized on the outage cushion at the window close with no solar credited, so the planner-sizing metric has no solar forecast to grade.`);
  const held = cushionOnlyNote({ pv: [{ sn: 'C1', heldMs: 3 * H }], load: [] } as never, () => 'Core 1', SOLAR_REFUSAL_0);
  assert.ok(held.includes(` Also ${HELD_TELEMETRY_MARKER}: PV — Core 1 3.0 h of the 24 h span`), held);
  assert.notEqual(held.split(BASIS_INCOMPLETE_NOTE).length, 2, 'not the incomplete-basis note');
  // The gate: scored 0, so out of the actuated pool (graduation, under-buy, the strike-clearing streak) — but a realized close under
  // the line on an actuated night is a strike all the same.
  const NOW = Date.UTC(2026, 10, 20, 4, 30);
  const DAY = 86_400_000;
  const ymd = (ms: number) => new Date(ms - 7 * H).toISOString().slice(0, 10);
  const row = (d: number, f: Record<string, unknown>) => ({
    plan_date: ymd(NOW - d * DAY), algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast', issued_at_ms: NOW - d * DAY, outcome_captured_at_ms: NOW - (d - 1) * DAY,
    scored: 0, actuated: 1, cushion_shortfall: 0, plan_traj_floor_breached: 0, reserve_floor_pct: 16, cushion_pct: 15, cushion_line_soc_pct: 27.94,
    window_kind: 'overnight', grid_home_coverage_frac: 0.95, cushion_only_refused_by: SOLAR_REFUSAL_0, ...f,
  }) as never;
  const struck = computeNightChargeReadiness([row(3, { window_close_soc_pct: 27, actual_min_soc_pct: 27, cushion_breached: 1 })], NOW);
  assert.equal(struck.metrics.activeStrikes, 1, 'a close under the line is a strike');
  const clean = Array.from({ length: 20 }, (_, i) => row(2 - i / 10, { window_close_soc_pct: 28, actual_min_soc_pct: 28, cushion_breached: 0 }));
  const after = computeNightChargeReadiness([row(25, { window_close_soc_pct: 27, actual_min_soc_pct: 27, cushion_breached: 1 }), ...clean], NOW);
  assert.equal(after.metrics.actuatedNights, 0, 'no cushion-only night joins the actuated pool');
  assert.equal(after.metrics.strikeFreeStreak, 0, 'and none advances the strike-clearing streak');
  assert.equal(after.metrics.activeStrikes, 1);
});

/* ══ T9 — the texts ═══════════════════════════════════════════════════════════════════════════════════ */

const shapes = (): Array<[string, NightChargePlan, NightChargeInputDeps]> => {
  const out: Array<[string, NightChargePlan, NightChargeInputDeps]> = [];
  const add = (name: string, d: NightChargeInputDeps) => out.push([name, plan(d), d]);
  add('charge', refDark());
  add('charge, low pool', refDark({ socNowPct: 18 }));
  add('hold (the line holds)', refDark({ socNowPct: 90, ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 } }));
  add('toward (the charge rate)', refDark({ socNowPct: 18, chargeCapKw: 1.5 }));
  add('a line above 50', refDark({ outageCushionHours: 12 }));
  add('a line above 50, the reserve reading 50', refDark({ outageCushionHours: 12, reserveFloorPct: 50 }));
  add('the floor', { ...darkDeps(REF.deps, 'np') } as NightChargeInputDeps);
  return out;
};

test('★★★ T9 THE TEXTS: rationale, push and card on every cushion-only shape — the disclosure always, "no PV" never "P10 PV", no confidence tier, the basis sentence; server and card word for word', () => {
  for (const [name, p, d] of shapes()) {
    assert.ok(p.cushionOnly != null, name);
    assert.equal(cushionOnlyFills(p.cushionOnly!, p), false, `${name}: no long-gap fill`);
    const tail = cushionOnlyText(p.cushionOnly!, p as never);
    assert.ok(p.rationale.endsWith(tail), `${name}: the rationale closes with the disclosure`);
    assert.match(tail, /^ OUTAGE CUSHION ONLY; NO SOLAR BASIS: the solar basis is refused \(only 0 scored calibration day\(s\), need 4 [^]*\), so this plan is sized only to hold the outage cushion at the window close — no solar is credited, no solar calibration is used, and no cost target or mid-day charge is planned\./);
    assert.doesNotMatch(p.rationale, /P10 PV/, name);
    if (p.chargeTonight) assert.ok(p.rationale.includes(`Sized on an islanded worst case (${NO_PV_WORST_CASE_BASIS.replace(', no grid', " and the Cores' ~270 W standby, no grid")})`), name);
    // The card says the same, word for word: its sizing line and its hold detail.
    const card = web.cushionOnlyCardText(p.cushionOnly as never, p as never);
    assert.equal(card, tail, `${name}: the card's disclosure`);
    if (p.chargeTonight) {
      assert.equal(web.sizingLine(p as never), `${sizingBasisText(p.buyKwhDebiased, '', 270, true)}.${tail}`, `${name}: the card's sizing line`);
    } else {
      assert.ok(web.holdSummary(p as never).detail.endsWith(tail), `${name}: the card's hold detail`);
    }
    // The push: the basis sentence, never a confidence tier, never "P10 PV".
    const sup = { cancelDeadlineText: 'at 11:00 PM', targetPct: written(p) ?? 0 };
    const shape = p.chargeTonight ? 'charge' : 'hold';
    for (const msg of [buildNightChargeMessage(p, shape, p.chargeTonight ? sup : null), buildNightChargeMessage(p, shape, null)]) {
      assert.doesNotMatch(msg.body, /Confidence:|P10 PV|Whole-house island projection/, `${name}: ${msg.body}`);
      assert.ok(msg.body.includes('Outage cushion only; no solar basis (only 0 scored calibration day(s)'), `${name}: ${msg.body}`);
      if (p.chargeTonight) assert.ok(msg.title.endsWith(' — outage cushion only'), msg.title);
    }
    if (p.chargeTonight && !p.forceChargeLine) {
      const body = buildNightChargeMessage(p, 'charge', sup).body;
      assert.ok(body.includes(`: the ${Math.round(p.cushionLineSocPct! * 10) / 10}% line is the 16% reserve floor plus 4 h of islanded backup load at the window close, with no solar credited and no cost target.`), body);
    }
    // A refused arm keeps its words and adds the basis. v1.205.1 (round 3, F5) — straight after its lead, every NOTE after it (the
    // refused note of v1.205.0, the unheld floor+cushion line of v1.205.1), as the armed push orders its notes after its basis sentence.
    const refused = buildNightChargeMessage(p, 'charge', null, 'the 2026-10-11 reserve write is still applied and not yet restored');
    if (p.chargeTonight) {
      const basis = ` tonight. Outage cushion only; no solar basis (${p.cushionOnly!.refusedBy}).`;
      const after = refused.body.split(basis);
      assert.ok(after.length === 2 && (after[1] === '' || after[1].startsWith(' NOTE: ')), refused.body);
    }
  }
  // The expected clause and the island-low reference credit no solar.
  const c = plan(refDark({ socNowPct: 18 }));
  assert.match(c.rationale, /with the grid present \(median load and the Cores' standby, no solar credited, never below the 16% reserve\)/);
  assert.match(c.rationale, /without the buy a whole-house island with no solar credited would trough at/);
  const h = plan(refDark({ socNowPct: 90, ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 } }));
  assert.equal(h.chargeTonight, false);
  assert.match(h.rationale, /For reference, a whole-house island with no solar credited would trough at ~[\d.]+%, which is not what the cushion is sized against\./);
  const shortfall = plan(refDark({ socNowPct: 18, chargeCapKw: 1.5 }));
  assert.ok(shortfall.cushionShortfall && /^Charge toward ~/.test(shortfall.rationale) && shortfall.rationale.includes(' NOTE: charge/pool caps prevent fully meeting the cushion — residual risk remains.'),
    'a night the window cannot carry keeps its "toward" and its caps note beside "sized only to hold"');
});

test('★★ T9 the card\'s stats name the basis, not a confidence tier, and the island low credits no PV (source pins)', () => {
  const card = readFileSync(resolve(HERE, '../../web/src/cards/NightChargeCard.tsx'), 'utf8');
  // v1.204.0 — the sub is the panel basis's words where its readings were refused ("no solar basis · panel solar refused",
  // panelBasisStat), else "no solar basis" as before; the window after it (withWindow).
  assert.ok(card.includes("        {plan.cushionOnly != null\n          ? <Stat label=\"Basis\" value={cushionOnlyBasisValue(plan.cushionOnly, plan)} sub={withWindow(pvStat?.sub ?? 'no solar basis')} />\n          : pvStat != null"));
  assert.ok(card.includes("const withWindow = (sub: string): string => (ws && we ? `${sub} · ${ws}–${we}` : sub);"));
  // The value: the cushion only, or on the long-gap fill the cushion and the fill (never "cushion only" of a night that fills).
  const co = { longGapAfter: true };
  assert.equal(web.cushionOnlyBasisValue({ longGapAfter: false }, { longGapAhead: false, costCeilingSocPct: null }), 'cushion only');
  assert.equal(web.cushionOnlyBasisValue(co, { longGapAhead: undefined, costCeilingSocPct: null }), 'cushion only', 'a resilience-mode long gap holds the cushion only');
  assert.equal(web.cushionOnlyBasisValue(co, { longGapAhead: true, costCeilingSocPct: 90 }), 'cushion + long-gap fill');
  assert.ok(card.includes("sub={plan.cushionOnly != null ? 'if the grid were lost · no PV / P90 load' : 'if the grid were lost · P10 PV / P90 load'}"));
});

/* ══ T11 / T13 — source pins ═══════════════════════════════════════════════════════════════════════ */

test('★★★ T11 the flag is passed once, on the live overnight plan alone: never a shadow leg, never advisory mode, never a stale panel', () => {
  assert.equal(INDEX.split('cushionOnlyEligible:').length - 1, 1);
  assert.ok(INDEX.includes('    cushionOnlyEligible: shadowLeg == null && lineForceChargeOn(legRole) && panel.fresh,\n'));
  // The log line, on change only: the long-gap fill named, never "the outage cushion only" of a night that fills.
  assert.ok(INDEX.includes("tonight's plan is sized on the outage cushion at the window close${coFills ? ' and the long-gap fill' : ' alone'}, with no solar credited`"));
  assert.ok(INDEX.includes('    const coFills = plan.cushionOnly != null && cushionOnlyFills(plan.cushionOnly, plan);\n'));
  // advisory: lineForceChargeOn is the write mode's gate.
  assert.ok(INDEX.includes("const lineForceChargeOn = (role: ChargeLegRole = 'cost'): boolean => legForceChargeEligible(role, lineForceChargeEnabled({ mode: NIGHT_CHARGE_MODE }));"));
});

test('★★★ T13 a stale panel at the deferral\'s last resort: no fallback (panel.fresh), and the NOTE of a refused plan names no plan sized on it', () => {
  assert.ok(INDEX.includes("      : ` NOTE: the panel reading is ${panel.ageMs != null ? `~${Math.round(panel.ageMs / 60_000)} min old` : 'of unknown age'} (${panel.why}); it did not recover before the deferral deadline, and no cushion-only plan is made on it.`;"));
  assert.ok(INDEX.includes('    plan.rationale += plan.basisComplete\n'));
});

/* ══ T12 — the evening deferral ══════════════════════════════════════════════════════════════════ */

test('★★★ T12 THE EVENING: a cushion-only plan made on a transient refusal waits to the deferral end (the 22:30 last resort), as a refused one does; on a persistent one it is decided at 21:30', () => {
  const t = plan(refDark());
  assert.equal(t.cushionOnly!.transient, true);
  assert.equal(eveningBasisDefers(t, 21 * 60 + 30), true, 'deferred at 21:30');
  assert.equal(eveningBasisDefers(t, NIGHT_PLAN_STALE_DEFER_UNTIL_MIN), false, 'the 22:30 last resort');
  const p = plan(refDark({ calScoredDays: 9, provisionalMinCalScoredDays: undefined }));
  assert.equal(p.cushionOnly!.transient, false);
  assert.equal(eveningBasisDefers(p, 21 * 60 + 30), false, 'decided at once');
  // A refused fallback keeps the solar refusal's transience: the deferral as before.
  assert.equal(eveningBasisDefers(plan(refDark({ islandedLoadKw: null })), 21 * 60 + 30), true);
  assert.equal(eveningBasisDefers(plan(refDark({ calScoredDays: 9, provisionalMinCalScoredDays: undefined, islandedLoadKw: null })), 21 * 60 + 30), false);
  // The full plan is unchanged: a sized plan never defers.
  assert.equal(eveningBasisDefers(plan(REF.deps), 21 * 60 + 30), false);
});

/* ══ T14 — the dark year's figures ══════════════════════════════════════════════════════════════════ */

test('★★★ T14 THE DARK YEAR, case by case: every basis\'s token as measured (cushionOnlyFigures.json)', () => {
  assert.equal(FIG.cases, CASES.length);
  assert.ok(FIG.generatedAt.startsWith('v1.203.0'));
  const now = darkFigures();
  for (const b of Object.keys(DARK_BASES) as DarkBasis[]) {
    const a = FIG.bases[b].split(','), z = now[b].split(',');
    const moved = a.map((t, i) => (t === z[i] ? null : `${CASES[i].label}: ${t} → ${z[i]}`)).filter((x) => x != null);
    assert.deepEqual(moved.slice(0, 5), [], `${b}: ${moved.length} moved`);
  }
  // Spot one by hand: the live-shaped resilience night, dark, on the held ratio.
  const deps = darkDeps(REF.deps, 'held');
  assert.equal(darkToken(plan(deps), deps), FIG.bases.held.split(',')[CASES.indexOf(REF)]);
});

/* ══ T15 — Friday's long gap (owner, 2026-11-08) ══════════════════════════════════════════════════════ */

test('★★★ T15 FRIDAY: before a gap of more than a day after its window, a cost-mode cushion-only night takes the long-gap fill — the ceiling at ARB_COST_MAX_SOC_PCT, the solar headroom set aside — through the cost force-charge; in resilience mode it holds the cushion only, and both say so', () => {
  let costFill = 0, resilience = 0, thursday = 0;
  for (const c of CASES) {
    const deps = darkDeps(c.deps, 'held');
    const p = plan(deps);
    if (p.cushionOnly == null) continue;
    const i = buildNightChargeInputs(deps);
    const gap = deps.nextRechargeMs == null ? null : deps.nextRechargeMs - p.window!.endMs;
    assert.equal(p.cushionOnly.gapAfterMs, gap, c.label);
    assert.equal(p.cushionOnly.longGapAfter, gap == null || gap > LONG_GAP_MS, c.label);
    if (!p.cushionOnly.longGapAfter) {
      // Thursday's full window before Friday's short one: the gap after it is 18 h, so no fill and no gap clause.
      if (new Date(p.window!.startMs - 7 * H).getUTCDay() === 4) thursday += 1;
      assert.doesNotMatch(p.rationale, /after this one closes/, c.label);
      continue;
    }
    assert.ok(p.rationale.includes(gapAfterWindowText(p.cushionOnly.gapAfterMs).slice(1)), c.label);
    if (deps.objectiveMode === 'cost') {
      assert.equal(i.objectiveMode, 'cost');
      assert.deepEqual([i.longGapAhead, i.prePeakPvSurplusP10Kwh, i.morningPvSurplusP50Kwh], [true, null, null], `${c.label}: solar-free`);
      assert.equal(p.costCeilingSocPct, deps.costMaxSocPct ?? 90, `${c.label}: the owner's ceiling, no solar headroom`);
      assert.equal(p.costCeilingSurplusBasis, 'none');
      assert.ok(p.rationale.includes(`Before the gap (${gapAfterWindowText(p.cushionOnly.gapAfterMs)}) tonight's cost target is the long-gap fill: the ${p.costCeilingSocPct}% state-of-charge ceiling, with the solar headroom set aside.`), p.rationale);
      // Sized on the cushion AND the fill: no text of it says "outage cushion only" or "sized only to hold the outage cushion".
      assert.equal(cushionOnlyFills(p.cushionOnly, p), true, c.label);
      const tail = cushionOnlyText(p.cushionOnly, p as never);
      assert.ok(p.rationale.endsWith(tail) && tail.startsWith(` NO SOLAR BASIS; THE OUTAGE CUSHION AND THE LONG-GAP FILL: the solar basis is refused (${p.cushionOnly.refusedBy}), so this plan is sized only on the outage cushion at the window close and, before the gap, the long-gap fill — no solar is credited, no solar calibration is used, and no mid-day charge is planned. Before the gap (`), tail);
      assert.equal(web.cushionOnlyCardText(p.cushionOnly as never, p as never), tail, `${c.label}: the card word for word`);
      assert.doesNotMatch(p.rationale, /OUTAGE CUSHION ONLY|sized only to hold the outage cushion/, c.label);
      for (const shape of p.chargeTonight ? ['charge'] as const : ['hold'] as const) {
        const m = buildNightChargeMessage(p, shape, p.chargeTonight ? { cancelDeadlineText: 'at 11:00 PM', targetPct: written(p) ?? 50 } : null);
        assert.doesNotMatch(`${m.title} ${m.body}`, /[Oo]utage cushion only/, `${c.label}: ${m.title} ${m.body}`);
        assert.ok(m.body.includes(`No solar basis (${p.cushionOnly.refusedBy})`), m.body);
        if (p.chargeTonight) assert.ok(m.title.endsWith(' — no solar basis, long-gap fill'), m.title);
      }
      if (p.chargeTonight) {
        const body = buildNightChargeMessage(p, 'charge', null).body;
        assert.ok(body.includes('with no solar credited and no cost target but the long-gap fill.') && body.includes(`Before the gap (${gapAfterWindowText(p.cushionOnly.gapAfterMs)}) the cost target is the long-gap fill: the ${p.costCeilingSocPct}% state-of-charge ceiling, with the solar headroom set aside.`), body);
        const refused = buildNightChargeMessage(p, 'charge', null, 'the 2026-10-11 reserve write is still applied and not yet restored').body;
        assert.ok(refused.includes(` No solar basis (${p.cushionOnly.refusedBy}). Before the gap (`) && !/[Oo]utage cushion only/.test(refused), refused);
      }
      if (p.chargeTonight && p.window != null) {
        const a = armFromPlan(emptyActuationState(), c.label, p, deps.nowMs, deps.reserveFloorPct, costGate(c.deps), nextOnPeakStartMs(MODEL, p.window.startMs), true);
        if (a != null && costGate(c.deps)) { costFill += 1; assert.equal(a.forceChargeCeilingPct, p.costCeilingSocPct, `${c.label}: the cost force-charge rides it`); }
      }
    } else {
      resilience += 1;
      assert.equal(i.objectiveMode, 'resilience');
      assert.equal(p.costCeilingSocPct ?? null, null);
      assert.ok(p.rationale.includes('; the cushion is sized for this window\'s close only, and no long-gap fill runs in resilience mode.'), p.rationale);
      // No fill: the cushion only, said so.
      assert.equal(cushionOnlyFills(p.cushionOnly, p), false, c.label);
      assert.ok(p.rationale.includes(' OUTAGE CUSHION ONLY; NO SOLAR BASIS: '), c.label);
    }
  }
  assert.deepEqual({ costFill, resilience, thursday }, PIN_T15);
  // No next charge window within the scan is a long gap too (its length unknown, at least the scan's), said as such.
  const none = plan(refDark({ nextRechargeMs: null }));
  assert.deepEqual([none.cushionOnly?.gapAfterMs, none.cushionOnly?.longGapAfter], [null, true]);
  assert.ok(none.rationale.includes(' No further charge window is found within the tariff scan after this one; the cushion is sized for this window\'s close only, and no long-gap fill runs in resilience mode.'), none.rationale);
});
/** Measured on the dark year at ×0.944 held: 53 cost-mode long-gap nights armed with the cost force-charge (Fridays, and the
 *  holiday eves the tariff calendar makes), 20 resilience-mode long-gap nights that hold the cushion only, and 128 plans of a
 *  Thursday window — whose next window is Friday's, 18 h on — with no fill and no gap clause. */
const PIN_T15 = { costFill: 53, resilience: 20, thursday: 128 };
