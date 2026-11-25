import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shadowPvBasis, shadowPvPlannerDeps, shadowDaylightRefusalText, pvBasisReasonText, bandCoverageRefusalText,
  type ShadowPvBasisInput, type ShadowPvBasis, type PvBasisReason,
} from '../src/panelPvSelection.js';
import type { UcVerdict, UcChecks } from '../src/panelPvBasis.js';
import { unfittedDaylightHourTs } from '../src/analytics.js';
import { buildNightChargeInputs, computeNightChargePlan, type NightChargeInputDeps, type NightForecastHour } from '../src/nightChargeAdvisor.js';
import { nextChargeableOpenMs } from '../src/chargeWindows.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';
import { armCycle, emptyCycle } from '../src/chargeCycle.js';
import { pvSurplusFromBand } from '../src/chargeTaper.js';
import { siteHour, fmtSiteClock } from '../src/siteTime.js';
import {
  runMiddayShadowEvening, shadowCycleConfig, windowP50Kwh, middayShadowLedgerColumns, coerceMiddayShadowRecord, panelPvBasisNote,
  type MiddayShadowRecord, type ShadowLegSizing, type ShadowSized, type ShadowArmCandidate, type ShadowArmVerdict,
} from '../src/middayShadow.js';

/**
 * ★★★ v1.210.0 — THE MID-DAY SHADOW SIZES ON ITS OWN SOLAR SELECTION (panelPvSelection.shadowPvBasis), opted into by the shadow's
 * sizer alone. With the house Cores dark, the published band has no scored days and every shadow leg was refused; the overnight plan
 * of the same evenings ran on the panel-measured band. Each shadow leg now selects as the evening job's own call does (no latch), on
 * the install's write mode, never the live night's cancel, under one rule of its own (the daylight rule). Nothing of the live plan
 * moves: its selection, latch, holder, snapshot and row are the lines of v1.209.1 (source pins below; index.ts is not importable).
 *
 * The fixture is middayShadow.test.ts's: Wednesday 2026-10-14 21:30 for Thursday 10-15 10:00–15:00, planned by the real engine.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const SEL_SRC = readFileSync(resolve(HERE, '../src/panelPvSelection.ts'), 'utf8');
const H = 3_600_000;
const POOL = 92.16;
const MODEL = buildApsREvModel();
const periodIdAt = (ts: number): string => rateAt(MODEL, ts).periodId;
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const phxHour = (ts: number): number => (new Date(ts).getUTCHours() + 17) % 24;
const NOW = phx(10, 14, 21, 30);
const E = '2026-10-14';
const CFG = shadowCycleConfig('cost', 90);
const KEYS = ['P#1', 'P#2', 'P#3'];
/** The evidence rows' own words: the published band with the Cores dark. */
const ZERO_WORDS = 'only 0 scored calibration day(s), need 4 (a provisional plan on a widened solar band from 4; the full band from 14)';

/* ── the selection's inputs ──────────────────────────────────────────────────────────────────────────────────────────────── */

