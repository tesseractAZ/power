/**
 * v0.11.0 — Runtime alert-annunciation settings (per-ISA-priority enable
 * flags + chime repeat), persisted across restarts.
 *
 * The add-on's static config (NOTIFY_*, BROADCAST_* env vars from the HA
 * options UI) sets the BASELINE. This file adds a small, USER-mutable layer
 * on top — toggled live from the web "Alert Settings" page (and mirrored as
 * Home Assistant switch entities) — and persists it to /data/alert-settings.json
 * so it survives add-on restarts (the env-derived config cannot be changed
 * at runtime without a restart; this layer can).
 *
 * SEMANTICS — disabling a priority silences its *annunciation* (push
 * notifications + audible broadcast + chime). It does NOT hide the alarm from
 * the panel's alert lists: per alarm-management best practice you never make an
 * active condition invisible, you only adjust how loudly it announces itself.
 * Disabled priorities render muted in the UI with a "silenced" marker.
 *
 * Storage: a single JSON object written atomically (temp file + rename) so a
 * crash mid-write never corrupts the file. Path mirrors alertTelemetry.ts —
 * sits next to the SQLite DB (i.e. /data in production).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { ALARM_PRIORITY_ORDER, type AlarmPriority } from './alertPriority.js';

export interface AlertSettings {
  /** Per-priority annunciation enable. true = notify + broadcast + chime; false = silenced (still visible). */
  priorityEnabled: Record<AlarmPriority, boolean>;
  /** How many times the alert chime sounds before the spoken announcement (1–4). Default 2. */
  chimeRepeat: number;
  /** Last mutation time (ms). */
  updatedAt: number;
  /** Where the last change came from, for the audit log ('web' | 'mqtt' | 'default'). */
  source: string;
}

const PATH = process.env.ALERT_SETTINGS_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'alert-settings.json');

const CHIME_REPEAT_MIN = 1;
const CHIME_REPEAT_MAX = 4;
export const DEFAULT_CHIME_REPEAT = 2; // v0.11.0 — user requested the chime sound twice on a new alert.

function defaults(): AlertSettings {
  const priorityEnabled = {} as Record<AlarmPriority, boolean>;
  for (const p of ALARM_PRIORITY_ORDER) priorityEnabled[p] = true;
  return { priorityEnabled, chimeRepeat: DEFAULT_CHIME_REPEAT, updatedAt: 0, source: 'default' };
}

function clampChime(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_CHIME_REPEAT;
  return Math.max(CHIME_REPEAT_MIN, Math.min(CHIME_REPEAT_MAX, v));
}

/** Coerce an arbitrary parsed object into a valid AlertSettings, filling gaps from defaults. */
function sanitize(raw: any, source: string): AlertSettings {
  const base = defaults();
  if (raw && typeof raw === 'object') {
    if (raw.priorityEnabled && typeof raw.priorityEnabled === 'object') {
      for (const p of ALARM_PRIORITY_ORDER) {
        if (typeof raw.priorityEnabled[p] === 'boolean') base.priorityEnabled[p] = raw.priorityEnabled[p];
      }
    }
    if (raw.chimeRepeat != null) base.chimeRepeat = clampChime(raw.chimeRepeat);
    if (typeof raw.updatedAt === 'number') base.updatedAt = raw.updatedAt;
  }
  base.source = source;
  return base;
}

let cache: AlertSettings | null = null;
type Listener = (s: AlertSettings) => void;
const listeners = new Set<Listener>();

/** Load from disk (once), falling back to defaults on any error. Cached thereafter. */
export function getAlertSettings(): AlertSettings {
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

/** True when this priority's annunciation (notify/broadcast/chime) is enabled. */
export function isPriorityEnabled(p: AlarmPriority): boolean {
  return getAlertSettings().priorityEnabled[p] !== false;
}

/** Current chime-repeat count (1–4). */
export function getChimeRepeat(): number {
  return clampChime(getAlertSettings().chimeRepeat);
}

/** Subscribe to settings changes (e.g. to re-publish HA switch states). Returns an unsubscribe fn. */
export function onAlertSettingsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function persist(s: AlertSettings): void {
  try {
    mkdirSync(dirname(PATH), { recursive: true });
  } catch {
    /* best effort */
  }
  const tmp = `${PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, PATH); // atomic on the same filesystem
}

/**
 * Apply a partial update, persist atomically, refresh the cache, and notify
 * listeners. Unknown / out-of-range values are ignored or clamped. Returns the
 * new, fully-resolved settings.
 */
export function updateAlertSettings(
  patch: { priorityEnabled?: Partial<Record<AlarmPriority, boolean>>; chimeRepeat?: number },
  source = 'web',
): AlertSettings {
  const next = sanitize(getAlertSettings(), source); // clone current
  if (patch.priorityEnabled) {
    for (const p of ALARM_PRIORITY_ORDER) {
      if (typeof patch.priorityEnabled[p] === 'boolean') next.priorityEnabled[p] = patch.priorityEnabled[p]!;
    }
  }
  if (patch.chimeRepeat != null) next.chimeRepeat = clampChime(patch.chimeRepeat);
  next.updatedAt = Date.now();
  next.source = source;
  cache = next;
  persist(next);
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      /* listener errors never break a settings write */
    }
  }
  return next;
}

/** Test-only: drop the in-memory cache so the next read re-loads from disk. */
export function _resetAlertSettingsCacheForTest(): void {
  cache = null;
}
