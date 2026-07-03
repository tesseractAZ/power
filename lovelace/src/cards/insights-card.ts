import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { EcoflowCardBase } from '../shared/base-card.js';
import { themeCss } from '../shared/theme.css.js';
import { glossary } from '../shared/glossary.js';
import { sparkline, type ChartPoint } from '../shared/charts.js';
import type {
  AmbientThermalReport,
  ChargeCurveReport,
  ConfidenceSnapshot,
  EquipmentHealth,
  EvWindowPrediction,
  FleetThermalEvents,
  ForecastSkillReport,
  Incident,
  InternalResistanceReport,
  NwsAlert,
  SelfConsumption,
  ShadeReport,
  SoilingDecomposition,
  StringMismatchReport,
} from '../shared/types.js';
import type { ConnectionState } from '../shared/snapshot-store.js';
// Side-effect imports register the primitive custom elements.
import '../shared/primitives/ef-badge.js';
import '../shared/primitives/ef-tile.js';
import '../shared/primitives/ef-section.js';

/**
 * PR7 advanced-insights card. Mirrors `web/src/cards/AdvancedInsightsCard.tsx`
 * — the React PWA's surface for the v0.7.5 analytics functions. The compute
 * is server-side; this card is just a read-only display.
 *
 * Layout — one `<ef-section>` per analytics family, top 3 sections expanded
 * by default and the rest collapsed for scannability. Sections that have
 * nothing to say are skipped entirely (e.g. no NWS alerts) so the card
 * never grows a row of "no data" placeholders for inactive endpoints.
 *
 * Data sources
 * ------------
 *   Snapshot WS — `snapshot.alerts` (active alert chips)
 *   HTTP        — 15 endpoints, each cached with stale-flag (refresh_seconds,
 *                 default 60 s for this slow-data card)
 *
 * Each endpoint goes into its own `CachedResource<T>`. On fetch failure we
 * keep the last good payload and flag the section stale — one bad endpoint
 * never blanks the rest of the card.
 */

/** Wrapper around an HTTP-fetched payload that tracks staleness. */
interface CachedResource<T> {
  data: T | null;
  stale: boolean;
}
const EMPTY_CACHE = <T>(): CachedResource<T> => ({ data: null, stale: false });

/** Server-side weather-ensemble response (per AdvancedInsightsCard.tsx). */
interface WeatherEnsemble {
  sourcesCount: number;
  avgDisagreementPct: number;
  enrichedHourCount: number;
  hourCount: number;
}

/** Sections the operator can collapse. The first three render expanded. */
type SectionKey =
  | 'incidents'
  | 'nws'
  | 'selfConsumption'
  | 'ensemble'
  | 'confidence'
  | 'thermal'
  | 'equipment'
  | 'shade'
  | 'soiling'
  | 'mismatch'
  | 'ev'
  | 'charge'
  | 'ir'
  | 'skill'
  | 'ambient';

const DAY_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Top-3-expanded order: Incidents and NWS are urgent so they're always at
 * the top and rendered open. Self-consumption is the everyday rollup.
 * Everything else collapses by default — operator clicks to open.
 */
const DEFAULT_EXPANDED: ReadonlyArray<SectionKey> = ['incidents', 'nws', 'selfConsumption'];

@customElement('ecoflow-insights-card')
export class EcoflowInsightsCard extends EcoflowCardBase {
  // HTTP caches — one per endpoint so a flake on `/api/shade-report` doesn't
  // wipe the rest of the card.
  @state() private sc: CachedResource<SelfConsumption> = EMPTY_CACHE();
  @state() private thermal: CachedResource<FleetThermalEvents> = EMPTY_CACHE();
  @state() private equip: CachedResource<EquipmentHealth> = EMPTY_CACHE();
  @state() private shade: CachedResource<ShadeReport> = EMPTY_CACHE();
  @state() private soil: CachedResource<SoilingDecomposition> = EMPTY_CACHE();
  @state() private mismatch: CachedResource<StringMismatchReport> = EMPTY_CACHE();
  @state() private ev: CachedResource<EvWindowPrediction> = EMPTY_CACHE();
  @state() private charge: CachedResource<ChargeCurveReport> = EMPTY_CACHE();
  @state() private ir: CachedResource<InternalResistanceReport> = EMPTY_CACHE();
  @state() private skill: CachedResource<ForecastSkillReport> = EMPTY_CACHE();
  @state() private ambient: CachedResource<AmbientThermalReport> = EMPTY_CACHE();
  @state() private conf: CachedResource<ConfidenceSnapshot> = EMPTY_CACHE();
  @state() private nws: CachedResource<NwsAlert[]> = EMPTY_CACHE();
  @state() private incidents: CachedResource<Incident[]> = EMPTY_CACHE();
  @state() private ensemble: CachedResource<WeatherEnsemble | null> = EMPTY_CACHE();

  /** Which sections are currently expanded. Keys default per DEFAULT_EXPANDED. */
  @state() private expanded: Set<SectionKey> = new Set(DEFAULT_EXPANDED);

  private _httpTimer: ReturnType<typeof setInterval> | null = null;

