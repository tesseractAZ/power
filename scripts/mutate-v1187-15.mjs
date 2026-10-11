#!/usr/bin/env node
/**
 * mutate-v1187-15.mjs — v1.187.15: the AppArmor profile invariants (server/test/apparmorProfile.test.ts).
 *
 *   A-i    the blanket `file,` rule removed (v1.7.0 crash-looped s6 /init)
 *   A-ii   a write-lock mask with the append bit (`wal`, v1.9.0: profile failed to load)
 *   A-iii  network widened to every family again
 *   A-iv   a capability back in the allow list
 *
 *   node scripts/mutate-v1187-15.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AA = resolve(REPO, 'ecoflow_panel/apparmor.txt');
const SUBSET = ['test/apparmorProfile.test.ts'];

const MUTANTS = [
  { id: 'A-i. ★★★ the blanket file rule removed', file: AA, find: '\n  file,\n', to: '\n  # MUTANT\n', why: 'A per-path list denies s6 re-reading /init on restart: the add-on crash-loops and the alarm is down.' },
  { id: 'A-ii. ★★★ a write-lock with the append bit', file: AA, find: '  deny /etc/{,**} wl,', to: '  deny /etc/{,**} wal, # MUTANT', why: 'The HAOS parser rejects a+w in one rule: the profile fails to load and the container cannot start.' },
  { id: 'A-iii. ★★ network widened to every family', file: AA, find: '  network inet stream,', to: '  network, # MUTANT', why: 'Raw and packet sockets become available to an exploited endpoint again.' },
  { id: 'A-iv. ★★ a capability back in the allow list', file: AA, find: '  capability chown,', to: '  capability chown,\n  capability sys_chroot, # MUTANT', why: 'An unused capability is granted to the process again.' },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-15', mutants: MUTANTS, subset: SUBSET, root: REPO });
