/**
 * SSH control-room TUI server (telnet until 1.189.x).
 *
 * Each login gets the live, keyboard-driven plant-operator console rendered
 * with ANSI, over an encrypted channel. Logins are password only, against the
 * console credentials in the add-on options (`TUI_USERNAME` / `TUI_PASSWORD`,
 * `authFromEnv()`), and spend the same budgets as the browser console's login
 * card: three attempts per connection, ten failures per ten minutes from one
 * address (that address alone is refused while its window is saturated; a login
 * that succeeds clears it). With no console password set, every login is refused and the add-on
 * log says why once per connection: an SSH port that admits anyone would only
 * look safer than the telnet port it replaces. Usernames are never logged (a
 * password typed into that field would be).
 *
 * TCP stays ours: a plain `net` server applies the connection caps (global and
 * per source address), TCP keep-alive, the idle reclaim and the login grace
 * before handing each socket to ssh2 (`injectSocket`), so a refused or
 * abandoned peer is closed on our schedule, never on the peer's. The host key
 * (ed25519) is generated once and kept in /data; its fingerprint is logged at
 * every start, to compare with what a client shows on first connect.
 *
 * The per-session render/input state machine is `session.ts` (`TuiSession`,
 * shared with the browser console at /console); the session opens
 * `preAuthenticated`, so the in-band login card is never drawn here. The
 * window size comes from the SSH client (pty request, window-change) and is
 * fed to the session as a `naws` event, the name the browser console uses too.
 *
 * Gated at the call site (index.ts) by `config.ssh.enabled`: when off, this
 * server is never started and the browser console alone is served.
 */

import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import type { AuthContext, Connection, ParsedKey, ServerChannel } from 'ssh2';
import type { SnapshotStore } from '../snapshot.js';
import type { Recorder } from '../recorder.js';
import { createTuiDataProvider } from './dataProvider.js';
import type { TuiDataProvider } from './session.js';
import {
  TuiSession, authFromEnv, verifyConsoleCredentials, consoleLoginThrottled, noteConsoleLoginFailure,
  noteConsoleLoginSuccess, AUTH_MAX_ATTEMPTS,
} from './session.js';
import type { InputEvent } from './session.js';
import {
  HIDE_CURSOR, SHOW_CURSOR, CLEAR_SCREEN, RESET,
  ENTER_ALT_BUFFER, EXIT_ALT_BUFFER,
} from './ansi.js';

const { Server: SshServer, utils: sshUtils } = ssh2;

interface SshConn {
  socket: Socket;
  /** Source address, kept for the per-IP connection cap and the log lines. */
  ip: string;
  /** Epoch ms of the last byte RECEIVED on the connection (keystrokes, window
   *  changes, the client's keep-alives). Writes never count: the 1 Hz redraw
   *  must not keep an absent peer alive. */
  lastRxAt: number;
  /** Epoch ms the TCP connection was accepted (teardown line, login grace). */
  openedAt: number;
  client: Connection | null;
  /** The console credentials the login was verified against (names the OPR seat). */
  auth: { username: string; password: string } | null;
  authenticated: boolean;
  /** Failed password attempts on this connection. */
  attempts: number;
  /** The no-password refusal is logged once per connection, not per attempt. */
  gateNoted: boolean;
  stream: ServerChannel | null;
  session: TuiSession | null;
  inbuf: Buffer;
  /** A chunk-final CR emitted enter; swallow its LF/NUL next chunk. */
  swallowAfterCr: boolean;
  timer: NodeJS.Timeout | null;
  closed: boolean;
}

// v1.7.0 (security #1, CWE-400) — the LAN listener carries the WS console's
// DoS guards: without a cap + idle-reap, a LAN peer opening many idle sockets
// would each get a permanent 1 Hz render timer, starving the shared
// single-threaded Node event loop (Fastify API + alerting + MQTT + EcoFlow
// polling all run in it). Match wsConsole.ts (MAX_WS_SESSIONS / WS_IDLE_TIMEOUT_MS).
export const MAX_SSH_CONNS = 16;
/** Keeps a single host from taking every operator's slot. */
export const MAX_SSH_CONNS_PER_IP = 4;
export const SSH_IDLE_TIMEOUT_MS = 5 * 60_000;
/** TCP keep-alive probe interval: half-open peers (yanked cable, expired NAT entry) never send a FIN. */
export const SSH_KEEPALIVE_MS = 60_000;
/** A connection that has not logged in within this long is ended (OpenSSH's LoginGraceTime):
 *  otherwise a client that sends keep-alives could hold a slot at the password prompt indefinitely. */