  static styles = [
    themeCss,
    css`
      :host { display: block; }
      ha-card { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .title { font-size: 1.1rem; font-weight: 600; color: var(--ef-ink); }
      .subtitle { font-size: 0.75rem; color: var(--ef-muted); margin-top: 2px; }
      .badges { display: flex; align-items: center; gap: 6px; }
      .skeleton { padding: 20px; text-align: center; color: var(--ef-muted); font-size: 0.85rem; }
      .skeleton .dot {
        display: inline-block; width: 8px; height: 8px; border-radius: 50%;
        background: var(--ef-accent); margin-right: 6px;
        animation: ef-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ef-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
      .blurb { font-size: 0.78rem; color: var(--ef-muted); line-height: 1.4; }
      .full { width: 100%; }
      .tile-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 6px; width: 100%;
      }
      .row-list { display: flex; flex-direction: column; gap: 4px; width: 100%; }
      /* Generic two-tone row used for thermal / equipment / IR / charge / etc. */
      .row {
        display: flex; align-items: baseline; gap: 8px; padding: 4px 8px;
        border: 1px solid var(--ef-line); border-radius: 6px;
        background: color-mix(in srgb, var(--ef-panel) 95%, transparent);
        font-size: 0.78rem; color: var(--ef-ink);
        font-variant-numeric: tabular-nums; flex-wrap: wrap;
      }
      .row[data-tone='warn'] {
        background: color-mix(in srgb, var(--ef-warn) 8%, var(--ef-panel));
        border-color: color-mix(in srgb, var(--ef-warn) 35%, var(--ef-line));
      }
      .row[data-tone='bad'] {
        background: color-mix(in srgb, var(--ef-bad) 10%, var(--ef-panel));
        border-color: color-mix(in srgb, var(--ef-bad) 40%, var(--ef-line));
      }
      .row .label { font-weight: 600; flex: 0 0 auto; min-width: 110px; }
      .row .meta { color: var(--ef-muted); flex: 1 1 auto; font-size: 0.72rem; }
      .row .num { font-family: ui-monospace, monospace; }
      .row .num.warn { color: var(--ef-warn); font-weight: 600; }
      .row .num.bad { color: var(--ef-bad); font-weight: 600; }
      .row .right { margin-left: auto; color: var(--ef-muted); font-size: 0.7rem; }
      /* Incident row: severity tag + alert count chip. */
      .incident {
        display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; padding: 6px 8px;
        border: 1px solid var(--ef-line); border-radius: 6px;
        background: color-mix(in srgb, var(--ef-panel) 92%, transparent); font-size: 0.78rem;
      }
      .incident .title-line { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
      .incident .name { font-weight: 600; color: var(--ef-ink); }
      .incident .scope {
        font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ef-muted);
      }
      .incident .detail {
        font-size: 0.72rem; color: var(--ef-muted); line-height: 1.35; grid-column: 1 / -1;
      }
      /* NWS alert — warn-toned to match storm semantics. */
      .nws-row {
        padding: 6px 8px; border-radius: 6px; font-size: 0.78rem;
        border: 1px solid color-mix(in srgb, var(--ef-warn) 45%, var(--ef-line));
        background: color-mix(in srgb, var(--ef-warn) 6%, var(--ef-panel));
      }
      .nws-row .event { font-weight: 600; color: var(--ef-ink); }
      .nws-row .headline { font-size: 0.72rem; color: var(--ef-muted); margin-top: 2px; line-height: 1.35; }
      .nws-row .sev { font-size: 0.65rem; color: var(--ef-muted); margin-top: 2px; }
      /* Tiny hour-strip used by soiling-per-hour and shade. */
      .hour-strip {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(40px, 1fr));
        gap: 4px; width: 100%;
      }
      .hour-cell {
        text-align: center; padding: 4px 2px; border-radius: 4px;
        border: 1px solid var(--ef-line); font-size: 0.65rem;
        font-family: ui-monospace, monospace;
        background: color-mix(in srgb, var(--ef-panel) 95%, transparent);
      }
      .hour-cell .h { color: var(--ef-muted); font-size: 0.6rem; }
      .hour-cell.warn {
        color: var(--ef-warn);
        border-color: color-mix(in srgb, var(--ef-warn) 35%, var(--ef-line));
      }
      .no-data { font-size: 0.78rem; color: var(--ef-muted); padding: 6px 0; }
      /* Toggle button for expand/collapse, mirrors alerts-card .show-btn. */
      button.toggle {
        font: inherit; font-size: 0.75rem; background: transparent;
        border: 1px solid var(--ef-line); border-radius: 6px; padding: 2px 8px;
        color: var(--ef-accent); cursor: pointer;
      }
      button.toggle:hover { background: color-mix(in srgb, var(--ef-accent) 8%, transparent); }
      /* Sub-block header inside dense sections (Equipment / Soiling). */
      .sub-head {
        font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em;
        color: var(--ef-muted); margin: 4px 0 2px;
      }
      .ev-summary { font-size: 0.72rem; color: var(--ef-muted); margin-bottom: 4px; }
      .checkpoint-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin-top: 4px; }
      .checkpoint {
        text-align: center; padding: 2px 4px; border-radius: 4px;
        background: color-mix(in srgb, var(--ef-panel) 90%, transparent);
        font-family: ui-monospace, monospace; font-size: 0.65rem;
      }
      .checkpoint .soc { color: var(--ef-muted); font-size: 0.6rem; }
    `,
  ];

