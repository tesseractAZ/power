import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNightChargeInputs, computeNightChargePlan, middayReserveTargetPct, costCeilingKwh, gridGainKw,
  expectedWindowLiftKwh, expectedBuyFromPlan, expectedPvChargeWalk, OVERNIGHT_WINDOW_SPEC,
  middayReentryLinePct, MIDDAY_REENTRY_MARGIN_PCT,
  type NightChargeInputDeps, type NightForecastHour, type NightChargePlan, type NightChargeHour, type WindowSpec,
} from '../src/nightChargeAdvisor.js';
import { chooseChargeCycle, nextChargeableOpenMs, nextOnPeakStartMs, type ChargeCycleConfig } from '../src/chargeWindows.js';
import { pvSurplusFromBand, surplusSpanEndMs, saturationThresholdPct } from '../src/chargeTaper.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';
import { forceChargeStopPct, forceChargeStartAtMs, FORCE_CHARGE_MIN_RUN_MS } from '../src/nightForceCharge.js';
import { armCycle, emptyCycle } from '../src/chargeCycle.js';

/**
 * R2 — THE MID-DAY LEG, SIZED BY THE SAME ENGINE (WindowSpec). Nothing live plans it yet; these
 * pin what the engine says when the chooser hands it the super off-peak window:
 *  - T_mid, the reserve written at 10:00 (middayReserveTargetPct), with and without its R term;
 *  - the anchors: the pool the cost leg is sized from with an armed backup (max(walk, hold) at
 *    05:00) and without;
 *  - C_mid, the ceiling under the charge taper (basis 'pv-curtail');
 *  - the PV terms: the grid gain bounded by the packs' acceptance, and the P50 PV credited against
 *    the expected buy — checked against an independent minute-by-minute model of the write;
 *  - the leg's role: a backup leg is resilience-only and never force-charges.
 *
 * The fixture is Wednesday 2026-10-14 21:30 for Thursday 10-15 10:00–15:00, the 09-30 morning's
 * median PV and load (costCeilingLoadDebias.test.ts), the 2026-10-12 evening's house load.
 */

const H = 3_600_000;
const POOL = 92.16;
const LEG = 0.927;
const ETA = 0.94;
const MODEL = buildApsREvModel();
const periodIdAt = (ts: number): string => rateAt(MODEL, ts).periodId;
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const phxHour = (ts: number): number => (new Date(ts).getUTCHours() + 17) % 24;
const NOW = phx(10, 14, 21, 30);
const MIDDAY_CFG: ChargeCycleConfig = { costWindow: 'super_off_peak', objective: 'cost', costMaxSocPct: 90 };
const CYCLE = chooseChargeCycle(MODEL, NOW, MIDDAY_CFG);
const COST = CYCLE.cost!;
const BACKUP = CYCLE.backup!;

/** 05:00–18:00 on 09-30: the median PV and the forecast load, W. */
const P50_W = [0, 94, 608, 2647, 4725, 6276, 6635, 6695, 6243, 5274, 3938, 2057, 573, 21];
const LOAD_W = [2188, 1864, 1646, 2068, 1851, 2158, 2202, 2927, 3228, 4020, 3435, 3738, 3205, 2978];
const houseKw = (h: number): number => (h >= 21 || h < 0 ? 2.8 : h < 5 ? 2.2 : h < 17 ? 2.6 : 3.4);
const loadW = (h: number): number => (h >= 5 && h <= 18 ? LOAD_W[h - 5] : houseKw(h) * 1000);
const pvW = (h: number, scale: number): number => (h >= 5 && h <= 18 ? P50_W[h - 5] * scale : 0);
const P90F = 1.35;

function band(scale: number, o: { postLoadW?: number } = {}): NightForecastHour[] {
  const out: NightForecastHour[] = [];
  for (let ts = phx(10, 14, 22); ts < phx(10, 15, 23); ts += H) {
    const h = phxHour(ts);
    const post = o.postLoadW != null && ts >= COST.endMs;
    const l = post ? o.postLoadW! : loadW(h);
    const pv = post ? 0 : pvW(h, scale);
    out.push({ ts, pvP10W: pv * 0.8, loadP90W: l * P90F, embeddedEvW: 0, loadP50W: l, pvP50W: pv });
  }
  return out;
}

/** S50 / S90 over [15:00, on-peak) — chargeTaper's span for a super off-peak window. */
function surplus(scale: number): { p50Kwh: number | null; p90Kwh: number | null } {
  const hours = band(scale).map((b) => ({ ts: b.ts, p50W: b.pvP50W ?? 0, p90W: (b.pvP50W ?? 0) * 1.3, load: b.loadP50W ?? 0 }));
  const loads = new Map(hours.map((x) => [x.ts, x.load]));
  return pvSurplusFromBand({
    hours, loadAt: (ts) => loads.get(ts), fromMs: COST.endMs,
    toMs: surplusSpanEndMs('super_off_peak', COST.endMs, nextOnPeakStartMs(MODEL, COST.endMs)),
  });
}

