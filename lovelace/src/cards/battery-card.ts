import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { EcoflowCardBase } from '../shared/base-card.js';
import { themeCss } from '../shared/theme.css.js';
import { glossary } from '../shared/glossary.js';
import { sparkline, type ChartPoint } from '../shared/charts.js';
import { fmtPct, fmtTemp, cToF } from '../shared/format.js';
import type {
  DeviceSnapshot,
  DpuPack,
  DpuProjection,
  FleetDegradation,
  PackDegradation,
  RoundTripEfficiency,
} from '../shared/types.js';
import type { ConnectionState } from '../shared/snapshot-store.js';
// Side-effect imports register the primitive custom elements.
import '../shared/primitives/ef-badge.js';
import '../shared/primitives/ef-tile.js';
import '../shared/primitives/ef-section.js';

/** Wrapper around an HTTP-fetched payload that tracks staleness. */
interface CachedResource<T> {
  data: T | null;
  stale: boolean;
}

const EMPTY_CACHE = <T>(): CachedResource<T> => ({ data: null, stale: false });

// DPU pack capacity is reported in single-string mAh. Each pack is 16S2P at
// 51.2 V nominal, so Wh = mAh × 51.2 V × 2 strings / 1000.
const MAH_TO_WH = (51.2 * 2) / 1000;

// Thermal bands (°F) for LFP cells (matches ThermalPanel.tsx).
const WARM_F = 95; // > 35 °C
const HOT_F = 113; // > 45 °C
// Cell-imbalance thresholds — port of ThermalPanel's spreadCellClass.
const SPREAD_WARN_MV = 50;
const SPREAD_BAD_MV = 100;
// State-of-health thresholds — port of DegradationCard's PackRow color logic.
const SOH_WARN = 80;
const SOH_BAD = 70;

type PackTone = 'ok' | 'warn' | 'bad' | 'neutral';

/**
 * PR5 battery card. Single Lit element rendering a condensed version of the
 * React PWA's Battery tab (`web/src/pages/ThermalPanel.tsx` +
 * `web/src/cards/DegradationCard.tsx`). Three logical sections inside one
 * `ha-card`:
 *
 *   1. Fleet rollup — total stored kWh + avg SoC + avg SoH tiles, derived
 *      from `snapshot.devices[*].projection.packs[*]` directly. No fetch.
 *
 *   2. Per-pack thermal & vitals — one compact subsection per DPU, listing
 *      every pack with temp / cell spread / SoC / SoH and the worst-of badge.
 *      The data already lives on the snapshot — no extra fetch needed.
 *
 *   3. Degradation trend + RTE — fetched from `/api/degradation` and
 *      `/api/round-trip-efficiency` on `config.refresh_seconds`. Same
 *      cached-with-stale-badge pattern PR3 uses for runway/today/forecast.
 *
 * Note on SoH sparklines: `/api/degradation` returns a single snapshot per
 * pack (current SoH + fade rate, not a series). We synthesize a 90-day SoH
 * trace per pack as a straight line from `currentSoh + fadePctPerYear` so
 * the sparkline reflects the *projected* recent decline; if the server later
 * exposes a per-pack SoH history endpoint, swap `synthSohTrend()`.
 */
@customElement('ecoflow-battery-card')
export class EcoflowBatteryCard extends EcoflowCardBase {
  @state() private deg: CachedResource<FleetDegradation> = EMPTY_CACHE();
  @state() private rte: CachedResource<RoundTripEfficiency> = EMPTY_CACHE();

