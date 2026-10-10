#!/usr/bin/env node
/**
 * mutate-curtail-freeze.mjs — committed harness for v1.186.1: the 7-day curtailment figure
 * freezes each finished day once it has SETTLED (weather fetched at least the settle lag after
 * the day ended, every hour of it covered by a value the provider sent, a posterior present),
 * persists the frozen days, prunes them as the window slides, and re-estimates only unsettled days.
 *
 *   node scripts/mutate-curtail-freeze.mjs
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
const FRZ = resolve(SERVER, 'src/curtailmentFreeze.ts');
const AN = resolve(SERVER, 'src/analytics.ts');

const SUBSET = ['test/curtailmentFreeze.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the settle lag is dropped',
    file: FRZ,
    find: '  if (!(weather.fetchedAt >= dayEndMs + CURTAIL_SETTLE_LAG_MS)) return false;',
    to: '  if (!(weather.fetchedAt >= dayEndMs)) return false; /* MUTANT */',
    why: 'Yesterday freezes minutes after midnight, on irradiance the provider is still revising.',
  },
  {
    id: 'ii. ★★★ settled by the wall clock, not by the fetch time of the weather in hand',
    file: FRZ,
    find: '  if (!(weather.fetchedAt >= dayEndMs + CURTAIL_SETTLE_LAG_MS)) return false;',
    to: '  if (!(Date.now() >= dayEndMs + CURTAIL_SETTLE_LAG_MS)) return false; /* MUTANT */',
    why: 'A stale cache (every fetch failing) freezes a finished day on the FORECAST it held for it.',
  },
  {
    id: 'iii. ★★ an hour outside the cache does not block the freeze',
    file: FRZ,
    find: '    if (!sent.has(coveringRadiationEpoch(Math.floor((dayStartMs + h * HOUR_MS) / HOUR_MS)))) return false;',
    to: '    if (false) return false; /* MUTANT */',
    why: 'The oldest day, half outside the past_days edge, freezes on heuristic-only hours.',
  },
  {
    id: 'iv. ★★ a stand-in 0 counts as a reading',
    file: FRZ,
    find: '    if (h.radiationMissing !== true && Number.isFinite(h.radiationWm2)) sent.add(Math.floor(h.ts / HOUR_MS));',
    to: '    sent.add(Math.floor(h.ts / HOUR_MS)); /* MUTANT */',
    why: 'An hour the provider did not send (radiationMissing) is frozen as a dark hour for a week.',
  },
  {
    id: 'v. ★★★ a model-less walk freezes',
    file: FRZ,
    find: '  if (!weather || !hasPosterior) return false;',
    to: '  if (!weather) return false; /* MUTANT */',
    why: 'With no posterior every hour samples null, and a week of 0 kWh is frozen (the v1.178.0 trap).',
  },
  {
    id: 'vi. ★★★ the frozen store is never read (every refresh re-estimates all 168 hours)',
    file: AN,
    find: '    const frozenDay = frozenCurtailmentDay(dayStart);',
    to: '    const frozenDay = null as ReturnType<typeof frozenCurtailmentDay>; /* MUTANT */',
    why: 'The pre-v1.186.1 defect: the same finished days drift with every re-learn and weather refresh.',
  },
  {
    id: 'vii. ★★ the sidecar is not reloaded after a restart',
    file: FRZ,
    find: '        if (day) frozen.set(day.dayStartMs, day); // an invalid entry is dropped: that day re-estimates live',
    to: '        void day; /* MUTANT */',
    why: 'Every restart re-estimates the whole week against the posterior of the moment.',
  },
  {
    id: 'viii. ★ days that left the window are never pruned',
    file: FRZ,
    find: '    if (k < oldestKeptDayStartMs) { frozen.delete(k); dirty = true; }',
    to: '    if (false) { frozen.delete(k); dirty = true; } /* MUTANT */',
    why: 'The sidecar grows by a day every day, forever.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-curtail-freeze', mutants: MUTANTS, subset: SUBSET, root: REPO });
