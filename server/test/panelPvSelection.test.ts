/**
 * ★★★ v1.204.0 — THE NIGHT PLAN'S SOLAR BASIS, SELECTED (panelPvSelection.ts, index.ts recomputeNightChargePlan), and what every
 * surface says of it. By the build brief's rulings:
 *  - M1  E is the evening that owns the window (the latch's day), never the window's start day;
 *  - M2  a published band that passed its gate without covering every connected slot is passed as refused (cushion-only);
 *  - M3  the refusal words are figures only (no causal clause);
 *  - L1  one reason per clause of selection (b), in a fixed precedence, with a transient class that prints nothing and defers;
 *  - L2  the latch: a missing report keeps the previous plan; a latch with no basis reads published to its close;
 *  - F1  the evening job's own call selects afresh as of its own day (Saturday's latch never decides Sunday's evening), and every
 *        'latched' refusal names the latch's own day and says no decision was made where the evening reached its cutoff without one;
 *  - L5  the ledger's PV actual on a panel row, said; L6  Home Assistant's two attributes, exactly;
 *  and the readiness gate's panelApart. The replay on the recorded plant is panelPvReplay.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  latchedPvBasis, planAsOfDay, selectPvBasis, planningClauses, pvBasisDecoration, withPvBasis, pvBasisReasonText, pvBasisRefusedText,
  panelPvBasisText, pvBasisPushText, bandCoverageRefusalText, uncountedCauseText,
  type PvSelectionInput, type PvBasisReason, type PvBasisLatch,
} from '../src/panelPvSelection.js';
import type { UcVerdict, UcChecks, UncountedCause } from '../src/panelPvBasis.js';
import {
  buildNightChargeInputs, computeNightChargePlan, eveningBasisDefers, solarBasisGate, cushionRatioKnown, nightChargeStateFields,
  type NightChargeInputDeps, type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { planDateOwningCycle, resolveCheapWindow, cheapNightOf } from '../src/chargeWindows.js';
import { siteDayStartMs, siteTimeZone, addDaysYmd, siteYmd } from '../src/siteTime.js';
import { tariffModelFromEnv, rateAt, cheapPeriodIdOf } from '../src/tariff.js';
import { nightScheduleOf } from '../src/nightSchedule.js';
import { SENSORS, sensorDiscoveryConfig, NIGHT_CHARGE_ATTRIBUTES_TEMPLATE } from '../src/mqttDiscovery.js';
import {
  panelRowPvActual, panelPvActualNote, pvVerdictSetAside, panelPvVerdictSetAside, isPanelBasisRow,
  panelPvAdmission, panelPvRecaptureDue, panelPvRecaptureColumns, spanSiteDays, PANEL_PV_PENDING_MARKER, FORECAST_SPAN_MS,
} from '../src/nightLedgerScoring.js';
import { computeNightChargeReadiness, panelApart, CURRENT_ALGO_VERSION } from '../src/nightChargeGate.js';
import type { NightLedgerRow } from '../src/recorder.js';
import * as web from '../../web/src/cards/nightChargeText.js';
import { legacyIdentityCases, planDigest } from './fixtures/legacyIdentityFixtures.js';
import { darkDeps } from './fixtures/cushionOnlyFigures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const H = 3_600_000;
const NOTIFY_MIN = 21 * 60 + 30;
const E = '2026-10-29';
const KEYS = ['P#1', 'P#2', 'P#3'];

const checks = (o: Partial<UcChecks> = {}): UcChecks => ({
  asOfDay: E, threshold: 1.04, ratio: 0.9997, balanceDaylightRatio: 0.9781, nightResidualKwhPerNight: -1.13, max7: 0.9997,
  blindBandPct: 4, fieldDays: 8, newestFieldDay: '2026-10-28', fieldSlots: [1, 2, 3],
  constants: { 1: { days: 51, chargeHours: 97 }, 2: { days: 51, chargeHours: 96 }, 3: { days: 51, chargeHours: 95 } },
  vendorDaysPresent: 14, vendorMaxDiffKwh: 0.17, nightMaxW: 0, frozenHours: 0, ...o,
});
const PANEL3 = [{ slot: 1, source: 'panel' }, { slot: 2, source: 'panel' }, { slot: 3, source: 'panel' }] as UcVerdict['sources'];
const verdict = (state: UcVerdict['state'], reason: UcVerdict['reason'] = null, sources = PANEL3, asOfDay = E): UcVerdict => {
  const panel = sources.filter((s) => s.source !== 'core').length;
  return {
    asOfDay, state, ok: state !== 'refused', reason, sources,
    basis: panel === 0 ? 'cores' : panel === sources.length ? 'panel' : 'mixed', checks: checks({ asOfDay }),
  };
};
const PASS_GATE = { basisComplete: true, basisBlockedBy: null, transient: false };
const ZERO_DAYS = { basisComplete: false, basisBlockedBy: 'only 0 scored calibration day(s), need 4', transient: true };
const input = (o: Partial<PvSelectionInput> = {}): PvSelectionInput => ({
  asOfDay: E,
  eligible: { writeMode: true, panelFresh: true, cancelled: false },
  latched: null,
  published: { gate: ZERO_DAYS, uncoveredSlots: [1, 2, 3] },
  planning: { asOfDay: E, keys: KEYS, verdict: verdict('pass'), gate: PASS_GATE },
  planningRollupOk: true,
  connectedKeys: KEYS,
  ratioKnown: true,
  ...o,
});
const BALANCE: PvBasisReason = { code: 'balance', windowEnd: '2026-11-05', ratio: 1.0523, daylightRatio: 1.0312, nightResidualKwhPerNight: -1.13, threshold: 1.04 };

/* ══ M1 / L2 — E and the latch ═══════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ M1: E is the evening that owns the window — Saturday 10-31 judges as of Saturday, read the same at Sat 22:30, Sun 00:30 and Sun 09:30; Sunday\'s evening job judges as of Sunday', () => {
  const monStart = siteDayStartMs('2026-11-02');
  const monEnd = monStart + 5 * H;
  const latch: PvBasisLatch = { basis: 'planning', asOfDay: '2026-10-31', windowStartMs: monStart, windowEndMs: monEnd };
  const at = (ms: number) => {
    const planDate = planDateOwningCycle({ nowMs: ms, firstLegStartMs: monStart, timezone: siteTimeZone(), notifyMinuteOfDay: NOTIFY_MIN });
    const l = latchedPvBasis({ lastNotifyDay: '2026-10-31', pv: latch, noDecision: false, windowStartMs: monStart, windowEndMs: monEnd, nowMs: ms, planDate, armed: { day: '2026-10-31', windowStartMs: monStart } });
    return { l, E: planAsOfDay({ arming: false, todayYmd: '-', latched: l, planDate }) };
  };
  const sat = siteDayStartMs('2026-10-31');
  const sun = siteDayStartMs('2026-11-01');
  for (const ms of [sat + 22.5 * H, sun + 0.5 * H, sun + 9.5 * H]) {
    const { l, E: e } = at(ms);
    assert.deepEqual(l, { basis: 'planning', asOfDay: '2026-10-31', decided: true });
    assert.equal(e, '2026-10-31', 'never the window\'s start day (Monday)');
  }
  // Sunday's own evening job decides afresh, as of Sunday; its latch then governs the window.
  assert.equal(planAsOfDay({ arming: true, todayYmd: '2026-11-01', latched: { asOfDay: '2026-10-31' }, planDate: '2026-11-01' }), '2026-11-01');
  // Before any evening owns a window: the plan date that will own it (Saturday 14:00 → Saturday, for the Monday window).
  const planDate = planDateOwningCycle({ nowMs: sat + 14 * H, firstLegStartMs: monStart, timezone: siteTimeZone(), notifyMinuteOfDay: NOTIFY_MIN });
  assert.equal(planAsOfDay({ arming: false, todayYmd: '2026-10-31', latched: null, planDate }), '2026-10-31');
});

test('★★★ L2: a latch written by v1.203.0 (no basis) reads as the published basis to its window\'s close — v1.204.0 may deploy inside an armed window', () => {
  const mon = siteDayStartMs('2026-11-09');
  const ws = mon + 23 * H;
  const we = ws + 6 * H;
  const deploy = siteDayStartMs('2026-11-10') + 3.43 * H; // Tue 03:26, inside Monday's window
  const planDate = planDateOwningCycle({ nowMs: deploy, firstLegStartMs: ws, timezone: siteTimeZone(), notifyMinuteOfDay: NOTIFY_MIN });
  const old = { lastNotifyDay: '2026-11-09', pv: undefined, noDecision: false, windowStartMs: ws, windowEndMs: we, planDate, armed: { day: '2026-11-09', windowStartMs: ws } };
  assert.deepEqual(latchedPvBasis({ ...old, nowMs: deploy }), { basis: 'published', asOfDay: '2026-11-09', decided: true });
  assert.equal(latchedPvBasis({ ...old, nowMs: we }), null, 'to the close, and no further');
  // The selection inside it never takes the planning band, even passing: the window's evening decided without it.
  const sel = selectPvBasis(input({ latched: { basis: 'published', asOfDay: E, decided: true } }));
  assert.equal(sel.use, 'published');
  assert.equal(sel.reason?.code, 'latched');
  // A latch for another window (Monday's, read on Tuesday afternoon for Tuesday's window) governs nothing.
  const tue = siteDayStartMs('2026-11-10') + 14 * H;
  const tuePlanDate = planDateOwningCycle({ nowMs: tue, firstLegStartMs: ws + 24 * H, timezone: siteTimeZone(), notifyMinuteOfDay: NOTIFY_MIN });
  assert.equal(latchedPvBasis({ ...old, windowStartMs: ws + 24 * H, windowEndMs: we + 24 * H, nowMs: tue, planDate: tuePlanDate, armed: { day: '2026-11-09', windowStartMs: ws } }), null);
});

test('★★★ L2: inside a window latched on the planning basis, a missing or other-evening report keeps the previous plan (never a fresh (c)); its report passing, the planning band', () => {
  for (const planning of [null, { asOfDay: '2026-10-28', keys: KEYS, verdict: verdict('pass'), gate: PASS_GATE }]) {
    const sel = selectPvBasis(input({ latched: { basis: 'planning', asOfDay: E, decided: true }, planning }));
    assert.equal(sel.use, 'keep-previous');
    assert.equal(sel.reason, null);
  }
  assert.equal(selectPvBasis(input({ latched: { basis: 'planning', asOfDay: E, decided: true } })).use, 'planning');
  // And index.ts keeps the previous served plan on it (or seeds this window's snapshot after a restart): 'panelStale' to its callers.
  assert.match(INDEX, /if \(pvSel\?\.use === 'keep-previous'\) \{\n\s+if \(getLatestNightChargePlan\(\) == null\) seedPlanFromSnapshot\(window\?\.startMs \?\? null\);\n\s+return 'panelStale';\n\s+\}/);
});

/* ══ F1 — the evening job's own call selects afresh as of its own day; the 'latched' words true on every path ═════════════════════ */