function middaySpec(over: Partial<WindowSpec> = {}): WindowSpec {
  return { kind: 'super_off_peak', role: 'cost', window: { startMs: COST.startMs, endMs: COST.endMs }, curtailFromPct: saturationThresholdPct(100), ...over };
}

function deps(o: { scale?: number; socNowPct?: number; spec?: WindowSpec; postLoadW?: number; over?: Partial<NightChargeInputDeps> } = {}): NightChargeInputDeps {
  const scale = o.scale ?? 1;
  const s = surplus(scale);
  return {
    nowMs: NOW, fullKwh: POOL, socNowPct: o.socNowPct ?? 60, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.62, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90,
    legEff: LEG, dischargeEff: ETA, chargeCapKw: 17.8, gridInputCapKw: 17,
    periodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: band(scale, { postLoadW: o.postLoadW }), dayRollups: [], realizedDailyErrHalfFrac: 0.1,
    nextRechargeMs: nextChargeableOpenMs(MODEL, COST.endMs, MIDDAY_CFG),
    ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 }, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 14, bandCoverageFrac: 0.85,
    morningPvSurplusP90Kwh: s.p90Kwh, morningPvSurplusP50Kwh: s.p50Kwh, longGapAhead: false, prePeakPvSurplusP10Kwh: null,
    minBuyKwh: 1, buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: true,
    windowSpec: o.spec ?? middaySpec(),
    ...o.over,
  };
}
const plan = (o: Parameters<typeof deps>[0] = {}): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(deps(o)));

test('the fixture: Wednesday plans backup Wed 23:00–Thu 05:00 and the cost leg Thu 10:00–15:00; the post span ends at 23:00', () => {
  assert.equal(CYCLE.why, 'midday');
  assert.equal(BACKUP.startMs, phx(10, 14, 23));
  assert.equal(BACKUP.endMs, phx(10, 15, 5));
  assert.equal(COST.startMs, phx(10, 15, 10));
  assert.equal(COST.endMs, phx(10, 15, 15));
  assert.equal(nextChargeableOpenMs(MODEL, COST.endMs, MIDDAY_CFG), phx(10, 15, 23));
  assert.equal(surplusSpanEndMs('super_off_peak', COST.endMs, nextOnPeakStartMs(MODEL, COST.endMs)), phx(10, 15, 16));
  // S50 over 15:00–16:00: 3938 W of PV against 3435 W of load (S90: 3938 × 1.3).
  assert.deepEqual(surplus(1), { p90Kwh: 1.68, p50Kwh: 0.5 });
});

/* ══ T_mid ══════════════════════════════════════════════════════════════════ */

test('★★★ T_mid = clamp[10,50](max(floor+1, ⌈line⌉, ⌊pool⌋−2, ⌈R⌉)) — each term, and R', () => {
  const t = (o: Partial<Parameters<typeof middayReserveTargetPct>[0]>) =>
    middayReserveTargetPct({ floorPct: 16, linePct: 31.13, expectedPoolPct: 30, resiliencePct: 44.2, ...o });
  assert.deepEqual(t({}), { pct: 45, basis: 'resilience' }, 'R below the envelope sets it');
  assert.deepEqual(t({ resiliencePct: null }), { pct: 32, basis: 'line' }, 'without R: the line');
  assert.deepEqual(t({ resiliencePct: 68.3 }), { pct: 50, basis: 'resilience' }, 'R above 50: the envelope maximum');
  assert.deepEqual(t({ expectedPoolPct: 47.9, resiliencePct: 40 }), { pct: 45, basis: 'pool' }, 'the pool held 2 points under where the window finds it');
  assert.deepEqual(t({ expectedPoolPct: null, resiliencePct: null }), { pct: 32, basis: 'line' }, 'no P50 basis: the pool term drops');
  assert.deepEqual(t({ floorPct: 40, linePct: 35, resiliencePct: null }), { pct: 41, basis: 'floor' }, 'a raise over the owner\'s floor');
  assert.deepEqual(t({ floorPct: 5, linePct: 7.2, expectedPoolPct: 8, resiliencePct: 3 }), { pct: 10, basis: 'line' }, 'the envelope minimum');
  assert.deepEqual(t({ resiliencePct: 31.13 }), { pct: 32, basis: 'line' }, 'a tie names the earlier term');
});

