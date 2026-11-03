import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nfc from '../src/nightForceCharge.js';
import { decideForceCharge, type ForceChargeOpts } from '../src/nightForceCharge.js';
import { coerceActuationState, emptyActuationState, type NightActuationState } from '../src/nightChargeActuator.js';
import * as notify from '../src/notify.js';
import { buildNightChargeApplyFailure, buildNightChargeMorningSummary, buildNightForceChargeOnFailure } from '../src/notify.js';

/**
 * v1.200.0 (review round 2) — A LINE NIGHT THAT LOSES ITS LINE AFTER THE START IS PUSHED WHILE A PERSON CAN
 * STILL ACT, AND NO LINE-NIGHT TEXT SAYS "NO ACTION NEEDED" OR IMPLIES A LINE THAT DID NOT HOLD.
 *
 * Evidence (the lead's record check): the panel switching each slot OFF at its ceiling is MEASURED (2026-09-23
 * ch1 04:19 / ch3 04:30; 2026-10-02 slots 2 and 1 at 04:24-04:25, read with the panel-side classifier). A slot
 * that keeps reading ON at its ceiling and stops importing (the ON-READING latch) is UNMEASURED on this plant:
 * 2026-09-18's "Charge Now still ON" is the add-on's own record (no OFF sent before 05:00), not a readback. So
 * no new write pattern rests on it; it is covered by a push, a one-time observation log and pinned counts.
 *
 *  W1 — the "line at risk" push (lineAtRiskPushDue): once a night, write-ahead, on a night whose record carries
 *       a line ask (line mode, or COST-DOMINANT), after a verified ON, before the window close less
 *       FORCE_CHARGE_LINE_AT_RISK_LEAD_MS, when a fresh coherent pool reads under the night's start target
 *       (⌈L⌉ + H on a cost-dominant night), is not rising against a reading ≥ FORCE_CHARGE_LINE_TREND_MS older,
 *       and the add-on cannot act itself (no re-ON due, none in its readback grace). And the one-time log of
 *       the ON-reading shape (lineOnReadingShape).
 *  W2 — a line re-ON is readback-checked FORCE_CHARGE_ON_VERIFY_AFTER_MS after it, like the first ON.
 *  W3 — the morning account of a line-ask night: under the line said so; an unread close said so; the panel's
 *       own stop and the re-ONs named. A cost night with no line ask reads word for word as v1.199.1.
 *  W4 — lineCeilingLoweringDue lowers only what the panel holds (never a raise, also under red vitals).
 *  W5 — (#1) a cost-dominant line night's ON failure and declined start speak for the line; (#9) the declined-
 *       start push is once a night per class ACROSS RESTARTS; (#6) the reserve-apply failure on a line night.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const TICK = INDEX.slice(INDEX.indexOf('async function runForceChargeTick('), INDEX.indexOf('async function escalateForceChargeStuck('));
/** The pushes and the morning account of a COST night (no line ask) as v1.199.1 wrote them (captured before
 *  this change from the same builders and inputs): word for word. */
const COST_TEXTS = JSON.parse(readFileSync(resolve(HERE, 'fixtures/lineNightCostTexts.v1199.json'), 'utf8')) as Record<string, string>;
const H = 3_600_000;
const M = 60_000;
const WIN_START = Date.UTC(2026, 8, 17, 6, 0); // 23:00 MST
const WIN_END = WIN_START + 6 * H;             // 05:00 MST

type S = NightActuationState;
const night = (over: Record<string, unknown> = {}): S => ({
  ...emptyActuationState(),
  day: '2026-09-16', targetPct: 50, buyKwh: 28,
  windowStartMs: WIN_START, windowEndMs: WIN_END,
  applyAttemptedAtMs: WIN_START - 5 * M, attemptBaselinePct: 30,
  appliedAtMs: WIN_START - 5 * M, priorReservePct: 30,
  applyVerifiedAtMs: WIN_START + M,
  forceChargeCeilingPct: null, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55,
  forceChargeCeilingSyncedPct: null, forceChargeMode: null, forceChargeRides: true,
  ...over,
} as S);
const onNight = (over: Record<string, unknown> = {}): S => night({
  forceChargeOnAtMs: WIN_START + 2 * H, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: WIN_START + 2 * H + 5 * M,
  forceChargeOnLastAttemptMs: WIN_START + 2 * H, forceChargeMode: 'line', forceChargeCeilingSyncedPct: 80, ...over,
});
const fo = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: false, lineEnabled: true, gridPresent: true, gridStaLost: false,
  slotsOn: [], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 80, poolSocPct: 50, fullKwh: 92.16, chargeRateKw: 14,
  ...over,
} as ForceChargeOpts);
const at = (pct: number) => ({ 1: pct, 2: pct, 3: pct });

/* ══ W4 — the line ceiling lowering lowers only what the panel holds ═════════════════════════════════════ */

test('★★★ W4 lineCeilingLoweringDue: a write only when the panel reads ABOVE the line mode\'s ceiling; never a raise, also under red vitals', () => {
  // The reviewer's probe: ON in cost mode (c 90, ask 75: cost-dominant), synced 90, the panel's own 100; the cost
  // gate then off ⇒ line mode, ceiling desired(max(75, 85)) = 85. The panel reads 80 (lowered in the app): writing
  // 85 would RAISE it — under red vitals, a new grid-charge reach. Nothing.
  const s = onNight({ forceChargeCeilingPct: 90, forceChargeLineAskPct: 75, forceChargeLinePct: 74.2, forceChargeMode: 'cost',
    forceChargeCeilingAttemptedAtMs: WIN_START + 10 * M, forceChargeCeilingPriorPct: 100, forceChargeCeilingSyncedPct: 90 });
  const off = (rb: number | null, over: Partial<ForceChargeOpts> = {}) => fo({ enabled: false, poolSocPct: 70, slotsOn: [1, 2, 3], slotSocPct: at(70), ceilingReadbackPct: rb, ...over });
  assert.equal(nfc.forceChargeModeOf(s, { cost: false, line: true })?.panelCeilingPct, 85);
  assert.equal(nfc.lineCeilingLoweringDue(s, off(80, { vitalsRed: true })), null);
  assert.deepEqual(decideForceCharge(s, WIN_END - H, off(80, { vitalsRed: true })), { kind: 'none' });
  assert.equal(nfc.lineCeilingLoweringDue(s, off(80)), null, 'at or under the mode\'s ceiling: nothing to lower');
  assert.equal(nfc.lineCeilingLoweringDue(s, off(85)), null);
  // The panel holds 90 > 85: lowered to 85, the restore keeping the panel's own 100 — and under red vitals too
  // (a lowering is the safe direction).
  assert.deepEqual(nfc.lineCeilingLoweringDue(s, off(90)), { kind: 'syncCeiling', pct: 85, prior: 100 });
  assert.deepEqual(decideForceCharge(s, WIN_END - H, off(90, { vitalsRed: true })), { kind: 'syncCeiling', pct: 85, prior: 100 });
  // A readback outside the panel's documented 80..100 is no ceiling.
  for (const rb of [null, 70, 79, 101, Number.NaN]) assert.equal(nfc.lineCeilingLoweringDue(s, off(rb)), null, String(rb));
  // One write: once stamped at the mode's ceiling it never repeats, whatever the panel reads.
  assert.equal(nfc.lineCeilingLoweringDue({ ...s, forceChargeCeilingSyncedPct: 85 }, off(90)), null);
  // Only a ceiling the add-on itself synced ABOVE the mode's is lowered: a night synced under the mode's 88 (ask 78)
  // whose panel reads 100 (raised in the app) is left alone — writing 88 would raise it past our own 80.
  assert.equal(nfc.lineCeilingLoweringDue(onNight({ forceChargeLineAskPct: 78, forceChargeLinePct: 77.1, forceChargeCeilingSyncedPct: 80 }), off(100)), null);
});

