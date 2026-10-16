import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeNightChargePlan, buildNightChargeInputs, nightChargeStateFields, expectedCarryKwh,
  expectedWindowLiftKwh, expectedBuyFromPlan, expectedForceChargeStart, ledgerExpectedBuyKwh,
  chargeLevelPct, statedBuyKwh, armedExpectedPhrase, sizingBasisText, buyFiguresLogText, WORST_CASE_BASIS, chargeIsWindowBound,
  noChargeExpected, chargeReservePct, floorCushionLinePct, fmtPhoenixDayHm,
  type NightChargeInputDeps, type NightForecastHour, type NightChargePlan, type NightChargeHour,
} from '../src/nightChargeAdvisor.js';
import {
  armedWriteLevelPct, forceChargeEnabled, forceChargeStartAtMs, forceChargeStopPct, FORCE_CHARGE_MIN_RUN_MS,
  armedForceChargeStopPct, forceChargeNightOutcome, type ForceChargeNightOutcome, partialForceChargeOnFailureSlots,
} from '../src/nightForceCharge.js';
import {
  armFromPlan, emptyActuationState, nightChargeSpokenNotice, RESERVE_WRITE_MAX_PCT, MAX_SPOKEN_ADVISORY_CHARS,
  armRefusalReason, APPLY_LATE_MS, type NightActuationState,
  isNoChargeKwh, NO_CHARGE_EXPECTED_KWH, servedArmRefusal, coerceArmRefusalRecord,
  coerceActuationState, eveningNotArmedReason, ARM_UNDELIVERED_REASON,
} from '../src/nightChargeActuator.js';
import {
  buildNightChargeMessage, buildNightChargeMorningSummary, buildNightChargeApplyFailure, buildNightForceChargeOnFailure,
} from '../src/notify.js';
import { SENSORS, sensorDiscoveryConfig } from '../src/mqttDiscovery.js';
import {
  chargeFigureParts, sizingLine, holdSummary, refusedArmLead, floorCushionLinePct as webFloorCushionLinePct, fmtLinePct,
  NO_CHARGE_EXPECTED_KWH as WEB_NO_CHARGE_EXPECTED_KWH, noChargeExpected as webNoChargeExpected, writtenReservePct,
} from '../../web/src/cards/nightChargeText.js';

/**
 * v1.187.22 — the night-charge plan states the purchase it EXPECTS beside the worst case it is
 * SIZED on.
 *
 * 2026-10-12 21:30: SoC 53%, window 00:00-05:00, cost mode, force-charge riding the night. The
 * plan, its push, its spoken line and its card said "Buy ~64.2 kWh overnight → target 80.4%".
 * That is the planner's islanded worst case — P90 load (×1.35), a 19.3 kWh P90 EV block placed
 * before the window, no reserve floor on the carry — which put the pool at 16.9% at the window
 * open. The pool was really at 46%, and the write is level-driven (reserve 50%, then
 * force-charge to the 80.4% ceiling), so from there it draws ≈34 kWh. The night was cancelled
 * at 21:54 on the strength of a figure nearly twice the expected purchase.
 *
 * The fixture is shaped like that night: the forecast's median house load in the evening is
 * 2.8 kW (the observed load was ~2.4 kW; the forecast runs high), the load band factor is 1.35,
 * the 19.3 kWh P90 EV block starts at 21:00 (the predicted start), and the cost ceiling leaves
 * 18.06 kWh of morning solar headroom (80.4% of the 92.16 kWh pool).
 */

const H = 3_600_000;
const POOL = 92.16;
const LEG = 0.927;
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (mo: number, d: number, h: number, mi = 0) => Date.UTC(2026, mo - 1, d, h + 7, mi);
const NOW = phx(10, 12, 21, 30);
const WIN_START = phx(10, 13, 0);
const WIN_END = phx(10, 13, 5);
const NEXT_WINDOW = phx(10, 13, 23);
const P90_FACTOR = 1.35;

/** The forecast's median house load (no EV), kW, by Phoenix hour. */
const houseKw = (h: number): number => (h >= 21 || h < 0 ? 2.8 : h < 5 ? 2.2 : h < 17 ? 2.6 : 3.4);
/** A typical-day PV curve (P50), kW. */
const pvP50Kw = (h: number): number => (h >= 7 && h < 18 ? 6 * Math.sin(((h - 7 + 0.5) / 11) * Math.PI) : 0);

/** The Phoenix hour of a UTC ms. */
const phxHour = (ts: number): number => (new Date(ts).getUTCHours() + 17) % 24;

/** The band as index.ts builds it: P90 = forecastLoadW × factor, embedded EV × factor, P50 copied.
 *  `from` — the first hour; the day-ahead forecast's hours start at the NEXT hour (ceil(now)). */
function band(o: { evExpectedW?: (ts: number) => number; p50?: boolean; from?: number } = {}): NightForecastHour[] {
  const out: NightForecastHour[] = [];
  for (let ts = o.from ?? phx(10, 12, 21); ts < NEXT_WINDOW; ts += H) {
    const hour = phxHour(ts);
    const evW = o.evExpectedW?.(ts) ?? 0;
    const forecastLoadW = houseKw(hour) * 1000 + evW;
    const p50W = pvP50Kw(hour) * 1000;
    out.push({
      ts,
      pvP10W: p50W * 0.8,
      loadP90W: forecastLoadW * P90_FACTOR,
      embeddedEvW: evW * P90_FACTOR,
      ...(o.p50 === false ? {} : { loadP50W: forecastLoadW, pvP50W: p50W }),
    });
  }
  return out;
}

function deps(over: Partial<NightChargeInputDeps> = {}): NightChargeInputDeps {
  return {
    nowMs: NOW, fullKwh: POOL, socNowPct: 53, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.62, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90,
    legEff: LEG, dischargeEff: 0.94, chargeCapKw: 17.8, gridInputCapKw: 17,
    periodIdAt: (ms) => (ms >= WIN_START && ms < WIN_END) || ms >= NEXT_WINDOW ? 'overnight' : 'off_peak',
    cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: band(), dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: NEXT_WINDOW,
    ev: { p90SessionKwh: 19.3, chargeStartMs: phx(10, 12, 21), sessionCount: 12 },
    evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 14, bandCoverageFrac: 0.85,
    morningPvSurplusP90Kwh: 30, morningPvSurplusP50Kwh: 18.06, longGapAhead: false, minBuyKwh: 1,
    buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: true,
    ...over,
  };
}
const plan = (over: Partial<NightChargeInputDeps> = {}): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(deps(over)));

/** The pre-v1.187.22 inputs: no P50 copied onto the band, no force-charge eligibility. */
const legacyPlan = (): NightChargePlan => plan({ bandHours: band({ p50: false }), forceChargeEligible: undefined });
const r1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** (to − from) % of the pool, meter-side: the bare "level − start" arithmetic. */
const legKwh = (fromPct: number, toPct: number) => Math.max(0, ((toPct - fromPct) / 100) * POOL / LEG);

/**
 * v1.187.22 — an INDEPENDENT minute-by-minute model of the night the armed write produces:
 * the oracle the expected figure is checked against. Unlike the walk under test (which only finds
 * the force-charge start) it CHARGES: below the written reserve the reserve charges at the live
 * rate; at or above it the house runs from the pool (2.2 kW in the window, ÷ the 0.94 discharge
 * leg), held at the reserve; the force-charge switches on once, when the clock reaches the write's
 * own forceChargeStartAtMs, charges at the live rate ((17 kW grid cap − the house) × the charge
 * leg, forceChargeRateKw) and stops at forceChargeStopPct. What it charges, ÷ the charge leg, is
 * what the night buys.
 */
function simulateNight(fromMs: number, openPct: number, ceilingPct: number, reservePct = 50): { buyKwh: number; onAtMs: number | null } {
  const stop = forceChargeStopPct(ceilingPct);
  let soc = openPct;
  let buy = 0;
  let on = false;
  let onAtMs: number | null = null;
  for (let t = fromMs; t < WIN_END; t += 60_000) {
    const house = houseKw(phxHour(t));
    const rate = (17 - house) * LEG;
    if (onAtMs == null && soc < stop && t < WIN_END - FORCE_CHARGE_MIN_RUN_MS
      && t >= forceChargeStartAtMs(WIN_END, ceilingPct, soc, POOL, rate, 0)) { on = true; onAtMs = t; }
    const charge = (toPct: number) => {
      const add = Math.min(rate / 60, Math.max(0, ((toPct - soc) / 100) * POOL));
      soc += (add / POOL) * 100;
      buy += add / LEG;
    };
    if (on) { charge(stop); if (soc >= stop - 1e-9) on = false; }
    else if (soc < reservePct) charge(reservePct);
    else soc = Math.max(reservePct, soc - ((house / 0.94 / 60) / POOL) * 100);
  }
  return { buyKwh: buy, onAtMs };
}

/* ── the 2026-10-12 replay ──────────────────────────────────────────────── */

test('★★★ 2026-10-12: the worst case stays ~64 kWh, the expected buy is ~35 kWh, and the headline is the charge the write arms', () => {
  const p = plan();
  assert.equal(p.chargeTonight, true);
  assert.equal(p.objective, 'cost_arbitrage');
  // The worst case the plan is sized on: the 64.19 kWh of that night, within the fixture's shape.
  assert.ok(p.buyKwh! >= 62 && p.buyKwh! <= 66, `worst-case buy ${p.buyKwh}`);
  assert.equal(p.targetSocPct, 80.4);
  assert.equal(p.costCeilingSocPct, 80.4);
  // The expected start: a grid-present median carry, 21:30 → 00:00. The forecast's median house
  // load (2.8 kW) is above the ~2.4 kW the house drew that evening, so it lands a point or so
  // under the measured 46% — and ~27 points above the islanded 17.6% sizing start.
  assert.ok(p.expectedStartSocPct! >= 43 && p.expectedStartSocPct! <= 48, `expected start ${p.expectedStartSocPct}`);
  assert.ok(p.projSocAtWindowStartPct! < 20, `sizing start ${p.projSocAtWindowStartPct}`);
  // The write: reserve 50%, then force-charge, which stops at 80 (the 80.4 target syncs an 80 ceiling).
  assert.equal(p.expectedWriteLevelPct, 80);
  // (80 − start) × pool / legEff — the write's own arithmetic, not a share of the worst case.
  const want = ((80 - p.expectedStartSocPct!) / 100) * POOL / LEG;
  assert.ok(Math.abs(p.expectedBuyKwh! - want) < 0.1, `expected ${p.expectedBuyKwh} vs ${want}`);
  assert.ok(p.expectedBuyKwh! >= 30 && p.expectedBuyKwh! <= 36, `expected buy ${p.expectedBuyKwh}`);
  // From the 46% the pool really opened at, the same write draws ≈34 kWh: the expected figure is
  // within ~1 kWh of what that night would have bought, the worst case ~30 kWh above it.
  const fromMeasured = ((80 - 46) / 100) * POOL / LEG;
  assert.ok(Math.abs(p.expectedBuyKwh! - fromMeasured) < 1.5, `${p.expectedBuyKwh} vs ${fromMeasured} from the measured 46%`);
  // The headline is the charge the write arms: the level it drives to, the window, the expected
  // draw. The worst case follows once, labelled as the sizing basis, with its islanded start and
  // the arrival it projects.
  assert.ok(p.rationale.startsWith(`Charge to ~80% in the 00:00–05:00 window: ~${r1(p.expectedBuyKwh!)} kWh expected. `
    + 'Expected: the pool should open the window near ~4'), p.rationale);
  assert.match(p.rationale, /Expected: the pool should open the window near ~4\d\.\d% with the grid present/);
  // v1.187.22 — the force-charge leg is timed by the write's own just-in-time start.
  assert.match(p.rationale, /charges it to 80% \(the 50% reserve, then force-charge from ~02:4\d\)\. Sized on/);
  assert.ok(p.rationale.includes(`Sized on an islanded worst case (${WORST_CASE_BASIS}) of ~${r1(p.buyKwh!)} kWh, `
    + 'from ~17.6% at the window open, projecting ~80.4% by the window close.'), p.rationale);
  // Below the reserve the drain question does not arise: the night the write produces from the
  // expected open buys what the plan states.
  const sim = simulateNight(WIN_START, p.expectedStartSocPct!, 80.4);
  assert.ok(Math.abs(p.expectedBuyKwh! - sim.buyKwh) < 0.3, `${p.expectedBuyKwh} vs the simulated night's ${sim.buyKwh}`);
});

test('★★★ the sizing does not move: every sizing field equals the pre-v1.187.22 plan of the same night', () => {
  const now = plan();
  const before = legacyPlan();
  for (const k of ['buyKwh', 'buyKwhDebiased', 'targetSocPct', 'setpointSocPct', 'requiredExtraKwh', 'bindingCap',
    'cushionShortfall', 'costCeilingSocPct', 'projSocAtWindowStartPct', 'preWindowMinSocPct', 'minProjSocPct',
    'baselineMinSocPct', 'cushionTroughSocPct', 'chargeTonight', 'objective'] as const) {
    assert.deepEqual(now[k], before[k], `${k} moved`);
  }
  // …and what armFromPlan writes is the same.
  const a = armFromPlan(emptyActuationState(), '2026-10-12', now, NOW, 16)!;
  const b = armFromPlan(emptyActuationState(), '2026-10-12', before, NOW, 16)!;
  assert.equal(a.targetPct, 50);
  assert.equal(a.forceChargeCeilingPct, 80.4);
  assert.deepEqual({ ...a, announcedAtMs: 0 }, { ...b, announcedAtMs: 0 });
  // Without a P50 basis there is no expected figure: the headline states the level and the
  // window and no kWh (force-charge ineligible here, so the reserve); the worst case is still
  // only the labelled sizing sentence.
  assert.equal(before.expectedBuyKwh, null);
  assert.equal(before.expectedStartSocPct, null);
  assert.ok(before.rationale.startsWith(`Charge to ~50% in the 00:00–05:00 window. Sized on an islanded worst case (${WORST_CASE_BASIS}) `
    + `of ~${r1(before.buyKwh!)} kWh, from ~17.6% at the window open, projecting ~80.4% by the window close.`), before.rationale);
});

