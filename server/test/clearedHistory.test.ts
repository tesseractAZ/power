/**
 * `GET /api/alerts/history` serves a window of the cleared ledger, newest first, each row reduced
 * to what the Cleared table renders (server/src/clearedHistory.ts).
 *
 * The route returned the whole ledger — 1,500 rows at the cap, 1.2 MB, each row the complete
 * alert object — and the page fetched it on mount and every 30 s. These tests pin the window
 * (`days` default 7, clamped to 1..365; `since`; `all=1`), the inclusive lower bound, the order,
 * the projection (and what it leaves out), the counts, the cache headers per window over a
 * Fastify `inject()`, and the wiring in index.ts. Fixtures carry fake serials.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  CLEARED_HISTORY_DEFAULT_DAYS,
  CLEARED_HISTORY_MAX_DAYS,
  clearedHistoryPage,
  clearedHistoryWindow,
  projectClearedRow,
  wantsAll,
} from '../src/clearedHistory.js';
import { cached } from '../src/cachedReply.js';
import type { ClearedAlert } from '../src/alertMonitor.js';
import type { Alert } from '../src/alerts.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const here = dirname(fileURLToPath(import.meta.url));

/** A cleared row whose clear is `agoDays` before NOW (fractions allowed), lasting 10 minutes. */
function row(id: string, agoDays: number, o: Partial<Alert> & { closedAs?: ClearedAlert['closedAs']; pushed?: boolean } = {}): ClearedAlert {
  const { closedAs, pushed, ...alert } = o;
  const clearedAt = NOW - agoDays * DAY;
  return {
    alert: { id, severity: 'warning', category: 'Battery', device: 'Core 9', title: `t-${id}`, detail: `d-${id}`, ...alert },
    raisedAt: clearedAt - 600_000,
    clearedAt,
    durationMs: 600_000,
    ...(closedAs ? { closedAs } : {}),
    ...(pushed != null ? { pushed } : {}),
  };
}

/** A row carrying every field the ledger can hold, none of which the table renders but a few. */
const FULL: ClearedAlert = {
  alert: {
    id: 'vdiff-warn-TEST-CORE-01-2', severity: 'warning', category: 'Battery', device: 'Core 1',
    title: 'Cell imbalance', detail: 'Pack 2 cell spread 61 mV (warning fires ≥ 60 mV, holds ≥ 40 mV).',
    source: 'learned', priority: 'medium', coreNum: 1, packNum: 2,
    facts: [{ label: 'spread', value: '61 mV' } as never],
    sourceSn: 'TEST-CORE-01', sourcePackSn: 'TEST-PACK-02', fault: 'x', annunciate: false, audible: false,
    muteReason: 'balancing', mutedBy: 'balancing' as never,
  },
  closedAs: { title: 'Cell imbalance', detail: 'Pack 2 cell spread 12 mV.', severity: 'info' },
  raisedAt: NOW - 3 * DAY - 3_600_000,
  clearedAt: NOW - 3 * DAY,
  durationMs: 3_600_000,
  pushed: true,
  rosterMuted: true,
};

const LEDGER: ClearedAlert[] = [
  row('a', 0.5), row('b', 2), row('c', 6.9), row('d', 7), row('e', 7.001), row('f', 20), row('g', 29),
  row('h', 45), row('i', 89), row('j', 120), row('k', 300), row('l', 400),
];

/* ── the window ──────────────────────────────────────────────────────────── */

test('no query: the last 7 days (CLEARED_HISTORY_DEFAULT_DAYS), inclusive at the bound', () => {
  assert.equal(CLEARED_HISTORY_DEFAULT_DAYS, 7);
  const p = clearedHistoryPage(LEDGER, {}, NOW);
  assert.equal(p.windowDays, 7);
  assert.equal(p.since, NOW - 7 * DAY);
  assert.deepEqual(p.cleared.map((r) => r.id), ['a', 'b', 'c', 'd'], 'd cleared exactly at the bound is in; e (1.4 min older) is out');
  assert.equal(p.total, LEDGER.length);
  assert.equal(p.shown, 4);
});

