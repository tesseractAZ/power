#!/usr/bin/env node
/**
 * mutate-v1187-20d.mjs — v1.187.20: Home Assistant backups hold SQLite checkpoints still while
 * they copy /data (server/src/backupWindow.ts, server/src/backupHook.mjs,
 * rootfs/usr/bin/ecoflow-panel-backup-hook, config.yaml backup_pre / backup_post).
 *
 *   L-i    the loopback check removed from the hook routes
 *   L-ii   the loopback check trusts a forwarding header
 *   D-i    the dead-man is never armed
 *   D-ii   the dead-man fires but restores nothing
 *   P-i    post never restores auto-checkpoint
 *   P-ii   post restores the value it finds (the 0 pre left), not the recorder's
 *   F-i    pre does not stop auto-checkpoints
 *   F-ii   pre does not empty the WAL
 *   H-i    the hook client exits non-zero when the server is unreachable
 *   H-ii   the shipped hook passes its client's failure to the Supervisor
 *   H-iii  the hook client stops journaling a failure
 *   J-i    the server stops journaling a phase
 *   C-i    config.yaml loses backup_pre
 *   C-ii   config.yaml switches to cold backups
 *   R-i    the recorder opens with auto-checkpoint 0
 *   A-i    the AppArmor profile loses the /usr/bin exec rule the hook runs under
 *   W-i    index.ts never registers the hook routes
 *
 *   node scripts/mutate-v1187-20d.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BW = resolve(REPO, 'server/src/backupWindow.ts');
const CLIENT = resolve(REPO, 'server/src/backupHook.mjs');
const HOOK = resolve(REPO, 'rootfs/usr/bin/ecoflow-panel-backup-hook');
const REC = resolve(REPO, 'server/src/recorder.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const CFG = resolve(REPO, 'ecoflow_panel/config.yaml');
const AA = resolve(REPO, 'ecoflow_panel/apparmor.txt');
const SUBSET = ['test/backupWindow.test.ts', 'test/backupHooks.test.ts', 'test/apparmorProfile.test.ts'];

const MUTANTS = [
  {
    id: 'L-i. ★★★ the loopback check removed from the hook routes',
    file: BW,
    find: '  if (isLoopbackPeer(req.socket?.remoteAddress)) return done();\n  reply.code(403)',
    to: '  return done(); /* MUTANT */\n  reply.code(403)',
    why: 'Anything on the LAN :8787 port or behind Ingress can freeze checkpoints at will.',
  },
  {
    id: 'L-ii. ★★★ the loopback check trusts a forwarding header',
    file: BW,
    find: 'if (isLoopbackPeer(req.socket?.remoteAddress)) return done();',
    to: "if (isLoopbackPeer(String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress))) return done(); /* MUTANT */",
    why: 'A LAN client forges X-Forwarded-For: 127.0.0.1 and passes as loopback.',
  },
  {
    id: 'D-i. ★★★ the dead-man is never armed',
    file: BW,
    find: '      deadMan = setTimeout(fireDeadMan, deadManMs);\n      deadMan.unref?.();\n',
    to: '      /* MUTANT: no dead-man */\n',
    why: 'A backup that dies between its hooks leaves checkpoints off until the next restart; the WAL grows without bound.',
  },
  {
    id: 'D-ii. ★★ the dead-man fires but restores nothing',
    file: BW,
    find: "    const r = restore();\n    const rec = record({ phase: 'deadman'",
    to: "    const r: Record<string, unknown> = { autocheckpoint: wal.autocheckpoint() }; /* MUTANT */\n    const rec = record({ phase: 'deadman'",
    why: 'The deadline passes, a line says so, and checkpoints stay off.',
  },
  {
    id: 'P-i. ★★★ post never restores auto-checkpoint',
    file: BW,
    find: '      const hadPre = openedAtMs != null;\n      const r = restore();',
    to: '      const hadPre = openedAtMs != null;\n      const r: Record<string, unknown> = { autocheckpoint: wal.autocheckpoint(), ok: true }; /* MUTANT */',
    why: 'Every nightly backup leaves checkpoints off for the dead-man\'s 10 minutes, or for good without it.',
  },
  {
    id: "P-ii. ★★ post restores the value it finds, not the recorder's",
    file: BW,
    find: 'try { out.autocheckpoint = wal.setAutocheckpoint(restoreTo); }',
    to: 'try { out.autocheckpoint = wal.setAutocheckpoint(wal.autocheckpoint()); /* MUTANT */ }',
    why: 'Restoring "what was there" restores the 0 that pre set: checkpoints never come back.',
  },
  {
    id: 'F-i. ★★★ pre does not stop auto-checkpoints',
    file: BW,
    find: 'try { rec.autocheckpoint = wal.setAutocheckpoint(0); }',
    to: 'try { rec.autocheckpoint = wal.setAutocheckpoint(restoreTo); /* MUTANT */ }',
    why: 'A checkpoint can land while tar reads ecoflow.db: the backup holds a torn database (the 10-03 bench: 19 of 20).',
  },
  {
    id: 'F-ii. ★★ pre does not empty the WAL',
    file: BW,
    find: "try { rec.checkpoint = wal.checkpoint('TRUNCATE'); }",
    to: "try { rec.checkpoint = wal.checkpoint('PASSIVE'); /* MUTANT */ }",
    why: 'The copy starts with a full WAL instead of an empty one.',
  },
  {
    id: 'H-i. ★★★ the hook client exits non-zero when the server is unreachable',
    file: CLIENT,
    find: '  .then(() => { clearTimeout(watchdog); process.exit(0); });',
    to: '  .then((ok) => { clearTimeout(watchdog); process.exit(ok ? 0 : 1); }); /* MUTANT */',
    why: 'The Supervisor drops the whole add-on from the backup whenever the server is down or booting.',
  },
  {
    id: "H-ii. ★★★ the shipped hook passes its client's failure to the Supervisor",
    file: HOOK,
    find: 'fi\nexit 0\n',
    to: 'fi\nexit "$rc" # MUTANT\n',
    why: 'A crashed or missing client fails the hook, and the add-on is left out of the backup.',
  },
  {
    id: 'H-iii. ★★ the hook client stops journaling a failure',
    file: CLIENT,
    find: '    note({ phase, ts: new Date().toISOString(), ok: false, elapsedMs: Date.now() - t0, error: why });\n',
    to: '    /* MUTANT: no journal line */\n',
    why: 'docker exec output never reaches the add-on log: an unquiesced backup leaves no trace anywhere.',
  },
  {
    id: 'J-i. ★★ the server stops journaling a phase',
    file: BW,
    find: 'rec.journaled = appendBackupJournal(journalPath, rec);',
    to: 'rec.journaled = false; /* MUTANT */',
    why: 'Nothing readable from outside the container shows the hooks ran.',
  },
  {
    id: 'C-i. ★★★ config.yaml loses backup_pre',
    file: CFG,
    find: 'backup_pre: /usr/bin/ecoflow-panel-backup-hook pre\n',
    to: '# MUTANT backup_pre removed\n',
    why: 'Nothing quiesces the database before the copy: back to torn hot backups.',
  },
  {
    id: 'C-ii. ★★ config.yaml switches to cold backups',
    file: CFG,
    find: 'backup: hot\n',
    to: 'backup: cold # MUTANT\n',
    why: 'The Supervisor stops the add-on, and the alarm engine with it, for every backup (and ignores the hooks).',
  },
  {
    id: 'R-i. ★★ the recorder opens with auto-checkpoint 0',
    file: REC,
    find: '    PRAGMA wal_autocheckpoint = ${RECORDER_WAL_AUTOCHECKPOINT};\n',
    to: '    PRAGMA wal_autocheckpoint = 0; -- MUTANT\n',
    why: 'Checkpoints never run outside a backup either; the restore target is no longer what the recorder uses.',
  },
  {
    id: 'A-i. ★★ the AppArmor profile loses the /usr/bin exec rule the hook runs under',
    file: AA,
    find: '  /usr/bin/** ix,\n',
    to: '  # MUTANT /usr/bin exec rule removed\n',
    why: 'Once `file,` is narrowed, the docker-exec\'d hook (and the node it runs) cannot execute: every backup fails it.',
  },
  {
    id: 'W-i. ★★ index.ts never registers the hook routes',
    file: IDX,
    find: 'registerBackupWindowRoutes(app, backupWindow);\n',
    to: '/* MUTANT: routes not registered */\n',
    why: 'The hook gets a 404 every night and the quiesce never happens.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset alone decides, so every kill comes from the tests named above.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-20d', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false });
