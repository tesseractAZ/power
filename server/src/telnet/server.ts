/**
 * Telnet control-room TUI server.
 *
 * A raw TCP server speaking just enough of the telnet protocol to put a
 * standard `telnet` client into character-at-a-time mode. Each connection
 * gets a live, menu-driven dashboard rendered with ANSI — every datapoint
 * the web app surfaces, laid out for a power-plant-style operator console.
 *
 * No dependencies: Node's `net` + hand-rolled telnet negotiation + ANSI.
 *
 * v0.67.0 — the per-session render/input state machine moved to
 * `session.ts` (transport-agnostic `TuiSession`), and the shared data caches
 * (totals/forecast/degradation) moved to `dataProvider.ts` so the browser
 * WebSocket console (`wsConsole.ts`, served at /console) reuses BOTH. This
 * file now only owns the telnet transport: TCP + IAC negotiation + NAWS +
 * the alt-screen lifecycle. The IAC parsing here is unchanged.
 */

import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import type { SnapshotStore } from '../snapshot.js';
import type { Recorder } from '../recorder.js';
import { createTuiDataProvider } from './dataProvider.js';
import type { TuiDataProvider } from './session.js';
import { TuiSession, authFromEnv } from './session.js';
import type { InputEvent } from './session.js';
import {
  HIDE_CURSOR, SHOW_CURSOR, CLEAR_SCREEN, RESET,
  ENTER_ALT_BUFFER, EXIT_ALT_BUFFER,
} from './ansi.js';

/* ── Telnet protocol bytes ── */
const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const OPT_ECHO = 1;
const OPT_SGA = 3;
const OPT_NAWS = 31;

interface TelnetConn {
  socket: Socket;
  session: TuiSession;
  inbuf: Buffer;
  /** v1.47.1 — a chunk-final CR emitted enter; swallow its LF/NUL next chunk. */
  swallowAfterCr: boolean;
  timer: NodeJS.Timeout | null;
  // v1.7.0 (security #1) — per-connection idle-close timer, reset on every
  // inbound chunk; parity with the WS console's WS_IDLE_TIMEOUT_MS.
  idle: NodeJS.Timeout | null;
}

// v1.7.0 (security #1, CWE-400) — the raw telnet listener never got the WS
// console's v0.68.0 DoS guards. Without a cap + idle-reap, a LAN peer opening
// many idle sockets would each get a permanent 1 Hz render timer, starving the
// shared single-threaded Node event loop (Fastify API + alerting + MQTT + EcoFlow
// polling all run in it). Match wsConsole.ts (MAX_WS_SESSIONS / WS_IDLE_TIMEOUT_MS).
export const MAX_TELNET_CONNS = 16;
export const TELNET_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * Parse a raw input buffer into key/resize events, stripping telnet IAC
 * sequences. Incomplete trailing sequences are returned in `rest` to be
 * prepended to the next chunk.
 */
