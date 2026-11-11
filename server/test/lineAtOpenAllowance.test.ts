import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeNightChargePlan, buildNightChargeInputs, expectedBuyFromPlan, expectedLineForceChargeWalk, expectedWindowLiftKwh, lineNotHeldOf,
  type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import {
  FORCE_CHARGE_OPEN_ALLOWANCE_MS, FORCE_CHARGE_ON_VERIFY_AFTER_MS, FORCE_CHARGE_TICK_MS, forceChargeLineArmNote, armedLineRunOnSinceMs,
  lateStartAllowanceWords, lateStartArmTail,
} from '../src/nightForceCharge.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { buildMiddayPlanMessage } from '../src/chargeText.js';
import * as cardText from '../../web/src/cards/nightChargeText.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';

/**
 * v1.205.0 — A LINE NIGHT'S CLAIM.
 *
 * (AO-5a) H1 on the cost-carried walk: a line night the COST force-charge carries (its stop ⌈L⌉ + 10 or more) closes where its
 * walk past the stop ends (expectedBuyFromPlan closePct, v1.202.0) — never above what the window can reach, as a bound line
 * walk's close is (expectedLineBuy, H1): the one reach expression, lineWindowReachKwh.
 *
 * (AO) THE AT-OPEN ALLOWANCE: a line night is carried only where its walk holds the line on the median AND with nothing charging
 * before each whole ON minute up to the window open + FORCE_CHARGE_OPEN_ALLOWANCE_MS, its reach counted from that minute, the
 * lowest close of them (assuredClosePct, capped at the reach, never floored at the reserve). Otherwise it is disclosed
 * 'lateStart', still armed, its stated figures the median walk's. Anchored at the window open; a verified ON in the pool reading
 * the plan walks from ends it.
 *
 * fixtures/lineAtOpenAllowance.args.json holds expectedBuyFromPlan's arguments as sizeNightChargePlan passed them, captured once
 * (an instrumented copy of the planner, the year fixture's deps, the live cost gate, eligibility true). (review) Two more were captured
 * the same way for the sweep's grid and its start (AO-13b, AO-13c); the first two are unchanged.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const M = 60_000;
const H = 3_600_000;
const ARGS = JSON.parse(readFileSync(resolve(HERE, 'fixtures/lineAtOpenAllowance.args.json'), 'utf8')) as Record<string, {
  label: string; basis: 'np' | 'm'; hours: number; linePct: number; windowStartMs: number; args: Parameters<typeof expectedBuyFromPlan>[0];
}>;
const CASES = legacyIdentityCases();
const live = (d: Record<string, unknown>) => ({ ...d, forceChargeEligible: d.objectiveMode === 'cost' && ((d.costMaxSocPct as number | undefined) ?? 90) > 50 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type P = NightChargePlan & Record<string, any>;
const planAt = (label: string, b: 'np' | 'm', h: number, extra: Record<string, unknown> = {}, served: Record<string, unknown> = {}): P => computeNightChargePlan({
  ...buildNightChargeInputs({
    ...live(CASES.find((c) => c.label === label)!.deps as unknown as Record<string, unknown>), outageCushionHours: h,
    ...(b === 'm' ? { cushionPoolScale: MEASURED_SCALE } : {}), lineForceChargeEligible: true, ...extra,
  } as never)!,
  ...served,
} as never) as P;
const card = cardText as unknown as { outageLineRow: (p: unknown) => string | null; lineNotHeldOfCard: (p: unknown) => string | null };
const SUP = { targetPct: 50, cancelDeadlineText: 'Until 11:00 PM', forceChargeTargetPct: null };
const pushOf = (p: P): string => buildNightChargeMessage(p, 'charge', SUP as never).body;
/** What the window delivers from `fromMs` (the sweep's reach, as expectedBuyFromPlan's assured walk counts it). */
const liftFrom = (a: Parameters<typeof expectedBuyFromPlan>[0], fromMs: number): number | null => expectedWindowLiftKwh({
  hours: a.window.hours, fromMs, windowEndMs: a.window.windowEndMs, chargeCapKw: a.window.chargeCapKw, envelopeKw: a.window.envelopeKw,
  legEff: a.legEff, acceptKw: a.window.acceptKw ?? null,
});

/** What a 'lateStart' night allows for (nightForceCharge.lateStartAllowanceWords): the plan's own switch-on at the window open where
 *  its start is inside the allowance (cushionLateStartAtOpen), the window's charge where it is past it (its reach alone decides). */
