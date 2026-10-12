/**
 * settingsDriftHold.ts — v1.187.20. A settings-drift push held for the notify quiet window
 * survives a restart.
 *
 * WHY: on 2026-10-10 at 23:02 an external change (Smart Home Panel 2 · smartBackupMode 0 → 2)
 * was confirmed inside the notify quiet window (22-06) and held for the morning in an in-memory
 * array. The same tick saved the new value as the confirmed baseline (settings-surface.json).
 * The 23:25 deploy restart dropped the array, and the baseline already held the new value, so
 * nothing could re-detect the change: the push never went out. The reserve-floor push (dedupId
 * settings_drift_reserve_floor) shares the path. alertMonitor's quiet queue had the same defect
 * and has persisted to digest-queue.json since v1.86.0; this is that fix for the drift path.
 *
 * MECHANISM
 *  - ON DISK BEFORE THE BASELINE: `commit` writes the held changes to the sidecar
 *    (settings-drift-held.json, beside settings-surface.json) and saves the baseline only when
 *    that write succeeded. A baseline that already holds the new value never reaches disk ahead
 *    of the record of the change it hides; a failed write leaves the old baseline on disk, so a
 *    restart re-detects the change instead of losing it.
 *  - REHYDRATED AT CONSTRUCTION: the queue reads the sidecar when it is built (index.ts builds it
 *    at module load, before the first drift tick). An unreadable or malformed sidecar is logged
 *    and ignored; it never throws into boot.
 *  - DELIVERED ONCE, CLEARED AFTER SUCCESS: `flush` sends the held batch at the first tick
 *    outside the quiet window. Entries leave the sidecar only after the send resolves; a failed
 *    send keeps them on disk and in memory for the next tick. One send is in flight at a time
 *    (until SEND_DEADLINE_MS: a hung send does not block later ones forever), and a change that
 *    arrives while it is in flight stays held (rebased onto what was sent).
 *  - BOUNDED: one entry per setting key — repeated changes merge into the first unannounced
 *    `from`, the latest `to` and a count. Entries untouched for HELD_MAX_AGE_MS are dropped, and
 *    beyond HELD_MAX_ENTRIES the least recently changed go; each drop is logged.
 *  - AT-LEAST-ONCE AT A CRASH: a restart between a successful send and the sidecar rewrite sends
 *    the batch again. A duplicate push is the accepted cost; a lost one is the defect.
 *
 * Main thread only (index.ts's drift tick); nothing here runs in a worker.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { renderDriftPush, settingsSurfacePath, type SettingChange, type SettingValue } from './settingsDrift.js';

/** A held external change: one per setting key. */
export interface HeldDriftChange {
  key: string;
  /** The value before the first change not yet announced. */
  from: SettingValue;
  /** The latest confirmed value. */
  to: SettingValue;
  /** Confirmed changes of this key merged into this entry (≥ 1). */
  changes: number;
  firstAtMs: number;
  lastAtMs: number;
}

/** The push a held batch becomes (a NotifyMessage). */
export interface DriftPushMessage {
  severity: 'warning';
  dedupId: string;
  title: string;
  body: string;
}

export interface DriftHoldLog {
  info(m: string): void;
  warn(m: string): void;
}

export type DriftFlushOutcome = 'empty' | 'held' | 'in-flight' | 'sent' | 'failed';

/** A held change older than this (since its last movement) is dropped unsent, with a log line. */
export const HELD_MAX_AGE_MS = 7 * 86_400_000;
/** At most this many held keys; beyond it the least recently changed are dropped, with a log line. */
export const HELD_MAX_ENTRIES = 200;
/** A send still unresolved after this long stops blocking the next attempt: a hung request must
 *  not hold every later push for the life of the process (a duplicate is the accepted cost). */
export const SEND_DEADLINE_MS = 10 * 60_000;

