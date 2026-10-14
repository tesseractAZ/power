import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeNightChargePlan, buildNightChargeInputs, nightChargeStateFields, expectedCarryKwh,
  expectedWindowLiftKwh, expectedBuyFromPlan, buyFigureText, headlineBuyKwh,
  type NightChargeInputDeps, type NightForecastHour, type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { armedWriteLevelPct, forceChargeEnabled } from '../src/nightForceCharge.js';
import { armFromPlan, emptyActuationState, nightChargeSpokenNotice, RESERVE_WRITE_MAX_PCT } from '../src/nightChargeActuator.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { SENSORS } from '../src/mqttDiscovery.js';
import { buyFigureParts } from '../../web/src/cards/nightChargeText.js';

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

/** The band as index.ts builds it: P90 = forecastLoadW × factor, embedded EV × factor, P50 copied. */
function band(o: { evExpectedW?: (ts: number) => number; p50?: boolean } = {}): NightForecastHour[] {
  const out: NightForecastHour[] = [];
  for (let ts = phx(10, 12, 21); ts < NEXT_WINDOW; ts += H) {
    const hour = (new Date(ts).getUTCHours() + 17) % 24; // Phoenix hour
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

/* ── the 2026-10-12 replay ──────────────────────────────────────────────── */

test('★★★ 2026-10-12: the worst case stays ~64 kWh, the expected buy is ~35 kWh, and the headline leads with it', () => {
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
  // The headline: expected first, the worst case named, then the target.
  assert.ok(p.rationale.startsWith(`Buy ~${r1(p.expectedBuyKwh!)} kWh expected (up to ~${r1(p.buyKwh!)} kWh in the worst case) → target 80.4% by the window close.`), p.rationale);
  assert.match(p.rationale, /Expected: the pool should open the window near ~4\d\.\d% with the grid present/);
  assert.match(p.rationale, /charges it to 80% \(the 50% reserve, then force-charge\)/);
  assert.match(p.rationale, /the worst case is sized from ~17\.6% at the window open/);
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
  // Without a P50 basis there is no expected figure and the headline is the pre-v1.187.22 line.
  assert.equal(before.expectedBuyKwh, null);
  assert.equal(before.expectedStartSocPct, null);
  assert.ok(before.rationale.startsWith(`Buy ~${r1(before.buyKwh!)} kWh overnight → target 80.4%`), before.rationale);
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

test('★★ an expected start ABOVE the write level draws nothing at the window open', () => {
  // Reserve only (force-charge ineligible): from ~66% the pool sits above the 50% reserve all
  // night, the house draws it toward 50%, and nothing is charged — exactly 0.
  const reserveOnly = plan({ socNowPct: 74, forceChargeEligible: false });
  assert.equal(reserveOnly.chargeTonight, true, 'the worst case still buys');
  assert.ok(reserveOnly.buyKwh! > 20, `worst case ${reserveOnly.buyKwh}`);
  assert.ok(reserveOnly.expectedStartSocPct! > 50, `expected start ${reserveOnly.expectedStartSocPct}`);
  assert.equal(reserveOnly.expectedBuyKwh, 0);
  assert.match(reserveOnly.rationale, /^Buy ~0 kWh expected \(up to ~[\d.]+ kWh in the worst case\)/);
  assert.match(reserveOnly.rationale, /already at or above the 50% tonight's write charges to/);
  // Force-charge riding the night, opening above its 80% stop: 0 at the window open (a drain
  // below the stop before the close would be bought back by the just-in-time start — not modelled).
  const fc = plan({ socNowPct: 96 });
  assert.equal(fc.chargeTonight, true, 'the worst case still buys');
  assert.ok(fc.expectedStartSocPct! > 80, `expected start ${fc.expectedStartSocPct}`);
  assert.equal(fc.expectedWriteLevelPct, 80);
  assert.equal(fc.expectedBuyKwh, 0);
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

test('★ mid-window the expected start is the live SoC (what is still to draw)', () => {
  const p = plan({ nowMs: phx(10, 13, 2, 10), socNowPct: 62 });
  assert.equal(p.chargeTonight, true, p.rationale);
  assert.equal(p.expectedStartSocPct, 62);
  assert.equal(p.expectedWriteLevelPct, 80);
  const want = ((80 - 62) / 100) * POOL / LEG;
  assert.ok(Math.abs(p.expectedBuyKwh! - want) < 0.1, `${p.expectedBuyKwh} vs ${want}`);
  assert.match(p.rationale, /Expected: the pool is at ~62% now, and tonight's write charges it to 80%/);
  assert.doesNotMatch(p.rationale, /worst case is sized from/, 'no pre-window carry mid-window');
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
  assert.match(idx, /\n\s+forceChargeEligible: forceChargeOn\(\),\n/);
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
  assert.equal(expectedCarryKwh({ startKwh: 50, fullKwh: 100, reserveKwh: 10, dischargeEff: 0.94, hours: [{ ts: 5 * H, pvP10W: 0, loadP90W: 1 }], fromMs: 0, toMs: H }), 50);
});

test('expectedWindowLiftKwh: the contended rate on the median load × legEff × the hour left', () => {
  const hrs = [0, 1].map((i) => ({ ts: i * H, pvP10W: 0, loadP90W: 14000, loadP50W: 3000 }));
  assert.equal(r1(expectedWindowLiftKwh({ hours: hrs, fromMs: 0.5 * H, windowEndMs: 2 * H, chargeCapKw: 20, envelopeKw: 17, legEff: 0.9 })!), r1(14 * 0.9 * 1.5));
  assert.equal(r1(expectedWindowLiftKwh({ hours: hrs, fromMs: 0, windowEndMs: 2 * H, chargeCapKw: 10, envelopeKw: null, legEff: 0.9 })!), 18);
  assert.equal(expectedWindowLiftKwh({ hours: [{ ts: 0, pvP10W: 0, loadP90W: 1 }], fromMs: 0, windowEndMs: H, chargeCapKw: 10, envelopeKw: null, legEff: 0.9 }), null);
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

test('expectedBuyFromPlan: never negative, bounded by the deliverable, null without a basis', () => {
  const base = { setpointSocPct: 80.4, costCeilingSocPct: 80.4, forceChargeEligible: true, fullKwh: 100, legEff: 0.9 };
  assert.deepEqual(expectedBuyFromPlan({ ...base, startKwh: 44, deliverableKwh: 1e9 }), { buyKwh: 40, levelPct: 80 });
  assert.deepEqual(expectedBuyFromPlan({ ...base, startKwh: 90, deliverableKwh: 1e9 }), { buyKwh: 0, levelPct: 80 });
  assert.deepEqual(expectedBuyFromPlan({ ...base, startKwh: 44, deliverableKwh: 9 }), { buyKwh: 10, levelPct: 80 });
  assert.deepEqual(expectedBuyFromPlan({ ...base, startKwh: null, deliverableKwh: 9 }), { buyKwh: null, levelPct: 80 });
  assert.deepEqual(expectedBuyFromPlan({ ...base, startKwh: 44, deliverableKwh: null }), { buyKwh: null, levelPct: 80 });
});

test('buyFigureText / buyFigureParts: expected first, the worst case named; "up to" only when it is one', () => {
  assert.equal(buyFigureText(33.84, 64.19), '~33.8 kWh expected (up to ~64.2 kWh in the worst case)');
  assert.equal(buyFigureText(15.2, 12.1), '~15.2 kWh expected (the worst case it is sized on is ~12.1 kWh)');
  assert.equal(buyFigureText(null, 64.19), '~64.2 kWh');
  assert.equal(buyFigureText(33.84, 64.19, '; x'), '~33.8 kWh expected (up to ~64.2 kWh in the worst case; x)');
  // The card's split mirrors the server's wording.
  assert.deepEqual(buyFigureParts(33.84, 64.19), { main: '33.8', label: 'expected buy overnight', worst: 'up to ~64.2 kWh in the worst case' });
  assert.deepEqual(buyFigureParts(15.2, 12.1), { main: '15.2', label: 'expected buy overnight', worst: 'the worst case it is sized on is ~12.1 kWh' });
  assert.deepEqual(buyFigureParts(undefined, 64.19), { main: '64.2', label: 'buy overnight', worst: null });
  assert.equal(headlineBuyKwh({ buyKwh: 64.19, expectedBuyKwh: 33.84 }), 33.84);
  assert.equal(headlineBuyKwh({ buyKwh: 64.19, expectedBuyKwh: null }), 64.19);
  assert.equal(headlineBuyKwh({ buyKwh: 64.19 }), 64.19, 'a plan from before v1.187.22');
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

test('★★★ the push leads with the expected figure and names the worst case', () => {
  const p = plan();
  const msg = buildNightChargeMessage(p, 'charge', { cancelDeadlineText: 'tonight at 12:00 AM', targetPct: 50, forceChargeTargetPct: 80.4 });
  assert.equal(msg.title, `Night-charge: buy ~${r1(p.expectedBuyKwh!)} kWh tonight`);
  assert.ok(msg.body.startsWith(`Buy ~${r1(p.expectedBuyKwh!)} kWh expected (up to ~${r1(p.buyKwh!)} kWh in the worst case) of grid energy overnight → target 80.4% pool SoC.`), msg.body);
  // A plan with no expected figure keeps the old push.
  const old = buildNightChargeMessage({ ...p, expectedBuyKwh: undefined }, 'charge');
  assert.equal(old.title, `Night-charge: buy ~${r1(p.buyKwh!)} kWh tonight`);
  assert.ok(old.body.startsWith(`Buy ~${r1(p.buyKwh!)} kWh of grid energy overnight`), old.body);
});

test('★★★ the spoken advisory says the expected figure — short, one number', () => {
  const p = plan();
  const { en, es } = nightChargeSpokenNotice({
    buyKwhRounded: Math.round(headlineBuyKwh(p) ?? 0), targetPct: 50,
    deadlineText: 'tonight at 12:00 AM', deadlineTextEs: 'esta noche a las 12:00 AM', cushionShortfall: false,
  });
  assert.match(en, new RegExp(`Buying about ${Math.round(p.expectedBuyKwh!)} kilowatt hours overnight`));
  assert.match(es, new RegExp(`Comprando unos ${Math.round(p.expectedBuyKwh!)} kilovatios hora`));
  assert.doesNotMatch(en, /64/);
  // index.ts builds the spoken figure from headlineBuyKwh (a wiring pin: the evening job is not
  // reachable from a unit test).
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(idx, /const buyRounded = Math\.round\(headlineBuyKwh\(plan\) \?\? 0\);/);
  assert.match(idx, /buyKwhRounded: buyRounded,/);
});
