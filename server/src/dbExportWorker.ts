/**
 * v1.107.0 — export worker. Runs ONE `VACUUM INTO` and exits.
 *
 * Lives on its own thread because DatabaseSync is synchronous and the copy
 * would otherwise pin either the alarm loop (main) or every dashboard panel
 * (analytics worker). See dbExport.ts for the full rationale.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, renameSync, statSync } from 'node:fs';

const port = parentPort!;
const { sourcePath, target, tmp, dir } = workerData as {
  sourcePath: string; target: string; tmp: string; dir: string;
};
const log = (m: string) => port.postMessage({ kind: 'log', message: m });

try {
  mkdirSync(dir, { recursive: true });

  const sourceBytes = statSync(sourcePath).size;
  log(`db-export: vacuuming ${sourcePath} (${(sourceBytes / 1e6).toFixed(1)} MB) -> ${target}`);

  // A temp file from a previous crashed/timed-out run would make VACUUM INTO
  // fail ("attempt to write a readonly database" — SQLite reports a
  // pre-existing target with the same misleading message as a genuine
  // permissions problem), so clear it unconditionally first.
  rmSync(tmp, { force: true });

  // Plain handle, NOT readRecorder's: that one sets `query_only = ON`, which
  // refuses VACUUM INTO by statement class even though the source is never
  // written. We hold this handle read-only by discipline — the only statement
  // ever issued is the vacuum below.
  const db = new DatabaseSync(sourcePath);
  try {
    // Single-quoted SQL literal. `target` is not user-controlled beyond a
    // strict [A-Za-z0-9._-]+\.db filename (sanitizeExportName), so it cannot
    // contain a quote; the fixed directory is ours.
    db.exec(`VACUUM INTO '${tmp}'`);
  } finally {
    db.close();
  }

  // Rename is atomic within the filesystem, so the published path flips from
  // the old complete snapshot straight to the new one — a viewer never sees a
  // half-written file.
  renameSync(tmp, target);
  const bytes = statSync(target).size;
  log(`db-export: wrote ${(bytes / 1e6).toFixed(1)} MB to ${target}`);
  port.postMessage({ kind: 'done', bytes, sourceBytes });
} catch (e: any) {
  try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  port.postMessage({ kind: 'error', message: e?.message ?? String(e) });
}
