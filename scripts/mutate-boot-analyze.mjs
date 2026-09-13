#!/usr/bin/env node
/**
 * mutate-boot-analyze.mjs — committed mutation harness for v1.156.0: planner statistics
 * at boot.
 *
 * v1.153.0 bounded the boot `ANALYZE samples` with `PRAGMA analysis_limit=400` and cited
 * "3,415 ms on the next boot". That was a restart 13 min after another. The next boot
 * after an image pull spent 10,785 ms in the bounded ANALYZE — more than the unbounded
 * 9,725 ms — because ANALYZE takes an exact count of each index before the bounded scan,
 * and the count reads every page. For all of it the add-on had no HTTP listener, no MQTT
 * ingest, no poll and no alarm evaluation. The bound also truncated the statistics.
 *
 * The boot now runs only the ANALYZE that `PRAGMA optimize=0x03` lists (a table with an
 * index that has NO statistics), and logs what ran. Each mutant below restores one part
 * of the old cost, or breaks one of the guards on the new path: the stale-stats skip,
 * the full (unbounded) refresh, the failure handling, and a log line that cannot claim
 * work that did not happen.
 *
 *   node scripts/mutate-boot-analyze.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ Every mutant must TYPECHECK. One that does not compile proves nothing about the
 *   tests, so it aborts the run instead of counting as killed.
 * ★ A red baseline kills every mutant for free, so the subset must pass unmutated first.
 * ★ Mutates the working tree in place, restoring in a finally block. Do not run
 *   git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const RECORDER = resolve(SERVER, 'src/recorder.ts');

const SUBSET = [
  'test/bootPlannerStats.test.ts',
  'test/darkCoreCoverage.test.ts',
  'test/seedAndBootPhases.test.ts',
];

const MUTANTS = [
  {
    id: 'i. ★★ an unconditional ANALYZE returns to the boot path (the shipped 10.8 s)',
    file: RECORDER,
    find: '    for (const row of db.prepare(`PRAGMA optimize=0x03`).all() as Array<Record<string, unknown>>) {',
    to: '    db.exec(`ANALYZE samples;`); /* MUTANT */ for (const row of db.prepare(`PRAGMA optimize=0x03`).all() as Array<Record<string, unknown>>) {',
    why: 'THE DEFECT: every boot reads every samples index page — 10,785 ms on the live Pi — with no listener, ingest, poll or alarm evaluation.',
  },
  {
    id: 'ii. ★★ the 10x size check is switched on (mask 0x10000)',
    file: RECORDER,
    find: 'db.prepare(`PRAGMA optimize=0x03`)',
    to: 'db.prepare(`PRAGMA optimize=0x10003`) /* MUTANT */',
    why: 'Stale statistics are refreshed at boot: near 160 M rows that is a full ANALYZE of ten times today\'s index on the alarm path, for plans the statistics do not change.',
  },
  {
    id: 'iii. ★ the v1.153.0 sampling bound comes back',
    file: RECORDER,
    find: '    for (const sql of statsPlanned) {',
    to: '    db.exec(`PRAGMA analysis_limit=400;`); /* MUTANT */ for (const sql of statsPlanned) {',
    why: 'A needed refresh still reads every index page (the exact count), and writes truncated statistics: 401 rows per SN.',
  },
  {
    id: 'iv. ★ the planned ANALYZE is logged but never run',
    file: RECORDER,
    find: '      db.exec(sql);',
    to: '      /* MUTANT */',
    why: 'A fresh install or a new index never gets statistics, while the boot line says the refresh ran.',
  },
  {
    id: 'v. ★ the debug bit is dropped, so SQLite runs the refresh itself and lists nothing',
    file: RECORDER,
    find: 'db.prepare(`PRAGMA optimize=0x03`)',
    to: 'db.prepare(`PRAGMA optimize=0x02`) /* MUTANT */',
    why: 'An ANALYZE runs on the boot path and the line reports "planned no ANALYZE": the log no longer describes what the boot did.',
  },
  {
    id: 'vi. ★ a failed refresh is swallowed without a trace',
    file: RECORDER,
    find: '    statsFailure = `refresh FAILED while ${statsStep} (${e?.message ?? e}), `;',
    to: '    void e; /* MUTANT */',
    why: 'A refresh that could not take the write lock leaves the planner without statistics, and the boot line reads "planned no ANALYZE" — a failure narrated as a decision.',
  },
  {
    id: 'vii. ★★ a failed refresh takes the boot down',
    file: RECORDER,
    find: '    statsFailure = `refresh FAILED while ${statsStep} (${e?.message ?? e}), `;',
    to: '    throw e; /* MUTANT */',
    why: 'A lock held by another connection at boot becomes an add-on that does not start: no alarm evaluation at all, to protect query-planner statistics.',
  },
  {
    id: 'viii. ★ the line reports the PLANNED statements as run',
    file: RECORDER,
    find: "${statsRan.length > 0 ? `: ${statsRan.join('; ')}` : ''}",
    to: "${/* MUTANT */ statsPlanned.length > 0 ? `: ${statsPlanned.join('; ')}` : ''}",
    why: 'After a failed ANALYZE the boot line still names it, so the log claims work that did not happen.',
  },
  {
    id: 'ix. the failing step is never advanced past planning',
    file: RECORDER,
    find: "    statsStep = 'running';",
    to: '    /* MUTANT */',
    why: 'A lock met by the ANALYZE itself is reported as a failure to list, pointing the reader at the wrong statement.',
  },
  {
    id: 'x. the line stops naming the linked SQLite',
    file: RECORDER,
    find: 'SQLite ${sqliteVersion}, ',
    to: "SQLite ${/* MUTANT */ sqliteVersion && 'unknown'}, ",
    why: "The add-on links Alpine's system SQLite; which PRAGMA optimize masks exist depends on its version, and live verification reads it from this line.",
  },
  {
    id: 'xi. the planner-stats line is not emitted',
    file: RECORDER,
    find: '  log(`recorder: planner stats — SQLite ',
    to: '  void (`recorder: planner stats — SQLite ',
    why: 'Whether a boot analyzed anything is invisible again; the boot-phases line only says how long the analyze phase took.',
  },
];

