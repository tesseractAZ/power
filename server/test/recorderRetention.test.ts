import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRetentionDays } from '../src/recorder.js';

/* v1.51.0 — RECORDER_RETENTION_DAYS resolution. A config typo must never turn
 * into a delete-everything retention; out-of-range values clamp, garbage falls
 * back to the 30-day historical default. */

test('resolveRetentionDays: default, clamp, and garbage fallback', () => {
  assert.equal(resolveRetentionDays(undefined), 30);
  assert.equal(resolveRetentionDays(''), 30);
  assert.equal(resolveRetentionDays('548'), 548);
  assert.equal(resolveRetentionDays('30'), 30);
  assert.equal(resolveRetentionDays('3'), 7);      // below floor → clamp up
  assert.equal(resolveRetentionDays('0'), 7);      // zero must NOT mean "prune all"
  // v1.108.0 — ceiling raised 730 → 3650: the operator runs 5-year retention
  // for long-horizon SoH/energy analytics. The floor and garbage handling are
  // unchanged; only the cap moved.
  assert.equal(resolveRetentionDays('1825'), 1825);
  assert.equal(resolveRetentionDays('10000'), 3650);
  assert.equal(resolveRetentionDays('365.7'), 366); // rounds
  assert.equal(resolveRetentionDays('abc'), 30);
  assert.equal(resolveRetentionDays('-5'), 7);
});