test('★★ the level comes from the fields armFromPlan writes: force-charge ineligible ⇒ the reserve setpoint only', () => {
  const p = plan({ forceChargeEligible: false });
  assert.equal(p.buyKwh, plan().buyKwh, 'the worst case is unchanged');
  assert.equal(p.expectedWriteLevelPct, 50, 'clampReserveTarget(setpoint) — the reserve maximum');
  const want = ((50 - p.expectedStartSocPct!) / 100) * POOL / LEG;
  assert.ok(Math.abs(p.expectedBuyKwh! - want) < 0.1, `expected ${p.expectedBuyKwh} vs ${want}`);
  assert.ok(p.expectedBuyKwh! < 6, 'the reserve leg alone: ~45% → 50%');
  assert.match(p.rationale, /tonight's write charges it to 50%[;.]/);
  assert.doesNotMatch(p.rationale, /then force-charge/);
  // The gate the planner is told is the force-charge's own (index.ts passes forceChargeOn()).
  assert.equal(forceChargeEnabled({ mode: 'advisory', objective: 'cost', costMaxSocPct: 90, reserveWriteMaxPct: RESERVE_WRITE_MAX_PCT }), false);
});

test('★★ reserve only, an expected start ABOVE the reserve draws nothing', () => {
  // Force-charge ineligible: from ~66% the pool sits above the 50% reserve all night, the house
  // draws it toward 50%, and nothing is charged — exactly 0.
  const reserveOnly = plan({ socNowPct: 74, forceChargeEligible: false });
  assert.equal(reserveOnly.chargeTonight, true, 'the worst case still buys');
  assert.ok(reserveOnly.buyKwh! > 20, `worst case ${reserveOnly.buyKwh}`);
  assert.ok(reserveOnly.expectedStartSocPct! > 50, `expected start ${reserveOnly.expectedStartSocPct}`);
  assert.equal(reserveOnly.expectedBuyKwh, 0);
  // v1.187.22 (recheck) — a night that charges nothing is headlined as the reserve it holds: the
  // rationale said "Charge to ~50% in the 00:00–05:00 window: ~0 kWh expected." (updated deliberately).
  assert.match(reserveOnly.rationale, /^Hold the reserve at 50% in the 00:00–05:00 window: no charge expected\. Expected: /);
  assert.match(reserveOnly.rationale, /already at or above the 50% tonight's write charges to/);
  assert.doesNotMatch(reserveOnly.rationale, /~0 kWh/);
});

test('★★★ force-charge nights that open ABOVE the reserve: the drain before the just-in-time start is bought back too', () => {
  // With the reserve at 50% and the pool above it, the house runs from the pool until the
  // just-in-time start, and the force-charge then fills back to its stop. Taking the pool at the
  // window OPEN as the start of charging understated these nights by up to the window's median
  // drain (~12 kWh), and announced "about 0" at 90%+ on nights that buy ~4-9.
  for (const socNowPct of [53, 60, 66, 74, 80, 88, 96]) {
    const p = plan({ socNowPct });
    assert.equal(p.chargeTonight, true, `${socNowPct}%: the worst case still buys`);
    assert.equal(p.expectedWriteLevelPct, 80);
    const sim = simulateNight(WIN_START, p.expectedStartSocPct!, 80.4);
    assert.ok(Math.abs(p.expectedBuyKwh! - sim.buyKwh) < 0.3,
      `${socNowPct}%: expected ${p.expectedBuyKwh} vs the simulated night's ${sim.buyKwh.toFixed(2)}`);
  }
  // 74% at 21:30: the pool opens ~65.9%, the house draws it to ~57.7% by the ~03:14 start, and the
  // force-charge buys back that drain: ~22 kWh, not the ~14 kWh of (80 − 65.9).
  const p74 = plan({ socNowPct: 74 });
  assert.ok(p74.expectedBuyKwh! > legKwh(p74.expectedStartSocPct!, 80) + 6, `${p74.expectedBuyKwh}`);
  assert.ok(p74.expectedBuyKwh! >= 21 && p74.expectedBuyKwh! <= 23.5, `${p74.expectedBuyKwh}`);
  assert.match(p74.rationale, /above the 50% reserve: the house should draw it to ~5\d\.\d% before the just-in-time force-charge \(~03:1\d\) charges it to 80%/);
  // 96%: opening ~87.9%, above the 80% stop; the house draws it under the stop and the
  // just-in-time start (~04:30) buys ~3.5 kWh — not the 0 the window-open start implied.
  const fc = plan({ socNowPct: 96 });
  assert.ok(fc.expectedStartSocPct! > 80, `expected start ${fc.expectedStartSocPct}`);
  assert.ok(fc.expectedBuyKwh! >= 3 && fc.expectedBuyKwh! <= 4.2, `${fc.expectedBuyKwh}`);
  assert.match(fc.rationale, /before the just-in-time force-charge \(~04:[23]\d\) charges it to 80%/);
  // The stated figure carries it: the push title and the spoken line are not "about 0".
  assert.notEqual(Math.round(statedBuyKwh(fc)!), 0);
  assert.match(buildNightChargeMessage(fc, 'charge').title, /\(~3\.\d kWh\)$/);
});

test('★★ the 2026-09-30 shape: ~74% at 23:00, ceiling 76% — the drain to the start is most of the buy', () => {
  // That night the pool sat at 74% at 23:00, was drawn to ~55% and charged to 76%; ~20.3 kWh went
  // into the Cores. The window-open arithmetic, (76 − ~71) of the pool, said ~5 kWh.
  const p = plan({ nowMs: phx(10, 12, 23), socNowPct: 74, morningPvSurplusP50Kwh: POOL * 0.24 });
  assert.equal(p.chargeTonight, true, p.rationale);
  assert.equal(p.costCeilingSocPct, 76);
  assert.equal(p.expectedWriteLevelPct, 76);
  assert.ok(p.expectedStartSocPct! > 70 && p.expectedStartSocPct! < 72, `${p.expectedStartSocPct}`);
  const sim = simulateNight(WIN_START, p.expectedStartSocPct!, 76);
  assert.ok(Math.abs(p.expectedBuyKwh! - sim.buyKwh) < 0.3, `${p.expectedBuyKwh} vs ${sim.buyKwh}`);
  assert.ok(p.expectedBuyKwh! > 2.5 * legKwh(p.expectedStartSocPct!, 76), `${p.expectedBuyKwh} vs ${legKwh(p.expectedStartSocPct!, 76)}`);
});

test('★★ a pool that stays at or near the force-charge stop: no start is expected, and the plan says so', () => {
  // 100% at 21:30 opens ~92% and is drawn under 80% only inside the window's last 20 minutes,
  // where decideForceCharge starts nothing (FORCE_CHARGE_MIN_RUN_MS): nothing is charged.
  const p = plan({ socNowPct: 100 });
  assert.equal(p.chargeTonight, true, 'the worst case still buys');
  assert.equal(p.expectedBuyKwh, 0);
  assert.equal(simulateNight(WIN_START, p.expectedStartSocPct!, 80.4).onAtMs, null, 'the simulated night starts nothing either');
  assert.match(p.rationale, /above the 50% reserve; the just-in-time force-charge to 80% is not expected to start/);
});

test('★★ the expected carry keeps the forecast\'s expected-value EV and never reads the P90 block', () => {
  // 1.5 kW of expected-value EV at 21:00-23:00 (the day-ahead forecast's own EV), under the
  // committed 19.3 kWh P90 block placed from 21:00.
  const evW = (ts: number) => (ts >= phx(10, 12, 21) && ts < phx(10, 12, 23) ? 1500 : 0);
  const withEv = plan({ bandHours: band({ evExpectedW: evW }) });
  const without = plan();
  // The worst case strips the embedded EV where the block lands: identical sizing start.
  assert.equal(withEv.projSocAtWindowStartPct, without.projSocAtWindowStartPct);
  assert.equal(withEv.buyKwh, without.buyKwh);
  // The expected carry counts it: 0.5 h + 1 h at 1.5 kW = 2.25 kWh at the panel, / 0.94 from the pack.
  const dropPct = ((2.25 / 0.94) / POOL) * 100;
  assert.ok(Math.abs((without.expectedStartSocPct! - withEv.expectedStartSocPct!) - dropPct) < 0.15,
    `${without.expectedStartSocPct} → ${withEv.expectedStartSocPct}, want −${dropPct.toFixed(2)}`);
  // And the P90 block itself (19.3 kWh) is nowhere in it: the drop is the 2.25 kWh, not ~20 kWh.
  assert.ok(without.expectedStartSocPct! - withEv.expectedStartSocPct! < 3);
});

test('★★ buildNightChargeInputs copies the P50 fields and the force-charge gate (an un-copied field drops SILENTLY)', () => {
  const evW = (ts: number) => (ts === phx(10, 12, 21) ? 1000 : 0);
  const inputs = buildNightChargeInputs(deps({
    bandHours: band({ evExpectedW: evW }),
    dayRollups: [{ daysAhead: 1, hours: [{ ts: NEXT_WINDOW + 2 * H, pvW: 0, loadW: 2500 }] }],
    nextRechargeMs: NEXT_WINDOW + 4 * H,
  }));
  assert.equal(inputs.forceChargeEligible, true);
  const h21 = inputs.horizon.find((h) => h.ts === phx(10, 12, 21))!;
  // The P90 block replaced the embedded EV in loadP90W; loadP50W is the forecast as handed in.
  assert.equal(h21.loadP90W, 2800 * P90_FACTOR + 11520);
  assert.equal(h21.loadP50W, 3800, 'the forecast load with its expected-value EV, untouched by the block');
  assert.equal(h21.pvP50W, 0);
  const noon = inputs.horizon.find((h) => h.ts === phx(10, 13, 12))!;
  assert.ok(noon.pvP50W! > noon.pvP10W, 'the median PV, not the P10');
  // A rollup hour carries its own central figures.
  const roll = inputs.horizon.find((h) => h.ts === NEXT_WINDOW + 2 * H)!;
  assert.equal(roll.loadP50W, 2500);
  assert.equal(roll.pvP50W, 0);
  assert.equal(buildNightChargeInputs(deps({ forceChargeEligible: undefined })).forceChargeEligible, undefined);
});

test('★ mid-window the expected start is the live SoC, and the walk runs from now', () => {
  // 02:10, 62%: above the reserve — the house draws it until the just-in-time start, then the
  // force-charge fills to 80%.
  const p = plan({ nowMs: phx(10, 13, 2, 10), socNowPct: 62 });
  assert.equal(p.chargeTonight, true, p.rationale);
  assert.equal(p.expectedStartSocPct, 62);
  assert.equal(p.expectedWriteLevelPct, 80);
  const sim = simulateNight(phx(10, 13, 2, 10), 62, 80.4);
  assert.ok(Math.abs(p.expectedBuyKwh! - sim.buyKwh) < 0.3, `${p.expectedBuyKwh} vs ${sim.buyKwh}`);
  assert.ok(p.expectedBuyKwh! > legKwh(62, 80) + 2);
  assert.match(p.rationale, /Expected: the pool is at ~62% now, above the 50% reserve: the house should draw it to ~\d\d(\.\d)?% before the just-in-time force-charge \(~03:\d\d\) charges it to 80%/);
  assert.doesNotMatch(p.rationale, /% at the window open/, 'no pre-window carry mid-window');
  assert.match(p.rationale, /Sized on an islanded worst case \([^)]*\) of ~[\d.]+ kWh, projecting ~[\d.]+% by the window close\./);
  // While the force-charge runs at the rate it was timed with, its own start reads "now": what is
  // still to draw is the stop less the pool. (02:43 from 50% at (17 − 2.2) × 0.927 kW → ~61.6% at 03:30.)
  const during = plan({ nowMs: phx(10, 13, 3, 30), socNowPct: 61.6 });
  assert.ok(Math.abs(during.expectedBuyKwh! - legKwh(61.6, 80)) < 0.1, `${during.expectedBuyKwh} vs ${legKwh(61.6, 80)}`);
  assert.match(during.rationale, /the force-charge is due at once \(~03:30\) and charges it to 80%/);
});

test('★ the expected buy never exceeds what the window can deliver on the median load', () => {
  // A one-hour window (Friday's 23:00-24:00 shape): 17.8 kW cap, 17 kW envelope, 2.2-2.8 kW load.
  const fri = plan({
    periodIdAt: (ms) => (ms >= phx(10, 12, 23) && ms < phx(10, 13, 0)) || ms >= NEXT_WINDOW ? 'overnight' : 'off_peak',
  });
  assert.equal(fri.chargeTonight, true);
  const deliverable = (17 - 2.8) * LEG; // one hour at the envelope less the median house load
  assert.ok(fri.expectedBuyKwh! <= deliverable / LEG + 0.01, `${fri.expectedBuyKwh} vs ${deliverable / LEG}`);
  assert.ok(Math.abs(fri.expectedBuyKwh! - deliverable / LEG) < 0.05, 'bound by the window, not by the level');
  assert.match(fri.rationale, /charges it toward 80% \(the 50% reserve, then force-charge from ~23:00\), as far as the window can deliver/);
});

test('★★ the in-progress hour: a band that starts at the NEXT hour still carries the drain to it', () => {
  // The day-ahead forecast's hours start at ceil(now), so at 21:05 the band usually starts at
  // 22:00. The 21:05-22:00 drain was dropped: the expected start read 46.5% at 21:00:30, 21:05 and
  // 21:30 alike. It is carried at the next hour's figures.
  const from22 = band({ from: phx(10, 12, 22) });
  for (const mi of [5, 30]) {
    const withHour = plan({ nowMs: phx(10, 12, 21, mi) });
    const next = plan({ nowMs: phx(10, 12, 21, mi), bandHours: from22 });
    assert.equal(next.expectedStartSocPct, withHour.expectedStartSocPct, `21:${mi}: 2.8 kW in both hours`);
    assert.equal(next.expectedBuyKwh, withHour.expectedBuyKwh);
  }
  const at2105 = plan({ nowMs: phx(10, 12, 21, 5), bandHours: from22 });
  const at2130 = plan({ nowMs: phx(10, 12, 21, 30), bandHours: from22 });
  // 25 more minutes at 2.8 kW / 0.94 ≈ 1.24 kWh ≈ 1.3 points.
  assert.ok(at2130.expectedStartSocPct! - at2105.expectedStartSocPct! > 1.1, `${at2105.expectedStartSocPct} → ${at2130.expectedStartSocPct}`);
  // Mid-window the same: at 02:10 a band from 03:00 still has a basis for 02:10-03:00.
  const mid = plan({ nowMs: phx(10, 13, 2, 10), socNowPct: 62, bandHours: band({ from: phx(10, 13, 3) }) });
  assert.ok(mid.expectedBuyKwh != null, 'the walk has a basis for the in-progress hour');
});

test('★ a hold states an expected buy of 0 and still records the expected start', () => {
  const hold = plan({ socNowPct: 100, morningPvSurplusP50Kwh: 60, morningPvSurplusP90Kwh: 60 });
  assert.equal(hold.chargeTonight, false);
  assert.equal(hold.expectedBuyKwh, 0);
  assert.equal(hold.expectedWriteLevelPct, null);
  assert.ok(hold.expectedStartSocPct != null && hold.expectedStartSocPct > 90);
  // The final hold (a buy under the minimum): the plan is sized, but nothing arms.
  const small = plan({ minBuyKwh: 1000 });
  assert.equal(small.chargeTonight, false);
  assert.equal(armFromPlan(emptyActuationState(), '2026-10-12', small, NOW, 16), null, 'nothing is armed');
  assert.equal(small.expectedBuyKwh, 0);
  assert.equal(small.expectedWriteLevelPct, null);
  assert.ok(small.expectedStartSocPct! >= 43 && small.expectedStartSocPct! <= 48);
});

test('★★ wiring (index.ts is not reachable from a unit test): P50 onto the band, the gate, the ledger columns, the measured open', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  // The band carries the MEDIAN load — forecastLoadW without the P90 factor — and the median PV.
  assert.match(idx, /loadP90W: fh\.forecastLoadW \* loadP90Factor,\n\s+embeddedEvW: \(fh\.predictedEvLoadW \?\? 0\) \* loadP90Factor,\n(\s+\/\/.*\n)*\s+loadP50W: fh\.forecastLoadW,\n\s+pvP50W: pb\.p50W,\n/);
  // The planner is told the force-charge's own gate.
  assert.match(idx, /\n\s+forceChargeEligible: forceChargeOn\(legRole\),\n/);
  // The plan row records the expected columns; the scorer records the measured open and grades it.
  assert.match(idx, /\n\s+\.\.\.expectedBuyLedgerColumns\(plan\),\n/);
  assert.match(idx, /measuredWindowOpenSocPct\(\n\s+recorder\.query\(shp2Sn, 'backup_pct', windowStart - WINDOW_OPEN_SOC_LEAD_MS, windowStart\), windowStart\);/);
  assert.match(idx, /\n\s+window_open_soc_pct: windowOpenSocPct,\n/);
  assert.match(idx, /\n\s+scoreNotes \+= expectedBuyScoreNote\(\{\n\s+expectedBuyKwh: y\.expected_buy_kwh \?\? null,/);
});

/* ── the pure pieces ────────────────────────────────────────────────────── */

test('expectedCarryKwh: the current hour by its remaining part, the reserve as a floor, null without a P50 basis', () => {
  const hrs = [0, 1, 2].map((i) => ({ ts: i * H, pvP10W: 0, loadP90W: 9000, loadP50W: 1880, pvP50W: 0 }));
  // From 0.5 h: 0.5 + 1 + 1 h at 1.88 kW / 0.94 = 5 kWh.
  assert.equal(r1(expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: hrs, fromMs: 0.5 * H, toMs: 3 * H })!), 45);
  // The reserve holds it.
  assert.equal(expectedCarryKwh({ startKwh: 12, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: hrs, fromMs: 0, toMs: 3 * H }), 10);
  // A pool already under the reserve is neither drained further nor lifted.
  assert.equal(expectedCarryKwh({ startKwh: 8, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: hrs, fromMs: 0, toMs: 3 * H }), 8);
  // PV P50 is used, P10 only when P50 is absent.
  const sun = [{ ts: 0, pvP10W: 1000, loadP90W: 0, loadP50W: 0, pvP50W: 3000 }];
  assert.equal(expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: sun, fromMs: 0, toMs: H }), 53);
  assert.equal(expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: [{ ...sun[0], pvP50W: null }], fromMs: 0, toMs: H }), 51);
  assert.equal(expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: [{ ts: 0, pvP10W: 0, loadP90W: 1 }], fromMs: 0, toMs: H }), null);
  // An hour outside the span is not read at all (its missing P50 does not null the carry).
  assert.equal(expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: [{ ts: 0, pvP10W: 0, loadP90W: 1, loadP50W: 0 }, { ts: 5 * H, pvP10W: 0, loadP90W: 1 }], fromMs: 0, toMs: H }), 50);
  // v1.187.22 — the in-progress hour missing from the band (it starts at ceil(now)) is carried
  // at the next hour's figures: from 0.5 h, 0.5 h at hour 1's 1.88 kW, then hours 1 and 2.
  const fromNext = hrs.slice(1);
  assert.equal(r1(expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: fromNext, fromMs: 0.5 * H, toMs: 3 * H })!), 45);
  // Only the in-progress hour: a missing hour later in the span is no P50 basis.
  assert.equal(expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: [hrs[0], hrs[2]], fromMs: 0.5 * H, toMs: 3 * H }), null);
  assert.equal(expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: hrs.slice(2), fromMs: 0.5 * H, toMs: 3 * H }), null, 'two hours missing');
});

test('expectedWindowLiftKwh: the contended rate on the median load × legEff × the hour left', () => {
  const hrs = [0, 1].map((i) => ({ ts: i * H, pvP10W: 0, loadP90W: 14000, loadP50W: 3000 }));
  assert.equal(r1(expectedWindowLiftKwh({ hours: hrs, fromMs: 0.5 * H, windowEndMs: 2 * H, chargeCapKw: 20, envelopeKw: 17, legEff: 0.9 })!), r1(14 * 0.9 * 1.5));
  assert.equal(r1(expectedWindowLiftKwh({ hours: hrs, fromMs: 0, windowEndMs: 2 * H, chargeCapKw: 10, envelopeKw: null, legEff: 0.9 })!), 18);
  assert.equal(expectedWindowLiftKwh({ hours: [{ ts: 0, pvP10W: 0, loadP90W: 1 }], fromMs: 0, windowEndMs: H, chargeCapKw: 10, envelopeKw: null, legEff: 0.9 }), null);
  // The in-progress hour at the next hour's figures; a missing later hour voids the bound.
  assert.equal(r1(expectedWindowLiftKwh({ hours: hrs.slice(1), fromMs: 0.5 * H, windowEndMs: 2 * H, chargeCapKw: 20, envelopeKw: 17, legEff: 0.9 })!), r1(14 * 0.9 * 1.5));
  assert.equal(expectedWindowLiftKwh({ hours: hrs.slice(0, 1), fromMs: 0, windowEndMs: 2 * H, chargeCapKw: 20, envelopeKw: 17, legEff: 0.9 }), null);
});

test('armedWriteLevelPct: the reserve as written, or the force-charge stop above it', () => {
  assert.equal(armedWriteLevelPct({ setpointSocPct: 80.4, costCeilingSocPct: 80.4 }, true), 80, 'an 80.4 target stops at its 80 ceiling');
  assert.equal(armedWriteLevelPct({ setpointSocPct: 72.8, costCeilingSocPct: 72.8 }, true), 72.8, 'below 80 the target is the stop');
  assert.equal(armedWriteLevelPct({ setpointSocPct: 85.3, costCeilingSocPct: 85.3 }, true), 85);
  assert.equal(armedWriteLevelPct({ setpointSocPct: 80.4, costCeilingSocPct: 80.4 }, false), 50, 'ineligible: the reserve only');
  assert.equal(armedWriteLevelPct({ setpointSocPct: 44.6, costCeilingSocPct: 48 }, true), 45, 'a ceiling at or below 50 starts no force-charge');
  assert.equal(armedWriteLevelPct({ setpointSocPct: 30, costCeilingSocPct: null }, true), 30, 'resilience mode: no ceiling');
  assert.equal(armedWriteLevelPct({ setpointSocPct: null, costCeilingSocPct: 80 }, true), null);
});

/** A 5-hour window, 0 → 5 h, at a flat median load, no PV. */
const flatWindow = (loadW: number): NightChargeHour[] => [0, 1, 2, 3, 4].map((i) => ({ ts: i * H, pvP10W: 0, loadP90W: 9000, loadP50W: loadW, pvP50W: 0 }));
const win = (loadW: number, envelopeKw: number | null = null) => ({
  hours: flatWindow(loadW), fromMs: 0, windowEndMs: 5 * H, dischargeEff: 1, chargeCapKw: 20, envelopeKw,
});

test('expectedForceChargeStart: the house drains the pool, held at the reserve, until the just-in-time start', () => {
  // 4 kW from 70 of a 100 kWh pool; no envelope ⇒ the write's fixed 10 kW plan rate. The start is
  // where t = 5 h − ((80.4 − pool(t)) / 10 h + 15 min), pool(t) = 70 − 4t: t ≈ 2.65 h, pool ≈ 59.4.
  const o = { startKwh: 70, reserveKwh: 50, fullKwh: 100, ceilingPct: 80.4, ...win(4000), legEff: 0.9 };
  const r = expectedForceChargeStart(o)!;
  assert.ok(Math.abs(r.startMs! / H - 2.65) < 0.02, `start ${r.startMs! / H} h`);
  assert.ok(Math.abs(r.packKwh - 59.4) < 0.1, `pack ${r.packKwh}`);
  // The start is the write's own condition, read on the pool at that minute.
  assert.ok(r.startMs! >= forceChargeStartAtMs(5 * H, 80.4, r.packKwh, 100, null, null));
  // Held at the written reserve: a heavy house load stops at 50, and the start comes from there.
  const heavy = expectedForceChargeStart({ ...o, ...win(12000) })!;
  assert.equal(heavy.packKwh, 50);
  // At or above the stop nothing starts; drained under it only inside the last 20 min ⇒ no start.
  const high = expectedForceChargeStart({ ...o, startKwh: 90, ...win(2000) })!;
  assert.equal(high.startMs, null);
  // The P50 basis is required for every minute walked.
  assert.equal(expectedForceChargeStart({ ...o, hours: flatWindow(4000).slice(0, 2) }), null);
  // A predicted EV in the window pulls the start earlier, as the live tick's evDisplacedKwh does
  // (11.52 kW against a (10 − 4) × 0.9 kW rate: due from the first minute) — but at or above the
  // stop nothing starts: the start comes the minute the pool falls under 80, at 2.5 h. (Without the
  // EV term it would come at ~3.75 h, from 75.)
  const ev = expectedForceChargeStart({
    ...o, startKwh: 90, envelopeKw: 10, hours: flatWindow(4000).map((h) => ({ ...h, evP90W: 11520 })),
  })!;
  assert.ok(ev.startMs! / H >= 2.45 && ev.startMs! / H <= 2.6, `start ${ev.startMs! / H} h`);
  assert.ok(ev.packKwh < 80 && ev.packKwh > 79.5, `pack ${ev.packKwh}`);
});

