import { appendFileSync, mkdirSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { cleanText, finiteNumber } from './logSanitize.js';

/**
 * v0.9.6 — append-only audit log of every write action issued through
 * the panel (reboot, future boost-reserve, future skip-EV, etc.).
 *
 * Stored as JSON Lines at `/data/writes.log` so it survives add-on
 * restarts and is grep-friendly. Each line:
 *
 *   { ts, action, sn, params, source, outcome, code, message, durationMs }
 *
 * Critical for trust: any write that goes to the user's devices MUST be
 * traceable — what was sent, when, by whom (IP + UA), and what happened.
 * `/api/writes/log` surfaces the most recent N entries.
 */

export type WriteOutcome = 'success' | 'failure';

export interface WriteLogEntry {
  ts: number;
  action: string;                   // e.g. "reboot-shp2", "send-command", "boost-reserve"
  sn: string;
  params?: unknown;
  source: { ip?: string; ua?: string };
  outcome: WriteOutcome;
  code?: string;                    // EcoFlow response code (or local error code like "rate-limited")
  message?: string;                 // human-readable detail
  durationMs?: number;              // wall time of the EcoFlow call
}

// Path resolution: WRITE_LOG_PATH env override > sibling-of-DB default. The
// override exists so test code can point at a temp dir without rebuilding
// the whole config chain.
const WRITE_LOG_PATH =
  process.env.WRITE_LOG_PATH ?? resolve(process.cwd(), config.dbPath, '..', 'writes.log');
const TAIL_MAX_BYTES = 256 * 1024;  // cap how much we re-read for /api/writes/log

let initialized = false;

function ensureDir() {
  if (initialized) return;
  mkdirSync(dirname(WRITE_LOG_PATH), { recursive: true });
  initialized = true;
}

/* ─── content sanitization (CodeQL js/http-to-file-access) ──────────────
 * WRITE_LOG_PATH is a fixed constant (env override or a config-derived
 * sibling of the DB) — the PATH is never request-influenced. The CONTENT is
 * request/EcoFlow-derived BY DESIGN (this log exists to record who asked for
 * what and what the device said), so instead of writing the caller's object
 * verbatim we re-serialize an explicit typed shape: known fields only,
 * numbers coerced finite, strings control-stripped and length-bounded. */

/** Re-serialize into the explicit WriteLogEntry shape. Backward-compatible:
 *  same field names, same JSONL row — loaders (tailWriteLog) are unchanged. */
function sanitizeWriteLogEntry(entry: WriteLogEntry): WriteLogEntry {
  return {
    ts: finiteNumber(entry.ts) ?? Date.now(),
    action: cleanText(entry.action, 128) ?? '',
    sn: cleanText(entry.sn, 64) ?? '',
    // params is the exact command payload — kept verbatim (bounded upstream by
    // Fastify's body limit); recording it is the audit log's entire purpose.
    params: entry.params,
    source: {
      ip: cleanText(entry.source?.ip, 64),
      ua: cleanText(entry.source?.ua, 256),
    },
    outcome: entry.outcome === 'failure' ? 'failure' : 'success',
    code: cleanText(entry.code, 64),
    message: cleanText(entry.message, 512),
    durationMs: finiteNumber(entry.durationMs),
  };
}

/** Append one entry. Synchronous on the write path — these are infrequent. */
export function appendWriteLog(entry: WriteLogEntry): void {
  try {
    ensureDir();
    appendFileSync(WRITE_LOG_PATH, JSON.stringify(sanitizeWriteLogEntry(entry)) + '\n', 'utf8');
  } catch {
    // Logging failure must NOT fail the write itself — we already did the
    // device action. Silently swallow so the user-visible outcome is correct.
  }
}

/**
 * Tail the log. Returns the last `limit` entries (most recent first).
 * Reads at most the last TAIL_MAX_BYTES of the file to bound cost.
 */
export function tailWriteLog(limit = 50): WriteLogEntry[] {
  // TOCTOU hardening (CodeQL js/file-system-race): open FIRST, then fstat the
  // HANDLE — size and read come from the same inode, and a missing file just
  // throws ENOENT out of openSync (→ []), same as the old existsSync probe.
  let fd: number;
  try {
    fd = openSync(WRITE_LOG_PATH, 'r');
  } catch {
    return [];
  }
  try {
    const stat = fstatSync(fd);
    const startByte = Math.max(0, stat.size - TAIL_MAX_BYTES);
    const buf = Buffer.alloc(stat.size - startByte);
    readSync(fd, buf, 0, buf.length, startByte);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    // If we started mid-line (because of TAIL_MAX_BYTES truncation), skip it.
    const start = startByte > 0 ? 1 : 0;
    const out: WriteLogEntry[] = [];
    for (const line of lines.slice(start)) {
      try { out.push(JSON.parse(line) as WriteLogEntry); } catch { /* skip bad line */ }
    }
    return out.slice(-limit).reverse(); // newest first
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}
