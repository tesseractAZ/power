/**
 * v1.187.10 (log review 10-03, C21) — /api/health publishes pollErrorKind only while a failure is
 * current. A healthy add-on returned {"ok":true,"blind":false,…,"pollErrorKind":"other"}: the
 * classifier's deliberate null → 'other' fallback (the blind alert renders it as cause "unknown")
 * published as if it were a current error class. Driven through the module's own poll state, as the
 * route reads it (assessBlind over pollState()).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessBlind, classifyPollError, healthPollErrorKind, notePollFailed, notePollOk, pollState } from '../src/telemetryBlind.js';

const health = (nowMs: number, projectedDeviceCount = 3) => {
  const v = assessBlind({ nowMs, bootMs: nowMs - 3_600_000, projectedDeviceCount, ...pollState(), lastHealAtMs: null });
  return { blind: v.blind, pollErrorKind: healthPollErrorKind(v, pollState()) };
};

test('★★ healthy: null, not "other"; a current failure: its class; blind: the verdict\'s class', () => {
  const t = Date.now();
  notePollOk(t);
  assert.deepEqual(health(t), { blind: false, pollErrorKind: null });
  assert.equal(classifyPollError(null), 'other', 'the classifier contract the blind alert relies on is unchanged');

  notePollFailed('EcoFlow API error 8521: signature is wrong');
  assert.deepEqual(health(t + 1_000), { blind: false, pollErrorKind: 'auth' }, 'one failed poll: reported while current');

  notePollFailed('getaddrinfo EAI_AGAIN api.ecoflow.com');
  assert.deepEqual(health(t + 10 * 60_000), { blind: true, pollErrorKind: 'network' }, 'stale past the threshold: blind');

  notePollOk(t + 11 * 60_000);
  assert.deepEqual(health(t + 11 * 60_000), { blind: false, pollErrorKind: null }, 'recovered: cleared');
});

test('healthPollErrorKind — any one of blind, a last error or a failure count keeps the class', () => {
  assert.equal(healthPollErrorKind({ blind: true, errorKind: 'other' }, { lastError: null, consecutiveFailures: 0 }), 'other');
  assert.equal(healthPollErrorKind({ blind: false, errorKind: 'network' }, { lastError: 'x', consecutiveFailures: 0 }), 'network');
  assert.equal(healthPollErrorKind({ blind: false, errorKind: 'auth' }, { lastError: null, consecutiveFailures: 2 }), 'auth');
  assert.equal(healthPollErrorKind({ blind: false, errorKind: 'other' }, { lastError: null, consecutiveFailures: 0 }), null);
});

test('★ the /api/health route publishes the gated class (source pin: index.ts is not importable in a test)', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(idx, /pollErrorKind: healthPollErrorKind\(blind, pollState\(\)\),/);
  assert.doesNotMatch(idx, /pollErrorKind: blind\.errorKind/);
});