/** The sidecar's path: SETTINGS_DRIFT_HELD_PATH, else beside settings-surface.json. */
export function driftHeldPath(): string {
  return process.env.SETTINGS_DRIFT_HELD_PATH ?? join(dirname(settingsSurfacePath()), 'settings-drift-held.json');
}

const RESERVE_FLOOR_SUFFIX = ' · backupReserveSoc';

/**
 * The push for a held batch (moved from index.ts's tick in v1.187.20, unchanged for a batch of
 * single changes). PURE.
 *
 * v1.119.0 — a reserve-floor change is NOT cosmetic drift: it moves the value the floor alarm
 * defends and the night-charge planner sizes against. On 2026-08-30 EcoFlow Storm Guard raised it
 * 20 → 40 and it surfaced only in a later audit. It gets its own dedupId, so it can never be
 * coalesced away behind an unrelated settings batch, and a title that names the consequence.
 * flush() logs the outcome ("push sent" / "push failed"), so whether the push went out is
 * answerable from the log — the question the 08-31 audit could not settle.
 */
export function driftNotification(batch: HeldDriftChange[]): DriftPushMessage {
  const msg = renderDriftPush(batch);
  const floor = batch.find((c) => c.key.endsWith(RESERVE_FLOOR_SUFFIX));
  if (!floor) return { severity: 'warning', dedupId: 'settings_drift', title: msg.title, body: msg.body };
  const title = floor.from !== floor.to
    ? `Reserve floor changed externally: ${floor.from}% → ${floor.to}%`
    : `Reserve floor changed externally and back to ${floor.to}%`;
  const body = `${msg.body}\n\nThis is the floor the backup-pool alarm defends and the night-charge planner sizes against. `
    + 'It was not written by this add-on — EcoFlow Storm Guard and the vendor app can both move it.';
  return { severity: 'warning', dedupId: 'settings_drift_reserve_floor', title, body };
}

