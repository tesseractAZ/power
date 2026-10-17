import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildNightChargeInputs, computeNightChargePlan, nightChargeStateFields, nightChargeRoleFields, chargeLevelPct, statedBuyKwh,
  setLatestNightChargePlan, getLatestNightChargePlan,
  type NightChargeInputDeps, type NightForecastHour, type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { nextChargeableOpenMs, OVERNIGHT_CYCLE, type ChargeLegRole } from '../src/chargeWindows.js';
import { pvSurplusFromBand } from '../src/chargeTaper.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';
import {
  armCycle, emptyCycle, promoteCycle, missedApplyDue, cycleLegsStatus, type ChargeCycleState,
} from '../src/chargeCycle.js';
import { decideActuation, nightChargeSpokenNotice, APPLY_LATE_MS, type NightActuationState } from '../src/nightChargeActuator.js';
import { decideForceCharge } from '../src/nightForceCharge.js';
import { buildNightChargeMessage } from '../src/notify.js';
import {
  runMiddayShadowEvening, shadowCycleConfig, backupLegSizing, costLegSizing, refreshLeg, shadowRefreshDue, standingRefresh,
  refreshFromSized, refreshSizing, middayChargeStateFields, middayShadowLedgerColumns, middayShadowRefreshLedgerColumns,
  middayShadowLogLines, middayShadowRefreshLogLine, coerceMiddayShadowRecord, windowP50Kwh, shadowServed,
  liveOvernightWrote, notComparableRefresh, refreshResized, middayShadowRefreshPreview, NOT_COMPARABLE_REASON, MIDDAY_CHARGE_BASIS,
  MIDDAY_SHADOW_LOG_TAG, MIDDAY_SHADOW_FRESH_MS, REFRESH_LEAD_MS, REFRESH_DEADLINE_MS,
  type MiddayShadowRecord, type ShadowLegSizing, type ShadowSized, type ShadowArmCandidate, type ShadowArmVerdict,
} from '../src/middayShadow.js';

/**
 * R4 — THE WINTER MID-DAY CYCLE IN SHADOW (plan §8 R4). Both legs are computed at 21:30 on a winter
 * weekday and at the 09:30 refresh, and NOTHING of them is written, armed, pushed or announced: the
 * overnight leg runs exactly as before.
 *
 * The fixture is Wednesday 2026-10-14 21:30 (after the season grace) for Thursday 10-15 10:00–15:00,
 * the 09-30 morning's median PV and load, the 2026-10-12 evening's house load (middayPlan.test.ts),
 * planned by the real engine.
 */

const H = 3_600_000;
const M = 60_000;
const POOL = 92.16;
const MODEL = buildApsREvModel();
const periodIdAt = (ts: number): string => rateAt(MODEL, ts).periodId;
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const phxHour = (ts: number): number => (new Date(ts).getUTCHours() + 17) % 24;
const NOW = phx(10, 14, 21, 30);
const DAY = '2026-10-14';
const CFG = shadowCycleConfig('cost', 90);

const P50_W = [0, 94, 608, 2647, 4725, 6276, 6635, 6695, 6243, 5274, 3938, 2057, 573, 21];
const LOAD_W = [2188, 1864, 1646, 2068, 1851, 2158, 2202, 2927, 3228, 4020, 3435, 3738, 3205, 2978];
const houseKw = (h: number): number => (h >= 21 || h < 0 ? 2.8 : h < 5 ? 2.2 : h < 17 ? 2.6 : 3.4);
const loadW = (h: number): number => (h >= 5 && h <= 18 ? LOAD_W[h - 5] : houseKw(h) * 1000);
const pvW = (h: number): number => (h >= 5 && h <= 18 ? P50_W[h - 5] : 0);

function band(fromMs: number): NightForecastHour[] {
  const out: NightForecastHour[] = [];
  for (let ts = Math.floor(fromMs / H) * H; ts < phx(10, 15, 23); ts += H) {
    const h = phxHour(ts);
    out.push({ ts, pvP10W: pvW(h) * 0.8, loadP90W: loadW(h) * 1.35, embeddedEvW: 0, loadP50W: loadW(h), pvP50W: pvW(h) });
  }
  return out;
}

/** The deps a live overnight plan (no spec) or a shadow leg (its sizing) is planned with. */
function deps(o: { nowMs?: number; socNowPct?: number; sizing?: ShadowLegSizing; forceCharge?: boolean } = {}): NightChargeInputDeps {
  const nowMs = o.nowMs ?? NOW;
  const hours = band(nowMs);
  const sz = o.sizing;
  const winEnd = sz?.spec.window?.endMs ?? phx(10, 15, 5);
  const loads = new Map(hours.map((x) => [x.ts, x.loadP50W ?? 0]));
  const s = pvSurplusFromBand({
    hours: hours.map((x) => ({ ts: x.ts, p50W: x.pvP50W ?? 0, p90W: (x.pvP50W ?? 0) * 1.3 })),
    loadAt: (ts) => loads.get(ts), fromMs: winEnd, toMs: sz?.surplusEndMs ?? winEnd + 14 * H,
  });
  return {
    nowMs, fullKwh: POOL, socNowPct: o.socNowPct ?? 60, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.62, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 17.8, gridInputCapKw: 17,
    periodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: hours, dayRollups: [], realizedDailyErrHalfFrac: 0.1,
    nextRechargeMs: sz ? sz.nextRechargeMs : nextChargeableOpenMs(MODEL, phx(10, 15, 6)),
    ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 }, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 14, bandCoverageFrac: 0.85,
    morningPvSurplusP90Kwh: s.p90Kwh, morningPvSurplusP50Kwh: s.p50Kwh, longGapAhead: false, prePeakPvSurplusP10Kwh: null,
    minBuyKwh: 1, buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: o.forceCharge ?? false,
    ...(sz ? { windowSpec: sz.spec } : {}),
  };
}
const livePlan = (o: Parameters<typeof deps>[0] = {}): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(deps(o)));

/** The shadow's planner: the real engine on the leg's sizing, as index.ts sizeShadowLeg does. */
function engineSizer(calls: ShadowLegSizing[], o: { socNowPct?: number; nowMs?: number } = {}) {
  return async (sz: ShadowLegSizing): Promise<ShadowSized> => {
    calls.push(sz);
    const d = deps({ ...o, sizing: sz, forceCharge: sz.spec.role === 'cost' });
    const plan = computeNightChargePlan(buildNightChargeInputs(d));
    return { plan, ...windowP50Kwh(d.bandHours, sz.spec.window!) };
  };
}
/** The shadow's arm probe: armCycle against `cycle`, its result dropped (index.ts shadowArmProbe). */
function probeOn(cycle: ChargeCycleState, calls: ShadowArmCandidate[][] = []) {
  return (cands: ShadowArmCandidate[]): ShadowArmVerdict => {
    calls.push(cands);
    const r = armCycle(cycle, DAY, cands.map((c) => ({ role: c.role, kind: c.kind, plan: c.plan, forceChargeEnabled: c.role === 'cost' })), NOW, 16);
    return { armed: r.legs.map((l) => l.leg), refused: r.refused };
  };
}

