/**
 * Tests for the browser web-terminal transport (/console).
 *
 *   1. parseXtermData — the char-mode (NO telnet IAC) keyboard parser maps
 *      ESC arrows, CR/LF→enter, Ctrl-C, TAB and printable ASCII to the same
 *      transport-agnostic InputEvents the telnet parser produces.
 *   2. TuiSession — the extracted session driver renders frames to its write
 *      sink, applies key navigation, honors resize, suppresses byte-identical
 *      frames (anti-flicker), and reports quit on ctrl-c / q.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { parseXtermData, registerWsConsole, MAX_WS_SESSIONS, WS_IDLE_TIMEOUT_MS } from '../src/telnet/wsConsole.js';
import { TuiSession, _resetAuthThrottleForTest } from '../src/telnet/session.js';
import type { TuiDataProvider } from '../src/telnet/session.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import type { Recorder } from '../src/recorder.js';

/* ── fixtures ──────────────────────────────────────────────────────────── */

function mockRecorder(): Recorder {
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn, metrics) => {
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

test('TuiSession — auth: cross-session throttle refuses submits after 10 window failures', () => {
  _resetAuthThrottleForTest();
  const fail = () => {
    const { session } = makeSession(100, 40, { username: 'op', password: 'pw' });
    return session.feed([
      { type: 'key', key: 'x' }, { type: 'key', key: 'enter' },
      { type: 'key', key: 'y' }, { type: 'key', key: 'enter' },
    ]);
  };
  // 10 failures across 10 fresh sessions saturate the sliding window …
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
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, url: `ws://127.0.0.1:${port}/console/ws` };
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
