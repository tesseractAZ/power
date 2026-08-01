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
  assert.equal(resolveRetentionDays('10000'), 730);
  assert.equal(resolveRetentionDays('365.7'), 366); // rounds
  assert.equal(resolveRetentionDays('abc'), 30);
  assert.equal(resolveRetentionDays('-5'), 7);
});
