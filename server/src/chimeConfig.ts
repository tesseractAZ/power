/**
 * chimeConfig.ts — which tone prepends each alert level (v0.15.23 / Alert Console).
 *
 * Mirrors alertSettings.ts exactly (in-memory cache + atomic write + listeners),
 * but stores the operator's per-LEVEL chime assignment:
 *   red (Critical) / yellow (Warning) / green (Advisory) →
 *     { kind: 'builtin' }              — the synthesized klaxon pack (default)
 *     { kind: 'custom', id }           — an uploaded tone from chimeStore
 *
 * GRANULARITY — per LEVEL, not per ISA priority. The renderer + every announce
 * path is level-based (AnnouncementLevel), and klaxonLevelForPriority already
 * collapses the 4 ISA priorities (critical/high/medium/low) to these 3 klaxons.
 * A per-priority scheme would be honoured only on the priority-aware announce()
 * path and silently collapse to level on the condition-transition path — the
 * SAME alarm could then play different tones depending on which path fired it.
 * Per-level resolves identically across all render call sites.
 *
 * DEFAULT is all-builtin, so until the operator assigns a custom tone this
 * module is a pure no-op and the audio is byte-identical to pre-feature.
 *
 * resolveChime() is the single resolution seam (used at BOTH broadcast render
 * sites): it returns the chime file path + a cache-key TAG, and FALLS BACK to
 * the builtin klaxon when a custom file is missing — so a dangling or deleted
 * assignment degrades to "wrong tone, message still plays", never a silent
 * alarm. The tag always matches the file actually returned, keeping the render
 * cache correct.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { KLAXON_FOR_LEVEL, type AnnouncementLevel } from './audioRenderer.js';
import { chimePath } from './chimeStore.js';

export const CHIME_LEVELS: AnnouncementLevel[] = ['red', 'yellow', 'green'];

/** The cache-key tag for the built-in klaxon. Must stay a single fixed literal
 *  (NOT the klaxon filename) so builtin cache keys are byte-identical to the
 *  pre-feature key string — see audioRenderer.renderCacheKey. */
export const BUILTIN_TAG = 'builtin';

export type ChimeAssignment = { kind: 'builtin' } | { kind: 'custom'; id: string };

export interface ChimeConfig {
  assignments: Record<AnnouncementLevel, ChimeAssignment>;
  updatedAt: number;
  source: string;
}

const PATH = process.env.CHIME_CONFIG_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'chime-config.json');

function defaults(): ChimeConfig {
  return {
    assignments: { red: { kind: 'builtin' }, yellow: { kind: 'builtin' }, green: { kind: 'builtin' } },
    updatedAt: 0,
    source: 'default',
  };
}

/** Coerce one assignment, dropping anything malformed back to builtin. */
function sanitizeAssignment(raw: any): ChimeAssignment {
  if (raw && raw.kind === 'custom' && typeof raw.id === 'string' && /^[a-f0-9]{16}$/.test(raw.id)) {
    return { kind: 'custom', id: raw.id };
  }
  return { kind: 'builtin' };
}

function sanitize(raw: any, source: string): ChimeConfig {
  const base = defaults();
  if (raw && typeof raw === 'object' && raw.assignments && typeof raw.assignments === 'object') {
    for (const lvl of CHIME_LEVELS) base.assignments[lvl] = sanitizeAssignment(raw.assignments[lvl]);
    if (typeof raw.updatedAt === 'number') base.updatedAt = raw.updatedAt;
  }
  base.source = source;
  return base;
}

let cache: ChimeConfig | null = null;
type Listener = (c: ChimeConfig) => void;
const listeners = new Set<Listener>();

export function getChimeConfig(): ChimeConfig {
  if (cache) return cache;
  try {
    if (existsSync(PATH)) {
      cache = sanitize(JSON.parse(readFileSync(PATH, 'utf8')), 'file');
      return cache;
    }
  } catch {
    /* corrupt/unreadable → defaults */
  }
  cache = defaults();
  return cache;
}