test('★★★ the engine writes T_mid on a mid-day leg: R (8 h of P90 drain over the line) sets it at 50', () => {
  const p = plan();
  assert.equal(p.chargeTonight, true);
  assert.equal(p.setpointSocPct, 50);
  assert.equal(p.reserveTargetBasis, 'resilience');
  assert.equal(p.expectedWriteLevelPct, forceChargeStopPct(p.costCeilingSocPct!), 'the force-charge carries the cost fill');
  assert.match(p.rationale, /buying cheap super off-peak energy/);
});

test('★★★ T_mid without R would drop the resilience lift: a light evening puts R under 50 and R still sets it', () => {
  // The evening after the window draws 0.5 kW (P50): the post-window trough needs only the line
  // plus 8 h × 0.675 kW (P90) ÷ 0.94 — R ≈ 37.5%, above the line and the pool term.
  const p = plan({ socNowPct: 30, postLoadW: 500 });
  const linePct = p.cushionLineSocPct!;
  const rPct = linePct + (8 * 0.5 * P90F / ETA / POOL) * 100;
  assert.equal(p.reserveTargetBasis, 'resilience');
  assert.equal(p.setpointSocPct, Math.ceil(rPct - 1e-6), `R ${rPct.toFixed(2)}%`);
  assert.ok(p.setpointSocPct! > Math.ceil(linePct) && p.setpointSocPct! < 50);
  assert.ok(p.setpointSocPct! > Math.floor(p.expectedStartSocPct!) - 2);
});

test('★★★ a protected light evening: floor+cushion holds with no buy, and T_mid still asks the resilience question (not the cost target)', () => {
  // The backup holds 50% to 05:00 and the evening after the window is light: the pack at the close
  // covers the line with no buy, so cost mode alone would make the cost target the ask (~90%).
  // A mid-day leg's reserve carries the resilience lift only: R ≈ 37.5%, and the pool term (the
  // pool expected at 10:00, less 2) is higher.
  const p = plan({ spec: middaySpec({ backupHold: { pct: 50, untilMs: BACKUP.endMs } }), postLoadW: 500 });
  assert.ok(p.cushionTroughSocPct! >= p.cushionLineSocPct!, 'floor+cushion holds with no buy');
  assert.equal(p.chargeTonight, true, 'the cost buy still goes ahead');
  assert.equal(p.reserveTargetBasis, 'pool');
  assert.equal(p.setpointSocPct, Math.floor(p.expectedStartSocPct!) - 2);
  assert.ok(p.setpointSocPct! < 50);
});

test('★★ the overnight leg keeps its own setpoint rule (no T_mid, no basis field)', () => {
  const p = plan({ spec: OVERNIGHT_WINDOW_SPEC });
  assert.equal('reserveTargetBasis' in p, false);
  assert.equal(p.window!.startMs, phx(10, 14, 23), 'the resolver\'s overnight window');
});

/* ══ the anchors ════════════════════════════════════════════════════════════ */

/** Independent: the islanded P10/P90 walk the planner sizes on, from `fromMs`'s hour to `toMs`,
 *  lifted to `hold` entering the first hour at/after `holdAt`. */
function islandedWalkPct(socPct: number, hours: NightChargeHour[], toMs: number, hold?: { pct: number; atMs: number }): number {
  let pack = (socPct / 100) * POOL;
  let lifted = false;
  for (const h of hours) {
    if (h.ts >= toMs) break;
    if (hold && !lifted && h.ts >= hold.atMs) { pack = Math.max(pack, (hold.pct / 100) * POOL); lifted = true; }
    pack = Math.max(0, Math.min(POOL, pack + (h.pvP10W - h.loadP90W / ETA) / 1000));
  }
  return Math.round((pack / POOL) * 1000) / 10;
}
/** Independent: the grid-present P50 walk from now (the in-progress hour at the next hour's
 *  figures), floored at the owner's reserve, and at the backup hold through the hours before its close. */
function expectedWalkPct(socPct: number, hours: NightChargeHour[], toMs: number, hold?: { pct: number; untilMs: number }): number {
  let pack = (socPct / 100) * POOL;
  const floor = Math.min(0.16 * POOL, pack);
  const byTs = new Map(hours.map((h) => [h.ts, h]));
  for (let slot = phx(10, 14, 21); slot < toMs; slot += H) {
    const w = (Math.min(slot + H, toMs) - Math.max(slot, NOW)) / H;
    const h = byTs.get(slot) ?? byTs.get(slot + H)!;
    const fl = hold && slot < hold.untilMs ? Math.max(floor, (hold.pct / 100) * POOL) : floor;
    pack = Math.max(fl, Math.min(POOL, pack + (w * ((h.pvP50W ?? 0) - (h.loadP50W ?? 0) / ETA)) / 1000));
  }
  return Math.round((pack / POOL) * 1000) / 10;
}

