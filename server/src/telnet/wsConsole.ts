/**
 * Browser web-terminal for the control-room TUI ("Power TUI").
 *
 * v0.67.0 — serves the same operator TUI that the telnet TCP server exposes,
 * but over a WebSocket + xterm.js so it opens in a browser (and from the Home
 * Assistant sidebar via a `panel_iframe` pointing at
 * `http://<host>:8787/console`).
 *
 * Routes registered on the existing Fastify app:
 *   • GET /console        — full-screen xterm.js page (self-contained HTML).
 *   • GET /console/xterm.js, /console/xterm.css — the vendored xterm.js dist,
 *     served from node_modules (NO CDN — offline ethos). The HA add-on image
 *     copies server/node_modules wholesale, so these resolve in production.
 *   • GET /console/ws     — WebSocket transport. Drives a `TuiSession`:
 *       browser keystrokes (xterm `onData`, char mode, NO telnet IAC) →
 *       parsed `InputEvent`s; ANSI frames → ws text frames. A JSON control
 *       message `{type:'resize',cols,rows}` maps to the session size.
 *
 * Auth posture: the telnet TUI is already unauthenticated on the LAN, so this
 * read-only browser view is the SAME exposure. It does NOT touch the existing
 * write-auth and does NOT add auth that would break `panel_iframe`.
 *
 * v0.68.0 hardening — the /console/ws upgrade is still unauthenticated but no
 * longer unbounded: a cross-origin Origin is rejected (same-origin/LAN/missing
 * Origin still pass, so the HA panel_iframe is unaffected), concurrent sessions
 * are capped, idle sessions time out, and inbound frames are size-bounded by
 * the @fastify/websocket `maxPayload`.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { TuiSession, authFromEnv } from './session.js';
import type { InputEvent, TuiDataProvider } from './session.js';

/**
 * v0.68.0 — guard rails for the (unauthenticated) /console/ws transport:
 *   • MAX_WS_SESSIONS    — concurrent-session cap; beyond it the upgrade is
 *     accepted then immediately closed 1013 (Try Again Later) so a runaway
 *     client (or open tab storm) can't pin unbounded 1 Hz render loops.
 *   • WS_IDLE_TIMEOUT_MS — close a session that has received no inbound ws
 *     message for this long, so an idle/forgotten browser tab stops holding a
 *     live render loop forever. Reset on every inbound frame.
 * Both are deliberately generous — this is a LAN operator view, not a public
 * endpoint — but turn an unbounded surface into a bounded one.
 */
export const MAX_WS_SESSIONS = 16;
export const WS_IDLE_TIMEOUT_MS = 5 * 60_000;
/** WebSocket close code 1013 = "Try Again Later" (RFC 6455 §7.4.1). */
const WS_TRY_AGAIN_LATER = 1013;

export interface WsConsoleOptions {
  app: FastifyInstance;
  data: TuiDataProvider;
  log: (msg: string) => void;
  /**
   * Origin allow-list check for the ws upgrade. Should mirror the panel's
   * existing same-origin/LAN policy (auth.ts `isAllowedOrigin`). A missing
   * Origin (same-origin browser fetch, HA panel_iframe, curl) is treated as
   * allowed — the policy only rejects a *present, cross-origin* Origin.
   * Omitted in tests that don't exercise the upgrade path.
   */
  isOriginAllowed?: (origin: string | undefined) => boolean;
  /** Concurrent-session cap override (defaults to MAX_WS_SESSIONS). Test seam. */
  maxSessions?: number;
  /** Idle-timeout override in ms (defaults to WS_IDLE_TIMEOUT_MS). Test seam. */
  idleTimeoutMs?: number;
}

/**
 * Parse a chunk of xterm.js keyboard data (a JS string of raw terminal bytes,
 * char-at-a-time, with NO telnet IAC framing) into transport-agnostic input
 * events. This mirrors the non-IAC half of the telnet parser: ESC arrow
 * sequences, CR/LF → enter, Ctrl-C, TAB, and printable ASCII.
 *
 * xterm's `onData` already delivers decoded key data — there are no IAC bytes
 * to strip — so this is simpler than the telnet `parseInput`. Window size
 * arrives out-of-band via the JSON resize control message, not here.
 */
