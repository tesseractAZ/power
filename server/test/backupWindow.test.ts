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
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import {
  BACKUP_DEADLINE_HEADER, BACKUP_DEAD_MAN_MS, BACKUP_WINDOW_ROUTE, RECORDER_WAL_AUTOCHECKPOINT, createBackupWindow, isLoopbackPeer,
  registerBackupWindowRoutes, resolveBackupJournalPath, walControlFor, type BackupWindow, type CheckpointResult, type WalControl,
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

    assert.equal(bw.status().windowOpen, true);
    const post = bw.post('127.0.0.1');
    assert.equal(post.ok, true);
    assert.equal(bw.status().windowOpen, false, 'post closes the window');
    assert.equal(bw.status().openedAt, null);
    assert.equal(bw.status().deadManDueAt, null);
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
    assert.equal(bw.status().windowOpen, true);
    assert.ok(bw.status().openedAt);
    bw.post();
    // The status route reports a closed window after every completed backup, and the next
    // night's pre is a fresh window, not a re-arm of a window this one left open.
    assert.equal(bw.status().windowOpen, false, 'post closes the window');
    assert.equal(bw.status().openedAt, null);
    assert.equal(bw.status().deadManDueAt, null);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bw.status().lastDeadMan, null, 'no dead-man after a completed window');
    assert.deepEqual(journalLines(journal).map((r) => r.phase), ['pre', 'post']);
    assert.equal(bw.pre().rearmed, false, "the next pre does not find this window still open");
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

