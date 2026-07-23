import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startHeartbeat, heartbeatStatus, heartbeatIntervalMs,
  _resetHeartbeatForTest, _sendOnceForTest,
} from '../src/heartbeat.js';

/* v1.43.0 — out-of-band dead-man's switch: env gating, interval clamp, the
 * send/outcome state machine via the injected fetcher, transition-only log
 * discipline, and URL secrecy (the URL is a capability token — it must never
 * reach a log line, only its host may). */

/** Fresh module + env slate; returns a capturing log installed via a DISABLED
 *  startHeartbeat (env cleared first ⇒ inert: no timers, no live send). Tests
 *  that want sends then set HEARTBEAT_URL and use _sendOnceForTest. */
function freshCapture(): string[] {
  _resetHeartbeatForTest();
  delete process.env.HEARTBEAT_URL;
  delete process.env.HEARTBEAT_INTERVAL_S;
  const logs: string[] = [];
  startHeartbeat((m) => logs.push(m));
  return logs;
}

test('config — empty/http/garbage URL each disable without throwing', () => {
  // empty ⇒ the normal opt-out: inert AND silent
  const logs = freshCapture();
  let s = heartbeatStatus();
  assert.equal(s.enabled, false);
  assert.equal(s.url, false);
  assert.equal(s.lastOkMs, null);
  assert.equal(s.lastErrMs, null);
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(logs.length, 0, 'unconfigured must not nag');

  // http:// ⇒ disabled with ONE warn naming the host, never the full URL
  _resetHeartbeatForTest();
  process.env.HEARTBEAT_URL = 'http://hb.example.invalid/secret-path-token';
  const logs2: string[] = [];
  assert.doesNotThrow(() => startHeartbeat((m) => logs2.push(m)));
  s = heartbeatStatus();
  assert.equal(s.enabled, false);
  assert.equal(s.url, true, 'something WAS configured — health should show the mismatch');
  assert.equal(logs2.length, 1);
  assert.match(logs2[0], /https/);
  assert.match(logs2[0], /hb\.example\.invalid/);
  assert.ok(!logs2[0].includes('secret-path-token'), 'path is the secret — never logged');
  startHeartbeat((m) => logs2.push(m));  // idempotent: no second warn
  assert.equal(logs2.length, 1);

  // garbage ⇒ disabled with ONE warn
  _resetHeartbeatForTest();
  process.env.HEARTBEAT_URL = 'not a url at all';
  const logs3: string[] = [];
  assert.doesNotThrow(() => startHeartbeat((m) => logs3.push(m)));
  s = heartbeatStatus();
  assert.equal(s.enabled, false);
  assert.equal(s.url, true);
  assert.equal(logs3.length, 1);
  assert.match(logs3[0], /disabled/);
});

test('interval — default 300 s, clamped to 60..3600 s', () => {
  assert.equal(heartbeatIntervalMs(undefined), 300_000);
  assert.equal(heartbeatIntervalMs(''), 300_000, 'empty string is unset, not 0');
  assert.equal(heartbeatIntervalMs('garbage'), 300_000);
  assert.equal(heartbeatIntervalMs('300'), 300_000);
  assert.equal(heartbeatIntervalMs('60'), 60_000);
  assert.equal(heartbeatIntervalMs('10'), 60_000, 'clamped up, not rejected');
  assert.equal(heartbeatIntervalMs('3600'), 3_600_000);
  assert.equal(heartbeatIntervalMs('86400'), 3_600_000, 'clamped down');
});

test('send — ok path stamps lastOkMs and clears the failure streak', async () => {
  freshCapture();
  process.env.HEARTBEAT_URL = 'https://hb.example.invalid/ok';
  const before = Date.now();
  await _sendOnceForTest(async () => 200);
  let s = heartbeatStatus();
  assert.ok(s.lastOkMs !== null && s.lastOkMs >= before);
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.lastErrMs, null);
  // failures accumulate, then a single 2xx resets the streak to zero
  await _sendOnceForTest(async () => { throw new Error('net down'); });
  await _sendOnceForTest(async () => { throw new Error('net down'); });
  assert.equal(heartbeatStatus().consecutiveFailures, 2);
  await _sendOnceForTest(async () => 204);  // any 2xx counts as delivered
  s = heartbeatStatus();
  assert.equal(s.consecutiveFailures, 0);
  assert.ok(s.lastOkMs !== null);
  assert.ok(s.lastErrMs !== null, 'lastErrMs is history, not cleared by success');
});

