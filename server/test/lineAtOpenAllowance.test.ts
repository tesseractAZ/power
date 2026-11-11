import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNightChargePlan, buildNightChargeInputs, expectedBuyFromPlan } from '../src/nightChargeAdvisor.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';

/**
 * v1.205.0 — A LINE NIGHT'S CLAIM.
 *
 * (AO-5a) H1 on the cost-carried walk: a line night the COST force-charge carries (its stop ⌈L⌉ + 10 or more) closes where its
 * walk past the stop ends (expectedBuyFromPlan closePct, v1.202.0) — never above what the window can reach, as a bound line
 * walk's close is (expectedLineBuy, H1): the one reach expression, lineWindowReachKwh.
 *
 * fixtures/lineAtOpenAllowance.args.json holds expectedBuyFromPlan's arguments as sizeNightChargePlan passed them, captured once
 * (an instrumented copy of the planner, the year fixture's deps, the live cost gate, eligibility true).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = JSON.parse(readFileSync(resolve(HERE, 'fixtures/lineAtOpenAllowance.args.json'), 'utf8')) as Record<string, {
  label: string; basis: 'np' | 'm'; hours: number; linePct: number; windowStartMs: number; args: Parameters<typeof expectedBuyFromPlan>[0];
}>;
const CASES = legacyIdentityCases();
const live = (d: Record<string, unknown>) => ({ ...d, forceChargeEligible: d.objectiveMode === 'cost' && ((d.costMaxSocPct as number | undefined) ?? 90) > 50 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const planAt = (label: string, b: 'np' | 'm', h: number, extra: Record<string, unknown> = {}, served: Record<string, unknown> = {}): any => computeNightChargePlan({
  ...buildNightChargeInputs({
    ...live(CASES.find((c) => c.label === label)!.deps as unknown as Record<string, unknown>), outageCushionHours: h,
    ...(b === 'm' ? { cushionPoolScale: MEASURED_SCALE } : {}), lineForceChargeEligible: true, ...extra,
  } as never)!,
  ...served,
} as never);

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
  // Under the reserve the stated close is floored at it (the level convention of every bound night); the claim's is not.
  const low = expectedBuyFromPlan({ ...k.args, deliverableKwh: 0 });
  const lowReach = Math.round((k.args.startKwh! / k.args.fullKwh) * 1000) / 10;
  assert.equal(low.rawClosePct, lowReach);
  assert.ok(lowReach < 50 && low.closePct === 50, `${low.closePct} / ${low.rawClosePct}`);
});
