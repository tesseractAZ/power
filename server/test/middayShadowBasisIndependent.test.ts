import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shadowPvBasis, shadowPvPlannerDeps, selectPvBasis, pvBasisReasonText, bandCoverageRefusalText,
  type ShadowPvBasisInput, type ShadowPvBasis, type PvBasisReason, type BandGate,
} from '../src/panelPvSelection.js';
import type { UcVerdict, UcChecks } from '../src/panelPvBasis.js';
import { unfittedDaylightHourTs } from '../src/analytics.js';
import {
  buildNightChargeInputs, computeNightChargePlan, solarBasisGate, type NightChargeInputDeps, type NightForecastHour, type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { planDateOwningCycle } from '../src/chargeWindows.js';
import { pvSurplusFromBand } from '../src/chargeTaper.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';
import { siteHour, fmtSiteClock } from '../src/siteTime.js';
import {
  runMiddayShadowEvening, shadowCycleConfig, windowP50Kwh, middayShadowLedgerColumns, coerceMiddayShadowRecord, summariseLeg, refreshFromSized,
  type MiddayShadowRecord, type ShadowLegSizing, type ShadowSized, type ShadowArmCandidate, type ShadowArmVerdict,
} from '../src/middayShadow.js';

/**
 * v1.210.0 — THE MID-DAY SHADOW'S OWN SOLAR BASIS, checked from its contract rather than from its implementation's tests.
 *
 *  1. The live overnight plan is untouched: every line of its selection, latch, admission note, decoration, log and extras is the
 *     v1.209.1 text; no new term is evaluated with an effect on a live call; nothing the shadow computes reaches the live record.
 *  2. A shadow row says no more than it knows: a refused basis, a stale panel, a band with no figure or no fitted response for an
 *     hour the leg reads, a band for another evening each size nothing on the panel band, and the row says why.
 *  3. Unknown equals today: wherever the selection cannot be made, the shadow's output is exactly what it was before.
 *
 * index.ts is not importable (it starts the add-on), so its wiring is read as text; every pure part runs.
 * The fixture day is Wednesday 2026-10-14 21:30 (site clock) for the Thursday 10:00-15:00 window.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const ANALYTICS = readFileSync(resolve(HERE, '../src/analytics.ts'), 'utf8');
const REPORTS = readFileSync(resolve(HERE, '../src/reports.ts'), 'utf8');
const SHADOW_SRC = readFileSync(resolve(HERE, '../src/middayShadow.ts'), 'utf8');

/** The text of a top-level function, from its header to the next top-level function. */
function fnText(src: string, header: string): string {
  const a = src.indexOf(header);
  assert.ok(a >= 0, `found: ${header}`);
  const rest = src.slice(a + header.length);
  const m = rest.search(/\n(?:export )?(?:async )?function /);
  return src.slice(a, m < 0 ? src.length : a + header.length + m);
}
const count = (s: string, needle: string): number => s.split(needle).length - 1;

const FN = fnText(INDEX, 'async function recomputeNightChargePlan(');

const H = 3_600_000;
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const phxHour = (ts: number): number => (new Date(ts).getUTCHours() + 17) % 24;
const clock = (ts: number): string => {
  const h = phxHour(ts);
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
};
const E = '2026-10-14';
const NOW = phx(10, 14, 21, 31);
const HORIZON_END = phx(10, 15, 23);
const KEYS = ['P#1', 'P#2', 'P#3'];

/* ══ 1. the live plan untouched (index.ts as text) ═══════════════════════════════════════════════════════════════════════ */

test('★★★ the live selection keeps every v1.209.1 line: latch, E, mode, cancel, ask, selection, keep-previous, admission, reason', () => {
  const lines = [
    '  const pvLatchHere = shadowLeg || window == null ? null : latchedPvBasis({',
    '  const pvAsOfDay: string | null = shadowLeg ? null : planAsOfDay({',
    '  const pvWriteMode = lineForceChargeOn(legRole);',
    '  const pvCancelled = nightActuationMem.cancelled === true && window != null && nightActuationMem.windowStartMs === window.startMs;',
    '  const pvAsk = pvAsOfDay != null && pvWriteMode && panel.fresh && !pvCancelled;',
    "      ? analytics.report<PlanningProbabilisticReport | null>('planningProbabilisticForecast', { asOfDay: pvAsOfDay! }).catch(() => null)",
    "      ? analytics.report<(MultiDayForecast & { basis?: string; asOfDay?: string }) | null>('multiDayForecast', { days: 4, basis: 'planning', asOfDay: pvAsOfDay! }).catch(() => null)",
    '  notePanelAdmission(probPlanning, pvAsOfDay, nowMs);',
    '  const pvSel: PvSelection | null = shadowLeg ? null : selectPvBasis({',
    '    eligible: { writeMode: pvWriteMode, panelFresh: panel.fresh, cancelled: pvCancelled },',
    '    latched: opts.arming === true ? null : pvLatchHere,',
    '    planningRollupOk: multiDayPlanning != null && multiDayPlanning.asOfDay === pvAsOfDay,',
    "  if (pvSel?.use === 'keep-previous') {\n    if (getLatestNightChargePlan() == null) seedPlanFromSnapshot(window?.startMs ?? null);\n    return 'panelStale';\n  }",
    "  const pvReason: PvBasisReason | null = pvSel?.reason == null ? null : pvSel.reason.code === 'night-reading'",
    '    if (pvSel == null || pvAsOfDay == null) return;',
    '  if (pvSel != null) logPvBasisOnChange(pvSel, pvReason, pvAsOfDay!, plan);',
    '    ...(pvSel != null && pvAsOfDay != null ? { pvSelection: pvSelectionExtras(pvSel, pvReason, pvAsOfDay) } : {}),',
    '    bandCoverageRefusedBy: pvSel?.bandCoverageRefusedBy ?? null,',
    '    panelBasisRefusal: pvReason != null && !pvPlanning ? pvBasisReasonText(pvReason) : null,',
    '    cushionOnlyEligible: shadowLeg == null && lineForceChargeOn(legRole) && panel.fresh,',
    '  if (!shadowLeg) setLatestNightChargePlan(',
    '  if (!shadowLeg && plan.window && nowMs < plan.window.startMs) {',
  ];
  for (const l of lines) assert.equal(count(FN, l), 1, `the live line stands once: ${l.trim().slice(0, 90)}`);
  // The latch is read only to build the live latch: four reads, all before the live E (none in the shadow's lines).
  assert.equal(count(FN, 'readNightChargeLatch('), 4);
  const lastRead = FN.lastIndexOf('readNightChargeLatch(');
  assert.ok(lastRead < FN.indexOf('  const pvAsOfDay: string | null = shadowLeg ? null : planAsOfDay({'));
  // The latch is written nowhere in the function (the evening job and the no-arm push own those writes).
  assert.equal(count(FN, 'writeNightChargeLatch('), 0);
  // On a shadow call probPlanning may now hold the shadow's report: the admission memory still takes nothing without the live E.
  assert.ok(fnText(INDEX, 'function notePanelAdmission(').includes(
    '  if (r == null || asOfDay == null || r.asOfDay !== asOfDay || r.planningAdmittedSlotDays == null) return;'));
});

test('★★★ the shadow\'s new lines read no latch, no armed record, no live cancel or mode, and write nothing', () => {
  const head = FN.slice(FN.indexOf('const shadowPvAsOfDay'), FN.indexOf('// Live analytics reports'));
  const sel = FN.slice(FN.indexOf('const shadowPv: ShadowPvBasis'), FN.indexOf('const pvPlanning ='));
  assert.ok(head.length > 0 && sel.length > 0, 'both shadow blocks found');
  const forbidden = [
    'readNightChargeLatch', 'writeNightChargeLatch', 'nightActuationMem', 'pvCancelled', 'pvWriteMode', 'pvLatchHere', 'pvSel',
    'pvAsOfDay', 'opts.arming', 'legRole', 'setLatestNightChargePlan', 'seedPlanFromSnapshot', 'lastLogged', 'app.log',
    'atomicWriteFileSync', 'notePanelAdmission', 'panelAdmissionMem', 'persist', 'sendNotification',
  ];
  for (const f of forbidden) {
    assert.ok(!head.includes(f), `the shadow's E and ask do not touch ${f}`);
    assert.ok(!sel.includes(f), `the shadow's selection does not touch ${f}`);
  }
  // Its E: only with a shadow leg, the sizer's opt-in and a window; its mode the install's (the cost term), never the leg role's.
  assert.ok(head.includes('shadowLeg != null && opts.shadowPvBasis === true && window != null'));
  assert.ok(head.includes("const shadowPvWriteMode = lineForceChargeOn('cost');"));
  assert.ok(head.includes('const shadowPvAsk = shadowPvAsOfDay != null && shadowPvWriteMode && panel.fresh;'));
  // Its selection runs only with its own E (null on every live call), after the live selection's keep-previous return.
  assert.ok(sel.startsWith('const shadowPv: ShadowPvBasis | null = shadowPvAsOfDay == null ? null : shadowPvBasis({'));
  assert.ok(sel.includes('planningRollupOk: multiDayPlanning != null && multiDayPlanning.asOfDay === shadowPvAsOfDay,'));
  // lineForceChargeOn, newly evaluated on every call, is a pure read of the configured mode.
  assert.ok(INDEX.includes("const lineForceChargeOn = (role: ChargeLegRole = 'cost'): boolean => legForceChargeEligible(role, lineForceChargeEnabled({ mode: NIGHT_CHARGE_MODE }));"));
});

test('★★★ evaluation order: admission note, keep-previous return, shadow selection, then the band choice; the shadow reports only where the live ask is off', () => {
  const at = (s: string): number => { const i = FN.indexOf(s); assert.ok(i >= 0, `found: ${s.slice(0, 70)}`); return i; };
  const iNote = at('notePanelAdmission(probPlanning, pvAsOfDay, nowMs);');
  const iKeep = at("if (pvSel?.use === 'keep-previous') {");
  const iShadow = at('const shadowPv: ShadowPvBasis | null = shadowPvAsOfDay == null ? null : shadowPvBasis({');
  const iPlanning = at("const pvPlanning = pvSel?.use === 'planning' || shadowPv?.use === 'planning';");
  const iProb = at('const prob: ProbabilisticForecast | null = pvPlanning ? probPlanning : probPublished;');
  assert.ok(iNote < iKeep && iKeep < iShadow && iShadow < iPlanning && iPlanning < iProb);
  // The identifier shadowPv appears nowhere before its own selection (no early read).
  const firstUse = FN.search(/\bshadowPv\b/);
  assert.equal(firstUse, FN.indexOf('shadowPv: ShadowPvBasis'));
  // The two planning reports: the live ask first, verbatim; the shadow's only on its else branch, under the same report and the same
  // argument shapes (the same report key for the same E: no new cache entry beside the live one).
  assert.equal(count(FN, ": shadowPvAsk\n        ? analytics.report<PlanningProbabilisticReport | null>('planningProbabilisticForecast', { asOfDay: shadowPvAsOfDay! }).catch(() => null)\n        : Promise.resolve(null),"), 1);
  assert.equal(count(FN, ": shadowPvAsk\n        ? analytics.report<(MultiDayForecast & { basis?: string; asOfDay?: string }) | null>('multiDayForecast', { days: 4, basis: 'planning', asOfDay: shadowPvAsOfDay! }).catch(() => null)\n        : Promise.resolve(null),"), 1);
  // Six request texts of the four published reports (two with the weather-age option), and the two planning reports written twice
  // (the live ask, the shadow's): no other request.
  assert.equal(count(FN, 'analytics.report<'), 10);
  assert.equal(count(FN, "analytics.report<PlanningProbabilisticReport | null>('planningProbabilisticForecast'"), 2);
  assert.equal(count(FN, "('multiDayForecast', { days: 4, basis: 'planning'"), 2);
});

test('★★★ the planner deps: the shadow\'s refusal is the LAST entry (it overrides only on a shadow call) and is no key at all without one', () => {
  const a = FN.indexOf('const deps: NightChargeInputDeps = {');
  const b = FN.indexOf('\n  };', a);
  const deps = FN.slice(a, b);
  const iSpread = deps.indexOf('...shadowPvPlannerDeps(shadowPv),');
  assert.ok(iSpread > deps.indexOf('bandCoverageRefusedBy: pvSel?.bandCoverageRefusedBy ?? null,'));
  assert.ok(iSpread > deps.indexOf('panelBasisRefusal: pvReason != null && !pvPlanning ? pvBasisReasonText(pvReason) : null,'));
  assert.equal(deps.slice(iSpread + '...shadowPvPlannerDeps(shadowPv),'.length).trim(), '', 'nothing after it');
  assert.equal(count(INDEX, 'shadowPvPlannerDeps('), 1);
  // No own key, not even undefined: a spread of it can never overwrite a live value.
  assert.deepEqual(Object.keys(shadowPvPlannerDeps(null)), []);
  assert.deepEqual(Object.getOwnPropertyNames(shadowPvPlannerDeps(null)), []);
});

test('★★★ the opt-in is the shadow sizer\'s alone: the live arming call, ticks and the live morning refresh pass none', () => {
  assert.equal(count(INDEX, 'shadowPvBasis: true'), 1);
  assert.equal(count(INDEX, 'opts.shadowPvBasis'), 1);
  const sizer = fnText(INDEX, 'async function sizeShadowLeg(');
  assert.ok(sizer.includes('const r = await recomputeNightChargePlan({ allowStalePanel, shadowLeg: sizing, shadowPvBasis: true });'));
  assert.ok(INDEX.includes('const result = await recomputeNightChargePlan({ allowStalePanel: nowMin >= deferUntilMin, arming: true });'));
  assert.ok(INDEX.includes('const r = await recomputeNightChargePlan({ shadowLeg: sizing, maxWeatherAgeMs: REFRESH_MAX_WEATHER_AGE_MS });'));
  assert.equal(count(INDEX, 'recomputeNightChargePlan({'), 3, 'the arming call, the shadow sizer, the live morning refresh');
  assert.equal(count(INDEX, 'recomputeNightChargePlan()'), 2, 'the 30-minute tick and the warm-up');
  // The sizings the shadow builds (and the live morning refresh reuses) carry no opt-in of their own.
  assert.ok(!/shadowPvBasis\s*:/.test(SHADOW_SRC));
});

test('★★★ nothing the shadow selects reaches the live record: its extra is shadow-only and read by the shadow sizer alone', () => {
  assert.equal(count(FN, "...(shadowPv?.use === 'planning' ? { shadowPanelPvAsOfDay: shadowPv.asOfDay } : {}),"), 1);
  for (const header of [
    'async function runNightChargeEveningJobInner(', 'function recordNightPlanRow(', 'function pvLatchOf(', 'async function runMorningRefreshTickInner(',
    'function pvSelectionExtras(', 'function logPvBasisOnChange(',
  ]) {
    const t = fnText(INDEX, header);
    assert.ok(!t.includes('shadowPanelPvAsOfDay') && !/\bshadowPv\b/.test(t), `${header} reads nothing of the shadow's selection`);
  }
  const readers = INDEX.split('\n').filter((l) => l.includes('extras.shadowPanelPvAsOfDay'));
  assert.equal(readers.length, 1);
  assert.ok(fnText(INDEX, 'async function sizeShadowLeg(').includes(readers[0]));
});

test('★★ the worker field the shadow reads cannot fail the live plan\'s planning report: both layers carry their 24 hours', () => {
  // The report the live plan asks for now also computes unfittedDaylightHourTs(p.planningHours): the field is never absent.
  assert.ok(REPORTS.includes('planningUnfittedDaylightTs: unfittedDaylightHourTs(p.planningHours),'));
  assert.ok(ANALYTICS.includes('  planningHours: ForecastHour[];'));
  assert.ok(ANALYTICS.includes('planningHours: fc.hours,'), 'the identity layer');
  assert.ok(ANALYTICS.includes('planningHours: hours,'), 'the fitted layer');
  // The report's earlier fields come first and are unchanged (the field is appended).
  const i = REPORTS.indexOf('planningGeneratedAt: p.generatedAt,');
  assert.ok(i >= 0 && i < REPORTS.indexOf('planningUnfittedDaylightTs:'));
});

/* ══ 2. the daylight figures ═════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ an unfitted daylight hour: no fitted response while the sun may be up (GHI unknown or above 20 W/m2); never a modelled hour', () => {
  const hours = [
    { ts: 1, modelled: true, ghiWm2: 600 },
    { ts: 2, modelled: true, ghiWm2: null },
    { ts: 3, modelled: false, ghiWm2: 600 },
    { ts: 4, modelled: false, ghiWm2: null },
    { ts: 5, modelled: false, ghiWm2: 21 },
    { ts: 6, modelled: false, ghiWm2: 20 },
    { ts: 7, modelled: false, ghiWm2: 0 },
  ];
  const before = JSON.stringify(hours);
  assert.deepEqual(unfittedDaylightHourTs(hours), [3, 4, 5]);
  assert.equal(JSON.stringify(hours), before, 'its input is not touched');
  assert.deepEqual(unfittedDaylightHourTs([]), []);
});

/* ══ 3. the shadow's selection ═══════════════════════════════════════════════════════════════════════════════════════════ */

const CHECKS = { asOfDay: E, threshold: 1.05, ratio: 1.0 } as unknown as UcChecks;
const PANEL_SOURCES = KEYS.map((_, i) => ({ slot: i + 1, source: 'panel' })) as UcVerdict['sources'];
const verdictOf = (state: UcVerdict['state'], reason: UcVerdict['reason'] = null, asOfDay = E): UcVerdict => ({
  asOfDay, state, ok: state === 'pass', reason, sources: PANEL_SOURCES, basis: 'panel', checks: CHECKS,
});
const BALANCE: PvBasisReason = { code: 'balance', windowEnd: '2026-10-13', ratio: 1.0612, daylightRatio: 1.0301, nightResidualKwhPerNight: 0.42, threshold: 1.05 };
const GATE_PASS: BandGate = { basisComplete: true, basisBlockedBy: null, transient: false };
const GATE_ZERO: BandGate = { basisComplete: false, basisBlockedBy: 'only 0 scored calibration day(s), need 4', transient: false };
const GATE_TRANSIENT: BandGate = { basisComplete: false, basisBlockedBy: 'no forecast', transient: true };
/** The band of a 21:05 day forecast: 22:00 E to 21:00 E+1. */
const BAND_TS: number[] = Array.from({ length: 24 }, (_, k) => phx(10, 14, 22) + k * H);

function input(o: Partial<ShadowPvBasisInput> = {}): ShadowPvBasisInput {
  return {
    asOfDay: E, writeMode: true, panelFresh: true,
    // The Cores dark: the published band refused, not transient, and it covers no slot.
    published: { gate: GATE_ZERO, uncoveredSlots: [1, 2, 3] },
    planning: { asOfDay: E, keys: KEYS, verdict: verdictOf('pass'), gate: GATE_PASS },
    planningRollupOk: true, connectedKeys: KEYS, ratioKnown: true,
    bandHourTs: BAND_TS, unfittedDaylightTs: [],
    fromMs: NOW, toMs: HORIZON_END, clockHourOf: phxHour, clockText: clock,
    enrich: (r) => r,
    ...o,
  };
}
const refusedWith = (words: string, m2: string | null = null): ShadowPvBasis =>
  ({ use: 'published', asOfDay: E, bandCoverageRefusedBy: m2, panelBasisRefusal: words });

test('★★★ every check holds: the leg is sized on the panel band as of the evening that owns its window, and nothing is refused', () => {
  const s = shadowPvBasis(input());
  assert.deepEqual(s, { use: 'planning', asOfDay: E, bandCoverageRefusedBy: null, panelBasisRefusal: null });
  assert.deepEqual(shadowPvPlannerDeps(s), { bandCoverageRefusedBy: null, panelBasisRefusal: null });
});

test('★★★ a refused basis says why, in the live plan\'s words: the balance verdict, the panel band\'s own gate, no pack ratio, an unresolved slot', () => {
  assert.deepEqual(shadowPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: verdictOf('refused', BALANCE as UcVerdict['reason']), gate: GATE_PASS } })),
    refusedWith(pvBasisReasonText(BALANCE)));
  assert.match(pvBasisReasonText(BALANCE), /^the 7-day energy balance read 1\.0612 on the week to 2026-10-13, above 1\.05/);
  assert.deepEqual(shadowPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: verdictOf('pass'), gate: { basisComplete: false, basisBlockedBy: 'only 2 scored calibration day(s), need 4', transient: false } } })),
    refusedWith("on the panel's readings: only 2 scored calibration day(s), need 4"));
  assert.deepEqual(shadowPvBasis(input({ ratioKnown: false })), refusedWith(pvBasisReasonText({ code: 'no-capacity-ratio' })));
  const unresolved = { ...verdictOf('pass'), sources: [{ slot: 1, source: 'panel' }, { slot: 2, source: 'none' }, { slot: 3, source: 'panel' }] } as UcVerdict;
  assert.deepEqual(shadowPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: unresolved, gate: GATE_PASS } })),
    refusedWith(pvBasisReasonText({ code: 'slot-unresolved', slot: 2 })));
});

