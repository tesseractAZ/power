/**
 * The SSH control-room TUI transport (telnet until 1.189.x), driven by a REAL
 * ssh2 client against `startSshServer` on an ephemeral port:
 *
 *   1. The console credentials log in; the alt screen opens and a console frame
 *      is drawn with the signed-in user in the OPR seat, never the login card;
 *      a window change redraws at the new width; no log line carries the
 *      username or the password.
 *   2. A wrong password is refused; the third failure on one connection ends it,
 *      and a fresh connection with the right password still logs in.
 *   3. Ten failures from one address (over IPv4 on a dual-stack listener) refuse
 *      that address outright, the right password included, while another address
 *      (IPv6 loopback) logs in: one address's failures bind that address alone.
 *      A login that succeeds clears its address: nine failures, a login, nine
 *      more, and the address is still admitted.
 *   4. With no console password every login is refused, and the log says why
 *      exactly once per connection.
 *   5. exec and the sftp subsystem are refused: the port serves the TUI only.
 *   6. `q` in the console ends the connection and restores the primary screen.
 *   7. The host key is generated once, kept 0600, reused across restarts, and a
 *      file that does not parse is replaced with a warning.
 *   8. `parseInput` has no telnet IAC handling; a chunk-final CR still swallows
 *      the LF of the next chunk. `describeSshAuth` states the refusal.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { startSshServer, loadOrCreateHostKey, hostKeyFingerprint, parseInput } from '../src/telnet/server.js';
import { _resetAuthThrottleForTest, describeSshAuth } from '../src/telnet/session.js';
import type { TuiDataProvider } from '../src/telnet/session.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import type { Recorder } from '../src/recorder.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

/* ── fixtures (mirrors sshCaps.test.ts / wsConsole.test.ts) ────────────── */

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

/** One host key for the whole file: generating an ed25519 pair is cheap, but once is enough. */
const KEY = ssh2.utils.generateKeyPairSync('ed25519').private;

async function boot(opts: { host?: string } = {}) {
  const lines: string[] = [];
  const t = startSshServer({
    store: {} as never,
    recorder: mockRecorder(),
    host: opts.host ?? '127.0.0.1',
    port: 0,
    hostKey: KEY,
    log: (m) => { lines.push(m); },
    warn: (m) => { lines.push(`WARN ${m}`); },
    data: mockData(),
  });
  await once(t.server, 'listening');
  const addr = t.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { t, port, lines };
}

/** Strip CSI escape sequences (colors, cursor, mode toggles) from a frame. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

interface LoginResult {
  ok: boolean;
  err?: string;
  out: string;
  execOk?: boolean;
  sftpOk?: boolean;
  resizeOut?: string;
  streamClosed?: boolean;
}

/**
 * Connect with a real ssh2 client; resolve with what happened (never throw).
 * `passwords` are tried in order on ONE connection (the client's auth-method list).
 */
