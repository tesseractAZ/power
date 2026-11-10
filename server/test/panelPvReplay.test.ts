/**
 * ★★★ v1.204.0 — THE REPLAY THROUGH THE REAL PLANNER, on the specified basis: every recorded dark night 2026-10-16..11-05 (21
 * evenings) through the real selection (panelPvSelection.selectPvBasis on the verdict panelPvBasis.upperCheck computes on the
 * recorded plant, test/fixtures/panelPvRecord.json — nameplate fullCap, the membership-vouched days), the real
 * computeNightChargePlan, armFromPlan and decideActuation, at 21:30, 22:30 and 00:30 — the verdict, the selection and the plan
 * RECOMPUTED at each instant on the data known then (L3), never reused from 21:30.
 *
 * The frame (test/fixtures/panelPvReplayNights.json): each night's recorded pools, loads and islanded load (the v1.203.0 replay's),
 * and the round-2 planning band on the panel-measured basis (its next-24-h P10/P50/P90, the 72-h rollup, its calibration). No
 * worker forecast is replayed (no weather cache of the record): the band is the night's at every instant, said so here.
 *
 * Live settings: cost mode, ceiling 90, floor 16, the held ×0.944 pool scale, the Cores' 270 W standby. The decision time is the
 * real eveningBasisDefers: v1.203.0's cushion-only plan on its transient refusal (0 scored days) is the 22:30 last resort; a plan
 * on the panel's readings is decided at 21:30. Superseded arms (Saturday's arm of the Monday window, which Sunday's replaces) are
 * dropped before any sum (L4).
 *
 * The latch as index.ts reads it (latchedPvBasis): the evening job's own calls (21:30, 22:30) select on none (F1); the 00:30
 * recompute reads the latch the evening wrote (pvLatchOf: its basis, E and the window). A replay may stand an earlier evening's latch
 * at the evening job (Saturday's, for the Monday window Saturday and Sunday share), withhold the night's planning report at an
 * instant, or plant a fault on the record itself, which the balance then sees as a real over-read is seen (F1, V2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, periodIdAt } from './fixtures/legacyIdentityFixtures.js';
import {
  buildNightChargeInputs, computeNightChargePlan, nextFullCheapWindow, longGapAhead, pessimisticPrePeakSurplus, solarBasisGate,
  eveningBasisDefers, OVERNIGHT_WINDOW_SPEC, type NightChargeInputDeps, type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { armFromPlan, decideActuation, emptyActuationState, type NightActuationState } from '../src/nightChargeActuator.js';
import { nextOnPeakStartMs, planDateOwningCycle } from '../src/chargeWindows.js';
import { siteTimeZone } from '../src/siteTime.js';
import { planChargeCapKw } from '../src/nightForceCharge.js';
import { pvSurplusFromBand, surplusSpanEndMs } from '../src/chargeTaper.js';
import { rateAt } from '../src/tariff.js';
import { assembleUcTable, upperCheck, type UcVerdict } from '../src/panelPvBasis.js';
import { latchedPvBasis, selectPvBasis, pvBasisDecoration, withPvBasis, type PvSelection, type PvBasisLatch } from '../src/panelPvSelection.js';
import { recordSources, type RecordOptions } from './fixtures/panelPvRecordFixtures.js';
import { priorArmSuperseded } from '../src/chargeCycle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
interface ReplayNight {
  plan_date: string; nowMs: number; socAt21: number | null; socAt2130: number | null; l50: number; l90: number; islandedKw: number;
  hours: Array<[number, number | null, number | null]>;
  band: Array<[number, number, number, number]>;
  roll: Array<[number, number]>;
  calScoredDays: number; coverage: number | null; realizedHalfFrac: number | null;
}
const NIGHTS = (JSON.parse(readFileSync(resolve(HERE, 'fixtures/panelPvReplayNights.json'), 'utf8')) as { nights: ReplayNight[] }).nights;

const H = 3_600_000;
const LEG = Math.sqrt(0.86);
const FLOOR = 16;
const POOL = 92.16 * 0.944;
const KEYS = ['P#1', 'P#2', 'P#3'];
const capKw = planChargeCapKw(0, 3, LEG);
const isOnPeakAt = (t: number): boolean => rateAt(MODEL, t).isOnPeak;
const NOTIFY_MIN = 21 * 60 + 30;
const minuteOf = (n: ReplayNight, ms: number): number => NOTIFY_MIN + Math.round((ms - n.nowMs) / 60_000);

const plan = (d: NightChargeInputDeps): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(d));
/** The window, the next recharge and the Thursday rule for a recompute at `nowMs` (as index.ts resolves them). */
function withWindow(base: NightChargeInputDeps, nowMs: number, soc: number): NightChargeInputDeps {
  const d0 = { ...base, nowMs, socNowPct: Math.round(soc) } as NightChargeInputDeps;
  const w = plan(d0).window;
  let nr: number | null = null;
  if (w) for (let t = w.endMs + H; t < w.endMs + 96 * H; t += H) { if (periodIdAt(t) === 'overnight' && periodIdAt(t - H) !== 'overnight') { nr = t; break; } }
  const d2 = { ...d0, nextRechargeMs: nr } as NightChargeInputDeps;
  if (w) (d2 as { longGapAhead?: boolean }).longGapAhead = longGapAhead(w, nextFullCheapWindow(periodIdAt, w.endMs, 'overnight'));
  return d2;
}
function arm(p: NightChargePlan, d: NightChargeInputDeps, day: string): { a: NightActuationState | null; write: number | null; fc: number | null } {
  const costOn = d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50;
  const w = p.window;
  const a = armFromPlan(emptyActuationState(), day, p as never, d.nowMs, FLOOR, costOn, w ? nextOnPeakStartMs(MODEL, w.startMs) : null, true);
  let write: number | null = null;
  if (a && w) {
    const act = decideActuation(a, w.startMs, { mode: 'supervised', writeReady: false, currentReservePct: FLOOR, socCoherent: true, vitalsRed: false, gridPresent: true });
    if (act.kind === 'apply') write = act.targetPct;
  }
  return { a, write, fc: a?.forceChargeCeilingPct ?? null };
}

