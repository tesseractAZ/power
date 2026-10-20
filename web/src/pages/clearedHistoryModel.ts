import type { Alert, ClearedHistoryRow } from '../types';
import { priorityOf } from '../alertPriority';

/**
 * The Cleared view's model: which window it asks the server for, what it says about the rows
 * it holds, and how many it renders at once. Pure, with no DOM, so server/test can run it
 * (clearedHistoryWeb.test.ts) beside the server's own clearedHistory.ts.
 *
 * WHY. The view fetched the whole ledger (1,500 rows, 1.2 MB, each row the complete alert
 * object) on mount and every 30 s, and rendered every row in one table. It now asks for a
 * window — the last 7 days unless the operator picks 30 or 90 days or All — refreshes that
 * window only, and renders CLEARED_PAGE_ROWS rows before a "Show more".
 */

/** A `days` window, or the whole ledger. Strings: SubNav keys its tabs by string ids. */
export type ClearedRange = '7' | '30' | '90' | 'all';
export const CLEARED_RANGES: readonly ClearedRange[] = ['7', '30', '90', 'all'];
export const CLEARED_DEFAULT_RANGE: ClearedRange = '7';
/** Rows rendered before "Show more" (and added by each one). */
export const CLEARED_PAGE_ROWS = 200;

/**
 * The fields of a ClearedHistoryRow, as the server projects them (clearedHistory.ts). The test
 * compares this list with a projected row's keys so the two types cannot drift apart silently.
 */
export const CLEARED_ROW_FIELDS = [
  'id', 'title', 'detail', 'severity', 'priority', 'source', 'category', 'device',
  'coreNum', 'packNum', 'raisedAt', 'clearedAt', 'durationMs', 'closedAs', 'pushed',
] as const satisfies readonly (keyof ClearedHistoryRow)[];

/** The request path (relative to the SPA root) for a range: a `days` window, or the whole ledger. */
export function clearedHistoryQuery(range: ClearedRange): string {
  return range === 'all' ? 'api/alerts/history?all=1' : `api/alerts/history?days=${range}`;
}

export function clearedRangeLabel(range: ClearedRange): string {
  return range === 'all' ? 'All' : `${range} days`;
}

/** Critical or High on the ISA ladder (the "Critical + High" filter). */
export function isSevere(row: Pick<Alert, 'severity' | 'source' | 'priority'>): boolean {
  const p = priorityOf(row);
  return p === 'critical' || p === 'high';
}

/** Newest clear first; a defensive copy — the server already orders the page this way. */
export function newestFirst<T extends { clearedAt: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.clearedAt - a.clearedAt);
}

/** The rows rendered under the current limit, and how many wait behind "Show more". */
export function visibleRows<T>(rows: readonly T[], limit: number): { rows: T[]; hidden: number } {
  const n = Math.max(0, Math.min(rows.length, Math.trunc(limit)));
  return { rows: rows.slice(0, n), hidden: rows.length - n };
}

const num = (n: number): string => n.toLocaleString('en-US');

/**
 * The caption beside the title: how many rows are listed, of how many the ledger holds, and
 * which window and filter apply. `shown` counts the rows after the filter.
 */
export function clearedCaption(o: { shown: number; total: number; range: ClearedRange; filtered: boolean }): string {
  const scope = o.range === 'all' ? '' : `last ${o.range} days`;
  const filter = o.filtered ? 'Critical + High' : '';
  const qualifiers = [scope, filter].filter(Boolean).join(', ');
  if (o.range === 'all' && !o.filtered) return `all ${num(o.total)}`;
  return `${num(o.shown)} of ${num(o.total)}${qualifiers ? ` · ${qualifiers}` : ''}`;
}

export function showMoreLabel(hidden: number): string {
  return `Show ${num(Math.min(CLEARED_PAGE_ROWS, hidden))} more`;
}

/** What the table says when a window holds nothing. */
export function clearedEmptyText(o: { total: number; shown: number; range: ClearedRange }): string {
  if (o.total === 0) return 'No cleared alerts recorded yet.';
  if (o.shown === 0) return o.range === 'all' ? 'No cleared alerts recorded yet.' : `No alerts cleared in the last ${o.range} days.`;
  return 'No Critical or High alerts in this window.';
}

/** The Device column: the Core and pack when the alert names them, else the device's label. */
export function deviceLabel(row: Pick<ClearedHistoryRow, 'device' | 'coreNum' | 'packNum'>): string {
  if (row.coreNum == null) return row.device;
  return `Core ${row.coreNum}${row.packNum != null ? ` · Pack ${row.packNum}` : ''}`;
}
