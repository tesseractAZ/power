/**
 * v1.7.0 (security #1, CWE-400) — the LAN console's DoS guards, on the SSH
 * transport (telnet until 1.189.x). TCP is still ours: a plain `net` server
 * applies the caps and the reclaim before ssh2 sees a socket, so these run
 * against a REAL server on an ephemeral port with raw TCP clients. An admitted
 * socket receives the `SSH-2.0-power-tui` version line as its first bytes; a
 * refused one receives a banner and is closed (and destroyed on our schedule).
 *
 *   1. Concurrency cap — beyond the cap: banner + close, no render session.
 *   2. The slot is freed when a live connection closes.
 *   3. Per-address cap — a single host cannot take every slot.
 *   4. Idle reap — nothing RECEIVED for the idle window closes the connection;
 *      inbound bytes keep it alive.
 *   5. Login grace — a connection that keeps sending bytes but never logs in is
 *      ended after the grace.
 *   6. TCP keep-alive is set on every admitted socket; accept and teardown are
 *      logged; a refused socket is destroyed after the linger when the peer
 *      never closes.
 *
 * The caps and windows are overridable via opts (production uses the module
 * constants) so the test runs with tiny values instead of opening 16 sockets
 * or waiting 5 minutes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import {
  startSshServer, refuseSocket,
  MAX_SSH_CONNS, MAX_SSH_CONNS_PER_IP, SSH_IDLE_TIMEOUT_MS, SSH_KEEPALIVE_MS, SSH_AUTH_GRACE_MS, REFUSE_LINGER_MS,
} from '../src/console/server.js';
import type { TuiDataProvider } from '../src/console/session.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import type { Recorder } from '../src/recorder.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import ssh2 from 'ssh2';

/* ── fixtures ──────────────────────────────────────────────────────────── */

function mockRecorder(): Recorder {
  return makeRecorderStub();
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

const KEY = ssh2.utils.generateKeyPairSync('ed25519').private;

async function boot(opts: { maxConns?: number; maxConnsPerIp?: number; idleTimeoutMs?: number; keepAliveMs?: number; authGraceMs?: number } = {}) {
  const lines: string[] = [];
  const t = startSshServer({
    store: {} as never,
    recorder: mockRecorder(),
    host: '127.0.0.1',
    port: 0,
    hostKey: KEY,
    log: (m) => { lines.push(m); },
    data: mockData(),
    maxConns: opts.maxConns,
    maxConnsPerIp: opts.maxConnsPerIp,
    idleTimeoutMs: opts.idleTimeoutMs,
    keepAliveMs: opts.keepAliveMs,
    // The grace must not fire inside a test about something else.
    authGraceMs: opts.authGraceMs ?? 60_000,
  });
  await once(t.server, 'listening');
  const addr = t.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { t, port, lines };
}

/** Open a raw TCP client; collect all bytes; expose first-data + close promises. */
function connectRaw(port: number) {
  const sock = net.connect({ host: '127.0.0.1', port });
  const chunks: Buffer[] = [];
  sock.on('data', (d) => chunks.push(d));
  sock.on('error', () => {}); // ignore ECONNRESET on server-side close
  const gotData = once(sock, 'data');
  const closed = once(sock, 'close');
  const text = () => Buffer.concat(chunks).toString('utf8');
  return { sock, chunks, gotData, closed, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BANNER = 'SSH-2.0-power-tui';

/** Resolve when the socket closes; FAIL after `ms` instead of hanging (a guard that never fires must fail the test). */
function closedWithin(c: ReturnType<typeof connectRaw>, ms: number, what: string): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new assert.AssertionError({ message: `${what}: the server did not close the socket within ${ms} ms` })), ms);
    c.closed.then(() => { clearTimeout(timer); done(); }, (e) => { clearTimeout(timer); fail(e); });
  });
}

/* ── tests ─────────────────────────────────────────────────────────────── */

