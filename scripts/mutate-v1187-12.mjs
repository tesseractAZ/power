#!/usr/bin/env node
/**
 * mutate-v1187-12.mjs — v1.187.12: the force-charge ON readback grace and the push-only
 * warning-level cell spread.
 *
 *   F-i  the ON readback grace back to 6 min (a lagging slot re-issued at +7 and given up at +14)
 *   V-i  a warning-level cell spread voiced again (audible:false dropped)
 *
 *   node scripts/mutate-v1187-12.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const FC = resolve(SERVER, 'src/nightForceCharge.ts');
const AL = resolve(SERVER, 'src/alerts.ts');

const SUBSET = [
  'test/forceChargeOn.test.ts',
  'test/alertVdiffBalancing.test.ts',
];

const MUTANTS = [
  {
    id: 'F-i. ★★ the ON readback grace back to 6 min',
    file: FC,
    find: 'export const FORCE_CHARGE_ON_VERIFY_AFTER_MS = 15 * 60_000;',
    to: 'export const FORCE_CHARGE_ON_VERIFY_AFTER_MS = 6 * 60_000; /* MUTANT */',
    why: 'A slot whose ON reads back late is re-issued at +7 min and given up at +14 min while it is charging: the night reports a forfeited buy that did not happen.',
  },
  {
    id: 'V-i. ★★ a warning-level cell spread is voiced again',
    file: AL,
    find: "id: `vdiff-warn-${d.sn}-${pk.num}`, severity: 'warning', audible: false, category: 'Battery',",
    to: "id: `vdiff-warn-${d.sn}-${pk.num}`, severity: 'warning', /* MUTANT */ category: 'Battery',",
    why: 'The morning warning spread on the same two packs raises a spoken yellow and an all-clear for 40 min to 2 h every few days.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-12', mutants: MUTANTS, subset: SUBSET, root: REPO });