const OPEN = 'a late switch-on at the window open';
const CHARGE = "a late start of the window's charge";
/** The words of a 'lateStart' night, on every surface. */
const RATIONALE = (x: string, l: number, w: string = OPEN): string => ` NOTE: on the median load the pool is expected to close at ~${x}%, too close to tonight's ${l}% outage line to allow for ${w}, so the cushion is not assured — residual risk remains.`;
const PUSH_LINE = /NOTE: on the median load the pool is expected to close at ~([\d.]+)%, too close to tonight's [\d.]+% outage line to allow for (a late switch-on at the window open|a late start of the window's charge) — residual risk remains\./;
const PUSH_COST = /NOTE: tonight's [\d.]+% outage line is too close to the expected close to allow for (a late switch-on at the window open|a late start of the window's charge) — residual risk remains\./;
const CARD_LINE = / — too close to the line to allow for (a late switch-on at the window open|a late start of the window's charge); residual risk remains$/;
const CARD_COST = / — its force-charge runs, but the line is not claimed; residual risk remains$/;
/** Either 'lateStart' wording, on any surface. */
const LATE_WORDS = /late switch-on at the window open|late start of the window's charge/;
/** A close stated under the line (the 'closeUnder' words): never on a 'lateStart' night. */
const UNDER = /expected to close at (?:~[\d.]+%|a level), under |, under the line|Line NOT held/;

/** A 'lateStart' night: disclosed, still armed, worded alike by the server and the card, never "under". */
function disclosedLate(p: P, where: string): void {
  assert.equal(p.cushionEnvelopeReason, 'lateStart', where);
  assert.equal(p.cushionShortfall, true, where);
  assert.equal(p.cushionShortfallCause, 'envelope', where);
  assert.ok(p.forceChargeLine != null, `${where}: still armed`);
  assert.equal(lineNotHeldOf(p), 'lateStart', where);
  assert.equal(card.lineNotHeldOfCard(p), 'lateStart', `${where}: the card mirrors it`);
  assert.doesNotMatch(p.rationale, UNDER, `${where}: rationale`);
  assert.doesNotMatch(pushOf(p), UNDER, `${where}: push`);
  assert.doesNotMatch(card.outageLineRow(p) ?? '', UNDER, `${where}: card`);
}

test('★★★ AO-1 the allowance is the actuator\'s own: the ON\'s readback grace and five ticks, 20 min; 2026-11-10\'s at-open ON read ON on every Core 19:47 after the open', () => {
  assert.equal(FORCE_CHARGE_OPEN_ALLOWANCE_MS, FORCE_CHARGE_ON_VERIFY_AFTER_MS + 5 * FORCE_CHARGE_TICK_MS);
  assert.equal(FORCE_CHARGE_OPEN_ALLOWANCE_MS, 20 * M);
  // The 2026-11-10 record's stamps (the night-charge status): the open, the apply, the ON, the re-issue, every Core verified ON.
  const open = 1794376800000, apply = 1794376847017, on = 1794376967018, retry = 1794377927181, verified = 1794377987018;
  assert.ok(open < apply && apply < on && on < retry && retry < verified);
  assert.equal(on - open, 167_018, 'the ON 2:47 after the open (the apply, its readback with the ceiling sync, the ceiling\'s readback with the ON)');
  assert.ok(retry - on >= FORCE_CHARGE_ON_VERIFY_AFTER_MS && retry - on < FORCE_CHARGE_ON_VERIFY_AFTER_MS + 2 * FORCE_CHARGE_TICK_MS, 're-issued after the grace and a tick');
  assert.equal(verified - open, 1_187_018);
  assert.ok(verified - open <= FORCE_CHARGE_OPEN_ALLOWANCE_MS, `every Core ON within the allowance (${verified - open} ms)`);
});

test('★★★ AO-2 the walk: nothing charges before onNotBeforeMs, the start it decides is unchanged, a deferred walk never reads as latched, and at or before fromMs it is the walk without it', () => {
  const D0 = Date.UTC(2027, 3, 10, 6);
  const hours = [0, 1].map((i) => ({ ts: D0 + i * H, pvP10W: 0, pvP50W: 0, loadP90W: 2500, loadP50W: 2000, evP90W: 0 }));
  const o = { startKwh: 0.52 * 87, reserveKwh: 0.5 * 87, fullKwh: 87, tickPoolKwh: 92.16, startTargetPct: 65, panelCeilingPct: 80, hours, fromMs: D0, windowEndMs: D0 + H,
    dischargeEff: 0.94, chargeCapKw: 17.8, envelopeKw: 17, legEff: 0.927, acceptKw: null };
  const free = expectedLineForceChargeWalk(o)!;
  const late = expectedLineForceChargeWalk({ ...o, onNotBeforeMs: D0 + 20 * M })!;
  assert.equal(free.startMs, D0, 'at the open');
  assert.equal(late.startMs, free.startMs, 'the start it decides is the same');
  assert.equal(late.startPackKwh, free.startPackKwh);
  const ratePerMin = ((17 - 2) * 0.927) / 60;
  assert.ok(free.closeKwh - late.closeKwh > 19 * ratePerMin, `20 min of charge is not credited (${(free.closeKwh - late.closeKwh).toFixed(2)} kWh)`);
  assert.ok(late.gridKwh < free.gridKwh - 19 * ratePerMin);
  assert.equal(free.ceilingReached, false);
  assert.equal(late.ceilingReached, false, 'deferred, not latched: no panel stop read into the wait');
  assert.deepEqual(expectedLineForceChargeWalk({ ...o, onNotBeforeMs: D0 }), free);
  assert.deepEqual(expectedLineForceChargeWalk({ ...o, onNotBeforeMs: D0 - M }), free);
});

test('★★★ AO-3 path (b), not window-bound: Friday 2027-04-09 21:30 at ×0.944, 7 h (open ~51.8%, line 59.43%) — the median close 59.5% holds, the at-open allowance does not: disclosed \'lateStart\', still armed', () => {
  const p = planAt('2027-04-09 21:30', 'm', 7);
  assert.equal(p.expectedDeliverableBound, false);
  assert.equal(p.expectedForceChargeMode, 'line');
  assert.deepEqual([p.cushionLineSocPct, p.expectedStartSocPct, p.expectedWriteLevelPct], [59.43, 51.8, 59.5], 'the stated close is the median walk, unchanged');
  disclosedLate(p, 'path b');
  assert.equal(p.expectedForceChargeStartMs, p.window!.startMs, 'its own start at the open');
  assert.equal(p.cushionLateStartAtOpen, true, 'what the allowance defers: its switch-on at the window open');
  assert.ok(p.rationale.includes(RATIONALE('59.5', 59.43)), p.rationale);
  assert.deepEqual(PUSH_LINE.exec(pushOf(p))?.slice(1), ['59.5', OPEN], pushOf(p));
  assert.equal(CARD_LINE.exec(card.outageLineRow(p) ?? '')?.[1], OPEN);
});

test('★★★ AO-4 path (a), window-bound: 2027-02-15 21:30 on nameplate at 18 h (open ~33.5%, the walk capped at its ~69.7% reach, line 69.24%) — the reach counted from the allowance\'s end does not hold it: disclosed', () => {
  const p = planAt('2027-02-15 21:30', 'np', 18);
  assert.equal(p.expectedDeliverableBound, true);
  assert.deepEqual([p.cushionLineSocPct, p.expectedStartSocPct, p.expectedWriteLevelPct], [69.24, 33.5, 69.7]);
  assert.ok(p.expectedForceChargeStartMs! > p.window!.startMs + FORCE_CHARGE_OPEN_ALLOWANCE_MS, 'its own start is past the allowance: the reach decides');
  disclosedLate(p, 'path a');
  // (review) Its force-charge switches on at ~00:58, not at the open: the words name a late start of the window's charge (the reach
  // counted from the allowance's end), never a switch-on at the window open the plan does not make.
  assert.equal(p.cushionLateStartAtOpen, undefined);
  assert.match(p.rationale, /the panel's force-charge switches on at ~00:58 and stays on until the window closes/);
  assert.ok(p.rationale.includes(RATIONALE('69.7', 69.24, CHARGE)), p.rationale);
  assert.deepEqual(PUSH_LINE.exec(pushOf(p))?.slice(1), ['69.7', CHARGE], pushOf(p));
  assert.equal(CARD_LINE.exec(card.outageLineRow(p) ?? '')?.[1], CHARGE);
  assert.doesNotMatch(p.rationale + pushOf(p) + (card.outageLineRow(p) ?? ''), /switch-on at the window open/);
});

test('★★★ AO-5 a cost-carried line night, window-bound (2027-02-05 21:30 at ×0.944, 20 h): its close past the stop capped at ~59.9% holds the 58.91% line, the allowance does not — disclosed; the rationale, the 21:30 push and the ARMED line name ~59.9%, none the stop', () => {
  const p = planAt('2027-02-05 21:30', 'm', 20);
  assert.equal(p.expectedForceChargeMode, undefined, 'the cost force-charge carries it');
  assert.equal(p.expectedDeliverableBound, true);
  assert.equal(p.expectedWriteLevelPct, 87, 'the stop');
  disclosedLate(p, 'cost-carried');
  assert.equal(p.cushionLateStartAtOpen, true, 'the cost force-charge at the open');
  // (review) The plan carries the close past the stop beside 'lateStart' (it holds the line on the median walk): every surface that
  // names a figure names it, the stop nowhere as the close.
  assert.equal(p.expectedCloseAfterStopPct, 59.9);
  assert.ok(p.rationale.includes(RATIONALE('59.9', 58.91)), p.rationale);
  assert.deepEqual(PUSH_LINE.exec(pushOf(p))?.slice(1), ['59.9', OPEN], pushOf(p));
  assert.equal(lateStartArmTail(p.expectedCloseAfterStopPct, p.cushionLateStartAtOpen),
    ' Line NOT assured: ~59.9% expected at the close, too close to the line to allow for a late switch-on at the window open.', 'the ARMED line');
  assert.doesNotMatch(pushOf(p), /close at ~87%/);
  assert.match(card.outageLineRow(p) ?? '', CARD_COST);
  // A plan without the close (none this build makes) names no figure, never the stop.
  const bare = { ...p, expectedCloseAfterStopPct: undefined } as P;
  assert.equal(PUSH_COST.exec(pushOf(bare))?.[1], OPEN, pushOf(bare));
  assert.doesNotMatch(pushOf(bare), /close at ~/);
});

test('★★★ AO-5a (H1) a cost-carried line night\'s close past its stop is capped at the window\'s reach: 2027-02-05 21:30 at ×0.944, 20 h — ~59.9%, not the walk\'s ~65.8%; the stop, the start and the write unchanged', () => {
  const k = ARGS['2027-02-05 21:30|m|20'];
  const p = planAt(k.label, k.basis, k.hours);
  assert.equal(p.cushionLineSocPct, k.linePct, 'the captured arguments are this plan\'s');
  assert.equal(p.expectedForceChargeMode, undefined, 'the cost force-charge carries it');
  assert.equal(p.expectedDeliverableBound, true, 'window-bound');
  assert.equal(p.expectedWriteLevelPct, 87, 'its stated level is the stop');
  const e = expectedBuyFromPlan(k.args);
  assert.deepEqual([e.levelPct, e.closePct, e.rawClosePct, e.deliverableBound, e.buyKwh], [87, 59.9, 59.9, true, 14.86]);
  // The reach: the window-open pack, the deliverable and the window's P50 PV (none in this overnight hour).
  const reachPct = ((k.args.startKwh! + k.args.deliverableKwh!) / k.args.fullKwh) * 100;
  assert.equal(Math.round(reachPct * 10) / 10, 59.9);
  // The walk past the stop itself is unchanged: with a window that delivers everything, nothing binds and nothing caps it.
  const free = expectedBuyFromPlan({ ...k.args, deliverableKwh: 1e6 });
  assert.deepEqual([free.levelPct, free.closePct, free.rawClosePct, free.deliverableBound ?? false], [87, 65.8, 65.8, false]);
  assert.deepEqual([e.forceChargeStartMs, e.forceChargeFromPct], [free.forceChargeStartMs, free.forceChargeFromPct], 'the start the walk decides');
  // (review) The cap is recorded where it binds (closeReachCapped: the walk identity's guard, lineStandingWalk W1), not on every
  // bound window: a window that reaches ~70% is bound (the stop is 87%) and leaves the ~65.8% close past the stop as walked.
  assert.deepEqual([e.closeReachCapped, free.closeReachCapped], [true, undefined]);
  const mid = expectedBuyFromPlan({ ...k.args, deliverableKwh: 0.7 * k.args.fullKwh - k.args.startKwh! });
  assert.deepEqual([mid.deliverableBound, mid.closePct, mid.rawClosePct, mid.closeReachCapped], [true, 65.8, 65.8, undefined]);
  // Under the reserve the stated close is floored at it (the level convention of every bound night); the claim's is not.
  const low = expectedBuyFromPlan({ ...k.args, deliverableKwh: 0 });
  const lowReach = Math.round((k.args.startKwh! / k.args.fullKwh) * 1000) / 10;
  assert.equal(low.rawClosePct, lowReach);
  assert.ok(lowReach < 50 && low.closePct === 50, `${low.closePct} / ${low.rawClosePct}`);
});

test('★★★ AO-6 a line in (49, 50] (2026-11-27 21:30 at ×0.944, 16 h): the claim reads the assured close unfloored — the median walk reaches ~50.0% (it holds the 49.99% line), the assured walk ~47.5% at the allowance\'s end, which the 50% floor would read as 50%', () => {
  const p = planAt('2026-11-27 21:30', 'm', 16);
  assert.equal(p.cushionLineSocPct, 49.99);
  assert.equal(p.expectedWriteLevelPct, 50, 'stated at the floor, as before');
  assert.equal(p.expectedDeliverableBound, true);
  disclosedLate(p, '(49, 50]');
  assert.ok(p.rationale.includes(RATIONALE('50', 49.99)), p.rationale);
  // (review) What it shows, on its captured arguments: the median walk, capped at the window's reach (~50.01%), holds the line
  // unfloored too; the night is disclosed for the allowance alone. The walk from each ON minute is capped at the reach from that
  // minute — ~49.9% at +1, ~47.5% at the allowance's end — and the floored (stated) close reads 50% at every one of them: the claim
  // reads the unfloored close, or the night is carried on the floor.
  const k = ARGS['2026-11-27 21:30|m|16'];
  const W0 = k.windowStartMs;
  assert.deepEqual([k.linePct, k.args.window.fromMs, p.window!.startMs], [49.99, W0, W0], 'the captured arguments are this plan\'s, planned before the open');
  const median = expectedBuyFromPlan(k.args);
  assert.deepEqual([median.mode, median.levelPct, median.rawClosePct, median.deliverableBound, median.forceChargeStartMs], ['line', 50, 50, true, W0]);
  const at = (min: number) => expectedBuyFromPlan({ ...k.args, onNotBeforeMs: W0 + min * M, deliverableKwh: liftFrom(k.args, W0 + min * M) });
  assert.deepEqual([1, 2, 20].map((min) => at(min).rawClosePct), [49.9, 49.8, 47.5], 'unfloored');
  assert.deepEqual([1, 2, 20].map((min) => at(min).levelPct), [50, 50, 50], 'floored, every minute reads as held');
  const r = expectedBuyFromPlan({ ...k.args, assureUntilMs: W0 + FORCE_CHARGE_OPEN_ALLOWANCE_MS });
  assert.deepEqual([r.assuredClosePct, (r.assuredAtMs! - W0) / M], [47.5, 20]);
});

test('★★★ AO-7 a timed start inside the window, and a pool opening above its line at the open, stay carried', () => {
  const t = planAt('2027-01-04 21:30', 'm', 13);
  assert.ok(t.forceChargeLine != null && t.expectedForceChargeMode === 'line');
  assert.ok(t.expectedForceChargeStartMs! > t.window!.startMs + FORCE_CHARGE_OPEN_ALLOWANCE_MS, 'timed after the allowance');
  assert.deepEqual([t.cushionShortfall, t.cushionEnvelopeReason ?? null, lineNotHeldOf(t)], [false, null, null], 'timed');
  const a = planAt('2026-12-11 21:30', 'np', 11);
  assert.equal(a.expectedForceChargeStartMs, a.window!.startMs, 'at the open');
  assert.ok(a.expectedStartSocPct! >= a.cushionLineSocPct!, 'opens above its line');
  assert.deepEqual([a.cushionShortfall, a.cushionEnvelopeReason ?? null, lineNotHeldOf(a), card.lineNotHeldOfCard(a)], [false, null, null, null]);
  assert.doesNotMatch(a.rationale, LATE_WORDS);
});

test('★★★ AO-8 mid-window: the allowance is anchored at the window open (it lapses at +20 min whatever is read), and a verified ON ends it only when stamped in the window and at or before the pool reading the plan walks from', () => {
  const base = planAt('2027-04-09 21:30', 'm', 7);
  const W0 = base.window!.startMs;
  const at = (dtMin: number, served: Record<string, unknown> = {}) => planAt('2027-04-09 21:30', 'm', 7, { nowMs: W0 + dtMin * M, socNowPct: 52 + dtMin * 0.25 }, served);
  assert.equal(at(5).cushionEnvelopeReason, 'lateStart', '+5 min, no ON on record: the rest of the allowance');
  for (const dt of [20, 21]) {
    const p = at(dt);
    assert.notEqual(p.cushionEnvelopeReason, 'lateStart', `+${dt} min: lapsed`);
    assert.equal(p.forceChargeLine != null, true);
  }
  const run = (v: number) => ({ armedLineRunOnStartMs: W0, armedLineOnVerifiedAtMs: v });
  assert.notEqual(at(5, run(W0 + 4 * M)).cushionEnvelopeReason, 'lateStart', 'verified at +4 min, the pool read at +5: no allowance');
  assert.notEqual(at(5, run(W0 + 5 * M)).cushionEnvelopeReason, 'lateStart', 'verified at the reading itself');
  assert.equal(at(5, run(W0 + 5 * M + 1)).cushionEnvelopeReason, 'lateStart', 'verified after the pool reading: the reading predates it, so the allowance stands');
  assert.equal(at(5, run(W0 - 1)).cushionEnvelopeReason, 'lateStart', 'a stamp before this window\'s open is not its ON');
  assert.equal(at(5, run(Number.NaN)).cushionEnvelopeReason, 'lateStart');
  // The verify alone ends it (the plan of record gets it too, from the record, as index.ts passes it): with no run on, the walk is the median's.
  assert.notEqual(at(5, { armedLineOnVerifiedAtMs: W0 + 4 * M }).cushionEnvelopeReason, 'lateStart');
  // (review) The production path: index.ts hands the stamp to buildNightChargeInputs (its deps), which forwards it to the plan's inputs.
  const viaDeps = (v: number) => planAt('2027-04-09 21:30', 'm', 7, { nowMs: W0 + 5 * M, socNowPct: 52 + 5 * 0.25, armedLineOnVerifiedAtMs: v });
  assert.notEqual(viaDeps(W0 + 4 * M).cushionEnvelopeReason, 'lateStart', 'forwarded by buildNightChargeInputs: verified at +4, read at +5');
  assert.equal(viaDeps(W0 + 5 * M + 1).cushionEnvelopeReason, 'lateStart', 'forwarded, and judged against the pool reading alike');
});

test('★★ AO-9 a night whose median walk closes under its line keeps \'closeUnder\' and its words (the stronger statement wins)', () => {
  const p = planAt('2027-08-09 21:30', 'm', 13);
  assert.equal(p.cushionEnvelopeReason, 'closeUnder');
  assert.equal(lineNotHeldOf(p), 'closeUnder');
  assert.equal(card.lineNotHeldOfCard(p), 'closeUnder');
  assert.ok(p.rationale.includes(" NOTE: on the median load the pool is expected to close at ~54.9%, under tonight's 68.85% outage line, so the cushion is not fully held — residual risk remains."), p.rationale);
  assert.doesNotMatch(p.rationale + pushOf(p), LATE_WORDS);
});

test('★★ AO-11 the mid-day shadow record keeps \'lateStart\' across a restore, and the mid-day push words it', async () => {
  const ms = await import('../src/middayShadow.js');
  const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
  const p = planAt('2027-04-09 21:30', 'm', 7);
  const leg = { role: 'cost', kind: 'super_off_peak', startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) };
  const sum = (ms as unknown as { summariseLeg: (l: unknown, s: unknown, a: unknown) => Record<string, unknown> }).summariseLeg(leg, { plan: p, windowPvP50Kwh: null, windowLoadP50Kwh: null }, { wouldArm: true, disposition: 'would arm' });
  assert.equal(sum.lineNotHeld, 'lateStart');
  const rec = { version: 1, day: '2026-10-14', computedAtMs: phx(10, 14, 21, 30), why: 'midday', mode: 'supervised', backup: null, cost: sum, refresh: null, note: null };
  const back = ms.coerceMiddayShadowRecord(JSON.parse(JSON.stringify(rec)))!;
  assert.equal((back.cost as unknown as Record<string, unknown>).lineNotHeld, 'lateStart', 'kept across a restore');
  const { buildApsREvModel } = await import('../src/tariff.js');
  assert.equal((back.cost as unknown as Record<string, unknown>).lateStartAtOpen, true, 'its switch-on at the open, kept across a restore');
  const body = buildMiddayPlanMessage(ms.middayShadowAnnounceInput(back, buildApsREvModel())!).body;
  assert.ok(body.includes(" NOTE: on the median load this leg's pool is expected to close too close to its outage line to allow for a late switch-on at the window open — residual risk remains."), body);
  assert.doesNotMatch(body, /no force-charge carries it|under its outage line/);
  // (review) A leg whose own start is past the allowance (2027-02-15 21:30 on nameplate, 18 h: the force-charge from ~00:58): its words
  // name the window's charge, and a record from before the field (lateStartAtOpen lost) says the same — never a switch-on at the open.
  const past = planAt('2027-02-15 21:30', 'np', 18);
  const pastSum = (ms as unknown as { summariseLeg: (l: unknown, s: unknown, a: unknown) => Record<string, unknown> }).summariseLeg(leg, { plan: past, windowPvP50Kwh: null, windowLoadP50Kwh: null }, { wouldArm: true, disposition: 'would arm' });
  assert.deepEqual([pastSum.lineNotHeld, pastSum.lateStartAtOpen], ['lateStart', undefined]);
  const CHARGE_NOTE = " NOTE: on the median load this leg's pool is expected to close too close to its outage line to allow for a late start of the window's charge — residual risk remains.";
  for (const c of [pastSum, { ...sum, lateStartAtOpen: undefined }]) {
    const r = ms.coerceMiddayShadowRecord(JSON.parse(JSON.stringify({ ...rec, cost: c })))!;
    const b = buildMiddayPlanMessage(ms.middayShadowAnnounceInput(r, buildApsREvModel())!).body;
    assert.ok(b.includes(CHARGE_NOTE), b);
    assert.doesNotMatch(b, /switch-on at the window open/);
  }
  // Kept only beside 'lateStart'.
  const odd = ms.coerceMiddayShadowRecord(JSON.parse(JSON.stringify({ ...rec, cost: { ...sum, lineNotHeld: 'closeUnder' } })))!;
  assert.equal((odd.cost as unknown as Record<string, unknown>).lateStartAtOpen, undefined);
});

test('★★ AO-12 the ARMED line: "Line NOT assured" for both kinds, never "NOT held"; index.ts passes the verified ON only through armedLineRunOnSinceMs, beside armedNoLineStartMs', () => {
  const line = forceChargeLineArmNote({ linePct: 59.43, startTargetPct: 65, panelCeilingPct: 70, expectedStartText: '11:00 PM', timedByText: '11:40 PM', notHeld: { kind: 'lateStart', closePct: 59.5 } });
  assert.ok(line.endsWith(" Line NOT assured: ~59.5% expected at the close, too close to the line to allow for a late start of the window's charge."), line);
  assert.doesNotMatch(line, /NOT held/);
  const open = forceChargeLineArmNote({ linePct: 59.43, startTargetPct: 65, panelCeilingPct: 70, expectedStartText: '11:00 PM', timedByText: '11:40 PM', notHeld: { kind: 'lateStart', closePct: 59.5, atOpen: true } });
  assert.ok(open.endsWith(' Line NOT assured: ~59.5% expected at the close, too close to the line to allow for a late switch-on at the window open.'), open);
  // (review) The one predicate's words: the switch-on at the open only where the plan's own start is inside the allowance.
  assert.deepEqual([lateStartAllowanceWords(true), lateStartAllowanceWords(false), lateStartAllowanceWords(undefined)], [OPEN, CHARGE, CHARGE]);
  const idx = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
  // (review) Both ARMED lines word a 'lateStart' night by one helper: its close (the cost walk's past the stop, never the stop).
  assert.ok(idx.includes("  return eligible + (lineNotHeldOf(plan) === 'lateStart' ? lateStartArmTail(plan?.expectedCloseAfterStopPct, plan?.cushionLateStartAtOpen) : '');\n"));
  assert.ok(line.endsWith(lateStartArmTail(59.5, undefined)) && open.endsWith(lateStartArmTail(59.5, true)), 'the line-mode note is the helper\'s');
  assert.deepEqual([lateStartArmTail(59.94, true), lateStartArmTail(null, false), lateStartArmTail(undefined, true)], [
    ' Line NOT assured: ~59.9% expected at the close, too close to the line to allow for a late switch-on at the window open.',
    " Line NOT assured: a level near the line expected at the close, too close to the line to allow for a late start of the window's charge.",
    ' Line NOT assured: a level near the line expected at the close, too close to the line to allow for a late switch-on at the window open.',
  ]);
  assert.ok(idx.includes("      notHeld: notHeld != null ? { kind: notHeld, closePct: plan?.expectedWriteLevelPct ?? null, atOpen: plan?.cushionLateStartAtOpen === true } : null,\n"));
  // The served and the plan of record alike: never the arm, never a shadow leg — as armedNoLineStartMs.
  const ONE = '    armedLineOnVerifiedAtMs: shadowLeg == null && opts.arming !== true ? armedLineRunOnSinceMs(nightActuationMem) : null,\n';
  assert.equal(idx.split('armedLineOnVerifiedAtMs').length - 1, 1, 'one reader of the stamp');
  const NO_LINE = '    armedNoLineStartMs: shadowLeg == null && opts.arming !== true ? armedNoLineStartMs(nightActuationMem) : null,\n';
  const [noLineAt, oneAt] = [idx.indexOf(NO_LINE), idx.indexOf(ONE)];
  assert.ok(noLineAt > 0 && oneAt > noLineAt, 'after armedNoLineStartMs');
  const between = idx.slice(noLineAt + NO_LINE.length, oneAt).split('\n').filter((l) => l.trim() !== '');
  assert.ok(between.every((l) => l.trim().startsWith('//')), `beside armedNoLineStartMs, only a comment between: ${between.join(' | ')}`);
  // armedLineRunOnSinceMs: the verify stamp of a run on record, and nothing else.
  const rec = {
    windowStartMs: 1, forceChargeLineAskPct: 60, forceChargeLinePct: 59.43, forceChargeOnVerifiedAtMs: 5, forceChargeOffAtMs: null,
    cancelled: false, revertedAtMs: null, foreignSettledAtMs: null, forceChargeSlots: [1, 2, 3], forceChargeLineOffSlots: null,
  };
  assert.equal(armedLineRunOnSinceMs(rec as never), 5);
  assert.equal(armedLineRunOnSinceMs({ ...rec, forceChargeOffAtMs: 9 } as never), null, 'an OFF of ours');
  assert.equal(armedLineRunOnSinceMs({ ...rec, forceChargeLineAskPct: null, forceChargeLinePct: null } as never), null, 'no line on record');
  assert.equal(armedLineRunOnSinceMs({ ...rec, forceChargeOnVerifiedAtMs: null } as never), null, 'not verified');
});

test('★★★ G4 index.ts reads the time and the pool before its first await, and the record\'s verified ON after it: a verify landing in between keeps the allowance for that recompute', () => {
  const idx = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
  const fn = idx.indexOf('async function recomputeNightChargePlan(');
  const end = idx.indexOf('\nasync function ', fn + 10);
  const body = idx.slice(fn, end > fn ? end : undefined);
  const nowAt = body.indexOf('  const nowMs = Date.now();\n');
  const socAt = body.indexOf('  const socNowPct: number | null = sp.backupBatPercent ?? null;\n');
  const firstAwait = body.search(/\bawait\b/);
  const stampAt = body.indexOf('    armedLineOnVerifiedAtMs: ');
  assert.ok(nowAt > 0 && socAt > 0 && firstAwait > 0 && stampAt > 0, `${nowAt} ${socAt} ${firstAwait} ${stampAt}`);
  assert.ok(nowAt < firstAwait && socAt < firstAwait, 'the time and the pool before the first await');
  assert.ok(stampAt > firstAwait, 'the record after it');
});

test('★★★ AO-13 every whole ON minute of the allowance is walked, the lowest close taken: 2027-08-09 13:00 at ×0.944, 12 h (captured arguments) — ~69.1% at +5 min, under the median\'s ~77.8% and the allowance end\'s ~76.2%', () => {
  const k = ARGS['2027-08-09 13:00|m|12'];
  const W0 = k.windowStartMs;
  assert.equal(k.args.window.fromMs, W0, 'planned before the open');
  const median = expectedBuyFromPlan(k.args);
  const r = expectedBuyFromPlan({ ...k.args, assureUntilMs: W0 + FORCE_CHARGE_OPEN_ALLOWANCE_MS });
  assert.equal(median.forceChargeStartMs, W0, 'an at-open start');
  assert.deepEqual([median.levelPct, median.rawClosePct, median.assuredClosePct], [77.8, 77.8, undefined]);
  assert.deepEqual([r.assuredClosePct, (r.assuredAtMs! - W0) / M], [69.1, 5]);
  const { assuredClosePct: _a, assuredAtMs: _b, ...rest } = r;
  assert.deepEqual(rest, median, 'every other figure is the median walk\'s');
  // The minute by minute closes: the end alone reads ~76.2%, +5 min ~69.1% — the latching walk is not monotone in the minute.
  const closeAt = (min: number) => expectedBuyFromPlan({ ...k.args, onNotBeforeMs: W0 + min * M, deliverableKwh: liftFrom(k.args, W0 + min * M) }).rawClosePct;
  assert.deepEqual([1, 4, 5, 6, 20].map(closeAt), [77.4, 73.8, 69.1, 69.7, 76.2]);
  // An allowance that has already lapsed (at or before the walk's own start): nothing to assure.
  assert.equal(expectedBuyFromPlan({ ...k.args, assureUntilMs: W0 }).assuredClosePct, undefined);
  // A cost-carried night (2027-02-05 21:30 at ×0.944, 20 h; the cost force-charge at the open): its walk past the stop is deferred
  // too — on a window that delivers everything, 20 min of no charge closes ~60.6%, not ~65.8% — and on its bound window the reach
  // from each minute decides, lowest at the allowance's end (~54.6%).
  const c = ARGS['2027-02-05 21:30|m|20'];
  const C0 = c.windowStartMs;
  assert.deepEqual([expectedBuyFromPlan({ ...c.args, deliverableKwh: 1e6 }).rawClosePct, expectedBuyFromPlan({ ...c.args, deliverableKwh: 1e6, onNotBeforeMs: C0 + 20 * M }).rawClosePct], [65.8, 60.6]);
  const cr = expectedBuyFromPlan({ ...c.args, assureUntilMs: C0 + FORCE_CHARGE_OPEN_ALLOWANCE_MS });
  assert.deepEqual([cr.closePct, cr.rawClosePct, cr.assuredClosePct, (cr.assuredAtMs! - C0) / M], [59.9, 59.9, 54.6, 20]);
  // No P50 basis: the assured close holds, as the median does.
  const blind = expectedBuyFromPlan({ ...k.args, startKwh: null, assureUntilMs: W0 + FORCE_CHARGE_OPEN_ALLOWANCE_MS });
  assert.deepEqual([blind.mode, blind.rawClosePct, blind.assuredClosePct], ['line', undefined, null]);
});

test('★★★ AO-13b every minute, not a coarser grid: 2027-08-09 21:30 at ×0.944, 11 h (captured arguments; an at-open start) — the lowest close ~65.6% at +12 min, a minute no 5-minute grid walks (~66.9% at +15 is its lowest)', () => {
  const k = ARGS['2027-08-09 21:30|m|11'];
  const W0 = k.windowStartMs;
  assert.equal(k.args.window.fromMs, W0, 'planned before the open');
  const median = expectedBuyFromPlan(k.args);
  assert.deepEqual([median.mode, median.forceChargeStartMs, median.rawClosePct], ['line', W0, 76.3], 'an at-open start');
  const closeAt = (min: number) => expectedBuyFromPlan({ ...k.args, onNotBeforeMs: W0 + min * M, deliverableKwh: liftFrom(k.args, W0 + min * M) }).rawClosePct;
  assert.deepEqual([5, 10, 11, 12, 13, 15, 20].map(closeAt), [74.5, 70.7, 69.2, 65.6, 66.1, 66.9, 69.3]);
  const r = expectedBuyFromPlan({ ...k.args, assureUntilMs: W0 + FORCE_CHARGE_OPEN_ALLOWANCE_MS });
  assert.deepEqual([r.assuredClosePct, (r.assuredAtMs! - W0) / M], [65.6, 12]);
  assert.notEqual(((r.assuredAtMs! - W0) / M) % 5, 0, 'the lowest minute is not on a 5-minute grid');
  assert.equal(r.assuredClosePct! >= k.linePct - 0.05, true, 'it holds the 60.72% line');
});

test('★★★ AO-13c a median start inside the allowance: 2027-08-29 21:30 at ×0.944, 20 h (captured arguments) — its force-charge from +5 min; every minute is walked, the lowest close ~91.0% at +12, after that start, under the allowance end\'s ~91.5%', () => {
  const k = ARGS['2027-08-29 21:30|m|20'];
  const W0 = k.windowStartMs;
  const until = W0 + FORCE_CHARGE_OPEN_ALLOWANCE_MS;
  assert.equal(k.args.window.fromMs, W0, 'planned before the open');
  const median = expectedBuyFromPlan(k.args);
  assert.equal(median.mode, 'line');
  assert.equal((median.forceChargeStartMs! - W0) / M, 5, 'its own start strictly inside the allowance');
  assert.equal(median.rawClosePct, 96.6);
  const closeAt = (min: number) => expectedBuyFromPlan({ ...k.args, onNotBeforeMs: W0 + min * M, deliverableKwh: liftFrom(k.args, W0 + min * M) }).rawClosePct;
  assert.deepEqual([4, 5, 11, 12, 13, 20].map(closeAt), [96.6, 96.6, 97, 91, 91, 91.5]);
  const r = expectedBuyFromPlan({ ...k.args, assureUntilMs: until });
  assert.deepEqual([r.assuredClosePct, (r.assuredAtMs! - W0) / M], [91, 12]);
  assert.ok(r.assuredAtMs! > median.forceChargeStartMs! && r.assuredAtMs! < until, 'an interior minute after the start');
  assert.equal(r.assuredClosePct! >= k.linePct - 0.05, true, 'it holds the 86.33% line');
});

test('★★★ G1 a sunny mid-day leg whose reserve leg ends past the allowance (open 40%, P50 PV 3.5 kW, a 1-h window, line 61.5%): its walk is untouched, and the reach counted from the allowance\'s end decides', () => {
  const W0 = Date.UTC(2026, 9, 15, 17);
  const hours = [0, 1].map((i) => ({ ts: W0 + i * H, pvP10W: 3500, pvP50W: 3500, loadP90W: 1200, loadP50W: 1000, evP90W: 0 }));
  const fullKwh = 92.16;
  const args: Parameters<typeof expectedBuyFromPlan>[0] = {
    setpointSocPct: 50, costCeilingSocPct: null, forceChargeEligible: false, forceChargeLine: { askPct: 62, linePct: 61.5 }, lineForceChargeEligible: true,
    noReOn: false, runOn: false, tickPoolKwh: fullKwh, startKwh: 0.4 * fullKwh, deliverableKwh: null, fullKwh, legEff: 0.927,
    window: { hours, fromMs: W0, windowEndMs: W0 + H, dischargeEff: 0.94, chargeCapKw: 20, envelopeKw: 22, acceptKw: null, standbyW: 0 },
  };
  args.deliverableKwh = liftFrom(args, W0);
  const until = W0 + FORCE_CHARGE_OPEN_ALLOWANCE_MS;
  const median = expectedBuyFromPlan(args);
  assert.equal(median.mode, 'line');
  assert.ok(median.forceChargeStartMs != null && median.forceChargeStartMs > until, `the walk starts after the reserve leg, past the allowance (${(median.forceChargeStartMs! - W0) / M} min)`);
  assert.ok(median.rawClosePct! >= 61.5 - 0.05, `the median holds (${median.rawClosePct})`);
  const r = expectedBuyFromPlan({ ...args, assureUntilMs: until });
  assert.equal(r.assuredAtMs, until, 'one walk: the end of the allowance');
  assert.ok(r.assuredClosePct! < 61.5 - 0.05, `the shifted reach does not hold it (${r.assuredClosePct})`);
  // The walk itself is the median's at that minute: only the reach moved.
  const sameWalk = expectedBuyFromPlan({ ...args, onNotBeforeMs: until });
  assert.equal(sameWalk.rawClosePct, median.rawClosePct);
  assert.equal(expectedBuyFromPlan({ ...args, onNotBeforeMs: until, deliverableKwh: liftFrom(args, until) }).rawClosePct, r.assuredClosePct);
});

test('★★ G2 the claim\'s edge is the scorer\'s: an assured close exactly at the line less 0.05 holds, 0.01 under it is disclosed (2027-04-09 21:30 at ×0.944, its ~55.1% assured close)', () => {
  const held = planAt('2027-04-09 21:30', 'm', 5.984);
  const under = planAt('2027-04-09 21:30', 'm', 5.985);
  assert.deepEqual([held.cushionLineSocPct, held.forceChargeLine?.askPct, held.expectedWriteLevelPct], [55.15, 56, 59.5]);
  assert.deepEqual([under.cushionLineSocPct, under.forceChargeLine?.askPct, under.expectedWriteLevelPct], [55.16, 56, 59.5]);
  assert.deepEqual([held.cushionShortfall, held.cushionEnvelopeReason ?? null], [false, null], 'at L − 0.05: held');
  assert.deepEqual([under.cushionShortfall, under.cushionEnvelopeReason], [true, 'lateStart'], '0.01 under: disclosed');
});

test('★ G5 (a residual, stated in docs 15-1) a pool the walk draws down to the written reserve is read at it, not at the point under it the panel holds a pool it charged up to: 2026-10-19 21:30 on nameplate at 13 h (a 49.63% line, the cost force-charge from the open, a predicted EV) is carried', () => {
  const p = planAt('2026-10-19 21:30', 'np', 13);
  assert.deepEqual([p.cushionLineSocPct, p.forceChargeLine?.askPct, p.expectedForceChargeMode, p.expectedWriteLevelPct], [49.63, 51, undefined, 70], 'cost-carried, its stop 70%');
  assert.equal(p.expectedForceChargeStartMs, p.window!.startMs, 'from the open');
  assert.ok((p.evContention?.windowEvKwh ?? 0) > 40, 'a predicted EV draws the pool back after the stop');
  assert.deepEqual([p.cushionShortfall, p.cushionEnvelopeReason ?? null, lineNotHeldOf(p), card.lineNotHeldOfCard(p)], [false, null, null, null], 'carried on a close at the 50% reserve');
});

/** AO-14 — measured on the landed change: the 21:30 plans of the year at 4-20 h on both pools (the live cost gate, eligibility
 *  true) disclosed 'lateStart', by walk mode: 57 (45 line-mode, 12 cost-carried), every one carried on v1.204.0. (review) 4 of them,
 *  line-mode, start past the allowance (2027-02-15 and 2027-07-12, nameplate 18 h and ×0.944 17 h: ~00:58 and ~01:15 on 5- and 6-h
 *  windows): their words name a late start of the window's charge; the other 53 a late switch-on at the window open. */
const PIN_AO14 = { np: { line: 21, cost: 7 }, m: { line: 24, cost: 5 } };
const PIN_AO14_PAST_OPEN = { np: 2, m: 2 };
/** (review) The cost-carried 'lateStart' nights whose 21:30 push and ARMED line name the close past the stop, as the rationale does
 *  (each of the 12 above; before, they named only the ~87% stop): measured on the landed change. */
const PIN_AO14_COST_CLOSE_NAMED = { np: 7, m: 5 };

test('★★★ AO-14 the year at 21:30, 4-20 h, both pools: every \'lateStart\' night is armed with its median close at or above the line less 0.05, said by the server and the card alike, never "under"; counted', () => {
  const count = { np: { line: 0, cost: 0 }, m: { line: 0, cost: 0 } };
  const pastOpen = { np: 0, m: 0 };
  const closeNamed = { np: 0, m: 0 };
  const errs: string[] = [];
  for (const c of CASES.filter((x) => / 21:30$/.test(x.label))) for (const b of ['np', 'm'] as const) for (let h = 4; h <= 20; h++) {
    const p = planAt(c.label, b, h);
    const where = `${c.label} ${b} ${h} h`;
    if (lineNotHeldOf(p) !== card.lineNotHeldOfCard(p)) errs.push(`${where}: server ${lineNotHeldOf(p)}, card ${card.lineNotHeldOfCard(p)}`);
    if (p.cushionEnvelopeReason !== 'lateStart') {
      if (LATE_WORDS.test(p.rationale + pushOf(p) + (card.outageLineRow(p) ?? ''))) errs.push(`${where}: late-start words on a night that is not 'lateStart'`);
      if (p.cushionLateStartAtOpen !== undefined) errs.push(`${where}: cushionLateStartAtOpen on a night that is not 'lateStart'`);
      // (review) Beside any other reason the close past the stop is carried only under the line.
      if (p.expectedCloseAfterStopPct != null && p.expectedCloseAfterStopPct >= p.cushionLineSocPct! - 0.05 - 1e-9) errs.push(`${where}: a held close past the stop carried on a night that is not 'lateStart'`);
      continue;
    }
    // (review) The one predicate every surface words by: the switch-on at the open only where the plan's own start is inside the allowance.
    const atOpen = p.expectedForceChargeStartMs != null && p.expectedForceChargeStartMs <= p.window!.startMs + FORCE_CHARGE_OPEN_ALLOWANCE_MS;
    if ((p.cushionLateStartAtOpen === true) !== atOpen) errs.push(`${where}: cushionLateStartAtOpen ${p.cushionLateStartAtOpen} with its start ${atOpen ? 'inside' : 'past'} the allowance`);
    if (!atOpen) pastOpen[b] += 1;
    const [said, unsaid] = atOpen ? [OPEN, CHARGE] : [CHARGE, OPEN];
    const mode = p.expectedForceChargeMode === 'line' ? 'line' : 'cost';
    count[b][mode] += 1;
    if (p.forceChargeLine == null || p.cushionShortfall !== true || p.cushionShortfallCause !== 'envelope') errs.push(`${where}: not armed and disclosed`);
    const x = /expected to close at ~([\d.]+)%, too close to tonight's/.exec(p.rationale);
    if (x == null || Number(x[1]) < p.cushionLineSocPct! - 0.05 - 1e-9) errs.push(`${where}: the median close ${x?.[1]} under ${p.cushionLineSocPct}`);
    if (mode === 'line' && Number(x?.[1]) !== p.expectedWriteLevelPct) errs.push(`${where}: the rationale's close is not the stated level`);
    // (review) A cost-carried night: the plan carries the close the rationale names, and the push and the ARMED line name it too.
    if (mode === 'cost') {
      if (p.expectedCloseAfterStopPct == null || Number(x?.[1]) !== p.expectedCloseAfterStopPct) errs.push(`${where}: the rationale's close ${x?.[1]} is not the plan's ${p.expectedCloseAfterStopPct}`);
      else if (PUSH_LINE.exec(pushOf(p))?.[1] !== x?.[1]) errs.push(`${where}: the push does not name ~${x?.[1]}%`);
      else if (!lateStartArmTail(p.expectedCloseAfterStopPct, p.cushionLateStartAtOpen).startsWith(` Line NOT assured: ~${x?.[1]}% expected at the close,`)) errs.push(`${where}: the ARMED line does not name ~${x?.[1]}%`);
      else closeNamed[b] += 1;
    }
    for (const [s, t] of [['rationale', p.rationale], ['push', pushOf(p)], ['card', card.outageLineRow(p) ?? '']]) {
      if (UNDER.test(t)) errs.push(`${where}: ${s} says "under"`);
      if ((s !== 'card' || mode === 'line') && !t.includes(`allow for ${said}`)) errs.push(`${where}: ${s} does not say "${said}"`);
      if (t.includes(unsaid)) errs.push(`${where}: ${s} says "${unsaid}"`);
    }
    if (mode === 'line' && !CARD_LINE.test(card.outageLineRow(p) ?? '')) errs.push(`${where}: card row`);
    if (mode === 'cost' && !CARD_COST.test(card.outageLineRow(p) ?? '')) errs.push(`${where}: card row (cost)`);
  }
  assert.deepEqual(errs.slice(0, 10), [], `${errs.length} errors`);
  assert.deepEqual(count, PIN_AO14);
  assert.deepEqual(pastOpen, PIN_AO14_PAST_OPEN);
  assert.deepEqual(closeNamed, PIN_AO14_COST_CLOSE_NAMED);
});

/** AO-15 — a REFUSED arm arms nothing (index.ts: armCycle's refusal, the plan announced unchanged). The 21:30 push's note on a night
 *  whose plan carries a line force-charge (forceChargeLine) is then this one, once — never an armed night's line note
 *  (lineNotHeldOf), which states the close of a charge the refusal does not arm. Measured on the landed change: the year's 21:30
 *  plans at 4-20 h on both pools with a line force-charge, by kind. */
const REFUSED_NOTE = /NOTE: tonight's (?:[\d.]+% )?outage line is above the (?:50% the panel accepts as a reserve|49% the panel holds the pool at under the 50% it accepts as a reserve), and nothing is armed to carry it — residual risk remains\./g;
const PIN_AO15 = { none: 3075, closeUnder: 716, nearFull: 142, aboveFull: 104, lateStart: 57 };
/** What only an armed night's line note says: a close, a margin, a force-charge that runs. */
const ARMED_WORDS = /expected to close|too close to|within 10 points of a full pool|above a full pool|its force-charge runs|cannot hold it with/;

test('★★★ AO-15 a refused arm arms nothing: the 21:30 and mid-day pushes say once that nothing is armed to carry the line, never an armed night\'s note (the ~59.5% close of a 7.2 kWh charge the refusal does not arm), on every kind; the year counted', async () => {
  const WHY = 'the panel reports the grid is not connected';
  const refusedOf = (p: P, mode: 'supervised' | 'auto' = 'supervised') => buildNightChargeMessage(p, 'charge', null, WHY, mode);
  const lead = `Tonight's plan calls for a charge, but the supervised write was not armed — ${WHY}. The add-on will not charge tonight.`;
  const note = (l: string, over = 'the 50% the panel accepts as a reserve'): string => ` NOTE: tonight's ${l}% outage line is above ${over}, and nothing is armed to carry it — residual risk remains.`;
  // The finding: 2027-04-09 21:30 at ×0.944, 7 h — open ~51.8%; the ~59.5% median close is the 7.2 kWh charge's.
  const late = planAt('2027-04-09 21:30', 'm', 7);
  assert.deepEqual([lineNotHeldOf(late), late.expectedStartSocPct, late.expectedWriteLevelPct, late.expectedBuyKwh], ['lateStart', 51.8, 59.5, 7.2]);
  assert.equal(refusedOf(late).title, 'Night-charge: planned charge NOT armed tonight');
  assert.equal(refusedOf(late).body, lead + note('59.4'));
  assert.equal(refusedOf(late, 'auto').body, lead.replace('the supervised write', 'the write') + note('59.4'));
  // The armed push is unchanged: its 'lateStart' note.
  assert.deepEqual(PUSH_LINE.exec(pushOf(late))?.slice(1), ['59.5', OPEN]);
  // The cost-carried 'lateStart' night (2027-02-05 21:30 at ×0.944, 20 h; open ~44.1%), a 'closeUnder' (2027-08-09 21:30 at ×0.944,
  // 13 h), a 'nearFull' and an 'aboveFull' (2026-10-26 21:30 on nameplate, 17 and 20 h), a carried line (2027-08-09 21:30 at ×0.944,
  // 12 h) and a line in (49, 50] (2026-11-27 21:30 at ×0.944, 16 h): the one note, beside the 49% the panel holds for the last.
  for (const [p, kind, l, over] of [
    [planAt('2027-02-05 21:30', 'm', 20), 'lateStart', '58.9'], [planAt('2027-08-09 21:30', 'm', 13), 'closeUnder', '68.9'],
    [planAt('2026-10-26 21:30', 'np', 17), 'nearFull', null], [planAt('2026-10-26 21:30', 'np', 20), 'aboveFull', null],
    [planAt('2027-08-09 21:30', 'm', 12), null, null],
    [planAt('2026-11-27 21:30', 'm', 16), 'lateStart', '49.99', 'the 49% the panel holds the pool at under the 50% it accepts as a reserve'],
  ] as Array<[P, string | null, string | null, string?]>) {
    const where = `${p.window?.startMs} ${kind}`;
    assert.equal(lineNotHeldOf(p), kind, where);
    const b = refusedOf(p).body;
    assert.ok(b.startsWith(lead), `${where}: ${b}`);
    if (l != null) assert.ok(b.endsWith(note(l, over)), `${where}: ${b}`);
    assert.equal(b.match(REFUSED_NOTE)?.length, 1, `${where}: ${b}`);
    assert.doesNotMatch(b, ARMED_WORDS, where);
    assert.doesNotMatch(b, LATE_WORDS, where);
  }
  // A night expected to charge nothing: the reserve-hold shape, the same note.
  const heldShape = refusedOf({ ...late, expectedBuyKwh: 0 } as P);
  assert.equal(heldShape.title, 'Night-charge: planned reserve hold NOT armed tonight');
  assert.ok(heldShape.body.endsWith(`The add-on will not raise the reserve tonight.${note('59.4')}`), heldShape.body);
  // The year: every plan with a line force-charge, refused, in both write modes.
  const count: Record<string, number> = {};
  const errs: string[] = [];
  for (const c of CASES.filter((x) => / 21:30$/.test(x.label))) for (const b of ['np', 'm'] as const) for (let h = 4; h <= 20; h++) {
    const p = planAt(c.label, b, h);
    if (p.forceChargeLine == null) continue;
    const kind = lineNotHeldOf(p) ?? 'none';
    count[kind] = (count[kind] ?? 0) + 1;
    for (const mode of ['supervised', 'auto'] as const) {
      const t = refusedOf(p, mode).body;
      if (t.match(REFUSED_NOTE)?.length !== 1) errs.push(`${c.label} ${b} ${h} h ${mode}: not one refused note: ${t}`);
      if (ARMED_WORDS.test(t) || LATE_WORDS.test(t) || UNDER.test(t)) errs.push(`${c.label} ${b} ${h} h ${mode}: an armed night's note: ${t}`);
    }
  }
  assert.deepEqual(errs.slice(0, 5), [], `${errs.length} errors`);
  assert.deepEqual(count, PIN_AO15);
  // The mid-day push alike: the leg's record across a restore, refused (a prior night's reserve write is unresolved).
  const ms = await import('../src/middayShadow.js');
  const { buildApsREvModel } = await import('../src/tariff.js');
  const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
  const leg = { role: 'cost', kind: 'super_off_peak', startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) };
  const R = "a prior night's reserve write is unresolved";
  const MIDDAY = " NOTE: this leg's outage line is above the 50% the panel accepts as a reserve, and nothing is armed to carry it — residual risk remains.";
  const inputOf = (p: P) => {
    const sum = (ms as unknown as { summariseLeg: (l: unknown, s: unknown, a: unknown) => Record<string, unknown> }).summariseLeg(leg, { plan: p, windowPvP50Kwh: null, windowLoadP50Kwh: null }, { wouldArm: true, disposition: 'would arm' });
    const rec = { version: 1, day: '2026-10-14', computedAtMs: phx(10, 14, 21, 30), why: 'midday', mode: 'supervised', backup: null, cost: sum, refresh: null, note: null };
    return ms.middayShadowAnnounceInput(ms.coerceMiddayShadowRecord(JSON.parse(JSON.stringify(rec)))!, buildApsREvModel())!;
  };
  for (const [p, kind] of [
    [late, 'lateStart'], [planAt('2027-02-15 21:30', 'np', 18), 'lateStart'], [planAt('2027-08-09 21:30', 'm', 13), 'closeUnder'],
    [planAt('2026-10-26 21:30', 'np', 17), 'nearFull'], [planAt('2026-10-26 21:30', 'np', 20), 'aboveFull'], [planAt('2027-08-09 21:30', 'm', 12), undefined],
  ] as Array<[P, string | undefined]>) {
    const i = inputOf(p);
    assert.equal(i.cost.lineNotHeld, kind);
    const m = buildMiddayPlanMessage({ ...i, refused: R });
    assert.equal(m.title, "Charge plan: tomorrow's 10am–3pm charge NOT armed");
    assert.ok(m.body.includes(`The add-on will not charge tomorrow.`) && m.body.endsWith(MIDDAY), `${kind}: ${m.body}`);
    assert.equal(m.body.split('outage line').length - 1, 1, `${kind}: one line note: ${m.body}`);
    assert.doesNotMatch(m.body, ARMED_WORDS, String(kind));
    assert.doesNotMatch(m.body, LATE_WORDS, String(kind));
    // Armed (not refused): the leg's own note, as before.
    if (kind != null) assert.match(buildMiddayPlanMessage(i).body, kind === 'closeUnder' || kind === 'lateStart' ? /expected to close/ : /full pool/, String(kind));
  }
  // A line in (49, 50] (2026-11-27 21:30 at ×0.944, 16 h): beside the 49% the panel holds, as the overnight note names it.
  assert.ok(buildMiddayPlanMessage({ ...inputOf(planAt('2026-11-27 21:30', 'm', 16)), refused: R }).body.endsWith(" NOTE: this leg's outage line is above "
    + 'the 49% the panel holds the pool at under the 50% it accepts as a reserve, and nothing is armed to carry it — residual risk remains.'));
  // …and beside it a backup leg that discloses its own line: its sentence kept, after the leg's.
  const withBackup = buildMiddayPlanMessage({ ...inputOf(late), refused: R, backup: { windowStartMs: phx(10, 14, 23), windowEndMs: phx(10, 15, 5),
    reservePct: 50, expectedKwh: 12.4, buyKwh: 20.1, cushionShortfall: true, cushionShortfallCause: 'envelope' } });
  assert.ok(withBackup.body.endsWith(`${MIDDAY} NOTE: the outage line is above the 50% the panel accepts as a reserve and no force-charge carries it on the backup leg — residual risk remains.`), withBackup.body);
});

