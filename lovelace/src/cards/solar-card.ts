import { html, svg, css, nothing, type TemplateResult, type SVGTemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { EcoflowCardBase } from '../shared/base-card.js';
import { themeCss } from '../shared/theme.css.js';
import { sortDevices } from '../shared/sort.js';
import { fmtTemp, fmtW, fmtWh } from '../shared/format.js';
import { glossary } from '../shared/glossary.js';
import { forecastChart, type ChartPoint } from '../shared/charts.js';
import type {
  DayForecast,
  DeviceSnapshot,
  DpuProjection,
  ShadeReport,
  Shp2Projection,
  SoilingDecomposition,
  ClippingEstimate,
} from '../shared/types.js';
import type { ConnectionState } from '../shared/snapshot-store.js';
// Side-effect imports register the primitive elements.
import '../shared/primitives/ef-badge.js';
import '../shared/primitives/ef-tile.js';
import '../shared/primitives/ef-section.js';

/* ── Server payload shapes that aren't already in shared/types.ts ─── */

/** /api/summary/today rollup shape (same as fleet card). */
interface TodaySummaryResp {
  sinceMs: number;
  untilMs: number;
  fleet: {
    pvWh: number;
    acOutWh: number;
    panelLoadWh: number;
    batteryNetWh: number;
    coverage: number;
  };
}

/** /api/forecast/probabilistic — P10/P50/P90 forecast bands. */
interface ForecastBand {
  ts: number;
  p10W: number;
  p50W: number;
  p90W: number;
  p10SocPct: number | null;
  p50SocPct: number | null;
  p90SocPct: number | null;
}

interface ProbabilisticForecast {
  generatedAt: number;
  hours: ForecastBand[];
  pAboveReservePct: number | null;
  pFullCharge: number | null;
  uncertaintyKwhStdev: number;
}

/** Generic cached-resource wrapper — same pattern as fleet-card. */
interface CachedResource<T> {
  data: T | null;
  stale: boolean;
}
const EMPTY_CACHE = <T>(): CachedResource<T> => ({ data: null, stale: false });

/* ── Array constants ──────────────────────────────────────────────── */

// Each equipped DPU has a 10-panel HV string and a 4-panel LV string.
// All panels are 400 W; ported verbatim from web/src/pages/SolarPanel.tsx.
const HV_PANELS = 10;
const LV_PANELS = 4;
const PANEL_W = 400;

/**
 * PR6 solar card. Single Lit element rendering the solar/forecast view from
 * `web/src/pages/SolarPanel.tsx`, plus the diagnostic surface from
 * `web/src/cards/SolarResponseCard.tsx` (clipping / soiling / shade).
 *
 * Layout
 * ------
 *   1. Headline strip — Now (live PV) · Today (kWh) · Forecast (kWh expected)
 *   2. Per-MPPT table — one row per HV string, one per LV string, across all DPUs
 *   3. 24h forecast — P10/P50/P90 confidence bands via forecastChart()
 *   4. Solar response — clipping events · soiling drop · upcoming shade
 *
 * Data sources
 * ------------
 *   "Now" PV    — `this.snapshot.devices[*].projection.pvTotalWatts` (WS-streamed)
 *   "Today"     — /api/summary/today (refreshed on `refresh_seconds`)
 *   Forecast    — /api/forecast + /api/forecast/probabilistic
 *   Per-MPPT    — `this.snapshot.devices[*].projection` (HV/LV V/A/W from WS)
 *   Diagnostics — /api/clipping + /api/soiling-decomposition + /api/shade-report
 *
 * The three diagnostic endpoints are slow (server-cached at 60 s) so we
 * fetch them on a separate, longer interval so the regular 30 s refresh
 * doesn't hammer them.
 */
@customElement('ecoflow-solar-card')
export class EcoflowSolarCard extends EcoflowCardBase {
  // HTTP-backed resources — each refresh stays in its own cache so a
  // transient failure on one doesn't blank the rest of the card.
  @state() private today: CachedResource<TodaySummaryResp> = EMPTY_CACHE();
  @state() private forecast: CachedResource<DayForecast> = EMPTY_CACHE();
  @state() private prob: CachedResource<ProbabilisticForecast> = EMPTY_CACHE();
  @state() private clipping: CachedResource<ClippingEstimate> = EMPTY_CACHE();
  @state() private soiling: CachedResource<SoilingDecomposition> = EMPTY_CACHE();
  @state() private shade: CachedResource<ShadeReport> = EMPTY_CACHE();

  private _fastTimer: ReturnType<typeof setInterval> | null = null;
  private _slowTimer: ReturnType<typeof setInterval> | null = null;

  static styles = [
    themeCss,
    css`
      :host {
        display: block;
      }
      ha-card {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .title {
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--ef-ink);
      }
      .subtitle {
        font-size: 0.75rem;
        color: var(--ef-muted);
        margin-top: 2px;
      }
      .badges {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .skeleton {
        padding: 20px;
        text-align: center;
        color: var(--ef-muted);
        font-size: 0.85rem;
      }
      .skeleton .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ef-accent);
        margin-right: 6px;
        animation: ef-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ef-pulse {
        0%, 100% { opacity: .3; }
        50% { opacity: 1; }
      }
      .top-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 8px;
        width: 100%;
      }
      .full {
        width: 100%;
      }
      /* Per-MPPT grid — 5 columns: name | W | V | A | status */
      .mppt-table {
        display: grid;
        grid-template-columns: 1fr 70px 60px 60px 24px;
        column-gap: 8px;
        row-gap: 2px;
        width: 100%;
        font-size: 0.82rem;
        color: var(--ef-ink);
        font-variant-numeric: tabular-nums;
      }
      .mppt-head {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--ef-muted);
        padding-bottom: 2px;
        border-bottom: 1px solid var(--ef-line);
      }
      .mppt-cell {
        padding: 3px 0;
        border-bottom: 1px solid color-mix(in srgb, var(--ef-line) 50%, transparent);
      }
      .mppt-name {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .swatch {
        display: inline-block;
        width: 6px;
        height: 14px;
        border-radius: 1px;
      }
      .mppt-num {
        text-align: right;
      }
      .mppt-status {
        text-align: center;
      }
      .mppt-status.ok {
        color: var(--ef-ok);
      }
      .mppt-status.bad {
        color: var(--ef-bad);
      }
      .mppt-status.idle {
        color: var(--ef-muted);
      }
      .mppt-empty {
        grid-column: 1 / -1;
        padding: 6px 0;
        color: var(--ef-muted);
        font-size: 0.78rem;
      }
      .diag-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
      }
      .diag-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 0.85rem;
        line-height: 1.4;
        color: var(--ef-ink);
      }
      .diag-icon {
        flex: 0 0 auto;
        font-size: 1rem;
        margin-top: 1px;
      }
      .diag-text {
        flex: 1 1 auto;
      }
      .diag-text .muted {
        color: var(--ef-muted);
        font-size: 0.78rem;
      }
      .ratio-bar {
        position: relative;
        width: 56px;
        height: 4px;
        background: var(--ef-line);
        border-radius: 2px;
        margin-left: 4px;
        vertical-align: middle;
        display: inline-block;
      }
      .ratio-bar > span {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        background: var(--ef-accent);
        border-radius: 2px;
      }
    `,
  ];

  // ───────────────────────── lifecycle ─────────────────────────

  connectedCallback() {
    super.connectedCallback();
    this._kickFast();
    this._kickSlow();
    const refreshSec = Math.max(10, this.config?.refresh_seconds ?? 30);
    // Diagnostics live in a 60 s default bucket — twice the headline refresh
    // unless the operator forced it down. Each is cached server-side too.
    const slowSec = Math.max(refreshSec, 60);
    this._fastTimer = setInterval(() => this._kickFast(), refreshSec * 1000);
    this._slowTimer = setInterval(() => this._kickSlow(), slowSec * 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._fastTimer) {
      clearInterval(this._fastTimer);
      this._fastTimer = null;
    }
    if (this._slowTimer) {
      clearInterval(this._slowTimer);
      this._slowTimer = null;
    }
  }

  /** Headline data — today's totals + both forecast variants. */
  private _kickFast() {
    void this._fetchOne<TodaySummaryResp>('/api/summary/today', () => this.today, (r) => (this.today = r));
    void this._fetchOne<DayForecast>('/api/forecast', () => this.forecast, (r) => (this.forecast = r));
    void this._fetchOne<ProbabilisticForecast>(
      '/api/forecast/probabilistic',
      () => this.prob,
      (r) => (this.prob = r),
    );
  }

  /** Diagnostic data — clipping/soiling/shade reports. */
  private _kickSlow() {
    void this._fetchOne<ClippingEstimate>('/api/clipping', () => this.clipping, (r) => (this.clipping = r));
    void this._fetchOne<SoilingDecomposition>(
      '/api/soiling-decomposition',
      () => this.soiling,
      (r) => (this.soiling = r),
    );
    void this._fetchOne<ShadeReport>('/api/shade-report', () => this.shade, (r) => (this.shade = r));
  }

  private async _fetchOne<T>(
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

  // ───────────────────────── helpers ─────────────────────────

  private connTone(state: ConnectionState): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
    if (state === 'open') return 'ok';
    if (state === 'connecting' || state === 'reconnecting') return 'warn';
    if (state === 'closed') return 'bad';
    return 'neutral';
  }

  private connLabel(state: ConnectionState): string {
    return state === 'open' ? 'live' : state === 'connecting' ? 'linking' : state === 'reconnecting' ? 'reconnecting' : state === 'closed' ? 'offline' : 'idle';
  }

  /** Online DPUs sorted in the canonical display order from sort.ts. */
  private dpuList(): Array<DeviceSnapshot & { projection: DpuProjection }> {
    const snap = this.snapshot;
    if (!snap) return [];
    const sorted = sortDevices(Object.values(snap.devices));
    return sorted.filter(
      (d): d is DeviceSnapshot & { projection: DpuProjection } => d.projection?.kind === 'dpu' && d.online,
    );
  }

  /** SHP2 source SNs — used to flag spare DPUs that have no PV array wired in. */
  private wiredArraySns(): Set<string> {
    const snap = this.snapshot;
    if (!snap) return new Set();
    const shp2 = Object.values(snap.devices).find(
      (d): d is DeviceSnapshot & { projection: Shp2Projection } => d.projection?.kind === 'shp2',
    );
    if (!shp2) return new Set();
    return new Set(shp2.projection.sources.map((s) => s.sn).filter((sn): sn is string => !!sn));
  }

  // ───────────────────────── render ─────────────────────────

  render() {
    const snap = this.snapshot;
    const title = this.config?.title ?? 'Solar';

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

    const dpus = this.dpuList();
    const wired = this.wiredArraySns();
    const arrayedDpus = wired.size > 0 ? dpus.filter((d) => wired.has(d.sn)) : dpus;
    const totalPanels = arrayedDpus.length * (HV_PANELS + LV_PANELS);

    return html`<ha-card>
      <div class="header">
        <div>
          <div class="title">${title}</div>
          <div class="subtitle">
            ${dpus.length} DPU${dpus.length === 1 ? '' : 's'} online · ${totalPanels} panels ·
            ${HV_PANELS} HV + ${LV_PANELS} LV per array
          </div>
        </div>
        <div class="badges">
          <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
        </div>
      </div>
      ${this.renderHeadline(dpus)}
      ${this.renderMpptTable(dpus, wired)}
      ${this.renderForecast()}
      ${this.renderResponseSection()}
    </ha-card>`;
  }

  // ───────────────────────── headline strip ─────────────────────────

  /** Now · Today · Forecast — three tiles via <ef-tile>. */
  private renderHeadline(
    dpus: Array<DeviceSnapshot & { projection: DpuProjection }>,
  ): TemplateResult {
    const pvNow = dpus.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);
    const pvHighNow = dpus.reduce((s, d) => s + (d.projection.pvHighWatts ?? 0), 0);
    const pvLowNow = dpus.reduce((s, d) => s + (d.projection.pvLowWatts ?? 0), 0);

    const today = this.today.data;
    const fc = this.forecast.data;

    const fmtKwh = (wh: number | null | undefined) => (wh == null ? '—' : (wh / 1000).toFixed(1));

    const todayVal = today ? fmtKwh(today.fleet.pvWh) : '—';
    const fcVal = fc ? fmtKwh(fc.forecastPvWhNext24) : '—';

    return html`<ef-section .title=${'Solar'}>
      ${this.today.stale || this.forecast.stale
        ? html`<ef-badge slot="header" tone="warn">stale data</ef-badge>`
        : nothing}
      <div class="full">
        <div class="top-row">
          <ef-tile label="Now" value=${fmtW(pvNow)} unit="">
            <span>HV ${fmtW(pvHighNow)} · LV ${fmtW(pvLowNow)}</span>
          </ef-tile>
          <ef-tile label="Today" value=${todayVal} unit=${today ? 'kWh' : ''}>
            <span>${today ? `${Math.round(today.fleet.coverage * 100)}% measured` : ''}</span>
          </ef-tile>
          <ef-tile label="Forecast 24h" value=${fcVal} unit=${fc ? 'kWh' : ''}>
            <span>${fc ? (fc.hasWeather ? 'cloud-aware' : 'typical-day') : ''}</span>
          </ef-tile>
        </div>
      </div>
    </ef-section>`;
  }

  // ───────────────────────── per-MPPT table ─────────────────────────

  /**
   * Per-MPPT table — one row per HV string then one per LV string per DPU.
   * Marks a string as "spare" when the DPU isn't bound to an SHP2 source
   * slot (i.e. there's no array wired into it), so 0 W reads as expected
   * rather than a fault.
   */
  private renderMpptTable(
    dpus: Array<DeviceSnapshot & { projection: DpuProjection }>,
    wired: Set<string>,
  ): TemplateResult {
    if (dpus.length === 0) {
      return html`<ef-section .title=${'Per-MPPT strings (HV + LV)'}>
        <div class="mppt-empty">No online DPUs reporting MPPT data.</div>
      </ef-section>`;
    }

    type Row = {
      key: string;
      device: string;
      stringLabel: string;
      kind: 'HV' | 'LV';
      watts: number | null;
      volts: number | null;
      amps: number | null;
      errCode: number | null;
      arrayed: boolean;
    };

    const rows: Row[] = [];
    let hvCount = 0;
    let lvCount = 0;
    for (const d of dpus) {
      const arrayed = wired.size === 0 || wired.has(d.sn);
      hvCount += 1;
      rows.push({
        key: `${d.sn}-hv`,
        device: d.deviceName,
        stringLabel: `HV-${hvCount}`,
        kind: 'HV',
        watts: d.projection.pvHighWatts,
        volts: d.projection.pvHighVolts,
        amps: d.projection.pvHighAmps,
        errCode: d.projection.pvHighErrCode,
        arrayed,
      });
      lvCount += 1;
      rows.push({
        key: `${d.sn}-lv`,
        device: d.deviceName,
        stringLabel: `LV-${lvCount}`,
        kind: 'LV',
        watts: d.projection.pvLowWatts,
        volts: d.projection.pvLowVolts,
        amps: d.projection.pvLowAmps,
        errCode: d.projection.pvLowErrCode,
        arrayed,
      });
    }
    // Group view: HV first then LV — operator scans by string class.
    rows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'HV' ? -1 : 1));

    const statusFor = (r: Row): { klass: 'ok' | 'bad' | 'idle'; sym: string; title: string } => {
      if ((r.errCode ?? 0) !== 0) return { klass: 'bad', sym: '!', title: `error code ${r.errCode}` };
      if (!r.arrayed) return { klass: 'idle', sym: '—', title: 'no array wired' };
      if ((r.watts ?? 0) > 5) return { klass: 'ok', sym: '✓', title: 'producing' };
      return { klass: 'idle', sym: '·', title: 'idle (no sun / no array)' };
    };

    const swatch = (kind: 'HV' | 'LV') =>
      html`<span class="swatch" style="background:${kind === 'HV' ? '#d97706' : '#c2410c'};" aria-hidden="true"></span>`;

    return html`<ef-section .title=${'Per-MPPT strings (HV + LV)'}>
      <div class="full">
        <div class="mppt-table">
          <div class="mppt-head">${glossary('mppt')} string</div>
          <div class="mppt-head mppt-num">W</div>
          <div class="mppt-head mppt-num">V</div>
          <div class="mppt-head mppt-num">A</div>
          <div class="mppt-head mppt-status">·</div>
          ${rows.map((r) => {
            const st = statusFor(r);
            return html`
              <div class="mppt-cell mppt-name">
                ${swatch(r.kind)}
                <span>
                  <span style="color:var(--ef-ink);">${r.stringLabel}</span>
                  <span style="color:var(--ef-muted);font-size:.7rem;"> · ${r.device}</span>
                </span>
              </div>
              <div class="mppt-cell mppt-num">${fmtW(r.watts)}</div>
              <div class="mppt-cell mppt-num">${r.volts != null ? `${r.volts.toFixed(0)} V` : '—'}</div>
              <div class="mppt-cell mppt-num">${r.amps != null ? `${r.amps.toFixed(1)} A` : '—'}</div>
              <div class="mppt-cell mppt-status ${st.klass}" title=${st.title}>${st.sym}</div>
            `;
          })}
        </div>
      </div>
    </ef-section>`;
  }

  // ───────────────────────── forecast ─────────────────────────

  /**
   * 24-hour forecast section. Uses the forecastChart() helper but configures
   * it with P10/P90 area bands (probabilistic) plus the P50 (deterministic)
   * line so operators can see both the median and the confidence width.
   * Falls back to plain P50 area when the probabilistic endpoint hasn't
   * caught up.
   */
  private renderForecast(): TemplateResult {
    const fc = this.forecast.data;
    const prob = this.prob.data;
    const stale = this.forecast.stale;

    if (!fc) {
      return html`<ef-section .title=${'24-hour forecast'}>
        ${stale ? html`<ef-badge slot="header" tone="warn">stale</ef-badge>` : nothing}
        <div class="subtitle">${stale ? 'Forecast unavailable.' : 'Loading forecast…'}</div>
      </ef-section>`;
    }
    const ready = fc.hours.length > 0 && fc.historyDays > 0;
    if (!ready) {
      return html`<ef-section .title=${'24-hour forecast'}>
        <ef-badge slot="header" tone=${fc.hasWeather ? 'ok' : 'neutral'}
          >${fc.hasWeather ? 'cloud-aware' : 'history only'}</ef-badge
        >
        <div class="subtitle">Building forecast — needs a little recorded history first.</div>
      </ef-section>`;
    }

    // P10/P50/P90 area + median line if the probabilistic endpoint resolved;
    // otherwise fall back to a single P50 area from the deterministic /api/forecast.
    let chart: TemplateResult;
    let confidenceBadge: TemplateResult | symbol = nothing;
    if (prob && prob.hours.length > 0) {
      const p90Pts: ChartPoint[] = prob.hours.map((h) => ({ ts: h.ts, value: h.p90W }));
      const p50Pts: ChartPoint[] = prob.hours.map((h) => ({ ts: h.ts, value: h.p50W }));
      // P10 is rendered as a "hole" underneath — we cheat the area helper by
      // overlaying a panel-coloured area at the P10 level over the P90 area.
      // Hand-roll the SVG instead to layer cleanly: P90 area, P10 mask area,
      // P50 line. forecastChart() doesn't natively do bands so we use it for
      // the P90 background and overlay the rest below.
      chart = this.renderProbForecastChart(prob);
      const widthKwh = prob.uncertaintyKwhStdev;
      const above = prob.pAboveReservePct;
      confidenceBadge = html`<ef-badge slot="header" tone=${above != null && above < 70 ? 'warn' : 'ok'}
        >±${widthKwh.toFixed(1)} kWh · ${above != null ? `${above}% above reserve` : 'no SoC ref'}</ef-badge
      >`;
    } else {
      const p50Pts: ChartPoint[] = fc.hours.map((h) => ({ ts: h.ts, value: h.forecastPvW }));
      chart = forecastChart(
        { area: { points: p50Pts, color: '#d97706', label: 'Forecast PV (P50)' } },
        { height: 200 },
      );
    }

    return html`<ef-section .title=${'24-hour forecast'}>
      <ef-badge slot="header" tone=${fc.hasWeather ? 'ok' : 'neutral'}
        >${fc.hasWeather ? 'cloud-aware' : 'history only'}</ef-badge
      >
      ${confidenceBadge}
      ${stale ? html`<ef-badge slot="header" tone="warn">stale</ef-badge>` : nothing}
      <div class="full">${chart}</div>
    </ef-section>`;
  }

  /**
   * Hand-rolled SVG forecast chart for the probabilistic case — P90 area,
   * P10 baseline area subtracted, P50 median line on top. forecastChart()
   * in shared/charts.ts handles the single-series case; this layered band
   * is bespoke enough that copying its layout is cheaper than expanding
   * the shared helper's API surface.
   */
  private renderProbForecastChart(prob: ProbabilisticForecast): TemplateResult {
    const w = 720;
    const h = 200;
    const padL = 36;
    const padR = 36;
    const padT = 10;
    const padB = 22;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const tsList = prob.hours.map((p) => p.ts);
    const tsMin = Math.min(...tsList);
    const tsMax = Math.max(...tsList);
    const wattMax = Math.max(100, ...prob.hours.map((p) => p.p90W)) * 1.05;

    const xScale = (t: number) => padL + ((t - tsMin) / (tsMax - tsMin || 1)) * plotW;
    const yScale = (v: number) => padT + (1 - v / wattMax) * plotH;
    const baselineY = yScale(0);

    // Build an SVG path that traces P90 across, then back along P10 to form a band.
    const p90Path: string[] = [];
    const p10ReturnPath: string[] = [];
    let pen = false;
    for (let i = 0; i < prob.hours.length; i++) {
      const p = prob.hours[i];
      const x = xScale(p.ts);
      const y90 = yScale(p.p90W);
      p90Path.push(`${pen ? 'L' : 'M'} ${x.toFixed(1)} ${y90.toFixed(1)}`);
      pen = true;
    }
    for (let i = prob.hours.length - 1; i >= 0; i--) {
      const p = prob.hours[i];
      const x = xScale(p.ts);
      const y10 = yScale(p.p10W);
      p10ReturnPath.push(`L ${x.toFixed(1)} ${y10.toFixed(1)}`);
    }
    const bandPath = p90Path.length ? `${p90Path.join(' ')} ${p10ReturnPath.join(' ')} Z` : '';

    // P50 median line.
    const p50PathParts: string[] = [];
    let p50pen = false;
    for (const p of prob.hours) {
      const x = xScale(p.ts);
      const y = yScale(p.p50W);
      p50PathParts.push(`${p50pen ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`);
      p50pen = true;
    }
    const p50Path = p50PathParts.join(' ');

    // Gridlines every 6 h.
    const gridStep = 6 * 60 * 60 * 1000;
    const startHour = Math.ceil(tsMin / gridStep) * gridStep;
    const grids: SVGTemplateResult[] = [];
    for (let t = startHour; t <= tsMax; t += gridStep) {
      const x = xScale(t);
      grids.push(
        svg`<line x1=${x} x2=${x} y1=${padT} y2=${padT + plotH} stroke="var(--ef-line)" stroke-dasharray="2 3" stroke-opacity=".6" />`,
      );
    }
    const wTicks = [0, wattMax / 2, wattMax].map((v) => ({ v, y: yScale(v) }));

    return html`<svg
        viewBox="0 0 ${w} ${h}"
        width="100%"
        height=${h}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        ${grids}
        ${wTicks.map(
          (t) =>
            svg`<line x1=${padL} x2=${padL + plotW} y1=${t.y} y2=${t.y} stroke="var(--ef-line)" stroke-opacity=".4" />
            <text x=${padL - 4} y=${t.y + 3} text-anchor="end" font-size="9" fill="var(--ef-muted)">${(t.v / 1000).toFixed(1)}k</text>`,
        )}
        ${bandPath ? svg`<path d=${bandPath} fill="#d97706" fill-opacity=".18" stroke="none" />` : null}
        ${p50Path ? svg`<path d=${p50Path} fill="none" stroke="#d97706" stroke-width="1.8" />` : null}
        <line
          x1=${padL}
          x2=${padL + plotW}
          y1=${baselineY}
          y2=${baselineY}
          stroke="var(--ef-line)"
          stroke-opacity=".6"
        />
      </svg>
      <div
        style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--ef-muted);margin-top:4px;"
      >
        <span
          ><span
            style="display:inline-block;width:10px;height:10px;opacity:.6;border-radius:2px;margin-right:4px;background:#d97706;"
          ></span
          >P10–P90 band</span
        >
        <span
          ><span
            style="display:inline-block;width:14px;height:2px;margin-right:4px;vertical-align:middle;background:#d97706;"
          ></span
          >P50 median</span
        >
      </div>`;
  }

  // ───────────────────────── solar response (diagnostics) ─────────────────────────

  /**
   * "Solar response" section — three diagnostic readouts that explain what's
   * holding output back. Each row degrades to a neutral note when the data
   * isn't ready yet, so the section is always present (its job is reassurance
   * as much as it is alerting).
   */
  private renderResponseSection(): TemplateResult {
    const stale = this.clipping.stale || this.soiling.stale || this.shade.stale;
    return html`<ef-section .title=${'Solar response · what\'s holding output back'}>
      ${stale ? html`<ef-badge slot="header" tone="warn">stale</ef-badge>` : nothing}
      <div class="diag-list">
        ${this.renderClippingRow()} ${this.renderSoilingRow()} ${this.renderShadeRow()}
      </div>
    </ef-section>`;
  }

  private renderClippingRow(): TemplateResult {
    const c = this.clipping.data;
    if (!c) {
      return html`<div class="diag-row">
        <span class="diag-icon">·</span>
        <div class="diag-text">
          <strong>Clipping</strong> ·
          <span class="muted">${this.clipping.stale ? 'unavailable' : 'computing…'}</span>
        </div>
      </div>`;
    }
    const peakHrs = c.perHour.filter((h) => h.clippedW > 5).length;
    const todayKwh = c.todayKwh;
    const headline =
      todayKwh > 0.2
        ? html`<strong>${todayKwh.toFixed(1)} kWh</strong> clipped today over ${peakHrs} hour${peakHrs === 1 ? '' : 's'}`
        : html`<strong>0 kWh</strong> clipped today — array peak ${fmtW(c.arrayPeakW)}`;
    const detail =
      todayKwh > 0.2
        ? `Inverter capped output at peak (~${fmtW(c.arrayPeakW)}); more arrays or batteries could absorb the surplus.`
        : `Inverter is keeping up with peak production — no power lost to clipping.`;
    return html`<div class="diag-row">
      <span class="diag-icon" style="color:${todayKwh > 0.2 ? 'var(--ef-warn)' : 'var(--ef-ok)'};"
        >${todayKwh > 0.2 ? '!' : '✓'}</span
      >
      <div class="diag-text">
        ${glossary('clipping')}: ${headline}<br />
        <span class="muted">${detail}</span>
      </div>
    </div>`;
  }

  private renderSoilingRow(): TemplateResult {
    const s = this.soiling.data;
    if (!s) {
      return html`<div class="diag-row">
        <span class="diag-icon">·</span>
        <div class="diag-text">
          <strong>${glossary('soiling')}</strong> ·
          <span class="muted">${this.soiling.stale ? 'unavailable' : 'computing…'}</span>
        </div>
      </div>`;
    }
    const worst = [...s.perDevice]
      .filter((d) => d.dropPct != null)
      .sort((a, b) => (b.dropPct ?? 0) - (a.dropPct ?? 0))[0];
    if (!worst || worst.dropPct == null) {
      return html`<div class="diag-row">
        <span class="diag-icon" style="color:var(--ef-muted);">·</span>
        <div class="diag-text">
          ${glossary('soiling')}:
          <strong>insufficient clear-sky history</strong>
          <br /><span class="muted">Needs ~6 clear days to flag a soiling trend.</span>
        </div>
      </div>`;
    }
    const bad = worst.dropPct >= 12;
    const warn = !bad && worst.dropPct >= 6;
    const tone = bad ? 'var(--ef-warn)' : warn ? 'var(--ef-warn)' : 'var(--ef-ok)';
    const sym = bad ? '!' : warn ? '·' : '✓';
    const peerNote = bad
      ? `Worst-affected: ${worst.device} (${worst.dropPct.toFixed(0)}% below clean-day baseline) — a wash should recover most.`
      : warn
        ? `Worst-affected: ${worst.device} (${worst.dropPct.toFixed(0)}% below clean-day) — minor, worth a rinse soon.`
        : `Panels are tracking the clean-day baseline — no soiling detected.`;
    return html`<div class="diag-row">
      <span class="diag-icon" style="color:${tone};">${sym}</span>
      <div class="diag-text">
        ${glossary('soiling')}: <strong>${worst.dropPct.toFixed(0)}% ${glossary('output drop')}</strong>
        <br /><span class="muted">${peerNote}</span>
      </div>
    </div>`;
  }

  private renderShadeRow(): TemplateResult {
    const sh = this.shade.data;
    if (!sh) {
      return html`<div class="diag-row">
        <span class="diag-icon">·</span>
        <div class="diag-text">
          <strong>Shade</strong> ·
          <span class="muted">${this.shade.stale ? 'unavailable' : 'computing…'}</span>
        </div>
      </div>`;
    }
    // Pick the hour with the worst shortfall as the "predicted shade window".
    const worst = [...sh.hours].sort((a, b) => b.shortfallPct - a.shortfallPct)[0];
    if (!worst || worst.shortfallPct < 8) {
      return html`<div class="diag-row">
        <span class="diag-icon" style="color:var(--ef-ok);">✓</span>
        <div class="diag-text">
          Shade: <strong>none detected</strong><br /><span class="muted"
            >No hours showing a meaningful shortfall vs clear-sky expected output.</span
          >
        </div>
      </div>`;
    }
    const fmtHour = (h: number) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);
    const yearKwh = sh.estTotalKwhPerYear;
    return html`<div class="diag-row">
      <span class="diag-icon" style="color:var(--ef-warn);">!</span>
      <div class="diag-text">
        Shade: <strong>${worst.shortfallPct.toFixed(0)}% shortfall</strong> at ${fmtHour(worst.hour)}<br /><span
          class="muted"
          >Around ${fmtHour(worst.hour)} the array produces ${fmtW(worst.observedW)} vs ${fmtW(worst.expectedW)} clear-sky.${yearKwh > 0
            ? ` Est. ~${yearKwh.toFixed(0)} kWh/year lost.`
            : ''}</span
        >
      </div>
    </div>`;
  }
}

// Register in HA's custom-cards catalog so it shows up in the card picker.
// Avoid touching cards already registered by sibling bundles — push only if
// this card isn't present yet.
type CustomCardEntry = { type: string; name?: string; description?: string };
const w = window as unknown as { customCards?: CustomCardEntry[] };
w.customCards = w.customCards || [];
if (!w.customCards.some((c) => c.type === 'ecoflow-solar-card')) {
  w.customCards.push({
    type: 'ecoflow-solar-card',
    name: 'EcoFlow Solar Card',
    description: 'Live PV + per-MPPT detail + day-ahead forecast + diagnostics',
  });
}