const checks: UcChecks = {
  asOfDay: E, threshold: 1.05, ratio: 0.9997, balanceDaylightRatio: 0.9781, nightResidualKwhPerNight: -1.13, max7: 0.9997,
  blindBandPct: 5, fieldDays: 8, newestFieldDay: '2026-10-13', fieldSlots: [1, 2, 3],
  constants: { 1: { days: 51, chargeHours: 97 }, 2: { days: 51, chargeHours: 96 }, 3: { days: 51, chargeHours: 95 } },
  vendorDaysPresent: 14, vendorMaxDiffKwh: 0.17, nightMaxW: 0, frozenHours: 0,
};
const PANEL3 = [{ slot: 1, source: 'panel' }, { slot: 2, source: 'panel' }, { slot: 3, source: 'panel' }] as UcVerdict['sources'];
const verdict = (state: UcVerdict['state'], reason: UcVerdict['reason'] = null, o: { asOfDay?: string; sources?: UcVerdict['sources'] } = {}): UcVerdict => ({
  asOfDay: o.asOfDay ?? E, state, ok: state !== 'refused', reason, sources: o.sources ?? PANEL3, basis: 'panel', checks,
});
const PASS_GATE = { basisComplete: true, basisBlockedBy: null, transient: false };
const ZERO_DAYS = { basisComplete: false, basisBlockedBy: ZERO_WORDS, transient: true };
const BALANCE: PvBasisReason = { code: 'balance', windowEnd: '2026-10-13', ratio: 1.041, daylightRatio: 1.0312, nightResidualKwhPerNight: -1.13, threshold: 1.04 };
/** The planning band's 24 hours, from the next whole hour (getDayForecast's layout). */
const BAND_TS = Array.from({ length: 24 }, (_, k) => phx(10, 14, 22) + k * H);
const COST_WIN = { startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) };
const COST_HORIZON = phx(10, 15, 23);
const inp = (o: Partial<ShadowPvBasisInput> = {}): ShadowPvBasisInput => ({
  asOfDay: E, writeMode: true, panelFresh: true,
  published: { gate: ZERO_DAYS, uncoveredSlots: [1, 2, 3] },
  planning: { asOfDay: E, keys: KEYS, verdict: verdict('pass'), gate: PASS_GATE },
  planningRollupOk: true, connectedKeys: KEYS, ratioKnown: true,
  bandHourTs: BAND_TS, unfittedDaylightTs: [],
  fromMs: NOW, toMs: COST_HORIZON, clockHourOf: siteHour, clockText: fmtSiteClock, enrich: (r) => r,
  ...o,
});
const SIZED_ON_PANEL: ShadowPvBasis = { use: 'planning', asOfDay: E, bandCoverageRefusedBy: null, panelBasisRefusal: null };
const refusedBy = (words: string, m2: string | null = null): ShadowPvBasis => ({ use: 'published', asOfDay: E, bandCoverageRefusedBy: m2, panelBasisRefusal: words });

/* ── the real engine, as index.ts sizes a shadow leg ─────────────────────────────────────────────────────────────────────── */

const P50_W = [0, 94, 608, 2647, 4725, 6276, 6635, 6695, 6243, 5274, 3938, 2057, 573, 21];
const LOAD_W = [2188, 1864, 1646, 2068, 1851, 2158, 2202, 2927, 3228, 4020, 3435, 3738, 3205, 2978];
const houseKw = (h: number): number => (h >= 21 || h < 0 ? 2.8 : h < 5 ? 2.2 : h < 17 ? 2.6 : 3.4);
const loadW = (h: number): number => (h >= 5 && h <= 18 ? LOAD_W[h - 5] : houseKw(h) * 1000);
const pvW = (h: number): number => (h >= 5 && h <= 18 ? P50_W[h - 5] : 0);

/** The deps of a shadow leg, on a band with `calScoredDays` scored days (0: the published band with the Cores dark; 27: the panel's). */
function deps(sz: ShadowLegSizing, calScoredDays: number): NightChargeInputDeps {
  const hours: NightForecastHour[] = [];
  for (let ts = Math.floor(NOW / H) * H; ts < phx(10, 15, 23); ts += H) {
    const h = phxHour(ts);
    // The published band with the Cores dark reads no sun (the evidence rows' window PV is 0).
    const pv = calScoredDays > 0 ? pvW(h) : 0;
    hours.push({ ts, pvP10W: pv * 0.8, loadP90W: loadW(h) * 1.35, embeddedEvW: 0, loadP50W: loadW(h), pvP50W: pv });
  }
  const loads = new Map(hours.map((x) => [x.ts, x.loadP50W ?? 0]));
  const s = pvSurplusFromBand({
    hours: hours.map((x) => ({ ts: x.ts, p50W: x.pvP50W ?? 0, p90W: (x.pvP50W ?? 0) * 1.3 })),
    loadAt: (ts) => loads.get(ts), fromMs: sz.spec.window!.endMs, toMs: sz.surplusEndMs,
  });
  return {
    nowMs: NOW, fullKwh: POOL, socNowPct: 60, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.62, outageCushionHours: 4, islandedLoadSafety: 1.25, objectiveMode: 'cost', costMaxSocPct: 90,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 17.8, gridInputCapKw: 17,
    periodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: hours, dayRollups: [], realizedDailyErrHalfFrac: calScoredDays >= 14 ? 0.1 : 0, nextRechargeMs: sz.nextRechargeMs,
    ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 }, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays, minCalScoredDays: 14, provisionalMinCalScoredDays: 4,
    bandCoverageFrac: calScoredDays > 0 ? 0.85 : 0,
    morningPvSurplusP90Kwh: s.p90Kwh, morningPvSurplusP50Kwh: s.p50Kwh, longGapAhead: false, prePeakPvSurplusP10Kwh: null,
    minBuyKwh: 1, buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: sz.spec.role === 'cost', cushionOnlyEligible: false, windowSpec: sz.spec,
  };
}