test('?days=N: parsed, truncated, clamped to 1..CLEARED_HISTORY_MAX_DAYS; not a number ⇒ the default', () => {
  assert.equal(CLEARED_HISTORY_MAX_DAYS, 365);
  const days = (v: unknown) => clearedHistoryWindow({ days: v }, NOW).windowDays;
  assert.equal(days('30'), 30);
  assert.equal(days('90'), 90);
  assert.equal(days(30), 30);
  assert.equal(days('2.9'), 2, 'whole days');
  assert.equal(days('0'), 1);
  assert.equal(days('-5'), 1);
  assert.equal(days('400'), 365);
  assert.equal(days('1e9'), 365);
  assert.equal(days('abc'), 7);
  assert.equal(days(''), 7);
  assert.equal(days('  '), 7);
  assert.equal(days(undefined), 7);
  assert.equal(days(['7', '30']), 7, 'a repeated key is not a number');
  assert.equal(days('Infinity'), 7);
  assert.equal(days('NaN'), 7);
  const p30 = clearedHistoryPage(LEDGER, { days: '30' }, NOW);
  assert.deepEqual(p30.cleared.map((r) => r.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(p30.since, NOW - 30 * DAY);
  const p90 = clearedHistoryPage(LEDGER, { days: '90' }, NOW);
  assert.equal(p90.shown, 9);
  const p365 = clearedHistoryPage(LEDGER, { days: '400' }, NOW);
  assert.equal(p365.shown, 11, 'clamped to a year: the 400-day-old row stays out');
  assert.equal(p365.windowDays, 365);
});

test('?since=<ms>: an exact inclusive lower bound; windowDays null; wins over days', () => {
  const since = NOW - 7.001 * DAY;
  const p = clearedHistoryPage(LEDGER, { since: String(since), days: '1' }, NOW);
  assert.equal(p.since, since);
  assert.equal(p.windowDays, null);
  assert.deepEqual(p.cleared.map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(clearedHistoryPage(LEDGER, { since: String(since + 1) }, NOW).shown, 4, 'one ms later excludes e');
  assert.equal(clearedHistoryWindow({ since: 'soon' }, NOW).windowDays, 7, 'an unparsable since falls back to the days window');
  assert.equal(clearedHistoryWindow({ since: '' }, NOW).windowDays, 7);
  assert.equal(clearedHistoryPage(LEDGER, { since: String(NOW + DAY) }, NOW).shown, 0, 'a future bound shows nothing');
});

test('?all=1: the whole ledger, newest first, projected; wins over since and days', () => {
  for (const v of ['1', 'true', 'TRUE', 'True']) assert.equal(wantsAll(v), true, v);
  for (const v of ['0', 'yes', '', 'false', undefined, 1, ['1']]) assert.equal(wantsAll(v), false, String(v));
  const p = clearedHistoryPage(LEDGER, { all: '1', since: String(NOW), days: '1' }, NOW);
  assert.equal(p.since, null);
  assert.equal(p.windowDays, null);
  assert.equal(p.shown, LEDGER.length);
  assert.equal(p.total, LEDGER.length);
  assert.deepEqual(p.cleared.map((r) => r.id), LEDGER.map((e) => e.alert.id));
  for (const r of p.cleared) assert.equal('alert' in r, false, 'projected, not the ledger row');
  assert.equal(clearedHistoryPage(LEDGER, { all: '0' }, NOW).shown, 4, 'all=0 is the default window');
});

/* ── order ───────────────────────────────────────────────────────────────── */

test('newest first whatever the ledger order; ties keep their order; the ledger is not reordered', () => {
  const shuffled = [row('old', 5), row('new', 0.1), row('tie-1', 2), row('mid', 3), row('tie-2', 2)];
  const before = shuffled.map((e) => e.alert.id);
  const p = clearedHistoryPage(shuffled, { days: '7' }, NOW);
  assert.deepEqual(p.cleared.map((r) => r.id), ['new', 'tie-1', 'tie-2', 'mid', 'old']);
  assert.deepEqual(shuffled.map((e) => e.alert.id), before, 'input untouched');
  const all = clearedHistoryPage(shuffled, { all: '1' }, NOW);
  assert.deepEqual(all.cleared.map((r) => r.id), ['new', 'tie-1', 'tie-2', 'mid', 'old']);
});

test('a row without a finite clearedAt is in no window and sorts last under all=1', () => {
  const bad = { ...row('bad', 1), clearedAt: Number.NaN };
  const ledger = [bad, row('ok', 1)];
  assert.deepEqual(clearedHistoryPage(ledger, {}, NOW).cleared.map((r) => r.id), ['ok']);
  assert.deepEqual(clearedHistoryPage(ledger, { all: '1' }, NOW).cleared.map((r) => r.id), ['ok', 'bad']);
});

/* ── the projection ──────────────────────────────────────────────────────── */

test('a row is the fields the table renders and nothing else of the alert', () => {
  const r = projectClearedRow(FULL);
  assert.deepEqual(Object.keys(r).sort(), [
    'category', 'clearedAt', 'closedAs', 'coreNum', 'detail', 'device', 'durationMs', 'id', 'packNum',
    'priority', 'pushed', 'raisedAt', 'severity', 'source', 'title',
  ]);
  assert.equal(r.id, FULL.alert.id);
  assert.equal(r.title, 'Cell imbalance');
  assert.equal(r.detail, FULL.alert.detail, 'the detail line is rendered under the title');
  assert.equal(r.severity, 'warning');
  assert.equal(r.priority, 'medium');
  assert.equal(r.source, 'learned');
  assert.equal(r.category, 'Battery');
  assert.equal(r.device, 'Core 1');
  assert.equal(r.coreNum, 1);
  assert.equal(r.packNum, 2);
  assert.equal(r.raisedAt, FULL.raisedAt);
  assert.equal(r.clearedAt, FULL.clearedAt);
  assert.equal(r.durationMs, FULL.durationMs);
  assert.deepEqual(r.closedAs, { title: 'Cell imbalance', severity: 'info' }, 'closedAs without its detail');
  assert.equal(r.pushed, true);
  const json = JSON.stringify(r);
  for (const leaked of ['facts', 'sourceSn', 'sourcePackSn', 'TEST-PACK-02', 'muteReason', 'mutedBy', 'annunciate', 'audible', 'fault', 'rosterMuted', '"alert"', '12 mV']) {
    assert.equal(json.includes(leaked), false, `${leaked} is not sent`);
  }
  assert.ok(json.length < JSON.stringify(FULL).length, `slim (${json.length} B) against the ledger row (${JSON.stringify(FULL).length} B)`);
});

test('optional fields are absent, not undefined, when the ledger row lacks them', () => {
  const r = projectClearedRow(row('plain', 1));
  assert.deepEqual(Object.keys(r).sort(), ['category', 'clearedAt', 'detail', 'device', 'durationMs', 'id', 'raisedAt', 'severity', 'title']);
  assert.equal(Object.hasOwn(r, 'closedAs'), false);
  assert.equal(Object.hasOwn(r, 'pushed'), false);
  assert.equal(Object.hasOwn(r, 'priority'), false);
  const withNulls = projectClearedRow(row('nulls', 1, { coreNum: null, packNum: null }));
  assert.equal(Object.hasOwn(withNulls, 'coreNum'), false, 'a null core is no core');
  const pushedFalse = projectClearedRow(row('np', 1, { pushed: false }));
  assert.equal(pushedFalse.pushed, false, 'recorded as not pushed is kept (absent means unknown)');
});

/* ── the route: window + cache ───────────────────────────────────────────── */

async function routeApp(ledger: ClearedAlert[], now = NOW) {
  const app = Fastify({ logger: false });
  // The same shape as index.ts registers (pinned below), over a stub ledger and clock.
  app.get<{ Querystring: { days?: string; since?: string; all?: string } }>('/api/alerts/history', async (req, reply) =>
    cached(req, reply, clearedHistoryPage(ledger, req.query ?? {}, now), 30),
  );
  await app.ready();
  return app;
}

test('route: each window has its own ETag; a matching If-None-Match is a 304 for that window only', async () => {
  const app = await routeApp(LEDGER);
  try {
    const r7 = await app.inject({ method: 'GET', url: '/api/alerts/history' });
    assert.equal(r7.statusCode, 200);
    assert.equal(r7.headers['cache-control'], 'private, max-age=30');
    const etag7 = r7.headers.etag as string;
    assert.match(etag7, /^"[A-Za-z0-9+/]{22}"$/);
    const body7 = r7.json();
    assert.equal(body7.windowDays, 7);
    assert.equal(body7.shown, 4);
    assert.equal(body7.total, LEDGER.length);

    const again = await app.inject({ method: 'GET', url: '/api/alerts/history?days=7', headers: { 'if-none-match': etag7 } });
    assert.equal(again.statusCode, 304, 'the explicit default window is the same body');
    assert.equal(again.body, '');

    const r30 = await app.inject({ method: 'GET', url: '/api/alerts/history?days=30', headers: { 'if-none-match': etag7 } });
    assert.equal(r30.statusCode, 200, 'another window is not the cached one');
    assert.notEqual(r30.headers.etag, etag7);
    assert.equal(r30.json().shown, 7);

    const rAll = await app.inject({ method: 'GET', url: '/api/alerts/history?all=1' });
    assert.equal(rAll.statusCode, 200);
    const all = rAll.json();
    assert.equal(all.shown, all.total);
    assert.equal(all.total, LEDGER.length);
    assert.notEqual(rAll.headers.etag, r30.headers.etag);
    assert.equal((await app.inject({ method: 'GET', url: '/api/alerts/history?all=1', headers: { 'if-none-match': rAll.headers.etag as string } })).statusCode, 304);

    const rBad = await app.inject({ method: 'GET', url: '/api/alerts/history?days=nope' });
    assert.equal(rBad.statusCode, 200);
    assert.equal(rBad.headers.etag, etag7, 'an unparsable days is the default window, byte for byte');
  } finally {
    await app.close();
  }
});

test('route: a row that leaves the window changes the ETag, so a 30 s poll is not served the stale page', async () => {
  const ledger = [row('edge', 6.9999), row('fresh', 1)];
  const app = await routeApp(ledger, NOW);
  const later = await routeApp(ledger, NOW + DAY);
  try {
    const a = await app.inject({ method: 'GET', url: '/api/alerts/history' });
    const b = await later.inject({ method: 'GET', url: '/api/alerts/history', headers: { 'if-none-match': a.headers.etag as string } });
    assert.equal(a.json().shown, 2);
    assert.equal(b.statusCode, 200);
    assert.equal(b.json().shown, 1);
    assert.notEqual(b.headers.etag, a.headers.etag);
  } finally {
    await app.close();
    await later.close();
  }
});

/* ── wired to production ─────────────────────────────────────────────────── */

test('index.ts serves /api/alerts/history through clearedHistoryPage over monitor.history(), cached 30 s', () => {
  const src = readFileSync(resolve(here, '../src/index.ts'), 'utf8');
  assert.match(src, /import \{ clearedHistoryPage \} from '\.\/clearedHistory\.js';/);
  assert.match(src, /import \{ cached \} from '\.\/cachedReply\.js';/);
  assert.match(
    src,
    /app\.get<\{ Querystring: \{ days\?: string; since\?: string; all\?: string \} \}>\('\/api\/alerts\/history', async \(req, reply\) =>\n\s*cached\(req, reply, clearedHistoryPage\(monitor\.history\(\), req\.query \?\? \{\}, Date\.now\(\)\), 30\),/,
  );
  assert.equal(src.includes('{ cleared: monitor.history() }'), false, 'the whole-ledger body is gone');
  assert.equal(/\nfunction cached</.test(src), false, 'one cached(): cachedReply.ts');
});