export function onChimeConfigChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function persist(c: ChimeConfig): void {
  try { mkdirSync(dirname(PATH), { recursive: true }); } catch { /* best effort */ }
  const tmp = `${PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  renameSync(tmp, PATH);
}

/**
 * Apply a partial per-level assignment update, persist atomically, refresh the
 * in-memory cache (so the next render sees it without a disk read), and notify
 * listeners. A 'custom' assignment to an id that does not exist on disk is
 * rejected (kept as the prior value) — the caller should surface that. Returns
 * the new resolved config.
 */
export function updateChimeConfig(
  patch: Partial<Record<AnnouncementLevel, ChimeAssignment>>,
  source = 'web',
): { config: ChimeConfig; rejected: string[] } {
  const next = sanitize(getChimeConfig(), source); // clone current
  const rejected: string[] = [];
  for (const lvl of CHIME_LEVELS) {
    const a = patch[lvl];
    if (a == null) continue;
    const clean = sanitizeAssignment(a);
    if (clean.kind === 'custom' && !chimePath(clean.id)) {
      rejected.push(`${lvl}: unknown tone id ${clean.id}`);
      continue; // keep the existing assignment
    }
    next.assignments[lvl] = clean;
  }
  next.updatedAt = Date.now();
  next.source = source;
  cache = next;
  persist(next);
  for (const fn of listeners) { try { fn(next); } catch { /* never break a write */ } }
  return { config: next, rejected };
}

/**
 * Revert every level currently assigned to the given custom id back to builtin
 * (called when that tone is deleted). No-op + no write if nothing referenced it.
 */
export function revertAssignmentsFor(id: string, source = 'delete'): boolean {
  const cur = getChimeConfig();
  const referencing = CHIME_LEVELS.filter((l) => {
    const a = cur.assignments[l];
    return a.kind === 'custom' && a.id === id;
  });
  if (referencing.length === 0) return false;
  const patch: Partial<Record<AnnouncementLevel, ChimeAssignment>> = {};
  for (const l of referencing) patch[l] = { kind: 'builtin' };
  // Bypass the existence check (the file is being deleted) by writing directly.
  const next = sanitize(cur, source);
  for (const l of referencing) next.assignments[l] = { kind: 'builtin' };
  next.updatedAt = Date.now();
  next.source = source;
  cache = next;
  persist(next);
  for (const fn of listeners) { try { fn(next); } catch { /* ignore */ } }
  return true;
}

export interface ResolvedChime {
  /** Absolute path to the WAV the renderer should prepend. */
  path: string;
  /** Cache-key tag — BUILTIN_TAG for the klaxon, else the custom tone's id. */
  tag: string;
  /** True when a custom assignment was requested but its file was missing. */
  fellBack: boolean;
}

/**
 * Resolve the chime for a level to a concrete file + cache tag. Falls back to
 * the builtin klaxon (in `klaxonDir`) when the assignment is builtin OR when a
 * custom tone's file is missing. The returned tag ALWAYS matches the returned
 * path, so the render cache can never serve a stale tone for a swapped id.
 */
export function resolveChime(level: AnnouncementLevel, klaxonDir: string): ResolvedChime {
  const builtin = (): ResolvedChime => ({
    path: resolve(klaxonDir, KLAXON_FOR_LEVEL[level]), tag: BUILTIN_TAG, fellBack: false,
  });
  const a = getChimeConfig().assignments[level];
  if (a.kind !== 'custom') return builtin();
  const p = chimePath(a.id);
  if (p == null) return { ...builtin(), fellBack: true };
  return { path: p, tag: a.id, fellBack: false };
}

/** Test-only: drop the in-memory cache so the next read re-loads from disk. */
export function _resetChimeConfigCacheForTest(): void {
  cache = null;
}