/** The weekend as index.ts resolves it (the real tariff, its cheap window, the evening schedule): Saturday 11-14 and Sunday 11-15 both
 *  plan the Monday 11-16 window. */
const TM = tariffModelFromEnv();
const SCHED = nightScheduleOf(TM, { hour: 21, minute: 30 });
const winAt = (ms: number) => resolveCheapWindow((t) => rateAt(TM, t).periodId, ms, cheapPeriodIdOf(TM)!, 30, cheapNightOf(TM))!;
const SAT = '2026-11-14';
const SUN = '2026-11-15';
const at = (day: string, h: number): number => siteDayStartMs(day) + h * H;
const SAT_W = winAt(at(SAT, 21.5));
interface LatchFile { lastNotifyDay: string; pv: PvBasisLatch | null; noDecision?: boolean; armed: { day: string | null; windowStartMs: number | null } }
/** recomputeNightChargePlan's latch, E and selection at `ms` with the latch file `latch` standing: latchedPvBasis and planAsOfDay as
 *  index.ts calls them, and the selection's latch by the expression index.ts carries (ARMING, pinned in each test below). */
function chainAt(ms: number, arming: boolean, latch: LatchFile, o: Partial<PvSelectionInput> = {}) {
  const w = winAt(ms);
  const planDate = planDateOwningCycle({ nowMs: ms, firstLegStartMs: w.startMs, timezone: siteTimeZone(), notifyMinuteOfDay: SCHED.notify.fireMin });
  const here = latchedPvBasis({
    lastNotifyDay: latch.lastNotifyDay, pv: latch.pv, noDecision: latch.noDecision === true,
    windowStartMs: w.startMs, windowEndMs: w.endMs, nowMs: ms, planDate, armed: latch.armed,
  });
  const E = planAsOfDay({ arming, todayYmd: siteYmd(ms), latched: here, planDate });
  const sel = selectPvBasis(input({ asOfDay: E, latched: arming ? null : here, ...o }));
  return { w, here, E, sel };
}
/** index.ts: `latched: opts.arming === true ? null : pvLatchHere` — the evening job's own call reads no latch. */
const ARMING = /\n\s+latched: opts\.arming === true \? null : pvLatchHere,\n/;
const satLatch = (basis: 'planning' | 'published' | null): LatchFile => ({
  lastNotifyDay: SAT, armed: { day: SAT, windowStartMs: SAT_W.startMs },
  pv: basis == null ? null : { basis, asOfDay: SAT, windowStartMs: SAT_W.startMs, windowEndMs: SAT_W.endMs },
});
const reportAsOf = (day: string, state: UcVerdict['state'] = 'pass', reason: UcVerdict['reason'] = null, gate: PvSelectionInput['published']['gate'] = PASS_GATE): Partial<PvSelectionInput> => ({
  planning: { asOfDay: day, keys: KEYS, verdict: verdict(state, reason, PANEL3, day), gate },
});

test('★★★ F1 (a): Sunday\'s evening job under Saturday\'s planning latch for the Monday window both share, its planning report missing (or built for another evening, or its band transient) → the published deps, transient: deferred to 22:30 and decided then — never keep-previous, which returned \'panelStale\' every minute to the 23:00 cutoff and left Saturday\'s day-old arm standing', () => {
  assert.match(INDEX, ARMING);
  const gone: Array<Partial<PvSelectionInput>> = [
    { planning: null, planningRollupOk: false },
    reportAsOf(SAT),
    reportAsOf(SUN, 'pass', null, ZERO_DAYS),
    { ...reportAsOf(SUN), planningRollupOk: false },
  ];
  for (const o of gone) {
    for (const h of [21.5, 22.5, 22 + 59 / 60]) {
      const c = chainAt(at(SUN, h), true, satLatch('planning'), o);
      assert.equal(c.w.startMs, SAT_W.startMs, 'the window Saturday and Sunday share');
      assert.deepEqual(c.here, { basis: 'planning', asOfDay: SAT, decided: true }, 'Saturday\'s latch still stands at Sunday\'s evening');
      assert.equal(c.E, SUN);
      assert.equal(c.sel.use, 'published', `${h}: not keep-previous`);
      assert.equal(c.sel.transient, true);
      assert.equal(c.sel.reason, null, 'the transient class prints nothing');
      const d = pvBasisDecoration({ sel: c.sel, asOfDay: c.E, plan: { sized: true, cushionOnly: true }, calScoredDays: 0, admittedDays: null })!;
      assert.equal(d.pvBasisTransient, true);
      const nowMin = Math.round(h * 60);
      assert.equal(eveningBasisDefers({ basisComplete: true, pvBasisTransient: true }, nowMin, SCHED.staleDeferUntilMin), nowMin < SCHED.staleDeferUntilMin, `${h}: deferred to 22:30, decided from then`);
    }
  }
  assert.equal(SCHED.staleDeferUntilMin, 22 * 60 + 30);
  // The Cores back (their band passing and covering every slot), the planning report missing: decided at 21:30 on the Cores' band.
  const back = chainAt(at(SUN, 21.5), true, satLatch('planning'), { published: { gate: PASS_GATE, uncoveredSlots: [] }, planning: null, planningRollupOk: false });
  assert.deepEqual([back.sel.use, back.sel.published, back.sel.transient], ['published', true, false]);
  // L2 unchanged: the same latch read by any other recompute (Sunday 14:00, before Sunday's evening), its report missing, keeps the
  // previous plan.
  const tick = chainAt(at(SUN, 14), false, satLatch('planning'), { planning: null, planningRollupOk: false });
  assert.equal(tick.E, SAT);
  assert.equal(tick.sel.use, 'keep-previous');
});

test('★★★ F1 (b): Sunday\'s evening job under Saturday\'s published latch (Saturday refused, decided on a transient at 22:30, or in advisory mode), Sunday\'s verdict passing as of Sunday → the planning band; a Sunday that refuses says its own reason; before Sunday\'s evening the latch\'s \'latched\' refusal names Saturday', () => {
  assert.match(INDEX, ARMING);
  for (const h of [21.5, 22.5]) {
    const c = chainAt(at(SUN, h), true, satLatch('published'), reportAsOf(SUN));
    assert.deepEqual(c.here, { basis: 'published', asOfDay: SAT, decided: true });
    assert.equal(c.E, SUN);
    assert.equal(c.sel.use, 'planning');
    assert.equal(c.sel.reason, null);
  }
  assert.deepEqual(chainAt(at(SUN, 21.5), true, satLatch('published'), reportAsOf(SUN, 'refused', BALANCE)).sel.reason, BALANCE);
  const tick = chainAt(at(SUN, 14), false, satLatch('published'), reportAsOf(SAT));
  assert.equal(tick.E, SAT);
  assert.equal(tick.sel.use, 'published');
  assert.deepEqual(tick.sel.reason, { code: 'latched', asOfDay: SAT, decided: true });
  assert.equal(pvBasisReasonText(tick.sel.reason!), `this window's evening decision was made on ${SAT} without them`);
  assert.equal(pvBasisReasonText(tick.sel.reason!, 'es'), `la decisión de la tarde para esta ventana se tomó el ${SAT} sin ellas`);
});

