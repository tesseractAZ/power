/**
 * v1.187.20 — the backup window: SQLite checkpoints held still while a Home Assistant backup
 * copies /data (server/src/backupWindow.ts).
 *
 * The 2026-10-12 log review found every nightly backup copying the live WAL database hot: tar
 * reads ecoflow.db, -wal and -shm one after another while the recorder commits, and a checkpoint
 * that lands inside that copy leaves a torn database in the backup (the 2026-10-03 bench: 19 of 20
 * copies torn with checkpoints running, 0 of 40 with them held still). These tests drive a real
 * node:sqlite WAL database; the central one shows the main file stays byte-identical while more
 * than the auto-checkpoint threshold is committed inside the window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import {
  BACKUP_DEAD_MAN_MS, BACKUP_WINDOW_ROUTE, RECORDER_WAL_AUTOCHECKPOINT, createBackupWindow, isLoopbackPeer,
  registerBackupWindowRoutes, resolveBackupJournalPath, walControlFor, type BackupWindow,
} from '../src/backupWindow.js';
import { panelFastifyOptions } from '../src/logHooks.js';

const tmp = mkdtempSync(join(tmpdir(), 'ef-backup-window-'));
// The recorder reads DB_PATH once, at import (config.ts) — set before the dynamic import below.
process.env.DB_PATH = join(tmp, 'recorder', 'ecoflow.db');
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function freshDb() {
  const dir = join(tmp, `db-${++seq}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'ecoflow.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = ${RECORDER_WAL_AUTOCHECKPOINT};
           CREATE TABLE samples (ts INTEGER NOT NULL, payload BLOB NOT NULL);`);
  return { db, path, dir, journal: join(dir, 'backup-window.jsonl') };
}
/** `txns` commits of 100 rows x 4 KB: 15 commits is about 1,500 pages, past the 1,000-page threshold. */
function commit(db: DatabaseSync, txns: number) {
  const ins = db.prepare('INSERT INTO samples VALUES (?, randomblob(4000))');
  for (let t = 0; t < txns; t++) {
    db.exec('BEGIN');
    for (let i = 0; i < 100; i++) ins.run(Date.now());
    db.exec('COMMIT');
  }
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const journalLines = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function quietLog() {
  const info: string[] = []; const warn: string[] = [];
  return { info, warn, log: { info: (m: string) => { info.push(m); }, warn: (m: string) => { warn.push(m); } } };
}
async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

test('★★★ pre empties the WAL and stops auto-checkpoints; the main file cannot change until post restores them', () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  const l = quietLog();
  const bw = createBackupWindow({ wal, journalPath: journal, log: l.log });
  try {
    commit(db, 3);
    assert.ok((wal.walBytes() ?? 0) > 0, 'precondition: committed rows sit in the WAL');

    const pre = bw.pre('127.0.0.1');
    assert.equal(pre.ok, true);
    assert.equal(wal.autocheckpoint(), 0, 'auto-checkpoint is off for the window');
    assert.equal(pre.autocheckpoint, 0);
    assert.equal(statSync(`${path}-wal`).size, 0, 'TRUNCATE emptied the WAL before the copy starts');
    assert.equal(pre.walBytesAfter, 0);
    assert.ok((pre.walBytesBefore as number) > 0);

    // The copy. More than RECORDER_WAL_AUTOCHECKPOINT pages are committed while tar reads; with
    // checkpoints held still, not one byte of the main file changes under it.
    const mainAtCopy = sha(path);
    commit(db, 15);
    assert.ok((wal.walBytes() ?? 0) > RECORDER_WAL_AUTOCHECKPOINT * 4096, 'the WAL went past the threshold');
    assert.equal(sha(path), mainAtCopy, 'no checkpoint touched the main file inside the window');

    const post = bw.post('127.0.0.1');
    assert.equal(post.ok, true);
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT, "post restores the recorder's value");
    assert.equal(post.autocheckpoint, RECORDER_WAL_AUTOCHECKPOINT);
    assert.equal(post.hadPre, true);
    assert.notEqual(sha(path), mainAtCopy, 'the PASSIVE checkpoint folded the window into the main file');

    // Control: outside a window the same commits DO reach the main file, so the assertion above
    // is about the window and not about this SQLite build never checkpointing.
    const before = sha(path);
    commit(db, 15);
    assert.notEqual(sha(path), before, 'auto-checkpoint runs again after post');
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');

    const lines = journalLines(journal);
    assert.deepEqual(lines.map((r) => r.phase), ['pre', 'post'], 'one journal line per hook');
    assert.equal(lines[0].autocheckpoint, 0);
    assert.equal(lines[1].autocheckpoint, RECORDER_WAL_AUTOCHECKPOINT);
    assert.equal(typeof lines[1].windowMs, 'number');
    assert.ok(l.info.some((m) => m.startsWith('backup-window: pre')) && l.info.some((m) => m.startsWith('backup-window: post')), 'logged through the server log too');
    assert.equal(l.warn.length, 0);
  } finally { bw.stop(); db.close(); }
});

