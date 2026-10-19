/**
 * The Cleared view's model (web/src/pages/clearedHistoryModel.ts) beside the server's
 * clearedHistory.ts: the default window is 7 days, each range's query is the window the server
 * reads from it, the row type the page renders has the fields the server projects (and no
 * other), 200 rows are rendered before "Show more", and the panel is wired to the model.
 * The model is pure (no DOM), so it runs here as the energy-flow model does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLEARED_DEFAULT_RANGE,
  CLEARED_PAGE_ROWS,
  CLEARED_RANGES,
  CLEARED_ROW_FIELDS,
  clearedCaption,
  clearedEmptyText,
  clearedHistoryQuery,
  clearedRangeLabel,
  deviceLabel,
  isSevere,
  newestFirst,
  showMoreLabel,
  visibleRows,
} from '../../web/src/pages/clearedHistoryModel.js';
import { clearedHistoryWindow, projectClearedRow } from '../src/clearedHistory.js';
import type { ClearedAlert } from '../src/alertMonitor.js';

const here = dirname(fileURLToPath(import.meta.url));
const web = (rel: string) => readFileSync(resolve(here, '../../web/src', rel), 'utf8');
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const DAY = 86_400_000;

test('the default window is 7 days; the ranges are 7 / 30 / 90 / All', () => {
  assert.equal(CLEARED_DEFAULT_RANGE, '7');
  assert.deepEqual([...CLEARED_RANGES], ['7', '30', '90', 'all']);
  assert.deepEqual(CLEARED_RANGES.map(clearedRangeLabel), ['7 days', '30 days', '90 days', 'All']);
});

test('each range asks the server for exactly that window (parity through the query string)', () => {
  assert.equal(clearedHistoryQuery('7'), 'api/alerts/history?days=7');
  assert.equal(clearedHistoryQuery('30'), 'api/alerts/history?days=30');
  assert.equal(clearedHistoryQuery('90'), 'api/alerts/history?days=90');
  assert.equal(clearedHistoryQuery('all'), 'api/alerts/history?all=1');
  for (const range of CLEARED_RANGES) {
    const q = Object.fromEntries(new URL(clearedHistoryQuery(range), 'http://x/').searchParams);
    const w = clearedHistoryWindow(q, NOW);
    if (range === 'all') {
      assert.equal(w.since, null);
      assert.equal(w.windowDays, null);
    } else {
      assert.equal(w.windowDays, Number(range));
      assert.equal(w.since, NOW - Number(range) * DAY);
    }
  }
  // The default range is the server's default window: the first request is byte-for-byte the no-query page.
  const def = Object.fromEntries(new URL(clearedHistoryQuery(CLEARED_DEFAULT_RANGE), 'http://x/').searchParams);
  assert.deepEqual(clearedHistoryWindow(def, NOW), clearedHistoryWindow({}, NOW));
});

test('the web row type names the fields the server projects, no more and no fewer', () => {
  const full: ClearedAlert = {
    alert: {
      id: 'vdiff-warn-TEST-CORE-01-2', severity: 'warning', category: 'Battery', device: 'Core 1',
      title: 'Cell imbalance', detail: 'd', source: 'learned', priority: 'medium', coreNum: 1, packNum: 2,
      facts: [], sourceSn: 'TEST-CORE-01', sourcePackSn: 'TEST-PACK-02', annunciate: false,
    },
    closedAs: { title: 'Cell imbalance', detail: 'd2', severity: 'info' },
    raisedAt: NOW - 3_600_000, clearedAt: NOW, durationMs: 3_600_000, pushed: true, rosterMuted: true,
  };
  assert.deepEqual(Object.keys(projectClearedRow(full)).sort(), [...CLEARED_ROW_FIELDS].sort());
  // And the web interface literally declares each of them (a type is erased at runtime; its text is not).
  const types = web('types.ts');
  const iface = types.slice(types.indexOf('export interface ClearedHistoryRow {'));
  const body = iface.slice(0, iface.indexOf('\n}\n'));
  for (const f of CLEARED_ROW_FIELDS) assert.match(body, new RegExp(`^  ${f}\\??:`, 'm'), `types.ts declares ${f}`);
  assert.equal(types.includes('interface ClearedAlert '), false, 'the whole-alert row type is gone from the web');
});

test('200 rows render before "Show more"; the rest wait behind it', () => {
  assert.equal(CLEARED_PAGE_ROWS, 200);
  const rows = Array.from({ length: 450 }, (_, i) => i);
  let v = visibleRows(rows, CLEARED_PAGE_ROWS);
  assert.equal(v.rows.length, 200);
  assert.equal(v.hidden, 250);
  assert.deepEqual(v.rows.slice(0, 3), [0, 1, 2], 'the newest (first) rows');
  v = visibleRows(rows, 400);
  assert.equal(v.rows.length, 400);
  assert.equal(v.hidden, 50);
  v = visibleRows(rows, 1_000);
  assert.equal(v.rows.length, 450);
  assert.equal(v.hidden, 0);
  assert.deepEqual(visibleRows([], 200), { rows: [], hidden: 0 });
  assert.deepEqual(visibleRows(rows, 0), { rows: [], hidden: 450 });
  assert.equal(showMoreLabel(250), 'Show 200 more');
  assert.equal(showMoreLabel(50), 'Show 50 more');
  assert.equal(showMoreLabel(1_300), 'Show 200 more');
});

test('the caption says how many of the ledger are listed, and under which window and filter', () => {
  assert.equal(clearedCaption({ shown: 145, total: 1500, range: '7', filtered: false }), '145 of 1,500 · last 7 days');
  assert.equal(clearedCaption({ shown: 12, total: 1500, range: '7', filtered: true }), '12 of 1,500 · last 7 days, Critical + High');
  assert.equal(clearedCaption({ shown: 703, total: 1500, range: '30', filtered: false }), '703 of 1,500 · last 30 days');
  assert.equal(clearedCaption({ shown: 1500, total: 1500, range: 'all', filtered: false }), 'all 1,500');
  assert.equal(clearedCaption({ shown: 101, total: 1500, range: 'all', filtered: true }), '101 of 1,500 · Critical + High');
  assert.equal(clearedCaption({ shown: 0, total: 0, range: '7', filtered: false }), '0 of 0 · last 7 days');
});

test('the empty states tell the ledger apart from the window and the filter', () => {
  assert.equal(clearedEmptyText({ total: 0, shown: 0, range: '7' }), 'No cleared alerts recorded yet.');
  assert.equal(clearedEmptyText({ total: 40, shown: 0, range: '7' }), 'No alerts cleared in the last 7 days.');
  assert.equal(clearedEmptyText({ total: 40, shown: 0, range: '90' }), 'No alerts cleared in the last 90 days.');
  assert.equal(clearedEmptyText({ total: 40, shown: 40, range: '7' }), 'No Critical or High alerts in this window.');
  assert.equal(clearedEmptyText({ total: 40, shown: 40, range: 'all' }), 'No Critical or High alerts in this window.');
});

test('the Critical + High filter reads the ISA ladder as the row does, and the Device column names the Core and pack', () => {
  assert.equal(isSevere({ severity: 'critical' }), true);
  assert.equal(isSevere({ severity: 'warning' }), true, 'a threshold warning is High');
  assert.equal(isSevere({ severity: 'warning', source: 'learned' }), false, 'a learned warning is Medium');
  assert.equal(isSevere({ severity: 'info' }), false);
  assert.equal(isSevere({ severity: 'critical', priority: 'low' }), false, 'an explicit priority wins');
  assert.equal(isSevere({ severity: 'info', priority: 'high' }), true);
  assert.equal(deviceLabel({ device: 'Core 3', coreNum: 3, packNum: 2 }), 'Core 3 · Pack 2');
  assert.equal(deviceLabel({ device: 'Core 3', coreNum: 3 }), 'Core 3');
  assert.equal(deviceLabel({ device: 'Smart Home Panel 2' }), 'Smart Home Panel 2');
  assert.equal(deviceLabel({ device: 'x', coreNum: null, packNum: 4 }), 'x', 'no core, no pack label');
  assert.deepEqual(newestFirst([{ clearedAt: 1 }, { clearedAt: 3 }, { clearedAt: 2 }]).map((r) => r.clearedAt), [3, 2, 1]);
});

test('AlertsPanel fetches the current range through the model, re-fetches it every 30 s, and pages the rows', () => {
  const panel = web('pages/AlertsPanel.tsx');
  assert.match(panel, /useState<ClearedRange>\(CLEARED_DEFAULT_RANGE\)/, 'the default window');
  assert.match(panel, /fetch\(apiUrl\(clearedHistoryQuery\(range\)\)\)/, 'the request is the model\'s query for the range');
  assert.match(panel, /window\.setInterval\(load, 30_000\);[\s\S]{0,200}\}, \[range\]\);/, 'the 30 s refresh is re-armed per range');
  assert.equal(/apiUrl\('api\/alerts\/history'\)/.test(panel), false, 'no whole-ledger request remains');
  assert.match(panel, /useState\(CLEARED_PAGE_ROWS\)/);
  assert.match(panel, /visibleRows\(filtered, limit\)/, 'the limit applies after the filter');
  assert.match(panel, /setLimit\(\(l\) => l \+ CLEARED_PAGE_ROWS\)/, '"Show more" adds a page');
  assert.match(panel, /setRange\(r\);\n\s*setLimit\(CLEARED_PAGE_ROWS\);/, 'a new range starts at one page');
  assert.match(panel, /loaded\?\.range === range \? loaded\.page : null/, 'a page for another range is not shown under this one');
  assert.match(panel, /clearedCaption\(\{ shown: filtered\.length, total: page\.total, range, filtered: filter === 'severe' \}\)/);
  assert.match(panel, /function ClearedRow\(\{ row \}: \{ row: ClearedHistoryRow \}\)/);
  assert.match(panel, /\{row\.detail && <div/, 'the detail line is still rendered');
  assert.equal(panel.includes('ce.alert'), false, 'no row reads a nested alert object');
});
