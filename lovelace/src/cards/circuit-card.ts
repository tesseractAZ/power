import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { EcoflowCardBase, type EcoflowCardConfig } from '../shared/base-card.js';
import { themeCss } from '../shared/theme.css.js';
import { glossary } from '../shared/glossary.js';
import { fmtW, fmtWh } from '../shared/format.js';
import { sparkline, type ChartPoint } from '../shared/charts.js';
import type {
  CircuitHistory,
  DeviceSnapshot,
  Shp2Circuit,
  Shp2PairedCircuit,
  Shp2Projection,
} from '../shared/types.js';
import type { ConnectionState } from '../shared/snapshot-store.js';
// Side-effect imports register the primitive custom elements.
import '../shared/primitives/ef-badge.js';
import '../shared/primitives/ef-tile.js';
import '../shared/primitives/ef-section.js';

/**
 * Lit port of `web/src/components/CircuitModal.tsx` reshaped from a popover
 * into a standalone Lovelace card. The React modal was triggered by clicking
 * a tile inside Shp2Card; in HA the popover UX doesn't translate, so each
 * circuit drill-down is wired up as its own card with a `circuit:` config.
 *
 * Layout (single `<ha-card>`):
 *
 *   1. Header — badge (`live` / stale), circuit number, friendly name, breaker
 *      amperage, link/split-phase note.
 *   2. Headline tiles — Now W · Peak 24h · Today kWh.
 *   3. 24-h power history sparkline (60s polled from /api/history).
 *   4. Lifetime + cost section — totals across `/api/circuit/history?days=30`,
 *      with optional $/kWh from `cost_per_kwh` (defaults to $0.17 — Phoenix
 *      APS residential average; pass any value to override).
 *   5. Pairing section — only when the configured leg is split-phase, showing
 *      combined-now and combined-today.
 *
 * Config (extends EcoflowCardConfig with one required field):
 *
 *   type: custom:ecoflow-circuit-card
 *   host: http://homeassistant.local:8787
 *   circuit: 10           # SHP2 circuit number, 1-12
 *   title: Pool Pump      # optional override
 *   refresh_seconds: 60   # optional, default 60 for the history poll
 *   cost_per_kwh: 0.17    # optional $/kWh for the lifetime cost calc
 */

/** Card-specific config — extends the base with circuit and cost fields. */
export interface EcoflowCircuitCardConfig extends EcoflowCardConfig {
  circuit: number;
  cost_per_kwh?: number;
}

/** Wrapper around an HTTP-fetched payload that tracks staleness. */
interface CachedResource<T> {
  data: T | null;
  stale: boolean;
}
const EMPTY_CACHE = <T>(): CachedResource<T> => ({ data: null, stale: false });

/** Default $/kWh applied when the operator hasn't overridden it. */
const DEFAULT_COST_PER_KWH = 0.17;

/** Days of multi-day history we pull for the lifetime/cost summary. */
const HISTORY_DAYS = 30;

/** Setup-error stash, surfaced via a render path when `setConfig` rejected. */
interface SetupError {
  message: string;
  hint: string;
}

@customElement('ecoflow-circuit-card')
export class EcoflowCircuitCard extends EcoflowCardBase {
  // Narrowed config; `circuit` is required so we cast in the getters below.
  declare config?: EcoflowCircuitCardConfig;

  @state() private history24: CachedResource<{ points: ChartPoint[] }> = EMPTY_CACHE();
  @state() private historyMulti: CachedResource<CircuitHistory> = EMPTY_CACHE();
  @state() private setupError: SetupError | null = null;

  private _httpTimer: ReturnType<typeof setInterval> | null = null;