test('ssh — exported guard-rail constants are sane', () => {
  assert.ok(MAX_SSH_CONNS >= 1 && MAX_SSH_CONNS <= 256);
  assert.ok(MAX_SSH_CONNS_PER_IP >= 1 && MAX_SSH_CONNS_PER_IP < MAX_SSH_CONNS);
  assert.ok(SSH_IDLE_TIMEOUT_MS >= 60_000, 'idle window should be at least a minute in prod');
  assert.ok(SSH_KEEPALIVE_MS >= 10_000 && SSH_KEEPALIVE_MS <= SSH_IDLE_TIMEOUT_MS);
  assert.ok(SSH_AUTH_GRACE_MS >= 30_000 && SSH_AUTH_GRACE_MS <= SSH_IDLE_TIMEOUT_MS, 'a login gets a bounded, shorter window than a session');
  assert.ok(REFUSE_LINGER_MS >= 100 && REFUSE_LINGER_MS <= 10_000);
});

test('ssh — connection cap closes sessions beyond the limit with a banner; admitted ones get the SSH version line', async () => {
  const { t, port, lines } = await boot({ maxConns: 2 });
  try {
    const a = connectRaw(port);
    await a.gotData;
    const b = connectRaw(port);
    await b.gotData;
    assert.ok(a.text().startsWith(BANNER), `admitted sockets receive the version line first: ${JSON.stringify(a.text().slice(0, 30))}`);
    assert.ok(b.text().startsWith(BANNER));
    // The 3rd is over the cap: banner + immediate close, no render session.
    const c = connectRaw(port);
    await closedWithin(c, 3000, 'over the cap');
    assert.match(c.text(), /Too many active connections \(max 2\)/);
    assert.ok(!c.text().includes(BANNER), 'a refused socket never reaches ssh2');
    assert.ok(lines.some((l) => l === 'ssh: connection cap (2) reached — refusing 127.0.0.1'), lines.join(' | '));
    // The first two stay open.
    assert.equal(a.sock.destroyed, false);
    assert.equal(b.sock.destroyed, false);
    a.sock.destroy();
    b.sock.destroy();
  } finally {
    t.stop();
  }
});

test('ssh — cap frees a slot when a live connection closes', async () => {
  const { t, port } = await boot({ maxConns: 1 });
  try {
    const a = connectRaw(port);
    await a.gotData;
    const b = connectRaw(port);
    await closedWithin(b, 3000, 'over the cap');
    assert.match(b.text(), /Too many active connections/);
    a.sock.destroy();
    await a.closed;
    await sleep(50);
    const c = connectRaw(port);
    await c.gotData;
    assert.ok(c.text().startsWith(BANNER));
    assert.equal(c.sock.destroyed, false);
    c.sock.destroy();
  } finally {
    t.stop();
  }
});

test('ssh — per-address cap: a single host cannot take every slot', async () => {
  const { t, port, lines } = await boot({ maxConns: 10, maxConnsPerIp: 2 });
  const admitted: ReturnType<typeof connectRaw>[] = [];
  try {
    let accepted = 0;
    for (let i = 0; i < 2; i++) {
      const s = connectRaw(port);
      await s.gotData;
      if (s.text().startsWith(BANNER)) accepted += 1;
      admitted.push(s);
    }
    // "Absence is not success": the refusal below only means something if the
    // first two really were admitted.
    assert.equal(accepted, 2, 'two connections from one address are admitted');
    const third = connectRaw(port);
    await closedWithin(third, 3000, 'over the per-address cap');
    assert.match(third.text(), /Too many active connections from this address \(max 2\)/);
    assert.ok(!third.text().includes(BANNER));
    assert.ok(lines.some((l) => l === 'ssh: per-IP cap (2) reached — refusing 127.0.0.1'), lines.join(' | '));
    for (const s of admitted) assert.equal(s.sock.destroyed, false, 'the admitted sockets stay open');
  } finally {
    for (const s of admitted) s.sock.destroy();
    t.stop();
  }
});

