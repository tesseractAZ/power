import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import Fastify from 'fastify';

/**
 * v0.9.60 — Write-auth middleware tests.
 *
 * Strategy: Fastify `inject()` against a minimal app that wires up the
 * REAL `requireWriteAuth` preHandler returned by `createAuth(...)`. The
 * helpers are extracted into src/auth.ts (see v0.9.60 refactor note in
 * that file), so we test the same code path that index.ts registers.
 *
 * Each test starts from a fresh tmp dir + fresh `createAuth()` call so
 * that token persistence across calls is observable and tests don't
 * leak state into one another.
 */

const tmpRoot = mkdtempSync(resolve(tmpdir(), 'panel-auth-test-'));

// Clear envs that could leak from the user's shell into createAuth's
// token resolution — we want deterministic behavior per test.
delete process.env.PANEL_WRITE_TOKEN;
delete process.env.DATA_DIR;

const { createAuth, tokenEquals, isAllowedOrigin, buildSameOrigins, LAN_ORIGIN_RE, isSupervisorSource } =
  await import('../src/auth.js');

/** Build a Fastify instance with the supplied auth wired in as a
 *  preHandler on a single test endpoint. Returns the app — caller is
 *  responsible for `await app.close()`. */
function buildApp(authObj: Awaited<ReturnType<typeof createAuth>>) {
  const app = Fastify({ logger: false });
  app.post(
    '/test/write',
    { preHandler: authObj.requireWriteAuth },
    async () => ({ ok: true }),
  );
  return app;
}

/** Per-test factory — fresh tmp subdir, fresh token, fresh app. */
function freshAuth(label: string, opts: { envToken?: string } = {}) {
  const dataDir = join(tmpRoot, label);
  if (opts.envToken) process.env.PANEL_WRITE_TOKEN = opts.envToken;
  else delete process.env.PANEL_WRITE_TOKEN;
  return createAuth({
    host: '::',
    port: 8787,
    dataDir,
  });
}

/* ─── tokenEquals (helper) ───────────────────────────────────────────── */

test('tokenEquals — equal strings return true', () => {
  const tok = 'a-very-deliberate-token-1234567890';
  const buf = Buffer.from(tok, 'utf8');
  assert.equal(tokenEquals(tok, buf), true);
});

test('tokenEquals — unequal same-length strings return false', () => {
  const buf = Buffer.from('aaaaaaaaaaaaaaaa', 'utf8');
  assert.equal(tokenEquals('bbbbbbbbbbbbbbbb', buf), false);
});

test('tokenEquals — different lengths return false without crashing', () => {
  const buf = Buffer.from('correct-token-1234567890', 'utf8');
  // Length 1 → much shorter than expected.
  assert.equal(tokenEquals('a', buf), false);
  // Length 100 → much longer than expected.
  assert.equal(tokenEquals('z'.repeat(100), buf), false);
  // Empty.
  assert.equal(tokenEquals('', buf), false);
});

/* ─── isAllowedOrigin / LAN regex ───────────────────────────────────── */