interface NightOut {
  date: string;
  verdict: UcVerdict;
  sel: PvSelection;
  /** v1.203.0: the plan of record (22:30) and its armed record. */
  a: { plan: NightChargePlan; arm: ReturnType<typeof arm>; at: '22:30' };
  /** v1.204.0: the plan of record, its decision time and armed record, and the basis read at each of the three instants. */
  b: {
    plan: NightChargePlan; arm: ReturnType<typeof arm>; at: '21:30' | '22:30'; kinds: Array<string | null>; setpoints: Array<number | null>;
    /** The selection at 21:30, 22:30 and 00:30, the latch latchedPvBasis read at each, and the latch the evening wrote. */
    sels: PvSelection[]; latchAt: Array<ReturnType<typeof latchedPvBasis>>; own: ReplayLatch | null;
  };
}

/** The latch file as an evening left it (index.ts NightChargeLatch): its day, its basis, and the armed record's day and window. */
interface ReplayLatch { lastNotifyDay: string; pv: PvBasisLatch | null; armed: { day: string | null; windowStartMs: number | null } }
interface ReplayOpts {
  /** A fault on the record itself (panelPvRecordFixtures' `fault`: the field and the panel's daily total alike), which the balance sees. */
  ro?: Partial<RecordOptions>;
  /** The latch standing when the evening job runs (an earlier evening's); absent: none governs this window. */
  prior?: ReplayLatch;
  /** Whether the night's planning report (and its rollup) is available at an instant; absent: always. */
  planningAt?: (tMs: number) => boolean;
}

