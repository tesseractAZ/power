/**
 * Tests for the browser web-terminal transport (/console).
 *
 *   1. parseXtermData — the char-mode keyboard parser maps ESC arrows,
 *      CR/LF→enter, Ctrl-C, TAB and printable ASCII to the same
 *      transport-agnostic InputEvents the SSH transport's parser produces.
 *   2. TuiSession — the extracted session driver renders frames to its write
 *      sink, applies key navigation, honors resize, suppresses byte-identical
 *      frames (anti-flicker), and reports quit on ctrl-c / q.
 *   3. /console/ws — the origin gate, the session cap, the idle timeout, and the
 *      login card counting its failures under the socket's address: ten from one
 *      address (IPv4 on a dual-stack listener) refuse that address, the right
 *      credentials included, while another address (IPv6 loopback) logs in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { parseXtermData, registerWsConsole, MAX_WS_SESSIONS, WS_IDLE_TIMEOUT_MS } from '../src/telnet/wsConsole.js';
import { TuiSession, _resetAuthThrottleForTest, consoleLoginThrottled } from '../src/telnet/session.js';
import type { TuiDataProvider } from '../src/telnet/session.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import type { Recorder } from '../src/recorder.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

/* ── fixtures ──────────────────────────────────────────────────────────── */

function mockRecorder(): Recorder {
  // Every member is the shared stub's no-op default; queryMulti already yields an
  // empty array per requested metric.
  return makeRecorderStub();
}

function mockDataProvider(): TuiDataProvider {
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {}, alerts: [] };
  return {
    store: { get: () => snap } as any,
    recorder: mockRecorder(),
    totals: () => null,
    forecast: () => null,
    degradation: () => null,
    serverStartedAt: Date.now() - 60_000,
  };
}

/** A TuiSession wired to a string-collecting sink. */
function makeSession(width = 100, height = 40, auth: { username: string; password: string } | null = null) {
  const writes: string[] = [];
  const session = new TuiSession({
    write: (d) => writes.push(d),
    data: mockDataProvider(),
    width,
    height,
    auth,
  });
  return { session, writes };
}

/* ── parseXtermData ────────────────────────────────────────────────────── */

test('parseXtermData — printable keys', () => {
  assert.deepEqual(parseXtermData('1'), [{ type: 'key', key: '1' }]);
  assert.deepEqual(parseXtermData('q'), [{ type: 'key', key: 'q' }]);
  assert.deepEqual(parseXtermData('ab'), [
    { type: 'key', key: 'a' },
    { type: 'key', key: 'b' },
  ]);
});

test('parseXtermData — CR, LF and CRLF all become a single enter', () => {
  assert.deepEqual(parseXtermData('\r'), [{ type: 'key', key: 'enter' }]);
  assert.deepEqual(parseXtermData('\n'), [{ type: 'key', key: 'enter' }]);
  assert.deepEqual(parseXtermData('\r\n'), [{ type: 'key', key: 'enter' }]);
});

test('parseXtermData — Ctrl-C and TAB', () => {
  assert.deepEqual(parseXtermData('\x03'), [{ type: 'key', key: 'ctrl-c' }]);
  assert.deepEqual(parseXtermData('\t'), [{ type: 'key', key: 'tab' }]);
});

test('parseXtermData — arrow keys (CSI and SS3 forms)', () => {
  assert.deepEqual(parseXtermData('\x1b[A'), [{ type: 'key', key: 'up' }]);
  assert.deepEqual(parseXtermData('\x1b[B'), [{ type: 'key', key: 'down' }]);
  assert.deepEqual(parseXtermData('\x1b[C'), [{ type: 'key', key: 'right' }]);
  assert.deepEqual(parseXtermData('\x1b[D'), [{ type: 'key', key: 'left' }]);
  assert.deepEqual(parseXtermData('\x1bOA'), [{ type: 'key', key: 'up' }]);
});

test('parseXtermData — bare ESC is its own key', () => {
  assert.deepEqual(parseXtermData('\x1b'), [{ type: 'key', key: 'esc' }]);
});

test('parseXtermData — no IAC handling (0xFF is just skipped, not a command)', () => {
  // A telnet parser would treat 0xFF (IAC) as a command lead-in; the char-mode
  // parser has no IAC concept, so a lone 0xFF byte is a non-printable skip and
  // the following printable still registers.
  assert.deepEqual(parseXtermData('\xff1'), [{ type: 'key', key: '1' }]);
});

/* ── TuiSession driver ─────────────────────────────────────────────────── */

