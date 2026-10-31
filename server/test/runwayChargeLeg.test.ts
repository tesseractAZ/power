import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chargeLegStep } from '../src/physics/chargeLeg.js';
import {
  computeRunway, resetRunwayCache, setPoolBasisOverrideForTesting, resetPoolEnergyBasisForTesting,
  RUNWAY_CHARGE_EFFICIENCY, RUNWAY_DISCHARGE_EFFICIENCY, DISPATCH_ROUND_TRIP_EFFICIENCY,
  type DayForecast,
} from '../src/analytics.js';
import { classifyRunway } from '../src/runwayAlarm.js';
import {
  computeNightChargePlan, expectedCarryKwh, expectedForceChargeStart, plannerSizingNeedBuyKwh,
  type NightChargeHour, type NightChargeInputs,
} from '../src/nightChargeAdvisor.js';
import { forceChargeStartAtMs } from '../src/nightForceCharge.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.194.0 — THE CHARGE LEG. Every walk that steps a pool hour by hour credited a PV surplus to
 * the cells at unity: the runway (the alarm path), the day and multi-day SoC projections, the
 * probabilistic band, the night-charge planner's islanded sizing walk and its median walks, and
 * the mid-day shadow's held-import walk. Charging loses energy: on 29 measured PV-surplus spans
 * (docs/PERFORMANCE.md), with the 270 W overhead removed, the pool gained 2-7% less than
 * pv − load/0.94 predicts. A surplus now reaches the cells at √DISPATCH_ROUND_TRIP_EFFICIENCY
 * (0.927 by default) — the per-leg figure the dispatch plan and the planner's grid charge already
 * used — through one pure step, chargeLegStep (physics/chargeLeg.ts). A deficit is untouched.
 *
 * Every figure below is worked by hand; the "before" figures are the same walk at unity. The
 * source pins (every walk calls the step) are in runwayChargeLegPins.test.ts, so a mutant of a walk
 * is caught here by its figures, not by its text.
 * ═════════════════════════════════════════════════════════════════════════ */

const H = 3_600_000;
const ETA_C = Math.sqrt(0.86); // 0.92736

afterEach(() => { setPoolBasisOverrideForTesting(null); resetPoolEnergyBasisForTesting(); resetRunwayCache(); });

/* ── (a) the step ─────────────────────────────────────────────────────── */

test('★★★ chargeLegStep: a surplus × η, a deficit as it is; η clamped to [0, 1], a non-finite η credits nothing', () => {
  assert.equal(chargeLegStep(-2, 0.9274), -2, 'a deficit is the pool\'s own drain: untouched');
  assert.ok(Math.abs(chargeLegStep(5, 0.9274) - 4.637) < 1e-12);
  assert.equal(chargeLegStep(0, 0.9274), 0);
  assert.ok(Number.isNaN(chargeLegStep(Number.NaN, 0.9274)), 'a NaN net passes through for the caller\'s own guard');
  assert.equal(chargeLegStep(5, 1.2), 5, 'no configuration credits a surplus above unity');
  assert.equal(chargeLegStep(5, -0.5), 0);
  assert.equal(chargeLegStep(5, Number.NaN), 0, 'fail-closed: no credit, the walk reads shorter');
  assert.equal(chargeLegStep(5, Number.POSITIVE_INFINITY), 0);
  // Never above the net, and monotone in it (a bisection over a walk stays exact).
  let prev = -Infinity;
  for (let n = -10; n <= 10; n += 0.25) {
    const s = chargeLegStep(n, ETA_C);
    assert.ok(s <= n + 1e-12 && s >= prev, `n=${n}`);
    prev = s;
  }
});

/* ── (b) the efficiency ───────────────────────────────────────────────── */

