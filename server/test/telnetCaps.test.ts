/**
 * v1.7.0 (security #1, CWE-400) — telnet transport DoS guards.
 *
 * The raw telnet listener never had the WS console's v0.68.0 hardening. Two
 * guards were added and are exercised here against a REAL server bound to an
 * ephemeral port:
 *
 *   1. Concurrency cap — beyond MAX_TELNET_CONNS the server sends a short
 *      banner and closes, so a LAN flood can't spawn unbounded 1 Hz render
 *      timers that starve the single-threaded event loop (Fastify API +
 *      alerting + EcoFlow polling all share it).
 *   2. Idle reap — a session silent for the idle window is closed; any inbound
 *      byte resets the timer.
 *
 * The cap and idle window are overridable via opts (production uses the module
 * constants) so the test runs with tiny values instead of opening 16 sockets
 * or waiting 5 minutes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import {
  startTelnetServer,
  MAX_TELNET_CONNS,
  TELNET_IDLE_TIMEOUT_MS,
} from '../src/telnet/server.js';
import type { TuiDataProvider } from '../src/telnet/session.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import type { Recorder } from '../src/recorder.js';

/* ── fixtures ──────────────────────────────────────────────────────────── */

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

async function boot(opts: { maxConns?: number; idleTimeoutMs?: number } = {}) {
  const t = startTelnetServer({
    store: {} as never,
    recorder: mockRecorder(),
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    data: mockData(),
    maxConns: opts.maxConns,
    idleTimeoutMs: opts.idleTimeoutMs,
  });
  await once(t.server, 'listening');
  const addr = t.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { t, port };
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

/* ── tests ─────────────────────────────────────────────────────────────── */

test('telnet — exported guard-rail constants are sane', () => {
  assert.ok(MAX_TELNET_CONNS >= 1 && MAX_TELNET_CONNS <= 256);
  assert.ok(TELNET_IDLE_TIMEOUT_MS >= 60_000, 'idle window should be at least a minute in prod');
});

test('telnet — connection cap closes sessions beyond the limit with a banner', async () => {
  const { t, port } = await boot({ maxConns: 2 });
  try {
    // Two admitted sessions each receive IAC negotiation as their first bytes.
    const a = connectRaw(port);
    await a.gotData;
    const b = connectRaw(port);
    await b.gotData;
    // The 3rd is over the cap: banner + immediate close, no render session.
    const c = connectRaw(port);
    await c.closed;
    assert.match(c.text(), /Too many active connections \(max 2\)/);
    // The first two stay open.
    assert.equal(a.sock.destroyed, false);
    assert.equal(b.sock.destroyed, false);
    a.sock.destroy();
    b.sock.destroy();
  } finally {
    t.stop();
  }
});

test('telnet — cap frees a slot when a live connection closes', async () => {
  const { t, port } = await boot({ maxConns: 1 });
  try {
    const a = connectRaw(port);
    await a.gotData;
    // 2nd over the cap → banner + close.
    const b = connectRaw(port);
    await b.closed;
    assert.match(b.text(), /Too many active connections/);
    // Close the live one; let the server observe 'close' and decrement.
    a.sock.destroy();
    await a.closed;
    await sleep(50);
    // A fresh session now fits.
    const c = connectRaw(port);
    await c.gotData;
    assert.equal(c.sock.destroyed, false);
    c.sock.destroy();
  } finally {
    t.stop();
  }
});

test('telnet — idle session is reaped after the idle window; input resets it', async () => {
  const { t, port } = await boot({ idleTimeoutMs: 150 });
  try {
    // A silent session is closed by the server after ~150 ms.
    const idle = connectRaw(port);
    await idle.gotData;
    const t0 = Date.now();
    await idle.closed;
    assert.ok(Date.now() - t0 >= 140, 'idle socket closed before the idle window elapsed');

    // A session that keeps sending input survives well past the window.
    const active = connectRaw(port);
    await active.gotData;
    let closed = false;
    active.sock.on('close', () => { closed = true; });
    const beat = setInterval(() => { if (!active.sock.destroyed) active.sock.write('x'); }, 50);
    await sleep(400); // > 2 idle windows
    clearInterval(beat);
    assert.equal(closed, false, 'active telnet session must survive past the idle window');
    active.sock.destroy();
  } finally {
    t.stop();
  }
});
