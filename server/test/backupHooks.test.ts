/**
 * v1.187.20 — the Home Assistant backup hooks, as shipped: the config.yaml keys, the executable
 * in the image, the hook client, and the whole path end to end.
 *
 * The Supervisor (2026.09.3, supervisor/apps/app.py) runs `backup_pre` / `backup_post` with
 * `docker exec` in the running add-on, and a non-zero exit makes it leave the add-on out of the
 * backup (AppPrePostBackupCommandReturnedError, then store_apps skips the add-on). A hook it
 * cannot exec fails at BACKUP time, not at build time, so the packaging is pinned here too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import {
  BACKUP_DEADLINE_HEADER, RECORDER_WAL_AUTOCHECKPOINT, createBackupWindow, registerBackupWindowRoutes, walControlFor,
} from '../src/backupWindow.js';
import { panelFastifyOptions } from '../src/logHooks.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = join(REPO, 'rootfs/usr/bin/ecoflow-panel-backup-hook');
const CLIENT = join(REPO, 'server/src/backupHook.mjs');
const IMAGE_NODE = '/usr/bin/node';
const IMAGE_CLIENT = '/app/server/src/backupHook.mjs';
const CONFIG = readFileSync(join(REPO, 'ecoflow_panel/config.yaml'), 'utf8');
const DOCKERFILE = readFileSync(join(REPO, 'Dockerfile'), 'utf8');

const tmp = mkdtempSync(join(tmpdir(), 'ef-backup-hooks-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const fresh = (name: string) => { const d = join(tmp, `${name}-${++seq}`); mkdirSync(d, { recursive: true }); return d; };
const journalLines = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function run(file: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; ms: number; stderr: string }> {
  const t0 = Date.now();
  return new Promise((res) => {
    execFile(file, args, { env: { PATH: process.env.PATH ?? '', ...env }, timeout: 30_000 }, (err, _out, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, ms: Date.now() - t0, stderr: String(stderr) });
    });
  });
}
const runClient = (phase: string, env: Record<string, string>) => run(process.execPath, [CLIENT, phase], env);

/** The shipped hook with its two image paths pointed at this checkout (both must appear exactly once). */
function hookCopy(client = CLIENT): string {
  const src = readFileSync(HOOK, 'utf8');
  for (const lit of [IMAGE_NODE, IMAGE_CLIENT]) assert.equal(src.split(lit).length - 1, 1, `${lit} appears once in the hook`);
  const out = join(fresh('hook'), 'ecoflow-panel-backup-hook');
  writeFileSync(out, src.replace(IMAGE_NODE, process.execPath).replace(IMAGE_CLIENT, client));
  chmodSync(out, 0o755);
  return out;
}

async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as { port: number }).port;
}

test('★★★ config.yaml declares hot backups with the pre and post hooks, and maps /share for the journal', () => {
  assert.match(CONFIG, /^backup: hot$/m, 'hot: a cold backup stops the alarm engine for the whole copy');
  assert.match(CONFIG, /^backup_pre: \/usr\/bin\/ecoflow-panel-backup-hook pre$/m);
  assert.match(CONFIG, /^backup_post: \/usr\/bin\/ecoflow-panel-backup-hook post$/m);
  assert.match(CONFIG, /^ {2}- share:rw$/m, '/share is mapped read-write (the journal lives there)');
  assert.doesNotMatch(CONFIG, /^backup_exclude:/m, 'nothing in /data is excluded from the copy');
});