/** One night, both versions; `scale` multiplies the planning band (a field reading high by that factor). */
function replay(n: ReplayNight, objective: 'cost' | 'resilience' = 'cost', scale = 1, o: ReplayOpts = {}): NightOut {
  const byTs = new Map(n.hours.map(([ts, loadW, lvl]) => [ts, { loadW, lvl }]));
  const act24 = n.hours.slice(1, 25).reduce((s, h) => s + (h[1] ?? 1700), 0) / 1000;
  const k50 = n.l50 / act24;
  const k90 = n.l90 / n.l50;
  const soc2130 = Math.round(((n.socAt21 ?? n.socAt2130)! + (n.socAt2130 ?? n.socAt21)!) / 2);
  const t21 = n.nowMs, t22 = n.nowMs + H, t00 = n.nowMs + 3 * H;
  const l22 = byTs.get(t22 - H / 2)?.lvl, l23 = byTs.get(t22 + H / 2)?.lvl;
  const soc2230 = l22 != null && l23 != null ? (l22 + l23) / 2 : soc2130;
  const soc2300 = l23 ?? soc2230;
  const loadAt = (ts: number): number => (byTs.get(ts)?.loadW ?? 1700) * k50;
  const bandTs = n.band.map((b) => b[0]);
  // The PUBLISHED deps, as v1.203.0 reads the dark plant: no scored day, a PV band of 0 — the cushion-only plan.
  const base: NightChargeInputDeps = {
    nowMs: t21, fullKwh: 92.16, socNowPct: soc2130, reserveFloorPct: FLOOR, cushionPct: 15, socCoherent: true,
    islandedLoadKw: Math.round(n.islandedKw * 100) / 100, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: objective, costMaxSocPct: 90, cushionPoolScale: { scale: 0.944, basis: 'held' }, cushionStandbyW: 270,
    legEff: LEG, dischargeEff: 0.94, chargeCapKw: capKw, gridInputCapKw: 17,
    periodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: bandTs.map((ts) => ({ ts, pvP10W: 0, pvP50W: 0, loadP90W: loadAt(ts) * k90, embeddedEvW: 0, loadP50W: loadAt(ts) })),
    dayRollups: [0, 1, 2].map((i) => ({ daysAhead: i + 1, hours: n.roll.slice(i * 24, (i + 1) * 24).map(([ts]) => ({ ts, pvW: 0, loadW: loadAt(ts) })) })),
    realizedDailyErrHalfFrac: 0, nextRechargeMs: null,
    ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 }, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 0, minCalScoredDays: 14, provisionalMinCalScoredDays: 4, bandCoverageFrac: 0,
    morningPvSurplusP90Kwh: 0, morningPvSurplusP50Kwh: 0, longGapAhead: false, prePeakPvSurplusP10Kwh: 0, costSurplusLoad: null,
    minBuyKwh: 1, buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: objective === 'cost', lineForceChargeEligible: true,
    cushionOnlyEligible: true, cushionOnlyFloorScale: 0.8, windowSpec: OVERNIGHT_WINDOW_SPEC,
  } as NightChargeInputDeps;
  const gateOf = (calScoredDays: number, coverage: number) => solarBasisGate({
    forecastPresent: true, confidenceTier: 'forecast', calScoredDays, minCalScoredDays: 14, provisionalMinCalScoredDays: 4, bandCoverageFrac: coverage,
  });
  const band = n.band.map(([ts, p10W, p50W, p90W]) => ({ ts, p10W: p10W * scale, p50W: p50W * scale, p90W: p90W * scale }));
  /** The PLANNING deps: the same night on the round-2 band (index.ts takes every PV read from the selected band). */
  const w21 = plan(withWindow(base, t21, soc2130)).window!;
  const planningDeps = (b: NightChargeInputDeps): NightChargeInputDeps => {
    // (A Friday's 1-h window has closed by 00:30: the surplus is still summed from the evening's window, as plans3.ts did.)
    const w = plan(b).window ?? w21;
    const sur = pvSurplusFromBand({ hours: band, loadAt: (ts) => loadAt(ts), fromMs: w.endMs, toMs: surplusSpanEndMs('overnight', w.endMs, null) });
    const prePeak = pessimisticPrePeakSurplus({ hours: band.map((x) => ({ ts: x.ts, p10W: x.p10W, loadW: loadAt(x.ts) })), windowEndMs: w.endMs, isOnPeakAt }).kwh;
    return {
      ...b,
      bandHours: band.map((x) => ({ ts: x.ts, pvP10W: x.p10W, pvP50W: x.p50W, loadP90W: loadAt(x.ts) * k90, embeddedEvW: 0, loadP50W: loadAt(x.ts) })),
      dayRollups: [0, 1, 2].map((i) => ({ daysAhead: i + 1, hours: n.roll.slice(i * 24, (i + 1) * 24).map(([ts, pvW]) => ({ ts, pvW: pvW * scale, loadW: loadAt(ts) })) })),
      calScoredDays: n.calScoredDays, bandCoverageFrac: n.coverage ?? 0, realizedDailyErrHalfFrac: n.realizedHalfFrac ?? 0,
      morningPvSurplusP90Kwh: sur.p90Kwh, morningPvSurplusP50Kwh: sur.p50Kwh, prePeakPvSurplusP10Kwh: prePeak,
    } as NightChargeInputDeps;
  };
  const E = n.plan_date;
  /** v1.204.0 at an instant: the verdict as of E on the data known then, the selection, the deps it selects, the plan. `arming`: the
   *  evening job's own call, which selects on no latch (index.ts F1); else the latch file `latch` governs as latchedPvBasis reads it. */
  const at = (t: number, soc: number, arming: boolean, latch: ReplayLatch | null) => {
    const v = upperCheck(assembleUcTable(recordSources(E, { knownAtMs: t, ...o.ro }), E).table, E);
    const d0 = withWindow(base, t, soc);
    const w = plan(d0).window;
    const here = latch == null || w == null ? null : latchedPvBasis({
      lastNotifyDay: latch.lastNotifyDay, pv: latch.pv, noDecision: false, windowStartMs: w.startMs, windowEndMs: w.endMs, nowMs: t,
      planDate: planDateOwningCycle({ nowMs: t, firstLegStartMs: w.startMs, timezone: siteTimeZone(), notifyMinuteOfDay: NOTIFY_MIN }),
      armed: latch.armed,
    });
    const avail = o.planningAt?.(t) ?? true;
    const sel = selectPvBasis({
      asOfDay: E, eligible: { writeMode: true, panelFresh: true, cancelled: false }, latched: arming ? null : here,
      published: { gate: gateOf(0, 0), uncoveredSlots: [1, 2, 3] },
      planning: avail ? { asOfDay: E, keys: KEYS, verdict: v, gate: gateOf(n.calScoredDays, n.coverage ?? 0) } : null,
      planningRollupOk: avail, connectedKeys: KEYS, ratioKnown: true,
    });
    const d = sel.use === 'planning' ? withWindow(planningDeps(d0), t, soc) : d0;
    const p = plan(d);
    const out = withPvBasis(p, pvBasisDecoration({
      sel, asOfDay: E, plan: { sized: p.basisComplete && p.requiredExtraKwh != null, cushionOnly: p.cushionOnly != null },
      calScoredDays: d.calScoredDays, admittedDays: null,
    }));
    return { v, sel, d, p: out, here };
  };
  // v1.203.0: the published deps, its transient refusal deferring to the 22:30 last resort.
  const dA21 = withWindow(base, t21, soc2130);
  const A21 = plan(dA21);
  assert.equal(eveningBasisDefers(A21, minuteOf(n, t21)), true, `${E}: v1.203.0 waits its transient refusal out`);
  const dA22 = withWindow(base, t22, soc2230);
  const A22 = plan(dA22);
  const armA = arm(A22, dA22, E);
  // v1.204.0: decided at 21:30 unless eveningBasisDefers holds it to 22:30 — the evening job's own calls, with the latch standing then.
  const prior = o.prior ?? null;
  const b21 = at(t21, soc2130, true, prior);
  const b22 = at(t22, soc2230, true, prior);
  const decided = eveningBasisDefers(b21.p, minuteOf(n, t21)) ? { ...b22, at: '22:30' as const } : { ...b21, at: '21:30' as const };
  const armB = arm(decided.p, decided.d, E);
  // The latch the evening writes (index.ts pvLatchOf): the basis it chose, as of E, with its window.
  const wD = decided.p.window;
  const own: ReplayLatch | null = wD == null ? null : {
    lastNotifyDay: E, armed: { day: armB.a ? E : null, windowStartMs: armB.a ? wD.startMs : null },
    pv: { basis: decided.sel.use === 'planning' ? 'planning' : 'published', asOfDay: E, windowStartMs: wD.startMs, windowEndMs: wD.endMs },
  };
  // 00:30: the pool after 1.5 h of the armed reserve from 23:00 (charged toward it at the plan's cap, else drained toward it).
  const walk = (target: number | null): number => {
    const ld = (loadAt(t22 + H / 2) / 0.94 + 270) / 1000;
    if (target != null && target > soc2300) return Math.min(target, soc2300 + 1.5 * capKw * LEG / POOL * 100);
    return Math.max(target ?? FLOOR, soc2300 - 1.5 * ld / POOL * 100);
  };
  const b00 = at(t00, walk(armB.write), false, own);
  const kindOf = (p: NightChargePlan): string | null => (p.window == null ? null : p.cushionOnly ? 'cushion-only' : p.basisComplete ? 'panel' : 'none');
  return {
    date: E, verdict: b21.v, sel: b21.sel,
    a: { plan: A22, arm: armA, at: '22:30' },
    b: {
      plan: decided.p, arm: armB, at: decided.at, kinds: [b21.p, b22.p, b00.p].map(kindOf), setpoints: [b21.p, b22.p, b00.p].map((p) => p.setpointSocPct ?? null),
      sels: [b21.sel, b22.sel, b00.sel], latchAt: [b21.here, b22.here, b00.here], own,
    },
  };
}

