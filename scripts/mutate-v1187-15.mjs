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
 * v1.197.1 review — the exec grants `file,` used to back up are each the only grant for their folder
 * now; the Go runtime's huge-page read; the /run writable-and-executable exception bounded; the
 * capability, mount and ptrace denies and the remaining write-locks pinned:
 *
 *   C-i    the cont-finish exec grant removed (the STOP path)
 *   C-ii   the cont-init exec grant removed
 *   C-iii  the s6-overlay script exec grant removed
 *   C-iv   the services.d exec grant removed
 *   C-v    the legacy /etc/s6 exec grant removed
 *   C-vi   the /usr/sbin exec grant removed
 *   C-vii  the /sbin exec grant removed
 *   C-viii the /usr/local/bin exec grant removed
 *   C-ix   the /dev/pts grant removed
 *   C-x    the /proc folder grant removed (only the files named one by one stay readable)
 *   D-i    the transparent-huge-page read grant removed (esbuild's Go runtime, every start)
 *   D-ii   exec widened from /run/service to all of /run
 *   D-iii  a new writable and executable folder outside /run
 *   E-i    a dangerous capability's explicit deny removed
 *   E-ii   the ptrace deny removed
 *   E-iii  the mount deny removed
 *   E-iv   the /lib64 write-lock removed
 *   E-v    the /var write-lock removed
 *   E-vi   the /sys write deny removed
 *   E-vii  the /sys/firmware deny removed
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
  {
    id: 'C-i. ★★★ the cont-finish exec grant removed (the stop path)',
    file: AA,
    find: '  /etc/cont-finish.d/** rwix,',
    to: '  # MUTANT',
    why: 'Without `file,` nothing else grants it: a finish script cannot run at stop, and the failure shows only at shutdown.',
  },
  {
    id: 'C-ii. ★★ the cont-init exec grant removed',
    file: AA,
    find: '  /etc/cont-init.d/** rwix,',
    to: '  # MUTANT',
    why: 'A cont-init script cannot run at boot: s6-overlay stops the container before the service starts.',
  },
  {
    id: 'C-iii. ★★ the s6-overlay script exec grant removed',
    file: AA,
    find: '  /etc/s6-overlay/** ix,',
    to: '  # MUTANT',
    why: "A script an s6-rc `up` file names cannot run: the base image's oneshots fail at boot.",
  },
  {
    id: 'C-iv. ★★ the services.d exec grant removed',
    file: AA,
    find: '  /etc/services.d/** rwix,',
    to: '  # MUTANT',
    why: 'The legacy service folder (the add-on\'s run script) loses its only exec grant.',
  },
  {
    id: 'C-v. ★ the legacy /etc/s6 exec grant removed',
    file: AA,
    find: '  /etc/s6/** ix,',
    to: '  # MUTANT',
    why: 'An s6-overlay v2 script under /etc/s6 cannot run.',
  },
  {
    id: 'C-vi. ★★ the /usr/sbin exec grant removed',
    file: AA,
    find: '  /usr/sbin/** ix,',
    to: '  # MUTANT',
    why: 'A program in /usr/sbin cannot run: nothing else grants exec there since `file,` is gone.',
  },
  {
    id: 'C-vii. ★★ the /sbin exec grant removed',
    file: AA,
    find: '  /sbin/** ix,',
    to: '  # MUTANT',
    why: 'A program in /sbin cannot run: nothing else grants exec there since `file,` is gone.',
  },
  {
    id: 'C-viii. ★★ the /usr/local/bin exec grant removed',
    file: AA,
    find: '  /usr/local/bin/** ix,',
    to: '  # MUTANT',
    why: 'A program in /usr/local/bin cannot run: nothing else grants exec there since `file,` is gone.',
  },
  {
    id: 'C-ix. ★ the /dev/pts grant removed',
    file: AA,
    find: '  /dev/pts/** rw,',
    to: '  # MUTANT',
    why: 'A terminal (`docker exec -t`) can no longer be read or written.',
  },
  {
    id: 'C-x. ★★ the /proc folder grant removed',
    file: AA,
    find: '  /proc/{,**} r,',
    to: '  # MUTANT',
    why: 'Only the /proc files named one by one stay readable: a per-file list, the v1.7.0 failure class.',
  },
  {
    id: "D-i. ★★ the transparent-huge-page read grant removed",
    file: AA,
    find: '  /sys/kernel/mm/transparent_hugepage/{,**} r,',
    to: '  # MUTANT',
    why: "esbuild's Go runtime reads the huge-page size at every start; on a host whose abstractions/base predates AppArmor 3.0.12 / 3.1.6 that is a DENIED record on every boot and export.",
  },
  {
    id: 'D-ii. ★★ exec widened from /run/service to all of /run',
    file: AA,
    find: '  /run/service/** ix,',
    to: '  /run/** ix, # MUTANT',
    why: 'Anything written anywhere under /run can be run: the writable-and-executable exception is no longer bounded to s6\'s trees.',
  },
  {
    id: 'D-iii. ★★ a new writable and executable folder outside /run',
    file: AA,
    find: '  /usr/local/bin/** ix,',
    to: '  /usr/local/bin/** ix,\n  /opt/** rwix, # MUTANT',
    why: 'A payload written to /opt can be run: a second writable-and-executable tree.',
  },
  {
    id: 'E-i. ★★ a dangerous capability\'s explicit deny removed',
    file: AA,
    find: '  deny capability sys_module,',
    to: '  # MUTANT',
    why: 'A later allow rule could grant kernel module loading without a deny to override it.',
  },
  {
    id: 'E-ii. ★★ the ptrace deny removed',
    file: AA,
    find: '  deny ptrace,',
    to: '  # MUTANT',
    why: 'abstractions/base grants ptrace read within the profile; nothing then overrides a later ptrace grant.',
  },
  {
    id: 'E-iii. ★★ the mount deny removed',
    file: AA,
    find: '  deny mount,',
    to: '  # MUTANT',
    why: 'A later broad rule could grant mount, a container escape path.',
  },
  {
    id: 'E-iv. ★★ the /lib64 write-lock removed',
    file: AA,
    find: '  deny /lib64/{,**} wl,',
    to: '  # MUTANT',
    why: 'A library under /lib64 loses its write-lock (CWE-732 persistence).',
  },
  {
    id: 'E-v. ★★ the /var write-lock removed',
    file: AA,
    find: '  deny /var/{cache,lib,log,spool,opt,mail,local}/{,**} wl,',
    to: '  # MUTANT',
    why: 'The package database and the rest of /var lose their write-lock.',
  },
  {
    id: 'E-vi. ★★ the /sys write deny removed',
    file: AA,
    find: '  deny /sys/** w,',
    to: '  # MUTANT',
    why: 'Host kernel attributes outside /sys/kernel are no longer write-denied.',
  },
  {
    id: 'E-vii. ★ the /sys/firmware deny removed',
    file: AA,
    find: '  deny /sys/firmware/** rw,',
    to: '  # MUTANT',
    why: 'The firmware tables lose their explicit deny.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-15', mutants: MUTANTS, subset: SUBSET, root: REPO });