/* ══ W2 — a line re-ON is readback-checked like the first ON ════════════════════════════════════════════ */

test('★★★ W2 the re-ON readback check: FORCE_CHARGE_ON_VERIFY_AFTER_MS after it, slots still OFF ⇒ "did not take effect"', () => {
  const t0 = WIN_END - 2 * H;
  const reOn = onNight({ forceChargeLineReOns: 1, forceChargeLineReOnAtMs: t0, forceChargeLineReOnSlots: [1, 2, 3] });
  const o = (slotsOn: number[] | null, over: Partial<ForceChargeOpts> = {}) => fo({ poolSocPct: 58, slotsOn, slotSocPct: at(58), ...over });
  // Inside the grace: wait.
  assert.equal(decideForceCharge(reOn, t0 + 15 * M - 1, o([])).kind, 'none');
  // At the grace: the check, before any second re-ON.
  assert.deepEqual(decideForceCharge(reOn, t0 + 15 * M, o([])), { kind: 'lineReOnChecked', slots: [1, 2, 3], notApplied: [1, 2, 3] });
  assert.deepEqual(decideForceCharge(reOn, t0 + 15 * M, o([1, 3])), { kind: 'lineReOnChecked', slots: [1, 2, 3], notApplied: [2] });
  assert.deepEqual(decideForceCharge(reOn, t0 + 15 * M, o([1, 2, 3])), { kind: 'lineReOnChecked', slots: [1, 2, 3], notApplied: [] });
  // A stale readback decides nothing (absence is not evidence either way).
  assert.notEqual(decideForceCharge(reOn, t0 + 15 * M, o(null)).kind, 'lineReOnChecked');
  // A Core already at the panel's stop ceiling is exempt (the panel switched it off again) — but not when none reads ON.
  assert.deepEqual(decideForceCharge(reOn, t0 + 15 * M, o([1], { slotSocPct: { 1: 60, 2: 80, 3: 58 } })), { kind: 'lineReOnChecked', slots: [1, 2, 3], notApplied: [3] });
  assert.deepEqual(decideForceCharge(reOn, t0 + 15 * M, o([], { slotSocPct: at(80) })), { kind: 'lineReOnChecked', slots: [1, 2, 3], notApplied: [1, 2, 3] });
  // Checked once: then the budget's second re-ON may follow (the slots still read OFF, the pool under 61).
  const checked = { ...reOn, forceChargeLineReOnCheckedAtMs: t0 + 15 * M, forceChargeLineReOnsNotApplied: 1, forceChargeLineReOnNotAppliedSlots: [1, 2, 3] };
  assert.deepEqual(decideForceCharge(checked, t0 + 16 * M, o([])), { kind: 'lineReOn', slots: [1, 2, 3] });
  // A re-ON whose writes were all rate-limited carries no slots: nothing to check.
  assert.equal(nfc.lineReOnCheckDue({ ...reOn, forceChargeLineReOnSlots: null }, t0 + 15 * M, o([])), null);
  // Never after the OFF.
  assert.notEqual(decideForceCharge({ ...reOn, forceChargeOffAtMs: t0 + 10 * M, forceChargeOffReason: 'gridLoss' }, t0 + 15 * M, o([])).kind, 'lineReOnChecked');
  // The record fields survive a restart, coerced.
  const raw = (o2: Record<string, unknown>) => coerceActuationState(JSON.parse(JSON.stringify({ ...reOn, ...o2 }))) as unknown as Record<string, unknown>;
  assert.deepEqual(raw({}).forceChargeLineReOnSlots, [1, 2, 3]);
  assert.deepEqual(raw({ forceChargeLineReOnSlots: [0, 2, 4, 'x', 3.5] }).forceChargeLineReOnSlots, [2]);
  assert.equal(raw({ forceChargeLineReOnSlots: 'x' }).forceChargeLineReOnSlots, null);
  assert.equal(raw({ forceChargeLineReOnCheckedAtMs: 5 }).forceChargeLineReOnCheckedAtMs, 5);
  assert.equal(raw({ forceChargeLineReOnsNotApplied: 1.7 }).forceChargeLineReOnsNotApplied, 1);
  assert.equal(raw({ forceChargeLineReOnsNotApplied: -2 }).forceChargeLineReOnsNotApplied, 0);
  assert.deepEqual(raw({ forceChargeLineReOnNotAppliedSlots: [2, 9] }).forceChargeLineReOnNotAppliedSlots, [2]);
  const e = emptyActuationState() as unknown as Record<string, unknown>;
  assert.deepEqual([e.forceChargeLineReOnSlots, e.forceChargeLineReOnCheckedAtMs, e.forceChargeLineReOnsNotApplied, e.forceChargeLineReOnNotAppliedSlots], [null, null, 0, null]);
});

test('★★ W2 index.ts: the re-ON stamps its slots write-ahead (a rate-limited one stamps none); the check is persisted', () => {
  const exec = TICK.slice(TICK.indexOf("if (action.kind === 'lineReOn') {"), TICK.indexOf("if (action.kind === 'onFailed') {"));
  const spend = exec.indexOf('forceChargeLineReOnSlots: [...action.slots],');
  const write = exec.indexOf("on: true, source: { ua: 'night-force-charge-line-reon' }");
  assert.ok(spend > 0 && write > spend, 'the slots are on the record before the writes');
  assert.ok(exec.includes('...(allLimited ? { forceChargeLineReOns: Math.max(0, nightActuationMem.forceChargeLineReOns - 1), forceChargeLineReOnSlots: null } : {}),'));
  const chk = TICK.slice(TICK.indexOf("if (action.kind === 'lineReOnChecked') {"), TICK.indexOf("if (action.kind === 'lineReOn') {"));
  assert.ok(chk.length > 0, 'the check has its branch, before the re-ON');
  assert.ok(chk.includes('forceChargeLineReOnCheckedAtMs: nowMs,'));
  assert.ok(chk.includes('forceChargeLineReOnNotAppliedSlots: [...action.notApplied],'));
  assert.ok(chk.includes('forceChargeLineReOnsNotApplied: nightActuationMem.forceChargeLineReOnsNotApplied + 1'));
  assert.ok(!chk.includes('setChannelForceCharge'), 'a check writes nothing');
});