/** Tonight's live overnight arm, as the evening job makes it. */
function liveArm(plan: NightChargePlan): ChargeCycleState {
  const r = armCycle(emptyCycle(), DAY, [{ role: 'cost', kind: 'overnight', plan, forceChargeEnabled: false, announcedLevelPct: chargeLevelPct(plan), announcedExpectedKwh: statedBuyKwh(plan) }], NOW, 16);
  assert.ok(r.cycle, 'the overnight leg arms');
  return r.cycle!;
}

/* ══ the evening ═══════════════════════════════════════════════════════════ */

test('★★★ a winter weekday evening sizes both legs: the backup Wed 23:00–Thu 05:00 on option A, then the cost leg from the pool it protects', async () => {
  const live = livePlan();
  const cycle = liveArm(live);
  const sizings: ShadowLegSizing[] = [];
  const probes: ShadowArmCandidate[][] = [];
  const rec = await runMiddayShadowEvening({
    nowMs: NOW, day: DAY, model: MODEL, cfg: CFG, mode: 'supervised', chgMaxSocPcts: [100, 100, null],
    sizeLeg: engineSizer(sizings), armProbe: probeOn(cycle, probes),
  });
  assert.notEqual(rec, 'panelStale');
  const r = rec as MiddayShadowRecord;
  assert.equal(r.why, 'midday');
  assert.equal(r.day, DAY);
  assert.deepEqual([r.backup!.windowStartMs, r.backup!.windowEndMs], [phx(10, 14, 23), phx(10, 15, 5)]);
  assert.deepEqual([r.cost!.windowStartMs, r.cost!.windowEndMs], [phx(10, 15, 10), phx(10, 15, 15)]);
  // The backup first, its horizon the next overnight open (option A): Thursday 23:00.
  assert.equal(sizings.length, 2);
  assert.equal(sizings[0].spec.role, 'backup');
  assert.equal(sizings[0].nextRechargeMs, phx(10, 15, 23));
  assert.equal(sizings[1].spec.role, 'cost');
  assert.equal(sizings[1].nextRechargeMs, phx(10, 15, 23), 'the mid-day leg carries the house to 23:00 the same day');
  assert.equal(sizings[1].surplusEndMs, phx(10, 15, 16), 'its PV surplus runs from the close to the on-peak start');
  assert.equal(sizings[1].spec.curtailFromPct, 90, 'the taper line of a 100% charge ceiling');
  // The backup arms (60% at 21:30 walks under the line before 23:00 the next day) and its 50% hold
  // is the cost leg's anchor.
  assert.equal(r.backup!.chargeTonight, true);
  assert.equal(r.backup!.wouldArm, true, r.backup!.disposition);
  assert.equal(r.backup!.reservePct, 50, 'written 50 (the walk asks for more)');
  assert.deepEqual(sizings[1].spec.backupHold, { pct: 50, untilMs: phx(10, 15, 5) });
  assert.equal(r.cost!.wouldArm, true, r.cost!.disposition);
  assert.equal(r.cost!.reservePct, 50);
  assert.equal(r.cost!.reserveBasis, 'resilience');
  assert.ok(r.cost!.levelPct! > 80, `the force-charge carries the cost fill (${r.cost!.levelPct}%)`);
  assert.ok(r.cost!.windowPvP50Kwh! > 20 && r.cost!.windowLoadP50Kwh! > 10, 'the planned window PV and load are recorded');
  // Probed alone, then both together; the backup first.
  assert.deepEqual(probes.map((p) => p.map((c) => c.role)), [['backup'], ['backup', 'cost']]);
});

test('★★★ Friday and Saturday evenings, summer and the season grace: no mid-day cycle, nothing sized, nothing probed', async () => {
  for (const [nowMs, why] of [
    [phx(10, 16, 21, 30), 'no-run-in-scan'], // Friday
    [phx(10, 17, 21, 30), 'no-run-in-scan'], // Saturday
    [phx(10, 5, 21, 30), 'season-grace'],    // Monday in the first week of October
    [Date.UTC(2026, 6, 14, 4, 30), 'no-run-in-scan'], // a July evening
  ] as const) {
    const sizings: ShadowLegSizing[] = [];
    const probes: ShadowArmCandidate[][] = [];
    const r = await runMiddayShadowEvening({
      nowMs, day: 'x', model: MODEL, cfg: CFG, mode: 'supervised', chgMaxSocPcts: [],
      sizeLeg: engineSizer(sizings), armProbe: probeOn(emptyCycle(), probes),
    }) as MiddayShadowRecord;
    assert.equal(r.why, why, new Date(nowMs).toISOString());
    assert.equal(r.cost, null);
    assert.equal(r.backup, null);
    assert.equal(sizings.length + probes.length, 0);
    assert.match(middayShadowLogLines(r)[0], /no mid-day cycle/);
  }
  // A configuration that does not ask for a mid-day buy is recorded with its reason.
  const res = await runMiddayShadowEvening({
    nowMs: NOW, day: DAY, model: MODEL, cfg: shadowCycleConfig('resilience', 90), mode: 'supervised', chgMaxSocPcts: [],
    sizeLeg: engineSizer([]), armProbe: probeOn(emptyCycle()),
  }) as MiddayShadowRecord;
  assert.equal(res.why, 'not-cost-objective');
});

test('★★★ advisory mode arms nothing: no probe, every leg "not armed", and no backup hold anchors the cost leg', async () => {
  const sizings: ShadowLegSizing[] = [];
  const probes: ShadowArmCandidate[][] = [];
  const r = await runMiddayShadowEvening({
    nowMs: NOW, day: DAY, model: MODEL, cfg: CFG, mode: 'advisory', chgMaxSocPcts: [100],
    sizeLeg: engineSizer(sizings), armProbe: probeOn(emptyCycle(), probes),
  }) as MiddayShadowRecord;
  assert.equal(probes.length, 0);
  assert.equal(r.backup!.wouldArm, false);
  assert.equal(r.cost!.wouldArm, false);
  assert.match(r.cost!.disposition, /advisory/);
  assert.equal(sizings[1].spec.backupHold, null);
});

test('★★ a backup the arm probe refuses gives the cost leg no hold, and says why', async () => {
  const sizings: ShadowLegSizing[] = [];
  const r = await runMiddayShadowEvening({
    nowMs: NOW, day: DAY, model: MODEL, cfg: CFG, mode: 'supervised', chgMaxSocPcts: [100],
    sizeLeg: engineSizer(sizings),
    armProbe: (cands) => ({ armed: [], refused: cands.map((c) => ({ role: c.role, reason: 'the 2026-10-13 reserve write is still applied and not yet restored' })) }),
  }) as MiddayShadowRecord;
  assert.equal(r.backup!.wouldArm, false);
  assert.match(r.backup!.disposition, /^would not arm — the 2026-10-13 reserve write/);
  assert.equal(sizings[1].spec.backupHold, null);
  assert.match(r.cost!.disposition, /^would not arm/);
});