const COST = NIGHTS.map((n) => replay(n));
/** Saturday's arm of the Monday window is superseded by Sunday's (index.ts priorArmSuperseded): dropped before any sum (L4). */
const superseded = (date: string): boolean => new Date(`${date}T12:00:00Z`).getUTCDay() === 6;
const r2 = (x: number): number => Math.round(x * 100) / 100;

test('★★★ the replay: 12 refused nights (10-16..10-27) and 9 panel nights (10-28..11-05), the armed write and force-charge of each, and the decision time', () => {
  // [date, v1.203.0 write/fc, v1.204.0 basis, write/fc, decided]
  const want: Array<[string, string, string, string, string]> = [
    ['2026-10-16', '50/90', 'cushion-only', '50/90', '22:30'],
    ['2026-10-17', '31/—', 'cushion-only', '31/—', '22:30'],
    ['2026-10-18', '32/—', 'cushion-only', '32/—', '22:30'],
    ['2026-10-19', '32/—', 'cushion-only', '32/—', '22:30'],
    ['2026-10-20', '32/—', 'cushion-only', '32/—', '22:30'],
    ['2026-10-21', '32/—', 'cushion-only', '32/—', '22:30'],
    ['2026-10-22', '32/—', 'cushion-only', '32/—', '22:30'],
    ['2026-10-23', '50/90', 'cushion-only', '50/90', '22:30'],
    ['2026-10-24', '32/—', 'cushion-only', '32/—', '22:30'],
    ['2026-10-25', '31/—', 'cushion-only', '31/—', '22:30'],
    ['2026-10-26', '30/—', 'cushion-only', '30/—', '22:30'],
    ['2026-10-27', '30/—', 'cushion-only', '30/—', '22:30'],
    ['2026-10-28', '30/—', 'panel', '50/80.4', '21:30'],
    ['2026-10-29', '29/—', 'panel', '50/90', '21:30'],
    ['2026-10-30', '50/90', 'panel', '50/79.1', '21:30'],
    ['2026-10-31', '29/—', 'panel', '50/90', '21:30'],
    ['2026-11-01', '30/—', 'panel', '50/71.7', '21:30'],
    ['2026-11-02', '30/—', 'panel', '50/71.6', '21:30'],
    ['2026-11-03', '—/—', 'panel', '50/75.6', '21:30'],
    ['2026-11-04', '—/—', 'panel', '50/67.7', '21:30'],
    ['2026-11-05', '30/—', 'panel', '50/81.5', '21:30'],
  ];
  const fmt = (x: { write: number | null; fc: number | null }): string => `${x.write ?? '—'}/${x.fc == null ? '—' : r2(x.fc)}`;
  const got = COST.map((o) => [o.date, fmt(o.a.arm), o.b.kinds[0] ?? 'none', fmt(o.b.arm), o.b.at]);
  assert.deepEqual(got, want);
  // The verdicts: refused by the count until 10-27, passing from 10-28.
  for (const o of COST) {
    if (o.date <= '2026-10-27') {
      assert.equal(o.verdict.state, 'refused', o.date);
      assert.equal(o.verdict.reason?.code, 'too-few-field-days', o.date);
      assert.equal(o.sel.use, 'published');
    } else {
      assert.equal(o.verdict.state, 'pass', o.date);
      assert.equal(o.sel.use, 'planning');
      assert.equal(o.b.plan.pvBasis, 'panel');
    }
  }
});