test('★★★ a stale panel, or advisory mode: refused and said so (no report is asked then, and the words are not the transient silence)', () => {
  assert.deepEqual(shadowPvBasis(input({ panelFresh: false, planning: null, planningRollupOk: false })),
    refusedWith("the panel's reading is stale (a plan on its readings needs a fresh one)"));
  assert.deepEqual(shadowPvBasis(input({ writeMode: false, planning: null, planningRollupOk: false })),
    refusedWith(pvBasisReasonText({ code: 'advisory' })));
});

test('★★★ the shadow never says the live night\'s cancel or latch, and never stalls on keep-previous, whatever the inputs', () => {
  const plannings: Array<ShadowPvBasisInput['planning']> = [
    null,
    { asOfDay: '2026-10-13', keys: KEYS, verdict: verdictOf('pass', null, '2026-10-13'), gate: GATE_PASS },
    { asOfDay: E, keys: KEYS, verdict: verdictOf('pass'), gate: GATE_PASS },
    { asOfDay: E, keys: KEYS, verdict: verdictOf('pass'), gate: GATE_TRANSIENT },
    { asOfDay: E, keys: KEYS, verdict: verdictOf('refused', BALANCE as UcVerdict['reason']), gate: GATE_PASS },
    { asOfDay: E, keys: KEYS, verdict: verdictOf('refused', null), gate: GATE_PASS },
    { asOfDay: E, keys: ['P#1', 'P#2'], verdict: verdictOf('pass'), gate: GATE_PASS },
    { asOfDay: E, keys: KEYS, verdict: verdictOf('pass', null, '2026-10-13'), gate: GATE_PASS },
  ];
  const publisheds: Array<ShadowPvBasisInput['published']> = [
    { gate: GATE_ZERO, uncoveredSlots: [1, 2, 3] }, { gate: GATE_PASS, uncoveredSlots: [] }, { gate: GATE_PASS, uncoveredSlots: [2] },
    { gate: GATE_TRANSIENT, uncoveredSlots: [] },
  ];
  const unfitteds: Array<number[] | null> = [[], [phx(10, 15, 12)], null];
  const forbidden = ["tonight's write was cancelled", pvBasisReasonText({ code: 'cancelled' })];
  let n = 0;
  for (const writeMode of [true, false]) for (const panelFresh of [true, false]) for (const planning of plannings)
    for (const planningRollupOk of [true, false]) for (const published of publisheds) for (const ratioKnown of [true, false])
      for (const unfittedDaylightTs of unfitteds) {
        const i = input({ writeMode, panelFresh, planning, planningRollupOk, published, ratioKnown, unfittedDaylightTs });
        const s = shadowPvBasis(i);
        n++;
        if (s == null) continue;
        assert.ok(s.use === 'published' || s.use === 'planning', 'never keep-previous');
        assert.equal(s.asOfDay, E);
        for (const f of forbidden) assert.ok(!(s.panelBasisRefusal ?? '').includes(f));
        // A refusal always carries words, and a use of the panel band carries none.
        if (s.use === 'published') assert.ok(typeof s.panelBasisRefusal === 'string' && s.panelBasisRefusal.length > 0);
        else assert.equal(s.panelBasisRefusal, null);
        // The Cores' band passing and covering every connected slot is v1.203.0's plan: nothing of the shadow's selection.
        assert.ok(!(published.gate.basisComplete && published.uncoveredSlots.length === 0));
      }
  assert.equal(n, 2 * 2 * plannings.length * 2 * publisheds.length * 2 * unfitteds.length);
});