test('★★★ a cost leg the re-entry line holds is recorded as held for it — not as "no buy needed" — and a refresh that holds on it says so', async () => {
  // The engine's re-entry hold (nightChargeAdvisor: a write under floor + 25), as the cost leg's sizing.
  const held = { ...livePlan(), chargeTonight: false, middayReentryHold: { arrivalPct: 38, linePct: 41 } } as NightChargePlan;
  const sizer = engineSizer([]);
  const r = await runMiddayShadowEvening({
    nowMs: NOW, day: DAY, model: MODEL, cfg: CFG, mode: 'supervised', chgMaxSocPcts: [100],
    sizeLeg: async (sz) => (sz.spec.role === 'cost' ? { plan: held, windowPvP50Kwh: null, windowLoadP50Kwh: null } : sizer(sz)),
    armProbe: probeOn(emptyCycle()),
  }) as MiddayShadowRecord;
  assert.equal(r.cost!.wouldArm, false);
  assert.equal(r.cost!.disposition, 'not armed — the plan holds: the charge would take the pool only to ~38%, under the 41% re-entry line');
  const rf = refreshLeg({ announced: ANN, refreshed: fresh({ chargeTonight: false, reentryHold: { arrivalPct: 38, linePct: 41 } }) });
  assert.equal(rf.disposition, 'cancelled');
  assert.equal(rf.reason, 'the refreshed plan holds: the charge would take the pool only to ~38%, under the 41% re-entry line');
  assert.equal(refreshLeg({ announced: ANN, refreshed: fresh({ chargeTonight: false }) }).reason, 'the refreshed plan holds: no charge is needed');
});

test('★★ a stale panel defers the whole evening (no half record)', async () => {
  let n = 0;
  const r = await runMiddayShadowEvening({
    nowMs: NOW, day: DAY, model: MODEL, cfg: CFG, mode: 'supervised', chgMaxSocPcts: [],
    sizeLeg: async () => { n++; return 'panelStale'; }, armProbe: probeOn(emptyCycle()),
  });
  assert.equal(r, 'panelStale');
  assert.equal(n, 1);
});

/* ══ ★★★ NOTHING IS WRITTEN, ARMED, PUSHED OR ANNOUNCED FOR THE MID-DAY LEG ═════════════════ */

interface Effects {
  writes: Array<{ t: number; what: string; leg: ChargeLegRole; kind: string }>;
  pushes: Array<{ t: number; what: string }>;
}

/** The actuator ticks over the cycle, as runNightActuationTick drives them: the cycle step, the
 *  missed-apply push, the reserve decision and the force-charge decision. Every write and push is
 *  counted. The panel reads back what was written. */
function runTicks(cycle0: ChargeCycleState, times: number[], fx: Effects): { cycle: ChargeCycleState; actions: string[] } {
  let cycle = cycle0;
  let reserve = 16;
  const actions: string[] = [];
  for (const t of times) {
    const step = promoteCycle(cycle, t, reserve);
    if (step) cycle = step.cycle;
    for (const leg of [cycle.active, ...cycle.pendingLegs]) {
      if (missedApplyDue(leg, t)) fx.pushes.push({ t, what: `missed apply ${leg.leg}/${leg.windowKind}` });
    }
    const s: NightActuationState = cycle.active;
    const a = decideActuation(s, t, { mode: 'supervised', writeReady: false, currentReservePct: reserve, socCoherent: true, vitalsRed: false, gridPresent: true });
    actions.push(`${new Date(t).toISOString()} ${a.kind}`);
    const leg = cycle.active;
    switch (a.kind) {
      case 'apply':
        fx.writes.push({ t, what: `reserve → ${a.targetPct}`, leg: leg.leg, kind: leg.windowKind });
        cycle = { ...cycle, active: { ...leg, applyAttemptedAtMs: t, attemptBaselinePct: reserve, appliedAtMs: t, priorReservePct: reserve } };
        reserve = a.targetPct;
        break;
      case 'applyVerified':
        cycle = { ...cycle, active: { ...leg, applyVerifiedAtMs: t } };
        break;
      case 'revert':
        fx.writes.push({ t, what: `reserve → ${a.restorePct}`, leg: leg.leg, kind: leg.windowKind });
        cycle = { ...cycle, active: { ...leg, revertedAtMs: t } };
        reserve = a.restorePct;
        break;
      case 'revertVerified':
        cycle = { ...cycle, active: { ...leg, revertVerifiedAtMs: t } };
        break;
      case 'none':
        break;
      default:
        throw new Error(`unexpected action ${a.kind} at ${new Date(t).toISOString()}`);
    }
    // The force-charge decision, after the overnight leg (it rides no overnight write here): from
    // 09:00 on it must find nothing to do.
    if (t >= phx(10, 15, 9)) {
      const f = decideForceCharge(cycle.active, t, {
        enabled: true, gridPresent: true, gridStaLost: false, ceilingReadbackPct: 90, slotsOn: [], connectedSlots: [1, 2, 3],
        vitalsRed: false, socCoherent: true, poolSocPct: 40, fullKwh: POOL, chargeRateKw: 13, nextLegOpenMs: null,
      });
      if (f.kind !== 'none') fx.writes.push({ t, what: `force-charge ${f.kind}`, leg: cycle.active.leg, kind: cycle.active.windowKind });
    }
  }
  return { cycle, actions };
}

const TICKS = [
  phx(10, 14, 22, 59), phx(10, 14, 23), phx(10, 14, 23, 1), phx(10, 15, 2), phx(10, 15, 5), phx(10, 15, 5, 1),
  phx(10, 15, 9, 30), phx(10, 15, 9, 55), phx(10, 15, 10), phx(10, 15, 10, 1), phx(10, 15, 10, 31), phx(10, 15, 12),
  phx(10, 15, 14, 59), phx(10, 15, 15), phx(10, 15, 15, 1), phx(10, 15, 15, 30), phx(10, 15, 16), phx(10, 15, 19),
];