test('★★★ F1 (c): a v1.203.0 latch (no basis) for Saturday\'s arm of the Monday window — this release deployed over the weekend — and Sunday\'s evening job selects afresh: passing, the planning band; its report missing, the transient class', () => {
  assert.match(INDEX, ARMING);
  const c = chainAt(at(SUN, 21.5), true, satLatch(null), reportAsOf(SUN));
  assert.deepEqual(c.here, { basis: 'published', asOfDay: SAT, decided: true }, 'it reads as the published basis');
  assert.equal(c.sel.use, 'planning');
  const t = chainAt(at(SUN, 21.5), true, satLatch(null), { planning: null, planningRollupOk: false });
  assert.deepEqual([t.sel.use, t.sel.transient, t.sel.reason], ['published', true, null]);
  // Saturday 23:30 (deployed after Saturday decided on v1.203.0): inside Saturday's latch, the decided words name Saturday.
  const sat = chainAt(at(SAT, 23.5), false, satLatch(null), reportAsOf(SAT));
  assert.deepEqual(sat.sel.reason, { code: 'latched', asOfDay: SAT, decided: true });
});

test('★★★ F1 (d): inside Sunday\'s own latched window every other recompute still selects the latched basis (L2 unchanged) — planning: its report passing, the planning band; missing, keep-previous; published: a passing reading refused as \'latched\', naming Sunday — and the reason names the latch\'s own day, whatever E it is handed', () => {
  const sunW = winAt(at(SUN, 21.5));
  assert.equal(sunW.startMs, SAT_W.startMs);
  const own = (basis: 'planning' | 'published'): LatchFile => ({
    lastNotifyDay: SUN, armed: { day: SUN, windowStartMs: sunW.startMs },
    pv: { basis, asOfDay: SUN, windowStartMs: sunW.startMs, windowEndMs: sunW.endMs },
  });
  for (const ms of [at(SUN, 23.5), at('2026-11-16', 0.5), at('2026-11-16', 4.5)]) {
    const p = chainAt(ms, false, own('planning'), reportAsOf(SUN));
    assert.equal(p.E, SUN);
    assert.equal(p.sel.use, 'planning');
    assert.equal(chainAt(ms, false, own('planning'), { planning: null, planningRollupOk: false }).sel.use, 'keep-previous');
    const q = chainAt(ms, false, own('published'), reportAsOf(SUN));
    assert.equal(q.sel.use, 'published');
    assert.deepEqual(q.sel.reason, { code: 'latched', asOfDay: SUN, decided: true });
  }
  assert.deepEqual(
    selectPvBasis(input({ asOfDay: '2026-10-29', latched: { basis: 'published', asOfDay: '2026-10-28', decided: true } })).reason,
    { code: 'latched', asOfDay: '2026-10-28', decided: true });
});

test('★★★ F1 the \'latched\' words on every path that serves them: a decided evening (a published latch, a v1.203.0 latch, an evening that decided with no plan) — "this window\'s evening decision was made on <its day> without them"; an evening job that did not decide before its cutoff latches noDecision, and its window says no evening decision was made that day — en and es, never a decision on a day that made none', () => {
  // Sunday's cutoff (the add-on down 21:30–23:00, or a panel stale throughout): the latch has no basis and says so; Saturday's arm
  // of the window stands.
  const cut: LatchFile = { lastNotifyDay: SUN, pv: null, noDecision: true, armed: { day: SAT, windowStartMs: SAT_W.startMs } };
  for (const ms of [at(SUN, 23.5), at('2026-11-16', 0.5)]) {
    const c = chainAt(ms, false, cut, reportAsOf(SUN));
    assert.deepEqual(c.here, { basis: 'published', asOfDay: SUN, decided: false });
    assert.equal(c.E, SUN);
    assert.equal(c.sel.use, 'published');
    assert.deepEqual(c.sel.reason, { code: 'latched', asOfDay: SUN, decided: false });
    const en = pvBasisReasonText(c.sel.reason!);
    const es = pvBasisReasonText(c.sel.reason!, 'es');
    assert.equal(en, `no evening decision was made for this window on ${SUN} (the evening job did not decide before its cutoff)`);
    assert.equal(es, `el ${SUN} no se tomó ninguna decisión de la tarde para esta ventana (el trabajo de la tarde no decidió antes de su hora límite)`);
    assert.doesNotMatch(en, /without them|decided on/);
    assert.doesNotMatch(es, /sin ellas|se decidió/);
    assert.equal(pvBasisRefusedText(c.sel.reason!), ` The panel's own solar readings are not used tonight: ${en}.`);
  }
  // An evening that decided with no plan (inputs unavailable) latches no basis, and decided: the decided words name it.
  const noPlan: LatchFile = { lastNotifyDay: SUN, pv: null, armed: { day: null, windowStartMs: null } };
  const n = chainAt(at(SUN, 23.5), false, noPlan, reportAsOf(SUN));
  assert.deepEqual(n.sel.reason, { code: 'latched', asOfDay: SUN, decided: true });
  assert.equal(pvBasisReasonText(n.sel.reason!), `this window's evening decision was made on ${SUN} without them`);
  // The evening job's own call never serves it, under any latch.
  for (const l of [cut, noPlan, satLatch('published'), satLatch(null)]) {
    assert.notEqual(chainAt(at(SUN, 21.5), true, l, reportAsOf(SUN)).sel.reason?.code, 'latched');
  }
  // The wiring: the cutoff path alone latches noDecision; the latch is read with it; only a writer that says so sets it.
  assert.match(INDEX, ARMING);
  const jobAt = INDEX.indexOf('async function runNightChargeEveningJobInner(');
  const job = INDEX.slice(jobAt, INDEX.indexOf('\n}\n', jobAt));
  const cutoffAt = job.indexOf('if (nowMin >= cutoffMin) {');
  const cutoff = job.slice(cutoffAt, job.indexOf('return;', cutoffAt));
  assert.match(cutoff, /\n\s+writeNightChargeLatch\(\{ lastNotifyDay: today, armRefused: latch\.armRefused \?\? null, noDecision: true \}\);\n/);
  assert.equal(job.split('noDecision: true').length - 1, 1, 'no deciding path says it');
  assert.match(INDEX, /\n\s+noDecision: readNightChargeLatch\(\)\.noDecision === true,\n/);
  assert.match(INDEX, /\n\s+\.\.\.\(l\.noDecision === true \? \{ noDecision: true \} : \{\}\),\n/);
  assert.match(INDEX, /\n\s+\.\.\.\(raw\?\.noDecision === true \? \{ noDecision: true \} : \{\}\),\n/);
});

/* ══ the selection (a)/(b)/(c), M2, L1 ═══════════════════════════════════════════════════════════════════════════════════ */

test('★★★ (a) the published band passing its gate AND covering every connected slot is v1.203.0\'s: nothing of the selection is put on the plan', () => {
  const sel = selectPvBasis(input({ published: { gate: PASS_GATE, uncoveredSlots: [] } }));
  assert.equal(sel.use, 'published');
  assert.equal(sel.published, true);
  assert.equal(sel.bandCoverageRefusedBy, null);
  assert.equal(pvBasisDecoration({ sel, asOfDay: E, plan: { sized: true, cushionOnly: false }, calScoredDays: 22, admittedDays: 13 }), null);
  const p = { rationale: 'x' } as { rationale: string };
  assert.equal(withPvBasis(p, null), p, 'the plan itself, untouched');
});

test('★★★ M2: one Core back with its band passing on its own Core alone and the panel basis refused → the published band is passed as REFUSED, so the plan is v1.203.0\'s cushion-only plan', () => {
  const sel = selectPvBasis(input({
    published: { gate: PASS_GATE, uncoveredSlots: [2, 3] },
    planning: { asOfDay: E, keys: KEYS, verdict: verdict('refused', BALANCE), gate: PASS_GATE },
  }));
  assert.equal(sel.use, 'published');
  assert.equal(sel.published, false);
  assert.equal(sel.bandCoverageRefusedBy, "the Cores' solar band leaves out the Cores of slots 2 and 3");
  assert.equal(sel.reason?.code, 'balance');
  // Through the planner: a night of the year that plans on its band today, with the coverage refusal, is cushion-only — with the
  // gate's transience as computed (the gate passed: not transient) — and without it, byte-identical.
  const c = legacyIdentityCases().find((x) => computeNightChargePlan(buildNightChargeInputs(x.deps)).basisComplete && x.deps.objectiveMode === 'resilience')!;
  const d = { ...c.deps, cushionOnlyEligible: true, cushionOnlyFloorScale: 0.8, lineForceChargeEligible: true } as NightChargeInputDeps;
  const before = computeNightChargePlan(buildNightChargeInputs(d));
  assert.equal(planDigest(computeNightChargePlan(buildNightChargeInputs({ ...d, bandCoverageRefusedBy: null }))), planDigest(before));
  const refused = computeNightChargePlan(buildNightChargeInputs({ ...d, bandCoverageRefusedBy: sel.bandCoverageRefusedBy }));
  assert.ok(refused.cushionOnly != null, 'cushion-only');
  assert.equal(refused.cushionOnly!.refusedBy, sel.bandCoverageRefusedBy);
  assert.equal(refused.cushionOnly!.transient, false);
  // A band its gate refused is passed exactly (no coverage words).
  assert.equal(selectPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: verdict('refused', BALANCE), gate: PASS_GATE } })).bandCoverageRefusedBy, null);
});