test('★ the walk reads the in-progress hour\'s EV from the hour that stands in for its load', () => {
  // From 0.5 h on a band that starts at hour 1 (the day-ahead forecast starts at ceil(now)), the
  // first part-hour's load is carried at hour 1's figures (p50HourAt), and so is its predicted EV.
  // Read directly, the EV of that part-hour was "no prediction", so the start ignored the EV
  // displacement the live tick counts and came later than on a band that carries the same hour.
  // 11.52 kW of EV against a (10 − 4) × 0.9 kW rate is due at once from 75 of a 100 kWh pool.
  const evHours = flatWindow(4000).map((h) => ({ ...h, evP90W: 11520 }));
  const o = {
    startKwh: 75, reserveKwh: 50, fullKwh: 100, ceilingPct: 80.4, hours: evHours,
    fromMs: 0.5 * H, windowEndMs: 5 * H, dischargeEff: 1, chargeCapKw: 20, envelopeKw: 10, legEff: 0.9,
  };
  const withHour = expectedForceChargeStart(o)!;
  assert.equal(withHour.startMs, 0.5 * H, 'due at once');
  assert.deepEqual(expectedForceChargeStart({ ...o, hours: evHours.slice(1) }), withHour);
  // Without the EV term the same pool starts later: the stand-in is what moves it.
  const noEv = expectedForceChargeStart({ ...o, hours: flatWindow(4000).slice(1) })!;
  assert.ok(noEv.startMs! > withHour.startMs! + 0.25 * H, `start ${noEv.startMs! / H} h`);
  // A gap later in the window is still no prediction (only the in-progress hour is stood in for).
  const gap = expectedForceChargeStart({ ...o, hours: evHours.map((h, i) => (i === 3 ? { ...h, evP90W: undefined } : h)) })!;
  assert.ok(gap.startMs! > withHour.startMs!, `start ${gap.startMs! / H} h`);
});

test('expectedBuyFromPlan: the reserve leg, the drain-and-refill force-charge leg, bounded, null without a basis', () => {
  const base = { setpointSocPct: 80.4, costCeilingSocPct: 80.4, forceChargeEligible: true, fullKwh: 100, legEff: 0.9, window: win(2000) };
  // Below the reserve: 44 → 50 (the reserve), then 50 → 80 at the just-in-time start = F − S.
  const below = expectedBuyFromPlan({ ...base, startKwh: 44, deliverableKwh: 1e9 });
  assert.equal(below.buyKwh, 40);
  assert.equal(below.levelPct, 80);
  assert.ok(below.forceChargeStartMs! > 0 && below.forceChargeFromPct === 50);
  // Above the reserve: the drain to the start is bought back — more than the old (80 − 70).
  const above = expectedBuyFromPlan({ ...base, startKwh: 70, deliverableKwh: 1e9, window: win(4000) });
  assert.ok(Math.abs(above.buyKwh! - (80 - 59.4) / 0.9) < 0.2, `${above.buyKwh}`);
  assert.ok(above.buyKwh! > (80 - 70) / 0.9 + 9);
  // Above the stop all night: 0, and no start.
  const none = expectedBuyFromPlan({ ...base, startKwh: 90, deliverableKwh: 1e9 });
  assert.equal(none.buyKwh, 0);
  assert.equal(none.forceChargeStartMs, null);
  // The window bounds it; reserve only takes no walk.
  const bound = expectedBuyFromPlan({ ...base, startKwh: 44, deliverableKwh: 9 });
  assert.equal(bound.buyKwh, 10);
  assert.equal(bound.deliverableBound, true);
  const reserveOnly = expectedBuyFromPlan({ ...base, forceChargeEligible: false, startKwh: 44, deliverableKwh: 1e9 });
  assert.deepEqual(reserveOnly, { buyKwh: round2(6 / 0.9), levelPct: 50 });
  assert.deepEqual(expectedBuyFromPlan({ ...base, forceChargeEligible: false, startKwh: 70, deliverableKwh: 1e9 }), { buyKwh: 0, levelPct: 50 });
  // No basis: the carry, the deliverable, or a minute of the walk.
  assert.deepEqual(expectedBuyFromPlan({ ...base, startKwh: null, deliverableKwh: 9 }), { buyKwh: null, levelPct: 80 });
  assert.deepEqual(expectedBuyFromPlan({ ...base, startKwh: 44, deliverableKwh: null }), { buyKwh: null, levelPct: 80 });
  assert.deepEqual(expectedBuyFromPlan({ ...base, startKwh: 44, deliverableKwh: 1e9, window: { ...win(2000), hours: [] } }), { buyKwh: null, levelPct: 80 });
});

test('the stated figures: the level the write drives to, the expected draw or none, the worst case only as the sizing basis', () => {
  // chargeLevelPct: the plan's write level; on a plan from before v1.187.22, the reserve as written.
  assert.equal(chargeLevelPct({ setpointSocPct: 80.4, expectedWriteLevelPct: 80 }), 80);
  assert.equal(chargeLevelPct({ setpointSocPct: 80.4 }), 50, 'clampReserveTarget: the panel maximum');
  assert.equal(chargeLevelPct({ setpointSocPct: 37.6, expectedWriteLevelPct: null }), 38);
  assert.equal(chargeLevelPct({ setpointSocPct: null }), null);
  // statedBuyKwh: the expected draw, or nothing — never a fallback to the worst case.
  assert.equal(statedBuyKwh({ expectedBuyKwh: 34.88 }), 34.88);
  assert.equal(statedBuyKwh({ expectedBuyKwh: 0 }), 0);
  assert.equal(statedBuyKwh({ expectedBuyKwh: null }), null);
  assert.equal(statedBuyKwh({}), null, 'a plan from before v1.187.22');
  assert.equal(statedBuyKwh({ expectedBuyKwh: Number.NaN }), null);
  assert.equal(armedExpectedPhrase(34.88), '~34.9 kWh expected');
  assert.equal(armedExpectedPhrase(null), null);
  assert.equal(armedExpectedPhrase(undefined), null);
  // The one sentence that names the worst case, as the sizing basis, the de-bias beside it.
  assert.equal(sizingBasisText(64.19), `Sized on an islanded worst case (${WORST_CASE_BASIS}) of ~64.2 kWh`);
  assert.equal(sizingBasisText(106.11, ' (raw estimate 63.9 kWh × 1.66 realized-buy calibration)'),
    `Sized on an islanded worst case (${WORST_CASE_BASIS}) of ~106.1 kWh (raw estimate 63.9 kWh × 1.66 realized-buy calibration)`);
  assert.equal(sizingBasisText(null), null);
  // Logs keep both, each labelled.
  assert.equal(buyFiguresLogText(34.88, 63.92), 'expected buy ~34.9 kWh, islanded worst-case sizing ~63.9 kWh');
  assert.equal(buyFiguresLogText(null, 63.92), 'expected buy none, islanded worst-case sizing ~63.9 kWh');
  assert.equal(buyFiguresLogText(undefined, null), 'expected buy none, islanded worst-case sizing none');
});

/* ── the surfaces ───────────────────────────────────────────────────────── */

test('★★★ MQTT: night_charge_expected_buy_kwh publishes the expected figure; night_charge_buy_kwh keeps the worst case', () => {
  const p = plan();
  const f = nightChargeStateFields(p, NOW + 60_000);
  assert.equal(f.night_charge_expected_buy_kwh, p.expectedBuyKwh);
  assert.equal(f.night_charge_buy_kwh, p.buyKwh, 'the existing entity keeps its meaning');
  assert.ok(f.night_charge_expected_buy_kwh! < f.night_charge_buy_kwh!);
  assert.equal(nightChargeStateFields(p, NOW + 13 * H).night_charge_expected_buy_kwh, null, 'stale ⇒ null');
  assert.equal(nightChargeStateFields(null).night_charge_expected_buy_kwh, null);
  assert.equal(nightChargeStateFields({ ...p, expectedBuyKwh: undefined }, NOW).night_charge_expected_buy_kwh, null, 'a plan from before v1.187.22');
  const s = SENSORS.find((x) => x.unique_id === 'ecoflow_night_charge_expected_buy_kwh');
  assert.ok(s, 'discovered');
  assert.equal(s!.value_template, '{{ value_json.night_charge_expected_buy_kwh }}');
  assert.equal(s!.unit_of_measurement, 'kWh');
  assert.equal(s!.device_class, undefined, 'a planned figure, not an energy accumulation');
  assert.equal(s!.state_class, 'measurement');
  assert.ok((s!.expire_after ?? 0) >= 80_000);
  assert.equal((s as { json_attributes_topic?: string }).json_attributes_topic, undefined);
});

/* ── v1.187.22 — what is spoken and pushed: the charge the write arms, never the sizing basis ── */

/** Every spoken and pushed night-charge text for plan `p`, built as index.ts builds them (the
 *  evening job and the actuation tick are not reachable from a unit test; the wiring pins below
 *  hold index.ts to these calls). */
function nightTexts(p: NightChargePlan): Array<[string, string]> {
  // Force-charge rides the night exactly when the plan was made with it enabled (index.ts passes
  // forceChargeOn() to both): the write's level is then above the reserve maximum. The arm stamps
  // it (forceChargeRides), and the push names the force-charge from the stamp, as index.ts does.
  const fcOn = (p.expectedWriteLevelPct ?? 0) > RESERVE_WRITE_MAX_PCT;
  const armed = armFromPlan(emptyActuationState(), '2026-10-12', p, NOW, 16, fcOn)!;
  assert.ok(armed, 'an armable plan');
  assert.equal(armed.forceChargeRides, fcOn);
  const ceiling = armed.forceChargeRides === true ? armed.forceChargeCeilingPct : null;
  const sup = buildNightChargeMessage(p, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: armed.targetPct!, forceChargeTargetPct: ceiling });
  const reserveOnly = buildNightChargeMessage(p, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: armed.targetPct! });
  const advisory = buildNightChargeMessage(p, 'charge');
  const spoken = nightChargeSpokenNotice({
    levelPct: chargeLevelPct(p)!, reservePct: armed.targetPct!, expectedKwh: statedBuyKwh(p), toward: chargeIsWindowBound(p),
    deadlineText: 'on Monday at 00:00', deadlineTextEs: 'el lunes a las 00:00', cushionShortfall: p.cushionShortfall,
  });
  // The after-the-fact pushes read the armed day's plan row, and what the force-charge did from
  // the actuation record (forceChargeNightOutcome): every outcome the record can hold.
  const expectedKwh = ledgerExpectedBuyKwh([{ plan_date: '2026-10-12', expected_buy_kwh: p.expectedBuyKwh ?? null }], '2026-10-12');
  // (A force-charge is switched ON only on a night it rides.)
  const on = { forceChargeOnAtMs: WIN_START + 2 * H };
  const records: Array<[string, NightActuationState]> = [
    ['never started', armed],
    ...(fcOn ? [
      ['ran', { ...armed, ...on, forceChargeOnVerifiedAtMs: WIN_START + 2 * H + 60_000 }],
      ['failed', { ...armed, ...on, forceChargeOnFailedAtMs: WIN_START + 2 * H + 600_000 }],
      ['unconfirmed', { ...armed, ...on }],
    ] as Array<[string, NightActuationState]> : []),
  ];
  const mornings = records.map(([what, rec]) => [what, buildNightChargeMorningSummary({
    day: '2026-10-12', targetPct: armed.targetPct, restorePct: 16, expectedKwh, forceCharge: forceChargeNightOutcome(rec, fcOn),
  })] as const);
  const cancelled = buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: armed.targetPct, restorePct: 16, expectedKwh, forceCharge: forceChargeNightOutcome(armed, fcOn), ended: 'cancelled' });
  const failed = buildNightChargeApplyFailure({ day: '2026-10-12', currentReservePct: 16, targetPct: armed.targetPct, applyRetries: 2, expectedKwh });
  // v1.187.22 — a write mode that refused to arm: no level, no draw (supervised and auto).
  const why = 'the 2026-10-11 force-charge was switched ON and its OFF has not verified';
  const refused = buildNightChargeMessage(p, 'charge', null, why);
  const refusedAuto = buildNightChargeMessage(p, 'charge', null, why, 'auto');
  // The card's lead (the dashboard, not pushed, held to the same rule), and its refused-arm lead, as
  // NightChargeCard builds it.
  const card = chargeFigureParts(p, RESERVE_WRITE_MAX_PCT);
  const cardRefused = refusedArmLead(why, { mode: 'supervised', held: webNoChargeExpected(p), reservePct: writtenReservePct(p, RESERVE_WRITE_MAX_PCT) });
  const cardUndelivered = refusedArmLead(ARM_UNDELIVERED_REASON, { mode: 'auto', held: webNoChargeExpected(p), reservePct: writtenReservePct(p, RESERVE_WRITE_MAX_PCT) });
  return [
    ['push title', sup.title], ['push body', sup.body], ['push body (reserve only)', reserveOnly.body],
    ['advisory title', advisory.title], ['advisory body', advisory.body],
    ['refused-arm title', refused.title], ['refused-arm body', refused.body],
    ['refused-arm title (auto)', refusedAuto.title], ['refused-arm body (auto)', refusedAuto.body],
    ['spoken en', spoken.en], ['spoken es', spoken.es],
    ...mornings.flatMap(([what, m]): Array<[string, string]> => [[`morning title (${what})`, m.title], [`morning body (${what})`, m.body]]),
    ['cancelled title', cancelled.title], ['cancelled body', cancelled.body],
    ['apply-failure title', failed.title], ['apply-failure body', failed.body],
    ['card lead', `${card.main}${card.unit} ${card.label}`],
    ['card lead (refused)', `${cardRefused.headline} ${cardRefused.detail}`],
    ['card lead (not delivered)', `${cardUndelivered.headline} ${cardUndelivered.detail}`],
  ];
}
/** The energy figures a text states: a number followed by kWh, kilowatt or kilovatio. */
const energyFigures = (t: string): number[] =>
  [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:kWh|kilowatt|kilovatio)/g)].map((m) => Number(m[1]));
/** Does `t` state `kwh` anywhere, at the precision a push (one decimal) or a speaker (whole) uses? */
const statesFigure = (t: string, kwh: number): boolean =>
  new RegExp(`(^|[^\\d.])${String(r1(kwh)).replace('.', '\\.')}(?![\\d])`).test(t)
  || energyFigures(t).includes(Math.round(kwh));
const calibratedPlan = (): NightChargePlan => plan({ buyDebiasFactor: 1.66, buyDebiasBasis: 'measured', buyDebiasSamples: 9 });
const fridayPlan = (): NightChargePlan => plan({
  periodIdAt: (ms) => (ms >= phx(10, 12, 23) && ms < phx(10, 13, 0)) || ms >= NEXT_WINDOW ? 'overnight' : 'off_peak',
});

test('★★★ no spoken or pushed night-charge text states the worst case: the only energy figure is the expected one', () => {
  const cases: Array<[string, NightChargePlan]> = [
    ['2026-10-12', plan()], ['74% at 21:30', plan({ socNowPct: 74 })], ['96% at 21:30', plan({ socNowPct: 96 })],
    ['force-charge ineligible', plan({ forceChargeEligible: false })], ['calibrated de-bias', calibratedPlan()],
    ['Friday one-hour window', fridayPlan()],
    // v1.187.22 (recheck) — nights expected to charge nothing (reserve only; force-charge with no start).
    ['74%, reserve only', plan({ socNowPct: 74, forceChargeEligible: false })], ['100%, force-charge', plan({ socNowPct: 100 })],
    // v1.187.22 (recheck 3) — force-charge armed, not expected to start; the reserve leg charges.
    ['40% under a 51% ceiling', plan({ socNowPct: 40, costMaxSocPct: 51 })],
  ];
  for (const [name, p] of cases) {
    const expected = statedBuyKwh(p);
    assert.ok(p.chargeTonight && expected != null, `${name}: a charge night with an expected figure`);
    // Meaningful only where the worst case differs from what the write draws (on Friday's
    // one-hour window it is the smaller of the two: its P90 EV block takes the grid input).
    for (const w of [p.buyKwh!, p.buyKwhDebiased!]) assert.notEqual(Math.round(w), Math.round(expected), `${name}: ${w} vs ${expected}`);
    const allowed = new Set([r1(expected), Math.round(expected), ...(Math.round(expected) < 1 ? [1] : [])]);
    for (const [where, t] of nightTexts(p)) {
      for (const w of [p.buyKwh!, p.buyKwhDebiased!]) assert.ok(!statesFigure(t, w), `${name} / ${where} states the worst case ${w}: ${t}`);
      for (const f of energyFigures(t)) assert.ok(allowed.has(f), `${name} / ${where}: ${f} kWh is not the expected ${expected}: ${t}`);
    }
  }
});

test('★★★ with no expected figure no spoken or pushed night-charge text states any kWh', () => {
  const p = plan();
  const cases: Array<[string, NightChargePlan]> = [
    ['no P50 basis', legacyPlan()],
    ['a plan from before v1.187.22', { ...p, expectedBuyKwh: undefined, expectedStartSocPct: undefined, expectedWriteLevelPct: undefined }],
    ['a null expected figure', { ...p, expectedBuyKwh: null }],
  ];
  for (const [name, q] of cases) {
    assert.equal(statedBuyKwh(q), null, name);
    for (const [where, t] of nightTexts(q)) {
      assert.doesNotMatch(t, /kWh|kilowatt|kilovatio/, `${name} / ${where}: ${t}`);
      for (const w of [q.buyKwh!, q.buyKwhDebiased!]) assert.ok(!statesFigure(t, w), `${name} / ${where} states the worst case: ${t}`);
    }
  }
});

test('★★★ the push: the level and the expected draw; the island troughs labelled as such; no kWh without an expected figure', () => {
  const p = plan();
  const m = buildNightChargeMessage(p, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: 50, forceChargeTargetPct: 80.4 });
  assert.equal(m.title, 'Night-charge: charging to ~80% tonight (~34.9 kWh)');
  // v1.187.22 (recheck) — the floor+cushion line is the one the plan is sized on (cushionLineSocPct,
  // 31.13%), as the hold push states it — it said 31% (reserveFloorPct + cushionPct, the legacy
  // band); and the force-charge clause says when it is expected to switch on. Pinned whole.
  assert.equal(p.expectedForceChargeStartMs, phx(10, 13, 2, 43));
  assert.equal(m.body, 'Charging the backup pool to ~80% overnight, ~34.9 kWh of grid energy expected. '
    + 'Whole-house island projection (if the grid were lost): tomorrow’s low SoC ~0% without this charge, ~0% with it; '
    + 'the floor+cushion line is 31.1%. Confidence: forecast. SUPERVISED: at 00:00 the add-on raises the backup reserve to 50% '
    + '(bounded write; auto-restores after the charge window closes). Then, at ~02:43, timed to finish by the window close, '
    + "it switches the panel's force-charge ON just long enough to reach ~80%, and OFF when it gets there (or when the window closes). "
    + 'Cancel from the night-charge card on the panel before then.');
  // Advisory: a recommendation, not "charging".
  const adv = buildNightChargeMessage(plan({ forceChargeEligible: false }), 'charge');
  assert.match(adv.title, /^Night-charge: charge to ~50% recommended tonight \(~\d+(\.\d)? kWh\)$/);
  assert.match(adv.body, /^Recommended: charge the backup pool to ~50% overnight, ~\d+(\.\d)? kWh of grid energy expected\. /);
  assert.match(adv.body, /Advisory only/);
  // No expected figure: the level, no kWh.
  const legacy = buildNightChargeMessage(legacyPlan(), 'charge', { cancelDeadlineText: 'at 00:00', targetPct: 50 });
  assert.equal(legacy.title, 'Night-charge: charging to ~50% tonight');
  assert.ok(legacy.body.startsWith('Charging the backup pool to ~50% overnight. Whole-house island projection (if the grid were lost): '), legacy.body);
});