test('TuiSession — first draw writes a non-empty synchronized frame', () => {
  const { session, writes } = makeSession();
  session.draw();
  assert.equal(writes.length, 1);
  // Wrapped in mode-2026 synchronized-output escapes.
  assert.ok(writes[0].startsWith('\x1b[?2026h'), 'frame not wrapped in BEGIN_SYNC');
  assert.ok(writes[0].endsWith('\x1b[?2026l'), 'frame not wrapped in END_SYNC');
});

test('TuiSession — identical re-draw is suppressed (anti-flicker)', () => {
  const { session, writes } = makeSession();
  session.draw();
  const after1 = writes.length;
  session.draw(); // nothing changed → byte-identical body → no write
  assert.equal(writes.length, after1, 'identical frame should not be re-written');
});

test('TuiSession — v1.46.0: switching console screens produces a new frame', () => {
  const { session, writes } = makeSession();
  session.draw();
  const before = writes.length;
  const r = session.feed([{ type: 'key', key: '2' }]); // console → gen
  assert.equal(r.redraw, true);
  session.draw();
  assert.ok(writes.length > before, 'screen switch should yield a fresh frame');
});

/* ── v1.46.0 — login gate (session-level, shared by both transports) ───── */

test('TuiSession — no configured password opens straight into the console', () => {
  const { session } = makeSession();
  assert.equal(session.isInteractive, true);
});

test('TuiSession — auth: correct credentials unlock the console', () => {
  _resetAuthThrottleForTest();
  const { session } = makeSession(100, 40, { username: 'operator', password: 'hunter2' });
  assert.equal(session.isInteractive, false, 'starts at the login prompt');
  const type = (text: string) => session.feed([...text].map((ch) => ({ type: 'key' as const, key: ch })));
  type('operator');
  session.feed([{ type: 'key', key: 'enter' }]);
  type('hunter2');
  const r = session.feed([{ type: 'key', key: 'enter' }]);
  assert.equal(r.redraw, true);
  assert.equal(session.isInteractive, true, 'authenticated → console');
});

test('TuiSession — auth: q while typing does NOT quit; three failures do', () => {
  _resetAuthThrottleForTest();
  const { session } = makeSession(100, 40, { username: 'operator', password: 'secret' });
  // 'q' is a legitimate credential character at the login prompt.
  assert.equal(session.feed([{ type: 'key', key: 'q' }]).quit, undefined);
  const attempt = () => session.feed([
    { type: 'key', key: 'x' }, { type: 'key', key: 'enter' },
    { type: 'key', key: 'y' }, { type: 'key', key: 'enter' },
  ]);
  assert.equal(attempt().quit, undefined, 'first failure re-prompts');
  assert.equal(attempt().quit, undefined, 'second failure re-prompts');
  assert.equal(attempt().quit, true, 'third failure disconnects');
});

test('TuiSession — auth: backspace edits the active field', () => {
  _resetAuthThrottleForTest();
  const { session } = makeSession(100, 40, { username: 'op', password: 'pw' });
  const keys = (...ks: string[]) => session.feed(ks.map((k) => ({ type: 'key' as const, key: k })));
  keys('o', 'x', 'backspace', 'p', 'enter'); // username 'op' after edit
  keys('p', 'w', 'enter');
  assert.equal(session.isInteractive, true);
});

test('TuiSession — auth: the address\'s window refuses submits after 10 failures (sessions with no peer named share one address)', () => {
  _resetAuthThrottleForTest();
  const fail = () => {
    const { session } = makeSession(100, 40, { username: 'op', password: 'pw' });
    return session.feed([
      { type: 'key', key: 'x' }, { type: 'key', key: 'enter' },
      { type: 'key', key: 'y' }, { type: 'key', key: 'enter' },
    ]);
  };
  // 10 failures across 10 fresh sessions (no peer named, so all one address) saturate its window …
  for (let i = 0; i < 10; i++) fail();
  // … so an 11th session is refused on its FIRST submit, even with the
  // correct credentials — no oracle while throttled.
  const { session } = makeSession(100, 40, { username: 'op', password: 'pw' });
  const r = session.feed([
    { type: 'key', key: 'o' }, { type: 'key', key: 'p' }, { type: 'key', key: 'enter' },
    { type: 'key', key: 'p' }, { type: 'key', key: 'w' }, { type: 'key', key: 'enter' },
  ]);
  assert.equal(r.quit, true, 'throttled submit disconnects');
  _resetAuthThrottleForTest();
});