test('★★★ the dead-man restores auto-checkpoint when the post hook never comes', async () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  const l = quietLog();
  const bw = createBackupWindow({ wal, journalPath: journal, log: l.log, deadManMs: 40 });
  try {
    bw.pre();
    assert.equal(wal.autocheckpoint(), 0);
    assert.ok(bw.status().deadManDueAt, 'a deadline is armed');
    assert.ok(await until(() => !bw.status().windowOpen), 'the window closes on its own');
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT, 'restored without a post hook');
    assert.equal(bw.status().deadManDueAt, null);
    assert.deepEqual(journalLines(journal).map((r) => r.phase), ['pre', 'deadman']);
    assert.ok(l.warn.some((m) => m.includes('no post-backup hook')), 'the dead-man warns');
    // The late post hook still restores (idempotent) and says the dead-man got there first.
    const late = bw.post();
    assert.equal(late.hadPre, false);
    assert.equal(late.deadManClosedWindow, true);
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT);
  } finally { bw.stop(); db.close(); }
});

test('★★ post disarms the dead-man; the default deadline is 10 minutes', async () => {
  assert.equal(BACKUP_DEAD_MAN_MS, 10 * 60_000);
  const { db, path, journal } = freshDb();
  const bw = createBackupWindow({ wal: walControlFor(db, path), journalPath: journal, log: quietLog().log, deadManMs: 40 });
  try {
    bw.pre();
    bw.post();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bw.status().lastDeadMan, null, 'no dead-man after a completed window');
    assert.deepEqual(journalLines(journal).map((r) => r.phase), ['pre', 'post']);
  } finally { bw.stop(); db.close(); }
});

test("★★ a second pre re-arms, and post still restores the recorder's value, never the 0 it found", () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  let t = Date.parse('2026-10-12T03:30:34Z');
  const bw = createBackupWindow({ wal, journalPath: journal, log: quietLog().log, now: () => t });
  try {
    bw.pre();
    const firstDue = bw.status().deadManDueAt;
    t += 60_000;
    const again = bw.pre();
    assert.equal(again.rearmed, true);
    assert.notEqual(bw.status().deadManDueAt, firstDue, 'the deadline moved with the second pre');
    assert.equal(wal.autocheckpoint(), 0);
    bw.post();
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT);
  } finally { bw.stop(); db.close(); }
});

test('★★ post without a pre (a restart inside the window) still restores, and says so', () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  wal.setAutocheckpoint(0);
  const l = quietLog();
  const bw = createBackupWindow({ wal, journalPath: journal, log: l.log });
  try {
    const post = bw.post();
    assert.equal(post.hadPre, false);
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT);
    assert.ok(l.info.some((m) => m.includes('no pre hook was seen')));
  } finally { bw.stop(); db.close(); }
});

test('★★★ the hook routes answer loopback peers only — never the LAN :8787 port, never Ingress', async () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  const bw = createBackupWindow({ wal, journalPath: journal, log: quietLog().log });
  const app = Fastify(panelFastifyOptions('silent'));
  registerBackupWindowRoutes(app, bw);
  try {
    // Off the box: a LAN client on the published port (plain and IPv4-mapped, as the dual-stack
    // listener reports it), the Supervisor's Ingress proxy with its header, and forged headers.
    const outside: Array<{ remoteAddress: string; headers?: Record<string, string> }> = [
      { remoteAddress: '192.168.1.20' },
      { remoteAddress: '::ffff:192.168.1.20' },
      { remoteAddress: '::ffff:172.30.32.2', headers: { 'x-ingress-path': '/api/hassio_ingress/abc' } },
      { remoteAddress: '::ffff:192.168.1.20', headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '::1' } },
      { remoteAddress: '::ffff:192.168.1.20', headers: { origin: 'http://127.0.0.1:8787' } },
      { remoteAddress: 'fe80::1' },
      { remoteAddress: '127.0.0.2' },
    ];
    for (const phase of ['pre', 'post']) {
      for (const o of outside) {
        const res = await app.inject({ method: 'POST', url: `${BACKUP_WINDOW_ROUTE}/${phase}`, remoteAddress: o.remoteAddress, headers: o.headers });
        assert.equal(res.statusCode, 403, `${phase} from ${o.remoteAddress} ${JSON.stringify(o.headers ?? {})}`);
      }
    }
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT, 'a refused request changed nothing');
    assert.equal(bw.status().lastPre, null);
    assert.deepEqual(journalLines(journal), []);

    for (const peer of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
      const pre = await app.inject({ method: 'POST', url: `${BACKUP_WINDOW_ROUTE}/pre`, remoteAddress: peer });
      assert.equal(pre.statusCode, 200, `pre from ${peer}`);
      assert.equal(pre.json().autocheckpoint, 0);
      assert.equal(pre.json().peer, peer);
      const post = await app.inject({ method: 'POST', url: `${BACKUP_WINDOW_ROUTE}/post`, remoteAddress: peer });
      assert.equal(post.statusCode, 200, `post from ${peer}`);
      assert.equal(post.json().autocheckpoint, RECORDER_WAL_AUTOCHECKPOINT);
    }

    // The status route is read-only, so it is readable from the LAN (verification after a deploy).
    await app.inject({ method: 'POST', url: `${BACKUP_WINDOW_ROUTE}/pre`, remoteAddress: '127.0.0.1' });
    const st = await app.inject({ method: 'GET', url: '/api/backup-window', remoteAddress: '192.168.1.20' });
    assert.equal(st.statusCode, 200);
    assert.equal(st.json().windowOpen, true);
    assert.equal(st.json().autocheckpoint, 0, "the recorder connection's live value");
    assert.equal(st.json().journalPath, journal);
    const viaGet = await app.inject({ method: 'GET', url: `${BACKUP_WINDOW_ROUTE}/post`, remoteAddress: '127.0.0.1' });
    assert.equal(viaGet.statusCode, 404, 'the hooks are POST-only');
  } finally { bw.stop(); await app.close(); db.close(); }
});

