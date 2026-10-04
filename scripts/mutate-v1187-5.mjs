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
 * v1.187.9 — what a condition retry SAYS when it runs is decided by the IDENTITY of the alert its
 * words name (broadcast.conditionRetryWords): the same alert replays the armed words (rendered
 * already; the cordless skipped as armed), a different one gets the tick's words and tone now and
 * re-fires the cordless after the tick's identity gates (repeat warning, red replay); a retry ahead
 * of the announcement naming that alert yields to it; an armed alert the speech gates now drop is not
 * replayed; a throw replays the armed words. A failed spoken render earns the spoken retry, and a
 * refusal by the same-level gap one re-present, never over a waiting one (refusedRetryRepresent).
 * Mutants W-i..W-xxx, against conditionRetryWords.test.ts with the subset above. v1.187.9 (review): the
 * naming pool (conditionNamePool), the repeat-warning record of a retry, the green and policy-mute
 * gates, the kept spoken retry and the kept red's re-present — W-xxxi..W-xliii; round 2: the 90 s
 * spoken retry's all-clear gate and repeat record, the kept-pending rule, the Spanish pool — W-xliv..W-xlvii.
 *
 * Not mutated (v1.187.9): `retryOf == null` and `kind === 'condition'` in the queued count (a retry
 * counted in while it waits is counted out when it runs, before it reads the count, and a dedicated
 * announcement names no alert); the dedicated retry path (it never reaches conditionRetryAtRun); the
 * all-clear speech gate's own predicate (allClearSpeechBlocked, pinned by its v1.166.0 tests).
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
  'test/conditionRetryWords.test.ts', // v1.187.9
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
    // A verified red delivery arms the same-level gap, which refuses the warning's retry anyway; the
    // guard decides what is heard when the red plays tone-only (speech stalled), which arms no gap.
    why: 'An older red retry reaching the speakers tone-only cancels the retry of a newer warning spoken under the kept red: the warning is not heard until the condition commits down to it.',
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
  /* ── v1.187.9 — what a condition retry SAYS when it runs (conditionRetryWords) ────────────────── */
  {
    id: 'W-i. ★★★ the words are rebuilt for the same alert (a reading that moved)',
    file: BR,
    find: "    if (namedFp === armedFp) return { action: 'replay' };",
    to: "    if (namedFp === armedFp && (false as boolean)) return { action: 'replay' }; /* MUTANT */",
    why: 'THE WITHDRAWN FIX: a spread moving 101 → 104 mV misses the rendered file; with speech stalled the retry plays the tone alone.',
  },
  {
    id: 'W-ii. ★★★ the armed words are replayed whatever the alert they name',
    file: BR,
    find: "    if (namedFp === armedFp) return { action: 'replay' };",
    to: "    if (namedFp === armedFp || (true as boolean)) return { action: 'replay' }; /* MUTANT */",
    why: 'THE DEFECT: A clears while C keeps the red; the retry speaks the cleared A and C is never named.',
  },
  {
    id: 'W-iii. ★★ the words are rebuilt whenever the condition is not green, at any level',
    file: BR,
    find: '  if (now.level === level) {',
    to: "  if (now.level !== 'green') { /* MUTANT */",
    why: 'A red retry under a kept red (its critical muted) is rebuilt from the warning beside it: the red nobody heard is spoken as "Critical condition detected".',
  },
  {
    id: 'W-iv. ★★ the tone of the set the retry was armed with rides the new words',
    file: BR,
    find: '      return { rung: w.rung, message: w.message, messageEs: w.messageEs, skipSip: false, named: w.namedFp, warnFps: w.warningFingerprints };', // v1.187.9 (review) — re-pointed
    to: '      return { rung: armed.rung, message: w.message, messageEs: w.messageEs, skipSip: false, named: w.namedFp, warnFps: w.warningFingerprints }; /* MUTANT */',
    why: 'C (High) is announced with the Critical tone of the cleared A: tone and words disagree.',
  },
  {
    id: 'W-v. ★★★ the cordless is skipped for words that name a different alert',
    file: BR,
    find: '      return { rung: w.rung, message: w.message, messageEs: w.messageEs, skipSip: false, named: w.namedFp, warnFps: w.warningFingerprints };', // v1.187.9 (review) — re-pointed
    to: '      return { rung: w.rung, message: w.message, messageEs: w.messageEs, skipSip: armed.skipSip, named: w.namedFp, warnFps: w.warningFingerprints }; /* MUTANT */',
    why: 'THE WITHDRAWN FIX: the cordless heard A on the first dispatch and never hears C.',
  },
  {
    id: 'W-vi. ★★ the cordless is dispatched again for the same alert',
    file: BR,
    find: "      if (w.action === 'replay') return { ...armed, warnFps: conditionFromAlerts(speakable).warningFingerprints };", // v1.187.9 (review) — re-pointed
    to: "      if (w.action === 'replay') return { ...armed, skipSip: false, warnFps: conditionFromAlerts(speakable).warningFingerprints }; /* MUTANT */",
    why: 'The cordless, which took these words on the first dispatch, plays them again at +30 s.',
  },
  {
    id: 'W-vii. ★★ the retry reads the store, not the tick\'s speakable alerts',
    file: BR,
    find: '      const w = conditionRetryWords(level, armed.named, raw, speakable);',
    to: '      const w = conditionRetryWords(level, armed.named, raw, raw); /* MUTANT */',
    why: 'A cell-imbalance warning still inside its speak hold is named through the retry.',
  },
  {
    id: 'W-viii. ★★★ an armed alert the speech gates now drop is replayed',
    file: BR,
    find: '  if (armedFp != null && raw.some((a) => alertFingerprint(a) === armedFp) && (voiced == null || policyMuted)) {', // v1.187.9 (review) — re-pointed
    to: '  if ((false as boolean) && armedFp != null && raw.some((a) => alertFingerprint(a) === armedFp) && (voiced == null || policyMuted)) { /* MUTANT */',
    why: 'A cell-imbalance warning back inside its speak hold (or silenced, or card-and-push only) is spoken by its retry.',
  },
  {
    id: 'W-ix. ★★ a green retry ignores the all-clear speech gate',
    file: BR,
    find: '    return allClearSpeechBlocked(speakable)', // v1.187.9 (review) — re-pointed
    to: '    return (false as boolean) && allClearSpeechBlocked(speakable) /* MUTANT */',
    why: '"All clear" is retried while a critical is active (the reserve floor, a held telemetry-blind alarm).',
  },
  {
    id: 'W-x. ★★ the named alert is the id, not the fingerprint',
    file: BR,
    find: '  return primary == null ? null : alertFingerprint(primary);',
    to: '  return primary == null ? null : primary.id; /* MUTANT */',
    why: 'The speech-gate check and the red replay gate compare fingerprints: neither ever matches.',
  },
  {
    id: 'W-xi. ★★★ a retry ahead of the announcement naming its new alert does not yield',
    file: BR,
    find: '      if (w.namedFp != null && (queuedConditionNames.get(queuedConditionKey(level, w.namedFp)) ?? 0) > 0) {',
    to: '      if ((false as boolean) && w.namedFp != null && (queuedConditionNames.get(queuedConditionKey(level, w.namedFp)) ?? 0) > 0) { /* MUTANT */',
    why: 'C is told by the retry and again by its own announcement, refused by the gap and re-presented two minutes later.',
  },
  {
    id: 'W-xii. ★★ a new announcement is not counted in while it waits',
    file: BR,
    find: '    if (queued != null) countQueuedCondition(queued, 1);',
    to: '    /* MUTANT */',
    why: 'As W-xi: the retry cannot see the announcement waiting behind it.',
  },
  {
    id: 'W-xiii. ★★ an announcement is never counted out',
    file: BR,
    find: '      if (queued != null) countQueuedCondition(queued, -1);',
    to: '      /* MUTANT */',
    why: 'A retry that names C is dropped for an announcement of C that ran long ago: C, standing, is not told.',
  },
  {
    id: 'W-xiv. ★★★ a throw while reading the condition drops the retry',
    file: BR,
    find: "the words it was armed with are replayed`);\n      return armed;",
    to: "the words it was armed with are replayed`);\n      return { drop: 'unreadable' }; /* MUTANT */",
    why: 'An unreadable snapshot silences a red nobody heard.',
  },
  {
    id: 'W-xv. ★★ the repeat-warning gate is not applied to new words',
    file: BR,
    find: "      if (level === 'yellow' && sameWarningRepeat(",
    to: "      if ((false as boolean) && level === 'yellow' && sameWarningRepeat( /* MUTANT */",
    why: 'A yellow retry that now names the warning voiced minutes ago repeats it.',
  },
  {
    id: 'W-xvi. ★★ the red replay gate is not applied to new words',
    file: BR,
    find: "      if (level === 'red' && redReplayGate.shouldSuppress(",
    to: "      if ((false as boolean) && level === 'red' && redReplayGate.shouldSuppress( /* MUTANT */",
    why: 'Inside the warm-up, a red retry names the critical announced before the restart, unchanged.',
  },
  {
    id: 'W-xvii. ★★ the attempt does not record the alert its words name',
    file: BR,
    find: '      attemptNamed = w.named;',
    to: '      /* MUTANT */',
    why: 'A retry is armed with no named alert: it rebuilds the same alert\'s words, misses the rendered file and repeats the cordless.',
  },
  {
    id: 'W-xviii. ★★ a transition does not pass the alert its words name',
    file: BR,
    find: "    const result = await runBroadcast(level, rung, message, false, messageEs, false, 'condition', conditionNamedFingerprint(level, alerts));",
    to: "    const result = await runBroadcast(level, rung, message, false, messageEs, false, 'condition'); /* MUTANT */",
    why: 'As W-xvii, for every retry of a transition.',
  },
  {
    id: 'W-xix. ★★ the deferred retry does not carry the alert to its run',
    file: BR,
    find: '      void runBroadcast(level, rung, message, false, messageEs, lastSipDispatchOk, kind, named,',
    to: '      void runBroadcast(level, rung, message, false, messageEs, lastSipDispatchOk, kind, null, /* MUTANT */',
    why: 'As W-xvii: every retry reads as naming a different alert.',
  },
  {
    id: 'W-xx. ★★ the re-arm forgets the alert',
    file: BR,
    find: "'play_announcement failed after in-call retries', kind, episode, generation, named);",
    to: "'play_announcement failed after in-call retries', kind, episode, generation, null); /* MUTANT */",
    why: 'As W-xvii, for a retry armed by a Music Assistant failure.',
  },
  {
    id: 'W-xxi. ★★ a spoken retry does not pass the alert it names',
    file: BR,
    find: "            stored ? 'dedicated' : 'condition', stored ? null : conditionNamedFingerprint(level, alerts));",
    to: "            stored ? 'dedicated' : 'condition', null); /* MUTANT */",
    why: 'A spoken retry the speakers miss is retried as a different alert: the cordless plays the words twice.',
  },
  {
    id: 'W-xxii. ★★ a spoken retry keeps the tone of the set its render failed on',
    file: BR,
    find: '          const result = await runBroadcast(want, stored ? wantRung : rung, message, true, messageEs, false,',
    to: '          const result = await runBroadcast(want, wantRung, message, true, messageEs, false, /* MUTANT */',
    why: 'C (High) is spoken with the Critical tone of the cleared A.',
  },
  /* ── v1.187.9 — what a condition retry leaves to the tick (afterConditionRetry) ──────────────── */
  {
    id: 'W-xxiii. ★★★ a condition retry\'s result is discarded',
    file: BR,
    find: '      if (retried) afterConditionRetry(level, w.rung, w.named, w.warnFps, result);', // v1.187.9 (review) — re-pointed
    to: '      /* MUTANT */',
    why: 'A retry whose new words cannot be rendered sounds the tone alone and the speech never follows; a refused warning waits for the commit down to it.',
  },
  {
    id: 'W-xxiv. ★★★ a retry\'s failed spoken render earns no spoken retry',
    file: BR,
    find: '    if (!kept) noteSpokenRenderFailure(level, rung, result);', // v1.187.9 (review) — re-pointed
    to: '    if (!kept && (false as boolean)) noteSpokenRenderFailure(level, rung, result); /* MUTANT */',
    why: 'Speech stalled: the retry naming C plays the tone, and C is never spoken.',
  },
  {
    id: 'W-xxv. ★★ a retry refused by the same-level gap is not re-presented',
    file: BR,
    find: '    if (represent == null) return;',
    to: '    if (represent == null || (true as boolean)) return; /* MUTANT */',
    why: 'The warning under a kept red, refused just after the red\'s retry played, waits for the condition to commit down to it.',
  },
  {
    id: 'W-xxvi. ★★★ a refused retry displaces a re-present already waiting',
    file: BR,
    find: '    if (deferredCondition != null) {\n      log(`broadcast: the refused',
    to: '    if ((false as boolean) && deferredCondition != null) { /* MUTANT */\n      log(`broadcast: the refused',
    why: 'A new critical refused by the same gap is lost behind the warning: never re-presented.',
  },
  {
    id: 'W-xxvii. ★★ any refusal or failure is re-presented',
    file: BR,
    find: "  if (errors[0] !== 'suppressed: same-or-lower level within gap' || lastPlayed.level == null) return null;",
    to: '  if (lastPlayed.level == null) return null; /* MUTANT */',
    why: 'A failing announcement re-presented after its give-up starts a fresh ladder (retried without end); heard words are repeated.',
  },
  {
    id: 'W-xxviii. ★★ a same-level refusal is re-presented whatever is counted',
    file: BR,
    find: '  return { level, dueAtMs: lastPlayed.atMs + gapMs, fresh: lower || named == null ? null : [named] };',
    to: '  return { level, dueAtMs: lastPlayed.atMs + gapMs, fresh: null }; /* MUTANT */',
    why: 'A retry refused at its own level is re-presented after the alert it named has cleared.',
  },
  {
    id: 'W-xxix. ★★ a refusal below the played level waits for its alert',
    file: BR,
    find: '  return { level, dueAtMs: lastPlayed.atMs + gapMs, fresh: lower || named == null ? null : [named] };',
    to: '  return { level, dueAtMs: lastPlayed.atMs + gapMs, fresh: named == null ? null : [named] }; /* MUTANT */',
    why: 'Below the red, the level is the news: keyed to the alert, the re-present is dropped when another warning names the level.',
  },
  {
    id: 'W-xxx. ★★ the re-present is due at once, inside the gap',
    file: BR,
    find: '  return { level, dueAtMs: lastPlayed.atMs + gapMs, fresh: lower || named == null ? null : [named] };',
    to: '  return { level, dueAtMs: lastPlayed.atMs, fresh: lower || named == null ? null : [named] }; /* MUTANT */',
    why: 'Re-presented on the next tick, the gap refuses it again, and a re-present is never re-armed: the warning is lost.',
  },
  /* ── v1.187.9 (review) — the naming pool, the repeat-warning record, the gates, the kept spoken retry, the kept red ── */
  {
    id: 'W-xxxi. ★★★ the tick\'s words name from every speakable alert, not the counted ones',
    file: BR,
    find: '    return buildAlertMessage(level, conditionNamePool(alerts));',
    to: '    return buildAlertMessage(level, alerts); /* MUTANT */',
    why: 'A yellow raised by a Grid warning is announced as "Backup pool low — 28%": an alarm the SoC ladder owns, its title a live reading.',
  },
  {
    id: 'W-xxxii. ★★★ the named identity ranks every speakable alert',
    file: BR,
    find: '  const primary = pickPrimaryAlert(conditionNamePool(alerts), level); // v1.187.9 — only an alert it counts',
    to: '  const primary = pickPrimaryAlert(alerts, level); /* MUTANT */',
    why: 'THE REVIEW\'S M1: the band\'s reading moves, the retry reads a different alert, calls the cordless again (and, with speech stalled, plays the tone alone).',
  },
  {
    id: 'W-xxxiii. ★★ rebuilt words name from every speakable alert',
    file: BR,
    find: 'buildAlertMessage(level, now.counted), messageEs: buildAlertMessageEs(level, now.counted)',
    to: 'buildAlertMessage(level, speakable), messageEs: buildAlertMessageEs(level, now.counted) /* MUTANT */',
    why: 'A rebuilt retry names a backup band in place of the warning that raised the level.',
  },
  {
    id: 'W-xxxiv. ★★ the repeat-warning gate ranks every speakable alert',
    file: BR,
    find: "pickPrimaryAlert(conditionNamePool(alerts), 'yellow') : null;",
    to: "pickPrimaryAlert(alerts, 'yellow') : null; /* MUTANT */",
    why: 'A band beside the warning voiced moments ago reads as a different warning: it is told again.',
  },
  {
    id: 'W-xxxv. ★★ the red replay fingerprint ranks every speakable alert',
    file: BR,
    find: '    const voicedFingerprint = voicedRedFingerprint(level, namePool);',
    to: '    const voicedFingerprint = voicedRedFingerprint(level, alerts); /* MUTANT */',
    why: 'After a restart a backup band beside the critical announced before it makes that critical "new": the klaxon again.',
  },
  {
    id: 'W-xxxvi. ★★★ a yellow retry that reached the speakers is not remembered',
    file: BR,
    find: '      lastVoicedWarning = { voicedFp: named, rung, warnFps: [...warnFps], atMs: Date.now() };',
    to: '      /* MUTANT */',
    why: 'THE REVIEW\'S M2: a warning named only through a rebuilt retry is told again at its flicker back.',
  },
  {
    id: 'W-xxxvii. ★★ a replayed yellow retry carries no counted warnings',
    file: BR,
    find: "      if (w.action === 'replay') return { ...armed, warnFps: conditionFromAlerts(speakable).warningFingerprints };",
    to: "      if (w.action === 'replay') return armed; /* MUTANT */",
    why: 'A warning heard through its replayed retry is told again when it returns after a silent all-clear.',
  },
  {
    id: 'W-xxxviii. ★★ a green retry checks the all-clear gate only when the condition is green',
    file: BR,
    find: '    return allClearSpeechBlocked(speakable)',
    to: "    return now.level === 'green' && allClearSpeechBlocked(speakable) /* MUTANT */",
    why: '"All clear" is retried while a counted critical has raised the level and the tick has not committed it yet.',
  },
  {
    id: 'W-xxxix. ★★ a policy mute is replayed',
    file: BR,
    find: "  const policyMuted = voiced != null && voiced.annunciate === false && !(voiced.severity === 'critical' && voiced.mutedBy != null);",
    to: '  const policyMuted = (false as boolean); /* MUTANT */',
    why: 'A bench spare marked non-annunciating after the retry was armed is spoken by it.',
  },
  {
    id: 'W-xl. ★★★ a critical held by a bounded mute is dropped as a policy mute',
    file: BR,
    find: "  const policyMuted = voiced != null && voiced.annunciate === false && !(voiced.severity === 'critical' && voiced.mutedBy != null);",
    to: '  const policyMuted = voiced != null && voiced.annunciate === false; /* MUTANT */',
    why: 'The cell-spread red nobody heard, held by the balancing mute, is never retried.',
  },
  {
    id: 'W-xli. ★★ a retry\'s render failure replaces the spoken retry already pending',
    file: BR,
    find: '    const kept = pending != null && (pending.message !== undefined', // v1.187.9 (review, round 2) — re-pointed
    to: '    const kept = (false as boolean) && pending != null && (pending.message !== undefined /* MUTANT */',
    why: 'The SoC ladder\'s or runway alarm\'s speech is replaced by the condition\'s and never delivered.',
  },
  {
    id: 'W-xlii. ★★ a deferral under a kept red is dropped while the critical reads loud',
    file: BR,
    find: '      const heldUnder = level === prevLevel && LEVEL_RANK[held.level] < LEVEL_RANK[level];',
    to: '      const heldUnder = (false as boolean) && level === prevLevel; /* MUTANT */',
    why: 'The warning refused under the kept red is lost until the condition commits down to it.',
  },
  {
    id: 'W-xliii. ★★ a re-present below the committed level ends the red\'s hold',
    file: BR,
    find: '          if (held.level === prevLevel) endDeescalationHold(',
    to: '          if ((true as boolean) || held.level === prevLevel) endDeescalationHold( /* MUTANT */',
    why: 'An abandoned de-escalation is logged under a red that still holds, the heard flag flips twice, and the hold restarts.',
  },
  /* ── v1.187.9 (review, round 2) — the 90 s spoken retry, the kept-pending rule, the Spanish pool ── */
  {
    id: 'W-xliv. ★★★ the spoken retry of an all-clear ignores the all-clear speech gate',
    file: BR,
    find: "      const allClearGated = stored == null && want === 'green' && allClearSpeechBlocked(alerts);",
    to: '      const allClearGated = (false as boolean); /* MUTANT */',
    why: '"All clear. All stations report normal." 90 s after a stalled render, while the reserve-floor critical is active.',
  },
  {
    id: 'W-xlv. ★★ a condition spoken retry pending at another level is kept over a retry\'s',
    file: BR,
    find: '      : pending.level === level);',
    to: '      : RETRY_LEVEL_RANK[pending.level] >= RETRY_LEVEL_RANK[level]); /* MUTANT */',
    why: 'The kept red\'s spoken retry is dropped at its fire (the level reads yellow), and the warning\'s speech was discarded for it: neither is spoken.',
  },
  {
    id: 'W-xlvi. ★★ the 90 s spoken retry\'s yellow is not remembered',
    file: BR,
    find: '          if (spokenNamed != null) lastVoicedWarning = { voicedFp: spokenNamed, rung, warnFps: [...warningFingerprints], atMs: Date.now() };',
    to: '          /* MUTANT */',
    why: 'A warning named by the spoken retry is told again at its flicker back.',
  },
  {
    id: 'W-xlvii. ★★ the Spanish words name from every speakable alert',
    file: BR,
    find: '    return buildAlertMessageEs(level, conditionNamePool(alerts));',
    to: '    return buildAlertMessageEs(level, alerts); /* MUTANT */',
    why: 'The bilingual pass names the backup band in Spanish while the English names the Grid warning.',
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
