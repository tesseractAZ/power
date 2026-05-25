/**
 * Telnet control-room TUI server.
 *
 * A raw TCP server speaking just enough of the telnet protocol to put a
 * standard `telnet` client into character-at-a-time mode. Each connection
 * gets a live, menu-driven dashboard rendered with ANSI — every datapoint
 * the web app surfaces, laid out for a power-plant-style operator console.
 *
 * No dependencies: Node's `net` + hand-rolled telnet negotiation + ANSI.
 */

import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import type { SnapshotStore } from '../snapshot.js';
import type { Recorder } from '../recorder.js';
import { computeTotals, startOfLocalDayMs } from '../aggregator.js';
import type { FleetEnergyTotals } from '../aggregator.js';
import { getDayForecast, computeDegradation } from '../analytics.js';
import type { DayForecast } from '../analytics.js';
import { renderScreen, SCREENS, getDpus } from './screens.js';
import type { ScreenId, SessionView } from './screens.js';
import { renderPlant, PLANT_SCREENS } from './plant/index.js';
import type { PlantScreenId, PlantView } from './plant/index.js';
import { renderChooser, defaultChooserState } from './plant/chooser.js';
import type { ChooserState } from './plant/chooser.js';
import {
  HIDE_CURSOR, SHOW_CURSOR, CLEAR_SCREEN, CURSOR_HOME, CLEAR_EOL, CLEAR_BELOW, RESET,
  ENTER_ALT_BUFFER, EXIT_ALT_BUFFER, BEGIN_SYNC, END_SYNC,
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

type InputEvent = { type: 'key'; key: string } | { type: 'naws'; w: number; h: number };

/**
 * v0.9.13 — session mode. On connect we show the chooser; the user picks
 * a console with [1] (Plant Operator) or [2] (Summary). TAB from any
 * non-chooser view returns to the chooser.
 */
type SessionMode = 'chooser' | 'plant' | 'summary';

interface Session {
  socket: Socket;
  width: number;
  height: number;
  mode: SessionMode;
  /** SUMMARY mode state (legacy screens). */
  screen: ScreenId;
  battDpu: number;
  battPack: number;
  alertScroll: number;
  /** PLANT mode state. */
  plantScreen: PlantScreenId;
  plantGenSel: number;
  plantGenPack: number;
  plantAlmScroll: number;
  plantConnectedAt: number;
  /** CHOOSER mode state. */
  chooser: ChooserState;
  inbuf: Buffer;
  timer: NodeJS.Timeout | null;
  /** v0.9.5 — true while a frame is being written; prevents overlapping draws
   *  from interleaving (e.g. a NAWS event triggering a mid-frame redraw on
   *  top of the periodic 1s redraw). Cleared as soon as socket.write returns. */
  drawing: boolean;
  /** v0.9.5 — a redraw was requested while drawing was in flight; honor it
   *  immediately after the current frame finishes so user input still feels
   *  instant without ever overlapping writes. */
  drawPending: boolean;
  /** v0.9.16 — hash of the last successfully-written frame body. When the
   *  next render produces the same body, we skip the socket write entirely.
   *  This drops Termius bandwidth on screens that don't change between ticks
   *  (e.g. ALM with 5 stable alarms) from ~3 KB/s to 0 — and removes the
   *  flicker that was visible on terminals without mode-2026 sync support. */
  lastFrameHash: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Parse a raw input buffer into key/resize events, stripping telnet IAC
 * sequences. Incomplete trailing sequences are returned in `rest` to be
 * prepended to the next chunk.
 */
function parseInput(buf: Buffer): { events: InputEvent[]; rest: Buffer } {
  const events: InputEvent[] = [];
  const n = buf.length;
  let i = 0;
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
        if (incomplete || seAt < 0) break; // wait for the rest
        const sub = buf.subarray(i + 2, seAt);
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
      // ESC — possibly an arrow-key sequence.
      if (i + 1 >= n) break; // wait — could be the start of a sequence
      const b1 = buf[i + 1];
      if (b1 === 0x5b || b1 === 0x4f) {
        // CSI / SS3
        if (i + 2 >= n) break; // incomplete
        const f = buf[i + 2];
        const arrow =
          f === 0x41 ? 'up' : f === 0x42 ? 'down' : f === 0x43 ? 'right' : f === 0x44 ? 'left' : null;
        if (arrow) events.push({ type: 'key', key: arrow });
        i += 3;
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
    if (b === 9) {
      // v0.9.13 — TAB key returns to the mode chooser.
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
  return { events, rest: buf.subarray(i) };
}

export interface TelnetServerOptions {
  store: SnapshotStore;
  recorder: Recorder;
  host: string;
  port: number;
  log: (msg: string) => void;
}

export function startTelnetServer(opts: TelnetServerOptions): { stop: () => void } {
  const { store, recorder, host, port, log } = opts;
  const sessions = new Set<Session>();
  // v0.9.13 — captured once at server start so Plant header can show SYS.UPTIME.
  const serverStartedAt = Date.now();

  // Shared, periodically-refreshed data caches — the energy integration and
  // weather forecast are too heavy to run on every 1 s render.
  let totals: FleetEnergyTotals | null = null;
  let forecast: DayForecast | null = null;
  let stopped = false;
  let forecastTimer: NodeJS.Timeout | null = null;

  const storeReady = () => Object.keys(store.get().devices).length > 0;

  const refreshTotals = () => {
    if (!storeReady()) return; // leave totals null until the fleet is discovered
    try {
      totals = computeTotals(store, recorder, startOfLocalDayMs(), Date.now());
    } catch (e: any) {
      log(`telnet: totals refresh failed: ${e?.message ?? e}`);
    }
  };

  // The day-ahead forecast is heavy and needs the device list + recorder
  // history ready, so it self-schedules: fast retries until the first usable
  // result lands, then a relaxed 5-minute cadence. A degraded result (no
  // history yet) never clobbers a good one.
  const refreshForecast = async (): Promise<boolean> => {
    if (!storeReady()) return false;
    try {
      const f = await getDayForecast(store.get().devices, recorder, () => {});
      if (f.historyDays > 0 || forecast == null) forecast = f;
      return f.historyDays > 0;
    } catch (e: any) {
      log(`telnet: forecast refresh failed: ${e?.message ?? e}`);
      return false;
    }
  };
  const scheduleForecast = (delayMs: number) => {
    forecastTimer = setTimeout(async () => {
      if (stopped) return;
      const good = await refreshForecast();
      if (!stopped) scheduleForecast(good ? 5 * 60_000 : 30_000);
    }, delayMs);
  };

  refreshTotals();
  const totalsTimer = setInterval(refreshTotals, 15_000);
  scheduleForecast(2_000);

  const safeWrite = (s: Session, data: string | Buffer) => {
    try {
      if (!s.socket.destroyed && s.socket.writable) s.socket.write(data);
    } catch {
      /* peer vanished mid-write — the close handler will clean up */
    }
  };

  const draw = (s: Session) => {
    if (s.socket.destroyed) return;
    // v0.9.5 — serialize frames. If a draw is already in flight, mark a
    // pending redraw and bail. The completing frame will run the pending
    // one on its way out. Eliminates the "two writes racing into the same
    // ANSI stream" class of glitch.
    if (s.drawing) {
      s.drawPending = true;
      return;
    }
    s.drawing = true;
    s.drawPending = false;
    try {
      let lines: string[];
      if (s.mode === 'chooser') {
        s.chooser.width = s.width;
        s.chooser.height = s.height;
        lines = renderChooser(s.chooser);
      } else if (s.mode === 'plant') {
        const pv: PlantView = {
          width: s.width,
          height: s.height,
          screen: s.plantScreen,
          genSel: s.plantGenSel,
          genPack: s.plantGenPack,
          almScroll: s.plantAlmScroll,
          connectedAt: s.plantConnectedAt,
        };
        lines = renderPlant(pv, {
          snap: store.get(),
          totals,
          forecast,
          degradation: computeDegradation(store.get().devices, recorder),
          serverStartedAt,
        }, { recorder });
      } else {
        const sv: SessionView = {
          width: s.width,
          height: s.height,
          screen: s.screen,
          battDpu: s.battDpu,
          battPack: s.battPack,
          alertScroll: s.alertScroll,
        };
        // computeDegradation is internally cached (~30 min), so calling it per
        // render is cheap — the work runs at most twice an hour.
        lines = renderScreen(sv, {
          snap: store.get(),
          totals,
          forecast,
          degradation: computeDegradation(store.get().devices, recorder),
        });
      }
      // v0.9.5 — wrap each frame in synchronized-output escapes so terminals
      // that support mode 2026 (Kitty, recent iTerm2, recent WezTerm, Windows
      // Terminal) buffer all output and flip atomically. Terminals that don't
      // support it (Termius, older iTerm2, plain xterm) treat the escapes as
      // no-ops and apply each subsequent escape live.
      //
      // v0.9.16 — fix flicker on non-mode-2026 terminals:
      //   • Build the FRAME BODY (without sync escapes) and hash it.
      //   • If the new body is byte-identical to the previous one, skip the
      //     socket write entirely — Termius sees zero bytes, zero repaint
      //     work. The 1 Hz draw timer keeps firing, so any change reaches
      //     the wire within ~1 s of happening.
      //   • Drop CLEAR_SCREEN. The combination of CURSOR_HOME at the top,
      //     per-line CLEAR_EOL, and trailing CLEAR_BELOW already covers
      //     every transition cleanly — and crucially does NOT produce a
      //     visible blank-and-repaint on Termius. The "INFO" flash on the
      //     ALM screen was a side effect of the per-tick blank.
      let body = HIDE_CURSOR + CURSOR_HOME;
      for (let i = 0; i < lines.length; i++) {
        body += lines[i] + CLEAR_EOL;
        if (i < lines.length - 1) body += '\r\n';
      }
      body += CLEAR_BELOW;

      // Cheap stable hash of the body. The body is typically ~2-4 KB and
      // already a UTF-8 string, so a 32-bit FNV-1a is plenty discriminative
      // and avoids pulling in node:crypto on the hot path.
      let hash = 2166136261;
      for (let i = 0; i < body.length; i++) {
        hash ^= body.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
      }
      const hashStr = hash.toString(36);
      if (hashStr === s.lastFrameHash) {
        // Identical frame — no wire write, no terminal work, no flicker.
        return;
      }
      s.lastFrameHash = hashStr;
      safeWrite(s, BEGIN_SYNC + body + END_SYNC);
    } finally {
      s.drawing = false;
      // Honor a pending redraw queued during this frame.
      if (s.drawPending) {
        s.drawPending = false;
        // Schedule on the next tick so we don't grow the call stack on rapid
        // keypress + interval coincidence.
        setImmediate(() => draw(s));
      }
    }
  };

  const endSession = (s: Session) => {
    if (!sessions.has(s)) return;
    sessions.delete(s);
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
    try {
      if (!s.socket.destroyed) {
        // v0.9.5 — restore the user's primary screen buffer + cursor on exit
        // so their terminal returns to whatever was visible before they ran
        // `telnet`. Without ?1049l the alt-buffer remains active and they'd
        // see a blank terminal until they manually re-enter primary mode.
        s.socket.write(SHOW_CURSOR + RESET + EXIT_ALT_BUFFER + '\r\n');
        s.socket.end();
      }
    } catch {
      /* ignore */
    }
  };

  /** Apply a key to session state. Returns true if a redraw is warranted. */
  const applyKey = (s: Session, key: string): boolean => {
    /* ── chooser mode ────────────────────────────────────────────── */
    if (s.mode === 'chooser') {
      if (key === '1') {
        s.mode = 'plant';
        s.plantScreen = 'console';
        s.plantConnectedAt = Date.now();
        return true;
      }
      if (key === '2') {
        s.mode = 'summary';
        s.screen = 'overview';
        return true;
      }
      if (key === 'left' || key === 'right') {
        s.chooser.highlight = s.chooser.highlight === 0 ? 1 : 0;
        return true;
      }
      if (key === 'enter') {
        if (s.chooser.highlight === 0) {
          s.mode = 'plant';
          s.plantScreen = 'console';
          s.plantConnectedAt = Date.now();
        } else {
          s.mode = 'summary';
          s.screen = 'overview';
        }
        return true;
      }
      return false;
    }

    /* ── universal: TAB returns to chooser ──────────────────────── */
    if (key === '\t' || key === 'tab') {
      s.mode = 'chooser';
      return true;
    }

    /* ── plant mode ─────────────────────────────────────────────── */
    if (s.mode === 'plant') {
      if (key.length === 1 && key >= '1' && key <= String(PLANT_SCREENS.length)) {
        const next = PLANT_SCREENS[Number(key) - 1];
        if (next !== s.plantScreen) {
          s.plantScreen = next;
          s.plantAlmScroll = 0;
        }
        return true;
      }
      if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
        if (s.plantScreen === 'gen') {
          const count = Math.max(1, getDpus(store.get()).length);
          if (key === 'left') s.plantGenSel = (s.plantGenSel - 1 + count) % count;
          else if (key === 'right') s.plantGenSel = (s.plantGenSel + 1) % count;
          else if (key === 'up') s.plantGenPack = (s.plantGenPack + 4) % 5;
          else if (key === 'down') s.plantGenPack = (s.plantGenPack + 1) % 5;
          return true;
        }
        if (s.plantScreen === 'alm') {
          if (key === 'up') s.plantAlmScroll = Math.max(0, s.plantAlmScroll - 1);
          else if (key === 'down') s.plantAlmScroll += 1;
          return true;
        }
      }
      return false;
    }

    /* ── summary mode (legacy, unchanged) ───────────────────────── */
    if (key.length === 1 && key >= '1' && key <= String(SCREENS.length)) {
      const next = SCREENS[Number(key) - 1];
      if (next !== s.screen) {
        s.screen = next;
        s.alertScroll = 0;
      }
      return true;
    }
    if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
      if (s.screen === 'battery') {
        const count = Math.max(1, getDpus(store.get()).length);
        if (key === 'left') s.battDpu = (s.battDpu - 1 + count) % count;
        else if (key === 'right') s.battDpu = (s.battDpu + 1) % count;
        else if (key === 'up') s.battPack = (s.battPack + 4) % 5;
        else if (key === 'down') s.battPack = (s.battPack + 1) % 5;
        return true;
      }
      if (s.screen === 'alerts' || s.screen === 'predictive' || s.screen === 'shp2') {
        if (key === 'up') s.alertScroll = Math.max(0, s.alertScroll - 1);
        else if (key === 'down') s.alertScroll += 1;
        return true;
      }
    }
    return false;
  };

  const onData = (s: Session, data: Buffer) => {
    s.inbuf = s.inbuf.length ? Buffer.concat([s.inbuf, data]) : data;
    if (s.inbuf.length > 4096) s.inbuf = s.inbuf.subarray(s.inbuf.length - 64); // drop runaway garbage
    const { events, rest } = parseInput(s.inbuf);
    s.inbuf = Buffer.from(rest);
    let dirty = false;
    for (const ev of events) {
      if (ev.type === 'naws') {
        if (ev.w > 0 && ev.h > 0) {
          s.width = clamp(ev.w, 60, 200);
          s.height = clamp(ev.h, 16, 80);
          dirty = true;
        }
      } else {
        if (ev.key === 'ctrl-c' || ev.key === 'q' || ev.key === 'Q') {
          endSession(s);
          return;
        }
        if (applyKey(s, ev.key)) dirty = true;
      }
    }
    if (dirty) draw(s);
  };

  const server = createServer((socket) => {
    socket.setNoDelay(true);
    const s: Session = {
      socket,
      width: 80,
      height: 24,
      mode: 'chooser',
      screen: 'overview',
      battDpu: 0,
      battPack: 0,
      alertScroll: 0,
      plantScreen: 'console',
      plantGenSel: 0,
      plantGenPack: 0,
      plantAlmScroll: 0,
      plantConnectedAt: Date.now(),
      chooser: defaultChooserState(80, 24),
      inbuf: Buffer.alloc(0),
      timer: null,
      drawing: false,
      drawPending: false,
      lastFrameHash: '',
    };
    sessions.add(s);
    log(`telnet: client connected from ${socket.remoteAddress ?? '?'} (${sessions.size} active)`);

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
    safeWrite(s, ENTER_ALT_BUFFER + HIDE_CURSOR + CLEAR_SCREEN);
    draw(s);
    s.timer = setInterval(() => draw(s), 1000);

    // node:net never delivers strings on a socket without setEncoding(); the
    // @types/node ≥ 22.19 union of `string | Buffer` is a theoretical-only
    // possibility for our setup, so coerce to keep the inner signature tight.
    socket.on('data', (d) => onData(s, d as Buffer));
    socket.on('close', () => endSession(s));
    socket.on('error', () => endSession(s));
  });

  server.on('error', (e: any) => log(`telnet: server error: ${e?.message ?? e}`));
  server.listen(port, host);

  return {
    stop: () => {
      stopped = true;
      clearInterval(totalsTimer);
      if (forecastTimer) clearTimeout(forecastTimer);
      for (const s of [...sessions]) endSession(s);
      server.close();
    },
  };
}