test('★★★ (b) the planning band: every clause holds → planning; a refused verdict → (c) with its reason; the solar basis gate is one definition', () => {
  assert.equal(selectPvBasis(input()).use, 'planning');
  const r = selectPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: verdict('refused', BALANCE), gate: PASS_GATE } }));
  assert.equal(r.use, 'published');
  assert.deepEqual(r.reason, BALANCE);
  assert.equal(r.transient, false);
  // solarBasisGate is buildNightChargeInputs' own head: the same words on every case of the year.
  for (const c of legacyIdentityCases()) {
    const g = solarBasisGate({
      forecastPresent: c.deps.forecastPresent, confidenceTier: c.deps.confidenceTier, calScoredDays: c.deps.calScoredDays,
      minCalScoredDays: c.deps.minCalScoredDays, provisionalMinCalScoredDays: c.deps.provisionalMinCalScoredDays, bandCoverageFrac: c.deps.bandCoverageFrac,
    });
    const i = buildNightChargeInputs(c.deps);
    assert.equal(g.basisComplete, i.basisComplete, c.label);
    if (!g.basisComplete && i.cushionOnly == null) assert.equal(i.basisBlockedBy, g.basisBlockedBy, c.label);
  }
  assert.equal(cushionRatioKnown({ scale: 0.944, basis: 'held' }), true);
  assert.equal(cushionRatioKnown({ scale: 1, basis: 'nameplate' }), false);
  assert.equal(cushionRatioKnown(null), false);
});

test('★★★ L1: one reason per clause of (b), in a fixed precedence — the mode, the panel, the cancel; the transient class; the verdict\'s own; G7; G8; the planning band\'s gate', () => {
  // The mode before anything (no report at all still says advisory, not transient).
  assert.deepEqual(planningClauses(input({ eligible: { writeMode: false, panelFresh: false, cancelled: true }, planning: null })), { ok: false, transient: false, reason: { code: 'advisory' } });
  assert.deepEqual(planningClauses(input({ eligible: { writeMode: true, panelFresh: false, cancelled: true } })), { ok: false, transient: false, reason: { code: 'stale-panel' } });
  assert.deepEqual(planningClauses(input({ eligible: { writeMode: true, panelFresh: true, cancelled: true } })), { ok: false, transient: false, reason: { code: 'cancelled' } });
  // The transient class: no report, another evening's, another slot set's, a rollup missing, a band refused the way a start-up leaves it.
  for (const o of [
    { planning: null },
    { planning: { asOfDay: '2026-10-28', keys: KEYS, verdict: verdict('pass'), gate: PASS_GATE } },
    { planning: { asOfDay: E, keys: ['P#1', 'P#2'], verdict: verdict('pass'), gate: PASS_GATE } },
    { planningRollupOk: false },
    { planning: { asOfDay: E, keys: KEYS, verdict: verdict('pass'), gate: ZERO_DAYS } },
  ] as Array<Partial<PvSelectionInput>>) {
    const sel = selectPvBasis(input(o));
    assert.equal(sel.transient, true, JSON.stringify(o));
    assert.equal(sel.reason, null, 'prints nothing');
    const d = pvBasisDecoration({ sel, asOfDay: E, plan: { sized: true, cushionOnly: true }, calScoredDays: 0, admittedDays: null })!;
    assert.equal(d.pvBasisTransient, true);
    assert.equal(d.pvBasisText, '');
  }
  // The verdict's own reason before G7 / G8 / the band, which follow in that order.
  const none = [{ slot: 1, source: 'panel' }, { slot: 2, source: 'none' }, { slot: 3, source: 'panel' }] as UcVerdict['sources'];
  assert.equal(selectPvBasis(input({ ratioKnown: false, planning: { asOfDay: E, keys: KEYS, verdict: verdict('refused', BALANCE, none), gate: { basisComplete: false, basisBlockedBy: 'x', transient: false } } })).reason?.code, 'balance');
  assert.deepEqual(selectPvBasis(input({ ratioKnown: false, planning: { asOfDay: E, keys: KEYS, verdict: verdict('pass', null, none), gate: PASS_GATE } })).reason, { code: 'slot-unresolved', slot: 2 });
  assert.deepEqual(selectPvBasis(input({ ratioKnown: false, planning: { asOfDay: E, keys: KEYS, verdict: verdict('pass'), gate: { basisComplete: false, basisBlockedBy: 'PV band coverage 74% < 78%', transient: false } } })).reason, { code: 'no-capacity-ratio' });
  assert.deepEqual(selectPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: verdict('pass'), gate: { basisComplete: false, basisBlockedBy: 'PV band coverage 74% < 78%', transient: false } } })).reason, { code: 'band', blockedBy: 'PV band coverage 74% < 78%' });
  // Every connected slot's Core covered E−1: not needed (and so not the planning band).
  assert.deepEqual(selectPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: verdict('not-needed', null, [{ slot: 1, source: 'core' }, { slot: 2, source: 'core' }, { slot: 3, source: 'core' }]), gate: PASS_GATE } })).reason, { code: 'not-needed', day: '2026-10-28' });
});

test('★★★ L1: the transient class keeps the 22:30 deferral (eveningBasisDefers) — and an accepted panel plan is decided at 21:30', () => {
  assert.equal(eveningBasisDefers({ basisComplete: true, pvBasisTransient: true }, NOTIFY_MIN), true);
  assert.equal(eveningBasisDefers({ basisComplete: true, pvBasisTransient: true }, 22 * 60 + 30), false, 'the deferral end decides');
  assert.equal(eveningBasisDefers({ basisComplete: true }, NOTIFY_MIN), false, 'a complete plan with no transient basis decides at 21:30');
});

/* ══ M3 / L1 — the words ═════════════════════════════════════════════════════════════════════════════════════════════════ */

const ALL_REASONS: PvBasisReason[] = [
  { code: 'no-membership-record' },
  { code: 'no-capacity', slot: 2 },
  { code: 'no-constants', slot: 3, days: 4, chargeHours: 0, needDays: 21, needChargeHours: 20 },
  { code: 'overlap-hold', slot: 1, day: '2026-11-04', ratio: 1.031, lastHeldDay: '2026-12-04' },
  { code: 'night-reading', slot: 2, day: '2026-11-03', hourStartMs: siteDayStartMs('2026-11-03') + H, w: 35, acInWh: 2410, lastHeldDay: '2026-11-17', forceCharge: 'on', hourClock: '1:00 AM' },
  { code: 'vendor-mismatch', day: '2026-11-03', fieldKwh: 46.1, vendorKwh: 43.7, diffKwh: 2.4, lastHeldDay: '2026-11-17' },
  { code: 'restart', slot: 2, day: '2026-11-04', kind: 'core-changed' },
  { code: 'restart', slot: null, day: '2026-11-04', kind: 'slot-set-changed' },
  { code: 'too-few-field-days', n: 6, need: 7, firstFieldDay: '2026-10-20', uncounted: [{ day: '2026-10-25', cause: 'no-vendor-row' }] },
  { code: 'too-few-field-days', n: 0, need: 7, firstFieldDay: null, uncounted: [] },
  { code: 'stale', newest: '2026-11-03', minNewest: '2026-11-05' },
  BALANCE,
  { code: 'not-needed', day: '2026-11-19' },
  { code: 'advisory' }, { code: 'stale-panel' }, { code: 'cancelled' },
  { code: 'slot-unresolved', slot: 3 }, { code: 'no-capacity-ratio' },
  { code: 'band', blockedBy: 'PV band coverage 74% < 78%' },
  { code: 'latched', asOfDay: '2026-11-09', decided: true },
  { code: 'latched', asOfDay: '2026-11-09', decided: false },
];

