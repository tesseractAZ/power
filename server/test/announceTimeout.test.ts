import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sipTimeoutLike, dispatchTimeoutLike } from '../src/broadcast.js';

/**
 * v1.118.0 — a lost HTTP response is not a failed announcement.
 *
 * LIVE INCIDENT 2026-08-30 20:39 MST. A Severe Thunderstorm Warning raised a
 * red. Every `music_assistant.play_announcement` call returned "Headers Timeout
 * Error" — while the audio played each time. The MA path treated each timeout
 * as a miss: 2 in-call attempts x 3 deferred rounds = ~6 announcements of the
 * same alert into the house, during the storm it was warning about. The
 * operator reported "lots of announcements playing" while the log read
 * "failed".
 *
 * v1.48.3 had already learned this on the SIP path (the cordless RANG instead
 * of auto-answering when a duplicate arrived mid-call) and verifies against
 * entity state before re-firing. The MA path never got that treatment. These
 * tests pin the classifier both paths share.
 */

test('the live error string classifies as a timeout', () => {
  assert.equal(dispatchTimeoutLike('Headers Timeout Error'), true,
    'the exact string from the 08-30 incident');
});

test('timeout and abort shapes are all UNKNOWN, not failed', () => {
  for (const e of ['Headers Timeout Error', 'timeout', 'ETIMEDOUT', 'The operation was aborted', 'AbortError']) {
    assert.equal(dispatchTimeoutLike(e), true, e);
  }
});

test('a definite failure is still a definite failure and must still retry', () => {
  for (const e of ['500 Internal Server Error', 'ECONNREFUSED', 'entity not found', 'Bad Request', '401']) {
    assert.equal(dispatchTimeoutLike(e), false, e);
  }
});

test('absent error is not a timeout (never invent an unknown)', () => {
  assert.equal(dispatchTimeoutLike(undefined), false);
  assert.equal(dispatchTimeoutLike(''), false);
});

test('the SIP predicate keeps its all-must-be-timeout semantics', () => {
  // One definite failure in the set makes the whole dispatch a real miss.
  assert.equal(sipTimeoutLike(['Headers Timeout Error', 'timeout']), true);
  assert.equal(sipTimeoutLike(['Headers Timeout Error', 'ECONNREFUSED']), false);
  assert.equal(sipTimeoutLike([]), false, 'no errors is not a timeout verdict');
});

test('the two predicates agree on a single timeout error', () => {
  const e = 'Headers Timeout Error';
  assert.equal(sipTimeoutLike([e]), dispatchTimeoutLike(e),
    'one classifier for one question — they must not drift apart');
});