test('★★★ unarmed: 60% at 21:30 walks to ~26% at 10:00 islanded — under the line', () => {
  const p = plan();
  const hours = buildNightChargeInputs(deps()).horizon;
  assert.equal(p.projSocAtWindowStartPct, islandedWalkPct(60, hours, COST.startMs));
  assert.ok(p.projSocAtWindowStartPct! < p.cushionLineSocPct!, `${p.projSocAtWindowStartPct}% < ${p.cushionLineSocPct}%`);
  assert.ok(Math.abs(p.projSocAtWindowStartPct! - 26) < 3);
  assert.equal(p.expectedStartSocPct, expectedWalkPct(60, hours, COST.startMs));
});

test('★★★ armed: the worst case is max(walk, hold) at 05:00 and the expected pool is held until then', () => {
  const spec = middaySpec({ backupHold: { pct: 50, untilMs: BACKUP.endMs } });
  const p = plan({ spec });
  const unarmed = plan();
  const hours = buildNightChargeInputs(deps({ spec })).horizon;
  assert.equal(p.projSocAtWindowStartPct, islandedWalkPct(60, hours, COST.startMs, { pct: 50, atMs: BACKUP.endMs }));
  assert.ok(p.projSocAtWindowStartPct! > unarmed.projSocAtWindowStartPct! + 10, 'the backup protects the pool the cost leg is sized from');
  assert.equal(p.expectedStartSocPct, expectedWalkPct(60, hours, COST.startMs, { pct: 50, untilMs: BACKUP.endMs }));
  assert.ok(p.expectedStartSocPct! > unarmed.expectedStartSocPct!);
  // The worst case buys less from a protected pool.
  assert.ok(p.buyKwh! < unarmed.buyKwh! - 5, `${unarmed.buyKwh} → ${p.buyKwh}`);
  // A pool above the hold is not lowered by it.
  const high = plan({ spec, socNowPct: 95 });
  assert.equal(high.expectedStartSocPct, plan({ socNowPct: 95 }).expectedStartSocPct);
});

test('★★ a hold whose window has closed is history: a 06:00 recompute sizes on the pool as it is', () => {
  const spec = middaySpec({ backupHold: { pct: 50, untilMs: BACKUP.endMs } });
  const at6 = { nowMs: phx(10, 15, 6), bandHours: band(1).filter((h) => h.ts >= phx(10, 15, 6)) };
  const withHold = computeNightChargePlan(buildNightChargeInputs({ ...deps({ spec, socNowPct: 30 }), ...at6 }));
  const without = computeNightChargePlan(buildNightChargeInputs({ ...deps({ socNowPct: 30 }), ...at6 }));
  assert.equal(withHold.projSocAtWindowStartPct, without.projSocAtWindowStartPct);
  assert.equal(withHold.expectedStartSocPct, without.expectedStartSocPct);
  assert.equal(withHold.buyKwh, without.buyKwh);
});

/* ══ C_mid ═════════════════════════════════════════════════════════════════ */

test('★★★ C_mid = min(costMax, taper − 100·S50/full): the sun after 15:00 fills to the taper, not past it', () => {
  // chgMaxSoc 100 ⇒ taper 90; S50 0.5 kWh ⇒ 90 − 0.54 = 89.46%.
  const p = plan();
  assert.equal(p.costCeilingBasis, 'pv-curtail');
  assert.equal(p.costCeilingSocPct, 89.5);
  assert.match(p.rationale, /solar headroom under the 90% charge taper/);
  // A Core ceiling of 80 ⇒ taper 70.
  const lowCeiling = plan({ spec: middaySpec({ curtailFromPct: saturationThresholdPct(80) }) });
  assert.equal(lowCeiling.costCeilingSocPct, 69.5);
  assert.equal(lowCeiling.costCeilingBasis, 'pv-curtail');
  // The owner's ceiling binds below the taper.
  const owner = plan({ over: { costMaxSocPct: 70 } });
  assert.equal(owner.costCeilingSocPct, 70);
  assert.equal(owner.costCeilingBasis, 'max-soc');
});

test('★★ costCeilingKwh: the taper form, and the overnight form unchanged', () => {
  assert.deepEqual(costCeilingKwh({ fullKwh: 100, morningPvSurplusKwh: 5, maxSocPct: 90, curtailFromPct: 90 }), { ceilingKwh: 85, basis: 'pv-curtail' });
  assert.deepEqual(costCeilingKwh({ fullKwh: 100, morningPvSurplusKwh: null, maxSocPct: 95, curtailFromPct: 90 }), { ceilingKwh: 90, basis: 'pv-curtail' }, 'no surplus known: the taper');
  assert.deepEqual(costCeilingKwh({ fullKwh: 100, morningPvSurplusKwh: 5, maxSocPct: 60, curtailFromPct: 90 }), { ceilingKwh: 60, basis: 'max-soc' });
  assert.deepEqual(costCeilingKwh({ fullKwh: 100, morningPvSurplusKwh: 5, maxSocPct: 90 }), { ceilingKwh: 90, basis: 'max-soc' });
  assert.deepEqual(costCeilingKwh({ fullKwh: 100, morningPvSurplusKwh: 15, maxSocPct: 90 }), { ceilingKwh: 85, basis: 'pv-headroom' });
  assert.deepEqual(costCeilingKwh({ fullKwh: 100, morningPvSurplusKwh: 15, maxSocPct: 90, curtailFromPct: null }), { ceilingKwh: 85, basis: 'pv-headroom' });
});

