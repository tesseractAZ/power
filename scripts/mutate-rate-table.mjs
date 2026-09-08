#!/usr/bin/env node
/**
 * mutate-rate-table.mjs — committed mutation harness for v1.136.0's single rate table.
 *
 * WHY COMMITTED: the defect it replaces cost $47.91/month and nothing failed.
 * `resolveTariffCents` returns TWO tiers; APS R-EV has four, so every overnight
 * kWh was priced at the off-peak rate — 16.91 c instead of 12.59 c — in Grid Cost
 * Today and everything downstream. A pricing error produces a plausible number,
 * not an exception, so only a test that pins each period to its own rate can hold
 * this.
 *
 *   node scripts/mutate-rate-table.mjs
 *
 * ★ Anchor-asserted: aborts rather than reporting green against an unmutated tree.
 * ★ Mutates in place, restoring in a finally block.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const A = resolve(SERVER, 'src/analytics.ts');
const SUBSET = ['test/rateTableUnify.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ the two-tier ladder comes back (the shipped defect)',
    file: A,
    find: '  const slice = rateAt(apsREvModelFromEnv(), tsMs);\n  if (slice.centsPerKwh != null) return slice.centsPerKwh;\n  return onPeakAt(tsMs) ? fallback.onPeak : fallback.offPeak;',
    to: '  return onPeakAt(tsMs) ? fallback.onPeak : fallback.offPeak; /* MUTANT */',
    why: 'Every overnight kWh returns to the off-peak rate — $47.91/month over-stated, and nothing throws.',
  },
  {
    id: 'ii. ★ the null guard is dropped — an unconfirmed install prices at $0',
    file: A,
    find: '  if (slice.centsPerKwh != null) return slice.centsPerKwh;\n  return onPeakAt(tsMs) ? fallback.onPeak : fallback.offPeak;',
    to: '  return slice.centsPerKwh as number; /* MUTANT */',
    why: 'rateAt returns null when rates are unconfirmed and null/100 === 0 in JS, so every kWh silently costs nothing.',
  },
  {
    id: 'iii. the discharge gate goes back to the 15-20 window',
    file: A,
    find: '  return slice.ratesConfirmed ? slice.isOnPeak : onPeakAt(tsMs);',
    to: '  return onPeakAt(tsMs); /* MUTANT */',
    why: 'The plan discharges across five hours where R-EV rewards three, spending cycle life for no arbitrage.',
  },
  {
    id: 'iv. the gate stops honouring the confirmed table',
    file: A,
    find: '  return slice.ratesConfirmed ? slice.isOnPeak : onPeakAt(tsMs);\n}',
    to: '  return slice.isOnPeak;\n} /* MUTANT */',
    why: 'On an unconfirmed tariff isOnPeak is meaningless, so the gate would follow a table that has no rates.',
  },
  // ★★ KNOWN SURVIVOR — DECLARED, NOT HIDDEN.
  //
  // Mutant v below survives. `computeTariffReport`'s tally integrates over the
  // trailing `windowDays` only, so a fixture hour far enough in the past to have
  // a KNOWN tariff period contributes no energy, and with zero energy both the
  // two-tier and full-table paths return 0 — the mutant is invisible. Making the
  // hour recent enough to be integrated makes its tariff period depend on the day
  // the suite happens to run, and the fixture also needs SHP2 membership for
  // `homeDpus` to be non-empty.
  //
  // The DISPATCH call site (mutant vi) IS pinned, and both pure helpers are pinned
  // exhaustively. What is unprotected is specifically the one line in the KPI
  // tally — which is the number the operator reads, so this is worth closing:
  // build a recorder stub whose series lands inside the window with an injected
  // clock. Left declared rather than deleted, because a harness that quietly drops
  // the mutant it cannot kill reports a better score than it has earned.
  {
    id: 'v. the KPI tally stops using the shared resolver [KNOWN SURVIVOR — see note above]',
    file: A,
    find: '      const rate = hourlyRateCents(t, tariffCents) / 100;',
    to: '      const rate = (onPeakAt(t) ? tariffCents.onPeak : tariffCents.offPeak) / 100; /* MUTANT */',
    why: 'Grid Cost Today drifts from the dispatch planner again — the split-brain v1.52.0 set out to remove.',
  },
  {
    id: 'vi. the dispatch planner prices off a different table than the KPIs',
    file: A,
    find: '    const rate = hourlyRateCents(h.ts, dispatchCents) / 100;',
    to: '    const rate = (onPeak ? dispatchCents.onPeak : dispatchCents.offPeak) / 100; /* MUTANT */',
    why: "The planner's own comment says it must not price its plan off a different table than the KPIs.",
  },
];

function run(files) { execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' }); }

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
let killed = 0; const survivors = [];
console.log(`mutate-rate-table: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);
for (const m of MUTANTS) {
  const original = originals.get(m.file);
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
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
  } finally { writeFileSync(m.file, original); }
}
console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
const undeclared = survivors.filter((s) => !/KNOWN SURVIVOR/.test(s.id));
if (survivors.length) {
  console.log('\nSURVIVORS:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
}
if (undeclared.length) { console.error(`\n${undeclared.length} UNDECLARED survivor(s) — fix or declare them.`); process.exit(1); }
if (survivors.length) console.log('\nAll survivors are declared in the harness with their reason. Exit 0.');
console.log('post-run: tree restored');
