import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTopLevelError, handleTopLevelError } from '../src/processGuard.js';

/* v0.60.0 — the process guard survives a transient DNS/network bounce (the daily
 * CoreDNS/AppArmor maintenance window crashed the add-on with exit 255) but
 * re-raises a genuinely fatal uncaught error so a real bug is never masked. */

test('classifyTopLevelError — transient DNS/network errors → survive', () => {
  for (const e of [
    { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN api-a.ecoflow.com' },
    { code: 'ENOTFOUND' },
    { code: 'ECONNREFUSED' },
    { code: 'ETIMEDOUT' },
    new Error('connect timeout'),
    new Error('fetch failed'),
  ]) assert.equal(classifyTopLevelError(e), 'survive', `${JSON.stringify(e)} should survive`);
});

test('classifyTopLevelError — a genuine bug → fatal (never masked)', () => {
  assert.equal(classifyTopLevelError(new TypeError("Cannot read properties of undefined (reading 'x')")), 'fatal');
  assert.equal(classifyTopLevelError(new RangeError('Maximum call stack size exceeded')), 'fatal');
  assert.equal(classifyTopLevelError(new Error('assertion failed: invariant broken')), 'fatal');
});

test('handleTopLevelError — survives a transient error WITHOUT exiting (logs loudly)', () => {
  const logs: string[] = [];
  let fatalCalled = false;
  const d = handleTopLevelError(
    { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN core-dns' },
    'uncaughtException',
    { error: (m) => logs.push('E:' + m), fatal: (m) => logs.push('F:' + m) },
    () => { fatalCalled = true; },
  );
  assert.equal(d, 'survive');
  assert.equal(fatalCalled, false, 'a transient DNS bounce must NOT exit the process');
  assert.ok(logs.some((l) => l.startsWith('E:') && /SURVIVED transient/.test(l)), 'logs loudly at error level');
});

test('handleTopLevelError — re-raises a fatal error via onFatal', () => {
  const logs: string[] = [];
  let fatalCalled = false;
  const d = handleTopLevelError(
    new TypeError('boom'),
    'unhandledRejection',
    { error: (m) => logs.push('E:' + m), fatal: (m) => logs.push('F:' + m) },
    () => { fatalCalled = true; },
  );
  assert.equal(d, 'fatal');
  assert.equal(fatalCalled, true, 'a genuine bug must still be fatal');
  assert.ok(logs.some((l) => l.startsWith('F:') && /FATAL/.test(l)));
});
