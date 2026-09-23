#!/usr/bin/env node
/**
 * mutate-grid-reading-persist.mjs — committed harness for v1.180.0: the SHP2's last NOT-OK grid
 * reading survives a restart (server/src/snapshot.ts grid-reading.json), and the declared-grid
 * veto (server/src/gridState.ts) finds an unprojected panel by identity to read it.
 *
 * WHY COMMITTED: the failure is silent and in the missed-alarm direction. An outage with the
 * grid toggle ON, a panel gone cloud-dark and an add-on restart brought "grid present" back —
 * runway audible gated, off_grid OFF, SoC crossings spoken as "drawing from grid power" — for as
 * long as the panel stayed dark. Nothing errors.
 *
 *   node scripts/mutate-grid-reading-persist.mjs
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

const SUBSET = ['test/gridReadingPersist.test.ts', 'test/gridMeasuredAbsentVeto.test.ts', 'test/presenceFreshReadback.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 the persisted reading is not rehydrated on first sight',
    file: SNAP,
    find: '        ...(existing == null && this.persistedGridReadings.has(d.sn)',
    to: '        ...(false && existing == null && this.persistedGridReadings.has(d.sn) /* MUTANT */',
    why: 'A restart with the panel dark brings "grid present" back mid-outage: the runway audible is gated again.',
  },
  {
    id: 'ii. \u2605\u2605\u2605 the veto only looks at a PROJECTED panel',
    file: GRID,
    find: '  const vetoPanel = panel ?? identityShp2(input.devices);',
    to: '  const vetoPanel = panel; /* MUTANT */',
    why: 'The rehydrated reading sits on a panel with no projection; the veto never sees it.',
  },
  {
    id: 'iii. \u2605\u2605 a Grid OK reading does not delete the persisted entry',
    file: SNAP,
    find: '    else if (!this.persistedGridReadings.delete(sn)) return; // Grid OK and nothing persisted: no write',
    to: '    else return; /* MUTANT */',
    why: 'After the grid returns, the next restart with the panel dark resurrects "no grid": a stale alarm on a healthy grid.',
  },
  {
    id: 'iv. \u2605 a persisted Grid OK is rehydrated',
    file: SNAP,
    find: '        if (v && v.connected === false && typeof v.atMs === \'number\' && Number.isFinite(v.atMs)) {',
    to: '        if (v && typeof v.connected === \'boolean\' && typeof v.atMs === \'number\' && Number.isFinite(v.atMs)) { /* MUTANT */',
    why: 'Only a not-OK reading has any business surviving a restart; a stale "1" must never come back.',
  },
  {
    id: 'v. \u2605 the file is rewritten on every poll, not on change',
    file: SNAP,
    find: '      if (prev?.connected !== cur.lastGridReading.connected || prev?.sta !== cur.lastGridReading.sta) {',
    to: '      if (true) { /* MUTANT */',
    why: 'A write every 60 s on the Pi\u2019s storage for nothing.',
  },
  {
    id: 'vi. \u2605\u2605 persistence defaults ON outside the add-on (a shared file across test processes)',
    file: SNAP,
    find: "      ?? (process.env.SUPERVISOR_TOKEN ? resolve(process.cwd(), config.dbPath, '..', 'grid-reading.json') : '');",
    to: "      ?? resolve(process.cwd(), config.dbPath, '..', 'grid-reading.json'); /* MUTANT */",
    why: 'One test process\u2019s reading rehydrates into another\u2019s store: order-dependent vetoes in unrelated tests.',
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
console.log(`mutate-grid-reading-persist: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