  private _httpTimer: ReturnType<typeof setInterval> | null = null;

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
        0%,
        100% {
          opacity: 0.3;
        }
        50% {
          opacity: 1;
        }
      }
      .rollup-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px;
        width: 100%;
      }
      /* Per-pack grid: one subsection per DPU, packs stacked as rows. */
      .pack-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 8px;
        width: 100%;
      }
      .dpu-box {
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ef-panel) 96%, transparent);
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .dpu-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-bottom: 2px;
      }
      .dpu-name {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--ef-ink);
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pack-row {
        display: grid;
        grid-template-columns: 56px 1fr auto;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 6px;
        font-size: 0.78rem;
        line-height: 1.2;
        min-height: 24px;
      }
      .pack-row[data-tone='warn'] {
        background: color-mix(in srgb, var(--ef-warn) 10%, transparent);
      }
      .pack-row[data-tone='bad'] {
        background: color-mix(in srgb, var(--ef-bad) 12%, transparent);
      }
      .pack-row[data-tone='neutral'] {
        opacity: 0.7;
      }
      .pack-label {
        color: var(--ef-muted);
        font-weight: 500;
      }
      .pack-vitals {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        font-variant-numeric: tabular-nums;
        color: var(--ef-ink);
      }
      .pack-vitals .vital {
        white-space: nowrap;
      }
      .pack-vitals .vital .k {
        color: var(--ef-muted);
        font-size: 0.68rem;
        margin-right: 2px;
      }
      .vital.warn {
        color: var(--ef-warn);
        font-weight: 600;
      }
      .vital.bad {
        color: var(--ef-bad);
        font-weight: 600;
      }
      /* Degradation: per-pack row with sparkline */
      .deg-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
      }
      .deg-row {
        display: grid;
        grid-template-columns: 140px 1fr auto;
        align-items: center;
        gap: 10px;
        padding: 4px 6px;
        border-radius: 6px;
        font-size: 0.78rem;
      }
      .deg-row[data-tone='warn'] {
        background: color-mix(in srgb, var(--ef-warn) 8%, transparent);
      }
      .deg-row[data-tone='bad'] {
        background: color-mix(in srgb, var(--ef-bad) 10%, transparent);
      }
      .deg-row .label {
        font-weight: 500;
        color: var(--ef-ink);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .deg-row .label .sub {
        display: block;
        font-size: 0.65rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .deg-row .soh-val {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        text-align: right;
      }
      .deg-row .soh-val .sub {
        display: block;
        font-size: 0.65rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .deg-summary {
        font-size: 0.78rem;
        color: var(--ef-muted);
        margin-top: 6px;
        line-height: 1.4;
      }
      .deg-summary .flag {
        color: var(--ef-warn);
        font-weight: 500;
      }
      .rte-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        width: 100%;
        align-items: center;
      }
      .rte-headline {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.85rem;
        color: var(--ef-ink);
      }
      .rte-headline .big {
        font-size: 1.8rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      .rte-headline .big.warn {
        color: var(--ef-warn);
      }
      .rte-headline .big.bad {
        color: var(--ef-bad);
      }
      .rte-headline .sub {
        font-size: 0.7rem;
        color: var(--ef-muted);
      }
      .no-data {
        font-size: 0.78rem;
        color: var(--ef-muted);
        padding: 6px 0;
      }
      .full {
        width: 100%;
      }
    `,
  ];

  // ────────────────────────────── lifecycle ──────────────────────────────

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
    void this._fetchOne<FleetDegradation>('/api/degradation', () => this.deg, (r) => (this.deg = r));
    void this._fetchOne<RoundTripEfficiency>(
      '/api/round-trip-efficiency',
      () => this.rte,
      (r) => (this.rte = r),
    );
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

  // ────────────────────────────── helpers ──────────────────────────────

  private connTone(state: ConnectionState): PackTone | 'info' {
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

  /** Severity for a per-pack row — worst-of temp / cell spread / SoH. */
  private packTone(pk: DpuPack): PackTone {
    const temp = pk.maxCellTemp ?? pk.temp;
    const spread = pk.maxVolDiffMv;
    const soh = pk.actSoh ?? pk.soh;
    let tone: PackTone = 'ok';
    const promote = (next: PackTone) => {
      const rank: Record<PackTone, number> = { neutral: 0, ok: 1, warn: 2, bad: 3 };
      if (rank[next] > rank[tone]) tone = next;
    };
    if (temp != null) {
      const f = cToF(temp);
      if (f >= HOT_F) promote('bad');
      else if (f >= WARM_F) promote('warn');
    }
    if (spread != null) {
      if (spread > SPREAD_BAD_MV) promote('bad');
      else if (spread > SPREAD_WARN_MV) promote('warn');
    }
    if (soh != null) {
      if (soh < SOH_BAD) promote('bad');
      else if (soh < SOH_WARN) promote('warn');
    }
    return tone;
  }

  /** Map a tone to an ef-badge tone (collapse `neutral` to `neutral`). */
  private badgeTone(t: PackTone): 'ok' | 'warn' | 'bad' | 'neutral' {
    return t;
  }

  /** Vital cell-class for individual values within a pack row. */
  private tempClass(c: number | null | undefined): '' | 'warn' | 'bad' {
    if (c == null) return '';
    const f = cToF(c);
    if (f >= HOT_F) return 'bad';
    if (f >= WARM_F) return 'warn';
    return '';
  }
  private spreadClass(mv: number | null | undefined): '' | 'warn' | 'bad' {
    if (mv == null) return '';
    if (mv > SPREAD_BAD_MV) return 'bad';
    if (mv > SPREAD_WARN_MV) return 'warn';
    return '';
  }
  private sohClass(soh: number | null | undefined): '' | 'warn' | 'bad' {
    if (soh == null) return '';
    if (soh < SOH_BAD) return 'bad';
    if (soh < SOH_WARN) return 'warn';
    return '';
  }

  /**
   * Synthesize a 90-day SoH trend for a pack using its current SoH and the
   * server's projected fade-per-year slope. Returns evenly spaced daily
   * points; null fields fall back to a flat line at currentSoh so the
   * sparkline still renders.
   */
  private synthSohTrend(p: PackDegradation): ChartPoint[] {
    if (p.currentSoh == null) return [];
    const days = 90;
    const fadePerDay = (p.fadePctPerYear ?? 0) / 365;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const points: ChartPoint[] = [];
    for (let i = days; i >= 0; i--) {
      const ts = now - i * dayMs;
      // currentSoh is "today" → "i days ago" was currentSoh + i*fadePerDay.
      const value = p.currentSoh + i * fadePerDay;
      points.push({ ts, value });
    }
    return points;
  }

  // ────────────────────────────── render ──────────────────────────────

  render() {
    const snap = this.snapshot;
    const title = this.config?.title ?? 'Battery';

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

    const devices = Object.values(snap.devices);
    const dpus = devices.filter(
      (d): d is DeviceSnapshot & { projection?: DpuProjection } =>
        d.productName.toLowerCase().includes('delta pro ultra'),
    );

    return html`<ha-card>
      ${this.renderHeader(title, dpus)}
      ${this.renderFleetRollup(dpus)}
      ${this.renderPerPackThermal(dpus)}
      ${this.renderDegradation(dpus)}
      ${this.renderRoundTripEfficiency()}
    </ha-card>`;
  }

  private renderHeader(
    title: string,
    dpus: Array<DeviceSnapshot & { projection?: DpuProjection }>,
  ): TemplateResult {
    const packCount = dpus.reduce((s, d) => s + (d.projection?.packs.length ?? 0), 0);
    return html`<div class="header">
      <div>
        <div class="title">${title}</div>
        <div class="subtitle">${dpus.length} DPU · ${packCount} packs</div>
      </div>
      <div class="badges">
        <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
      </div>
    </div>`;
  }

  // ── Section 1: fleet rollup ──────────────────────────────────────────

  private renderFleetRollup(
    dpus: Array<DeviceSnapshot & { projection?: DpuProjection }>,
  ): TemplateResult {
    let packs = 0;
    let socSum = 0;
    let sohSum = 0;
    let fullMah = 0;
    for (const d of dpus) {
      if (!d.online || !d.projection) continue;
      for (const pk of d.projection.packs) {
        packs++;
        if (pk.soc != null) socSum += pk.soc;
        const soh = pk.actSoh ?? pk.soh;
        if (soh != null) sohSum += soh;
        if (pk.fullCapMah != null) fullMah += pk.fullCapMah;
      }
    }
    const avgSoc = packs ? socSum / packs : null;
    const avgSoh = packs ? sohSum / packs : null;
    // Stored energy estimate: average SoC × full capacity across packs.
    const fullKwh = (fullMah * MAH_TO_WH) / 1000;
    const storedKwh = avgSoc != null && fullKwh > 0 ? (avgSoc / 100) * fullKwh : null;

    return html`<ef-section .title=${'Fleet'}>
      <div class="rollup-row">
        <ef-tile
          label="Stored"
          value=${storedKwh != null ? storedKwh.toFixed(1) : '—'}
          unit=${storedKwh != null ? 'kWh' : ''}
        ></ef-tile>
        <ef-tile label="Avg SoC" value=${avgSoc != null ? avgSoc.toFixed(0) : '—'} unit=${avgSoc != null ? '%' : ''}>
          <span slot="label">${glossary('avg soc')}</span>
        </ef-tile>
        <ef-tile label="Avg SoH" value=${avgSoh != null ? avgSoh.toFixed(1) : '—'} unit=${avgSoh != null ? '%' : ''}>
          <span slot="label">${glossary('avg soh')}</span>
        </ef-tile>
        <ef-tile
          label="Capacity"
          value=${fullKwh > 0 ? fullKwh.toFixed(1) : '—'}
          unit=${fullKwh > 0 ? 'kWh' : ''}
        ></ef-tile>
      </div>
    </ef-section>`;
  }

  // ── Section 2: per-pack thermal & vitals ─────────────────────────────

  private renderPerPackThermal(
    dpus: Array<DeviceSnapshot & { projection?: DpuProjection }>,
  ): TemplateResult {
    if (dpus.length === 0) {
      return html`<ef-section .title=${'Per-pack thermal & vitals'}>
        <div class="no-data">No DPU batteries discovered.</div>
      </ef-section>`;
    }
    return html`<ef-section .title=${'Per-pack thermal & vitals'}>
      <div class="pack-grid">${dpus.map((d) => this.renderDpuBox(d))}</div>
    </ef-section>`;
  }

  private renderDpuBox(d: DeviceSnapshot & { projection?: DpuProjection }): TemplateResult {
    const p = d.projection;
    const packs = p?.packs ?? [];
    return html`<div class="dpu-box">
      <div class="dpu-head">
        <div class="dpu-name" title=${d.deviceName}>${d.deviceName}</div>
        <ef-badge tone=${d.online ? 'ok' : 'bad'}>${d.online ? 'online' : 'offline'}</ef-badge>
      </div>
      ${packs.length === 0
        ? html`<div class="no-data">
            <ef-badge tone="neutral">no data</ef-badge>
          </div>`
        : packs.map((pk) => this.renderPackRow(pk))}
    </div>`;
  }

  private renderPackRow(pk: DpuPack): TemplateResult {
    const tone = this.packTone(pk);
    const temp = pk.maxCellTemp ?? pk.temp;
    const spread = pk.maxVolDiffMv;
    const soh = pk.actSoh ?? pk.soh;
    const soc = pk.soc;
    const tempCls = this.tempClass(temp);
    const spreadCls = this.spreadClass(spread);
    const sohCls = this.sohClass(soh);
    return html`<div class="pack-row" data-tone=${tone}>
      <span class="pack-label">Pack ${pk.num}</span>
      <span class="pack-vitals">
        <span class="vital ${tempCls}"><span class="k">T</span>${fmtTemp(temp)}</span>
        <span class="vital ${spreadCls}"
          ><span class="k">${glossary('cell spread')}</span>${spread != null ? `${Math.round(spread)} mV` : '—'}</span
        >
        <span class="vital"><span class="k">${glossary('soc')}</span>${fmtPct(soc, 0)}</span>
        <span class="vital ${sohCls}"><span class="k">${glossary('soh')}</span>${fmtPct(soh, 1)}</span>
      </span>
      ${tone === 'warn' || tone === 'bad'
        ? html`<ef-badge tone=${this.badgeTone(tone)}>${tone === 'bad' ? '!' : '·'}</ef-badge>`
        : html`<span></span>`}
    </div>`;
  }

  // ── Section 3: degradation trend ─────────────────────────────────────

  private renderDegradation(
    dpus: Array<DeviceSnapshot & { projection?: DpuProjection }>,
  ): TemplateResult {
    const deg = this.deg.data;
    const stale = this.deg.stale;

    if (!deg && !stale) {
      return html`<ef-section .title=${'Degradation trend'}>
        <div class="no-data">Computing degradation projection…</div>
      </ef-section>`;
    }
    if (!deg) {
      return html`<ef-section .title=${'Degradation trend'}>
        <ef-badge slot="header" tone="warn">stale data</ef-badge>
        <div class="no-data">Degradation projection unavailable.</div>
      </ef-section>`;
    }

    const packs = deg.packs;
    if (packs.length === 0) {
      return html`<ef-section .title=${'Degradation trend'}>
        ${stale ? html`<ef-badge slot="header" tone="warn">stale data</ef-badge>` : nothing}
        <div class="no-data">No battery packs reporting SoH yet.</div>
      </ef-section>`;
    }

    // Flag packs below the EOL floor or with peer-outlier fade.
    const eolSoh = deg.eolSoh;
    const flaggedFloor = packs.filter((p) => p.currentSoh != null && p.currentSoh < eolSoh + 5);
    const flaggedOutlier = packs.filter((p) => p.peerOutlier);
    const projecting = packs.filter((p) => p.status === 'projecting');
    const soonest = projecting.reduce<PackDegradation | null>(
      (best, p) =>
        best == null || (p.yearsToEol ?? 1e9) < (best.yearsToEol ?? 1e9) ? p : best,
      null,
    );
    const soonestEolYear =
      soonest && soonest.eolDate ? new Date(soonest.eolDate).getFullYear() : null;

    // Sort packs by SoH ascending so the worst is first.
    const sorted = [...packs].sort(
      (a, b) => (a.currentSoh ?? 999) - (b.currentSoh ?? 999),
    );

    // Keep the list short — top 6 by worst SoH covers our 4-pack fleet
    // with two slots to spare; long lists get a "+N more" pill.
    const shown = sorted.slice(0, 6);
    const more = sorted.length - shown.length;

    // Tone for whole section if any pack is below EOL floor.
    const headerBadge = flaggedFloor.length > 0
      ? html`<ef-badge slot="header" tone="warn">${flaggedFloor.length} flagged</ef-badge>`
      : nothing;
    void dpus; // Reserved for future per-pack DPU-name resolution; currently using p.device from server.

    return html`<ef-section .title=${'Degradation trend'}>
      ${headerBadge}${stale ? html`<ef-badge slot="header" tone="warn">stale data</ef-badge>` : nothing}
      <div class="deg-list">
        ${shown.map((p) => this.renderDegRow(p, eolSoh))}
      </div>
      <div class="deg-summary full">
        ${more > 0 ? html`<span>+${more} more pack${more === 1 ? '' : 's'}.</span> ` : nothing}
        ${flaggedFloor.length > 0
          ? html`<span class="flag"
              >${flaggedFloor
                .map((p) => `${this.packShortLabel(p)} (${p.currentSoh!.toFixed(1)}%)`)
                .join(', ')}
              near ${glossary('eol')} floor (${eolSoh}%).</span
            > `
          : nothing}
        ${flaggedOutlier.length > 0
          ? html`<span class="flag"
              >${flaggedOutlier.map((p) => this.packShortLabel(p)).join(', ')} fading faster than peers.</span
            > `
          : nothing}
        ${soonest && soonestEolYear != null
          ? html`<span
              >Projected ${glossary('eol')}: ${soonestEolYear}
              (${this.packShortLabel(soonest)}, ~${soonest.yearsToEol?.toFixed(1)} yr).</span
            >`
          : projecting.length === 0
            ? html`<span>Not enough history to project end-of-life yet.</span>`
            : nothing}
      </div>
    </ef-section>`;
  }

  private packShortLabel(p: PackDegradation): string {
    return p.coreNum != null ? `Core ${p.coreNum} · Pack ${p.packNum}` : `${p.device} P${p.packNum}`;
  }

  private renderDegRow(p: PackDegradation, eolSoh: number): TemplateResult {
    const tone: PackTone =
      p.currentSoh == null
        ? 'neutral'
        : p.currentSoh < eolSoh
          ? 'bad'
          : p.currentSoh < eolSoh + 5
            ? 'warn'
            : 'ok';
    const trend = this.synthSohTrend(p);
    const sub =
      p.fadePctPerYear != null
        ? `${p.fadePctPerYear.toFixed(1)} %/yr fade`
        : p.status === 'learning'
          ? 'still learning'
          : p.status === 'no-data'
            ? 'no data'
            : 'stable';
    const sohColor =
      tone === 'bad' ? 'var(--ef-bad)' : tone === 'warn' ? 'var(--ef-warn)' : 'var(--ef-accent)';
    return html`<div class="deg-row" data-tone=${tone}>
      <div class="label">
        ${this.packShortLabel(p)}
        <span class="sub">${sub}</span>
      </div>
      <div class="full">${sparkline(trend, { width: 200, height: 32, color: sohColor })}</div>
      <div class="soh-val">
        ${p.currentSoh != null ? `${p.currentSoh.toFixed(1)}%` : '—'}
        ${p.yearsToEol != null ? html`<span class="sub">~${p.yearsToEol.toFixed(1)} yr</span>` : nothing}
      </div>
    </div>`;
  }

  // ── Section 4: round-trip efficiency ─────────────────────────────────

  private renderRoundTripEfficiency(): TemplateResult {
    const rte = this.rte.data;
    const stale = this.rte.stale;

    if (!rte && !stale) {
      return html`<ef-section .title=${'Round-trip efficiency'}>
        <div class="no-data">Computing round-trip efficiency…</div>
      </ef-section>`;
    }
    if (!rte) {
      return html`<ef-section .title=${'Round-trip efficiency'}>
        <ef-badge slot="header" tone="warn">stale data</ef-badge>
        <div class="no-data">${glossary('rte')} unavailable.</div>
      </ef-section>`;
    }

    const cur = rte.efficiencyPct;
    const klass = cur == null ? 'big' : cur < 80 ? 'big bad' : cur < 88 ? 'big warn' : 'big';
    const subText =
      rte.daysWithData > 0
        ? `${rte.daysWithData}/${rte.windowDays}-day rolling window`
        : 'gathering data — needs charge/discharge cycles';

    // Build a sparkline from per-day efficiency values; skip days with null.
    const points: ChartPoint[] = rte.perDay
      .filter((d) => d.efficiencyPct != null)
      .map((d) => ({
        ts: new Date(d.date).getTime(),
        value: d.efficiencyPct,
      }));

    return html`<ef-section .title=${'Round-trip efficiency'}>
      ${stale ? html`<ef-badge slot="header" tone="warn">stale data</ef-badge>` : nothing}
      <div class="rte-row">
        <div class="rte-headline">
          <div class=${klass}>${cur != null ? `${cur.toFixed(1)}%` : '—'}</div>
          <div class="sub">${glossary('rte')}: ${subText}</div>
          <div class="sub">Industry avg: 88–92%</div>
        </div>
        <div>
          ${points.length >= 2
            ? sparkline(points, {
                width: 200,
                height: 40,
                color: 'var(--ef-accent)',
                yMin: 70,
                yMax: 100,
              })
            : html`<div class="no-data">Not enough cycle data yet.</div>`}
        </div>
      </div>
    </ef-section>`;
  }
}

// Register in HA's custom-cards catalog so it shows up in the card picker.
(window as unknown as { customCards?: unknown[] }).customCards =
  (window as unknown as { customCards?: unknown[] }).customCards || [];
(window as unknown as { customCards: unknown[] }).customCards.push({
  type: 'ecoflow-battery-card',
  name: 'EcoFlow Battery Card',
  description: 'Fleet thermal + degradation + round-trip efficiency for EcoFlow batteries',
});