test('★★★ RUNWAY_CHARGE_EFFICIENCY is √DISPATCH_ROUND_TRIP_EFFICIENCY: 0.927, under every measured span and under the discharge leg', () => {
  assert.equal(RUNWAY_CHARGE_EFFICIENCY, Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY));
  assert.ok(Math.abs(RUNWAY_CHARGE_EFFICIENCY - 0.9274) < 1e-4, `${RUNWAY_CHARGE_EFFICIENCY}`);
  // The lowest of the 29 measured PV-surplus spans (overhead removed) charged 7% under pv − load/0.94.
  assert.ok(RUNWAY_CHARGE_EFFICIENCY <= 0.93, 'at or below the lowest measured span');
  assert.ok(RUNWAY_CHARGE_EFFICIENCY < 1, 'a surplus is never credited at unity');
  assert.ok(RUNWAY_CHARGE_EFFICIENCY <= RUNWAY_DISCHARGE_EFFICIENCY, 'a round-trip leg never exceeds the measured discharge leg');
});

/* ── (c), (d) the runway ──────────────────────────────────────────────── */

function panel(remainingWh: number): Record<string, DeviceSnapshot> {
  return {
    'SN-SHP2': {
      sn: 'SN-SHP2', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: 0,
      projection: { kind: 'shp2', backupRemainWh: remainingWh, backupFullCapWh: 92_160, backupReserveSoc: 16, circuits: [] },
    } as unknown as DeviceSnapshot,
  };
}
/** 24 forecast hours: `pvW(h)` and a flat 3 kW house. The panel_load window reads the same 3 kW, so
 *  the observed-load blend changes nothing. */
function runwayOn(remainingWh: number, pvW: (h: number) => number) {
  resetRunwayCache();
  setPoolBasisOverrideForTesting({ capacityScale: 1, overheadW: 270 });
  const now = Date.now();
  const rec = makeRecorderStub({ query: (_sn, m) => (m === 'panel_load' ? [{ ts: now - 30 * 60_000, value: 3_000 }, { ts: now - 5 * 60_000, value: 3_000 }] : []) });
  const hours = Array.from({ length: 24 }, (_, h) => ({ ts: now + h * H, forecastPvW: pvW(h), forecastLoadW: 3_000, projectedSocPct: null }));
  return computeRunway(panel(remainingWh), rec, { hours, reserveSoc: 16, minProjectedSoc: null } as unknown as DayForecast);
}
// The drain of every hour: max(3000/0.94, 270 + 3000/0.94) = 3461.5 W. A 9 kW sunny hour's net is
// 9 − 3.4615 = 5.5385 kWh: 5.1362 kWh into the cells at 0.92736 (5.5385 at unity before v1.194.0).
const DRAIN = 0.27 + 3 / 0.94;
const SURPLUS = 9 - DRAIN;
const RESERVE = 0.16 * 92.16; // 14.7456 kWh

test('★★★ the runway: an 18 kWh pool with two sunny hours ahead now reads the MEDIUM alarm (5.9 h to the reserve), not LOW (6.1 h)', () => {
  // 18 kWh, 9 kW of PV in hours 0-1 under 3 kW: 18 + 2 × 5.1362 = 28.272 kWh at 2 h, then 3.4615 kWh
  // an hour: the reserve at 2 + (28.272 − 14.7456) / 3.4615 = 5.908 h, empty at 2 + 28.272 / 3.4615
  // = 10.168 h. At unity the pool reached 29.077 kWh: 6.140 h / 10.400 h — the LOW tier, because the
  // medium one starts at a reserve crossing within 6 h.
  const r = runwayOn(18_000, (h) => (h < 2 ? 9_000 : 0));
  const atTwo = 18 + 2 * SURPLUS * ETA_C;
  const toReserve = 2 + (atTwo - RESERVE) / DRAIN;
  const toEmpty = 2 + atTwo / DRAIN;
  assert.ok(Math.abs(toReserve - 5.908) < 0.001 && Math.abs(toEmpty - 10.168) < 0.001, `by hand ${toReserve} / ${toEmpty}`);
  assert.ok(Math.abs((r.reserveAtMs! - r.generatedAt) / H - toReserve) < 1e-5, `hoursToReserve ${r.hoursToReserve}`);
  assert.equal(r.hoursToReserve, 5.9);
  assert.equal(r.hoursToEmpty, 10.2);
  assert.equal(classifyRunway(r), 'medium');
  // The same pool at unity, for the record: 6.1 h — classifyRunway's LOW.
  const unityReserve = 2 + (18 + 2 * SURPLUS - RESERVE) / DRAIN;
  assert.ok(Math.abs(unityReserve - 6.140) < 0.001);
  assert.equal(classifyRunway({ ...r, hoursToReserve: 6.1, hoursToEmpty: 10.4 }), 'low');
  // The PV the runway reports is the forecast's, unchanged: the leg acts on the pool, not the sun.
  assert.equal(r.forecastPvUsedKwh, 18);
});

