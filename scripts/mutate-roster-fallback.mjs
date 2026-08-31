#!/usr/bin/env node
/**
 * mutate-roster-fallback.mjs — the last-known SHP2 roster.
 *
 * WHY COMMITTED: this is the guard between "the SoC ladder reads the backup
 * pool" and "the SoC ladder reads whatever happens to be hydrated" — and when
 * it fails it fails AUDIBLY. On 2026-08-29 the stale static literal admitted an
 * off-panel spare at 75% during boot hydration; the phantom re-armed the rungs
 * and replayed an already-announced 30% advisory to two speakers and a handset,
 * on both deploys. The opposite failure is just as bad: over-tighten the
 * fallback and the v1.8.0 SHP2-blind failover goes dark, which is the 42-hour
 * blackout that fallback exists to cover.
 *
 *   node scripts/mutate-roster-fallback.mjs
 *
 * ★ Anchor-asserted; restores in finally; do not touch the tree while running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MOD = resolve(SERVER, 'src/shp2Membership.ts');
const SUBSET = ['test/reserveBlindFailover.test.ts', 'test/rosterFallback.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ last-known roster ignored — the stale literal returns (audible replay)',
    find: '  if (lastKnownRoster && lastKnownRoster.size > 0) return lastKnownRoster.has(sn);',
    to: '  /* MUTANT */',
    why: 'The off-panel Core 3 re-enters the pool mean on every unhydrated tick — the 08-29 speaker replay.',
  },
  {
    id: 'ii. ★ last-known roster used even when the LIVE roster is populated',
    find: '  if (connected.size > 0) return connected.has(sn);',
    to: '  /* MUTANT */',
    why: 'A stale roster overrides live panel truth, so a real membership change is ignored until restart.',
  },
  {
    id: 'iii. an EMPTY last-known roster is trusted (nothing is ever in the pool)',
    find: '  if (lastKnownRoster && lastKnownRoster.size > 0) return lastKnownRoster.has(sn);',
    to: '  if (lastKnownRoster) return lastKnownRoster.has(sn); /* MUTANT */',
    why: 'On a first-ever boot the pool reads empty, homeFleetMeanSoc returns null forever, and the SHP2-blind failover is dead.',
  },
  {
    id: 'iv. ★ fallback roster not threaded into the pool mean',
    find: '    if (!isHomePoolDpu(d.sn, roster, lastKnownRoster)) continue; // only DPUs actually wired into the backup pool',
    to: '    if (!isHomePoolDpu(d.sn, roster)) continue; /* MUTANT */',
    why: 'The predicate is fixed but the one caller that matters still guesses — the replay returns.',
  },
];

function run(files) { execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' }); }
const original = readFileSync(MOD, 'utf8');
let killed = 0; const survivors = [];
console.log(`mutate-roster-fallback: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);
try {
  for (const m of MUTANTS) {
    const hits = original.split(m.find).length - 1;
    if (hits !== 1) {
      console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
      writeFileSync(MOD, original); process.exit(2);
    }
    writeFileSync(MOD, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           -> ${m.why}`); }
    writeFileSync(MOD, original);
  }
} finally { writeFileSync(MOD, original); }

console.log(`\nmutate-roster-fallback: ${killed}/${MUTANTS.length} killed`);
if (survivors.length) { console.log('\nSURVIVORS:'); for (const s of survivors) console.log(`  - ${s.id}`); process.exit(1); }
