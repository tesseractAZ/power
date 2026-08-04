#!/usr/bin/env node
/**
 * mutate-rate-floor.mjs — committed mutation harness for the v1.66.0 diurnal
 * message-rate floor detector (server/src/messageRateFloor.ts).
 *
 * WHY THIS IS COMMITTED, not run ad hoc: "the tests would catch it" is a claim, and a
 * claim about the ONLY detector covering "a device reports but is starved" has to be
 * reproducible. v0.92.0 shipped with a header comment asserting a property the code did
 * not have ("a collapse cannot drag the baseline down to meet itself") and nothing ever
 * caught it — for two years the detector was unreliable in BOTH directions:
 *
 *   FALSE NEGATIVE — Core baselines eroded 47 -> 32 over two days and an 11.7 h
 *                    fleet-wide collapse (2.7-2.9 msg/min) fired nothing on 08-04.
 *   FALSE POSITIVE — 08-03 19:24 Core 2 fired at 4.0 msg/min during its legitimate
 *                    19:00-22:59 idle window (measured 4.4-6.2 msg/min every day).
 *
 * Mutant `iii` is special: it is a bug I actually wrote and the suite actually caught
 * during this rewrite. Gating the hour bucket on the GLOBAL baseline deadlocks the
 * bootstrap — an idle hour can never learn, so it false-fires forever. Keep it.
 *
 *   node scripts/mutate-rate-floor.mjs
 *
 * A mutant is KILLED if the suite fails while it is applied. Survivors are re-run
 * against the FULL suite before being reported, so "survived" never means "the fast
 * subset happened to miss it".
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once, the
 *   harness ABORTS rather than reporting a green run against an unmutated tree. A
 *   previous harness in this repo reported a false all-killed because its edits
 *   silently failed to apply.
 * ★ The harness MUTATES THE WORKING TREE in place and restores each file in a finally
 *   block. Do not run git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const FLOOR = resolve(SERVER, 'src/messageRateFloor.ts');

/** Fast subset: the only files that can observe these mutants. */
const SUBSET = ['test/messageRateFloor.test.ts', 'test/messageRateFloorAlert.test.ts'];

const MUTANTS = [
  {
    id: 'i. clear dwell removed — ONE healthy sample clears a fired collapse (the v0.92.0 defect)',
    find: '      if (nowMs - recoverSinceMs >= this.cfg.recoverMs) {',
    to: '      if (true) { /* MUTANT */',
    why: 'A single burst mid-episode buys silence. Cost 27 min inside the 08-04 collapse.',
  },
  {
    id: 'ii. pre-fire timer reset on any healthy sample (the "5 msgs every 19 min" evasion)',
    find: '      if (recoverSinceMs == null) recoverSinceMs = nowMs;',
    to: '      collapseSinceMs = null; fired = false; /* MUTANT */',
    why: 'A device averaging ~1% of baseline never accumulates 20 min and never fires.',
  },
  {
    id: 'iii. hour bucket gated on the GLOBAL view (bootstrap deadlock — a bug I wrote)',
    find: '    const bucketCollapsed = usedHourBucket && rate < this.cfg.floorFraction * bucket;',
    to: '    const bucketCollapsed = globalCollapsed; /* MUTANT */',
    why: 'An idle hour can never learn, so the idle window false-fires against the global forever.',
  },
  {
    id: 'iv. bucket decay made symmetric (restores the ratchet)',
    find: '      const a = bucket === 0 ? 1 : rate >= bucket ? this.cfg.baselineAlpha : this.cfg.baselineAlphaDown;',
    to: '      const a = bucket === 0 ? 1 : this.cfg.baselineAlpha; /* MUTANT */',
    why: 'A ramp-down walks the bucket down to meet the collapse — the 47->32 erosion.',
  },
  {
    id: 'v. hour buckets ignored entirely (regression to the v0.92.0 single scalar)',
    find: '    const usedHourBucket = prev.hourlyN[hour] >= this.cfg.minHourSamples && bucket > 0;',
    to: '    const usedHourBucket = false; /* MUTANT */',
    why: 'Reinstates both failure modes: one scalar cannot describe a 13x diurnal swing.',
  },
  {
    id: 'vi. collapse no longer blocks GLOBAL learning',
    find: '    if (!globalCollapsed) {',
    to: '    if (true) { /* MUTANT */',
    why: 'The baseline converges to the collapsed rate and the device silently self-heals.',
  },
  {
    id: 'vii. eligibilityLost never signalled',
    find: '      eligibilityLost: prev.wasEligible && !eligible,',
    to: '      eligibilityLost: false, /* MUTANT */',
    why: 'The transition that stops monitoring a device becomes invisible again.',
  },
  {
    id: 'viii. hydrate resurrects the pre-restart counter (bogus rate on first sample)',
    find: '      st.lastMs = -1; // sentinel: "no live sample yet"',
    to: '      st.lastMs = 0; /* MUTANT */',
    why: 'The message counter re-zeroes on restart; a carried-over lastMs computes garbage.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

let killed = 0;
const survivors = [];
const original = readFileSync(FLOOR, 'utf8');

console.log(`mutate-rate-floor: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

for (const m of MUTANTS) {
  // ANCHOR ASSERTION — a mutant that does not apply must abort the run, never pass.
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    writeFileSync(FLOOR, original);
    process.exit(2);
  }
  try {
    writeFileSync(FLOOR, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) {
      // Survived the subset — confirm against the FULL suite before reporting it.
      try { run([]); } catch { died = true; }
    }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(FLOOR, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