/* ══ the PV terms ═══════════════════════════════════════════════════════════ */

test('★★★ gridGainKw: the packs take PV and grid together up to their acceptance; no PV ⇒ the rate itself', () => {
  assert.equal(gridGainKw(13.76, 0, 16.5), 13.76);
  assert.equal(gridGainKw(13.76, 6276, 16.5), 16.5 - 6.276);
  assert.equal(gridGainKw(5, 6276, 16.5), 5, 'the rate binds first');
  assert.equal(gridGainKw(13.76, 20_000, 16.5), 0, 'the sun alone fills the acceptance');
  assert.equal(gridGainKw(13.76, 6276, null), 13.76, 'no acceptance bound');
});

test('★★★ the window\'s deliverable lift is bounded by the acceptance less the P10 PV (default chargeCap × legEff)', () => {
  // A 7.2 kW charger under a 6 kW sun: the default acceptance is 7.2 × 0.927 = 6.67 kW, so the
  // grid adds at most ~0.4–6.7 kW an hour. The cost target (89.5%) from a drained pool is bound by it.
  const small = plan({ socNowPct: 20, over: { chargeCapKw: 7.2 } });
  const open = plan({ socNowPct: 20, spec: middaySpec({ packAcceptKw: 1e6 }), over: { chargeCapKw: 7.2 } });
  const hours = buildNightChargeInputs(deps({ socNowPct: 20 })).horizon.filter((h) => h.ts >= COST.startMs && h.ts < COST.endMs);
  const accept = 7.2 * LEG;
  const gain = hours.reduce((a, h) => a + gridGainKw(Math.max(0, Math.min(7.2, 17 - h.loadP90W / 1000)) * LEG, h.pvP10W, accept), 0);
  assert.equal(small.bindingCap, 'chargePower');
  // The acceptance bound is not EV contention: the disclosed derate is the grid input's alone
  // (a 7.2 kW charger under a 17 kW input has none).
  assert.equal(small.evContention!.derateKwh, 0);
  assert.ok(Math.abs(small.buyKwh! - Math.round((gain / LEG) * 100) / 100) <= 0.01, `${small.buyKwh} vs ${(gain / LEG).toFixed(2)}`);
  assert.ok(open.buyKwh! > small.buyKwh! + 10, 'without the bound the grid would be credited the sun\'s share');
});

test('★★ expectedWindowLiftKwh takes the acceptance bound on the median PV', () => {
  const hours: NightChargeHour[] = [
    { ts: phx(10, 15, 10), pvP10W: 4000, loadP90W: 3000, loadP50W: 2000, pvP50W: 6000 },
    { ts: phx(10, 15, 11), pvP10W: 0, loadP90W: 3000, loadP50W: 2000, pvP50W: 0 },
  ];
  const base = { hours, fromMs: phx(10, 15, 10), windowEndMs: phx(10, 15, 12), chargeCapKw: 17.8, envelopeKw: 17, legEff: LEG };
  assert.equal(expectedWindowLiftKwh(base), 2 * 15 * LEG);
  assert.equal(expectedWindowLiftKwh({ ...base, acceptKw: 16 }), (16 - 6) + 15 * LEG);
});

/**
 * An INDEPENDENT minute-by-minute model of the mid-day write: below the 50% reserve the grid
 * charges at the live rate ((17 kW − the house) × 0.927, at most the acceptance less the PV) and
 * the P50 PV goes into the pack on top, the house on the grid; at or above it the house runs from
 * the pool (PV − load ÷ 0.94), held at the reserve; the force-charge switches on once, when the
 * clock reaches the live tick's own forceChargeStartAtMs (PV-blind, as it runs today), and charges
 * the same way to forceChargeStopPct(90). Its grid draw ÷ 0.927 is the night's buy.
 */