test('★★ isLoopbackPeer is exact', () => {
  for (const a of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) assert.equal(isLoopbackPeer(a), true, a);
  for (const a of [undefined, null, '', '127.0.0.2', '::ffff:127.0.0.2', '0.0.0.0', '::', '172.30.32.2', '::ffff:172.30.32.2', '192.168.1.20', 'localhost', ' 127.0.0.1']) {
    assert.equal(isLoopbackPeer(a as string | undefined), false, String(a));
  }
});

test('★★ a real socket on a dual-stack listener (production HOST=::) passes the loopback check', async () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  const bw = createBackupWindow({ wal, journalPath: journal, log: quietLog().log });
  const app = Fastify(panelFastifyOptions('silent'));
  registerBackupWindowRoutes(app, bw);
  try {
    let host = '::';
    try { await app.listen({ host, port: 0 }); } catch { host = '127.0.0.1'; await app.listen({ host, port: 0 }); }
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${BACKUP_WINDOW_ROUTE}/pre`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { peer: string; autocheckpoint: number };
    assert.ok(isLoopbackPeer(body.peer), `peer ${body.peer}`);
    assert.equal(wal.autocheckpoint(), 0);
  } finally { bw.stop(); await app.close(); db.close(); }
});

test('★★ the journal goes to /share/ecoflow-panel when /share is mapped, else to /data', () => {
  const share = join(tmp, 'share');
  const data = join(tmp, 'data');
  const env = {} as NodeJS.ProcessEnv;
  assert.equal(resolveBackupJournalPath({ dataDir: data, shareRoot: share, env }), join(data, 'backup-window.jsonl'));
  mkdirSync(share, { recursive: true });
  assert.equal(resolveBackupJournalPath({ dataDir: data, shareRoot: share, env }), join(share, 'ecoflow-panel', 'backup-window.jsonl'));
  assert.equal(resolveBackupJournalPath({ dataDir: data, shareRoot: share, env: { BACKUP_WINDOW_LOG: '/x/y.jsonl' } as NodeJS.ProcessEnv }), '/x/y.jsonl');
});

test('★★★ the recorder sets its auto-checkpoint explicitly and hands the window its write connection', async () => {
  const { createRecorder } = await import('../src/recorder.js');
  const { SnapshotStore } = await import('../src/snapshot.js');
  const rec = createRecorder(new SnapshotStore(), () => {});
  let bw: BackupWindow | null = null;
  try {
    assert.equal(rec.walControl.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT);
    bw = createBackupWindow({ wal: rec.walControl, journalPath: join(tmp, 'recorder', 'backup-window.jsonl'), log: quietLog().log });
    bw.pre();
    assert.equal(rec.walControl.autocheckpoint(), 0);
    assert.equal(rec.walControl.walBytes(), 0);
    bw.post();
    assert.equal(rec.walControl.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT);
  } finally { bw?.stop(); rec.close(); }
});

test('★ index.ts builds the window over the recorder connection, registers the routes and disarms it at shutdown', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /createBackupWindow\(\{\s*wal: recorder\.walControl,/);
  assert.match(src, /registerBackupWindowRoutes\(app, backupWindow\);/);
  const shutdown = src.slice(src.indexOf('const shutdown = async () => {'));
  assert.ok(shutdown.indexOf('backupWindow.stop();') > 0 && shutdown.indexOf('backupWindow.stop();') < shutdown.indexOf('recorder.close();'));
});