test("★★★ a second pre cancels the first pre's dead-man: past the first deadline the window is still frozen", (t) => {
  // Timing on node:test's mock timers (deterministic under load): dead-man 200 ms; pre at 0,
  // pre again at 120, look at 270 (past the first deadline, before the second at 320), then at 330.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  let now = Date.parse('2026-10-12T03:30:00Z');
  const l = quietLog();
  const bw = createBackupWindow({ wal, journalPath: journal, log: l.log, deadManMs: 200, now: () => now });
  const advance = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
  try {
    bw.pre();
    advance(120);
    assert.equal(bw.pre().rearmed, true);
    advance(150);
    assert.equal(wal.autocheckpoint(), 0, "the first pre's deadline passed and checkpoints are still held");
    assert.equal(bw.status().windowOpen, true);
    assert.equal(bw.status().lastDeadMan, null, 'the first dead-man was cancelled, not left to fire');
    assert.equal(l.warn.length, 0);
    advance(60);
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT, "the second pre's dead-man fires on time");
    assert.equal(bw.status().windowOpen, false);
    assert.deepEqual(journalLines(journal).map((r) => r.phase), ['pre', 'pre', 'deadman'], 'exactly one dead-man');
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
    assert.equal(post.preRefused, false);
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

test('★★★ the window freezes the connection the recorder COMMITS on — proved through the recorder\'s own write path', async () => {
  // wal_autocheckpoint is per connection, and reads through walControl give the same answers on
  // ANY connection to the file. So this drives commits through the recorder's own API and watches
  // the main file: only a setting on the committing connection decides whether they reach it.
  const { createRecorder } = await import('../src/recorder.js');
  const { SnapshotStore } = await import('../src/snapshot.js');
  const rec = createRecorder(new SnapshotStore(), () => {});
  const dbPath = process.env.DB_PATH as string;
  let bw: BackupWindow | null = null;
  let hour = Date.parse('2026-10-12T00:00:00Z');
  let pv = 70_000;
  // One autocommit row per call (an hour-snapped forecast archive row, distinct hour and value).
  const write = (n: number) => { for (let i = 0; i < n; i++) rec.recordForecastArchive((pv += 1000), (hour += 3_600_000)); };
  try {
    assert.equal(rec.walControl.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT, 'set explicitly at open');

    // (1) A 1-page threshold set through walControl makes the recorder's very next commit
    // checkpoint into the main file — only if walControl is the connection that commits.
    rec.walControl.checkpoint('TRUNCATE');
    rec.walControl.setAutocheckpoint(1);
    const beforeOne = sha(dbPath);
    write(1);
    assert.notEqual(sha(dbPath), beforeOne, "walControl's setting governs the recorder's own commits");

    // (2) The window over that connection (restoreTo 1, so any commit outside it reaches the main
    // file at once): 50 recorder commits inside the window leave the main file byte-identical.
    bw = createBackupWindow({ wal: rec.walControl, journalPath: join(tmp, 'recorder', 'backup-window.jsonl'), log: quietLog().log, restoreTo: 1 });
    const pre = bw.pre();
    assert.equal(pre.ok, true);
    assert.equal(rec.walControl.walBytes(), 0, 'TRUNCATE emptied the WAL');
    const mainAtCopy = sha(dbPath);
    write(50);
    assert.ok((rec.walControl.walBytes() ?? 0) > 0, 'the commits went to the WAL');
    assert.equal(sha(dbPath), mainAtCopy, "no checkpoint touched the main file while the recorder committed inside the window");

    // (3) post restores the threshold on that same connection: the next commit reaches the file.
    assert.equal(bw.post().ok, true);
    const afterPost = sha(dbPath);
    assert.notEqual(afterPost, mainAtCopy, "post's PASSIVE checkpoint folded the window in");
    write(1);
    assert.notEqual(sha(dbPath), afterPost, "the recorder's commits checkpoint again after post");
    rec.walControl.setAutocheckpoint(RECORDER_WAL_AUTOCHECKPOINT);
  } finally { bw?.stop(); rec.close(); }
});

/** A WalControl whose calls fail as a closed handle's do (or whose setting does not take). */
function stubWal(o: { checkpointThrows?: boolean; setThrows?: boolean; readThrows?: boolean; stuckAt?: number }): WalControl {
  const boom = (): never => { throw new Error('database is not open'); };
  let ac = RECORDER_WAL_AUTOCHECKPOINT;
  return {
    checkpoint: (): CheckpointResult => (o.checkpointThrows ? boom() : { busy: 0, log: 0, checkpointed: 0 }),
    setAutocheckpoint: (pages) => { if (o.setThrows) boom(); ac = o.stuckAt ?? pages; return ac; },
    autocheckpoint: () => (o.readThrows ? boom() : ac),
    walBytes: () => null,
  };
}

test('★★★ a freeze or restore that fails is journaled ok:false with its error and logged as a warning — never as a success', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = join(tmp, `stub-${++seq}`);
  const journal = join(dir, 'backup-window.jsonl');
  const l = quietLog();
  // The recorder handle closed under the window (a shutdown overlapping a backup): every call throws.
  const bw = createBackupWindow({ wal: stubWal({ checkpointThrows: true, setThrows: true, readThrows: true }), journalPath: journal, log: l.log });
  try {
    const pre = bw.pre('127.0.0.1');
    assert.equal(pre.ok, false, 'checkpoints were not frozen: pre must not report a quiesced copy');
    assert.equal(pre.autocheckpoint, null);
    assert.match(String(pre.autocheckpointError), /not open/);
    assert.match(String(pre.checkpointError), /not open/);
    t.mock.timers.tick(BACKUP_DEAD_MAN_MS);
    assert.equal(bw.status().lastDeadMan?.ok, false, 'the dead-man restore failed too');
    const post = bw.post('127.0.0.1');
    assert.equal(post.ok, false);
    assert.equal(post.autocheckpoint, null);
    assert.match(String(post.autocheckpointError), /not open/);
    assert.match(String(post.checkpointError), /not open/);
    assert.equal(bw.status().autocheckpoint, null, 'status reports an unreadable setting as null');

    const lines = journalLines(journal);
    assert.deepEqual(lines.map((r) => `${r.phase}:${r.ok}`), ['pre:false', 'deadman:false', 'post:false'], 'the journal, the only evidence outside the container, says so');
    for (const r of lines) assert.ok(r.autocheckpointError && r.checkpointError, `${r.phase} carries both errors`);
    assert.equal(l.info.length, 0, 'nothing logged at info');
    assert.ok(l.warn.some((m) => m.startsWith('backup-window: pre')) && l.warn.some((m) => m.startsWith('backup-window: post')), 'both logged as warnings');
  } finally { bw.stop(); }
});

test('★★ ok needs BOTH halves: a failed checkpoint, or a setting that did not take, is ok:false', () => {
  const dir = join(tmp, `stub-${++seq}`);
  // The checkpoint fails while the setting works: the value is right, the phase is still not ok.
  const l = quietLog();
  const cp = createBackupWindow({ wal: stubWal({ checkpointThrows: true }), journalPath: join(dir, 'a.jsonl'), log: l.log });
  try {
    const pre = cp.pre();
    assert.equal(pre.autocheckpoint, 0);
    assert.equal(pre.ok, false);
    const post = cp.post();
    assert.equal(post.autocheckpoint, RECORDER_WAL_AUTOCHECKPOINT);
    assert.equal(post.ok, false);
    assert.deepEqual(journalLines(join(dir, 'a.jsonl')).map((r) => r.ok), [false, false]);
    assert.equal(l.info.length, 0);
    assert.equal(l.warn.length, 2);
  } finally { cp.stop(); }
  // The setting reads back as something other than what was asked: pre stuck at the recorder's
  // value never froze; post stuck at 0 never restored.
  for (const [stuckAt, phase] of [[RECORDER_WAL_AUTOCHECKPOINT, 'pre'], [0, 'post']] as const) {
    const bw = createBackupWindow({ wal: stubWal({ stuckAt }), journalPath: join(dir, `stuck-${stuckAt}.jsonl`), log: quietLog().log });
    try {
      const pre = bw.pre();
      const post = bw.post();
      assert.equal(pre.ok, phase !== 'pre', `pre with the setting stuck at ${stuckAt}`);
      assert.equal(post.ok, phase !== 'post', `post with the setting stuck at ${stuckAt}`);
    } finally { bw.stop(); }
  }
});

test('★★★ a pre the hook has already given up on changes nothing — past its deadline, or with its connection closed', () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  let t = Date.parse('2026-10-12T03:30:08Z');
  const l = quietLog();
  const bw = createBackupWindow({ wal, journalPath: journal, log: l.log, now: () => t });
  try {
    commit(db, 3);
    const walBefore = wal.walBytes();
    assert.ok((walBefore ?? 0) > 0, 'precondition: frames in the WAL');
    const mainBefore = sha(path);
    const late = [{ deadlineMs: t - 1 }, { deadlineMs: t - 60_000 }, { clientGone: true }, { deadlineMs: t + 5000, clientGone: true }];
    for (const guard of late) {
      const r = bw.pre('127.0.0.1', guard);
      assert.equal(r.ok, false, JSON.stringify(guard));
      assert.equal(r.refused, true);
      assert.equal(r.error, 'client gone');
      assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT, 'no freeze');
      assert.equal(wal.walBytes(), walBefore, 'no TRUNCATE: a WAL tar may be reading did not shrink');
      assert.equal(sha(path), mainBefore, 'no checkpoint wrote the main file');
      assert.equal(bw.status().windowOpen, false);
      assert.equal(bw.status().deadManDueAt, null, 'no dead-man armed');
    }
    assert.match(String(bw.status().lastPre?.reason), /closed/);
    const lines = journalLines(journal);
    assert.deepEqual(lines.map((r) => `${r.phase}:${r.ok}:${r.error}`), late.map(() => 'pre:false:client gone'), 'one ok:false line each');
    assert.match(lines[0].reason, /deadline passed 1 ms ago/);
    assert.equal(lines[0].deadlineAt, new Date(t - 1).toISOString());
    assert.equal(l.warn.length, late.length);
    assert.ok(l.warn.every((m) => m.startsWith('backup-window: pre refused — client gone')));
    assert.equal(l.info.length, 0);

    // On time (the deadline is now, or none was sent): the window opens as before.
    const onTime = bw.pre('127.0.0.1', { deadlineMs: t, clientGone: false });
    assert.equal(onTime.ok, true);
    assert.equal(wal.autocheckpoint(), 0);
    assert.equal(wal.walBytes(), 0);
    bw.post();
    assert.equal(bw.pre('127.0.0.1', { deadlineMs: null }).ok, true);
  } finally { bw.stop(); db.close(); }
});