export function parseXtermData(s: string): InputEvent[] {
  const events: InputEvent[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    const code = s.charCodeAt(i);

    if (code === 0x1b) {
      // ESC — possibly an arrow-key sequence (CSI / SS3).
      if (i + 1 >= n) {
        events.push({ type: 'key', key: 'esc' });
        i += 1;
        continue;
      }
      const b1 = s.charCodeAt(i + 1);
      if (b1 === 0x5b || b1 === 0x4f) {
        // v1.47.2 (second-pass) — variable-length CSI (see server.ts): consume
        // parameter/intermediate bytes to the final, so Delete/Home/End and
        // modified arrows can't leak printable tails into the session (a
        // leaked '~' at the login prompt silently corrupted the credential).
        let j = i + 2;
        while (j < n) {
          const cj = s.charCodeAt(j);
          if ((cj >= 0x30 && cj <= 0x3f) || (cj >= 0x20 && cj <= 0x2f)) { j++; continue; }
          break;
        }
        if (j >= n) break; // incomplete — xterm onData delivers sequences atomically
        const f = s.charCodeAt(j);
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

    if (code === 13) {
      events.push({ type: 'key', key: 'enter' });
      i += 1;
      if (i < n && (s.charCodeAt(i) === 10 || s.charCodeAt(i) === 0)) i += 1; // swallow LF/NUL after CR
      continue;
    }
    if (code === 10) {
      events.push({ type: 'key', key: 'enter' });
      i += 1;
      continue;
    }
    if (code === 3) {
      events.push({ type: 'key', key: 'ctrl-c' });
      i += 1;
      continue;
    }
    if (code === 8 || code === 127) {
      // v1.46.0 — BS/DEL both arrive as backspace depending on the client's
      // terminal; the login prompt needs it, the console ignores it.
      events.push({ type: 'key', key: 'backspace' });
      i += 1;
      continue;
    }
    if (code === 9) {
      events.push({ type: 'key', key: 'tab' });
      i += 1;
      continue;
    }
    if (code >= 32 && code < 127) {
      events.push({ type: 'key', key: ch });
      i += 1;
      continue;
    }
    i += 1; // skip other control bytes
  }
  return events;
}

/* ── vendored xterm.js assets (resolved from node_modules, served offline) ── */

const require_ = createRequire(import.meta.url);
function readVendored(spec: string): string | null {
  try {
    return readFileSync(require_.resolve(spec), 'utf8');
  } catch {
    return null;
  }
}
const XTERM_JS = readVendored('@xterm/xterm/lib/xterm.js');
const XTERM_CSS = readVendored('@xterm/xterm/css/xterm.css');

/* ── the /console page ── */

const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Power TUI</title>
<link rel="stylesheet" href="./console/xterm.css" />
<style>
  html, body { margin: 0; height: 100%; background: #0a0c10; }
  #term { position: fixed; inset: 0; padding: 6px; box-sizing: border-box; }
  .xterm { height: 100%; }
  #dashlink {
    position: fixed; right: 10px; bottom: 8px; z-index: 10;
    font: 12px/1.4 system-ui, -apple-system, sans-serif;
    color: #9fb3c8; background: rgba(16,20,28,0.82);
    border: 1px solid #243044; border-radius: 6px;
    padding: 4px 9px; text-decoration: none;
  }
  #dashlink:hover { color: #e6edf3; border-color: #3a4a63; }
  #status {
    position: fixed; left: 10px; bottom: 8px; z-index: 10;
    font: 12px/1.4 system-ui, -apple-system, sans-serif; color: #6b7d92;
  }
</style>
</head>
<body>
<div id="term"></div>
<a id="dashlink" href="./" title="Open the web dashboard">📊 Dashboard</a>
<div id="status">connecting…</div>
<script src="./console/xterm.js"></script>
<script>
(function () {
  var statusEl = document.getElementById('status');
  var term = new Terminal({
    cursorBlink: false,
    convertEol: false,
    fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 14,
    theme: {
      background: '#0a0c10',
      foreground: '#cfe0f0',
      cursor: '#cfe0f0',
      black: '#0a0c10', brightBlack: '#5b6b7d',
      red: '#ff5c57', brightRed: '#ff8a85',
      green: '#5af78e', brightGreen: '#8affb1',
      yellow: '#f3f99d', brightYellow: '#fdffb6',
      blue: '#57c7ff', brightBlue: '#8fd9ff',
      magenta: '#ff6ac1', brightMagenta: '#ff92d6',
      cyan: '#9aedfe', brightCyan: '#c2f5ff',
      white: '#cfe0f0', brightWhite: '#ffffff'
    }
  });
  term.open(document.getElementById('term'));
  term.focus();

  // Fit the terminal to the viewport without the addon: compute cols/rows from
  // the measured cell size and the container box, clamped to the session's
  // supported range (60..200 cols, 16..80 rows).
  function dims() {
    var core = term._core;
    var cw = (core && core._renderService && core._renderService.dimensions
      && core._renderService.dimensions.css.cell.width) || 9;
    var chh = (core && core._renderService && core._renderService.dimensions
      && core._renderService.dimensions.css.cell.height) || 17;
    var el = document.getElementById('term');
    var w = Math.max(0, el.clientWidth - 12);
    var h = Math.max(0, el.clientHeight - 12);
    var cols = Math.max(60, Math.min(200, Math.floor(w / cw) || 80));
    var rows = Math.max(16, Math.min(80, Math.floor(h / chh) || 24));
    return { cols: cols, rows: rows };
  }

  var ws = null;
  var retry = null;
  // Last cols/rows we actually sent. term.resize() re-triggers term.onResize
  // (→ sendResize), so without this guard each user resize sent a duplicate
  // {type:'resize'} frame and could re-enter. Track + compare to suppress that.
  var lastCols = 0, lastRows = 0;
  var keepalive = null;

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Relative path so this works behind any host:port and through HA Ingress.
    var base = location.pathname.replace(/\\/console\\/?$/, '/console');
    var url = proto + '//' + location.host + base + '/ws';
    ws = new WebSocket(url);

    ws.onopen = function () {
      if (retry) { clearTimeout(retry); retry = null; }
      if (keepalive) clearInterval(keepalive);
      keepalive = setInterval(function () {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 60000);
      statusEl.textContent = 'connected';
      // Force the first resize through even if dims() matches the stale latch.
      lastCols = 0; lastRows = 0;
      sendResize();
    };
    ws.onmessage = function (ev) { term.write(ev.data); };
    ws.onclose = function () {
      if (keepalive) { clearInterval(keepalive); keepalive = null; }
      statusEl.textContent = 'disconnected — reconnecting…';
      retry = setTimeout(connect, 1500);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  var inResize = false;
  function sendResize() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (inResize) return; // term.resize() below re-enters via onResize — ignore
    var d = dims();
    if (d.cols === lastCols && d.rows === lastRows) return; // no actual change
    lastCols = d.cols; lastRows = d.rows;
    inResize = true;
    try { term.resize(d.cols, d.rows); } finally { inResize = false; }
    ws.send(JSON.stringify({ type: 'resize', cols: d.cols, rows: d.rows }));
  }

  term.onData(function (data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  });
  term.onResize(function () { sendResize(); });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendResize, 120);
  });

  connect();
})();
</script>
</body>
</html>`;

/**
 * Register the /console routes on the given Fastify app. Idempotent shape:
 * call once after `@fastify/websocket` is registered.
 */
export function registerWsConsole(opts: WsConsoleOptions): void {
  const { app, data, log, isOriginAllowed } = opts;
  const maxSessions = opts.maxSessions ?? MAX_WS_SESSIONS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? WS_IDLE_TIMEOUT_MS;

  if (!XTERM_JS || !XTERM_CSS) {
    log('console: WARNING — @xterm/xterm dist not found in node_modules; /console assets will 404');
  }

  // Live /console/ws session count for the concurrency cap. Incremented when a
  // session is admitted, decremented exactly once on close.
  let liveSessions = 0;

  app.get('/console', (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8').send(CONSOLE_HTML);
  });

  app.get('/console/xterm.js', (_req, reply) => {
    if (!XTERM_JS) { reply.code(404).send({ error: 'xterm.js unavailable' }); return; }
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=86400')
      .send(XTERM_JS);
  });

  app.get('/console/xterm.css', (_req, reply) => {
    if (!XTERM_CSS) { reply.code(404).send({ error: 'xterm.css unavailable' }); return; }
    reply
      .header('Content-Type', 'text/css; charset=utf-8')
      .header('Cache-Control', 'public, max-age=86400')
      .send(XTERM_CSS);
  });

  app.get('/console/ws', {
    websocket: true,
    // Reject cross-origin upgrades BEFORE the socket is hijacked. Replying from
    // a preValidation hook short-circuits the route, so the upgrade never
    // happens. A missing Origin (same-origin fetch, HA panel_iframe, curl) is
    // allowed — only a present, disallowed Origin is rejected. No-op when
    // isOriginAllowed is not supplied.
    preValidation: (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
      if (isOriginAllowed) {
        const origin = req.headers.origin?.toString();
        if (origin && !isOriginAllowed(origin)) {
          reply.code(403).send({ error: 'forbidden-origin' });
          return; // do NOT call done() — reply short-circuits the route
        }
      }
      done();
    },
  }, (socket: WebSocket) => {
    // Concurrency cap: admit-then-close-1013 beyond the limit. We accept the
    // upgrade first (the cap fires post-handshake) and immediately close with
    // "Try Again Later" so the browser sees a clean, well-coded rejection.
    if (liveSessions >= maxSessions) {
      log(`console: ws session cap (${maxSessions}) reached — rejecting with 1013`);
      try { socket.close(WS_TRY_AGAIN_LATER, 'too many sessions'); } catch { /* ignore */ }
      return;
    }
    liveSessions += 1;

    const session = new TuiSession({
      auth: authFromEnv(),
      // xterm renders the bytes verbatim; no telnet alt-buffer dance needed.
      write: (payload) => {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      },
      data,
    });

    let alive = true;
    // 1 Hz redraw tick — same cadence as the telnet transport, so live data
    // (which the frame-hash skips when unchanged) reaches the browser within
    // ~1 s of changing.
    const timer = setInterval(() => { if (alive) session.draw(); }, 1000);

    // Idle timeout — close a session with no inbound traffic for
    // WS_IDLE_TIMEOUT_MS so a forgotten tab stops holding the render loop.
    // Reset on every inbound ws message.
    let idleTimer: NodeJS.Timeout;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log('console: ws session idle timeout — closing');
        try { socket.close(); } catch { /* ignore */ }
      }, idleTimeoutMs);
    };

    const cleanup = () => {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      clearTimeout(idleTimer);
      liveSessions -= 1;
    };

    armIdle();
    session.draw();

    socket.on('message', (raw: Buffer) => {
      const text = raw.toString('utf8');
      // A control message is a JSON object with a known `type`; anything else
      // is treated as raw keyboard data from xterm.
      if (text.length && text[0] === '{') {
        try {
          const msg = JSON.parse(text);
          // v1.47.2/v1.47.3 — client keepalive: a passively WATCHED console
          // sends no keystrokes, so without a ping the 5-min idle timeout
          // closed wall-display sessions. A bare ping refreshes the deadline
          // ONLY once the session is past the login gate (session.isInteractive
          // is true after login, or immediately when no password is set); a
          // SILENT login-parked tab that only pings is NOT kept alive, so it
          // still reaps at the idle timeout and cannot hold a session slot
          // indefinitely. Genuine activity (keystrokes/resize) always re-arms.
          if (msg && msg.type === 'ping') {
            if (session.isInteractive) armIdle();
            return;
          }
          armIdle(); // resize is genuine activity
          if (msg && msg.type === 'resize') {
            const cols = Number(msg.cols);
            const rows = Number(msg.rows);
            if (session.resize(cols, rows)) session.draw();
            return;
          }
        } catch {
          /* not JSON — fall through and treat as keyboard data */
        }
      }
      armIdle(); // keystrokes are genuine activity — always reset the deadline
      const r = session.feed(parseXtermData(text));
      if (r.quit) {
        // Browser sessions can't "quit" the page; close the socket — the
        // client auto-reconnects to a fresh session (which re-prompts login).
        try { socket.close(); } catch { /* ignore */ }
        return;
      }
      if (r.redraw) session.draw();
    });

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  log('console: web terminal on /console (xterm.js over /console/ws)');
}