test('★★★ the image ships the hook as an executable at the path config.yaml names', () => {
  assert.ok(existsSync(HOOK), 'rootfs/usr/bin/ecoflow-panel-backup-hook exists');
  assert.ok((statSync(HOOK).mode & 0o111) === 0o111, 'the file is executable in the repository (git mode 100755)');
  assert.match(readFileSync(HOOK, 'utf8'), /^#!\/bin\/sh\n/, 'a /bin/sh script (busybox in the image)');
  assert.match(DOCKERFILE, /^COPY rootfs\/ \/$/m, 'rootfs is copied into the image');
  const chmod = DOCKERFILE.split('\n').find((l) => l.startsWith('RUN chmod a+x '));
  assert.ok(chmod && chmod.split(/\s+/).includes('/usr/bin/ecoflow-panel-backup-hook'), 'and made executable there, whatever the build context says');
  assert.match(DOCKERFILE, /^COPY server\/ \.\/server\/$/m, 'the client ships under /app/server');
  assert.ok(existsSync(CLIENT));
  const ignore = readFileSync(join(REPO, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(!ignore.some((l) => l === 'rootfs/' || l === 'rootfs' || l.startsWith('server/src')), '.dockerignore keeps both in the build context');
});

test('★★★ the hook client exits 0 and journals the failure when the server is down', async () => {
  const port = await closedPort();
  for (const phase of ['pre', 'post']) {
    const journal = join(fresh('down'), 'backup-window.jsonl');
    const r = await runClient(phase, { PORT: String(port), BACKUP_WINDOW_LOG: journal });
    assert.equal(r.code, 0, `${phase}: exit 0, or the Supervisor drops the add-on from the backup (${r.stderr})`);
    const lines = journalLines(journal);
    assert.equal(lines.length, 1, `${phase}: one journal line`);
    assert.equal(lines[0].phase, phase);
    assert.equal(lines[0].ok, false);
    assert.equal(lines[0].by, 'hook');
    assert.match(lines[0].error, /server unreachable/);
  }
});

test('★★ the hook client exits 0 within its timeout when the server accepts and never answers', async () => {
  const hang = createServer(() => { /* never responds */ });
  const port = await listen(hang);
  try {
    const journal = join(fresh('hang'), 'backup-window.jsonl');
    const r = await runClient('pre', { PORT: String(port), BACKUP_WINDOW_LOG: journal, BACKUP_HOOK_TIMEOUT_MS: '300' });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 5000, `bounded (${r.ms} ms)`);
    assert.match(journalLines(journal)[0]?.error ?? '', /no answer within 300 ms/);
  } finally { hang.closeAllConnections(); await new Promise<void>((res) => hang.close(() => res())); }
});

test('★★ the hook client exits 0 on a refusal and journals the status', async () => {
  const refuse = createServer((_req, res) => { res.statusCode = 403; res.end('{"ok":false}'); });
  const port = await listen(refuse);
  try {
    const journal = join(fresh('refuse'), 'backup-window.jsonl');
    const r = await runClient('post', { PORT: String(port), BACKUP_WINDOW_LOG: journal });
    assert.equal(r.code, 0);
    assert.equal(journalLines(journal)[0]?.status, 403);
  } finally { await new Promise<void>((res) => refuse.close(() => res())); }
});

test('★★★ the shipped hook exits 0 even when its client fails or is missing', async () => {
  const failing = join(fresh('fail'), 'client.mjs');
  writeFileSync(failing, 'process.exit(3);\n');
  for (const client of [failing, join(tmp, 'no-such-client.mjs')]) {
    const r = await run(hookCopy(client), ['pre'], {});
    assert.equal(r.code, 0, `client ${client}`);
    assert.match(r.stderr, /hook client exited [1-9]/, 'and says why on stderr');
  }
});

test('★★★ end to end: the shipped hook drives the server — pre freezes and empties the WAL, post restores', async () => {
  const dir = fresh('e2e');
  const dbPath = join(dir, 'ecoflow.db');
  const journal = join(dir, 'backup-window.jsonl');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = ${RECORDER_WAL_AUTOCHECKPOINT};
           CREATE TABLE t (x BLOB); INSERT INTO t VALUES (randomblob(50000));`);
  const wal = walControlFor(db, dbPath);
  const bw = createBackupWindow({ wal, journalPath: journal, log: { info: () => {}, warn: () => {} } });
  const app = Fastify(panelFastifyOptions('silent'));
  registerBackupWindowRoutes(app, bw);
  try {
    let host = '::';
    try { await app.listen({ host, port: 0 }); } catch { host = '127.0.0.1'; await app.listen({ host, port: 0 }); }
    const env = { PORT: String((app.server.address() as { port: number }).port), BACKUP_WINDOW_LOG: journal };
    const hook = hookCopy();
    assert.ok((wal.walBytes() ?? 0) > 0);

    const pre = await run(hook, ['pre'], env);
    assert.equal(pre.code, 0);
    assert.equal(wal.autocheckpoint(), 0, 'pre froze auto-checkpoints on the server connection');
    assert.equal(wal.walBytes(), 0, 'and emptied the WAL');

    const post = await run(hook, ['post'], env);
    assert.equal(post.code, 0);
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT, 'post restored them');

    const lines = journalLines(journal);
    assert.deepEqual(lines.map((r) => `${r.phase}:${r.ok}`), ['pre:true', 'post:true'], 'the server journaled both; the client added nothing');
  } finally { bw.stop(); await app.close(); db.close(); }
});

test('★★★ a pre the hook gave up on during a main-thread stall is refused when it finally runs: no TRUNCATE, no freeze', async () => {
  // The 03:30 failure: the server's main thread stalls past the hook's timeout, the hook exits 0,
  // the Supervisor starts copying /data, and only then does the queued pre reach its handler — with
  // its socket not yet seen as closed. A TRUNCATE then would shrink ecoflow.db-wal under tar.
  const dir = fresh('stall');
  const dbPath = join(dir, 'ecoflow.db');
  const journal = join(dir, 'backup-window.jsonl');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = ${RECORDER_WAL_AUTOCHECKPOINT};
           CREATE TABLE t (x BLOB); INSERT INTO t VALUES (randomblob(50000));`);
  const wal = walControlFor(db, dbPath);
  const warn: string[] = [];
  const bw = createBackupWindow({ wal, journalPath: journal, log: { info: () => {}, warn: (m) => { warn.push(m); } } });
  const app = Fastify(panelFastifyOptions('silent'));
  const TIMEOUT_MS = 400;
  const STALL_MS = 1500;
  // The stall: once the hook's request is in, this thread is busy for STALL_MS, as in the
  // 3.5-9.7 s main-thread stalls of the 08-05 review. The hook gives up meanwhile.
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.url.endsWith('/pre')) { const end = Date.now() + STALL_MS; while (Date.now() < end) { /* stalled */ } }
    done();
  });
  registerBackupWindowRoutes(app, bw);
  try {
    let host = '::';
    try { await app.listen({ host, port: 0 }); } catch { host = '127.0.0.1'; await app.listen({ host, port: 0 }); }
    const env = { PORT: String((app.server.address() as { port: number }).port), BACKUP_WINDOW_LOG: journal, BACKUP_HOOK_TIMEOUT_MS: String(TIMEOUT_MS) };
    const walBefore = wal.walBytes();
    assert.ok((walBefore ?? 0) > 0, 'precondition: frames in the WAL');

    const r = await run(hookCopy(), ['pre'], env);
    assert.equal(r.code, 0);
    assert.ok(await until(() => bw.status().lastPre != null), 'the queued pre reached its handler after the stall');
    const lines = journalLines(journal);
    const byHook = lines.filter((x) => x.by === 'hook');
    const byServer = lines.filter((x) => x.by == null);
    assert.equal(byHook.length, 1);
    assert.match(byHook[0].error, new RegExp(`no answer within ${TIMEOUT_MS} ms`), 'the hook gave up first');
    assert.equal(byServer.length, 1);
    assert.equal(byServer[0].phase, 'pre');
    assert.equal(byServer[0].ok, false, 'never journaled as a quiesced copy');
    assert.equal(byServer[0].error, 'client gone');
    assert.match(byServer[0].reason, /deadline passed/);
    assert.equal(wal.autocheckpoint(), RECORDER_WAL_AUTOCHECKPOINT, 'no freeze');
    assert.equal(wal.walBytes(), walBefore, 'no TRUNCATE: the WAL tar may be reading did not shrink');
    assert.equal(bw.status().windowOpen, false);
    assert.ok(warn.some((m) => m.startsWith('backup-window: pre refused — client gone')));
  } finally { bw.stop(); await app.close(); db.close(); }
});