test('★★★ L1: every reason has its words in English and in Spanish — figures, slot numbers and days only, never a slot key', () => {
  const seen = new Set<string>();
  for (const r of ALL_REASONS) {
    const en = pvBasisReasonText(r, 'en');
    const es = pvBasisReasonText(r, 'es');
    assert.ok(en.length > 20 && es.length > 20, r.code);
    assert.notEqual(en, es, `${r.code}: es is not en`);
    assert.ok(!seen.has(en), `${r.code}: its own words`);
    seen.add(en);
    for (const t of [en, es]) {
      assert.doesNotMatch(t, /#|undefined|null|NaN/, `${r.code}: ${t}`);
      assert.ok(!/refused$/.test(t), `${r.code}: not the fallback word`);
    }
    assert.match(pvBasisRefusedText(r, 'en'), /^ The panel's own solar readings are not used tonight: .+\.$/);
    assert.match(pvBasisRefusedText(r, 'es'), /^ Las lecturas solares propias del panel no se usan esta noche: .+\.$/);
  }
});

test('★★★ M3: the balance refusal is figures only — the ratio, the week, the threshold, the daylight-only ratio and the nights\' residual — and asserts no cause (a planted ×1.10 reads the same way)', () => {
  const t = pvBasisReasonText(BALANCE);
  assert.equal(t, 'the 7-day energy balance read 1.0523 on the week to 2026-11-05, above 1.04 (1.0312 on daylight hours alone; its nights closed at −1.13 kWh a night against the measured constants); the readings are not used again before the weeks ending on 7 later whole days have all passed');
  for (const w of [/so the plant/i, /cannot tell/i, /because/i, /drew more/i, /high solar reading/i, /plant drift/i]) assert.doesNotMatch(t, w);
  // A planted ×1.10 on every slot (daylight-only ratio above the honest dark range, nights as honest): the night clause names
  // its figure and nothing else.
  const planted = pvBasisReasonText({ ...BALANCE, ratio: 1.0611, daylightRatio: 1.0402, nightResidualKwhPerNight: -0.98 });
  assert.match(planted, /its nights closed at −0\.98 kWh a night against the measured constants\)/);
  assert.doesNotMatch(planted, /so |cannot|because|drew/);
  // Four decimals: a ratio a hair above the threshold never prints equal to it.
  assert.match(pvBasisReasonText({ ...BALANCE, ratio: 1.04004 }), /read 1\.0400 on/);
});

test('★★★ L1: every hold names the evening it is held through; G4 states the slot\'s grid input and the add-on\'s force-charge in that hour; a Core swap says the new Core needs 21 days of its own meter', () => {
  const g4 = pvBasisReasonText(ALL_REASONS[4]);
  assert.equal(g4, "slot 2 read 35.0 W with the sun down at 1:00 AM on 2026-11-03 (its grid input in that hour 2.41 kWh; the add-on's force-charge was on in that hour); a night reading above 20 W is not a solar reading, and the readings are held through the evening of 2026-11-17");
  assert.match(pvBasisReasonText({ ...(ALL_REASONS[4] as object), forceCharge: 'off' } as PvBasisReason), /the add-on's force-charge was off in that hour/);
  assert.match(pvBasisReasonText({ ...(ALL_REASONS[4] as object), forceCharge: undefined, hourClock: undefined } as PvBasisReason), /force-charge state in that hour is not on record/);
  assert.match(pvBasisReasonText(ALL_REASONS[3]), /held through the evening of 2026-12-04$/);
  assert.match(pvBasisReasonText(ALL_REASONS[5]), /2\.40 kWh above the panel's own daily solar total \(46\.10 against 43\.70 kWh\); the readings are held through the evening of 2026-11-17$/);
  assert.equal(pvBasisReasonText(ALL_REASONS[2]), "slot 3's Core has no measured energy-balance constants: they need 21 whole days of that Core's own solar meter in that slot (it has 4) and 20 night hours of grid charge (it has 0)");
  assert.match(pvBasisReasonText(ALL_REASONS[6]), /^the Core in slot 2 changed; whole days of panel readings count again from 2026-11-04$/);
  // The count names its first field day and the newest day it could not count, with the cause.
  assert.equal(pvBasisReasonText(ALL_REASONS[8]), "only 6 of the 7 whole days of panel readings the energy balance needs (they count from 2026-10-20); the newest day not counted, 2026-10-25, has no daily total from the panel's own ledger");
  // Every uncounted cause has words in both languages.
  const causes: Array<{ day: string } & UncountedCause> = [
    { day: 'd', cause: 'no-record' }, { day: 'd', cause: 'map' }, { day: 'd', cause: 'no-vendor-row' }, { day: 'd', cause: 'vendor-mismatch', diffWh: 900 },
    { day: 'd', cause: 'night-reading', slot: 1, w: 31 }, { day: 'd', cause: 'core-day', slot: 1 }, { day: 'd', cause: 'field-share', slot: 1, frac: 0.6 },
    ...(['pct', 'meter', 'coverage', 'bridge', 'frozen', 'ac-charge', 'no-hours'] as const).map((what) => ({ day: 'd', cause: 'slot-incomplete' as const, slot: 2, what, frozenHours: 3 })),
    { day: 'd', cause: 'no-estimate', slot: 3 },
  ];
  const en = new Set(causes.map((c) => uncountedCauseText(c, 'en')));
  assert.equal(en.size, causes.length, 'each cause its own words');
  for (const c of causes) assert.notEqual(uncountedCauseText(c, 'es'), uncountedCauseText(c, 'en'));
});

test('★★★ L7: the accepted basis sentence — each slot\'s source is its E−1 daylight\'s; panel and mixed; the runway sentence true in both; the push and the card mirror it', () => {
  const panel = panelPvBasisText({ verdict: verdict('pass'), calScoredDays: 22, admittedDays: 13 });
  assert.equal(panel, " SOLAR FROM THE PANEL'S READINGS: slots 1, 2 and 3 take their solar from the panel's own reading of each Core's chargers (their Cores did not report their own solar on 2026-10-28); the band is calibrated on 22 scored days (the panel's readings stand in on 13 of the last 30 days), and the 7-day energy balance reads 0.9997 on the week to 2026-10-28: the panel's solar against what the plant's own metered flows account for over 7 whole days, on constants measured against each Core's own solar meter (refused above 1.04). The runway alarm does not read these readings: it counts only the solar of Cores that report their own.");
  const mixed = panelPvBasisText({ verdict: verdict('pass', null, [{ slot: 1, source: 'panel' }, { slot: 2, source: 'core' }, { slot: 3, source: 'panel' }]), calScoredDays: 22, admittedDays: 13 });
  assert.match(mixed, /^ SOLAR FROM THE PANEL'S READINGS: slot 2 on its Core's own figure; slots 1 and 3 on the panel's own reading of their Cores' chargers \(their Cores did not report their own solar on 2026-10-28\);/);
  assert.match(panelPvBasisText({ verdict: verdict('pass'), calScoredDays: 22, admittedDays: 13 }, 'es'), /^ SOLAR DE LAS LECTURAS DEL PANEL: /);
  assert.equal(pvBasisPushText({ pvBasis: 'panel', pvBasisChecks: checks(), pvBasisRefusedBy: null }), " Solar from the panel's readings (7-day energy balance 0.9997, refused above 1.04).");
  assert.equal(pvBasisPushText({ pvBasis: null, pvBasisChecks: null, pvBasisRefusedBy: BALANCE }), ` Panel solar not used: ${pvBasisReasonText(BALANCE)}.`);
  assert.equal(pvBasisPushText({ pvBasis: null, pvBasisChecks: null, pvBasisRefusedBy: null }), '', 'the transient class prints nothing');
  // The card's Basis stat.
  assert.deepEqual(web.panelBasisStat({ pvBasis: 'panel', pvBasisChecks: { ratio: 0.9997, threshold: 1.04 } }), { value: 'panel solar', sub: 'balance 0.9997 ≤ 1.04' });
  assert.deepEqual(web.panelBasisStat({ pvBasis: 'mixed', pvBasisChecks: { ratio: 1.01, threshold: 1.04 } }), { value: 'Cores + panel solar', sub: 'balance 1.0100 ≤ 1.04' });
  assert.deepEqual(web.panelBasisStat({ pvBasis: null, pvBasisRefusedBy: { code: 'balance' }, cushionOnly: {} }), { value: null, sub: 'no solar basis · panel solar refused' });
  assert.equal(web.panelBasisStat({}), null, 'a plan of the Cores\' band: nothing new on the card');
  // Through the real push: a charge plan and a hold sized on the planning band say so; the same plans unselected do not.
  const sel = selectPvBasis(input());
  for (const want of [true, false]) {
    const c = legacyIdentityCases().find((x) => {
      const q = computeNightChargePlan(buildNightChargeInputs(x.deps));
      return q.basisComplete && q.cushionOnly == null && q.window != null && q.chargeTonight === want && !q.cushionShortfall;
    })!;
    const base = computeNightChargePlan(buildNightChargeInputs(c.deps));
    const sized = withPvBasis(base, pvBasisDecoration({ sel, asOfDay: E, plan: { sized: true, cushionOnly: false }, calScoredDays: 22, admittedDays: 13 })) as NightChargePlan;
    const shape = want ? 'charge' : 'hold';
    const msg = buildNightChargeMessage(sized, shape, null, null, 'supervised');
    assert.ok(msg.body.includes(" Solar from the panel's readings (7-day energy balance 0.9997, refused above 1.04)."), `${c.label} (${shape}): ${msg.body}`);
    assert.ok(!buildNightChargeMessage(base, shape, null, null, 'supervised').body.includes('panel\'s readings'), `${c.label}: not on the Cores' band`);
  }
});

/* ══ a refused night is v1.203.0's, but for the sentence and the pvBasis* fields ══════════════════════════════════════════ */

test('★★★ a refused night: every field of v1.203.0\'s cushion-only plan is deep-equal but the rationale\'s one appended sentence and the pvBasis* fields; the push and the card carry the reason', () => {
  const c = legacyIdentityCases().find((x) => x.label === '2026-10-12 resilience')!;
  const v1203 = computeNightChargePlan(buildNightChargeInputs(darkDeps(c.deps, 'held')));
  assert.ok(v1203.cushionOnly != null && v1203.basisComplete);
  const sel = selectPvBasis(input({ planning: { asOfDay: E, keys: KEYS, verdict: verdict('refused', BALANCE), gate: PASS_GATE } }));
  // The selector passes the published deps exactly; the panel reason reaches only a refused plan's basisBlockedBy.
  const p = computeNightChargePlan(buildNightChargeInputs({ ...darkDeps(c.deps, 'held'), bandCoverageRefusedBy: sel.bandCoverageRefusedBy, panelBasisRefusal: pvBasisReasonText(sel.reason!) }));
  assert.deepEqual(p, v1203, 'the deps are v1.203.0\'s exactly: the panel reason never reaches a cushion-only plan\'s refusedBy');
  const d = pvBasisDecoration({ sel, asOfDay: E, plan: { sized: true, cushionOnly: true }, calScoredDays: 0, admittedDays: null })!;
  const out = withPvBasis(p, d) as NightChargePlan;
  assert.equal(out.rationale, v1203.rationale + pvBasisRefusedText(BALANCE));
  const strip = (x: NightChargePlan) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'rationale' && !k.startsWith('pvBasis')));
  assert.deepEqual(strip(out), strip(v1203));
  assert.equal(out.pvBasis, null);
  assert.deepEqual(out.pvBasisRefusedBy, BALANCE);
  assert.deepEqual(out.pvBasisSlots, PANEL3);
  // The push: the cushion-only basis sentence, then the panel reason.
  const msg = buildNightChargeMessage(out, out.chargeTonight ? 'charge' : 'hold', null, null, 'supervised');
  assert.ok(msg.body.includes(` Panel solar not used: ${pvBasisReasonText(BALANCE)}.`), msg.body);
  // The card's sizing line shows the server's sentence word for word.
  assert.equal(out.pvBasisText, pvBasisRefusedText(BALANCE));
  const card = out.chargeTonight ? web.sizingLine(out as never) : web.holdSummary(out as never).detail;
  assert.ok(card != null && card.endsWith(pvBasisRefusedText(BALANCE)), String(card));
  // A refused plan with no cushion-only fallback (advisory): the reason in its basisBlockedBy, for the "no plan tonight" push.
  const adv = computeNightChargePlan(buildNightChargeInputs({ ...darkDeps(c.deps, 'held', { eligible: false }), panelBasisRefusal: pvBasisReasonText({ code: 'advisory' }) }));
  assert.equal(adv.basisComplete, false);
  assert.match(adv.basisBlockedBy!, /; the panel's own solar readings are not used: the add-on is in advisory mode \(a plan on the panel's readings is made only in a write mode\)$/);
  const noPlan = buildNightChargeMessage(adv, 'insufficient_basis', null, null, 'advisory');
  assert.ok(noPlan.body.includes("the panel's own solar readings are not used: the add-on is in advisory mode"), noPlan.body);
});