test('TuiSession — preAuthenticated opens in the console and keeps the operator seat (the SSH transport); the browser console never sets it', () => {
  _resetAuthThrottleForTest();
  const writes: string[] = [];
  const session = new TuiSession({
    write: (d) => writes.push(d),
    data: mockDataProvider(),
    width: 160,
    height: 40,
    auth: { username: 'operator', password: 'hunter2' },
    preAuthenticated: true,
  });
  assert.equal(session.isInteractive, true, 'no login card: the transport verified the password');
  session.draw();
  const frame = (writes.at(-1) ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  assert.ok(frame.includes('CONSOLE'), 'a console frame, not the login card');
  assert.ok(!frame.includes('USERNAME'));
  assert.match(frame, /OPR operator@local/, 'the OPR seat still names the signed-in user');
  // The flag without credentials is the open console, as `auth: null` is.
  const open = new TuiSession({ write: () => {}, data: mockDataProvider(), auth: null, preAuthenticated: true });
  assert.equal(open.isInteractive, true);
  // The browser console keeps its login card: it constructs the session without the flag.
  const src = readFileSync(resolve(import.meta.dirname, '../src/telnet/wsConsole.ts'), 'utf8');
  assert.doesNotMatch(src, /preAuthenticated/, '/console must keep the in-session login card');
  assert.match(src, /new TuiSession\(\{\s*auth: authFromEnv\(\),/, '/console passes the configured credentials to the card');
});

test('TuiSession — ctrl-c and q report quit (console mode)', () => {
  const a = makeSession();
  assert.equal(a.session.feed([{ type: 'key', key: 'ctrl-c' }]).quit, true);
  const b = makeSession();
  assert.equal(b.session.feed([{ type: 'key', key: 'q' }]).quit, true);
  const c = makeSession();
  assert.equal(c.session.feed([{ type: 'key', key: 'Q' }]).quit, true);
});

test('TuiSession — resize clamps to the supported range and flags change', () => {
  const { session } = makeSession(100, 40);
  // Within range.
  assert.equal(session.resize(120, 50), true);
  assert.equal(session.width, 120);
  assert.equal(session.height, 50);
  // Same size → no change.
  assert.equal(session.resize(120, 50), false);
  // Out of range → clamped (cols 60..200, rows 16..80).
  assert.equal(session.resize(9999, 9999), true);
  assert.equal(session.width, 200);
  assert.equal(session.height, 80);
  assert.equal(session.resize(1, 1), true);
  assert.equal(session.width, 60);
  assert.equal(session.height, 16);
  // Non-positive is ignored.
  assert.equal(session.resize(0, 0), false);
});

test('TuiSession — resize via a naws InputEvent redraws', () => {
  const { session } = makeSession(100, 40);
  const r = session.feed([{ type: 'naws', w: 120, h: 50 }]);
  assert.equal(r.redraw, true);
  assert.equal(session.width, 120);
  assert.equal(session.height, 50);
});

test('TuiSession — v1.46.0: TAB cycles console screens (chooser removed)', () => {
  const { session, writes } = makeSession();
  assert.equal(session.isInteractive, true);
  session.draw();
  const before = writes.length;
  const r = session.feed([{ type: 'key', key: 'tab' }]);
  assert.equal(r.redraw, true);
  session.draw();
  assert.ok(writes.length > before, 'TAB should land on a different screen frame');
});

/* ── /console/ws hardening (v0.68.0): origin gate, cap, idle timeout ─────── */

/** Boot a real Fastify app with @fastify/websocket + the /console/ws route. */
async function bootConsoleApp(opts: {
  isOriginAllowed?: (o: string | undefined) => boolean;
  maxSessions?: number;
  idleTimeoutMs?: number;
  host?: string;
} = {}) {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerWsConsole({
    app,
    data: mockDataProvider(),
    log: () => {},
    isOriginAllowed: opts.isOriginAllowed,
    maxSessions: opts.maxSessions,
    idleTimeoutMs: opts.idleTimeoutMs,
  });
  await app.listen({ host: opts.host ?? '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, port, url: `ws://127.0.0.1:${port}/console/ws` };
}

/** Strip CSI escape sequences (colors, cursor, mode toggles) from a frame. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

interface ConsoleClient {
  ws: WebSocket;
  /** The first frame (past or future) whose stripped text matches; rejects once the socket has closed. */
  frame: (re: RegExp) => Promise<string>;
  /** The close code, once the socket closes. */
  closed: Promise<number>;
}

/**
 * Open a ws client on the console and collect its frames from the first byte. The
 * listener is attached BEFORE `open`: the server draws the card inside the upgrade
 * handler, so the first frame can share a read with the 101 response, and `ws`
 * emits it from a nextTick queued inside `emit('open')` — before a continuation
 * awaiting `open` could attach anything. A wait for a frame therefore looks at the
 * frames already collected, then at the ones to come; nothing sleeps.
 */
function openConsole(url: string): Promise<ConsoleClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: string[] = [];
    const waiters: Array<{ re: RegExp; ok: (t: string) => void; no: (e: Error) => void }> = [];
    let closeCode: number | null = null;
    const closed = new Promise<number>((r) => {
      ws.once('close', (code: number) => {
        closeCode = code;
        for (const w of waiters.splice(0)) w.no(new Error(`closed (${code}) before a frame matched ${w.re}`));
        r(code);
      });
    });
    ws.on('message', (raw: Buffer) => {
      const text = stripAnsi(raw.toString('utf8'));
      frames.push(text);
      for (const w of waiters.splice(0)) {
        if (w.re.test(text)) w.ok(text);
        else waiters.push(w);
      }
    });
    const frame = (re: RegExp) => new Promise<string>((ok, no) => {
      const hit = frames.find((t) => re.test(t));
      if (hit !== undefined) { ok(hit); return; }
      if (closeCode != null) { no(new Error(`closed (${closeCode}) before a frame matched ${re}`)); return; }
      waiters.push({ re, ok, no });
    });
    ws.once('open', () => resolve({ ws, frame, closed }));
    ws.once('error', reject);
  });
}

/** Open a ws client and resolve once it's OPEN (or reject on close/error). */
function openWs(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    // A handshake rejection (HTTP 403) surfaces as 'unexpected-response'/'error'.
  });
}

