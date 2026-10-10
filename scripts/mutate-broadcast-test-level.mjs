#!/usr/bin/env node
/**
 * mutate-broadcast-test-level.mjs — committed harness for v1.185.1: POST /api/broadcast/test
 * validates the CONDITION levels (red/yellow/green, empty body = red), not the chime rungs.
 *
 *   node scripts/mutate-broadcast-test-level.mjs
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
const INDEX = resolve(SERVER, 'src/index.ts');

const SUBSET = ['test/broadcastTestLevel.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★ a chime rung passes as a test level',
    file: BC,
    find: '  return typeof level === \'string\' && (BROADCAST_TEST_LEVELS as readonly string[]).includes(level) ? (level as ConditionLevel) : null;',
    to: '  return typeof level === \'string\' ? (level as ConditionLevel) : null; /* MUTANT */',
    why: 'A "critical" test is spoken as "All clear. Test broadcast." with the clear tone.',
  },
  {
    id: 'ii. ★ the empty body is refused',
    file: BC,
    find: '  const level = raw ?? \'red\';',
    to: '  const level = raw; /* MUTANT */',
    why: 'The documented default (no body = red test) returns 400 again.',
  },
  {
    id: 'iii. ★★ the route validates against the chime rungs again',
    file: INDEX,
    find: '    const level = parseBroadcastTestLevel(req.body?.level);',
    to: '    const level = (CHIME_LEVELS as readonly string[]).includes(req.body?.level ?? \'red\') ? parseBroadcastTestLevel(req.body?.level) : null; /* MUTANT */',
    why: 'Every documented test call is refused with 400, as from v1.59.0 to v1.185.0.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-broadcast-test-level', mutants: MUTANTS, subset: SUBSET, root: REPO });
