#!/usr/bin/env node
/**
 * mutate-line-at-open.mjs — committed harness for v1.205.0, the line night's claim (nightChargeAdvisor.ts expectedBuyFromPlan,
 * expectedLineBuy, lineWindowReachKwh).
 *
 * (C) H1 ON THE COST-CARRIED WALK: a line night the cost force-charge carries closes where its walk past the stop ends, never
 * above what the window can reach (the one reach expression a bound line walk's close is capped at); the stated close floored at
 * the reserve, the claim's close (rawClosePct) not. AOA-7, AOA-7b.
 *
 *   node scripts/mutate-line-at-open.mjs [--only <id prefix>]
 *
 * ★ Every id starts AOA- (no other harness uses it). Anchor-asserted (each anchor matches exactly once); every mutant must
 *   TYPECHECK (one that does not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it. Run with MUTATE_CONCURRENCY=2 beside other lanes, on a GREEN tree.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');

const T_AO = 'test/lineAtOpenAllowance.test.ts';
const T_MPW = 'test/measuredPlannerWalks.test.ts';
const T_YEAR = 'test/lineForceChargeYear.test.ts';

const MUTANTS = [
  /* ── C: H1 on the cost-carried walk ── */
  {
    id: 'AOA-7. ★★★ no cost-carried reach cap (the walk past the stop stated whatever the window can deliver)',
    file: NCA, tests: [T_AO, T_MPW, T_YEAR],
    find: '  if (out.deliverableBound === true && out.rawClosePct != null) {\n    const reachPct = (lineWindowReachKwh(o, deliverableKwh) / o.fullKwh) * 100;',
    to: '  if ((false as boolean) && out.rawClosePct != null) { /* MUTANT */\n    const reachPct = (lineWindowReachKwh(o, deliverableKwh) / o.fullKwh) * 100;',
    why: '2027-02-05 21:30 at ×0.944, 20 h: ~65.8% stated past the stop from a pool the window can take to ~59.9%.',
  },
  {
    id: 'AOA-7b. ★★ the cap on the stated close only, not on the close the claim reads',
    file: NCA, tests: [T_AO],
    find: '      out.rawClosePct = round1(Math.min(100, reachPct));\n',
    to: '      /* MUTANT */\n',
    why: 'The claim reads a close the window cannot reach: a cost-carried night out of reach is judged on its uncapped walk.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-line-at-open', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
