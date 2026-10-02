#!/usr/bin/env node
/**
 * mutate-v1187-4.mjs — committed harness for v1.187.4: the restart-recovery follow-ups.
 *
 * (1) The restart question on a green under a heard baseline stays open past the warm-up until
 * LONGEST_RESTARTED_ONSET_MS + RESTARTED_ONSET_HOLD_MARGIN_MS (16 min) after the boot, and one more
 * dwell on a set settled by then (broadcast.restartQuestionOpen): the backup-pool-unknown clock
 * (15 min) restarts at the boot, so a green decided at the end of the warm-up, or one whose dwell
 * ended after it, could precede the reserve-blind warning it hid. When it closes with the green
 * held, the decision waits for a broadcast in flight or a SIP outcome pending. Mutants W-i..W-xii.
 * (review) A return to the held level is a flicker only when that level was audible in its episode
 * (committedAudible), and a level above the observed one audible since the boot ends the
 * continuation when that level has cleared (not while it is only held: keepRed). Mutants H-i..H-vi.
 *
 * (2) The restart-recovery decisions read conditionAudibleSinceBootLevel — the most severe
 * condition this process made audible on any channel (Music Assistant played it, the tone-only
 * fallback and a delivery-unknown timeout included, a sub-2 s "ok" not; the SIP cordless took it,
 * or a timed-out SIP dispatch the entity state confirms) — not lastConditionPlayedLevel. Tests and
 * dedicated announcements never count. Mutants U-i..U-viii.
 *
 * (3) The backup pool's unknown onset survives a restart (SnapshotStore, pool-unknown.json): carried
 * by a panel whose first projection reads unknown when the add-on was down at most
 * POOL_UNKNOWN_CARRY_MAX_GAP_MS; refreshed by projections and by the poll loop; an unconsumed,
 * carriable entry of a listed panel is pending for the settled set; a failed save removes the file;
 * an episode over POOL_UNKNOWN_MAX_EPISODE_MS is not believed. Mutants C-i..C-xix.
 *
 * (4) A deferred retry of a CONDITION broadcast replays only while the condition episode it was
 * requested in is current (broadcast.conditionRetryStale), checked when it runs; a stale one never
 * keeps a newer deferral from arming. Dedicated announcements are unchanged. Mutants R-i..R-vii.
 *
 * Not mutated: the episode a deferred retry passes to its own re-run (the run-time check reads the
 * armed episode from its closure first, so a re-run in a later episode is always dropped before it
 * could re-arm); the `else if (heard)` keeping a same-level heard adoption audible (no test reaches a
 * same-level heard adoption whose audibility changes an outcome); `!inWarmup` on the decision branch
 * (the question is always open through the warm-up).
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
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const BR = resolve(SERVER, 'src/broadcast.ts');
const SN = resolve(SERVER, 'src/snapshot.ts');

const SUBSET = [
  'test/restartRecoveryAllClear.test.ts',
  'test/restartRecoverySettledSet.test.ts',
  'test/poolUnknownCarry.test.ts',
  'test/staleConditionRetry.test.ts',
  'test/broadcastRetryBudget.test.ts',
  'test/reserveBlindFailover.test.ts',
  'test/conditionDeescalationDwell.test.ts',
];

const NOTE_SIP = "          if (r.ok > 0 && kind === 'condition') noteConditionAudible(level, episode);";
const RUN_CHECK = "        () => (conditionRetryStale(kind, episode, conditionEpisode) ? `a newer condition (${prevLevel ?? 'unknown'}) has been committed since` : null),";

const MUTANTS = [
  /* ── (1) the restart question ─────────────────────────────────────────────────────────── */
  {
    id: 'W-i. ★★★ the question closes at the end of the warm-up (v1.187.3)',
    file: BR,
    find: '  if (msSinceBoot < Math.max(warmupMs, holdMs)) return true;',
    to: '  if (msSinceBoot < warmupMs) return true; /* MUTANT */',
    why: '"All clear" at boot + 11, then the reserve-blind warning the restarted clock hid at boot + 15.',
  },
  {
    id: 'W-ii. ★★ no patience on a settled set at the bound',
    file: BR,
    find: '  return alertSetSettledSinceMs != null && msSinceBoot < holdMs + dwellMs;',
    to: '  return false; /* MUTANT */',
    why: 'A set that settles at boot + 15 has its green decided at boot + 16 with one minute on it.',
  },
  {
    id: 'W-iii. ★★★ an unsettled set holds the question open for good',
    file: BR,
    find: '  if (msSinceBoot < Math.max(warmupMs, holdMs)) return true;',
    to: '  if (alertSetSettledSinceMs == null || msSinceBoot < Math.max(warmupMs, holdMs)) return true; /* MUTANT */',
    why: 'A feed that never delivers keeps the cleared condition the last words for the life of the process.',
  },
  {
    id: 'W-iv. ★★ no margin: closed at the restarted window itself',
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
    why: 'The question closes with the warm-up: the 10-02 shape returns.',
  },
  {
    id: 'W-vi. ★★★ the tick keeps the warm-up as the question\'s window',
    file: BR,
    find: '    const questionOpen = restartQuestionOpen(Date.now() - bootMs, settledSinceMs);',
    to: '    const questionOpen = Date.now() - bootMs < BROADCAST_BOOT_WARMUP_MS; /* MUTANT */',
    why: 'As W-i, and the late-green path speaks an all-clear on an unsettled set at boot + 10:30.',
  },
  {
    id: 'W-vii. ★ the patience runs two dwells',
    file: BR,
    find: '  return alertSetSettledSinceMs != null && msSinceBoot < holdMs + dwellMs;',
    to: '  return alertSetSettledSinceMs != null && msSinceBoot < holdMs + 2 * dwellMs; /* MUTANT */',
    why: 'The question stays open three minutes longer than documented.',
  },
  {
    id: 'W-viii. ★★ the decision does not wait for a broadcast in flight',
    file: BR,
    find: '      if (realAudibleInFlight > 0 || sipOutcomesPending > 0) {',
    to: '      if (false) { /* MUTANT */',
    why: 'A red retry playing when the question closes is not audible yet: its green is adopted silently and the red ends the last words.',
  },
  {
    id: 'W-ix. ★★ the decision does not wait for a SIP outcome',
    file: BR,
    find: '      if (realAudibleInFlight > 0 || sipOutcomesPending > 0) {',
    to: '      if (realAudibleInFlight > 0) { /* MUTANT */',
    why: 'A red reaching only the cordless, its outcome pending, is followed by a silent green.',
  },
  {
    id: 'W-x. ★ a SIP outcome is never settled on the plain path',
    file: BR,
    find: '          if (!probing) sipOutcomeKnown();',
    to: '          /* MUTANT */',
    why: 'After any cordless dispatch the restart decision waits for good.',
  },
  {
    id: 'W-xi. ★ the timeout probe never settles its outcome',
    file: BR,
    find: '                  .finally(sipOutcomeKnown);',
    to: '                  ; /* MUTANT */',
    why: 'After a timed-out cordless dispatch the restart decision waits for good.',
  },
  {
    id: 'W-xii. ★ the wait is logged on every tick',
    file: BR,
    find: '        if (warmupEndWaitLoggedFor !== recoveryHoldSinceMs) {',
    to: '        if (true) { /* MUTANT */',
    why: 'One line every 10 s while a clip plays.',
  },
  {
    id: 'H-i. ★★★ a return to the held level is always a flicker (v1.187.3)',
    file: BR,
    find: '    const unheardReturn = deescalationHold != null && level === deescalationHold.from && !newCrit && !committedAudible;',
    to: '    const unheardReturn = false; /* MUTANT */',
    why: 'A red nobody heard that returns while its clearing stands the dwell is never spoken — for up to 16 min after a restart.',
  },
  {
    id: 'H-ii. ★★ a return is spoken even when the held level was heard',
    file: BR,
    find: '    const unheardReturn = deescalationHold != null && level === deescalationHold.from && !newCrit && !committedAudible;',
    to: '    const unheardReturn = deescalationHold != null && level === deescalationHold.from && !newCrit; /* MUTANT */',
    why: 'Every flicker of a heard condition sounds again: the dwell no longer absorbs anything.',
  },
  {
    id: 'H-iii. ★★ an audible broadcast does not mark the committed level',
    file: BR,
    find: '    if (episode === conditionEpisode && level === prevLevel) committedAudible = true;',
    to: '    /* MUTANT */',
    why: 'As H-ii for every level that was heard in this process.',
  },
  {
    id: 'H-iv. ★★ a level change keeps the old level\'s audibility',
    file: BR,
    find: '      conditionEpisode += 1;\n      committedAudible = heard;',
    to: '      conditionEpisode += 1; /* MUTANT */',
    why: 'A red nobody heard after a heard yellow is absorbed as a flicker when it returns.',
  },
  {
    id: 'H-v. ★★★ the continuation ignores a higher level audible since the boot',
    file: BR,
    find: '    if (transitioned && !higherAudible && isRestartContinuation(continuationBaseline, level, Date.now() - bootMs)) {',
    to: '    if (transitioned && isRestartContinuation(continuationBaseline, level, Date.now() - bootMs)) { /* MUTANT */',
    why: 'A red heard after the restart that clears back to the heard yellow is filed as the pre-restart advisory: the cleared red stays the last words.',
  },
  {
    id: 'H-vi. ★ a held (not cleared) red after the restart also ends the continuation',
    file: BR,
    find: '    const higherAudible = !keepRed && conditionAudibleSinceBootLevel != null && LEVEL_RANK[conditionAudibleSinceBootLevel] > LEVEL_RANK[level];',
    to: '    const higherAudible = conditionAudibleSinceBootLevel != null && LEVEL_RANK[conditionAudibleSinceBootLevel] > LEVEL_RANK[level]; /* MUTANT */',
    why: 'The warning heard before the restart is spoken again beside a red that is still committed.',
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
    find: NOTE_SIP,
    to: '          /* MUTANT */',
    why: 'A red that reached only the SIP cordless (every speaker away) is followed by a silent green.',
  },
  {
    id: 'U-iv. ★★ a refused SIP dispatch counts',
    file: BR,
    find: NOTE_SIP,
    to: "          if (kind === 'condition') noteConditionAudible(level, episode); /* MUTANT */",
    why: 'A red heard nowhere makes the clear of a warning heard only before the restart spoken from an unsettled set.',
  },
  {
    id: 'U-v. ★★ a sub-2 s "ok" counts',
    file: BR,
    find: '    if (call.ok && dt < 2000) {',
    to: "    if (call.ok && kind === 'condition') noteConditionAudible(level, episode); /* MUTANT */\n    if (call.ok && dt < 2000) {",
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
    find: NOTE_SIP,
    to: '          if (r.ok > 0) noteConditionAudible(level, episode); /* MUTANT */',
    why: 'As U-vi, through the SIP side-channel.',
  },
  {
    id: 'U-viii. ★★ a timed-out SIP dispatch the entity confirms is not noted',
    file: BR,
    find: "                      if (kind === 'condition') noteConditionAudible(level, episode); // v1.187.4",
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
    find: '    if (changed) this.writePoolUnknown();\n    else this.refreshPoolUnknown();',
    to: '    /* MUTANT */',
    why: 'As C-i: the next process finds nothing to carry.',
  },
  {
    id: 'C-iii. ★★ projections do not refresh the last-seen time',
    file: SN,
    find: '    else this.refreshPoolUnknown();',
    to: '    /* MUTANT */',
    why: 'A restart an hour into a wedge reads as a long outage: the critical drops to absent, then a warning.',
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
  {
    id: 'C-xii. ★★★ the poll loop does not refresh the file (a dark panel)',
    file: SN,
    find: '    // last-seen time keeps saying this process holds the onset (refreshPoolUnknown).\n    this.refreshPoolUnknown();',
    to: '    /* MUTANT */',
    why: 'A panel gone dark for an hour with its pool unknown loses its critical at the next restart, though the process held it.',
  },
  {
    id: 'C-xiii. ★★ an unconsumed entry is never pending',
    file: SN,
    find: '      if (this.snap.devices[sn] != null && carriedPoolUnknownSince(e, nowMs) != null) out.push(sn);',
    to: '      /* MUTANT */',
    why: 'The set settles before the panel\'s first projection; the carried critical returns after an all-clear.',
  },
  {
    id: 'C-xiv. ★ an unlisted panel is pending',
    file: SN,
    find: '      if (this.snap.devices[sn] != null && carriedPoolUnknownSince(e, nowMs) != null) out.push(sn);',
    to: '      if (carriedPoolUnknownSince(e, nowMs) != null) out.push(sn); /* MUTANT */',
    why: 'A panel off the account keeps the set unsettled for an hour after every restart.',
  },
  {
    id: 'C-xv. ★★ the alert monitor is not told what is pending',
    file: AM,
    find: '      poolUnknownCarryPending: store.poolUnknownCarryPending(),',
    to: '      /* MUTANT */',
    why: 'As C-xiii, through the production wiring.',
  },
  {
    id: 'C-xvi. ★★ the settled set ignores a pending carried onset',
    file: AL,
    find: "  for (const sn of connectivity.poolUnknownCarryPending ?? []) out.push(`reserve-alarm-blind ${sn} (carried onset; the panel not projected yet)`);",
    to: '  /* MUTANT */',
    why: 'As C-xiii.',
  },
  {
    id: 'C-xvii. ★★ a failed save leaves the old file',
    file: SN,
    find: '      try { unlinkSync(path); } catch { /* absent, or not removable either */ }',
    to: '      /* MUTANT */',
    why: 'A pool that reads again stays "unknown since" on file; after a restart a false critical with an inflated age.',
  },
  {
    id: 'C-xviii. ★ any episode length is believed',
    file: SN,
    find: '    if (lastSeenMs - sinceMs > POOL_UNKNOWN_MAX_EPISODE_MS) continue;',
    to: '    /* MUTANT */',
    why: 'A hand-edited or corrupt onset raises "unreadable for 20,000 days", critical, at the first projection.',
  },
  {
    id: 'C-xix. ★★★ the file is not read at construction',
    file: SN,
    find: '    // (poolUnknownCarryPending).\n    this.loadPoolUnknown();',
    to: '    // (poolUnknownCarryPending). /* MUTANT */',
    why: 'Nothing is ever carried or pending: as C-i.',
  },

  /* ── (4) a stale condition retry ──────────────────────────────────────────────────────── */
  {
    id: 'R-i. ★★★ no run-time check: the armed level is replayed whatever the condition',
    file: BR,
    find: RUN_CHECK,
    to: '        undefined, /* MUTANT */',
    why: 'A cleared red is spoken after its all-clear: the last words in the house a critical that has cleared.',
  },
  {
    id: 'R-ii. ★★★ a stale pending retry still holds the slot',
    file: BR,
    find: '    const stalePending = retryLevel != null && conditionRetryStale(retryKind, retryEpisode, conditionEpisode);',
    to: '    const stalePending = false; /* MUTANT */',
    why: 'The green that replaced the red is "kept pending" behind the red retry, which is then dropped: never retried.',
  },
  {
    id: 'R-iii. ★★ checked when the timer fires, not when the retry runs',
    file: BR,
    find: RUN_CHECK,
    to: "        ((s) => () => s)(conditionRetryStale(kind, episode, conditionEpisode) ? `a newer condition (${prevLevel ?? 'unknown'}) has been committed since` : null), /* MUTANT */",
    why: 'A retry queued behind a broadcast in flight is played after the green committed meanwhile.',
  },
  {
    id: 'R-iv. ★★ a dedicated retry is judged against the condition too',
    file: BR,
    find: "  return kind === 'condition' && armedEpisode !== currentEpisode;",
    to: '  return armedEpisode !== currentEpisode; /* MUTANT */',
    why: 'A deferred SoC-ladder or runway alarm is dropped because the condition (which excludes it) moved.',
  },
  {
    id: 'R-v. ★★ every condition retry is stale',
    file: BR,
    find: "  return kind === 'condition' && armedEpisode !== currentEpisode;",
    to: "  return kind === 'condition'; /* MUTANT */",
    why: 'A red nobody heard is never retried, even while it is still the committed condition.',
  },
  {
    id: 'R-vi. ★★ the retry\'s episode is not recorded',
    file: BR,
    find: '    retryEpisode = episode;',
    to: '    /* MUTANT */',
    why: 'Every pending condition retry reads as stale once any commit has happened: a red keeps no slot against a yellow.',
  },
  {
    id: 'R-vii. ★★★ every commit starts a new episode (a same-level one too)',
    file: BR,
    find: '    if (l !== prevLevel) {\n      conditionEpisode += 1;',
    to: '    if (true) { /* MUTANT */\n      conditionEpisode += 1;',
    why: 'A red nobody heard is dropped when a warning is spoken under it (keepRed), and its audibility is lost.',
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
