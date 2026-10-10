#!/usr/bin/env node
/**
 * mutate-pack-identity.mjs — committed harness for v1.173.0: per-pack alert state follows the
 * BATTERY, not the slot (server/src/alertMonitor.ts, alerts.ts, analytics.ts).
 *
 * WHY COMMITTED: after a pack is replaced or the Core renumbers its slots (Core 4,
 * 2026-09-20), each of these rails keeps one battery's state from being read as another's —
 * a swallowed first push, an onset spanning two batteries, an inherited warn-hold.
 *
 *   node scripts/mutate-pack-identity.mjs
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
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const AL = resolve(SERVER, 'src/alerts.ts');
const AN = resolve(SERVER, 'src/analytics.ts');

const SUBSET = ['test/packIdentityRenumber.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ a missing serial counts as a pack change',
    file: AM,
    find: '    if (before != null && after != null && before !== after) out.push({ id: a.id, from: before, to: after });',
    to: '    if (before !== after) out.push({ id: a.id, from: String(before), to: String(after) }); /* MUTANT */',
    why: 'A serial that drops out for one read closes every live pack episode and re-pages it.',
  },
  {
    id: 'ii. ★★★ the old pack’s push record survives the replacement',
    file: AM,
    find: '      if (persistedNotified.delete(c.id)) persistNotified();',
    to: '      /* MUTANT */',
    why: 'The new pack’s alert re-tracks as already notified — its first push (critical included) is swallowed.',
  },
  {
    id: 'iii. ★★ the onset is not restarted for the new pack',
    file: AM,
    find: '      restampAlertOnset(c.id, now);',
    to: '      /* MUTANT */',
    why: 'The new episode’s cleared record spans two batteries — the RMA evidence trail v1.102.0 protects.',
  },
  {
    id: 'iv. ★★★ the warn-hold is inherited by the pack that moves in',
    file: AL,
    find: '        if (heldBy != null && pk.packSn && heldBy !== pk.packSn) heldVdiffWarnKeys.delete(vdiffKey);',
    to: '        /* MUTANT */',
    why: 'A healthy pack moving into slot 1 fires vdiff-warn at 20-23 mV without ever crossing the 24 mV rise line.',
  },
  {
    id: 'v. ★★ the baseline alerts carry no pack serial',
    file: AN,
    find: '      ...(t.packSn ? { sourcePackSn: t.packSn } : {}),',
    to: '      /* MUTANT */',
    why: 'The residency check cannot see a renumber under a baseline alert — one episode silently describes two batteries.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-pack-identity', mutants: MUTANTS, subset: SUBSET, root: REPO });