test('★★ the runway across a sunny day: the reserve 1 h sooner (22.8 h, was 23.8), the pool ends 3.2 kWh lower', () => {
  // 25 kWh at the start, 3 kW all day, 9 kW of PV in hours 2-9. Hours 0-1: 25 − 2 × 3.4615 = 18.077.
  // Hours 2-9: + 8 × 5.1362 = 59.167 kWh (unity: + 44.308 = 62.385). Then 3.4615 kWh an hour: the
  // reserve at 10 + (59.167 − 14.7456) / 3.4615 = 22.83 h (unity 23.76 h); the 24th hour ends at
  // 59.167 − 14 × 3.4615 = 10.706 kWh (unity 13.924), the trough.
  const r = runwayOn(25_000, (h) => (h >= 2 && h < 10 ? 9_000 : 0));
  const top = 25 - 2 * DRAIN + 8 * SURPLUS * ETA_C;
  const toReserve = 10 + (top - RESERVE) / DRAIN;
  const end = top - 14 * DRAIN;
  assert.ok(Math.abs(toReserve - 22.833) < 0.001 && Math.abs(end - 10.706) < 0.001, `by hand ${toReserve} / ${end}`);
  assert.ok(Math.abs((r.reserveAtMs! - r.generatedAt) / H - toReserve) < 1e-5);
  assert.equal(r.hoursToReserve, 22.8);
  assert.equal(r.endKwh, 10.71);
  assert.equal(r.troughKwh, 10.71);
  assert.equal(r.hoursToEmpty, null);
  const unityEnd = 25 - 2 * DRAIN + 8 * SURPLUS - 14 * DRAIN;
  assert.ok(Math.abs(unityEnd - 13.924) < 0.001 && Math.abs(unityEnd - end - 3.218) < 0.001, `${unityEnd - end} kWh lower`);
});

test('★★ the runway: a horizon with no surplus is exactly the walk it always was', () => {
  // Night only: 30 kWh, 3 kW. The reserve at (30 − 14.7456) / 3.4615 = 4.407 h, empty at 8.667 h.
  const r = runwayOn(30_000, () => 0);
  assert.ok(Math.abs((r.reserveAtMs! - r.generatedAt) / H - (30 - RESERVE) / DRAIN) < 1e-5);
  assert.ok(Math.abs((r.emptyAtMs! - r.generatedAt) / H - 30 / DRAIN) < 1e-5);
  // PV that serves part of the load but never exceeds the drain is no surplus either.
  const partSun = runwayOn(30_000, (h) => (h < 3 ? 3_000 : 0));
  const atThree = 30 - 3 * (DRAIN - 3);
  assert.ok(Math.abs((partSun.reserveAtMs! - partSun.generatedAt) / H - (3 + (atThree - RESERVE) / DRAIN)) < 1e-5);
});

/* ── (f) the night-charge planner ─────────────────────────────────────── */

