#!/usr/bin/env node
/**
 * mutate-v1187-b.mjs — committed harness for v1.187.0 (announcement condition + storm gate):
 * the audible condition's de-escalation dwell with identity-based new-alert detection, the
 * repeat-warning storm gate keyed on a stable identity, the one re-present of a storm-gated
 * de-escalation, and suppressions recorded apart from the last broadcast.
 *
 * Review round (mutants xxx-xxxvii): the deferral waits while a lower level stands its dwell;
 * a same-level refusal of something new is re-presented while it is still counted; the
 * red-replay evidence is cleared when green is OBSERVED under a held level and the heard flag is
 * demoted for the hold (restored when the level comes back); the committed criticals accumulate
 * through a red episode.
 *
 * Log review 09-29 (xxxviii-xliv): a critical that sounded and is then held by a bounded
 * cell-spread mute is held, not cleared (soundedCriticalHeld): no move below red, nor to green,
 * commits until it clears or annunciates again.
 *
 * Verifier round (xlv-lii): a sounded cell-spread critical is also held between two of its
 * readings (SOUNDED_VDIFF_ABSENT_HOLD_MS from when it was last present); a critical counted under
 * a committed red is recorded on every such tick, not only at a red commit; and a new warning
 * below a held sounded critical is spoken while the red stays committed (keepRed).
 *
 *   node scripts/mutate-v1187-b.mjs
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
const BC = resolve(SERVER, 'src/broadcast.ts');

const SUBSET = [
  'test/conditionDeescalationDwell.test.ts',
  'test/stormGateRepeatAndAllClear.test.ts',
  'test/broadcastIntegrity.test.ts',
];

const MUTANTS = [
  {
    id: 'i. ★★★ the de-escalation dwell is removed',
    file: BC,
    find: '    if (downward && !newWarn && (!lowerDue || (recoveryCandidate && !recovery))) {',
    to: '    if (false /* MUTANT */) {',
    why: 'A warning flickering warning↔info speaks "All clear" while it stands (2026-09-29 15:20:51).',
  },
  {
    id: 'ii. ★★★ newCrit is count-only again',
    file: BC,
    find: "    const newCrit = level === 'red' && (crit > prevCrit || hasNewIdentity(criticalFingerprints, prevCritFps));",
    to: "    const newCrit = level === 'red' && crit > prevCrit; /* MUTANT */",
    why: 'A different critical replacing a cleared one inside the red hold, at the same count, is never announced.',
  },
  {
    id: 'iii. ★★★ a new warning waits out the dwell',
    file: BC,
    find: '    const newWarn = level === \'yellow\' && (downward || deescalationHold != null)\n      && hasNewIdentity(warningFingerprints, prevWarnFps);',
    to: '    const newWarn = false as boolean; /* MUTANT */',
    why: 'A warning nobody has heard is delayed up to 3 minutes behind a clearing condition.',
  },
  {
    id: 'iv. ★★ a new warning inside a held yellow→green is not new',
    file: BC,
    find: '(downward || deescalationHold != null)',
    to: '(downward /* MUTANT */)',
    why: 'A different warning appearing as the old one clears is never spoken: the level reads unchanged.',
  },
  {
    id: 'v. ★★ green commits on below-red time, not on green time',
    file: BC,
    find: "  if (observed === 'green') return greenSinceMs != null && nowMs - greenSinceMs >= dwellMs;",
    to: "  if (observed === 'green') return belowRedSinceMs != null && nowMs - belowRedSinceMs >= dwellMs; /* MUTANT */",
    why: 'A yellow↔green flicker below a cleared red speaks a false all-clear.',
  },
  {
    id: 'vi. ★★ red → yellow commits at once',
    file: BC,
    find: "  if (observed === 'yellow') return belowRedSinceMs != null && nowMs - belowRedSinceMs >= dwellMs;",
    to: "  if (observed === 'yellow') return true; /* MUTANT */",
    why: 'A critical flickering to its warning re-speaks a yellow on every dip.',
  },
  {
    id: 'vii. ★★ the green clock survives a return to yellow',
    file: BC,
    find: "    if (level !== 'green' || critHeld) greenSinceMs = null;",
    to: "    if (false) greenSinceMs = null; /* MUTANT */",
    why: 'Short greens accumulate across flickers until one of them speaks the all-clear.',
  },
  {
    id: 'viii. ★★ the below-red clock survives a red',
    file: BC,
    find: "    if (level === 'red' || critHeld) belowRedSinceMs = null;",
    to: "    if (false) belowRedSinceMs = null; /* MUTANT */",
    why: 'Time before the red counts toward its clearing: red → yellow commits at once.',
  },
  {
    id: 'ix. ★★ the hold is cleared before a new warning commits',
    file: BC,
    find: '    if (!downward && !newWarn && deescalationHold != null) {',
    to: '    if (!downward && deescalationHold != null) { /* MUTANT */',
    why: 'A new warning held by the boot yellow confirmation reads as "no transition" next tick and is never spoken.',
  },
  {
    id: 'x. ★★★ the committed criticals are not recorded',
    file: BC,
    find: "    prevCritFps = l === 'red' && prevLevel === 'red' ? new Set([...prevCritFps, ...ids.crit]) : new Set(ids.crit);",
    to: '    /* MUTANT */',
    why: 'Every standing critical reads as new: a critical flickering inside the dwell re-klaxons.',
  },
  {
    id: 'xi. ★★ the committed warnings are not recorded',
    file: BC,
    find: '    prevWarnFps = new Set(ids.warn);',
    to: '    /* MUTANT */',
    why: 'Every standing warning reads as new: the dwell no longer absorbs a flicker.',
  },
  {
    id: 'xii. ★★★ identity never reads as new',
    file: BC,
    find: '  return current.some((f) => !known.has(f));',
    to: '  return false; /* MUTANT */',
    why: 'Replacement criticals and new warnings are held or lost.',
  },
  {
    id: 'xiii. ★★★ the repeat-warning gate is off',
    file: BC,
    find: '    if (warning != null && sameWarningRepeat(warning, lastVoicedWarning, Date.now())) {',
    to: '    if (false /* MUTANT */) {',
    why: 'The same warning is re-spoken with each new reading once the 2-minute gap lapses (15:16, 15:21, 15:26).',
  },
  {
    id: 'xiv. ★★★ a spoken green or red does not end the repeat memory',
    file: BC,
    find: "    if (kind === 'condition' && level !== 'yellow') lastVoicedWarning = null;",
    to: '    /* MUTANT */',
    why: 'After a spoken all-clear the returning warning is suppressed: "All clear" is the last word while it stands.',
  },
  {
    id: 'xv. ★★ the repeat gate ignores a new warning beside the named one',
    file: BC,
    find: '  return current.warnFps.every((f) => last.warnFps.includes(f));',
    to: '  return true; /* MUTANT */',
    why: 'A warning nobody has heard is swallowed behind one they have.',
  },
  {
    id: 'xvi. ★★ the repeat gate ignores which alert is named, and the tone',
    file: BC,
    find: '  if (current.voicedFp !== last.voicedFp || current.rung !== last.rung) return false;',
    to: '  /* MUTANT */',
    why: 'A different warning is suppressed as a repeat of the last one.',
  },
  {
    id: 'xvii. ★★ the repeat gate never lapses',
    file: BC,
    find: '  if (nowMs < last.atMs || nowMs - last.atMs >= gapMs) return false;',
    to: '  /* MUTANT */',
    why: 'A warning standing for hours is never re-announced after an unspoken clear.',
  },
  {
    id: 'xviii. ★★ an unheard yellow is remembered as voiced',
    file: BC,
    find: '    if (warning != null && warning.voicedFp != null && result.ok) {',
    to: '    if (warning != null && warning.voicedFp != null) { /* MUTANT */',
    why: 'A warning that never reached the speakers suppresses its own repeat.',
  },
  {
    id: 'xix. ★★★ a storm-gated de-escalation is not re-presented',
    file: BC,
    find: '      mayDefer\n      && result.errors[0]',
    to: '      false /* MUTANT */\n      && result.errors[0]',
    why: 'The refused all-clear is lost: the last words stay a critical that has cleared (15:41:10).',
  },
  {
    id: 'xx. ★★ the re-present ignores that the condition moved',
    file: BC,
    find: '          level !== held.level ? `the condition is ${level} now`',
    to: '          false ? `the condition is ${level} now` /* MUTANT */',
    why: 'A held yellow is spoken over a green that is standing its own dwell.',
  },
  {
    id: 'xxi. ★★★ the re-present bypasses the all-clear speech gate',
    file: BC,
    find: "          : held.level === 'green' && allClearSpeechBlocked(alerts) ? 'a critical alert is still active'",
    to: "          : false ? 'a critical alert is still active' /* MUTANT */",
    why: '"All clear" is spoken while a critical is active.',
  },
  {
    id: 'xxii. ★★ the re-present ignores quiet hours',
    file: BC,
    find: "          : inQuiet() && !(held.level === 'red' && cfg.criticalBreakThrough) ? 'quiet hours' : null;",
    to: '          : null; /* MUTANT */',
    why: 'A deferred all-clear wakes the house overnight.',
  },
  {
    id: 'xxiii. ★★★ a newer commit does not supersede the held re-present',
    file: BC,
    find: '    deescalationHold = null;\n    deferredCondition = null;',
    to: '    deescalationHold = null; /* MUTANT */',
    why: 'A stale all-clear is spoken while a newer red is being held for its own dwell.',
  },
  {
    id: 'xxiv. ★★ a condition suppression is stamped as the last broadcast',
    file: BC,
    find: '    if (!isStormSuppression(result)) {',
    to: '    if (true /* MUTANT */) {',
    why: '/api/broadcast/status reports a green "partial" that never played (15:41:10).',
  },
  {
    id: 'xxv. ★★ a dedicated suppression is stamped as the last broadcast',
    file: BC,
    find: '        if (!isStormSuppression(r)) {',
    to: '        if (true /* MUTANT */) {',
    why: 'A refused SoC-ladder announcement becomes the last broadcast, outcome partial.',
  },
  {
    id: 'xxvi. ★★ any failure reads as a suppression',
    file: BC,
    find: "  return result.errors.length > 0 && result.errors.every((e) => e.startsWith('suppressed:'));",
    to: '  return result.errors.length > 0; /* MUTANT */',
    why: 'A real delivery failure is hidden from lastOutcome.',
  },
  {
    id: 'xxvii. ★★ a same-level suppression is not recorded',
    file: BC,
    find: "          noteSuppression(level, kind, 'same-or-lower level within gap'); // v1.187.0",
    to: '          /* MUTANT */',
    why: 'The refusal leaves no trace beside the count.',
  },
  {
    id: 'xxviii. ★★ the dwell is not the push path\'s 3 minutes',
    file: BC,
    find: 'export const CONDITION_CLEAR_DWELL_MS = 3 * 60_000;',
    to: 'export const CONDITION_CLEAR_DWELL_MS = 60_000; /* MUTANT */',
    why: 'A 1-minute dwell no longer covers the ~3-min sibling cadence behind the flicker.',
  },
  {
    id: 'xxix. ★ the repeat window is not 30 minutes',
    file: BC,
    find: 'export const SAME_WARNING_REPEAT_GAP_MS = 30 * 60_000;',
    to: 'export const SAME_WARNING_REPEAT_GAP_MS = 24 * 60 * 60_000; /* MUTANT */',
    why: 'A standing warning after an unspoken clear is effectively never re-announced.',
  },
  {
    id: 'xxx. ★★★ review: a deferral is dropped while a lower level stands its dwell',
    file: BC,
    find: '      if (LEVEL_RANK[level] < LEVEL_RANK[held.level]) {',
    to: '      if (false /* MUTANT */) {',
    why: 'A new warning refused by the gap, green at the due tick, then back: never spoken while it stands; the last words stay a cleared critical.',
  },
  {
    id: 'xxxi. ★★ review: a same-level refusal of something new is not deferred',
    file: BC,
    find: '      if (lower || ids.fresh.length > 0) {',
    to: '      if (lower /* MUTANT */) {',
    why: 'A new warning (or a different critical) refused by the same-level gap is never voiced.',
  },
  {
    id: 'xxxii. ★★ review: a same-level re-present ignores that what was new has gone',
    file: BC,
    find: "          : held.fresh != null && !held.fresh.some((f) => counted.includes(f)) ? 'what was new to it is no longer counted'",
    to: "          : false ? 'what was new to it is no longer counted' /* MUTANT */",
    why: 'The critical heard 2 min ago is repeated for a replacement that has already cleared.',
  },
  {
    id: 'xxxiii. ★★ review: a red re-present is silenced by quiet hours despite the breakthrough',
    file: BC,
    find: "          : inQuiet() && !(held.level === 'red' && cfg.criticalBreakThrough) ? 'quiet hours' : null;",
    to: "          : inQuiet() ? 'quiet hours' : null; /* MUTANT */",
    why: 'A refused critical is never re-presented overnight although criticals are set to break through.',
  },
  {
    id: 'xxxiv. ★★★ review: the red-replay evidence survives an observed green',
    file: BC,
    find: "      if (level === 'green' && redReplayGate.state() != null) {",
    to: '      if (false /* MUTANT */) {',
    why: 'A restart inside the dwell boots on the evidence: the same critical re-raising is muted as already announced.',
  },
  {
    id: 'xxxv. ★★ review: the heard flag is not demoted for the hold',
    file: BC,
    find: '        if (conditionSpoken) {',
    to: '        if (false /* MUTANT */) {',
    why: 'A restart inside the dwell boots on "red, heard" and swallows a standing yellow as a continuation.',
  },
  {
    id: 'xxxvi. ★★ review: the heard flag is not restored when the hold is abandoned',
    file: BC,
    find: '    if (restoreHeard && h.heard && conditionLevel === h.from && !conditionSpoken) {',
    to: '    if (false /* MUTANT */) {',
    why: 'Every absorbed flicker costs the restart continuation its baseline: the standing warning is re-spoken after a restart.',
  },
  {
    id: 'xxxvii. ★★ review: the committed criticals are replaced, not accumulated, through a red episode',
    file: BC,
    find: "    prevCritFps = l === 'red' && prevLevel === 'red' ? new Set([...prevCritFps, ...ids.crit]) : new Set(ids.crit);",
    to: '    prevCritFps = new Set(ids.crit); /* MUTANT */',
    why: 'A critical whose fault code alternates re-sounds the klaxon on every flip once the 2-min gap lapses.',
  },
  /* ── log review 09-29: a critical that sounded and is then held by a bounded mute ── */
  {
    id: 'xxxviii. ★★★ the tick ignores a sounded critical held by a bounded cell-spread mute',
    file: BC,
    find: '    const critHeld = soundedCriticalHeld(alerts, soundedCritFps, tickNow);',
    to: '    const critHeld = false as boolean; /* MUTANT */',
    why: '"All clear" is spoken between two critical klaxons for the same pack while its card is open.',
  },
  {
    id: 'xxxix. ★★★ the green clock runs under a held sounded critical',
    file: BC,
    find: "    if (level !== 'green' || critHeld) greenSinceMs = null;",
    to: "    if (level !== 'green') greenSinceMs = null; /* MUTANT */",
    why: 'As xxxviii: the green commits after the dwell and the all-clear is spoken.',
  },
  {
    id: 'xl. ★★ the below-red clock runs under a held sounded critical',
    file: BC,
    find: "    if (level === 'red' || critHeld) belowRedSinceMs = null;",
    to: "    if (level === 'red') belowRedSinceMs = null; /* MUTANT */",
    why: 'A warning that stood with the critical is committed as the condition below a red that is only held.',
  },
  {
    id: 'xli. ★★★ a red commit does not record what sounded',
    file: BC,
    find: "    if (l === 'red') for (const f of ids.crit) soundedCritFps.set(f, Date.now());",
    to: '    /* MUTANT */',
    why: 'As xxxviii: nothing is ever held.',
  },
  {
    id: 'xlii. ★★ what sounded is never forgotten',
    file: BC,
    find: '    else sounded.delete(f);',
    to: '    else { /* MUTANT */ }',
    why: 'A critical that cleared and returns muted, never heard in its new episode, withholds every later all-clear.',
  },
  {
    id: 'xliii. ★★ any bounded-muted critical holds, sounded or not',
    file: BC,
    find: "  return betweenReadings || alerts.some((a) => a.severity === 'critical' && a.mutedBy != null && sounded.has(alertFingerprint(a)));",
    to: "  return betweenReadings || alerts.some((a) => a.severity === 'critical' && a.mutedBy != null); /* MUTANT */",
    why: 'Every top-of-charge knee (muted from its first reading, never heard) withholds the all-clear after an unrelated warning.',
  },
  {
    id: 'xliv. ★ a policy mute holds like a bounded one',
    file: BC,
    find: "  return betweenReadings || alerts.some((a) => a.severity === 'critical' && a.mutedBy != null && sounded.has(alertFingerprint(a)));",
    to: "  return betweenReadings || alerts.some((a) => a.severity === 'critical' && (a as { annunciate?: boolean }).annunciate === false && sounded.has(alertFingerprint(a))); /* MUTANT */",
    why: 'A Core moved off the panel roster after its critical sounded withholds the all-clear for as long as its card stands.',
  },
  /* ── verifier round: between readings, an uncommitted return, a new warning below the hold ── */
  {
    id: 'xlv. ★★★ a sounded cell-spread critical is released the tick it is absent (no absent hold)',
    file: BC,
    find: "    else if (f.startsWith('vdiff-crit-') && nowMs - lastPresentMs < absentHoldMs) betweenReadings = true;",
    to: '    else if (false /* MUTANT */) betweenReadings = true;',
    why: 'A spread loud on alternate BMS readings commits green between them: 8 klaxons and 7 all-clears in 8 cycles.',
  },
  {
    id: 'xlvi. ★★ the absent hold covers every critical, not only a cell-spread one',
    file: BC,
    find: "f.startsWith('vdiff-crit-') && nowMs - lastPresentMs < absentHoldMs",
    to: '/* MUTANT */ nowMs - lastPresentMs < absentHoldMs',
    why: 'Every cleared critical (an inverter fault, an overvoltage) waits 7 extra minutes for its all-clear; a storm-gated one is never re-presented.',
  },
  {
    id: 'xlvii. ★★ the last-present tick is not refreshed while a sounded critical is present',
    file: BC,
    find: '    if (present.has(f)) sounded.set(f, nowMs);',
    to: '    if (present.has(f)) { /* MUTANT */ }',
    why: 'A critical held muted for longer than the absent hold is released the moment it is next absent — the all-clear comes between its readings.',
  },
  {
    id: 'xlviii. ★★ the absent hold is shorter than one missed BMS reading',
    file: BC,
    find: 'export const SOUNDED_VDIFF_ABSENT_HOLD_MS = 7 * 60_000;',
    to: 'export const SOUNDED_VDIFF_ABSENT_HOLD_MS = 3 * 60_000; /* MUTANT */',
    why: 'A single missed reading (360 s absent) lets green commit and the all-clear be spoken between two klaxons.',
  },
  {
    id: 'xlix. ★★★ a critical counted under a committed red is recorded only at a red commit',
    file: BC,
    find: "    if (level === 'red' && prevLevel === 'red') for (const f of criticalFingerprints) soundedCritFps.set(f, tickNow);",
    to: '    /* MUTANT */',
    why: 'A critical that clears, is released, and comes back loud inside the green dwell (absorbed — nothing commits) is never recorded: its next mute speaks the all-clear.',
  },
  {
    id: 'l. ★★★ a new warning below a held sounded critical commits yellow',
    file: BC,
    find: "    const keepRed = critHeld && level !== 'red' && prevLevel === 'red';",
    to: '    const keepRed = false as boolean; /* MUTANT */',
    why: 'The red episode ends under a critical that is only held; its next loud reading is a new red and sounds the klaxon again.',
  },
  {
    id: 'li. ★★ a kept red commits the yellow tick\'s critical count',
    file: BC,
    find: "    adoptLevel(keepRed ? 'red' : level, keepRed ? prevCrit : crit, ids);",
    to: "    adoptLevel(keepRed ? 'red' : level, crit, ids); /* MUTANT */",
    why: 'The kept red records 0 criticals, so the held critical annunciating again is a count increase — a second klaxon.',
  },
  {
    id: 'lii. ★ the restart continuation commits the yellow below a held sounded critical',
    file: BC,
    find: "      adoptLevel(keepRed ? 'red' : level, keepRed ? prevCrit : crit, ids, !keepRed);",
    to: '      adoptLevel(level, crit, ids, true); /* MUTANT */',
    why: 'Inside the boot warm-up a new warning that continues the heard baseline ends the red episode under a critical that is only held.',
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
console.log(`mutate-v1187-b: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
