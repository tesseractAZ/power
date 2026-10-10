#!/usr/bin/env node
/**
 * mutate-charge-curve-bucket.mjs — committed harness for the v1.171.0 bucketed pack scan
 * (server/src/analytics.ts computeChargeCurveFingerprint).
 *
 * WHY COMMITTED: the bucket is one optional argument. Dropping it is invisible in every
 * report the scan produces — it only shows up as the single analytics worker stalling
 * 16-20 s every hour, which doubles alarm latency (log audit 2026-09-20).
 *
 *   node scripts/mutate-charge-curve-bucket.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block and on
 *   SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const AN = resolve(SERVER, 'src/analytics.ts');

const SUBSET = ['test/chargeCurveBucket.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 the pack scan reads raw samples again',
    file: AN,
    // v1.186.0 — the scan moved into readChargeCurveRows (week-long slices); same mutant.
    find: '    const slice = recorder.queryMulti(sn, metrics, lo, hi, CHARGE_CURVE_BUCKET_SEC);',
    to: '    const slice = recorder.queryMulti(sn, metrics, lo, hi); /* MUTANT */',
    why: 'The single analytics worker is pinned 16-20 s every hour; an alert tick landing inside waits it out and the next is dropped \u2014 alarm latency doubles to ~40 s.',
  },
  {
    id: 'ii. \u2605\u2605 the bucket is widened past the checkpoint tolerance',
    file: AN,
    find: 'const CHARGE_CURVE_BUCKET_SEC = 60;',
    to: 'const CHARGE_CURVE_BUCKET_SEC = 3600; /* MUTANT */',
    why: 'An hour-wide average smears SoC across checkpoints (\u00b11.5%) and lifts resting voltage into the >100 W charge gate.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-charge-curve-bucket', mutants: MUTANTS, subset: SUBSET, root: REPO });
