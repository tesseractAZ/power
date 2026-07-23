/**
 * Transport-agnostic control-room TUI session driver.
 *
 * v0.67.0 — extracted from `telnet/server.ts` so the per-session render/input
 * state machine can be reused by BOTH transports:
 *
 *   • the raw telnet TCP server (`server.ts`), which speaks telnet IAC
 *     negotiation + NAWS and feeds parsed `InputEvent`s in here; and
 *   • a browser WebSocket transport (`wsConsole.ts`, served at /console),
 *     which runs xterm.js in character mode — NO telnet IAC — and feeds the
 *     same `InputEvent`s.
 *
 * The driver knows nothing about sockets. It takes:
 *   • a `write(data: string)` sink (the transport pipes this to the wire);
 *   • a `data` provider for the shared, periodically-refreshed caches
 *     (totals/forecast/degradation) + the store/recorder; and
 *   • an initial size.
 *
 * It owns: the session view-state (mode/screen/selection/scroll), the
 * frame-hash anti-flicker, the draw-serialization (no overlapping writes),
 * and the key→state-transition logic. The transports own: byte parsing,
 * connection lifecycle, and any protocol negotiation.
 *
 * Behaviour is byte-for-byte identical to the pre-extraction telnet server:
 * the same `renderPlant`/`renderLogin` calls, the same frame
 * body assembly (HIDE_CURSOR + CURSOR_HOME + per-line CLEAR_EOL + CLEAR_BELOW),
 * the same FNV-1a frame hash, and the same BEGIN_SYNC/END_SYNC wrapping.
 */

import type { SnapshotStore } from '../snapshot.js';
import type { Recorder } from '../recorder.js';
import type { FleetEnergyTotals } from '../aggregator.js';
import type { DayForecast, FleetDegradation } from '../analytics.js';
import { renderPlant, PLANT_SCREENS } from './plant/index.js';
import type { PlantScreenId, PlantView } from './plant/index.js';
import { getDpus } from './plant/data.js';
import { renderLogin } from './login.js';
import type { LoginViewState } from './login.js';
import { timingSafeEqual } from 'node:crypto';
import {
  HIDE_CURSOR, CURSOR_HOME, CLEAR_EOL, CLEAR_BELOW,
  BEGIN_SYNC, END_SYNC,
} from './ansi.js';

/** A parsed terminal input event, independent of transport encoding. */
export type InputEvent =
  | { type: 'key'; key: string }
  | { type: 'naws'; w: number; h: number };

/**
 * v1.46.0 — single-console session. The v0.9.13 chooser + legacy Summary
 * console are removed: the Plant Operator console IS the interface, so every
 * connection lands on the same screens, the render code has one theme to
 * maintain, and the full terminal is spent on the console itself. When
 * operator credentials are configured (`TUI_PASSWORD` non-empty) the session
 * starts in 'auth' and must pass the login prompt; with no password set the
 * session opens straight into the console (the login layer is opt-in, exactly
 * like the notification channels).
 */
type SessionMode = 'auth' | 'plant';

/** Login attempts before the transport is told to disconnect. */
const AUTH_MAX_ATTEMPTS = 3;
/** Input-length cap for either credential field. */
const AUTH_FIELD_MAX = 64;

/**
 * Constant-time credential compare. Both sides are copied into fixed-length
 * buffers before `timingSafeEqual`, so neither content nor length leaks
 * through timing. This is a COMPARISON, not storage — the reference value is
 * the operator's configured option, never a persisted hash — so no KDF is
 * involved (and none would add anything here). Inputs beyond the fixed length
 * cannot occur: the prompt caps fields at AUTH_FIELD_MAX and the compare
 * truncates defensively.
 */
const CRED_CMP_LEN = 256;
function credentialEqual(a: string, b: string): boolean {
  const pa = Buffer.alloc(CRED_CMP_LEN);
  const pb = Buffer.alloc(CRED_CMP_LEN);
  pa.write(a.slice(0, CRED_CMP_LEN), 'utf8');
  pb.write(b.slice(0, CRED_CMP_LEN), 'utf8');
  return timingSafeEqual(pa, pb);
}