  // ─────────────────────────── lifecycle ───────────────────────────

  connectedCallback() {
    super.connectedCallback();
    this._kickHttpFetches();
    // 60 s default — these analytics endpoints are slow server-side, so we
    // intentionally refresh less often than the live cards.
    const refreshSec = Math.max(15, this.config?.refresh_seconds ?? 60);
    this._httpTimer = setInterval(() => this._kickHttpFetches(), refreshSec * 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._httpTimer) {
      clearInterval(this._httpTimer);
      this._httpTimer = null;
    }
  }

  // ────────────────────── fetch / cache helpers ────────────────────

  private _kickHttpFetches() {
    void this._fetchOne<SelfConsumption>(
      '/api/self-consumption',
      () => this.sc,
      (r) => (this.sc = r),
    );
    void this._fetchOne<FleetThermalEvents>(
      '/api/thermal-events',
      () => this.thermal,
      (r) => (this.thermal = r),
    );
    void this._fetchOne<EquipmentHealth>(
      '/api/equipment-health',
      () => this.equip,
      (r) => (this.equip = r),
    );
    void this._fetchOne<ShadeReport>(
      '/api/shade-report',
      () => this.shade,
      (r) => (this.shade = r),
    );
    void this._fetchOne<SoilingDecomposition>(
      '/api/soiling-decomposition',
      () => this.soil,
      (r) => (this.soil = r),
    );
    void this._fetchOne<StringMismatchReport>(
      '/api/string-mismatch',
      () => this.mismatch,
      (r) => (this.mismatch = r),
    );
    void this._fetchOne<EvWindowPrediction>(
      '/api/ev-window-prediction',
      () => this.ev,
      (r) => (this.ev = r),
    );
    void this._fetchOne<ChargeCurveReport>(
      '/api/charge-curve',
      () => this.charge,
      (r) => (this.charge = r),
    );
    void this._fetchOne<InternalResistanceReport>(
      '/api/internal-resistance',
      () => this.ir,
      (r) => (this.ir = r),
    );
    void this._fetchOne<ForecastSkillReport>(
      '/api/forecast-skill',
      () => this.skill,
      (r) => (this.skill = r),
    );
    void this._fetchOne<AmbientThermalReport>(
      '/api/ambient-thermal-forecast',
      () => this.ambient,
      (r) => (this.ambient = r),
    );
    void this._fetchOne<ConfidenceSnapshot>(
      '/api/confidence',
      () => this.conf,
      (r) => (this.conf = r),
    );
    void this._fetchListEnvelope<NwsAlert>(
      '/api/nws-alerts',
      'alerts',
      () => this.nws,
      (r) => (this.nws = r),
    );
    void this._fetchListEnvelope<Incident>(
      '/api/incidents',
      'incidents',
      () => this.incidents,
      (r) => (this.incidents = r),
    );
    void this._fetchEnsemble();
  }

