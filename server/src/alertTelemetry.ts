/**
 * v0.9.59 — Persistent alert telemetry log.
 *
 * Companion to alertMonitor.ts. Before this file existed, the per-alert
 * rise/short-clear/long-active stats lived only in an in-memory Map; a
 * process restart wiped them, which meant the chronic-noise and
 * warning-demote auto-silencing rules could never fire on a long-running
 * panel that gets occasional restarts (deploys, crashes, host reboots).
 *
 * Schema: JSON Lines at `/data/alert-telemetry.jsonl`. Each line is a
 * single event:
 *
 *   { familyKey, alertId, event: 'rise'|'shortClear'|'longActive', ts, durationMs? }
 *
 * `familyKey` is `familyOf(alertId)` from alertOutcomes.ts — collapses
 * per-pack variants of the same condition so the rules see the aggregate
 * (5 packs flapping 3× each rolls up as "this family fired 15 times").
 *
 * Replay window is bounded — on boot we re-hydrate only events within
 * the last 30 days to keep startup fast and memory bounded.
 *
 * Outcome JSONL (alertOutcomes.ts) is intentionally a separate file:
 * outcomes are operator-driven (rare, valuable forever), telemetry is
 * machine-generated (frequent, only valuable for ~weeks).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';

/** Telemetry event kinds we track for auto-silencing decisions. */
export type TelemetryEvent = 'rise' | 'shortClear' | 'longActive';

/**
 * v1.23.0 (engine-review F31) — parse one JSONL line, recovering torn-append
 * records. A power cut mid-append can leave the file extended with a run of NUL
 * bytes ahead of the next flushed record (classic delayed-allocation crash
 * artifact — the Pi cuts power daily). `\0` is not whitespace, so `.trim()`
 * never removed it and JSON.parse threw on the NUL-prefixed line, silently
 * dropping the valid record that follows (live: one real rise event lost after
 * 424 leading NULs). Strip a leading NUL run before parsing; a line that is
 * still not JSON after that throws and is skipped exactly as before.
 * Returns null on unrecoverable lines. Exported for tests.
 */
export function parseTelemetryLine(line: string): TelemetryEntry | null {
  // Strip a leading run of NUL / other C0 control bytes (the torn-append
  // artifact); a valid JSON record begins with '{' (0x7B), never a control byte.
  const cleaned = line.replace(/^[\u0000-\u001f]+/, '');
  if (cleaned.length === 0) return null;
  try {
    return JSON.parse(cleaned) as TelemetryEntry;
  } catch {
    return null;
  }
}

/** One persisted event line. */
export interface TelemetryEntry {
  /** familyOf(alertId) — e.g. "pack-hot", "cell-imbalance". Rule thresholds are evaluated against this. */
  familyKey: string;
  /** Full alert id — kept so we can also drive per-alert behavior (e.g. "this exact alert id has cleared 10×"). */
  alertId: string;
  /** What happened. */
  event: TelemetryEvent;
  /** Event time (ms since epoch). */
  ts: number;
  /** For shortClear / longActive: how long the alert was alive before it cleared / hit the long threshold. */
  durationMs?: number;
}

const PATH = process.env.ALERT_TELEMETRY_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'alert-telemetry.jsonl');

/** Replay only the last 30 days at boot to bound memory + startup work. */
const REPLAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Read up to the last 4 MB of the log for the boot replay. JSONL is small;
 *  this caps worst-case I/O without dropping any realistic recent window. */
const REPLAY_MAX_BYTES = 4 * 1024 * 1024;

let initialized = false;
function ensureDir() {
  if (initialized) return;
  try {
    mkdirSync(dirname(PATH), { recursive: true });
  } catch { /* best effort */ }
  initialized = true;
}

/**
 * v1.3.1 (audit rank 49) — rotate at twice the replay budget. This file's own doc says the
 * events are "only valuable for ~weeks", and boot replays just the last 30 days / 4 MB — but
 * nothing ever pruned it. On a panel that has flapped for months it grows without bound on the
 * Pi's SD card, and every byte past REPLAY_MAX_BYTES is written once and never read again.
 */
export const ROTATE_AT_BYTES = 2 * REPLAY_MAX_BYTES;
/** statSync on every append would be wasteful; steady state is a few dozen lines a day. */
const ROTATE_CHECK_EVERY = 256;
let appendsSinceCheck = 0;

/** Drop the oldest whole lines until the file is back under REPLAY_MAX_BYTES. Exported for tests. */
export function rotateTelemetryIfOversized(path: string = PATH): boolean {
  try {
    if (!existsSync(path)) return false;
    const fd = openSync(path, 'r');
    let size: number;
    try { size = fstatSync(fd).size; } finally { closeSync(fd); }
    if (size <= ROTATE_AT_BYTES) return false;
    const text = readFileSync(path, 'utf8');
    // Keep the newest REPLAY_MAX_BYTES, then discard the leading PARTIAL line so every
    // surviving line still parses.
    const cut = text.slice(-REPLAY_MAX_BYTES);
    const nl = cut.indexOf('\n');
    const tail = nl >= 0 ? cut.slice(nl + 1) : '';
    atomicWriteFileSync(path, tail);
    console.warn(`alertTelemetry: rotated ${path} (${size} → ${tail.length} bytes)`);
    return true;
  } catch (e: any) {
    console.error(`alertTelemetry: rotate failed: ${e?.message ?? e}`);
    return false;
  }
}