/** index.ts sizeShadowLeg on the real engine: the leg's selection overrides the deps (shadowPvPlannerDeps), the band follows it,
 *  and a leg on the panel band carries its E. */
function sizer(select: (sz: ShadowLegSizing) => ShadowPvBasis | null, calls: Array<ShadowPvBasis | null> = []) {
  return async (sz: ShadowLegSizing): Promise<ShadowSized> => {
    const sel = select(sz);
    calls.push(sel);
    const d = { ...deps(sz, sel?.use === 'planning' ? 27 : 0), ...shadowPvPlannerDeps(sel) };
    const plan = computeNightChargePlan(buildNightChargeInputs(d));
    return { plan, ...windowP50Kwh(d.bandHours, sz.spec.window!), ...(sel?.use === 'planning' ? { panelPvAsOfDay: sel.asOfDay } : {}) };
  };
}
const probe = (cands: ShadowArmCandidate[]): ShadowArmVerdict => {
  const r = armCycle(emptyCycle(), E, cands.map((c) => ({ role: c.role, kind: c.kind, plan: c.plan, forceChargeEnabled: c.role === 'cost' })), NOW, 16);
  return { armed: r.legs.map((l) => l.leg), refused: r.refused };
};
async function evening(select: (sz: ShadowLegSizing) => ShadowPvBasis | null): Promise<MiddayShadowRecord> {
  const rec = await runMiddayShadowEvening({
    nowMs: NOW, day: E, model: MODEL, cfg: CFG, mode: 'supervised', chgMaxSocPcts: [100, 100, null], sizeLeg: sizer(select), armProbe: probe,
  });
  assert.notEqual(rec, 'panelStale');
  return rec as MiddayShadowRecord;
}
const SIZED_COLS = ['shadow_backup_setpoint_pct', 'shadow_backup_buy_kwh', 'shadow_cost_reserve_pct', 'shadow_cost_level_pct',
  'shadow_cost_buy_kwh', 'shadow_cost_expected_buy_kwh', 'shadow_cost_expected_start_soc_pct'] as const;

