#!/usr/bin/env node
/**
 * mutate-broadcast.mjs — committed harness for v1.186.0: the broadcast pipeline's bookkeeping
 * belongs to the CONDITION (tests and dedicated announcements arm no storm gap, take no retry
 * slot and never become the restart baseline), and a PARTIAL audible channel (some, not all,
 * Music Assistant speakers usable) raises a named, debounced alert and is logged honestly.
 *
 *   node scripts/mutate-broadcast.mjs
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
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const BH = resolve(SERVER, 'src/broadcastHealth.ts');

const SUBSET = ['test/broadcastIntegrity.test.ts', 'test/edges.test.ts'];

const MUTANTS = [
  {
    // Both test exclusions in the verified-delivery block at once: either alone leaves the gate
    // shut (the gate needs lastPlayedAt AND lastConditionPlayedAt), so this is the unit that reverts.
    id: 'i. ★★★ a verified TEST arms the storm gates again',
    file: BC,
    find: '      if (kind !== \'test\') {\n        retryAttempt = 0; // verified success resets the deferred-retry budget\n        // v0.15.22 — storm gates key off VERIFIED playback only, so a failed or\n        // unverified dispatch never blocks its own deferred retries.\n        lastPlayedAt = Date.now();\n        lastPlayedLevel = level;\n        lastPlayedMessage = message;\n      }\n      // v1.186.0 — only a CONDITION delivery arms the same-level gap (see the gate constants).\n      if (kind === \'condition\') {',
    to: '      if (true) { /* MUTANT */\n        retryAttempt = 0; // verified success resets the deferred-retry budget\n        // v0.15.22 — storm gates key off VERIFIED playback only, so a failed or\n        // unverified dispatch never blocks its own deferred retries.\n        lastPlayedAt = Date.now();\n        lastPlayedLevel = level;\n        lastPlayedMessage = message;\n      }\n      // v1.186.0 — only a CONDITION delivery arms the same-level gap (see the gate constants).\n      if (kind !== \'dedicated\') {',
    why: 'A real red inside ~2 min of a red test (or queued behind it) is refused, with no retry.',
  },
  {
    id: 'ii. ★★ a dedicated announcement arms the same-level gap again',
    file: BC,
    find: '      if (kind === \'condition\') {\n        lastConditionPlayedAt = Date.now();',
    to: '      if (kind !== \'test\') { /* MUTANT */\n        lastConditionPlayedAt = Date.now();',
    why: 'A SoC-ladder red, or the consent notice, silences a DIFFERENT real alarm that follows within 2 min.',
  },
  {
    id: 'iii. ★★ any verified delivery at the level satisfies a condition\'s spoken retry',
    file: BC,
    find: '        (pendingSpokenRetry.message === undefined\n          ? kind === \'condition\'',
    to: '        (pendingSpokenRetry.message === undefined\n          ? true /* MUTANT */',
    why: 'A red test or a SoC red cancels a render-failed condition red\'s retry; its speech is never delivered.',
  },
  {
    id: 'iv. ★★ a failed TEST takes the deferred-retry slot',
    file: BC,
    find: '    if (kind === \'test\') {\n      log(`broadcast: TEST ${level} not retried',
    to: '    if (false) { /* MUTANT */\n      log(`broadcast: TEST ${level} not retried',
    why: 'A failed red test supersedes a real yellow\'s pending retry, and "This is only a test" is what replays.',
  },
  {
    id: 'v. ★★★ the restart baseline is the last broadcast of ANY kind again',
    file: BC,
    find: '  const bootBaselineLevel: ConditionLevel | null = conditionBootBaseline(persistedCondition);',
    to: '  const bootBaselineLevel: ConditionLevel | null = lastOutcome === \'success\' ? lastLevel : null; /* MUTANT */',
    why: 'After the 21:30 consent notice or a red test, a genuine new yellow after a restart is filed as a duplicate.',
  },
  {
    id: 'vi. ★★ an unheard condition level becomes the baseline',
    file: BC,
    find: '  return rec.conditionSpoken === true ? l : null;',
    to: '  return l; /* MUTANT */',
    why: 'A storm-gated / quiet-hours yellow the household never heard is never spoken after a restart.',
  },
  {
    id: 'vii. ★★ a verified TEST marks the condition heard',
    file: BC,
    find: '      if (kind === \'condition\' && !deliveryUnverified && conditionLevel === level) conditionSpoken = true;',
    to: '      if (kind !== \'dedicated\' && !deliveryUnverified && conditionLevel === level) conditionSpoken = true; /* MUTANT */',
    why: 'A yellow test over an unheard yellow warning suppresses that warning after the next restart.',
  },
  {
    id: 'viii. ★★ the post-warm-up reconciliation of the condition record is gone',
    file: BC,
    find: '      if (prevLevel != null && conditionLevel !== prevLevel) {',
    to: '      if (false) { /* MUTANT */',
    why: 'A warning that cleared while the add-on was down stays the baseline and mutes the next restart\'s new yellow.',
  },
  {
    id: 'ix. ★★★ the degraded channel is "nothing usable" again',
    file: BC,
    find: '  if (configured === 0 || usable >= configured) return { streak: 0, degraded: false };',
    to: '  if (configured === 0 || usable > 0) return { streak: 0, degraded: false }; /* MUTANT */',
    why: 'One of two speakers dark for ~27 h raises nothing — the v0.84.0 blind spot.',
  },
  {
    id: 'x. ★★ no debounce: a restart blip raises the degraded alert',
    file: BC,
    find: '  return { streak, degraded: streak >= confirm };',
    to: '  return { streak, degraded: true }; /* MUTANT */',
    why: 'Every HA/MA restart that briefly deregisters one speaker pushes a false "degraded" alert.',
  },
  {
    id: 'xi. ★★ the alert engine does not publish the degraded alert',
    file: AM,
    find: '      ...(() => { const a = broadcastDegradedAlert(getBroadcastHealth(), Date.now()); return a ? [a] : []; })(),',
    to: '      /* MUTANT */',
    why: 'The monitor knows a speaker is gone; nobody is told.',
  },
  {
    id: 'xii. ★ the broadcast log reports the configured count again',
    file: BC,
    find: "    const maTally = `${usable}/${cfg.targets.length} MA usable${preflight.unusable.length ? ` (not reached: ${preflight.unusable.join(', ')})` : ''}`;",
    to: "    const maTally = `${cfg.targets.length} MA`; /* MUTANT */",
    why: '"2 MA + 1 SIP target(s) → ok" while one of the two never played.',
  },
  {
    id: 'xiii. ★★ zero usable reads "the remaining speaker(s) still work"',
    file: BH,
    find: '  const none = h.usableTargets === 0;',
    to: '  const none = false; /* MUTANT */',
    why: 'While the unreachable alert confirms, the card reassures that speakers still work when none can play.',
  },
  {
    id: 'xiv. ★★★ degraded → dead pushes "Resolved: Audible alarm channel degraded"',
    file: AM,
    find: "  if (id === 'system-audible-degraded') {",
    to: '  if (false) { /* MUTANT */',
    why: 'A false all-clear goes out the moment the audible channel becomes completely dead.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-broadcast', mutants: MUTANTS, subset: SUBSET, root: REPO });