/**
 * Cross-session failed-login throttle. The per-session 3-attempt limit does
 * not bound a reconnect loop (3 tries per connection, unlimited connections),
 * so failures are also counted globally in a sliding window; while the window
 * is saturated every submit is refused outright. Shared by both transports.
 */
const AUTH_THROTTLE_WINDOW_MS = 10 * 60_000;
const AUTH_THROTTLE_MAX_FAILURES = 10;
let authFailureTimes: number[] = [];
function authThrottled(now: number): boolean {
  authFailureTimes = authFailureTimes.filter((t) => now - t < AUTH_THROTTLE_WINDOW_MS);
  return authFailureTimes.length >= AUTH_THROTTLE_MAX_FAILURES;
}
function noteAuthFailure(now: number): void {
  authFailureTimes.push(now);
}
export function _resetAuthThrottleForTest(): void {
  authFailureTimes = [];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Live, shared data the driver reads on each render. These are getters because
 * the telnet/WS transports both read from the SAME periodically-refreshed
 * caches owned by the telnet server (the energy integration + forecast +
 * degradation are too heavy to recompute on every 1 s frame).
 */
export interface TuiDataProvider {
  store: SnapshotStore;
  recorder: Recorder;
  /** Most recent fleet energy totals, or null until the fleet is discovered. */
  totals(): FleetEnergyTotals | null;
  /** Most recent day-ahead forecast, or null until the first refresh lands. */
  forecast(): DayForecast | null;
  /** Most recent capacity-fade degradation report, or null until first refresh. */
  degradation(): FleetDegradation | null;
  /** Captured once at server start so the Plant header can show SYS.UPTIME. */
  serverStartedAt: number;
}

export interface TuiSessionOptions {
  /** Transport sink — the driver writes ANSI frames here. */
  write: (data: string) => void;
  /** Live data accessors shared across all sessions. */
  data: TuiDataProvider;
  /** Initial terminal size. */
  width?: number;
  height?: number;
  /**
   * v1.46.0 — operator credentials. `null`/absent password ⇒ login disabled
   * (the session opens straight into the console). Injectable for tests; the
   * transports pass the add-on options via `authFromEnv()`.
   */
  auth?: { username: string; password: string } | null;
}

/** Resolve the login gate from the add-on options (env). Empty password ⇒ off. */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): { username: string; password: string } | null {
  const password = (env.TUI_PASSWORD ?? '').trim();
  if (password.length === 0) return null;
  const username = (env.TUI_USERNAME ?? '').trim() || 'operator';
  return { username, password };
}

/**
 * v1.47.1 (full-pass) — the login prompt can only ever TYPE printable ASCII
 * (both transports emit keys for bytes 0x20-0x7E) capped at AUTH_FIELD_MAX
 * chars, but the options schema accepts any string. A password outside that
 * envelope is a guaranteed lockout: every submit fails until the throttle
 * saturates. Returns the problems for the caller to log at startup — loudly,
 * once — rather than letting the operator discover it at the prompt.
 */
export function authConfigProblems(auth: { username: string; password: string } | null): string[] {
  if (!auth) return [];
  const out: string[] = [];
  for (const [label, v] of [['TUI_USERNAME', auth.username], ['TUI_PASSWORD', auth.password]] as const) {
    if (v.length > AUTH_FIELD_MAX) out.push(`${label} is ${v.length} chars — the login prompt accepts at most ${AUTH_FIELD_MAX}; this credential can never be typed`);
    if (!/^[\x20-\x7e]*$/.test(v)) out.push(`${label} contains non-ASCII characters — the login prompt only accepts printable ASCII; this credential can never be typed`);
  }
  return out;
}