/* ══ the selection ══════════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ the Cores dark, the panel basis passing: each leg is sized on the panel-measured band as of the evening, and no refusal reaches the planner', () => {
  const s = shadowPvBasis(inp());
  assert.deepEqual(s, SIZED_ON_PANEL);
  assert.deepEqual(shadowPvPlannerDeps(s), { bandCoverageRefusedBy: null, panelBasisRefusal: null });
  // The install's write mode decides, whatever the leg: a backup leg in a write mode is never "advisory" (writeMode is no role input).
  assert.doesNotMatch(JSON.stringify(shadowPvBasis(inp({ toMs: phx(10, 15, 10) }))), /advisory/);
});

test('★★★ a refused panel basis is said in the leg\'s own words, and the leg sizes nothing: the mode, the panel, the verdict, G7, G8, the band\'s gate', () => {
  const cases: Array<[Partial<ShadowPvBasisInput>, PvBasisReason]> = [
    [{ writeMode: false }, { code: 'advisory' }],
    [{ panelFresh: false }, { code: 'stale-panel' }],
    [{ planning: { asOfDay: E, keys: KEYS, verdict: verdict('refused', BALANCE as UcVerdict['reason']), gate: PASS_GATE } }, BALANCE],
    [{ planning: { asOfDay: E, keys: KEYS, verdict: verdict('pass', null, { sources: [...PANEL3.slice(0, 2), { slot: 3, source: 'none' }] as UcVerdict['sources'] }), gate: PASS_GATE } }, { code: 'slot-unresolved', slot: 3 }],
    [{ ratioKnown: false }, { code: 'no-capacity-ratio' }],
    [{ planning: { asOfDay: E, keys: KEYS, verdict: verdict('pass'), gate: { basisComplete: false, basisBlockedBy: 'band coverage 70% < 78%', transient: false } } }, { code: 'band', blockedBy: 'band coverage 70% < 78%' }],
  ];
  for (const [o, reason] of cases) assert.deepEqual(shadowPvBasis(inp(o)), refusedBy(pvBasisReasonText(reason)), reason.code);
  // G4 — a night reading is completed by the main thread (the hour's clock, the add-on's force-charge in it), as on the live plan.
  const night = { code: 'night-reading', slot: 2, day: '2026-10-12', hourStartMs: phx(10, 12, 1), w: 31.5, acInWh: 1800, lastHeldDay: '2026-10-19' } as unknown as PvBasisReason;
  const enriched = { ...night, hourClock: '1:00 AM', forceCharge: 'on' } as PvBasisReason;
  const s = shadowPvBasis(inp({ planning: { asOfDay: E, keys: KEYS, verdict: verdict('refused', night as UcVerdict['reason']), gate: PASS_GATE }, enrich: () => enriched }));
  assert.equal(s?.panelBasisRefusal, pvBasisReasonText(enriched));
  assert.match(s!.panelBasisRefusal!, /at 1:00 AM .*force-charge was on/);
});

test('★★★ the row says so and sizes nothing: the balance refusal lands in shadow_arm_disposition after the gate\'s own words, every sized figure NULL', async () => {
  const words = pvBasisReasonText(BALANCE);
  const rec = await evening(() => refusedBy(words));
  const cols = middayShadowLedgerColumns(rec);
  const leg = `not armed — the plan basis is incomplete (${ZERO_WORDS}; the panel's own solar readings are not used: ${words})`;
  assert.equal(cols.shadow_arm_disposition, `backup: ${leg}; cost: ${leg}`);
  for (const k of SIZED_COLS) assert.equal(cols[k], null, k);
  assert.equal(cols.shadow_cost_arms, 0);
  assert.equal(rec.cost!.panelPvAsOfDay, undefined, 'no basis is claimed for a refused leg');
});

test('★★★ unknown equals today: the transient class, (a) and no selection leave the shadow exactly as v1.209.1 — the evidence rows\' words, nothing added', async () => {
  const transient: Array<Partial<ShadowPvBasisInput>> = [
    { planning: null },
    { planning: { asOfDay: '2026-10-13', keys: KEYS, verdict: verdict('pass'), gate: PASS_GATE } },
    { planning: { asOfDay: E, keys: ['P#1', 'P#2'], verdict: verdict('pass'), gate: PASS_GATE } },
    { planningRollupOk: false },
    { planning: { asOfDay: E, keys: KEYS, verdict: verdict('refused', null), gate: PASS_GATE } },
    { planning: { asOfDay: E, keys: KEYS, verdict: verdict('pass'), gate: { basisComplete: false, basisBlockedBy: 'x', transient: true } } },
    // M2 is the selection's: a transient in the mixed state applies none (the published band passed without covering slot 2).
    { planning: null, published: { gate: PASS_GATE, uncoveredSlots: [2] } },
    // (a): the Cores' band passes and covers every connected slot.
    { published: { gate: PASS_GATE, uncoveredSlots: [] } },
  ];
  for (const o of transient) assert.equal(shadowPvBasis(inp(o)), null, JSON.stringify(o));
  assert.deepEqual(shadowPvPlannerDeps(null), {});
  // The row: no selection gives the live evidence rows' disposition, to the letter.
  const rec = await evening(() => null);
  const leg = `not armed — the plan basis is incomplete (${ZERO_WORDS})`;
  assert.equal(middayShadowLedgerColumns(rec).shadow_arm_disposition, `backup: ${leg}; cost: ${leg}`);
  assert.equal(panelPvBasisNote(undefined), '');
  // A live call's deps: the trailing spread adds nothing, so the plan is the plan without it.
  const sz = { spec: { kind: 'overnight' as const, role: 'cost' as const, window: { startMs: phx(10, 14, 23), endMs: phx(10, 15, 5) } }, nextRechargeMs: nextChargeableOpenMs(MODEL, phx(10, 15, 6)), surplusEndMs: phx(10, 15, 19) };
  const live = deps(sz, 27);
  assert.deepEqual(computeNightChargePlan(buildNightChargeInputs({ ...live, ...shadowPvPlannerDeps(null) })), computeNightChargePlan(buildNightChargeInputs(live)));
});

test('★★★ M2 on a shadow leg: the Cores\' band passed without covering slot 2 and the panel refused — refused with the coverage words first, as the live plan', () => {
  const pub = { gate: PASS_GATE, uncoveredSlots: [2] };
  const bal = { asOfDay: E, keys: KEYS, verdict: verdict('refused', BALANCE as UcVerdict['reason']), gate: PASS_GATE };
  const s = shadowPvBasis(inp({ published: pub, planning: bal }));
  assert.deepEqual(s, refusedBy(pvBasisReasonText(BALANCE), bandCoverageRefusalText([2])));
  // And where the daylight rule refuses the panel band in that state.
  const d = shadowPvBasis(inp({ published: pub, unfittedDaylightTs: [phx(10, 15, 12)] }));
  assert.equal(d?.bandCoverageRefusedBy, bandCoverageRefusalText([2]));
  const sz = { spec: { kind: 'super_off_peak' as const, role: 'cost' as const, window: COST_WIN }, nextRechargeMs: COST_HORIZON, surplusEndMs: phx(10, 15, 16) };
  const plan = computeNightChargePlan(buildNightChargeInputs({ ...deps(sz, 27), ...shadowPvPlannerDeps(s) }));
  assert.equal(plan.basisComplete, false);
  assert.equal(plan.basisBlockedBy, `${bandCoverageRefusalText([2])}; the panel's own solar readings are not used: ${pvBasisReasonText(BALANCE)}`);
});

/* ══ the daylight rule (constraint 4) ═══════════════════════════════════════════════════════════════════════════════════ */

