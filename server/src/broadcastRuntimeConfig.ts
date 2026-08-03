/**
 * v0.18.0 — Runtime broadcast config, persisted across restarts.
 * v1.57.0 — VOLUME REMOVED: it now has exactly one source, the BROADCAST_VOLUME
 * add-on option. Only the live enable/disable override remains here.
 * (legacy header follows)
 * Runtime broadcast config (live enable), persisted across
 * restarts. Mirrors alertSettings.ts exactly (in-memory cache + atomic write +
 * listeners).
 *
 * The add-on's static config (BROADCAST_ENABLED / BROADCAST_VOLUME env from the
 * HA options UI) sets the BASELINE. This file adds a small, USER-mutable layer
 * on top — toggled live from the web Alert Console — and persists it to
 * /data/broadcast-runtime-config.json so it survives restarts (the env-derived
 * config can't change at runtime without a restart; this layer can).
 *
 * SEMANTICS — each field is an OVERRIDE: `null` means "defer to the env
 * baseline"; a concrete value wins over env. loadBroadcastConfig() merges this
 * on top of the env-derived config on every tick (~10 s) and per broadcast, so a
 * change takes effect within one tick with NO restart. Clearing a field back to
 * `null` restores the env baseline.
 *
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

export interface BroadcastRuntimeConfig {
  /** Override for whether broadcasts are enabled. null = use BROADCAST_ENABLED. */
  enabled: boolean | null;
  /** Last mutation time (ms). */
  updatedAt: number;
  /** Where the last change came from ('web' | 'default'). */
  source: string;
}

const PATH = process.env.BROADCAST_RUNTIME_CONFIG_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'broadcast-runtime-config.json');

function defaults(): BroadcastRuntimeConfig {
  return { enabled: null, updatedAt: 0, source: 'default' };
}


/** Coerce an arbitrary parsed object into a valid config, filling gaps from defaults.
 *  Every field is re-normalized into a FRESH primitive (`=== true` for the boolean,
 *  Number() for the numbers) so nothing request-derived flows verbatim into the
 *  persisted JSON (CodeQL js/http-to-file-access) — the file only ever contains
 *  values of this exact typed shape. */
function sanitize(raw: any, source: string): BroadcastRuntimeConfig {
  const base = defaults();
  if (raw && typeof raw === 'object') {
    if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled === true;
    if (typeof raw.updatedAt === 'number') base.updatedAt = Number(raw.updatedAt);
  }
  base.source = source;
  return base;
}

let cache: BroadcastRuntimeConfig | null = null;
type Listener = (c: BroadcastRuntimeConfig) => void;
const listeners = new Set<Listener>();

/** Load from disk (once), falling back to defaults on any error. Cached thereafter. */
export function getBroadcastRuntimeConfig(): BroadcastRuntimeConfig {
  if (cache) return cache;
  try {
    if (existsSync(PATH)) {
      cache = sanitize(JSON.parse(readFileSync(PATH, 'utf8')), 'file');
      return cache;
    }
  } catch {
    /* corrupt/unreadable → defaults (env baseline) */
  }
  cache = defaults();
  return cache;
}

/** Subscribe to changes (e.g. to mirror an HA switch/number entity). Returns an unsubscribe fn. */
export function onBroadcastRuntimeConfigChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function persist(c: BroadcastRuntimeConfig): void {
  // PATH is a fixed constant (env override or a config-derived sibling of the
  // DB) — never request-influenced; only the sanitize()-typed content varies.
  try { mkdirSync(dirname(PATH), { recursive: true }); } catch { /* best effort */ }
  const tmp = `${PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  renameSync(tmp, PATH); // atomic on the same filesystem
}

/**
 * Apply a partial update, persist atomically, refresh the cache, and notify
 * listeners. A field present in the patch is SET (a boolean/number overrides
 * env; an explicit null clears the override back to the env baseline). A field
 * ABSENT from the patch is left unchanged. Returns the new resolved config.
 */
export function updateBroadcastRuntimeConfig(
  patch: { enabled?: boolean | null },
  source = 'web',
): BroadcastRuntimeConfig {
  const next = sanitize(getBroadcastRuntimeConfig(), source); // clone current
  // `=== true` re-normalizes the request-derived boolean into a fresh primitive
  // (see sanitize) — behavior-identical for booleans, non-booleans clear to null.
  if ('enabled' in patch) next.enabled = typeof patch.enabled === 'boolean' ? patch.enabled === true : null;
  next.updatedAt = Date.now();
  next.source = source;
  cache = next;
  persist(next);
  for (const fn of listeners) {
    try { fn(next); } catch { /* listener errors never break a settings write */ }
  }
  return next;
}

/** Test-only: drop the in-memory cache so the next read re-loads from disk. */
export function _resetBroadcastRuntimeConfigCacheForTest(): void {
  cache = null;
}
