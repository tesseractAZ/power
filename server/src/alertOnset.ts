/**
 * v1.x — restart-persistent alarm ONSET (first-seen) timestamps.
 *
 * The Alert type (alerts.ts) is stateless — every field is recomputed fresh
 * on each alertMonitor evaluate() tick — so nothing on the Alert itself
 * records WHEN it first became active. The ALM screen
 * (telnet/plant/alm.ts) used to stamp every alarm row with
 * `snapshot.generatedAt` (this refresh's clock time), which is wrong for any
 * alarm that has been active longer than one poll interval. alertMonitor's
 * own in-memory `TrackedAlert.firstSeen` WOULD be correct, but it lives only
 * in the in-process `tracked` Map and resets to "now" on every add-on
 * restart — and this host restarts roughly daily (see the Pi power-loss
 * notes elsewhere in this codebase).
 *
 * This sidecar is the durable source of truth: keyed by alert id, it records
 * the wall-clock ms the id was FIRST seen active, persists it to the same
 * state-dir convention as the other alarm sidecars (notify-state.json,
 * alert-telemetry.jsonl, alert-family-meta.json — all resolved relative to
 * config.dbPath's directory), and prunes an id's record the moment that id
 * is no longer in the active alert set. A later re-fire of the same id then
 * gets a fresh onset, matching how every other alarm-lifecycle concept in
 * this codebase (tracked, notify-state, telemetry) treats a clear-then-rise
 * as a new event, not a continuation.
 *
 * `syncAlertOnsets` is the single per-cycle hook: called once per
 * alertMonitor.evaluate() tick with the CURRENT set of active alert ids, it
 * adds any new id (stamped `now`), drops any id no longer present, and —
 * only when the set actually changed — atomically persists. Best-effort
 * throughout: a missing/unwritable state dir must never throw into the
 * alarm loop; it just means onsets stop surviving restarts and the ALM
 * screen falls back to its pre-existing `generatedAt` behaviour.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';

const ONSET_PATH = process.env.ALERT_ONSET_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'alert-onset.json');

/** Entries older than this are dropped at load — mirrors
 *  NOTIFY_STATE_MAX_AGE_MS's sibling constant in alertMonitor.ts (scaled up
 *  since an onset record is smaller and less sensitive than a notify
 *  record); an onset this old belongs to an alert every other persistence
 *  layer in this codebase has long since forgotten regardless. */
export const ALERT_ONSET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let cache: Map<string, number> | null = null;

/** Load the onset map from disk. Corrupt/missing file → empty map. Exported
 *  for tests (mirrors loadNotifiedState's signature/shape in
 *  alertMonitor.ts). */
export function loadAlertOnsets(path: string = ONSET_PATH, nowMs: number = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  try {
    if (!existsSync(path)) return out;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const cutoff = nowMs - ALERT_ONSET_MAX_AGE_MS;
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > cutoff) out.set(id, v);
    }
  } catch {
    /* corrupt → start fresh */
  }
  return out;
}

/** Persist the onset map. Best-effort — never throws into the alarm loop
 *  (mirrors saveNotifiedState in alertMonitor.ts). Exported for tests. */
export function saveAlertOnsets(path: string, state: Map<string, number>): void {
  try {
    atomicWriteFileSync(path, JSON.stringify(Object.fromEntries(state)));
  } catch {
    /* best effort — losing this just means ALM falls back to generatedAt */
  }
}

function ensureLoaded(): Map<string, number> {
  if (!cache) cache = loadAlertOnsets();
  return cache;
}

/**
 * Per-cycle hook — call once per alertMonitor evaluate() tick with the ids of
 * every currently-active alert. Adds a first-seen stamp for any new id,
 * prunes any id no longer active (so its NEXT rise gets a fresh onset), and
 * persists only when the set actually changed (a steady-state tick with an
 * unchanged alarm roster is then a pure in-memory no-op). Side-effect-safe:
 * catches everything so a disk/permission failure can never propagate into
 * the alarm evaluation loop.
 */
export function syncAlertOnsets(activeIds: Iterable<string>, nowMs: number = Date.now()): void {
  try {
    const state = ensureLoaded();
    const active = new Set(activeIds);
    let changed = false;
    for (const id of active) {
      if (!state.has(id)) {
        state.set(id, nowMs);
        changed = true;
      }
    }
    for (const id of [...state.keys()]) {
      if (!active.has(id)) {
        state.delete(id);
        changed = true;
      }
    }
    if (changed) saveAlertOnsets(ONSET_PATH, state);
  } catch {
    /* best effort — never let onset tracking disturb the alarm loop */
  }
}

/** Look up the recorded onset (first-seen wall-clock ms) for an alert id.
 *  Returns undefined if unknown — never recorded, pruned because the id went
 *  inactive, or the sidecar failed to load — in which case the caller
 *  (alm.ts) should fall back to another timestamp (snapshot.generatedAt). */
export function getAlertOnset(id: string): number | undefined {
  try {
    return ensureLoaded().get(id);
  } catch {
    return undefined;
  }
}

/** Test-only: reset the in-process cache and the loaded path so tests can
 *  point ALERT_ONSET_PATH at a fresh temp file per test without cross-test
 *  bleed through the module-level cache. */
export function resetAlertOnsetCacheForTests(): void {
  cache = null;
}
