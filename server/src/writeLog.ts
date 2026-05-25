import { appendFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

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

/** Append one entry. Synchronous on the write path — these are infrequent. */
export function appendWriteLog(entry: WriteLogEntry): void {
  try {
    ensureDir();
    appendFileSync(WRITE_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
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
  try {
    if (!existsSync(WRITE_LOG_PATH)) return [];
    const stat = statSync(WRITE_LOG_PATH);
    const startByte = Math.max(0, stat.size - TAIL_MAX_BYTES);
    const fd = openSync(WRITE_LOG_PATH, 'r');
    const buf = Buffer.alloc(stat.size - startByte);
    readSync(fd, buf, 0, buf.length, startByte);
    closeSync(fd);
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
  }
}