test('★★★ the 21:30 job and the 10:00/15:00 ticks on a winter weekday: zero writes, pushes or announcements for the mid-day leg; the overnight leg exactly as before', async () => {
  // The evening, as the job runs it: the live overnight plan, its push and speech, its arm.
  const live = livePlan();
  setLatestNightChargePlan(live);
  const liveCycle = liveArm(live);
  const frozen = JSON.stringify(liveCycle);
  const ctx = { cancelDeadlineText: 'at 11:00 PM', cancelDeadlineTextEs: 'a las 11:00 PM', targetPct: liveCycle.active.targetPct! };
  const pushBefore = buildNightChargeMessage(live, 'charge', ctx, null, 'supervised');
  const speechBefore = nightChargeSpokenNotice({
    levelPct: chargeLevelPct(live) ?? ctx.targetPct, reservePct: ctx.targetPct, expectedKwh: statedBuyKwh(live), toward: false,
    deadlineText: ctx.cancelDeadlineText, deadlineTextEs: ctx.cancelDeadlineTextEs, cushionShortfall: live.cushionShortfall === true,
  });
  const entitiesBefore = { ...nightChargeStateFields(live, NOW), ...nightChargeRoleFields(live, NOW) };

  // …then the shadow, probing against that very cycle.
  const rec = await runMiddayShadowEvening({
    nowMs: NOW, day: DAY, model: MODEL, cfg: CFG, mode: 'supervised', chgMaxSocPcts: [100],
    sizeLeg: engineSizer([]), armProbe: probeOn(liveCycle),
  }) as MiddayShadowRecord;
  assert.equal(rec.cost!.wouldArm, true, 'the shadow says the mid-day leg would arm');
  assert.equal(rec.backup!.wouldArm, true);

  // Nothing of it reached the live cycle, the plan holder, the push, the speech or the night entities.
  assert.equal(JSON.stringify(liveCycle), frozen, 'the cycle record is untouched');
  assert.equal(liveCycle.pendingLegs.length, 0);
  assert.equal(liveCycle.active.windowKind, 'overnight');
  assert.equal(getLatestNightChargePlan(), live, 'the plan holder is the live plan');
  assert.deepEqual(buildNightChargeMessage(getLatestNightChargePlan(), 'charge', ctx, null, 'supervised'), pushBefore);
  assert.deepEqual(nightChargeSpokenNotice({
    levelPct: chargeLevelPct(live) ?? ctx.targetPct, reservePct: ctx.targetPct, expectedKwh: statedBuyKwh(live), toward: false,
    deadlineText: ctx.cancelDeadlineText, deadlineTextEs: ctx.cancelDeadlineTextEs, cushionShortfall: live.cushionShortfall === true,
  }), speechBefore);
  assert.deepEqual({ ...nightChargeStateFields(getLatestNightChargePlan(), NOW), ...nightChargeRoleFields(getLatestNightChargePlan(), NOW) }, entitiesBefore);
  assert.equal(entitiesBefore.night_charge_role, 'cost');
  assert.equal(middayChargeStateFields(rec, NOW).midday_charge_recommended, false, 'a shadow is never recommended');
  assert.deepEqual(cycleLegsStatus(liveCycle, NOW).map((l) => `${l.leg}/${l.windowKind}`), ['cost/overnight']);

  // The ticks through the night, the 10:00 open and the 15:00 close: with the shadow, and without it.
  const withShadow: Effects = { writes: [], pushes: [] };
  const a = runTicks(liveCycle, TICKS, withShadow);
  const baseline: Effects = { writes: [], pushes: [] };
  const b = runTicks(liveArm(livePlan()), TICKS, baseline);
  assert.deepEqual(a.actions, b.actions, 'the overnight leg behaves exactly as without the shadow');
  assert.deepEqual(withShadow, baseline);
  // The overnight leg writes at 23:00 and restores at 05:00 — and that is every write there is.
  assert.deepEqual(withShadow.writes.map((w) => [new Date(w.t).toISOString(), w.what, w.leg, w.kind]), [
    [new Date(phx(10, 14, 23)).toISOString(), `reserve → ${liveCycle.active.targetPct}`, 'cost', 'overnight'],
    [new Date(phx(10, 15, 5)).toISOString(), 'reserve → 16', 'cost', 'overnight'],
  ]);
  assert.equal(withShadow.writes.filter((w) => w.t >= phx(10, 15, 9)).length, 0, 'nothing at 10:00 or 15:00');
  assert.equal(withShadow.writes.filter((w) => w.kind === 'super_off_peak').length, 0);
  assert.deepEqual(withShadow.pushes, [], 'no missed-apply push: no mid-day leg was ever armed');
  assert.equal(a.cycle.pendingLegs.length, 0);

  // The 09:30 refresh. The live overnight leg wrote at 23:00 (a write mode, the cost objective), so
  // the 09:30 pool is not the one a mid-day cycle would have had: the refresh is recorded as not
  // comparable, never re-sized on it (index.ts runMiddayShadowTickInner, step 2).
  const due = shadowRefreshDue(rec, phx(10, 15, 9, 30));
  assert.equal(due, 'run');
  assert.equal(liveOvernightWrote(rec, a.cycle.active), true, 'the live overnight leg wrote');
  // Re-sized on the post-charge pool it would read the cost leg as nearly done — the defect.
  const sz = refreshSizing(MODEL, rec, CFG, [100])!;
  const postCharge = refreshFromSized(rec, await engineSizer([], { nowMs: phx(10, 15, 9, 30), socNowPct: 70 })(sz), phx(10, 15, 9, 30));
  assert.ok(postCharge.expectedBuyKwh == null || postCharge.expectedBuyKwh < rec.cost!.expectedBuyKwh! / 2,
    `${postCharge.expectedBuyKwh} against the evening's ${rec.cost!.expectedBuyKwh}: not the mid-day cycle's refresh`);
  // A night the live leg wrote nothing (advisory, or a hold): comparable, re-sized on the pool as it is.
  const unwritten = { day: DAY, appliedAtMs: null, forceChargeOnAtMs: null };
  assert.equal(liveOvernightWrote(rec, unwritten), false);
  const refreshed = refreshFromSized(rec, await engineSizer([], { nowMs: phx(10, 15, 9, 30), socNowPct: 30 })(sz), phx(10, 15, 9, 30));
  assert.ok(['unchanged', 'lowered', 'capped', 'cancelled'].includes(refreshed.disposition));
  assert.equal(JSON.stringify(liveCycle), frozen);
});

