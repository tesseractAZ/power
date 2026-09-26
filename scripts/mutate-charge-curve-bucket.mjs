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

/** true = the tests passed; false = they ran and failed. Throws if they could not run. */
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (typeof e?.status === 'number' && e?.signal == null) return false;
    throw e;
  }
}
const subsetPasses = () => passes('node', ['--import', 'tsx', '--test', ...SUBSET]);
const fullPasses = () => passes('npm', ['test', '--silent']);

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
const restoreAll = () => { for (const [f, s] of originals) writeFileSync(f, s); };

for (const [f, s] of originals) {
  if (s.includes('/* MUTANT')) {
    console.error(`\nABORT: ${f} already contains a mutant marker — restore it first.`);
    process.exit(2);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); console.error(`\ninterrupted (${sig}) — tree restored`); process.exit(130); });
}
for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    process.exit(2);
  }
}
if (!subsetPasses()) {
  console.error('\nABORT: the subset fails on the UNMUTATED tree. Fix the baseline first.');
  process.exit(2);
}

let fullBaselineChecked = false;
let killed = 0;
const survivors = [];
console.log(`mutate-charge-curve-bucket: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const mutated = original.replace(m.find, m.to);
    writeFileSync(m.file, mutated);
    let died = !subsetPasses();
    if (!died) {
      if (!fullBaselineChecked) {
        writeFileSync(m.file, original);
        const ok = fullPasses();
        writeFileSync(m.file, mutated);
        fullBaselineChecked = true;
        if (!ok) {
          console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot count a kill.');
          restoreAll();
          process.exit(2);
        }
      }
      died = !fullPasses();
    }
    writeFileSync(m.file, original);
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  }
} finally {
  restoreAll();
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