test('send — failure path increments the streak and stamps lastErrMs', async () => {
  freshCapture();
  process.env.HEARTBEAT_URL = 'https://hb.example.invalid/fail';
  await _sendOnceForTest(async () => 500);  // non-2xx status is a failure
  let s = heartbeatStatus();
  assert.equal(s.consecutiveFailures, 1);
  assert.ok(s.lastErrMs !== null);
  assert.equal(s.lastOkMs, null, 'never fabricated');
  await _sendOnceForTest(async () => { throw new TypeError('fetch failed'); });
  s = heartbeatStatus();
  assert.equal(s.consecutiveFailures, 2);
  // a redirect is NOT a delivered ping
  await _sendOnceForTest(async () => 301);
  assert.equal(heartbeatStatus().consecutiveFailures, 3);
});

test('logs — exactly one line per transition, silence on repeats', async () => {
  const logs = freshCapture();
  process.env.HEARTBEAT_URL = 'https://hb.example.invalid/t';
  const ok = async (): Promise<number> => 200;
  const fail = async (): Promise<number> => { throw new Error('boom'); };

  await _sendOnceForTest(ok);    // first-ever success: nothing was "restored"
  assert.equal(logs.length, 0);
  await _sendOnceForTest(ok);    // repeat ok: silent
  assert.equal(logs.length, 0);
  await _sendOnceForTest(fail);  // ok→fail: exactly one warn, class only
  assert.equal(logs.length, 1);
  assert.match(logs[0], /failed \(Error\)/);
  await _sendOnceForTest(fail);  // repeat fail: silent
  await _sendOnceForTest(fail);
  assert.equal(logs.length, 1);
  await _sendOnceForTest(ok);    // fail→ok: exactly one restore line
  assert.equal(logs.length, 2);
  assert.match(logs[1], /restored after 3 failures/);
  await _sendOnceForTest(ok);    // repeat ok: silent again
  assert.equal(logs.length, 2);
});

test('secrecy — the URL never appears in any log line', async () => {
  const logs = freshCapture();
  const SECRET = 'https://hb.example.invalid/ping/deadbeef-cafe-distinctive-token';
  process.env.HEARTBEAT_URL = SECRET;
  let seen: string | null = null;
  // adversarial fetcher: the thrown MESSAGE embeds the URL, the way undici
  // network errors embed the origin — the module may log only the class name
  await _sendOnceForTest(async (u) => {
    seen = u;
    throw new TypeError(`getaddrinfo ENOTFOUND ${u}`);
  });
  await _sendOnceForTest(async () => 200);  // fail→ok transition line
  await _sendOnceForTest(async () => 503);  // ok→fail transition line (HTTP reason)
  assert.equal(seen, SECRET, 'the configured URL is exactly what gets pinged');
  assert.equal(logs.length, 3);
  assert.match(logs[0], /TypeError/);
  assert.match(logs[2], /HTTP 503/);
  for (const line of logs) {
    assert.ok(!line.includes(SECRET), `full URL leaked: ${line}`);
    assert.ok(!line.includes('distinctive-token'), `URL path leaked: ${line}`);
  }
});

test('start — enabled path sends immediately; status reflects the attempt', async () => {
  _resetHeartbeatForTest();
  delete process.env.HEARTBEAT_INTERVAL_S;
  // loopback port 1 refuses instantly: a REAL send through the undici path
  // with zero external traffic. Any outcome must be a recorded failure.
  process.env.HEARTBEAT_URL = 'https://127.0.0.1:1/x-secret-path';
  const logs: string[] = [];
  startHeartbeat((m) => logs.push(m));
  let s = heartbeatStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.url, true);
  assert.match(logs[0], /enabled/);
  assert.match(logs[0], /127\.0\.0\.1:1/, 'host alone is loggable');
  // the boot send is async — wait for it to settle (loopback refusal is fast)
  const deadline = Date.now() + 8000;
  while (heartbeatStatus().lastErrMs === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  s = heartbeatStatus();
  assert.ok(s.lastErrMs !== null, 'immediate boot send was attempted and recorded');
  assert.equal(s.lastOkMs, null);
  assert.equal(s.consecutiveFailures, 1);
  assert.equal(logs.length, 2, 'enabled line + one transition warn, nothing else');
  for (const line of logs) {
    assert.ok(!line.includes('x-secret-path'), `URL path leaked: ${line}`);
  }
  _resetHeartbeatForTest();  // clears the chained (unref'd) interval timer
  delete process.env.HEARTBEAT_URL;
});