test('★★★ the spoken line: the level and the expected draw; no energy figure without one; under 1 kWh said as such', () => {
  const p = plan();
  const { en, es } = nightChargeSpokenNotice({
    levelPct: chargeLevelPct(p)!, reservePct: 50, expectedKwh: statedBuyKwh(p), deadlineText: 'at 00:00', deadlineTextEs: 'a las 00:00', cushionShortfall: false,
  });
  // v1.187.22 — the time is the window's, not "starting at": a pool that opens above the reserve
  // is not charged at the open (the house draws it until the just-in-time start).
  assert.equal(en, 'Night charge notice. Charging the backup pool to about 80 percent, about 35 kilowatt hours, '
    + 'in the charge window that opens at 00:00. Cancel on the Power panel before then.');
  assert.equal(es, 'Aviso de carga nocturna. Se cargarán las baterías de respaldo hasta cerca del 80 por ciento, '
    + 'unos 35 kilovatios hora, en la ventana de carga que comienza a las 00:00. Cancele en el panel Power antes de esa hora.');
  // No expected figure: the level and the time only; the shortfall clause stays.
  const none = nightChargeSpokenNotice({
    levelPct: 50, reservePct: 50, expectedKwh: null, deadlineText: 'on Monday at 00:00', deadlineTextEs: 'el lunes a las 00:00', cushionShortfall: true,
  });
  assert.equal(none.en, 'Night charge notice. Charging the backup pool to about 50 percent, in the charge window that opens on Monday at 00:00. '
    + 'Outage cushion not fully met. Cancel on the Power panel before then.');
  assert.equal(none.es, 'Aviso de carga nocturna. Se cargarán las baterías de respaldo hasta cerca del 50 por ciento, '
    + 'en la ventana de carga que comienza el lunes a las 00:00. Margen de respaldo no cubierto por completo. Cancele en el panel Power antes de esa hora.');
  // v1.187.22 (recheck) — a pool expected above the level draws nothing: the line says the reserve
  // is held and no charge is expected. It said "Charging the backup pool to about 50 percent, less
  // than 1 kilowatt hour" (updated deliberately).
  const above = plan({ socNowPct: 74, forceChargeEligible: false });
  assert.equal(above.expectedBuyKwh, 0);
  const a = nightChargeSpokenNotice({
    levelPct: chargeLevelPct(above)!, reservePct: 50, expectedKwh: statedBuyKwh(above), deadlineText: 'at 00:00', deadlineTextEs: 'a las 00:00', cushionShortfall: false,
  });
  assert.equal(a.en, 'Night charge notice. The backup reserve will be held at 50 percent in the charge window that opens at 00:00; '
    + 'no charge is expected. Cancel on the Power panel before then.');
  assert.equal(a.es, 'Aviso de carga nocturna. La reserva de respaldo se mantendrá en el 50 por ciento en la ventana de carga que comienza '
    + 'a las 00:00; no se espera ninguna carga. Cancele en el panel Power antes de esa hora.');
  // The held line speaks the reserve the write sets, never the level (a force-charge night with no
  // start expected drives toward 80% and holds 50%), and keeps the shortfall clause.
  const fcHeld = nightChargeSpokenNotice({
    levelPct: 80, reservePct: 50, expectedKwh: 0.04, toward: true, deadlineText: 'at 00:00', deadlineTextEs: 'a las 00:00', cushionShortfall: true,
  });
  assert.match(fcHeld.en, /^Night charge notice\. The backup reserve will be held at 50 percent in the charge window that opens at 00:00; no charge is expected\. Outage cushion not fully met\. /);
  assert.match(fcHeld.es, /se mantendrá en el 50 por ciento .* no se espera ninguna carga\. Margen de respaldo no cubierto por completo\. /);
  for (const t of [a.en, a.es, fcHeld.en, fcHeld.es]) assert.doesNotMatch(t, /80|kilowat|kilovat|about 0|toward|rumbo/, t);
  // At the threshold it is a charge again, under 1 kWh said as such.
  const small = nightChargeSpokenNotice({ levelPct: 50, reservePct: 50, expectedKwh: NO_CHARGE_EXPECTED_KWH, deadlineText: 'at 00:00', deadlineTextEs: 'a las 00:00', cushionShortfall: false });
  assert.match(small.en, /to about 50 percent, less than 1 kilowatt hour, in the charge window that opens at 00:00\./);
  assert.match(small.es, /50 por ciento, menos de 1 kilovatio hora, en la ventana de carga que comienza a las 00:00\./);
  const one = nightChargeSpokenNotice({ levelPct: 50, reservePct: 50, expectedKwh: 1.2, deadlineText: 'at 00:00', deadlineTextEs: 'a las 00:00', cushionShortfall: false });
  assert.match(one.en, /, about 1 kilowatt hour, /);
  assert.match(one.es, /, alrededor de 1 kilovatio hora, /);
  // The longest line it can make stays inside the spoken bound — every figure shape (the held one
  // included), the window bound and the shortfall clause included.
  for (const expectedKwh of [null, 0, 0.4, 1.2, 123.4]) {
    for (const toward of [false, true]) {
      const longest = nightChargeSpokenNotice({
        levelPct: 100, reservePct: 50, expectedKwh, toward, deadlineText: 'on Wednesday at 12:00 AM', deadlineTextEs: 'el miércoles a las 12:00 AM', cushionShortfall: true,
      });
      assert.ok(longest.en.length + longest.es.length <= MAX_SPOKEN_ADVISORY_CHARS, `${expectedKwh}/${toward}: ${longest.en.length + longest.es.length} chars`);
    }
  }
});

test('★★ the morning summary and the apply-failure push: the armed day\'s expected figure, or no kWh', () => {
  const m = buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 34.88 });
  assert.equal(m.severity, 'info');
  assert.equal(m.dedupId, 'night_charge_actuation');
  assert.equal(m.title, 'Night-charge: reserve restored to 16%');
  assert.equal(m.body, 'Supervised night charge for 2026-10-12 completed: reserve raised to 50% (~34.9 kWh expected) and restored to 16%. '
    + "Delivery vs plan scores in the ledger at tomorrow evening's update.");
  assert.equal(buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: null }).body,
    "Supervised night charge for 2026-10-12 completed: reserve raised to 50% and restored to 16%. Delivery vs plan scores in the ledger at tomorrow evening's update.");
  // v1.187.22 — a force-charge night that RAN (a readback proved the ON): the figure covers the
  // force-charge leg, so it is named beside where that leg stops, not beside the 50% reserve alone.
  // (v1.187.22 recheck: what the force-charge did is the actuation record's — the ran /
  // unconfirmed / failed / never-started shapes are pinned in the force-charge outcome test.)
  assert.equal(buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 34.88, forceCharge: { kind: 'ran', stopPct: 80, expectedLeg: true } }).body,
    'Supervised night charge for 2026-10-12 completed: reserve raised to 50%, and force-charge ran toward ~80% (~34.9 kWh expected); '
    + "the reserve is restored to 16%. Delivery vs plan scores in the ledger at tomorrow evening's update.");
  const f = buildNightChargeApplyFailure({ day: '2026-10-12', currentReservePct: 16, targetPct: 50, applyRetries: 2, expectedKwh: 34.88 });
  assert.equal(f.severity, 'warning');
  assert.equal(f.dedupId, 'night_charge_apply_failure');
  assert.equal(f.title, 'Night-charge: write did not take effect');
  assert.match(f.body, /still reads 16% \(target 50%\) after 2 re-issues\. Tonight's planned charge \(~34\.9 kWh expected\) will not happen; the pool stays on its normal floor\./);
  const fNone = buildNightChargeApplyFailure({ day: '2026-10-12', currentReservePct: null, targetPct: 50, applyRetries: 2, expectedKwh: null });
  assert.match(fNone.body, /still reads unknown% .* Tonight's planned charge will not happen;/);
  assert.doesNotMatch(fNone.body, /kWh/);
  // The armed record keeps only the worst case (armFromPlan, unchanged); the expected figure is
  // read back from the plan row of the armed day.
  const rows = [
    { plan_date: '2026-10-11', expected_buy_kwh: 20.1 },
    { plan_date: '2026-10-12', expected_buy_kwh: 34.88 },
    { plan_date: '2026-10-13', expected_buy_kwh: null },
  ];
  assert.equal(ledgerExpectedBuyKwh(rows, '2026-10-12'), 34.88);
  assert.equal(ledgerExpectedBuyKwh(rows, '2026-10-13'), null);
  assert.equal(ledgerExpectedBuyKwh(rows, '2026-10-14'), null);
  assert.equal(ledgerExpectedBuyKwh(rows, null), null);
});

