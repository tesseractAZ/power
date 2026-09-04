import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sanitizeExportName,
  resolveExportPaths,
  exportDatabase,
  describeExistingExport,
  DEFAULT_EXPORT_NAME,
} from '../src/dbExport.js';

/**
 * v1.107.0 — the DB snapshot published to /share for external viewers.
 *
 * The properties that matter, and why each is pinned here:
 *   1. The copy is CONSISTENT — it must include rows still sitting in the WAL
 *      that a plain `cp` of the main file would silently drop. This is the
 *      whole reason VACUUM INTO was chosen over cp; a regression to cp would
 *      still "work" on a checkpointed DB and lose data on a busy one.
 *   2. The SOURCE is never modified. The export runs against the live
 *      life-safety recorder DB.
 *   3. The published path is never torn — a failure leaves the PREVIOUS good
 *      snapshot in place rather than a hole or a half-file.
 *   4. The only caller-controlled path component cannot escape the directory.
 */

/** A WAL database with rows deliberately left UN-CHECKPOINTED. */
/** v1.120.0 — strong refs to every fixture source handle, so none is finalized
 *  (and thus closed, and thus WAL-checkpointed) while a test is still running. */
const OPEN_HANDLES: DatabaseSync[] = [];
after(() => { for (const h of OPEN_HANDLES) { try { h.close(); } catch { /* already closed */ } } });