/* ══ W1 — the line-at-risk push ══════════════════════════════════════════════════════════════════════════ */

const T = WIN_END - H; // 04:00 MST: 40 min before the at-risk cutoff
/** A latched line night at T: ON verified at 01:05, the panel's 80% ceiling, the pool read 62% 15 min ago. */
const risky = (over: Record<string, unknown> = {}): S => onNight({
  forceChargeLinePoolSamples: [{ pct: 62, atMs: T - 15 * M }, { pct: 60, atMs: T - 5 * M }], ...over,
});
/** The ON-reading shape: the slots still read ON at their Cores' 58%, the pool falling. */
const onReading = (over: Partial<ForceChargeOpts> = {}) => fo({ poolSocPct: 58, slotsOn: [1, 2, 3], slotSocPct: at(58), ...over });
/** The OFF-reading latch, the pool at 58% under the 61% start target. */
const offReading = (over: Partial<ForceChargeOpts> = {}) => fo({ poolSocPct: 58, slotsOn: [], slotSocPct: at(58), ...over });

test('★★★ W1 the constants: the lead before the close is the start\'s own margin; the trend compares a reading ≥ 10 min older', () => {
  assert.equal(nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS, nfc.FORCE_CHARGE_MIN_RUN_MS);
  assert.ok(nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS >= 10 * M);
  assert.equal(nfc.FORCE_CHARGE_LINE_TREND_MS, 10 * M);
});

test('★★★ W1 the pool trend: two samples at most, the newer replaced once it is ≥ 10 min old; the reference is the newest ≥ 10 min older', () => {
  const step = nfc.linePoolSamplesStep;
  const s0 = step(null, 60, T);
  assert.deepEqual(s0, [{ pct: 60, atMs: T }]);
  assert.equal(step(s0, 59, T + 9 * M), s0, 'unchanged (the same array) inside 10 min: nothing to persist');
  const s1 = step(s0, 59, T + 10 * M);
  assert.deepEqual(s1, [{ pct: 60, atMs: T }, { pct: 59, atMs: T + 10 * M }]);
  const s2 = step(s1, 57, T + 21 * M);
  assert.deepEqual(s2, [{ pct: 59, atMs: T + 10 * M }, { pct: 57, atMs: T + 21 * M }]);
  assert.deepEqual(step(s2, 57, T - H), [{ pct: 57, atMs: T - H }], 'a clock that went back restarts the trail');
  const ref = nfc.linePoolReference;
  assert.equal(ref(null, T), null);
  assert.equal(ref(s0, T + 9 * M), null, 'nothing 10 min older yet');
  assert.deepEqual(ref(s0, T + 10 * M), { pct: 60, atMs: T });
  assert.deepEqual(ref(s1, T + 15 * M), { pct: 60, atMs: T }, 'the newer is 5 min old: the older one');
  assert.deepEqual(ref(s1, T + 20 * M), { pct: 59, atMs: T + 10 * M });
  // Coerced on load: finite pairs only, the last two, in time order.
  const raw = (v: unknown) => (coerceActuationState(JSON.parse(JSON.stringify({ ...night(), forceChargeLinePoolSamples: v }))) as unknown as Record<string, unknown>).forceChargeLinePoolSamples;
  assert.deepEqual(raw([{ pct: 60, atMs: 1 }, { pct: 'x', atMs: 2 }, { pct: 58, atMs: 3 }, { pct: 57, atMs: 4 }]), [{ pct: 58, atMs: 3 }, { pct: 57, atMs: 4 }]);
  assert.deepEqual(raw([{ pct: 58, atMs: 9 }, { pct: 60, atMs: 1 }]), [{ pct: 60, atMs: 1 }, { pct: 58, atMs: 9 }]);
  assert.equal(raw('x'), null);
  assert.equal(raw([]), null);
  assert.equal((emptyActuationState() as unknown as Record<string, unknown>).forceChargeLinePoolSamples, null);
});

test('★★★ W1 the observations a line night\'s tick stamps: the pool trail while ON, and the panel\'s own stop', () => {
  const obs = nfc.lineNightObservations;
  // The trail: only on a line-ask night, ON and not yet OFF, on a fresh coherent reading.
  assert.deepEqual(obs(onNight(), T, fo({ poolSocPct: 70, slotsOn: [1, 2, 3], slotSocPct: at(70) })), { forceChargeLinePoolSamples: [{ pct: 70, atMs: T }] });
  assert.equal(obs(onNight({ forceChargeLineAskPct: null, forceChargeLinePct: null, forceChargeMode: 'cost', forceChargeCeilingPct: 90 }), T, fo({ enabled: true, poolSocPct: 70, slotsOn: [1, 2, 3] })), null, 'a cost night: nothing');
  assert.equal(obs(night(), T, fo({ poolSocPct: 70 })), null, 'not ON: nothing');
  assert.equal(obs(onNight({ forceChargeOffAtMs: T - M }), T, fo({ poolSocPct: 70 })), null, 'OFF issued: nothing');
  assert.equal(obs(onNight(), T, fo({ poolSocPct: 70, socCoherent: false, slotsOn: [1, 2, 3] })), null);
  assert.equal(obs(onNight({ forceChargeLinePoolSamples: [{ pct: 70, atMs: T - 5 * M }] }), T, fo({ poolSocPct: 70, slotsOn: [1, 2, 3] })), null, 'unchanged: nothing to persist');
  // The panel's own stop: after the verified ON, every slot of ours reads OFF with a Core at the stop ceiling.
  const latch = (o: Partial<ForceChargeOpts>) => obs(onNight({ forceChargeLinePoolSamples: [{ pct: 80, atMs: T - 5 * M }] }), T, fo({ poolSocPct: 80, ...o }));
  assert.deepEqual(latch({ slotsOn: [], slotSocPct: { 1: 79.5, 2: 80, 3: 78 } }), { forceChargeLinePanelOffAtMs: T });
  assert.deepEqual(latch({ slotsOn: [], slotSocPct: { 1: 79, 2: 79, 3: 78 } }), { forceChargeLinePanelOffAtMs: T }, 'a Core one point under the ceiling still reads as the stop');
  assert.equal(latch({ slotsOn: [3], slotSocPct: at(80) }), null, 'one slot still ON: the charge has not ended');
  assert.equal(latch({ slotsOn: [], slotSocPct: at(70) }), null, 'all OFF with no Core at the ceiling: not the panel\'s stop');
  assert.equal(latch({ slotsOn: null, slotSocPct: null }), null);
  assert.equal(obs(onNight({ forceChargeOnVerifiedAtMs: null, forceChargeLinePoolSamples: [{ pct: 80, atMs: T - 5 * M }] }), T, fo({ poolSocPct: 80, slotsOn: [], slotSocPct: at(80) })), null, 'before the ON verified: the ON verify\'s');
  // Stamped once per episode: again only after a re-ON's readback grace (a second latch).
  const stopped = { forceChargeLinePanelOffAtMs: T - H, forceChargeLinePoolSamples: [{ pct: 80, atMs: T - 5 * M }] };
  assert.equal(obs(onNight(stopped), T, fo({ poolSocPct: 80, slotsOn: [], slotSocPct: at(80) })), null);
  assert.equal(obs(onNight({ ...stopped, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: T - 14 * M }), T, fo({ poolSocPct: 80, slotsOn: [], slotSocPct: at(80) })), null, 'inside the re-ON\'s grace');
  assert.deepEqual(obs(onNight({ ...stopped, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: T - 15 * M }), T, fo({ poolSocPct: 80, slotsOn: [], slotSocPct: at(80) })), { forceChargeLinePanelOffAtMs: T });
  const raw = (v: unknown) => (coerceActuationState(JSON.parse(JSON.stringify({ ...night(), forceChargeLinePanelOffAtMs: v }))) as unknown as Record<string, unknown>).forceChargeLinePanelOffAtMs;
  assert.equal(raw(5), 5);
  assert.equal(raw('5'), null);
});

