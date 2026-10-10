#!/usr/bin/env node
/**
 * mutate-settings-drift.mjs — committed mutation harness for the v1.83.0
 * settings-drift watchdog (server/src/settingsDrift.ts, pure core).
 *
 * WHY COMMITTED: the watchdog exists because two incidents were invisible
 * settings movements (the 08-04 "Charge Now" on-peak buy; the 08-16 phantom
 * reserve write). Its failure modes are all SILENT-WRONG: announcing the
 * boot baseline as changes (noise storm), announcing transients (noise),
 * announcing offline gaps (Core 2 spam), or classifying the actuator's own
 * nightly writes as external (two pushes per night, forever).
 *
 *   node scripts/mutate-settings-drift.mjs
 *
 * ★ Anchor-asserted; mutates in place, restores in finally. Do not touch the
 *   tree while it runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MOD = resolve(SERVER, 'src/settingsDrift.ts');

const SUBSET = ['test/settingsDrift.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ the debounce is gone — a single-poll transient announces (noise)',
    find: "    if (p != null && p.to === c.to) {",
    to: "    if (true) {",
    why: 'Mid-write glitches and one-poll flickers would push [Medium] notifications; the operator learns to ignore the channel.',
  },
  {
    id: 'ii. ★ the both-sides rule is gone — availability reads as drift',
    find: "    if (!(key in prev)) continue;",
    to: "    /* MUTANT */",
    why: "Core 2 has been offline for weeks; every reappearing key would announce 'undefined -> value'.",
  },
  {
    id: 'iii. ★★ own-write classification always says external',
    find: "  if (c.to === act.targetPct || c.to === act.priorReservePct) return 'own-write';",
    to: "  return 'external';",
    why: "The night-charge actuator moves the reserve twice a night — two spurious 'settings changed' pushes per night, forever.",
  },
  {
    id: 'iv. ★ the nightActive gate is gone — an idle-time reserve change is silenced',
    find: "  if (!act.nightActive) return 'external';",
    to: "  /* MUTANT */",
    why: 'A reserve moved OUTSIDE any night (the phantom-write investigation\'s other side) would be classified own-write and never announced.',
  },
  {
    id: 'v. the confirmed baseline never advances — every tick re-announces the same change',
    find: "  for (const c of confirmedChanges) state.confirmed[c.key] = c.to;",
    to: "  /* MUTANT */",
    why: 'One real change would push every minute until restart.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-settings-drift', mutants: MUTANTS.map((m) => ({ file: MOD, ...m })), subset: SUBSET, root: REPO });
