#!/usr/bin/env node
/**
 * mutate-zero-cushion.mjs — committed mutation harness for v1.133.0's
 * deliberate-zero outage cushion.
 *
 * WHY COMMITTED: the defect this replaces was INERT CONFIGURATION — an owner set
 * the cushion to 0, the option was accepted, validation passed, and the setting
 * silently delivered the legacy 15%-of-pool band instead. Worse, the legacy basis
 * also switches the cushion test to the whole-house forward trough, so asking for
 * NO cushion made the requirement LARGER. Nothing failed; the decision just did
 * not happen. That failure mode leaves no trace, so the guards have to be proven.
 *
 *   node scripts/mutate-zero-cushion.mjs
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
const ADVISOR = resolve(SERVER, 'src/nightChargeAdvisor.ts');

const SUBSET = ['test/zeroCushion.test.ts', 'test/cushionRescope.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ zero folds back into the unmeasurable branch (the shipped defect)',
    file: ADVISOR,
    find: "  if (outageHours === 0) return { kwh: 0, basis: 'disabled' };",
    to: '  /* MUTANT */',
    why: 'This IS the defect: asking for no cushion silently delivers the legacy 15% band and a harsher trough test.',
  },
  {
    id: 'ii. the disabled check moves AFTER the unmeasurable branch',
    file: ADVISOR,
    find: "  if (outageHours === 0) return { kwh: 0, basis: 'disabled' };\n\n  if (\n    islandedLoadKw == null",
    to: "  if (\n    islandedLoadKw == null",
    why: 'Ordering is the fix: with no islanded-load reading, a deliberate zero would fall through to the legacy band.',
  },
  {
    id: 'iii. a malformed hours value is treated as a decision',
    file: ADVISOR,
    find: '  if (outageHours === 0) return',
    to: '  if (outageHours <= 0) return', // eslint-disable-line -- MUTANT
    why: 'A negative or garbage hours value would silently disable the cushion instead of failing conservative.',
  },
  {
    id: 'iv. ★ the disabled cushion stops announcing itself',
    file: ADVISOR,
    find: "    ? `the ${reserveFloorPct}% reserve floor alone — the outage cushion is DISABLED, so nothing is held back for an outage`",
    to: "    ? `the ${reserveFloorPct}% floor+cushion` /* MUTANT */",
    why: 'A night with NO outage margin would read as one whose cushion was comfortably covered — the standard lowered, reported as met.',
  },
  {
    id: 'v. the disabled basis takes the whole-house trough',
    file: ADVISOR,
    find: "    if (cushionBasis === 'legacy-pct') return houseTroughAtLift(lift);",
    to: "    if (cushionBasis !== 'islanded-outage') return houseTroughAtLift(lift); /* MUTANT */",
    why: 'Disabling the cushion would apply the HARSHER whole-house test, raising the requirement instead of lowering it.',
  },
  {
    id: 'vi. a disabled cushion reports a non-zero kWh',
    file: ADVISOR,
    find: "  if (outageHours === 0) return { kwh: 0, basis: 'disabled' };",
    to: "  if (outageHours === 0) return { kwh: legacyCushionKwh, basis: 'disabled' }; /* MUTANT */",
    why: 'The basis would say disabled while the number still reserved 13.8 kWh — the two halves disagreeing is how this hid.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-zero-cushion: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

for (const m of MUTANTS) {
  const original = originals.get(m.file);
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    for (const [f, s] of originals) writeFileSync(f, s);
    process.exit(2);
  }
  try {
    writeFileSync(m.file, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(m.file, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