test('★★★ W1 lineAtRiskPushDue — every way the line is lost after the start, while a person can still act', () => {
  const due = nfc.lineAtRiskPushDue;
  // (a) The ON-READING latch (UNMEASURED here): the slots read ON at their Cores' 58%, the pool falling 62 → 58.
  // decideForceCharge has nothing to do (no slot reads OFF: no re-ON) — the night would close under in silence.
  assert.deepEqual(decideForceCharge(risky(), T, onReading()), { kind: 'none' });
  assert.deepEqual(due(risky(), T, onReading()), {
    cause: 'onNotRising', offSlots: [], onSlots: [1, 2, 3], poolPct: 58, refPct: 62, refAtMs: T - 15 * M,
    thresholdPct: 61, linePct: 55.55, closeAtMs: WIN_END, reOnNotAppliedSlots: null,
  });
  // (b) The OFF-reading latch with the re-ON budget spent.
  const spent = risky({ forceChargeLineReOns: 2, forceChargeLineReOnAtMs: T - H, forceChargeLineReOnSlots: [1, 2, 3], forceChargeLineReOnCheckedAtMs: T - 44 * M, forceChargeLineReOnNotAppliedSlots: [] });
  assert.equal(decideForceCharge(spent, T, offReading()).kind, 'none');
  assert.equal(due(spent, T, offReading())?.cause, 'reOnSpent');
  assert.deepEqual(due(spent, T, offReading())?.offSlots, [1, 2, 3]);
  // (c) …spent on a re-ON that did not take effect.
  const notApplied = { ...spent, forceChargeLineReOnsNotApplied: 1, forceChargeLineReOnNotAppliedSlots: [2] };
  assert.equal(due(notApplied, T, offReading())?.cause, 'reOnNotApplied');
  assert.deepEqual(due(notApplied, T, offReading())?.reOnNotAppliedSlots, [2]);
  // (d) The re-ON's gates hold it (the grid unknown, vitals red, no ceiling readback).
  for (const bad of [{ gridPresent: null }, { vitalsRed: true }, { ceilingReadbackPct: null }] as Array<Partial<ForceChargeOpts>>) {
    assert.equal(decideForceCharge(risky(), T, offReading(bad)).kind, 'none', JSON.stringify(bad));
    assert.equal(due(risky(), T, offReading(bad))?.cause, 'reOnHeld', JSON.stringify(bad));
  }
  // (e) A re-ON that CAN go is the add-on's to make: no push.
  assert.equal(decideForceCharge(risky(), T, offReading()).kind, 'lineReOn');
  assert.equal(due(risky(), T, offReading()), null);
  // (f) A COST-DOMINANT line night (cost 90 ≥ ⌈L⌉ + 10 = 80; cost mode, no re-ON there): the threshold is ⌈L⌉ + 5.
  const costDom = risky({ forceChargeCeilingPct: 90, forceChargeLineAskPct: 70, forceChargeLinePct: 69.4, forceChargeMode: 'cost', forceChargeCeilingSyncedPct: 90,
    forceChargeLinePoolSamples: [{ pct: 76, atMs: T - 15 * M }] });
  const cdo = (pool: number, over: Partial<ForceChargeOpts> = {}) => fo({ enabled: true, poolSocPct: pool, slotsOn: [1, 2, 3], slotSocPct: at(pool), ceilingReadbackPct: 90, ...over });
  assert.equal(nfc.forceChargeModeOf(costDom, { cost: true, line: true })?.kind, 'cost');
  assert.deepEqual(decideForceCharge(costDom, T, cdo(73)), { kind: 'none' });
  assert.equal(due(costDom, T, cdo(73))?.cause, 'costMode');
  assert.equal(due(costDom, T, cdo(73))?.thresholdPct, 75);
  assert.equal(due(costDom, T, cdo(75)), null, 'at ⌈L⌉ + 5: not at risk');
  assert.equal(due(costDom, T, cdo(73, { lineEnabled: false })), null, 'the line gate off (advisory): never');
});