/** Wait for a ws to close, resolving with the close code. */
function waitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code: number) => resolve(code)));
}

test('console/ws — cross-origin upgrade is rejected (403), same/missing Origin allowed', async () => {
  const { app, url } = await bootConsoleApp({
    // Mirror the production policy shape: allow only an explicit good origin.
    isOriginAllowed: (o) => o === 'http://homeassistant.local:8787',
  });
  try {
    // 1. A present, disallowed Origin → handshake fails (no 'open').
    await assert.rejects(
      openWs(url, { Origin: 'http://evil.example.com' }),
      'cross-origin upgrade should be rejected before open',
    );
    // 2. An allowed Origin → connects.
    const good = await openWs(url, { Origin: 'http://homeassistant.local:8787' });
    assert.equal(good.readyState, WebSocket.OPEN);
    good.close();
    // 3. No Origin at all (curl / same-origin / panel_iframe) → connects.
    const none = await openWs(url);
    assert.equal(none.readyState, WebSocket.OPEN);
    none.close();
  } finally {
    await app.close();
  }
});

test('console/ws — concurrency cap: session beyond the limit is closed 1013', async () => {
  const { app, url } = await bootConsoleApp({ maxSessions: 2 });
  try {
    const a = await openWs(url);
    const b = await openWs(url);
    // The 3rd is admitted then immediately closed with 1013 (Try Again Later).
    const c = await openWs(url);
    const code = await waitClose(c);
    assert.equal(code, 1013, 'over-cap session should close with 1013');
    // The first two stay open.
    assert.equal(a.readyState, WebSocket.OPEN);
    assert.equal(b.readyState, WebSocket.OPEN);
    a.close();
    b.close();
  } finally {
    await app.close();
  }
});

test('console/ws — cap decrements on close, freeing a slot for a new session', async () => {
  const { app, url } = await bootConsoleApp({ maxSessions: 1 });
  try {
    const a = await openWs(url);
    // 2nd over the cap → closed 1013.
    const b = await openWs(url);
    assert.equal(await waitClose(b), 1013);
    // Close the live one and wait for the server to observe it.
    a.close();
    await waitClose(a);
    // Give the server's 'close' handler a tick to decrement liveSessions.
    await new Promise((r) => setTimeout(r, 50));
    // A fresh session now fits.
    const c = await openWs(url);
    assert.equal(c.readyState, WebSocket.OPEN);
    c.close();
  } finally {
    await app.close();
  }
});

