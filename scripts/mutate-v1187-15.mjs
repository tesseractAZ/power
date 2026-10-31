#!/usr/bin/env node
/**
 * mutate-v1187-15.mjs — v1.187.15: the AppArmor profile invariants (server/test/apparmorProfile.test.ts).
 *
 *   A-i    `/init r,` removed (v1.7.0: sh could not read /init and s6 crash-looped)
 *   A-ii   a write-lock mask with the append bit (`wal`, v1.9.0: profile failed to load)
 *   A-iii  network widened to every family again
 *   A-iv   a capability back in the allow list
 *
 * v1.197.1 — the blanket `file,` rule is gone (reads granted per top-level folder). A-i was anchored
 * on `  file,`; it now removes `/init r,`. The new mutants:
 *
 *   B-i    the blanket `file,` rule back
 *   B-ii   /share widened from the add-on's own folder to all of /share
 *   B-iii  the esbuild exec grant removed (tsx cannot transform: the server never starts)
 *   B-iv   `/data/{,**}` narrowed to `/data/**` (the folder's own listing refused)
 *   B-v    the /proc mem write deny removed
 *   B-vi   bashio's exec grant removed (the run script's interpreter, by its resolved path)
 *   B-vii  the /run/service exec grant removed (s6's stop path)
 *   B-viii the /package exec grant removed (every s6 command)
 *   B-ix   the no-exec-from-writable-trees deny made silent
 *   B-x    the unmapped-folder tripwire removed
 *   B-xi   a read deny on /data/options.json
 *
 *   node scripts/mutate-v1187-15.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AA = resolve(REPO, 'ecoflow_panel/apparmor.txt');
const SUBSET = ['test/apparmorProfile.test.ts'];

const MUTANTS = [
  {
    id: 'A-i. ★★★ /init no longer readable',
    file: AA,
    find: '  /init r,',
    to: '  # MUTANT',
    why: 'sh is denied reading /init at start and on restart: the add-on crash-loops and the alarm is down (v1.7.0).',
  },
  {
    id: 'A-ii. ★★★ a write-lock with the append bit',
    file: AA,
    find: '  deny /etc/{,**} wl,',
    to: '  deny /etc/{,**} wal, # MUTANT',
    why: 'The HAOS parser rejects a+w in one rule: the profile fails to load and the container cannot start.',
  },
  {
    id: 'A-iii. ★★ network widened to every family',
    file: AA,
    find: '  network inet stream,',
    to: '  network, # MUTANT',
    why: 'Raw and packet sockets become available to an exploited endpoint again.',
  },
  {
    id: 'A-iv. ★★ a capability back in the allow list',
    file: AA,
    find: '  capability chown,',
    to: '  capability chown,\n  capability sys_chroot, # MUTANT',
    why: 'An unused capability is granted to the process again.',
  },
  {
    id: 'B-i. ★★★ the blanket file rule back',
    file: AA,
    find: '  /init r,',
    to: '  /init r,\n  file, # MUTANT',
    why: "Every read is granted again: other add-ons' /share files, every unmapped path; the per-folder confinement is decorative.",
  },
  {
    id: 'B-ii. ★★ /share widened to every add-on',
    file: AA,
    find: '  /share/ecoflow-panel/{,**} rwk,',
    to: '  /share/{,**} rwk, # MUTANT',
    why: "An exploited endpoint can read and overwrite other add-ons' files under /share.",
  },
  {
    id: 'B-iii. ★★★ the esbuild exec grant removed',
    file: AA,
    find: '  /app/server/node_modules/@esbuild/*/bin/esbuild ix,',
    to: '  # MUTANT',
    why: 'tsx cannot start its esbuild service: the server never loads and the alarm is down.',
  },
  {
    id: 'B-iv. ★★ /data narrowed to /data/** (the folder itself refused)',
    file: AA,
    find: '  /data/{,**} rwk,',
    to: '  /data/** rwk, # MUTANT',
    why: 'atomicWrite cannot list /data and SQLite cannot fsync the folder: alarm state writes fail.',
  },
  {
    id: 'B-v. ★★ the /proc mem write deny removed',
    file: AA,
    find: '  audit deny /proc/*/{,task/*/}mem w,',
    to: '  # MUTANT',
    why: "A process's own memory file is writable as soon as any later rule grants /proc writes.",
  },
  {
    id: "B-vi. ★★★ bashio's exec grant removed",
    file: AA,
    find: '  /usr/lib/bashio/bashio ix,',
    to: '  # MUTANT',
    why: 'with-contenv cannot exec bashio (AppArmor checks the symlink target): the run script never starts.',
  },
  {
    id: 'B-vii. ★★★ the /run/service exec grant removed',
    file: AA,
    find: '  /run/service/** ix,',
    to: '  # MUTANT',
    why: "s6-svscan cannot run its finish and signal scripts copied into /run: every stop is a kill, every restart unclean.",
  },
  {
    id: 'B-viii. ★★★ the /package exec grant removed',
    file: AA,
    find: '  /package/** ix,',
    to: '  # MUTANT',
    why: 's6 commands resolve into versioned /package folders: init cannot run them and crash-loops.',
  },
  {
    id: 'B-ix. ★★ the no-exec-from-writable-trees deny made silent',
    file: AA,
    find: '  audit deny /{data,share,tmp,var/tmp}/** mx,',
    to: '  deny /{data,share,tmp,var/tmp}/** mx, # MUTANT',
    why: 'A dropped payload executed from /data or /tmp is refused without a record: the probe and an attack leave nothing in the audit journal.',
  },
  {
    id: 'B-x. ★★ the unmapped-folder tripwire removed',
    file: AA,
    find: '  audit deny /{config,ssl,backup,media,addons,addon_configs,homeassistant}/{,**} rwlkmx,',
    to: '  # MUTANT',
    why: 'A later broad allow rule would reach /config, /ssl and /backup, and an attempt would leave no record.',
  },
  {
    id: 'B-xi. ★★★ a read deny on /data/options.json',
    file: AA,
    find: '  deny /etc/shadow r,',
    to: '  deny /etc/shadow r,\n  deny /data/options.json r, # MUTANT',
    why: 'bashio cannot read any option: the run script exits and the add-on never starts.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-15', mutants: MUTANTS, subset: SUBSET, root: REPO });