test('★★★ expectedCarryKwh: an hour of 5 kW sun over a 1.88 kW house adds 2.782 kWh (3.000 before v1.194.0)', () => {
  // 5 − 1.88 / 0.94 = 3.000 kWh of surplus × 0.92736 = 2.782 kWh.
  const hours: NightChargeHour[] = [{ ts: 0, pvP10W: 0, loadP90W: 0, loadP50W: 1_880, pvP50W: 5_000 }];
  const carry = expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, legEff: ETA_C, hours, fromMs: 0, toMs: H })!;
  assert.ok(Math.abs(carry - 50 - 2.782) < 0.001, `${carry}`);
  // The same hour with the house over the sun drains in full: 1 − 6.58 / 0.94 = −6.000 kWh.
  const dark = expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, legEff: ETA_C, hours: [{ ...hours[0], loadP50W: 6_580, pvP50W: 1_000 }], fromMs: 0, toMs: H })!;
  assert.ok(Math.abs(dark - 44) < 1e-9, `${dark}`);
});

test('★★ expectedForceChargeStart: sun in the window lifts the pool at legEff, so the just-in-time start comes sooner and lower', () => {
  // 5 h window, 70 of 100 kWh, written reserve 50, ceiling 80.4 (stop 80), no envelope ⇒ the fixed
  // 10 kW plan rate, dischargeEff 1, legEff 0.9. 6 kW of P50 sun over a 4 kW house: +2 kWh an hour,
  // +1.8 stored. The start is where t = 5 h − ((80.4 − pool(t)) / 10 h + 15 min) with
  // pool(t) = 70 + 1.8 t: t = 3.71 / 0.82 = 4.524 h, pool 78.14 kWh. At unity (pool 70 + 2 t) it was
  // t = 3.71 / 0.8 = 4.638 h, pool 79.28 kWh.
  const hours: NightChargeHour[] = [0, 1, 2, 3, 4].map((i) => ({ ts: i * H, pvP10W: 0, loadP90W: 9_000, loadP50W: 4_000, pvP50W: 6_000 }));
  const r = expectedForceChargeStart({
    startKwh: 70, reserveKwh: 50, fullKwh: 100, ceilingPct: 80.4, hours, fromMs: 0, windowEndMs: 5 * H,
    dischargeEff: 1, chargeCapKw: 20, envelopeKw: null, legEff: 0.9,
  })!;
  assert.ok(Math.abs(r.startMs! / H - 4.524) < 0.02, `start ${r.startMs! / H} h`);
  assert.ok(Math.abs(r.packKwh - 78.14) < 0.05, `pack ${r.packKwh}`);
  assert.ok(r.startMs! >= forceChargeStartAtMs(5 * H, 80.4, r.packKwh, 100, null, null));
});

/** A sizing horizon on a 100 kWh pool, window 03:00-09:00 from B (legacy-pct cushion: the post-window
 *  whole-house trough is the cushion test). */
const B = 1_800_000 * H;
function sizingInputs(legEff: number): NightChargeInputs {
  const hour = (i: number): NightChargeHour => ({
    ts: B + i * H,
    pvP10W: i >= 9 && i < 17 ? 6_000 : 0,
    // The pre-window hours draw 2 kW; the window none (no bypass term: the lift lands whole); the
    // eight sunny hours 2 kW; the seven evening hours 4 kW.
    loadP90W: i < 3 ? 2_000 : i < 9 ? 0 : i < 17 ? 2_000 : 4_000,
  });
  return {
    nowMs: B, fullKwh: 100, socNowPct: 20, reserveFloorPct: 10, cushionPct: 15, socCoherent: true,
    legEff, dischargeEff: 0.94, chargeCapKw: 100, gridInputCapKw: null,
    window: { startMs: B + 3 * H, endMs: B + 9 * H },
    horizon: Array.from({ length: 24 }, (_, i) => hour(i)),
    morningPvSurplusP90Kwh: null, confidenceTier: 'forecast', basisComplete: true, minBuyKwh: 1,
  };
}