test('★★★ daylight: an hour is a fitted solar figure only where it is modelled; the typical-day fallback with the sun possibly up is not', () => {
  const h = (ts: number, modelled: boolean, ghiWm2: number | null) => ({ ts, modelled, ghiWm2 });
  assert.deepEqual(unfittedDaylightHourTs([h(1, true, 600), h(2, true, null), h(3, false, 0), h(4, false, 20), h(5, false, 21), h(6, false, null)]), [5, 6]);
  // The band the shadow reads is the planning layer's own 24 hours, each on the slope of its clock hour (the code, as read).
  const an = readFileSync(resolve(HERE, '../src/analytics.ts'), 'utf8');
  const plan = an.slice(an.indexOf('export async function getPlanningForecast('), an.indexOf('export function planningDayForecast('));
  assert.ok(plan.includes('fc.hours.forEach((fh, k) => {'));
  assert.ok(plan.includes('const resp = model.hourly[clock];\n      const { pv, modelled } = forecastHourPvW(resp, ghi, cloud, curve[clock], clearnessHist);'));
  assert.ok(an.includes('  for (let k = 0; k < 24; k++) {\n    const ts = startHour + k * 3_600_000;'), 'the day forecast: 24 hours from the next whole hour');
  assert.ok(an.includes('if (resp.coeff != null && ghi != null) {'), 'modelled: a fitted slope and a GHI');
  const rep = readFileSync(resolve(HERE, '../src/reports.ts'), 'utf8');
  assert.ok(rep.includes('      planningUnfittedDaylightTs: unfittedDaylightHourTs(p.planningHours),\n'));
});