  /** Standard fetch for an endpoint whose body is the payload itself. */
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
      // Keep last good payload; flag stale so the section shows a badge.
      set({ ...get(), stale: true });
    }
  }

  /** Endpoints that wrap their list inside `{ key: [...] }` envelopes. */
  private async _fetchListEnvelope<T>(
    path: string,
    key: string,
    get: () => CachedResource<T[]>,
    set: (r: CachedResource<T[]>) => void,
  ): Promise<void> {
    try {
      const url = this.effectiveHost().replace(/\/$/, '') + path;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      const list = Array.isArray(body[key]) ? (body[key] as T[]) : [];
      set({ data: list, stale: false });
    } catch {
      set({ ...get(), stale: true });
    }
  }

  /** Weather-ensemble response can be `{ error: ... }` — treat as no data. */
  private async _fetchEnsemble(): Promise<void> {
    try {
      const url = this.effectiveHost().replace(/\/$/, '') + '/api/weather/ensemble';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (body.error) {
        this.ensemble = { data: null, stale: false };
        return;
      }
      this.ensemble = {
        data: {
          sourcesCount: Number(body.sourcesCount ?? 0),
          avgDisagreementPct: Number(body.avgDisagreementPct ?? 0),
          enrichedHourCount: Number(body.enrichedHourCount ?? 0),
          hourCount: Number(body.hourCount ?? 0),
        },
        stale: false,
      };
    } catch {
      this.ensemble = { ...this.ensemble, stale: true };
    }
  }

  // ───────────────────── connection-badge helpers ──────────────────

  private connTone(state: ConnectionState): 'ok' | 'warn' | 'bad' | 'neutral' {
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

  // ───────────────────── expand / collapse plumbing ────────────────

  private toggle(key: SectionKey): void {
    const next = new Set(this.expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.expanded = next;
  }

  /** Wrap a section body in the standard `<ef-section>` with toggle button. */
  private wrapSection(
    key: SectionKey,
    title: TemplateResult | string,
    headerExtras: TemplateResult | typeof nothing,
    body: () => TemplateResult,
    stale: boolean = false,
  ): TemplateResult {
    const open = this.expanded.has(key);
    return html`<ef-section>
      <span slot="title">${title}</span>
      ${headerExtras}
      ${stale ? html`<ef-badge slot="header" tone="warn">stale data</ef-badge>` : nothing}
      <button
        slot="header"
        class="toggle"
        aria-expanded=${open ? 'true' : 'false'}
        @click=${() => this.toggle(key)}
      >
        ${open ? 'Hide' : 'Show'}
      </button>
      ${open ? body() : nothing}
    </ef-section>`;
  }

  // ──────────────────────────── render ─────────────────────────────

  render() {
    const snap = this.snapshot;
    const title = this.config?.title ?? 'Advanced insights';

    if (snap === null) {
      return html`<ha-card>
        <div class="header">
          <div>
            <div class="title">${title}</div>
            <div class="subtitle">${this.effectiveHost()}</div>
          </div>
          <div class="badges">
            <ef-badge tone=${this.connTone(this.connState)}
              >${this.connLabel(this.connState)}</ef-badge
            >
          </div>
        </div>
        <div class="skeleton"><span class="dot"></span>Connecting to add-on…</div>
      </ha-card>`;
    }

    // Section emit order mirrors AdvancedInsightsCard.tsx so the operator's
    // muscle memory carries between the PWA and the HA dashboard.
    return html`<ha-card>
      ${this.renderHeader(title)}
      <div class="blurb">
        The full advanced-analytics surface, one block per family. Quiet sections mean the
        underlying signal has nothing actionable to say right now.
      </div>
      ${this.renderIncidents()}
      ${this.renderNws()}
      ${this.renderSelfConsumption()}
      ${this.renderEnsemble()}
      ${this.renderConfidence()}
      ${this.renderThermal()}
      ${this.renderEquipment()}
      ${this.renderShade()}
      ${this.renderSoiling()}
      ${this.renderMismatch()}
      ${this.renderEv()}
      ${this.renderCharge()}
      ${this.renderIr()}
      ${this.renderSkill()}
      ${this.renderAmbient()}
    </ha-card>`;
  }

  private renderHeader(title: string): TemplateResult {
    return html`<div class="header">
      <div>
        <div class="title">${title}</div>
        <div class="subtitle">v0.7.5 analytics</div>
      </div>
      <div class="badges">
        <ef-badge tone=${this.connTone(this.connState)}
          >${this.connLabel(this.connState)}</ef-badge
        >
      </div>
    </div>`;
  }

  // ── Active incidents ───────────────────────────────────────────────
  // Clustered alerts that share a Core/Pack — quickly tells the operator
  // whether they have one root cause or N unrelated noise sources.

  private renderIncidents(): TemplateResult | typeof nothing {
    const list = this.incidents.data ?? [];
    if (list.length === 0 && !this.incidents.stale) return nothing;
    return this.wrapSection(
      'incidents',
      glossary('Incident'),
      list.length > 0 ? html`<ef-badge slot="header" tone="bad">${list.length}</ef-badge>` : nothing,
      () => {
        if (list.length === 0) return html`<div class="no-data">No active incidents.</div>`;
        return html`<div class="row-list full">
          ${list.slice(0, 8).map(
            (i) => html`<div class="incident">
              <div class="title-line">
                <span class="name">${i.title}</span>
                <span class="scope">${i.scope}</span>
              </div>
              <span class="meta">${i.alertCount} alerts</span>
              <div class="detail">${i.detail}</div>
            </div>`,
          )}
        </div>`;
      },
      this.incidents.stale,
    );
  }

  // ── NWS active alerts ──────────────────────────────────────────────
  // Storm-prep — when a watch/warning is active for our zone the operator
  // should pre-charge to 100% and recheck inverter settings.

  private renderNws(): TemplateResult | typeof nothing {
    const list = this.nws.data ?? [];
    if (list.length === 0 && !this.nws.stale) return nothing;
    return this.wrapSection(
      'nws',
      glossary('NWS storm'),
      list.length > 0 ? html`<ef-badge slot="header" tone="warn">${list.length}</ef-badge>` : nothing,
      () => {
        if (list.length === 0) return html`<div class="no-data">No active NWS alerts.</div>`;
        return html`<div class="row-list full">
          ${list.map(
            (a) => html`<div class="nws-row">
              <div class="event">${a.event}</div>
              <div class="headline">${a.headline ?? a.areaDesc ?? ''}</div>
              <div class="sev">
                Severity ${a.severity} · ${a.urgency} · expires
                ${a.expires ? new Date(a.expires).toLocaleString() : '—'}
              </div>
            </div>`,
          )}
        </div>`;
      },
      this.nws.stale,
    );
  }

  // ── Self-consumption (7-day rolling) ───────────────────────────────
  // Where the kWh actually went: PV vs load vs battery vs grid.

  private renderSelfConsumption(): TemplateResult | typeof nothing {
    const sc = this.sc.data;
    if (!sc && !this.sc.stale) return nothing;
    return this.wrapSection(
      'selfConsumption',
      glossary('Self-consumption'),
      nothing,
      () => {
        if (!sc) return html`<div class="no-data">Self-consumption unavailable.</div>`;
        return html`<div class="tile-grid">
          <ef-tile label="PV gen" value=${sc.pvKwh.toFixed(1)} unit="kWh"></ef-tile>
          <ef-tile label="Load" value=${sc.loadKwh.toFixed(1)} unit="kWh"></ef-tile>
          <ef-tile
            label="To battery"
            value=${sc.pvToBatteryKwh.toFixed(1)}
            unit="kWh"
          ></ef-tile>
          <ef-tile
            label="Bat discharge"
            value=${sc.batteryDischargeKwh.toFixed(1)}
            unit="kWh"
          ></ef-tile>
          <ef-tile
            label="Grid import"
            value=${sc.gridForKpiKwh != null ? sc.gridForKpiKwh.toFixed(1) : '—'}
            unit=${sc.gridForKpiKwh != null ? 'kWh' : ''}
          ></ef-tile>
          <ef-tile
            label="Solar fraction"
            value=${sc.solarFractionOfLoadPct != null
              ? sc.solarFractionOfLoadPct.toString()
              : '—'}
            unit=${sc.solarFractionOfLoadPct != null ? '%' : ''}
          ></ef-tile>
          <ef-tile
            label="Direct use"
            value=${sc.directUseRatioPct != null ? sc.directUseRatioPct.toString() : '—'}
            unit=${sc.directUseRatioPct != null ? '%' : ''}
          ></ef-tile>
        </div>`;
      },
      this.sc.stale,
    );
  }

  // ── Weather ensemble ───────────────────────────────────────────────
  // Open-Meteo + NWS NDFD cloud-cover blend; widens P10/P90 when sources
  // disagree (Phoenix monsoon clouds are the main beneficiary).

  private renderEnsemble(): TemplateResult | typeof nothing {
    const e = this.ensemble.data;
    if ((!e || e.sourcesCount <= 1) && !this.ensemble.stale) return nothing;
    return this.wrapSection(
      'ensemble',
      'Weather ensemble',
      nothing,
      () => {
        if (!e || e.sourcesCount <= 1)
          return html`<div class="no-data">Only one source — no ensemble yet.</div>`;
        const cov = Math.round((e.enrichedHourCount / Math.max(1, e.hourCount)) * 100);
        return html`<div class="tile-grid">
          <ef-tile label="Sources" value=${e.sourcesCount.toString()}>
            <span>enriched ${e.enrichedHourCount}/${e.hourCount} h</span>
          </ef-tile>
          <ef-tile
            label="Avg disagreement"
            value=${e.avgDisagreementPct.toFixed(1)}
            unit="%"
          >
            <span>|Open-Meteo − NWS|</span>
          </ef-tile>
          <ef-tile
            label="Status"
            value=${e.avgDisagreementPct > 15 ? 'wide' : 'tight'}
          >
            <span>forecast bands</span>
          </ef-tile>
          <ef-tile label="Coverage" value=${cov.toString()} unit="%">
            <span>ensemble overlap</span>
          </ef-tile>
        </div>`;
      },
      this.ensemble.stale,
    );
  }

  // ── Confidence ─────────────────────────────────────────────────────
  // R² + bias for each learned model; trust the projection as much as
  // the fit allows.

  private renderConfidence(): TemplateResult | typeof nothing {
    const c = this.conf.data;
    if (!c && !this.conf.stale) return nothing;
    return this.wrapSection(
      'confidence',
      glossary('Confidence'),
      nothing,
      () => {
        if (!c) return html`<div class="no-data">Confidence snapshot unavailable.</div>`;
        return html`<div class="tile-grid">
          <ef-tile
            label="Degradation R²"
            value=${c.degradationMedianR2 != null ? c.degradationMedianR2.toFixed(2) : '—'}
          ></ef-tile>
          <ef-tile
            label="Solar model R²"
            value=${c.solarModelMedianR2 != null ? c.solarModelMedianR2.toFixed(2) : '—'}
          ></ef-tile>
          <ef-tile
            label="Thermal R²"
            value=${c.thermalMedianR2 != null ? c.thermalMedianR2.toFixed(2) : '—'}
          ></ef-tile>
          <ef-tile
            label="Forecast bias"
            value=${c.forecastSkillBiasFactor != null
              ? `×${c.forecastSkillBiasFactor.toFixed(2)}`
              : '—'}
          ></ef-tile>
          <ef-tile
            label="Forecast MAE"
            value=${c.forecastSkillMaePct != null ? c.forecastSkillMaePct.toString() : '—'}
            unit=${c.forecastSkillMaePct != null ? '%' : ''}
          ></ef-tile>
        </div>`;
      },
      this.conf.stale,
    );
  }

  // ── Thermal events (cumulative) ────────────────────────────────────
  // Hard-life score per pack, normalised per year; identifies which pack
  // has been getting the toughest thermal treatment.

  private renderThermal(): TemplateResult | typeof nothing {
    const t = this.thermal.data;
    if ((!t || t.packs.length === 0) && !this.thermal.stale) return nothing;
    return this.wrapSection(
      'thermal',
      'Thermal events',
      nothing,
      () => {
        if (!t || t.packs.length === 0)
          return html`<div class="no-data">No thermal events recorded.</div>`;
        const sorted = [...t.packs].sort((a, b) => b.hardLifeScore - a.hardLifeScore).slice(0, 8);
        return html`<div class="row-list full">
          ${sorted.map(
            (p) => html`<div class="row">
              <span class="label">Core ${p.coreNum} · Pk ${p.packNum}</span>
              <span class="meta"
                >${p.warmEvents}w / ${p.hotEvents}h / ${p.overheatEvents}o ·
                ${p.warmHours}h warm</span
              >
              <span class="num right">${p.hardLifeScore.toFixed(0)}</span>
            </div>`,
          )}
        </div>`;
      },
      this.thermal.stale,
    );
  }

  // ── Equipment health (MPPT + inverter idle) ────────────────────────
  // Drift in conversion efficiency and rising idle losses both flag
  // wear-out trajectories that don't show up on the live cards.

  private renderEquipment(): TemplateResult | typeof nothing {
    const e = this.equip.data;
    const hasContent =
      !!e &&
      (e.mpptStrings.some((s) => s.driftPctPts != null) ||
        e.inverterStandby.some((s) => s.idleWatts != null));
    if (!hasContent && !this.equip.stale) return nothing;
    return this.wrapSection(
      'equipment',
      'Equipment health',
      nothing,
      () => {
        if (!e || !hasContent)
          return html`<div class="no-data">No equipment-health signal yet.</div>`;
        const mppt = e.mpptStrings.filter((s) => s.recentEffPct != null);
        const idle = e.inverterStandby.filter((s) => s.idleWatts != null);
        return html`<div class="full">
          ${mppt.length > 0
            ? html`<div class="sub-head">${glossary('MPPT')} efficiency</div>
                <div class="row-list">
                  ${mppt.map((s) => {
                    const drift = s.driftPctPts;
                    const driftCls = drift != null && drift < -1 ? 'warn' : '';
                    return html`<div class="row">
                      <span class="label">Core ${s.coreNum} ${s.string}</span>
                      <span class="num">${s.recentEffPct}% / base ${s.baselineEffPct}%</span>
                      <span class="num ${driftCls} right">
                        ${drift != null ? (drift >= 0 ? '+' : '') + drift : ''}
                      </span>
                    </div>`;
                  })}
                </div>`
            : nothing}
          ${idle.length > 0
            ? html`<div class="sub-head">Inverter standby</div>
                <div class="row-list">
                  ${idle.map(
                    (s) => html`<div class="row">
                      <span class="label">Core ${s.coreNum}</span>
                      <span class="num"
                        >${s.idleWatts} W idle (base ${s.baselineIdleWatts})</span
                      >
                      <span class="right">
                        ${s.trendWattsPerWeek != null
                          ? `${s.trendWattsPerWeek >= 0 ? '+' : ''}${s.trendWattsPerWeek} W/wk`
                          : ''}
                      </span>
                    </div>`,
                  )}
                </div>`
            : nothing}
        </div>`;
      },
      this.equip.stale,
    );
  }

  // ── Shade events ───────────────────────────────────────────────────
  // Per-hour shortfall vs the clean-array reference — recurring obstruction.

  private renderShade(): TemplateResult | typeof nothing {
    const s = this.shade.data;
    if ((!s || s.hours.length === 0) && !this.shade.stale) return nothing;
    return this.wrapSection(
      'shade',
      'Shade events',
      nothing,
      () => {
        if (!s || s.hours.length === 0)
          return html`<div class="no-data">No recurring shade detected.</div>`;
        return html`<div class="full">
          <div class="ev-summary">
            Est. ${s.estTotalKwhPerYear} kWh/yr lost to physical obstruction
          </div>
          <div class="hour-strip">
            ${s.hours.map(
              (h) => html`<div class="hour-cell">
                <div class="h">${h.hour}:00</div>
                <div>-${h.shortfallPct}%</div>
                <div class="h">${h.observedW}/${h.expectedW} W</div>
              </div>`,
            )}
          </div>
        </div>`;
      },
      this.shade.stale,
    );
  }

  // ── Soiling decomposition ──────────────────────────────────────────
  // Per-DPU and per-hour breakdown of dust/pollen attenuation.

  private renderSoiling(): TemplateResult | typeof nothing {
    const s = this.soil.data;
    const hasContent = !!s && (s.perDevice.length > 0 || s.perHour.length > 0);
    if (!hasContent && !this.soil.stale) return nothing;
    return this.wrapSection(
      'soiling',
      'Soiling decomposition',
      nothing,
      () => {
        if (!s || !hasContent)
          return html`<div class="no-data">No soiling signal — panels look clean.</div>`;
        return html`<div class="full">
          ${s.perDevice.length > 0
            ? html`<div class="sub-head">Per DPU</div>
                <div class="tile-grid">
                  ${s.perDevice.map(
                    (d) => html`<ef-tile
                      label=${`Core ${d.coreNum ?? d.device}`}
                      value=${d.dropPct != null ? `${d.dropPct}%` : '—'}
                    >
                      <span>${d.cleanDays} clear d</span>
                    </ef-tile>`,
                  )}
                </div>`
            : nothing}
          ${s.perHour.length > 0
            ? html`<div class="sub-head">Per hour</div>
                <div class="hour-strip">
                  ${s.perHour.map(
                    (h) => html`<div class="hour-cell ${h.dropPct >= 15 ? 'warn' : ''}">
                      <div class="h">${h.hour}</div>
                      <div>${h.dropPct}%</div>
                    </div>`,
                  )}
                </div>`
            : nothing}
        </div>`;
      },
      this.soil.stale,
    );
  }

  // ── String mismatch / per-DPU production ───────────────────────────
  // Each DPU vs the fleet median — quickly identifies the underperformer.

  private renderMismatch(): TemplateResult | typeof nothing {
    const m = this.mismatch.data;
    if ((!m || m.devices.length === 0) && !this.mismatch.stale) return nothing;
    return this.wrapSection(
      'mismatch',
      'String mismatch',
      nothing,
      () => {
        if (!m || m.devices.length === 0)
          return html`<div class="no-data">No DPU mismatch — fleet is even.</div>`;
        return html`<div class="row-list full">
          ${m.devices.map(
            (d) => html`<div class="row" data-tone=${d.outlier ? 'warn' : ''}>
              <span class="label">Core ${d.coreNum ?? d.device}</span>
              <span class="num"
                >${d.recentMedianW} W / fleet ${d.fleetMedianW} W</span
              >
              <span class="num">${d.ratio != null ? `×${d.ratio.toFixed(2)}` : '—'}</span>
              ${d.outlier
                ? html`<ef-badge tone="warn">underperformer</ef-badge>`
                : nothing}
            </div>`,
          )}
        </div>`;
      },
      this.mismatch.stale,
    );
  }

  // ── EV-charging window prediction ──────────────────────────────────
  // Recurring sessions in the EVSE-bound circuit history; next-24h windows.

  private renderEv(): TemplateResult | typeof nothing {
    const e = this.ev.data;
    if ((!e || e.patterns.length === 0) && !this.ev.stale) return nothing;
    return this.wrapSection(
      'ev',
      'EV-charging windows',
      nothing,
      () => {
        if (!e || e.patterns.length === 0)
          return html`<div class="no-data">No recurring EV charging detected.</div>`;
        return html`<div class="full">
          <div class="ev-summary">
            ${e.sessionsObserved} session${e.sessionsObserved === 1 ? '' : 's'} observed in last 30
            d · ${e.upcomingNext24h.length} predicted in next 24 h
          </div>
          <div class="row-list">
            ${e.patterns.slice(0, 8).map(
              (p) => html`<div class="row">
                <span class="label"
                  >${DAY_OF_WEEK[p.dayOfWeek]} @ ${p.startHour}:00</span
                >
                <span class="meta"
                  >~${p.typicalDurationHours} h · ${p.typicalWatts} W · ≈
                  ${p.energyKwh} kWh</span
                >
                <span class="right">observed ${p.recurrences}×</span>
              </div>`,
            )}
          </div>
        </div>`;
      },
      this.ev.stale,
    );
  }

  // ── Charge-curve fingerprint drift ─────────────────────────────────
  // V at SoC checkpoints, recent vs baseline — early electrochemical drift.

  private renderCharge(): TemplateResult | typeof nothing {
    const c = this.charge.data;
    const hasContent = !!c && c.packs.some((p) => p.meanDriftMv != null);
    if (!hasContent && !this.charge.stale) return nothing;
    return this.wrapSection(
      'charge',
      'Charge-curve drift',
      nothing,
      () => {
        if (!c || !hasContent)
          return html`<div class="no-data">No charge-curve drift detected.</div>`;
        const packs = c.packs.filter((p) => p.meanDriftMv != null).slice(0, 10);
        return html`<div class="row-list full">
          ${packs.map(
            (p) => html`<div class="row" style="flex-direction:column;align-items:stretch;">
              <div style="display:flex;align-items:baseline;gap:8px;width:100%;">
                <span class="label">Core ${p.coreNum} · Pack ${p.packNum}</span>
                <span class="right">mean drift ±${p.meanDriftMv} mV</span>
              </div>
              <div class="checkpoint-grid">
                ${p.checkpoints.map(
                  (cp) => html`<div class="checkpoint">
                    <div class="soc">${cp.soc}%</div>
                    <div>
                      ${cp.driftMv != null
                        ? `${cp.driftMv >= 0 ? '+' : ''}${cp.driftMv}`
                        : '—'}
                    </div>
                  </div>`,
                )}
              </div>
            </div>`,
          )}
        </div>`;
      },
      this.charge.stale,
    );
  }

  // ── Internal resistance trend ──────────────────────────────────────
  // dV/dI from snapshots — bus-level per Core.

  private renderIr(): TemplateResult | typeof nothing {
    const ir = this.ir.data;
    const hasContent = !!ir && ir.devices.some((d) => d.recentMilliohms != null);
    if (!hasContent && !this.ir.stale) return nothing;
    return this.wrapSection(
      'ir',
      'Internal resistance',
      nothing,
      () => {
        if (!ir || !hasContent)
          return html`<div class="no-data">No internal-resistance signal yet.</div>`;
        const devs = ir.devices.filter((d) => d.recentMilliohms != null);
        return html`<div class="row-list full">
          ${devs.map((d) => {
            const trend = d.trendMilliohmsPerMonth;
            const trendCls = trend != null && trend > 0.5 ? 'warn' : '';
            return html`<div class="row">
              <span class="label">Core ${d.coreNum}</span>
              <span class="num">${d.recentMilliohms} mΩ</span>
              <span class="meta">base ${d.baselineMilliohms} mΩ</span>
              <span class="num ${trendCls} right">
                ${trend != null ? `${trend >= 0 ? '+' : ''}${trend} mΩ/mo` : ''}
              </span>
            </div>`;
          })}
        </div>`;
      },
      this.ir.stale,
    );
  }

  // ── Forecast skill ─────────────────────────────────────────────────
  // Hindcast: model vs actual PV, last 7 days. Includes a 7-day error
  // sparkline so the operator sees trend at a glance.

  private renderSkill(): TemplateResult | typeof nothing {
    const s = this.skill.data;
    if ((!s || s.days.length === 0) && !this.skill.stale) return nothing;
    return this.wrapSection(
      'skill',
      glossary('Forecast skill'),
      nothing,
      () => {
        if (!s || s.days.length === 0)
          return html`<div class="no-data">Forecast skill needs more days of hindcast.</div>`;
        // Build a sparkline of |error| % — visualises whether we're getting
        // better or worse at predicting day-ahead PV.
        const errPts: ChartPoint[] = s.days
          .filter((d) => d.errorPct != null)
          .map((d) => ({
            ts: new Date(d.date).getTime(),
            value: Math.abs(d.errorPct as number),
          }));
        return html`<div class="full">
          ${s.meanAbsErrorPct != null
            ? html`<div class="ev-summary">
                MAE ${s.meanAbsErrorKwh} kWh (${s.meanAbsErrorPct}%) · bias factor ×${s.biasFactor?.toFixed(
                  2,
                ) ?? '—'}
              </div>`
            : nothing}
          ${errPts.length >= 2
            ? html`<div class="full">
                ${sparkline(errPts, { width: 320, height: 36, color: 'var(--ef-warn)' })}
              </div>`
            : nothing}
          <div class="tile-grid">
            ${s.days.map(
              (d) => html`<ef-tile
                label=${d.date.slice(5)}
                value=${d.actualKwh.toFixed(1)}
                unit="kWh"
              >
                <span>pred ${d.predictedKwh.toFixed(1)}</span>
              </ef-tile>`,
            )}
          </div>
        </div>`;
      },
      this.skill.stale,
    );
  }

  // ── Ambient-coupled thermal forecast ───────────────────────────────
  // Predicted pack-temp peaks in the next 24 h, derived from the ambient
  // forecast and the learned pack thermal response.

  private renderAmbient(): TemplateResult | typeof nothing {
    const a = this.ambient.data;
    const hasContent = !!a && a.packs.some((p) => p.predictedPeak24hC != null);
    if (!hasContent && !this.ambient.stale) return nothing;
    return this.wrapSection(
      'ambient',
      'Ambient thermal forecast',
      nothing,
      () => {
        if (!a || !hasContent)
          return html`<div class="no-data">No ambient-coupled thermal forecast yet.</div>`;
        const packs = a.packs.filter((p) => p.predictedPeak24hC != null).slice(0, 10);
        return html`<div class="row-list full">
          ${packs.map((p) => {
            const tF =
              p.predictedPeak24hC != null ? Math.round(p.predictedPeak24hC * 1.8 + 32) : null;
            const at = p.predictedPeakAtMs
              ? new Date(p.predictedPeakAtMs).toLocaleString([], {
                  weekday: 'short',
                  hour: 'numeric',
                })
              : '';
            return html`<div class="row">
              <span class="label">Core ${p.coreNum} · Pk ${p.packNum}</span>
              <span class="num">${tF}°F</span>
              <span class="meta">${at}</span>
              <span class="right">R² ${p.r2?.toFixed(2) ?? '—'}</span>
            </div>`;
          })}
        </div>`;
      },
      this.ambient.stale,
    );
  }

  getCardSize(): number {
    // Up to 15 sections; the bulk are collapsed by default so we report a
    // realistic mid-range size.
    return 10;
  }
}

// Register in HA's custom-cards catalog. Dedupe so a second include doesn't
// produce duplicate picker entries (matches solar-card's pattern).
type CustomCardEntry = { type: string; name?: string; description?: string };
const w = window as unknown as { customCards?: CustomCardEntry[] };
w.customCards = w.customCards || [];
if (!w.customCards.some((c) => c.type === 'ecoflow-insights-card')) {
  w.customCards.push({
    type: 'ecoflow-insights-card',
    name: 'EcoFlow Advanced Insights',
    description: 'v0.7.5 advanced analytics — incidents, NWS, self-consumption, equipment, etc.',
  });
}