test('★★★ a band with no figure for an hour the leg reads: refused, naming the first such hour (the window, or the morning before it)', () => {
  const noNoon = BAND_TS.filter((t) => phxHour(t) !== 12);
  assert.deepEqual(shadowPvBasis(input({ bandHourTs: noNoon })), refusedWith('the panel-measured band carries no figure for the hour from 12:00 PM'));
  assert.deepEqual(shadowPvBasis(input({ unfittedDaylightTs: [phx(10, 15, 11)] })),
    refusedWith('the panel-measured band has no fitted solar response for the daylight hour from 11:00 AM'));
  // The walk's order decides which hour is named: the 8:00 AM hour before the window comes first.
  assert.deepEqual(shadowPvBasis(input({ unfittedDaylightTs: [phx(10, 15, 13), phx(10, 15, 8)] })),
    refusedWith('the panel-measured band has no fitted solar response for the daylight hour from 8:00 AM'));
  // A report that does not list its unfitted hours is not taken as all fitted: the shadow as before (unknown equals today).
  assert.equal(shadowPvBasis(input({ unfittedDaylightTs: null })), null);
  // An empty band is refused, never sized on.
  assert.equal(shadowPvBasis(input({ bandHourTs: [] }))?.use, 'published');
});

test('★★ hours the leg does not read do not refuse it: before its plan instant, at or after its horizon end', () => {
  // The refresh's walk, 09:31 to 23:00 the same day (the horizon end exclusive), on the band as of the evening.
  const refresh = { fromMs: phx(10, 15, 9, 31), toMs: HORIZON_END };
  assert.equal(shadowPvBasis(input({ ...refresh, unfittedDaylightTs: [phx(10, 15, 8)] }))?.use, 'planning', 'the 8:00 AM hour is behind it');
  assert.equal(shadowPvBasis(input({ ...refresh, unfittedDaylightTs: [phx(10, 14, 23)] }))?.use, 'planning', 'the 11:00 PM hour starts at its end');
  assert.equal(shadowPvBasis(input({ ...refresh, unfittedDaylightTs: [phx(10, 14, 22)] }))?.use, 'published', 'the 10:00 PM hour is its last');
  assert.equal(shadowPvBasis(input({ ...refresh, unfittedDaylightTs: [phx(10, 15, 9)] }))?.use, 'published', 'the hour it starts in');
  // Option B's walk ends at the window's open: an unfitted hour inside the window does not refuse it.
  assert.equal(shadowPvBasis(input({ toMs: phx(10, 15, 10), unfittedDaylightTs: [phx(10, 15, 12)] }))?.use, 'planning');
});

