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
    id: 'i. fired-latch dwell removed — ONE healthy sample clears the collapse',
    find: `        if (recoverSinceMs == null) recoverSinceMs = nowMs;
        if (nowMs - recoverSinceMs >= this.cfg.recoverMs) {
          recovered = true;`,
    to: `        if (recoverSinceMs == null) recoverSinceMs = nowMs;
        if (true) { /* MUTANT */
          recovered = true;`,
    why: 'A single burst would clear a latched collapse (the 08-04 05:06 defect, resurrected).',
  },
  {
    id: 'ii. pre-fire timer reset on any healthy sample (the "5 msgs every 19 min" evasion)',
    find: `      if (collapseSinceMs != null) {
        if (recoverSinceMs == null) recoverSinceMs = nowMs;`,
    to: `      if (collapseSinceMs != null) {
        collapseSinceMs = null; /* MUTANT */
        if (recoverSinceMs == null) recoverSinceMs = nowMs;`,
    why: 'Trickle traffic could park below the floor forever without ever accumulating the fire window.',
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
  {
    id: 'ix. ★ the absolute recovery floor is dropped (the 19:35 false all-clear, resurrected)',
    find: '      const genuineRecoveryRate = Math.max(this.cfg.floorFraction * cmpBaseline, this.cfg.minBaselineRate);',
    to: '      const genuineRecoveryRate = this.cfg.floorFraction * cmpBaseline; /* MUTANT */',
    why: 'A poisoned comparison baseline would again let a 95%-starved device announce "recovered".',
  },
  {
    id: 'x. the latch clears on any non-collapsed sample (v1.66.0 control flow, resurrected)',
    find: '      if (rate >= genuineRecoveryRate) {',
    to: '      if (true) { /* MUTANT */',
    why: 'Losing the ability to judge the device would again read as the device recovering.',
  },
  {
    id: 'xi. ★ eligibility read off the comparison baseline again (the DISARM trapdoor)',
    find: '    const eligible = peak >= this.cfg.minBaselineRate;',
    to: '    const eligible = cmpBaseline >= this.cfg.minBaselineRate; /* MUTANT */',
    why: 'A collapse could once more drive the very value that decides whether collapses are watched.',
  },
  {
    id: 'xii. the eligibility mark never decays (one-way latch)',
    find: '    const peak = Math.max(rate, prev.peak * Math.pow(0.5, dtMin / halfLifeMin));',
    to: '    const peak = Math.max(rate, prev.peak); /* MUTANT */',
    why: 'A device genuinely reconfigured to be quiet would be nagged about forever.',
  },
  {
    id: 'xiii. ★ the learning guard reverts to the one-way trapdoor form',
    find: '    const globalCollapsed = eligible && rate < this.cfg.floorFraction * prev.baseline;',
    to: '    const globalCollapsed = prev.baseline >= this.cfg.minBaselineRate && rate < this.cfg.floorFraction * prev.baseline; /* MUTANT */',
    why: 'Once the baseline slips under the floor the guard can never engage again — unguarded learning free-falls it to ~0.9.',
  },
  {
    id: 'xi. \u2605 idle EVICTS a surfaced collapse \u2014 the silent resolve\u2192refire flap returns',
    find: '  if (idle && !alreadySurfaced) return { surfaced: false, logCollapse: false };',
    to: '  if (idle) return { surfaced: false, logCollapse: false }; /* MUTANT */',
    why: 'A brief idle spell mid-collapse resolves the standing alert with no trail and re-pushes on wake \u2014 the 08-25/26 duplicate-push minors.',
  },
  {
    id: 'xii. collapse warn logs on EVERY surfaced tick',
    find: '  return { surfaced: true, logCollapse: !alreadySurfaced };',
    to: '  return { surfaced: true, logCollapse: true }; /* MUTANT */',
    why: 'One warn per minute for the length of every episode \u2014 log spam that buries the real signal.',
  },
  {
    id: 'xiii. offline no longer evicts a surfaced collapse',
    find: '  if (!online) return { surfaced: false, logCollapse: false };',
    to: '  /* MUTANT */',
    why: 'An unplugged device keeps a phantom rate-collapse alert alongside its offline alert.',
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
