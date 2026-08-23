/**
 * v1.107.0 — on-demand consistent SQLite snapshot for external viewers.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/data/ecoflow.db` is private to this add-on (config.yaml maps only
 * `data:rw`), so a separate viewer add-on — sqlite-web or anything else —
 * physically cannot open it. This module publishes a point-in-time COPY to
 * `/share/ecoflow-panel/`, which every add-on can read.
 *
 * WHY `VACUUM INTO` AND NOT `cp`
 * ------------------------------
 * The live DB is WAL (recorder.ts sets `journal_mode = WAL`). A plain copy of
 * the main file misses everything still sitting in `-wal`, and copying the
 * three files non-atomically can yield a torn set. `VACUUM INTO` asks SQLite
 * for a transactionally consistent snapshot as of one read point, written as a
 * single defragmented, WAL-free file — precisely the shape a viewer wants.
 *
 * WHY A DEDICATED WORKER THREAD
 * -----------------------------
 * `DatabaseSync` is synchronous: whichever thread runs the vacuum has its
 * event loop pinned for the whole copy. The main thread runs the alarm engine
 * (life-safety — must never stall) and the analytics worker backs every
 * dashboard panel. So the export gets a THIRD, short-lived thread that exits
 * when it is done. Nothing long-lived is added to the process.
 *
 * WHY THE WORKER OPENS ITS OWN HANDLE
 * -----------------------------------
 * readRecorder.ts sets `PRAGMA query_only = ON`, and SQLite classifies
 * `VACUUM INTO` as a write statement by statement CLASS — not by effect — so it
 * is refused on that connection with "attempt to write a readonly database"
 * even though the source file is never modified. Verified empirically, not
 * assumed. The export therefore opens its own plain handle and simply never
 * writes to the source.
 */

import { Worker } from 'node:worker_threads';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where snapshots land. `/share` is readable by every add-on. */
export const DEFAULT_EXPORT_DIR = process.env.DB_EXPORT_DIR ?? '/share/ecoflow-panel';
export const DEFAULT_EXPORT_NAME = 'ecoflow-snapshot.db';

/** Generous: a multi-hundred-MB vacuum on the Pi's NVMe is seconds, but a
 *  cold cache or a large retention window could stretch it. Bounded so a
 *  wedged worker can never leak a thread. */
export const EXPORT_TIMEOUT_MS = 10 * 60_000;

export interface DbExportResult {
  path: string;
  bytes: number;
  sourceBytes: number;
  elapsedMs: number;
}

/**
 * Reject anything that is not a plain filename ending in .db. This is the
 * ONLY caller-controlled component of the output path, so it is where
 * traversal has to die: no `/`, no `..`, no absolute paths, no empty string.
 * PURE.
 */
export function sanitizeExportName(name: string | undefined): string | null {
  if (name == null || name === '') return DEFAULT_EXPORT_NAME;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (name.startsWith('.')) return null; // no dotfiles, and kills bare ".." early
  if (!name.endsWith('.db')) return null;
  if (name.length > 100) return null;
  return name;
}

/**
 * Target plus the temp path we vacuum into first. PURE.
 *
 * We never vacuum straight onto the published path: `VACUUM INTO` refuses an
 * existing target, so a naive implementation would have to delete the good
 * snapshot BEFORE producing the new one — leaving a window where the path a
 * viewer is pointed at does not exist, and leaving nothing at all behind if
 * the vacuum then fails. Vacuum-to-temp + rename means the published path
 * always holds a complete, openable database.
 */
export function resolveExportPaths(dir: string, name: string): { target: string; tmp: string } {
  return { target: join(dir, name), tmp: join(dir, `.${name}.tmp`) };
}

/** Single-flight: a concurrent second request joins the in-flight export
 *  rather than racing it onto the same temp path. */
let inFlight: Promise<DbExportResult> | null = null;

export function exportInProgress(): boolean {
  return inFlight != null;
}

export function exportDatabase(opts: {
  sourcePath: string;
  dir?: string;
  name?: string;
  log?: (m: string) => void;
}): Promise<DbExportResult> {
  if (inFlight) return inFlight;

  const dir = opts.dir ?? DEFAULT_EXPORT_DIR;
  const name = sanitizeExportName(opts.name);
  if (name == null) return Promise.reject(new Error('invalid export name'));
  const { target, tmp } = resolveExportPaths(dir, name);
  const log = opts.log ?? (() => {});

  const started = Date.now();
  const run = new Promise<DbExportResult>((resolve, reject) => {
    const workerUrl = new URL('./dbExportWorkerBootstrap.mjs', import.meta.url);
    const worker = new Worker(workerUrl, {
      workerData: { sourcePath: opts.sourcePath, target, tmp, dir },
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`db export timed out after ${EXPORT_TIMEOUT_MS} ms`))),
      EXPORT_TIMEOUT_MS,
    );

    worker.on('message', (msg: any) => {
      if (msg?.kind === 'log') { log(msg.message); return; }
      if (msg?.kind === 'done') {
        finish(() => resolve({
          path: target,
          bytes: msg.bytes,
          sourceBytes: msg.sourceBytes,
          elapsedMs: Date.now() - started,
        }));
        return;
      }
      if (msg?.kind === 'error') {
        finish(() => reject(new Error(msg.message ?? 'db export failed')));
      }
    });
    worker.on('error', (e) => finish(() => reject(e)));
    worker.on('exit', (code) => {
      // Only meaningful if the worker died WITHOUT reporting either outcome.
      finish(() => reject(new Error(`db export worker exited early (code ${code})`)));
    });
  });

  inFlight = run.finally(() => { inFlight = null; });
  return inFlight;
}

/** Report on the currently published snapshot without producing a new one. */
export function describeExistingExport(dir?: string, name?: string): {
  path: string;
  exists: boolean;
  bytes: number | null;
  modifiedAt: string | null;
} {
  const safe = sanitizeExportName(name) ?? DEFAULT_EXPORT_NAME;
  const { target } = resolveExportPaths(dir ?? DEFAULT_EXPORT_DIR, safe);
  if (!existsSync(target)) return { path: target, exists: false, bytes: null, modifiedAt: null };
  const st = statSync(target);
  return {
    path: target,
    exists: true,
    bytes: st.size,
    modifiedAt: new Date(st.mtimeMs).toISOString(),
  };
}
