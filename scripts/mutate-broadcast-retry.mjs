#!/usr/bin/env node
/**
 * mutate-broadcast-retry.mjs — committed harness for the v1.159.0 deferred-retry budget
 * (server/src/broadcast.ts).
 *
 * WHY COMMITTED: this is the AUDIBLE alarm path, and a retry that cannot count is
 * indistinguishable from one that works until the day an announcement keeps failing. On
 * 2026-09-15 `music_assistant.play_announcement` returned HTTP 500 for ten minutes and the
 * log shows "deferred retry 1/3" three times for a single condition — the budget reset on
 * every failure because the timer cleared the slot before re-running the broadcast. The
 * file's own single-flight comment records that overlapping play_announcement calls are what
 * wedges MA into those 500s, so an unbounded retry can sustain the failure it is retrying.
 *
 * v1.160.0 added the release-on-every-exit wrapper (mutants vi/vii): v1.159.0 released the
 * slot only at the completion tail, so a retry that fired into an early return — most
 * plausibly the same-level storm gate, since a retry replays the same rung ~30 s later —
 * left it held with no timer armed and no retry could ever be scheduled again.
 *
 *   node scripts/mutate-broadcast-retry.mjs
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

const SUBSET = ['test/broadcastRetryBudget.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the slot is cleared at fire time again (the budget never counts)',
    file: BC,
    find: '      retryTimer = null;\n      // v1.159.0 — do NOT clear retryLevel here.',
    to: '      retryTimer = null;\n      retryLevel = null; /* MUTANT */\n      // v1.159.0 — do NOT clear retryLevel here.',
    why: 'Every failure restarts at attempt 1: the retry never gives up and re-announces every ~30 s for as long as the announcement service keeps failing.',
  },
  {
    id: 'ii. ★★ a completed broadcast never releases the slot',
    file: BC,
    find: '    releaseRetrySlotIfIdle();\n    persistStatus();',
    to: '    /* MUTANT */\n    persistStatus();',
    why: 'A stale level makes every later milder deferral "keep-pending" against a retry that does not exist, so nothing is ever retried again.',
  },
  {
    id: 'iii. ★ the release ignores whether a retry is armed',
    file: BC,
    find: '    if (retryTimer == null) { retryAttempt = 0; retryLevel = null; }',
    to: '    retryAttempt = 0; retryLevel = null; /* MUTANT */',
    why: 'The armed retry loses its budget the instant the broadcast that armed it completes — back to an uncountable retry.',
  },
  {
    id: 'iv. ★★ the budget ceiling is removed',
    file: BC,
    find: '  if (attempt >= maxAttempts) return { action: \'give-up\', attempt: 0 };',
    to: '  if (false) return { action: \'give-up\', attempt: 0 }; /* MUTANT */',
    why: 'The retry ladder never terminates; a permanently wedged announcement service is retried forever.',
  },
  {
    id: 'v. ★ yellow churn spends the red budget again',
    file: BC,
    find: '  const attempt = pending && RETRY_LEVEL_RANK[incoming] > RETRY_LEVEL_RANK[pending.level]\n    ? 0\n    : pending?.attempt ?? 0;',
    to: '  const attempt = pending?.attempt ?? 0; /* MUTANT */',
    why: 'Three yellow deferrals exhaust the budget and the next red gets "giving up" without a single attempt — the v1.122.0 defect, restored.',
  },
  // v1.160.0 — these two revert the release-on-every-exit wrapper. The slot machinery is a
  // closure inside makeBroadcaster (no seam to call runBroadcastInner from a test without a
  // live HA client), so the mechanism that kills them is an anchor-asserted SOURCE PIN.
  // That is the point of running them: the pin is only worth having if it fails on the
  // exact shapes the regression would take.
  {
    id: 'vi. ★★★ only the completion tail releases the slot again (the v1.159.0 leak)',
    file: BC,
    // v1.187.4 — re-pointed: the try now also holds the stale-retry drop; the finally is removed.
    // v1.187.11 — re-pointed: the try ends with the attempt's result (after the run-time words).
    find: '      return result;\n    } finally {\n      releaseRetrySlotIfIdle();\n    }',
    to: '      return result;\n    } finally {\n      /* MUTANT */\n    }',
    why: 'A deferred retry absorbed by the same-level storm gate leaves the slot held with no timer: every later milder deferral keeps-pending against a retry that does not exist, and the next same-level failure gives up having made zero attempts.',
  },
  {
    id: 'vii. ★★ the slot is released on the way IN instead of on the way out',
    file: BC,
    // v1.187.4 — re-pointed: released at entry, and not in the finally.
    // v1.187.5 — re-pointed: the attempt's generation is now set last, before the try.
    find: '    attemptGeneration = retryOf ?? ++broadcastGeneration;\n    try {',
    to: '    attemptGeneration = retryOf ?? ++broadcastGeneration;\n    releaseRetrySlotIfIdle(); /* MUTANT */\n    try {',
    why: 'The fired retry loses its own budget before it re-runs — attempt restarts at 1 forever, which is exactly the v1.159.0 defect.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-broadcast-retry', mutants: MUTANTS, subset: SUBSET, root: REPO });