export const SSH_AUTH_GRACE_MS = 120_000;
/** How long a refused socket may linger before it is destroyed. */
export const REFUSE_LINGER_MS = 1_000;

/**
 * Parse a raw input buffer into key events. Incomplete trailing escape
 * sequences are returned in `rest` to be prepended to the next chunk. (Until
 * 1.189.x this also stripped telnet IAC sequences and read the window size
 * from NAWS; SSH delivers the terminal's bytes as they are, and its window
 * size out of band.)
 */
export function parseInput(buf: Buffer, swallowLeadingLf = false): { events: InputEvent[]; rest: Buffer; swallowAfterCr: boolean } {
  const events: InputEvent[] = [];
  const n = buf.length;
  let i = 0;
  let swallowAfterCr = false;
  // v1.47.1 — a CR that ended the PREVIOUS chunk already emitted its enter;
  // drop the LF/NUL that belongs to it.
  if (swallowLeadingLf && i < n && (buf[i] === 10 || buf[i] === 0)) i += 1;
  while (i < n) {
    const b = buf[i];

    if (b === 0x1b) {
      // ESC — possibly a CSI/SS3 sequence.
      if (i + 1 >= n) break; // wait — could be the start of a sequence
      const b1 = buf[i + 1];
      if (b1 === 0x5b || b1 === 0x4f) {
        // v1.47.2 (second-pass) — CSI sequences are VARIABLE length: parameter
        // bytes (0x30-0x3F) and intermediates (0x20-0x2F) run until a final in
        // 0x40-0x7E. The old fixed-3-byte read leaked the tail of Delete
        // (ESC[3~ → '~'), Home/End, and modified arrows (ESC[1;5C → ';5C' —
        // where '5' is a screen hotkey). Consume the whole sequence; map A/B/C/D
        // finals to arrows regardless of parameters (Ctrl-arrow still moves).
        let j = i + 2;
        while (j < n && ((buf[j] >= 0x30 && buf[j] <= 0x3f) || (buf[j] >= 0x20 && buf[j] <= 0x2f))) j++;
        if (j >= n) {
          if (n - i <= 16) break; // incomplete — wait for the final byte
          i = j; continue;        // runaway "sequence" — drop it
        }
        const f = buf[j];
        const arrow =
          f === 0x41 ? 'up' : f === 0x42 ? 'down' : f === 0x43 ? 'right' : f === 0x44 ? 'left' : null;
        if (arrow) events.push({ type: 'key', key: arrow });
        i = j + 1;
        continue;
      }
      events.push({ type: 'key', key: 'esc' });
      i += 1;
      continue;
    }

    if (b === 13) {
      events.push({ type: 'key', key: 'enter' });
      i += 1;
      if (i < n && (buf[i] === 10 || buf[i] === 0)) i += 1; // swallow LF / NUL after CR
      // v1.47.1 (full-pass) — a CR at the very end of a chunk must swallow a
      // LF/NUL that arrives in the NEXT chunk, or a segment-split CRLF yields
      // a double enter.
      else if (i >= n) swallowAfterCr = true;
      continue;
    }
    if (b === 10) {
      events.push({ type: 'key', key: 'enter' });
      i += 1;
      continue;
    }
    if (b === 3) {
      events.push({ type: 'key', key: 'ctrl-c' });
      i += 1;
      continue;
    }
    if (b === 8 || b === 127) {
      // v1.46.0 — BS/DEL both arrive as backspace depending on the client's
      // terminal; the browser console's prompt needs it, the console ignores it.
      events.push({ type: 'key', key: 'backspace' });
      i += 1;
      continue;
    }
    if (b === 9) {
      // v1.46.0 — TAB cycles console screens.
      events.push({ type: 'key', key: 'tab' });
      i += 1;
      continue;
    }
    if (b >= 32 && b < 127) {
      events.push({ type: 'key', key: String.fromCharCode(b) });
      i += 1;
      continue;
    }
    i += 1; // skip other control bytes (0xFF included — there is no IAC any more)
  }
  return { events, rest: buf.subarray(i), swallowAfterCr };
}

/**
 * Refuse a connection and RECLAIM IT ON OUR SCHEDULE: `end()` alone is a
 * half-close, and a peer that never sends FIN would pin one descriptor per
 * refusal on the very branch whose job is to shed load. Say goodbye, then take
 * it back. (A text line before the `SSH-2.0-` version string is legal, RFC 4253
 * §4.2, and OpenSSH prints it.)
 */