test('★★★ M2: the Cores\' band passing without covering a connected slot, the panel band refused: the coverage words lead, on every refusal path', () => {
  const pubPartial = { gate: GATE_PASS, uncoveredSlots: [2] };
  const m2 = bandCoverageRefusalText([2]);
  assert.deepEqual(shadowPvBasis(input({ published: pubPartial, unfittedDaylightTs: [phx(10, 15, 11)] })),
    refusedWith('the panel-measured band has no fitted solar response for the daylight hour from 11:00 AM', m2));
  assert.deepEqual(shadowPvBasis(input({ published: pubPartial, planning: { asOfDay: E, keys: KEYS, verdict: verdictOf('refused', BALANCE as UcVerdict['reason']), gate: GATE_PASS } })),
    refusedWith(pvBasisReasonText(BALANCE), m2));
  // The Cores' band failing its own gate: no coverage words.
  assert.equal(shadowPvBasis(input({ unfittedDaylightTs: [phx(10, 15, 11)] }))?.bandCoverageRefusedBy, null);
});

test('★★ a night reading is completed by the main thread (its hour, the force-charge in it) before it is said; no other reason is', () => {
  const night: PvBasisReason = { code: 'night-reading', slot: 2, day: '2026-10-12', hourStartMs: phx(10, 12, 2), w: 31.4, acInWh: 1200, lastHeldDay: '2026-10-19' };
  const seen: PvBasisReason[] = [];
  const enrich = (r: PvBasisReason): PvBasisReason => { seen.push(r); return r.code === 'night-reading' ? { ...r, hourClock: '2:00 AM', forceCharge: 'off' } : r; };
  const s = shadowPvBasis(input({ enrich, planning: { asOfDay: E, keys: KEYS, verdict: verdictOf('refused', night as UcVerdict['reason']), gate: GATE_PASS } }));
  assert.equal(s?.panelBasisRefusal, pvBasisReasonText({ ...night, hourClock: '2:00 AM', forceCharge: 'off' } as PvBasisReason));
  assert.match(s!.panelBasisRefusal!, / at 2:00 AM on 2026-10-12 .*force-charge was off in that hour/);
  assert.equal(seen.length, 1);
  // A leg sized on the band, or a transient, enriches nothing.
  seen.length = 0;
  shadowPvBasis(input({ enrich }));
  shadowPvBasis(input({ enrich, planning: null }));
  assert.equal(seen.length, 0);
});