test('★★ a late pre leaves an open window alone: its freeze and its dead-man stay as they were', () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  let t = Date.parse('2026-10-12T03:30:00Z');
  const bw = createBackupWindow({ wal, journalPath: journal, log: quietLog().log, now: () => t });
  try {
    assert.equal(bw.pre().ok, true);
    const before = bw.status();
    t += 9000;
    const r = bw.pre('127.0.0.1', { deadlineMs: t - 1000 });
    assert.equal(r.refused, true);
    assert.equal(r.windowOpen, true);
    const after = bw.status();
    assert.equal(after.windowOpen, true);
    assert.equal(after.autocheckpoint, 0);
    assert.equal(after.openedAt, before.openedAt);
    assert.equal(after.deadManDueAt, before.deadManDueAt);
  } finally { bw.stop(); db.close(); }
});

test('★★ the post after a refused pre says the pre was refused, not that none was seen; an accepted pre or a post clears it', () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  let t = Date.parse('2026-10-12T03:30:08Z');
  const l = quietLog();
  const bw = createBackupWindow({ wal, journalPath: journal, log: l.log, now: () => t });
  const lastPostLine = () => l.info.filter((m) => m.startsWith('backup-window: post')).at(-1) ?? '';
  try {
    // The hook gave up, the Supervisor copied /data unquiesced, then ran the post hook.
    assert.equal(bw.pre('127.0.0.1', { deadlineMs: t - 1 }).refused, true);
    t += 30_000;
    const post = bw.post('127.0.0.1');
    assert.equal(post.ok, true, 'the restore itself worked');
    assert.equal(post.hadPre, false);
    assert.equal(post.preRefused, true);
    assert.match(lastPostLine(), /; the pre hook was refused \(client gone\), so this copy was not quiesced$/);
    assert.doesNotMatch(lastPostLine(), /no pre hook was seen/, 'no contradiction of the refusal warning above it');

    // Post clears it: a later post with no pre in between (a restart, a hand-run call) has no refusal to report.
    const again = bw.post();
    assert.equal(again.preRefused, false);
    assert.match(lastPostLine(), /; no pre hook was seen$/);

    // An accepted pre after a refused one clears it: that backup's copy was quiesced.
    assert.equal(bw.pre('127.0.0.1', { clientGone: true }).refused, true);
    assert.equal(bw.pre('127.0.0.1', { deadlineMs: t + 5000 }).ok, true);
    t += 30_000;
    const quiesced = bw.post('127.0.0.1');
    assert.equal(quiesced.preRefused, false);
    assert.match(lastPostLine(), /; window 30 s$/);

    const posts = journalLines(journal).filter((r) => r.phase === 'post');
    assert.deepEqual(posts.map((r) => r.preRefused), [true, false, false], 'the journal carries it on each post line');
    assert.equal(l.warn.length, 2, 'only the two refusals warn');
  } finally { bw.stop(); db.close(); }
});

