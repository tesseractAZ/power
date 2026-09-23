#!/usr/bin/env node
/**
 * mutate-broadcast-test-level.mjs — committed harness for v1.185.1: POST /api/broadcast/test
 * validates the CONDITION levels (red/yellow/green, empty body = red), not the chime rungs.
 *
 *   node scripts/mutate-broadcast-test-level.mjs
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
const BC = resolve(SERVER, 'src/broadcast.ts');
const INDEX = resolve(SERVER, 'src/index.ts');

const SUBSET = ['test/broadcastTestLevel.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★ a chime rung passes as a test level',
    file: BC,
    find: '  return typeof level === \'string\' && (BROADCAST_TEST_LEVELS as readonly string[]).includes(level) ? (level as ConditionLevel) : null;',
    to: '  return typeof level === \'string\' ? (level as ConditionLevel) : null; /* MUTANT */',
    why: 'A "critical" test is spoken as "All clear. Test broadcast." with the clear tone.',
  },
  {
    id: 'ii. ★ the empty body is refused',
    file: BC,
    find: '  const level = raw ?? \'red\';',
    to: '  const level = raw; /* MUTANT */',
    why: 'The documented default (no body = red test) returns 400 again.',
  },
  {
    id: 'iii. ★★ the route validates against the chime rungs again',
    file: INDEX,
    find: '    const level = parseBroadcastTestLevel(req.body?.level);',
    to: '    const level = (CHIME_LEVELS as readonly string[]).includes(req.body?.level ?? \'red\') ? parseBroadcastTestLevel(req.body?.level) : null; /* MUTANT */',
    why: 'Every documented test call is refused with 400, as from v1.59.0 to v1.185.0.',
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
console.log(`mutate-broadcast-test-level: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