test('ssh — idle connection is reaped after the idle window; inbound bytes reset it', async () => {
  const { t, port, lines } = await boot({ idleTimeoutMs: 150 });
  try {
    const idle = connectRaw(port);
    await idle.gotData;
    const t0 = Date.now();
    await closedWithin(idle, 3000, 'idle reap');
    assert.ok(Date.now() - t0 >= 140, 'idle socket closed before the idle window elapsed');
    assert.ok(lines.some((l) => l === 'ssh: idle 150 ms with no inbound data — closing 127.0.0.1'), lines.join(' | '));
  } finally {
    t.stop();
  }

  // A connection that keeps sending bytes survives well past the window.
  // (ssh2 buffers them as an unfinished identification line; nothing is parsed.)
  // v1.191.4 — on its own server with a 500 ms window: against 150 ms, a 50 ms
  // heartbeat delayed ~100 ms by a loaded runner (the full suite in parallel, the
  // ssh-console harness at concurrency 4) was reaped legitimately and failed here.
  // A reset that never happens still reaps at 500 ms, inside the 1.1 s watched.
  const live = await boot({ idleTimeoutMs: 500 });
  try {
    const active = connectRaw(live.port);
    await active.gotData;
    let closed = false;
    active.sock.on('close', () => { closed = true; });
    const beat = setInterval(() => { if (!active.sock.destroyed) active.sock.write('x'); }, 50);
    await sleep(1100); // > 2 idle windows
    clearInterval(beat);
    assert.equal(closed, false, 'a connection receiving input must survive past the idle window');
    active.sock.destroy();
  } finally {
    live.t.stop();
  }
});

test('ssh — a connection that never logs in is ended after the login grace, keep-alives or not', async () => {
  const { t, port, lines } = await boot({ idleTimeoutMs: 60_000, authGraceMs: 200 });
  try {
    const s = connectRaw(port);
    await s.gotData;
    // Bytes keep the IDLE clock fresh; they must not extend the login grace.
    const beat = setInterval(() => { if (!s.sock.destroyed) s.sock.write('x'); }, 40);
    const t0 = Date.now();
    try { await closedWithin(s, 3000, 'login grace'); } finally { clearInterval(beat); }
    const took = Date.now() - t0;
    assert.ok(took >= 180 && took < 2000, `closed after ${took} ms`);
    assert.ok(lines.some((l) => l === 'ssh: no login within 200 ms — closing 127.0.0.1'), lines.join(' | '));
  } finally {
    t.stop();
  }
});

test('ssh — keep-alive is set on every admitted socket; accept and teardown are logged', async () => {
  const calls: Array<[boolean | undefined, number | undefined]> = [];
  const orig = net.Socket.prototype.setKeepAlive;
  net.Socket.prototype.setKeepAlive = function (this: net.Socket, enable?: boolean, delay?: number) {
    calls.push([enable, delay]);
    return orig.call(this, enable, delay);
  } as typeof orig;
  const { t, port, lines } = await boot({ keepAliveMs: 1234 });
  try {
    const a = connectRaw(port);
    await a.gotData;
    assert.ok(calls.some(([on, ms]) => on === true && ms === 1234), `setKeepAlive(true, 1234) on the admitted socket: ${JSON.stringify(calls)}`);
    assert.ok(lines.some((l) => l === 'ssh: client connected from 127.0.0.1 (1 active)'), lines.join(' | '));
    a.sock.destroy();
    await a.closed;
    await sleep(50);
    assert.ok(lines.some((l) => /^ssh: client 127\.0\.0\.1 disconnected after \d+s \(0 active\)$/.test(l)), lines.join(' | '));
  } finally {
    net.Socket.prototype.setKeepAlive = orig;
    t.stop();
  }
});

test('ssh — refuseSocket ends the socket and destroys it after the linger unless the peer closes first', async () => {
  const ended: string[] = [];
  let destroyed = 0;
  const closeHandlers: Array<() => void> = [];
  const fake = {
    end: (msg?: string) => { ended.push(msg ?? ''); },
    destroy: () => { destroyed += 1; },
    once: (ev: string, fn: () => void) => { if (ev === 'close') closeHandlers.push(fn); },
  };
  refuseSocket(fake as never, 'bye', 40);
  assert.deepEqual(ended, ['bye']);
  await sleep(80);
  assert.equal(destroyed, 1, 'a peer that never closes is destroyed after the linger');

  destroyed = 0;
  refuseSocket(fake as never, '', 40);
  closeHandlers.at(-1)?.(); // the peer closed in time
  await sleep(80);
  assert.equal(destroyed, 0, 'no destroy once the peer has closed');
});
