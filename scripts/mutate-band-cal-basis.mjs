#!/usr/bin/env node
/**
 * mutate-band-cal-basis.mjs — committed mutation harness for v1.149.0's
 * `bandSigmaCalBasis`.
 *
 * WHY COMMITTED: the defect this guards against is a NUMBER THAT READS THE SAME
 * IN FIVE DIFFERENT STATES. `bandSigmaCal = 1` is published when the calibration
 * is active and SATURATED (it has found the band too narrow and `Math.min(1, …)`
 * forbids widening), when it never ENGAGED for want of scored days — the actual
 * v1.23.0 defect, which sat pinned at exactly 1 in production — when the ratio
 * lands on 1, and, before this release, whenever there was no probabilistic
 * forecast at all and the ledger wrote `?? 1`.
 *
 * The 2026-09-06 PERFORMANCE.md snapshot inspected this field, read 0.50, and
 * asserted "still above its 0.4 floor — data-driven, not floor-pinned." It
 * checked the FLOOR ambiguity and never considered the ceiling. Five days later
 * the field read 1 with realized error at 0.657 and the night-charge advisor had
 * stopped planning entirely. Nothing failed. There was nothing to disagree with.
 *
 * A collapse back into that state is invisible by construction, so it is proven
 * here rather than trusted.
 *
 *   node scripts/mutate-band-cal-basis.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ Mutates the working tree in place, restoring in a finally block. Do not run
 *   git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const ANALYTICS = resolve(SERVER, 'src/analytics.ts');
const INDEX = resolve(SERVER, 'src/index.ts');

const SUBSET = ['test/bandCalIntegrity.test.ts', 'test/bandCalWindow.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ saturated collapses into uncalibrated (the v1.23.0 signature)',
    file: ANALYTICS,
    find: "    bandCalBasis = ratio >= 1 ? 'saturated' : ratio <= PV_BAND_CAL_FLOOR ? 'floor-pinned' : 'shrunk';",
    to: "    bandCalBasis = ratio <= PV_BAND_CAL_FLOOR ? 'floor-pinned' : 'shrunk'; /* MUTANT */",
    why: 'A band that is too NARROW would report the same basis as one whose calibration never ran — the exact confusion the field exists to end.',
  },
  {
    id: 'ii. ★ the basis is hard-wired to the benign value',
    file: ANALYTICS,
    find: "  let bandCalBasis: PvBandCalBasis = 'uncalibrated';",
    to: "  let bandCalBasis: PvBandCalBasis = 'shrunk'; /* MUTANT */",
    why: 'Every reading would claim an actively-narrowing calibration, including the no-skill-report case where none ran at all.',
  },
  {
    id: 'iii. the saturation boundary moves off 1',
    file: ANALYTICS,
    find: "    bandCalBasis = ratio >= 1 ? 'saturated'",
    to: "    bandCalBasis = ratio >= 1.5 ? 'saturated'", // eslint-disable-line -- MUTANT
    why: 'A ratio of 1.0-1.5 is already clamped and already under-covering, but would be reported as a healthy shrink.',
  },
  {
    id: 'iv. the floor clamp stops being distinguished from a data-driven shrink',
    file: ANALYTICS,
    find: "ratio <= PV_BAND_CAL_FLOOR ? 'floor-pinned' : 'shrunk';",
    to: "'shrunk'; /* MUTANT */",
    why: 'A floor-pinned band would read as data-driven — the ambiguity the 2026-09-06 snapshot DID check for, so it must stay checked.',
  },
  {
    id: 'v. ★ an operator override is reported as a measurement',
    file: ANALYTICS,
    find: "    bandCalBasis = 'operator-override';",
    to: "    bandCalBasis = 'shrunk'; /* MUTANT */",
    why: 'A hand-set PV_BAND_SIGMA_CAL would be read back as evidence about the forecast, which is how a config value becomes a false measurement.',
  },
  {
    id: 'vi. the basis is computed but never published',
    file: ANALYTICS,
    find: '    bandSigmaCalBasis: bandCalBasis,',
    to: '    /* MUTANT */',
    why: 'The whole v1.145.0 lesson: a field computed correctly and then not emitted is indistinguishable from one that was never written.',
  },
  {
    id: 'vii. ★ the ledger goes back to fabricating a neutral 1',
    file: INDEX,
    find: '    bandSigmaCal: prob?.bandSigmaCal ?? null,',
    to: '    bandSigmaCal: prob?.bandSigmaCal ?? 1, /* MUTANT */',
    why: 'A night with no probabilistic forecast would be filed in a durable ledger column as "calibration neutral", unrecoverable after the fact.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-band-cal-basis', mutants: MUTANTS, subset: SUBSET, root: REPO });
