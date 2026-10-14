#!/usr/bin/env node
/**
 * mutate-v1187-22b.mjs — v1.187.22: the audible-unreachable and audible-degraded debounce spans
 * TIME, not just probes (confirm failing probes AND (confirm − 1) probe periods since the run's
 * first failing probe), and the alert monitor reads the audible-channel alerts when it assembles
 * the set it dispatches, not before its wait on the analytics worker.
 *
 *   B-i    the unreachable run drops its time condition (the 2026-10-12 22:04 forced-probe trio)
 *   B-ii   the degraded run drops its time condition
 *   B-iii  the shared run step drops the span (a count-only debounce again)
 *   B-iv   the span is measured from the latest probe instead of the run's first failing one
 *   B-v    a usable read does not reset the run's first failing time
 *   B-vi   CONFIRM = 1 is no longer immediate
 *   B-vii  a usable read no longer restores reachable at once
 *   B-viii a pending run publishes unknown instead of holding the prior value
 *   B-ix   the alert monitor reads the audible alerts once, before the worker wait
 *
 *   node scripts/mutate-v1187-22b.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BC = resolve(REPO, 'server/src/broadcast.ts');
const AM = resolve(REPO, 'server/src/alertMonitor.ts');
const SUBSET = [
  'test/broadcastIntegrity.test.ts',
  'test/audibleAlertFreshAfterFeedWait.test.ts',
];

const MUTANTS = [
  {
    id: 'B-i. ★★★ the unreachable run drops its time condition',
    file: BC,
    find: '      const reach = audibleReachableStep(unreachableRun, audibleReachable, usable, nowMs, AUDIBLE_UNREACHABLE_CONFIRM, AUDIBLE_HEALTH_PROBE_MS);',
    to: '      const reach = audibleReachableStep(unreachableRun, audibleReachable, usable, nowMs, AUDIBLE_UNREACHABLE_CONFIRM, 0); /* MUTANT */',
    why: 'Three probes forced inside a Music Assistant restart confirm the channel dead: an "unreachable" push and its "Resolved" (2026-10-12 22:04-22:06).',
  },
  {
    id: 'B-ii. ★★ the degraded run drops its time condition',
    file: BC,
    find: '      const degraded = audibleDegradedStep(degradedRun, cfg.targets.length, usable, nowMs, AUDIBLE_UNREACHABLE_CONFIRM, AUDIBLE_HEALTH_PROBE_MS);',
    to: '      const degraded = audibleDegradedStep(degradedRun, cfg.targets.length, usable, nowMs, AUDIBLE_UNREACHABLE_CONFIRM, 0); /* MUTANT */',
    why: 'The same restart window logs "audible channel DEGRADED" at 22:04:44 and raises the degraded alert while the speakers are seconds from returning.',
  },
  {
    id: 'B-iii. ★★★ the shared run step drops the span (count-only debounce)',
    file: BC,
    find: '  const spanMet = nowMs - sinceMs >= (confirm - 1) * probeMs;',
    to: '  const spanMet = true; /* MUTANT */',
    why: 'Every forced probe (failed broadcast, boot kick) counts toward confirmation again, so any restart with a broadcast in it pushes a false dead-channel alert.',
  },
  {
    id: 'B-iv. ★★★ the span is measured from the latest probe instead of the first failing one',
    file: BC,
    find: '  const sinceMs = prev.sinceMs ?? nowMs;',
    to: '  const sinceMs = nowMs; /* MUTANT */',
    why: 'Each probe restarts the clock, so a real outage is never confirmed and the dead audible channel never raises its alert.',
  },
  {
    id: 'B-v. ★★ a usable read does not reset the run\'s first failing time',
    file: BC,
    find: '  if (!failing) return { streak: 0, sinceMs: null, confirmed: false };',
    to: '  if (!failing) return { streak: 0, sinceMs: prev.sinceMs, confirmed: false }; /* MUTANT */',
    why: 'A later restart window is measured from an old blip, so its forced probes confirm the channel dead at once.',
  },
  {
    id: 'B-vi. ★★ CONFIRM = 1 is no longer immediate',
    file: BC,
    find: '  const spanMet = nowMs - sinceMs >= (confirm - 1) * probeMs;',
    to: '  const spanMet = nowMs - sinceMs >= Math.max(1, confirm - 1) * probeMs; /* MUTANT */',
    why: 'A site set to confirm on the first failing probe (BROADCAST_UNREACHABLE_CONFIRM=1) waits a full probe period before its dead-channel alert.',
  },
  {
    id: 'B-vii. ★★★ a usable read no longer restores reachable at once',
    file: BC,
    find: '  const reachable = usable > 0 ? true : run.confirmed ? false : prevReachable;',
    to: '  const reachable = run.confirmed ? false : prevReachable; /* MUTANT */',
    why: 'Once confirmed, the unreachable alert never resolves after the speakers return, and a fresh boot never reads the channel reachable.',
  },
  {
    id: 'B-viii. ★★ a pending run publishes unknown instead of holding the prior value',
    file: BC,
    find: '  const reachable = usable > 0 ? true : run.confirmed ? false : prevReachable;',
    to: '  const reachable = usable > 0 ? true : run.confirmed ? false : null; /* MUTANT */',
    why: 'A rename confirmed at once (resolveTargetDriftOnce) un-confirms on the next failing probe, so its alert resolves and fires again; every blip reads "unknown".',
  },
  {
    id: 'B-ix. ★★★ the alert monitor reads the audible alerts once, before the worker wait',
    file: AM,
    find: '      const all = [...liveHead, ...workerAlerts, ...liveTail, ...liveAudible(), ...liveTailRest]',
    to: '      const all = [...liveHead, ...workerAlerts, ...liveTail, ...(((liveHead as any).audibleOnce ??= liveAudible()) as Alert[]), ...liveTailRest] /* MUTANT */',
    why: 'A channel restored during the worker wait is still pushed as unreachable, then resolved a tick later (2026-10-12 22:06:09 / 22:06:29).',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-22b', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