function makeSourceDb(dir: string): { path: string; rows: number } {
  const path = join(dir, 'ecoflow.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
           CREATE TABLE samples (ts INTEGER, sn TEXT, metric TEXT, value REAL);`);
  const ins = db.prepare('INSERT INTO samples VALUES (?,?,?,?)');
  for (let i = 0; i < 2000; i++) ins.run(i, 'SN-A', 'soc', i * 0.5);
  // Leave the handle OPEN so the WAL is not checkpointed on close: this is the
  // state a live recorder is always in.
  //
  // v1.120.0 — and PIN it. `db` used to be a local that fell out of scope here,
  // so V8 was free to finalize the DatabaseSync mid-test; node:sqlite closes the
  // handle on finalization, and if that happened before exportDatabase's own
  // connection closed, the export's close became the LAST connection and SQLite
  // checkpointed the WAL — which writes the source and moved its mtime. That
  // made "export must not write the source" fail on roughly 40 % of runs (2/5 on
  // clean main at 7333f0f, 3/5 on this branch) purely on GC timing. Production
  // never sees it: the recorder holds its connection for the process lifetime,
  // which is exactly the state this fixture is trying to model.
  OPEN_HANDLES.push(db);
  assert.ok(existsSync(path + '-wal'), 'precondition: source must have a live WAL');
  return { path, rows: 2000 };
}

test('sanitizeExportName rejects every path-escape shape', () => {
  // The default when nothing is supplied.
  assert.equal(sanitizeExportName(undefined), DEFAULT_EXPORT_NAME);
  assert.equal(sanitizeExportName(''), DEFAULT_EXPORT_NAME);
  // Valid.
  assert.equal(sanitizeExportName('snap.db'), 'snap.db');
  assert.equal(sanitizeExportName('ecoflow-2026_08.db'), 'ecoflow-2026_08.db');
  // Traversal / absolute / separators.
  assert.equal(sanitizeExportName('../../etc/passwd.db'), null);
  assert.equal(sanitizeExportName('..'), null);
  assert.equal(sanitizeExportName('/etc/shadow.db'), null);
  assert.equal(sanitizeExportName('sub/dir.db'), null);
  assert.equal(sanitizeExportName('a\\b.db'), null);
  // Dotfiles — also what stops a caller colliding with our own temp path,
  // which is `.<name>.tmp` in the SAME directory. `.hidden.db` passes the
  // extension check, so ONLY the dotfile rule can reject it.
  assert.equal(sanitizeExportName('.hidden.db'), null);
  assert.equal(sanitizeExportName('.ecoflow-snapshot.db.tmp'), null);
  // Wrong extension, and a quote that would break out of the SQL literal.
  assert.equal(sanitizeExportName('snap.txt'), null);
  assert.equal(sanitizeExportName("snap'.db"), null);
  assert.equal(sanitizeExportName('x'.repeat(200) + '.db'), null);
});

test('temp path is distinct from, and hidden beside, the target', () => {
  const { target, tmp } = resolveExportPaths('/share/ecoflow-panel', 'snap.db');
  assert.equal(target, '/share/ecoflow-panel/snap.db');
  assert.notEqual(tmp, target);
  // Same directory → the final rename is atomic (same filesystem).
  assert.equal(tmp.slice(0, tmp.lastIndexOf('/')), target.slice(0, target.lastIndexOf('/')));
});

test('export captures un-checkpointed WAL rows and leaves the source untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbexp-'));
  const outDir = join(dir, 'share');
  const src = makeSourceDb(dir);
  const before = statSync(src.path).mtimeMs;

  const res = await exportDatabase({ sourcePath: src.path, dir: outDir, name: 'snap.db' });

  assert.equal(res.path, join(outDir, 'snap.db'));
  assert.ok(res.bytes > 0);
  assert.ok(res.sourceBytes > 0);

  // (1) CONSISTENT: every row is present, including the WAL-resident ones. A
  // `cp` of the main file here would come up short.
  const copy = new DatabaseSync(res.path);
  const got = copy.prepare('SELECT COUNT(*) AS c FROM samples').get() as { c: number };
  assert.equal(got.c, src.rows, 'snapshot must include un-checkpointed WAL rows');
  copy.close();

  // The published file is self-contained — no sidecar WAL for a viewer to miss.
  assert.ok(!existsSync(res.path + '-wal'), 'snapshot must be WAL-free');

  // (2) SOURCE UNTOUCHED.
  assert.equal(statSync(src.path).mtimeMs, before, 'export must not write the source');

  // No temp litter left behind.
  assert.deepEqual(readdirSync(outDir), ['snap.db']);
});

test('a stale temp file from a crashed run does not block the next export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbexp-'));
  const outDir = join(dir, 'share');
  const src = makeSourceDb(dir);

  // First export creates the directory.
  await exportDatabase({ sourcePath: src.path, dir: outDir, name: 'snap.db' });
  // Simulate a crash mid-vacuum: a leftover temp file. VACUUM INTO refuses an
  // existing target, so without the unconditional rm this would fail forever.
  const { tmp } = resolveExportPaths(outDir, 'snap.db');
  writeFileSync(tmp, 'garbage from a killed run');

  const res = await exportDatabase({ sourcePath: src.path, dir: outDir, name: 'snap.db' });
  assert.ok(res.bytes > 0);
  assert.ok(!existsSync(tmp), 'stale temp must be cleared');
});

test('re-export replaces the published snapshot atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbexp-'));
  const outDir = join(dir, 'share');
  const src = makeSourceDb(dir);

  await exportDatabase({ sourcePath: src.path, dir: outDir, name: 'snap.db' });

  // Grow the source, then re-export: the published path must hold the NEW data
  // and must have been openable throughout (rename, not delete-then-write).
  const w = new DatabaseSync(src.path);
  const ins = w.prepare('INSERT INTO samples VALUES (?,?,?,?)');
  for (let i = 0; i < 500; i++) ins.run(90_000 + i, 'SN-B', 'soc', 1);
  w.close();

  const res = await exportDatabase({ sourcePath: src.path, dir: outDir, name: 'snap.db' });
  const copy = new DatabaseSync(res.path);
  const got = copy.prepare('SELECT COUNT(*) AS c FROM samples').get() as { c: number };
  copy.close();
  assert.equal(got.c, 2500, 're-export must publish the newer data');
});

test('concurrent requests collapse into one export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbexp-'));
  const outDir = join(dir, 'share');
  const src = makeSourceDb(dir);

  const [a, b, c] = await Promise.all([
    exportDatabase({ sourcePath: src.path, dir: outDir, name: 'snap.db' }),
    exportDatabase({ sourcePath: src.path, dir: outDir, name: 'snap.db' }),
    exportDatabase({ sourcePath: src.path, dir: outDir, name: 'snap.db' }),
  ]);
  // Single-flight: all three observe the SAME run, so nothing raced onto the
  // shared temp path.
  assert.equal(a.elapsedMs, b.elapsedMs);
  assert.equal(b.elapsedMs, c.elapsedMs);
});

test('an invalid name is rejected before any worker is spawned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbexp-'));
  await assert.rejects(
    () => exportDatabase({ sourcePath: join(dir, 'ecoflow.db'), dir, name: '../escape.db' }),
    /invalid export name/,
  );
});

test('a missing source reports an error rather than publishing a bad file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbexp-'));
  const outDir = join(dir, 'share');
  await assert.rejects(
    () => exportDatabase({ sourcePath: join(dir, 'does-not-exist.db'), dir: outDir, name: 'snap.db' }),
  );
  // Nothing half-written was published.
  assert.equal(describeExistingExport(outDir, 'snap.db').exists, false);
});

test('describeExistingExport reports absence without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbexp-'));
  const d = describeExistingExport(dir, 'nope.db');
  assert.equal(d.exists, false);
  assert.equal(d.bytes, null);
  assert.equal(d.modifiedAt, null);
  assert.ok(d.path.endsWith('nope.db'));
});