test('★★★ the sizing trough after a sunny day: 30.98 kWh of P10 surplus stores 28.73, the trough sits 2.25 kWh lower and the buy rises 2.43 kWh', () => {
  // Post-window: 8 h × (6 − 2 / 0.94) = 30.979 kWh of surplus, then 7 h × 4 / 0.94 = 29.787 kWh out.
  // The trough is the 24th hour's end: P + 30.979 η − 29.787. The line is 10 + 15 = 25 kWh. The pack at
  // the window close with no buy is 20 − 3 × 2 / 0.94 = 13.617 kWh, and with the window's house at 0
  // the lift lands whole: lift = 25 + 29.787 − 30.979 η − 13.617; buy = lift / legEff.
  const surplus = 8 * (6 - 2 / 0.94);
  const evening = 7 * (4 / 0.94);
  const noBuy = 20 - 3 * (2 / 0.94);
  assert.ok(Math.abs(surplus - 30.979) < 0.001 && Math.abs(surplus * ETA_C - 28.729) < 0.001);
  const p = computeNightChargePlan(sizingInputs(ETA_C));
  const lift = 25 + evening - surplus * ETA_C - noBuy;
  assert.equal(p.chargeTonight, true);
  assert.ok(Math.abs(p.requiredExtraKwh! - Math.round(lift * 100) / 100) <= 0.01, `required ${p.requiredExtraKwh} vs ${lift}`);
  assert.ok(Math.abs(p.buyKwh! - lift / ETA_C) <= 0.01, `buy ${p.buyKwh} vs ${lift / ETA_C}`);
  // The surplus at unity — the sizing before v1.194.0 — needed 2.2505 kWh less lift: 2.43 kWh less buy.
  const unityLift = 25 + evening - surplus - noBuy;
  assert.ok(Math.abs((lift - unityLift) - 2.2505) < 0.001);
  assert.ok(Math.abs((p.buyKwh! - unityLift / ETA_C) - 2.427) < 0.011, `buy rise ${p.buyKwh! - unityLift / ETA_C}`);
  // The with-buy trough holds the line exactly: the target pack less the evening, plus the stored sun.
  assert.ok(Math.abs((p.targetSocPct! / 100) * 100 - (noBuy + lift)) < 0.06, `target ${p.targetSocPct}%`);
});

test('★ DISPATCH_ROUND_TRIP_EFFICIENCY = 1 is not the planner before v1.194.0: its grid charge turns lossless too, so it buys 0.80 kWh below the earlier default', () => {
  // At legEff 1 the step is the identity, so the surplus is credited in full as it was before v1.194.0,
  // but the planner's buy (lift / legEff) loses the grid charge's own loss as well. The horizon above:
  // the lift with the surplus at unity is 25 + 29.787 − 30.979 − 13.617 = 10.191 kWh. Before v1.194.0
  // the default bought it at / η = 10.99 kWh; at legEff 1 it is bought at par.
  const surplus = 8 * (6 - 2 / 0.94);
  const evening = 7 * (4 / 0.94);
  const noBuy = 20 - 3 * (2 / 0.94);
  const unityLift = 25 + evening - surplus - noBuy;
  assert.ok(Math.abs(unityLift - 10.191) < 0.001, `${unityLift}`);
  const atUnity = computeNightChargePlan(sizingInputs(1));
  assert.equal(atUnity.chargeTonight, true);
  assert.ok(Math.abs(atUnity.buyKwh! - unityLift) <= 0.01, `buy ${atUnity.buyKwh} vs ${unityLift}`);
  const earlierDefault = unityLift / ETA_C;
  assert.ok(Math.abs(earlierDefault - 10.989) < 0.001);
  assert.ok(earlierDefault - atUnity.buyKwh! > 0.79, `${earlierDefault - atUnity.buyKwh!} kWh below the earlier default`);
});