test('isAllowedOrigin — same-origin (host+port) is allowed', () => {
  const same = buildSameOrigins('homeassistant.local', 8787);
  assert.equal(isAllowedOrigin('http://homeassistant.local:8787', same), true);
  assert.equal(isAllowedOrigin('https://homeassistant.local:8787', same), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8787', same), true);
  assert.equal(isAllowedOrigin('http://localhost:8787', same), true);
});

test('isAllowedOrigin — known HA dashboard origins are allowed', () => {
  const same = buildSameOrigins('homeassistant.local', 8787);
  assert.equal(isAllowedOrigin('http://homeassistant.local:8123', same), true);
  assert.equal(isAllowedOrigin('https://homeassistant:8123', same), true);
});

test('isAllowedOrigin — random internet origin is rejected', () => {
  const same = buildSameOrigins('homeassistant.local', 8787);
  assert.equal(isAllowedOrigin('http://evil.example.com', same), false);
  assert.equal(isAllowedOrigin('https://attacker.io:8787', same), false);
});

test('LAN_ORIGIN_RE — matches RFC1918 hosts on 8123/8787', () => {
  assert.ok(LAN_ORIGIN_RE.test('http://192.168.1.50:8123'));
  assert.ok(LAN_ORIGIN_RE.test('http://10.0.0.4:8787'));
  assert.ok(LAN_ORIGIN_RE.test('http://172.16.5.5:8123'));
  assert.ok(LAN_ORIGIN_RE.test('https://my-pi.local:8787'));
});

test('LAN_ORIGIN_RE — v1.47.2: portless and any-port private origins match (reverse proxy / default ports)', () => {
  // A reverse-proxied HA or the companion app arrives with no explicit port.
  assert.ok(LAN_ORIGIN_RE.test('http://192.168.1.5'));
  assert.ok(LAN_ORIGIN_RE.test('https://homeassistant.local'));
  assert.ok(LAN_ORIGIN_RE.test('http://192.168.1.5:80'));
  assert.ok(LAN_ORIGIN_RE.test('https://10.0.0.4:443'));
});

test('v1.47.3 — buildSameOrigins includes IPv6 loopback', () => {
  const same = buildSameOrigins('192.168.5.152', 8787);
  assert.ok(same.has('http://[::1]:8787'));
  assert.ok(same.has('https://[::1]:8787'));
});

test('v1.47.3 — TUI_TRUSTED_ORIGINS is an EXACT-match opt-in, never a wildcard', () => {
  const prev = process.env.TUI_TRUSTED_ORIGINS;
  process.env.TUI_TRUSTED_ORIGINS = 'https://my-id.ui.nabu.casa , https://vpn.example.net';
  try {
    const auth = createAuth({ host: 'homeassistant.local', port: 8787, dataDir: join(tmpRoot, `trusted-${Date.now()}`) });
    assert.ok(isAllowedOrigin('https://my-id.ui.nabu.casa', auth.sameOrigins), 'declared origin allowed');
    assert.ok(isAllowedOrigin('https://vpn.example.net', auth.sameOrigins));
    // A DIFFERENT nabu.casa tenant is still rejected — no namespace widening.
    assert.equal(isAllowedOrigin('https://attacker.ui.nabu.casa', auth.sameOrigins), false);
  } finally {
    if (prev === undefined) delete process.env.TUI_TRUSTED_ORIGINS; else process.env.TUI_TRUSTED_ORIGINS = prev;
  }
});

test('LAN_ORIGIN_RE — v1.47.3: Nabu Casa blanket removed (CSWSH surface)', () => {
  // v1.47.2 briefly matched the whole *.ui.nabu.casa namespace, which any HA
  // Cloud tenant (incl. an attacker) owns. v1.47.3 removed it: remote /console
  // is reached via HA ingress (HA-auth-gated), or a specific origin can be
  // allow-listed with TUI_TRUSTED_ORIGINS. So no nabu.casa host matches now.
  assert.equal(LAN_ORIGIN_RE.test('https://abcdef123456.ui.nabu.casa'), false);
  assert.equal(LAN_ORIGIN_RE.test('https://attacker.ui.nabu.casa'), false);
});

test('LAN_ORIGIN_RE — rejects non-RFC1918 / non-LAN hosts', () => {
  assert.equal(LAN_ORIGIN_RE.test('http://8.8.8.8:8123'), false);
  assert.equal(LAN_ORIGIN_RE.test('http://203.0.113.1:8123'), false);
  assert.equal(LAN_ORIGIN_RE.test('https://evil.example.com'), false);
  // 172.32 is OUTSIDE the 172.16-31 RFC1918 block.
  assert.equal(LAN_ORIGIN_RE.test('http://172.32.0.1:8123'), false);
});

/* ─── requireWriteAuth via Fastify inject ───────────────────────────── */

test('requireWriteAuth — allow same-origin', async () => {
  const auth = freshAuth('case-same-origin');
  const app = buildApp(auth);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/test/write',
      headers: { origin: 'http://homeassistant.local:8787' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test('requireWriteAuth — allow HA Ingress (X-Ingress-Path from the Supervisor)', async () => {
  const auth = freshAuth('case-ingress');
  const app = buildApp(auth);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/test/write',
      // Genuine ingress: Supervisor sets the header AND the TCP peer is the
      // hassio-network Supervisor address.
      remoteAddress: '172.30.32.2',
      headers: { 'x-ingress-path': '/api/hassio_ingress/abc123def456' },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('requireWriteAuth — REJECT a forged X-Ingress-Path from a LAN client', async () => {
  // The hardening: a malicious device on the directly-published :8787 port can
  // set X-Ingress-Path, but its TCP source is its real LAN IP, not the
  // Supervisor — so the ingress bypass must NOT fire.
  const auth = freshAuth('case-ingress-forged');
  const app = buildApp(auth);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/test/write',
      remoteAddress: '192.168.6.58',
      headers: { 'x-ingress-path': '/api/hassio_ingress/abc123def456' },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

/* ─── isSupervisorSource (ingress-source pin) ───────────────────────── */

test('isSupervisorSource — Supervisor hassio-net addresses (incl. IPv6-mapped)', () => {
  assert.equal(isSupervisorSource('172.30.32.2'), true);
  assert.equal(isSupervisorSource('::ffff:172.30.32.2'), true);
  assert.equal(isSupervisorSource('172.30.33.1'), true); // /23 covers .32 and .33
  assert.equal(isSupervisorSource('::ffff:172.30.33.250'), true);
});

test('isSupervisorSource — direct-LAN / external / empty are NOT the Supervisor', () => {
  assert.equal(isSupervisorSource('192.168.6.58'), false);
  assert.equal(isSupervisorSource('::ffff:192.168.1.50'), false);
  assert.equal(isSupervisorSource('10.0.0.4'), false);
  assert.equal(isSupervisorSource('172.30.34.1'), false); // outside the /23
  assert.equal(isSupervisorSource('172.17.0.1'), false); // default docker bridge, not hassio
  assert.equal(isSupervisorSource('8.8.8.8'), false);
  assert.equal(isSupervisorSource(undefined), false);
  assert.equal(isSupervisorSource(null), false);
  assert.equal(isSupervisorSource(''), false);
});

test('requireWriteAuth — allow valid token', async () => {
  // Use a fixed env token so the test is deterministic.
  const auth = freshAuth('case-token', { envToken: 'a-fixed-deterministic-token-1234567890' });
  const app = buildApp(auth);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/test/write',
      headers: { 'x-panel-write-token': 'a-fixed-deterministic-token-1234567890' },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('requireWriteAuth — reject cross-origin without token (401)', async () => {
  const auth = freshAuth('case-cross-origin');
  const app = buildApp(auth);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/test/write',
      headers: { origin: 'http://evil.example.com' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'write-auth-required');
  } finally {
    await app.close();
  }
});

test('requireWriteAuth — reject mismatched token (401)', async () => {
  const auth = freshAuth('case-mismatch', { envToken: 'the-real-token-xxxxxxxxxxxxx' });
  const app = buildApp(auth);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/test/write',
      headers: { 'x-panel-write-token': 'wrongvalue-but-correct-length-..' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'write-auth-required');
  } finally {
    await app.close();
  }
});

test('requireWriteAuth — constant-time compare tolerates wildly mismatched lengths', async () => {
  const auth = freshAuth('case-length', { envToken: 'mid-length-token-aaaaaaaaaaa' });
  const app = buildApp(auth);
  try {
    // 1-char token: shorter than expected — must NOT crash, must return 401.
    const tiny = await app.inject({
      method: 'POST',
      url: '/test/write',
      headers: { 'x-panel-write-token': 'a' },
    });
    assert.equal(tiny.statusCode, 401);
    // 100-char token: much longer — same expectation.
    const huge = await app.inject({
      method: 'POST',
      url: '/test/write',
      headers: { 'x-panel-write-token': 'z'.repeat(100) },
    });
    assert.equal(huge.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('requireWriteAuth — no headers at all → 401 (default-deny)', async () => {
  const auth = freshAuth('case-no-headers');
  const app = buildApp(auth);
  try {
    const res = await app.inject({ method: 'POST', url: '/test/write' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'write-auth-required');
  } finally {
    await app.close();
  }
});

test('requireWriteAuth — LAN-ish origin without a matching same-origin is rejected', async () => {
  // The same-origin allow-list is constructed from host+port + localhost
  // + homeassistant.local. A request from 192.168.1.50:8123 (LAN HA
  // dashboard origin) is allowed by `isAllowedOrigin` (used by CORS) but
  // NOT by `requireWriteAuth`'s tighter same-origin check — the gate
  // intentionally requires either an explicit token or HA Ingress for
  // writes from non-self origins. This test pins that behavior.
  const auth = freshAuth('case-lan');
  const app = buildApp(auth);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/test/write',
      headers: { origin: 'http://192.168.1.50:8123' },
    });
    assert.equal(res.statusCode, 401, 'cross-origin LAN write must require token');
  } finally {
    await app.close();
  }
});

/* ─── token persistence + mode 0600 ─────────────────────────────────── */

test('token persistence — auto-generated token file is written mode 0600', () => {
  const dataDir = join(tmpRoot, 'case-persist');
  delete process.env.PANEL_WRITE_TOKEN;
  const auth = createAuth({ host: '::', port: 8787, dataDir });
  const tokenPath = auth.tokenPath;
  assert.ok(existsSync(tokenPath), `token file should exist at ${tokenPath}`);
  const onDisk = readFileSync(tokenPath, 'utf8').trim();
  assert.equal(onDisk, auth.token, 'token on disk must match returned token');
  assert.ok(onDisk.length >= 16, 'persisted token must be at least 16 chars');
  // Mode 0600 — owner read/write only. Mask with 0o777 to compare the
  // permission bits without including file-type bits.
  const mode = statSync(tokenPath).mode & 0o777;
  assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
});

test('token persistence — second createAuth call reads existing token from disk', () => {
  const dataDir = join(tmpRoot, 'case-reload');
  delete process.env.PANEL_WRITE_TOKEN;
  const first = createAuth({ host: '::', port: 8787, dataDir });
  const second = createAuth({ host: '::', port: 8787, dataDir });
  assert.equal(first.token, second.token, 'token must be stable across restarts');
});

test('token persistence — env-supplied PANEL_WRITE_TOKEN wins over disk', () => {
  const dataDir = join(tmpRoot, 'case-env-wins');
  delete process.env.PANEL_WRITE_TOKEN;
  // Seed a disk token first.
  const disk = createAuth({ host: '::', port: 8787, dataDir });
  assert.ok(existsSync(disk.tokenPath));
  // Now set env and re-create. Env wins; disk file is not consulted.
  process.env.PANEL_WRITE_TOKEN = 'env-supplied-token-must-be-16+-chars-ok';
  try {
    const fromEnv = createAuth({ host: '::', port: 8787, dataDir });
    assert.equal(fromEnv.token, 'env-supplied-token-must-be-16+-chars-ok');
    assert.notEqual(fromEnv.token, disk.token);
  } finally {
    delete process.env.PANEL_WRITE_TOKEN;
  }
});

/* ─── CORS origin callback ──────────────────────────────────────────── */

test('corsOriginCallback — no Origin header (same-origin / curl) is allowed', () => {
  const auth = freshAuth('case-cors-no-origin');
  let allowed: boolean | null = null;
  auth.corsOriginCallback(undefined, (_err, allow) => { allowed = allow; });
  assert.equal(allowed, true);
});

test('corsOriginCallback — same-origin / HA / LAN are allowed; internet is denied', () => {
  const auth = freshAuth('case-cors-allowed');
  const cases: Array<[string, boolean]> = [
    ['http://localhost:8787', true],
    ['http://homeassistant.local:8123', true],
    ['http://192.168.1.50:8123', true],
    ['http://10.10.10.10:8787', true],
    ['http://evil.example.com', false],
    ['https://attacker.io', false],
  ];
  for (const [origin, expected] of cases) {
    let got: boolean | null = null;
    auth.corsOriginCallback(origin, (_err, allow) => { got = allow; });
    assert.equal(got, expected, `origin ${origin} expected allow=${expected}, got ${got}`);
  }
});

/* ─── cleanup ──────────────────────────────────────────────────────── */

test('cleanup tmp dir', () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