/** Append one telemetry event. Synchronous — log volume is low enough
 *  (a few dozen lines per day in steady state) that we don't need batching. */
export function appendTelemetryEvent(entry: TelemetryEntry): void {
  try {
    ensureDir();
    appendFileSync(PATH, JSON.stringify(entry) + '\n');
    if (++appendsSinceCheck >= ROTATE_CHECK_EVERY) {
      appendsSinceCheck = 0;
      rotateTelemetryIfOversized();
    }
  } catch (e: any) {
    console.error(`alertTelemetry: append failed: ${e?.message ?? e}`);
  }
}

/**
 * Read the recent tail of the telemetry log. Bounded by both a time
 * window (`windowMs`) and a max byte budget (REPLAY_MAX_BYTES) so a
 * pathologically large file can't slow boot.
 *
 * Returns entries in file order (oldest → newest), so callers can
 * fold them into the rollup in chronological order.
 */
export function readRecentTelemetry(windowMs: number = REPLAY_WINDOW_MS): TelemetryEntry[] {
  // TOCTOU hardening (CodeQL js/file-system-race): open FIRST, then fstat the
  // HANDLE — size and read come from the same inode, and a missing file just
  // throws ENOENT out of openSync (→ []), same as the old existsSync probe.
  let fd: number;
  try {
    fd = openSync(PATH, 'r');
  } catch {
    return [];
  }
  try {
    const stat = fstatSync(fd);
    const start = Math.max(0, stat.size - REPLAY_MAX_BYTES);
    const len = Math.min(stat.size, REPLAY_MAX_BYTES);
    if (len === 0) return [];
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf-8');
    // Drop the first (possibly partial) line if we started mid-file.
    const startNL = start > 0 ? text.indexOf('\n') + 1 : 0;
    const usable = text.slice(startNL);
    const lines = usable.split('\n').filter((l) => l.trim().length > 0);
    const cutoff = Date.now() - windowMs;
    const out: TelemetryEntry[] = [];
    for (const line of lines) {
      const e = parseTelemetryLine(line); // v1.23.0 (F31) — recovers NUL-torn records
      if (e && typeof e.ts === 'number' && e.ts >= cutoff) out.push(e);
    }
    return out;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/* ─── v0.31.0 — per-family metadata sidecar ────────────────────────────────
 * The telemetry JSONL stores only {familyKey, alertId, event, ts, durationMs} —
 * NOT the human title / severity / category. So on boot, replayPersistedTelemetry
 * seeded any family that hasn't re-fired since the last restart with placeholder
 * `title = familyKey`, `severity = 'info'` (live: 24 families stuck this way in
 * the UI). The placeholder severity is also a latent silencing foot-gun: the
 * post-replay batch rule pass runs against 'info' instead of the family's true
 * severity. Fix: maintain a tiny `{familyKey → {title, severity, category}}`
 * sidecar, upserted (change-detected) whenever a LIVE alert is seen, and loaded
 * before replay so rollups boot with real metadata. */

export interface FamilyMeta {
  title: string;
  severity: string;   // kept as string here to avoid importing alert types into this leaf module
  category: string;
}

const FAMILY_META_PATH = process.env.ALERT_FAMILY_META_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'alert-family-meta.json');

let familyMetaCache: Record<string, FamilyMeta> | null = null;

/** Load the family-metadata sidecar (cached after first read). */
export function loadFamilyMeta(): Record<string, FamilyMeta> {
  if (familyMetaCache) return familyMetaCache;
  try {
    if (existsSync(FAMILY_META_PATH)) {
      const obj = JSON.parse(readFileSync(FAMILY_META_PATH, 'utf-8'));
      familyMetaCache = obj && typeof obj === 'object' ? (obj as Record<string, FamilyMeta>) : {};
    } else {
      familyMetaCache = {};
    }
  } catch {
    familyMetaCache = {};
  }
  return familyMetaCache;
}

/**
 * Record the latest real metadata for a family. Change-detected: only writes to
 * disk when (title, severity, category) actually changes, so the per-tick live
 * path stays cheap (a steady fleet writes this file ~never). Returns true if it
 * persisted.
 */
export function upsertFamilyMeta(familyKey: string, meta: FamilyMeta): boolean {
  const cache = loadFamilyMeta();
  const prev = cache[familyKey];
  if (prev && prev.title === meta.title && prev.severity === meta.severity && prev.category === meta.category) {
    return false;
  }
  cache[familyKey] = meta;
  try {
    ensureDir();
    writeFileSync(FAMILY_META_PATH, JSON.stringify(cache));
    return true;
  } catch (e: any) {
    console.error(`alertTelemetry: family-meta write failed: ${e?.message ?? e}`);
    return false;
  }
}

/** Read all entries (no window) — exposed for tests / debugging. */
export function readAllTelemetry(): TelemetryEntry[] {
  if (!existsSync(PATH)) return [];
  try {
    const text = readFileSync(PATH, 'utf-8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const out: TelemetryEntry[] = [];
    for (const line of lines) {
      const e = parseTelemetryLine(line); // v1.23.0 (F31) — recovers NUL-torn records
      if (e) out.push(e);
    }
    return out;
  } catch {
    return [];
  }
}
