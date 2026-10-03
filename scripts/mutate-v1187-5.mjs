#!/usr/bin/env node
/**
 * mutate-v1187-5.mjs — committed harness for v1.187.5: condition retries are newest-wins.
 *
 * Red A failed to play (Music Assistant 500s) and its retry was armed; on one tick A cleared and
 * critical C was announced; C's slow play failed; A's retry, fired meanwhile and queued behind C, then
 * ran. The run-time check read only the condition episode, "outranked" was a different TEXT, and any
 * same-episode red delivery cancelled the pending retry: played, A's retry cancelled C's (the house
 * heard the cleared A, C was never named); failed, it took C's slot with a fresh 1/3 budget.
 *
 * Every broadcast now takes a GENERATION when it runs (runBroadcastInner; a deferred retry keeps the
 * one of the announcement it replays). Per level, the newest generation of a condition announcement
 * that took the slot or reached the speakers is recorded (noteConditionNewest), and a condition
 * retry superseded by a newer one at its level or above is dropped when it runs
 * (broadcast.conditionRetrySuperseded). Only a newer generation outranks the pending retry (a retry's
 * own re-arm keeps its budget), and only a delivery at least as new as the pending retry cancels it.
 * A lower announcement never supersedes a higher retry; dedicated announcements are unchanged.
 * Mutants S-i..S-xiii.
 *
 * Not mutated: Math.max in noteConditionNewest (a retry is recorded only after passing the run-time
 * check, so its generation is never below the record of its level — a plain assignment is the same);
 * `>` against `!==` in the outrank test (an older generation reaching the arm is one nothing newer at
 * its level or above has superseded, so the pending retry it meets is lower, and the level rank
 * already decides); the episode the deferred retry passes to its own re-run (as mutate-v1187-4).
 *
 *   node scripts/mutate-v1187-5.mjs
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
const BR = resolve(SERVER, 'src/broadcast.ts');

const SUBSET = [
  'test/conditionRetryNewestWins.test.ts',
  'test/staleConditionRetry.test.ts',
  'test/broadcastRetryBudget.test.ts',
];

const MUTANTS = [
  {
    id: 'S-i. ★★★ no run-time check for a newer announcement',
    file: BR,
    find: '        () => staleAtRun() ?? supersededAtRun(), episode, generation);',
    to: '        () => staleAtRun(), episode, generation); /* MUTANT */',
    why: 'THE DEFECT: A\'s retry queued behind C plays the cleared A, and C (its retry storm-gated or cancelled) is never named.',
  },
  {
    id: 'S-ii. ★★ superseded judged when the timer fires, not when the retry runs',
    file: BR,
    find: '        () => staleAtRun() ?? supersededAtRun(), episode, generation);',
    to: '        ((s) => () => staleAtRun() ?? s)(supersededAtRun()), episode, generation); /* MUTANT */',
    why: 'A\'s retry fires while C is still playing (nothing newer yet) and plays after C has failed and armed.',
  },
  {
    id: 'S-iii. ★★ the timer does not pass the announcement\'s generation',
    file: BR,
    find: '        () => staleAtRun() ?? supersededAtRun(), episode, generation);',
    to: '        () => staleAtRun() ?? supersededAtRun(), episode); /* MUTANT */',
    why: 'Every re-run is a new announcement: its own re-arm outranks the slot with a fresh budget, and a failing announcement is retried forever.',
  },
  {
    id: 'S-iv. ★★ a retry takes a new generation instead of keeping its announcement\'s',
    file: BR,
    find: '    attemptGeneration = retryOf ?? ++broadcastGeneration;',
    to: '    attemptGeneration = ++broadcastGeneration; /* MUTANT */',
    why: 'As S-iii: the v1.159.0 budget that never counts, through the outrank path.',
  },
  {
    id: 'S-v. ★★ the slot does not record the pending retry\'s generation',
    file: BR,
    find: '    retryGeneration = generation;',
    to: '    /* MUTANT */',
    why: 'Every re-arm reads as newer than generation 0: a failing announcement takes a fresh budget each time.',
  },
  {
    id: 'S-vi. ★★ a retry\'s own re-arm outranks the slot (>=)',
    file: BR,
    find: '      && retryEpisode === episode && generation > retryGeneration && RETRY_LEVEL_RANK[level] >= RETRY_LEVEL_RANK[retryLevel];',
    to: '      && retryEpisode === episode && generation >= retryGeneration && RETRY_LEVEL_RANK[level] >= RETRY_LEVEL_RANK[retryLevel]; /* MUTANT */',
    why: 'C\'s second failure starts a fresh 1/3: the budget never counts past 1.',
  },
  {
    id: 'S-vii. ★★★ an arm is not recorded as the newest of its level',
    file: BR,
    find: "    if (kind === 'condition') noteConditionNewest(level, generation);",
    to: '    /* MUTANT */',
    why: 'C failing and arming does not supersede A\'s queued retry: the cleared A is played.',
  },
  {
    id: 'S-viii. ★★ a dedicated arm takes a condition retry\'s place',
    file: BR,
    find: "    if (kind === 'condition') noteConditionNewest(level, generation);",
    to: '    noteConditionNewest(level, generation); /* MUTANT */',
    why: 'A still-standing red\'s retry, queued behind a SoC-ladder alarm that deferred, is dropped: the red is not retried.',
  },
  {
    id: 'S-ix. ★★★ a delivery is not recorded as the newest of its level',
    file: BR,
    find: '      noteConditionNewest(level, generation);\n      if (retryTimer != null && retryLevel != null',
    to: '      /* MUTANT */\n      if (retryTimer != null && retryLevel != null',
    why: 'C reaches the speakers while A\'s retry waits in the chain (not the timer): A\'s cleared text is spoken after C.',
  },
  {
    id: 'S-x. ★★★ an older delivery cancels a newer pending retry',
    file: BR,
    find: '        && generation >= retryGeneration && RETRY_LEVEL_RANK[level] >= RETRY_LEVEL_RANK[retryLevel]) {',
    to: '        && RETRY_LEVEL_RANK[level] >= RETRY_LEVEL_RANK[retryLevel]) { /* MUTANT */',
    why: 'An older red retry reaching the speakers cancels the retry of a newer warning spoken under the kept red: the warning is never heard.',
  },
  {
    id: 'S-xi. ★★★ a newer LOWER announcement supersedes a higher retry',
    file: BR,
    find: '    .some((l) => RETRY_LEVEL_RANK[l] >= RETRY_LEVEL_RANK[level] && newest[l] > generation);',
    to: '    .some((l) => newest[l] > generation); /* MUTANT */',
    why: 'A warning spoken under the kept red drops the red\'s queued retry: the red nobody heard is not retried.',
  },
  {
    id: 'S-xii. ★★ the retry\'s own arm supersedes it',
    file: BR,
    find: '    .some((l) => RETRY_LEVEL_RANK[l] >= RETRY_LEVEL_RANK[level] && newest[l] > generation);',
    to: '    .some((l) => RETRY_LEVEL_RANK[l] >= RETRY_LEVEL_RANK[level] && newest[l] >= generation); /* MUTANT */',
    why: 'Every condition retry is dropped: a red nobody heard is never retried.',
  },
  {
    id: 'S-xiii. ★★ a dedicated retry is judged against the condition',
    file: BR,
    find: "  if (kind !== 'condition') return false;\n  return (Object.keys(RETRY_LEVEL_RANK) as ConditionLevel[])",
    to: "  /* MUTANT */\n  return (Object.keys(RETRY_LEVEL_RANK) as ConditionLevel[])",
    why: 'A SoC-ladder alarm\'s retry queued behind a newer condition announcement is dropped: the dedicated alarm is never heard.',
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
console.log(`mutate-v1187-5: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