test('★★★ a shadow refresh after the live overnight charge wrote is not comparable: not re-sized, the evening figures stand, nothing pushed', () => {
  const r = record();
  const at = phx(10, 15, 9, 30);
  assert.equal(liveOvernightWrote(r, { day: DAY, appliedAtMs: phx(10, 14, 23), forceChargeOnAtMs: null }), true, 'the reserve raise');
  assert.equal(liveOvernightWrote(r, { day: DAY, appliedAtMs: null, forceChargeOnAtMs: phx(10, 15, 3) }), true, 'a force-charge alone');
  assert.equal(liveOvernightWrote(r, { day: '2026-10-13', appliedAtMs: phx(10, 13, 23), forceChargeOnAtMs: null }), false, 'another evening\'s leg');
  assert.equal(liveOvernightWrote(r, { day: null, appliedAtMs: null, forceChargeOnAtMs: null }), false);
  const nc = notComparableRefresh(at);
  assert.equal(nc.disposition, 'not-comparable');
  assert.equal(nc.wouldPush, false);
  assert.equal(nc.reason, NOT_COMPARABLE_REASON);
  assert.match(nc.reason, /^the live overnight charge wrote to the panel, so the 09:30 pool is not the one a mid-day cycle would have had/);
  assert.deepEqual([nc.levelPct, nc.reservePct, nc.buyKwh, nc.expectedBuyKwh], [null, null, null, null], 'no re-sized figures');
  assert.equal(refreshResized(nc), false);
  const withNc = { ...r, refresh: nc };
  // The entities keep the evening's figures and say what the refresh was.
  const f = middayChargeStateFields(withNc, at + M);
  assert.equal(f.midday_charge_target_soc_percent, 89.5);
  assert.equal(f.midday_charge_expected_buy_kwh, 34);
  assert.equal(f.midday_charge_refresh, 'not-comparable');
  assert.equal(f.midday_charge_basis, 'shadow');
  // The ledger: the disposition and no refreshed figures; the log line states the basis; no push preview.
  const cols = middayShadowRefreshLedgerColumns(nc);
  assert.equal(cols.shadow_refresh_disposition, 'not-comparable');
  assert.equal(cols.shadow_refreshed_level_pct, null);
  assert.equal(cols.shadow_refreshed_expected_buy_kwh, null);
  assert.match(middayShadowRefreshLogLine(withNc, nc), /refresh — not-comparable: the live overnight charge wrote to the panel/);
  assert.equal(middayShadowRefreshPreview(withNc, nc), null);
  // It round-trips through the file.
  assert.deepEqual(coerceMiddayShadowRecord(JSON.parse(JSON.stringify(withNc))), withNc);
});

/* ══ the morning refresh ════════════════════════════════════════════════════ */

const ANN = { levelPct: 89.5, reservePct: 50, expectedBuyKwh: 34, buyKwh: 47.8 };
const fresh = (o: Partial<NonNullable<Parameters<typeof refreshLeg>[0]['refreshed']>> = {}) => ({
  basisComplete: true, chargeTonight: true, levelPct: 89.5, reservePct: 50, expectedBuyKwh: 34, buyKwh: 47.8, ...o,
});

test('★★★ refreshLeg: lower-only — the announced level is the ceiling; a higher need is "capped", never written', () => {
  assert.deepEqual(refreshLeg({ announced: ANN, refreshed: fresh() }), {
    disposition: 'unchanged', levelPct: 89.5, reservePct: 50, buyKwh: 47.8, expectedBuyKwh: 34, wouldPush: false, reason: 'the evening plan holds as announced',
  });
  const lowered = refreshLeg({ announced: ANN, refreshed: fresh({ levelPct: 80, expectedBuyKwh: 22 }) });
  assert.equal(lowered.disposition, 'lowered');
  assert.equal(lowered.levelPct, 80);
  assert.equal(lowered.wouldPush, true, 'a changed stop pushes');
  const capped = refreshLeg({ announced: ANN, refreshed: fresh({ levelPct: 95, reservePct: 50, expectedBuyKwh: 40 }) });
  assert.equal(capped.disposition, 'capped');
  assert.equal(capped.levelPct, 89.5, 'held at the announced level');
  assert.equal(capped.expectedBuyKwh, null, 'the figure at the capped level is not invented');
  assert.equal(capped.wouldPush, true);
  // The reserve never above the announced level, nor 50.
  const lowAnn = { ...ANN, levelPct: 45, reservePct: 45 };
  assert.equal(refreshLeg({ announced: lowAnn, refreshed: fresh({ levelPct: 45, reservePct: 50 }) }).reservePct, 45);
  assert.equal(refreshLeg({ announced: lowAnn, refreshed: fresh({ levelPct: 45, reservePct: 50 }) }).disposition, 'capped');
  // A hold cancels; no plan or an incomplete basis lets the evening plan stand.
  assert.equal(refreshLeg({ announced: ANN, refreshed: fresh({ chargeTonight: false }) }).disposition, 'cancelled');
  assert.equal(refreshLeg({ announced: ANN, refreshed: fresh({ chargeTonight: false }) }).wouldPush, true);
  assert.equal(refreshLeg({ announced: ANN, refreshed: null }).disposition, 'stood');
  assert.equal(refreshLeg({ announced: ANN, refreshed: fresh({ basisComplete: false }) }).disposition, 'stood');
  assert.equal(refreshLeg({ announced: ANN, refreshed: null }).wouldPush, false);
});

test('★★ refreshLeg: an expected-kWh move above 25% either way pushes; 25% or less does not', () => {
  assert.equal(refreshLeg({ announced: ANN, refreshed: fresh({ expectedBuyKwh: 34 * 1.25 }) }).wouldPush, false);
  assert.equal(refreshLeg({ announced: ANN, refreshed: fresh({ expectedBuyKwh: 34 * 1.26 }) }).wouldPush, true);
  assert.equal(refreshLeg({ announced: ANN, refreshed: fresh({ expectedBuyKwh: 34 * 0.75 }) }).wouldPush, false);
  assert.equal(refreshLeg({ announced: ANN, refreshed: fresh({ expectedBuyKwh: 34 * 0.74 }) }).wouldPush, true);
});

function record(o: Partial<MiddayShadowRecord> = {}): MiddayShadowRecord {
  const leg = (role: 'backup' | 'cost', a: number, b: number) => ({
    role, kind: role === 'cost' ? 'super_off_peak' as const : 'overnight' as const, windowStartMs: a, windowEndMs: b,
    basisComplete: true, chargeTonight: true, reservePct: 50, reserveBasis: role === 'cost' ? 'resilience' as const : null,
    levelPct: role === 'cost' ? 89.5 : 50, costCeilingSocPct: role === 'cost' ? 89.5 : null,
    buyKwh: 47.8, expectedBuyKwh: 34, expectedStartSocPct: 48, cushionTroughSocPct: 20, cushionLineSocPct: 31.13,
    wouldArm: true, disposition: 'would arm', windowPvP50Kwh: 27.1, windowLoadP50Kwh: 14.9,
  });
  return {
    version: 1, day: DAY, computedAtMs: NOW, why: 'midday', mode: 'supervised',
    backup: leg('backup', phx(10, 14, 23), phx(10, 15, 5)), cost: leg('cost', phx(10, 15, 10), phx(10, 15, 15)),
    refresh: null, note: null, ...o,
  };
}