function oracleBuy(scale: number, openPct: number, acceptKw: number | null): { buyKwh: number; onAtMs: number | null } {
  const end = COST.endMs;
  const stop = forceChargeStopPct(90);
  let pack = (openPct / 100) * POOL, grid = 0, on = false, onAtMs: number | null = null;
  for (let t = COST.startMs; t < end; t += 60_000) {
    const h = phxHour(t), p = pvW(h, scale) / 1000, l = loadW(h) / 1000, dt = 1 / 60;
    const rate = (17 - l) * LEG;
    const poolPct = (pack / POOL) * 100;
    if (onAtMs == null && poolPct < stop && t < end - FORCE_CHARGE_MIN_RUN_MS && t >= forceChargeStartAtMs(end, 90, poolPct, POOL, rate, 0)) { on = true; onAtMs = t; }
    if (on || pack < 0.5 * POOL) {
      const target = on ? (stop / 100) * POOL : 0.5 * POOL;
      const g = acceptKw == null || p <= 0 ? rate : Math.min(rate, Math.max(0, acceptKw - p));
      pack += Math.min(p * dt, Math.max(0, target - pack));
      const add = Math.min(g * dt, Math.max(0, target - pack));
      pack += add;
      grid += add / LEG;
      if (on && pack >= target - 1e-9) on = false;
    } else {
      pack = Math.max(0.5 * POOL, Math.min(POOL, pack + (p - l / ETA) * dt));
    }
  }
  return { buyKwh: Math.round(grid * 100) / 100, onAtMs };
}
/** The engine's expected buy for the same write from `openPct` at 10:00. */
function engineBuy(scale: number, openPct: number, acceptKw: number | null) {
  const hours = buildNightChargeInputs(deps({ scale })).horizon;
  const w = { hours, fromMs: COST.startMs, windowEndMs: COST.endMs, chargeCapKw: 17.8, envelopeKw: 17, acceptKw };
  return expectedBuyFromPlan({
    setpointSocPct: 50, costCeilingSocPct: 90, forceChargeEligible: true, startKwh: (openPct / 100) * POOL,
    deliverableKwh: expectedWindowLiftKwh({ ...w, legEff: LEG }), fullKwh: POOL, legEff: LEG,
    window: { ...w, dischargeEff: ETA },
  });
}

test('★★★ the expected buy credits the P50 PV: from 29.9% it is ~35.9 kWh sunny, ~49.8 cloudy (47.8 PV-blind before R2)', () => {
  const sunny = engineBuy(1, 29.9, null);
  const cloudy = engineBuy(0.4, 29.9, null);
  assert.equal(sunny.buyKwh, 35.88);
  assert.equal(cloudy.buyKwh, 49.83);
  // With the default acceptance (chargeCap × legEff = 16.5 kW) the grid shares it with the sun.
  assert.equal(engineBuy(1, 29.9, 17.8 * LEG).buyKwh, 33.65);
  // The force-charge times itself as the live tick does (PV-blind): the sun moved the pool, so it starts later.
  assert.equal(sunny.forceChargeStartMs, phx(10, 15, 12, 23));
  assert.equal(cloudy.forceChargeStartMs, phx(10, 15, 12, 0));
});

test('★★★ the expected buy is what an independent minute model of the write draws (open, default and tight acceptance)', () => {
  for (const scale of [1, 0.7, 0.4, 0]) {
    for (const open of [29.9, 50, 70]) {
      for (const accept of [null, 17.8 * LEG, 12]) {
        const e = engineBuy(scale, open, accept);
        const o = oracleBuy(scale, open, accept);
        const label = `sun ×${scale}, open ${open}%, acceptance ${accept ?? 'open'}`;
        assert.equal(e.forceChargeStartMs ?? null, o.onAtMs, label);
        if (e.deliverableBound) continue;
        // Where the force-charge cannot finish under a tight acceptance the engine states the higher
        // figure (the grid is taken to supply what the sun does not); elsewhere it is the model's.
        const finishes = Math.abs(e.buyKwh! - o.buyKwh) < 0.011;
        assert.ok(finishes || (accept === 12 && e.buyKwh! > o.buyKwh), `${label}: engine ${e.buyKwh} vs model ${o.buyKwh}`);
      }
    }
  }
});

test('★★ expectedPvChargeWalk: the sun\'s share of a lift and when it completes; none with no sun', () => {
  const hours = buildNightChargeInputs(deps({ scale: 1 })).horizon;
  const w = { hours, windowEndMs: COST.endMs, chargeCapKw: 17.8, envelopeKw: 17, legEff: LEG, acceptKw: null };
  const r = expectedPvChargeWalk({ ...w, liftKwh: 18.43, fromMs: COST.startMs });
  // 10:00: 6.28 kW of sun beside (17 − 2.16) × 0.927 = 13.76 kW of grid: ~55 min.
  assert.ok(r.creditKwh > 5.5 && r.creditKwh < 6.2, String(r.creditKwh));
  assert.equal(r.doneMs, phx(10, 15, 10, 56));
  const dark = buildNightChargeInputs(deps({ scale: 0 })).horizon;
  assert.deepEqual(expectedPvChargeWalk({ ...w, hours: dark, liftKwh: 18.43, fromMs: COST.startMs }).creditKwh, 0);
  assert.deepEqual(expectedPvChargeWalk({ ...w, liftKwh: 0, fromMs: COST.startMs }), { creditKwh: 0, doneMs: COST.startMs });
  // A minute with no P50 basis credits nothing at all.
  const holed = hours.map((h) => (h.ts === phx(10, 15, 10) ? { ...h, loadP50W: null } : h));
  assert.equal(expectedPvChargeWalk({ ...w, hours: holed, liftKwh: 18.43, fromMs: COST.startMs }).creditKwh, 0);
});

