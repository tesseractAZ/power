#!/usr/bin/env node
/**
 * mutate-v1187-14.mjs — v1.187.14: the warning-level cell spread's push quiets from the plateau.
 *
 *   Q-i  the warning push quiets only at the top of charge (95%) again
 *
 *   node scripts/mutate-v1187-14.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AL = resolve(REPO, 'server/src/alerts.ts');
const SUBSET = ['test/alertVdiffBalancing.test.ts'];

const MUTANTS = [
  {
    id: 'Q-i. ★★ the warning push quiets only at the top of charge again',
    file: AL,
    find: '        const plateauQuietWarn = plateauQuietWarnSpread(packSoc, pk.maxVolDiffMv);',
    to: '        const plateauQuietWarn = topOfChargeQuietSpread(packSoc, pk.maxVolDiffMv); /* MUTANT */',
    why: 'A charge toward full pushes a warn-band spread for every pack crossing 85-95% (nine pushes in 30 min on 10-10).',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-14', mutants: MUTANTS, subset: SUBSET, root: REPO });