/**
 * One TUI session: the render/input state machine. Construct one per
 * connection; drive it with `feed()`, `resize()`, and the 1 Hz `draw()` tick.
 */
export class TuiSession {
  private readonly write: (data: string) => void;
  private readonly data: TuiDataProvider;

  width: number;
  height: number;
  private mode: SessionMode;

  /** AUTH mode state (only meaningful while mode === 'auth'). */
  private readonly auth: { username: string; password: string } | null;
  private login: LoginViewState = { stage: 'username', user: '', passLen: 0, attemptsLeft: AUTH_MAX_ATTEMPTS, error: null };
  private loginPass = '';

  /** PLANT mode state. */
  private plantScreen: PlantScreenId = 'console';
  private plantGenSel = 0;
  private plantGenPack = 0;
  private plantAlmScroll = 0;
  private plantConnectedAt = Date.now();

  /** v0.9.5 — true while a frame is being written; prevents overlapping draws
   *  from interleaving (e.g. a resize event triggering a mid-frame redraw on
   *  top of the periodic 1 s redraw). Cleared as soon as write returns. */
  private drawing = false;
  /** v0.9.5 — a redraw was requested while drawing was in flight; honor it
   *  immediately after the current frame finishes so user input still feels
   *  instant without ever overlapping writes. */
  private drawPending = false;
  /** v0.9.16 — hash of the last successfully-written frame body. When the next
   *  render produces the same body, we skip the write entirely (zero bandwidth,
   *  zero repaint, zero flicker). */
  private lastFrameHash = '';

  constructor(opts: TuiSessionOptions) {
    this.write = opts.write;
    this.data = opts.data;
    this.width = opts.width ?? 80;
    this.height = opts.height ?? 24;
    this.auth = opts.auth ?? null;
    this.mode = this.auth ? 'auth' : 'plant';
    this.plantConnectedAt = Date.now();
  }

  /** True once the session has passed (or never needed) the login gate. */
  get isInteractive(): boolean {
    return this.mode === 'plant';
  }

  /**
   * Set the terminal size. Clamps to the supported range. Returns true if the
   * size changed (caller should redraw).
   */
  resize(w: number, h: number): boolean {
    if (!(w > 0 && h > 0)) return false;
    const nw = clamp(w, 60, 200);
    const nh = clamp(h, 16, 80);
    if (nw === this.width && nh === this.height) return false;
    this.width = nw;
    this.height = nh;
    return true;
  }

  /**
   * Apply a batch of parsed input events. Returns one of:
   *   • { redraw: true }   — state changed, the transport should `draw()`;
   *   • { quit: true }     — the user asked to disconnect (ctrl-c / q);
   *   • { }                — nothing to do.
   * Resize events are applied here too (the telnet transport delivers window
   * size via NAWS; the WS transport via a synthetic 'naws' event).
   */
  feed(events: InputEvent[]): { redraw?: boolean; quit?: boolean } {
    let dirty = false;
    for (const ev of events) {
      if (ev.type === 'naws') {
        if (this.resize(ev.w, ev.h)) dirty = true;
      } else {
        // ctrl-c always disconnects; 'q' only once past the login prompt — a
        // username or password may legitimately contain the letter q.
        if (ev.key === 'ctrl-c' || (this.mode === 'plant' && (ev.key === 'q' || ev.key === 'Q'))) {
          return { quit: true };
        }
        if (this.mode === 'auth') {
          const r = this.applyAuthKey(ev.key);
          if (r === 'denied') return { quit: true };
          if (r) dirty = true;
          continue;
        }
        if (this.applyKey(ev.key)) dirty = true;
      }
    }
    return dirty ? { redraw: true } : {};
  }