test('★★★ the refresh runs once, from 30 to 5 minutes before the open; then the evening plan stands', () => {
  const r = record();
  const open = phx(10, 15, 10);
  assert.equal(REFRESH_LEAD_MS, 30 * M);
  assert.equal(REFRESH_DEADLINE_MS, 5 * M);
  assert.equal(shadowRefreshDue(r, open - 31 * M), null);
  assert.equal(shadowRefreshDue(r, open - 30 * M), 'run');
  assert.equal(shadowRefreshDue(r, open - 5 * M - 1), 'run');
  assert.equal(shadowRefreshDue(r, open - 5 * M), 'stand');
  assert.equal(shadowRefreshDue(r, open + 4 * H), 'stand');
  assert.equal(shadowRefreshDue(r, phx(10, 15, 15)), null, 'the window closed');
  assert.equal(shadowRefreshDue({ ...r, refresh: standingRefresh(r, open - 5 * M) }, open - 20 * M), null, 'once');
  assert.equal(shadowRefreshDue({ ...r, cost: { ...r.cost!, chargeTonight: false } }, open - 20 * M), null, 'a hold has nothing to refresh');
  assert.equal(shadowRefreshDue(null, open - 20 * M), null);
  const st = standingRefresh(r, open - 5 * M);
  assert.equal(st.disposition, 'stood');
  assert.equal(st.levelPct, 89.5);
  assert.equal(st.wouldPush, false);
  // The refresh's sizing: the evening's leg, the backup's (closed) hold.
  const sz = refreshSizing(MODEL, r, CFG, [100])!;
  assert.deepEqual(sz.spec.window, { startMs: open, endMs: phx(10, 15, 15) });
  assert.deepEqual(sz.spec.backupHold, { pct: 50, untilMs: phx(10, 15, 5) });
  assert.equal(refreshSizing(MODEL, { ...r, cost: null }, CFG, []), null);
  // No plan from the planner: the evening plan stands.
  assert.equal(refreshFromSized(r, null, open - 20 * M).disposition, 'stood');
});

/* ══ the surfaces ═══════════════════════════════════════════════════════════ */

test('★★★ the mid-day entities: never recommended; the refreshed figures once refreshed; null outside the record\'s life', () => {
  const r = record();
  const f = middayChargeStateFields(r, NOW + H);
  assert.deepEqual(f, {
    midday_charge_basis: 'shadow',
    midday_charge_recommended: false,
    midday_charge_target_soc_percent: 89.5,
    midday_charge_reserve_hold_percent: 50,
    midday_charge_expected_buy_kwh: 34,
    midday_charge_buy_kwh: 47.8,
    midday_charge_window_start_at: new Date(phx(10, 15, 10)).toISOString(),
    midday_charge_window_end_at: new Date(phx(10, 15, 15)).toISOString(),
    midday_charge_refresh: 'pending',
  });
  const lowered = { ...r, refresh: { atMs: phx(10, 15, 9, 31), disposition: 'lowered' as const, levelPct: 80, reservePct: 50, buyKwh: 40, expectedBuyKwh: 22, wouldPush: true, reason: '' } };
  assert.equal(middayChargeStateFields(lowered, phx(10, 15, 9, 40)).midday_charge_target_soc_percent, 80);
  assert.equal(middayChargeStateFields(lowered, phx(10, 15, 9, 40)).midday_charge_expected_buy_kwh, 22);
  assert.equal(middayChargeStateFields(lowered, phx(10, 15, 9, 40)).midday_charge_refresh, 'lowered');
  const cancelled = { ...r, refresh: { ...lowered.refresh, disposition: 'cancelled' as const } };
  assert.equal(middayChargeStateFields(cancelled, phx(10, 15, 9, 40)).midday_charge_target_soc_percent, null);
  const stood = { ...r, refresh: standingRefresh(r, phx(10, 15, 9, 55)) };
  assert.equal(middayChargeStateFields(stood, phx(10, 15, 9, 56)).midday_charge_target_soc_percent, 89.5);
  // Stale, closed, or no mid-day leg: every figure null, and still never recommended.
  for (const [rec, t] of [[r, phx(10, 15, 15)], [r, NOW + MIDDAY_SHADOW_FRESH_MS], [{ ...r, cost: null }, NOW + H], [null, NOW]] as const) {
    const g = middayChargeStateFields(rec, t);
    assert.equal(g.midday_charge_recommended, false);
    assert.equal(g.midday_charge_target_soc_percent, null);
    assert.equal(g.midday_charge_window_start_at, null);
    assert.equal(g.midday_charge_basis, 'shadow', 'every mid-day figure is a shadow computation in this release');
    assert.equal(shadowServed(rec, t), false);
  }
  // Even a "would arm" mid-day leg in a write mode is not a recommendation.
  assert.equal(middayChargeStateFields(record({ mode: 'auto' }), NOW + H).midday_charge_recommended, false);
});

test('★★★ the ledger: the shadow fills only shadow_* columns; the refresh its own', () => {
  const cols = middayShadowLedgerColumns(record());
  assert.ok(Object.keys(cols).length >= 20);
  for (const k of Object.keys(cols)) assert.match(k, /^shadow_/, `${k} is a shadow column`);
  assert.equal(cols.shadow_cycle_why, 'midday');
  assert.equal(cols.shadow_backup_arms, 1);
  assert.equal(cols.shadow_cost_window_start_ms, phx(10, 15, 10));
  assert.equal(cols.shadow_cost_reserve_basis, 'resilience');
  assert.equal(cols.shadow_window_pv_p50_kwh, 27.1);
  assert.equal(cols.shadow_arm_disposition, 'backup: would arm; cost: would arm');
  const none = middayShadowLedgerColumns(record({ why: 'no-run-in-scan', backup: null, cost: null }));
  assert.equal(none.shadow_cycle_why, 'no-run-in-scan');
  assert.equal(none.shadow_cost_window_start_ms, null);
  const rc = middayShadowRefreshLedgerColumns(standingRefresh(record(), phx(10, 15, 9, 55)));
  for (const k of Object.keys(rc)) assert.match(k, /^shadow_refresh/, k);
  assert.equal(rc.shadow_refresh_disposition, 'stood');
});

test('★★ every log line carries the shadow tag and says nothing was written', () => {
  const r = record();
  assert.equal(MIDDAY_SHADOW_LOG_TAG, 'night-charge[midday-shadow]:');
  const lines = middayShadowLogLines(r);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.startsWith(`${MIDDAY_SHADOW_LOG_TAG} ${DAY} `), l);
  assert.match(lines[1], /Shadow only: nothing is armed, written or announced for it\.$/);
  assert.match(lines[0], /^night-charge\[midday-shadow\]: 2026-10-14 backup .* — would arm: .*Shadow only: nothing is armed, written or announced for it\.$/, 'the backup\'s "would arm" says so too');
  assert.equal(MIDDAY_CHARGE_BASIS, 'shadow');
  assert.match(lines[0], /worst-case sizing 47\.8 kWh/, 'the worst case is labelled as the sizing basis');
  const rl = middayShadowRefreshLogLine(r, standingRefresh(r, phx(10, 15, 9, 55)));
  assert.ok(rl.startsWith(MIDDAY_SHADOW_LOG_TAG));
  assert.match(rl, /Shadow only: nothing is written or pushed\.$/);
});