test('★★★ W1 lineAtRiskPushDue — each condition holds it back', () => {
  const due = nfc.lineAtRiskPushDue;
  assert.notEqual(due(risky(), T, onReading()), null, 'precondition');
  const none = (s: S, o: ForceChargeOpts, t: number, why: string) => assert.equal(due(s, t, o), null, why);
  none(risky({ forceChargeLineAskPct: null, forceChargeLinePct: null, forceChargeCeilingPct: 70, forceChargeMode: 'cost' }), onReading({ enabled: true }), T, 'no line ask: never');
  none(risky(), onReading({ lineEnabled: false, enabled: false }), T, 'advisory: never');
  none(risky({ forceChargeOnVerifiedAtMs: null }), onReading(), T, 'the ON not verified (the ON verify owns that)');
  none(risky({ forceChargeOffAtMs: T - M, forceChargeOffReason: 'onPeakGuard' }), onReading(), T, 'an OFF issued');
  none(risky({ forceChargeOnAtMs: null, forceChargeOnVerifiedAtMs: null }), onReading(), T, 'never ON');
  none(risky({ forceChargeLineAtRiskPushedAtMs: T - H }), onReading(), T, 'once a night');
  none(risky(), onReading({ poolSocPct: 61, slotSocPct: at(61) }), T, 'at the start target');
  none(risky(), onReading({ socCoherent: false }), T, 'an incoherent pool');
  none(risky(), onReading({ poolSocPct: null }), T, 'no pool reading');
  none(risky(), onReading({ slotsOn: null }), T, 'no slot readback: no slot to name');
  none(risky({ forceChargeLinePoolSamples: [{ pct: 57, atMs: T - 15 * M }] }), onReading(), T, 'rising (58 > 57)');
  none(risky({ forceChargeLinePoolSamples: [{ pct: 62, atMs: T - 5 * M }] }), onReading(), T, 'no reading 10 min older');
  none(risky({ forceChargeLinePoolSamples: null }), onReading(), T, 'no trail');
  none(risky({ forceChargeLineReOns: 1, forceChargeLineReOnAtMs: T - 15 * M + 1, forceChargeLineReOnSlots: [1, 2, 3], forceChargeLineReOnCheckedAtMs: T - M }), onReading(), T, 'a re-ON in its readback grace is left alone');
  none(risky({ forceChargeOnLastAttemptMs: T - 15 * M + 1 }), onReading(), T, 'the ON\'s own readback grace');
  // The lead: never inside FORCE_CHARGE_LINE_AT_RISK_LEAD_MS of the add-on's close OFF.
  const tc = WIN_END - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS;
  const near = (t: number) => risky({ forceChargeLinePoolSamples: [{ pct: 62, atMs: t - 15 * M }] });
  assert.notEqual(due(near(tc), tc, onReading()), null, 'at the lead: still pushed');
  none(near(tc + 1), onReading(), tc + 1, 'inside the lead');
  // The close is the write window's end: an hour before on-peak, when that comes first.
  const onPeak = WIN_END + 30 * M; // on-peak at 05:30 ⇒ the write window ends 04:30, the lead 04:10
  assert.equal(due(risky({ nextOnPeakStartMs: onPeak }), T, onReading())?.closeAtMs, WIN_END - 30 * M);
  none(risky({ nextOnPeakStartMs: onPeak, forceChargeLinePoolSamples: [{ pct: 62, atMs: WIN_END - 65 * M }] }), onReading(), WIN_END - 49 * M, 'inside the lead of the on-peak guard');
  // Slots: OFF ones only when connected and their Core under the stop ceiling; ON ones named apart.
  const spent = risky({ forceChargeLineReOns: 2, forceChargeLineReOnAtMs: T - H });
  const mixed = due(spent, T, offReading({ slotsOn: [3], connectedSlots: [1, 3], slotSocPct: at(58) }));
  assert.deepEqual([mixed?.offSlots, mixed?.onSlots], [[1], [3]]);
  none(spent, offReading({ slotSocPct: at(80) }), T, 'every OFF slot\'s Core at the ceiling, none ON: nothing a person can switch');
});

test('★★★ W1 the push words: the pool, the start target, the line, the close; what to switch — never "No action needed"', () => {
  const build = (notify as unknown as { buildLineForceChargeAtRisk: (o: unknown) => { title: string; body: string; severity: string; dedupId: string } }).buildLineForceChargeAtRisk;
  const r = (over: Record<string, unknown>) => ({ cause: 'onNotRising', offSlots: [], onSlots: [1, 2, 3], poolPct: 58, refPct: 62, refAtMs: 0, thresholdPct: 61, linePct: 55.55, closeAtMs: 0, reOnNotAppliedSlots: null, ...over });
  const onLatch = build({ day: '2026-09-16', risk: r({}), closeText: '4:40am' });
  assert.equal(onLatch.severity, 'warning');
  assert.equal(onLatch.dedupId, 'night_charge_line_at_risk');
  assert.equal(onLatch.title, "Night-charge: tonight's outage line is at risk");
  assert.equal(onLatch.body, "Night-charge: the pool reads 58%, under the 61% start target and falling toward tonight's 55.6% outage line; the window closes at ~4:40am. "
    + 'Charge Now reads on for slot(s) 1, 2, 3 but the pool is not rising; switching it off and on again in the EcoFlow app may restart the charge.');
  const spent = build({ day: '2026-09-16', risk: r({ cause: 'reOnSpent', offSlots: [1, 3], onSlots: [], poolPct: 57, refPct: 57 }), closeText: '4:40am' });
  assert.equal(spent.body, "Night-charge: the pool reads 57%, under the 61% start target and not rising; tonight's outage line is 55.6%; the window closes at ~4:40am. "
    + "The add-on has switched Charge Now back on 2 times tonight after the panel's own stop, the most it does in a night. "
    + 'To hold the line, switch Charge Now on for slot(s) 1, 3 in the EcoFlow app (the add-on switches it off at the close).');
  const notApplied = build({ day: '2026-09-16', risk: r({ cause: 'reOnNotApplied', offSlots: [2], onSlots: [1, 3], reOnNotAppliedSlots: [2], poolPct: 54 }), closeText: '4:40am' });
  assert.ok(notApplied.body.startsWith("Night-charge: the pool reads 54%, under tonight's 55.6% outage line and falling; the window closes at ~4:40am. "), notApplied.body);
  assert.ok(notApplied.body.includes('The add-on switched Charge Now back on for slot(s) 2 and it did not take effect; it does not try again tonight. '), notApplied.body);
  assert.ok(notApplied.body.includes('To hold the line, switch Charge Now on for slot(s) 2 in the EcoFlow app (the add-on switches it off at the close). Charge Now reads on for slot(s) 1, 3 but the pool is not rising'), notApplied.body);
  const held = build({ day: '2026-09-16', risk: r({ cause: 'reOnHeld', offSlots: [1, 2, 3], onSlots: [] }), closeText: '4:40am' });
  assert.ok(held.body.includes('The add-on cannot switch Charge Now back on now (it needs the grid known present, healthy host vitals and a live panel reading). '), held.body);
  const cost = build({ day: '2026-09-16', risk: r({ cause: 'costMode', thresholdPct: 75, linePct: 69.4, poolPct: 73, refPct: 76 }), closeText: '4:40am' });
  assert.ok(cost.body.startsWith("Night-charge: the pool reads 73%, under the 75% start target and falling toward tonight's 69.4% outage line;"), cost.body);
  for (const m of [onLatch, spent, notApplied, held, cost]) assert.doesNotMatch(m.body, /No action needed|no action/i);
});