  // CSS compacted to keep the file under the 700-line ceiling. Selectors and
  // tokens match the sibling cards (battery/solar/alerts) so the dashboard
  // reads as a coherent set.
  static styles = [
    themeCss,
    css`
      :host { display: block; }
      ha-card { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
      .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
      .title { font-size: 1.1rem; font-weight: 600; color: var(--ef-ink); }
      .subtitle { font-size: 0.75rem; color: var(--ef-muted); margin-top: 2px; }
      .badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .skeleton { padding: 20px; text-align: center; color: var(--ef-muted); font-size: 0.85rem; }
      .skeleton .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ef-accent); margin-right: 6px; animation: ef-pulse 1.2s ease-in-out infinite; }
      @keyframes ef-pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
      .error { padding: 14px; border: 1px solid color-mix(in srgb, var(--ef-bad) 40%, var(--ef-line)); background: color-mix(in srgb, var(--ef-bad) 8%, var(--ef-panel)); border-radius: 8px; color: var(--ef-ink); font-size: 0.85rem; line-height: 1.4; }
      .error strong { color: var(--ef-bad); }
      .error code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.8rem; background: color-mix(in srgb, var(--ef-line) 60%, transparent); padding: 1px 4px; border-radius: 4px; }
      .error pre { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.78rem; background: var(--ef-panel); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--ef-line); margin: 8px 0 0; white-space: pre-wrap; }
      .tiles-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; width: 100%; }
      .full { width: 100%; }
      .chart-wrap { width: 100%; padding: 4px 0; }
      .chart-meta { font-size: 0.72rem; color: var(--ef-muted); margin-top: 4px; display: flex; flex-wrap: wrap; gap: 12px; }
      .kv { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.85rem; color: var(--ef-ink); padding: 2px 0; }
      .kv .k { color: var(--ef-muted); font-size: 0.78rem; }
      .kv .v { font-variant-numeric: tabular-nums; font-weight: 600; }
      .pairing-note { font-size: 0.78rem; color: var(--ef-muted); margin-top: 4px; }
    `,
  ];

  // ───────────────────────── config validation ─────────────────────────

  /**
   * Override base setConfig to require + validate `circuit`. Lovelace catches
   * thrown errors here and renders them inline in the card editor, so this is
   * the primary surface for "you forgot to add `circuit:` to the YAML."
   *
   * On *real* validation failures we re-throw so the editor surfaces them.
   * For the case where we want the card to render an inline error in the
   * dashboard (e.g. circuit number that doesn't exist on the live SHP2),
   * we set `this.setupError` and let `render()` handle it.
   */
  setConfig(config: EcoflowCircuitCardConfig) {
    if (!config) throw new Error('Invalid config: missing config object');
    if (config.circuit == null) {
      throw new Error(
        'circuit is required — add `circuit: <1-12>` to the card YAML (SHP2 channel number)',
      );
    }
    if (typeof config.circuit !== 'number' || !Number.isFinite(config.circuit)) {
      throw new Error('circuit must be a number (got ' + JSON.stringify(config.circuit) + ')');
    }
    if (!Number.isInteger(config.circuit) || config.circuit < 1 || config.circuit > 12) {
      throw new Error('circuit must be an integer between 1 and 12 (got ' + config.circuit + ')');
    }
    if (config.cost_per_kwh != null) {
      if (typeof config.cost_per_kwh !== 'number' || !Number.isFinite(config.cost_per_kwh) || config.cost_per_kwh < 0) {
        throw new Error('cost_per_kwh must be a non-negative number (got ' + JSON.stringify(config.cost_per_kwh) + ')');
      }
    }
    // All good — defer to base for host/title/refresh defaults, then layer
    // the card-specific fields on top.
    super.setConfig(config);
    this.config = {
      ...(this.config as EcoflowCardConfig),
      circuit: config.circuit,
      cost_per_kwh: config.cost_per_kwh,
    } as EcoflowCircuitCardConfig;
    this.setupError = null;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  connectedCallback() {
    super.connectedCallback();
    // Charts default to 60 s refresh (a hair slower than the base WS push so
    // the snapshot-driven "Now" tile already updates between fetches).
    const refreshSec = Math.max(15, this.config?.refresh_seconds ?? 60);
    this._kickHttp();
    this._httpTimer = setInterval(() => this._kickHttp(), refreshSec * 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._httpTimer) {
      clearInterval(this._httpTimer);
      this._httpTimer = null;
    }
  }

  /**
   * Pull the 24-h history series + the multi-day rollup. We need the SHP2 SN
   * and the metric name first, so we bail when the snapshot hasn't told us
   * which SHP2 to talk to yet — the next snapshot tick re-triggers a fetch
   * via update().
   */
  private _kickHttp() {
    const ctx = this.circuitContext();
    if (!ctx) return;
    const { sn, circuit, pair } = ctx;
    const useCombined = !!pair && pair.isSplitPhase && pair.secondaryCh != null;
    const seriesMetric = useCombined ? `pair${pair!.primaryCh}_w` : `ch${circuit.ch}_w`;
    const histQuery = useCombined ? `pair=${pair!.primaryCh}` : `ch=${circuit.ch}`;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    void this._fetch<{ points: ChartPoint[] }>(
      `/api/history?sn=${encodeURIComponent(sn)}&metric=${encodeURIComponent(seriesMetric)}&since=${since}&bucket=120`,
      () => this.history24,
      (r) => (this.history24 = r),
    );
    void this._fetch<CircuitHistory>(
      `/api/circuit/history?sn=${encodeURIComponent(sn)}&${histQuery}&days=${HISTORY_DAYS}`,
      () => this.historyMulti,
      (r) => (this.historyMulti = r),
    );
  }

  private async _fetch<T>(
    path: string,
    get: () => CachedResource<T>,
    set: (r: CachedResource<T>) => void,
  ): Promise<void> {
    try {
      const url = this.effectiveHost().replace(/\/$/, '') + path;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set({ data: (await res.json()) as T, stale: false });
    } catch {
      // Keep last good payload; flag stale so the badge appears.
      set({ ...get(), stale: true });
    }
  }

  /** Triggered when @state changes — kick a fetch the first time the WS
   *  snapshot resolves so we don't wait a full refresh interval for the chart. */
  updated(changed: Map<string, unknown>) {
    super.updated(changed as Map<PropertyKey, unknown>);
    if (changed.has('snapshot') && this.history24.data == null && this.snapshot) {
      this._kickHttp();
    }
  }

  // ───────────────────────── helpers ─────────────────────────

  private connTone(state: ConnectionState): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
    if (state === 'open') return 'ok';
    if (state === 'connecting' || state === 'reconnecting') return 'warn';
    if (state === 'closed') return 'bad';
    return 'neutral';
  }