function isSettingValue(v: unknown): v is SettingValue {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

/** One sidecar entry, or null when it is not a held change. */
function parseHeld(x: unknown): HeldDriftChange | null {
  if (x == null || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.key !== 'string' || o.key === '') return null;
  if (!isSettingValue(o.from) || !isSettingValue(o.to)) return null;
  if (typeof o.lastAtMs !== 'number' || !Number.isFinite(o.lastAtMs)) return null;
  const changes = typeof o.changes === 'number' && Number.isInteger(o.changes) && o.changes >= 1 ? o.changes : 1;
  const firstAtMs = typeof o.firstAtMs === 'number' && Number.isFinite(o.firstAtMs) ? o.firstAtMs : o.lastAtMs;
  return { key: o.key, from: o.from, to: o.to, changes, firstAtMs, lastAtMs: o.lastAtMs };
}

const describe = (e: HeldDriftChange): string => `${e.key} ${String(e.from)} → ${String(e.to)}`;
const listSome = (es: HeldDriftChange[]): string =>
  es.slice(0, 5).map(describe).join('; ') + (es.length > 5 ? `; +${es.length - 5} more` : '');

export interface DriftHoldOptions {
  /** The sidecar (driftHeldPath() in production). */
  path: string;
  /** True inside the notify quiet window: the batch is held. */
  isQuiet: (now: Date) => boolean;
  /** Deliver one push; a rejection is a failed push (sendNotification throws on failure). */
  send: (msg: DriftPushMessage) => Promise<unknown>;
  log: DriftHoldLog;
  /** The clock for the construction-time bounds check (tests). */
  nowMs?: () => number;
  maxAgeMs?: number;
  maxEntries?: number;
  sendDeadlineMs?: number;
}

export class DriftHoldQueue {
  private entries: HeldDriftChange[];
  private readonly path: string;
  private readonly isQuiet: (now: Date) => boolean;
  private readonly send: (msg: DriftPushMessage) => Promise<unknown>;
  private readonly log: DriftHoldLog;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly sendDeadlineMs: number;
  /** False after a failed sidecar write: the next commit retries it before saving a baseline. */
  private onDisk = true;
  /** The unresolved send, if any. Compared by identity, so a late resolution of a send that was
   *  given up on never releases the guard of the one after it. */
  private flight: { sinceMs: number } | null = null;
  /** Bumped on every change to the held set, so the "held" line logs once per state. */
  private version = 0;
  private heldLoggedVersion = -1;

  constructor(o: DriftHoldOptions) {
    this.path = o.path;
    this.isQuiet = o.isQuiet;
    this.send = o.send;
    this.log = o.log;
    this.maxAgeMs = o.maxAgeMs ?? HELD_MAX_AGE_MS;
    this.maxEntries = o.maxEntries ?? HELD_MAX_ENTRIES;
    this.sendDeadlineMs = o.sendDeadlineMs ?? SEND_DEADLINE_MS;
    this.entries = this.rehydrate();
    if (this.enforceBounds((o.nowMs ?? Date.now)())) this.persist();
  }

  /** A copy of the held changes, in the order they were first held. */
  held(): HeldDriftChange[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /**
   * Hold confirmed external changes, merged per key, and write the sidecar when the held set
   * changed (or an earlier write failed). Returns true when the held set is on disk.
   */
  hold(changes: SettingChange[], nowMs: number): boolean {
    let mutated = false;
    for (const c of changes) {
      const e = this.entries.find((x) => x.key === c.key);
      if (e == null) {
        this.entries.push({ key: c.key, from: c.from, to: c.to, changes: 1, firstAtMs: nowMs, lastAtMs: nowMs });
        mutated = true;
      } else if (e.to !== c.to) {
        e.to = c.to;
        e.changes += 1;
        e.lastAtMs = nowMs;
        mutated = true;
      }
      // else: the same movement confirmed again (a restart between this sidecar write and the
      // baseline save re-detects it) — already held, not a second change.
    }
    if (this.enforceBounds(nowMs)) mutated = true;
    if (mutated) this.version++;
    if (!mutated && this.onDisk) return true;
    return this.persist();
  }

  /**
   * The tick's commit: hold the external changes, THEN save the baseline that hides them — and
   * only when the hold reached disk. Returns whether the baseline was saved.
   */
  commit(external: SettingChange[], nowMs: number, saveBaseline: () => void): boolean {
    if (!this.hold(external, nowMs)) {
      this.log.warn('settings-drift: baseline NOT saved — the held change(s) are not on disk; '
        + 'a restart re-detects them instead of losing them');
      return false;
    }
    saveBaseline();
    return true;
  }

  /**
   * Deliver the held batch when outside the quiet window. Never rejects. The entries leave the
   * sidecar only after the send resolves.
   */
  async flush(now: Date): Promise<DriftFlushOutcome> {
    try {
      if (this.enforceBounds(now.getTime())) { this.version++; this.persist(); }
      if (this.entries.length === 0) return 'empty';
      if (this.flight != null) {
        if (now.getTime() - this.flight.sinceMs < this.sendDeadlineMs) return 'in-flight';
        this.log.warn(`settings-drift: the push started ${Math.round((now.getTime() - this.flight.sinceMs) / 60_000)} min ago `
          + 'never resolved — sending again');
        this.flight = null;
      }
      if (this.isQuiet(now)) {
        if (this.heldLoggedVersion !== this.version) {
          this.heldLoggedVersion = this.version;
          this.log.info(`settings-drift: ${this.entries.length} change(s) held for the notify quiet window — `
            + `pushed once it ends (${this.onDisk ? 'kept on disk' : 'in memory only: the sidecar write failed'}): ${listSome(this.entries)}`);
        }
        return 'held';
      }
      const batch = this.held();
      const msg = driftNotification(batch);
      const flight = { sinceMs: now.getTime() };
      this.flight = flight;
      try {
        await this.send(msg);
      } catch (e: any) {
        this.log.warn(`settings-drift: push failed (${e?.message ?? e}) — ${batch.length} change(s) stay held`
          + `${this.onDisk ? ' on disk' : ''}; will retry`);
        return 'failed';
      } finally {
        if (this.flight === flight) this.flight = null;
      }
      this.settle(batch);
      this.log.info(`settings-drift: push sent — ${msg.title} (${batch.length} change(s), dedupId ${msg.dedupId})`);
      return 'sent';
    } catch (e: any) {
      this.log.warn(`settings-drift: held-change flush failed (${e?.message ?? e})`);
      return 'failed';
    }
  }

  /** After a successful send: drop what was announced; rebase what moved while it was in flight. */
  private settle(sent: HeldDriftChange[]): void {
    for (const s of sent) {
      const i = this.entries.findIndex((e) => e.key === s.key);
      if (i < 0) continue;
      const e = this.entries[i];
      if (e.to === s.to && e.changes === s.changes) {
        this.entries.splice(i, 1);
      } else {
        // Changed again while the push was in flight: the operator now knows `s.to`.
        e.from = s.to;
        e.changes = Math.max(1, e.changes - s.changes);
      }
    }
    this.version++;
    this.persist();
  }

  /** Drop entries older than maxAgeMs, then the least recently changed beyond maxEntries. */
  private enforceBounds(nowMs: number): boolean {
    let dropped = false;
    const stale = this.entries.filter((e) => nowMs - e.lastAtMs > this.maxAgeMs);
    if (stale.length > 0) {
      this.entries = this.entries.filter((e) => !stale.includes(e));
      this.log.warn(`settings-drift: dropped ${stale.length} held change(s) never pushed in `
        + `${Math.round(this.maxAgeMs / 3_600_000)} h: ${listSome(stale)}`);
      dropped = true;
    }
    if (this.entries.length > this.maxEntries) {
      const over = [...this.entries].sort((a, b) => a.lastAtMs - b.lastAtMs).slice(0, this.entries.length - this.maxEntries);
      this.entries = this.entries.filter((e) => !over.includes(e));
      this.log.warn(`settings-drift: held changes over the cap of ${this.maxEntries} — dropped the `
        + `${over.length} least recently changed: ${listSome(over)}`);
      dropped = true;
    }
    return dropped;
  }

  private persist(): boolean {
    try {
      atomicWriteFileSync(this.path, JSON.stringify({ v: 1, held: this.entries }));
      this.onDisk = true;
    } catch (e: any) {
      this.onDisk = false;
      this.log.warn(`settings-drift: could not write ${this.path} (${e?.message ?? e}) — `
        + `${this.entries.length} held change(s) are in memory only`);
    }
    return this.onDisk;
  }

  private rehydrate(): HeldDriftChange[] {
    let text: string;
    try {
      if (!existsSync(this.path)) return [];
      text = readFileSync(this.path, 'utf8');
    } catch (e: any) {
      this.log.warn(`settings-drift: held-change sidecar ${this.path} unreadable (${e?.message ?? e}) — ignored`);
      return [];
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e: any) {
      this.log.warn(`settings-drift: held-change sidecar ${this.path} is corrupt (${e?.message ?? e}) — ignored`);
      return [];
    }
    const list = raw != null && typeof raw === 'object' ? (raw as { held?: unknown }).held : undefined;
    if (!Array.isArray(list)) {
      this.log.warn(`settings-drift: held-change sidecar ${this.path} has no held list — ignored`);
      return [];
    }
    const out: HeldDriftChange[] = [];
    let skipped = 0;
    for (const x of list) {
      const e = parseHeld(x);
      if (e == null || out.some((o) => o.key === e.key)) skipped++;
      else out.push(e);
    }
    if (skipped > 0) this.log.warn(`settings-drift: skipped ${skipped} malformed held-change entr${skipped === 1 ? 'y' : 'ies'} in ${this.path}`);
    if (out.length > 0) {
      this.log.info(`settings-drift: rehydrated ${out.length} held change(s) from ${this.path} — `
        + `pushed at the first tick outside the notify quiet window: ${listSome(out)}`);
    }
    return out;
  }
}
