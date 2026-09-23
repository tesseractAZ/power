#!/usr/bin/env node
/**
 * mutate-three-small-gaps.mjs — committed harness for v1.184.0: the operator clear for a stuck
 * "no grid" (honoured, offered only when stale, carried, persisted readings forgotten), the
 * starved-feed anomaly guard on the main thread (idle-held exempt), and a client hang-up demoted.
 *
 *   node scripts/mutate-three-small-gaps.mjs
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
const GRID = resolve(SERVER, 'src/gridState.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const MON = resolve(SERVER, 'src/alertMonitor.ts');
const HOOKS = resolve(SERVER, 'src/logHooks.ts');

const SUBSET = ['test/threeSmallGaps.test.ts', 'test/gridMeasuredAbsentVeto.test.ts', 'test/gridReadingPersist.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605 the operator clear is ignored',
    file: GRID,
    find: '  const readingCleared = clearedAtMs != null && (readingAtMs == null || readingAtMs <= clearedAtMs);',
    to: '  const readingCleared = false; /* MUTANT */',
    why: 'The owner knows the grid is back and the button does nothing: "no grid" stays until the panel reports.',
  },
  {
    id: 'ii. \u2605\u2605\u2605 the clear outlives the panel\u2019s NEXT reading',
    file: GRID,
    find: '  const readingCleared = clearedAtMs != null && (readingAtMs == null || readingAtMs <= clearedAtMs);',
    to: '  const readingCleared = clearedAtMs != null; /* MUTANT */',
    why: 'One click silences the veto for good: a later real outage with the toggle ON reads "grid present".',
  },
  {
    id: 'iii. \u2605\u2605\u2605 a panel freshly reporting no grid is clearable',
    file: GRID,
    find: '  const vetoClearable = declaredRaw && gridMeasuredAbsent && panelFresh !== true;',
    to: '  const vetoClearable = declaredRaw && gridMeasuredAbsent; /* MUTANT */',
    why: 'The button is offered against the live measurement of an outage.',
  },
  {
    id: 'iv. \u2605\u2605 the /device/list rebuild drops the clear (the sticky-clock trap)',
    file: SNAP,
    find: '        gridVetoClearedAtMs: existing?.gridVetoClearedAtMs, // v1.184.0 — same trap, same carry',
    to: '        /* MUTANT */',
    why: 'The clear lasts at most 60 s.',
  },
  {
    id: 'v. \u2605 the clear keeps the persisted reading (it returns at the next restart)',
    file: SNAP,
    find: '      this.persistedGridReadings.clear();',
    to: '      /* MUTANT */',
    why: 'After a restart with the panel still dark, the cleared "no grid" is restored from disk.',
  },
  {
    id: 'vi. \u2605\u2605 the starved-feed guard exempts nobody (idle-held Cores blinded all night)',
    file: AN,
    find: '  const starved = new Set(collapsedSns.filter((sn) => !idleHeldSns.has(sn)));',
    to: '  const starved = new Set(collapsedSns); /* MUTANT */',
    why: 'A Core held idle with a healthy session loses anomaly detection for the whole idle night.',
  },
  {
    id: 'vii. \u2605\u2605 the starved-feed guard never runs (the v1.79.0 fault it replaces)',
    file: MON,
    find: '      ...applyStarvedFeedFilter(baselineAlerts, getRateFloorCollapses().map((c) => c.sn), rateFloorIdleHeldSns()),',
    to: '      ...baselineAlerts, /* MUTANT */',
    why: 'Anomalies fire off minutes-old spot values from a starved feed (2026-08-16 07:01).',
  },
  {
    id: 'viii. \u2605 a client hang-up is logged as a server error again',
    file: HOOKS,
    find: '  if (level >= 50 && isClientHangup(args)) {',
    to: '  if (false) { /* MUTANT */',
    why: 'Error-level noise buries the real errors in the log ring.',
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
console.log(`mutate-three-small-gaps: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