test('★★★ W1 the ON-reading shape is logged once a night when seen, whatever the push conditions — its first real occurrence is measured', () => {
  const shape = (nfc as unknown as { lineOnReadingShape: (s: S, t: number, o: ForceChargeOpts) => unknown }).lineOnReadingShape;
  // Slots of ours read ON, their Cores under the 80% stop ceiling, the pool falling (62 → 58 over 15 min).
  assert.deepEqual(shape(risky(), T, onReading()), { slots: [1, 2, 3], poolPct: 58, refPct: 62, refAtMs: T - 15 * M, stopCeilingPct: 80 });
  // …even above the start target and inside the lead (the push would not go).
  assert.notEqual(shape(risky({ forceChargeLinePoolSamples: [{ pct: 75, atMs: T - 15 * M }] }), T, onReading({ poolSocPct: 70, slotSocPct: at(70) })), null);
  assert.notEqual(shape(risky({ forceChargeLinePoolSamples: [{ pct: 62, atMs: WIN_END - 25 * M }] }), WIN_END - 10 * M, onReading()), null);
  assert.equal(shape(risky(), T, onReading({ poolSocPct: 62, slotSocPct: at(62) })), null, 'flat is not falling');
  assert.equal(shape(risky(), T, onReading({ slotSocPct: at(80) })), null, 'a Core at the ceiling reading ON is the panel\'s business');
  assert.equal(shape(risky(), T, onReading({ slotSocPct: null })), null, 'an unknown Core level says nothing');
  assert.equal(shape(risky(), T, offReading()), null, 'the slots read OFF: the measured latch, not this shape');
  assert.equal(shape(risky({ forceChargeLineAskPct: null, forceChargeLinePct: null, forceChargeCeilingPct: 70, forceChargeMode: 'cost' }), T, onReading({ enabled: true })), null, 'a cost night with no line ask');
  // index.ts: once a night, in memory (a log line), a warning.
  assert.ok(TICK.includes('lineOnReadingShape(nightActuationMem, nowMs, fcOpts)'));
  assert.ok(TICK.includes('if (shape != null && lineOnShapeLoggedDay !== state.day) {'));
  assert.ok(TICK.includes('lineOnShapeLoggedDay = state.day;'));
});

test('★★★ W1 index.ts: the at-risk push is stamped on the record BEFORE it goes (a restart never repeats it), and the trail is persisted only when it moves', () => {
  const call = TICK.indexOf('const risk = lineAtRiskPushDue(nightActuationMem, nowMs, fcOpts);');
  assert.ok(call > 0);
  const stamp = TICK.indexOf('persistNightActuation({ ...nightActuationMem, forceChargeLineAtRiskPushedAtMs: nowMs });', call);
  const send = TICK.indexOf('buildLineForceChargeAtRisk({', call);
  assert.ok(stamp > call && send > stamp, 'write-ahead');
  assert.ok(TICK.includes('closeText: fmtSiteClock(risk.closeAtMs),'));
  const obs = TICK.indexOf('const obs = lineNightObservations(nightActuationMem, nowMs, fcOpts);');
  assert.ok(obs > 0 && obs < TICK.indexOf('const action = decideForceCharge(state, nowMs, fcOpts);'), 'observed before the decision reads the record');
  assert.ok(TICK.includes('if (obs != null) { persistNightActuation({ ...nightActuationMem, ...obs }); state = nightActuationMem; }'));
});

/* ══ W5 — a cost-dominant line night; the declined start across restarts; the reserve-apply failure ═══════ */

test('★★★ W5 #1 a COST-DOMINANT line night\'s ON failure speaks for the line (never "No action needed"); a cost night is today\'s word for word', () => {
  // A Thursday-like night: cost ceiling 90, line 69.4 (ask 70): cost-dominant, so it runs — and is stamped — in cost mode.
  const rec = onNight({ forceChargeCeilingPct: 90, forceChargeLineAskPct: 70, forceChargeLinePct: 69.4, forceChargeMode: 'cost', forceChargeOnVerifiedAtMs: null, forceChargeCeilingSyncedPct: 90 });
  const fields = nfc.forceChargeOnFailureNight(rec);
  assert.deepEqual(fields, { ceilingPct: null, lineLinePct: 69.4 });
  const all = buildNightForceChargeOnFailure({ day: '2026-09-16', slots: [1, 2, 3], ourSlots: [1, 2, 3], retries: 1, noRetry: false, ...fields });
  assert.doesNotMatch(all.body, /No action needed/);
  assert.ok(all.body.includes("Tonight's force-charge for the 69.4% outage line will not happen: without it the pool will close the window near the 50% reserve, under the line."), all.body);
  assert.ok(all.body.includes('switch Charge Now on for slot(s) 1, 2, 3 in the EcoFlow app'), all.body);
  // A line-mode record: the line, as before; a cost record with no line ask: the cost ceiling, word for word.
  assert.deepEqual(nfc.forceChargeOnFailureNight(onNight()), { ceilingPct: null, lineLinePct: 55.55 });
  const cost = onNight({ forceChargeCeilingPct: 90, forceChargeLineAskPct: null, forceChargeLinePct: null, forceChargeMode: 'cost' });
  assert.deepEqual(nfc.forceChargeOnFailureNight(cost), { ceilingPct: 90, lineLinePct: null });
  assert.equal(JSON.stringify(buildNightForceChargeOnFailure({ day: '2026-10-12', slots: [1, 2, 3], ourSlots: [1, 2, 3], retries: 1, noRetry: false, ...nfc.forceChargeOnFailureNight(cost) })), COST_TEXTS['onfail.all']);
  assert.equal(JSON.stringify(buildNightForceChargeOnFailure({ day: '2026-10-12', slots: [2], ourSlots: [1, 2, 3], retries: 1, noRetry: false, ...nfc.forceChargeOnFailureNight(cost) })), COST_TEXTS['onfail.partial']);
  // A record whose line is unknown but whose ask is: the ask stands in for it.
  assert.deepEqual(nfc.forceChargeOnFailureNight(onNight({ forceChargeLinePct: null })), { ceilingPct: null, lineLinePct: 56 });
  assert.equal(nfc.forceChargeLineNightPct(cost), null);
  // index.ts reads the helper — keyed on the record's line ask, never the stamped mode.
  const b = TICK.slice(TICK.indexOf("if (action.kind === 'onFailed') {"), TICK.indexOf("if (action.kind === 'off' || action.kind === 'offRetry') {"));
  assert.ok(b.includes('        ...forceChargeOnFailureNight(state),\n'));
  assert.ok(!b.includes("state.forceChargeMode === 'line'"));
});