/* ══ L6 — Home Assistant ═════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ L6: ecoflow_night_charge_target_soc carries exactly pv_basis and pv_basis_refused_by, from the state topic, under the night-charge freshness', () => {
  const s = SENSORS.find((x) => x.unique_id === 'ecoflow_night_charge_target_soc')!;
  assert.equal(s.json_attributes_template, NIGHT_CHARGE_ATTRIBUTES_TEMPLATE);
  const keys = [...NIGHT_CHARGE_ATTRIBUTES_TEMPLATE.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['pv_basis', 'pv_basis_refused_by'], 'json_attributes is an allowlist: exactly these two');
  const cfg = sensorDiscoveryConfig(s);
  assert.equal(cfg.json_attributes_topic, 'ecoflow_panel/state');
  assert.equal(cfg.unique_id, 'ecoflow_night_charge_target_soc');
  assert.equal(cfg.value_template, '{{ value_json.night_charge_target_soc_percent }}', 'the state is unchanged');
  // The payload keys, under the same freshness nulling.
  const now = Date.now();
  const base = { generatedAt: now, basisComplete: true, chargeTonight: true, setpointSocPct: 50, targetSocPct: 60, buyKwh: 10, window: null } as unknown as NightChargePlan;
  assert.equal(nightChargeStateFields({ ...base, pvBasis: 'panel', pvBasisAsOfDay: E } as NightChargePlan, now).night_charge_pv_basis, 'panel');
  const refused = nightChargeStateFields({ ...base, cushionOnly: { refusedBy: 'x', transient: false, gapAfterMs: 0, longGapAfter: false }, pvBasis: null, pvBasisAsOfDay: E, pvBasisRefusedBy: BALANCE } as NightChargePlan, now);
  assert.equal(refused.night_charge_pv_basis, 'none');
  assert.equal(refused.night_charge_pv_basis_refused_by, 'balance');
  assert.equal(nightChargeStateFields(base, now).night_charge_pv_basis, 'cores', 'a plan the selection put nothing on: the Cores\' band');
  const stale = nightChargeStateFields({ ...base, pvBasis: 'panel', generatedAt: now - 13 * H } as NightChargePlan, now);
  assert.equal(stale.night_charge_pv_basis, null);
  assert.equal(stale.night_charge_pv_basis_refused_by, null);
  assert.equal(nightChargeStateFields(null, now).night_charge_pv_basis, null);
});

/* ══ L5 — the ledger ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ L5: a panel row\'s PV actual is the per-slot resolver (the panel\'s reading for a P slot, the Core\'s meter for a C slot) at the coverage minimum; its note says passed as of its evening with the stored ratio', () => {
  const span = { startMs: 0, endMs: 24 * H };
  const flat = (w: number) => Array.from({ length: 24 * 12 + 1 }, (_, i) => ({ ts: i * 300_000, value: w }));
  const q = (sn: string, metric: string) => (sn === 'PANEL' ? flat(metric === 'src2_pv_w' ? 0 : 1000) : flat(500));
  const r = panelRowPvActual({ slots: '1:P,2:P,3:C', span, panelSn: 'PANEL', coreOfSlot: (s) => (s === 3 ? 'CORE3' : null), query: q, minCoverage: 0.9 });
  assert.deepEqual(r, { kwh: 36, basis: '1:P,2:P,3:C', worstCoverage: 1, why: null });
  assert.equal(panelRowPvActual({ slots: '1:P,2:N', span, panelSn: 'PANEL', coreOfSlot: () => null, query: q, minCoverage: 0.9 }).kwh, null);
  assert.equal(panelRowPvActual({ slots: '1:P,3:C', span, panelSn: 'PANEL', coreOfSlot: () => null, query: q, minCoverage: 0.9 }).kwh, null, 'a C slot with no Core connected: withheld');
  const thin = panelRowPvActual({ slots: '1:P', span, panelSn: 'PANEL', coreOfSlot: () => null, query: () => flat(1000).slice(0, 100), minCoverage: 0.9 });
  assert.equal(thin.kwh, null);
  assert.match(thin.why!, /worst per-slot PV coverage 0\.\d\d < 0\.9/);
  const note = panelPvActualNote({ plan_date: '2026-11-05', pv_upper_ratio: 1.0041 }, '1:P,2:P,3:C', null, { state: 'admitted', asOfDay: '2026-11-07' });
  assert.equal(note, " PV actual is the panel's own per-slot reading for slots 1 and 2; the Core's own meter for slot 3, on days the 7-day energy balance passed as of 2026-11-07 (the newest evening it had judged as of when the row was captured). The plan's own 7-day energy balance read 1.0041 as of 2026-11-05, the evening it was made. The row is kept apart from the readiness gate's sizing figures.");
  assert.match(panelPvActualNote({ plan_date: '2026-11-05', pv_upper_ratio: null }, '1:P', 'held telemetry over the span'), /^ PV actual withheld \(held telemetry over the span\)\. The row is kept apart/);
  // pvVerdictSetAside takes the panel rule FIRST — even where the keys would match the actuals.
  assert.equal(pvVerdictSetAside('A,B,C', ['A', 'B', 'C'], 'panel'), panelPvVerdictSetAside('panel'));
  assert.equal(pvVerdictSetAside('A,B,C', ['A', 'B', 'C'], 'cores'), null);
  assert.equal(pvVerdictSetAside('A,B,C', ['A', 'B', 'C']), null, 'absent: the rule as before');
  assert.ok(isPanelBasisRow({ pv_basis: 'mixed' }) && isPanelBasisRow({ pv_basis: null, actual_pv_basis: '1:P,2:C' }) && !isPanelBasisRow({ pv_basis: 'cores' }));
  // The columns: the row type, the allowlist and the idempotent migration, each once.
  const rec = readFileSync(resolve(HERE, '../src/recorder.ts'), 'utf8');
  for (const [col, type] of [['pv_basis', 'TEXT'], ['pv_basis_slots', 'TEXT'], ['pv_basis_refused_by', 'TEXT'], ['pv_upper_ratio', 'REAL'], ['actual_pv_basis', 'TEXT']]) {
    assert.ok(rec.includes(`'${col} ${type}'`), `${col}: migrated`);
    assert.ok(new RegExp(`\\n  ${col}: (string|number) \\| null;`).test(rec), `${col}: on the row`);
  }
  assert.ok(rec.includes("'pv_basis', 'pv_basis_slots', 'pv_basis_refused_by', 'pv_upper_ratio', 'actual_pv_basis',"), 'allowlisted');
  assert.match(INDEX, /pv_basis: extras\.pvSelection\?\.pvBasis \?\? null,\n\s+pv_basis_slots: extras\.pvSelection\?\.pvBasisSlots \?\? null,\n\s+pv_basis_refused_by: extras\.pvSelection\?\.pvBasisRefusedBy \?\? null,\n\s+pv_upper_ratio: extras\.pvSelection\?\.pvUpperRatio \?\? null,/);
  const gate = readFileSync(resolve(HERE, '../src/nightChargeGate.ts'), 'utf8');
  assert.ok(gate.includes('export const CURRENT_ALGO_VERSION = 3;'), 'CURRENT_ALGO_VERSION stays 3');
});

test('★★★ L5: a panel row\'s PV actual waits for the energy balance to judge its span\'s last day (pending, captured with the PV-independent columns; re-captured once judged), is admitted only on admitted slot-days, and is withheld on a day the balance did not pass', () => {
  // The 11-05 row: issued 11-05 21:30, span to 11-06 21:30 (days 11-05 and 11-06). Its last day's daily total comes in 11-07 06:35-09:00.
  const issued = siteDayStartMs('2026-11-05') + (21 * 60 + 30) * 60_000;
  const span = { startMs: issued, endMs: issued + FORECAST_SPAN_MS };
  assert.deepEqual(spanSiteDays(span), ['2026-11-05', '2026-11-06']);
  const at9 = siteDayStartMs('2026-11-07') + 9 * H;
  const adm = (asOfDay: string, builtAtMs: number, days: Record<string, string[]>) => ({ asOfDay, builtAtMs, slotDays: days });
  const both = { 1: ['2026-11-04', '2026-11-05', '2026-11-06'], 2: ['2026-11-05', '2026-11-06'], 3: ['2026-11-05', '2026-11-06'] };
  // No report read; one as of the plan's own evening; one as of 11-07 built before 09:00 (the daily total may not be in): pending.
  assert.equal(panelPvAdmission({ basis: '1:P,2:P,3:P', span, admission: null }).state, 'pending');
  assert.equal(panelPvAdmission({ basis: '1:P,2:P,3:P', span, admission: adm('2026-11-06', at9 + H, both) }).state, 'pending', 'as of 11-06: 11-06 itself is not judged');
  assert.equal(panelPvAdmission({ basis: '1:P,2:P,3:P', span, admission: adm('2026-11-07', at9 - 1, both) }).state, 'pending', 'built before 09:00 the morning after');
  const p = panelPvAdmission({ basis: '1:P,2:P,3:P', span, admission: null });
  assert.deepEqual(p, { state: 'pending', lastDay: '2026-11-06', judgeFromMs: at9 });
  // Judged: admitted on every P slot's every span day; withheld on the first day a slot was not passed.
  assert.deepEqual(panelPvAdmission({ basis: '1:P,2:P,3:P', span, admission: adm('2026-11-07', at9, both) }), { state: 'admitted', asOfDay: '2026-11-07' });
  assert.deepEqual(panelPvAdmission({ basis: '1:P,2:P,3:P', span, admission: adm('2026-11-07', at9, { ...both, 2: ['2026-11-05'] }) }),
    { state: 'withheld', asOfDay: '2026-11-07', slot: 2, day: '2026-11-06' });
  // A C slot needs no admission (its Core's own meter): slot 3 on its Core, slot 3's days absent, admitted.
  assert.equal(panelPvAdmission({ basis: '1:P,2:P,3:C', span, admission: adm('2026-11-08', at9 + 86_400_000, { 1: both[1], 2: both[2] }) }).state, 'admitted');
  // The notes: pending carries the marker the re-capture finds; withheld names the slot-day and the evening; both say kept apart.
  const pendingNote = panelPvActualNote({ plan_date: '2026-11-05', pv_upper_ratio: 1.0041 }, '1:P,2:P,3:P', null, p);
  assert.ok(pendingNote.includes(PANEL_PV_PENDING_MARKER));
  assert.equal(pendingNote, ` ${PANEL_PV_PENDING_MARKER}: 2026-11-06 is judged no earlier than 9:00 the next morning, once its daily total from the panel's own ledger is in, and the row is re-captured once the night planner has read that judgement. The plan's own 7-day energy balance read 1.0041 as of 2026-11-05, the evening it was made. The row is kept apart from the readiness gate's sizing figures.`);
  assert.equal(panelPvActualNote({ plan_date: '2026-11-05', pv_upper_ratio: null }, '1:P,2:P', null, { state: 'withheld', asOfDay: '2026-11-07', slot: 2, day: '2026-11-06' }),
    " PV actual withheld — slot 2's 2026-11-06 was not passed by the 7-day energy balance as of 2026-11-07. The row is kept apart from the readiness gate's sizing figures.");
  // The re-capture: a captured pending panel row, once judgeable, inside the horizon; never a row without the marker or a Core row.
  const row = { pv_basis: 'panel', pv_basis_slots: '1:P,2:P,3:P', actual_pv_basis: '1:P,2:P,3:P', outcome_captured_at_ms: issued + FORECAST_SPAN_MS, score_notes: `x.${pendingNote}`, issued_at_ms: issued };
  const horizon = 28 * 86_400_000;
  assert.equal(panelPvRecaptureDue(row, adm('2026-11-07', at9 - 1, both), at9, horizon), false, 'still pending: left as captured');
  assert.equal(panelPvRecaptureDue(row, adm('2026-11-07', at9, both), at9, horizon), true);
  assert.equal(panelPvRecaptureDue({ ...row, score_notes: 'x' }, adm('2026-11-07', at9, both), at9, horizon), false, 'no marker: not pending');
  assert.equal(panelPvRecaptureDue({ ...row, pv_basis: 'cores', actual_pv_basis: null }, adm('2026-11-07', at9, both), at9, horizon), false);
  assert.equal(panelPvRecaptureDue({ ...row, outcome_captured_at_ms: null }, adm('2026-11-07', at9, both), at9, horizon), false, 'not captured yet: the loop captures it');
  assert.equal(panelPvRecaptureDue(row, adm('2026-11-07', at9, both), issued + horizon + 1, horizon), false, 'past the re-capture horizon: kept');
  const reset = panelPvRecaptureColumns('2026-11-07');
  assert.equal(reset.outcome_captured_at_ms, null);
  assert.equal(reset.actual_pv_kwh, null);
  assert.ok(!String(reset.score_notes).includes(PANEL_PV_PENDING_MARKER), 'the reset note carries no marker (the re-capture writes the verdict)');
  // index.ts: the memo from the planning report as of the E asked; the scorer reads it; the sweep resets a pending row before the loop.
  assert.match(INDEX, /notePanelAdmission\(probPlanning, pvAsOfDay, nowMs\);/);
  assert.match(INDEX, /panelAdmission = panelPvAdmission\(\{ basis: panelPv\.basis, span: \{ startMs: fcSpanStart, endMs: fcSpanEnd \}, admission: panelAdmissionMem \}\);\n\s+actualPvKwh = held \|\| panelAdmission\.state !== 'admitted' \? null : panelPv\.kwh;/);
  const sweep = INDEX.slice(INDEX.indexOf('function scoreCompletedNights('), INDEX.indexOf('function scoreNightRow('));
  assert.ok(sweep.indexOf('repairPendingPanelPv(rows, nowMs)') > 0 && sweep.indexOf('repairPendingPanelPv(rows, nowMs)') < sweep.indexOf('ledgerRowsDueForCapture('));
  assert.match(INDEX, /if \(m != null && \(asOfDay < m\.asOfDay \|\| \(asOfDay === m\.asOfDay && builtAtMs <= m\.builtAtMs\)\)\) return;/, 'never regresses to an earlier evening');
});

/* ══ readiness ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ readiness: panel/mixed rows are kept apart from the actuated pool, the under-buy rate and the PV statistics; their strikes count, and a panel night cannot clear one', () => {
  const NOW = Date.UTC(2026, 10, 20, 4, 30);
  const dayMs = 86_400_000;
  const ymd = (d: number) => new Date(NOW - d * dayMs - 7 * H).toISOString().slice(0, 10);
  const row = (d: number, f: Record<string, unknown> = {}): NightLedgerRow => ({
    plan_date: ymd(d), algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast',
    issued_at_ms: NOW - d * dayMs, outcome_captured_at_ms: NOW - (d - 1) * dayMs,
    scored: 1, actuated: 1, cushion_shortfall: 0, plan_traj_floor_breached: 0, cushion_breached: 0,
    min_proj_soc_pct: 40, actual_min_soc_pct: 45, buy_err_kwh: 2, cushion_trough_soc_pct: 40, cushion_line_soc_pct: 30,
    pv_err_frac: 0.05, load_err_frac: -0.1, pv_in_band: 1, load_in_band: 1, grid_home_coverage_frac: 0.97, ...f,
  } as unknown as NightLedgerRow);
  const cores = [10, 9, 8, 7].map((d) => row(d));
  const panel = [6, 5, 4, 3].map((d) => row(d, { pv_basis: 'panel', buy_err_kwh: -3, pv_in_band: 0 }));
  // One more panel night that bought enough (buy_err +2): apart, but no under-buy in the diagnostic.
  const r = computeNightChargeReadiness([...cores, ...panel, row(2, { pv_basis: 'mixed', buy_err_kwh: 2 })], NOW);
  assert.equal(r.metrics.actuatedNights, 4, 'the panel nights are not in the actuated pool');
  assert.equal(r.metrics.underBuyRate, 0, 'nor in the under-buy rate (each reads −3 kWh)');
  assert.equal(r.metrics.pvBandCoverage, 1, 'nor in the PV statistics');
  assert.equal(r.metrics.panelApartNights, 5);
  assert.equal(r.metrics.panelBasisUnderBuyNights, 4, 'the diagnostic says what they would show: the four under-buys, not the fifth');
  // A strike on a panel night counts; panel nights after it cannot clear it.
  const struck = [...cores, row(6, { pv_basis: 'panel', cushion_trough_soc_pct: 20, cushion_line_soc_pct: 30, plan_traj_floor_breached: 1 }),
    ...[5, 4, 3, 2, 1].map((d) => row(d, { pv_basis: 'mixed' }))];
  const s = computeNightChargeReadiness(struck, NOW);
  assert.equal(s.metrics.activeStrikes, 1, 'the panel night\'s strike counts');
  assert.equal(s.metrics.strikeFreeStreak, 0, 'and no panel night counts toward clearing it');
  assert.equal(s.state, 'BLOCKED');
  assert.ok(panelApart({ pv_basis: 'panel' }) && panelApart({ actual_pv_basis: '1:P' }) && !panelApart({ pv_basis: 'cores', actual_pv_basis: null }));
});

/* ══ the option texts ═══════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★ the option texts: while the Cores are dark a write-mode plan takes the panel\'s readings once 7 whole days of them pass the checks; advisory never; the refused basis keeps v1.203.0\'s cushion-only rules; the long-gap target is the lower of the ceiling and full less the P10 pre-peak surplus (en, es, the options guide, the operator guide)', () => {
  const root = resolve(HERE, '../..');
  const desc = (lang: string, key: string): string => {
    const y = readFileSync(resolve(root, `ecoflow_panel/translations/${lang}.yaml`), 'utf8');
    const at = y.indexOf(`\n  ${key}:\n`);
    assert.ok(at >= 0, `${lang} ${key}`);
    return y.slice(at, y.indexOf('\n  ', y.indexOf('description:', at) + 1));
  };
  const enObj = desc('en', 'ARB_OBJECTIVE');
  assert.ok(enObj.includes("While the Cores are dark on the vendor cloud, a supervised or auto plan takes its solar from the panel''s own per-slot readings of their chargers once 7 whole days of those readings (the newest no more than two days old) have passed the add-on''s checks, and the rules above apply; while the solar basis is refused (no such week yet, or a check fails), a supervised or auto plan is cushion-only"));
  assert.ok(enObj.includes("In advisory mode a refused solar basis means no plan, and the panel''s readings are not used."));
  assert.ok(desc('en', 'ARB_COST_MAX_SOC_PCT').includes("On a night planned on the panel''s readings, Thursday fills as above."));
  // V5: "as above" is the long-gap rule, stated as the median rule beside it is (nightChargeAdvisor: min(this, full − P10 pre-peak
  // surplus), this value with no P10): 90 on 10-29 (7.88 kWh), 81.5 on 11-05 (17.02 kWh) on the record.
  assert.ok(desc('en', 'ARB_COST_MAX_SOC_PCT').includes("the target is this value OR the room the pessimistic (P10) solar surplus expected before the next on-peak needs, whichever is lower (this value when no P10 is known)."));
  assert.ok(!desc('en', 'ARB_COST_MAX_SOC_PCT').includes('the solar room is set aside'));
  const esObj = desc('es', 'ARB_OBJECTIVE');
  assert.ok(esObj.includes('Mientras los Cores no informan a la nube del fabricante, un plan supervised o auto toma su solar de las lecturas que el propio panel hace de sus cargadores en cada ranura'));
  assert.ok(esObj.includes('y las lecturas del panel no se usan.'));
  assert.ok(desc('es', 'ARB_COST_MAX_SOC_PCT').includes('En una noche planificada sobre las lecturas del panel, el jueves llena como se indica arriba.'));
  assert.ok(desc('es', 'ARB_COST_MAX_SOC_PCT').includes('el objetivo es este valor O el espacio que necesita el excedente solar pesimista (P10) previsto antes de la siguiente punta, lo que sea menor (este valor cuando no se conoce el P10).'));
  assert.ok(!desc('es', 'ARB_COST_MAX_SOC_PCT').includes('se deja de lado el espacio solar'));
  const guide = readFileSync(resolve(root, 'docs/guide/options.md'), 'utf8');
  assert.ok(guide.includes("a `supervised` or `auto` plan takes its solar from the panel's own per-slot readings of their chargers once 7 whole days of those readings (the newest no more than two days old) have passed the add-on's checks"));
  assert.ok(guide.includes("On a night planned on the panel's readings, Thursday, before a long gap, fills toward the lower of it and full less the pessimistic (P10) solar surplus expected before the next on-peak (toward it when no P10 is known)."));
  const docs = readFileSync(resolve(root, 'ecoflow_panel/DOCS.md'), 'utf8');
  assert.ok(docs.includes('The runway alarm still counts no sun from a Core that does not\nreport its own.'));
});

/* ══ the wiring (index.ts source pins) ═══════════════════════════════════════════════════════════════════════════════════ */