test('★★ wiring (index.ts is not reachable from a unit test): the spoken line, the pushes and the logs', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  // The spoken line: the level the write drives to and the expected draw.
  assert.match(idx, /nightChargeSpokenNotice\(\{\n\s+levelPct: chargeLevelPct\(plan\) \?\? supervisedCtx\.targetPct,\n(\s+\/\/.*\n)*\s+reservePct: supervisedCtx\.targetPct,\n\s+expectedKwh: statedBuyKwh\(plan\),\n/);
  // The after-the-fact pushes: the builders above, with the armed day's expected figure.
  assert.match(idx, /function armedExpectedBuyKwh\(day: string \| null\): number \| null \{\n\s+try \{\n\s+return ledgerExpectedBuyKwh\(recorder\.readNightLedger\(14\), day\);/);
  assert.match(idx, /const expectedKwh = armedExpectedBuyKwh\(state\.day\);\n/);
  assert.match(idx, /sendNotification\(loadNotifyConfig\(\), buildNightChargeApplyFailure\(\{\n\s+day: state\.day, currentReservePct, targetPct: state\.targetPct, applyRetries: state\.applyRetries, expectedKwh,\n/);
  assert.match(idx, /sendNotification\(loadNotifyConfig\(\), buildNightChargeMorningSummary\(\{\n\s+day: state\.day, targetPct: state\.targetPct, restorePct: action\.restorePct,\n\s+expectedKwh: armedExpectedBuyKwh\(state\.day\),\n/);
  // The ARMED log keeps both figures, labelled.
  assert.match(idx, /\(\$\{buyFiguresLogText\(plan\?\.expectedBuyKwh, plan\?\.buyKwhDebiased \?\? plan\?\.buyKwh\)\}\); announced via/);
  // The armed record's buyKwh (the worst case) reaches index.ts's text only in labelled log lines.
  const lines = idx.split('\n').filter((l) => /\.buyKwh\b/.test(l) && l.includes('`'));
  assert.ok(lines.length >= 4, `${lines.length} template lines read a buyKwh`);
  for (const l of lines) assert.match(l, /buyFiguresLogText|worst-case sizing ~|buyKwh=\$\{/, l.trim());
});

test('★★★ the rationale states the worst case once, in the sentence that labels it the sizing basis', () => {
  for (const [name, p] of [['2026-10-12', plan()], ['74%', plan({ socNowPct: 74 })], ['calibrated', calibratedPlan()],
    ['no P50 basis', legacyPlan()], ['Friday', fridayPlan()]] as const) {
    assert.match(p.rationale, /^Charge (to|toward) ~[\d.]+% in the \d\d:\d\d–\d\d:\d\d window[:.]/, name);
    const w = `~${r1(p.buyKwhDebiased!)} kWh`;
    assert.equal(p.rationale.split(w).length - 1, 1, `${name}: ${p.rationale}`);
    assert.ok(p.rationale.includes(`Sized on an islanded worst case (${WORST_CASE_BASIS}) of ${w}`), `${name}: ${p.rationale}`);
  }
  // The de-bias rides beside the figure it multiplies.
  const cal = calibratedPlan();
  assert.ok(cal.rationale.includes(`of ~${r1(cal.buyKwhDebiased!)} kWh (raw estimate ${r1(cal.buyKwh!)} kWh × 1.66 realized-buy calibration), from ~`), cal.rationale);
  // Friday: the window cannot pass the whole draw, and the headline says "toward".
  assert.match(fridayPlan().rationale, /^Charge toward ~80% in the 23:00–00:00 window: ~\d+(\.\d)? kWh expected\./);
});

test('★★ the card: the charge the write arms as the headline, the worst case only in its labelled sizing line', () => {
  const p = plan();
  const parts = chargeFigureParts(p, 50);
  assert.deepEqual(parts, { main: p.expectedBuyKwh!.toFixed(1), unit: 'kWh', label: 'expected charge to ~80%' });
  assert.ok(!JSON.stringify(parts).includes(String(r1(p.buyKwh!))));
  const line = sizingLine(p)!;
  assert.equal(line, `Sized on an islanded worst case (${WORST_CASE_BASIS}) of ~${r1(p.buyKwh!)} kWh.`);
  // The card's line is the server's sentence.
  assert.ok(p.rationale.includes(line.slice(0, -1)), p.rationale);
  // No expected figure: the level, no kWh.
  assert.deepEqual(chargeFigureParts(legacyPlan(), 50), { main: '50', unit: '%', label: 'charge target' });
  // A plan from before v1.187.22: the setpoint as written, at most the panel maximum.
  assert.deepEqual(chargeFigureParts({ buyKwh: 63.92, setpointSocPct: 80.4 }, 50), { main: '50', unit: '%', label: 'charge target' });
  assert.deepEqual(chargeFigureParts({ buyKwh: 9, setpointSocPct: 37.6, expectedBuyKwh: 4.21 }, 50), { main: '4.2', unit: 'kWh', label: 'expected charge to ~38%' });
  // The de-bias rides beside the figure it multiplies, in the sizing line only.
  const cal = calibratedPlan();
  assert.equal(sizingLine(cal), `Sized on an islanded worst case (${WORST_CASE_BASIS}) of ~${r1(cal.buyKwhDebiased!)} kWh `
    + `(raw estimate ${r1(cal.buyKwh!)} kWh × 1.66 realized-buy calibration).`);
  assert.ok(cal.rationale.includes(sizingLine(cal)!.slice(0, -1)), cal.rationale);
  assert.ok(!JSON.stringify(chargeFigureParts(cal, 50)).includes(String(r1(cal.buyKwhDebiased!))));
  assert.equal(sizingLine({ buyKwh: null, setpointSocPct: 50 }), null);
  // The card renders no buy figure but these two (a source pin: the card is not reachable from a unit test).
  const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(card, /plan\.buyKwh/);
  assert.match(card, /const fig = chargeFigureParts\(plan, status\.reserveWriteMaxPct \?\? null\);\n\s+const sizing = sizingLine\(plan\);/);
  assert.match(card, /\{fig\.main\}/);
  assert.match(card, /\{sizing && <div className="text-xs text-muted mb-3 -mt-2">\{sizing\}<\/div>\}/);
});

test('★★ HA: the worst-case entity is named for what it is — same unique_id, value and config topic, no entity id in the payload', () => {
  const s = SENSORS.find((x) => x.unique_id === 'ecoflow_night_charge_buy_kwh')!;
  assert.equal(s.name, 'Night-Charge Buy (Worst Case)');
  assert.equal(s.value_template, '{{ value_json.night_charge_buy_kwh }}');
  const cfg = sensorDiscoveryConfig(s);
  assert.equal(cfg.unique_id, 'ecoflow_night_charge_buy_kwh');
  assert.equal(cfg.name, 'Night-Charge Buy (Worst Case)');
  // HA keeps the entity_id it minted against the unique_id at first discovery; nothing in the
  // payload can move it.
  for (const k of ['object_id', 'default_entity_id', 'entity_id']) assert.equal(k in cfg, false, k);
  // The config topic is keyed on the unique_id, so the rename republishes the same retained config.
  const src = readFileSync(new URL('../src/mqttDiscovery.ts', import.meta.url), 'utf8');
  assert.match(src, /for \(const s of SENSORS\) \{\n\s+const topic = `\$\{prefix\}\/sensor\/\$\{s\.unique_id\}\/config`;\n\s+client\.publish\(topic, JSON\.stringify\(sensorDiscoveryConfig\(s\)\)/);
  // …and its value is the worst case, unchanged; the expected figure keeps its own entity.
  const p = plan();
  assert.equal(nightChargeStateFields(p, NOW + 60_000).night_charge_buy_kwh, p.buyKwh);
  assert.equal(SENSORS.find((x) => x.unique_id === 'ecoflow_night_charge_expected_buy_kwh')!.name, 'Night-Charge Expected Buy');
});

/* ── v1.187.22 (review) — no line presents a sizing figure as the outcome ────────────────── */

const resilience8 = (): NightChargePlan => plan({ objectiveMode: 'resilience', islandedLoadKw: 1.0, outageCushionHours: 8 });
const fridayReserveOnly = (): NightChargePlan => plan({
  periodIdAt: (ms) => (ms >= phx(10, 12, 23) && ms < phx(10, 13, 0)) || ms >= NEXT_WINDOW ? 'overnight' : 'off_peak',
  forceChargeEligible: false,
});
/** Does `t` state the percentage `v` — at the one decimal a push uses, or whole as a speaker says it? */
const statesPct = (t: string, v: number): boolean =>
  new RegExp(`(^|[^\\d.])${String(r1(v)).replace('.', '\\.')}%`).test(t)
  || new RegExp(`(^|[^\\d.])${Math.round(v)} (percent|por ciento)`).test(t);

test('★★★ no spoken or pushed text calls the worst-case arrival (targetSocPct) expected, or states it at all', () => {
  // targetSocPct is the arrival projected on the islanded worst case the plan is sized on. On a
  // reserve-only night the supervised push read "Charging the backup pool to ~50% overnight, ~5.1
  // kWh of grid energy expected. … The pack is only expected to reach ~27.5% — the reserve is the
  // ask, not a forecast": two outcomes, the one called expected the sizing basis.
  const cases: Array<[string, NightChargePlan]> = [
    ['resilience, 8 h cushion', resilience8()], ['resilience', plan({ objectiveMode: 'resilience' })],
    ['resilience from 30%', plan({ objectiveMode: 'resilience', socNowPct: 30 })],
    ['Friday, reserve only', fridayReserveOnly()], ['force-charge ineligible', plan({ forceChargeEligible: false })],
    ['2026-10-12', plan()], ['Friday', fridayPlan()], ['74% at 21:30', plan({ socNowPct: 74 })],
  ];
  let diverged = 0;
  for (const [name, p] of cases) {
    assert.ok(p.chargeTonight, name);
    const level = chargeLevelPct(p)!;
    const differs = Math.abs(p.targetSocPct! - level) > 0.5;
    if (differs) diverged++;
    for (const [where, t] of nightTexts(p)) {
      assert.doesNotMatch(t, /expected to reach|not a forecast/, `${name} / ${where}: ${t}`);
      // The floor+cushion line is a labelled line, not an outcome. In resilience mode the sizing
      // drives the worst-case arrival to exactly that line (31.13%), so its labelled statement is
      // set aside — and only it: the line must be stated in exactly that clause.
      const unlabelled = t.replace(`the floor+cushion line is ${fmtLinePct(floorCushionLinePct(p))}.`, '');
      if (differs) assert.ok(!statesPct(unlabelled, p.targetSocPct!), `${name} / ${where} states the worst-case arrival ${p.targetSocPct}%: ${t}`);
    }
  }
  assert.ok(diverged >= 5, 'the scan covers nights whose worst-case arrival is not the level');
});

test('★★ the rationale names the worst-case arrival once, in the sizing sentence, never as "expected"', () => {
  for (const [name, p] of [['resilience, 8 h cushion', resilience8()], ['resilience', plan({ objectiveMode: 'resilience' })],
    ['Friday', fridayPlan()], ['Friday, reserve only', fridayReserveOnly()], ['2026-10-12', plan()]] as const) {
    assert.doesNotMatch(p.rationale, /expected to reach/, `${name}: ${p.rationale}`);
    const t = `~${p.targetSocPct}%`;
    assert.equal(p.rationale.split(t).length - 1, 1, `${name}: ${t} in ${p.rationale}`);
    assert.ok(p.rationale.includes(`projecting ${t} by the window close.`), `${name}: ${p.rationale}`);
  }
  // The reserve sentence keeps the written reserve and the ask.
  assert.match(resilience8().rationale, / The reserve is set to 50% — the resilience requirement asks for 69\.5%, but the panel only accepts a backup reserve up to 50%\. /);
});

test('★★★ a window that cannot reach the level: every surface says "toward", never "to"', () => {
  // Friday's one-hour 23:00 window from ~48.2%: ~14.2 kWh lifts the pool ~14 points, to ~62%; the
  // write charges toward 80% and the window closes first. The rationale said "toward"; the push,
  // the speakers and the card said "to ~80%".
  const fri = fridayPlan();
  assert.equal(fri.expectedDeliverableBound, true);
  assert.equal(chargeIsWindowBound(fri), true);
  const armed = armFromPlan(emptyActuationState(), '2026-10-12', fri, NOW, 16)!;
  const sup = buildNightChargeMessage(fri, 'charge', { cancelDeadlineText: 'at 23:00', targetPct: armed.targetPct!, forceChargeTargetPct: armed.forceChargeCeilingPct });
  assert.equal(sup.title, `Night-charge: charging toward ~80% tonight (~${r1(fri.expectedBuyKwh!)} kWh)`);
  // v1.187.22 (recheck) — the WHOLE body: the force-charge clause said "near the end of the window,
  // it switches the panel's force-charge ON just long enough to reach ~80%" under the "toward"
  // headline. On this window the just-in-time start is due at the open (~23:00) and the window
  // closes first: the clause says when it starts and that it may not get there.
  assert.equal(fri.expectedForceChargeStartMs, phx(10, 12, 23));
  assert.equal(sup.body, `Charging the backup pool toward ~80% overnight, as far as the window can deliver, ~${r1(fri.expectedBuyKwh!)} kWh `
    + `of grid energy expected. Whole-house island projection (if the grid were lost): tomorrow’s low SoC ~${r1(fri.baselineMinSocPct!)}% `
    + `without this charge, ~${r1(fri.minProjSocPct!)}% with it; the floor+cushion line is 31.1%. Confidence: forecast. `
    + 'SUPERVISED: at 23:00 the add-on raises the backup reserve to 50% (bounded write; auto-restores after the charge window closes). '
    + "Then it switches the panel's force-charge ON at ~23:00 and charges toward ~80%; the window is expected to close before it "
    + 'gets there, and force-charge switches OFF then. Cancel from the night-charge card on the panel before then.');
  assert.doesNotMatch(sup.body, /near the end of the window|just long enough to reach/);
  assert.match(buildNightChargeMessage(fri, 'charge').title, /^Night-charge: charge toward ~80% recommended tonight/);
  const spoken = nightChargeSpokenNotice({
    levelPct: chargeLevelPct(fri)!, reservePct: armed.targetPct!, expectedKwh: statedBuyKwh(fri), toward: chargeIsWindowBound(fri),
    deadlineText: 'at 23:00', deadlineTextEs: 'a las 23:00', cushionShortfall: false,
  });
  assert.equal(spoken.en, 'Night charge notice. Charging the backup pool toward 80 percent, about 14 kilowatt hours, '
    + 'in the charge window that opens at 23:00, which ends before it gets there. Cancel on the Power panel before then.');
  assert.equal(spoken.es, 'Aviso de carga nocturna. Se cargarán las baterías de respaldo rumbo al 80 por ciento, unos 14 kilovatios hora, '
    + 'en la ventana de carga que comienza a las 23:00 y termina antes de alcanzar ese nivel. Cancele en el panel Power antes de esa hora.');
  assert.deepEqual(chargeFigureParts(fri, 50), { main: fri.expectedBuyKwh!.toFixed(1), unit: 'kWh', label: 'expected charge toward ~80%' });
  // A night the window can serve says "to" on every surface.
  const p = plan();
  assert.equal(p.expectedDeliverableBound, false);
  // (The morning push says "toward" on every force-charge night: after the fact it does not claim
  // the stop was reached.)
  for (const [where, t] of nightTexts(p)) if (!/^(morning|cancelled)/.test(where)) assert.doesNotMatch(t, /toward|rumbo/, `${where}: ${t}`);
  assert.equal(chargeFigureParts(p, 50).label, 'expected charge to ~80%');
  // A hold arms nothing and bounds nothing.
  assert.equal(chargeIsWindowBound(plan({ minBuyKwh: 1000 })), false);
});

/** The hold nights: the cushion covered (resilience, and cost mode at a full pack), a need under
 *  the minimum buy, a window that cannot cover the cushion, and no window at all. */
const holdCovered = (): NightChargePlan => plan({ objectiveMode: 'resilience', socNowPct: 90 });
const holdCostFull = (): NightChargePlan => plan({ socNowPct: 100, morningPvSurplusP50Kwh: 60, morningPvSurplusP90Kwh: 60 });
const holdSmall = (): NightChargePlan => plan({ objectiveMode: 'resilience', socNowPct: 60, minBuyKwh: 1000 });
const holdStarved = (): NightChargePlan => plan({
  objectiveMode: 'resilience', socNowPct: 30, minBuyKwh: 20,
  periodIdAt: (ms) => (ms >= WIN_START && ms < WIN_START + H / 2) || ms >= NEXT_WINDOW ? 'overnight' : 'off_peak',
});
const holdNoWindow = (): NightChargePlan => plan({ periodIdAt: () => 'off_peak' });

test('★★★ the hold push and the card say which hold it is, on the trough it was decided on, labelled', () => {
  // The body said "the projected overnight low SoC (0%) stays at or above the 31% floor+cushion" on
  // every hold: the whole-house island trough, unlabelled, not the trough the cushion test judged
  // (the pack at window close, 37.5%), so it contradicted itself; and a window that cannot cover
  // the cushion was pushed as "No overnight charge needed".
  const covered = holdCovered();
  assert.equal(covered.chargeTonight, false);
  assert.equal(covered.cushionTroughSocPct, 37.49);
  assert.equal(covered.baselineMinSocPct, 0);
  const c = buildNightChargeMessage(covered, 'hold');
  assert.equal(c.title, 'Night-charge: hold (no charge needed)');
  assert.equal(c.body, 'No overnight charge needed — even if the grid were lost overnight, the pack would close the charge window at ~37.5%, '
    + 'at or above the 31.1% floor+cushion line. Nothing will be charged.');
  assert.deepEqual(holdSummary(covered), {
    headline: 'No overnight charge needed.',
    detail: 'Even if the grid were lost overnight, the pack would close the charge window at ~37.5%, at or above the 31.1% floor+cushion line — nothing will be charged.',
    tone: 'ok',
  });
  // Cost mode at a full pack: the cushion trough, not the whole-house 5.5%.
  const full = holdCostFull();
  assert.equal(full.chargeTonight, false);
  assert.match(buildNightChargeMessage(full, 'hold').body, /the pack would close the charge window at ~47\.5%, at or above the 31\.1% floor\+cushion line/);
  // On the legacy-pct basis the cushion IS judged on the whole-house low, and it says so.
  const legacy = { ...covered, cushionBasis: 'legacy-pct' as const, cushionTroughSocPct: 41, cushionLineSocPct: 31 };
  assert.match(buildNightChargeMessage(legacy, 'hold').body, /even if the grid were lost overnight, the whole-house low would stay at ~41%, at or above the 31% floor\+cushion line/);
  assert.match(holdSummary(legacy).detail, /^Even if the grid were lost overnight, the whole-house low would stay at ~41%, at or above the 31% floor\+cushion line/);
  // A need under the minimum buy.
  const small = holdSmall();
  assert.equal(small.chargeTonight, false);
  assert.ok(small.requiredExtraKwh! > 0 && !small.cushionShortfall);
  assert.equal(buildNightChargeMessage(small, 'hold').title, 'Night-charge: hold (the need is under the minimum buy)');
  assert.match(holdSummary(small).detail, /needs only a small top-up, under the minimum buy/);
  // A window that cannot cover the cushion: never "no charge needed", and the shortfall disclosed.
  const starved = holdStarved();
  assert.equal(starved.chargeTonight, false);
  assert.equal(starved.cushionShortfall, true);
  assert.match(starved.rationale, /The window cannot serve the need/);
  const s = buildNightChargeMessage(starved, 'hold');
  assert.equal(s.title, 'Night-charge: no charge tonight (the window cannot cover the cushion)');
  assert.match(s.body, /^No overnight charge tonight — the outage cushion needs a charge, but this window cannot deliver enough to clear the minimum buy, so nothing will be charged\. NOTE: charge\/pool limits prevent fully meeting the cushion — residual risk remains\./);
  assert.equal(holdSummary(starved).tone, 'warn');
  assert.match(holdSummary(starved).detail, /residual risk remains/);
  // No window resolved: no trough to state at all.
  const none = holdNoWindow();
  assert.equal(none.basisComplete, true);
  assert.equal(none.chargeTonight, false);
  assert.equal(buildNightChargeMessage(none, 'hold').body, 'No overnight charge tonight — no cheap charge window was resolved. Nothing will be charged.');
  assert.equal(holdSummary(none).headline, 'No overnight charge tonight.');
  // Every hold: no "no charge needed" unless the cushion holds, no kWh, the whole-house trough
  // never stated as the night's low.
  for (const [name, h] of [['covered', covered], ['cost, full', full], ['small', small], ['starved', starved], ['no window', none]] as const) {
    const m = buildNightChargeMessage(h, 'hold');
    for (const t of [m.title, m.body, holdSummary(h).headline, holdSummary(h).detail]) {
      assert.doesNotMatch(t, /kWh|projected overnight low|Projected overnight trough/, `${name}: ${t}`);
      if (h.requiredExtraKwh !== 0) assert.doesNotMatch(t, /no charge needed|No overnight charge needed/i, `${name}: ${t}`);
    }
  }
  // The card renders the summary (a source pin: the card is not reachable from a unit test).
  const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  // v1.189.0 — with whether a write armed from the announced plan stands (chargeCardCancel.test.ts).
  assert.match(card, /const hold = holdSummary\(plan, \{ writeStands: stands \}\);/);
  assert.match(card, />\{hold\.headline\}<\/div>\n\s+<div className="text-muted mt-1 leading-relaxed">\{hold\.detail\}<\/div>/);
  assert.doesNotMatch(card, /Projected overnight trough/);
});

test('★★ a write mode that refused to arm pushes no level and no draw: it says nothing is armed, and why', () => {
  // armFromPlan refuses (here: the previous night's force-charge never verified OFF), the push
  // took the advisory shape and recommended "charge to ~80% … ~34.9 kWh of grid energy expected"
  // — a force-charge night nothing would run, and more than the advisory automation (the 50%
  // reserve) could draw.
  const p = plan();
  const prev: NightActuationState = { ...emptyActuationState(), day: '2026-10-11', forceChargeOnAtMs: NOW - 20 * H };
  assert.equal(armFromPlan(prev, '2026-10-12', p, NOW, 16), null);
  const why = armRefusalReason(prev, p, NOW, 16)!;
  assert.equal(why, 'the 2026-10-11 force-charge was switched ON and its OFF has not verified');
  const m = buildNightChargeMessage(p, 'charge', null, why);
  assert.equal(m.title, 'Night-charge: planned charge NOT armed tonight');
  assert.equal(m.body, "Tonight's plan calls for a charge, but the supervised write was not armed — "
    + 'the 2026-10-11 force-charge was switched ON and its OFF has not verified. The add-on will not charge tonight.');
  assert.doesNotMatch(`${m.title} ${m.body}`, /kWh|~\d+(\.\d)?%|Recommended/);
  // The cushion shortfall stays disclosed.
  assert.match(buildNightChargeMessage({ ...p, cushionShortfall: true }, 'charge', null, why).body, /residual risk remains/);
  // Not refused (advisory mode): the advisory shape, unchanged.
  assert.match(buildNightChargeMessage(p, 'charge', null, null).body, /^Recommended: charge the backup pool/);
});

test('★★ armRefusalReason names a reason exactly when armFromPlan refuses, in armFromPlan\'s order', () => {
  const p = plan();
  const base = emptyActuationState();
  const prevs: Array<[string, NightActuationState, number | null]> = [
    ['fresh', base, 16],
    ['applied, not reverted', { ...base, day: '2026-10-11', appliedAtMs: NOW - 20 * H }, 16],
    ['applied and reverted', { ...base, day: '2026-10-11', appliedAtMs: NOW - 20 * H, revertedAtMs: NOW - 15 * H }, 16],
    ['force-charge ON, OFF unverified', { ...base, day: '2026-10-11', forceChargeOnAtMs: NOW - 20 * H }, 16],
    ['force-charge OFF verified', { ...base, day: '2026-10-11', forceChargeOnAtMs: NOW - 20 * H, forceChargeOffVerifiedAtMs: NOW - 15 * H }, 16],
    ['attempt unconfirmed', { ...base, day: '2026-10-11', applyAttemptedAtMs: NOW - 20 * H, attemptBaselinePct: 16 }, 50],
    ['attempt proven un-applied', { ...base, day: '2026-10-11', applyAttemptedAtMs: NOW - 20 * H, attemptBaselinePct: 16 }, 16],
    ['attempt, reserve unknown', { ...base, day: '2026-10-11', applyAttemptedAtMs: NOW - 20 * H, attemptBaselinePct: 16 }, null],
  ];
  const plans: Array<[string, NightChargePlan, number]> = [
    ['charge', p, NOW], ['hold', plan({ minBuyKwh: 1000 }), NOW],
    ['window under way 20 min', p, WIN_START + 20 * 60_000], ['window under way 40 min', p, WIN_START + APPLY_LATE_MS + 10 * 60_000],
    ['no setpoint', { ...p, setpointSocPct: null }, NOW], ['no buy', { ...p, buyKwh: 0 }, NOW],
    ['inverted window', { ...p, window: { startMs: WIN_END, endMs: WIN_START } }, NOW],
  ];
  for (const [pn, prev, live] of prevs) {
    for (const [qn, q, now] of plans) {
      const armed = armFromPlan(prev, '2026-10-12', q, now, live);
      const why = armRefusalReason(prev, q, now, live);
      assert.equal(why == null, armed != null, `${pn} / ${qn}: ${why}`);
    }
  }
  assert.match(armRefusalReason(prevs[1][1], p, NOW, 16)!, /^the 2026-10-11 reserve write is still applied/);
  assert.match(armRefusalReason(prevs[5][1], p, NOW, 50)!, /^the 2026-10-11 reserve write was attempted and is not confirmed/);
  assert.equal(armRefusalReason(base, p, WIN_START + APPLY_LATE_MS + 10 * 60_000, 16), 'the charge window opened more than 30 minutes ago');
});

test('★★ the morning push after a cancel or a grid-loss abort says the night ended early, with no figure', () => {
  // Every successful revert sent "Supervised night charge … completed: reserve raised to 50% (~34.9
  // kWh expected)", including an owner cancel after the write and a grid-loss abort — a charge
  // that was stopped, reported as completed with its full expected purchase.
  const cancelled = buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 34.88, forceCharge: { kind: 'ran', stopPct: 80, expectedLeg: true }, ended: 'cancelled' });
  assert.equal(cancelled.title, 'Night-charge: cancelled — reserve restored to 16%');
  assert.equal(cancelled.body, 'Supervised night charge for 2026-10-12 was cancelled after the write: the reserve, raised to 50%, is restored to 16% and nothing more is charged tonight.');
  const lost = buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 34.88, ended: 'gridLoss' });
  assert.equal(lost.title, 'Night-charge: stopped (grid lost) — reserve restored to 16%');
  assert.equal(lost.body, 'Supervised night charge for 2026-10-12 stopped: the grid was lost during the window: the reserve, raised to 50%, is restored to 16% and nothing more is charged tonight.');
  for (const m of [cancelled, lost]) {
    assert.doesNotMatch(`${m.title} ${m.body}`, /kWh|completed|expected/);
    assert.equal(m.dedupId, 'night_charge_actuation');
    assert.equal(m.severity, 'info');
  }
  // The window closing is the completed shape, as before.
  assert.match(buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 5.05, ended: 'window' }).body,
    /^Supervised night charge for 2026-10-12 completed: reserve raised to 50% \(~5\.1 kWh expected\) and restored to 16%\. /);
  // Where the armed force-charge stops: the evening push's own condition.
  assert.equal(armedForceChargeStopPct({ forceChargeCeilingPct: 80.4 }, true), 80);
  assert.equal(armedForceChargeStopPct({ forceChargeCeilingPct: 64.3 }, true), 64.3);
  assert.equal(armedForceChargeStopPct({ forceChargeCeilingPct: 80.4 }, false), null, 'force-charge off');
  assert.equal(armedForceChargeStopPct({ forceChargeCeilingPct: 50 }, true), null, 'the reserve reaches it alone');
  assert.equal(armedForceChargeStopPct({ forceChargeCeilingPct: null }, true), null);
});

test('★★ the card labels the worst-case arrival and the island troughs as what they are', () => {
  // "Expected SoC 80%" sat under "5.0 kWh — expected charge to ~50%" on a reserve-only night: the
  // arrival projected on the islanded worst case, as a second, contradicting outcome.
  const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(card, /label="Expected SoC"|label="Trough with(out)? buy"/);
  assert.match(card, /label="Worst-case arrival"\n\s+value=\{fmtSoc\(plan\.targetSocPct\)\}/);
  assert.match(card, /\[\n\s+'sizing basis',\n/);
  assert.match(card, /<Stat label="Island low, no charge" value=\{fmtSoc\(plan\.baselineMinSocPct\)\} sub="if the grid were lost · P10 PV \/ P90 load" \/>/);
  assert.match(card, /<Stat label="Island low, with charge" value=\{fmtSoc\(plan\.minProjSocPct\)\} sub=\{`if the grid were lost · floor\+cushion/);
});

test('★★ HA: the worst-case arrival entity is named for it — same unique_id, value and key, no entity id in the payload', () => {
  const s = SENSORS.find((x) => x.unique_id === 'ecoflow_night_charge_expected_soc')!;
  assert.equal(s.name, 'Night-Charge Arrival SoC (Worst Case)');
  assert.equal(s.value_template, '{{ value_json.night_charge_expected_soc_percent }}');
  const cfg = sensorDiscoveryConfig(s);
  assert.equal(cfg.unique_id, 'ecoflow_night_charge_expected_soc');
  for (const k of ['object_id', 'default_entity_id', 'entity_id']) assert.equal(k in cfg, false, k);
  const p = resilience8();
  assert.equal(nightChargeStateFields(p, NOW + 60_000).night_charge_expected_soc_percent, p.targetSocPct, 'the value is unchanged');
});

test('★★ wiring (index.ts is not reachable from a unit test): the refused arm, "toward" on the speakers, the morning push', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  // R1 (v1.189.0) — the arm also stamps the on-peak start (armOnPeakStartMs; onPeakGuard.test.ts).
  // v1.189.0 — through armCycle (chargeCycle.ts): with one leg, armFromPlan / armRefusalReason against the
  // active leg (chargeCycle.test.ts holds the two equal).
  assert.match(idx, /const arm = armCycle\(nightCycleView\(\), today, \[\{\n\s+role: 'cost', kind: 'overnight', plan, forceChargeEnabled: forceChargeOn\(\), nextOnPeakStartMs: armOnPeakStartMs,\n[^\n]*\n\s+\}\], nowMs, plan\.reserveFloorPct\);\n\s+armedCycle = arm\.cycle;\n\s+armedCandidate = arm\.cycle\?\.active \?\? null;\n\s+if \(!armedCandidate\) armRefused = arm\.refused\[0\]\?\.reason \?\? null;/);
  assert.match(idx, /const msg = buildNightChargeMessage\(plan, shape, supervisedCtx, armRefused, NIGHT_CHARGE_MODE\);/);
  assert.match(idx, /\n\s+expectedKwh: statedBuyKwh\(plan\),\n\s+toward: chargeIsWindowBound\(plan\),\n/);
  assert.match(idx, /\n\s+expectedKwh: armedExpectedBuyKwh\(state\.day\),\n\s+forceCharge: forceChargeNightOutcome\(state, forceChargeOn\(\)\),\n\s+ended: action\.gridLossAbort \? 'gridLoss' : state\.cancelled \? 'cancelled' : 'window',\n/);
  // What the force-charge did is read from the record, never from the armed ceiling and the option alone.
  assert.doesNotMatch(idx, /armedForceChargeStopPct\(/);
});

/* ── v1.187.22 (recheck) — what the system will actually do, on every night shape ───────────── */

/** Nights whose write is expected to charge NOTHING: the pool is expected to open the window at or
 *  above the level the write drives it to. */
const heldReserveOnly = (): NightChargePlan => plan({ socNowPct: 74, forceChargeEligible: false });
const heldResilience = (): NightChargePlan => plan({ objectiveMode: 'resilience', islandedLoadKw: 1.0, outageCushionHours: 8, socNowPct: 60 });
const heldForceCharge = (): NightChargePlan => plan({ socNowPct: 100 });

test('★★★ a night expected to charge nothing says the reserve is held and no charge is expected — on every surface', () => {
  // 74% at 21:30, force-charge not riding the night: the pool should open the window near 65.9%,
  // above the 50% reserve, and the write charges nothing. Every surface said "charging to ~50%
  // (~0 kWh)" — the push title, the speakers ("less than 1 kilowatt hour"), the card ("0.0 kWh
  // expected charge to ~50%") and the morning push ("(~0 kWh expected)").
  const p = heldReserveOnly();
  assert.equal(p.chargeTonight, true, 'the worst case still buys: the write is armed');
  assert.equal(p.expectedBuyKwh, 0);
  assert.equal(p.expectedStartSocPct, 65.9);
  assert.equal(p.expectedWriteLevelPct, 50);
  assert.equal(noChargeExpected(p), true);
  assert.equal(chargeReservePct(p), 50);
  const armed = armFromPlan(emptyActuationState(), '2026-10-12', p, NOW, 16)!;
  assert.equal(armed.targetPct, 50, 'the write is unchanged');
  const sup = buildNightChargeMessage(p, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: 50 });
  assert.equal(sup.title, 'Night-charge: reserve held at 50% tonight — no charge expected');
  assert.equal(sup.body, 'Holding the backup reserve at 50% overnight as a floor; no charge is expected — the pool should open the '
    + `window near ~65.9% and stay at or above 50%. Whole-house island projection (if the grid were lost): tomorrow’s low SoC ~${r1(p.baselineMinSocPct!)}% `
    + `without tonight's write, ~${r1(p.minProjSocPct!)}% with it; the floor+cushion line is 31.1%. Confidence: forecast. `
    + 'SUPERVISED: at 00:00 the add-on raises the backup reserve to 50% (bounded write; auto-restores after the charge window closes). '
    + 'Cancel from the night-charge card on the panel before then.');
  const adv = buildNightChargeMessage(p, 'charge');
  assert.equal(adv.title, 'Night-charge: reserve hold at 50% recommended tonight — no charge expected');
  assert.match(adv.body, /^Recommended: hold the backup reserve at 50% overnight as a floor; no charge is expected — the pool should open the window near ~65\.9% and stay at or above 50%\. /);
  const spoken = nightChargeSpokenNotice({
    levelPct: chargeLevelPct(p)!, reservePct: armed.targetPct!, expectedKwh: statedBuyKwh(p), toward: chargeIsWindowBound(p),
    deadlineText: 'at 00:00', deadlineTextEs: 'a las 00:00', cushionShortfall: p.cushionShortfall,
  });
  assert.equal(spoken.en, 'Night charge notice. The backup reserve will be held at 50 percent in the charge window that opens at 00:00; '
    + 'no charge is expected. Cancel on the Power panel before then.');
  assert.equal(spoken.es, 'Aviso de carga nocturna. La reserva de respaldo se mantendrá en el 50 por ciento en la ventana de carga que comienza '
    + 'a las 00:00; no se espera ninguna carga. Cancele en el panel Power antes de esa hora.');
  assert.deepEqual(chargeFigureParts(p, 50), { main: '50', unit: '%', label: 'reserve held as a floor — no charge expected' });
  const morning = buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 0, forceCharge: forceChargeNightOutcome(armed, false) });
  assert.equal(morning.title, 'Night-charge: reserve restored to 16%');
  assert.equal(morning.body, 'Supervised night charge for 2026-10-12 completed: the reserve was held at 50% overnight as a floor '
    + "(no charge was expected) and is restored to 16%. Delivery vs plan scores in the ledger at tomorrow evening's update.");
  const fail = buildNightChargeApplyFailure({ day: '2026-10-12', currentReservePct: 16, targetPct: 50, applyRetries: 2, expectedKwh: 0 });
  assert.match(fail.body, /\. Tonight's planned reserve hold \(no charge was expected\) will not happen; the pool stays on its normal floor\. /);
  assert.match(p.rationale, /^Hold the reserve at 50% in the 00:00–05:00 window: no charge expected\. /);
});

test('★★★ every night expected to charge nothing: no "~0 kWh", "about 0" or "charging to" on any surface', () => {
  const cases: Array<[string, NightChargePlan]> = [
    ['74%, reserve only', heldReserveOnly()],
    // Resilience, an 8 h cushion on a 1 kW island, 60% at 21:30: opening ~51.9% over the 50% reserve.
    ['resilience 8 h, 60%', heldResilience()],
    // Force-charge riding the night from 100%: opening ~91.9%, drawn under the 80% stop only in the
    // window's last minutes, where no force-charge starts.
    ['force-charge, 100%', heldForceCharge()],
  ];
  for (const [name, p] of cases) {
    assert.equal(p.chargeTonight, true, name);
    assert.equal(p.expectedBuyKwh, 0, name);
    assert.ok(noChargeExpected(p), name);
    for (const [where, t] of nightTexts(p)) {
      assert.doesNotMatch(t, /~0(\.0)? ?kWh|0\.0 ?kWh|about 0\b|less than 1 kilowatt|menos de 1 kilovatio|kWh expected\)/, `${name} / ${where}: ${t}`);
      // (The armed force-charge is named by where it stops — "force-charge toward ~80%" — and is not a charge claim.)
      assert.doesNotMatch(t, /[Cc]harging (the backup pool )?(to|toward)|(?<!force-)[Cc]harge (to|toward) ~|expected charge|Se cargarán/, `${name} / ${where}: ${t}`);
    }
    const texts = Object.fromEntries(nightTexts(p));
    assert.equal(texts['push title'], 'Night-charge: reserve held at 50% tonight — no charge expected', name);
    assert.ok(texts['push body'].startsWith('Holding the backup reserve at 50% overnight as a floor; no charge is expected — the pool should open the window near ~'), `${name}: ${texts['push body']}`);
    assert.match(texts['spoken en'], /^Night charge notice\. The backup reserve will be held at 50 percent in the charge window that opens on Monday at 00:00; no charge is expected\. /, name);
    assert.match(texts['spoken es'], /^Aviso de carga nocturna\. La reserva de respaldo se mantendrá en el 50 por ciento en la ventana de carga que comienza el lunes a las 00:00; no se espera ninguna carga\. /, name);
    assert.equal(texts['card lead'], '50% reserve held as a floor — no charge expected', name);
    assert.match(texts['morning body (never started)'], /^Supervised night charge for 2026-10-12 completed: the reserve was held at 50% overnight as a floor \(no charge was expected\)/, name);
    assert.match(p.rationale, /^Hold the reserve at 50% in the 00:00–05:00 window: no charge expected\. Expected: /, name);
  }
  // Force-charge riding a night that charges nothing: armed, and not expected to start.
  const fc = heldForceCharge();
  assert.equal(fc.expectedWriteLevelPct, 80);
  assert.equal(fc.expectedForceChargeStartMs, null);
  const armed = armFromPlan(emptyActuationState(), '2026-10-12', fc, NOW, 16)!;
  const sup = buildNightChargeMessage(fc, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: 50, forceChargeTargetPct: armed.forceChargeCeilingPct });
  assert.match(sup.body, /Holding the backup reserve at 50% overnight as a floor; no charge is expected — the pool should open the window near ~91\.9% and stay at or above 50%\. /);
  assert.match(sup.body, /\(bounded write; auto-restores after the charge window closes\)\. It also arms the panel's force-charge toward ~80%, timed to finish by the window close; it is not expected to start\. Cancel from/);
  assert.match(sup.body, /this write is economic \(cost mode\)/);
  assert.doesNotMatch(sup.body, /just long enough|this buy is economic/);
  // The resilience night writes the clamped requirement and states the line it is sized on.
  const res = heldResilience();
  assert.equal(res.setpointSocPct! > 50, true);
  assert.match(Object.fromEntries(nightTexts(res))['push body'], /the floor\+cushion line is 27\.6%\./);
});

test('★★ the no-charge threshold: under what a push states as "~0 kWh", one definition on both sides', () => {
  assert.equal(NO_CHARGE_EXPECTED_KWH, 0.05);
  assert.equal(WEB_NO_CHARGE_EXPECTED_KWH, NO_CHARGE_EXPECTED_KWH, 'the card mirrors the server');
  assert.equal(isNoChargeKwh(0), true);
  assert.equal(isNoChargeKwh(0.049), true);
  assert.equal(isNoChargeKwh(0.05), false, 'at the threshold it is a charge (pushed "~0.1 kWh", spoken "less than 1")');
  assert.equal(isNoChargeKwh(null), false, 'no expected figure is not an expectation of none');
  assert.equal(isNoChargeKwh(undefined), false);
  assert.equal(isNoChargeKwh(Number.NaN), false);
  assert.equal(noChargeExpected({ expectedBuyKwh: 0.04 }), true);
  assert.equal(noChargeExpected({ expectedBuyKwh: 0.3 }), false);
  assert.equal(noChargeExpected({}), false, 'a plan from before v1.187.22');
  assert.equal(armedExpectedPhrase(0), null, 'never "~0 kWh expected"');
  assert.equal(armedExpectedPhrase(0.04), null);
  assert.equal(armedExpectedPhrase(0.05), '~0.1 kWh expected');
  // The card's lead flips at the same figure, and states the reserve the server says the write sets.
  const p = plan({ socNowPct: 74, forceChargeEligible: false });
  assert.equal(chargeFigureParts({ ...p, expectedBuyKwh: 0.049 }, 50).label, 'reserve held as a floor — no charge expected');
  assert.equal(chargeFigureParts({ ...p, expectedBuyKwh: 0.05 }, 50).label, 'expected charge to ~50%');
  assert.equal(Number(chargeFigureParts(p, 50).main), chargeReservePct(p));
  assert.equal(chargeFigureParts({ ...p, setpointSocPct: 37.6, expectedWriteLevelPct: 38 }, 50).main, '38');
  assert.equal(chargeFigureParts({ ...p, setpointSocPct: null, expectedWriteLevelPct: null }, 50).main, '—');
  // Under the threshold from just under the reserve: held, with no "stays above" clause the
  // expected open would contradict.
  const edge = buildNightChargeMessage({ ...p, expectedBuyKwh: 0.02, expectedStartSocPct: 49.98 }, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: 50 });
  assert.equal(edge.title, 'Night-charge: reserve held at 50% tonight — no charge expected');
  assert.ok(edge.body.startsWith('Holding the backup reserve at 50% overnight as a floor; no charge is expected. Whole-house island projection'), edge.body);
  // A small positive draw is still a charge on every surface, never held.
  const small = { ...p, expectedBuyKwh: 0.3 };
  assert.equal(buildNightChargeMessage(small, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: 50 }).title, 'Night-charge: charging to ~50% tonight (~0.3 kWh)');
});

test('★★★ the morning push states what the force-charge actually did, from the actuation record', () => {
  // The morning push named "force-charge toward ~80%" whenever the armed ceiling sat above 50% and
  // the option was on (armedForceChargeStopPct) — including the nights decideForceCharge never
  // started it (the ceiling never read back, Charge Now already on, the grid unknown, no slot
  // readback, vitals red, the pool already at the stop).
  const p = plan();
  // v1.187.22 (recheck 3) — armed with force-charge enabled: the record carries the stamp.
  const armed = armFromPlan(emptyActuationState(), '2026-10-12', p, NOW, 16, true)!;
  assert.equal(armed.forceChargeRides, true);
  const onAt = phx(10, 13, 2, 43);
  const ran: NightActuationState = { ...armed, forceChargeOnAtMs: onAt, forceChargeOnVerifiedAtMs: onAt + 60_000 };
  const failed: NightActuationState = { ...armed, forceChargeOnAtMs: onAt, forceChargeOnFailedAtMs: onAt + 600_000 };
  const late: NightActuationState = { ...failed, forceChargeOnVerifiedAtMs: onAt + 900_000 };
  const unconfirmed: NightActuationState = { ...armed, forceChargeOnAtMs: onAt };
  // A record armed before the stamp: whether force-charge rode is read from the option now.
  const legacy: NightActuationState = { ...armed, forceChargeRides: null };
  const leg = { expectedLeg: true };
  const outcomes: Array<[string, NightActuationState, boolean, ForceChargeNightOutcome]> = [
    ['never started', armed, true, { kind: 'neverStarted', stopPct: 80, ...leg }],
    ['ran', ran, true, { kind: 'ran', stopPct: 80, ...leg }],
    ['failed', failed, true, { kind: 'failed', stopPct: 80, ...leg, partialSlots: null }],
    ['applied after the warning', late, true, { kind: 'ran', stopPct: 80, ...leg }],
    ['unconfirmed', unconfirmed, true, { kind: 'unconfirmed', stopPct: 80, ...leg }],
    // The stamp, not the option at the restore: a restart with force-charge switched off does not
    // turn the armed-to-ride night into "reserve only".
    ['armed to ride, option off by the restore', armed, false, { kind: 'neverStarted', stopPct: 80, ...leg }],
    ['armed to ride, option off, but switched on', ran, false, { kind: 'ran', stopPct: 80, ...leg }],
    // Armed with force-charge disabled: reserve only — unless something of ours was switched ON.
    ['armed disabled, option on by the restore', { ...armed, forceChargeRides: false }, true, { kind: 'none', expectedLeg: false }],
    ['armed disabled, but switched on', { ...ran, forceChargeRides: false }, true, { kind: 'ran', stopPct: 80, expectedLeg: false }],
    ['reserve-only ceiling', { ...armed, forceChargeCeilingPct: 50, forceChargeRides: false }, true, { kind: 'none', expectedLeg: false }],
    ['no ceiling', { ...armed, forceChargeCeilingPct: null, forceChargeRides: false }, true, { kind: 'none', expectedLeg: false }],
    ['on with no ceiling', { ...unconfirmed, forceChargeCeilingPct: null, forceChargeRides: false }, true, { kind: 'unconfirmed', stopPct: null, expectedLeg: false }],
    // Before the stamp: the option now decides whether it rode, and whether the figure counts a
    // force-charge leg is unknown while the armed ceiling sat above the reserve maximum.
    ['before the stamp, enabled', legacy, true, { kind: 'neverStarted', stopPct: 80, expectedLeg: null }],
    ['before the stamp, disabled', legacy, false, { kind: 'none', expectedLeg: null }],
    ['before the stamp, no ceiling', { ...legacy, forceChargeCeilingPct: null }, true, { kind: 'none', expectedLeg: false }],
    ['before the stamp, ran', { ...ran, forceChargeRides: null }, false, { kind: 'ran', stopPct: 80, expectedLeg: null }],
  ];
  for (const [name, rec, enabled, want] of outcomes) assert.deepEqual(forceChargeNightOutcome(rec, enabled), want, name);
  const body = (rec: NightActuationState, expectedKwh: number | null = 34.88) => buildNightChargeMorningSummary({
    day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh, forceCharge: forceChargeNightOutcome(rec, true),
  }).body;
  const tail = "Delivery vs plan scores in the ledger at tomorrow evening's update.";
  assert.equal(body(ran), 'Supervised night charge for 2026-10-12 completed: reserve raised to 50%, and force-charge ran toward ~80% '
    + `(~34.9 kWh expected); the reserve is restored to 16%. ${tail}`);
  assert.equal(body(armed), 'Supervised night charge for 2026-10-12 completed: reserve raised to 50%; force-charge toward ~80% never started; '
    + `the reserve is restored to 16%. ${tail}`);
  assert.equal(body(failed), 'Supervised night charge for 2026-10-12 completed: reserve raised to 50%; force-charge toward ~80% was switched ON '
    + `but did not take effect; the reserve is restored to 16%. ${tail}`);
  assert.equal(body(unconfirmed), 'Supervised night charge for 2026-10-12 completed: reserve raised to 50%; force-charge toward ~80% was switched ON '
    + `but the panel never confirmed it; the reserve is restored to 16%. ${tail}`);
  // The expected figure covers the force-charge leg: it is named only beside a force-charge that ran.
  for (const rec of [armed, failed, unconfirmed]) assert.doesNotMatch(body(rec), /kWh|ran toward/);
  // A plan with no expected figure: what happened, no kWh.
  assert.equal(body(ran, null), 'Supervised night charge for 2026-10-12 completed: reserve raised to 50%, and force-charge ran toward ~80%; '
    + `the reserve is restored to 16%. ${tail}`);
  // A night expected to charge nothing whose force-charge never started (the plan said it would not).
  assert.equal(body(armed, 0), 'Supervised night charge for 2026-10-12 completed: the reserve was held at 50% overnight as a floor '
    + `(no charge was expected); force-charge toward ~80% never started; the reserve is restored to 16%. ${tail}`);
  // Reserve only: as before.
  assert.equal(buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 5.05, forceCharge: { kind: 'none', expectedLeg: false } }).body,
    `Supervised night charge for 2026-10-12 completed: reserve raised to 50% (~5.1 kWh expected) and restored to 16%. ${tail}`);
});

test('★★ the floor+cushion line: the one the plan is sized on, on the charge push, the hold push and the card', () => {
  // The plan holds the trough to targetFloorKwh = reserveKwh + cushionKwh (cushionLineSocPct). The
  // hold push stated that line; the charge push and the card's stat stated reserveFloorPct +
  // cushionPct, the legacy flat band — 31% beside a resilience plan sized on 27.55%.
  const res = resilience8();
  assert.equal(res.cushionBasis, 'islanded-outage');
  assert.equal(res.cushionLineSocPct, 27.55);
  assert.equal(res.reserveFloorPct + res.cushionPct, 31);
  assert.equal(floorCushionLinePct(res), 27.55);
  assert.equal(webFloorCushionLinePct(res), 27.55, 'the card reads the same line');
  assert.equal(fmtLinePct(27.55), '27.6%');
  const charge = buildNightChargeMessage(res, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: 50 });
  assert.match(charge.body, /; the floor\+cushion line is 27\.6%\. Confidence: /);
  assert.doesNotMatch(charge.body, /\b31%/);
  // The same line on the hold push and the card's hold summary for the same plan, held.
  const held = { ...res, chargeTonight: false, requiredExtraKwh: 0, cushionShortfall: false, cushionTroughSocPct: 40 };
  assert.match(buildNightChargeMessage(held, 'hold').body, /, at or above the 27\.6% floor\+cushion line\. Nothing will be charged\./);
  assert.match(holdSummary(held).detail, /, at or above the 27\.6% floor\+cushion line — nothing will be charged\./);
  // Server and card agree on every plan; the legacy sum stands in only without the line (a plan from
  // before v1.186.0), where it is the applied cushion's own basis.
  for (const p of [plan(), res, fridayPlan(), heldResilience(), holdCovered(), holdStarved()]) {
    assert.equal(webFloorCushionLinePct(p), floorCushionLinePct(p));
    assert.equal(floorCushionLinePct(p), p.cushionLineSocPct);
  }
  const old = { ...res, cushionLineSocPct: undefined };
  assert.equal(floorCushionLinePct(old), 31);
  assert.equal(webFloorCushionLinePct(old), 31);
  assert.match(buildNightChargeMessage(old, 'charge').body, /the floor\+cushion line is 31%\./);
  assert.equal(floorCushionLinePct({ reserveFloorPct: Number.NaN, cushionPct: 15 }), null);
  // The card states it from the shared helper, in the push's format (a source pin: the card is not
  // reachable from a unit test).
  const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /const floorCushionLine = fmtLinePct\(floorCushionLinePct\(plan\)\);/);
  assert.match(card, /sub=\{`if the grid were lost · floor\+cushion \$\{floorCushionLine\}`\}/);
  assert.doesNotMatch(card, /plan\.reserveFloorPct \+ plan\.cushionPct/);
  const web = readFileSync(new URL('../../web/src/cards/nightChargeText.ts', import.meta.url), 'utf8');
  assert.match(web, /\n\s+const line = floorCushionLinePct\(plan\);\n\s+const wholeHouse/);
  const notify = readFileSync(new URL('../src/notify.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(notify, /reserveFloorPct \+ plan\.cushionPct/);
});

test('★★ a refused arm: the card leads with "not armed tonight — <reason>", from the status the evening job records', () => {
  const p = plan();
  const reason = 'the 2026-10-11 force-charge was switched ON and its OFF has not verified';
  const rec = { reason, windowStartMs: WIN_START, windowEndMs: WIN_END };
  assert.equal(servedArmRefusal(rec, p, 'supervised', NOW), reason);
  assert.equal(servedArmRefusal(rec, p, 'auto', WIN_START + H), reason, 'through the window it was refused for');
  assert.equal(servedArmRefusal(rec, p, 'supervised', WIN_END), null, 'until that window closes');
  assert.equal(servedArmRefusal(rec, p, 'advisory', NOW), null, 'advisory arms nothing, so refuses nothing');
  assert.equal(servedArmRefusal(null, p, 'supervised', NOW), null);
  assert.equal(servedArmRefusal(rec, null, 'supervised', NOW), null);
  assert.equal(servedArmRefusal(rec, { ...p, chargeTonight: false }, 'supervised', NOW), null, 'a recompute that holds');
  assert.equal(servedArmRefusal(rec, { ...p, window: { startMs: NEXT_WINDOW, endMs: NEXT_WINDOW + H } }, 'supervised', NOW), null, 'another window');
  assert.equal(servedArmRefusal(rec, { ...p, window: null }, 'supervised', NOW), null);
  // The record survives a restart, and a malformed one is no refusal.
  assert.deepEqual(coerceArmRefusalRecord(JSON.parse(JSON.stringify(rec))), rec);
  for (const bad of [null, 'x', {}, { ...rec, reason: '' }, { ...rec, reason: 5 }, { ...rec, windowStartMs: 'x' }, { ...rec, windowEndMs: null }]) {
    assert.equal(coerceArmRefusalRecord(bad), null, JSON.stringify(bad));
  }
  // The card's lead: the push's words, no level, no kWh.
  const lead = refusedArmLead(reason);
  assert.deepEqual(lead, {
    headline: `Planned charge not armed tonight — ${reason}.`,
    detail: "Tonight's plan calls for a charge, but the supervised write was not armed. The add-on will not charge tonight.",
  });
  assert.doesNotMatch(`${lead.headline} ${lead.detail}`, /kWh|~\d+(\.\d)?%|expected/);
  // The card renders it in place of the expected charge (a source pin: the card is not reachable
  // from a unit test).
  const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /const noChargeNight = noChargeExpected\(plan\);\n(\s+\/\/.*\n)*\s+const refused = status\.mode !== 'advisory' && status\.armRefusal\n\s+\? refusedArmLead\(status\.armRefusal, \{ mode: status\.mode, held: noChargeNight, reservePct: writtenReservePct\(plan, status\.reserveWriteMaxPct \?\? null\) \}\)\n\s+: null;/);
  assert.match(card, /\{refused \? \(\n\s+<div className="mb-3 text-sm">\n\s+<div className="text-warn font-medium">\{refused\.headline\}<\/div>\n\s+<div className="text-muted mt-1 leading-relaxed">\{refused\.detail\}<\/div>\n\s+<\/div>\n\s+\) : \(\n\s+<div className="flex items-baseline gap-4 mb-3 flex-wrap">\n\s+<div className="text-4xl font-bold tabular-nums text-ink">\n\s+\{fig\.main\}/);
  // index.ts records the refusal with the evening latch, reads it back coerced, and serves it.
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  // v1.187.22 (recheck 3) — a refusal, or a write no channel delivered (eveningNotArmedReason).
  assert.match(idx, /\n\s+const notArmed = eveningNotArmedReason\(\{\n\s+refused: armRefused, candidate: armedCandidate, delivered: haNotifyDelivered \|\| audibleDelivered, prior: nightActuationMem,\n\s+\}\);\n\s+writeNightChargeLatch\(\{\n\s+lastNotifyDay: today,\n\s+armRefused: notArmed && plan\?\.window\n\s+\? \{ reason: notArmed, windowStartMs: plan\.window\.startMs, windowEndMs: plan\.window\.endMs \} : null,\n\s+\}\); \/\/ latch AFTER a successful send/);
  assert.match(idx, /return \{ lastNotifyDay: typeof d === 'string' \? d : null, armRefused: coerceArmRefusalRecord\(raw\?\.armRefused\) \};/);
  assert.match(idx, /nightChargeLatchMem = \{ lastNotifyDay: l\.lastNotifyDay, armRefused: l\.armRefused \?\? null \};/);
  const route = idx.slice(idx.indexOf("app.get('/api/night-charge/status'"), idx.indexOf("app.post('/api/night-charge/cancel'"));
  assert.match(route, /\n\s+armRefusal: servedArmRefusal\(latch\.armRefused, plan, NIGHT_CHARGE_MODE, Date\.now\(\)\),\n/);
});

test('★★ the force-charge clause says when the force-charge is expected to switch on, on every night shape', () => {
  const clause = (p: NightChargePlan): string => {
    const armed = armFromPlan(emptyActuationState(), '2026-10-12', p, NOW, 16)!;
    const body = buildNightChargeMessage(p, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: 50, forceChargeTargetPct: armed.forceChargeCeilingPct }).body;
    return body.slice(body.indexOf('closes). ') + 'closes). '.length, body.indexOf('Cancel from'));
  };
  // 2026-10-12: a just-in-time start at ~02:43, timed to finish by the 05:00 close.
  const p = plan();
  assert.equal(fmtPhoenixDayHm(p.expectedForceChargeStartMs!, p.generatedAt), '02:43');
  assert.equal(clause(p), "Then, at ~02:43, timed to finish by the window close, it switches the panel's force-charge ON just long enough to "
    + 'reach ~80%, and OFF when it gets there (or when the window closes). ');
  // 74%: the house draws the pool to ~57.7% first; the start moves later.
  const p74 = plan({ socNowPct: 74 });
  assert.match(clause(p74), /^Then, at ~03:1\d, timed to finish by the window close, /);
  // Friday: due at the open, and the window closes first.
  assert.equal(clause(fridayPlan()), "Then it switches the panel's force-charge ON at ~23:00 and charges toward ~80%; the window is expected "
    + 'to close before it gets there, and force-charge switches OFF then. ');
  // No start expected.
  assert.equal(clause(heldForceCharge()), "It also arms the panel's force-charge toward ~80%, timed to finish by the window close; it is not expected to start. ");
  // A charge night whose force-charge is not expected to start (the reserve leg alone), and a
  // night expected to charge nothing whatever the walk's start: armed, not expected to start.
  const notStarting = "It also arms the panel's force-charge toward ~80%, timed to finish by the window close; it is not expected to start. ";
  assert.equal(clause({ ...p, expectedForceChargeStartMs: null }), notStarting);
  assert.equal(clause({ ...heldForceCharge(), expectedForceChargeStartMs: phx(10, 13, 4, 30) }), notStarting);
  // No P50 basis (the start unknown): timed to the close, no time given.
  const unknown = { ...p, expectedForceChargeStartMs: undefined, expectedBuyKwh: null, expectedDeliverableBound: false };
  assert.equal(clause(unknown), "Then, just in time to finish by the window close, it switches the panel's force-charge ON just long enough to "
    + 'reach ~80%, and OFF when it gets there (or when the window closes). ');
  // The plan carries the start only when force-charge rides the night.
  assert.equal('expectedForceChargeStartMs' in plan({ forceChargeEligible: false }), false);
  assert.equal('expectedForceChargeStartMs' in legacyPlan(), false);
  assert.equal('expectedForceChargeStartMs' in plan({ minBuyKwh: 1000 }), false, 'a hold');
});

/* ── v1.187.22 (recheck 3) — the level the night reaches, the arm-time stamp, partial failures,
 *    every way a night ends up not armed ─────────────────────────────────────────────────── */

/** Force-charge riding the night with no just-in-time start expected while the reserve leg still
 *  charges: from 40% under a 51% cost ceiling the pool opens near ~31.9%, the 50% reserve draws
 *  ~18 kWh, and the force-charge to 51% is not expected to start. */
const reserveLegOnly = (): NightChargePlan => plan({ socNowPct: 40, costMaxSocPct: 51 });
const TAIL = "Delivery vs plan scores in the ledger at tomorrow evening's update.";

test('★★★ force-charge armed but not expected to start: every line states the reserve the night reaches, not the stop', () => {
  // Every surface said "to ~51%" — the force-charge stop — on a night the pool is expected to stop
  // at the 50% reserve: the ~18 kWh is the reserve leg alone.
  const p = reserveLegOnly();
  assert.equal(p.chargeTonight, true);
  assert.equal(p.expectedWriteLevelPct, 51, 'the write still arms the force-charge to 51% (unchanged)');
  assert.equal(p.expectedForceChargeStartMs, null);
  assert.equal(p.expectedStartSocPct, 31.9);
  assert.equal(p.expectedBuyKwh, 17.97);
  assert.ok(Math.abs(p.expectedBuyKwh! - legKwh(31.9, 50)) < 0.1, 'the figure is the reserve leg alone');
  assert.equal(noChargeExpected(p), false);
  assert.equal(chargeLevelPct(p), 50);
  const armed = armFromPlan(emptyActuationState(), '2026-10-12', p, NOW, 16, true)!;
  assert.equal(armed.targetPct, 50);
  assert.equal(armed.forceChargeCeilingPct, 51);
  assert.equal(armed.forceChargeRides, true);
  const sup = buildNightChargeMessage(p, 'charge', { cancelDeadlineText: 'at 00:00', targetPct: 50, forceChargeTargetPct: armed.forceChargeCeilingPct });
  assert.equal(sup.title, 'Night-charge: charging to ~50% tonight (~18 kWh)');
  assert.equal(sup.body, 'Charging the backup pool to ~50% overnight, ~18 kWh of grid energy expected. '
    + 'Whole-house island projection (if the grid were lost): tomorrow’s low SoC ~0% without this charge, ~0% with it; '
    + 'the floor+cushion line is 31.1%. Confidence: forecast. SUPERVISED: at 00:00 the add-on raises the backup reserve to 50% '
    + "(bounded write; auto-restores after the charge window closes). It also arms the panel's force-charge toward ~51%, "
    + 'timed to finish by the window close; it is not expected to start. Cancel from the night-charge card on the panel before then.');
  assert.equal(buildNightChargeMessage(p, 'charge').title, 'Night-charge: charge to ~50% recommended tonight (~18 kWh)');
  const spoken = nightChargeSpokenNotice({
    levelPct: chargeLevelPct(p)!, reservePct: armed.targetPct!, expectedKwh: statedBuyKwh(p), toward: chargeIsWindowBound(p),
    deadlineText: 'at 00:00', deadlineTextEs: 'a las 00:00', cushionShortfall: p.cushionShortfall,
  });
  assert.equal(spoken.en, 'Night charge notice. Charging the backup pool to about 50 percent, about 18 kilowatt hours, '
    + 'in the charge window that opens at 00:00. Cancel on the Power panel before then.');
  assert.equal(spoken.es, 'Aviso de carga nocturna. Se cargarán las baterías de respaldo hasta cerca del 50 por ciento, '
    + 'unos 18 kilovatios hora, en la ventana de carga que comienza a las 00:00. Cancele en el panel Power antes de esa hora.');
  assert.deepEqual(chargeFigureParts(p, 50), { main: '18.0', unit: 'kWh', label: 'expected charge to ~50%' });
  assert.ok(p.rationale.startsWith('Charge to ~50% in the 00:00–05:00 window: ~18 kWh expected. Expected: the pool should open the window '
    + "near ~31.9% with the grid present (median load and PV, never below the 16% reserve), and tonight's write charges it to the 50% "
    + 'reserve; the just-in-time force-charge to 51% is not expected to start. '), p.rationale);
  // No surface states the stop as the level: 51% appears only where the force-charge is named by
  // where it stops (armed and not expected to start; after the fact, what it did).
  for (const [where, t] of nightTexts(p)) {
    const rest = t.replace(/force-charge (ran )?toward ~51%/g, '');
    assert.doesNotMatch(rest, /(^|[^\d.])51(\.0)?( ?%| percent| por ciento)/, `${where}: ${t}`);
  }
  // The stop whenever a start is expected (2026-10-12), the write's level on a plan with no start
  // field (reserve only, no basis), the reserve as written on a plan from before v1.187.22.
  assert.equal(chargeLevelPct(plan()), 80);
  assert.equal(chargeLevelPct({ setpointSocPct: 80.4, expectedWriteLevelPct: 80, expectedForceChargeStartMs: null }), 50);
  assert.equal(chargeLevelPct({ setpointSocPct: 80.4, expectedWriteLevelPct: 80, expectedForceChargeStartMs: phx(10, 13, 2, 43) }), 80);
  assert.equal(chargeLevelPct({ setpointSocPct: 80.4, expectedWriteLevelPct: 80 }), 80);
  assert.equal(chargeLevelPct({ setpointSocPct: 37.6, expectedWriteLevelPct: 38 }), 38);
  assert.equal(chargeLevelPct({ setpointSocPct: 80.4 }), 50);
  assert.equal(chargeLevelPct({ setpointSocPct: null, expectedWriteLevelPct: 80, expectedForceChargeStartMs: null }), 80, 'no reserve to state');
  // The card mirrors it.
  const label = (start?: number | null) => chargeFigureParts({
    buyKwh: 50.8, setpointSocPct: 73.1, expectedBuyKwh: 17.97, expectedWriteLevelPct: 51,
    ...(start === undefined ? {} : { expectedForceChargeStartMs: start }),
  }, 50).label;
  assert.equal(label(null), 'expected charge to ~50%');
  assert.equal(label(phx(10, 13, 4, 50)), 'expected charge to ~51%');
  assert.equal(label(), 'expected charge to ~51%');
  // A night expected to charge nothing leads with the reserve the write holds, whatever the level.
  assert.equal(chargeFigureParts({ ...heldForceCharge(), expectedForceChargeStartMs: phx(10, 13, 4, 30) }, 50).main, '50');
  // …from the field the status route serves (a source pin: the card is not reachable from a unit test).
  const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /\n\s+expectedForceChargeStartMs\?: number \| null;\n/);
});

test('★★★ the morning push reads whether force-charge rode the night from the arm-time stamp, never the option at the restore', () => {
  const p = plan();
  // armFromPlan stamps the evening push's own condition: enabled, and the ceiling above the reserve maximum.
  const a = armFromPlan(emptyActuationState(), '2026-10-12', p, NOW, 16, true)!;
  const b = armFromPlan(emptyActuationState(), '2026-10-12', p, NOW, 16, false)!;
  assert.equal(a.forceChargeRides, true);
  assert.equal(b.forceChargeRides, false);
  assert.equal(armFromPlan(emptyActuationState(), '2026-10-12', p, NOW, 16)!.forceChargeRides, null, 'not given: unknown');
  assert.equal(armFromPlan(emptyActuationState(), '2026-10-12', { ...p, costCeilingSocPct: 50 }, NOW, 16, true)!.forceChargeRides, false);
  assert.equal(armFromPlan(emptyActuationState(), '2026-10-12', { ...p, costCeilingSocPct: null }, NOW, 16, true)!.forceChargeRides, false);
  assert.equal(emptyActuationState().forceChargeRides, null);
  // The stamp changes nothing the write does.
  assert.deepEqual({ ...a, forceChargeRides: null }, { ...b, forceChargeRides: null });
  // It survives a restart; a record from before it reads as unknown, never a guess.
  assert.equal(coerceActuationState(JSON.parse(JSON.stringify(a))).forceChargeRides, true);
  assert.equal(coerceActuationState(JSON.parse(JSON.stringify(b))).forceChargeRides, false);
  const old: Record<string, unknown> = JSON.parse(JSON.stringify(a));
  delete old.forceChargeRides;
  assert.equal(coerceActuationState(old).forceChargeRides, null);
  assert.equal(coerceActuationState({ ...old, forceChargeRides: 'true' }).forceChargeRides, null);
  const morning = (rec: NightActuationState, enabled: boolean, expectedKwh = 34.88) => buildNightChargeMorningSummary({
    day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh, forceCharge: forceChargeNightOutcome(rec, enabled),
  }).body;
  // Armed to ride, then a restart with force-charge switched off (decideForceCharge then never starts
  // it): it said "reserve raised to 50% (~34.9 kWh expected) and restored to 16%" — the force-charge
  // leg's figure beside a reserve-only account.
  assert.equal(morning(a, false), 'Supervised night charge for 2026-10-12 completed: reserve raised to 50%; force-charge toward ~80% '
    + `never started; the reserve is restored to 16%. ${TAIL}`);
  // A record from before the stamp with the option off at the restore: reserve only — and its figure,
  // which may count the force-charge leg, is not named beside it.
  assert.equal(morning({ ...a, forceChargeRides: null }, false), `Supervised night charge for 2026-10-12 completed: reserve raised to 50% and restored to 16%. ${TAIL}`);
  // …unless no leg was possible (no armed ceiling above the reserve maximum).
  assert.equal(morning({ ...a, forceChargeRides: null, forceChargeCeilingPct: null }, false, 5.05),
    `Supervised night charge for 2026-10-12 completed: reserve raised to 50% (~5.1 kWh expected) and restored to 16%. ${TAIL}`);
  // Armed with force-charge disabled: reserve only, with its figure, whatever the option reads by the restore.
  assert.equal(morning(b, true, 5.05), `Supervised night charge for 2026-10-12 completed: reserve raised to 50% (~5.1 kWh expected) and restored to 16%. ${TAIL}`);
  // …and a force-charge that ran anyway (switched on by a restart mid-night) is reported, without the
  // reserve-only figure beside it.
  const onAt = phx(10, 13, 2, 43);
  const bRan: NightActuationState = { ...b, forceChargeOnAtMs: onAt, forceChargeOnVerifiedAtMs: onAt + 60_000 };
  assert.equal(morning(bRan, true, 5.05), 'Supervised night charge for 2026-10-12 completed: reserve raised to 50%, and force-charge ran toward ~80%; '
    + `the reserve is restored to 16%. ${TAIL}`);
  // Every record, every option at the restore: the figure appears only beside the legs it counts.
  const on = { forceChargeOnAtMs: onAt };
  for (const stamp of [true, false, null]) {
    for (const [what, extra] of [
      ['never on', {}], ['ran', { ...on, forceChargeOnVerifiedAtMs: onAt + 60_000 }],
      ['failed', { ...on, forceChargeOnFailedAtMs: onAt + 600_000 }], ['unconfirmed', on],
    ] as const) {
      for (const enabled of [true, false]) {
        const rec: NightActuationState = { ...a, ...extra, forceChargeRides: stamp };
        const fc = forceChargeNightOutcome(rec, enabled);
        const named = morning(rec, enabled).includes('kWh expected');
        const fits = fc.kind === 'none' ? fc.expectedLeg === false : fc.kind === 'ran' && fc.expectedLeg === true;
        assert.equal(named, fits, `${stamp}/${what}/${enabled}: ${morning(rec, enabled)}`);
        // (Under an 80.4% ceiling a reserve-only account names it only when the arm stamped that
        // force-charge did not ride: before the stamp, its figure may count the leg.)
        if (named && fc.kind === 'none') assert.equal(stamp, false, `${stamp}/${what}/${enabled}`);
      }
    }
  }
  // index.ts arms with the gate and names the force-charge on the evening push from the stamp.
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(idx, /\n\s+forceChargeTargetPct: armedCandidate\.forceChargeRides === true \? armedCandidate\.forceChargeCeilingPct : null,\n/);
  assert.doesNotMatch(idx, /forceChargeOn\(\) && armedCandidate\.forceChargeCeilingPct/);
});

test('★★ a force-charge ON that failed on only some slots is reported as such, in the warning and the morning push', () => {
  const armed = armFromPlan(emptyActuationState(), '2026-10-12', plan(), NOW, 16, true)!;
  const onAt = phx(10, 13, 2, 43);
  const on: NightActuationState = { ...armed, forceChargeOnAtMs: onAt, forceChargeSlots: [1, 2, 3], forceChargeOnFailedAtMs: onAt + 30 * 60_000 };
  const partial: NightActuationState = { ...on, forceChargeOnFailedSlots: [2] };
  const total: NightActuationState = { ...on, forceChargeOnFailedSlots: [1, 2, 3] };
  const before: NightActuationState = { ...on, forceChargeOnFailedSlots: null };
  assert.deepEqual(partialForceChargeOnFailureSlots(partial), [2]);
  assert.equal(partialForceChargeOnFailureSlots(total), null);
  assert.equal(partialForceChargeOnFailureSlots(before), null, 'a failure recorded before the slots were kept: whole-night');
  assert.equal(partialForceChargeOnFailureSlots({ forceChargeSlots: null, forceChargeOnFailedSlots: [2] }), null, 'no slot list');
  assert.equal(partialForceChargeOnFailureSlots({ forceChargeSlots: [1, 2, 3], forceChargeOnFailedSlots: [] }), null);
  assert.deepEqual(forceChargeNightOutcome(partial, true), { kind: 'failed', stopPct: 80, expectedLeg: true, partialSlots: [2] });
  assert.deepEqual(forceChargeNightOutcome(total, true), { kind: 'failed', stopPct: 80, expectedLeg: true, partialSlots: null });
  const body = (rec: NightActuationState) => buildNightChargeMorningSummary({
    day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 34.88, forceCharge: forceChargeNightOutcome(rec, true),
  }).body;
  // It said "was switched ON but did not take effect" though the other slots took the ON.
  assert.equal(body(partial), 'Supervised night charge for 2026-10-12 completed: reserve raised to 50%; force-charge toward ~80% was switched ON '
    + 'but did not take effect on slot(s) 2 (the buy above the reserve did not happen on those slot(s)); the reserve is restored to 16%. '
    + TAIL);
  assert.equal(body(total), 'Supervised night charge for 2026-10-12 completed: reserve raised to 50%; force-charge toward ~80% was switched ON '
    + `but did not take effect; the reserve is restored to 16%. ${TAIL}`);
  assert.equal(body(before), body(total));
  for (const r of [partial, total]) assert.doesNotMatch(body(r), /kWh/);
  // The record keeps the slots across a restart.
  assert.deepEqual(coerceActuationState(JSON.parse(JSON.stringify(partial))).forceChargeOnFailedSlots, [2]);
  assert.equal(coerceActuationState({ ...partial, forceChargeOnFailedSlots: undefined }).forceChargeOnFailedSlots, null);
  assert.deepEqual(coerceActuationState({ ...partial, forceChargeOnFailedSlots: [2, 7, 'x', 2.5] }).forceChargeOnFailedSlots, [2]);
  assert.equal(emptyActuationState().forceChargeOnFailedSlots, null);
  // The warning says "on those slot(s)" on exactly the same test.
  const warn = (slots: number[], ours: number[] | null) => buildNightForceChargeOnFailure({
    day: '2026-10-12', slots, ourSlots: ours, retries: 1, noRetry: false, ceilingPct: 80.4,
  }).body;
  assert.match(warn([2], [1, 2, 3]), /\(toward ~80%\) will not happen on those slot\(s\); the reserve charge is unaffected\./);
  assert.match(warn([1, 2, 3], [1, 2, 3]), /\(toward ~80%\) will not happen; the reserve charge is unaffected\./);
  assert.match(warn([2], null), /will not happen; /);
  // index.ts keeps the slots the warning names, and decides "on those slot(s)" on the same helper.
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(idx, /persistNightActuation\(\{ \.\.\.nightActuationMem, forceChargeOnFailedAtMs: nowMs, forceChargeOnFailedSlots: \[\.\.\.action\.slots\] \}\);\n\s+const all = partialForceChargeOnFailureSlots\(\{ forceChargeSlots: state\.forceChargeSlots, forceChargeOnFailedSlots: action\.slots \}\) == null;/);
});

test('★★ the force-charge ON-failure push names where the force-charge stops (~80%), not the ceiling (80.4%)', () => {
  const m = buildNightForceChargeOnFailure({ day: '2026-10-12', slots: [1, 2, 3], ourSlots: [1, 2, 3], retries: 1, noRetry: false, ceilingPct: 80.4 });
  assert.equal(m.severity, 'warning');
  assert.equal(m.dedupId, 'night_charge_force_charge_on_failure');
  assert.equal(m.title, 'Night-charge: force-charge did not take effect');
  assert.equal(m.body, 'The night-charge for 2026-10-12 switched force-charge ("Charge Now") ON, but the Smart Home Panel 2 still reads '
    + "slot(s) 1, 2, 3 OFF after 1 re-issue(s). Tonight's buy above the 50% reserve (toward ~80%) will not happen; the reserve charge "
    + 'is unaffected. No action needed tonight — but if this repeats, check the SHP2 cloud link.');
  assert.doesNotMatch(m.body, /80\.4/);
  const at = (ceilingPct: number | null, noRetry = false) => buildNightForceChargeOnFailure({
    day: '2026-10-12', slots: [3], ourSlots: [3], retries: 0, noRetry, ceilingPct,
  }).body;
  assert.match(at(64.3), /reserve \(toward ~64\.3%\) will not happen;/, 'below 80 the target is the stop');
  assert.match(at(85.3), /reserve \(toward ~85%\) will not happen;/, 'a whole-number ceiling stops it at 85');
  assert.match(at(null), /above the 50% reserve will not happen;/);
  assert.doesNotMatch(at(null), /toward|—%|\(—/);
  assert.match(at(80.4, true), /OFF after 0 re-issue\(s\) \(too close to the window end to re-issue\)\. /);
  // index.ts builds it from the record: the slots, ours, the armed ceiling.
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(idx, /buildNightForceChargeOnFailure\(\{\n\s+day: state\.day, slots: action\.slots, ourSlots: state\.forceChargeSlots, retries: state\.forceChargeOnRetries,\n\s+noRetry: action\.noRetry === true, ceilingPct: state\.forceChargeCeilingPct,\n\s+\}\)\)/);
  assert.doesNotMatch(idx, /\(toward \$\{state\.forceChargeCeilingPct/);
  // The stop is the one the morning push and the evening push name.
  assert.match(buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: null,
    forceCharge: forceChargeNightOutcome({ ...armFromPlan(emptyActuationState(), '2026-10-12', plan(), NOW, 16, true)!, forceChargeOnAtMs: NOW }, true) }).body,
  /force-charge toward ~80% was switched ON but the panel never confirmed it/);
});

test('★★ a write no announcement delivered is recorded like a refusal; a missed evening keeps a refusal that still stands', () => {
  const p = plan();
  const cand = armFromPlan(emptyActuationState(), '2026-10-12', p, NOW, 16, true)!;
  const idle = emptyActuationState();
  assert.equal(ARM_UNDELIVERED_REASON, 'the announcement could not be delivered');
  assert.equal(eveningNotArmedReason({ refused: null, candidate: cand, delivered: false, prior: idle }), ARM_UNDELIVERED_REASON);
  assert.equal(eveningNotArmedReason({ refused: null, candidate: cand, delivered: true, prior: idle }), null, 'armed');
  assert.equal(eveningNotArmedReason({ refused: null, candidate: null, delivered: false, prior: idle }), null, 'nothing to arm');
  assert.equal(eveningNotArmedReason({ refused: 'the plan sizes no buy', candidate: null, delivered: true, prior: idle }), 'the plan sizes no buy');
  // Saturday's arm for the same (Monday) window stays in place and will write: a write is armed.
  const sat: NightActuationState = { ...cand, day: '2026-10-10' };
  assert.equal(eveningNotArmedReason({ refused: null, candidate: cand, delivered: false, prior: sat }), null);
  // …unless it was cancelled, restored, never targeted, or is for another window.
  for (const prior of [
    { ...sat, cancelled: true }, { ...sat, revertedAtMs: NOW - H }, { ...sat, targetPct: null }, { ...sat, day: null },
    { ...sat, windowStartMs: NEXT_WINDOW }, { ...sat, windowEndMs: NEXT_WINDOW + H },
  ]) {
    assert.equal(eveningNotArmedReason({ refused: null, candidate: cand, delivered: false, prior }), ARM_UNDELIVERED_REASON, JSON.stringify(prior).slice(0, 60));
  }
  // It is served like a refusal, and the card leads with it.
  const rec = { reason: ARM_UNDELIVERED_REASON, windowStartMs: WIN_START, windowEndMs: WIN_END };
  assert.equal(servedArmRefusal(rec, p, 'supervised', NOW), ARM_UNDELIVERED_REASON);
  assert.deepEqual(refusedArmLead(ARM_UNDELIVERED_REASON, { mode: 'supervised', held: false, reservePct: 50 }), {
    headline: 'Planned charge not armed tonight — the announcement could not be delivered.',
    detail: "Tonight's plan calls for a charge, but the supervised write was not armed. The add-on will not charge tonight.",
  });
  // The missed-evening cutoff latches the day and keeps the record: Saturday's refusal for the window
  // Sat and Sun share is still served on Sunday night.
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const job = idx.slice(idx.indexOf('async function runNightChargeEveningJobInner'));
  const cutoffAt = job.indexOf('if (nowMin >= cutoffMin) {');
  assert.ok(cutoffAt > 0);
  const cutoff = job.slice(cutoffAt, job.indexOf('return;', cutoffAt));
  assert.match(cutoff, /\n\s+writeNightChargeLatch\(\{ lastNotifyDay: today, armRefused: latch\.armRefused \?\? null \}\);\n/);
  assert.doesNotMatch(cutoff, /writeNightChargeLatch\(\{ lastNotifyDay: today \}\)/);
  assert.ok(job.indexOf('const latch = readNightChargeLatch();') < cutoffAt, 'the latch it keeps is the one read at the top');
  const satRefusal = { reason: 'the 2026-10-09 reserve write is still applied and not yet restored', windowStartMs: WIN_START, windowEndMs: WIN_END };
  assert.equal(servedArmRefusal(coerceArmRefusalRecord(JSON.parse(JSON.stringify(satRefusal))), p, 'auto', WIN_START - 30 * 60_000), satRefusal.reason);
});

test('★★ a refused arm on a night expected to charge nothing is pushed and shown as the reserve hold it was; "the write" in auto mode', () => {
  const p = heldReserveOnly();
  const why = 'the 2026-10-11 reserve write is still applied and not yet restored';
  const m = buildNightChargeMessage(p, 'charge', null, why);
  assert.equal(m.title, 'Night-charge: planned reserve hold NOT armed tonight');
  assert.equal(m.body, "Tonight's plan holds the backup reserve at 50% overnight as a floor, with no charge expected, but the supervised write "
    + `was not armed — ${why}. The add-on will not raise the reserve tonight.`);
  const auto = buildNightChargeMessage(p, 'charge', null, why, 'auto');
  assert.equal(auto.title, m.title);
  assert.equal(auto.body, "Tonight's plan holds the backup reserve at 50% overnight as a floor, with no charge expected, but the write "
    + `was not armed — ${why}. The add-on will not raise the reserve tonight.`);
  // A charge night: "calls for a charge", and the write named for the mode.
  const c = buildNightChargeMessage(plan(), 'charge', null, why, 'auto');
  assert.equal(c.title, 'Night-charge: planned charge NOT armed tonight');
  assert.equal(c.body, `Tonight's plan calls for a charge, but the write was not armed — ${why}. The add-on will not charge tonight.`);
  assert.match(buildNightChargeMessage(plan(), 'charge', null, why, 'supervised').body, /, but the supervised write was not armed — /);
  for (const t of [m.title, m.body, auto.title, auto.body]) assert.doesNotMatch(t, /calls for a charge|planned charge|will not charge|kWh|~\d/, t);
  // The shortfall stays disclosed.
  assert.match(buildNightChargeMessage({ ...p, cushionShortfall: true }, 'charge', null, why).body, /raise the reserve tonight\. NOTE: .* residual risk remains\./);
  // The card, in the push's words.
  assert.deepEqual(refusedArmLead(why, { mode: 'supervised', held: true, reservePct: 50 }), {
    headline: `Planned reserve hold not armed tonight — ${why}.`,
    detail: "Tonight's plan holds the backup reserve at 50% overnight as a floor, with no charge expected, but the supervised write "
      + 'was not armed. The add-on will not raise the reserve tonight.',
  });
  assert.match(refusedArmLead(why, { mode: 'auto', held: true, reservePct: 50 }).detail, /, but the write was not armed\. /);
  assert.equal(refusedArmLead(why, { mode: 'auto' }).detail, "Tonight's plan calls for a charge, but the write was not armed. The add-on will not charge tonight.");
  assert.equal(refusedArmLead(why, { held: true }).detail.includes('at — overnight'), true, 'no reserve known: a dash, never a guess');
  // The card's inputs are the server's: noChargeExpected and the reserve the write sets.
  for (const q of [p, heldResilience(), heldForceCharge(), plan(), reserveLegOnly(), legacyPlan(), resilience8()]) {
    assert.equal(webNoChargeExpected(q), noChargeExpected(q));
    assert.equal(writtenReservePct(q, RESERVE_WRITE_MAX_PCT), chargeReservePct(q));
  }
  // Every night expected to charge nothing: the refused lines never call it a charge, on any surface.
  for (const q of [heldReserveOnly(), heldResilience(), heldForceCharge()]) {
    const texts = Object.fromEntries(nightTexts(q));
    for (const k of ['refused-arm title', 'refused-arm body', 'refused-arm title (auto)', 'refused-arm body (auto)', 'card lead (refused)', 'card lead (not delivered)']) {
      assert.doesNotMatch(texts[k], /[Cc]harge NOT armed|charge not armed|calls for a charge|will not charge/, `${k}: ${texts[k]}`);
    }
    assert.match(texts['refused-arm body (auto)'], /, but the write was not armed — /);
    assert.match(texts['card lead (not delivered)'], /^Planned reserve hold not armed tonight — the announcement could not be delivered\. .*, but the write was not armed\./);
  }
});

test('★★ no EV-contention note on a night expected to charge nothing — on the push or the card', () => {
  const ev = { basis: 'predicted' as const, windowEvKwh: 19.3, peakEvKw: 11.5, minChargeRateKw: 2.5, derateKwh: 4.1 };
  const charging: NightChargePlan = { ...plan({ forceChargeEligible: false }), bindingCap: 'evContention', evContention: ev };
  const held: NightChargePlan = { ...heldReserveOnly(), bindingCap: 'evContention', evContention: ev };
  assert.equal(noChargeExpected(charging), false);
  assert.equal(noChargeExpected(held), true);
  const sup = { cancelDeadlineText: 'at 00:00', targetPct: 50 };
  assert.match(buildNightChargeMessage(charging, 'charge', sup).body,
    / NOTE: EV charging is predicted inside the window \(~19\.3 kWh, peak ~11\.5 kW\); it shares the grid input, leaving ~2\.5 kW for the packs while the car charges\. /);
  // It said "…leaving ~2.5 kW for the packs while the car charges" beside "no charge is expected".
  for (const m of [buildNightChargeMessage(held, 'charge', sup), buildNightChargeMessage(held, 'charge')]) {
    assert.doesNotMatch(m.body, /EV|for the packs|while the car charges/, m.body);
  }
  // The unmodelled shape describes a pack charge too.
  const unavailable = { basis: 'unavailable' as const, windowEvKwh: null, peakEvKw: null, minChargeRateKw: null, derateKwh: null };
  const heldUnmodelled: NightChargePlan = { ...heldReserveOnly(), cushionShortfall: true, evContention: unavailable };
  assert.doesNotMatch(buildNightChargeMessage(heldUnmodelled, 'charge', sup).body, /EVSE|less than planned/);
  assert.match(buildNightChargeMessage({ ...heldUnmodelled, expectedBuyKwh: 5 }, 'charge', sup).body, / NOTE: no EVSE prediction covers this window/);
  // A hold the car's charging starves keeps the note: it is why nothing can be charged.
  assert.match(buildNightChargeMessage({ ...holdStarved(), bindingCap: 'evContention', evContention: ev }, 'hold').body, /leaving ~2\.5 kW for the packs/);
  // The card drops both lines on such a night (a source pin: the card is not reachable from a unit test).
  const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /\n\s+const noChargeNight = noChargeExpected\(plan\);\n/);
  assert.match(card, /\{!noChargeNight && plan\.bindingCap === 'evContention' && plan\.evContention\?\.windowEvKwh != null && \(/);
  assert.match(card, /\{!noChargeNight && plan\.evContention\?\.basis === 'unavailable' && plan\.cushionShortfall && \(/);
});