test('★★★ daylight: a leg is sized on the panel band only when no hour its walks read, from the plan instant to its horizon end, is an unfitted daylight hour or one the band lacks', () => {
  const at = (h: number, d = 15) => phx(10, d, h);
  const refused = (ms: number, missing = false) => refusedBy(shadowDaylightRefusalText({ atText: fmtSiteClock(ms), missing }));
  // In the window, after it, and before it (the morning that sets the pool at the open): refused, naming the hour.
  for (const ms of [at(11), at(16), at(8)]) assert.deepEqual(shadowPvBasis(inp({ unfittedDaylightTs: [ms] })), refused(ms), fmtSiteClock(ms));
  // A clock hour the band lacks: refused, said as such.
  assert.deepEqual(shadowPvBasis(inp({ bandHourTs: BAND_TS.filter((ts) => ts !== at(13)) })), refused(at(13), true));
  // A report that does not say: never sized on the panel band, and nothing said (unknown equals today: the shadow as before).
  assert.equal(shadowPvBasis(inp({ unfittedDaylightTs: null })), null);
  // Hours outside the leg's span do not count: option B's walk ends at the window open (10:00), so 10:00 and 16:00 are not its.
  assert.deepEqual(shadowPvBasis(inp({ toMs: at(10), unfittedDaylightTs: [at(10), at(16)] })), SIZED_ON_PANEL);
  // Beyond the 24-hour band (to 23:00) an hour is judged by the band hour of its clock hour (22:00 the evening before).
  assert.deepEqual(shadowPvBasis(inp({ fromMs: at(9), unfittedDaylightTs: [at(22, 14)] })), refused(at(22)));
  // The words name the leg's refusal, and the row carries them with nothing sized.
  assert.match(shadowDaylightRefusalText({ atText: '4:00 PM', missing: false }), /^the panel-measured band has no fitted solar response for the daylight hour from 4:00 PM$/);
});

/* ══ the record and the row ═════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ the row says which band sized each leg: a leg on the panel band names it and the evening; the record keeps it across a restart; still shadow_* columns only', async () => {
  const rec = await evening(() => SIZED_ON_PANEL);
  assert.equal(rec.backup!.panelPvAsOfDay, E);
  assert.equal(rec.cost!.panelPvAsOfDay, E);
  assert.equal(rec.backupB!.panelPvAsOfDay, E);
  assert.equal(rec.cost!.basisComplete, true, 'the leg is sized');
  const cols = middayShadowLedgerColumns(rec);
  const note = ` (on the panel-measured planning band as of ${E})`;
  assert.equal(cols.shadow_arm_disposition, `backup: ${rec.backup!.disposition}${note}; cost: ${rec.cost!.disposition}${note}; backup option B:${note}`);
  assert.ok(cols.shadow_cost_buy_kwh != null && cols.shadow_cost_expected_start_soc_pct != null, 'real figures');
  assert.ok((cols.shadow_window_pv_p50_kwh ?? 0) > 0, 'the window PV is the panel band\'s');
  for (const k of Object.keys(cols)) assert.match(k, /^shadow_/);
  const back = coerceMiddayShadowRecord(JSON.parse(JSON.stringify(rec)));
  assert.deepEqual(back, rec);
  const bad = JSON.parse(JSON.stringify(rec));
  bad.cost.panelPvAsOfDay = 'yesterday';
  assert.equal(coerceMiddayShadowRecord(bad)!.cost!.panelPvAsOfDay, undefined, 'a malformed day is no basis');
  // A record from before v1.210.0 (no field) reads, and its row is as before.
  delete bad.cost.panelPvAsOfDay; delete bad.backup.panelPvAsOfDay; delete bad.backupB.panelPvAsOfDay;
  const old = coerceMiddayShadowRecord(bad)!;
  assert.equal(middayShadowLedgerColumns(old).shadow_arm_disposition, `backup: ${old.backup!.disposition}; cost: ${old.cost!.disposition}`);
});

/* ══ index.ts (source pins: it starts a server and is not importable) ═══════════════════════════════════════════════════ */