test('★★ on the site clock: the hour is judged and named in the site zone', () => {
  const s = shadowPvBasis(input({ clockHourOf: siteHour, clockText: fmtSiteClock, unfittedDaylightTs: [phx(10, 15, 14)] }));
  assert.equal(s?.panelBasisRefusal, 'the panel-measured band has no fitted solar response for the daylight hour from 2:00 PM');
  assert.equal(shadowPvBasis(input({ clockHourOf: siteHour, clockText: fmtSiteClock }))?.use, 'planning');
});

/* ══ 4. unknown equals today ═════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ unknown equals today: no report, another evening, another slot set, a refusal with no reason, a transient gate, the Cores\' band covering', () => {
  const cases: Array<[string, Partial<ShadowPvBasisInput>]> = [
    ['no report yet', { planning: null, planningRollupOk: false }],
    ['a report as of another evening', { planning: { asOfDay: '2026-10-13', keys: KEYS, verdict: verdictOf('pass', null, '2026-10-13'), gate: GATE_PASS } }],
    ['another slot set', { planning: { asOfDay: E, keys: ['P#1', 'P#3'], verdict: verdictOf('pass'), gate: GATE_PASS } }],
    ['a refused verdict with no reason', { planning: { asOfDay: E, keys: KEYS, verdict: verdictOf('refused', null), gate: GATE_PASS } }],
    ['no verdict', { planning: { asOfDay: E, keys: KEYS, verdict: null, gate: GATE_PASS } }],
    ['a transient planning gate', { planning: { asOfDay: E, keys: KEYS, verdict: verdictOf('pass'), gate: GATE_TRANSIENT } }],
    // (a), whatever the panel band would say: a refused verdict and an unfitted window hour change nothing.
    ['the Cores\' band covering', { published: { gate: GATE_PASS, uncoveredSlots: [] }, planning: { asOfDay: E, keys: KEYS, verdict: verdictOf('refused', BALANCE as UcVerdict['reason']), gate: GATE_PASS }, unfittedDaylightTs: [phx(10, 15, 12)] }],
    // The daylight rule unknown, every other check holding: no list of unfitted hours, or no span of hours to judge.
    ['a report that does not list its unfitted hours', { unfittedDaylightTs: null }],
    ['the M2 case with no list of unfitted hours', { published: { gate: GATE_PASS, uncoveredSlots: [2] }, unfittedDaylightTs: null }],
    ['a horizon end that is not a number', { toMs: Number.NaN }],
    ['a plan instant that is not a number', { fromMs: Number.NaN }],
    ['a horizon end at the plan instant', { toMs: NOW }],
    ['a horizon end before the plan instant', { toMs: NOW - 2 * H }],
  ];
  for (const [why, o] of cases) {
    assert.equal(shadowPvBasis(input(o)), null, why);
  }
  assert.deepEqual(shadowPvPlannerDeps(shadowPvBasis(input({ planning: null }))), {});
});

test('★★★ unknown equals today, beyond the listed cases: a rollup for another evening, a verdict for another evening inside a report as of E, and M2 with a transient', () => {
  assert.equal(shadowPvBasis(input({ planningRollupOk: false })), null, 'the planning rollup missing or as of another evening');
  assert.equal(shadowPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: verdictOf('pass', null, '2026-10-13'), gate: GATE_PASS } })), null,
    'the report says E, its verdict another evening');
  // The Cores' band passes without covering slot 2 and the panel band is not yet known: the shadow as before, so M2's words are NOT put
  // on it (selectPvBasis has them for the live plan; the shadow passes no deps at all).
  const pubPartial = { gate: GATE_PASS, uncoveredSlots: [2] };
  const live = selectPvBasis({
    asOfDay: E, eligible: { writeMode: true, panelFresh: true, cancelled: false }, latched: null, published: pubPartial,
    planning: null, planningRollupOk: false, connectedKeys: KEYS, ratioKnown: true,
  });
  assert.equal(live.bandCoverageRefusedBy, bandCoverageRefusalText([2]));
  assert.equal(shadowPvBasis(input({ published: pubPartial, planning: null, planningRollupOk: false })), null);
});

test('★★★ E for the shadow: the evening that owns the leg, at the evening and at the next morning\'s refresh (the live plan\'s E has moved on by then)', () => {
  const o = { timezone: 'America/Phoenix', notifyMinuteOfDay: 21 * 60 + 30 };
  assert.equal(planDateOwningCycle({ ...o, nowMs: phx(10, 14, 21, 31), firstLegStartMs: phx(10, 14, 23) }), E, 'the backup leg at the evening');
  assert.equal(planDateOwningCycle({ ...o, nowMs: phx(10, 14, 21, 31), firstLegStartMs: phx(10, 15, 10) }), E, 'the mid-day leg at the evening');
  assert.equal(planDateOwningCycle({ ...o, nowMs: phx(10, 15, 9, 31), firstLegStartMs: phx(10, 15, 10) }), E, 'the mid-day leg at the refresh');
  assert.equal(planDateOwningCycle({ ...o, nowMs: phx(10, 15, 9, 31), firstLegStartMs: phx(10, 15, 23) }), '2026-10-15', 'the live plan\'s window that morning');
});

/* ══ 5. the planner on the shadow's deps ═════════════════════════════════════════════════════════════════════════════════ */