test('★★ buy_err_kwh after the charge leg: a surplus-hour PV miss moves the planner\'s buy 1:1, the ledger\'s fixed conversion 1/legEff (7.8 % more); a deficit-hour miss matches', () => {
  // The ledger scores a night with plannerSizingNeedBuyKwh: planBuy + netMiss / legEff, a fixed
  // conversion kept for every algo-v3 row (nightChargeGate.ts). Re-sizing the same horizon on the
  // "actual" PV gives the planner's own answer. In a surplus hour the planner stores the PV at legEff
  // and buys at 1/legEff, so the two cancel; in a deficit hour the PV offsets drain 1:1 and the
  // conversion is exact.
  const fc = computeNightChargePlan(sizingInputs(ETA_C));
  const withPv = (pv: (i: number, w: number) => number): NightChargeInputs => {
    const base = sizingInputs(ETA_C);
    return { ...base, horizon: base.horizon.map((h, i) => ({ ...h, pvP10W: pv(i, h.pvP10W) })) };
  };
  const scored = (fcPv: number, actPv: number): number => plannerSizingNeedBuyKwh({
    planBuyKwh: fc.buyKwh!, forecastPvKwh: fcPv, actualPvKwh: actPv, forecastLoadKwh: 50, actualLoadKwh: 50, legEff: ETA_C,
  });
  assert.equal(fc.chargeTonight, true);

  // Cloudier: 4 kW instead of 6 kW in the eight sunny hours (still a surplus over 2 / 0.94), 16 kWh short.
  const cloudy = computeNightChargePlan(withPv((i, w) => (w > 0 ? 4_000 : 0)));
  assert.equal(cloudy.minProjSocTsMs, fc.minProjSocTsMs, 'the same trough (the horizon\'s end) binds both');
  assert.ok(Math.abs(cloudy.buyKwh! - fc.buyKwh! - 16) <= 0.02, `planner: +${cloudy.buyKwh! - fc.buyKwh!} kWh (16 × η / η)`);
  const cloudyScored = scored(48, 32);
  assert.ok(Math.abs(cloudyScored - fc.buyKwh! - 16 / ETA_C) <= 0.01, `ledger: +${cloudyScored - fc.buyKwh!} kWh`);
  assert.ok(cloudyScored > cloudy.buyKwh!, 'the ledger reads the deeper under-buy: the gate errs toward blocking');
  assert.ok(Math.abs((cloudyScored - cloudy.buyKwh!) - 16 * (1 / ETA_C - 1)) <= 0.02, `gap ${cloudyScored - cloudy.buyKwh!} (1.25)`);

  // Sunnier: 6.5 kW, 4 kWh more PV. The planner buys 4 kWh less; the ledger says 4.31 less (a larger over-buy).
  const sunny = computeNightChargePlan(withPv((i, w) => (w > 0 ? 6_500 : 0)));
  assert.equal(sunny.minProjSocTsMs, fc.minProjSocTsMs);
  assert.ok(Math.abs(fc.buyKwh! - sunny.buyKwh! - 4) <= 0.02, `planner: −${fc.buyKwh! - sunny.buyKwh!} kWh`);
  assert.ok(Math.abs(fc.buyKwh! - scored(48, 52) - 4 / ETA_C) <= 0.01);

  // A deficit hour: 0.5 kW of evening PV under the 4 kW house (hours 17-23) that never came, 3.5 kWh
  // short. (Small enough that the evening's end stays the trough: past 0.66 kW the first hour after
  // the window close binds instead, and the rest of the evening's PV no longer moves the buy.)
  const eveningFc = computeNightChargePlan(withPv((i, w) => (i >= 17 ? 500 : w)));
  const eveningAct = computeNightChargePlan(sizingInputs(ETA_C));
  const eveningScored = plannerSizingNeedBuyKwh({
    planBuyKwh: eveningFc.buyKwh!, forecastPvKwh: 51.5, actualPvKwh: 48, forecastLoadKwh: 50, actualLoadKwh: 50, legEff: ETA_C,
  });
  assert.equal(eveningFc.minProjSocTsMs, eveningAct.minProjSocTsMs, 'the same trough binds both');
  assert.ok(Math.abs(eveningAct.buyKwh! - eveningFc.buyKwh! - 3.5 / ETA_C) <= 0.02, `planner: +${eveningAct.buyKwh! - eveningFc.buyKwh!} kWh`);
  assert.ok(Math.abs(eveningScored - eveningAct.buyKwh!) <= 0.02, `a deficit-hour miss converts exactly: ${eveningScored} vs ${eveningAct.buyKwh}`);
});

