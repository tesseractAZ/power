#!/usr/bin/env node
/**
 * mutate-alerts-history.mjs — `GET /api/alerts/history` serves a WINDOW of the cleared ledger,
 * newest first, each row reduced to what the Cleared table renders; the Alerts page asks for the
 * last 7 days unless another range is picked, re-fetches that window only, and renders 200 rows
 * before "Show more". The route returned the whole ledger (1,500 rows, 1.2 MB, each row the full
 * alert object) on mount and every 30 s, and the page drew every row.
 *
 *   W-i..viii  the window: the 7-day default, the inclusive bound, the 1..365 clamp, an unparsable
 *              `days`, `since`, `all=1`
 *   O-i..iii   newest first (inverted, dropped, a row without a clock first)
 *   P-i..v     the projection (the whole alert leaks, the detail is dropped, closedAs leaks its
 *              detail, optional fields written undefined, the all=1 path sends ledger rows)
 *   C-i..ii    the counts (total is the window's, shown is the ledger's)
 *   R-i..ii    index.ts (the whole-ledger body returns; the query is not passed)
 *   M-i..vii   the web model (default range, the query, the page size, the limit, the caption, the filter)
 *   A-i..iv    AlertsPanel (whole-ledger fetch, refresh armed once, the limit ignored, a stale page shown)
 *
 *   node scripts/mutate-alerts-history.mjs [--only W-]
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the harness ABORTS
 *   rather than reporting a green run against an unmutated tree.
 * ★ A harness run is only evidence if the BASELINE was green — confirm `0 fail`.
 * ★ `typecheck: true`: a mutant that does not typecheck is INVALID, never counted.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutantsParallel } from './lib/mutateParallel.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const SRV = resolve(SERVER, 'src/clearedHistory.ts');
const INDEX = resolve(SERVER, 'src/index.ts');
const MODEL = resolve(REPO, 'web/src/pages/clearedHistoryModel.ts');
const PANEL = resolve(REPO, 'web/src/pages/AlertsPanel.tsx');

const SUBSET = ['test/clearedHistory.test.ts', 'test/clearedHistoryWeb.test.ts'];

const MUTANTS = [
  // ── W: the window ─────────────────────────────────────────────────────────
  {
    id: 'W-i ★★★ the default window is a year',
    file: SRV,
    find: 'export const CLEARED_HISTORY_DEFAULT_DAYS = 7;',
    to: 'export const CLEARED_HISTORY_DEFAULT_DAYS = 365; /* MUTANT */',
    why: 'The page opens on the whole ledger again (1,498 of 1,500 rows live), which is the slow load this fixes.',
  },
  {
    id: 'W-ii the lower bound becomes exclusive',
    file: SRV,
    find: '    : log.filter((e) => Number.isFinite(e.clearedAt) && e.clearedAt >= since);',
    to: '    : log.filter((e) => Number.isFinite(e.clearedAt) && e.clearedAt > since); /* MUTANT */',
    why: 'A row cleared exactly at `since` is dropped; a client that passes back a row\'s own clearedAt as since loses it.',
  },
  {
    id: 'W-iii the ceiling on days is dropped',
    file: SRV,
    find: '    : Math.min(CLEARED_HISTORY_MAX_DAYS, Math.max(1, Math.trunc(asked)));',
    to: '    : Math.max(1, Math.trunc(asked)); /* MUTANT */',
    why: '`?days=1e9` is accepted; the documented 1..365 range is a sentence, not a mechanism.',
  },
  {
    id: 'W-iv the floor on days is dropped',
    file: SRV,
    find: 'Math.max(1, Math.trunc(asked))',
    to: 'Math.max(0, Math.trunc(asked)) /* MUTANT */',
    why: '`?days=0` becomes a window that starts now and shows nothing, read as "no alerts cleared".',
  },
  {
    id: 'W-v an unparsable days is one day, not the default',
    file: SRV,
    find: '  const days = asked == null\n    ? CLEARED_HISTORY_DEFAULT_DAYS\n',
    to: '  const days = asked == null\n    ? 1 /* MUTANT */\n',
    why: 'A malformed query silently narrows the window to a day instead of serving the documented default.',
  },
  {
    id: 'W-vi since is ignored',
    file: SRV,
    find: '  if (since != null) return { since, windowDays: null };\n',
    to: '  /* MUTANT */\n',
    why: 'A client asking from an exact instant gets the 7-day window and reads it as the answer.',
  },
  {
    id: 'W-vii ★★ all=1 is ignored',
    file: SRV,
    find: '  if (wantsAll(q.all)) return { since: null, windowDays: null };\n',
    to: '  /* MUTANT */\n',
    why: 'The All range shows the last 7 days under the label "all": the operator looking for an old episode is told it never happened.',
  },
  {
    id: 'W-viii all accepts any value',
    file: SRV,
    find: "  return typeof v === 'string' && (v === '1' || v.toLowerCase() === 'true');",
    to: '  return v != null; /* MUTANT */',
    why: '`?all=0` serves the whole ledger; the fail-open the window exists to prevent.',
  },
  // ── O: order ──────────────────────────────────────────────────────────────
  {
    id: 'O-i ★★ newest first is inverted',
    file: SRV,
    find: '  return tb - ta;\n};',
    to: '  return ta - tb; /* MUTANT */\n};',
    why: 'The first 200 rows rendered are the OLDEST of the window; the newest clear is behind "Show more".',
  },
  {
    id: 'O-ii the sort is dropped',
    file: SRV,
    find: '  const rows = inWindow.sort(newestFirst).map(projectClearedRow);',
    to: '  const rows = inWindow.map(projectClearedRow); /* MUTANT */',
    why: 'The order is whatever the ledger file holds; a rewritten or merged file renders in file order.',
  },
  {
    id: 'O-iii a row without a clock sorts first',
    file: SRV,
    find: '  const ta = Number.isFinite(a.clearedAt) ? a.clearedAt : -Infinity;\n  const tb = Number.isFinite(b.clearedAt) ? b.clearedAt : -Infinity;',
    to: '  const ta = Number.isFinite(a.clearedAt) ? a.clearedAt : Infinity; /* MUTANT */\n  const tb = Number.isFinite(b.clearedAt) ? b.clearedAt : Infinity;',
    why: 'A corrupt row heads the All list as the newest clear.',
  },
  // ── P: the projection ─────────────────────────────────────────────────────
  {
    id: 'P-i ★★★ the whole alert leaks into the row',
    file: SRV,
    find: '  const row: ClearedHistoryRow = {\n    id: a.id,',
    to: '  const row: ClearedHistoryRow = {\n    ...(a as object), /* MUTANT */\n    id: a.id,',
    why: 'facts, source serials and mute bookkeeping ride along: the row is the full alert object again, 798 B instead of 487.',
  },
  {
    id: 'P-ii the detail line is dropped',
    file: SRV,
    find: '    detail: a.detail,\n',
    to: "    detail: '', /* MUTANT */\n",
    why: 'The table renders the detail under the title; a "slim" row that loses it is a different table.',
  },
  {
    id: 'P-iii closedAs leaks its detail',
    file: SRV,
    find: '  if (e.closedAs != null) row.closedAs = { title: e.closedAs.title, severity: e.closedAs.severity };',
    to: '  if (e.closedAs != null) row.closedAs = e.closedAs; /* MUTANT */',
    why: 'Half the live rows carry closedAs; its detail (139 B a row) is not rendered.',
  },
  {
    id: 'P-iv an absent optional field is written undefined',
    file: SRV,
    find: '  if (a.priority != null) row.priority = a.priority;',
    to: '  row.priority = a.priority; /* MUTANT */',
    why: 'A key with an undefined value is a key: the row\'s shape depends on the serializer, and the parity test with the web type would pass or fail by accident.',
  },
  {
    id: 'P-v ★★ the all=1 path sends ledger rows',
    file: SRV,
    find: '  return { cleared: rows, total: log.length, shown: rows.length, windowDays, since };',
    to: '  return { cleared: (since == null ? inWindow : rows) as never, total: log.length, shown: rows.length, windowDays, since }; /* MUTANT */',
    why: 'The All range is the 1.2 MB payload again, with every row the full alert object.',
  },
  // ── C: the counts ─────────────────────────────────────────────────────────
  {
    id: 'C-i total is the window\'s count',
    file: SRV,
    find: 'total: log.length,',
    to: 'total: rows.length, /* MUTANT */',
    why: 'The caption reads "145 of 145": the operator cannot tell there is more behind the window.',
  },
  {
    id: 'C-ii shown is the ledger\'s count',
    file: SRV,
    find: 'shown: rows.length,',
    to: 'shown: log.length, /* MUTANT */',
    why: 'An empty window reports 1,500 shown.',
  },
  // ── R: index.ts ───────────────────────────────────────────────────────────
  {
    id: 'R-i ★★★ the route serves the whole ledger again',
    file: INDEX,
    find: '  cached(req, reply, clearedHistoryPage(monitor.history(), req.query ?? {}, Date.now()), 30),',
    to: '  cached(req, reply, { cleared: monitor.history() }, 30), /* MUTANT */',
    why: 'The module is tested and unused: the production route is the one the page calls.',
  },
  {
    id: 'R-ii the route drops the query',
    file: INDEX,
    find: 'clearedHistoryPage(monitor.history(), req.query ?? {}, Date.now())',
    to: 'clearedHistoryPage(monitor.history(), {}, Date.now()) /* MUTANT */',
    why: 'Every range the page offers serves the 7-day window; All is a label.',
  },
  // ── M: the web model ──────────────────────────────────────────────────────
  {
    id: 'M-i ★★★ the page opens on All',
    file: MODEL,
    find: "export const CLEARED_DEFAULT_RANGE: ClearedRange = '7';",
    to: "export const CLEARED_DEFAULT_RANGE: ClearedRange = 'all'; /* MUTANT */",
    why: 'The first request is the whole ledger: the load the owner reported, with the server fix in place.',
  },
  {
    id: 'M-ii the query asks for everything',
    file: MODEL,
    find: "  return range === 'all' ? 'api/alerts/history?all=1' : `api/alerts/history?days=${range}`;",
    to: "  return 'api/alerts/history?all=1'; /* MUTANT */",
    why: 'Every range fetches the whole ledger and the client shows it under "7 days".',
  },
  {
    id: 'M-iii the query asks for a year',
    file: MODEL,
    find: "`api/alerts/history?days=${range}`",
    to: "'api/alerts/history?days=365' /* MUTANT */",
    why: 'The range control is decoration: 7, 30 and 90 are the same request.',
  },
  {
    id: 'M-iv the page size is unbounded',
    file: MODEL,
    find: 'export const CLEARED_PAGE_ROWS = 200;',
    to: 'export const CLEARED_PAGE_ROWS = 1_000_000; /* MUTANT */',
    why: 'All renders 1,500 rows in one table again.',
  },
  {
    id: 'M-v visibleRows ignores the limit',
    file: MODEL,
    find: '  const n = Math.max(0, Math.min(rows.length, Math.trunc(limit)));',
    to: '  const n = rows.length; /* MUTANT */',
    why: '"Show more" has nothing to show; every row is in the DOM.',
  },
  {
    id: 'M-vi the caption drops the total',
    file: MODEL,
    find: "  return `${num(o.shown)} of ${num(o.total)}${qualifiers ? ` · ${qualifiers}` : ''}`;",
    to: "  return `${num(o.shown)} shown${qualifiers ? ` · ${qualifiers}` : ''}`; /* MUTANT */",
    why: 'The "N of total" caption is the only sign that the window is a window.',
  },
  {
    id: 'M-vii the filter admits Medium',
    file: MODEL,
    find: "  return p === 'critical' || p === 'high';",
    to: "  return p !== 'low'; /* MUTANT */",
    why: 'Critical + High shows the learned warnings too (235 of the 1,500 live rows).',
  },
  // ── A: the panel ──────────────────────────────────────────────────────────
  {
    id: 'A-i ★★★ the panel fetches the whole ledger',
    file: PANEL,
    find: '        const r = await fetch(apiUrl(clearedHistoryQuery(range)));',
    to: "        const r = await fetch(apiUrl('api/alerts/history')); /* MUTANT */",
    why: 'The model is tested and unused; the panel makes the request.',
  },
  {
    id: 'A-ii the refresh is armed once',
    file: PANEL,
    find: '    };\n  }, [range]);',
    to: '    };\n  }, []); /* MUTANT */',
    why: 'Picking 30 days fetches nothing: the 30 s refresh keeps re-fetching the first window under the new label.',
  },
  {
    id: 'A-iii the limit is ignored',
    file: PANEL,
    find: '  const { rows: visible, hidden } = visibleRows(filtered, limit);',
    to: '  const { rows: visible, hidden } = visibleRows(filtered, Infinity); /* MUTANT */',
    why: 'Every row in the window is rendered; the model\'s limit is not what the DOM gets.',
  },
  {
    id: 'A-iv a page for another range is shown under this one',
    file: PANEL,
    find: '  const page = loaded?.range === range ? loaded.page : null;',
    to: '  const page = loaded?.page ?? null; /* MUTANT */',
    why: 'Switching to 90 days shows the 7-day rows captioned "last 90 days" until the fetch lands.',
  },
];

await runMutantsParallel({ name: 'mutate-alerts-history', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