test('★★ the file round-trips; anything malformed is no record', () => {
  const r = { ...record(), refresh: standingRefresh(record(), phx(10, 15, 9, 55)) };
  assert.deepEqual(coerceMiddayShadowRecord(JSON.parse(JSON.stringify(r))), r);
  assert.equal(coerceMiddayShadowRecord(null), null);
  assert.equal(coerceMiddayShadowRecord({ ...r, version: 2 }), null);
  assert.equal(coerceMiddayShadowRecord({ ...r, day: '10/14' }), null);
  assert.equal(coerceMiddayShadowRecord({ ...r, why: 'because' }), null);
  assert.equal(coerceMiddayShadowRecord({ ...r, cost: { ...r.cost, windowEndMs: 0 } })!.cost, null);
  assert.equal(coerceMiddayShadowRecord({ ...r, mode: 'write-everything' })!.mode, 'advisory', 'an unknown mode reads as advisory');
});

test('★★ windowP50Kwh: the window\'s P50 PV and median load; null unless every hour is covered', () => {
  const hours = band(NOW);
  const w = { startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) };
  const r = windowP50Kwh(hours, w);
  const pv = [10, 11, 12, 13, 14].reduce((a, h) => a + pvW(h) / 1000, 0);
  const load = [10, 11, 12, 13, 14].reduce((a, h) => a + loadW(h) / 1000, 0);
  assert.equal(r.windowPvP50Kwh, Math.round(pv * 100) / 100);
  assert.equal(r.windowLoadP50Kwh, Math.round(load * 100) / 100);
  assert.deepEqual(windowP50Kwh(hours.filter((h) => h.ts !== phx(10, 15, 12)), w), { windowPvP50Kwh: null, windowLoadP50Kwh: null });
});

test('★★ backupLegSizing / costLegSizing: option A for the backup, 23:00 and the on-peak for the cost leg', () => {
  const b = backupLegSizing(MODEL, { role: 'backup', kind: 'overnight', startMs: phx(10, 14, 23), endMs: phx(10, 15, 5) });
  assert.equal(b.spec.role, 'backup');
  assert.equal(b.nextRechargeMs, nextChargeableOpenMs(MODEL, phx(10, 15, 6), OVERNIGHT_CYCLE));
  assert.equal(b.nextRechargeMs, phx(10, 15, 23));
  // Sunday's backup (Monday 00:00–05:00) walks to Monday 23:00.
  const sun = backupLegSizing(MODEL, { role: 'backup', kind: 'overnight', startMs: phx(10, 19, 0), endMs: phx(10, 19, 5) });
  assert.equal(sun.nextRechargeMs, phx(10, 19, 23));
  const c = costLegSizing(MODEL, { role: 'cost', kind: 'super_off_peak', startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) }, CFG, { chgMaxSocPcts: [80, 80], backupHold: null });
  assert.equal(c.spec.curtailFromPct, 70);
  assert.equal(c.nextRechargeMs, phx(10, 15, 23));
  assert.equal(c.surplusEndMs, phx(10, 15, 16));
  assert.equal(c.spec.packAcceptKw, null, 'the default acceptance until it is measured');
});

/* ══ the wiring (index.ts is not importable: its source is checked) ═══════════════════════ */

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const INDEX = src('../src/index.ts');
const SHADOW = src('../src/middayShadow.ts');