test('★★★ the pre route reads the hook deadline header: past it 409 and nothing changes, ahead of it the window opens', async () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  const bw = createBackupWindow({ wal, journalPath: journal, log: quietLog().log });
  const app = Fastify(panelFastifyOptions('silent'));
  registerBackupWindowRoutes(app, bw);
  try {
    commit(db, 2);
    const walBefore = wal.walBytes();
    const pre = (headers: Record<string, string>) => app.inject({ method: 'POST', url: `${BACKUP_WINDOW_ROUTE}/pre`, remoteAddress: '127.0.0.1', headers });
    const past = await pre({ [BACKUP_DEADLINE_HEADER]: String(Date.now() - 1000) });
    assert.equal(past.statusCode, 409);
    assert.equal(past.json().ok, false);
    assert.equal(past.json().error, 'client gone');
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT);
    assert.equal(wal.walBytes(), walBefore);

    // A header that is not epoch milliseconds is no deadline (as for a hand-run call).
    const odd = await pre({ [BACKUP_DEADLINE_HEADER]: 'soon' });
    assert.equal(odd.statusCode, 200);
    assert.equal(odd.json().ok, true);
    await app.inject({ method: 'POST', url: `${BACKUP_WINDOW_ROUTE}/post`, remoteAddress: '127.0.0.1', headers: { [BACKUP_DEADLINE_HEADER]: String(Date.now() - 1000) } })
      .then((r) => assert.equal(r.statusCode, 200, 'post is never refused: it only restores, after the copy'));
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT);

    const ahead = await pre({ [BACKUP_DEADLINE_HEADER]: String(Date.now() + 60_000) });
    assert.equal(ahead.statusCode, 200);
    assert.equal(ahead.json().ok, true);
    assert.equal(wal.autocheckpoint(), 0);
  } finally { bw.stop(); await app.close(); db.close(); }
});

test('★★ a pre whose connection closed before its handler ran is refused, even with no deadline header', async () => {
  const { db, path, journal } = freshDb();
  const wal = walControlFor(db, path);
  const bw = createBackupWindow({ wal, journalPath: journal, log: quietLog().log });
  const app = Fastify(panelFastifyOptions('silent'));
  let arrived = () => {};
  const arrivedP = new Promise<void>((r) => { arrived = r; });
  // Holds the request after the route's loopback check until its client has left, as a slow
  // hook chain or body read would; Fastify still runs the handler after that.
  app.addHook('preHandler', async (req) => {
    if (!req.url.endsWith('/pre')) return;
    arrived();
    await until(() => req.raw.socket.destroyed, 5000);
  });
  registerBackupWindowRoutes(app, bw);
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const c = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `${BACKUP_WINDOW_ROUTE}/pre` });
    c.on('error', () => { /* destroyed on purpose */ });
    c.end();
    await arrivedP;
    c.destroy();
    assert.ok(await until(() => bw.status().lastPre != null), 'the handler still ran');
    const r = bw.status().lastPre as Record<string, unknown>;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'client gone');
    assert.match(String(r.reason), /connection was already closed/);
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT);
    assert.equal(bw.status().windowOpen, false);
  } finally { bw.stop(); await app.close(); db.close(); }
});

test('★ index.ts builds the window over the recorder connection, registers the routes and disarms it at shutdown', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /createBackupWindow\(\{\s*wal: recorder\.walControl,/);
  assert.match(src, /registerBackupWindowRoutes\(app, backupWindow\);/);
  const shutdown = src.slice(src.indexOf('const shutdown = async () => {'));
  assert.ok(shutdown.indexOf('backupWindow.stop();') > 0 && shutdown.indexOf('backupWindow.stop();') < shutdown.indexOf('recorder.close();'));
});
