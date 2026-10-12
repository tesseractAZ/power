#!/usr/bin/env node
/**
 * mutate-v1187-20b.mjs — v1.187.20: the host-pressure WARNING raises the audible condition only
 * after it has stood its dwell (HOST_PRESSURE_WARN_DWELL_MS, 300 s); card and push at once.
 *
 *   H-i     the warning dwell is removed (audible on the first non-ok assessment)
 *   H-ii    computeAlerts drops the gate (the warning audible immediately)
 *   H-iii   the dwell is applied to the critical instead of the warning
 *   H-iv    the critical is held by the warning dwell as well
 *   H-v     a sustained critical no longer latches the warning audible
 *   H-vi    no latch at all (audible re-derived from the clock each tick)
 *   H-vii   computeAlerts' ok branch no longer resets the warning's episode
 *   H-viii  the holder's ok branch keeps the latch
 *   H-ix    the holder's ok branch keeps the episode clock
 *   H-x     the episode clock restarts on every tick (never audible)
 *   H-xi    the default dwell is the crit's 180 s
 *   H-xii   an empty HOST_PRESSURE_WARN_DWELL_S reads as 0 (audible at once)
 *   H-xiii  an unsustained crit spike latches the warning audible
 *   H-xiv   the gate is short-circuited by a sustained critical (the latch is never set while red)
 *   H-xv    the card no longer says the warning is held off the speakers
 *   H-xvi   the held warning is annunciate:false (drops the push too) instead of audible:false
 *
 * v1.187.20 (review) — an audible episode ends only once ok has stood the clear window:
 *   H-xvii  an audible episode ends on the first ok (no clear window)
 *   H-xviii every ok evaluation restarts the clear window (an audible episode never ends)
 *   H-xix   a return inside the window does not close it (the next dip is timed from the first)
 *   H-xx    the clear window is shorter than the broadcast's clear dwell
 *   H-xxi   the clear window holds an episode that never became audible too
 *   H-xxii  the last-held time stops moving inside the clear window
 * v1.187.20 (review) — the episode survives a restart (host-pressure-state.json):
 *   H-xxiii the monitor does not restore the episode at start-up
 *   H-xxiv  the monitor does not persist the episode
 *   H-xxv   the first assessment after a restart does not resume the carried episode
 *   H-xxvi  only the onset is carried, not the audible latch
 *   H-xxvii the carry ignores its gap at the assessment
 *   H-xxviii the start-up restore carries an episode older than the window
 *   H-xxix  a pass with no assessment yet (vitals null) consumes the carry as an ok
 *   H-xxx   debouncedOnsetsPending does not list a carried episode not resumed yet
 *   H-xxxi  the monitor does not hand the carry to debouncedOnsetsPending
 *   H-xxxii a carry not resumed yet is cleared from the file (lost on a second restart)
 *   H-xxxiii the last-held time is never refreshed while the episode stands
 *   H-xxxiv the episode is written on every evaluation (no persist grain)
 *
 *   node scripts/mutate-v1187-20b.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALERTS = resolve(REPO, 'server/src/alerts.ts');
const MONITOR = resolve(REPO, 'server/src/alertMonitor.ts');
const SUBSET = [
  'test/hostPressureWarnDwell.test.ts',
  'test/hostPressureWarnBroadcast.test.ts',
  'test/hostPressureDwell.test.ts',
  'test/hostPressureWarnCarry.test.ts',
  'test/hostPressureWarnRestart.test.ts',
];

const MUTANTS = [
  {
    id: 'H-i. ★★★ the warning dwell is removed',
    file: ALERTS,
    find: '  if (critSustained || now - hostPressureSinceMs >= HOST_PRESSURE_WARN_DWELL_MS) hostPressureWarnAudibleLatched = true;',
    to: '  hostPressureWarnAudibleLatched = true; /* MUTANT */',
    why: 'A 59 s Core-update blip speaks a yellow again (2026-10-10 22:33).',
  },
  {
    id: 'H-ii. ★★★ computeAlerts drops the gate: the warning is audible immediately',
    file: ALERTS,
    find: '      ...(crit || warnAudible ? {} : { audible: false }),',
    to: '      /* MUTANT */',
    why: 'The held warning counts toward the audible condition on its first assessment.',
  },
  {
    id: 'H-iii. ★★★ the dwell is applied to the critical instead of the warning',
    file: ALERTS,
    find: "    const warnAudible = hostPressureWarnAudible(vitals.level, crit, now);\n    out.push({\n      id: crit ? 'host-pressure-crit' : 'host-pressure-warn',\n      severity: crit ? 'critical' : 'warning',\n      ...(crit || warnAudible ? {} : { audible: false }),",
    to: "    const warnAudible = hostPressureWarnAudible(vitals.level, false, now); /* MUTANT */\n    out.push({\n      id: crit ? 'host-pressure-crit' : 'host-pressure-warn',\n      severity: crit ? 'critical' : 'warning',\n      ...(!crit || warnAudible ? {} : { audible: false }),",
    why: 'The blip speaks a yellow and a sustained critical stays silent until 300 s.',
  },
  {
    id: 'H-iv. ★★★ the critical is held by the warning dwell as well',
    file: ALERTS,
    find: "hostPressureWarnAudible(vitals.level, crit, now);\n    out.push({\n      id: crit ? 'host-pressure-crit' : 'host-pressure-warn',\n      severity: crit ? 'critical' : 'warning',\n      ...(crit || warnAudible",
    to: "hostPressureWarnAudible(vitals.level, false, now); /* MUTANT */\n    out.push({\n      id: crit ? 'host-pressure-crit' : 'host-pressure-warn',\n      severity: crit ? 'critical' : 'warning',\n      ...(warnAudible",
    why: 'The red waits 300 s instead of the critical\'s own 180 s dwell.',
  },
  {
    id: 'H-v. ★★ a sustained critical no longer latches the warning audible',
    file: ALERTS,
    find: '  if (critSustained || now - hostPressureSinceMs >= HOST_PRESSURE_WARN_DWELL_MS) hostPressureWarnAudibleLatched',
    to: '  if (now - hostPressureSinceMs >= HOST_PRESSURE_WARN_DWELL_MS) /* MUTANT */ hostPressureWarnAudibleLatched',
    why: 'A red that de-escalates to the warning inside 300 s goes red → green → yellow.',
  },
  {
    id: 'H-vi. ★★ no latch: audible re-derived from the clock each tick',
    file: ALERTS,
    find: '  return hostPressureWarnAudibleLatched;\n}',
    to: '  return critSustained || now - hostPressureSinceMs >= HOST_PRESSURE_WARN_DWELL_MS; /* MUTANT */\n}',
    why: 'After a sustained critical steps down to the warning, the warning goes silent again.',
  },
  {
    id: 'H-vii. ★★★ computeAlerts\' ok branch no longer resets the warning\'s episode',
    file: ALERTS,
    find: "if (vitals) hostPressureWarnAudible('ok', false, now);",
    to: '/* MUTANT */',
    why: 'After one sustained episode every later blip is audible at once.',
  },
  {
    id: 'H-viii. ★★ the holder\'s ok branch keeps the latch',
    file: ALERTS,
    find: '    hostPressureSinceMs = null;\n    hostPressureWarnAudibleLatched = false;\n',
    to: '    hostPressureSinceMs = null; /* MUTANT */\n',
    why: 'The dwell does not reset after recovery: the next blip speaks.',
  },
  {
    id: 'H-ix. ★★ the holder\'s ok branch keeps the episode clock',
    file: ALERTS,
    find: '    hostPressureSinceMs = null;\n    hostPressureWarnAudibleLatched',
    to: '    /* MUTANT */\n    hostPressureWarnAudibleLatched',
    why: 'A later episode is timed from an earlier one\'s onset and speaks at once.',
  },
  {
    id: 'H-x. ★★ the episode clock restarts on every tick',
    file: ALERTS,
    find: '  hostPressureSinceMs ??= now;',
    to: '  hostPressureSinceMs = now; /* MUTANT */',
    why: 'Sustained pressure is never announced.',
  },
  {
    id: 'H-xi. ★★ the default dwell is the crit\'s 180 s',
    file: ALERTS,
    find: '  return Number.isFinite(v) && v >= 0 && v <= 900 ? v * 1000 : 300_000;',
    to: '  return Number.isFinite(v) && v >= 0 && v <= 900 ? v * 1000 : 180_000; /* MUTANT */',
    why: 'Five of the 33 recorded warning episodes (180-256 s) are spoken.',
  },
  {
    id: 'H-xii. ★ an empty HOST_PRESSURE_WARN_DWELL_S reads as 0',
    file: ALERTS,
    find: "  const v = raw == null || raw.trim() === '' ? NaN : Number(raw);",
    to: '  const v = Number(raw); /* MUTANT */',
    why: 'An empty option silently restores the immediate yellow.',
  },
  {
    id: 'H-xiii. ★★ an unsustained crit spike latches the warning audible',
    file: ALERTS,
    find: '    const warnAudible = hostPressureWarnAudible(vitals.level, crit, now);',
    to: "    const warnAudible = hostPressureWarnAudible(vitals.level, vitals.level === 'crit', now); /* MUTANT */",
    why: 'A one-minute crit spike speaks a yellow before the critical\'s own dwell.',
  },
  {
    id: 'H-xiv. ★★ the gate is short-circuited by a sustained critical',
    file: ALERTS,
    find: '    const warnAudible = hostPressureWarnAudible(',
    to: '    const warnAudible = crit || hostPressureWarnAudible( /* MUTANT */',
    why: 'The latch is never set while red, so the step down to the warning reads green.',
  },
  {
    id: 'H-xv. ★ the card no longer says the warning is held off the speakers',
    file: ALERTS,
    find: ' Not announced on the speakers unless the pressure lasts ${hostPressureDwellText(HOST_PRESSURE_WARN_DWELL_MS)}.',
    to: ' /* MUTANT */',
    why: 'The card reads as an announced alarm while it is held.',
  },
  {
    id: 'H-xvi. ★★ the held warning is annunciate:false instead of audible:false',
    file: ALERTS,
    find: '? {} : { audible: false }),',
    to: '? {} : { annunciate: false }), /* MUTANT */',
    why: 'The held warning loses its push too: pressure is on no channel for five minutes.',
  },

  /* ── v1.187.20 (review) — the clear window ── */
  {
    id: 'H-xvii. ★★★ an audible episode ends on the first ok (no clear window)',
    file: ALERTS,
    find: '      if (now - hostPressureOkSinceMs < HOST_PRESSURE_LATCH_CLEAR_MS) { hostPressureHeldAtMs = now; return false; }',
    to: '      /* MUTANT */',
    why: 'One ok assessment during sustained pressure: "All clear" with the warning back on the card, then a second yellow (the review replay).',
  },
  {
    id: 'H-xviii. ★★ every ok evaluation restarts the clear window',
    file: ALERTS,
    find: '      hostPressureOkSinceMs ??= now;',
    to: '      hostPressureOkSinceMs = now; /* MUTANT */',
    why: 'An audible episode never ends: every later blip is audible at once.',
  },
  {
    id: 'H-xix. ★★ a return inside the window does not close it',
    file: ALERTS,
    find: '  hostPressureOkSinceMs = null;\n  hostPressureSinceMs ??= now;',
    to: '  /* MUTANT */\n  hostPressureSinceMs ??= now;',
    why: 'A second dip is timed from the first one\'s ok: the episode ends inside the flicker guard.',
  },
  {
    id: 'H-xx. ★★ the clear window is shorter than the broadcast\'s clear dwell',
    file: ALERTS,
    find: 'export const HOST_PRESSURE_LATCH_CLEAR_MS = 3 * 60_000;',
    to: 'export const HOST_PRESSURE_LATCH_CLEAR_MS = 2 * 60_000; /* MUTANT */',
    why: 'A dip of 2-3 minutes ends the episode while the broadcast still holds its green: the all-clear comes back.',
  },
  {
    id: 'H-xxi. ★★ the clear window holds an episode that never became audible too',
    file: ALERTS,
    find: '    if (hostPressureWarnAudibleLatched) {\n      hostPressureOkSinceMs ??= now;',
    to: '    { /* MUTANT */\n      hostPressureOkSinceMs ??= now;',
    why: 'Two held blips with one ok between them add up and speak a yellow.',
  },
  {
    id: 'H-xxii. ★ the last-held time stops moving inside the clear window',
    file: ALERTS,
    find: '{ hostPressureHeldAtMs = now; return false; }',
    to: '{ return false; } /* MUTANT */',
    why: 'A restart inside the clear window is judged from the last non-ok assessment, not from when the episode was last held.',
  },

  /* ── v1.187.20 (review) — the episode across a restart ── */
  {
    id: 'H-xxiii. ★★★ the monitor does not restore the episode at start-up',
    file: MONITOR,
    find: 'let hostPressureOnDisk = restoreHostPressureEpisode(hostPressureStatePath, Date.now(), log);',
    to: "let hostPressureOnDisk = restoreHostPressureEpisode(hostPressureStatePath + '.MUTANT', Date.now(), log);",
    why: 'A restart during a heard yellow: "All clear", then the yellow again (the review replay).',
  },
  {
    id: 'H-xxiv. ★★★ the monitor does not persist the episode',
    file: MONITOR,
    find: '    hostPressureOnDisk = persistHostPressureEpisode(hostPressureStatePath, hostPressureOnDisk);',
    to: '    /* MUTANT */',
    why: 'Nothing on file: the next process starts the dwell again.',
  },
  {
    id: 'H-xxv. ★★★ the first assessment after a restart does not resume the carried episode',
    file: ALERTS,
    find: '      hostPressureSinceMs = Math.min(carried.sinceMs, now);\n      hostPressureWarnAudibleLatched = carried.latched;',
    to: '      /* MUTANT */',
    why: 'The heard warning is held again for its full dwell after every restart.',
  },
  {
    id: 'H-xxvi. ★★ only the onset is carried, not the audible latch',
    file: ALERTS,
    find: '      hostPressureWarnAudibleLatched = carried.latched;',
    to: '      /* MUTANT */',
    why: 'A fresh process reads its first assessment ok (no hysteresis): the episode ends and the returning pressure is held 300 s.',
  },
  {
    id: 'H-xxvii. ★★ the carry ignores its gap at the assessment',
    file: ALERTS,
    find: 'now - carried.heldAtMs <= HOST_PRESSURE_CARRY_MAX_GAP_MS',
    to: 'true /* MUTANT */',
    why: 'An episode last seen long ago is resumed by an assessment that comes after a stalled boot.',
  },
  {
    id: 'H-xxviii. ★★ the start-up restore carries an episode older than the window',
    file: ALERTS,
    find: '  if (nowMs - ep.heldAtMs > HOST_PRESSURE_CARRY_MAX_GAP_MS) {',
    to: '  if (nowMs - ep.heldAtMs > 1000 * HOST_PRESSURE_CARRY_MAX_GAP_MS) { /* MUTANT */',
    why: 'A stale episode keeps the alert set unsettled and is never cleared from the file.',
  },
  {
    id: 'H-xxix. ★★★ a pass with no assessment yet consumes the carry as an ok',
    file: ALERTS,
    find: '    if (vitals) hostPressureWarnAudible(',
    to: '    hostPressureWarnAudible( /* MUTANT */',
    why: 'The first minute after a boot (vitals null) ends a carried episode: pressure across restarts is never announced.',
  },
  {
    id: 'H-xxx. ★★ debouncedOnsetsPending does not list a carried episode not resumed yet',
    file: ALERTS,
    find: "out.push('host-pressure (carried episode; not assessed since the restart)');",
    to: '{ /* MUTANT */ }',
    why: 'A stalled first assessment: the set settles on a green that is only the missing assessment.',
  },
  {
    id: 'H-xxxi. ★★ the monitor does not hand the carry to debouncedOnsetsPending',
    file: MONITOR,
    find: '      hostPressureCarriedHeldAtMs: hostPressureCarryPendingHeldAt(),',
    to: '      hostPressureCarriedHeldAtMs: null, /* MUTANT */',
    why: 'The pending rule exists but never fires in production.',
  },
  {
    id: 'H-xxxii. ★★ a carry not resumed yet is cleared from the file',
    file: ALERTS,
    find: '    : hostPressureCarried;',
    to: '    : null; /* MUTANT */',
    why: 'A second restart before the first assessment loses the episode.',
  },
  {
    id: 'H-xxxiii. ★ the last-held time is never refreshed while the episode stands',
    file: ALERTS,
    find: ' && next.heldAtMs - onDisk.heldAtMs < HOST_PRESSURE_PERSIST_EVERY_MS;',
    to: '; /* MUTANT */',
    why: 'An episode longer than the carry window is not carried: its last-held time is its onset.',
  },
  {
    id: 'H-xxxiv. ★ the episode is written on every evaluation',
    file: ALERTS,
    find: 'next.heldAtMs - onDisk.heldAtMs < HOST_PRESSURE_PERSIST_EVERY_MS',
    to: 'next.heldAtMs - onDisk.heldAtMs < 0 /* MUTANT */',
    why: 'A disk write every 20 s while the host is under pressure.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-20b', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
