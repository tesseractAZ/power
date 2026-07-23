/**
 * v1.46.0 — telnet transport ⇄ login gate integration.
 *
 * The unit tests in wsConsole.test.ts drive TuiSession with pre-parsed
 * InputEvents; nothing there proves the REAL telnet path — raw TCP bytes →
 * IAC stripping (server.ts parseInput) → session auth state machine → ANSI
 * frames back on the wire — composes correctly. These tests boot the real
 * server (`startTelnetServer`) in-process on an ephemeral port with a mock
 * data provider and auth enabled via TUI_USERNAME / TUI_PASSWORD (server.ts
 * calls `authFromEnv()` per connection, which reads process.env at call
 * time, so the env is set per test and restored after).
 *
 *   1. Correct credentials typed as raw CRLF-terminated lines land in the
 *      console (frames carry the CONSOLE tab, never the login card again).
 *   2. Three rejected attempts → the SERVER closes the TCP connection (and
 *      restores the primary screen buffer on the way out).
 *   3. BS (0x08) and DEL (0x7f) both edit the username field.
 *   4. 'q' at the login prompt is a credential character, NOT quit — but it
 *      IS quit once authenticated (same socket, both sides of the contrast).
 *   5. A NAWS subnegotiation interleaved mid-username (and split across TCP
 *      writes, exercising the incomplete-IAC carry buffer) neither corrupts
 *      the typed credentials nor is leaked into them — and the resize it
 *      carries is applied to the post-auth frames.
 *
 * Frames are located by stripping ANSI escapes and searching for stable
 * markers: 'USERNAME' (login card), 'ACCESS DENIED' (rejection line),
 * 'CONSOLE' (plant footer tab — never rendered by the login card).
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startTelnetServer } from '../src/telnet/server.js';
import { _resetAuthThrottleForTest } from '../src/telnet/session.js';
import type { TuiDataProvider } from '../src/telnet/session.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import type { Recorder } from '../src/recorder.js';

/* ── fixtures (mirrors telnetCaps.test.ts / wsConsole.test.ts) ─────────── */

function mockRecorder(): Recorder {
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn: string, metrics: string[]) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

function mockData(): { provider: TuiDataProvider; stop: () => void } {
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {}, alerts: [] };
  return {
    provider: {
      store: { get: () => snap } as unknown as TuiDataProvider['store'],
      recorder: mockRecorder(),
      totals: () => null,
      forecast: () => null,
      degradation: () => null,
      serverStartedAt: Date.now() - 60_000,
    },
    stop: () => {},
  };
}

async function boot() {
  const t = startTelnetServer({
    store: {} as never,
    recorder: mockRecorder(),
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    data: mockData(),
  });
  await once(t.server, 'listening');
  const addr = t.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { t, port };
}

/* ── raw TCP client helpers ────────────────────────────────────────────── */

/** Strip CSI escape sequences (colors, cursor, mode toggles) from a frame. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A raw TCP client that accumulates everything the server sends. `text()`
 * exposes the ANSI-stripped stream; `waitFor()` polls it with a deadline so a
 * missing frame fails the test with the stream tail instead of hanging.
 */
function connectRaw(port: number) {
  const sock = net.connect({ host: '127.0.0.1', port });
  sock.setNoDelay(true);
  const chunks: Buffer[] = [];
  let closed = false;
  sock.on('data', (d) => chunks.push(d));
  sock.on('close', () => { closed = true; });
  sock.on('error', () => {}); // ignore ECONNRESET on server-side close

  const raw = () => Buffer.concat(chunks).toString('utf8');
  const text = () => stripAnsi(raw());
  const isClosed = () => closed;

  const waitFor = async (marker: string, timeoutMs = 3000): Promise<void> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (text().includes(marker)) return;
      await sleep(15);
    }
    assert.fail(`timed out waiting for ${JSON.stringify(marker)}; stream tail: ${JSON.stringify(text().slice(-400))}`);
  };

  const waitClosed = async (timeoutMs = 3000): Promise<void> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (closed) return;
      await sleep(15);
    }
    assert.fail('timed out waiting for the server to close the connection');
  };

  const write = (data: string | Buffer) => {
    if (!sock.destroyed) sock.write(data);
  };

  return { sock, raw, text, isClosed, waitFor, waitClosed, write };
}

/* ── env plumbing — authFromEnv() reads process.env per connection ─────── */

const CREDS = { username: 'operator', password: 'hunter2' };
let savedUser: string | undefined;
let savedPass: string | undefined;

beforeEach(() => {
  savedUser = process.env.TUI_USERNAME;
  savedPass = process.env.TUI_PASSWORD;
  process.env.TUI_USERNAME = CREDS.username;
  process.env.TUI_PASSWORD = CREDS.password;
  _resetAuthThrottleForTest();
});

afterEach(() => {
  if (savedUser === undefined) delete process.env.TUI_USERNAME;
  else process.env.TUI_USERNAME = savedUser;
  if (savedPass === undefined) delete process.env.TUI_PASSWORD;
  else process.env.TUI_PASSWORD = savedPass;
  _resetAuthThrottleForTest();
});