test('★★ buy_err_kwh after the charge leg: a surplus-hour LOAD miss shifts by the same 1/legEff (6 % shallow before, 1.4 % deep now); a deficit-hour load miss reads 6 % shallow, as before', () => {
  // A load miss also passes the discharge leg: the planner draws load / dischargeEff from the pack.
  // Before v1.194.0 a surplus hour's net (pv − load / 0.94) went in at unity, so +ΔL there moved the
  // buy by ΔL / (0.94 η) and the ledger's ΔL / η read 0.94 of it. The planner now stores that whole
  // net at η, so the buy moves ΔL / 0.94 and the ledger reads 0.94 / η = 1.0136 of it: the same factor
  // 1 / η (7.8 %) as a surplus-hour PV miss, toward blocking. A deficit hour's load is drain at
  // 1 / 0.94 on both trees, so there the ledger reads 0.94 of the planner's move before and after.
  const fc = computeNightChargePlan(sizingInputs(ETA_C));
  const withLoad = (load: (i: number, w: number) => number): NightChargeInputs => {
    const base = sizingInputs(ETA_C);
    return { ...base, horizon: base.horizon.map((h, i) => ({ ...h, loadP90W: load(i, h.loadP90W) })) };
  };
  const scored = (actLoad: number): number => plannerSizingNeedBuyKwh({
    planBuyKwh: fc.buyKwh!, forecastPvKwh: 48, actualPvKwh: 48, forecastLoadKwh: 50, actualLoadKwh: actLoad, legEff: ETA_C,
  });

  // A heavier day: 2.5 kW instead of 2 kW in the eight sunny hours (2.5 / 0.94 = 2.66 kW, still under
  // 6 kW of PV, so every one stays a surplus hour), 4 kWh more house.
  const heavierDay = computeNightChargePlan(withLoad((i, w) => (i >= 9 && i < 17 ? 2_500 : w)));
  assert.equal(heavierDay.minProjSocTsMs, fc.minProjSocTsMs, 'the same trough (the horizon\'s end) binds both');
  const planner = heavierDay.buyKwh! - fc.buyKwh!;
  assert.ok(Math.abs(planner - 4 / 0.94) <= 0.02, `planner: +${planner} kWh (4 × η / 0.94 / η = 4.255)`);
  const ledger = scored(54) - fc.buyKwh!;
  assert.ok(Math.abs(ledger - 4 / ETA_C) <= 0.01, `ledger: +${ledger} kWh (4 / η = 4.313)`);
  assert.ok(ledger > planner, 'the ledger reads the deeper under-buy: a surplus-hour load miss is not scored as before');
  assert.ok(Math.abs(ledger / planner - 0.94 / ETA_C) <= 0.005, `ratio ${ledger / planner} (0.94 / η = 1.0136)`);
  // The same walk with the surplus at unity (the sizing before v1.194.0) moved the buy 4 / (0.94 η) =
  // 4.589 kWh, which the ledger read at 0.94: the ratio rises by exactly 1 / η.
  const unityPlanner = 4 / (0.94 * ETA_C);
  assert.ok(Math.abs(unityPlanner - 4.589) < 0.001 && Math.abs((4 / ETA_C) / unityPlanner - 0.94) < 1e-12);
  assert.ok(Math.abs((ledger / planner) / ((4 / ETA_C) / unityPlanner) - 1 / ETA_C) <= 0.005);

  // A heavier evening: 4.5 kW instead of 4 kW in the seven deficit hours, 3.5 kWh more house.
  const heavierEvening = computeNightChargePlan(withLoad((i, w) => (i >= 17 ? 4_500 : w)));
  assert.equal(heavierEvening.minProjSocTsMs, fc.minProjSocTsMs, 'the same trough binds both');
  const plannerE = heavierEvening.buyKwh! - fc.buyKwh!;
  assert.ok(Math.abs(plannerE - 3.5 / (0.94 * ETA_C)) <= 0.02, `planner: +${plannerE} kWh (3.5 / (0.94 η) = 4.015)`);
  const ledgerE = scored(53.5) - fc.buyKwh!;
  assert.ok(Math.abs(ledgerE / plannerE - 0.94) <= 0.005, `a deficit-hour load miss reads 0.94 of the planner's move, as before: ${ledgerE / plannerE}`);
});

