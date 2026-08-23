#!/usr/bin/env node
/**
 * mutate-db-export.mjs — committed harness for the /share DB snapshot
 * (server/src/dbExport.ts + dbExportWorker.ts).
 *
 * WHY COMMITTED: this feature's failure modes are all SILENT. A snapshot taken
 * with `cp` instead of VACUUM INTO still produces an openable database — it
 * just quietly omits every row still in the WAL, so an investigation would be
 * run against data that is missing exactly the most recent (most interesting)
 * samples. Likewise a vacuum written straight onto the published path leaves a
 * window where the path a viewer is aimed at does not exist, and a fail-open
 * name check turns the one caller-controlled path component into a traversal.
 * None of these announce themselves; each must be demonstrably load-bearing.
 *
 *   node scripts/mutate-db-export.mjs
 *
 * ★ Anchor-asserted; restores in finally; do not touch the tree while running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MOD = resolve(SERVER, 'src/dbExport.ts');
const WORKER = resolve(SERVER, 'src/dbExportWorker.ts');
const SUBSET = ['test/dbExport.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ VACUUM INTO downgraded to a plain file copy',
    file: WORKER,
    find: "    db.exec(`VACUUM INTO '${tmp}'`);",
    to: "    copyFileSync(sourcePath, tmp); /* MUTANT */",
    extra: (s) => s.replace(
      "import { mkdirSync, rmSync, renameSync, statSync } from 'node:fs';",
      "import { mkdirSync, rmSync, renameSync, statSync, copyFileSync } from 'node:fs';",
    ),
    why: 'The snapshot silently loses every un-checkpointed WAL row — the newest samples, on a busy recorder.',
  },
  {
    id: 'ii. ★ vacuum written straight onto the published path (no temp + rename)',
    file: WORKER,
    find: "    db.exec(`VACUUM INTO '${tmp}'`);",
    to: "    rmSync(target, { force: true }); db.exec(`VACUUM INTO '${target}'`); /* MUTANT */",
    why: 'Deletes the last good snapshot BEFORE producing the next: a viewer aimed at the path sees a hole, or nothing at all if the vacuum fails.',
  },
  {
    id: 'iii. stale-temp cleanup dropped',
    file: WORKER,
    find: '  rmSync(tmp, { force: true });',
    to: '  /* MUTANT */',
    why: 'One crashed run wedges every future export — VACUUM INTO refuses an existing target, and reports it as a readonly-database error.',
  },
  {
    id: 'iv. ★ name check fails OPEN (invalid names fall back to the default)',
    file: MOD,
    find: "  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;",
    to: "  if (!/^[A-Za-z0-9._-]+$/.test(name)) return DEFAULT_EXPORT_NAME; /* MUTANT */",
    why: 'A rejected name silently becomes a successful export, so the caller believes a path they never asked for is the one they got.',
  },
  {
    id: 'v. ★ separator/traversal rule removed from the name check',
    file: MOD,
    find: "  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;",
    to: "  /* MUTANT */",
    why: 'The one caller-controlled path component becomes a traversal: ../../ escapes /share entirely.',
  },
  {
    id: 'vi. dotfile rule removed',
    file: MOD,
    find: "  if (name.startsWith('.')) return null; // no dotfiles, and kills bare \"..\" early",
    to: '  /* MUTANT */',
    why: 'A caller could name a snapshot onto our own `.<name>.tmp` scratch path and collide with an in-flight export.',
  },
  {
    id: 'vii. .db extension rule removed',
    file: MOD,
    find: "  if (!name.endsWith('.db')) return null;",
    to: '  /* MUTANT */',
    why: 'Publishes SQLite databases under arbitrary extensions into a shared directory.',
  },
  {
    id: 'viii. ★ single-flight removed',
    file: MOD,
    find: '  if (inFlight) return inFlight;',
    to: '  /* MUTANT */',
    why: 'Two concurrent exports race onto the SAME temp path — one vacuum renames the other half-written file into place.',
  },
];

function run(files) { execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' }); }

const originals = new Map([[MOD, readFileSync(MOD, 'utf8')], [WORKER, readFileSync(WORKER, 'utf8')]]);
const restore = () => { for (const [f, s] of originals) writeFileSync(f, s); };

let killed = 0; const survivors = [];
console.log(`mutate-db-export: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);
try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const hits = original.split(m.find).length - 1;
    if (hits !== 1) {
      console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
      restore(); process.exit(2);
    }
    let mutated = original.replace(m.find, m.to);
    if (m.extra) mutated = m.extra(mutated);
    writeFileSync(m.file, mutated);
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           -> ${m.why}`); }
    restore();
  }
} finally { restore(); }

console.log(`\nmutate-db-export: ${killed}/${MUTANTS.length} killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the tests do NOT pin these:');
  for (const s of survivors) console.log(`  - ${s.id}\n    ${s.why}`);
  process.exit(1);
}