  private connLabel(state: ConnectionState): string {
    return state === 'open'
      ? 'live'
      : state === 'connecting'
        ? 'linking'
        : state === 'reconnecting'
          ? 'reconnecting'
          : state === 'closed'
            ? 'offline'
            : 'idle';
  }

  /** Locate the unique SHP2 device in the current snapshot, or null. */
  private findShp2(): (DeviceSnapshot & { projection: Shp2Projection }) | null {
    const snap = this.snapshot;
    if (!snap) return null;
    return (
      Object.values(snap.devices).find(
        (d): d is DeviceSnapshot & { projection: Shp2Projection } => d.projection?.kind === 'shp2',
      ) ?? null
    );
  }

  /**
   * Resolve the configured circuit number into:
   *   - the live `Shp2Circuit` row (for the primary leg)
   *   - the matching `Shp2PairedCircuit` when one exists (so split-phase
   *     drill-downs show combined kW the same way the React modal did).
   *
   * Returns null when the snapshot hasn't loaded yet OR when the circuit
   * isn't reported by the SHP2 (which the render path surfaces as an error).
   */
  private circuitContext(): {
    sn: string;
    circuit: Shp2Circuit;
    pair?: Shp2PairedCircuit;
  } | null {
    const shp2 = this.findShp2();
    const cfgCh = this.config?.circuit;
    if (!shp2 || cfgCh == null) return null;
    const circuit = shp2.projection.circuits.find((c) => c.ch === cfgCh);
    if (!circuit) return null;
    const pair = shp2.projection.pairedCircuits.find(
      (pc) => pc.primaryCh === cfgCh || pc.secondaryCh === cfgCh,
    );
    return { sn: shp2.sn, circuit, pair };
  }

  /** Trapezoidal integration over the 24 h points to get today's Wh —
   *  same logic as the React modal so the headline tile updates between
   *  60s server-history polls. */
  private todayWh(points: ChartPoint[]): number | null {
    if (points.length < 2) return null;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayMs = dayStart.getTime();
    const todayPts = points.filter((p) => p.ts >= dayMs && p.value != null);
    if (todayPts.length < 2) return 0;
    let wh = 0;
    const MAX_GAP = 10 * 60 * 1000;
    for (let i = 1; i < todayPts.length; i++) {
      const dt = todayPts[i].ts - todayPts[i - 1].ts;
      if (dt <= 0 || dt > MAX_GAP) continue;
      const a = todayPts[i - 1].value ?? 0;
      const b = todayPts[i].value ?? 0;
      wh += ((a + b) / 2) * (dt / 3_600_000);
    }
    return wh;
  }