/* ══ the leg ═══════════════════════════════════════════════════════════════ */

test('★★★ a backup leg is resilience-only and never force-charges, whatever the configuration says', () => {
  const spec: WindowSpec = { kind: 'overnight', role: 'backup', window: { startMs: BACKUP.startMs, endMs: BACKUP.endMs } };
  const inputs = buildNightChargeInputs(deps({ socNowPct: 30, spec }));
  assert.equal(inputs.objectiveMode, 'resilience');
  assert.equal(inputs.forceChargeEligible, false);
  const p = computeNightChargePlan(inputs);
  assert.notEqual(p.objective, 'cost_arbitrage');
  assert.equal(p.costCeilingSocPct ?? null, null);
  assert.equal(p.expectedWriteLevelPct, p.chargeTonight ? Math.min(50, Math.round(p.setpointSocPct!)) : null, 'the reserve alone');
  assert.equal(p.expectedForceChargeStartMs, undefined, 'no force-charge leg');
  // The cost leg of the same cycle keeps the configuration.
  const cost = buildNightChargeInputs(deps({ socNowPct: 30 }));
  assert.equal(cost.objectiveMode, 'cost');
  assert.equal(cost.forceChargeEligible, true);
});

test('★★ the leg\'s window is the one the chooser pinned; a pinned null is no window', () => {
  const p = plan();
  assert.deepEqual(p.window, { startMs: COST.startMs, endMs: COST.endMs }, 'not the overnight window the resolver would find');
  const none = plan({ spec: middaySpec({ window: null }) });
  assert.equal(none.chargeTonight, false);
  assert.match(none.rationale, /no valid cheap charge window/);
});

/* ══ R4 — the backup leg: one walk ═════════════════════════════════════════ */

/** A backup leg on its window, its walk to `horizonMs` (option A: Thursday 23:00; option B: the 10:00 open). */
function backupPlan(socNowPct: number, horizonMs: number, role: 'backup' | 'cost' = 'backup'): NightChargePlan {
  const spec: WindowSpec = { kind: 'overnight', role, window: { startMs: BACKUP.startMs, endMs: BACKUP.endMs } };
  return computeNightChargePlan(buildNightChargeInputs(deps({
    socNowPct, spec, over: { nextRechargeMs: horizonMs, objectiveMode: 'resilience', forceChargeEligible: false },
  })));
}

test('★★★ R4 — the backup leg arms on the walk its setpoint is solved on: to the next overnight open (option A), against reserve + cushion', () => {
  const A = phx(10, 15, 23);
  for (const soc of [30, 45, 60, 80, 90, 98]) {
    const p = backupPlan(soc, A);
    // One walk: the no-buy trough of the walk (baselineMinSocPct, the whole-house islanded walk to the
    // horizon) under the line is exactly when the leg charges.
    assert.equal(p.chargeTonight, p.baselineMinSocPct! < p.cushionLineSocPct!, `${soc}%: trough ${p.baselineMinSocPct} vs line ${p.cushionLineSocPct}`);
    if (p.chargeTonight) {
      // …and the lift it is sized on brings that same walk's trough to the line (or as near as the window allows).
      assert.ok(p.cushionTroughSocPct! >= p.cushionLineSocPct! - 0.01 || p.cushionShortfall, `${soc}%`);
      assert.ok(p.setpointSocPct! > 50, `${soc}%: the walk to 23:00 asks for more than the panel takes (${p.setpointSocPct}%)`);
    }
  }
  // At 80% the pool still clears the line at 05:00 — the cost leg's own test would hold — but the
  // walk to 23:00 does not: the backup arms, and writes 50.
  const cost80 = backupPlan(80, A, 'cost');
  const backup80 = backupPlan(80, A);
  assert.equal(cost80.chargeTonight, false, 'the pack at the close covers the line');
  assert.equal(backup80.chargeTonight, true, 'the walk to the next overnight open does not');
  assert.equal(Math.min(50, Math.round(backup80.setpointSocPct!)), 50);
  assert.match(backup80.rationale, /Charge|buy/i);
  const held = backupPlan(98, A);
  assert.match(held.rationale, held.chargeTonight ? /./ : /^Hold — projected overnight trough/);
});