test('★★★ W5 #1 + #9 the declined-start push: a cost-dominant line night too; once a night per class ACROSS RESTARTS (persisted write-ahead)', () => {
  const tick = nfc.lineDeclinedPushTick;
  const VITALS = nfc.FORCE_CHARGE_BLOCKER_WHY.vitals;
  const STALE = nfc.FORCE_CHARGE_BLOCKER_WHY.incoherent;
  const T0 = WIN_END - 3 * H;
  const run = (s0: S, gates: { cost: boolean; line: boolean }, plan: Array<[number, number, string | null]>, mem0 = { day: null as string | null, st: nfc.EMPTY_LINE_DECLINED_PUSH }) => {
    let mem = mem0;
    let s = s0;
    const pushes: Array<[number, string]> = [];
    for (const [from, to, why] of plan) {
      for (let i = from; i <= to; i++) {
        const r = tick(mem, s, why, T0 + i * M, gates);
        mem = r.mem;
        if (r.push != null) { pushes.push([i, r.push]); s = { ...s, forceChargeLineDeclinedPushed: [...r.mem.st.pushed] } as S; }
      }
    }
    return { pushes, s, mem };
  };
  // A line-mode night: pushed once, 10 min in.
  const line = run(night(), { cost: false, line: true }, [[0, 30, VITALS]]);
  assert.deepEqual(line.pushes, [[10, 'vitals']]);
  // The process restarts (memory gone) with the cause still holding: the record says it was pushed — no repeat.
  const restarted = coerceActuationState(JSON.parse(JSON.stringify(line.s)));
  assert.deepEqual((restarted as unknown as { forceChargeLineDeclinedPushed: string[] }).forceChargeLineDeclinedPushed, ['vitals']);
  const again = run(restarted, { cost: false, line: true }, [[31, 90, VITALS]]);
  assert.deepEqual(again.pushes, [], 'two restarts under the same cause: still once');
  const third = run(coerceActuationState(JSON.parse(JSON.stringify(again.s))), { cost: false, line: true }, [[91, 150, VITALS]]);
  assert.deepEqual(third.pushes, []);
  // A different class still pushes once it holds.
  assert.deepEqual(run(restarted, { cost: false, line: true }, [[31, 50, STALE]]).pushes, [[41, 'incoherent']]);
  // A COST-DOMINANT line night (cost 90, ask 70): the same push (finding 1).
  const costDom = night({ forceChargeCeilingPct: 90, forceChargeLineAskPct: 70, forceChargeLinePct: 69.4 });
  assert.equal(nfc.forceChargeModeOf(costDom, { cost: true, line: true })?.kind, 'cost');
  assert.deepEqual(run(costDom, { cost: true, line: true }, [[0, 15, VITALS]]).pushes, [[10, 'vitals']]);
  // Never: advisory, no line ask, not live (ON stamped, reserve unverified), or another day's memory.
  assert.deepEqual(run(costDom, { cost: true, line: false }, [[0, 15, VITALS]]).pushes, []);
  assert.deepEqual(run(night({ forceChargeLineAskPct: null, forceChargeLinePct: null, forceChargeCeilingPct: 90 }), { cost: true, line: true }, [[0, 15, VITALS]]).pushes, []);
  assert.deepEqual(run(night({ forceChargeOnAtMs: T0 - H, forceChargeSlots: [1, 2, 3] }), { cost: false, line: true }, [[0, 15, VITALS]]).pushes, []);
  assert.deepEqual(run(night({ applyVerifiedAtMs: null }), { cost: false, line: true }, [[0, 15, VITALS]]).pushes, []);
  assert.deepEqual(run(night(), { cost: false, line: true }, [[0, 15, VITALS]], { day: '2026-09-15', st: { cls: null, sinceMs: null, pushed: ['vitals'] } }).pushes, [[10, 'vitals']], 'yesterday\'s memory does not hold tonight\'s push');
  // Coercion: strings only, each once.
  const raw = (v: unknown) => (coerceActuationState(JSON.parse(JSON.stringify({ ...night(), forceChargeLineDeclinedPushed: v }))) as unknown as { forceChargeLineDeclinedPushed: string[] }).forceChargeLineDeclinedPushed;
  assert.deepEqual(raw(['vitals', 'vitals', 3, '', 'gridPresence']), ['vitals', 'gridPresence']);
  assert.deepEqual(raw('vitals'), []);
  assert.deepEqual((emptyActuationState() as unknown as { forceChargeLineDeclinedPushed: string[] }).forceChargeLineDeclinedPushed, []);
  // index.ts: the class is on the record before the push goes; the latest start is the record's ⌈L⌉.
  const step = TICK.indexOf('const dp = lineDeclinedPushTick(lineDeclinedPush, state, action.why, nowMs, ');
  assert.ok(step > 0);
  const persist = TICK.indexOf('persistNightActuation({ ...nightActuationMem, forceChargeLineDeclinedPushed: [...dp.mem.st.pushed] });', step);
  const send = TICK.indexOf('buildLineForceChargeDeclinedStart({', step);
  assert.ok(persist > step && send > persist, 'write-ahead');
  assert.ok(TICK.includes('lineLatestStartMs(endMs, state.forceChargeLineAskPct!, '));
});

test('★★★ W5 #6 the reserve-apply failure on a line night: the pool held at its floor, under the line, and what holds it — never "No action needed"', () => {
  const line = buildNightChargeApplyFailure({ day: '2027-01-04', currentReservePct: 30, targetPct: 50, applyRetries: 2, expectedKwh: 28.18, linePct: 55.55 } as never);
  assert.equal(line.severity, 'warning');
  assert.equal(line.body,
    'The supervised reserve write for 2027-01-04 was accepted by the EcoFlow cloud but the Smart Home Panel 2 still reads 30% (target 50%) after 2 re-issues. '
    + "Tonight's planned charge (~28.2 kWh expected) will not happen: the pool stays on its normal floor, under tonight's 55.6% outage line, and the force-charge for the line waits on this write. "
    + 'To hold the line tonight, set the backup reserve to 50% in the EcoFlow app: once the panel reads it, the add-on starts the force-charge for the line as planned. If this repeats, check the SHP2 cloud link.');
  assert.doesNotMatch(line.body, /No action needed/);
  // A night with no line: word for word.
  for (const e of [28.18, null, 0]) {
    assert.equal(JSON.stringify(buildNightChargeApplyFailure({ day: '2026-10-12', currentReservePct: 16, targetPct: 50, applyRetries: 2, expectedKwh: e, linePct: null } as never)), COST_TEXTS[`apply.${e}`]);
    assert.equal(JSON.stringify(buildNightChargeApplyFailure({ day: '2026-10-12', currentReservePct: 16, targetPct: 50, applyRetries: 2, expectedKwh: e })), COST_TEXTS[`apply.${e}`]);
  }
  assert.ok(INDEX.includes('day: state.day, currentReservePct, targetPct: state.targetPct, applyRetries: state.applyRetries, expectedKwh,\n        linePct: forceChargeLineNightPct(state),\n'));
});

/* ══ W3 — the morning account of a line-ask night ════════════════════════════════════════════════════════ */

const sum = (fc: unknown, o: Record<string, unknown> = {}) => buildNightChargeMorningSummary({ day: '2026-09-16', targetPct: 50, restorePct: 30, expectedKwh: 17.6, forceCharge: fc, ...o } as never).body;
const lineGates = { cost: false, line: true };