test('★★★ every refused night is byte-identical to v1.203.0 in the armed record (12/12), and its plan but for the one appended sentence and the pvBasis* fields', () => {
  let n = 0;
  for (const o of COST.filter((x) => x.sel.use === 'published')) {
    n++;
    assert.deepEqual(o.b.arm.a, o.a.arm.a, `${o.date}: the armed record`);
    assert.equal(o.b.arm.write, o.a.arm.write);
    assert.equal(o.b.plan.rationale, o.a.plan.rationale + o.b.plan.pvBasisText, o.date);
    assert.match(o.b.plan.pvBasisText!, /^ The panel's own solar readings are not used tonight: (only|none yet of) /);
    const strip = (x: NightChargePlan) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'rationale' && !k.startsWith('pvBasis')));
    assert.deepEqual(strip(o.b.plan), strip(o.a.plan), o.date);
  }
  assert.equal(n, 12);
});

test('★★★ L3: the verdict, the selection and the plan recomputed at 21:30, 22:30 and 00:30 read one basis and one setpoint on every night (a Friday\'s 1-h window has closed by 00:30)', () => {
  for (const o of COST) {
    const [k21, k22, k00] = o.b.kinds;
    assert.equal(k22, k21, `${o.date} 22:30`);
    if (k00 != null) assert.equal(k00, k21, `${o.date} 00:30`);
    const [s21, s22, s00] = o.b.setpoints;
    if (k21 === 'panel') {
      assert.equal(s22, s21, `${o.date} 22:30 setpoint`);
      if (k00 != null) assert.equal(s00, s21, `${o.date} 00:30 setpoint`);
    }
    // A Friday: no window at 00:30 on either version (the 1-h window closed at 00:00).
    if (new Date(`${o.date}T12:00:00Z`).getUTCDay() === 5) assert.equal(k00, null, o.date);
  }
});