export function refuseSocket(
  socket: Pick<Socket, 'end' | 'destroy' | 'once'>,
  msg: string,
  lingerMs: number = REFUSE_LINGER_MS,
): void {
  const kill = setTimeout(() => { try { socket.destroy(); } catch { /* already gone */ } }, lingerMs);
  kill.unref?.();
  socket.once('close', () => clearTimeout(kill));
  try { socket.end(msg); } catch { /* ignore */ }
}

/** The SHA256 fingerprint of a host key, as `ssh` and `ssh-keygen -lf` print it. */
export function hostKeyFingerprint(key: string): string {
  const parsed = sshUtils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  const k = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
  return 'SHA256:' + createHash('sha256').update(k.getPublicSSH()).digest('base64').replace(/=+$/, '');
}

/**
 * The host key at `path`, generated (ed25519) on first use and written 0600
 * through a rename. A file that does not parse is replaced, and the add-on log
 * says so: clients will warn that the host key changed.
 */
export function loadOrCreateHostKey(
  path: string,
  log: (msg: string) => void,
  warn: (msg: string) => void = log,
): { key: string; fingerprint: string } {
  if (existsSync(path)) {
    try {
      const key = readFileSync(path, 'utf8');
      return { key, fingerprint: hostKeyFingerprint(key) };
    } catch (e) {
      warn(`ssh: the host key at ${path} could not be read (${(e as Error).message}) — generating a new one; clients will warn that the host key changed`);
    }
  }
  const key = sshUtils.generateKeyPairSync('ed25519').private;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, key, { mode: 0o600 });
  renameSync(tmp, path);
  const fingerprint = hostKeyFingerprint(key);
  log(`ssh: generated a new host key (${fingerprint})`);
  return { key, fingerprint };
}

/** `42s`, `3m 05s`, `2h 14m` — for the teardown line. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export interface SshServerOptions {
  store: SnapshotStore;
  recorder: Recorder;
  host: string;
  port: number;
  /** The host key, OpenSSH format (see loadOrCreateHostKey). */
  hostKey: string;
  log: (msg: string) => void;
  /** Warning sink (the no-password refusal); defaults to `log`. */
  warn?: (msg: string) => void;
  /**
   * v0.67.0 — optional shared data provider. When the caller wants the WS
   * console and this server to share ONE set of refresh timers, it creates the
   * provider once and passes it in here. When omitted, this server creates and
   * owns its own.
   */
  data?: { provider: TuiDataProvider; stop: () => void };
  /**
   * v1.7.0 (security #1) — override the connection caps and the reclaim windows.
   * Production leaves them undefined (→ the module constants); tests pass tiny
   * values to exercise the guards without opening 16 sockets or waiting minutes.
   */
  maxConns?: number;
  maxConnsPerIp?: number;
  idleTimeoutMs?: number;
  keepAliveMs?: number;
  authGraceMs?: number;
}

