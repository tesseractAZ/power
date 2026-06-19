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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

/** Telemetry event kinds we track for auto-silencing decisions. */
export type TelemetryEvent = 'rise' | 'shortClear' | 'longActive';

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

/** Append one telemetry event. Synchronous — log volume is low enough
 *  (a few dozen lines per day in steady state) that we don't need batching. */
export function appendTelemetryEvent(entry: TelemetryEntry): void {
  try {
    ensureDir();
    appendFileSync(PATH, JSON.stringify(entry) + '\n');
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
  if (!existsSync(PATH)) return [];
  try {
    const stat = statSync(PATH);
    const start = Math.max(0, stat.size - REPLAY_MAX_BYTES);
    const len = Math.min(stat.size, REPLAY_MAX_BYTES);
    if (len === 0) return [];
    const buf = Buffer.alloc(len);
    const fd = openSync(PATH, 'r');
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString('utf-8');
    // Drop the first (possibly partial) line if we started mid-file.
    const startNL = start > 0 ? text.indexOf('\n') + 1 : 0;
    const usable = text.slice(startNL);
    const lines = usable.split('\n').filter((l) => l.trim().length > 0);
    const cutoff = Date.now() - windowMs;
    const out: TelemetryEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as TelemetryEntry;
        if (typeof e?.ts === 'number' && e.ts >= cutoff) out.push(e);
      } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
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
      try { out.push(JSON.parse(line) as TelemetryEntry); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}
