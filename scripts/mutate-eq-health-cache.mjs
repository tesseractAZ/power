#!/usr/bin/env node
/**
 * mutate-eq-health-cache.mjs — committed mutation harness for v1.151.0's
 * equipment-health incremental series cache.
 *
 * WHY COMMITTED: a caching bug here does not crash and does not look wrong. It
 * produces a slightly different efficiency baseline — a number nothing else in
 * the system can contradict, feeding an MPPT drift figure whose whole purpose is
 * to detect slow degradation. A stale or double-counted bucket would read as
 * exactly the thing the report exists to find.
 *
 * The optimisation is only legitimate while an incrementally-topped-up series is
 * INDISTINGUISHABLE from a full re-query. That equivalence is the invariant these
 * mutants attack.
 *
 *   node scripts/mutate-eq-health-cache.mjs
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
const ANALYTICS = resolve(SERVER, 'src/analytics.ts');

const SUBSET = ['test/equipmentHealthIncremental.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ the trailing partial bucket is not re-fetched',
    file: ANALYTICS,
    find: '    const from = Math.floor(cached.toMs / bucketMs) * bucketMs - bucketMs;',
    to: '    const from = cached.toMs; /* MUTANT */',
    why: 'The last bucket of the previous fetch stays frozen at its PARTIAL average forever — a permanently wrong sample in the efficiency baseline, with nothing to contradict it.',
  },
  {
    id: 'ii. ★ the overlap is appended instead of replacing',
    file: ANALYTICS,
    find: '      const kept = (cached.byMetric.get(m) ?? []).filter((p) => p.ts >= sinceMs && p.ts < from);',
    to: '      const kept = (cached.byMetric.get(m) ?? []).filter((p) => p.ts >= sinceMs); /* MUTANT */',
    why: 'The re-fetched buckets are DOUBLE-COUNTED — the series grows a duplicate every recompute and the medians drift toward whatever the tail happens to hold.',
  },
  {
    id: 'iii. aged-out points are never dropped',
    file: ANALYTICS,
    find: 'p.ts >= sinceMs && p.ts < from);',
    to: 'p.ts < from); /* MUTANT */',
    why: 'The cached series grows without bound: the 60-day baseline silently becomes a 60-day-plus-uptime baseline, and the earliest-30% slice drifts away from what the report claims to measure.',
  },
  {
    id: 'iv. ★ a non-overlapping cache is stitched across the hole',
    file: ANALYTICS,
    find: '  if (cached && cached.toMs > sinceMs && cached.toMs <= nowMs) {',
    to: '  if (cached) { /* MUTANT */',
    why: 'After a long gap the series is spliced across missing time, fabricating continuity the recorder never had.',
  },
  {
    id: 'v. the cache is never written, so every call is a full 60-day scan',
    file: ANALYTICS,
    find: '    eqSeriesCache.set(key, { toMs: nowMs, byMetric: out });',
    to: '    /* MUTANT */',
    why: 'Correct output, but the 9-second head-of-line block returns at the 10-minute TTL cadence — the whole defect this release exists to remove.',
  },
  {
    id: 'vi. the cache key drops the metric list',
    file: ANALYTICS,
    find: '  const key = `${sn}|${metrics.join(\',\')}`;',
    to: '  const key = sn; /* MUTANT */',
    why: 'The MPPT triple and the standby pair collide on one key per device, so each loop serves the other loop’s series — wrong metrics entirely, and still no error.',
  },
  {
    id: 'vii. the MPPT loop bypasses the cache',
    file: ANALYTICS,
    find: '  const byMetric = eqQueryMulti(recorder, sn, [watts, volts, amps], since, now);',
    to: '  const byMetric = recorder.queryMulti(sn, [watts, volts, amps], since, now, EQ_HEALTH_BUCKET_SEC); /* MUTANT */',
    why: 'The hotter of the two loops (10 of the 15 queries) goes back to a full 60-day scan per recompute.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-eq-health-cache: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