const MODEL = buildApsREvModel();
const periodIdAt = (ts: number): string => rateAt(MODEL, ts).periodId;
const pvAt = (h: number): number => [0, 0, 0, 0, 0, 0, 40, 600, 2400, 4300, 5600, 6200, 6300, 6000, 5100, 3700, 1900, 500, 20, 0, 0, 0, 0, 0][h];
const loadAt = (h: number): number => (h >= 21 || h < 5 ? 2700 : h < 17 ? 2500 : 3300);

function bandFrom(fromMs: number): NightForecastHour[] {
  const out: NightForecastHour[] = [];
  for (let ts = Math.floor(fromMs / H) * H; ts < phx(10, 15, 23); ts += H) {
    const h = phxHour(ts);
    out.push({ ts, pvP10W: pvAt(h) * 0.8, loadP90W: loadAt(h) * 1.3, embeddedEvW: 0, loadP50W: loadAt(h), pvP50W: pvAt(h) });
  }
  return out;
}

/** A shadow leg's planner inputs, as index.ts builds them (no cushion-only on a shadow leg). */
function legDeps(sz: ShadowLegSizing, calScoredDays: number): NightChargeInputDeps {
  const hours = bandFrom(NOW);
  const loads = new Map(hours.map((x) => [x.ts, x.loadP50W ?? 0]));
  const winEnd = sz.spec.window!.endMs;
  const s = pvSurplusFromBand({
    hours: hours.map((x) => ({ ts: x.ts, p50W: x.pvP50W ?? 0, p90W: (x.pvP50W ?? 0) * 1.25 })),
    loadAt: (ts) => loads.get(ts), fromMs: winEnd, toMs: sz.surplusEndMs,
  });
  return {
    nowMs: NOW, fullKwh: 92.16, socNowPct: 55, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.5, outageCushionHours: 4, islandedLoadSafety: 1.25, objectiveMode: 'cost', costMaxSocPct: 90,
    legEff: 0.93, dischargeEff: 0.94, chargeCapKw: 17.8, gridInputCapKw: 17,
    periodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: hours, dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: sz.nextRechargeMs,
    ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 }, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays, minCalScoredDays: 14, provisionalMinCalScoredDays: 4, bandCoverageFrac: 0.85,
    morningPvSurplusP90Kwh: s.p90Kwh, morningPvSurplusP50Kwh: s.p50Kwh, longGapAhead: false, prePeakPvSurplusP10Kwh: null,
    minBuyKwh: 1, buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: sz.spec.role === 'cost',
    windowSpec: sz.spec,
  };
}
const planOf = (d: NightChargeInputDeps): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(d));
const CFG = shadowCycleConfig('cost', 90);

