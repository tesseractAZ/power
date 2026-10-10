#!/usr/bin/env node
/**
 * mutate-insights-empty.mjs — committed mutation harness for v1.147.0's
 * explanatory empty states in AdvancedInsightsCard.
 *
 * WHY COMMITTED: the regression is a DELETION that produces no error. Remove the
 * empty-state block and the section silently returns to vanishing, which is
 * precisely the state v1.131.1 rejected in this same file — a detector that
 * cannot produce a value looking identical to one that was never enabled, on the
 * screen a human reads. Nothing throws, nothing logs, and the panel looks tidier.
 *
 *   node scripts/mutate-insights-empty.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ A harness run is only evidence if the BASELINE was green — confirm `0 fail`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const CARD = resolve(REPO, 'web/src/cards/AdvancedInsightsCard.tsx');

const SUBSET = ['test/insightsEmptyStates.test.ts'];

const MUTANTS = [
  {
    id: "i. ★★★ 'charge-curve' goes back to vanishing",
    file: CARD,
    find: "      {show('charge-curve') && charge && (",
    to: "      {show('charge-curve') && charge && charge.packs.some((p) => p.meanDriftMv != null) && ( /* MUTANT */",
    why: 'A detector with no charge sessions yet looks exactly like one that was never enabled — the pattern v1.131.1 rejected three sections up in this same file.',
  },
  {
    id: "ii. ★★★ 'internal-resistance' goes back to vanishing",
    file: CARD,
    find: "      {show('internal-resistance') && ir && (",
    to: "      {show('internal-resistance') && ir && ir.devices.some((d) => d.recentMilliohms != null) && ( /* MUTANT */",
    why: "Worse than a spinner: `insufficient-cadence` is documented server-side as the HONEST TERMINAL state added so the UI would stop spinning — and the UI hid the section instead.",
  },
  {
    id: "iii. ★★★ 'ambient-thermal' goes back to vanishing",
    file: CARD,
    find: "      {show('ambient-thermal') && ambient && (",
    to: "      {show('ambient-thermal') && ambient && ambient.packs.some((p) => p.predictedPeak24hC != null) && ( /* MUTANT */",
    why: 'The third of the three. An un-converged fit is indistinguishable from a disabled panel.',
  },
  {
    id: "iv. ★ the terminal status collapses into 'learning'",
    file: CARD,
    find: "              {ir.devices.some((d) => d.status === 'insufficient-cadence')",
    to: "              {false && ir.devices.some((d) => d.status === 'insufficient-cadence') /* MUTANT */",
    why: 'A measurement that CANNOT complete at the current poll cadence would read as one still accumulating — a perpetual "nearly there" for something that never arrives.',
  },
  {
    id: 'v. the empty state is painted as healthy rather than neutral',
    file: CARD,
    find: '            <div className="text-xs text-muted">\n              {charge.packs.length === 0',
    to: '            <div className="text-xs text-ok">\n              {charge.packs.length === 0 /* MUTANT */',
    why: 'An absence rendered in the healthy colour is the render-surface defect this project has already fixed five times.',
  },
  {
    id: 'vi. the populated rows stop filtering to items that HAVE a value',
    file: CARD,
    find: '            {ambient.packs.filter((p) => p.predictedPeak24hC != null).slice(0, 10).map((p) => {',
    to: '            {ambient.packs.slice(0, 10).map((p) => { /* MUTANT */',
    why: 'The fix must not change what a HEALTHY section shows — packs with no forecast would render as blank rows, re-creating the original defect inside the populated case.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-insights-empty', mutants: MUTANTS, subset: SUBSET, root: REPO });