export function startSshServer(opts: SshServerOptions): { stop: () => void; server: import('node:net').Server } {
  const { store, recorder, host, port, log } = opts;
  const warn = opts.warn ?? log;
  const maxConns = opts.maxConns ?? MAX_SSH_CONNS;
  const maxConnsPerIp = opts.maxConnsPerIp ?? MAX_SSH_CONNS_PER_IP;
  const idleMs = opts.idleTimeoutMs ?? SSH_IDLE_TIMEOUT_MS;
  const keepAliveMs = opts.keepAliveMs ?? SSH_KEEPALIVE_MS;
  const authGraceMs = opts.authGraceMs ?? SSH_AUTH_GRACE_MS;
  const conns = new Set<SshConn>();
  /** Sockets handed to ssh2 and not yet matched to its connection, by peer address:port. */
  const pending = new Map<string, SshConn>();

  // Shared, periodically-refreshed data caches (energy totals, day-ahead
  // forecast, capacity-fade degradation). Reused by every session here AND by
  // the WS console when the caller passes a shared provider.
  const owned = opts.data ?? createTuiDataProvider({ store, recorder, log });
  const data = owned.provider;
  const ownsData = !opts.data;

  const write = (conn: SshConn, payload: string): void => {
    try {
      if (conn.stream && !conn.stream.destroyed && conn.stream.writable) conn.stream.write(payload);
    } catch { /* peer vanished mid-write — the close handler cleans up */ }
  };

  const endConn = (conn: SshConn): void => {
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn);
    for (const [k, c] of pending) if (c === conn) pending.delete(k);
    log(`ssh: client ${conn.ip} disconnected after ${fmtElapsed(Date.now() - conn.openedAt)} (${conns.size} active)`);
    if (conn.timer) { clearInterval(conn.timer); conn.timer = null; }
    if (conn.stream) {
      // v0.9.5 — restore the primary screen buffer + cursor on exit so the
      // operator's terminal returns to whatever was visible before `ssh`.
      write(conn, SHOW_CURSOR + RESET + EXIT_ALT_BUFFER + '\r\n');
      try { conn.stream.exit(0); conn.stream.end(); } catch { /* ignore */ }
    }
    try { conn.client?.end(); } catch { /* ignore */ }
    refuseSocket(conn.socket, '');
  };

  const onData = (conn: SshConn, chunk: Buffer): void => {
    const session = conn.session;
    if (!session) return;
    conn.inbuf = conn.inbuf.length ? Buffer.concat([conn.inbuf, chunk]) : chunk;
    if (conn.inbuf.length > 4096) conn.inbuf = conn.inbuf.subarray(conn.inbuf.length - 64); // drop runaway garbage
    const { events, rest, swallowAfterCr } = parseInput(conn.inbuf, conn.swallowAfterCr);
    conn.swallowAfterCr = swallowAfterCr;
    conn.inbuf = Buffer.from(rest);
    const r = session.feed(events);
    if (r.quit) { endConn(conn); return; }
    if (r.redraw) session.draw();
  };

  /** Password only, against the console credentials, spending the login card's
   *  budgets under the connection's address. Usernames are never logged: a
   *  password typed into that field would be. */
  const authenticate = (conn: SshConn, ctx: AuthContext): void => {
    if (conn.closed) return;
    // Read per connection: the credentials are add-on options, and the tests set them per case.
    const auth = authFromEnv();
    if (!auth) {
      if (!conn.gateNoted) {
        conn.gateNoted = true;
        warn(`ssh: login from ${conn.ip} refused — no console password is set (TUI_PASSWORD); set one, or use /console through Home Assistant`);
      }
      ctx.reject([]);
      return;
    }
    if (ctx.method !== 'password') { ctx.reject(['password']); return; }
    const now = Date.now();
    if (consoleLoginThrottled(conn.ip, now)) {
      // The address's window is saturated: refuse outright and end the connection — no oracle, no more attempts.
      log(`ssh: login from ${conn.ip} refused — too many failed logins from this address; try again in a few minutes`);
      ctx.reject([]);
      endConn(conn);
      return;
    }
    if (verifyConsoleCredentials(ctx.username, ctx.password, auth)) {
      noteConsoleLoginSuccess(conn.ip);
      conn.auth = auth;
      conn.authenticated = true;
      ctx.accept();
      return;
    }
    noteConsoleLoginFailure(conn.ip, now);
    conn.attempts += 1;
    log(`ssh: failed login from ${conn.ip} (${conn.attempts} of ${AUTH_MAX_ATTEMPTS})`);
    if (conn.attempts >= AUTH_MAX_ATTEMPTS) {
      ctx.reject([]);
      endConn(conn);
      return;
    }
    ctx.reject(['password']);
  };

  /** One terminal per connection: a pty (optional — 80×24 without one), then a
   *  shell. exec, subsystems (sftp) and port forwarding are refused. */
  const onSession = (conn: SshConn, accept: () => import('ssh2').Session): void => {
    const sess = accept();
    let w = 80;
    let h = 24;
    sess.on('pty', (ok, _no, info) => { w = info.cols || w; h = info.rows || h; ok?.(); });
    sess.on('window-change', (ok, _no, info) => {
      ok?.();
      if (conn.session && info.cols && info.rows) {
        const r = conn.session.feed([{ type: 'naws', w: info.cols, h: info.rows }]);
        if (r.redraw) conn.session.draw();
      }
    });
    sess.on('exec', (_ok, no) => no?.());
    sess.on('subsystem', (_ok, no) => no?.());
    sess.on('shell', (ok, no) => {
      if (conn.session || conn.closed) { no?.(); return; }
      const stream = ok();
      conn.stream = stream;
      conn.session = new TuiSession({
        auth: conn.auth,
        preAuthenticated: true, // the password was checked above; no login card
        write: (payload) => write(conn, payload),
        data,
        width: w,
        height: h,
      });
      // v0.9.5 — enter the alt-screen buffer so the frames never smear into
      // the operator's scrollback.
      write(conn, ENTER_ALT_BUFFER + HIDE_CURSOR + CLEAR_SCREEN);
      conn.session.draw();
      conn.timer = setInterval(() => conn.session?.draw(), 1000);
      stream.on('data', (d: Buffer) => onData(conn, d));
      stream.on('close', () => endConn(conn));
      stream.on('error', () => endConn(conn));
    });
  };

  const ssh = new SshServer({ hostKeys: [opts.hostKey], ident: 'power-tui' }, (client, info) => {
    client.on('error', () => { /* handled by close */ });
    const conn = pending.get(`${info.ip}|${info.port}`);
    if (!conn || conn.closed) { client.end(); return; }
    pending.delete(`${info.ip}|${info.port}`);
    conn.client = client;
    client.on('authentication', (ctx) => authenticate(conn, ctx));
    client.on('ready', () => {
      log(`ssh: login from ${conn.ip} (${conns.size} active)`);
      client.on('session', (accept) => onSession(conn, accept));
    });
    client.on('close', () => endConn(conn));
  });
  ssh.on('error', () => { /* per-connection errors end that connection */ });

  const refuse = (socket: Socket, why: string, banner: string): void => {
    log(why);
    refuseSocket(socket, banner);
  };

  const server = createServer((socket) => {
    // An error listener FIRST: an RST on a socket with none crashes the add-on.
    socket.on('error', () => { /* handled by close */ });
    socket.setNoDelay(true);
    const ip = socket.remoteAddress ?? '?';
    // v1.7.0 (security #1) — concurrent-connection cap (parity with the WS
    // console's MAX_WS_SESSIONS). Beyond the cap a short banner, then close, so
    // a LAN flood cannot spawn unbounded per-connection render timers.
    if (conns.size >= maxConns) {
      refuse(socket, `ssh: connection cap (${maxConns}) reached — refusing ${ip}`,
        `\r\nToo many active connections (max ${maxConns}). Try again later.\r\n`);
      return;
    }
    let sameIp = 0;
    for (const c of conns) if (c.ip === ip) sameIp += 1;
    if (sameIp >= maxConnsPerIp) {
      refuse(socket, `ssh: per-IP cap (${maxConnsPerIp}) reached — refusing ${ip}`,
        `\r\nToo many active connections from this address (max ${maxConnsPerIp}). Try again later.\r\n`);
      return;
    }
    socket.setKeepAlive(true, keepAliveMs);
    const conn: SshConn = {
      socket, ip, lastRxAt: Date.now(), openedAt: Date.now(), client: null, auth: null, authenticated: false,
      attempts: 0, gateNoted: false, stream: null, session: null, inbuf: Buffer.alloc(0), swallowAfterCr: false,
      timer: null, closed: false,
    };
    conns.add(conn);
    log(`ssh: client connected from ${ip} (${conns.size} active)`);
    pending.set(`${ip}|${socket.remotePort}`, conn);
    socket.once('close', () => endConn(conn));
    // The idle clock counts INBOUND bytes only (node:net never delivers strings
    // on a socket without setEncoding()).
    socket.on('data', () => { conn.lastRxAt = Date.now(); });
    ssh.injectSocket(socket);
  });

  // A listen failure means the LAN port never opened, and nothing else says so.
  server.on('error', (e: any) => log(`ssh: server error: ${e?.message ?? e}`));
  server.listen(port, host);

  // Reclaim connections that have RECEIVED nothing for idleMs, and connections
  // that never logged in within authGraceMs. One timer covers every peer; unref'd
  // so it never keeps the process alive.
  const sweepMs = Math.min(60_000, Math.max(25, Math.floor(Math.min(idleMs, authGraceMs) / 2)));
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const conn of [...conns]) {
      if (!conn.authenticated && now - conn.openedAt >= authGraceMs) {
        log(`ssh: no login within ${authGraceMs} ms — closing ${conn.ip}`);
        endConn(conn);
        continue;
      }
      if (now - conn.lastRxAt < idleMs) continue;
      log(`ssh: idle ${idleMs} ms with no inbound data — closing ${conn.ip}`);
      endConn(conn);
    }
  }, sweepMs);
  sweep.unref?.();

  return {
    // v1.7.0 — expose the underlying net.Server so callers/tests can read the
    // bound address (esp. when listening on port 0). index.ts uses only .stop().
    server,
    stop: () => {
      clearInterval(sweep);
      for (const conn of [...conns]) endConn(conn);
      server.close();
      // Only stop the refresh timers if WE created them; a shared provider is
      // the caller's to stop.
      if (ownsData) owned.stop();
    },
  };
}