/** The evening, with each leg planned by the real engine on `sel`'s deps (index.ts: the trailing spread). */
async function evening(sel: ShadowPvBasis | null, calScoredDays: number): Promise<MiddayShadowRecord> {
  const r = await runMiddayShadowEvening({
    nowMs: NOW, day: E, model: MODEL, cfg: CFG, mode: 'supervised', chgMaxSocPcts: [100, 100, 100],
    sizeLeg: async (sz: ShadowLegSizing): Promise<ShadowSized> => {
      const d = { ...legDeps(sz, calScoredDays), ...shadowPvPlannerDeps(sel) };
      return {
        plan: planOf(d), ...windowP50Kwh(d.bandHours, sz.spec.window!),
        ...(sel?.use === 'planning' ? { panelPvAsOfDay: sel.asOfDay } : {}),
      };
    },
    armProbe: (cands: ShadowArmCandidate[]): ShadowArmVerdict => ({ armed: cands.map((c) => c.role), refused: [] }),
  });
  assert.notEqual(r, 'panelStale');
  return r as MiddayShadowRecord;
}

test('★★★ a refused shadow leg sizes nothing and its row says why, after the gate\'s own words; no basis is claimed for it', async () => {
  const words = pvBasisReasonText(BALANCE);
  const rec = await evening(refusedWith(words), 0);
  assert.equal(rec.why, 'midday');
  const gateWords = solarBasisGate({ forecastPresent: true, confidenceTier: 'forecast', calScoredDays: 0, minCalScoredDays: 14, provisionalMinCalScoredDays: 4, bandCoverageFrac: 0.85 }).basisBlockedBy;
  assert.ok(gateWords != null && gateWords.startsWith('only 0 scored calibration day(s)'));
  for (const leg of [rec.backup!, rec.cost!, rec.backupB!]) {
    assert.equal(leg.basisComplete, false);
    assert.equal(leg.chargeTonight, false);
    assert.equal(leg.basisBlockedBy, `${gateWords}; the panel's own solar readings are not used: ${words}`);
    assert.ok(!('panelPvAsOfDay' in leg));
  }
  const disp = middayShadowLedgerColumns(rec).shadow_arm_disposition!;
  assert.equal(disp, `backup: ${rec.backup!.disposition}; cost: ${rec.cost!.disposition}`);
  assert.equal(count(disp, `the panel's own solar readings are not used: ${words}`), 2);
  assert.ok(!disp.includes('(on the panel-measured planning band as of'));
});

test('★★★ M2 on the planner: the Cores\' band passing without covering a slot is refused with the coverage words first, and sizes nothing', () => {
  const sz: ShadowLegSizing = {
    spec: { kind: 'super_off_peak', role: 'cost', window: { startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) } },
    nextRechargeMs: HORIZON_END, surplusEndMs: phx(10, 15, 16),
  };
  const words = 'the panel-measured band has no fitted solar response for the daylight hour from 11:00 AM';
  const m2 = bandCoverageRefusalText([2]);
  const p = planOf({ ...legDeps(sz, 30), ...shadowPvPlannerDeps(refusedWith(words, m2)) });
  assert.equal(p.basisComplete, false);
  assert.equal(p.chargeTonight, false);
  assert.equal(p.basisBlockedBy, `${m2}; the panel's own solar readings are not used: ${words}`);
  assert.equal(p.cushionOnly ?? null, null, 'no cushion-only plan on a shadow leg');
});

test('★★★ sized on the panel band: the plan is the one the band sizes (the deps carry nothing else), and the row names the basis and its evening', async () => {
  const sel = shadowPvBasis(input())!;
  const sz: ShadowLegSizing = {
    spec: { kind: 'super_off_peak', role: 'cost', window: { startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) } },
    nextRechargeMs: HORIZON_END, surplusEndMs: phx(10, 15, 16),
  };
  assert.deepEqual(planOf({ ...legDeps(sz, 30), ...shadowPvPlannerDeps(sel) }), planOf(legDeps(sz, 30)));
  assert.deepEqual(planOf({ ...legDeps(sz, 0), ...shadowPvPlannerDeps(null) }), planOf(legDeps(sz, 0)), 'no selection: the plan of v1.209.1');

  const rec = await evening(sel, 30);
  assert.equal(rec.cost!.basisComplete, true);
  for (const leg of [rec.backup!, rec.cost!, rec.backupB!]) assert.equal(leg.panelPvAsOfDay, E);
  const note = ` (on the panel-measured planning band as of ${E})`;
  assert.equal(middayShadowLedgerColumns(rec).shadow_arm_disposition,
    `backup: ${rec.backup!.disposition}${note}; cost: ${rec.cost!.disposition}${note}; backup option B:${note}`);
  // The leg's own disposition (the card, the log) is the arm verdict alone, as before.
  assert.ok(!rec.cost!.disposition.includes('panel'));
});