test('★★ R4 — option B (the walk ends at the 10:00 open) arms less often than option A', () => {
  const A = phx(10, 15, 23);
  const B = COST.startMs;
  const a90 = backupPlan(90, A);
  const b90 = backupPlan(90, B);
  assert.equal(a90.chargeTonight, true);
  assert.equal(b90.chargeTonight, false, 'from 90% the pool reaches 10:00 above the line');
  for (const soc of [30, 50, 60, 70, 80, 90]) {
    assert.ok(!backupPlan(soc, B).chargeTonight || backupPlan(soc, A).chargeTonight, `${soc}%: B arms only where A does`);
  }
});

/* ══ the re-entry hold (plan §3.3), and arming on the worst case ═══════════════════════════════ */

test('★★★ re-entry hold: a mid-day write that takes the pool only under floor + 25 holds — the panel would hold the pool into on-peak', () => {
  assert.equal(MIDDAY_REENTRY_MARGIN_PCT, 25);
  // No force-charge riding, a light day: T_mid is 38%, under the 41% line (16 + 25).
  const light = plan({ socNowPct: 30, postLoadW: 500, over: { forceChargeEligible: false } });
  assert.equal(light.chargeTonight, false);
  assert.deepEqual(light.middayReentryHold, { arrivalPct: 38, linePct: 41 });
  assert.equal(light.objective, 'none');
  assert.equal(light.expectedBuyKwh, 0, 'a hold arms nothing');
  assert.match(light.rationale, /^Hold — the mid-day charge's write takes the pool only to ~38%, under the 41% re-entry line \(the 16% reserve \+ 25\)/);
  // A higher owner floor raises the line: the 50% write is under 55%.
  const floor30 = plan({ socNowPct: 30, over: { forceChargeEligible: false, reserveFloorPct: 30 } });
  assert.deepEqual(floor30.middayReentryHold, { arrivalPct: 50, linePct: 55 });
  // The cost fill to C_mid clears the line: no hold.
  const full = plan({ socNowPct: 30 });
  assert.equal(full.chargeTonight, true);
  assert.equal(full.middayReentryHold, undefined);
  assert.ok((full.expectedWriteLevelPct ?? 0) >= 41);
  // A 50% write against the 16% floor clears the 41% line.
  const fifty = plan({ socNowPct: 60, over: { forceChargeEligible: false } });
  assert.equal(fifty.chargeTonight, true);
  assert.equal(fifty.middayReentryHold, undefined);
  // Not the backup leg, and not an overnight plan.
  const backup = plan({ socNowPct: 30, postLoadW: 500, spec: { kind: 'overnight', role: 'backup', window: { startMs: BACKUP.startMs, endMs: BACKUP.endMs } }, over: { forceChargeEligible: false } });
  assert.equal(backup.middayReentryHold, undefined);
  const night = plan({ socNowPct: 30, postLoadW: 500, spec: OVERNIGHT_WINDOW_SPEC, over: { forceChargeEligible: false } });
  assert.equal(night.middayReentryHold, undefined);
  // The test itself.
  assert.equal(middayReentryLinePct(38, 16), 41);
  assert.equal(middayReentryLinePct(41, 16), null, 'at the line: it resumes');
  assert.equal(middayReentryLinePct(89.5, 16), null);
  assert.equal(middayReentryLinePct(null, 16), null);
  assert.equal(middayReentryLinePct(Number.NaN, 16), null);
});

test('★★★ a P50 hold with a P10 requirement still arms: the leg arms on the worst case, not on the expected figure', () => {
  // The pool opens the window above T_mid on the median (no charge expected), but the islanded
  // worst case still needs a buy: the leg charges, and armCycle arms it.
  const p = plan({ socNowPct: 80, over: { forceChargeEligible: false } });
  assert.equal(p.chargeTonight, true);
  assert.equal(p.expectedBuyKwh, 0, 'P50: no charge expected');
  assert.ok((p.buyKwh ?? 0) > 1, `P10: ${p.buyKwh} kWh of worst case`);
  assert.equal(p.middayReentryHold, undefined);
  const r = armCycle(emptyCycle(), '2026-10-14', [{ role: 'cost', kind: 'super_off_peak', plan: p, forceChargeEnabled: false }], NOW, 16);
  assert.ok(r.cycle, `it arms (${r.refused[0]?.reason ?? ''})`);
  assert.equal(r.cycle!.active.targetPct, 50);
  assert.equal(r.cycle!.active.buyKwh, p.buyKwh, 'armed on the worst case it is sized on');
});