/* ── tests ─────────────────────────────────────────────────────────────── */

test('telnet auth — correct credentials over raw TCP unlock the console', async () => {
  const { t, port } = await boot();
  const cl = connectRaw(port);
  try {
    // Auth is on → the first frame is the login card, not the console.
    await cl.waitFor('USERNAME');
    assert.ok(!cl.text().includes('CONSOLE'), 'console must not render before login');

    cl.write(`${CREDS.username}\r\n`);
    cl.write(`${CREDS.password}\r\n`);

    await cl.waitFor('CONSOLE');
    // Everything from the first console frame onward is console markup — the
    // login card must never re-render after a successful login.
    const all = cl.text();
    const idx = all.indexOf('CONSOLE');
    assert.ok(!all.slice(idx).includes('USERNAME'), 'login card re-rendered after auth');
    assert.ok(!all.includes('ACCESS DENIED'), 'correct credentials were rejected');
    assert.equal(cl.isClosed(), false);
  } finally {
    cl.sock.destroy();
    t.stop();
  }
});

test('telnet auth — three rejected attempts close the TCP connection', async () => {
  const { t, port } = await boot();
  const cl = connectRaw(port);
  try {
    await cl.waitFor('USERNAME');

    cl.write('baduser\r\nbadpass\r\n'); // attempt 1
    await cl.waitFor('2 attempt(s) remaining');
    cl.write('baduser\r\nbadpass\r\n'); // attempt 2
    await cl.waitFor('1 attempt(s) remaining');
    cl.write('baduser\r\nbadpass\r\n'); // attempt 3 → denied → disconnect

    await cl.waitClosed();
    assert.ok(cl.text().includes('ACCESS DENIED'));
    assert.ok(!cl.text().includes('CONSOLE'), 'failed login must never reach the console');
    // The transport restores the primary screen buffer on its way out so the
    // operator's terminal isn't left stranded in the alt buffer.
    assert.ok(cl.raw().includes('\x1b[?1049l'), 'server-side close must exit the alt buffer');
  } finally {
    cl.sock.destroy();
    t.stop();
  }
});

test('telnet auth — BS (0x08) and DEL (0x7f) both edit the username field', async () => {
  const { t, port } = await boot();
  const cl = connectRaw(port);
  try {
    await cl.waitFor('USERNAME');

    // Type "opex", BS erases the x → "ope"; "rq", DEL erases the q → "oper";
    // then finish the username. Both erase bytes must map to backspace.
    cl.write('opex');
    cl.write(Buffer.from([0x08]));
    cl.write('rq');
    cl.write(Buffer.from([0x7f]));
    cl.write('ator\r\n');
    cl.write(`${CREDS.password}\r\n`);

    await cl.waitFor('CONSOLE');
    assert.ok(!cl.text().includes('ACCESS DENIED'), 'edited username should authenticate cleanly');
  } finally {
    cl.sock.destroy();
    t.stop();
  }
});

test('telnet auth — q at the login prompt is input, not quit (and IS quit after auth)', async () => {
  // Make the username literally 'q' so the same keystroke that would quit the
  // console must be accepted as a credential character to log in at all.
  process.env.TUI_USERNAME = 'q';
  const { t, port } = await boot();
  const cl = connectRaw(port);
  try {
    await cl.waitFor('USERNAME');

    cl.write('q');
    await sleep(250);
    assert.equal(cl.isClosed(), false, "'q' at the login prompt must not disconnect");

    cl.write('\r\n');
    cl.write(`${CREDS.password}\r\n`);
    await cl.waitFor('CONSOLE');

    // Contrast: past the gate the same key quits, and the server closes.
    cl.write('q');
    await cl.waitClosed();
  } finally {
    cl.sock.destroy();
    t.stop();
  }
});

test('telnet auth — NAWS subnegotiation mid-username does not corrupt the fields', async () => {
  const { t, port } = await boot();
  const cl = connectRaw(port);
  try {
    await cl.waitFor('USERNAME');

    cl.write('oper');
    // NAWS 120×40 (IAC SB NAWS 0 120 0 40 IAC SE) split across two writes so
    // the trailing-incomplete-IAC carry path runs over the real transport.
    cl.write(Buffer.from([255, 250, 31, 0, 120]));
    await sleep(40);
    cl.write(Buffer.from([0, 40, 255, 240]));
    cl.write('ator\r\n');
    cl.write(`${CREDS.password}\r\n`);

    await cl.waitFor('CONSOLE');
    const all = cl.text();
    assert.ok(!all.includes('ACCESS DENIED'), 'IAC bytes leaked into a credential field');
    // The resize the subnegotiation carried must be applied: plant frames end
    // with a full-width footer rule, so a 120-column run of ─ proves the
    // session is rendering at the NAWS size (login/80-col frames never
    // produce one — the login rule is ≤44 and the default width is 80).
    assert.match(all, /─{120}/, 'NAWS resize was not applied to post-auth frames');
  } finally {
    cl.sock.destroy();
    t.stop();
  }
});
