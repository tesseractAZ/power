#!/usr/bin/env node
/**
 * mutate-v1187-4.mjs — committed harness for v1.187.4: the restart-recovery follow-ups.
 *
 * (1) The warm-up-end decision on a green held for its recovery waits for a settled alert set, or
 * at the latest LONGEST_RESTARTED_ONSET_MS + RESTARTED_ONSET_HOLD_MARGIN_MS after the boot
 * (broadcast.warmupEndDecisionDue): the backup-pool-unknown clock (15 min) restarts at the boot, so
 * a green announced at the end of the warm-up could precede the reserve-blind warning it hid.
 * Both outcomes wait — the announcement and the silent adoption. Mutants W-i..W-vii.
 *
 * (2) The restart-recovery decisions read conditionAudibleSinceBootLevel — the most severe
 * condition this process made audible on any channel (Music Assistant played it, the tone-only
 * fallback and a delivery-unknown timeout included, a sub-2 s "ok" not; the SIP cordless took it,
 * or a timed-out SIP dispatch the entity state confirms) — not lastConditionPlayedLevel (a
 * verified, error-free play: the storm gates' evidence). Tests and dedicated announcements never
 * count. Mutants U-i..U-viii.
 *
 * (3) The backup pool's unknown onset survives a restart (SnapshotStore, pool-unknown.json): a
 * panel whose first projection after the restart reads unknown carries it when the add-on was down
 * at most POOL_UNKNOWN_CARRY_MAX_GAP_MS, so an off-grid reserve-blind critical is critical at once,
 * not absent 15 min and a warning until boot + 60. Mutants C-i..C-xi.
 *
 * (4) A deferred retry of a CONDITION broadcast replays its level only while the condition is still
 * committed there (broadcast.conditionRetryStale), checked when it runs; a stale one never keeps a
 * newer deferral from arming. Dedicated announcements are unchanged. Mutants R-i..R-vi.
 *
 *   node scripts/mutate-v1187-4.mjs
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
const AL = resolve(SERVER, 'src/alerts.ts');
const BR = resolve(SERVER, 'src/broadcast.ts');
const SN = resolve(SERVER, 'src/snapshot.ts');

const SUBSET = [
  'test/restartRecoveryAllClear.test.ts',
  'test/restartRecoverySettledSet.test.ts',
  'test/poolUnknownCarry.test.ts',
  'test/staleConditionRetry.test.ts',
  'test/broadcastRetryBudget.test.ts',
  'test/reserveBlindFailover.test.ts',
];

const MUTANTS = [
  /* ── (1) the warm-up-end decision waits for a settled set ─────────────────────────────── */
  {
    id: 'W-i. ★★★ no wait: decided at the end of the warm-up on an unsettled set (v1.187.3)',
    file: BR,
    find: '      if (!warmupEndDecisionDue(alertSetSettledSince(), Date.now() - bootMs)) {',
    to: '      if (false) { /* MUTANT */',
    why: '"All clear" at boot + 11, then the reserve-blind warning the restarted clock hid at boot + 15.',
  },
  {
    id: 'W-ii. ★★ a settled set does not decide it: only the bound does',
    file: BR,
    find: '  return alertSetSettledSinceMs != null || msSinceBoot >= holdMs;',
    to: '  return msSinceBoot >= holdMs; /* MUTANT */',
    why: 'A red heard after the restart keeps the last words until boot + 16 though the set settled at boot + 11.',
  },
  {
    id: 'W-iii. ★★★ no bound: a set that never settles holds the green for good',
    file: BR,
    find: '  return alertSetSettledSinceMs != null || msSinceBoot >= holdMs;',
    to: '  return alertSetSettledSinceMs != null; /* MUTANT */',
    why: 'A feed that never delivers keeps the cleared condition the last words for the life of the process.',
  },
  {
    id: 'W-iv. ★★ no margin: released at the restarted window itself',
    file: BR,
    find: 'export const RESTARTED_ONSET_HOLD_MARGIN_MS = 60_000;',
    to: 'export const RESTARTED_ONSET_HOLD_MARGIN_MS = 0; /* MUTANT */',
    why: 'The withheld warning reaches the set only at the next alert pass: the green is spoken seconds before it.',
  },
  {
    id: 'W-v. ★★ the window forgets the backup pool (the 3-minute debounces only)',
    file: AL,
    find: 'export const LONGEST_RESTARTED_ONSET_MS = Math.max(BOOT_RESET_ONSET_DEBOUNCE_MS, RESERVE_BLIND_AFTER_MS);',
    to: 'export const LONGEST_RESTARTED_ONSET_MS = BOOT_RESET_ONSET_DEBOUNCE_MS; /* MUTANT */',
    why: 'The bound has passed before the warm-up ends: the 10-02 shape returns.',
  },
  {
    id: 'W-vi. ★★ only the announcement waits; the silent adoption is taken at the end of the warm-up',
    file: BR,
    find: '      if (!warmupEndDecisionDue(alertSetSettledSince(), Date.now() - bootMs)) {',
    to: "      if (conditionAudibleSinceBootLevel != null && conditionAudibleSinceBootLevel !== 'green' && !warmupEndDecisionDue(alertSetSettledSince(), Date.now() - bootMs)) { /* MUTANT */",
    why: 'The warning heard before the restart, published again at boot + 15, is spoken a second time.',
  },
  {
    id: 'W-vii. ★ the wait is logged on every tick',
    file: BR,
    find: '        if (warmupEndWaitLoggedFor !== recoveryHoldSinceMs) {',
    to: '        if (true) { /* MUTANT */',
    why: 'One line every 10 s for up to six minutes.',
  },

  /* ── (2) "audible since the boot" ─────────────────────────────────────────────────────── */
  {
    id: 'U-i. ★★★ a Music Assistant play is not noted',
    file: BR,
    find: "    } else if (call.ok && kind === 'condition') {",
    to: '    } else if (false) { /* MUTANT */',
    why: 'A red heard after the restart has its green adopted silently: the cleared red stays the last words.',
  },
  {
    id: 'U-ii. ★★★ the decisions read the verified play again (v1.187.3)',
    file: BR,
    find: "      if (conditionAudibleSinceBootLevel != null && conditionAudibleSinceBootLevel !== 'green') {",
    to: "      if (lastConditionPlayedLevel != null && lastConditionPlayedLevel !== 'green') { /* MUTANT */",
    why: 'A red heard as the klaxon alone, or only on the cordless, is followed by a silent green.',
  },
  {
    id: 'U-iii. ★★★ the cordless is not noted',
    file: BR,
    find: "          if (r.ok > 0 && kind === 'condition') noteConditionAudible(level);",
    to: '          /* MUTANT */',
    why: 'A red that reached only the SIP cordless (every speaker away) is followed by a silent green.',
  },
  {
    id: 'U-iv. ★★ a refused SIP dispatch counts',
    file: BR,
    find: "          if (r.ok > 0 && kind === 'condition') noteConditionAudible(level);",
    to: "          if (kind === 'condition') noteConditionAudible(level); /* MUTANT */",
    why: 'A red heard nowhere makes the clear of a warning heard only before the restart spoken from an unsettled set.',
  },
  {
    id: 'U-v. ★★ a sub-2 s "ok" counts',
    file: BR,
    find: '    if (call.ok && dt < 2000) {',
    to: "    if (call.ok && kind === 'condition') noteConditionAudible(level); /* MUTANT */\n    if (call.ok && dt < 2000) {",
    why: 'HA answered without playing; the red was heard by no one, yet its green is announced as if it had been.',
  },
  {
    id: 'U-vi. ★★ an operator TEST counts (Music Assistant)',
    file: BR,
    find: "    } else if (call.ok && kind === 'condition') {",
    to: '    } else if (call.ok) { /* MUTANT */',
    why: '"This is only a test" decides that the clear of a pre-restart warning is spoken from an unsettled set.',
  },
  {
    id: 'U-vii. ★★ an operator TEST counts (the cordless)',
    file: BR,
    find: "          if (r.ok > 0 && kind === 'condition') noteConditionAudible(level);",
    to: '          if (r.ok > 0) noteConditionAudible(level); /* MUTANT */',
    why: 'As U-vi, through the SIP side-channel.',
  },
  {
    id: 'U-viii. ★★ a timed-out SIP dispatch the entity confirms is not noted',
    file: BR,
    find: "                      if (kind === 'condition') noteConditionAudible(level); // v1.187.4",
    to: '                      /* MUTANT */',
    why: 'The cordless played the red (its HTTP response was lost) and the green is adopted silently.',
  },

  /* ── (3) the pool-unknown onset survives a restart ────────────────────────────────────── */
  {
    id: 'C-i. ★★★ nothing carried: the clock restarts at the first projection (pre-v1.187.4)',
    file: SN,
    find: '        this.backupPoolUnknownSinceBySn.set(sn, carried ?? nowMs);',
    to: '        this.backupPoolUnknownSinceBySn.set(sn, nowMs); /* MUTANT */',
    why: 'An off-grid reserve-blind critical is absent 15 min after a restart, then a warning until boot + 60.',
  },
  {
    id: 'C-ii. ★★★ never written',
    file: SN,
    find: '    if (changed || (due && (this.backupPoolUnknownSinceBySn.size > 0 || this.poolUnknownDirty))) this.writePoolUnknown();',
    to: '    /* MUTANT */',
    why: 'As C-i: the next process finds nothing to carry.',
  },
  {
    id: 'C-iii. ★★ the last-seen time is not refreshed while the pool stays unknown',
    file: SN,
    find: '    if (changed || (due && (this.backupPoolUnknownSinceBySn.size > 0 || this.poolUnknownDirty))) this.writePoolUnknown();',
    to: '    if (changed) this.writePoolUnknown(); /* MUTANT */',
    why: 'A restart an hour into a wedge reads as a long outage: the critical is dropped to absent, then a warning.',
  },
  {
    id: 'C-iv. ★★ rewritten on every projection',
    file: SN,
    find: '    const due = sinceAttemptMs >= POOL_UNKNOWN_PERSIST_EVERY_MS || sinceAttemptMs < 0;',
    to: '    const due = true; /* MUTANT */',
    why: 'A synchronous temp-file write and rename per panel delta (~1 Hz) on the event loop that evaluates the alarms.',
  },
  {
    id: 'C-v. ★★ any outage is carried',
    file: SN,
    find: '  if (nowMs - entry.lastSeenMs > maxGapMs) return null;',
    to: '  /* MUTANT */',
    why: 'A day-old onset greets a pool that reads unknown again after a long outage: a false critical at once.',
  },
  {
    id: 'C-vi. ★ an onset in the future is carried (the clock stepped back)',
    file: SN,
    find: '  return Math.min(entry.sinceMs, nowMs);',
    to: '  return entry.sinceMs; /* MUTANT */',
    why: 'The blind time reads negative and the alert is withheld until the clock catches up.',
  },
  {
    id: 'C-vii. ★★ a readable first projection does not retire the file\'s entry',
    file: SN,
    find: '    let changed = onDisk !== undefined;',
    to: '    let changed = false; /* MUTANT */',
    why: 'A later restart into a new unknown episode carries the onset of one that ended.',
  },
  {
    id: 'C-viii. ★★ the file\'s entry is not consumed by the panel\'s first projection',
    file: SN,
    find: '    this.poolUnknownOnDisk.delete(sn);',
    to: '    /* MUTANT */',
    why: 'An ended episode is written back on every save and carried by the next restart.',
  },
  {
    id: 'C-ix. ★ another panel\'s carriable entry is dropped when this one writes',
    file: SN,
    find: '    for (const [sn, e] of this.poolUnknownOnDisk) if (carriedPoolUnknownSince(e, nowMs) != null) out[sn] = e;',
    to: '    /* MUTANT */',
    why: 'A second panel not projected yet loses its onset to the first panel\'s save.',
  },
  {
    id: 'C-x. ★ an entry no longer carriable is kept forever',
    file: SN,
    find: '    for (const [sn, e] of this.poolUnknownOnDisk) if (carriedPoolUnknownSince(e, nowMs) != null) out[sn] = e;',
    to: '    for (const [sn, e] of this.poolUnknownOnDisk) out[sn] = e; /* MUTANT */',
    why: 'A panel taken off the account leaves its entry in the file for good.',
  },
  {
    id: 'C-xi. ★ an incoherent entry (since after last seen) is read',
    file: SN,
    find: '    if (sinceMs > lastSeenMs) continue;',
    to: '    /* MUTANT */',
    why: 'A corrupt file can carry an onset the store never wrote.',
  },

  /* ── (4) a stale condition retry ──────────────────────────────────────────────────────── */
  {
    id: 'R-i. ★★★ no run-time check: the armed level is replayed whatever the condition',
    file: BR,
    find: "        () => (conditionRetryStale(kind, level, prevLevel) ? `the condition is ${prevLevel ?? 'unknown'} now` : null));",
    to: '        undefined); /* MUTANT */',
    why: 'A cleared red is spoken after its all-clear: the last words in the house a critical that has cleared.',
  },
  {
    id: 'R-ii. ★★★ a stale pending retry still holds the slot',
    file: BR,
    find: '    const stalePending = retryLevel != null && conditionRetryStale(retryKind, retryLevel, prevLevel);',
    to: '    const stalePending = false; /* MUTANT */',
    why: 'The green that replaced the red is "kept pending" behind the red retry, which is then dropped: never retried.',
  },
  {
    id: 'R-iii. ★★ checked when the timer fires, not when the retry runs',
    file: BR,
    find: "        () => (conditionRetryStale(kind, level, prevLevel) ? `the condition is ${prevLevel ?? 'unknown'} now` : null));",
    to: "        ((s) => () => s)(conditionRetryStale(kind, level, prevLevel) ? `the condition is ${prevLevel ?? 'unknown'} now` : null)); /* MUTANT */",
    why: 'A retry queued behind a broadcast in flight is played after the green committed meanwhile.',
  },
  {
    id: 'R-iv. ★★ a dedicated retry is judged against the condition too',
    file: BR,
    find: "  return kind === 'condition' && committed !== armedLevel;",
    to: '  return committed !== armedLevel; /* MUTANT */',
    why: 'A deferred SoC-ladder or runway alarm is dropped because the condition (which excludes it) is green.',
  },
  {
    id: 'R-v. ★★ every condition retry is stale',
    file: BR,
    find: "  return kind === 'condition' && committed !== armedLevel;",
    to: "  return kind === 'condition'; /* MUTANT */",
    why: 'A red nobody heard is never retried, even while it is still the committed condition.',
  },
  {
    id: 'R-vi. ★★ the retry\'s kind is not recorded',
    file: BR,
    find: '    retryKind = kind;',
    to: '    /* MUTANT */',
    why: 'A condition retry reads as dedicated: as R-ii.',
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
console.log(`mutate-v1187-4: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
