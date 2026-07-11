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
 * the same `renderChooser`/`renderPlant`/`renderScreen` calls, the same frame
 * body assembly (HIDE_CURSOR + CURSOR_HOME + per-line CLEAR_EOL + CLEAR_BELOW),
 * the same FNV-1a frame hash, and the same BEGIN_SYNC/END_SYNC wrapping.
 */

import type { SnapshotStore } from '../snapshot.js';
import type { Recorder } from '../recorder.js';
import type { FleetEnergyTotals } from '../aggregator.js';
import type { DayForecast, FleetDegradation } from '../analytics.js';
import { renderScreen, SCREENS, getDpus } from './screens.js';
import type { ScreenId, SessionView } from './screens.js';
import { renderPlant, PLANT_SCREENS } from './plant/index.js';
import type { PlantScreenId, PlantView } from './plant/index.js';
import { renderChooser, defaultChooserState } from './plant/chooser.js';
import type { ChooserState } from './plant/chooser.js';
import {
  HIDE_CURSOR, CURSOR_HOME, CLEAR_EOL, CLEAR_BELOW,
  BEGIN_SYNC, END_SYNC,
} from './ansi.js';

/** A parsed terminal input event, independent of transport encoding. */
export type InputEvent =
  | { type: 'key'; key: string }
  | { type: 'naws'; w: number; h: number };

/**
 * v0.9.13 — session mode. On connect we show the chooser; the user picks a
 * console with [1] (Plant Operator) or [2] (Summary). TAB from any non-chooser
 * view returns to the chooser.
 */
type SessionMode = 'chooser' | 'plant' | 'summary';

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
  private mode: SessionMode = 'chooser';

  /** SUMMARY mode state (legacy screens). */
  private screen: ScreenId = 'overview';
  private battDpu = 0;
  private battPack = 0;
  private battScroll = 0;
  private alertScroll = 0;

  /** PLANT mode state. */
  private plantScreen: PlantScreenId = 'console';
  private plantGenSel = 0;
  private plantGenPack = 0;
  private plantAlmScroll = 0;
  private plantConnectedAt = Date.now();

  /** CHOOSER mode state. */
  private chooser: ChooserState;

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
    this.chooser = defaultChooserState(this.width, this.height);
  }

  /** True once the user has left the chooser (used to surface a busy state). */
  get isInteractive(): boolean {
    return this.mode !== 'chooser';
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
        if (ev.key === 'ctrl-c' || ev.key === 'q' || ev.key === 'Q') {
          return { quit: true };
        }
        if (this.applyKey(ev.key)) dirty = true;
      }
    }
    return dirty ? { redraw: true } : {};
  }

  /** Apply a key to session state. Returns true if a redraw is warranted. */
  private applyKey(key: string): boolean {
    /* ── chooser mode ────────────────────────────────────────────── */
    if (this.mode === 'chooser') {
      if (key === '1') {
        this.mode = 'plant';
        this.plantScreen = 'console';
        this.plantConnectedAt = Date.now();
        return true;
      }
      if (key === '2') {
        this.mode = 'summary';
        this.screen = 'overview';
        return true;
      }
      if (key === 'left' || key === 'right') {
        this.chooser.highlight = this.chooser.highlight === 0 ? 1 : 0;
        return true;
      }
      if (key === 'enter') {
        if (this.chooser.highlight === 0) {
          this.mode = 'plant';
          this.plantScreen = 'console';
          this.plantConnectedAt = Date.now();
        } else {
          this.mode = 'summary';
          this.screen = 'overview';
        }
        return true;
      }
      return false;
    }

    /* ── universal: TAB returns to chooser ──────────────────────── */
    if (key === '\t' || key === 'tab') {
      this.mode = 'chooser';
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
          const dpus = getDpus(this.data.store.get());
          const count = Math.max(1, dpus.length);
          if (key === 'left') this.plantGenSel = (this.plantGenSel - 1 + count) % count;
          else if (key === 'right') this.plantGenSel = (this.plantGenSel + 1) % count;
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

    /* ── summary mode (legacy, unchanged) ───────────────────────── */
    if (key.length === 1 && key >= '1' && key <= String(SCREENS.length)) {
      const next = SCREENS[Number(key) - 1];
      if (next !== this.screen) {
        this.screen = next;
        this.alertScroll = 0;
        this.battScroll = 0;
      }
      return true;
    }
    if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
      if (this.screen === 'battery') {
        const count = Math.max(1, getDpus(this.data.store.get()).length);
        if (key === 'left') this.battDpu = (this.battDpu - 1 + count) % count;
        else if (key === 'right') this.battDpu = (this.battDpu + 1) % count;
        else if (key === 'up') this.battPack = (this.battPack + 4) % 5;
        else if (key === 'down') this.battPack = (this.battPack + 1) % 5;
        // v1.4.0 (audit rank 5) — a different DPU/pack swaps in an entirely different
        // detail body; any prior scroll offset into the old body is stale.
        this.battScroll = 0;
        return true;
      }
      if (this.screen === 'alerts' || this.screen === 'predictive' || this.screen === 'shp2' || this.screen === 'strategy') {
        if (key === 'up') this.alertScroll = Math.max(0, this.alertScroll - 1);
        else if (key === 'down') this.alertScroll += 1;
        return true;
      }
    }
    // v1.4.0 (audit rank 5) — BATTERY's own ↑/↓/←/→ are already claimed by pack/DPU
    // navigation above, so the pack-detail pane (VITALS/LIFETIME/thermal grids/32 CELL
    // VOLTAGES — see packDetail() in screens.ts) scrolls on [ / ] instead of the other
    // paginated screens' ↑/↓; reusing ↑/↓ here would silently steal DPU/pack navigation.
    if (this.screen === 'battery' && (key === '[' || key === ']')) {
      this.battScroll = key === '[' ? Math.max(0, this.battScroll - 1) : this.battScroll + 1;
      return true;
    }
    return false;
  }

  /** Build the array of frame lines for the current state. */
  private renderLines(): string[] {
    const d = this.data;
    if (this.mode === 'chooser') {
      this.chooser.width = this.width;
      this.chooser.height = this.height;
      return renderChooser(this.chooser);
    }
    if (this.mode === 'plant') {
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
    const sv: SessionView = {
      width: this.width,
      height: this.height,
      screen: this.screen,
      battDpu: this.battDpu,
      battPack: this.battPack,
      battScroll: this.battScroll,
      alertScroll: this.alertScroll,
    };
    return renderScreen(sv, {
      snap: d.store.get(),
      totals: d.totals(),
      forecast: d.forecast(),
      degradation: d.degradation() ?? { generatedAt: Date.now(), eolSoh: 80, packs: [] },
    });
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
