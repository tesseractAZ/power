#!/usr/bin/env node
/**
 * mutate-core-replay-runtime-grid.mjs — committed harness for v1.181.0: a replayed Core body
 * proves no grid flow (snapshot.ts content-change clock, gridState.ts Core-import gates), and
 * the projected-runtime alert takes its grid rule from the MAIN thread (analytics.ts
 * applyRuntimeGrid, alertMonitor.ts).
 *
 *   node scripts/mutate-core-replay-runtime-grid.mjs
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
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const GRID = resolve(SERVER, 'src/gridState.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const MON = resolve(SERVER, 'src/alertMonitor.ts');

const SUBSET = ['test/coreReplayRuntimeGrid.test.ts', 'test/presenceFreshReadback.test.ts', 'test/gridState.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 the Core gate reads the ARRIVAL clock again (a replayed body counts as grid flow)',
    file: GRID,
    find: '  const t = d.contentChangedAtMs;',
    to: '  const t = d.lastTelemetryAtMs; /* MUTANT */',
    why: 'A cloud replaying a Core\u2019s pre-outage acIn keeps importLive true \u2014 exempt from both floor guards \u2014 and mutes an at-floor outage.',
  },
  {
    id: 'ii. \u2605\u2605\u2605 a fresh panel "no grid" does not zero Core import',
    file: GRID,
    find: '  const importWatts = panelSaysNoGrid ? 0 : computeGridImportWatts(input.devices, nowMs);',
    to: '  const importWatts = computeGridImportWatts(input.devices, nowMs); /* MUTANT */',
    why: 'A replayed or stray Core outvotes the panel\u2019s own fresh "grid not detected".',
  },
  {
    id: 'iii. \u2605\u2605 the content clock moves on every arrival (no witness comparison)',
    file: SNAP,
    find: '    if (prev != null && prev !== w) cur.contentChangedAtMs = nowMs;',
    to: '    cur.contentChangedAtMs = nowMs; /* MUTANT */',
    why: 'The content-change clock degenerates to the arrival clock: replay-blind again.',
  },
  {
    id: 'iii-b. \u2605 first sight after a restart counts as a change',
    file: SNAP,
    find: '    if (prev != null && prev !== w) cur.contentChangedAtMs = nowMs;',
    to: '    if (prev !== w) cur.contentChangedAtMs = nowMs; /* MUTANT */',
    why: 'The first replayed Core body after a restart counts as fresh grid flow for up to 5 minutes.',
  },
  {
    id: 'iv. \u2605\u2605 the /device/list rebuild drops the content clock (the sticky-clock trap)',
    file: SNAP,
    find: '        contentChangedAtMs: existing?.contentChangedAtMs, // v1.181.0 — same trap, same carry',
    to: '        /* MUTANT */',
    why: 'Every 60 s rebuild erases it and every Core reads stale between content changes.',
  },
  {
    id: 'v. \u2605\u2605 applyRuntimeGrid applies nothing',
    file: AN,
    find: '  if (!gridBackstopping) return alerts;',
    to: '  return alerts; /* MUTANT */',
    why: 'With the grid up, the runtime alert stays a warning: a nuisance projection to a floor the grid will catch.',
  },
  {
    id: 'vi. \u2605\u2605 the alert monitor passes the worker\u2019s alerts through raw',
    file: MON,
    find: '      ...applyRuntimeGrid(forecastAlerts, grid.backstopping === true),',
    to: '      ...forecastAlerts, /* MUTANT */',
    why: 'The grid rule exists, is tested, and the running monitor never applies it.',
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
console.log(`mutate-core-replay-runtime-grid: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