  /** "12:34" — short clock string for peak-time annotations. */
  private fmtClock(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ───────────────────────── render ─────────────────────────

  render() {
    // Hard-stop: if setConfig wasn't called (shouldn't happen via Lovelace)
    // or recorded a deferred error, show it before anything else.
    if (this.setupError) {
      return html`<ha-card>${this.renderErrorBox(this.setupError)}</ha-card>`;
    }
    if (!this.config) {
      return html`<ha-card
        >${this.renderErrorBox({
          message: 'Card config not set',
          hint: 'Add `circuit: <1-12>` to the YAML — see card README for an example.',
        })}</ha-card
      >`;
    }

    const snap = this.snapshot;
    const title = this.config.title ?? `Circuit ${this.config.circuit}`;
    if (!snap) {
      return html`<ha-card>
        <div class="header">
          <div>
            <div class="title">${title}</div>
            <div class="subtitle">${this.effectiveHost()}</div>
          </div>
          <div class="badges">
            <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
          </div>
        </div>
        <div class="skeleton"><span class="dot"></span>Connecting to add-on…</div>
      </ha-card>`;
    }

    const shp2 = this.findShp2();
    if (!shp2) {
      return html`<ha-card>
        ${this.renderErrorBox({
          message: 'No SHP2 device found in this fleet',
          hint: 'This card needs a Smart Home Panel 2 to read circuit data from. Check that the add-on host is correct and the SHP2 is online.',
        })}
      </ha-card>`;
    }

    const ctx = this.circuitContext();
    if (!ctx) {
      const knownChs = shp2.projection.circuits.map((c) => c.ch).sort((a, b) => a - b);
      return html`<ha-card>
        ${this.renderErrorBox({
          message: `Circuit ${this.config.circuit} not reported by SHP2 ${shp2.deviceName}`,
          hint: `The SHP2 currently knows about these channels: ${knownChs.join(', ') || '—'}. Pick one of those.`,
        })}
      </ha-card>`;
    }

    return this.renderCard(ctx, shp2);
  }

  private renderErrorBox(err: SetupError): TemplateResult {
    return html`<div class="error">
      <strong>Configuration error:</strong> ${err.message}
      <div style="margin-top:6px;">${err.hint}</div>
      <pre>
type: custom:ecoflow-circuit-card
host: http://homeassistant.local:8787
circuit: 10    # SHP2 circuit number (1-12)
title: Pool Pump</pre
      >
    </div>`;
  }

  /** Main happy-path render — header, headline tiles, chart, lifetime, pairing. */
  private renderCard(
    ctx: { sn: string; circuit: Shp2Circuit; pair?: Shp2PairedCircuit },
    shp2: DeviceSnapshot & { projection: Shp2Projection },
  ): TemplateResult {
    const { circuit, pair } = ctx;
    const useCombined = !!pair && pair.isSplitPhase && pair.secondaryCh != null;
    const nowW = useCombined ? pair!.watts : circuit.watts;
    const breakerAmps = useCombined ? pair!.breakerAmps : circuit.setAmp;
    const displayName = this.config?.title ?? (useCombined ? pair!.name : circuit.name);
    const subtitle = useCombined
      ? `${shp2.deviceName} · ch ${pair!.primaryCh}+${pair!.secondaryCh} · ${breakerAmps ?? '—'}A · 240 V`
      : `${shp2.deviceName} · ch ${circuit.ch} · ${breakerAmps ?? '—'}A breaker`;
    const stale = this.history24.stale || this.historyMulti.stale;

    return html`<ha-card>
      <div class="header">
        <div>
          <div class="title">${displayName}</div>
          <div class="subtitle">${subtitle}</div>
        </div>
        <div class="badges">
          <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
          ${stale ? html`<ef-badge tone="warn">stale data</ef-badge>` : nothing}
        </div>
      </div>
      ${this.renderHeadlineRow(nowW)} ${this.renderHistorySection()}
      ${this.renderLifetimeSection()} ${this.renderPairingSection(pair, useCombined)}
    </ha-card>`;
  }

  /** Now · Today · Peak (24h) — three <ef-tile>s. */
  private renderHeadlineRow(nowW: number | null): TemplateResult {
    const pts = this.history24.data?.points ?? [];
    const values = pts.map((p) => p.value).filter((v): v is number => v != null && Number.isFinite(v));
    const peak = values.length > 0 ? Math.max(...values) : null;
    const todayWh = this.todayWh(pts);

    return html`<div class="full">
      <div class="tiles-row">
        <ef-tile label="Now" value=${fmtW(nowW)} unit="">
          <span>live</span>
        </ef-tile>
        <ef-tile label="Today" value=${fmtWh(todayWh)} unit="">
          <span>since local midnight</span>
        </ef-tile>
        <ef-tile label="Peak (24h)" value=${fmtW(peak)} unit="">
          ${this.peakSubtitle(pts)}
        </ef-tile>
      </div>
    </div>`;
  }

  /** Tucks the peak's clock time under the Peak tile when known. */
  private peakSubtitle(pts: ChartPoint[]): TemplateResult | string {
    if (pts.length === 0) return '';
    let bestTs: number | null = null;
    let bestV = -Infinity;
    for (const p of pts) {
      if (p.value == null) continue;
      if (p.value > bestV) {
        bestV = p.value;
        bestTs = p.ts;
      }
    }
    if (bestTs == null) return '';
    return html`<span>at ${this.fmtClock(bestTs)}</span>`;
  }

  /** 24-h power sparkline + a one-line annotation under it. */
  private renderHistorySection(): TemplateResult {
    const data = this.history24.data;
    if (!data) {
      return html`<ef-section .title=${'24-hour power'}>
        <div class="subtitle">${this.history24.stale ? 'History unavailable.' : 'Loading history…'}</div>
      </ef-section>`;
    }
    if (data.points.length < 2) {
      return html`<ef-section .title=${'24-hour power'}>
        <div class="subtitle">Collecting samples — chart appears once history accumulates.</div>
      </ef-section>`;
    }
    return html`<ef-section .title=${'24-hour power'}>
      <div class="full">
        <div class="chart-wrap">
          ${sparkline(data.points, { height: 120, color: 'var(--ef-ok)' })}
        </div>
        <div class="chart-meta">${this.historyAnnotation(data.points)}</div>
      </div>
    </ef-section>`;
  }

  /** "Peak 12:34 · Idle 06:00-07:30" style summary derived from the points. */
  private historyAnnotation(points: ChartPoint[]): TemplateResult {
    // Peak time
    let peakTs: number | null = null;
    let peakV = -Infinity;
    for (const p of points) {
      if (p.value == null) continue;
      if (p.value > peakV) {
        peakV = p.value;
        peakTs = p.ts;
      }
    }
    // First long idle window (>= 30 min consecutive < 5 W)
    const IDLE_W = 5;
    const MIN_IDLE_MS = 30 * 60 * 1000;
    let idleStart: number | null = null;
    let bestIdle: { start: number; end: number } | null = null;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const v = p.value ?? 0;
      if (v < IDLE_W) {
        if (idleStart == null) idleStart = p.ts;
        const span = p.ts - idleStart;
        if (span >= MIN_IDLE_MS && (!bestIdle || span > bestIdle.end - bestIdle.start)) {
          bestIdle = { start: idleStart, end: p.ts };
        }
      } else {
        idleStart = null;
      }
    }
    return html`
      ${peakTs != null
        ? html`<span>Peak ${this.fmtClock(peakTs)}</span>`
        : nothing}
      ${bestIdle
        ? html`<span>Idle ${this.fmtClock(bestIdle.start)}–${this.fmtClock(bestIdle.end)}</span>`
        : nothing}
    `;
  }

