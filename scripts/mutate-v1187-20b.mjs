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
 *   node scripts/mutate-v1187-20b.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALERTS = resolve(REPO, 'server/src/alerts.ts');
const SUBSET = [
  'test/hostPressureWarnDwell.test.ts',
  'test/hostPressureWarnBroadcast.test.ts',
  'test/hostPressureDwell.test.ts',
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
    find: "    hostPressureWarnAudible('ok', false, now); // v1.187.20 — and the warning's episode clock",
    to: '    /* MUTANT */',
    why: 'After one sustained episode every later blip is audible at once.',
  },
  {
    id: 'H-viii. ★★ the holder\'s ok branch keeps the latch',
    file: ALERTS,
    find: "  if (level === 'ok') { hostPressureSinceMs = null; hostPressureWarnAudibleLatched = false; return false; }",
    to: "  if (level === 'ok') { hostPressureSinceMs = null; return false; } /* MUTANT */",
    why: 'The dwell does not reset after recovery: the next blip speaks.',
  },
  {
    id: 'H-ix. ★★ the holder\'s ok branch keeps the episode clock',
    file: ALERTS,
    find: "{ hostPressureSinceMs = null; hostPressureWarnAudibleLatched = false; return false; }",
    to: "{ hostPressureWarnAudibleLatched = false; return false; } /* MUTANT */",
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
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-20b', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