test('★★★ L4: the sums with Saturday\'s superseded arm dropped — panel nights v1.204.0 314.74 / 273.43 kWh (sized / expected) against v1.203.0 88.02 / 28.82; all 21 nights 534.65 / 368.56 against 307.93 / 123.95', () => {
  const sum = (xs: NightOut[], v: 'a' | 'b', f: 'buyKwh' | 'expectedBuyKwh'): number =>
    r2(xs.filter((o) => !superseded(o.date)).reduce((s, o) => s + (o[v].arm.a ? (o[v].plan[f] ?? 0) : 0), 0));
  const panel = COST.filter((o) => o.sel.use === 'planning');
  assert.equal(panel.length, 9);
  assert.deepEqual([sum(panel, 'b', 'buyKwh'), sum(panel, 'b', 'expectedBuyKwh'), sum(panel, 'a', 'buyKwh'), sum(panel, 'a', 'expectedBuyKwh')], [314.74, 273.43, 88.02, 28.82]);
  assert.deepEqual([sum(COST, 'b', 'buyKwh'), sum(COST, 'b', 'expectedBuyKwh'), sum(COST, 'a', 'buyKwh'), sum(COST, 'a', 'expectedBuyKwh')], [534.65, 368.56, 307.93, 123.95]);
  assert.deepEqual(COST.filter((o) => superseded(o.date)).map((o) => o.date), ['2026-10-17', '2026-10-24', '2026-10-31']);
});