  /** Lifetime totals from the multi-day rollup, with optional $/kWh cost. */
  private renderLifetimeSection(): TemplateResult {
    const hist = this.historyMulti.data;
    if (!hist) {
      return html`<ef-section .title=${`${HISTORY_DAYS}-day lifetime`}>
        <div class="subtitle">
          ${this.historyMulti.stale ? 'Multi-day history unavailable.' : 'Loading multi-day history…'}
        </div>
      </ef-section>`;
    }
    if (hist.summary.daysWithData === 0) {
      return html`<ef-section .title=${`${HISTORY_DAYS}-day lifetime`}>
        <div class="subtitle">
          No multi-day history recorded yet — totals appear as the recorder accumulates samples.
        </div>
      </ef-section>`;
    }
    const totalKwh = hist.summary.totalKwh;
    const rate = this.config?.cost_per_kwh ?? DEFAULT_COST_PER_KWH;
    const usingDefault = this.config?.cost_per_kwh == null;
    const cost = totalKwh * rate;
    const peakDay = hist.summary.peakDay;
    return html`<ef-section .title=${`${HISTORY_DAYS}-day lifetime`}>
      <div class="full">
        <div class="kv">
          <span class="k">${glossary('Lifetime kWh')}</span>
          <span class="v">${totalKwh.toFixed(1)} kWh</span>
        </div>
        <div class="kv">
          <span class="k">Avg / day</span>
          <span class="v">${hist.summary.avgKwh.toFixed(2)} kWh</span>
        </div>
        <div class="kv">
          <span class="k">Peak day</span>
          <span class="v">${peakDay ? `${peakDay.kwh.toFixed(2)} kWh` : '—'}</span>
        </div>
        <div class="kv">
          <span class="k">Cost${usingDefault ? ` (@ $${rate.toFixed(2)}/kWh)` : ''}</span>
          <span class="v">$${cost.toFixed(2)}</span>
        </div>
        <div class="pairing-note">
          ${hist.summary.daysWithData}/${hist.days.length} days with data${usingDefault
            ? ' · set `cost_per_kwh:` in the card YAML to override the default rate'
            : ''}
        </div>
      </div>
    </ef-section>`;
  }

