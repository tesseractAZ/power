#!/usr/bin/env node
/**
 * mutate-curtail-freeze.mjs — committed harness for v1.186.1: the 7-day curtailment figure
 * freezes each finished day once it has SETTLED (weather fetched at least the settle lag after
 * the day ended, every hour of it covered by a value the provider sent, a posterior present),
 * persists the frozen days, prunes them as the window slides, and re-estimates only unsettled days.
 *
 *   node scripts/mutate-curtail-freeze.mjs
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
const FRZ = resolve(SERVER, 'src/curtailmentFreeze.ts');
const AN = resolve(SERVER, 'src/analytics.ts');

const SUBSET = ['test/curtailmentFreeze.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the settle lag is dropped',
    file: FRZ,
    find: '  if (!(weather.fetchedAt >= dayEndMs + CURTAIL_SETTLE_LAG_MS)) return false;',
    to: '  if (!(weather.fetchedAt >= dayEndMs)) return false; /* MUTANT */',
    why: 'Yesterday freezes minutes after midnight, on irradiance the provider is still revising.',
  },
  {
    id: 'ii. ★★★ settled by the wall clock, not by the fetch time of the weather in hand',
    file: FRZ,
    find: '  if (!(weather.fetchedAt >= dayEndMs + CURTAIL_SETTLE_LAG_MS)) return false;',
    to: '  if (!(Date.now() >= dayEndMs + CURTAIL_SETTLE_LAG_MS)) return false; /* MUTANT */',
    why: 'A stale cache (every fetch failing) freezes a finished day on the FORECAST it held for it.',
  },
  {
    id: 'iii. ★★ an hour outside the cache does not block the freeze',
    file: FRZ,
    find: '    if (!sent.has(Math.floor((dayStartMs + h * HOUR_MS) / HOUR_MS))) return false;',
    to: '    if (false) return false; /* MUTANT */',
    why: 'The oldest day, half outside the past_days edge, freezes on heuristic-only hours.',
  },
  {
    id: 'iv. ★★ a stand-in 0 counts as a reading',
    file: FRZ,
    find: '    if (h.radiationMissing !== true && Number.isFinite(h.radiationWm2)) sent.add(Math.floor(h.ts / HOUR_MS));',
    to: '    sent.add(Math.floor(h.ts / HOUR_MS)); /* MUTANT */',
    why: 'An hour the provider did not send (radiationMissing) is frozen as a dark hour for a week.',
  },
  {
    id: 'v. ★★★ a model-less walk freezes',
    file: FRZ,
    find: '  if (!weather || !hasPosterior) return false;',
    to: '  if (!weather) return false; /* MUTANT */',
    why: 'With no posterior every hour samples null, and a week of 0 kWh is frozen (the v1.178.0 trap).',
  },
  {
    id: 'vi. ★★★ the frozen store is never read (every refresh re-estimates all 168 hours)',
    file: AN,
    find: '    const frozenDay = frozenCurtailmentDay(dayStart);',
    to: '    const frozenDay = null as ReturnType<typeof frozenCurtailmentDay>; /* MUTANT */',
    why: 'The pre-v1.186.1 defect: the same finished days drift with every re-learn and weather refresh.',
  },
  {
    id: 'vii. ★★ the sidecar is not reloaded after a restart',
    file: FRZ,
    find: '        if (day) frozen.set(day.dayStartMs, day); // an invalid entry is dropped: that day re-estimates live',
    to: '        void day; /* MUTANT */',
    why: 'Every restart re-estimates the whole week against the posterior of the moment.',
  },
  {
    id: 'viii. ★ days that left the window are never pruned',
    file: FRZ,
    find: '    if (k < oldestKeptDayStartMs) { frozen.delete(k); dirty = true; }',
    to: '    if (false) { frozen.delete(k); dirty = true; } /* MUTANT */',
    why: 'The sidecar grows by a day every day, forever.',
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
console.log(`mutate-curtail-freeze: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