test('★★★ the outage line is PV-independent: with the field reading ×1.00, ×1.05, ×1.10 and ×1.25, every resilience night arms the same write, and every cost night the same reserve write and line; a high field lowers only the cost fill', () => {
  const res = NIGHTS.map((n) => replay(n, 'resilience', 1));
  for (const scale of [1.05, 1.10, 1.25]) {
    const r = NIGHTS.map((n) => replay(n, 'resilience', scale));
    r.forEach((o, i) => {
      assert.deepEqual(o.b.arm.write, res[i].b.arm.write, `${o.date} ×${scale} resilience write`);
      assert.equal(o.b.plan.cushionLineSocPct, res[i].b.plan.cushionLineSocPct, `${o.date} ×${scale} the line`);
    });
    const c = NIGHTS.map((n) => replay(n, 'cost', scale));
    c.forEach((o, i) => {
      assert.equal(o.b.arm.write, COST[i].b.arm.write, `${o.date} ×${scale} cost reserve write`);
      assert.equal(o.b.plan.cushionLineSocPct, COST[i].b.plan.cushionLineSocPct, `${o.date} ×${scale} the line`);
      if (o.b.arm.fc != null && COST[i].b.arm.fc != null) assert.ok(o.b.arm.fc <= COST[i].b.arm.fc! + 1e-9, `${o.date} ×${scale}: the cost fill only lowers`);
    });
  }
});

test('★★★ the decision-time effect, resilience: every night arms what v1.203.0 arms but 11-02, whose 21:30 panel decision (the pool read 60% at 21:00 and 57% at 21:30) arms nothing where v1.203.0\'s 22:30 last resort armed 30 (1.48 kWh)', () => {
  const res = NIGHTS.map((n) => replay(n, 'resilience', 1));
  const fmt = (x: { write: number | null; fc: number | null }): string => `${x.write ?? '—'}/${x.fc == null ? '—' : r2(x.fc)}`;
  const differ = res.filter((o) => fmt(o.a.arm) !== fmt(o.b.arm)).map((o) => [o.date, fmt(o.a.arm), fmt(o.b.arm), o.a.at, o.b.at, r2(o.a.plan.buyKwh ?? 0), r2(o.b.plan.buyKwh ?? 0)]);
  assert.deepEqual(differ, [['2026-11-02', '30/—', '—/—', '22:30', '21:30', 1.48, 0]]);
  const n1102 = NIGHTS.find((n) => n.plan_date === '2026-11-02')!;
  assert.deepEqual([n1102.socAt21, n1102.socAt2130], [60, 57]);
  // Every refused night is the same plan at the same time; every panel night is decided at 21:30.
  for (const o of res) assert.equal(o.b.at, o.sel.use === 'planning' ? '21:30' : '22:30', o.date);
});