test('★★★ AO-16 a refused arm sets no reserve: the card\'s "Worst-case arrival" names no reserve set (or read) beside "The add-on will not charge tonight" — 2026-10-13 21:30 at ×0.944, 5 h ("reserve set to 38%" while the reserve stays at its floor) and on nameplate, 9 h (a line night: "reserve set to 50%"); an armed night keeps it', () => {
  const CARD = readFileSync(resolve(HERE, '../../web/src/cards/NightChargeCard.tsx'), 'utf8');
  // The stat's sub, evaluated as the card evaluates it (its expression is plain JS).
  const from = CARD.indexOf('sub={', CARD.indexOf('label="Worst-case arrival"')) + 'sub={'.length;
  let depth = 1;
  let to = from;
  for (; depth > 0 && to < CARD.length; to++) depth += CARD[to] === '{' ? 1 : CARD[to] === '}' ? -1 : 0;
  const expr = CARD.slice(from, to - 1);
  assert.match(expr, /reserveWriteLabel\(/, expr);
  const subOf = new Function('closedLead', 'refused', 'reserveWriteLabel', 'plan', 'status', 'BINDING_CAP_LABEL', `return (${expr});`) as (
    closedLead: unknown, refused: unknown, rwl: unknown, plan: unknown, status: unknown, labels: unknown) => string | undefined;
  const t = cardText as unknown as {
    refusedArmLead: (r: string, o: unknown) => { headline: string; detail: string }; startClosedLead: (p: unknown) => unknown;
    reserveWriteLabel: unknown; noChargeExpected: (p: unknown) => boolean; writtenReservePct: (p: unknown, m: number | null) => number | null;
  };
  const WHY = 'the panel reports the grid is not connected';
  assert.equal(t.refusedArmLead(WHY, { mode: 'supervised' }).detail, "Tonight's plan calls for a charge, but the supervised write was not armed. The add-on will not charge tonight.");
  const status = { reserveWriteMaxPct: 50 };
  const shown = (p: P, refused: boolean) => subOf(t.startClosedLead(p), refused
    ? t.refusedArmLead(WHY, { mode: 'supervised', held: t.noChargeExpected(p), reservePct: t.writtenReservePct(p, 50) }) : null,
  t.reserveWriteLabel, p, status, {}) ?? '';
  for (const [p, armedLabel, line] of [
    [planAt('2026-10-13 21:30', 'm', 5), 'reserve set to 38%', null],
    [planAt('2026-10-13 21:30', 'np', 9), "reserve set to 50% (the panel's maximum; 51% needed)", 50.42],
  ] as Array<[P, string, number | null]>) {
    assert.deepEqual([p.chargeTonight, t.startClosedLead(p), p.forceChargeLine?.linePct ?? null], [true, null, line]);
    assert.ok(shown(p, false).includes(armedLabel), `armed: ${shown(p, false)}`);
    assert.doesNotMatch(shown(p, true), /reserve/, `refused: ${shown(p, true)}`);
    // The reserve-hold shape ("The add-on will not raise the reserve tonight.") and a reserve that already reads the write: alike.
    assert.doesNotMatch(shown({ ...p, expectedBuyKwh: 0 } as P, true), /reserve/);
    assert.match(shown({ ...p, lineReserveStands: true } as P, false), /reserve reads /);
    assert.doesNotMatch(shown({ ...p, lineReserveStands: true } as P, true), /reserve/);
  }
});
