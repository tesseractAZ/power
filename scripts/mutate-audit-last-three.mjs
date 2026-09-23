#!/usr/bin/env node
/**
 * mutate-audit-last-three.mjs — committed harness for v1.183.0: no projection is not
 * "Comfortable", a strategy-excluded circuit is not "turned off", the DPU countdown names its
 * direction, and chart axes carry distinct compact ticks with the unit on the axis label.
 *
 *   node scripts/mutate-audit-last-three.mjs
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
const TEXT = resolve(REPO, 'web/src/cards/cardText.ts');
const AXIS = resolve(REPO, 'web/src/charts/axisFormat.ts');
const TREND = resolve(REPO, 'web/src/charts/TrendChart.tsx');
const STRAT = resolve(REPO, 'web/src/pages/StrategyPanel.tsx');
const GEN = resolve(SERVER, 'src/telnet/plant/gen.ts');

const SUBSET = ['test/auditLastThree.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605 no projection reads "Comfortable" again',
    file: TEXT,
    find: "  if (minProjectedSoc == null) return { label: '—', tone: 'muted' };",
    to: "  if (minProjectedSoc == null) return { label: 'Comfortable', tone: 'ok' }; /* MUTANT */",
    why: 'The most reassuring word, in green, exactly when nothing has been projected.',
  },
  {
    id: 'ii. \u2605\u2605 a strategy-excluded circuit gets no note (the "turned off" reading returns by omission)',
    file: TEXT,
    find: '  if (loadIsEnable !== false) return null;',
    to: '  return null; /* MUTANT */',
    why: 'The tab no longer says the circuit is outside the SHP2\u2019s shed order.',
  },
  {
    id: 'iii. \u2605 a charging countdown reads as a runtime',
    file: TEXT,
    find: "  if (batAmp > 0.5) return 'to full';",
    to: '  /* MUTANT */',
    why: 'Time-to-full is labelled like time-to-empty.',
  },
  {
    id: 'iv. \u2605 compact ticks round to whole thousands again',
    file: AXIS,
    find: '  return Math.abs(v) >= 1000 ? `${trimDecimals(v / 1000, 2)}k` : trimDecimals(v);',
    to: '  return Math.abs(v) >= 1000 ? `${trimDecimals(v / 1000)}k` : trimDecimals(v); /* MUTANT */',
    why: 'Neighbouring ticks print the same label: an uneven-looking axis.',
  },
  {
    id: 'v. \u2605 the kW axis rounds to whole kW again',
    file: AXIS,
    find: '  return trimDecimals(watts / 1000, 2);',
    to: '  return trimDecimals(watts / 1000); /* MUTANT */',
    why: '1.5 and 2 kW both read "2".',
  },
  {
    id: 'vi. \u2605 the trend chart prints its unit on every tick again',
    file: TREND,
    find: '<YAxis yAxisId="left" tick={{ fill: CHART.axis, fontSize: 10 }} width={48} tickFormatter={compactTick} label={unit ?',
    to: '<YAxis yAxisId="left" tick={{ fill: CHART.axis, fontSize: 10 }} width={48} unit={unit ? ` ${unit}` : \'\'} /* MUTANT */ label={unit ?',
    why: '"10000 W" overflows the 48 px axis and the unit wraps onto a stray line.',
  },
  {
    id: 'vii. \u2605 a circuit outside the load strategy is ranked and tiered again',
    file: STRAT,
    find: '    .filter((c) => c.loadPriority != null && c.loadIsEnable !== false)',
    to: '    .filter((c) => c.loadPriority != null) /* MUTANT */',
    why: 'It reads "first to shed" beside "not in the SHP2\u2019s load strategy", and shifts every other tier.',
  },
  {
    id: 'viii. \u2605 the telnet console tags a charge countdown as runtime',
    file: GEN,
    find: "    tag: `GEN.${idx + 1}.${(p.batAmp ?? 0) > 0.5 ? 'TTF' : 'RUN'}.MIN`,",
    to: '    tag: `GEN.${idx + 1}.RUN.MIN`, /* MUTANT */',
    why: 'Time-to-full reads as remaining runtime on the operator console.',
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
console.log(`mutate-audit-last-three: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
