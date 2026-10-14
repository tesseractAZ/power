#!/usr/bin/env node
/**
 * mutate-v1187-22b.mjs — v1.187.22: the audible-unreachable and audible-degraded debounce spans
 * TIME, not just probes (confirm failing probes AND (confirm − 1) probe periods since the run's
 * first failing probe), a probe is armed AT a pending run's span so a forced probe cannot push
 * confirmation to a later tick, the no-speakers and rename paths stay immediate, and the alert
 * monitor reads the audible-channel alerts when it assembles the set it dispatches, not before its
 * wait on the analytics worker.
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
 *   B-x    no probe is armed at a pending run's span (a forced probe pushes confirmation to a later tick)
 *   B-xi   the armed probe is measured from the latest probe instead of the run's first failing one
 *   B-xii  the degraded run is not probed at its span
 *   B-xiii the unreachable run is not probed at its span
 *   B-xiv  a run past its span with a short count is probed again at once
 *   B-xv   a wall clock stepped back mid-run does not re-anchor the span
 *   B-xvi  no speakers configured waits for the debounce instead of reporting at once
 *   B-xvii a renamed speaker id waits for the debounce instead of reporting at once
 *   B-xviii  the periodic throttle drops its jitter tolerance (a tick read P − 1 ms after the last is skipped)
 *   B-xix    a wall clock stepped back stalls the periodic probe until the clock catches up
 *   B-xx     the throttle is gone: a forced probe no longer defers the next tick
 *   B-xxi    the monitor's throttle is the v0.84.0 strict comparison again
 *   B-xxii   the deadline is re-armed from the probe's END, so one dropped by the re-entrancy guard is lost
 *   B-xxiii  a confirmed degraded channel is not held through failing probes (a clock step un-confirms it)
 *   B-xxiv   the monitor does not hand the degraded step its confirmed state
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
    find: '      const degraded = audibleDegradedStep(degradedRun, audibleDegraded, cfg.targets.length, usable, nowMs, AUDIBLE_UNREACHABLE_CONFIRM, AUDIBLE_HEALTH_PROBE_MS);',
    to: '      const degraded = audibleDegradedStep(degradedRun, audibleDegraded, cfg.targets.length, usable, nowMs, AUDIBLE_UNREACHABLE_CONFIRM, 0); /* MUTANT */',
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
    find: '  const sinceMs = prev.sinceMs != null && prev.sinceMs <= nowMs ? prev.sinceMs : nowMs;',
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
  {
    id: 'B-x. ★★★ no probe is armed at a pending run\'s span',
    file: BC,
    find: '      armAudibleDeadline(nowMs); // v1.187.22',
    to: '      /* MUTANT */',
    why: 'A failed alarm broadcast just short of the span skips the tick that would confirm, so the dead-channel push goes out a probe period late — up to two when the run began on a forced probe.',
  },
  {
    id: 'B-xi. ★★★ the armed probe is measured from the latest probe instead of the first failing one',
    file: BC,
    find: '    run.sinceMs == null || confirmed || nowMs >= run.sinceMs + span ? null : run.sinceMs + span;',
    to: '    run.sinceMs == null || confirmed || nowMs >= run.sinceMs + span ? null : nowMs + span; /* MUTANT */',
    why: 'Each forced probe pushes the armed probe a full span out, so confirmation falls back to the next tick past the span, a period or more late.',
  },
  {
    id: 'B-xii. ★★ the degraded run is not probed at its span',
    file: BC,
    find: '  const b = due(degraded, degradedConfirmed);',
    to: '  const b: number | null = null; /* MUTANT */',
    why: 'A speaker found dark by the 15 s boot probe is reported degraded a tick after its span (the boot probe made the first tick skip), not at the span.',
  },
  {
    id: 'B-xiii. ★★ the unreachable run is not probed at its span',
    file: BC,
    find: '  const a = due(unreachable, reachable === false);',
    to: '  const a: number | null = null; /* MUTANT */',
    why: 'Once the degraded alert stands, the last speaker going dark is confirmed unreachable at the next tick past its span, up to two periods late when failed broadcasts moved the probe beat.',
  },
  {
    id: 'B-xiv. ★★ a run past its span with a short count is probed again at once',
    file: BC,
    find: '    run.sinceMs == null || confirmed || nowMs >= run.sinceMs + span ? null : run.sinceMs + span;',
    to: '    run.sinceMs == null || confirmed ? null : run.sinceMs + span; /* MUTANT */',
    why: 'A run whose count fell short at its span is probed every 25 ms until the burst makes up the count: a request storm against Home Assistant that confirms on probes no period apart.',
  },
  {
    id: 'B-xv. ★★ a wall clock stepped back mid-run does not re-anchor the span',
    file: BC,
    find: '  const sinceMs = prev.sinceMs != null && prev.sinceMs <= nowMs ? prev.sinceMs : nowMs;',
    to: '  const sinceMs = prev.sinceMs ?? nowMs; /* MUTANT */',
    why: 'An NTP correction stepping the clock back an hour during a real outage holds the dead-channel alert for that hour.',
  },
  {
    id: 'B-xvi. ★★★ no speakers configured waits for the debounce',
    file: BC,
    find: '        unreachableRun = { streak: AUDIBLE_UNREACHABLE_CONFIRM, sinceMs: unreachableRun.sinceMs ?? nowMs }; audibleReachable = false; audibleUsableTargets = 0;',
    to: '        unreachableRun = { streak: AUDIBLE_UNREACHABLE_CONFIRM, sinceMs: unreachableRun.sinceMs ?? nowMs }; audibleUsableTargets = 0; /* MUTANT */',
    why: 'Audible enabled with BROADCAST_TARGETS empty reads "unknown" for ever: every alarm plays to no one and no alert says so.',
  },
  {
    id: 'B-xvii. ★★★ a renamed speaker id waits for the debounce',
    file: BC,
    find: '      unreachableRun = { streak: AUDIBLE_UNREACHABLE_CONFIRM, sinceMs: unreachableRun.sinceMs ?? Date.now() };\n      audibleReachable = false;',
    to: '      unreachableRun = { streak: AUDIBLE_UNREACHABLE_CONFIRM, sinceMs: unreachableRun.sinceMs ?? Date.now() }; /* MUTANT */',
    why: 'Renamed speaker ids (the v0.92.0 audit found 8 alarm broadcasts, a red among them, dropped this way) read "unknown" for a full probe span before the alert, though a rename never self-heals.',
  },
  {
    id: 'B-xviii. ★★★ the periodic throttle drops its jitter tolerance',
    file: BC,
    find: '  return since < 0 || since >= probeMs - Math.min(AUDIBLE_PROBE_JITTER_MAX_MS, probeMs / 10);',
    to: '  return since < 0 || since >= probeMs; /* MUTANT */',
    why: 'A tick the interval delivers P − 1 ms after the last (by Date.now) is skipped: a run loses a probe, and one past its span waits a further period to be confirmed (7 of 21 real-interval runs under load).',
  },
  {
    id: 'B-xix. ★★ a wall clock stepped back stalls the periodic probe',
    file: BC,
    find: '  return since < 0 || since >= probeMs - Math.min(AUDIBLE_PROBE_JITTER_MAX_MS, probeMs / 10);',
    to: '  return since >= probeMs - Math.min(AUDIBLE_PROBE_JITTER_MAX_MS, probeMs / 10); /* MUTANT */',
    why: 'An NTP correction stepping the clock back an hour stops the periodic probe for that hour: a confirmed dead-channel alert is held long after the speakers return.',
  },
  {
    id: 'B-xx. ★★ the throttle is gone: a forced probe no longer defers the next tick',
    file: BC,
    find: '  return since < 0 || since >= probeMs - Math.min(AUDIBLE_PROBE_JITTER_MAX_MS, probeMs / 10);',
    to: '  return true; /* MUTANT */',
    why: 'Every tick probes regardless of the forced probe just before it, so failed broadcasts and their retries double the Home Assistant reads in a restart window.',
  },
  {
    id: 'B-xxi. ★★ the monitor\'s throttle is the v0.84.0 strict comparison again',
    file: BC,
    find: '    if (!force && !audibleProbeDue(nowMs, lastAudibleHealthAt, AUDIBLE_HEALTH_PROBE_MS)) return;',
    to: '    if (!force && nowMs - lastAudibleHealthAt < AUDIBLE_HEALTH_PROBE_MS) return; /* MUTANT */',
    why: 'Interval jitter skips ticks again, and a clock stepped back stops the periodic probe until it catches up.',
  },
  {
    id: 'B-xxii. ★★ the deadline is re-armed from the probe\'s end, not its start',
    file: BC,
    find: '      armAudibleDeadline(nowMs); // v1.187.22',
    to: '      armAudibleDeadline(Date.now()); /* MUTANT */',
    why: 'A probe begun short of the span and still in flight past it (a slow Home Assistant read) swallows the probe armed at the span and arms none: confirmation waits for the next tick, a period late.',
  },
  {
    id: 'B-xxiii. ★★★ a confirmed degraded channel is not held through failing probes',
    file: BC,
    find: '  return { streak: run.streak, sinceMs: run.sinceMs, degraded: run.confirmed || (prevDegraded && run.streak > 0) };',
    to: '  return { streak: run.streak, sinceMs: run.sinceMs, degraded: run.confirmed }; /* MUTANT */',
    why: 'A wall clock stepped back re-anchors the run, which un-confirms it: "audible channel restored" is logged and the degraded alert resolves with the speaker still dark, then is pushed again a span later.',
  },
  {
    id: 'B-xxiv. ★★ the monitor does not hand the degraded step its confirmed state',
    file: BC,
    find: '      const degraded = audibleDegradedStep(degradedRun, audibleDegraded, cfg.targets.length, usable, nowMs, AUDIBLE_UNREACHABLE_CONFIRM, AUDIBLE_HEALTH_PROBE_MS);',
    to: '      const degraded = audibleDegradedStep(degradedRun, false, cfg.targets.length, usable, nowMs, AUDIBLE_UNREACHABLE_CONFIRM, AUDIBLE_HEALTH_PROBE_MS); /* MUTANT */',
    why: 'The hold exists only on paper: a clock step still logs a false "restored" and re-pushes the degraded alert.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-22b', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