function login(port: number, passwords: string[], opts: { shell?: boolean; exec?: string; sftp?: boolean; sendAfter?: string; username?: string; noneOnly?: boolean; host?: string } = {}): Promise<LoginResult> {
  return new Promise((done) => {
    const c = new ssh2.Client();
    let out = '';
    let over = false;
    let streamClosed = false;
    const fin = (r: Omit<LoginResult, 'out'>) => { if (over) return; over = true; try { c.end(); } catch { /* ignore */ } done({ out, ...r }); };
    c.on('error', (e) => fin({ ok: false, err: e.message }));
    c.on('ready', () => {
      if (opts.exec) { c.exec(opts.exec, (e) => fin({ ok: true, execOk: !e })); return; }
      if (opts.sftp) { c.sftp((e) => fin({ ok: true, sftpOk: !e })); return; }
      if (!opts.shell) { fin({ ok: true }); return; }
      c.shell({ cols: 100, rows: 30, term: 'xterm-256color' }, (e, stream) => {
        if (e) { fin({ ok: true, err: e.message }); return; }
        stream.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        stream.on('close', () => { streamClosed = true; if (opts.sendAfter) fin({ ok: true, streamClosed }); });
        setTimeout(() => {
          if (opts.sendAfter) { stream.write(opts.sendAfter); setTimeout(() => fin({ ok: true, streamClosed }), 1500); return; }
          const before = out.length;
          stream.setWindow(40, 140, 0, 0);
          setTimeout(() => fin({ ok: true, resizeOut: out.slice(before), streamClosed }), 600);
        }, 600);
      });
    });
    c.connect({
      host: opts.host ?? '127.0.0.1',
      port,
      username: opts.username ?? 'operator',
      authHandler: opts.noneOnly
        ? [{ type: 'none' as const, username: opts.username ?? 'operator' }]
        : passwords.map((password) => ({ type: 'password' as const, username: opts.username ?? 'operator', password })),
      readyTimeout: 4000,
    });
    setTimeout(() => fin({ ok: false, err: 'timeout' }), 8000);
  });
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

test('ssh — the console credentials log in; a console frame is drawn (no login card); a window change redraws wider', async () => {
  const { t, port, lines } = await boot();
  try {
    const r = await login(port, [CREDS.password], { shell: true });
    assert.equal(r.ok, true, r.err);
    assert.match(r.out, /\x1b\[\?1049h/, 'the alternate screen opens');
    const text = stripAnsi(r.out);
    assert.ok(text.includes('CONSOLE'), 'a console frame is drawn');
    assert.ok(!text.includes('USERNAME'), 'the in-session login card is never drawn over SSH');
    assert.ok(!text.includes('ACCESS DENIED'));
    // The OPR seat names the signed-in user, as the login card's path does.
    assert.match(text, /OPR operator@local/);
    // Frames end with a full-width footer rule: 100 columns before the window
    // change, 140 after it (login/80-col frames never produce either).
    const before = stripAnsi(r.out.slice(0, r.out.length - (r.resizeOut ?? '').length));
    assert.match(before, /─{100}/, 'drawn at the 100 columns the pty asked for');
    assert.doesNotMatch(before, /─{140}/);
    assert.match(stripAnsi(r.resizeOut ?? ''), /─{140}/, 'a window change to 140 columns redraws wider');
    assert.ok(lines.some((l) => /^ssh: client connected from 127\.0\.0\.1 \(1 active\)$/.test(l)), lines.join(' | '));
    assert.ok(lines.some((l) => /^ssh: login from 127\.0\.0\.1 \(1 active\)$/.test(l)), lines.join(' | '));
    assert.ok(!lines.some((l) => /operator|hunter2/.test(l)), 'never the username or password in the log');
  } finally { t.stop(); }
});

test('ssh — a wrong password is refused; the third failure ends the connection; a new connection with the right password logs in', async () => {
  const { t, port, lines } = await boot();
  try {
    const one = await login(port, ['wrong-1']);
    assert.equal(one.ok, false);
    assert.ok(lines.some((l) => l === 'ssh: failed login from 127.0.0.1 (1 of 3)'), lines.join(' | '));

    // Three wrong passwords on ONE connection, then the right one as the fourth
    // attempt: the server ends the connection after the third, so the fourth
    // never logs in.
    const three = await login(port, ['wrong-1', 'wrong-2', 'wrong-3', CREDS.password]);
    assert.equal(three.ok, false, 'the connection is ended after the third failure');
    assert.ok(lines.some((l) => l === 'ssh: failed login from 127.0.0.1 (3 of 3)'), lines.join(' | '));
    assert.ok(!lines.some((l) => /^ssh: login from/.test(l)), 'no login succeeded');
    assert.ok(lines.some((l) => /^ssh: client 127\.0\.0\.1 disconnected after \d+s \(\d+ active\)$/.test(l)), 'the teardown line');

    // The budget is per connection (the cross-session throttle is at 10).
    const fresh = await login(port, [CREDS.password]);
    assert.equal(fresh.ok, true, fresh.err);
    // The right password under the wrong username is refused too, and the username is not logged.
    const intruder = await login(port, [CREDS.password], { username: 'intruder' });
    assert.equal(intruder.ok, false, 'both fields must match');
    assert.ok(!lines.some((l) => /wrong-|hunter2|operator|intruder/.test(l)), 'never a credential in the log');
  } finally { t.stop(); }
});

test('ssh — the none method is refused while a password is set: a client without a password never logs in', async () => {
  const { t, port, lines } = await boot();
  try {
    const r = await login(port, [], { noneOnly: true });
    assert.equal(r.ok, false);
    assert.ok(!lines.some((l) => /^ssh: login from 127\.0\.0\.1 \(/.test(l)), 'nothing was admitted');
    assert.ok(!lines.some((l) => /failed login/.test(l)), 'the none probe is not a failed attempt: the client is told to try a password');
  } finally { t.stop(); }
});

test('ssh — ten failures from one address refuse that address, the right password included; another address still logs in', async () => {
  // A dual-stack listener, the add-on's default `::`: the failing client connects over
  // IPv4 (seen as ::ffff:127.0.0.1), the operator over IPv6 (::1) — two addresses, one host.
  const { t, port, lines } = await boot({ host: '::' });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await login(port, ['bad-a', 'bad-b']); // 2 failures per connection
      assert.equal(r.ok, false);
    }
    assert.equal(lines.filter((l) => /^ssh: failed login from ::ffff:127\.0\.0\.1 \(/.test(l)).length, 10, lines.join(' | '));
    const same = await login(port, [CREDS.password]);
    assert.equal(same.ok, false, 'the address is refused even with the right password');
    assert.ok(lines.some((l) => l === 'ssh: login from ::ffff:127.0.0.1 refused — too many failed logins from this address; try again in a few minutes'), lines.join(' | '));
    // The operator at another address is not affected by that address's failures.
    const other = await login(port, [CREDS.password], { host: '::1' });
    assert.equal(other.ok, true, other.err);
    assert.ok(lines.some((l) => /^ssh: login from ::1 \(1 active\)$/.test(l)), lines.join(' | '));
    assert.ok(!lines.some((l) => /^ssh: login from ::ffff:127\.0\.0\.1 \(/.test(l)), 'nothing from the failing address was admitted');
    // The operator's login clears the operator's address only: the failing address stays refused.
    const still = await login(port, [CREDS.password]);
    assert.equal(still.ok, false, 'still refused');
    assert.equal(lines.filter((l) => /refused — too many failed logins from this address/.test(l)).length, 2);
    assert.ok(!lines.some((l) => /bad-|hunter2|operator/.test(l)), 'never a credential in the log');
  } finally { t.stop(); }
});

test('ssh — a login that succeeds clears its address: nine failures, a login, nine more, and the address is still admitted', async () => {
  const { t, port, lines } = await boot();
  try {
    const nine = async () => {
      for (let i = 0; i < 3; i++) assert.equal((await login(port, ['bad-1', 'bad-2', 'bad-3'])).ok, false); // 3 failures per connection
    };
    await nine();
    const first = await login(port, [CREDS.password]);
    assert.equal(first.ok, true, first.err);
    // Without the clear these are the address's 10th to 18th failures, saturated at the 10th.
    await nine();
    const second = await login(port, [CREDS.password]);
    assert.equal(second.ok, true, second.err);
    assert.ok(!lines.some((l) => /too many failed logins/.test(l)), lines.join(' | '));
    assert.equal(lines.filter((l) => /^ssh: login from 127\.0\.0\.1 \(1 active\)$/.test(l)).length, 2, 'both logins admitted');
    assert.equal(lines.filter((l) => /^ssh: failed login from 127\.0\.0\.1 \(/.test(l)).length, 18, 'every failure was counted');
  } finally { t.stop(); }
});

test('ssh — with no console password every login is refused, and the log says why once per connection', async () => {
  delete process.env.TUI_PASSWORD;
  const { t, port, lines } = await boot();
  try {
    const r = await login(port, ['anything', 'else']);
    assert.equal(r.ok, false);
    const warns = lines.filter((l) => /^WARN ssh: login from 127\.0\.0\.1 refused — no console password is set \(TUI_PASSWORD\)/.test(l));
    assert.equal(warns.length, 1, lines.join(' | '));
    assert.ok(!lines.some((l) => /^ssh: login from 127\.0\.0\.1 \(/.test(l)), 'nothing was admitted');
    // A second connection gets its own line.
    await login(port, ['anything']);
    assert.equal(lines.filter((l) => /^WARN ssh: login from .* refused — no console password/.test(l)).length, 2);
  } finally { t.stop(); }
});

test('ssh — exec and the sftp subsystem are refused: the port serves the TUI and nothing else', async () => {
  const { t, port } = await boot();
  try {
    const ex = await login(port, [CREDS.password], { exec: 'cat /data/options.json' });
    assert.equal(ex.ok, true, ex.err);
    assert.equal(ex.execOk, false, 'exec refused');
    const sf = await login(port, [CREDS.password], { sftp: true });
    assert.equal(sf.ok, true, sf.err);
    assert.equal(sf.sftpOk, false, 'sftp refused');
  } finally { t.stop(); }
});

test('ssh — q in the console ends the connection and restores the primary screen buffer', async () => {
  const { t, port, lines } = await boot();
  try {
    const r = await login(port, [CREDS.password], { shell: true, sendAfter: 'q' });
    assert.equal(r.ok, true, r.err);
    assert.equal(r.streamClosed, true, 'the server closed the channel after q');
    assert.ok(r.out.includes('\x1b[?1049l'), 'server-side close exits the alt buffer');
    assert.ok(lines.some((l) => /^ssh: client 127\.0\.0\.1 disconnected after \d+s \(0 active\)$/.test(l)), lines.join(' | '));
  } finally { t.stop(); }
});

test('ssh — the host key is generated once, kept 0600, reused, and a broken one is replaced with a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'power-hostkey-'));
  const path = join(dir, 'ssh_host_ed25519_key');
  const lines: string[] = [];
  const log = (m: string) => { lines.push(m); };
  const warn = (m: string) => { lines.push(`WARN ${m}`); };
  try {
    const a = loadOrCreateHostKey(path, log, warn);
    assert.match(a.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(lines.some((l) => l === `ssh: generated a new host key (${a.fingerprint})`));
    const b = loadOrCreateHostKey(path, log, warn);
    assert.equal(b.fingerprint, a.fingerprint, 'kept across restarts');
    assert.equal(hostKeyFingerprint(b.key), a.fingerprint);
    assert.equal(lines.filter((l) => /generated a new host key/.test(l)).length, 1, 'generated once');
    writeFileSync(path, 'not a key');
    const c = loadOrCreateHostKey(path, log, warn);
    assert.notEqual(c.fingerprint, a.fingerprint);
    assert.ok(lines.some((l) => /^WARN ssh: the host key at .* could not be read/.test(l)));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ssh — parseInput decodes keys with no telnet IAC handling, and a chunk-final CR swallows the next chunk\'s LF', () => {
  const { events, rest } = parseInput(Buffer.from([0x71, 0x1b, 0x5b, 0x41, 0x0d, 0xff, 0x09, 0x7f]));
  assert.deepEqual(events, [
    { type: 'key', key: 'q' }, { type: 'key', key: 'up' }, { type: 'key', key: 'enter' },
    { type: 'key', key: 'tab' }, { type: 'key', key: 'backspace' },
  ]);
  assert.equal(rest.length, 0);
  // 0xFF 0xFD 0x01 was IAC DO ECHO; it is three skipped bytes now, not a command.
  assert.deepEqual(parseInput(Buffer.from([0xff, 0xfd, 0x01, 0x32])).events, [{ type: 'key', key: '2' }]);
  const first = parseInput(Buffer.from('a\r'));
  assert.equal(first.swallowAfterCr, true);
  assert.deepEqual(first.events, [{ type: 'key', key: 'a' }, { type: 'key', key: 'enter' }]);
  const second = parseInput(Buffer.from('\nb'), first.swallowAfterCr);
  assert.deepEqual(second.events, [{ type: 'key', key: 'b' }], 'the LF of a split CRLF is not a second enter');
  // An incomplete escape sequence waits for the rest.
  const partial = parseInput(Buffer.from([0x1b, 0x5b]));
  assert.deepEqual(partial.events, []);
  assert.equal(partial.rest.length, 2);
});

test('ssh — describeSshAuth states the refusal when no console password is set', () => {
  assert.equal(describeSshAuth({ username: 'operator', password: 'x' }), '(password login as the console user)');
  assert.equal(describeSshAuth(null), '(every login refused — set TUI_PASSWORD)');
});