const FN = INDEX.slice(INDEX.indexOf('async function recomputeNightChargePlan('), INDEX.indexOf('function armedExpectedBuyKwh('));

test('★★★ index.ts: the live plan\'s selection, latch, admission memory, decoration, log, holder, snapshot and row are the lines of v1.209.1, each null or unreached on a shadow leg', () => {
  for (const line of [
    '  const pvLatchHere = shadowLeg || window == null ? null : latchedPvBasis({',
    '  const pvAsOfDay: string | null = shadowLeg ? null : planAsOfDay({',
    '  const pvAsk = pvAsOfDay != null && pvWriteMode && panel.fresh && !pvCancelled;',
    '  const pvSel: PvSelection | null = shadowLeg ? null : selectPvBasis({',
    '    latched: opts.arming === true ? null : pvLatchHere,',
    "  if (pvSel?.use === 'keep-previous') {\n    if (getLatestNightChargePlan() == null) seedPlanFromSnapshot(window?.startMs ?? null);\n    return 'panelStale';\n  }",
    '  notePanelAdmission(probPlanning, pvAsOfDay, nowMs);',
    '    if (pvSel == null || pvAsOfDay == null) return;',
    '  if (pvSel != null) logPvBasisOnChange(pvSel, pvReason, pvAsOfDay!, plan);',
    '    ...(pvSel != null && pvAsOfDay != null ? { pvSelection: pvSelectionExtras(pvSel, pvReason, pvAsOfDay) } : {}),',
    '    bandCoverageRefusedBy: pvSel?.bandCoverageRefusedBy ?? null,',
    '    panelBasisRefusal: pvReason != null && !pvPlanning ? pvBasisReasonText(pvReason) : null,',
    '    cushionOnlyEligible: shadowLeg == null && lineForceChargeOn(legRole) && panel.fresh,',
    '  if (!shadowLeg) setLatestNightChargePlan(',
    '  if (!shadowLeg) pushLineNotArmedIfDue(getLatestNightChargePlan(), lineClosed, nowMs);',
    '  if (!shadowLeg && plan.window && nowMs < plan.window.startMs) {',
    "      ? analytics.report<PlanningProbabilisticReport | null>('planningProbabilisticForecast', { asOfDay: pvAsOfDay! }).catch(() => null)",
  ]) assert.equal(FN.split(line).length - 1, 1, line);
  // The admission memory takes no report without the live E (null on a shadow leg, whose reports these slots then hold).
  assert.match(INDEX, /function notePanelAdmission\(r: PlanningProbabilisticReport \| null, asOfDay: string \| null, nowMs: number\): void \{\n\s+if \(r == null \|\| asOfDay == null \|\|/);
  // One live selection; the latch is read in one place, behind the shadowLeg guard.
  assert.equal(FN.split('selectPvBasis(').length - 1, 1);
  assert.equal(FN.split('readNightChargeLatch()').length - 1, 4, 'the four reads of pvLatchHere only');
  // The evening job never sees a shadow result, nor its basis.
  const job = INDEX.slice(INDEX.indexOf('async function runNightChargeEveningJobInner('), INDEX.indexOf('\n}\n', INDEX.indexOf('async function runNightChargeEveningJobInner(')));
  assert.doesNotMatch(job, /shadowPv|shadowPanelPvAsOfDay/);
});

test('★★★ index.ts: the shadow\'s own selection is opted into by the shadow\'s sizer alone — never a live plan, never the live morning refresh — and every new term is null without it', () => {
  assert.equal(INDEX.split('shadowPvBasis: true').length - 1, 1);
  const size = INDEX.slice(INDEX.indexOf('async function sizeShadowLeg('), INDEX.indexOf('\n}\n', INDEX.indexOf('async function sizeShadowLeg(')));
  assert.ok(size.includes('  const r = await recomputeNightChargePlan({ allowStalePanel, shadowLeg: sizing, shadowPvBasis: true });'));
  assert.ok(size.includes('    ...(r.extras.shadowPanelPvAsOfDay != null ? { panelPvAsOfDay: r.extras.shadowPanelPvAsOfDay } : {}),'));
  const refresh = INDEX.slice(INDEX.indexOf('async function runMorningRefreshTickInner('), INDEX.indexOf('\n}\n', INDEX.indexOf('async function runMorningRefreshTickInner(')));
  assert.ok(refresh.includes('const r = await recomputeNightChargePlan({ shadowLeg: sizing, maxWeatherAgeMs: REFRESH_MAX_WEATHER_AGE_MS });'));
  // E only with a shadow leg AND the option; the ask, the selection, the band, the deps and the extras all follow from it.
  assert.ok(FN.includes('  const shadowPvAsOfDay: string | null = shadowLeg != null && opts.shadowPvBasis === true && window != null\n    ? planDateOwningCycle({ nowMs, firstLegStartMs: window.startMs, timezone: siteTimeZone(), notifyMinuteOfDay: nightSched.notify.fireMin }) : null;'));
  assert.ok(FN.includes("  const shadowPvWriteMode = lineForceChargeOn('cost');"), 'the install\'s mode, never the leg\'s role');
  assert.ok(FN.includes('  const shadowPvAsk = shadowPvAsOfDay != null && shadowPvWriteMode && panel.fresh;'));
  assert.ok(FN.includes("      : shadowPvAsk\n        ? analytics.report<PlanningProbabilisticReport | null>('planningProbabilisticForecast', { asOfDay: shadowPvAsOfDay! }).catch(() => null)\n        : Promise.resolve(null),"));
  assert.ok(FN.includes("      : shadowPvAsk\n        ? analytics.report<(MultiDayForecast & { basis?: string; asOfDay?: string }) | null>('multiDayForecast', { days: 4, basis: 'planning', asOfDay: shadowPvAsOfDay! }).catch(() => null)\n        : Promise.resolve(null),"));
  assert.ok(FN.includes('  const shadowPv: ShadowPvBasis | null = shadowPvAsOfDay == null ? null : shadowPvBasis({'));
  assert.ok(FN.includes('    planningRollupOk: multiDayPlanning != null && multiDayPlanning.asOfDay === shadowPvAsOfDay,'));
  assert.ok(FN.includes('    bandHourTs: (probPlanning?.hours ?? []).map((pb) => pb.ts),\n    unfittedDaylightTs: probPlanning?.planningUnfittedDaylightTs ?? null,\n    fromMs: nowMs, toMs: horizonEndMs, clockHourOf: siteHour, clockText: fmtSiteClock,'));
  assert.ok(FN.includes("    enrich: (r) => (r.code === 'night-reading' ? { ...r, hourClock: fmtSiteClock(r.hourStartMs), forceCharge: forceChargeStateAt(r.hourStartMs) } : r),"));
  assert.ok(FN.includes("  const pvPlanning = pvSel?.use === 'planning' || shadowPv?.use === 'planning';"));
  assert.ok(FN.includes("    windowSpec: shadowLeg ? shadowLeg.spec : legRole === 'cost' ? OVERNIGHT_WINDOW_SPEC : { kind: 'overnight', role: legRole },\n    // ★★★ v1.210.0 — a mid-day shadow leg's own refusal (M2 and why the panel's readings are not used); nothing on any other call.\n    ...shadowPvPlannerDeps(shadowPv),\n  };"));
  assert.ok(FN.includes("    ...(shadowPv?.use === 'planning' ? { shadowPanelPvAsOfDay: shadowPv.asOfDay } : {}),"));
  // The shadow's selection reads no latch and no live cancel.
  const fnSel = SEL_SRC.slice(SEL_SRC.indexOf('export function shadowPvBasis('), SEL_SRC.indexOf('export function shadowPvPlannerDeps('));
  assert.ok(fnSel.includes('    eligible: { writeMode: i.writeMode, panelFresh: i.panelFresh, cancelled: false },\n    latched: null,\n'));
});
