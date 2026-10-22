#!/usr/bin/env node
/**
 * mutate-rate-table.mjs — committed mutation harness for v1.136.0's single rate table.
 *
 * WHY COMMITTED: the defect it replaces cost $47.91/month and nothing failed.
 * `resolveTariffCents` returns TWO tiers; APS R-EV has four, so every overnight
 * kWh was priced at the off-peak rate — 16.91 c instead of 12.59 c — in Grid Cost
 * Today and everything downstream. A pricing error produces a plausible number,
 * not an exception, so only a test that pins each period to its own rate can hold
 * this.
 *
 *   node scripts/mutate-rate-table.mjs
 *
 * ★ Anchor-asserted: aborts rather than reporting green against an unmutated tree.
 * ★ Mutates in place, restoring in a finally block.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const A = resolve(SERVER, 'src/analytics.ts');
const SUBSET = ['test/rateTableUnify.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ the two-tier ladder comes back (the shipped defect)',
    file: A,
    // v1.191.0 — re-pointed: the model of the plan in effect (tariffModelFromEnv; the APS preset while TARIFF_PLAN is unset).
    find: '  const slice = rateAt(tariffModelFromEnv(), tsMs);\n  if (slice.centsPerKwh != null) return slice.centsPerKwh;\n  return onPeakAt(tsMs) ? fallback.onPeak : fallback.offPeak;',
    to: '  return onPeakAt(tsMs) ? fallback.onPeak : fallback.offPeak; /* MUTANT */',
    why: 'Every overnight kWh returns to the off-peak rate — $47.91/month over-stated, and nothing throws.',
  },
  {
    id: 'ii. ★ the null guard is dropped — an unconfirmed install prices at $0',
    file: A,
    find: '  if (slice.centsPerKwh != null) return slice.centsPerKwh;\n  return onPeakAt(tsMs) ? fallback.onPeak : fallback.offPeak;',
    to: '  return slice.centsPerKwh as number; /* MUTANT */',
    why: 'rateAt returns null when rates are unconfirmed and null/100 === 0 in JS, so every kWh silently costs nothing.',
  },
  {
    id: 'iii. the discharge gate goes back to the 15-20 window',
    file: A,
    find: '  return slice.ratesConfirmed ? slice.isOnPeak : onPeakAt(tsMs);',
    to: '  return onPeakAt(tsMs); /* MUTANT */',
    why: 'The plan discharges across five hours where R-EV rewards three, spending cycle life for no arbitrage.',
  },
  {
    id: 'iv. the gate stops honouring the confirmed table',
    file: A,
    find: '  return slice.ratesConfirmed ? slice.isOnPeak : onPeakAt(tsMs);\n}',
    to: '  return slice.isOnPeak;\n} /* MUTANT */',
    why: 'On an unconfirmed tariff isOnPeak is meaningless, so the gate would follow a table that has no rates.',
  },
  // ★★ KNOWN SURVIVOR — DECLARED, NOT HIDDEN.
  //
  // Mutant v below survives. `computeTariffReport`'s tally integrates over the
  // trailing `windowDays` only, so a fixture hour far enough in the past to have
  // a KNOWN tariff period contributes no energy, and with zero energy both the
  // two-tier and full-table paths return 0 — the mutant is invisible. Making the
  // hour recent enough to be integrated makes its tariff period depend on the day
  // the suite happens to run, and the fixture also needs SHP2 membership for
  // `homeDpus` to be non-empty.
  //
  // The DISPATCH call site (mutant vi) IS pinned, and both pure helpers are pinned
  // exhaustively. What is unprotected is specifically the one line in the KPI
  // tally — which is the number the operator reads, so this is worth closing:
  // build a recorder stub whose series lands inside the window with an injected
  // clock. Left declared rather than deleted, because a harness that quietly drops
  // the mutant it cannot kill reports a better score than it has earned.
  {
    id: 'v. the KPI tally stops using the shared resolver [KNOWN SURVIVOR — see note above]',
    file: A,
    find: '      const rate = hourlyRateCents(t, tariffCents) / 100;',
    to: '      const rate = (onPeakAt(t) ? tariffCents.onPeak : tariffCents.offPeak) / 100; /* MUTANT */',
    why: 'Grid Cost Today drifts from the dispatch planner again — the split-brain v1.52.0 set out to remove.',
  },
  {
    id: 'vi. the dispatch planner prices off a different table than the KPIs',
    file: A,
    // v1.187.10 — re-pointed: the hour's rate is resolved once per horizon (the top-off rule
    // needs every hour's), and the loop prices from it.
    find: '    const rate = tou[i].rateCents / 100;',
    to: '    const rate = (onPeak ? dispatchCents.onPeak : dispatchCents.offPeak) / 100; /* MUTANT */',
    why: "The planner's own comment says it must not price its plan off a different table than the KPIs.",
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-rate-table', mutants: MUTANTS, subset: SUBSET, root: REPO, knownSurvivor: (m) => /KNOWN SURVIVOR/.test(m.id) });