  /** Apply a key to session state. Returns true if a redraw is warranted. */
  private applyKey(key: string): boolean {
    /* ── TAB cycles to the next console screen (the chooser it used to
       return to no longer exists). */
    if (key === '\t' || key === 'tab') {
      const idx = PLANT_SCREENS.indexOf(this.plantScreen);
      this.plantScreen = PLANT_SCREENS[(idx + 1) % PLANT_SCREENS.length];
      this.plantAlmScroll = 0;
      return true;
    }

    /* ── plant mode ─────────────────────────────────────────────── */
    if (this.mode === 'plant') {
      if (key.length === 1 && key >= '1' && key <= String(PLANT_SCREENS.length)) {
        const next = PLANT_SCREENS[Number(key) - 1];
        if (next !== this.plantScreen) {
          this.plantScreen = next;
          this.plantAlmScroll = 0;
        }
        return true;
      }
      if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
        if (this.plantScreen === 'gen') {
          const dpus = getDpus({ snap: this.data.store.get() } as Parameters<typeof getDpus>[0]);
          const count = Math.max(1, dpus.length);
          // v1.47.1 (full-pass) — a DPU change invalidates the pack index (a
          // 2-pack unit after a 5-pack unit rendered "Pack 5/2" with no
          // highlighted row); the renderer also clamps defensively.
          if (key === 'left') { this.plantGenSel = (this.plantGenSel - 1 + count) % count; this.plantGenPack = 0; }
          else if (key === 'right') { this.plantGenSel = (this.plantGenSel + 1) % count; this.plantGenPack = 0; }
          else {
            // r27 — pack count is per-DPU (a DPU can report 1-5 packs), not a
            // fixed 5: the old hardcoded `% 5` let the selector land on a
            // phantom slot with no pack behind it on a <5-pack DPU. Mirrors the
            // count-aware pattern already used for plantGenSel above.
            const packCount = Math.max(1, dpus[this.plantGenSel]?.projection?.packs.length ?? 1);
            if (key === 'up') this.plantGenPack = (this.plantGenPack - 1 + packCount) % packCount;
            else if (key === 'down') this.plantGenPack = (this.plantGenPack + 1) % packCount;
          }
          return true;
        }
        if (this.plantScreen === 'alm') {
          if (key === 'up') this.plantAlmScroll = Math.max(0, this.plantAlmScroll - 1);
          else if (key === 'down') this.plantAlmScroll += 1;
          return true;
        }
      }
      return false;
    }