  /**
   * Pairing section — only rendered when the configured leg is one half of a
   * split-phase pair. Surfaces both legs' summed live power and today's kWh
   * so the operator can see the full 240 V picture in one card.
   */
  private renderPairingSection(
    pair: Shp2PairedCircuit | undefined,
    useCombined: boolean,
  ): TemplateResult | typeof nothing {
    if (!pair || !pair.isSplitPhase || pair.secondaryCh == null) return nothing;
    const cfgCh = this.config?.circuit;
    // When the operator configured the primary leg, the headline already
    // shows combined values — surface a confirmation, not a duplicate tile.
    if (useCombined) {
      return html`<ef-section .title=${'Pairing'}>
        <div class="full">
          <div class="pairing-note">
            ${glossary('Split-phase')}: ch ${pair.primaryCh}+${pair.secondaryCh} combined as
            ${pair.name}. Headline figures above are summed across both legs.
          </div>
        </div>
      </ef-section>`;
    }
    // Operator pointed the card at the *secondary* leg — show what the pair
    // looks like as a whole. We don't have a separate "today kWh" for the
    // pair without another fetch, so we report combined-now only and link
    // to the primary channel for the full drill-down.
    const otherCh = pair.primaryCh === cfgCh ? pair.secondaryCh : pair.primaryCh;
    return html`<ef-section .title=${'Pairing'}>
      <div class="full">
        <div class="pairing-note">
          ${glossary('Split-phase')}: paired with circuit ${otherCh}. Combined now:
          <strong>${fmtW(pair.watts)}</strong>. For the full 240 V history switch this card to
          <code>circuit: ${pair.primaryCh}</code>.
        </div>
      </div>
    </ef-section>`;
  }
}

// Register in HA's custom-cards catalog so it shows up in the card picker.
// Skip the push when the entry is already present so an HMR reload (dev) or
// a second bundle import doesn't double-register.
type CustomCardEntry = { type: string; name?: string; description?: string };
const w = window as unknown as { customCards?: CustomCardEntry[] };
w.customCards = w.customCards || [];
if (!w.customCards.some((c) => c.type === 'ecoflow-circuit-card')) {
  w.customCards.push({
    type: 'ecoflow-circuit-card',
    name: 'EcoFlow Circuit Drill-Down',
    description: 'Per-circuit live power, 24h history, lifetime kWh and cost',
  });
}

declare global {
  interface HTMLElementTagNameMap {
    'ecoflow-circuit-card': EcoflowCircuitCard;
  }
}