test('★★★ W3 a line night: a close under the line is said; an unread close is said; never "ran to the window close" alone over a line that did not hold', () => {
  const ran = nfc.forceChargeNightOutcome(onNight({ forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd' }), lineGates);
  assert.ok(sum(ran, { closePoolPct: 51 }).includes('force-charge ran to the window close for the 55.6% outage line; the pool read 51% at the close, under the 55.6% outage line'), sum(ran, { closePoolPct: 51 }));
  assert.ok(sum(ran, { closePoolPct: 63 }).includes('force-charge ran to the window close for the 55.6% outage line; the pool read 63% at the close'));
  assert.doesNotMatch(sum(ran, { closePoolPct: 56 }), /under the/, 'at ⌈L⌉: not under');
  assert.match(sum(ran, { closePoolPct: 55 }), /the pool read 55% at the close, under the 55\.6% outage line/);
  assert.ok(sum(ran, { closePoolPct: null }).includes('force-charge ran to the window close for the 55.6% outage line; the pool was not read at the close (no fresh panel reading)'), sum(ran, { closePoolPct: null }));
  assert.ok(sum(ran).includes('the pool was not read at the close'), 'omitted is unread, never silence');
  // The other outcomes of a line night say where it closed too.
  const never = nfc.forceChargeNightOutcome(night(), lineGates);
  assert.ok(sum(never, { closePoolPct: 50 }).includes('force-charge for the 55.6% outage line never started; the pool read 50% at the close, under the 55.6% outage line;'), sum(never, { closePoolPct: 50 }));
  const failed = nfc.forceChargeNightOutcome(onNight({ forceChargeOnVerifiedAtMs: null, forceChargeOnFailedAtMs: WIN_END - 3 * H, forceChargeOnFailedSlots: [1, 2, 3] }), lineGates);
  assert.ok(sum(failed, { closePoolPct: null }).includes('was switched ON but did not take effect; the pool was not read at the close (no fresh panel reading);'), sum(failed, { closePoolPct: null }));
});

test('★★★ W3 a line night: the panel\'s own stop and the re-ONs (issued, and any that did not take effect) are named', () => {
  // The panel stopped the charge at 03:10 after two re-ONs (the last at 02:30, one of them did not take effect).
  const ended = nfc.forceChargeNightOutcome(onNight({
    forceChargeLinePanelOffAtMs: WIN_END - 110 * M, forceChargeLineReOns: 2, forceChargeLineReOnAtMs: WIN_END - 150 * M, forceChargeLineReOnsNotApplied: 1,
    forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd',
  }), lineGates);
  assert.ok(sum(ended, { closePoolPct: 51 }).includes(
    "force-charge ran for the 55.6% outage line until the panel's own stop switched Charge Now off at 3:10am; Charge Now was switched back on 2 time(s) after the panel's own stop (1 of them did not take effect); the pool read 51% at the close, under the 55.6% outage line"), sum(ended, { closePoolPct: 51 }));
  assert.doesNotMatch(sum(ended, { closePoolPct: 51 }), /to the window close/);
  // A re-ON after the panel's stop that then ran to the close.
  const reOnRan = nfc.forceChargeNightOutcome(onNight({
    forceChargeLinePanelOffAtMs: WIN_END - 3 * H, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: WIN_END - 150 * M,
    forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd',
  }), lineGates);
  assert.ok(sum(reOnRan, { closePoolPct: 63 }).includes("force-charge ran to the window close for the 55.6% outage line; Charge Now was switched back on 1 time(s) after the panel's own stop; the pool read 63% at the close"), sum(reOnRan, { closePoolPct: 63 }));
  // The panel's stop before an early OFF of ours: the panel's stop ended it.
  const panelThenGuard = nfc.forceChargeNightOutcome(onNight({ forceChargeLinePanelOffAtMs: WIN_END - 3 * H, forceChargeOffAtMs: WIN_END - 90 * M, forceChargeOffReason: 'onPeakGuard' }), lineGates);
  assert.ok(sum(panelThenGuard, { closePoolPct: 70 }).includes("force-charge ran for the 55.6% outage line until the panel's own stop switched Charge Now off at 2am;"), sum(panelThenGuard, { closePoolPct: 70 }));
  // The outcome carries what it says.
  assert.deepEqual(
    (({ panelOffAtMs, reOns, reOnsNotApplied, lastReOnAtMs }) => ({ panelOffAtMs, reOns, reOnsNotApplied, lastReOnAtMs }))((ended as unknown as { line: Record<string, unknown> }).line),
    { panelOffAtMs: WIN_END - 110 * M, reOns: 2, reOnsNotApplied: 1, lastReOnAtMs: WIN_END - 150 * M });
});

test('★★★ W3 a COST-DOMINANT line night\'s morning account says where it closed against its line', () => {
  const rec = onNight({ forceChargeCeilingPct: 90, forceChargeLineAskPct: 70, forceChargeLinePct: 69.4, forceChargeMode: 'cost', forceChargeOffAtMs: WIN_END - H, forceChargeOffReason: 'target' });
  const fc = nfc.forceChargeNightOutcome(rec, { cost: true, line: true });
  assert.equal(fc.kind, 'ran');
  assert.ok(sum(fc, { closePoolPct: 62, linePct: 69.4 }).includes('force-charge ran toward ~90%; the pool read 62% at the close, under the 69.4% outage line'), sum(fc, { closePoolPct: 62, linePct: 69.4 }));
  assert.ok(sum(fc, { closePoolPct: null, linePct: 69.4 }).includes('force-charge ran toward ~90%; the pool was not read at the close (no fresh panel reading)'));
  // index.ts passes the close and the line on every night whose record carries a line ask.
  const restore = INDEX.slice(INDEX.indexOf('function sendRestoreSummary('), INDEX.indexOf('\n}\n', INDEX.indexOf('function sendRestoreSummary(')));
  assert.ok(restore.includes('      closePoolPct: lineNight != null ? freshPoolSocPct(nowMs) : null,\n      linePct: lineNight,\n'), restore);
  assert.ok(restore.includes('const lineNight = forceChargeLineNightPct(state);'));
});

test('★★★ W3 a cost night with no line ask: the morning account word for word as v1.199.1, whatever the close reading', () => {
  const fcs: Record<string, unknown> = {
    ran: { kind: 'ran', stopPct: 90, expectedLeg: true },
    neverStarted: { kind: 'neverStarted', stopPct: 80, expectedLeg: true },
    failedPartial: { kind: 'failed', stopPct: 85, expectedLeg: true, partialSlots: [2] },
    failedAll: { kind: 'failed', stopPct: 85, expectedLeg: true, partialSlots: null },
    unconfirmed: { kind: 'unconfirmed', stopPct: 72.8, expectedLeg: null },
    none: { kind: 'none', expectedLeg: false },
  };
  let n = 0;
  for (const [k, fc] of Object.entries(fcs)) for (const close of [undefined, 63]) for (const restore of ['readBack', 'acknowledged']) {
    const body = buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 34.88, forceCharge: fc as never, restore: restore as never, ...(close != null ? { closePoolPct: close } : {}) }).body;
    assert.equal(body, COST_TEXTS[`morning.${k}.${close ?? 'x'}.${restore}`], `${k} ${close} ${restore}`);
    const withNull = buildNightChargeMorningSummary({ day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 34.88, forceCharge: fc as never, restore: restore as never, closePoolPct: close ?? null, linePct: null } as never).body;
    assert.equal(withNull, body);
    n++;
  }
  assert.equal(n, 24);
});
