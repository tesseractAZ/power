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
import { withEnv } from './golden/support/env.js';

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
 *       the ON-reading shape (lineOnReadingShape). (review 3) The trend only on readings taken once the last ON of ours
 *       had its readback grace (lineTrendReference), a flat pool at risk only at or under ⌈L⌉, no push at the re-ON's
 *       own cutoff instant, and a cost-dominant night's push worded by its margin over the line and its reason.
 *       (review 4) A re-ON checked not applied (or never written) is no ON of ours: the trend reads past it, so a night
 *       whose re-ONs never took is pushed as soon as the check says so; the spent budget is "after the panel's own stop"
 *       only with that stop on record. (review 5) A slot of ours reading ON again after a readback showed it OFF, outside
 *       the grace of an ON write of ours (a re-ON applied after its check said not, a glitch at the check, Charge Now
 *       switched on in the app after the push), is waited out like an ON of ours (forceChargeLineOnSeenAtMs); no push
 *       while a handed-back re-ON's retry can still come, and 'reOnRefused' when it cannot; a not-applied slot that reads
 *       ON since is not named as not taking effect. (review 6) The retry comes on a tick: the hold counts them at
 *       FORCE_CHARGE_TICK_MS (index.ts's cadence), so a hand-back stamped after its writes gets its retry or the push.
 *       (review 7 counted to the earliest tick the retry can come, with a 1-s tolerance.) (review 8) The hold keeps a FULL
 *       TICK of margin before the cutoff and the push is judged on the hand-back's own tick: never neither while a tick reads
 *       before the cutoff after each hold; a 'reOnRefused' push may be followed by the retry, and its words say it may —
 *       or, where no tick can bring it (its spacing ends at or past the cutoff), that its next try comes after the cutoff,
 *       and then none does (reOnRetryPossible). (Fix12) A pool FLAT with every slot that counts reading ON waits until the time
 *       left no longer covers the charge to ⌈L⌉ at the plan rate (lineFlatPushHeld): a slow charge beside an EV reads level hours
 *       before the close.
 *  W2 — a line re-ON is readback-checked FORCE_CHARGE_ON_VERIFY_AFTER_MS after it, like the first ON. (review 4) The check
 *       keeps the latest re-ON that took effect (lineReOnCheckedStamp), across the next re-ON and a restart.
 *  W3 — the morning account of a line-ask night: under the line said so; an unread close said so; the panel's
 *       own stop and the re-ONs named. A cost night with no line ask reads word for word as v1.199.1. (review 3) A
 *       re-ON resumes the charge only when it took effect; "after the panel's own stop" only when that stop is on record.
 *       (review 4) Every re-ON after the stop counts, not the last alone; with no stop on record and no re-ON that took,
 *       never "ran to the window close". (review 5) The read-off is the LAST re-ON's: its check found every slot it
 *       switched still OFF (or it never reached the panel), whatever an earlier one did — unless a slot of ours read ON
 *       again after it; a slot seen ON again after the panel's stop resumed the charge. (review 6) …and a stop after that
 *       seen ON is a new episode, stamped and named.
 *  W4 — lineCeilingLoweringDue lowers only what the panel holds (never a raise, also under red vitals).
 *  W5 — (#1) a cost-dominant line night's ON failure and declined start speak for the line; (#9) the declined-
 *       start push is once a night per class ACROSS RESTARTS; (#6) the reserve-apply failure on a line night.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const TICK = INDEX.slice(INDEX.indexOf('async function runForceChargeTick('), INDEX.indexOf('async function escalateForceChargeStuck('));
const NFC_SRC = readFileSync(resolve(HERE, '../src/nightForceCharge.ts'), 'utf8');
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

test('★★ W2 index.ts: the re-ON stamps its slots write-ahead (a rate-limited one stamps none); the check is persisted through lineReOnCheckedStamp', () => {
  const exec = TICK.slice(TICK.indexOf("if (action.kind === 'lineReOn') {"), TICK.indexOf("if (action.kind === 'onFailed') {"));
  const spend = exec.indexOf('forceChargeLineReOnSlots: [...action.slots],');
  const write = exec.indexOf("on: true, source: { ua: 'night-force-charge-line-reon' }");
  assert.ok(spend > 0 && write > spend, 'the slots are on the record before the writes');
  assert.ok(exec.includes('...(allLimited ? { forceChargeLineReOns: Math.max(0, nightActuationMem.forceChargeLineReOns - 1), forceChargeLineReOnSlots: null } : {}),'));
  const chk = TICK.slice(TICK.indexOf("if (action.kind === 'lineReOnChecked') {"), TICK.indexOf("if (action.kind === 'lineReOn') {"));
  assert.ok(chk.length > 0, 'the check has its branch, before the re-ON');
  // (review 4) The record the check leaves is the pure stamp's (tested below), the re-ON that took effect included.
  assert.ok(chk.includes('persistNightActuation({ ...nightActuationMem, ...lineReOnCheckedStamp(nightActuationMem, nowMs, action) });'), chk);
  assert.ok(!chk.includes('setChannelForceCharge'), 'a check writes nothing');
  // …and no re-ON clears it: the latest re-ON that took effect outlives the next one.
  assert.ok(!exec.includes('forceChargeLineReOnAppliedAtMs'), 'the re-ON leaves the applied stamp alone');
});

test('★★★ W1 (Fix8 review 1) the re-ON\'s readback check is judged on its own tick: a re-ON not applied whose check lands on the last tick before the push\'s lead is pushed there — the check writes nothing, so the tick\'s readings stand', () => {
  // The round-7 reviewer's night (the close plant's reOnInert): re-ON #1 checked not applied, the panel's stop on record, the pool at
  // 59 then 58 under the 61% start target, every slot reading OFF. Re-ON #2 on the tick 36m30s before the close, stamped 2 s after
  // it (index.ts stamps Date.now() after the writes): its check is the first tick 15 min or more after the stamp, 20m30s before the
  // close — the last tick before the 20-min lead. Both re-ONs are spent and the add-on cannot act: 'reOnNotApplied' first becomes
  // due on that tick (before it the unchecked re-ON was an ON of ours, barring the trend; at it the check reads past it).
  const C = WIN_END;
  const base = onNight({ forceChargeLinePanelOffAtMs: C - 90 * M, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: C - 70 * M, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineReOnCheckedAtMs: C - 55 * M, forceChargeLineReOnNotAppliedSlots: [1, 2, 3], forceChargeLineReOnsNotApplied: 1 });
  const run = (t0: number, judgeCheck: boolean): string[] => {
    let s = base;
    const log: string[] = [];
    for (let t = t0; t < C - 15 * M; t += M) {
      const pool = t < C - 30 * M ? 59 : 58;
      const o = offReading({ poolSocPct: pool, slotSocPct: at(pool) });
      const obs = nfc.lineNightObservations(s, t, o);
      if (obs != null) s = { ...s, ...obs } as S;
      const a = decideForceCharge(s, t, o);
      const judge = (): void => {
        const r = nfc.lineAtRiskPushDue(s, t, o);
        if (r != null) { s = { ...s, forceChargeLineAtRiskPushedAtMs: t } as S; log.push(`push ${(C - t) / 1000}s ${r.cause}`); }
      };
      if (a.kind === 'lineReOn') {
        s = { ...s, forceChargeLineReOns: s.forceChargeLineReOns + 1, forceChargeLineReOnAtMs: t + 2_000, forceChargeLineReOnSlots: [...a.slots] } as S;
        log.push(`reOn ${(C - t) / 1000}s`);
      } else if (a.kind === 'lineReOnChecked') {
        s = { ...s, ...nfc.lineReOnCheckedStamp(s, t, a) } as S;
        log.push(`check ${(C - t) / 1000}s`);
        if (judgeCheck) judge();
      } else if (a.kind === 'none') judge();
      else log.push(`${a.kind} ${(C - t) / 1000}s`);
    }
    return log;
  };
  const late = C - 36 * M - 30_000;
  // As 4ace3a1e ran it (the check's tick not judged): neither — the next tick is inside the lead.
  assert.deepEqual(run(late, false), ['reOn 2190s', 'check 1230s']);
  // Judged on the check's own tick (index.ts now): pushed there, 20m30s before the close, before the lead.
  assert.deepEqual(run(late, true), ['reOn 2190s', 'check 1230s', 'push 1230s reOnNotApplied']);
  // A minute earlier the push already went on the tick after the check; judged on the check now, a minute sooner.
  assert.deepEqual(run(late - M, false), ['reOn 2250s', 'check 1290s', 'push 1230s reOnNotApplied']);
  assert.deepEqual(run(late - M, true), ['reOn 2250s', 'check 1290s', 'push 1290s reOnNotApplied']);
  // A re-ON whose check finds it applied is an ON of ours: no reference before its grace has run, so nothing is due on its check.
  const applied = { ...base, forceChargeLineReOns: 2, forceChargeLineReOnAtMs: C - 40 * M, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineReOnCheckedAtMs: C - 25 * M, forceChargeLineReOnNotAppliedSlots: [], forceChargeLineReOnAppliedAtMs: C - 40 * M,
    forceChargeLinePoolSamples: [{ pct: 60, atMs: C - 45 * M }, { pct: 59, atMs: C - 35 * M }] } as S;
  assert.equal(nfc.lineAtRiskPushDue(applied, C - 25 * M, onReading({ poolSocPct: 58, slotSocPct: at(58) })), null);
  assert.equal(nfc.lineOnReadingShape(applied, C - 25 * M, onReading({ poolSocPct: 58, slotSocPct: at(58) })), null);
  // index.ts: the check's branch judges the push and the shape after its stamp, and writes nothing.
  const chk = TICK.slice(TICK.indexOf("if (action.kind === 'lineReOnChecked') {"), TICK.indexOf("if (action.kind === 'lineReOn') {"));
  const stamp = chk.indexOf('persistNightActuation({ ...nightActuationMem, ...lineReOnCheckedStamp(nightActuationMem, nowMs, action) });');
  const judged = chk.indexOf('    judgeLineNight();\n');
  assert.ok(stamp > 0 && judged > stamp, 'judged after the check\'s stamp, on its own tick');
  assert.ok(!chk.includes('setChannelForceCharge'), 'the check writes nothing');
  // The header states the tick kinds the push is judged on, the check's among them.
  const head = TICK.slice(0, TICK.indexOf('const pushLineAtRiskIfDue = (): void => {')).replace(/\n\s*\/\/\s*/g, ' ');
  assert.ok(head.includes("on a re-ON's readback check (it writes nothing: the tick's readings stand)"), 'index.ts names the check among the judged ticks');
});

test('★★★ W2 (review 4) lineReOnCheckedStamp: the check\'s record, and the latest re-ON that took effect kept across the next re-ON and a restart', () => {
  const stamp = nfc.lineReOnCheckedStamp;
  const t0 = WIN_END - 2 * H;
  const s = onNight({ forceChargeLineReOns: 1, forceChargeLineReOnAtMs: t0, forceChargeLineReOnSlots: [1, 2, 3] });
  const now = t0 + 15 * M;
  // Every slot took it: the re-ON's write time is the latest that took effect; nothing counted not applied.
  assert.deepEqual(stamp(s, now, { slots: [1, 2, 3], notApplied: [] }),
    { forceChargeLineReOnCheckedAtMs: now, forceChargeLineReOnNotAppliedSlots: [], forceChargeLineReOnAppliedAtMs: t0 });
  // One slot of three did not: counted not applied (the morning account names it) — and it took effect on the others.
  assert.deepEqual(stamp(s, now, { slots: [1, 2, 3], notApplied: [2] }),
    { forceChargeLineReOnCheckedAtMs: now, forceChargeLineReOnNotAppliedSlots: [2], forceChargeLineReOnsNotApplied: 1, forceChargeLineReOnAppliedAtMs: t0 });
  // None took it: counted, and no applied stamp (an earlier one stands).
  assert.deepEqual(stamp({ ...s, forceChargeLineReOnsNotApplied: 1 }, now, { slots: [1, 3], notApplied: [1, 3] }),
    { forceChargeLineReOnCheckedAtMs: now, forceChargeLineReOnNotAppliedSlots: [1, 3], forceChargeLineReOnsNotApplied: 2 });
  // The verdict it leaves is lastLineReOnApplied's, both ways.
  for (const notApplied of [[], [2], [1, 2, 3]]) {
    const after = { ...s, ...stamp(s, now, { slots: [1, 2, 3], notApplied }) } as S;
    assert.equal(nfc.lastLineReOnApplied(after), notApplied.length < 3, JSON.stringify(notApplied));
    assert.equal(after.forceChargeLineReOnAppliedAtMs != null, notApplied.length < 3, JSON.stringify(notApplied));
  }
  // A RESTART mid-night: re-ON 1 took effect at t0, re-ON 2 at t0 + 30 min did not. The record round-trips through the
  // file, coerced, and the trend and the morning account read it as before.
  const night2 = { ...s, ...stamp(s, now, { slots: [1, 2, 3], notApplied: [] }) } as S;
  const second = { ...night2, forceChargeLineReOns: 2, forceChargeLineReOnAtMs: t0 + 30 * M, forceChargeLineReOnSlots: [1, 2, 3] } as S;
  const done = { ...second, ...stamp(second, t0 + 45 * M, { slots: [1, 2, 3], notApplied: [1, 2, 3] }),
    forceChargeLinePoolSamples: [{ pct: 60, atMs: t0 + 20 * M }] } as S;
  assert.equal(done.forceChargeLineReOnAppliedAtMs, t0, 'the second re-ON leaves the first one\'s stamp');
  const restarted = coerceActuationState(JSON.parse(JSON.stringify(done)));
  assert.equal(restarted.forceChargeLineReOnAppliedAtMs, t0);
  assert.deepEqual(nfc.lineTrendReference(restarted, t0 + 46 * M), nfc.lineTrendReference(done, t0 + 46 * M));
  assert.deepEqual(nfc.lineTrendReference(restarted, t0 + 46 * M), { pct: 60, atMs: t0 + 20 * M }, 'after the first re-ON\'s grace, past the failed second');
  const gates = { cost: false, line: true };
  assert.deepEqual(nfc.forceChargeNightOutcome(restarted, gates), nfc.forceChargeNightOutcome(done, gates));
  // Coerced on load: a finite number, else null; absent on an older record.
  const raw = (v: unknown) => (coerceActuationState(JSON.parse(JSON.stringify({ ...night(), forceChargeLineReOnAppliedAtMs: v }))) as unknown as Record<string, unknown>).forceChargeLineReOnAppliedAtMs;
  assert.equal(raw(5), 5);
  assert.equal(raw('5'), null);
  assert.equal(raw(null), null);
  const old = JSON.parse(JSON.stringify(night())) as Record<string, unknown>;
  delete old.forceChargeLineReOnAppliedAtMs;
  assert.equal(coerceActuationState(old).forceChargeLineReOnAppliedAtMs, null);
  assert.equal(emptyActuationState().forceChargeLineReOnAppliedAtMs, null);
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
  // (review 5) The record already holds this readback's slots OFF (forceChargeLineOffSlots, below): only the stop is new.
  const latch = (o: Partial<ForceChargeOpts>) => obs(onNight({ forceChargeLinePoolSamples: [{ pct: 80, atMs: T - 5 * M }],
    forceChargeLineOffSlots: [1, 2, 3].filter((n) => !(o.slotsOn ?? []).includes(n)) }), T, fo({ poolSocPct: 80, ...o }));
  assert.deepEqual(latch({ slotsOn: [], slotSocPct: { 1: 79.5, 2: 80, 3: 78 } }), { forceChargeLinePanelOffAtMs: T });
  assert.deepEqual(latch({ slotsOn: [], slotSocPct: { 1: 79, 2: 79, 3: 78 } }), { forceChargeLinePanelOffAtMs: T }, 'a Core one point under the ceiling still reads as the stop');
  assert.equal(latch({ slotsOn: [3], slotSocPct: at(80) }), null, 'one slot still ON: the charge has not ended');
  assert.equal(latch({ slotsOn: [], slotSocPct: at(70) }), null, 'all OFF with no Core at the ceiling: not the panel\'s stop');
  assert.equal(latch({ slotsOn: null, slotSocPct: null }), null);
  assert.equal(obs(onNight({ forceChargeOnVerifiedAtMs: null, forceChargeLinePoolSamples: [{ pct: 80, atMs: T - 5 * M }] }), T, fo({ poolSocPct: 80, slotsOn: [], slotSocPct: at(80) })), null, 'before the ON verified: the ON verify\'s');
  // Stamped once per episode: again only after a re-ON's readback grace (a second latch).
  const stopped = { forceChargeLinePanelOffAtMs: T - H, forceChargeLinePoolSamples: [{ pct: 80, atMs: T - 5 * M }], forceChargeLineOffSlots: [1, 2, 3] };
  assert.equal(obs(onNight(stopped), T, fo({ poolSocPct: 80, slotsOn: [], slotSocPct: at(80) })), null);
  assert.equal(obs(onNight({ ...stopped, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: T - 14 * M }), T, fo({ poolSocPct: 80, slotsOn: [], slotSocPct: at(80) })), null, 'inside the re-ON\'s grace');
  assert.deepEqual(obs(onNight({ ...stopped, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: T - 15 * M }), T, fo({ poolSocPct: 80, slotsOn: [], slotSocPct: at(80) })), { forceChargeLinePanelOffAtMs: T });
  const raw = (v: unknown) => (coerceActuationState(JSON.parse(JSON.stringify({ ...night(), forceChargeLinePanelOffAtMs: v }))) as unknown as Record<string, unknown>).forceChargeLinePanelOffAtMs;
  assert.equal(raw(5), 5);
  assert.equal(raw('5'), null);
});

test('★★★ W1 (review 5) the observations keep the slots a readback showed OFF, and stamp an ON seen again that no ON write of ours explains', () => {
  const obs = nfc.lineNightObservations;
  const rd = (slotsOn: number[] | null) => fo({ poolSocPct: 58, slotsOn, slotSocPct: at(58) });
  const stopped = (over: Record<string, unknown> = {}) => onNight({ forceChargeLinePoolSamples: [{ pct: 58, atMs: T - 5 * M }], ...over });
  // The readback memory: the slots of ours reading OFF, persisted only when it moves (nothing while every slot reads ON).
  assert.equal(obs(stopped(), T, rd([1, 2, 3])), null, 'every slot ON and none seen OFF: nothing to persist');
  assert.deepEqual(obs(stopped(), T, rd([2])), { forceChargeLineOffSlots: [1, 3] });
  assert.equal(obs(stopped({ forceChargeLineOffSlots: [1, 3] }), T, rd([2])), null, 'unchanged');
  assert.equal(obs(stopped({ forceChargeLineOffSlots: [1, 3] }), T, rd(null)), null, 'a stale readback says nothing');
  assert.equal(obs(stopped({ forceChargeOnVerifiedAtMs: null }), T, rd([])), null, 'before the ON verified');
  assert.equal(obs(stopped({ forceChargeOffAtMs: T - M, forceChargeOffReason: 'onPeakGuard' }), T, rd([])), null, 'after an OFF of ours');
  // A slot that read OFF reads ON again, the last ON of ours (01:00) long past its readback grace: an ON seen (a late apply,
  // Charge Now switched on in the app), stamped at this reading.
  assert.deepEqual(obs(stopped({ forceChargeLineOffSlots: [1, 2, 3] }), T, rd([1])), { forceChargeLineOffSlots: [2, 3], forceChargeLineOnSeenAtMs: T });
  assert.deepEqual(obs(stopped({ forceChargeLineOffSlots: [1, 2, 3] }), T, rd([1, 2, 3])), { forceChargeLineOffSlots: [], forceChargeLineOnSeenAtMs: T });
  // Inside the readback grace of a re-ON of ours (its write 14 min ago), the slots reading ON are that re-ON's: no stamp.
  const reOn = (at: number, slots: number[] | null) => stopped({ forceChargeLineOffSlots: [1, 2, 3], forceChargeLineReOns: 1, forceChargeLineReOnAtMs: at, forceChargeLineReOnSlots: slots });
  assert.deepEqual(obs(reOn(T - 14 * M, [1, 2, 3]), T, rd([1, 2, 3])), { forceChargeLineOffSlots: [] });
  // From its grace on (the check found it not applied at 15 min; the slots read ON at 16), it is a seen ON.
  assert.deepEqual(obs(reOn(T - 15 * M, [1, 2, 3]), T, rd([1, 2, 3])), { forceChargeLineOffSlots: [], forceChargeLineOnSeenAtMs: T });
  // A re-ON handed back (every write rate-limited: no slots on the record) never reached the panel: no grace of its own.
  assert.deepEqual(obs(reOn(T - 2 * M, null), T, rd([1, 2, 3])), { forceChargeLineOffSlots: [], forceChargeLineOnSeenAtMs: T });
  // The ON's own grace (its last attempt 10 min ago) likewise.
  assert.deepEqual(obs(stopped({ forceChargeLineOffSlots: [1, 2, 3], forceChargeOnLastAttemptMs: T - 10 * M }), T, rd([1, 2, 3])), { forceChargeLineOffSlots: [] });
  // A slot ON that never read OFF is no transition.
  assert.deepEqual(obs(stopped({ forceChargeLineOffSlots: [3] }), T, rd([1, 2])), null);
  // Coerced on load: slot numbers of the panel, a finite time; null when absent (every record from before the fields).
  const raw = (o2: Record<string, unknown>) => coerceActuationState(JSON.parse(JSON.stringify({ ...night(), ...o2 }))) as unknown as Record<string, unknown>;
  assert.deepEqual(raw({ forceChargeLineOffSlots: [3, 1, 9, 'x'] }).forceChargeLineOffSlots, [3, 1]);
  assert.deepEqual(raw({ forceChargeLineOffSlots: [] }).forceChargeLineOffSlots, []);
  assert.equal(raw({ forceChargeLineOffSlots: 'x' }).forceChargeLineOffSlots, null);
  assert.equal(raw({ forceChargeLineOnSeenAtMs: 7 }).forceChargeLineOnSeenAtMs, 7);
  assert.equal(raw({ forceChargeLineOnSeenAtMs: '7' }).forceChargeLineOnSeenAtMs, null);
  const old = JSON.parse(JSON.stringify(night())) as Record<string, unknown>;
  delete old.forceChargeLineOffSlots; delete old.forceChargeLineOnSeenAtMs;
  const e = coerceActuationState(old) as unknown as Record<string, unknown>;
  assert.deepEqual([e.forceChargeLineOffSlots, e.forceChargeLineOnSeenAtMs], [null, null]);
  const e0 = emptyActuationState() as unknown as Record<string, unknown>;
  assert.deepEqual([e0.forceChargeLineOffSlots, e0.forceChargeLineOnSeenAtMs], [null, null]);
});

test('★★★ W1 lineAtRiskPushDue — every way the line is lost after the start, while a person can still act', () => {
  const due = nfc.lineAtRiskPushDue;
  // (a) The ON-READING latch (UNMEASURED here): the slots read ON at their Cores' 58%, the pool falling 62 → 58.
  // decideForceCharge has nothing to do (no slot reads OFF: no re-ON) — the night would close under in silence.
  assert.deepEqual(decideForceCharge(risky(), T, onReading()), { kind: 'none' });
  assert.deepEqual(due(risky(), T, onReading()), {
    cause: 'onNotRising', offSlots: [], onSlots: [1, 2, 3], poolPct: 58, refPct: 62, refAtMs: T - 15 * M,
    thresholdPct: 61, linePct: 55.55, closeAtMs: WIN_END, reOnNotAppliedSlots: null, panelOffAtMs: null, reOnRetryPossible: false,
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
  // (review 3) …also at or under ⌈L⌉, where a flat pool is pushed: a pool rising there is the charge working.
  none(risky({ forceChargeLinePoolSamples: [{ pct: 54, atMs: T - 15 * M }] }), onReading({ poolSocPct: 55, slotSocPct: at(55) }), T, 'rising under the line (54 → 55)');
  // (Fix12) …once the time left no longer covers the charge to ⌈L⌉ at the plan rate: 40.5 min before the close from 55.
  const inGate = WIN_END - 40 * M;
  assert.notEqual(due(risky({ forceChargeLinePoolSamples: [{ pct: 55, atMs: inGate - 15 * M }] }), inGate, onReading({ poolSocPct: 55, slotSocPct: at(55) })), null, 'flat under the line, past the gate: pushed');
  none(risky({ forceChargeLinePoolSamples: [{ pct: 62, atMs: T - 5 * M }] }), onReading(), T, 'no reading 10 min older');
  none(risky({ forceChargeLinePoolSamples: null }), onReading(), T, 'no trail');
  none(risky({ forceChargeLineReOns: 1, forceChargeLineReOnAtMs: T - 15 * M + 1, forceChargeLineReOnSlots: [1, 2, 3], forceChargeLineReOnCheckedAtMs: T - M }), onReading(), T, 'a re-ON in its readback grace is left alone');
  none(risky({ forceChargeOnLastAttemptMs: T - 15 * M + 1 }), onReading(), T, 'the ON\'s own readback grace');
  // The lead: never inside FORCE_CHARGE_LINE_AT_RISK_LEAD_MS of the add-on's close OFF.
  const tc = WIN_END - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS;
  const near = (t: number) => risky({ forceChargeLinePoolSamples: [{ pct: 62, atMs: t - 15 * M }] });
  // (review 3) …and not AT it: the lead is the re-ON's own cutoff (FORCE_CHARGE_ON_RETRY_CUTOFF_MS), and at that instant
  // a re-ON is refused by the cutoff — a push there would blame the re-ON's gates (the grid, the vitals, a readback) for
  // it. The plant's minute ticks landed there on 18 of 202 nights; production's tick, at any phase, almost never does.
  assert.equal(nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS, nfc.FORCE_CHARGE_ON_RETRY_CUTOFF_MS);
  assert.notEqual(due(near(tc - 1), tc - 1, onReading()), null, 'a millisecond before the lead: pushed');
  none(near(tc), onReading(), tc, 'at the lead (the re-ON\'s cutoff)');
  none(near(tc + 1), onReading(), tc + 1, 'inside the lead');
  const offAtCut = near(tc);
  assert.equal(nfc.lineReOnDue(offAtCut, tc, offReading(), [1, 2, 3]), null, 'the re-ON\'s cutoff refuses it');
  none(offAtCut, offReading(), tc, 'at the cutoff: no push blaming the re-ON\'s gates');
  assert.equal(decideForceCharge(offAtCut, tc - 1, offReading()).kind, 'lineReOn', 'a millisecond before: the add-on\'s own re-ON');
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

test('★★★ W1 (review 3) the trend is judged on readings after the last ON of ours took effect, and a FLAT pool is at risk only at or under ⌈L⌉', () => {
  const due = nfc.lineAtRiskPushDue;
  // The round-3 reviewer's probe 2: a re-ON at T−16 took effect (its check found it applied) and the pool rose 58 → 60;
  // the reference, 62 at T−17, predates the re-ON (the fall that called for it). The pool is RISING: no push.
  const reOnTook = (reOnAt: number, samples: Array<{ pct: number; atMs: number }>) => risky({
    forceChargeLineReOns: 1, forceChargeLineReOnAtMs: reOnAt, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineReOnCheckedAtMs: reOnAt + 15 * M, forceChargeLineReOnNotAppliedSlots: [], forceChargeLinePoolSamples: samples,
  });
  const charging = (pool: number) => onReading({ poolSocPct: pool, slotSocPct: at(pool) });
  assert.equal(due(reOnTook(T - 16 * M, [{ pct: 62, atMs: T - 17 * M }, { pct: 58, atMs: T - 7 * M }]), T, charging(60)), null, 'a reference from before the re-ON');
  // A reference taken after the re-ON's write but inside its readback grace (an ON that takes effect late, a stale
  // reading) is no better: the re-ON at T−20, the reference at T−10.
  assert.equal(due(reOnTook(T - 20 * M, [{ pct: 62, atMs: T - 10 * M }]), T, charging(60)), null, 'a reference inside the re-ON\'s readback grace');
  // From the grace on, the trend counts: the re-ON at T−25, the reference at T−10 (= its write + 15 min), the pool falling.
  assert.equal(due(reOnTook(T - 25 * M, [{ pct: 62, atMs: T - 10 * M }]), T, charging(60))?.cause, 'onNotRising');
  // The first ON alike (its last attempt): a reference inside its grace says nothing.
  assert.equal(due(risky({ forceChargeOnLastAttemptMs: T - 20 * M, forceChargeLinePoolSamples: [{ pct: 62, atMs: T - 10 * M }] }), T, charging(58)), null);
  // The round-3 reviewer's probe 1: Charge Now ON and importing ~3.4 kW beside an EV sharing the grid cap — whole-percent
  // readings sit flat at 59 (6 points over ⌈L⌉ = 56, under the 61% start target). Flat is not falling: no push.
  const flat = (pct: number) => risky({ forceChargeLinePoolSamples: [{ pct, atMs: T - 12 * M }, { pct, atMs: T - 2 * M }] });
  assert.equal(due(flat(59), T, charging(59)), null, 'flat at 59, above ⌈L⌉');
  assert.equal(due(flat(57), T, charging(57)), null, 'flat at 57, above ⌈L⌉');
  // A flat pool AT ⌈L⌉ or under it is at risk (one more point lost is the line): pushed, (Fix12) once the time left says so.
  const G = WIN_END - 40 * M;
  const flatAtG = (pct: number) => risky({ forceChargeLinePoolSamples: [{ pct, atMs: G - 12 * M }, { pct, atMs: G - 2 * M }] });
  assert.equal(due(flatAtG(56), G, charging(56))?.cause, 'onNotRising', 'flat at ⌈L⌉');
  assert.equal(due(flatAtG(55), G, charging(55))?.cause, 'onNotRising', 'flat under the line');
  // A FALLING pool keeps the start-target threshold: 60 against 62, above ⌈L⌉.
  assert.equal(due(risky(), T, charging(60))?.cause, 'onNotRising', 'falling, under the start target');
  // On a cost-dominant night (ask 70): flat at 72 is not pushed; flat at 70 is, past the same gate.
  const costDom = (pct: number) => risky({ forceChargeCeilingPct: 90, forceChargeLineAskPct: 70, forceChargeLinePct: 69.4, forceChargeMode: 'cost',
    forceChargeCeilingSyncedPct: 90, forceChargeLinePoolSamples: [{ pct, atMs: G - 12 * M }] });
  const cdo = (pct: number) => fo({ enabled: true, poolSocPct: pct, slotsOn: [1, 2, 3], slotSocPct: at(pct), ceilingReadbackPct: 90 });
  assert.equal(due(costDom(72), G, cdo(72)), null);
  assert.equal(due(costDom(70), G, cdo(70))?.cause, 'costMode');
});

/* ── (Fix12) a flat pool with every slot reading on: a slow charge, until the time left says otherwise ──────────────────── */

const ASK = 56;
const FULL = 92.16;
/** The flat record at `t`: the pool reads `pct` now and read it 12 min ago, every slot of ours ON, the trend past the ON's grace. */
const flatNight = (pct: number, t: number, over: Record<string, unknown> = {}): S => onNight({
  forceChargeOnAtMs: WIN_START + 10 * M, forceChargeOnVerifiedAtMs: WIN_START + 12 * M, forceChargeOnLastAttemptMs: WIN_START + 10 * M,
  forceChargeLinePoolSamples: [{ pct, atMs: t - 12 * M }, { pct, atMs: t - 2 * M }], ...over,
});
const flatOn = (pct: number, over: Partial<ForceChargeOpts> = {}) => fo({ poolSocPct: pct, slotsOn: [1, 2, 3], slotSocPct: at(pct), ...over });
/** The first instant the push may go on a flat pool: the line's latest start at the plan rate, less the push's own lead. */
const gateMs = (pct: number): number => nfc.lineLatestStartMs(WIN_END, ASK, pct, FULL, nfc.lineDeliverableRateKw(3), null, 3) - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS;

test('★★★ W1 (Fix12) the gate: held to the instant the time left no longer covers the charge to ⌈L⌉ at the plan rate, then pushed; from 52 that is 57.1 min out, at ⌈L⌉ the last start less the lead', () => {
  const due = nfc.lineAtRiskPushDue;
  const g = gateMs(52);
  // 4 points of a 92.16 kWh pool at 10 kW is 22.1 min, + the 15-min buffer, + the 20-min lead.
  assert.ok(Math.abs((WIN_END - g) / M - (0.04 * FULL / nfc.FORCE_CHARGE_PLAN_RATE_KW * 60 + 15 + 20)) < 1e-6, String((WIN_END - g) / M));
  assert.equal(nfc.lineFlatPushHeld(g - 1, WIN_END, ASK, 52, FULL, 3), true, 'a millisecond before');
  assert.equal(nfc.lineFlatPushHeld(g, WIN_END, ASK, 52, FULL, 3), false, 'at it');
  assert.equal(due(flatNight(52, g - 1), g - 1, flatOn(52)), null, 'held to the last millisecond');
  assert.deepEqual(due(flatNight(52, g), g, flatOn(52))?.cause, 'onNotRising', 'pushed at the exact instant');
  // At ⌈L⌉ the charge needs nothing: the last start (the close less 20 min) less the lead, 40 min out, with never a buffer past it.
  assert.equal(gateMs(ASK), WIN_END - 40 * M);
  assert.equal(due(flatNight(ASK, WIN_END - 40 * M - 1), WIN_END - 40 * M - 1, flatOn(ASK)), null);
  assert.equal(due(flatNight(ASK, WIN_END - 40 * M), WIN_END - 40 * M, flatOn(ASK))?.cause, 'onNotRising');
  // The on-peak guard's close is the close: the same gate, 30 min sooner.
  const guard = { nextOnPeakStartMs: WIN_END + 30 * M };
  const gg = nfc.lineLatestStartMs(WIN_END - 30 * M, ASK, 52, FULL, 10, null, 3) - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS;
  assert.equal(due(flatNight(52, gg - 1, guard), gg - 1, flatOn(52)), null);
  assert.equal(due(flatNight(52, gg, guard), gg, flatOn(52))?.closeAtMs, WIN_END - 30 * M);
});

test('★★★ W1 (Fix12) the plan rate and no EV energy, on purpose: a 3 kW live rate and an EV\'s kWh, the very nights of the false alarm, do not open the gate', () => {
  const due = nfc.lineAtRiskPushDue;
  const held = WIN_END - 5 * H;
  // The false alarm: hours before the close, a pack importing 3 kW beside an EV. Timed on that rate the gate would be open at once.
  const slow = { chargeRateKw: 3, evDisplacedKwh: 30 };
  assert.ok(nfc.lineLatestStartMs(WIN_END, ASK, 52, FULL, 3, 30, 3) - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS < held, 'the live figures would open it');
  assert.equal(due(flatNight(52, held), held, flatOn(52, slow)), null, 'held');
  const g = gateMs(52);
  assert.equal(due(flatNight(52, g - 1), g - 1, flatOn(52, slow)), null, 'the live figures move nothing');
  assert.equal(due(flatNight(52, g), g, flatOn(52, slow))?.cause, 'onNotRising');
  assert.equal(due(flatNight(52, g - 1), g - 1, flatOn(52, { chargeRateKw: 30, evDisplacedKwh: null })), null, 'nor a live rate over the plan rate');
  assert.equal(due(flatNight(52, g), g, flatOn(52, { chargeRateKw: 30, evDisplacedKwh: null }))?.cause, 'onNotRising');
  assert.equal(nfc.FORCE_CHARGE_PLAN_RATE_KW, 10, 'under the ~14 kW a pack takes');
});

test('★★★ W1 (Fix13) a rate the plant can deliver: the plan rate, bounded by connected slots × the per-Core rate; the option never raises it, so a gate never opens later for it', async () => {
  const rate = nfc.lineDeliverableRateKw;
  await withEnv({ FORCE_CHARGE_KW_PER_CORE: undefined }, () => {
    // The default plants must not move: min(10, 16.5) and min(10, 11). One Core is its own 5.5 kW.
    assert.deepEqual([rate(3), rate(2), rate(1)], [10, 10, 5.5]);
    for (const n of [null, undefined, 0, -1, 1.5, Number.NaN]) assert.equal(rate(n), nfc.FORCE_CHARGE_PLAN_RATE_KW, `slots ${n}: unknown, the plan rate`);
  });
  await withEnv({ FORCE_CHARGE_KW_PER_CORE: '5.2' }, () => assert.deepEqual([rate(3), rate(2), rate(1)], [10, 10, 5.2], 'the option never above 10 kW, where the start\'s own fallback reads 15.6'));
  await withEnv({ FORCE_CHARGE_KW_PER_CORE: '2' }, () => assert.deepEqual([rate(3), rate(4), rate(1)], [6, 6, 2], 'never over the panel\'s three slots'));
  // No grid cap in it, on purpose: lineFlatPushHeld's docblock.
  await withEnv({ FORCE_CHARGE_KW_PER_CORE: undefined, ARB_GRID_INPUT_CAP_KW: '10' }, () => assert.equal(rate(3), 10));
  // It reads the gate and the quote and nothing else: not the start, nor anything that writes.
  assert.equal(NFC_SRC.split('lineDeliverableRateKw(').length - 1, 3, 'its definition, the gate, the quote');
  assert.ok(!INDEX.includes('lineDeliverableRateKw'));
  assert.ok(!readFileSync(resolve(HERE, '../src/nightChargeActuator.ts'), 'utf8').includes('lineDeliverableRateKw'));
});

test('★★★ W1 (Fix13) the slot count reaches the gate: a slower plant opens it sooner, at what it delivers; the option does not open it later', async () => {
  const due = nfc.lineAtRiskPushDue;
  const gate = (rate: number) => nfc.lineLatestStartMs(WIN_END, ASK, 52, FULL, rate, null, 3) - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS;
  await withEnv({ FORCE_CHARGE_KW_PER_CORE: '5' }, () => {
    // 10 kW for three slots, as with the option unset, where 15 kW would hold 7.4 min longer. 5 kW with one connected, a gate sooner.
    const three = gate(10);
    const one = gate(5);
    assert.ok(one < three, 'fewer slots, a slower rate, a gate sooner');
    assert.equal(due(flatNight(52, three - 1), three - 1, flatOn(52)), null);
    assert.equal(due(flatNight(52, three), three, flatOn(52))?.cause, 'onNotRising');
    assert.equal(due(flatNight(52, one), one, flatOn(52, { connectedSlots: [1], slotsOn: [1, 2, 3] }))?.cause, 'onNotRising', 'one connected: open at its own rate');
    assert.equal(due(flatNight(52, one - 1), one - 1, flatOn(52, { connectedSlots: [1], slotsOn: [1, 2, 3] })), null, 'one connected: held to it');
    assert.equal(due(flatNight(52, one), one, flatOn(52)), null, 'three connected: still held there');
  });
  await withEnv({ FORCE_CHARGE_KW_PER_CORE: undefined }, () => {
    const one = gate(5.5);
    assert.equal(nfc.lineFlatPushHeld(one - 1, WIN_END, ASK, 52, FULL, 1), true);
    assert.equal(nfc.lineFlatPushHeld(one, WIN_END, ASK, 52, FULL, 1), false, 'the option unset, one Core: 5.5 kW, where the plan rate read 10');
  });
});

test('★★★ W1 (Fix12) only a flat pool with every slot that counts reading on is held: a slot reading off explains it, a falling pool is no slow charge, each pushed at any time', () => {
  const due = nfc.lineAtRiskPushDue;
  const early = WIN_END - 5 * H;
  assert.equal(due(flatNight(52, early), early, flatOn(52)), null, 'the control: held');
  // A slot reading off, spent or held, on a flat reading: at any time, exactly as before.
  const spent = flatNight(52, early, { forceChargeLineReOns: 2, forceChargeLineReOnAtMs: early - 40 * M, forceChargeLineReOnSlots: [1, 2, 3], forceChargeLineReOnCheckedAtMs: early - 25 * M, forceChargeLineReOnNotAppliedSlots: [] });
  const oneOff = flatOn(52, { slotsOn: [1, 3] });
  assert.equal(due(spent, early, oneOff)?.cause, 'reOnSpent');
  assert.deepEqual(due(spent, early, oneOff)?.offSlots, [2]);
  assert.equal(due({ ...spent, forceChargeLineReOnNotAppliedSlots: [2] }, early, oneOff)?.cause, 'reOnNotApplied');
  assert.equal(due(flatNight(52, early), early, flatOn(52, { slotsOn: [1, 3], vitalsRed: true }))?.cause, 'reOnHeld', 'a re-ON its gates hold');
  const handed = flatNight(52, WIN_END - 30 * M, { forceChargeLineReOnAtMs: WIN_END - 30 * M - 2 * M, forceChargeLineReOnSlots: null });
  assert.equal(due(handed, WIN_END - 30 * M, flatOn(52, { slotsOn: [] }))?.cause, 'reOnRefused');
  // A slot off with its Core at the panel's stop does not count: every slot that counts reads on, and the flat reading waits.
  assert.equal(due(flatNight(52, early), early, flatOn(52, { slotsOn: [1, 2], slotSocPct: { 1: 52, 2: 52, 3: 80 } })), null, 'the third at the stop');
  // Falling, at any time, at or under ⌈L⌉ or above it.
  const falling = (now: number, ref: number) => due(flatNight(ref, early), early, flatOn(now));
  assert.equal(falling(51, 52)?.cause, 'onNotRising');
  assert.equal(falling(59, 60)?.cause, 'onNotRising', 'above ⌈L⌉, under the start target');
  // A cost-dominant night's flat pool is held like any other: its cost walk cannot tell a slow charge either.
  const cost = { forceChargeCeilingPct: 90, forceChargeLineAskPct: 70, forceChargeLinePct: 69.4, forceChargeMode: 'cost', forceChargeCeilingSyncedPct: 90 };
  assert.equal(due(flatNight(66, early, cost), early, flatOn(66, { enabled: true, ceilingReadbackPct: 90 })), null, 'held');
  const cg = nfc.lineLatestStartMs(WIN_END, 70, 66, FULL, null, null, 3) - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS;
  assert.equal(due(flatNight(66, cg, cost), cg, flatOn(66, { enabled: true, ceilingReadbackPct: 90 }))?.cause, 'costMode');
});

test('★★★ W1 (Fix12) a pool size not known holds nothing: every doubt goes to the push; a flat pool above ⌈L⌉ stays out, past the gate too', () => {
  const due = nfc.lineAtRiskPushDue;
  const early = WIN_END - 5 * H;
  for (const fullKwh of [null, 0, -1, Number.NaN] as Array<number | null>) {
    assert.equal(nfc.lineFlatPushHeld(early, WIN_END, ASK, 52, fullKwh, 3), false, String(fullKwh));
    assert.equal(due(flatNight(52, early), early, flatOn(52, { fullKwh }))?.cause, 'onNotRising', String(fullKwh));
  }
  assert.equal(nfc.lineFlatPushHeld(early, WIN_END, ASK, 52, undefined, 3), false);
  assert.equal(nfc.lineFlatPushHeld(early, WIN_END, ASK, 52, FULL, 3), true, 'the control');
  const late = WIN_END - 25 * M;
  assert.equal(due(flatNight(57, late), late, flatOn(57)), null, 'flat above ⌈L⌉, inside the gate');
  assert.equal(due(flatNight(57, late), late, flatOn(57, { fullKwh: null })), null, 'and with no pool size');
});

test('★★★ W1 (Fix12) a held tick spends nothing: the same night, after a held flat reading, is pushed for the real thing; a run of held ticks stamps no record', () => {
  const due = nfc.lineAtRiskPushDue;
  // Hours of a slow charge, read flat on every tick, the walk a person sees: nothing returned, so index.ts stamps nothing.
  let t = WIN_END - 5 * H;
  const s = flatNight(52, t);
  for (; t < WIN_END - 3 * H; t += M) assert.equal(due({ ...s, forceChargeLinePoolSamples: [{ pct: 52, atMs: t - 12 * M }, { pct: 52, atMs: t - 2 * M }] }, t, flatOn(52)), null);
  assert.equal(s.forceChargeLineAtRiskPushedAtMs, null, 'the once-a-night stamp is free');
  // The real thing, later the same night: the pool falls, and it is pushed.
  const fell = { ...s, forceChargeLinePoolSamples: [{ pct: 55, atMs: t - 12 * M }, { pct: 54, atMs: t - 2 * M }] };
  assert.equal(due(fell, t, flatOn(52))?.cause, 'onNotRising');
  assert.equal(due(fell, t, flatOn(52))?.refPct, 55, 'against its own reading');
});

test('★★★ W1 (review 4) a re-ON checked NOT APPLIED, or never written, is no ON of ours: the trend reads past it, and the night is pushed as soon as the check says so', () => {
  const due = nfc.lineAtRiskPushDue;
  const ref = nfc.lineTrendReference;
  // The round-4 reviewer's night (the close plant's 'reOnInert'): re-ONs 54 and 38 min before the close, both checked not
  // applied (39 and 23 min before), the pool falling 60 → 58 under the 61% start target with every slot reading OFF. A
  // minute after the second check, 22 min before the close, the push is due, naming the re-ON that has not taken effect
  // (Fix8 review 1: index.ts now judges the check's own tick too, so it goes there, 23 min before — PIN_REON_INERT's example).
  // Taken as an ON of ours, the second re-ON barred every reference before 23 min out — none 10 min old fits before the lead.
  const C = WIN_END;
  const failedTwice = (over: Record<string, unknown> = {}) => onNight({
    forceChargeLineReOns: 2, forceChargeLineReOnAtMs: C - 38 * M, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineReOnCheckedAtMs: C - 23 * M, forceChargeLineReOnNotAppliedSlots: [1, 2, 3], forceChargeLineReOnsNotApplied: 2,
    forceChargeLinePoolSamples: [{ pct: 60, atMs: C - 40 * M }, { pct: 59, atMs: C - 30 * M }], ...over,
  });
  const offNow = offReading({ poolSocPct: 58, slotSocPct: at(58) });
  assert.equal(decideForceCharge(failedTwice(), C - 22 * M, offNow).kind, 'none', 'the budget is spent: the add-on cannot act');
  const risk = due(failedTwice(), C - 22 * M, offNow);
  assert.equal(risk?.cause, 'reOnNotApplied');
  assert.deepEqual([risk?.refPct, risk?.refAtMs, risk?.offSlots, risk?.reOnNotAppliedSlots], [60, C - 40 * M, [1, 2, 3], [1, 2, 3]]);
  // The reference reads past the failed re-ON to the ON's own grace (the ON at 01:00 here).
  assert.equal(nfc.lastLineReOnApplied(failedTwice()), false);
  assert.deepEqual(ref(failedTwice(), C - 22 * M), { pct: 60, atMs: C - 40 * M });
  // A re-ON NOT YET CHECKED may still take effect: it bars the trend as before (no push against the fall that called for it).
  const unchecked = failedTwice({ forceChargeLineReOnCheckedAtMs: C - 39 * M, forceChargeLineReOnNotAppliedSlots: [1, 2, 3] });
  assert.equal(nfc.lastLineReOnApplied(unchecked), null);
  assert.equal(ref(unchecked, C - 22 * M), null);
  assert.equal(due(unchecked, C - 22 * M, offNow), null);
  // A re-ON whose every write came back rate-limited never reached the panel (no slots on the record): read past too.
  const limited = failedTwice({ forceChargeLineReOns: 1, forceChargeLineReOnSlots: null, forceChargeLineReOnCheckedAtMs: C - 39 * M,
    forceChargeLineReOnsNotApplied: 1 });
  assert.deepEqual(ref(limited, C - 22 * M), { pct: 60, atMs: C - 40 * M });
  // A check that found ONE slot took it: that re-ON is an ON of ours (lastLineReOnApplied true) — the trend waits its grace.
  const partly = failedTwice({ forceChargeLineReOnNotAppliedSlots: [2], forceChargeLineReOnAppliedAtMs: C - 38 * M });
  assert.equal(ref(partly, C - 22 * M), null);
  // An earlier re-ON that DID take effect stays the last ON of ours: a reference inside its grace says nothing, one after it counts.
  const tookFirst = (appliedAt: number) => failedTwice({ forceChargeLineReOnAppliedAtMs: appliedAt, forceChargeLineReOnsNotApplied: 1 });
  assert.equal(ref(tookFirst(C - 50 * M), C - 22 * M), null, 'the 40-min-out reading is inside the first re-ON\'s grace');
  assert.deepEqual(ref(tookFirst(C - 55 * M), C - 22 * M), { pct: 60, atMs: C - 40 * M }, 'the first re-ON + 15 min');
  assert.equal(due(tookFirst(C - 55 * M), C - 22 * M, offNow)?.cause, 'reOnNotApplied');
  // The ON-reading shape reads the same reference.
  assert.equal(nfc.lineOnReadingShape(failedTwice(), C - 22 * M, onReading()) != null, true);
  assert.equal(nfc.lineOnReadingShape(unchecked, C - 22 * M, onReading()), null);
});

/** (review 5) One tick as index.ts runs it on a line night: the observations on the record before the decision, the re-ON
 *  check's stamp, and (judgeLineNight) the at-risk push and the ON-reading shape — on a tick that decides nothing and (Fix8
 *  review 1) on the re-ON's readback check, after its stamp — each once a night, stamped on the record first. */
const tick = (s: S, t: number, o: ForceChargeOpts): { s: S; kind: string; push: nfc.LineAtRisk | null; shape: nfc.LineOnReadingShape | null } => {
  const obs = nfc.lineNightObservations(s, t, o);
  let rec = obs != null ? ({ ...s, ...obs } as S) : s;
  const a = decideForceCharge(rec, t, o);
  if (a.kind === 'lineReOnChecked') rec = { ...rec, ...nfc.lineReOnCheckedStamp(rec, t, a) } as S;
  const judged = a.kind === 'none' || a.kind === 'lineReOnChecked';
  const push = judged ? nfc.lineAtRiskPushDue(rec, t, o) : null;
  if (push != null) rec = { ...rec, forceChargeLineAtRiskPushedAtMs: t } as S; // write-ahead, once a night
  const shape = judged ? nfc.lineOnReadingShape(rec, t, o) : null;
  if (shape != null) rec = { ...rec, forceChargeLineShapeLoggedAtMs: t } as S; // write-ahead, once a night
  return { s: rec, kind: a.kind, push, shape };
};
/** Drive minutes `from`..`to` after `t0` through `tick`, the readback and the pool given per minute. */
const drive = (s0: S, t0: number, from: number, to: number, slotsOn: (m: number) => number[] | null, pool: (m: number) => number) => {
  let s = s0;
  const out: Array<{ m: number; kind: string; push: nfc.LineAtRisk | null; shape: nfc.LineOnReadingShape | null }> = [];
  for (let m = from; m <= to; m++) {
    const r = tick(s, t0 + m * M, fo({ poolSocPct: pool(m), slotsOn: slotsOn(m), slotSocPct: at(pool(m)) }));
    s = r.s;
    out.push({ m, kind: r.kind, push: r.push, shape: r.shape });
  }
  return { s, out };
};

test('★★★ W1 (review 5) a re-ON checked not applied whose slots then read ON (a late apply, a glitch at the check) is waited out from that reading: no push, no shape log on a pool now charging', () => {
  // The round-5 reviewer's probe: a re-ON at 03:00 after the panel's stop (the slots read OFF on the record), the pool
  // falling 60 → 58. LATE: the check at +15 finds every slot still OFF (not applied); at +16 the slots read ON and the
  // pool climbs from 58. Read past the "not applied" re-ON to the ON at 01:00, the 60 at +5 made the next ticks a pool
  // "falling" with Charge Now ON: the night's one push ('onNotRising', "switching it off and on again … may restart the
  // charge") and the shape log fired on the re-ON working.
  const R = WIN_END - 2 * H;
  const at0 = onNight({ forceChargeLinePanelOffAtMs: R - 40 * M, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: R, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineOffSlots: [1, 2, 3], forceChargeLinePoolSamples: [{ pct: 61, atMs: R - 5 * M }] });
  const climbing = (m: number) => (m < 7 ? 60 : m < 14 ? 59 : m < 20 ? 58 : 59 + Math.floor((m - 20) / 5));
  const late = drive(at0, R, 1, 45, (m) => (m <= 15 ? [] : [1, 2, 3]), climbing);
  assert.equal(late.out.find((x) => x.m === 15)?.kind, 'lineReOnChecked');
  assert.equal(nfc.lastLineReOnApplied(late.s), false, 'the check found it not applied');
  assert.deepEqual(late.out.filter((x) => x.push != null || x.shape != null).map((x) => `+${x.m} ${x.push?.cause ?? ''} ${x.shape != null ? 'shape' : ''}`), [], 'no push, no shape on the late apply');
  assert.equal(late.s.forceChargeLineOnSeenAtMs, R + 16 * M, 'the slots seen ON at +16');
  // GLITCH: the re-ON took at +2 (the slots read ON), but the readback at the check, +15, showed every slot OFF; ON again at
  // +16. The pool, slow beside a load, sits a point under the 60 taken at the re-ON (59 to +20, then rising).
  const glitch = drive({ ...at0, forceChargeLinePoolSamples: [{ pct: 62, atMs: R - 10 * M }, { pct: 60, atMs: R }] } as S, R, 1, 45,
    (m) => (m < 2 || m === 15 ? [] : [1, 2, 3]), (m) => (m <= 20 ? 59 : 59 + Math.floor((m - 20) / 5)));
  assert.equal(glitch.out.find((x) => x.m === 15)?.kind, 'lineReOnChecked');
  assert.equal(nfc.lastLineReOnApplied(glitch.s), false);
  assert.deepEqual(glitch.out.filter((x) => x.push != null || x.shape != null).map((x) => `+${x.m} ${x.push?.cause ?? ''} ${x.shape != null ? 'shape' : ''}`), [], 'no push, no shape on the glitch');
  assert.equal(glitch.s.forceChargeLineOnSeenAtMs, R + 16 * M, 'seen ON again after the one all-OFF reading (not at +2: the re-ON\'s own grace)');
  // The wait is the readback grace after the reading that saw it, as for an ON of ours: a reference 15 min after it counts.
  const seen = R + 16 * M;
  const after = (refAt: number) => ({ ...late.s, forceChargeLinePoolSamples: [{ pct: 62, atMs: refAt }] } as S);
  assert.equal(nfc.lineTrendReference(after(seen + 15 * M - 1), seen + 26 * M), null);
  assert.deepEqual(nfc.lineTrendReference(after(seen + 15 * M), seen + 26 * M), { pct: 62, atMs: seen + 15 * M });
  assert.equal(nfc.lineAtRiskPushDue(after(seen + 15 * M), seen + 26 * M, onReading())?.cause, 'onNotRising', 'a pool falling after the wait is pushed');
  // A seen ON older than the last ON of ours (the ON at 01:00, read past the failed re-ON) waits nothing extra.
  assert.deepEqual(nfc.lineTrendReference({ ...after(R + 20 * M), forceChargeLineOnSeenAtMs: R - 3 * H } as S, R + 31 * M), { pct: 62, atMs: R + 20 * M });
  // …and never shortens the wait of a later ON of ours: the slots seen ON at +16 stopped again at the panel's ceiling, a
  // re-ON at +30 took effect, and a reading 10 min after that re-ON is inside ITS grace (not past the +16 one's).
  const Q = R + 30 * M;
  const laterReOn = { ...after(Q + 10 * M), forceChargeLineReOns: 2, forceChargeLineReOnAtMs: Q, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineReOnCheckedAtMs: Q + 15 * M, forceChargeLineReOnNotAppliedSlots: [], forceChargeLineReOnAppliedAtMs: Q } as S;
  assert.equal(laterReOn.forceChargeLineOnSeenAtMs, seen);
  assert.equal(nfc.lineTrendReference(laterReOn, Q + 21 * M), null, 'inside the later re-ON\'s grace');
  assert.deepEqual(nfc.lineTrendReference({ ...laterReOn, forceChargeLinePoolSamples: [{ pct: 62, atMs: Q + 15 * M }] } as S, Q + 26 * M), { pct: 62, atMs: Q + 15 * M });
});

test('★★★ W1 (review 5) Charge Now switched on in the app after the push is waited out: the ON-reading shape is not logged on the person\'s fix', () => {
  // The close plant's reOnInert night with a person following the push: both re-ONs checked not applied, the push sent at P
  // naming slots 1, 2, 3 reading OFF, the pool falling 60 → 58. Five minutes later the person switches Charge Now on: the
  // slots read ON, their Cores under the stop, and the pool sits under the 60 taken 17 min before — the shape the log keeps
  // for the unmeasured latch ("a slot reading ON that does not import"), on the person's fix.
  const P = WIN_END - 50 * M;
  const pushed = onNight({ forceChargeLineReOns: 2, forceChargeLineReOnAtMs: P - 20 * M, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineReOnCheckedAtMs: P - 5 * M, forceChargeLineReOnNotAppliedSlots: [1, 2, 3], forceChargeLineReOnsNotApplied: 2,
    forceChargeLineAtRiskPushedAtMs: P, forceChargeLineOffSlots: [1, 2, 3], forceChargeLinePoolSamples: [{ pct: 60, atMs: P - 12 * M }, { pct: 59, atMs: P - 2 * M }] });
  const run = drive(pushed, P, 1, 40, (m) => (m < 5 ? [] : [1, 2, 3]), (m) => (m < 10 ? 58 : 58 + Math.floor((m - 5) / 5)));
  assert.deepEqual(run.out.filter((x) => x.shape != null).map((x) => `+${x.m}`), [], 'no shape log on the person\'s ON');
  assert.equal(run.s.forceChargeLineOnSeenAtMs, P + 5 * M);
  assert.ok(run.out.every((x) => x.push == null), 'the push is once a night');
});

test('★★★ W1 (Fix9) an ON verified LATE — its slots first read ON 15 min or more after its last attempt (after its re-issue and its failure warning) — is waited out from that reading like an ON seen: no push the tick after the late verify against the pool from before it; the push still goes on a fall against a reading taken 15 min or more after it', () => {
  const lateAt = (nfc as unknown as { onVerifiedLateAtMs?: (s: unknown) => number | null }).onVerifiedLateAtMs;
  // Round 7's carried open issue (b): line 55.55, the ON 3 h before the close, the pool held at the 50% reserve while the slots
  // read OFF, the re-issue at +15, the failure warning at +30; the slots read ON from +X, and the pool climbs a point every 5 min
  // after a 5-min lag. The slots read OFF are on the record only after the verify (lineNightObservations), so no ON is seen: with
  // +40, +45 or +60 the tick after the verify pushed 'onNotRising' (pool 50, against the 50 read before the slots read ON) and
  // spent the night's one push; from +31, none.
  const T0 = WIN_END - 3 * H;
  const fresh = night({ forceChargeOnAtMs: T0, forceChargeSlots: [1, 2, 3], forceChargeOnLastAttemptMs: T0, forceChargeMode: 'line', forceChargeCeilingSyncedPct: 80 });
  /** One tick as index.ts runs it from the ON: the observations, the decision and its stamp (the re-issue, the failure warning,
   *  the verify, a re-ON's check), and judgeLineNight on a tick that decides nothing or checks a re-ON. */
  const onTick = (s: S, t: number, o: ForceChargeOpts) => {
    const obs = nfc.lineNightObservations(s, t, o);
    let rec = obs != null ? ({ ...s, ...obs } as S) : s;
    const a = decideForceCharge(rec, t, o);
    if (a.kind === 'onRetry') rec = { ...rec, forceChargeOnRetries: rec.forceChargeOnRetries + 1, forceChargeOnLastAttemptMs: t } as S;
    if (a.kind === 'onFailed') rec = { ...rec, forceChargeOnFailedAtMs: t, forceChargeOnFailedSlots: [...a.slots] } as S;
    if (a.kind === 'onVerified') rec = { ...rec, forceChargeOnVerifiedAtMs: t } as S;
    if (a.kind === 'lineReOnChecked') rec = { ...rec, ...nfc.lineReOnCheckedStamp(rec, t, a) } as S;
    const judged = a.kind === 'none' || a.kind === 'lineReOnChecked';
    const push = judged ? nfc.lineAtRiskPushDue(rec, t, o) : null;
    if (push != null) rec = { ...rec, forceChargeLineAtRiskPushedAtMs: t } as S;
    const shape = judged ? nfc.lineOnReadingShape(rec, t, o) : null;
    if (shape != null) rec = { ...rec, forceChargeLineShapeLoggedAtMs: t } as S;
    return { s: rec, kind: a.kind, push, shape };
  };
  const run = (onFrom: number, pool: (m: number) => number, to = 150) => {
    let s = fresh;
    const kinds = new Map<number, string>();
    const pushes: string[] = [];
    const shapes: string[] = [];
    for (let m = 1; m <= to; m++) {
      const p = pool(m);
      const r = onTick(s, T0 + m * M, fo({ poolSocPct: p, slotSocPct: at(p), slotsOn: m >= onFrom ? [1, 2, 3] : [] }));
      s = r.s;
      kinds.set(m, r.kind);
      if (r.push != null) pushes.push(`+${m} ${r.push.cause} pool ${r.push.poolPct} ref ${r.push.refPct}`);
      if (r.shape != null) shapes.push(`+${m}`);
    }
    return { s, kinds, pushes, shapes };
  };
  const climbing = (X: number) => (m: number) => (m < X + 5 ? 50 : 50 + Math.floor((m - X) / 5));
  for (const X of [40, 45, 60, 31]) {
    const r = run(X, climbing(X));
    assert.deepEqual([r.kinds.get(15), r.kinds.get(30), r.kinds.get(X)], ['onRetry', 'onFailed', 'onVerified'], `+${X}`);
    assert.deepEqual(r.pushes, [], `slots ON from +${X}: no push on a pool beginning to charge`);
    assert.deepEqual(r.shapes, [], `slots ON from +${X}: no shape log`);
    assert.equal(lateAt?.(r.s), T0 + X * M, `+${X}: verified late`);
  }
  // …and the push still goes on a fall after the wait: ON from +40, the pool up to 53 by +55, then a load takes the grid cap and it
  // falls a point. The reference must be a reading taken at +55 or later (the verify + 15 min): the 53 at +61, judged at +71.
  const falls = run(40, (m) => (m < 45 ? 50 : m <= 61 ? Math.min(53, 50 + Math.floor((m - 40) / 5)) : 52));
  assert.deepEqual(falls.pushes, ['+71 onNotRising pool 52 ref 53']);
  // The boundary is the ON seen's (review 5): a reference 15 min after the late verify counts, one a millisecond sooner does not.
  const V = T0 + 40 * M;
  const verifiedLate = { ...fresh, forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: T0 + 15 * M, forceChargeOnFailedAtMs: T0 + 30 * M,
    forceChargeOnFailedSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: V } as S;
  const withRef = (s: S, refAt: number) => ({ ...s, forceChargeLinePoolSamples: [{ pct: 53, atMs: refAt }] } as S);
  assert.equal(nfc.lineTrendReference(withRef(verifiedLate, V + 15 * M - 1), V + 26 * M), null);
  assert.deepEqual(nfc.lineTrendReference(withRef(verifiedLate, V + 15 * M), V + 26 * M), { pct: 53, atMs: V + 15 * M });
  // Late is 15 min or more after the LAST attempt (the re-issue, else the ON): a verify inside that grace is the ON's own, as before.
  assert.equal(lateAt?.({ ...verifiedLate, forceChargeOnVerifiedAtMs: T0 + 30 * M }), T0 + 30 * M);
  assert.equal(lateAt?.({ ...verifiedLate, forceChargeOnVerifiedAtMs: T0 + 30 * M - 1 }), null);
  assert.equal(lateAt?.({ ...verifiedLate, forceChargeOnLastAttemptMs: null, forceChargeOnVerifiedAtMs: T0 + 15 * M }), T0 + 15 * M, 'no re-issue: from the ON');
  assert.equal(lateAt?.({ ...verifiedLate, forceChargeOnLastAttemptMs: null, forceChargeOnVerifiedAtMs: T0 + 15 * M - 1 }), null);
  assert.equal(lateAt?.(onNight()), null, 'the usual verify, 5 min after the ON');
  assert.equal(lateAt?.({ ...fresh, forceChargeOnVerifiedAtMs: null } as S), null, 'not verified');
  // A seen ON after the late verify (the panel's stop, then Charge Now switched on in the app) is waited out from its own reading…
  const seenAfter = { ...verifiedLate, forceChargeLineOnSeenAtMs: V + 60 * M } as S;
  assert.equal(nfc.lineTrendReference(withRef(seenAfter, V + 70 * M), V + 81 * M), null);
  assert.deepEqual(nfc.lineTrendReference(withRef(seenAfter, V + 75 * M), V + 86 * M), { pct: 53, atMs: V + 75 * M });
  // …a seen ON older than the late verify waits nothing extra over it, and a later re-ON of ours waits its own grace.
  assert.equal(nfc.lineTrendReference(withRef({ ...verifiedLate, forceChargeLineOnSeenAtMs: V - 5 * M } as S, V + 15 * M - 1), V + 26 * M), null);
  const reOnAfter = { ...verifiedLate, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: V + 30 * M, forceChargeLineReOnSlots: [1, 2, 3] } as S;
  assert.equal(nfc.lineTrendReference(withRef(reOnAfter, V + 40 * M), V + 51 * M), null);
  assert.deepEqual(nfc.lineTrendReference(withRef(reOnAfter, V + 45 * M), V + 56 * M), { pct: 53, atMs: V + 45 * M });
  // The at-risk push and the ON-reading shape both read this reference.
  assert.ok(NFC_SRC.includes('  const ref = lineTrendReference(s, nowMs);\n  if (ref == null || o.poolSocPct > ref.pct) return null;'));
  assert.ok(NFC_SRC.includes('  const ref = lineTrendReference(s, nowMs);\n  if (ref == null || !(o.poolSocPct < ref.pct)) return null;'));
});

test('★★★ W1 (review 5) a re-ON handed back (every write rate-limited): no push while its retry can still come; past the cutoff, \'reOnRefused\' — never the gates', () => {
  const due = nfc.lineAtRiskPushDue;
  // The round-5 reviewer's probe: the panel's stop on record, the pool 61 → 60 → 59 under the 61% start target, the slots
  // OFF, and the night's first re-ON at 03:00 handed back. The grid is present, vitals green, the ceiling read back: the
  // add-on's retry comes at +15. A push meanwhile said "it needs the grid known present, healthy host vitals and a live
  // panel reading" — all three held — and spent the night's only push 14 min before the add-on switched Charge Now back on.
  const handedBack = (H0: number) => onNight({ forceChargeLinePanelOffAtMs: H0 - 30 * M, forceChargeLineReOns: 0, forceChargeLineReOnAtMs: H0,
    forceChargeLineReOnSlots: null, forceChargeLineOffSlots: [1, 2, 3], forceChargeLinePoolSamples: [{ pct: 61, atMs: H0 - 12 * M }, { pct: 60, atMs: H0 - 2 * M }] });
  const H0 = WIN_END - 2 * H;
  const off59 = offReading({ poolSocPct: 59, slotSocPct: at(59) });
  for (const m of [1, 5, 9, 14]) {
    assert.equal(decideForceCharge(handedBack(H0), H0 + m * M, off59).kind, 'none', `+${m}`);
    assert.equal(due(handedBack(H0), H0 + m * M, off59), null, `+${m}: the retry is the add-on's`);
  }
  assert.deepEqual(decideForceCharge(handedBack(H0), H0 + 15 * M, off59), { kind: 'lineReOn', slots: [1, 2, 3] });
  // A retry the re-ON's cutoff (20 min before the close) would refuse is none: the push goes, with its own cause — not the
  // gates. The hand-back 35 min before the close: its retry instant IS the cutoff.
  const last = WIN_END - 35 * M;
  assert.equal(nfc.lineReOnDue(handedBack(last), last + 15 * M, off59, [1, 2, 3]), null, 'the cutoff refuses the retry');
  assert.equal(due(handedBack(last), last + M, off59)?.cause, 'reOnRefused');
  // (review 8) A millisecond earlier the retry fits, but its tick is due within a tick of the cutoff: pushed at once (the retry
  // may follow, and the push says it may). A full tick earlier, held.
  assert.equal(due(handedBack(last - 1), last - 1 + M, off59)?.cause, 'reOnRefused', 'the retry due within a tick of the cutoff');
  assert.equal(due(handedBack(last - M - 1), last - 1, off59), null, 'due a full tick before the cutoff: held');
  assert.equal(due(handedBack(last - M), last, off59)?.cause, 'reOnRefused');
  assert.equal(due(handedBack(WIN_END - 30 * M), WIN_END - 29 * M, off59)?.cause, 'reOnRefused');
  // After the spacing the push is the gates' to explain (here the grid not known present), as for any re-ON held.
  assert.equal(due(handedBack(H0), H0 + 16 * M, offReading({ poolSocPct: 59, slotSocPct: at(59), gridPresent: null }))?.cause, 'reOnHeld');
  // The words: the add-on's own write cooldown refused it, and (review 8) whether its retry can still come at all — its
  // spacing ends before the re-ON's cutoff (reOnRetryPossible): it may try once more; it ends at or past it: no tick brings it.
  const build = (notify as unknown as { buildLineForceChargeAtRisk: (o: unknown) => { body: string } }).buildLineForceChargeAtRisk;
  const risk = due(handedBack(last), last + M, off59);
  assert.equal(risk?.reOnRetryPossible, false, 'the stamp + 15 min IS the cutoff: no retry can come');
  const body = build({ day: '2026-09-16', risk, closeText: '5am', reOnCutoffText: '4:40am' }).body;
  assert.ok(body.includes("The add-on's last try to switch Charge Now back on was refused by its own write cooldown; its next try would come after ~4:40am, when it no longer switches Charge Now back on. "
    + 'Charge Now switched on for slot(s) 1, 2, 3 in the EcoFlow app can still lift the pool (the add-on switches it off at the close).'), body);
  assert.doesNotMatch(body, /grid known present|No action needed|does not try again|may try once more/);
  const mayRisk = due(handedBack(last - 1), last - 1 + M, off59);
  assert.equal(mayRisk?.reOnRetryPossible, true, 'a millisecond earlier a tick may bring it');
  const may = build({ day: '2026-09-16', risk: mayRisk, closeText: '5am', reOnCutoffText: '4:40am' }).body;
  assert.ok(may.includes("The add-on's last try to switch Charge Now back on was refused by its own write cooldown; it may try once more before ~4:40am if the cooldown allows. "
    + 'Charge Now switched on for slot(s) 1, 2, 3 in the EcoFlow app can still lift the pool (the add-on switches it off at the close).'), may);
  assert.doesNotMatch(may, /grid known present|No action needed|does not try again|next try would come after/);
  // Every other cause carries no retry: false.
  assert.equal(due(handedBack(H0), H0 + 16 * M, offReading({ poolSocPct: 59, slotSocPct: at(59), gridPresent: null }))?.reOnRetryPossible, false);
});

/** (review 6) A re-ON handed back (every write rate-limited) on the tick at `tHb`, stamped `lagMs` after it (index.ts stamps
 *  Date.now() after its writes): the panel's stop 30 min before, the pool 61 → 60 → 59, the slots reading OFF. */
const handedBackAt = (tHb: number, lagMs: number): S => onNight({ forceChargeLinePanelOffAtMs: tHb - 30 * M, forceChargeLineReOns: 0,
  forceChargeLineReOnAtMs: tHb + lagMs, forceChargeLineReOnSlots: null, forceChargeLineOffSlots: [1, 2, 3],
  forceChargeLinePoolSamples: [{ pct: 61, atMs: tHb - 12 * M }, { pct: 60, atMs: tHb - 2 * M }] });
const OFF59 = offReading({ poolSocPct: 59, slotsOn: [], slotSocPct: at(59) });
/** The hand-back's own tick (review 8: index.ts judges the push there, +0) and every tick after it, past the cutoff: the
 *  retry, and the push. Tick k fires k × (FORCE_CHARGE_TICK_MS + `driftMs`) after the hand-back's (setInterval re-arms from
 *  each callback's start, so the ticks drift later) and (review 7) reads its nowMs `lateMs(k)` after it fires. The push is
 *  once a night and the ticks run on after it, so a retry after a 'reOnRefused' push is seen. (review 8) A 'reOnRefused'
 *  push worded "its next try would come after ~<cutoff>" (reOnRetryPossible false) followed by the retry fails here, in
 *  every sweep that drives it. */
const afterHandBack = (tHb: number, lagMs: number, driftMs = 0, lateMs: (k: number) => number = () => 0): string[] => {
  let s = handedBackAt(tHb, lagMs);
  const ev: string[] = [];
  let sure: string | null = null;
  const pushed = (p: nfc.LineAtRisk, k: number): void => {
    ev.push(`+${k} push ${p.cause}`);
    if (p.cause === 'reOnRefused' && p.reOnRetryPossible !== true) sure = `+${k}`;
  };
  const p0 = nfc.lineAtRiskPushDue(s, tHb, OFF59);
  if (p0 != null) { pushed(p0, 0); s = { ...s, forceChargeLineAtRiskPushedAtMs: tHb } as S; }
  for (let k = 1; tHb + k * (M + driftMs) + lateMs(k) < WIN_END - 15 * M; k++) {
    const r = tick(s, tHb + k * (M + driftMs) + lateMs(k), OFF59);
    s = r.s;
    if (r.push != null) pushed(r.push, k);
    if (r.kind !== 'none') { ev.push(`+${k} ${r.kind}`); if (r.kind === 'lineReOn') break; }
  }
  if (sure != null && ev.some((e) => e.endsWith('lineReOn'))) assert.fail(`${tHb} lag ${lagMs}: pushed at ${sure} as no retry can come, then ${ev.join(', ')}`);
  return ev;
};
/** The hand-backs of a sweep with neither the retry nor the push, and with both (a 'reOnRefused' push, then the retry). */
const handBackOutcomes = (runs: Array<[string, string[]]>): { neither: string[]; both: string[] } => {
  const neither: string[] = [];
  const both: string[] = [];
  for (const [label, ev] of runs) {
    const retry = ev.some((e) => e.endsWith('lineReOn'));
    const pushed = ev.some((e) => e.includes(' push '));
    if (!retry && !pushed) neither.push(label);
    if (retry && pushed) both.push(`${label}: ${ev.join(', ')}`);
  }
  return { neither, both };
};

test('★★★ W1 (review 6) the hand-back hold counts the ticks: the retry is the first tick 15 min or more after a stamp written after the writes — no hand-back with a tick left before the cutoff loses both its retry and the push', () => {
  // The round-6 reviewer's probe: index.ts stamps a hand-back (forceChargeLineReOnAtMs: Date.now()) after its writes, a little
  // after its tick's nowMs, and the tick runs every FORCE_CHARGE_TICK_MS (index.ts's setInterval). Fifteen ticks on, the tick
  // reads 15 min less that lag: the retry is the 16th. Held while the stamp + 15 min fell before the cutoff, a hand-back 35-36
  // min before the close got neither its retry (the cutoff refused the 16th tick) nor the push (the lead refused it too).
  const SEC = 1000;
  const after = afterHandBack;
  // The probe's hand-backs, 35m50s and 35m30s before the close, the writes stamped 2 s after their tick: the 16th tick falls
  // past the cutoff, so there is no retry — (review 8) the push goes on the hand-back's own tick, as 'reOnRefused'.
  assert.deepEqual(after(WIN_END - 35 * M - 50 * SEC, 2 * SEC), ['+0 push reOnRefused']);
  assert.deepEqual(after(WIN_END - 35 * M - 30 * SEC, 2 * SEC), ['+0 push reOnRefused']);
  // On the minute (the close plant's ticks) with the writes 2 s late: the 16th tick IS the cutoff instant, which refuses it.
  assert.deepEqual(after(WIN_END - 36 * M, 2 * SEC), ['+0 push reOnRefused']);
  // Ten seconds earlier the 16th tick is still before the cutoff, but (review 8) within a tick of it: the push goes at once,
  // and the retry still comes on the 16th — the push said it may. A full tick earlier, held, and the retry alone.
  assert.deepEqual(after(WIN_END - 36 * M - 10 * SEC, 2 * SEC), ['+0 push reOnRefused', '+16 lineReOn']);
  assert.deepEqual(after(WIN_END - 37 * M + 10 * SEC, 2 * SEC), ['+0 push reOnRefused', '+16 lineReOn']);
  assert.deepEqual(after(WIN_END - 37 * M - 1, 2 * SEC), ['+16 lineReOn']);
  // Stamped on its tick's own millisecond, the 15th tick is the retry, a tick before the cutoff: pushed, then the retry.
  assert.deepEqual(after(WIN_END - 36 * M, 0), ['+0 push reOnRefused', '+15 lineReOn']);
  // Swept: hand-back ticks 34-38 min before the close every 5 s, the stamp 0 ms, 1 ms, 2 s or 20 s after its tick, the ticks on
  // the cadence or drifting 1 ms each. Every hand-back gets its retry or the push — never neither (the reviewer's sweep of
  // eed0363a: none from 35m05s to 36m00s out whenever the lag exceeded the drift). (review 7 also kept a 'reOnRefused' push
  // from being followed by the retry; review 8 gives that up for the full tick of margin: 288 of the 882, each a hand-back
  // whose retry's tick falls within a tick of the cutoff, pushed in words that say the add-on may try once more.)
  const runs: Array<[string, string[]]> = [];
  for (let back = 38 * M; back >= 34 * M; back -= 5 * SEC) {
    for (const lag of [0, 1, 2, 3, 5, 10, 15, 2 * SEC, 20 * SEC]) {
      for (const drift of [0, 1]) runs.push([`${back / SEC}s out, lag ${lag} ms, drift ${drift} ms`, after(WIN_END - back, lag, drift)]);
    }
  }
  const { neither, both } = handBackOutcomes(runs);
  assert.deepEqual(neither, [], 'a hand-back with neither its retry nor the push');
  assert.equal(both.length, 288, "a 'reOnRefused' push, then the retry");
  assert.ok(both.every((b) => b.includes(': +0 push reOnRefused, +')), both.find((b) => !b.includes(': +0 push reOnRefused, +')));
  // The cadence the hold counts is the one index.ts runs the tick on: the actuation tick, and the safety tick.
  assert.equal(nfc.FORCE_CHARGE_TICK_MS, 60_000);
  assert.ok(INDEX.includes('setInterval(() => { void runNightActuationTick(); }, FORCE_CHARGE_TICK_MS);'), 'the actuation tick runs on the cadence the hold counts');
  assert.match(INDEX, /runForceChargeTick\(\{ forceDisabled: true \}\)[\s\S]{0,300}\n\}, FORCE_CHARGE_TICK_MS\);\nforceChargeSafetyTick\.unref\(\);/, 'and the safety tick');
});

test('★★★ W1 (review 7, review 8) the ticks run late and read late: a \'reOnRefused\' push followed by the retry is allowed, in words that say it may come — never neither', () => {
  // The round-7 reviewer's probe: the push is once a night, so one judged on an early tick is not taken back by a later one.
  // Stamped 5 ms after its tick 35m30s before the close, with the ticks 1 ms late each, 36beb4b8 pushed "it does not try again
  // tonight" and the 15th tick brought the retry 14 min later. Review 7 counted to the earliest tick (a 1-s tolerance), and
  // its own final review found both windows again (a tick read late on either side). (review 8) Pushed at once, on the
  // hand-back's own tick, in words true either way; the retry comes on the 15th tick, before the cutoff.
  const SEC = 1000;
  const cutoff = WIN_END - nfc.FORCE_CHARGE_ON_RETRY_CUTOFF_MS;
  assert.deepEqual(afterHandBack(WIN_END - 35 * M - 30 * SEC, 5, 1), ['+0 push reOnRefused', '+15 lineReOn']);
  // On the cadence the retry would be the 16th tick, past the cutoff: none. Pushed on the hand-back's tick (review 7 waited for
  // the 15th, 14 min, to push).
  assert.deepEqual(afterHandBack(WIN_END - 35 * M - 30 * SEC, 5, 0), ['+0 push reOnRefused']);
  assert.deepEqual(afterHandBack(WIN_END - 35 * M - 30 * SEC, 2 * SEC, 1), ['+0 push reOnRefused']);
  // Swept with each tick's nowMs read up to 500 ms after it fires (the steps before the force-charge's, seeded), on the cadence
  // or drifting 1 ms a tick, hand-backs 34-38 min out every 5 s, stamped 0 ms, 1 ms, 5 ms or 2 s after their tick: never
  // neither; 144 of the 392 pushed and then retried, all pushed on the hand-back's tick as 'reOnRefused'.
  const lateFor = (seed: number): ((k: number) => number) => {
    let x = seed >>> 0;
    const late = Array.from({ length: 64 }, () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return Math.floor((x / 2 ** 32) * 501); });
    return (k) => late[k];
  };
  const runs: Array<[string, string[]]> = [];
  for (let back = 38 * M; back >= 34 * M; back -= 5 * SEC) {
    for (const lag of [0, 1, 5, 2 * SEC]) {
      for (const drift of [0, 1]) {
        runs.push([`${back / SEC}s out, lag ${lag} ms, drift ${drift} ms, late ≤ 500 ms`, afterHandBack(WIN_END - back, lag, drift, lateFor(back + lag + drift))]);
      }
    }
  }
  const { neither, both } = handBackOutcomes(runs);
  assert.deepEqual(neither, [], 'a hand-back with neither its retry nor the push');
  assert.equal(both.length, 144, "a 'reOnRefused' push, then the retry");
  assert.ok(both.every((b) => b.includes(': +0 push reOnRefused, +')), both.find((b) => !b.includes(': +0 push reOnRefused, +')));
  // Review 7's last neither, pinned there (the 15th tick 1 ms late on the 14th's cadence landed on the cutoff instant): pushed on
  // the hand-back's tick, a millisecond either side too.
  const tHbLast = cutoff - 15 * (M + 1);
  assert.deepEqual(afterHandBack(tHbLast, 5, 1), ['+0 push reOnRefused'], 'the 15th tick lands on the cutoff instant');
  assert.deepEqual(afterHandBack(tHbLast - 1, 5, 1), ['+0 push reOnRefused', '+15 lineReOn']);
  assert.deepEqual(afterHandBack(tHbLast + 1, 5, 1), ['+0 push reOnRefused']);
});

/* (review 8) THE HAND-BACK HOLD BY DESIGN. Rounds 5-7 tuned a predictive hold and each tuning opened the opposite window: a
 * push that said "it does not try again tonight" and then the retry, or a hold for a tick that ran late onto the cutoff and
 * neither came. The hold now keeps a FULL TICK of margin (every doubt settled on the side of the push), the push is judged on
 * the hand-back's own tick too (index.ts), and the 'reOnRefused' words are true whether or not the retry comes. */

/** (review 8) A night whose line re-ON is due on its next tick: the panel's stop 30 min before `t0`, the pool 61 → 60 → 59,
 *  the slots reading OFF, no re-ON on the record yet. */
const reOnDueAt = (t0: number): S => onNight({ forceChargeLinePanelOffAtMs: t0 - 30 * M, forceChargeLineReOns: 0,
  forceChargeLineOffSlots: [1, 2, 3], forceChargeLinePoolSamples: [{ pct: 61, atMs: t0 - 12 * M }, { pct: 60, atMs: t0 - 2 * M }] });
const CUTOFF = WIN_END - nfc.FORCE_CHARGE_ON_RETRY_CUTOFF_MS;
interface Cadence { push: { k: number; atMs: number; cause: string; retryPossible: boolean } | null; retry: { k: number; atMs: number } | null; reads: Array<{ k: number; atMs: number }> }
/** (review 8) index.ts's cadence, tick by tick. Tick 0 fires at `f0` and tick k FORCE_CHARGE_TICK_MS + `drift(k)` after tick
 *  k − 1 (setInterval re-arms from each callback's start); each force step reads its nowMs `late(k)` after its tick fires (the
 *  trailing-leg, cycle and reserve steps run first), so a later tick may read LESS late than the one that judged; a tick with
 *  `skip(k)` finds the in-flight lock still held (the tick before ran past 60 s) and does nothing. On tick 0 the re-ON is
 *  decided (decideForceCharge), every write refused by the add-on's own cooldown: the count returned, no slots, the stamp
 *  `lagMs` after the read (Date.now() after the writes) — and the push judged on that same tick, as index.ts does. The push
 *  keeps its wording's key (reOnRetryPossible: "it may try once more", or "its next try would come after ~<cutoff>").
 *  (Fix7 review 1) `restart`: the add-on stops `stopMs` after tick `after` fires (after its read) and starts again `downMs`
 *  later; the record survives (persisted), and its new setInterval fires FORCE_CHARGE_TICK_MS after the start (index.ts runs
 *  no tick at boot), then on its own cadence. */
const cadence = (f0: number, lagMs: number, drift: (k: number) => number = () => 0, late: (k: number) => number = () => 0,
  skip: (k: number) => boolean = () => false, restart: { after: number; stopMs: number; downMs: number } | null = null): Cadence => {
  if (restart != null) assert.ok(restart.stopMs > late(restart.after) + (restart.after === 0 ? lagMs : 0), 'the restart comes after its tick');
  const reads: Cadence['reads'] = [];
  let push: Cadence['push'] = null;
  let retry: Cadence['retry'] = null;
  const t0 = f0 + late(0);
  let s = reOnDueAt(f0);
  const obs0 = nfc.lineNightObservations(s, t0, OFF59);
  if (obs0 != null) s = { ...s, ...obs0 } as S;
  assert.equal(decideForceCharge(s, t0, OFF59).kind, 'lineReOn', "the re-ON is due on the hand-back's tick");
  reads.push({ k: 0, atMs: t0 });
  s = { ...s, forceChargeLineReOnAtMs: t0 + lagMs, forceChargeLineReOnSlots: null } as S;
  const p0 = nfc.lineAtRiskPushDue(s, t0, OFF59);
  if (p0 != null) { push = { k: 0, atMs: t0, cause: p0.cause, retryPossible: p0.reOnRetryPossible }; s = { ...s, forceChargeLineAtRiskPushedAtMs: t0 } as S; }
  let fire = f0;
  for (let k = 1; fire < WIN_END - 15 * M; k++) {
    fire = restart != null && k === restart.after + 1 ? fire + restart.stopMs + restart.downMs + nfc.FORCE_CHARGE_TICK_MS : fire + M + drift(k);
    if (skip(k)) continue;
    const t = fire + late(k);
    reads.push({ k, atMs: t });
    const r = tick(s, t, OFF59);
    s = r.s;
    if (r.push != null) push = { k, atMs: t, cause: r.push.cause, retryPossible: r.push.reOnRetryPossible };
    if (r.kind === 'lineReOn') { retry = { k, atMs: t }; break; }
    assert.equal(r.kind, 'none', `+${k} ${r.kind}`);
  }
  return { push, retry, reads };
};
const outcomeOf = (c: Cadence): 'neither' | 'push' | 'retry' | 'both' =>
  c.push != null ? (c.retry != null ? 'both' : 'push') : c.retry != null ? 'retry' : 'neither';
/** A seeded per-tick value in 0..max (ms), for drift and read lateness. */
const seeded = (seed: number, max: number): ((k: number) => number) => {
  let x = (seed >>> 0) || 1;
  const v = Array.from({ length: 48 }, () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return Math.floor((x / 2 ** 32) * (max + 1)); });
  return (k) => v[k] ?? 0;
};
/** (review 8) The sweep's counts, measured on the landed change: per outcome, and the pushes of the push-then-retry runs by
 *  cause. With no tick lost, neither on none (31e87ca4: 6 in the first band — the awaited tick running late onto the cutoff —
 *  and 10,769 hand-backs on the last tick before it, with no tick left for the push); push-then-retry 11,135 (31e87ca4: 3),
 *  all in the first band, a hand-back whose retry's tick falls within a tick of the cutoff: one tick-wide band of hand-back
 *  times, pushed for at once. With a tick lost, neither on 5, each the lost tick the one awaited (31e87ca4: 2,486). `sure` —
 *  the pushes worded "its next try would come after ~<cutoff>" (the stamp + 15 min at or past it): every one of the last
 *  band's 21,556, none in the bands 15 min or more out; none of them followed by the retry (asserted). */
const PIN_HANDBACK_CADENCE = {
  noSkip: { runs: 43156, neither: 0, push: 25997, retry: 6024, both: 11135, bothCauses: { reOnRefused: 11135 } as Record<string, number>, sure: 21556 },
  oneSkip: { runs: 86400, neither: 5, push: 24236, retry: 7009, both: 55150, bothCauses: { reOnRefused: 55150 } as Record<string, number>, sure: 0 },
};

test('★★★ W1 (review 8) the hand-back hold keeps a FULL TICK of margin: swept at sub-second spacing near the cutoff, drift 0-5 ms a tick, reads 0-500 ms late (later ticks sometimes less late than the judging one), stamps 0 ms to 5 s late — never neither; with a tick lost to the in-flight lock, neither only where that tick is the one awaited', () => {
  // The round-7 final reviewer's probes on 962e4668 (its afterHandBack: tick k at tHb + k × (M + drift) + late(k)):
  // finding 1 — a stamp under 1 s after its tick waited for the 15th tick, which ran late onto the cutoff: neither.
  assert.notEqual(outcomeOf(cadence(CUTOFF - 15 * (M + 3) + 2, 5, () => 3)), 'neither', '3 ms a tick');
  assert.notEqual(outcomeOf(cadence(CUTOFF - 15 * M - 200, 5, () => 0, (k) => (k === 15 ? 210 : 0))), 'neither', 'the 15th tick read 210 ms late');
  // finding 2 — the push tick read late, a later tick less late: 'reOnRefused' ("it does not try again tonight"), then the
  // retry. That may still happen (the retry tick is due within a tick of the cutoff): the push words it as possible.
  for (const c of [cadence(CUTOFF - 15 * M - 200, 0, () => 0, (k) => (k === 1 ? 500 : 0)), cadence(CUTOFF - 15 * M - 20, 0, () => 0, (k) => (k === 1 ? 30 : 0))]) {
    assert.ok(outcomeOf(c) !== 'neither' && c.push?.cause === 'reOnRefused' && c.push.retryPossible, JSON.stringify(c.push));
  }
  // The sweep with no tick lost: hand-back ticks every 100 ms from 17m30s to 15m30s before the re-ON's cutoff (where the awaited
  // tick crosses a tick before the cutoff) and over the last 2 min before it (the last tick: no tick left for the retry),
  // stamps 0 ms, 1 ms, 5 ms, 20 ms, 2 s and 5 s after their tick's read, and three tick models: on the cadence; drift 0-5 ms
  // and reads 0-500 ms late, seeded; the hand-back's tick read 500 ms late, every later one on time, drifting 5 ms.
  const models: Array<[string, (seed: number) => [(k: number) => number, (k: number) => number]]> = [
    ['cadence', () => [() => 0, () => 0]],
    ['seeded', (seed) => [seeded(seed, 5), seeded(seed * 7 + 3, 500)]],
    ['judge late', () => [() => 5, (k) => (k === 0 ? 500 : 0)]],
  ];
  const tally = () => ({ runs: 0, neither: 0, push: 0, retry: 0, both: 0, bothCauses: {} as Record<string, number>, sure: 0 });
  // (review 8) `sure` — 'reOnRefused' pushes worded "its next try would come after ~<cutoff>" (no tick can bring the retry);
  // the rest say it may try once more. A sure push followed by the retry, or a push then the retry not worded "may", is false.
  const falseWords: string[] = [];
  const words = (c: Cadence, where: string): void => {
    if (c.push?.cause !== 'reOnRefused') return;
    if (!c.push.retryPossible && c.retry != null) falseWords.push(`${where}: "next try would come after", then the retry at +${c.retry.k}`);
  };
  const noSkip = tally();
  const neither: string[] = [];
  for (const [from, to] of [[CUTOFF - 17 * M - 30_000, CUTOFF - 15 * M - 30_000], [CUTOFF - 2 * M, CUTOFF]]) {
    for (let f0 = from; f0 < to; f0 += 100) {
      for (const lag of [0, 1, 5, 20, 2_000, 5_000]) {
        for (const [name, model] of models) {
          const [drift, late] = model(f0 + lag);
          if (f0 + late(0) >= CUTOFF) continue; // no re-ON at or past the cutoff: no hand-back
          const c = cadence(f0, lag, drift, late);
          const o = outcomeOf(c);
          noSkip.runs += 1;
          noSkip[o] += 1;
          if (o === 'neither') neither.push(`${(CUTOFF - f0) / 1000}s before the cutoff, lag ${lag} ms, ${name}`);
          if (o === 'both') noSkip.bothCauses[c.push!.cause] = (noSkip.bothCauses[c.push!.cause] ?? 0) + 1;
          if (c.push?.cause === 'reOnRefused' && !c.push.retryPossible) noSkip.sure += 1;
          words(c, `${(CUTOFF - f0) / 1000}s, lag ${lag} ms, ${name}`);
        }
      }
    }
  }
  assert.deepEqual(neither.slice(0, 10), [], `${neither.length} hand-backs with neither the retry nor the push`);
  // Push-then-retry is the price of the margin: the retry's tick due within a tick of the cutoff is pushed for at once, and the
  // retry may still come. Only as 'reOnRefused', whose words say it may (the next test).
  assert.deepEqual(Object.keys(noSkip.bothCauses), noSkip.both > 0 ? ['reOnRefused'] : []);
  // One tick lost to the in-flight lock (the tick before it held the lock past 60 s), at each of ticks 1-18, hand-backs every
  // 100 ms from 17m10s to 15m10s before the cutoff, the stamp 5 ms or 2 s late; drift and reads seeded, or (adversarial) the
  // tick after the lost one read 500 ms late, every other on time, drifting 5 ms. Every hold leaves two ticks of its own
  // cadence before the cutoff, so neither needs the tick after the last hold to be lost (or a full tick late) and the one after
  // it to land past the cutoff. Counted and pinned; each such run's last hold is checked.
  const oneSkip = tally();
  const badNeither: string[] = [];
  for (let f0 = CUTOFF - 17 * M - 10_000; f0 < CUTOFF - 15 * M - 10_000; f0 += 100) {
    for (const lag of [5, 2_000]) {
      for (let lost = 1; lost <= 18; lost++) for (const adversarial of [false, true]) {
        const drift = adversarial ? () => 5 : seeded(f0 + lag + lost, 5);
        const late = adversarial ? (k: number) => (k === lost + 1 ? 500 : 0) : seeded(f0 * 3 + lag + lost, 500);
        const c = cadence(f0, lag, drift, late, (k) => k === lost);
        const o = outcomeOf(c);
        oneSkip.runs += 1;
        oneSkip[o] += 1;
        if (o === 'both') oneSkip.bothCauses[c.push!.cause] = (oneSkip.bothCauses[c.push!.cause] ?? 0) + 1;
        if (c.push?.cause === 'reOnRefused' && !c.push.retryPossible) oneSkip.sure += 1;
        words(c, `${(CUTOFF - f0) / 1000}s, lag ${lag}, tick ${lost} lost`);
        if (o === 'neither') {
          const lastHold = c.reads.filter((r) => r.atMs < CUTOFF).at(-1)!;
          if (!(lastHold.k + 1 === lost && lastHold.atMs + 2 * nfc.FORCE_CHARGE_TICK_MS < CUTOFF)) {
            badNeither.push(`${(CUTOFF - f0) / 1000}s, lag ${lag}, tick ${lost} lost: last hold +${lastHold.k} at cutoff − ${CUTOFF - lastHold.atMs} ms`);
          }
        }
      }
    }
  }
  assert.deepEqual(badNeither.slice(0, 10), [], `${badNeither.length} neither not explained by the lost awaited tick`);
  assert.deepEqual(Object.keys(oneSkip.bothCauses), oneSkip.both > 0 ? ['reOnRefused'] : []);
  // (review 8) Each push's words true in its outcome: none that says no tick can bring the retry is followed by it.
  assert.deepEqual(falseWords.slice(0, 10), [], `${falseWords.length} pushes whose words the retry then contradicted`);
  assert.deepEqual({ noSkip, oneSkip }, PIN_HANDBACK_CADENCE);
});

/** (Fix7 review 1) An add-on RESTART after the last hold (an option change, an update, a host restart): index.ts starts the
 *  actuation tick with setInterval alone, so the first tick after a start comes a tick after it. A restart that stops after a
 *  hold and starts again within a tick of the cutoff leaves neither the retry nor the push. A residual of the restart, counted
 *  and pinned, not closed (an immediate tick at boot would change behaviour outside this hold). Measured on 141349c7's code
 *  (words-only fix): per down time, the runs with neither (248, none down 5 s); every one explained (asserted).
 *  (Fix7 review 2) `stood`: where the night stood when the add-on stopped, after tick `after` (the retry run, else the push
 *  made, else a hold). Under the full-tick margin a
 *  hand-back 15-17 min before the cutoff is pushed on its own tick 0, so its restart comes after the push (or after the retry):
 *  only the 17-18 min band holds through ticks 13-15. The residual's rate is over the restarts that came after a hold —
 *  248 of 7,800 (152 of 1,950 down 45 s), not of the 25,920 swept — and nightForceCharge.ts's header states it so (asserted). */
const PIN_HANDBACK_RESTART = {
  runs: 25920, neither: { 5000: 0, 15000: 27, 30000: 69, 45000: 152 } as Record<number, number>, push: 7511, retry: 8380, both: 9781,
  stood: { afterHold: 7800, afterPush: 15624, afterRetry: 2496 },
  afterHoldByDown: { 5000: 1950, 15000: 1950, 30000: 1950, 45000: 1950 } as Record<number, number>,
};

test('★★★ W1 (Fix7 review 1) an add-on restart after the last hold: the first tick after a start comes a minute after it, so a restart that starts again within a tick of the cutoff leaves neither the retry nor the push — counted, each explained by the restart; and the tick after a hold read a whole minute late, likewise', () => {
  // The verifier's probe: tick 0 17m15s before the re-ON's cutoff, the stamp 2 s late, the ticks drifting 1 ms, read 50 ms late.
  const f0 = CUTOFF - 17 * M - 15_000;
  const drift = (): number => 1;
  const late50 = (): number => 50;
  const base = cadence(f0, 2_000, drift, late50);
  assert.deepEqual([outcomeOf(base), base.retry?.k, base.retry!.atMs - CUTOFF], ['retry', 16, -74_934]);
  assert.equal(base.reads.at(-2)!.atMs - CUTOFF, -134_935, 'the last hold, tick 15: two ticks of its cadence before the cutoff');
  // A restart 30 s after tick 15 fired: down 5 s, the first tick after the start reads 39.9 s before the cutoff — the retry;
  // down 45 s (back 60 s before the cutoff), it reads 65 ms past it — neither.
  const down5 = cadence(f0, 2_000, drift, late50, () => false, { after: 15, stopMs: 30_000, downMs: 5_000 });
  assert.deepEqual([outcomeOf(down5), down5.retry?.k, down5.retry!.atMs - CUTOFF], ['retry', 16, -39_935]);
  const down45 = cadence(f0, 2_000, drift, late50, () => false, { after: 15, stopMs: 30_000, downMs: 45_000 });
  assert.deepEqual([outcomeOf(down45), down45.reads.find((r) => r.k === 16)!.atMs - CUTOFF], ['neither', 65]);
  // The tick after the last hold read a whole minute late (its earlier steps ran 90 s; the next tick finds the lock held):
  // neither. Read 50 s late, it is still before the cutoff: the retry.
  const slow = (ms: number) => cadence(f0, 2_000, drift, (k) => (k === 16 ? ms : 50), (k) => k === 17);
  assert.equal(outcomeOf(slow(90_000)), 'neither');
  assert.deepEqual([outcomeOf(slow(50_000)), slow(50_000).retry?.k], ['retry', 16]);
  // The sweep: hand-backs every 500 ms from 18 to 15 min before the re-ON's cutoff, the stamp 5 ms or 2 s late, drift 0-5 ms
  // and reads 0-500 ms late (seeded), a restart after each of ticks 13-15 (the ticks before the retry's spacing ends), stopping
  // 1 s, 30 s or 55 s after that tick fired, down 5, 15, 30 or 45 s. (Fix7 review 2) Not every restart comes after a hold: a
  // hand-back 15-17 min out is pushed on its own tick 0 (its retry's tick lands under a full tick before the cutoff), so only
  // the 17-18 min band is still holding at ticks 13-15 — `stood`, where the night stood when the add-on stopped.
  const got = {
    runs: 0, neither: { 5000: 0, 15000: 0, 30000: 0, 45000: 0 } as Record<number, number>, push: 0, retry: 0, both: 0,
    stood: { afterHold: 0, afterPush: 0, afterRetry: 0 },
    afterHoldByDown: { 5000: 0, 15000: 0, 30000: 0, 45000: 0 } as Record<number, number>,
  };
  const bad: string[] = [];
  for (let f = CUTOFF - 18 * M; f < CUTOFF - 15 * M; f += 500) {
    for (const lag of [5, 2_000]) for (const after of [13, 14, 15]) for (const stopMs of [1_000, 30_000, 55_000]) for (const downMs of [5_000, 15_000, 30_000, 45_000]) {
      const dr = seeded(f + lag + after, 5);
      const lt = seeded(f * 3 + lag + after, 500);
      const c = cadence(f, lag, dr, lt, () => false, { after, stopMs, downMs });
      const o = outcomeOf(c);
      got.runs += 1;
      const stood = c.retry != null && c.retry.k <= after ? 'afterRetry' : c.push != null && c.push.k <= after ? 'afterPush' : 'afterHold';
      got.stood[stood] += 1;
      if (stood === 'afterHold') got.afterHoldByDown[downMs] += 1;
      if (o === 'neither' && stood !== 'afterHold') bad.push(`${(CUTOFF - f) / 1000}s: neither on a restart ${stood}`);
      if (o === 'neither') {
        got.neither[downMs] += 1;
        // Explained: the last read before the cutoff is a hold made before the restart, two ticks of its cadence before the
        // cutoff, and the first tick after the start reads at or past it.
        const lastHold = c.reads.filter((r) => r.atMs < CUTOFF).at(-1)!;
        const firstBack = c.reads.find((r) => r.k === after + 1);
        if (!(lastHold.k === after && lastHold.atMs + 2 * nfc.FORCE_CHARGE_TICK_MS < CUTOFF && (firstBack == null || firstBack.atMs >= CUTOFF))) {
          bad.push(`${(CUTOFF - f) / 1000}s, lag ${lag}, restart after +${after} (+${stopMs / 1000}s, down ${downMs / 1000}s): last hold +${lastHold.k} at cutoff − ${CUTOFF - lastHold.atMs} ms`);
        }
      } else got[o] += 1;
      if (o === 'both' && c.push!.cause !== 'reOnRefused') bad.push(`push then retry as ${c.push!.cause}`);
      if (c.push?.cause === 'reOnRefused' && !c.push.retryPossible && c.retry != null) bad.push(`${(CUTOFF - f) / 1000}s: "next try would come after", then the retry`);
    }
  }
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} runs not explained by the restart`);
  assert.deepEqual(got, PIN_HANDBACK_RESTART);
  // (Fix7 review 2) The header states the residual over the restarts that came after a hold, from this pin.
  const n = (x: number): string => x.toLocaleString('en-US');
  const neither = Object.values(got.neither).reduce((a, b) => a + b, 0);
  const header = NFC_SRC.slice(0, NFC_SRC.indexOf('★★★ SAFETY RAILS')).replace(/\n\s*\*\s*/g, ' ');
  const stated = `with a restart after a hold, on ${n(neither)} of the ${n(got.stood.afterHold)} restarts that came after one (${n(got.runs)} swept; ${n(got.neither[45_000])} of ${n(got.afterHoldByDown[45_000])} down 45 s)`;
  assert.ok(header.includes(stated), `nightForceCharge.ts's header states: ${stated}`);
});

/* (Fix8) EVERY TICK KIND ON WHICH THE PUSH IS NOT JUDGED, read at index.ts's runForceChargeTick, and whether it can be the tick
 * after a hold on a hand-back night (line mode, a verified ON, a re-ON whose every write came back rate-limited):
 *  - judged: a tick that decides nothing ('none' — also on a stale or incoherent reading, where the push needs a fresh,
 *    coherent one and cannot be due), the hand-back's own tick (review 8), and (Fix8) the line ceiling lowering while ON, after
 *    it: the lowering writes the ceiling only, so the tick's slot and pool readings stand;
 *  - not judged, and reachable there: a LOST tick (the in-flight lock held past it, an add-on restart — no tick at boot —, a
 *    tick that throws), the panel missing from the device list (a blind decision: no reading, as stale), the re-ON REFUSED BY
 *    THE WRITE BLOCK (two panels, none pinned: refused before its stamp), an OFF (a cancel, the reserve revert, a grid loss, the
 *    gates off, the run backstop: the force-charge is over, and neither the retry nor the push follows it);
 *  - not reachable there: the re-ON's readback check (a hand-back stamps no slots, and an earlier re-ON's check precedes the
 *    next re-ON), the ON verification (the ON verified), the OFF verification and the wall-clock deadline (no OFF yet; the
 *    deadline is at least half an hour past the add-on's close), the ceiling restore (the night not over), the ON and its
 *    ceiling sync (the ON is stamped), the close's OFF and the on-peak guard (at or past the re-ON's cutoff).
 * The lowering is decided on the tick after a hold only on a night switched ON in cost mode that runs in line mode since (its
 * cost gate off after a restart: the gates are read at load), whose panel read at or under the line mode's ceiling until then
 * (lowered in the app) and reads above it on that tick (raised in the app): every other tick of a line-mode night finds the
 * synced ceiling at the mode's, or decides the lowering before any re-ON. */
type AfterKind = 'lost' | 'stale' | 'lower' | 'blocked';
/** A reading that is not fresh, as runForceChargeTick builds its opts from such a projection: no slots, no pool, no ceiling. */
const STALE = fo({ slotsOn: null, connectedSlots: [], slotSocPct: null, socCoherent: false, ceilingReadbackPct: null, poolSocPct: null, fullKwh: null });
/** (Fix8) `cadence` (no restart) with tick `kAt` of another kind: 'lost' (nothing runs), 'stale' (no fresh reading), 'lower' (the
 *  panel's ceiling, at the line mode's 80% until then, reads 90%: the lowering is decided, stamped as index.ts stamps it and —
 *  `judgeLowering`, Fix8 — the push judged after it), 'blocked' (the add-on's writes blocked from `kAt` on: a re-ON due is
 *  refused before its stamp; Fix8 review 1: judged there, for the shape log, and the re-ON due holds the push). The night: switched ON in cost mode (synced at 90%), its
 *  cost gate off since, so the line mode (ceiling 80%) rides it. */
const cadenceAfter = (f0: number, lagMs: number, drift: (k: number) => number, late: (k: number) => number, kind: AfterKind, kAt: number,
  judgeLowering = true): Cadence & { pushOnLowering: boolean } => {
  const reads: Cadence['reads'] = [];
  let push: Cadence['push'] = null;
  let retry: Cadence['retry'] = null;
  let pushOnLowering = false;
  const t0 = f0 + late(0);
  let s = { ...reOnDueAt(f0), forceChargeCeilingPct: 90, forceChargeCeilingSyncedPct: 90 } as S;
  const obs0 = nfc.lineNightObservations(s, t0, OFF59);
  if (obs0 != null) s = { ...s, ...obs0 } as S;
  assert.equal(decideForceCharge(s, t0, OFF59).kind, 'lineReOn', "the re-ON is due on the hand-back's tick");
  reads.push({ k: 0, atMs: t0 });
  s = { ...s, forceChargeLineReOnAtMs: t0 + lagMs, forceChargeLineReOnSlots: null } as S;
  const p0 = nfc.lineAtRiskPushDue(s, t0, OFF59);
  if (p0 != null) { push = { k: 0, atMs: t0, cause: p0.cause, retryPossible: p0.reOnRetryPossible }; s = { ...s, forceChargeLineAtRiskPushedAtMs: t0 } as S; }
  let fire = f0;
  for (let k = 1; fire < WIN_END - 15 * M; k++) {
    fire = fire + M + drift(k);
    if (kind === 'lost' && k === kAt) continue;
    const t = fire + late(k);
    reads.push({ k, atMs: t });
    const o = kind === 'stale' && k === kAt ? STALE : kind === 'lower' && k === kAt ? { ...OFF59, ceilingReadbackPct: 90 } : OFF59;
    const obs = nfc.lineNightObservations(s, t, o);
    if (obs != null) s = { ...s, ...obs } as S;
    const a = decideForceCharge(s, t, o);
    const judge = (): void => {
      if (push != null) return;
      const p = nfc.lineAtRiskPushDue(s, t, o);
      if (p != null) { push = { k, atMs: t, cause: p.cause, retryPossible: p.reOnRetryPossible }; s = { ...s, forceChargeLineAtRiskPushedAtMs: t } as S; }
    };
    if (a.kind === 'syncCeiling') {
      assert.equal(kind === 'lower' && k === kAt, true, `+${k}: the lowering only on the tick the panel reads above 80%`);
      // index.ts: the stamp before the write (the synced value moves to the lowered one, so it does not repeat).
      s = { ...s, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingSyncRetries: 0, forceChargeCeilingPriorPct: s.forceChargeCeilingPriorPct ?? a.prior, forceChargeCeilingSyncedPct: a.pct } as S;
      if (judgeLowering) { const before = push; judge(); if (before == null && push != null) pushOnLowering = true; }
      continue;
    }
    if (a.kind === 'lineReOn') {
      // Refused by the write block before its stamp. (Fix8 review 1) Judged (judgeLineNight), but a re-ON due holds the push.
      if (kind === 'blocked' && k >= kAt) { assert.notEqual(nfc.lineReOnDue(s, t, o, [1, 2, 3]), null); assert.equal(nfc.lineAtRiskPushDue(s, t, o), null); continue; }
      retry = { k, atMs: t };
      break;
    }
    assert.equal(a.kind, 'none', `+${k} ${a.kind}`);
    judge();
  }
  return { push, retry, reads, pushOnLowering };
};
/** (Fix8) Measured on the landed change, hand-backs every 100 ms from 17m10s to 15m10s before the re-ON's cutoff, the stamp 5 ms
 *  or 2 s late, the other kind at each of ticks 1-18, drift and reads seeded (0-5 ms, 0-500 ms) or adversarial (5 ms a tick, the
 *  tick after the other one read 500 ms late) — PIN_HANDBACK_CADENCE's one-lost sweep, whose counts 'lost' repeats (asserted):
 *  - 'stale' — run for run as 'lost' (asserted): a tick with no fresh reading is a lost tick for the hold;
 *  - 'lost' — neither on 5, each where the lost tick is the one the last hold awaited (asserted);
 *  - 'lower' — judged after the lowering (Fix8): pushed on the lowering's own tick on 2 runs; neither on the same 5 as 'lost', each
 *    where the lowering takes the retry's own tick (the re-ON due then waits a tick, as after a lost one) and the next reads at or
 *    past the cutoff (asserted). `unjudged`: the same sweep with the push not judged after the lowering (before Fix8) — neither on
 *    the same 5, the push on another tick on 2;
 *  - 'blocked' — a re-ON due under the write block is neither made nor pushed while the block lasts: neither on 6,071, every run
 *    whose block starts at or before the retry's tick with no push from a hold before it (asserted).
 * PIN_HANDBACK_CADENCE and PIN_HANDBACK_RESTART do not move: their ticks decide nothing but the retry. */
const PIN_HANDBACK_AFTER = {
  lost: { runs: 86400, neither: 5, push: 24236, retry: 7009, both: 55150 },
  lower: { runs: 86400, neither: 5, push: 24236, retry: 7009, both: 55150, pushOnLowering: 2 },
  unjudged: { neither: 5, moved: 2 },
  blocked: { runs: 86400, neither: 6071, push: 71300, retry: 943, both: 8086 },
};

test('★★★ W1 (Fix8) one tick after a hand-back of every kind the push is not judged on: a stale reading is a lost tick; the line ceiling lowering is judged after it; the write block refuses the retry unjudged — counted, each neither explained', () => {
  // index.ts judges the push on a tick that decides nothing, on the hand-back's own tick, and (Fix8) after the line ceiling
  // lowering while ON (also when the write block refuses it): read at the source.
  const sync = TICK.slice(TICK.indexOf("if (action.kind === 'syncCeiling') {"), TICK.indexOf("if (action.kind === 'restoreCeiling') {"));
  assert.ok(sync.includes('const whileOn = state.forceChargeOnAtMs != null;') && sync.indexOf('const whileOn') < sync.indexOf('const blocked = multiPanelWriteBlock();'), 'whileOn read before the write block');
  assert.match(sync, /if \(blocked\) \{ app\.log\.warn\(`night-charge: force-charge ceiling sync refused — \$\{blocked\}`\); if \(whileOn\) judgeLineNight\(\); else pushLineDeclinedIfDue\(/);
  const logAt = sync.indexOf("app.log.info(`night-charge: force-charge ceiling →");
  assert.ok(logAt > 0 && sync.indexOf('    if (whileOn) judgeLineNight();\n', logAt) > logAt, 'judged after the lowering, on its own tick');
  // (Fix8 review 1) Judged on: none, the hand-back, the re-ON refused by the write block (for the shape: a re-ON due holds the
  // push), the lowering, the refused lowering, the re-ON's readback check.
  assert.equal(TICK.split('judgeLineNight()').length - 1, 6, 'judged on: none, the hand-back, the blocked re-ON, the lowering, the refused lowering, the check');
  assert.equal(TICK.split('pushLineAtRiskIfDue()').length - 1, 1, 'the push only through judgeLineNight');
  // The reachable kinds, swept.
  const tally = () => ({ runs: 0, neither: 0, push: 0, retry: 0, both: 0 });
  const lost = tally();
  const lower = { ...tally(), pushOnLowering: 0 };
  const unjudged = { neither: 0, moved: 0 };
  const blocked = tally();
  const bad: string[] = [];
  for (let f0 = CUTOFF - 17 * M - 10_000; f0 < CUTOFF - 15 * M - 10_000; f0 += 100) {
    for (const lag of [5, 2_000]) for (let kAt = 1; kAt <= 18; kAt++) for (const adversarial of [false, true]) {
      // As PIN_HANDBACK_CADENCE's one-lost sweep: seeded, or the tick after the other one read 500 ms late, the rest on time.
      const drift = adversarial ? () => 5 : seeded(f0 + lag + kAt, 5);
      const late = adversarial ? (k: number) => (k === kAt + 1 ? 500 : 0) : seeded(f0 * 3 + lag + kAt, 500);
      const where = `${(CUTOFF - f0) / 1000}s, lag ${lag}, tick ${kAt}${adversarial ? ', adversarial' : ''}`;
      const base = cadenceAfter(f0, lag, drift, late, 'lost', 99);
      const l = cadenceAfter(f0, lag, drift, late, 'lost', kAt);
      const st = cadenceAfter(f0, lag, drift, late, 'stale', kAt);
      if (JSON.stringify([outcomeOf(st), st.push, st.retry]) !== JSON.stringify([outcomeOf(l), l.push, l.retry])) bad.push(`${where}: stale ${outcomeOf(st)} ≠ lost ${outcomeOf(l)}`);
      lost.runs += 1; lost[outcomeOf(l)] += 1;
      const lastHold = (c: Cadence) => c.reads.filter((r) => r.atMs < CUTOFF).at(-1)!;
      if (outcomeOf(l) === 'neither' && !(lastHold(l).k + 1 === kAt)) bad.push(`${where}: lost — neither, last hold +${lastHold(l).k}`);
      const lw = cadenceAfter(f0, lag, drift, late, 'lower', kAt);
      lower.runs += 1; lower[outcomeOf(lw)] += 1; if (lw.pushOnLowering) lower.pushOnLowering += 1;
      if (outcomeOf(lw) === 'neither') {
        const next = lw.reads.find((r) => r.k === kAt + 1);
        if (!(base.retry != null && base.retry.k === kAt && (next == null || next.atMs >= CUTOFF))) bad.push(`${where}: lower — neither not on the retry's tick`);
      }
      const lu = cadenceAfter(f0, lag, drift, late, 'lower', kAt, false);
      if (outcomeOf(lu) === 'neither') unjudged.neither += 1;
      if (JSON.stringify([outcomeOf(lu), lu.push, lu.retry]) !== JSON.stringify([outcomeOf(lw), lw.push, lw.retry])) unjudged.moved += 1;
      const b = cadenceAfter(f0, lag, drift, late, 'blocked', kAt);
      blocked.runs += 1; blocked[outcomeOf(b)] += 1;
      // The block holds only ticks a re-ON is due on (from the retry's tick): a hold before it pushes as it would.
      const expectNeither = base.retry != null && kAt <= base.retry.k && !(base.push != null && base.push.k < base.retry.k);
      if ((outcomeOf(b) === 'neither') !== expectNeither) bad.push(`${where}: blocked — ${outcomeOf(b)}, the retry at +${base.retry?.k}`);
    }
  }
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} runs not explained by their tick`);
  // The lost tick here is PIN_HANDBACK_CADENCE's one-lost sweep, run for run.
  const { runs, neither, push, retry, both } = PIN_HANDBACK_CADENCE.oneSkip;
  assert.deepEqual(lost, { runs, neither, push, retry, both });
  assert.deepEqual({ lost, lower, unjudged, blocked }, PIN_HANDBACK_AFTER);
  // The header states the write block's count from this pin.
  const header = NFC_SRC.slice(0, NFC_SRC.indexOf('★★★ SAFETY RAILS')).replace(/\n\s*\*\s*/g, ' ');
  const stated = `neither, while the block lasts: PIN_HANDBACK_AFTER, ${blocked.neither.toLocaleString('en-US')} of ${blocked.runs.toLocaleString('en-US')} hand-backs`;
  assert.ok(header.includes(stated), `nightForceCharge.ts's header states: ${stated}`);
  // An OFF ends both: after it neither the retry nor the push can come (a cancel on the tick after a hold).
  const hb = { ...reOnDueAt(CUTOFF - 16 * M), forceChargeLineReOnAtMs: CUTOFF - 16 * M, forceChargeLineReOnSlots: null } as S;
  const cancelled = { ...hb, cancelled: true } as S;
  assert.equal(decideForceCharge(cancelled, CUTOFF - 15 * M + 5, OFF59).kind, 'off');
  const offed = { ...cancelled, forceChargeOffAtMs: CUTOFF - 15 * M + 5 } as S;
  assert.equal(nfc.lineReOnDue(offed, CUTOFF - 14 * M, OFF59, [1, 2, 3]), null);
  assert.equal(nfc.lineAtRiskPushDue(offed, CUTOFF - 14 * M, OFF59), null);
});

test('★★★ W1 (review 8) the margin is a full tick, and the hand-back\'s own tick is judged: a hand-back on the last tick before the cutoff is pushed on that tick; no tolerance constant is left', () => {
  // The hold, at its edge: the retry's tick on this tick's cadence (the 16th after a stamp written after its tick's read) one
  // full tick before the cutoff holds; a millisecond later, pushed at once.
  const edge = CUTOFF - 17 * M; // the 16th tick lands at CUTOFF − M: R + one tick = CUTOFF
  assert.deepEqual([outcomeOf(cadence(edge - 1, 5)), cadence(edge - 1, 5).retry?.k], ['retry', 16]);
  assert.deepEqual([outcomeOf(cadence(edge, 5)), cadence(edge, 5).push?.k, cadence(edge, 5).retry?.k], ['both', 0, 16]);
  // On the last tick before the cutoff (the next tick is past it, and the push's lead with it): pushed on the hand-back's tick.
  for (const back of [1, 30_000, 59_999]) {
    const c = cadence(CUTOFF - back, 5);
    assert.deepEqual([outcomeOf(c), c.push?.k, c.push?.cause], ['push', 0, 'reOnRefused'], `${back} ms before the cutoff`);
  }
  // index.ts judges it there: the re-ON's branch, when every write came back rate-limited, after the stamp.
  const reOn = TICK.slice(TICK.indexOf("if (action.kind === 'lineReOn') {"), TICK.indexOf("if (action.kind === 'onFailed') {"));
  const stamp = reOn.indexOf('forceChargeLineReOnAtMs: Date.now(),');
  const judged = reOn.indexOf('if (allLimited) judgeLineNight();');
  assert.ok(stamp > 0 && judged > stamp, 'the hand-back judged for the push after its stamp, on its own tick');
  assert.ok(TICK.includes("if (action.kind === 'none') {") && TICK.slice(TICK.indexOf("if (action.kind === 'none') {")).includes('    judgeLineNight();\n'));
  // The margin makes the earliest-tick tolerance dead: it is gone.
  assert.equal('FORCE_CHARGE_TICK_LATE_TOL_MS' in nfc, false);
});

test('★★★ W1 (review 8) the \'reOnRefused\' push is true in every outcome: the cooldown refused the switch-on; where a tick may still bring the retry, it may try once more before the re-ON\'s cutoff; where none can, its next try would come after it; and what to do now — never "it does not try again tonight"', () => {
  const build = (notify as unknown as { buildLineForceChargeAtRisk: (o: unknown) => { body: string } }).buildLineForceChargeAtRisk;
  const todo = 'Charge Now switched on for slot(s) 1, 2, 3 in the EcoFlow app can still lift the pool (the add-on switches it off at the close).';
  const MAY = "The add-on's last try to switch Charge Now back on was refused by its own write cooldown; it may try once more before ~4:40 AM if the cooldown allows. ";
  const SURE = "The add-on's last try to switch Charge Now back on was refused by its own write cooldown; its next try would come after ~4:40 AM, when it no longer switches Charge Now back on. ";
  const bodyAt = (f0: number, lag: number): { risk: nfc.LineAtRisk; body: string } => {
    const risk = nfc.lineAtRiskPushDue({ ...reOnDueAt(f0), forceChargeLineReOnAtMs: f0 + lag, forceChargeLineReOnSlots: null } as S, f0, OFF59)!;
    return { risk, body: build({ day: '2026-09-16', risk, closeText: '5:00 AM', reOnCutoffText: '4:40 AM' }).body };
  };
  // The retry's spacing ends before the cutoff (the stamp + 15 min under it): a tick may bring it or not — the push says it may.
  // 16m30s out, stamped 5 ms late, and 15m30s out stamped on its tick: pushed at once, and the retry comes on the 16th / 15th
  // tick (cadence: both). 16 min out (the 16th tick IS the cutoff instant) and 15 min 6 ms out (the 15th tick 1 ms short of the
  // stamp + 15 min): no retry on the cadence, but a tick a few ms late brings it — the same words.
  for (const [f0, lag, k] of [[CUTOFF - 16 * M - 30_000, 5, 16], [CUTOFF - 15 * M - 30_000, 0, 15]] as const) {
    const c = cadence(f0, lag);
    assert.deepEqual([outcomeOf(c), c.push?.k, c.push?.cause, c.push?.retryPossible, c.retry?.k], ['both', 0, 'reOnRefused', true, k]);
  }
  assert.equal(outcomeOf(cadence(CUTOFF - 16 * M, 5)), 'push');
  assert.equal(outcomeOf(cadence(CUTOFF - 15 * M - 6, 5, () => 0, (k) => (k === 15 ? 5 : 0))), 'both', 'the 15th tick read 5 ms late');
  for (const [f0, lag] of [[CUTOFF - 16 * M - 30_000, 5], [CUTOFF - 15 * M - 30_000, 0], [CUTOFF - 16 * M, 5], [CUTOFF - 15 * M - 6, 5]] as const) {
    const { risk, body } = bodyAt(f0, lag);
    assert.deepEqual([risk.cause, risk.reOnRetryPossible], ['reOnRefused', true], `${CUTOFF - f0} ms out`);
    assert.ok(body.includes(MAY + todo), body);
    assert.doesNotMatch(body, /does not try again|next try would come after|grid known present|No action needed/);
  }
  // The spacing ends at or past the cutoff: no tick can bring the retry (lineReOnDue refuses at the cutoff) — said so, and no
  // retry comes (cadence: the push alone), from a millisecond past that edge to the last tick before the cutoff.
  for (const [f0, lag] of [[CUTOFF - 15 * M - 5, 5], [CUTOFF - 15 * M, 0], [CUTOFF - 10 * M, 5], [CUTOFF - 30_000, 2_000]] as const) {
    const { risk, body } = bodyAt(f0, lag);
    assert.deepEqual([risk.cause, risk.reOnRetryPossible], ['reOnRefused', false], `${CUTOFF - f0} ms out`);
    assert.ok(body.includes(SURE + todo), body);
    assert.doesNotMatch(body, /does not try again|may try once more|grid known present|No action needed/);
    const run = cadence(f0, lag);
    assert.deepEqual([outcomeOf(run), run.push?.k, run.push?.retryPossible], ['push', 0, false], `${CUTOFF - f0} ms out`);
  }
  // index.ts gives the push the re-ON's cutoff (the close less FORCE_CHARGE_ON_RETRY_CUTOFF_MS) and words its log line alike.
  assert.ok(TICK.includes('const reOnCutoffText = fmtSiteClock(risk.closeAtMs - FORCE_CHARGE_ON_RETRY_CUTOFF_MS);'));
  assert.ok(TICK.includes('        reOnCutoffText,\n      })).catch('));
  assert.ok(TICK.includes("? `its last re-ON was refused by its own write cooldown and ${risk.reOnRetryPossible ? `it may try once more before ${reOnCutoffText}` : `its next try would come after ${reOnCutoffText}, the re-ON's cutoff`} (reOnRefused)`"));
  assert.doesNotMatch(TICK, /does not try again/);
});

test('★★ W1 (review 5) a slot its check found not applied that reads ON since is not named as not taking effect', () => {
  const due = nfc.lineAtRiskPushDue;
  const spent = (notApplied: number[]) => risky({ forceChargeLineReOns: 2, forceChargeLineReOnAtMs: T - H, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineReOnCheckedAtMs: T - 44 * M, forceChargeLineReOnNotAppliedSlots: notApplied, forceChargeLineReOnsNotApplied: 1 });
  // Slot 1 reads ON now (applied late, or switched on in the app): the push names slots 2 and 3 as not taking effect.
  const r = due(spent([1, 2, 3]), T, offReading({ slotsOn: [1] }));
  assert.deepEqual([r?.cause, r?.reOnNotAppliedSlots, r?.offSlots, r?.onSlots], ['reOnNotApplied', [2, 3], [2, 3], [1]]);
  // The only slot not applied reads ON now: the budget is spent, nothing of it failed that still reads OFF.
  const r2 = due(spent([2]), T, offReading({ slotsOn: [2] }));
  assert.deepEqual([r2?.cause, r2?.reOnNotAppliedSlots], ['reOnSpent', []]);
});

/** (Fix13) The words on every body with a slot reading on. The load first: on the measured shape every such push comes from a load or a rate
 *  limit, where cycling Charge Now cannot help and costs 2 minutes with the load on the pack; the cycle conditional. Every clause conditional:
 *  the builder has no load reading. */
const AT_RISK_ON = (slots: string): string => `Charge Now reads on for slot(s) ${slots} but the pool is not rising. `
  + 'A large load such as an EV shares the grid input: stopping it may let the pool rise. '
  + 'With none on, switching Charge Now off and on again in the EcoFlow app may restart the charge.';

test('★★★ W1 (Fix13) the load goes first on EVERY body with a slot reading on: mixed off and on, cost-dominant, a falling pool, a flat one; none with no slot on', () => {
  const build = (notify as unknown as { buildLineForceChargeAtRisk: (o: unknown) => { body: string } }).buildLineForceChargeAtRisk;
  const r = (over: Record<string, unknown>) => ({ cause: 'onNotRising', offSlots: [], onSlots: [1, 2, 3], poolPct: 58, refPct: 58, refAtMs: 0, thresholdPct: 61, linePct: 55.55, closeAtMs: 0, reOnNotAppliedSlots: null, panelOffAtMs: null, reOnRetryPossible: false, ...over });
  const body = (over: Record<string, unknown>) => build({ day: '2026-09-16', risk: r(over), closeText: '4:40am', reOnCutoffText: '4:40am' }).body;
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, '1, 2, 3'], [{ poolPct: 57, refPct: 59 }, '1, 2, 3'], [{ poolPct: 54, refPct: 54 }, '1, 2, 3'],
    [{ cause: 'reOnHeld', offSlots: [2], onSlots: [1, 3] }, '1, 3'], [{ cause: 'reOnSpent', offSlots: [2], onSlots: [1] }, '1'],
    [{ cause: 'reOnNotApplied', offSlots: [2], onSlots: [3], reOnNotAppliedSlots: [2] }, '3'], [{ cause: 'reOnRefused', offSlots: [1], onSlots: [2, 3] }, '2, 3'],
    [{ cause: 'costMode', thresholdPct: 75, linePct: 69.4, poolPct: 73, refPct: 76 }, '1, 2, 3'], [{ cause: 'costMode', thresholdPct: 75, linePct: 69.4, poolPct: 73, refPct: 73, offSlots: [2], onSlots: [1] }, '1'],
  ];
  for (const [over, slots] of cases) {
    const b = body(over);
    assert.ok(b.endsWith(AT_RISK_ON(slots)), b);
    assert.ok(b.indexOf('A large load') < b.indexOf('off and on again'), 'the load first');
    // Conditional clauses: "not rising" stays true of a falling pool, and "may let" of a load beside a stuck slot.
    assert.doesNotMatch(b, /lets the (pool|charge)|will (rise|restart)|must stop|is level/);
  }
  const offOnly = body({ cause: 'reOnHeld', offSlots: [1, 2, 3], onSlots: [] });
  assert.doesNotMatch(offOnly, /A large load|off and on again/, 'no slot on, no such words');
});

test('★★★ W1 the push words: the pool, the start target, the line, the close; what to switch — never "No action needed"', () => {
  const build = (notify as unknown as { buildLineForceChargeAtRisk: (o: unknown) => { title: string; body: string; severity: string; dedupId: string } }).buildLineForceChargeAtRisk;
  const r = (over: Record<string, unknown>) => ({ cause: 'onNotRising', offSlots: [], onSlots: [1, 2, 3], poolPct: 58, refPct: 62, refAtMs: 0, thresholdPct: 61, linePct: 55.55, closeAtMs: 0, reOnNotAppliedSlots: null, panelOffAtMs: null, ...over });
  const onLatch = build({ day: '2026-09-16', risk: r({}), closeText: '4:40am' });
  assert.equal(onLatch.severity, 'warning');
  assert.equal(onLatch.dedupId, 'night_charge_line_at_risk');
  assert.equal(onLatch.title, "Night-charge: tonight's outage line is at risk");
  assert.equal(onLatch.body, "Night-charge: the pool reads 58%, under the 61% start target and falling toward tonight's 55.6% outage line; the window closes at ~4:40am. "
    + AT_RISK_ON('1, 2, 3'));
  const spent = build({ day: '2026-09-16', risk: r({ cause: 'reOnSpent', offSlots: [1, 3], onSlots: [], poolPct: 57, refPct: 57, panelOffAtMs: WIN_END - 3 * H }), closeText: '4:40am' });
  assert.equal(spent.body, "Night-charge: the pool reads 57%, under the 61% start target and not rising; tonight's outage line is 55.6%; the window closes at ~4:40am. "
    + "The add-on has switched Charge Now back on 2 times tonight after the panel's own stop, the most it does in a night. "
    + 'Charge Now switched on for slot(s) 1, 3 in the EcoFlow app can still lift the pool (the add-on switches it off at the close).');
  // (review 4) With no panel stop on record (Charge Now switched off in the app, re-ONed twice) the stop is not named.
  const spentNoStop = build({ day: '2026-09-16', risk: r({ cause: 'reOnSpent', offSlots: [1, 3], onSlots: [], poolPct: 57, refPct: 57 }), closeText: '4:40am' });
  assert.ok(spentNoStop.body.includes('The add-on has switched Charge Now back on 2 times tonight, the most it does in a night. '), spentNoStop.body);
  assert.doesNotMatch(spentNoStop.body, /panel's own stop/);
  const notApplied = build({ day: '2026-09-16', risk: r({ cause: 'reOnNotApplied', offSlots: [2], onSlots: [1, 3], reOnNotAppliedSlots: [2], poolPct: 54 }), closeText: '4:40am' });
  assert.ok(notApplied.body.startsWith("Night-charge: the pool reads 54%, under tonight's 55.6% outage line and falling; the window closes at ~4:40am. "), notApplied.body);
  // (Fix8 review 1) A re-ON its check found not applied may still take effect late (lineNightObservations watches for it): "has
  // not taken effect", never "did not".
  assert.ok(notApplied.body.includes('The add-on switched Charge Now back on for slot(s) 2 and it has not taken effect; it does not try again tonight. '), notApplied.body);
  assert.ok(notApplied.body.endsWith(`Charge Now switched on for slot(s) 2 in the EcoFlow app can still lift the pool (the add-on switches it off at the close). ${AT_RISK_ON('1, 3')}`), notApplied.body);
  const held = build({ day: '2026-09-16', risk: r({ cause: 'reOnHeld', offSlots: [1, 2, 3], onSlots: [] }), closeText: '4:40am' });
  assert.ok(held.body.includes('The add-on cannot switch Charge Now back on now (it needs the grid known present, healthy host vitals and a live panel reading). '), held.body);
  const cost = build({ day: '2026-09-16', risk: r({ cause: 'costMode', thresholdPct: 75, linePct: 69.4, poolPct: 73, refPct: 76 }), closeText: '4:40am' });
  // (review 3) A cost-dominant night has no start target (its start is timed to its cost target, here 90): the threshold
  // is named by its margin over the line, and the push says why the add-on cannot act — its cost force-charge has its
  // own stop and no re-ON.
  assert.equal(cost.body, "Night-charge: the pool reads 73%, under 75%, 5.6 points above tonight's 69.4% outage line, and falling toward it; "
    + 'the window closes at ~4:40am. '
    + "Tonight's force-charge is the cost plan's, with its own stop: the add-on does not switch Charge Now back on for the line. "
    + AT_RISK_ON('1, 2, 3'));
  const costOff = build({ day: '2026-09-16', risk: r({ cause: 'costMode', offSlots: [2], onSlots: [], thresholdPct: 75, linePct: 69.4, poolPct: 70, refPct: 70 }), closeText: '4:40am' });
  assert.equal(costOff.body, "Night-charge: the pool reads 70%, under 75%, 5.6 points above tonight's 69.4% outage line, and not rising; "
    + 'the window closes at ~4:40am. '
    + "Tonight's force-charge is the cost plan's, with its own stop: the add-on does not switch Charge Now back on for the line. "
    + 'Charge Now switched on for slot(s) 2 in the EcoFlow app can still lift the pool (the add-on switches it off at the close).');
  for (const m of [cost, costOff]) assert.doesNotMatch(m.body, /start target/);
  // (Fix8 review 1) The margin is worked from the numbers the push names, so they add up: the 55.55% line named 55.6%, its 61%
  // threshold 5.4 points above it (round1(61 − 55.55) = 5.5 named 61 − 55.6); a 50.05% line named 50.1%, 56 − 50.1 = 5.9.
  const margin = (linePct: number, thresholdPct: number) => /under ([\d.]+)%, ([\d.]+) points above tonight's ([\d.]+)% outage line/
    .exec(build({ day: '2026-09-16', risk: r({ cause: 'costMode', thresholdPct, linePct, poolPct: thresholdPct - 2, refPct: thresholdPct }), closeText: '4:40am' }).body)!.slice(1).map(Number);
  assert.deepEqual(margin(55.55, 61), [61, 5.4, 55.6]);
  assert.deepEqual(margin(50.05, 56), [56, 5.9, 50.1]);
  assert.deepEqual([margin(69.35, 75), margin(69.44, 75)], [[75, 5.6, 69.4], [75, 5.6, 69.4]], 'the same named numbers, the same margin');
  // A line-mode night keeps "the start target" (the value its re-ON switches back on under).
  for (const m of [onLatch, spent]) assert.match(m.body, /the 61% start target/);
  for (const m of [onLatch, spent, spentNoStop, notApplied, held, cost, costOff]) assert.doesNotMatch(m.body, /No action needed|no action/i);
  // The push carries the record's panel stop, or null (the round-4 reviewer's emulation: two app OFFs, both re-ONed, none
  // checked not applied, the pool falling — 'reOnSpent' with no stop on record).
  const appOff = risky({ forceChargeLineReOns: 2, forceChargeLineReOnAtMs: T - H, forceChargeLineReOnSlots: [1, 2, 3], forceChargeLineReOnCheckedAtMs: T - 44 * M,
    forceChargeLineReOnNotAppliedSlots: [], forceChargeLineReOnAppliedAtMs: T - H });
  const appRisk = nfc.lineAtRiskPushDue(appOff, T, offReading());
  assert.deepEqual([appRisk?.cause, appRisk?.panelOffAtMs], ['reOnSpent', null]);
  assert.doesNotMatch(build({ day: '2026-09-16', risk: appRisk, closeText: '4:40am' }).body, /panel's own stop/);
  assert.equal(nfc.lineAtRiskPushDue({ ...appOff, forceChargeLinePanelOffAtMs: T - 2 * H }, T, offReading())?.panelOffAtMs, T - 2 * H);
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
  // (review 3) NEVER right after an ON of ours: on the measured path the pool falls (the panel's OFF), the re-ON switches
  // the slots back on, and the next tick reads them ON, their Cores under the stop, the pool still below a reading from
  // before the re-ON. That is the re-ON working, not the unmeasured latch. The round-3 reviewer's probe 3: the re-ON at
  // T−1, the reference 62 at T−12.
  const reOn = (reOnAt: number, refAt: number) => risky({ forceChargeLineReOns: 1, forceChargeLineReOnAtMs: reOnAt, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLinePoolSamples: [{ pct: 62, atMs: refAt }] });
  assert.equal(shape(reOn(T - M, T - 12 * M), T, onReading()), null, 'the minute after a re-ON');
  // …nor against a reference taken inside the re-ON's readback grace (an ON 5 min late, a reading 3 min stale).
  assert.equal(shape(reOn(T - 20 * M, T - 10 * M), T, onReading()), null, 'a reference inside the re-ON\'s grace');
  // A reference taken once the grace has run does count.
  assert.notEqual(shape(reOn(T - 25 * M, T - 10 * M), T, onReading()), null, 'a reference at the re-ON + 15 min');
  // The first ON alike.
  assert.equal(shape(risky({ forceChargeOnLastAttemptMs: T - 20 * M, forceChargeLinePoolSamples: [{ pct: 62, atMs: T - 10 * M }] }), T, onReading()), null);
  // (Fix8 review 1) ONCE A NIGHT ACROSS RESTARTS, as the pushes are: the record carries when it was logged
  // (forceChargeLineShapeLoggedAtMs), stamped before the line is written; seen again after a restart, it is not logged again.
  // It was module memory (lineOnShapeLoggedDay), and a restart wrote "Logged once a night." a second time.
  const logged = risky({ forceChargeLineShapeLoggedAtMs: T - 3 * M });
  assert.equal(shape(logged, T, onReading()), null, 'logged tonight: not again');
  const restarted = coerceActuationState(JSON.parse(JSON.stringify(logged))) as S;
  assert.equal((restarted as unknown as { forceChargeLineShapeLoggedAtMs: number | null }).forceChargeLineShapeLoggedAtMs, T - 3 * M);
  assert.equal(shape(restarted, T + M, onReading()), null, 'a restart does not log it again');
  assert.equal((coerceActuationState(JSON.parse(JSON.stringify({ ...risky(), forceChargeLineShapeLoggedAtMs: 'x' }))) as unknown as { forceChargeLineShapeLoggedAtMs: unknown }).forceChargeLineShapeLoggedAtMs, null);
  assert.equal((emptyActuationState() as unknown as { forceChargeLineShapeLoggedAtMs: unknown }).forceChargeLineShapeLoggedAtMs, null);
  // index.ts: stamped on the record, then logged, a warning — and no module memory left.
  const fn = TICK.slice(TICK.indexOf('const logLineOnReadingShapeIfSeen = (): void => {'), TICK.indexOf('const judgeLineNight = (): void => {'));
  assert.ok(fn.includes('const shape = lineOnReadingShape(nightActuationMem, nowMs, fcOpts);'), fn);
  const stampAt = fn.indexOf('persistNightActuation({ ...nightActuationMem, forceChargeLineShapeLoggedAtMs: nowMs });');
  const warnAt = fn.indexOf('app.log.warn(`night-charge: ${state.day} — slot(s) ${shape.slots.join(\',\')} read FORCE_CHARGE_ON');
  assert.ok(stampAt > 0 && warnAt > stampAt, 'stamped before it is logged');
  assert.ok(fn.includes('Logged once a night.`);'));
  assert.ok(!INDEX.includes('lineOnShapeLoggedDay'), 'no module memory');
  // (Fix8 review 1) …and judged wherever the push is (judgeLineNight), whatever the push conditions: on the ticks the line
  // ceiling lowering or its refusal takes (a lowering refused by the write block is due again every tick while it lasts) too.
  assert.ok(TICK.includes('const judgeLineNight = (): void => { pushLineAtRiskIfDue(); logLineOnReadingShapeIfSeen(); };'));
  assert.equal(TICK.split('logLineOnReadingShapeIfSeen()').length - 1, 1, 'only through judgeLineNight');
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
  assert.ok(all.body.includes("Tonight's force-charge for the 69.4% outage line has not taken effect: unless it applies late, the add-on adds nothing above the 50% reserve, and the pool may close the window under the line."), all.body);
  assert.ok(all.body.includes('Charge Now switched on for slot(s) 1, 2, 3 in the EcoFlow app can still lift the pool tonight'), all.body);
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
  const STALE = nfc.FORCE_CHARGE_BLOCKER_WHY.noReadback;
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
  assert.deepEqual(run(restarted, { cost: false, line: true }, [[31, 50, STALE]]).pushes, [[41, 'noReadback']]);
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
  const step = TICK.indexOf('const dp = lineDeclinedPushTick(lineDeclinedPush, state, why, nowMs, ');
  assert.ok(step > 0);
  const persist = TICK.indexOf('persistNightActuation({ ...nightActuationMem, forceChargeLineDeclinedPushed: [...dp.mem.st.pushed] });', step);
  const send = TICK.indexOf('buildLineForceChargeDeclinedStart({', step);
  assert.ok(persist > step && send > persist, 'write-ahead');
  assert.ok(TICK.includes('lineDeclinedLatestStartMs({\n'));
});

test('★★★ W5 #6 the reserve-apply failure on a line night: until the panel reads the reserve it keeps its own, under the line, and what holds it — never "No action needed", never "will not happen" (a late apply is still verified)', () => {
  const line = buildNightChargeApplyFailure({ day: '2027-01-04', currentReservePct: 30, targetPct: 50, applyRetries: 2, expectedKwh: 28.18, linePct: 55.55 } as never);
  assert.equal(line.severity, 'warning');
  assert.equal(line.body,
    'The supervised reserve write for 2027-01-04 was accepted by the EcoFlow cloud but the Smart Home Panel 2 still reads 30% (target 50%) after 2 re-issues. '
    + "Tonight's planned charge (~28.2 kWh expected) has not taken effect: until the panel reads 50%, it keeps its normal reserve, under tonight's 55.6% outage line, and the force-charge for the line waits on this write. "
    + 'To let it start, set the backup reserve to 50% in the EcoFlow app now: the sooner the panel reads it, the more of the line a start can reach. If this repeats, check the SHP2 cloud link.');
  assert.doesNotMatch(line.body, /No action needed|will not happen/);
  // (Fix8 review 2) …nor its title: "the reserve write has not taken effect"; a night with no line keeps v1.199.1's (below).
  assert.equal(line.title, 'Night-charge: the reserve write has not taken effect');
  // (Fix8 review 1) Why "has not taken effect": the apply ladder still verifies a reading of the target after the failure (a
  // late apply, or the reserve set by hand), and the force-charge then starts for the line.
  const actuator = readFileSync(resolve(HERE, '../src/nightChargeActuator.ts'), 'utf8');
  const ladder = actuator.slice(actuator.indexOf('if (state.applyVerifiedAtMs == null && state.targetPct != null) {'));
  assert.ok(ladder.indexOf("if (opts.currentReservePct === state.targetPct) return { kind: 'applyVerified' };") < ladder.indexOf("if (!state.applyEscalated) return { kind: 'applyFailed' };"));
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
  // (Fix9 review 2) The close as read and the line beside it, so the order shows: never a close rounded over the line it is under.
  assert.match(sum(ran, { closePoolPct: 55.5, linePct: 55.56 }), /the pool read 55\.5% at the close, under the 55\.6% outage line/);
  assert.match(sum(ran, { closePoolPct: 55.58, linePct: 55.64 }), /the pool read 55\.6% at the close, under the 55\.64% outage line/);
  assert.ok(sum(ran, { closePoolPct: null }).includes('force-charge ran to the window close for the 55.6% outage line; the pool was not read at the close (no fresh panel reading)'), sum(ran, { closePoolPct: null }));
  assert.ok(sum(ran).includes('the pool was not read at the close'), 'omitted is unread, never silence');
  // The other outcomes of a line night say where it closed too.
  const never = nfc.forceChargeNightOutcome(night(), lineGates);
  assert.ok(sum(never, { closePoolPct: 50 }).includes('force-charge for the 55.6% outage line never started; the pool read 50% at the close, under the 55.6% outage line;'), sum(never, { closePoolPct: 50 }));
  const failed = nfc.forceChargeNightOutcome(onNight({ forceChargeOnVerifiedAtMs: null, forceChargeOnFailedAtMs: WIN_END - 3 * H, forceChargeOnFailedSlots: [1, 2, 3] }), lineGates);
  assert.ok(sum(failed, { closePoolPct: null }).includes('was switched ON but did not take effect; the pool was not read at the close (no fresh panel reading);'), sum(failed, { closePoolPct: null }));
});

test('★★★ W3 a line night: the panel\'s own stop and the re-ONs (issued, and any a readback check found not applied) are named', () => {
  // The panel stopped the charge at 03:10 after two re-ONs (the last at 02:30, one of them checked not applied).
  const ended = nfc.forceChargeNightOutcome(onNight({
    forceChargeLinePanelOffAtMs: WIN_END - 110 * M, forceChargeLineReOns: 2, forceChargeLineReOnAtMs: WIN_END - 150 * M, forceChargeLineReOnsNotApplied: 1,
    forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd',
  }), lineGates);
  assert.ok(sum(ended, { closePoolPct: 51 }).includes(
    "force-charge ran for the 55.6% outage line until the panel's own stop switched Charge Now off at 3:10am; Charge Now was switched back on 2 time(s) after the panel's own stop (slot(s) still off at the readback check after 1 of them); the pool read 51% at the close, under the 55.6% outage line"), sum(ended, { closePoolPct: 51 }));
  assert.doesNotMatch(sum(ended, { closePoolPct: 51 }), /to the window close/);
  // A re-ON after the panel's stop that then ran to the close.
  const reOnRan = nfc.forceChargeNightOutcome(onNight({
    forceChargeLinePanelOffAtMs: WIN_END - 3 * H, forceChargeLineReOns: 1, forceChargeLineReOnAtMs: WIN_END - 150 * M,
    forceChargeLineReOnSlots: [1, 2, 3], forceChargeLineReOnCheckedAtMs: WIN_END - 135 * M, forceChargeLineReOnNotAppliedSlots: [],
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

test('★★★ W3 (review 3) a re-ON resumes the charge only when it took effect; "after the panel\'s own stop" only when that stop is on record', () => {
  // The round-3 reviewer's probe 1: the panel stopped the charge at 01:00; both re-ONs after it (the last at 02:30) were
  // checked not applied — Charge Now was off from 01:00 to the close. Never "ran to the window close".
  const failedAfterStop = (reOns: number, over: Record<string, unknown> = {}) => onNight({
    forceChargeLinePanelOffAtMs: WIN_START + 2 * H, forceChargeLineReOns: reOns, forceChargeLineReOnAtMs: WIN_END - 150 * M,
    forceChargeLineReOnSlots: [1, 3], forceChargeLineReOnCheckedAtMs: WIN_END - 135 * M, forceChargeLineReOnNotAppliedSlots: [1, 3],
    forceChargeLineReOnsNotApplied: reOns, forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd', ...over,
  });
  const two = sum(nfc.forceChargeNightOutcome(failedAfterStop(2), lineGates), { closePoolPct: 52 });
  assert.ok(two.includes("force-charge ran for the 55.6% outage line until the panel's own stop switched Charge Now off at 1am; "
    + "Charge Now was switched back on 2 time(s) after the panel's own stop (slot(s) still off at the readback check after 2 of them); the pool read 52% at the close, under the 55.6% outage line"), two);
  assert.doesNotMatch(two, /to the window close/);
  const one = sum(nfc.forceChargeNightOutcome(failedAfterStop(1), lineGates), { closePoolPct: 52 });
  assert.ok(one.includes("until the panel's own stop switched Charge Now off at 1am; Charge Now was switched back on 1 time(s) after the panel's own stop (slot(s) still off at the readback check after 1 of them)"), one);
  // A re-ON that took on one slot of the two resumed the charge: it ran to the close.
  const partial = sum(nfc.forceChargeNightOutcome(failedAfterStop(1, { forceChargeLineReOnNotAppliedSlots: [3] }), lineGates), { closePoolPct: 60 });
  assert.ok(partial.includes('force-charge ran to the window close for the 55.6% outage line; Charge Now was switched back on 1 time(s)'), partial);
  // A re-ON whose every write came back rate-limited never reached the panel (no slots on the record, the count handed
  // back): the panel's stop ended the charge.
  const limited = sum(nfc.forceChargeNightOutcome(failedAfterStop(0, { forceChargeLineReOnSlots: null, forceChargeLineReOnCheckedAtMs: null,
    forceChargeLineReOnNotAppliedSlots: null, forceChargeLineReOnsNotApplied: 0 }), lineGates), { closePoolPct: 52 });
  assert.ok(limited.includes("force-charge ran for the 55.6% outage line until the panel's own stop switched Charge Now off at 1am; the pool read 52%"), limited);
  // A re-ON not yet checked (no live readback in time) is taken as having resumed it, as before the check existed.
  const unchecked = sum(nfc.forceChargeNightOutcome(failedAfterStop(1, { forceChargeLineReOnCheckedAtMs: null, forceChargeLineReOnNotAppliedSlots: null,
    forceChargeLineReOnsNotApplied: 0 }), lineGates), { closePoolPct: 60 });
  assert.ok(unchecked.includes('force-charge ran to the window close for the 55.6% outage line;'), unchecked);
  // The outcome carries the last re-ON's verdict.
  const v = (s: S) => (nfc.forceChargeNightOutcome(s, lineGates) as unknown as { line: { lastReOnApplied: boolean | null } }).line.lastReOnApplied;
  assert.equal(v(failedAfterStop(2)), false);
  assert.equal(v(failedAfterStop(1, { forceChargeLineReOnNotAppliedSlots: [3] })), true);
  assert.equal(v(failedAfterStop(1, { forceChargeLineReOnNotAppliedSlots: [] })), true);
  assert.equal(v(failedAfterStop(1, { forceChargeLineReOnCheckedAtMs: WIN_END - 160 * M })), null, 'a check older than the last re-ON judges the one before');
  assert.equal(v(failedAfterStop(0, { forceChargeLineReOnSlots: null })), false);
  assert.equal(v(onNight({ forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd' })), null, 'no re-ON tonight');
  // The round-3 reviewer's probe 2: no panel stop on record (a slot an operator switched off in the app), one re-ON that
  // took effect. The re-ON is named, never "after the panel's own stop".
  const noStop = sum(nfc.forceChargeNightOutcome(failedAfterStop(1, { forceChargeLinePanelOffAtMs: null, forceChargeLineReOnNotAppliedSlots: [],
    forceChargeLineReOnsNotApplied: 0 }), lineGates), { closePoolPct: 60 });
  assert.ok(noStop.includes('force-charge ran to the window close for the 55.6% outage line; Charge Now was switched back on 1 time(s); the pool read 60% at the close'), noStop);
  assert.doesNotMatch(noStop, /panel's own stop/);
});

test('★★★ W3 (review 4) every re-ON after the panel\'s stop counts, not the last alone; with no stop on record and no re-ON that took, never "ran to the window close"', () => {
  // The round-4 reviewer's case (a): the panel stopped the charge at 01:00; re-ON 1 at 02:00 took effect (its check stamped
  // it); re-ON 2 at 04:00, for slot 1 only, was checked not applied. The charge resumed at 02:00: the 1am stop did not end it.
  // (review 5) But re-ON 2 was written because slot 1 read OFF at 04:00, and its check found it still OFF: slot 1 read off
  // before the close, whatever re-ON 1 did — never "ran to the window close".
  const a = onNight({
    forceChargeLinePanelOffAtMs: WIN_START + 2 * H, forceChargeLineReOns: 2, forceChargeLineReOnAppliedAtMs: WIN_START + 3 * H,
    forceChargeLineReOnAtMs: WIN_START + 5 * H, forceChargeLineReOnSlots: [1], forceChargeLineReOnCheckedAtMs: WIN_START + 5 * H + 15 * M,
    forceChargeLineReOnNotAppliedSlots: [1], forceChargeLineReOnsNotApplied: 1, forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd',
  });
  const aText = sum(nfc.forceChargeNightOutcome(a, lineGates), { closePoolPct: 60 });
  assert.ok(aText.includes("force-charge ran for the 55.6% outage line; Charge Now read off on slot(s) 1 before the window close and was switched back on 2 time(s) after the panel's own stop (slot(s) still off at the readback check after 1 of them); the pool read 60% at the close"), aText);
  assert.doesNotMatch(aText, /until the panel's own stop|to the window close for/);
  // …the same night whose second re-ON never reached the panel (every write rate-limited: handed back, no slots). It was
  // written to slots reading OFF, and nothing of ours switched them on after it: read off, no slot named (no check judged it).
  const aLimited = sum(nfc.forceChargeNightOutcome({ ...a, forceChargeLineReOns: 1, forceChargeLineReOnSlots: null, forceChargeLineReOnCheckedAtMs: WIN_START + 3 * H + 15 * M,
    forceChargeLineReOnNotAppliedSlots: [], forceChargeLineReOnsNotApplied: 0 } as S, lineGates), { closePoolPct: 60 });
  assert.ok(aLimited.includes("force-charge ran for the 55.6% outage line; Charge Now read off before the window close and was switched back on 1 time(s) after the panel's own stop;"), aLimited);
  // A second panel stop AFTER the re-ON that took effect (re-stamped once its grace ran), then a re-ON that did not: the
  // second stop ended it.
  const again = sum(nfc.forceChargeNightOutcome({ ...a, forceChargeLinePanelOffAtMs: WIN_START + 4 * H } as S, lineGates), { closePoolPct: 52 });
  assert.ok(again.includes("force-charge ran for the 55.6% outage line until the panel's own stop switched Charge Now off at 3am; Charge Now was switched back on 2 time(s) after the panel's own stop (slot(s) still off at the readback check after 1 of them)"), again);
  // Case (b): no stop on record (a slot switched off in the app, or a stop the readback never caught with every slot off);
  // both re-ONs checked not applied. Slots of ours read off before the close, so never "ran to the window close" — the
  // account names the slots the last check found off.
  const b = onNight({
    forceChargeLineReOns: 2, forceChargeLineReOnAtMs: WIN_END - 150 * M, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineReOnCheckedAtMs: WIN_END - 135 * M, forceChargeLineReOnNotAppliedSlots: [1, 2, 3], forceChargeLineReOnsNotApplied: 2,
    forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd',
  });
  const bText = sum(nfc.forceChargeNightOutcome(b, lineGates), { closePoolPct: 52 });
  assert.ok(bText.includes('force-charge ran for the 55.6% outage line; Charge Now read off on slot(s) 1, 2, 3 before the window close and was switched back on 2 time(s) (slot(s) still off at the readback check after 2 of them); the pool read 52% at the close, under the 55.6% outage line'), bText);
  assert.doesNotMatch(bText, /to the window close for|panel's own stop/);
  // …with the only re-ON never reaching the panel (handed back: no count, no check): the read-off alone, no slots to name.
  const bLimited = sum(nfc.forceChargeNightOutcome(onNight({ forceChargeLineReOnAtMs: WIN_END - 40 * M, forceChargeLineReOnSlots: null,
    forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd' }), lineGates), { closePoolPct: 52 });
  assert.ok(bLimited.includes('force-charge ran for the 55.6% outage line; Charge Now read off before the window close; the pool read 52% at the close'), bLimited);
  // (review 5) …and an earlier re-ON that took effect does not undo the last one's check: re-ON 2 (02:30, every slot of ours)
  // was written to slots reading OFF and found them still OFF, with the budget spent — read off, never "ran to the window
  // close" (the round-5 reviewer's NOSTOP-MIXED night).
  const bTook = sum(nfc.forceChargeNightOutcome({ ...b, forceChargeLineReOnAppliedAtMs: WIN_END - 180 * M, forceChargeLineReOnsNotApplied: 1 } as S, lineGates), { closePoolPct: 60 });
  assert.ok(bTook.includes('force-charge ran for the 55.6% outage line; Charge Now read off on slot(s) 1, 2, 3 before the window close and was switched back on 2 time(s) (slot(s) still off at the readback check after 1 of them); the pool read 60% at the close'), bTook);
  assert.doesNotMatch(bTook, /to the window close for/);
  // …the same with a stop on record before re-ON 1 (STOP-MIXED): re-ON 1 resumed the charge, re-ON 2's slots read off.
  const stopMixed = sum(nfc.forceChargeNightOutcome({ ...b, forceChargeLinePanelOffAtMs: WIN_END - 250 * M, forceChargeLineReOnAppliedAtMs: WIN_END - 210 * M,
    forceChargeLineReOnsNotApplied: 1 } as S, lineGates), { closePoolPct: 50 });
  assert.ok(stopMixed.includes("force-charge ran for the 55.6% outage line; Charge Now read off on slot(s) 1, 2, 3 before the window close and was switched back on 2 time(s) after the panel's own stop (slot(s) still off at the readback check after 1 of them); the pool read 50% at the close, under the 55.6% outage line"), stopMixed);
  // An early OFF of ours still says when and why, whatever the re-ONs did.
  const bEarly = sum(nfc.forceChargeNightOutcome({ ...b, forceChargeOffAtMs: WIN_END - 30 * M, forceChargeOffReason: 'gridLoss' } as S, lineGates), { closePoolPct: 52 });
  assert.ok(bEarly.includes('force-charge ran for the 55.6% outage line until 4:30am (switched off: the grid was lost); Charge Now was switched back on 2 time(s)'), bEarly);
  // The outcome carries the latest re-ON that took effect and the last check's slots.
  const line = (s: S) => (nfc.forceChargeNightOutcome(s, lineGates) as unknown as { line: { reOnAppliedAtMs: number | null; reOnNotAppliedSlots: number[] | null } }).line;
  assert.deepEqual([line(a).reOnAppliedAtMs, line(a).reOnNotAppliedSlots], [WIN_START + 3 * H, [1]]);
  assert.deepEqual([line(b).reOnAppliedAtMs, line(b).reOnNotAppliedSlots], [null, [1, 2, 3]]);
});

test('★★★ W3 (review 5) the read-off is the last re-ON\'s check, unless a slot of ours read ON again after it; a slot seen ON after the panel\'s stop resumed the charge', () => {
  // Both re-ONs checked not applied, no stop on record (case b above), and then a slot of ours read ON again (the last re-ON
  // applied late, or Charge Now switched on in the app — forceChargeLineOnSeenAtMs). Charge Now did not simply read off
  // to the close: "ran to the window close". (Fix8 review 2) The re-ONs the checks found not applied are named as what those
  // checks read ("slot(s) still off at the readback check after 2 of them"), never "did not take effect": the slot seen ON
  // after them may be one of them applied late, which the code cannot tell from a person's ON.
  const b = onNight({
    forceChargeLineReOns: 2, forceChargeLineReOnAtMs: WIN_END - 150 * M, forceChargeLineReOnSlots: [1, 2, 3],
    forceChargeLineReOnCheckedAtMs: WIN_END - 135 * M, forceChargeLineReOnNotAppliedSlots: [1, 2, 3], forceChargeLineReOnsNotApplied: 2,
    forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd',
  });
  const seenAfter = sum(nfc.forceChargeNightOutcome({ ...b, forceChargeLineOnSeenAtMs: WIN_END - 120 * M } as S, lineGates), { closePoolPct: 60 });
  assert.ok(seenAfter.includes('force-charge ran to the window close for the 55.6% outage line; Charge Now was switched back on 2 time(s) (slot(s) still off at the readback check after 2 of them); the pool read 60% at the close'), seenAfter);
  assert.doesNotMatch(seenAfter, /read off/);
  // A slot seen ON BEFORE the last re-ON (the re-ON was written to it once it read OFF again): still read off.
  const seenBefore = sum(nfc.forceChargeNightOutcome({ ...b, forceChargeLineOnSeenAtMs: WIN_END - 200 * M } as S, lineGates), { closePoolPct: 52 });
  assert.ok(seenBefore.includes('Charge Now read off on slot(s) 1, 2, 3 before the window close'), seenBefore);
  // The panel's stop at 01:00, both re-ONs after it checked not applied, then a slot read ON again at 03:00: the stop did not
  // end the charge.
  const stop = { ...b, forceChargeLinePanelOffAtMs: WIN_START + 2 * H } as S;
  const stopThenSeen = sum(nfc.forceChargeNightOutcome({ ...stop, forceChargeLineOnSeenAtMs: WIN_START + 4 * H } as S, lineGates), { closePoolPct: 60 });
  assert.ok(stopThenSeen.includes("force-charge ran to the window close for the 55.6% outage line; Charge Now was switched back on 2 time(s) after the panel's own stop (slot(s) still off at the readback check after 2 of them)"), stopThenSeen);
  assert.doesNotMatch(stopThenSeen, /until the panel's own stop/);
  // …seen ON before the stop: the stop ended it.
  const seenThenStop = sum(nfc.forceChargeNightOutcome({ ...stop, forceChargeLineOnSeenAtMs: WIN_START + H } as S, lineGates), { closePoolPct: 52 });
  assert.ok(seenThenStop.includes("until the panel's own stop switched Charge Now off at 1am"), seenThenStop);
  // A re-ON handed back after one whose check found slot 2 not applied: the read-off names no slot — that check judged the
  // re-ON before (the hand-back was written to whatever read OFF then, and no check judged it).
  const handedBack = onNight({
    forceChargeLineReOns: 1, forceChargeLineReOnAtMs: WIN_END - 60 * M, forceChargeLineReOnSlots: null, forceChargeLineReOnAppliedAtMs: WIN_END - 180 * M,
    forceChargeLineReOnCheckedAtMs: WIN_END - 165 * M, forceChargeLineReOnNotAppliedSlots: [2], forceChargeLineReOnsNotApplied: 1,
    forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd',
  });
  const hb = sum(nfc.forceChargeNightOutcome(handedBack, lineGates), { closePoolPct: 52 });
  assert.ok(hb.includes('force-charge ran for the 55.6% outage line; Charge Now read off before the window close and was switched back on 1 time(s) (slot(s) still off at the readback check after 1 of them)'), hb);
  // The outcome carries the seen ON, and the last check's slots only when that check judged the last re-ON.
  const line = (s: S) => (nfc.forceChargeNightOutcome(s, lineGates) as unknown as { line: { onSeenAtMs: number | null; reOnNotAppliedSlots: number[] | null } }).line;
  assert.equal(line({ ...b, forceChargeLineOnSeenAtMs: WIN_END - 120 * M } as S).onSeenAtMs, WIN_END - 120 * M);
  assert.equal(line(b).onSeenAtMs, null);
  assert.equal(line(handedBack).reOnNotAppliedSlots, null);
  assert.equal(line({ ...b, forceChargeLineReOnCheckedAtMs: WIN_END - 160 * M } as S).reOnNotAppliedSlots, null, 'a check older than the last re-ON');
});

test('★★★ W3 (review 6) a slot seen ON again opens a new panel-stop episode: a person\'s ON, then the panel\'s stop at its ceiling, is the stop the morning names', () => {
  const obs = nfc.lineNightObservations;
  const ceiling = fo({ poolSocPct: 80, slotsOn: [], slotSocPct: at(80) });
  const stopped = (over: Record<string, unknown>) => onNight({ forceChargeLinePanelOffAtMs: T - H, forceChargeLineOffSlots: [1, 2, 3],
    forceChargeLinePoolSamples: [{ pct: 80, atMs: T - 5 * M }], ...over });
  // A slot seen ON after the recorded stop (a reading: no grace to wait), then every slot OFF with a Core at the ceiling: a stop.
  assert.deepEqual(obs(stopped({ forceChargeLineOnSeenAtMs: T - 30 * M }), T, ceiling), { forceChargeLinePanelOffAtMs: T });
  assert.deepEqual(obs(stopped({ forceChargeLineOnSeenAtMs: T - M }), T, ceiling), { forceChargeLinePanelOffAtMs: T }, 'the reading after it');
  // Seen ON before the recorded stop: the same episode. Stamped after the seen ON: once per episode.
  assert.equal(obs(stopped({ forceChargeLineOnSeenAtMs: T - 2 * H }), T, ceiling), null);
  assert.equal(obs(stopped({ forceChargeLinePanelOffAtMs: T - 10 * M, forceChargeLineOnSeenAtMs: T - 30 * M }), T, ceiling), null);
  // All OFF with no Core at the ceiling after a seen ON (Charge Now switched off in the app): no stop.
  assert.equal(obs(stopped({ forceChargeLineOnSeenAtMs: T - 30 * M }), T, fo({ poolSocPct: 70, slotsOn: [], slotSocPct: at(70) })), null);
  // The round-6 reviewer's night (probe 1): the panel's stop re-stamped at 02:30 after the second re-ON took effect (the budget
  // spent), the push at 02:50, and a person's ON 5 minutes later. The pool climbs to the 80% ceiling and the panel switches every
  // slot off again at 03:40. Only a re-ON of ours opened a new episode, so that stop was never stamped and the seen ON read as
  // the charge resumed to the close: "ran to the window close" — Charge Now had been off since 03:40.
  const P = WIN_END - 130 * M;
  const spent = onNight({ forceChargeLinePanelOffAtMs: P - 20 * M, forceChargeLineReOns: 2, forceChargeLineReOnAtMs: P - 80 * M,
    forceChargeLineReOnSlots: [1, 2, 3], forceChargeLineReOnCheckedAtMs: P - 65 * M, forceChargeLineReOnNotAppliedSlots: [],
    forceChargeLineReOnAppliedAtMs: P - 80 * M, forceChargeLineAtRiskPushedAtMs: P, forceChargeLineOffSlots: [1, 2, 3],
    forceChargeLinePoolSamples: [{ pct: 60, atMs: P - 12 * M }, { pct: 59, atMs: P - 2 * M }] });
  const pool = (m: number) => (m < 5 ? 58 : m < 50 ? Math.min(80, 58 + Math.floor((m - 5) / 2)) : Math.max(72, 80 - Math.floor((m - 50) / 10)));
  const run = drive(spent, P, 1, 129, (m) => (m >= 5 && m < 50 ? [1, 2, 3] : []), pool);
  assert.equal(run.s.forceChargeLineOnSeenAtMs, P + 5 * M, 'the person\'s ON seen');
  assert.equal(run.s.forceChargeLinePanelOffAtMs, P + 50 * M, 'the stop after it stamped');
  const closed = (s: S) => ({ ...s, forceChargeOffAtMs: WIN_END, forceChargeOffReason: 'windowEnd' }) as S;
  const text = sum(nfc.forceChargeNightOutcome(closed(run.s), lineGates), { closePoolPct: 72 });
  assert.ok(text.includes("force-charge ran for the 55.6% outage line until the panel's own stop switched Charge Now off at 3:40am; "
    + "Charge Now was switched back on 2 time(s) after the panel's own stop; the pool read 72% at the close"), text);
  assert.doesNotMatch(text, /to the window close/);
  // The reviewer's second night: no re-ON (the stop at 01:00), a slot seen ON at 02:00, then every slot OFF at the ceiling at
  // 02:30 — "until the panel's own stop switched Charge Now off at 2:30am", not "ran to the window close".
  const noReOn = onNight({ forceChargeLinePanelOffAtMs: WIN_START + 2 * H, forceChargeLineOnSeenAtMs: WIN_START + 3 * H, forceChargeLineOffSlots: [1, 2, 3],
    forceChargeLinePoolSamples: [{ pct: 80, atMs: WIN_START + 3.5 * H - 5 * M }] });
  const stamped = { ...noReOn, ...obs(noReOn, WIN_START + 3.5 * H, ceiling) } as S;
  assert.equal(stamped.forceChargeLinePanelOffAtMs, WIN_START + 3.5 * H);
  const text2 = sum(nfc.forceChargeNightOutcome(closed(stamped), lineGates), { closePoolPct: 52 });
  assert.ok(text2.includes("force-charge ran for the 55.6% outage line until the panel's own stop switched Charge Now off at 2:30am; the pool read 52% at the close, under the 55.6% outage line"), text2);
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