const TSC = resolve(SERVER, 'node_modules/.bin/tsc');
function typecheck() {
  execFileSync(TSC, ['--noEmit', '-p', 'tsconfig.json'], { cwd: SERVER, stdio: 'pipe' });
}
// `npm test -- <files>` APPENDS the files to the package's own test/**/*.test.ts glob,
// so it runs the whole suite. The subset is run directly; the full suite only for a
// mutant the subset did not kill.
function runSubset() {
  execFileSync('node', ['--import', 'tsx', '--test', ...SUBSET], { cwd: SERVER, stdio: 'pipe' });
}
function runAll() {
  execFileSync('npm', ['test', '--silent'], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

// Pre-flight every anchor before any test runs: anchor rot costs a second, not a run.
for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    process.exit(2);
  }
}

// A red baseline kills every mutant for free.
try { typecheck(); runSubset(); } catch {
  console.error('\nABORT: the UNMUTATED tree fails to typecheck or fails the subset. Fix the baseline first.');
  process.exit(2);
}

let killed = 0;
const survivors = [];
console.log(`mutate-boot-analyze: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

for (const m of MUTANTS) {
  const original = originals.get(m.file);
  try {
    writeFileSync(m.file, original.replace(m.find, m.to));
    try { typecheck(); } catch (e) {
      console.error(`\nABORT: mutant "${m.id}" does not typecheck, so it proves nothing about the tests.`);
      console.error(String(e.stdout ?? e));
      process.exitCode = 2;
      break;
    }
    let died = false;
    try { runSubset(); } catch { died = true; }
    if (!died) { try { runAll(); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(m.file, original);
  }
}

if (process.exitCode === 2) {
  console.log('post-run: tree restored');
  process.exit(2);
}
console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