    return false;
  }

  /* ── v1.46.0 — login state machine ─────────────────────────────────
   * Printable keys type into the active field, backspace edits, ENTER
   * advances username → password → verify. TAB jumps between fields.
   * A rejected attempt clears the password and burns one attempt; the
   * third rejection returns 'denied' and the transport disconnects. */
  private applyAuthKey(key: string): boolean | 'denied' {
    const st = this.login;
    if (key === 'enter') {
      if (st.stage === 'username') {
        st.stage = 'password';
        return true;
      }
      const now = Date.now();
      if (authThrottled(now)) {
        // Saturated window: refuse outright — no oracle, no more attempts.
        return 'denied';
      }
      // v1.47.1 (full-pass) — evaluate BOTH compares unconditionally: the
      // short-circuit skipped the password compare on a wrong username,
      // re-opening exactly the field-level timing oracle the fixed-length
      // compare exists to prevent.
      const userOk = this.auth != null && credentialEqual(st.user, this.auth.username);
      const passOk = this.auth != null && credentialEqual(this.loginPass, this.auth.password);
      const ok = userOk && passOk;
      if (ok) {
        this.mode = 'plant';
        this.plantScreen = 'console';
        this.plantConnectedAt = Date.now();
        this.loginPass = '';
        this.lastFrameHash = ''; // force a full repaint into the console
        return true;
      }
      noteAuthFailure(now);
      st.attemptsLeft -= 1;
      if (st.attemptsLeft <= 0) return 'denied';
      st.error = 'ACCESS DENIED';
      st.stage = 'username';
      st.user = '';
      st.passLen = 0;
      this.loginPass = '';
      return true;
    }
    if (key === '\t' || key === 'tab') {
      st.stage = st.stage === 'username' ? 'password' : 'username';
      return true;
    }
    if (key === 'backspace') {
      if (st.stage === 'username') st.user = st.user.slice(0, -1);
      else { this.loginPass = this.loginPass.slice(0, -1); st.passLen = this.loginPass.length; }
      return true;
    }
    if (key.length === 1 && key >= ' ' && key <= '~') {
      st.error = null;
      if (st.stage === 'username' && st.user.length < AUTH_FIELD_MAX) st.user += key;
      else if (st.stage === 'password' && this.loginPass.length < AUTH_FIELD_MAX) {
        this.loginPass += key;
        st.passLen = this.loginPass.length;
      }
      return true;
    }
    return false;
  }

  /** Build the array of frame lines for the current state. */
  private renderLines(): string[] {
    const d = this.data;
    if (this.mode === 'auth') {
      return renderLogin(this.login, this.width, this.height);
    }
    const pv: PlantView = {
      width: this.width,
      height: this.height,
      screen: this.plantScreen,
      genSel: this.plantGenSel,
      genPack: this.plantGenPack,
      almScroll: this.plantAlmScroll,
      connectedAt: this.plantConnectedAt,
    };
    return renderPlant(pv, {
      snap: d.store.get(),
      totals: d.totals(),
      forecast: d.forecast(),
      // v0.9.50 — read from the timer-refreshed cache instead of calling the
      // now-async computeDegradation inline. Empty placeholder until the
      // first refresh lands (a few seconds after server start).
      degradation: d.degradation() ?? { generatedAt: Date.now(), eolSoh: 80, packs: [] },
      serverStartedAt: d.serverStartedAt,
    }, { recorder: d.recorder });
  }

  /**
   * Render + write one frame. Serializes against any in-flight write and
   * skips the write when the frame body is byte-identical to the previous one.
   */
  draw(): void {
    // v0.9.5 — serialize frames. If a draw is already in flight, mark a
    // pending redraw and bail. The completing frame will run the pending one
    // on its way out. Eliminates the "two writes racing into the same ANSI
    // stream" class of glitch.
    if (this.drawing) {
      this.drawPending = true;
      return;
    }
    this.drawing = true;
    this.drawPending = false;
    try {
      const lines = this.renderLines();

      // v0.9.16 — build the FRAME BODY (without sync escapes) and hash it.
      //   • CURSOR_HOME at the top, per-line CLEAR_EOL, trailing CLEAR_BELOW
      //     together cover every transition cleanly without a blank-and-repaint.
      //   • If the new body is byte-identical to the previous one, skip the
      //     write entirely.
      let body = HIDE_CURSOR + CURSOR_HOME;
      for (let i = 0; i < lines.length; i++) {
        body += lines[i] + CLEAR_EOL;
        if (i < lines.length - 1) body += '\r\n';
      }
      body += CLEAR_BELOW;

      // Cheap stable 32-bit FNV-1a hash of the body — plenty discriminative
      // for a ~2-4 KB UTF-8 string, and avoids node:crypto on the hot path.
      let hash = 2166136261;
      for (let i = 0; i < body.length; i++) {
        hash ^= body.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
      }
      const hashStr = hash.toString(36);
      if (hashStr === this.lastFrameHash) {
        // Identical frame — no write, no terminal work, no flicker.
        return;
      }
      this.lastFrameHash = hashStr;
      // v0.9.5 — wrap each frame in synchronized-output escapes so terminals
      // that support mode 2026 buffer all output and flip atomically. Others
      // treat the escapes as no-ops.
      this.write(BEGIN_SYNC + body + END_SYNC);
    } finally {
      this.drawing = false;
      // Honor a pending redraw queued during this frame, on the next tick so
      // we don't grow the call stack on rapid keypress + interval coincidence.
      if (this.drawPending) {
        this.drawPending = false;
        setImmediate(() => this.draw());
      }
    }
  }
}