test('★★★ the row of a leg not sized on the panel band is v1.209.1\'s, and the shadow writes shadow columns only', async () => {
  const rec = await evening(null, 30);
  for (const leg of [rec.backup!, rec.cost!, rec.backupB!]) assert.ok(!('panelPvAsOfDay' in leg));
  const cols = middayShadowLedgerColumns(rec);
  assert.equal(cols.shadow_arm_disposition, [`backup: ${rec.backup!.disposition}`, `cost: ${rec.cost!.disposition}`].join('; '));
  for (const k of Object.keys(cols)) assert.ok(k.startsWith('shadow_'), `a shadow column: ${k}`);
  const panelRec = await evening(shadowPvBasis(input()), 30);
  for (const k of Object.keys(middayShadowLedgerColumns(panelRec))) assert.ok(k.startsWith('shadow_'), `a shadow column: ${k}`);
});

test('★★ the basis survives a restart (the record\'s round trip), a malformed one does not, and an unsized leg claims none', async () => {
  const rec = await evening(shadowPvBasis(input()), 30);
  const back = coerceMiddayShadowRecord(JSON.parse(JSON.stringify(rec)))!;
  assert.equal(back.cost!.panelPvAsOfDay, E);
  assert.equal(back.backupB!.panelPvAsOfDay, E);
  assert.deepEqual(middayShadowLedgerColumns(back), middayShadowLedgerColumns(rec));
  const raw = JSON.parse(JSON.stringify(rec));
  raw.cost.panelPvAsOfDay = 'last evening';
  raw.backup.panelPvAsOfDay = 20261014;
  const bad = coerceMiddayShadowRecord(raw)!;
  assert.ok(!('panelPvAsOfDay' in bad.cost!) && !('panelPvAsOfDay' in bad.backup!));
  const leg = { role: 'cost', kind: 'super_off_peak', startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) } as Parameters<typeof summariseLeg>[0];
  assert.ok(!('panelPvAsOfDay' in summariseLeg(leg, null, { wouldArm: false, disposition: 'x' })));
});

test('★★★ a mixed band is named as the band, never as the panel\'s own readings of every slot', async () => {
  const mixed = { ...verdictOf('pass'), basis: 'mixed', sources: [{ slot: 1, source: 'core' }, { slot: 2, source: 'panel' }, { slot: 3, source: 'panel' }] } as UcVerdict;
  const sel = shadowPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: mixed, gate: GATE_PASS } }));
  assert.deepEqual(sel, { use: 'planning', asOfDay: E, bandCoverageRefusedBy: null, panelBasisRefusal: null });
  const disp = middayShadowLedgerColumns(await evening(sel, 30)).shadow_arm_disposition!;
  assert.equal(count(disp, ` (on the panel-measured planning band as of ${E})`), 3);
  assert.ok(!disp.includes("panel's own"));
});

test('★★★ the refresh compares like with like: a re-plan on another solar band than the evening\'s stands, names both bands, and records no re-plan figure', async () => {
  const sz: ShadowLegSizing = {
    spec: { kind: 'super_off_peak', role: 'cost', window: { startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) } },
    nextRechargeMs: HORIZON_END, surplusEndMs: phx(10, 15, 16),
  };
  const plan = planOf(legDeps(sz, 30));
  const at = phx(10, 15, 9, 31);
  const onCores: ShadowSized = { plan, windowPvP50Kwh: 20, windowLoadP50Kwh: 14 };
  const onPanel: ShadowSized = { ...onCores, panelPvAsOfDay: E };
  const panelRec = await evening(shadowPvBasis(input()), 30);
  const coresRec = await evening(null, 30);
  assert.equal(panelRec.cost!.panelPvAsOfDay, E);
  assert.ok(panelRec.cost!.basisComplete && coresRec.cost!.basisComplete);
  const stood = (rec: MiddayShadowRecord, reason: string) => ({
    atMs: at, disposition: 'stood', levelPct: rec.cost!.levelPct, reservePct: rec.cost!.reservePct, buyKwh: rec.cost!.buyKwh,
    expectedBuyKwh: rec.cost!.expectedBuyKwh, wouldPush: false, reason,
    weatherAgeS: null, neededLevelPct: null, windowPvP50Kwh: null, neededReservePct: null,
  });
  assert.deepEqual(refreshFromSized(panelRec, onCores, at), stood(panelRec,
    `the refresh was planned on the Cores' band, the evening plan on the panel-measured planning band as of ${E}; the evening plan stands`));
  assert.deepEqual(refreshFromSized(coresRec, onPanel, at), stood(coresRec,
    `the refresh was planned on the panel-measured planning band as of ${E}, the evening plan on the Cores' band; the evening plan stands`));
  // The same band on both: the comparison as before (a record with no basis and a re-plan with none, or null, are the Cores' band).
  const bare = { ...panelRec, cost: { ...panelRec.cost! } };
  delete bare.cost.panelPvAsOfDay;
  const compared = refreshFromSized(bare, onCores, at);
  assert.notEqual(compared.disposition, 'stood');
  assert.deepEqual(refreshFromSized(panelRec, onPanel, at), compared);
  assert.deepEqual(refreshFromSized(bare, { ...onCores, panelPvAsOfDay: null }, at), compared);
  assert.equal(compared.windowPvP50Kwh, 20);
  // No re-plan at all stands as before, whatever the evening's band.
  assert.equal(refreshFromSized(panelRec, null, at).reason, 'the refresh had no plan; the evening plan stands');
});