test('★★★ middayShadow.ts has no device, push, speech or persistence path', () => {
  const imports = [...SHADOW.matchAll(/^import [^;]+ from '([^']+)';$/gm)].map((m) => m[1]);
  // R5 — and the words (chargeAnnounce.ts, chargeText.ts: pure builders, checked below) and the
  // NotifyMessage type.
  assert.deepEqual(imports.sort(), [
    './chargeAnnounce.js', './chargeTaper.js', './chargeText.js', './chargeWindows.js', './nightChargeActuator.js',
    './nightChargeAdvisor.js', './notify.js', './recorder.js', './tariff.js',
  ].sort());
  // Only types and pure helpers from the actuator, the recorder and notify.
  assert.match(SHADOW, /^import \{ APPLY_LEAD_MS, clampReserveTarget, MAX_SPOKEN_ADVISORY_CHARS, revertDueMs, type NightChargeMode \} from '\.\/nightChargeActuator\.js';$/m);
  assert.match(SHADOW, /^import type \{ NightLedgerRow \} from '\.\/recorder\.js';$/m);
  assert.match(SHADOW, /^import type \{ NotifyMessage \} from '\.\/notify\.js';$/m);
  assert.match(SHADOW, /^import \{ eveningAnnouncement \} from '\.\/chargeAnnounce\.js';$/m);
  // The word builders send and speak nothing: they import notify.ts's builders, never its senders.
  for (const f of ['../src/chargeText.ts', '../src/chargeAnnounce.ts']) {
    const t = src(f);
    for (const banned of ['sendNotification', 'broadcast', '.announce(', 'writeFileSync', 'atomicWrite', 'setBackupReserveSoc', 'commands']) {
      assert.ok(!t.includes(banned), `${banned} in ${f}`);
    }
  }
  for (const banned of ['commands', 'sendNotification', 'broadcast', 'announce(', 'writeFileSync', 'atomicWrite', 'persist']) {
    assert.ok(!SHADOW.includes(banned) || banned === 'persist' && !/\bpersist[A-Z(]/.test(SHADOW), `${banned} in middayShadow.ts`);
  }
});

/** The shadow block of index.ts: from its banner to the next function the file had before it. */
function shadowBlock(): string {
  const a = INDEX.indexOf('R4 (v1.189.0) — THE WINTER MID-DAY CYCLE IN SHADOW');
  const b = INDEX.indexOf(' * v1.39.0 one-time-per-boot, idempotent repair', a);
  assert.ok(a > 0 && b > a, 'the shadow block is found');
  return INDEX.slice(a, b);
}

test('★★★ index.ts: the shadow block writes nothing — no panel writer, no cycle persist, no push, no speech, no plan holder', () => {
  const blk = shadowBlock();
  for (const banned of [
    'setBackupReserveSoc', 'setChannelForceCharge', 'setForceChargeCeiling', 'persistCycle(', 'persistNightActuation(',
    'persistTrailing(', 'sendNotification(', 'broadcast.', 'announce(', 'setLatestNightChargePlan(', 'recordNightPlan(',
    'writeNightChargeLatch(', 'NIGHT_CHARGE_PLANSNAP_PATH', 'NIGHT_CHARGE_ACTUATION_PATH', 'stampLegOutcome(',
  ]) {
    assert.ok(!blk.includes(banned), `${banned} in the shadow block`);
  }
  // The arm probe drops armCycle's cycle: only the verdict leaves.
  assert.match(blk, /const verdict = armCycle\(nightCycleView\(\), day, cands\.map/);
  assert.match(blk, /return \{ armed: verdict\.legs\.map\(\(l\) => l\.leg\), refused: verdict\.refused \};/);
  assert.equal(blk.split('verdict.cycle').length - 1, 0);
  // Its own file, its own holder; a ledger stamp only onto a row the evening job recorded.
  assert.match(blk, /atomicWriteFileSync\(NIGHT_CHARGE_MIDDAY_SHADOW_PATH, JSON\.stringify\(r\)\);/);
  assert.match(blk, /if \(!recorder\.readNightLedger\(3\)\.some\(\(r\) => r\.plan_date === day\)\) \{/);
  assert.match(blk, /recorder\.recordNightOutcome\(day, cols\);/);
  // The evening runs only once the live job latched today, inside its window.
  assert.match(blk, /if \(readNightChargeLatch\(\)\.lastNotifyDay === today && cur\?\.day !== today && nowMin >= fireMin && nowMin < 23 \* 60\) \{/);
  // The refresh needs a fresh panel, is re-read after the await, and is persisted before it is logged.
  assert.match(blk, /const sized = await sizeShadowLeg\(sizing, false\);/);
  // A night the live overnight leg wrote is not re-sized (liveOvernightWrote), before any sizing.
  assert.match(blk, /let refresh = liveOvernightWrote\(cur, nightActuationMem\) \? notComparableRefresh\(nowMs\)\n\s+: due === 'stand' \? standingRefresh\(cur, nowMs\) : null;/);
  assert.match(blk, /if \(live == null \|\| live\.day !== cur\.day \|\| live\.computedAtMs !== cur\.computedAtMs \|\| live\.refresh != null\) return;/);
  assert.ok(blk.indexOf('persistMiddayShadow(next);') < blk.indexOf('app.log.info(middayShadowRefreshLogLine(next, refresh));'));
  // The tick is registered beside the actuator tick, on its own single-flight.
  assert.match(INDEX, /const nightMiddayShadowTick = setInterval\(\(\) => \{ void runMiddayShadowTick\(\); \}, 60 \* 1000\);/);
  assert.match(blk, /if \(middayShadowInFlight\) return;\n\s+middayShadowInFlight = true;/);
});

test('★★★ index.ts: a shadow leg is returned only — no plan holder, no snapshot, no calibration log', () => {
  const fn = INDEX.slice(INDEX.indexOf('async function recomputeNightChargePlan('), INDEX.indexOf('function armedExpectedBuyKwh('));
  assert.match(fn, /\n\s+const shadowLeg = opts\.shadowLeg \?\? null;\n/);
  assert.match(fn, /const legRole: ChargeLegRole = shadowLeg\?\.spec\.role \?\? opts\.role \?\? 'cost';/);
  assert.match(fn, /\n\s+if \(!shadowLeg\) setLatestNightChargePlan\(plan\);\n/);
  assert.equal(fn.split('setLatestNightChargePlan(').length - 1, 1);
  assert.match(fn, /if \(!shadowLeg && plan\.window && nowMs < plan\.window\.startMs\) \{\n\s+try \{\n\s+atomicWriteFileSync\(NIGHT_CHARGE_PLANSNAP_PATH/);
  assert.match(fn, /if \(!shadowLeg && buyDebiasCal\.basis === 'measured'/);
  assert.match(fn, /const buyDebiasUnmeasured = shadowLeg \? null : buyDebiasUnmeasuredLogLine\(buyDebiasCal\);/);
  assert.match(fn, /if \(!shadowLeg && loadBandCal\.basis === 'measured'/);
  assert.match(fn, /if \(costLoadBuilt && !shadowLeg\) \{/);
  // The live snapshot is keyed by the plan date that owns the cycle (an overnight plan: this evening).
  assert.match(fn, /day: planDateOwningCycle\(\{\n\s+nowMs, firstLegStartMs: plan\.window\.startMs, timezone: 'America\/Phoenix',\n\s+notifyMinuteOfDay: NIGHT_CHARGE_NOTIFY_HOUR \* 60 \+ NIGHT_CHARGE_NOTIFY_MINUTE,\n\s+\}\),/);
  // The evening job and its arm are the overnight leg's alone.
  const job = INDEX.slice(INDEX.indexOf('async function runNightChargeEveningJobInner('), INDEX.indexOf('R4 (v1.189.0) — THE WINTER MID-DAY CYCLE IN SHADOW'));
  assert.equal(job.split('runMiddayShadow').length - 1, 0, 'the evening job does not run the shadow');
  assert.match(job, /const arm = armCycle\(nightCycleView\(\), today, \[\{\n\s+role: 'cost', kind: 'overnight', plan,/);
  assert.equal(job.split('shadowLeg').length - 1, 0);
});

test('★★★ the entities: the night ones keep the live plan; the mid-day ones the shadow, never recommended', () => {
  const md = src('../src/mqttDiscovery.ts');
  for (const s of [md, INDEX]) {
    assert.ok(s.includes('...nightChargeStateFields(getLatestNightChargePlan()),'));
    assert.ok(s.includes('...nightChargeRoleFields(getLatestNightChargePlan()),'));
    assert.ok(s.includes('...middayChargeStateFields(getMiddayShadow()),'));
  }
  // The recommended field is the constant false in both return shapes.
  const fn = SHADOW.slice(SHADOW.indexOf('export function middayChargeStateFields('), SHADOW.indexOf('export function middayShadowLedgerColumns('));
  assert.equal(fn.split('midday_charge_recommended: false,').length - 1, 2);
  assert.equal(fn.split('midday_charge_recommended:').length - 1, 3, 'declared once, false twice');
  // The status serves the record only while it is current.
  assert.match(INDEX, /middayShadow: shadowServed\(getMiddayShadow\(\), Date\.now\(\)\) \? getMiddayShadow\(\) : null,/);
});

test('★★ nightChargeRoleFields: cost on a fresh plan with a window; null otherwise', () => {
  const p = livePlan();
  assert.deepEqual(nightChargeRoleFields(p, NOW), { night_charge_role: 'cost' });
  assert.deepEqual(nightChargeRoleFields(p, NOW, 'backup'), { night_charge_role: 'backup' });
  assert.deepEqual(nightChargeRoleFields(null, NOW), { night_charge_role: null });
  assert.deepEqual(nightChargeRoleFields({ ...p, window: null }, NOW), { night_charge_role: null });
  assert.deepEqual(nightChargeRoleFields(p, NOW + 13 * H), { night_charge_role: null }, 'stale after 12 h');
  assert.deepEqual(nightChargeRoleFields({ ...p, basisComplete: false }, NOW), { night_charge_role: null });
  assert.ok(APPLY_LATE_MS > 0);
});