test('★★ the hook client sends the moment pre must start by: its own give-up time less a grace', async () => {
  let deadline = Number.NaN;
  let closedAt = Number.NaN;
  const hang = createServer((req) => {
    deadline = Number(req.headers[BACKUP_DEADLINE_HEADER]);
    req.socket.on('close', () => { closedAt = Date.now(); });
  });
  const port = await listen(hang);
  try {
    const journal = join(fresh('deadline'), 'backup-window.jsonl');
    const spawnedAt = Date.now();
    // 2000 ms timeout: the grace is min(2000, 2000 / 4) = 500 ms.
    const r = await runClient('pre', { PORT: String(port), BACKUP_WINDOW_LOG: journal, BACKUP_HOOK_TIMEOUT_MS: '2000' });
    assert.equal(r.code, 0);
    assert.ok(await until(() => Number.isFinite(closedAt)), 'the client gave up and closed');
    assert.ok(Number.isFinite(deadline), 'the header carries epoch milliseconds');
    assert.ok(deadline >= spawnedAt + 1500, `the deadline is ${deadline - spawnedAt} ms after the client started: its timeout less the grace`);
    assert.ok(closedAt - deadline >= 400, `the client gave up ${closedAt - deadline} ms after the deadline: a pre that started by then has the grace to finish`);
  } finally { hang.closeAllConnections(); await new Promise<void>((res) => hang.close(() => res())); }
});

test('★ the client resolves the journal exactly as the server does', () => {
  const client = readFileSync(CLIENT, 'utf8');
  const server = readFileSync(join(REPO, 'server/src/backupWindow.ts'), 'utf8');
  assert.match(client, /existsSync\('\/share'\) \? '\/share\/ecoflow-panel\/backup-window\.jsonl' : '\/data\/backup-window\.jsonl'/);
  assert.match(server, /opts\.shareRoot \?\? '\/share'/);
  assert.match(server, /join\(shareRoot, 'ecoflow-panel', 'backup-window\.jsonl'\) : join\(opts\.dataDir, 'backup-window\.jsonl'\)/);
  assert.match(client, /process\.env\.BACKUP_WINDOW_LOG/);
  assert.match(client, /fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\/api\/internal\/backup-window\/\$\{phase\}`/, 'loopback, the server route');
});