function parseInput(buf: Buffer, swallowLeadingLf = false): { events: InputEvent[]; rest: Buffer; swallowAfterCr: boolean } {
  const events: InputEvent[] = [];
  const n = buf.length;
  let i = 0;
  let swallowAfterCr = false;
  // v1.47.1 — a CR that ended the PREVIOUS chunk already emitted its enter;
  // drop the LF/NUL that belongs to it.
  if (swallowLeadingLf && i < n && (buf[i] === 10 || buf[i] === 0)) i += 1;
  while (i < n) {
    const b = buf[i];

    if (b === IAC) {
      if (i + 1 >= n) break; // incomplete
      const cmd = buf[i + 1];
      if (cmd === IAC) {
        i += 2; // escaped 0xFF data byte — ignore
        continue;
      }
      if (cmd === SB) {
        // Sub-negotiation: scan for IAC SE.
        let j = i + 2;
        let seAt = -1;
        let incomplete = false;
        while (j < n) {
          if (buf[j] === IAC) {
            if (j + 1 >= n) {
              incomplete = true;
              break;
            }
            if (buf[j + 1] === SE) {
              seAt = j;
              break;
            }
            j += 2; // IAC IAC (escaped) or IAC <x> inside SB
            continue;
          }
          j++;
        }
        // v1.47.2 (second-pass) — bound the wait for IAC SE: a dangling
        // subnegotiation used to hold the ENTIRE input stream hostage (every
        // later keystroke — including q/ctrl-c — was buffered as SB payload,
        // and each chunk reset the idle reaper). Real SB payloads are tiny
        // (NAWS = 5 bytes); past 64 buffered bytes the SB is abandoned and
        // parsing resumes after its header.
        if ((incomplete || seAt < 0) && n - i <= 64) break; // wait for the rest
        if (incomplete || seAt < 0) { i += 2; continue; }   // abandoned dangling SB
        // v1.47.1 (full-pass) — unescape doubled IAC bytes in the payload: a
        // dimension byte equal to 255 arrives as IAC IAC, and without
        // collapsing it the following bytes shift and w/h misparse (a
        // 255-col terminal negotiated 65280 rows).
        const raw = buf.subarray(i + 2, seAt);
        const sub: number[] = [];
        for (let k = 0; k < raw.length; k++) {
          sub.push(raw[k]);
          if (raw[k] === IAC && k + 1 < raw.length && raw[k + 1] === IAC) k++;
        }
        if (sub.length >= 5 && sub[0] === OPT_NAWS) {
          events.push({ type: 'naws', w: (sub[1] << 8) | sub[2], h: (sub[3] << 8) | sub[4] });
        }
        i = seAt + 2;
        continue;
      }
      if (cmd >= WILL && cmd <= DONT) {
        if (i + 2 >= n) break; // incomplete — need the option byte
        i += 3; // consume IAC <will/wont/do/dont> <opt>; no reply needed
        continue;
      }
      i += 2; // other 2-byte command (NOP, etc.)
      continue;
    }

    if (b === 0x1b) {
      // ESC — possibly a CSI/SS3 sequence.
      if (i + 1 >= n) break; // wait — could be the start of a sequence
      const b1 = buf[i + 1];
      if (b1 === 0x5b || b1 === 0x4f) {
        // v1.47.2 (second-pass) — CSI sequences are VARIABLE length: parameter
        // bytes (0x30-0x3F) and intermediates (0x20-0x2F) run until a final in
        // 0x40-0x7E. The old fixed-3-byte read leaked the tail of Delete
        // (ESC[3~ → '~'), Home/End, and modified arrows (ESC[1;5C → ';5C' —
        // where '5' is a screen hotkey and, at the login prompt, a silent
        // credential corruption). Consume the whole sequence; map A/B/C/D
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
      // a double enter (at the login prompt that submitted an empty password
      // and burned an attempt).
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
      // terminal; the login prompt needs it, the console ignores it.
      events.push({ type: 'key', key: 'backspace' });
      i += 1;
      continue;
    }
    if (b === 9) {
      // v1.46.0 — TAB cycles console screens (and toggles login fields).
      events.push({ type: 'key', key: 'tab' });
      i += 1;
      continue;
    }
    if (b >= 32 && b < 127) {
      events.push({ type: 'key', key: String.fromCharCode(b) });
      i += 1;
      continue;
    }
    i += 1; // skip other control bytes
  }
  return { events, rest: buf.subarray(i), swallowAfterCr };
}

export interface TelnetServerOptions {
  store: SnapshotStore;
  recorder: Recorder;
  host: string;
  port: number;
  log: (msg: string) => void;
  /**
   * v0.67.0 — optional shared data provider. When the caller wants the WS
   * console and the telnet server to share ONE set of refresh timers, it
   * creates the provider once and passes it in here. When omitted, the telnet
   * server creates and owns its own (the standalone-telnet path).
   */
  data?: { provider: TuiDataProvider; stop: () => void };
  /**
   * v1.7.0 (security #1) — override the concurrent-connection cap and the
   * idle-reap window. Production leaves both undefined (→ MAX_TELNET_CONNS /
   * TELNET_IDLE_TIMEOUT_MS); tests pass tiny values to exercise the guards
   * without opening 16 sockets or waiting 5 minutes.
   */
  maxConns?: number;
  idleTimeoutMs?: number;
}

export function startTelnetServer(opts: TelnetServerOptions): { stop: () => void; server: import('node:net').Server } {
  const { store, recorder, host, port, log } = opts;
  const maxConns = opts.maxConns ?? MAX_TELNET_CONNS;
  const idleMs = opts.idleTimeoutMs ?? TELNET_IDLE_TIMEOUT_MS;
  const conns = new Set<TelnetConn>();

  // Shared, periodically-refreshed data caches (energy totals, day-ahead
  // forecast, capacity-fade degradation). Reused by every session here AND by
  // the WS console when the caller passes a shared provider.
  const owned = opts.data ?? createTuiDataProvider({ store, recorder, log });
  const data = owned.provider;
  const ownsData = !opts.data;

  const safeWrite = (socket: Socket, payload: string | Buffer) => {
    try {
      if (!socket.destroyed && socket.writable) socket.write(payload);
    } catch {
      /* peer vanished mid-write — the close handler will clean up */
    }
  };

  const endConn = (conn: TelnetConn) => {
    if (!conns.has(conn)) return;
    conns.delete(conn);
    if (conn.timer) {
      clearInterval(conn.timer);
      conn.timer = null;
    }
    if (conn.idle) {
      clearTimeout(conn.idle);
      conn.idle = null;
    }
    try {
      if (!conn.socket.destroyed) {
        // v0.9.5 — restore the user's primary screen buffer + cursor on exit
        // so their terminal returns to whatever was visible before they ran
        // `telnet`. Without ?1049l the alt-buffer remains active and they'd
        // see a blank terminal until they manually re-enter primary mode.
        conn.socket.write(SHOW_CURSOR + RESET + EXIT_ALT_BUFFER + '\r\n');
        conn.socket.end();
      }
    } catch {
      /* ignore */
    }
  };

  const onData = (conn: TelnetConn, chunk: Buffer) => {
    // v1.7.0 (security #1) — any inbound activity resets the idle-reap timer.
    if (conn.idle) {
      clearTimeout(conn.idle);
      conn.idle = setTimeout(() => endConn(conn), idleMs);
      conn.idle.unref?.();
    }
    conn.inbuf = conn.inbuf.length ? Buffer.concat([conn.inbuf, chunk]) : chunk;
    if (conn.inbuf.length > 4096) conn.inbuf = conn.inbuf.subarray(conn.inbuf.length - 64); // drop runaway garbage
    const { events, rest, swallowAfterCr } = parseInput(conn.inbuf, conn.swallowAfterCr);
    conn.swallowAfterCr = swallowAfterCr;
    conn.inbuf = Buffer.from(rest);
    const r = conn.session.feed(events);
    if (r.quit) {
      endConn(conn);
      return;
    }
    if (r.redraw) conn.session.draw();
  };

  const server = createServer((socket) => {
    socket.setNoDelay(true);
    // v1.7.0 (security #1) — concurrent-connection cap (parity with the WS
    // console's MAX_WS_SESSIONS). Beyond the cap we send a short banner and close
    // so a LAN flood can't spawn unbounded per-connection render timers.
    if (conns.size >= maxConns) {
      try { socket.end(`\r\nToo many active connections (max ${maxConns}). Try again later.\r\n`); } catch { /* ignore */ }
      return;
    }
    const session = new TuiSession({
      auth: authFromEnv(),
      write: (payload) => safeWrite(socket, payload),
      data,
    });
    const conn: TelnetConn = { socket, session, inbuf: Buffer.alloc(0), swallowAfterCr: false, timer: null, idle: null };
    conns.add(conn);
    log(`telnet: client connected from ${socket.remoteAddress ?? '?'} (${conns.size} active)`);
    // v1.7.0 (security #1) — idle-reap: close a session silent for
    // TELNET_IDLE_TIMEOUT_MS. Reset on every inbound chunk (onData). unref() so
    // the timer never keeps the process alive.
    conn.idle = setTimeout(() => { log('telnet: idle timeout — closing'); endConn(conn); }, idleMs);
    conn.idle.unref?.();

    // Negotiate character-at-a-time mode + ask for the window size.
    socket.write(
      Buffer.from([
        IAC, WILL, OPT_ECHO,
        IAC, WILL, OPT_SGA,
        IAC, DO, OPT_SGA,
        IAC, DO, OPT_NAWS,
      ]),
    );
    // v0.9.5 — enter alt-screen buffer so we don't pollute the user's
    // scrollback and our frame boundaries can't smear into earlier output.
    safeWrite(socket, ENTER_ALT_BUFFER + HIDE_CURSOR + CLEAR_SCREEN);
    session.draw();
    conn.timer = setInterval(() => session.draw(), 1000);

    // node:net never delivers strings on a socket without setEncoding(); the
    // @types/node ≥ 22.19 union of `string | Buffer` is a theoretical-only
    // possibility for our setup, so coerce to keep the inner signature tight.
    socket.on('data', (d) => onData(conn, d as Buffer));
    socket.on('close', () => endConn(conn));
    socket.on('error', () => endConn(conn));
  });

  server.on('error', (e: any) => log(`telnet: server error: ${e?.message ?? e}`));
  server.listen(port, host);

  return {
    // v1.7.0 — expose the underlying net.Server so callers/tests can read the
    // bound address (esp. when listening on port 0). index.ts uses only .stop().
    server,
    stop: () => {
      for (const conn of [...conns]) endConn(conn);
      server.close();
      // Only stop the refresh timers if WE created them; a shared provider is
      // the caller's to stop.
      if (ownsData) owned.stop();
    },
  };
}
