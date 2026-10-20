import type { Alert } from './alerts.js';
import type { ClearedAlert } from './alertMonitor.js';

/**
 * The cleared-alert history as `GET /api/alerts/history` serves it to the Alerts page's Cleared
 * view: a time window of the ledger, newest first, each row reduced to the fields the table
 * renders.
 *
 * WHY. The route returned the whole ledger — every row `monitor.history()` holds, each carrying
 * the complete alert object (its `facts`, source serials, mute bookkeeping, and the body it
 * closed as) — and the page fetched it on mount and every 30 s. At the ledger's cap of 1,500
 * rows that was 1.2 MB a request, about 800 bytes a row, for a table that reads a dozen fields
 * and that an operator opens for the last few days. The ledger itself, its cap and
 * `monitor.history()` are unchanged: the warranty export reads the file directly and keeps the
 * full record.
 *
 * Query: `?days=N` (1..CLEARED_HISTORY_MAX_DAYS, default CLEARED_HISTORY_DEFAULT_DAYS) or
 * `?since=<ms>` for a window, `?all=1` for the whole ledger. `all` wins over `since`, which
 * wins over `days`. A `days` outside the range is clamped; one that is not a number is the
 * default. Pure, so the window is tested against a clock passed in.
 */

export const CLEARED_HISTORY_DEFAULT_DAYS = 7;
export const CLEARED_HISTORY_MAX_DAYS = 365;
const DAY_MS = 86_400_000;

/** The fields the Cleared table renders, flat, and nothing else of the alert. */
export interface ClearedHistoryRow {
  id: string;
  title: string;
  detail: string;
  severity: Alert['severity'];
  priority?: Alert['priority'];
  source?: Alert['source'];
  category: Alert['category'];
  device: string;
  coreNum?: number | null;
  packNum?: number | null;
  raisedAt: number;
  clearedAt: number;
  durationMs: number;
  /** The title and severity the alert closed with, when the ledger recorded them. */
  closedAs?: { title: string; severity: Alert['severity'] };
  pushed?: boolean;
}

export interface ClearedHistoryPage {
  cleared: ClearedHistoryRow[];
  /** Rows in the whole ledger, whatever the window. */
  total: number;
  /** Rows in `cleared`. */
  shown: number;
  /** The `days` window served; null for `since` and `all`. */
  windowDays: number | null;
  /** The window's lower bound (ms epoch, inclusive); null for `all`. */
  since: number | null;
}

/** Raw query-string values; Fastify gives strings (or arrays for a repeated key). */
export interface ClearedHistoryQuery {
  days?: unknown;
  since?: unknown;
  all?: unknown;
}

export interface ClearedHistoryWindow {
  since: number | null;
  windowDays: number | null;
}

const numberOf = (v: unknown): number | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `?all=1` / `?all=true` (case-insensitive); anything else is not the full ledger. */
export function wantsAll(v: unknown): boolean {
  return typeof v === 'string' && (v === '1' || v.toLowerCase() === 'true');
}

/** The window a query asks for, against `nowMs`. */
export function clearedHistoryWindow(q: ClearedHistoryQuery, nowMs: number): ClearedHistoryWindow {
  if (wantsAll(q.all)) return { since: null, windowDays: null };
  const since = numberOf(q.since);
  if (since != null) return { since, windowDays: null };
  const asked = numberOf(q.days);
  const days = asked == null
    ? CLEARED_HISTORY_DEFAULT_DAYS
    : Math.min(CLEARED_HISTORY_MAX_DAYS, Math.max(1, Math.trunc(asked)));
  return { since: nowMs - days * DAY_MS, windowDays: days };
}

/** One ledger row reduced to what the table renders. Optional fields are absent, not undefined. */
export function projectClearedRow(e: ClearedAlert): ClearedHistoryRow {
  const a = e.alert;
  const row: ClearedHistoryRow = {
    id: a.id,
    title: a.title,
    detail: a.detail,
    severity: a.severity,
    category: a.category,
    device: a.device,
    raisedAt: e.raisedAt,
    clearedAt: e.clearedAt,
    durationMs: e.durationMs,
  };
  if (a.priority != null) row.priority = a.priority;
  if (a.source != null) row.source = a.source;
  if (a.coreNum != null) row.coreNum = a.coreNum;
  if (a.packNum != null) row.packNum = a.packNum;
  if (e.closedAs != null) row.closedAs = { title: e.closedAs.title, severity: e.closedAs.severity };
  if (e.pushed != null) row.pushed = e.pushed;
  return row;
}

/** Newest clear first; a row without a finite `clearedAt` sorts last. */
const newestFirst = (a: ClearedAlert, b: ClearedAlert): number => {
  const ta = Number.isFinite(a.clearedAt) ? a.clearedAt : -Infinity;
  const tb = Number.isFinite(b.clearedAt) ? b.clearedAt : -Infinity;
  return tb - ta;
};

/**
 * The page for a query: the ledger rows cleared at or after the window's lower bound, newest
 * first, projected. The ledger passed in is not reordered.
 */
export function clearedHistoryPage(
  log: readonly ClearedAlert[],
  q: ClearedHistoryQuery,
  nowMs: number,
): ClearedHistoryPage {
  const { since, windowDays } = clearedHistoryWindow(q, nowMs);
  const inWindow = since == null
    ? [...log]
    : log.filter((e) => Number.isFinite(e.clearedAt) && e.clearedAt >= since);
  const rows = inWindow.sort(newestFirst).map(projectClearedRow);
  return { cleared: rows, total: log.length, shown: rows.length, windowDays, since };
}
