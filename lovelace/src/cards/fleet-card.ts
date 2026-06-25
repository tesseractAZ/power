import { html, svg, css, type TemplateResult, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { EcoflowCardBase } from '../shared/base-card.js';
import { themeCss } from '../shared/theme.css.js';
import { alertCounts } from '../shared/alerts.js';
import { sortDevices } from '../shared/sort.js';
import { fmtMins, fmtPct, fmtRel, fmtTemp, fmtW, fmtWh } from '../shared/format.js';
import { glossary } from '../shared/glossary.js';
import { forecastChart, type ChartPoint } from '../shared/charts.js';
import type {
  Alert,
  DayForecast,
  DeviceSnapshot,
  DpuProjection,
  RunwayProjection,
  Shp2EnergySource,
  Shp2Projection,
} from '../shared/types.js';
import type { ConnectionState } from '../shared/snapshot-store.js';
// Side-effect imports register the primitive elements.
import '../shared/primitives/ef-badge.js';
import '../shared/primitives/ef-tile.js';
import '../shared/primitives/ef-section.js';

/** Server response from `/api/summary/today`. */
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

/** Wrapper around an HTTP-fetched payload that tracks staleness. */
interface CachedResource<T> {
  data: T | null;
  stale: boolean;
}

const EMPTY_CACHE = <T>(): CachedResource<T> => ({ data: null, stale: false });

/**
 * PR3 fleet card. Single Lit element rendering the dashboard tab from the
 * React PWA (`web/src/App.tsx` `NormalApp`): status banner, energy-flow SVG,
 * runway + today tiles, SHP2/DPU/small-device grid, and 24-hour forecast.
 *
 * Architecture
 * ------------
 *   - Snapshot data (devices, alerts) comes from the WS-backed snapshot store
 *     wired by EcoflowCardBase. Everything that's *derived* from the snapshot
 *     (PV totals, SoC averages, sorted device list) is computed in render-time
 *     helpers; no extra @state for it.
 *   - Three HTTP endpoints are fetched on a refresh interval (default 30s):
 *     /api/runway, /api/summary/today, /api/forecast. Each lives in its own
 *     @state with last-fetched timestamp; the card renders the cached value
 *     with a warn-toned badge when the latest fetch failed.
 *   - The forecast chart uses a hand-rolled SVG renderer (charts.ts) — no
 *     recharts dependency, no React.
 *
 * The original React app split the dashboard across ~10 components. We
 * deliberately keep one custom element here so the Lovelace card-picker
 * stays uncluttered; the React components become private render methods.
 */
@customElement('ecoflow-fleet-card')
export class EcoflowFleetCard extends EcoflowCardBase {
  // HTTP-backed resources. Each refreshes on its own interval; we cache the
  // last-good payload so a server hiccup doesn't blank the card.
  @state() private runway: CachedResource<RunwayProjection> = EMPTY_CACHE();
  @state() private today: CachedResource<TodaySummaryResp> = EMPTY_CACHE();
  @state() private forecast: CachedResource<DayForecast> = EMPTY_CACHE();

  private _httpTimer: ReturnType<typeof setInterval> | null = null;

  // CSS is compacted single-line so terser doesn't have to ship indentation
  // bytes inside the IIFE bundle. The shape mirrors the React app's tailwind
  // classes — keep this in sync with renderXxx() class names below.
  static styles = [
    themeCss,
    css`:host{display:block}ha-card{padding:12px;display:flex;flex-direction:column;gap:12px}@keyframes ef-flowdash{to{stroke-dashoffset:-32}}.muted-sm{font-size:.72rem;color:var(--ef-muted)}.muted-xs{font-size:.65rem;color:var(--ef-muted)}.bar-mt6{margin-top:6px}.bar-mt4{margin-top:4px}.bar-mt2{margin-top:2px}.col-end{display:flex;flex-direction:column;gap:4px;align-items:flex-end}.row-gap4{display:flex;gap:4px}.full{width:100%}.mb8{margin-bottom:8px}.soc-sm{font-size:1.2rem}.suffix-h{font-size:1.1rem;font-weight:600;margin-left:2px}.header{display:flex;align-items:center;justify-content:space-between;gap:8px}.title{font-size:1.1rem;font-weight:600;color:var(--ef-ink)}.subtitle{font-size:.75rem;color:var(--ef-muted);margin-top:2px}.badges{display:flex;align-items:center;gap:6px}.skeleton{padding:20px;text-align:center;color:var(--ef-muted);font-size:.85rem}.skeleton .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ef-accent);margin-right:6px;animation:ef-pulse 1.2s ease-in-out infinite}@keyframes ef-pulse{0%,100%{opacity:.3}50%{opacity:1}}.banner{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 10px;border-radius:8px;background:var(--ef-panel);border:1px solid var(--ef-line)}.banner.bad{background:color-mix(in srgb,var(--ef-bad) 8%,var(--ef-panel));border-color:color-mix(in srgb,var(--ef-bad) 40%,var(--ef-line))}.banner.warn{background:color-mix(in srgb,var(--ef-warn) 8%,var(--ef-panel));border-color:color-mix(in srgb,var(--ef-warn) 40%,var(--ef-line))}.flow-wrap{width:100%}.flow-wrap svg{width:100%;max-height:280px;display:block}.flow-bg{fill:color-mix(in srgb,var(--ef-panel) 60%,transparent)}.flow-label{fill:var(--ef-muted);font-size:10px;font-family:ui-sans-serif;letter-spacing:.1em;text-transform:uppercase}.flow-sub{fill:var(--ef-muted);font-size:10px;font-family:ui-sans-serif}.top-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}.runway-headline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px}.runway-headline .big{font-size:1.8rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ef-ink)}.runway-headline .big.bad{color:var(--ef-bad)}.runway-headline .big.warn{color:var(--ef-warn)}.runway-headline .big.ok{color:var(--ef-ok)}.runway-headline .desc{font-size:.8rem;color:var(--ef-muted)}.device-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.dev{border:1px solid var(--ef-line);border-radius:10px;background:var(--ef-panel);padding:10px 12px;display:flex;flex-direction:column;gap:6px}.dev-head{display:flex;justify-content:space-between;align-items:flex-start;gap:6px}.dev-name{font-weight:600;color:var(--ef-ink);font-size:.95rem;line-height:1.2}.dev-product,.section-header,.others-label{font-size:.7rem;color:var(--ef-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:0}.dev-product{letter-spacing:.04em}.dev-sn{font-family:ui-monospace,Menlo,monospace;font-size:.65rem;color:var(--ef-muted);opacity:.8}.soc-big{font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ef-ink)}.bar{position:relative;height:6px;border-radius:3px;background:color-mix(in srgb,var(--ef-line) 80%,transparent);overflow:hidden}.bar>span{display:block;height:100%;border-radius:3px}.kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;font-size:.8rem;color:var(--ef-ink)}.kv-grid .k{color:var(--ef-muted)}.kv-grid .v{text-align:right;font-variant-numeric:tabular-nums}.pack-row{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}.pack{border:1px solid var(--ef-line);border-radius:6px;padding:4px;text-align:center;font-size:.7rem;background:color-mix(in srgb,var(--ef-panel) 80%,transparent)}.pack.empty{opacity:.5}.pack .n{color:var(--ef-muted)}.pack .v{font-weight:600;font-size:.85rem;color:var(--ef-ink);font-variant-numeric:tabular-nums}.section-header{margin-bottom:4px}.src-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:4px}.src{border:1px solid var(--ef-line);border-radius:6px;padding:4px 6px;font-size:.72rem;color:var(--ef-muted)}.src .pct{font-weight:600;font-size:1rem;color:var(--ef-ink);font-variant-numeric:tabular-nums}.row-flex{display:flex;justify-content:space-between;align-items:baseline;gap:4px}.others-label{margin-bottom:6px}.small-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}`,
  ];

  // ──────────────────────────── lifecycle ────────────────────────────

  connectedCallback() {
    super.connectedCallback();
    this._kickHttpFetches();
    const refreshSec = Math.max(10, this.config?.refresh_seconds ?? 30);
    this._httpTimer = setInterval(() => this._kickHttpFetches(), refreshSec * 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._httpTimer) {
      clearInterval(this._httpTimer);
      this._httpTimer = null;
    }
  }

  private _kickHttpFetches() {
    // Fire all three in parallel; each updates its @state on success and
    // marks the cache stale on failure (keeping the last good payload).
    void this._fetchOne<RunwayProjection>('/api/runway', () => this.runway, (r) => (this.runway = r));
    void this._fetchOne<TodaySummaryResp>('/api/summary/today', () => this.today, (r) => (this.today = r));
    void this._fetchOne<DayForecast>('/api/forecast', () => this.forecast, (r) => (this.forecast = r));
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

  // ──────────────────────────── helpers ────────────────────────────

  private connTone(state: ConnectionState): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
    if (state === 'open') return 'ok';
    if (state === 'connecting' || state === 'reconnecting') return 'warn';
    if (state === 'closed') return 'bad';
    return 'neutral';
  }

  private connLabel(state: ConnectionState): string {
    return state === 'open' ? 'live' : state === 'connecting' ? 'linking' : state === 'reconnecting' ? 'reconnecting' : state === 'closed' ? 'offline' : 'idle';
  }

  /** Color for a SoC bar / accent — `var(--ef-*)` token. */
  private socColor(soc: number | null | undefined): string {
    if (soc == null) return 'var(--ef-muted)';
    if (soc >= 50) return 'var(--ef-ok)';
    if (soc >= 25) return 'var(--ef-warn)';
    return 'var(--ef-bad)';
  }

  // ──────────────────────────── render ────────────────────────────

  render() {
    const snap = this.snapshot;
    const title = this.config?.title ?? 'Power';

    if (!snap) {
      return html`<ha-card>
<div class="header"><div>
<div class="title">${title}</div>
<div class="subtitle">${this.effectiveHost()}</div>
</div>
<div class="badges"><ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge></div>
</div>
<div class="skeleton"><span class="dot"></span>Connecting to add-on…</div>
</ha-card>`;
    }

    const devices = Object.values(snap.devices);
    const sorted = sortDevices(devices);
    const shp2 = sorted.find((d): d is DeviceSnapshot & { projection: Shp2Projection } => d.projection?.kind === 'shp2');
    const dpus = sorted.filter((d): d is DeviceSnapshot & { projection?: DpuProjection } =>
      d.productName.toLowerCase().includes('delta pro ultra'),
    );
    const others = sorted.filter((d) => d !== shp2 && !dpus.includes(d as DeviceSnapshot & { projection?: DpuProjection }))
      .sort((a, b) => Number(b.online) - Number(a.online));
    const alerts = snap.alerts ?? [];
    const counts = alertCounts(alerts);
    const onlineCount = devices.filter((d) => d.online).length;

    // Snapshot age sub-line
    const updatedRel = fmtRel(snap.generatedAt ?? null);

    return html`<ha-card>
<div class="header"><div>
<div class="title">${title}</div>
<div class="subtitle">${devices.length} devices · ${onlineCount} online · updated ${updatedRel}</div>
</div>
<div class="badges">${counts.critical > 0 ? html`<ef-badge tone="bad">${counts.critical} crit</ef-badge>` : nothing}${counts.warning > 0 ? html`<ef-badge tone="warn">${counts.warning} warn</ef-badge>` : nothing}<ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge></div>
</div>
${this.renderStatusBanner(alerts)}
${this.renderEnergyFlow(devices)}
${this.renderTopRow()}
${this.renderDeviceGrid(shp2, dpus, others)}
${this.renderForecast()}
</ha-card>`;
  }

  // ──────────────────────────── status banner ────────────────────────────

  private renderStatusBanner(alerts: Alert[]): TemplateResult {
    const counts = alertCounts(alerts);
    const actionable = alerts.filter((a) => a.severity !== 'info');
    const info = alerts.filter((a) => a.severity === 'info');
    if (actionable.length === 0 && info.length === 0) {
      return html`<div class="banner"><ef-badge tone="ok">All systems normal</ef-badge></div>`;
    }
    const shown = actionable.slice(0, 4);
    const moreCount = actionable.length - shown.length;
    const klass = counts.critical > 0 ? 'banner bad' : counts.warning > 0 ? 'banner warn' : 'banner';
    return html`<div class=${klass}>${counts.critical > 0 ? html`<ef-badge tone="bad">${counts.critical} ${glossary('critical')}</ef-badge>` : nothing}${counts.warning > 0 ? html`<ef-badge tone="warn">${counts.warning} ${glossary('warning')}${counts.warning === 1 ? '' : 's'}</ef-badge>` : nothing}${shown.map((a) => html`<ef-badge tone=${a.severity === 'critical' ? 'bad' : 'warn'} title=${a.detail}>${a.title} · ${a.device}</ef-badge>`)}${moreCount > 0 ? html`<ef-badge tone="neutral">+${moreCount} more</ef-badge>` : nothing}${info.map((a) => html`<ef-badge tone="info" title=${a.detail}>${a.title}</ef-badge>`)}</div>`;
  }

  // ──────────────────────────── energy flow ────────────────────────────

  private renderEnergyFlow(devices: DeviceSnapshot[]): TemplateResult {
    const dpus = devices.filter(
      (d): d is DeviceSnapshot & { projection: DpuProjection } => d.projection?.kind === 'dpu' && d.online,
    );
    const shp2 = devices.find(
      (d): d is DeviceSnapshot & { projection: Shp2Projection } => d.projection?.kind === 'shp2',
    );
    const pv = dpus.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);
    const sourceSns = new Set((shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn));
    const gridDpus = sourceSns.size > 0 ? dpus.filter((d) => sourceSns.has(d.sn)) : dpus;
    const acIn = gridDpus.reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
    const acOut = dpus.reduce((s, d) => s + (d.projection.acOutWatts ?? 0), 0);
    const totalIn = dpus.reduce((s, d) => s + (d.projection.totalInWatts ?? 0), 0);
    const totalOut = dpus.reduce((s, d) => s + (d.projection.totalOutWatts ?? 0), 0);
    const batNet = totalOut - totalIn;
    const soc = dpus.length === 0 ? null : dpus.reduce((s, d) => s + (d.projection.soc ?? 0), 0) / dpus.length;
    const load = shp2?.projection.circuits.reduce((s, c) => s + (c.watts ?? 0), 0) ?? acOut;
    const offGrid = acIn < 5;

    // SVG geometry — ported verbatim from EnergyFlow.tsx
    const W = 720;
    const H = 260;
    const Solar = { x: 90, y: 50, w: 130, h: 60 };
    const Grid = { x: 90, y: 170, w: 130, h: 60 };
    const Battery = { x: 290, y: 95, w: 150, h: 90 };
    const Loads = { x: 510, y: 95, w: 130, h: 90 };

    const period = (w: number) => (w < 5 ? 0 : Math.max(0.6, Math.min(8, 1500 / Math.max(w, 50))));
    const strokeW = (w: number) => Math.min(8, Math.max(1.5, Math.log10(Math.max(10, w)) * 1.6));

    const flow = (
      from: [number, number],
      to: [number, number],
      watts: number,
      color: string,
    ): TemplateResult => {
      const [x1, y1] = from;
      const [x2, y2] = to;
      const cx = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
      const t = period(watts);
      const sw = strokeW(watts);
      const active = t > 0;
      return svg`<g><path d=${d} fill="none" stroke=${color} stroke-opacity=".35" stroke-width=${sw} />${active
        ? svg`<path d=${d} fill="none" stroke=${color} stroke-width=${sw} stroke-dasharray="6 10" stroke-linecap="round" style="animation:ef-flowdash ${t}s linear infinite" />`
        : nothing}${watts >= 1
        ? svg`<text x=${(x1 + x2) / 2} y=${(y1 + y2) / 2 - 11} text-anchor="middle" fill=${color} font-size="12" font-family="ui-monospace,monospace" font-weight="700" stroke="var(--ef-panel)" stroke-width="4" style="paint-order:stroke">${Math.round(watts)} W</text>`
        : nothing}</g>`;
    };

    const node = (
      x: number,
      y: number,
      w: number,
      h: number,
      title: string,
      subtitle: string,
      value: string,
      accent: string,
      icon: string | null,
      big: boolean,
    ): TemplateResult => svg`<g><rect x=${x} y=${y} width=${w} height=${h} rx="6" class="flow-bg" stroke=${accent} stroke-opacity=".9" stroke-width="1.5" />
<text x=${x + 12} y=${y + 18} class="flow-label">${title}</text>
<text x=${x + 12} y=${y + h - 10} class="flow-sub">${subtitle}</text>
<text x=${x + w - 12} y=${y + h / 2 + (big ? 8 : 6)} text-anchor="end" fill=${accent} font-size=${big ? 28 : 18} font-weight="700">${value}</text>
${icon ? svg`<text x=${x + 12} y=${y + h / 2 + 8} fill=${accent} font-size=${big ? 26 : 22}>${icon}</text>` : nothing}</g>`;

    const socAcc = this.socColor(soc);
    const batSub =
      batNet > 5
        ? `▼ ${fmtW(batNet)} discharging`
        : batNet < -5
          ? `▲ ${fmtW(-batNet)} charging`
          : 'idle';

    return html`<ef-section .title=${'Energy flow'}>
<ef-badge slot="header" tone=${offGrid ? 'warn' : 'ok'}>${offGrid ? 'off-grid' : 'grid-tied'}</ef-badge>
<div class="flow-wrap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${flow([Solar.x + Solar.w, Solar.y + Solar.h / 2], [Battery.x, Battery.y + Battery.h / 2], pv, '#d97706')}${flow([Grid.x + Grid.w, Grid.y + Grid.h / 2], [Battery.x, Battery.y + Battery.h / 2], acIn, '#586474')}${flow([Battery.x + Battery.w, Battery.y + Battery.h / 2], [Loads.x, Loads.y + Loads.h / 2], Math.max(load, acOut), '#15803d')}${node(Solar.x, Solar.y, Solar.w, Solar.h, 'Solar', '42 panels', fmtW(pv), '#d97706', '☀', false)}${node(Grid.x, Grid.y, Grid.w, Grid.h, 'Grid', offGrid ? 'islanded' : 'imported', fmtW(acIn), offGrid ? '#586474' : '#0e7490', '⌁', false)}${node(Battery.x, Battery.y, Battery.w, Battery.h, `Batteries (${dpus.length} DPU)`, batSub, fmtPct(soc, 1), socAcc, null, true)}${node(Loads.x, Loads.y, Loads.w, Loads.h, 'Loads', `${shp2?.projection.circuits.filter((c) => (c.watts ?? 0) > 1).length ?? 0} circuits`, fmtW(load), '#15803d', '⌂', false)}</svg></div>
</ef-section>`;
  }

  // ──────────────────────────── runway + today ────────────────────────────

  private renderTopRow(): TemplateResult {
    const runway = this.runway.data;
    const today = this.today.data;

    // Runway headline section
    let runwaySection: TemplateResult;
    if (!runway && !this.runway.stale) {
      runwaySection = html`<div class="subtitle">Computing off-grid runway…</div>`;
    } else if (runway && runway.unavailable) {
      runwaySection = html`<div class="subtitle">${runway.unavailable}</div>`;
    } else if (runway) {
      const headlineHours = runway.hoursToReserve ?? runway.hoursToEmpty;
      const desc =
        runway.hoursToReserve != null
          ? 'until reserve floor'
          : runway.hoursToEmpty != null
            ? 'until empty'
            : `forecast PV keeps up over ${runway.horizonHours}h`;
      const klass =
        headlineHours == null ? 'big ok' : headlineHours < 4 ? 'big bad' : headlineHours < 12 ? 'big warn' : 'big';
      runwaySection = html`<div class="runway-headline">${headlineHours != null
        ? html`<div class=${klass}>${headlineHours.toFixed(1)}<span class="suffix-h">h</span></div>`
        : html`<div class=${klass}>no dip</div>`}<div class="desc">${desc}</div></div>`;
    } else {
      runwaySection = html`<div class="subtitle">Off-grid runway unavailable.</div>`;
    }

    // Tiles: runway numbers + today's energy totals.
    const t = (label: string, v: number | null | undefined, digits: number, unit: string) =>
      html`<ef-tile label=${label} value=${v != null ? v.toFixed(digits) : '—'} unit=${v != null ? unit : ''}></ef-tile>`;
    const tiles: TemplateResult[] = [];
    if (runway) {
      tiles.push(t('Backup now', runway.backupRemainingKwh, 1, 'kWh'));
      tiles.push(t('Reserve floor', runway.backupReserveKwh, 1, 'kWh'));
      tiles.push(t('Recent load', runway.recentLoadWatts / 1000, 2, 'kW'));
      tiles.push(t(`${runway.horizonHours}h forecast PV`, runway.forecastPvUsedKwh, 1, 'kWh'));
    }
    if (today) {
      tiles.push(t('Solar today', today.fleet.pvWh / 1000, 1, 'kWh'));
      tiles.push(t('AC output', today.fleet.acOutWh / 1000, 1, 'kWh'));
      tiles.push(t('Panel load', today.fleet.panelLoadWh / 1000, 1, 'kWh'));
      tiles.push(t('Batteries (net)', today.fleet.batteryNetWh / 1000, 1, 'kWh'));
    }

    return html`<ef-section .title=${'Today & runway'}>
${this.runway.stale || this.today.stale ? html`<ef-badge slot="header" tone="warn">stale data</ef-badge>` : nothing}
<div class="full">${runwaySection}<div class="top-row">${tiles}</div></div>
</ef-section>`;
  }

  // ──────────────────────────── device grid ────────────────────────────

  private renderDeviceGrid(
    shp2: (DeviceSnapshot & { projection: Shp2Projection }) | undefined,
    dpus: Array<DeviceSnapshot & { projection?: DpuProjection }>,
    others: DeviceSnapshot[],
  ): TemplateResult {
    return html`
      <div class="device-grid">
        ${shp2 ? this.renderShp2Card(shp2) : nothing}
        ${dpus.map((d) => this.renderDpuCard(d, shp2))}
      </div>
      ${others.length
        ? html`
            <div>
              <div class="others-label">
                Other devices (${others.filter((d) => d.online).length} online ·
                ${others.filter((d) => !d.online).length} offline)
              </div>
              <div class="small-grid">${others.map((d) => this.renderSmallDeviceCard(d))}</div>
            </div>
          `
        : nothing}
    `;
  }

  /** SHP2 condensed card — backup pool %, reserve, top circuits. */
  private renderShp2Card(d: DeviceSnapshot & { projection: Shp2Projection }): TemplateResult {
    const p = d.projection;
    const backupPct = p.backupBatPercent;
    const reservePct = p.backupReserveSoc;
    const panelLoad = p.circuits.reduce((s, c) => s + (c.watts ?? 0), 0);
    const activeCircuits = p.pairedCircuits.filter((c) => (c.watts ?? 0) > 1).length;
    const topCircuits = [...p.pairedCircuits]
      .filter((c) => (c.watts ?? 0) > 1)
      .sort((a, b) => (b.watts ?? 0) - (a.watts ?? 0))
      .slice(0, 3);

    return html`<div class="dev">
<div class="dev-head"><div>
<div class="dev-product">${d.productName}</div>
<div class="dev-name">${d.deviceName}</div>
<div class="dev-sn">${d.sn}</div>
</div><ef-badge tone=${d.online ? 'ok' : 'bad'}>${d.online ? 'online' : 'offline'}</ef-badge></div>
<div><div class="row-flex"><span class="soc-big">${fmtPct(backupPct)}</span><span class="muted-sm">${glossary('reserve')} ${fmtPct(reservePct)}</span></div>
<div class="bar bar-mt6"><span style="width:${backupPct ?? 0}%;background:${this.socColor(backupPct)};"></span></div>
</div>
<div class="kv-grid">
<span class="k">${glossary('panel load')}</span><span class="v">${fmtW(panelLoad)}</span>
<span class="k">${glossary('charge time')}</span><span class="v">${fmtMins(p.backupChargeTimeMin)}</span>
<span class="k">Capacity</span><span class="v">${fmtWh(p.backupFullCapWh)}</span>
<span class="k">${glossary('charge power')}</span><span class="v">${fmtW(p.chargeWattPower)}</span>
</div>
${topCircuits.length
  ? html`<div><div class="section-header">Top circuits · ${activeCircuits} active</div>
<div class="kv-grid">${topCircuits.map((c) => html`<span class="k" title=${c.name}>${c.name}</span><span class="v">${fmtW(c.watts)}</span>`)}</div></div>`
  : nothing}
${p.sources.length
  ? html`<div><div class="section-header">Energy sources (${p.sources.length})</div>
<div class="src-row">${p.sources.map((s, i) => this.renderShp2Source(s, p.sourceWatts[i]))}</div></div>`
  : nothing}
</div>`;
  }

  private renderShp2Source(s: Shp2EnergySource, srcW: number | undefined): TemplateResult {
    return html`<div class="src">
<div class="row-flex"><span class="pct">${fmtPct(s.batteryPercentage)}</span><span>slot ${s.slot}</span></div>
<div class="bar bar-mt4"><span style="width:${s.batteryPercentage ?? 0}%;background:${this.socColor(s.batteryPercentage)};"></span></div>
<div class="bar-mt4">${fmtW(srcW != null ? -srcW : null)} · ${fmtTemp(s.emsBatTemp)}
        </div>
      </div>
    `;
  }

  /** DPU card — SoC, pack tiles, key telemetry. */
  private renderDpuCard(
    d: DeviceSnapshot & { projection?: DpuProjection },
    shp2: (DeviceSnapshot & { projection: Shp2Projection }) | undefined,
  ): TemplateResult {
    const p = d.projection;
    const directOk = !!p;
    // SHP2 fallback for offline DPUs
    const source = shp2?.projection.sources.find((src) => src.sn === d.sn);
    const headlineSoc = p?.soc ?? source?.batteryPercentage ?? null;
    const headlineDigits = p?.soc != null ? 1 : 0;
    const remainTimeMin = p?.remainTimeMin ?? null;
    const packCount = p?.packs.length ?? 5;

    return html`<div class="dev">
<div class="dev-head"><div>
<div class="dev-product">${d.productName}</div>
<div class="dev-name">${d.deviceName}</div>
<div class="dev-sn">${d.sn}</div>
</div>
<div class="col-end">
<div class="row-gap4">${source ? html`<ef-badge tone="neutral">SHP2 slot ${source.slot}</ef-badge>` : nothing}<ef-badge tone=${d.online ? 'ok' : 'bad'}>${d.online ? 'online' : 'offline'}</ef-badge></div>
${!directOk && source ? html`<span class="muted-xs">direct down · via SHP2</span>` : nothing}
</div></div>
<div><div class="row-flex"><span class="soc-big">${fmtPct(headlineSoc, headlineDigits)}</span><span class="muted-sm">${remainTimeMin != null ? `${fmtMins(remainTimeMin)} remain` : '—'}</span></div>
<div class="bar bar-mt6"><span style="width:${headlineSoc ?? 0}%;background:${this.socColor(headlineSoc)};"></span></div>
</div>
<div class="kv-grid">
<span class="k">${glossary('pv')}</span><span class="v">${fmtW(p?.pvTotalWatts)}</span>
<span class="k">${glossary('ac out')}</span><span class="v">${fmtW(p?.acOutWatts)}</span>
<span class="k">${glossary('ac in')}</span><span class="v">${fmtW(p?.acInWatts)}</span>
<span class="k">${glossary('mppt')} temp</span><span class="v">HV ${fmtTemp(p?.mpptHvTemp)} · LV ${fmtTemp(p?.mpptLvTemp)}</span>
<span class="k">${glossary('total in / out')}</span><span class="v">${fmtW(p?.totalInWatts)} · ${fmtW(p?.totalOutWatts)}</span>
</div>
<div><div class="section-header">${packCount} battery packs${!directOk ? ' (needs WiFi)' : ''}</div>
<div class="pack-row">${Array.from({ length: packCount }, (_, i) => {
  const pk = p?.packs[i];
  if (pk) {
    return html`<div class="pack"><div class="n">Pack ${pk.num}</div><div class="v">${fmtPct(pk.soc)}</div>
<div class="bar bar-mt2"><span style="width:${pk.soc ?? 0}%;background:${this.socColor(pk.soc)};"></span></div>
<div class="n" class="bar-mt2">${fmtTemp(pk.temp)}</div></div>`;
  }
  return html`<div class="pack empty"><div class="n">Pack ${i + 1}</div><div class="v">—</div><div class="n">no data</div></div>`;
})}</div></div>
</div>`;
  }

  /** Small device card — Delta 3 Plus, RIVER, EVSE, etc. */
  private renderSmallDeviceCard(d: DeviceSnapshot): TemplateResult {
    const p = d.projection;
    const isGeneric = p?.kind === 'generic';
    const soc = isGeneric ? p.soc : null;
    const temp = isGeneric ? p.temp : null;
    const inW = isGeneric ? (p.inWatts ?? p.acInWatts ?? null) : null;
    const outW = isGeneric ? (p.outWatts ?? p.acOutWatts ?? null) : null;
    const pvW = isGeneric ? (p.pvWatts ?? null) : null;

    return html`<div class="dev">
<div class="dev-head"><div>
<div class="dev-product">${d.productName}</div>
<div class="dev-name">${d.deviceName}</div>
<div class="dev-sn">${d.sn}</div>
</div><ef-badge tone=${d.online ? 'ok' : 'bad'}>${d.online ? 'online' : 'offline'}</ef-badge></div>
${!p && d.online ? html`<ef-badge tone="neutral">app-only device</ef-badge>` : nothing}
${!p && !d.online && d.lastError ? html`<span class="muted-sm" style="color:var(--ef-bad);">err: ${d.lastError}</span>` : nothing}
${soc != null ? html`<div><div class="row-flex"><span class="soc-big soc-sm">${fmtPct(soc)}</span><span class="muted-sm">${fmtTemp(temp)}</span></div>
<div class="bar bar-mt4"><span style="width:${soc}%;background:${this.socColor(soc)};"></span></div></div>` : nothing}
${p ? html`<div class="kv-grid"><span class="k">${glossary('in')}</span><span class="v">${fmtW(inW)}</span>
<span class="k">${glossary('out')}</span><span class="v">${fmtW(outW)}</span>
${pvW != null ? html`<span class="k">${glossary('pv')}</span><span class="v">${fmtW(pvW)}</span>` : nothing}</div>` : nothing}
</div>`;
  }

  // ──────────────────────────── forecast ────────────────────────────

  private renderForecast(): TemplateResult {
    const fc = this.forecast.data;
    const stale = this.forecast.stale;

    if (!fc) {
      return html`<ef-section .title=${'24-hour forecast'}>${stale ? html`<ef-badge slot="header" tone="warn">stale</ef-badge>` : nothing}<div class="subtitle">${stale ? 'Forecast unavailable.' : 'Loading forecast…'}</div></ef-section>`;
    }
    const ready = fc.hours.length > 0 && fc.historyDays > 0;
    if (!ready) {
      return html`<ef-section .title=${'24-hour forecast'}><ef-badge slot="header" tone=${fc.hasWeather ? 'ok' : 'neutral'}>${fc.hasWeather ? 'cloud-aware' : 'history only'}</ef-badge><div class="subtitle">Building forecast — needs a little recorded history first.</div></ef-section>`;
    }

    // Build chart series. Watt axis: PV (area) + load (line). SoC axis: projected (right line).
    const pvPoints: ChartPoint[] = fc.hours.map((h) => ({ ts: h.ts, value: h.forecastPvW }));
    const loadPoints: ChartPoint[] = fc.hours.map((h) => ({ ts: h.ts, value: h.forecastLoadW }));
    const socPoints: ChartPoint[] = fc.hours.map((h) => ({ ts: h.ts, value: h.projectedSocPct }));

    const outlook =
      fc.minProjectedSoc == null
        ? 'Comfortable'
        : fc.minProjectedSoc < fc.reserveSoc
          ? 'Tight'
          : fc.minProjectedSoc < fc.reserveSoc + 15
            ? 'Watch'
            : 'Comfortable';
    const outlookTone: 'ok' | 'warn' | 'bad' =
      outlook === 'Tight' ? 'bad' : outlook === 'Watch' ? 'warn' : 'ok';

    return html`<ef-section .title=${'24-hour forecast'}>
<ef-badge slot="header" tone=${fc.hasWeather ? 'ok' : 'neutral'}>${fc.hasWeather ? 'cloud-aware' : 'history only'}</ef-badge>
${stale ? html`<ef-badge slot="header" tone="warn">stale</ef-badge>` : nothing}
<div class="full">
<div class="top-row mb8">
<ef-tile label="Solar next 24h" value=${(fc.forecastPvWhNext24 / 1000).toFixed(1)} unit="kWh"></ef-tile>
<ef-tile label="Projected low SoC" value=${fc.minProjectedSoc != null ? fmtPct(fc.minProjectedSoc, 0) : '—'} unit=""></ef-tile>
<ef-tile label="Reserve floor" value=${fmtPct(fc.reserveSoc, 0)} unit=""></ef-tile>
<ef-tile label="Outlook" value=${outlook} unit=""><ef-badge tone=${outlookTone}>${outlook}</ef-badge></ef-tile>
</div>
${forecastChart({
  area: { points: pvPoints, color: '#d97706', label: 'Forecast PV' },
  line: { points: loadPoints, color: '#0e7490', label: 'Forecast load' },
  rightLine: { points: socPoints, color: '#15803d', label: 'Projected SoC %' },
  rightRef: { value: fc.reserveSoc, color: '#b91c1c' },
}, { height: 220 })}
</div></ef-section>`;
  }
}

// Register in HA's custom-cards catalog so it shows up in the card picker.
// v0.13.7 — idempotent guard (matches circuit/insights/solar) so a second
// bundle import can't double-register this card in HA's picker.
type CustomCardEntry = { type: string; name?: string; description?: string };
const w = window as unknown as { customCards?: CustomCardEntry[] };
w.customCards = w.customCards || [];
if (!w.customCards.some((c) => c.type === 'ecoflow-fleet-card')) {
  w.customCards.push({
    type: 'ecoflow-fleet-card',
    name: 'EcoFlow Fleet Card',
    description: 'Top-level dashboard for EcoFlow off-grid system',
  });
}