test('★★ the with-buy window walk: sun in the window reaches the cells at legEff, so the lift that holds the line is 1.74 kWh larger', () => {
  // A window with P10 sun in it (the mid-day leg's shape): 03:00-09:00 at 4 kW of PV and no house load,
  // a 10 kW charger the packs accept in full (packAcceptKw 1000), then 15 h of 3.76 kW (4 kWh an hour
  // at 0.94) to the horizon's end. From 20 kWh the pool opens the window at 20 − 3 × 2 / 0.94 = 13.617.
  // The window's sun stores 6 × 4 × 0.92736 = 22.257 kWh whether or not the charger runs, so the pack
  // at the close is 13.617 + 22.257 + lift, and the trough (the horizon's end) is that less 60 kWh.
  // Holding the 25 kWh line: lift = 85 − 35.874 = 49.126 kWh, buy = lift / 0.92736 = 52.97 kWh. With
  // the window's sun at unity the lift was 47.383 kWh (buy 51.10): the line was missed by 1.74 kWh.
  const inputs: NightChargeInputs = {
    ...sizingInputs(ETA_C),
    chargeCapKw: 10,
    windowSpec: { kind: 'overnight', role: 'cost', packAcceptKw: 1000 },
    horizon: Array.from({ length: 24 }, (_, i): NightChargeHour => ({
      ts: B + i * H,
      pvP10W: i >= 3 && i < 9 ? 4_000 : 0,
      loadP90W: i < 3 ? 2_000 : i < 9 ? 0 : 3_760,
    })),
  };
  const open = 20 - 3 * (2 / 0.94);
  const sun = 6 * 4 * ETA_C;
  const lift = 85 - open - sun;
  assert.ok(Math.abs(lift - 49.126) < 0.001, `${lift}`);
  const p = computeNightChargePlan(inputs);
  assert.equal(p.chargeTonight, true);
  assert.equal(p.bindingCap, 'requirement', 'the charger delivers it: 6 × 10 × 0.927 = 55.6 kWh');
  assert.ok(Math.abs(p.requiredExtraKwh! - lift) <= 0.01, `required ${p.requiredExtraKwh} vs ${lift}`);
  assert.ok(Math.abs(p.buyKwh! - lift / ETA_C) <= 0.01, `buy ${p.buyKwh} vs ${lift / ETA_C}`);
  assert.equal(p.targetSocPct, 85);
  const unityLift = 85 - open - 6 * 4;
  assert.ok(Math.abs((lift - unityLift) - 24 * (1 - ETA_C)) < 1e-9 && Math.abs(lift - unityLift - 1.743) < 0.001);
});