test('★★★ wiring: the window resolved first; E asked of both planning reports in the same Promise.all as the published ones; one devs snapshot; every read takes the selected band; never a shadow leg', () => {
  const fn = INDEX.slice(INDEX.indexOf('async function recomputeNightChargePlan('), INDEX.indexOf('function armedExpectedBuyKwh('));
  const iWindow = fn.indexOf('const window = shadowLeg ? (shadowLeg.spec.window ?? null)');
  const iReports = fn.indexOf("analytics.report<ProbabilisticForecast>('probabilisticForecast')");
  assert.ok(iWindow > 0 && iReports > iWindow, 'the window before the reports');
  const all = fn.slice(fn.indexOf('await Promise.all(['), fn.indexOf(']);', fn.indexOf('await Promise.all([')));
  assert.ok(all.includes("analytics.report<PlanningProbabilisticReport | null>('planningProbabilisticForecast', { asOfDay: pvAsOfDay! })"));
  assert.ok(all.includes("'multiDayForecast', { days: 4, basis: 'planning', asOfDay: pvAsOfDay! }"));
  assert.match(fn, /const pvLatchHere = shadowLeg \|\| window == null \? null : latchedPvBasis\(\{/);
  assert.match(fn, /const pvAsOfDay: string \| null = shadowLeg \? null : planAsOfDay\(\{\n\s+arming: opts\.arming === true, todayYmd: siteYmd\(nowMs\), latched: pvLatchHere,/);
  assert.match(fn, /const pvAsk = pvAsOfDay != null && pvWriteMode && panel\.fresh && !pvCancelled;/);
  assert.match(fn, /const pvSel: PvSelection \| null = shadowLeg \? null : selectPvBasis\(\{/);
  // F1: the evening job's own call selects on no latch; every other recompute on the window's.
  assert.match(fn, /\n\s+latched: opts\.arming === true \? null : pvLatchHere,\n/);
  // M1: the plan date that will own the window (never the site day now: a recompute at 00:30 with no latch keeps the evening's E).
  assert.match(fn, /planDate: window == null \? siteYmd\(nowMs\)\n\s+: planDateOwningCycle\(\{ nowMs, firstLegStartMs: window\.startMs, timezone: siteTimeZone\(\), notifyMinuteOfDay: nightSched\.notify\.fireMin \}\),\n\s+\}\);/);
  // M2: the coverage refusal reaches the planner; L1/G4: the hour's force-charge from the armed record; L5: the window ratio stored.
  assert.match(fn, /\n\s+bandCoverageRefusedBy: pvSel\?\.bandCoverageRefusedBy \?\? null,\n/);
  assert.match(fn, /hourClock: fmtSiteClock\(pvSel\.reason\.hourStartMs\), forceCharge: forceChargeStateAt\(pvSel\.reason\.hourStartMs\) \}/);
  assert.match(INDEX, /pvUpperRatio: v != null && !sel\.published \? \(v\.checks\.ratio \?\? null\) : null,/);
  assert.match(fn, /const prob: ProbabilisticForecast \| null = pvPlanning \? probPlanning : probPublished;\n\s+const multiDay: MultiDayForecast \| null = pvPlanning \? multiDayPlanning : multiDayPublished;/);
  // The connected slots come from the one devs snapshot the planner read (sp = shp2.projection of `devs`).
  assert.match(fn, /const houseSlots = \(Array\.isArray\(sp\.sources\) \? sp\.sources : \[\]\)/);
  assert.equal(fn.split('store.get()').length - 1, 1, 'one device snapshot');
  // No published-band name is read after the selection but through the selected one.
  const iSel = fn.indexOf('const multiDay: MultiDayForecast | null = pvPlanning');
  const after = fn.slice(fn.indexOf('\n', iSel));
  assert.doesNotMatch(after, /probPublished|multiDayPublished/);
  // The evening latches its basis.
  assert.match(INDEX, /pv: pvLatchOf\(fresh, today\),\n\s+\}\); \/\/ latch AFTER a successful send/);
  assert.match(INDEX, /writeNightChargeLatch\(\{ lastNotifyDay: today, pv: pvLatchOf\(fresh, today\) \}\);/);
  // The selection never reaches a shadow leg (the mid-day, backup and refresh legs), nor the armed record.
  assert.match(fn, /\.\.\.\(pvSel != null && pvAsOfDay != null \? \{ pvSelection: pvSelectionExtras\(pvSel, pvReason, pvAsOfDay\) \} : \{\}\),/);
  assert.doesNotMatch(INDEX.slice(INDEX.indexOf('function armCycle'), INDEX.indexOf('function armCycle') + 1) + readFileSync(resolve(HERE, '../src/chargeCycle.ts'), 'utf8'), /pvBasis|panelPvSelection/);
});

test('★★ the runway never reads the planning layer: computeRunway and the alarms take hours[].forecastPvW of the published forecast only', () => {
  const an = readFileSync(resolve(HERE, '../src/analytics.ts'), 'utf8');
  const runway = an.slice(an.indexOf('export function computeRunway('), an.indexOf('\n}\n', an.indexOf('export function computeRunway(')));
  assert.ok(runway.length > 1000);
  assert.doesNotMatch(runway, /planningHours|planningSolarModel|planningPv|planningVerdict|getPlanningForecast|PlanningForecast|panelPvBasis|UcVerdict/);
  assert.ok(bandCoverageRefusalText([2]) === "the Cores' solar band leaves out the Core of slot 2");
  assert.equal(addDaysYmd(E, -1), '2026-10-28');
});