test('★★★ F1 (e), the evening job on the record: Sunday 11-01 with Saturday 10-31\'s latch standing for the Monday window both share decides afresh as of Sunday — Saturday on the panel\'s readings and Sunday\'s report missing to 23:00: v1.203.0\'s plan at 22:30 (30%), never a keep-previous stall, and it supersedes Saturday\'s 50/90; Saturday cushion-only (or a v1.203.0 latch) and Sunday passing: the panel plan 50/71.7 at 21:30; the 00:30 recompute reads Sunday\'s own latch', () => {
  // index.ts: the evening job's own call selects on no latch; the replay's `at` mirrors exactly this expression.
  assert.match(INDEX, /\n\s+latched: opts\.arming === true \? null : pvLatchHere,\n/);
  const fmt = (x: { write: number | null; fc: number | null }): string => `${x.write ?? '—'}/${x.fc == null ? '—' : r2(x.fc)}`;
  const sat = COST.find((o) => o.date === '2026-10-31')!;
  assert.equal(fmt(sat.b.arm), '50/90');
  const satLatch = sat.b.own!;
  assert.deepEqual(satLatch.pv && { basis: satLatch.pv.basis, asOfDay: satLatch.pv.asOfDay }, { basis: 'planning', asOfDay: '2026-10-31' });
  const sun = NIGHTS.find((n) => n.plan_date === '2026-11-01')!;
  const t00 = sun.nowMs + 3 * H;
  const supersedes = (o: NightOut): boolean => o.b.arm.a != null && o.b.plan.window?.startMs === sat.b.arm.a!.windowStartMs
    && priorArmSuperseded({ ...sat.b.arm.a!, missedApplyPushedAtMs: null }, o.date);

  // (a) Saturday latched the panel's readings; Sunday's planning report is missing from 21:30 to 23:00.
  const a = replay(sun, 'cost', 1, { prior: satLatch, planningAt: (t) => t >= t00 });
  assert.deepEqual(a.b.latchAt[0], { basis: 'planning', asOfDay: '2026-10-31', decided: true }, 'Saturday\'s latch stands at Sunday 21:30');
  for (const sel of a.b.sels.slice(0, 2)) {
    assert.equal(sel.use, 'published', 'never keep-previous');
    assert.equal(sel.transient, true);
  }
  assert.equal(a.b.at, '22:30', 'deferred to 22:30 and decided then');
  assert.equal(fmt(a.b.arm), fmt(a.a.arm));
  assert.equal(fmt(a.b.arm), '30/—', 'v1.203.0\'s plan for the Monday window');
  assert.ok(supersedes(a), 'Sunday\'s arm supersedes Saturday\'s 50/90 for the same window');
  // 00:30 reads the latch Sunday wrote (the published basis, as of Sunday): its report back and passing, refused as 'latched'.
  assert.deepEqual(a.b.latchAt[2], { basis: 'published', asOfDay: '2026-11-01', decided: true });
  assert.deepEqual(a.b.sels[2].reason, { code: 'latched', asOfDay: '2026-11-01', decided: true });

  // (b) Saturday latched the published basis (a refused or transient Saturday, or advisory); Sunday passes. (c) A v1.203.0 latch.
  const pub = { ...satLatch, pv: { ...satLatch.pv!, basis: 'published' as const } };
  const v1203 = { ...satLatch, pv: null };
  for (const prior of [pub, v1203]) {
    const o = replay(sun, 'cost', 1, { prior });
    assert.deepEqual(o.b.latchAt[0], { basis: 'published', asOfDay: '2026-10-31', decided: true });
    assert.deepEqual(o.b.sels.map((x) => x.use), ['planning', 'planning', 'planning']);
    assert.equal(o.b.at, '21:30');
    assert.equal(fmt(o.b.arm), '50/71.7', 'Sunday\'s own panel plan, as the unlatched replay arms it');
    assert.equal(o.b.plan.pvBasis, 'panel');
    assert.ok(supersedes(o));
    assert.deepEqual(o.b.latchAt[2], { basis: 'planning', asOfDay: '2026-11-01', decided: true });
  }
});