test('console/ws — idle session is closed after the idle timeout; input resets it', async () => {
  // 150 ms idle window keeps the test fast.
  const { app, url } = await bootConsoleApp({ idleTimeoutMs: 150 });
  try {
    const idle = await openWs(url);
    const t0 = Date.now();
    const code = await waitClose(idle);
    assert.ok(Date.now() - t0 >= 140, 'should not close before the idle window');
    assert.ok(code === 1000 || code === 1005 || code === 1006, `unexpected idle close code ${code}`);

    // A session that keeps sending input is NOT closed within the window.
    const active = await openWs(url);
    let closed = false;
    active.once('close', () => { closed = true; });
    const beat = setInterval(() => active.send('x'), 50); // input every 50 ms < 150 ms
    await new Promise((r) => setTimeout(r, 400)); // >2 idle windows
    clearInterval(beat);
    assert.equal(closed, false, 'active session must survive past the idle window');
    active.close();
  } finally {
    await app.close();
  }
});

test('console/ws — exported guard-rail constants are sane', () => {
  assert.ok(MAX_WS_SESSIONS >= 1 && MAX_WS_SESSIONS <= 256);
  assert.ok(WS_IDLE_TIMEOUT_MS >= 60_000, 'idle window should be at least a minute in prod');
});


/* ── v1.47.2 — variable-length CSI: no printable tail may leak ──────────── */

test('parseXtermData — v1.47.2: Delete (ESC[3~) emits nothing printable', () => {
  const ev = parseXtermData('\x1b[3~');
  assert.equal(ev.filter((e) => e.type === 'key' && e.key.length === 1).length, 0, `leaked: ${JSON.stringify(ev)}`);
});

test('parseXtermData — v1.47.2: Ctrl-Right (ESC[1;5C) is right, with no ;5C tail', () => {
  const ev = parseXtermData('\x1b[1;5C');
  assert.deepEqual(ev, [{ type: 'key', key: 'right' }]);
});

test('parseXtermData — v1.47.2: F5 (ESC[15~) emits no screen-hotkey digits', () => {
  const ev = parseXtermData('\x1b[15~');
  assert.equal(ev.some((e) => e.type === 'key' && /^[0-9]$/.test((e as any).key)), false, `leaked digits: ${JSON.stringify(ev)}`);
});

test('console/ws — the login card counts failures by the socket\'s address: ten from one address refuse that address, another address logs in', async () => {
  const savedUser = process.env.TUI_USERNAME;
  const savedPass = process.env.TUI_PASSWORD;
  process.env.TUI_USERNAME = 'operator';
  process.env.TUI_PASSWORD = 'hunter2';
  _resetAuthThrottleForTest();
  // A dual-stack listener, the add-on's default `::`: the failing sessions arrive over
  // IPv4 (seen as ::ffff:127.0.0.1), the operator's over IPv6 (::1).
  const { app, port } = await bootConsoleApp({ host: '::' });
  const v4 = `ws://127.0.0.1:${port}/console/ws`;
  const v6 = `ws://[::1]:${port}/console/ws`;
  try {
    // Ten failures, one per session (each session's card has three attempts; one is spent here).
    for (let i = 0; i < 10; i++) {
      const c = await openConsole(v4);
      await c.frame(/USERNAME/);
      c.ws.send('x\r');
      c.ws.send('y\r');
      const denied = await c.frame(/ACCESS DENIED/);
      assert.match(denied, /2 attempt\(s\) remaining/);
      c.ws.close();
      await c.closed;
    }
    assert.equal(consoleLoginThrottled('127.0.0.1'), true, 'the IPv4 address is saturated (the mapped form shares its window)');
    assert.equal(consoleLoginThrottled('::1'), false, 'the IPv6 address is not');
    // The right credentials from the saturated address: the card refuses the submit and the socket is closed.
    const same = await openConsole(v4);
    await same.frame(/USERNAME/);
    same.ws.send('operator\r');
    same.ws.send('hunter2\r');
    const code = await same.closed;
    assert.ok(code >= 1000, `closed (${code})`);
    assert.equal(consoleLoginThrottled('127.0.0.1'), true, 'a refused submit is not a counted failure, and nothing cleared the address');
    // The same credentials from another address open the console.
    const other = await openConsole(v6);
    await other.frame(/USERNAME/);
    other.ws.send('operator\r');
    other.ws.send('hunter2\r');
    const console_ = await other.frame(/CONSOLE/);
    assert.ok(!console_.includes('USERNAME'), 'the console, not the card');
    assert.equal(consoleLoginThrottled('127.0.0.1'), true, 'the other address\'s login clears only its own address');
    other.ws.close();
    await other.closed;
  } finally {
    await app.close();
    if (savedUser === undefined) delete process.env.TUI_USERNAME; else process.env.TUI_USERNAME = savedUser;
    if (savedPass === undefined) delete process.env.TUI_PASSWORD; else process.env.TUI_PASSWORD = savedPass;
    _resetAuthThrottleForTest();
  }
});
