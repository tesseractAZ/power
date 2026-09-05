#!/usr/bin/env node
/**
 * mutate-ledger-legibility.mjs — committed mutation harness for the v1.132.0
 * batch: five places where the system recorded a true thing in a way that read
 * as a different, false thing.
 *
 * WHY COMMITTED: none of these are wrong values. They are correct values with
 * wrong labels, which is strictly harder to notice — the 2026-09-04 row printed
 * "no meaningful charge" for a night whose window physically could not serve a
 * whole-pool requirement, and read as routine for a day. A regression here is
 * invisible by construction, so "the tests would catch it" has to be shown.
 *
 *   node scripts/mutate-ledger-legibility.mjs
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
const RECORDER = resolve(SERVER, 'src/recorder.ts');

const SUBSET = ['test/ledgerLegibility.test.ts', 'test/ledgerDisposition.test.ts'];

// A mutant substituting `bindingCap !== 'requirement'` for the discriminator at
// the CALL SITE was written and run: it survived, because reaching a state where
// a cap is labelled while the requirement is still covered needs a cost-mode
// shape this suite could not construct through computeNightChargePlan. Rather
// than contrive one or leave a permanent false survivor, the discriminator was
// extracted to `holdIsStarved` and the mutants below target it directly, where
// an exhaustive test over its whole input space kills any rewrite.
const MUTANTS = [
  {
    id: 'i. ★ the starved hold reads as a quiet night again (the shipped defect)',
    file: ADVISOR,
    find: '  if (!o.meetable) return true;\n  return o.requiredExtraKwh / o.legEff > o.deliverableKwh + 1e-6;',
    to: '  return false; /* MUTANT */',
    why: 'This IS the 2026-09-04 row: a window that cannot serve prints as "the projected need is genuinely small".',
  },
  {
    id: 'ii. every hold reads as a starved window',
    file: ADVISOR,
    find: '  return o.requiredExtraKwh / o.legEff > o.deliverableKwh + 1e-6;',
    to: '  return true; /* MUTANT */',
    why: 'The opposite error — a trivially small need would be reported as a window that cannot serve.',
  },
  {
    id: 'iii. the unmeetable case stops counting as starved',
    file: ADVISOR,
    find: '  if (!o.meetable) return true;',
    to: '  /* MUTANT */',
    why: 'A requirement no effort can meet is the clearest "cannot serve" there is; dropping it hides the worst case.',
  },
  {
    id: 'iv. the meter/pack conversion is dropped from the comparison',
    file: ADVISOR,
    find: '  return o.requiredExtraKwh / o.legEff > o.deliverableKwh + 1e-6;',
    to: '  return o.requiredExtraKwh > o.deliverableKwh + 1e-6; /* MUTANT */',
    why: 'requiredExtraKwh is PACK-side lift and deliverableKwh is METER-side; comparing them raw understates the shortfall by legEff and mislabels marginal holds.',
  },
  {
    id: 'v. a windowless night claims an incomplete basis again',
    file: ADVISOR,
    find: "  if (!window || !(window.endMs > window.startMs)) return nullPlan(inputs, true, 'No plan — no valid cheap charge window resolved for tonight.');",
    to: "  if (!window || !(window.endMs > window.startMs)) return nullPlan(inputs, false, 'No plan — no valid cheap charge window resolved for tonight.'); /* MUTANT */",
    why: 'HA reports "basis incomplete" about a healthy basis, and a normal Saturday reads like a data outage.',
  },
  {
    id: 'vi. a REAL basis failure stops reporting incomplete',
    file: ADVISOR,
    find: "  if (!basisComplete) return nullPlan(inputs, false, 'No plan — forecast/telemetry basis incomplete; nothing will be charged.');",
    to: "  if (!basisComplete) return nullPlan(inputs, true, 'No plan — forecast/telemetry basis incomplete; nothing will be charged.'); /* MUTANT */",
    why: 'The windowless-night distinction is only worth having if a genuine basis failure still reads as one.',
  },
  {
    id: 'vii. ★ arm_disposition drops out of the write allowlist (SILENT)',
    file: RECORDER,
    find: "  'arm_disposition', 'cost_ceiling_basis',\n];",
    to: '];  /* MUTANT */',
    why: 'recordNightOutcome ignores unknown columns rather than throwing — the write vanishes with no error.',
  },
  {
    id: 'viii. the columns are never added to an existing DB',
    file: RECORDER,
    find: "    'arm_disposition TEXT', 'cost_ceiling_basis TEXT',",
    to: '    /* MUTANT */',
    why: 'CREATE TABLE IF NOT EXISTS does not evolve columns — every upgraded install would lose both fields.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-ledger-legibility: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
    if (!died) { try { run([]); } catch { died = true; } } // confirm against the FULL suite
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
