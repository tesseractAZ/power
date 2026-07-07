import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportKey, reportTtlMs, REPORT_CACHE_TTL_OVERRIDES_MS } from '../src/analyticsClient.js';

/**
 * v0.90.0 — the report() coalesce + short-TTL cache. These pin the pure key/TTL
 * helpers that decide cache identity + freshness. The coalescing itself is built on
 * the unchanged requestWithRetry() path; correctness of the cross-consumer clone is
 * argued in the design (alertMonitor mutates alert elements; every hit is
 * structured-cloned so no consumer shares a mutable ref).
 */

test('reportKey — no-arg reports key to the bare name (the hot path)', () => {
  assert.equal(reportKey('forecast', {}), 'forecast');
  assert.equal(reportKey('runway', undefined as any), 'runway');
});

test('reportKey — arg order does not change the key ({a,b} === {b,a})', () => {
  assert.equal(reportKey('x', { a: 1, b: 2 } as any), reportKey('x', { b: 2, a: 1 } as any));
});

test('reportKey — different args → different keys (no cross-args collision)', () => {
  assert.notEqual(reportKey('rte', { days: 7 } as any), reportKey('rte', { days: 14 } as any));
});

test('reportKey — fractional numeric args are truncated so they cannot grow the Map unbounded', () => {
  // 7.1 / 7.2 / 7.9 all collapse to the days=7 key.
  const k7 = reportKey('rte', { days: 7 } as any);
  assert.equal(reportKey('rte', { days: 7.1 } as any), k7);
  assert.equal(reportKey('rte', { days: 7.9 } as any), k7);
  assert.notEqual(reportKey('rte', { days: 8.0 } as any), k7);
});

test('reportTtlMs — alarm-path reports get a tiny TTL; parameterised reports 0; default otherwise', () => {
  assert.equal(reportTtlMs('curtailmentAlerts'), 3_000);
  assert.equal(reportTtlMs('forecast'), 5_000);
  assert.equal(reportTtlMs('totals'), 0, 'args-bearing reports coalesce-only (no TTL cache)');
  assert.equal(reportTtlMs('backtest'), 0);
  assert.equal(reportTtlMs('shadeReport'), 20_000, 'unlisted report → default TTL');
  // The 0-TTL guard set is a hard invariant (bounds Map cardinality).
  for (const n of ['totals', 'circuitHistory', 'backtest']) assert.equal(REPORT_CACHE_TTL_OVERRIDES_MS[n], 0);
});
