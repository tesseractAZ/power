import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { EcoflowCardBase } from '../shared/base-card.js';
import { themeCss } from '../shared/theme.css.js';
import { glossary } from '../shared/glossary.js';
import { fmtPct, fmtW } from '../shared/format.js';
import type {
  DeviceSnapshot,
  Shp2ChargeWindow,
  Shp2PairedCircuit,
  Shp2Projection,
  Shp2Strategy,
} from '../shared/types.js';
import type { ConnectionState } from '../shared/snapshot-store.js';
// Side-effect imports register the primitive custom elements.
import '../shared/primitives/ef-badge.js';
import '../shared/primitives/ef-tile.js';
import '../shared/primitives/ef-section.js';

/* ── Server payload shape — /api/dispatch-plan (from server/src/analytics.ts) ── */

type DispatchAction = 'charge_from_pv' | 'discharge_to_load' | 'grid_import' | 'hold';

interface DispatchHour {
  ts: number;
  pvW: number;
  loadW: number;
  socStartPct: number;
  socEndPct: number;
  onPeak: boolean;
  action: DispatchAction;
  flowW: number;
  hourlyCostDollars: number;
}

interface DispatchPlan {
  generatedAt: number;
  horizon: number;
  hours: DispatchHour[];
  estimatedSavingsDollars: number;
  targetPrePeakSocPct: number;
}

/** Wrapper around an HTTP-fetched payload that tracks staleness. */
interface CachedResource<T> {
  data: T | null;
  stale: boolean;
}
const EMPTY_CACHE = <T>(): CachedResource<T> => ({ data: null, stale: false });

/* ── Tone helpers ───────────────────────────────────────────────────── */

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

/**
 * PR7 strategy card. Single Lit element rendering a condensed read-only view
 * of the React PWA's `web/src/pages/StrategyPanel.tsx`:
 *
 *   1. Header strip — connection badge, load-shed status pill, "edit in PWA"
 *      hint (config writes live in the add-on, not in Lovelace).
 *   2. Strategy tiles — mid-priority floor, backup reserve, solar reserve,
 *      smart-backup-mode. Pulled from `snapshot.devices[shp2].projection.strategy`.
 *   3. Circuit priorities — paired-circuit shed order from
 *      `snapshot.devices[shp2].projection.pairedCircuits`, ranked low-priority-
 *      first (last to shed). The React side colors them green→amber→red;
 *      we surface that as ef-badge tones (`ok` / `warn` / `bad`).
 *   4. TOU schedule — time-task window/repeat/target from `strategy.timeTask`,
 *      plus a compact 24-hour bar showing the active charge window.
 *   5. Recommendations — peak-aware action list synthesized from
 *      `/api/dispatch-plan`. The React StrategyPanel itself doesn't fetch this
 *      yet, but the dispatch endpoint exists on the server (server/src/index.ts
 *      `/api/dispatch-plan`) and surfaces the same kind of advice a Lovelace
 *      user would want next to their priorities. Cards-aware-of-snapshot
 *      pattern: cached, stale-flagged, server-error-tolerant.
 *
 * Read-only by design: nothing on this card POSTs back to the add-on.
 * The React Strategy view is also read-only; editing is done in the add-on's
 * options.yaml or the EcoFlow app itself.
 */
@customElement('ecoflow-strategy-card')
export class EcoflowStrategyCard extends EcoflowCardBase {
  @state() private plan: CachedResource<DispatchPlan> = EMPTY_CACHE();

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
        flex-wrap: wrap;
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
      .strategy-tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 8px;
        width: 100%;
      }
      .full {
        width: 100%;
      }
      .strategy-hint {
        font-size: 0.7rem;
        color: var(--ef-muted);
        line-height: 1.4;
      }
      /* ── Circuit priorities ── */
      .pri-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 100%;
      }
      .pri-row {
        display: grid;
        grid-template-columns: 32px 1fr auto auto;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ef-panel) 96%, transparent);
        font-size: 0.82rem;
        line-height: 1.2;
      }
      .pri-row[data-tier='ok'] {
        border-left: 3px solid var(--ef-ok);
      }
      .pri-row[data-tier='warn'] {
        border-left: 3px solid var(--ef-warn);
      }
      .pri-row[data-tier='bad'] {
        border-left: 3px solid var(--ef-bad);
      }
      .pri-row[data-tier='neutral'] {
        border-left: 3px solid var(--ef-line);
        opacity: 0.7;
      }
      .pri-rank {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        text-align: center;
        font-size: 1rem;
      }
      .pri-rank[data-tier='ok'] {
        color: var(--ef-ok);
      }
      .pri-rank[data-tier='warn'] {
        color: var(--ef-warn);
      }
      .pri-rank[data-tier='bad'] {
        color: var(--ef-bad);
      }
      .pri-name {
        font-weight: 500;
        color: var(--ef-ink);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pri-meta {
        display: block;
        font-size: 0.65rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .pri-watts {
        font-variant-numeric: tabular-nums;
        text-align: right;
        color: var(--ef-muted);
      }
      .pri-watts.active {
        color: var(--ef-ok);
        font-weight: 600;
      }
      .pri-help {
        font-size: 0.7rem;
        color: var(--ef-muted);
        line-height: 1.4;
        margin-top: 4px;
      }
      /* ── TOU schedule ── */
      .tou-tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 8px;
        width: 100%;
      }
      .tou-timeline {
        position: relative;
        height: 32px;
        background: color-mix(in srgb, var(--ef-panel) 90%, transparent);
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        overflow: hidden;
        width: 100%;
      }
      .tou-grid {
        position: absolute;
        top: 0;
        bottom: 0;
        border-left: 1px solid color-mix(in srgb, var(--ef-line) 60%, transparent);
      }
      .tou-window {
        position: absolute;
        top: 0;
        bottom: 0;
        background: color-mix(in srgb, var(--ef-accent) 30%, transparent);
        border-left: 1px solid var(--ef-accent);
        border-right: 1px solid var(--ef-accent);
      }
      .tou-now {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1px;
        background: var(--ef-bad);
      }
      .tou-ticks {
        display: flex;
        justify-content: space-between;
        font-size: 0.62rem;
        color: var(--ef-muted);
        margin-top: 2px;
      }
      .tou-hint {
        font-size: 0.7rem;
        color: var(--ef-muted);
        line-height: 1.4;
        margin-top: 4px;
      }
      /* ── Recommendations ── */
      .rec-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
      }
      .rec-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 8px;
        align-items: center;
        padding: 6px 10px;
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ef-panel) 96%, transparent);
        font-size: 0.82rem;
      }
      .rec-time {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        color: var(--ef-ink);
        min-width: 56px;
      }
      .rec-detail {
        color: var(--ef-ink);
        line-height: 1.35;
      }
      .rec-detail .sub {
        display: block;
        font-size: 0.7rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .rec-savings {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .no-data {
        font-size: 0.78rem;
        color: var(--ef-muted);
        padding: 4px 0;
      }
    `,
  ];

  // ────────────────────────────── lifecycle ──────────────────────────────

  connectedCallback() {
    super.connectedCallback();
    void this._fetchPlan();
    const refreshSec = Math.max(30, this.config?.refresh_seconds ?? 60);
    this._httpTimer = setInterval(() => void this._fetchPlan(), refreshSec * 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._httpTimer) {
      clearInterval(this._httpTimer);
      this._httpTimer = null;
    }
  }

  private async _fetchPlan(): Promise<void> {
    try {
      const url = this.effectiveHost().replace(/\/$/, '') + '/api/dispatch-plan';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.plan = { data: (await res.json()) as DispatchPlan, stale: false };
    } catch {
      // Soft-fail — keep last good payload, flag stale so the badge appears.
      this.plan = { ...this.plan, stale: true };
    }
  }

  // ────────────────────────────── helpers ──────────────────────────────

  private connTone(state: ConnectionState): Tone {
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

  /** Locate the SHP2 (Smart Home Panel) in the snapshot, or null if absent. */
  private findShp2(): (DeviceSnapshot & { projection: Shp2Projection }) | null {
    const snap = this.snapshot;
    if (!snap) return null;
    for (const d of Object.values(snap.devices)) {
      if (d.projection?.kind === 'shp2') {
        return d as DeviceSnapshot & { projection: Shp2Projection };
      }
    }
    return null;
  }

  /** Map zero-based rank index → ok|warn|bad tier (mirrors React gradient). */
  private rankTier(rank: number | null, total: number): Tone {
    if (rank == null) return 'neutral';
    if (total <= 1) return 'ok';
    const frac = (rank - 1) / (total - 1);
    if (frac < 0.34) return 'ok';
    if (frac < 0.67) return 'warn';
    return 'bad';
  }

  private rankLabel(rank: number | null, total: number): string {
    if (rank == null) return 'unranked';
    const tier = this.rankTier(rank, total);
    if (tier === 'ok') return 'essential';
    if (tier === 'warn') return 'standard';
    return 'first to shed';
  }

  private fmtClock(minute: number): string {
    const h = Math.floor(minute / 60) % 24;
    const m = minute % 60;
    const ampm = h < 12 ? 'a' : 'p';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
  }

  private taskLabel(type: string | null): string {
    if (!type) return '—';
    if (/charge/i.test(type)) return 'Scheduled charge';
    if (/discharge/i.test(type)) return 'Scheduled discharge';
    return type;
  }

  private modeLabel(mode: string | null): string {
    if (!mode) return '—';
    if (/every_day/i.test(mode)) return 'Every day';
    if (/week/i.test(mode)) return 'Weekly';
    if (/once/i.test(mode)) return 'Once';
    return mode.replace(/STARTEGY_|STRATEGY_/i, '').replace(/_/g, ' ').toLowerCase();
  }

  private actionLabel(a: DispatchAction): string {
    switch (a) {
      case 'charge_from_pv':
        return 'Charge from solar';
      case 'discharge_to_load':
        return 'Discharge to load';
      case 'grid_import':
        return 'Import from grid';
      case 'hold':
        return 'Hold';
    }
  }

  private actionTone(a: DispatchAction): Tone {
    switch (a) {
      case 'charge_from_pv':
        return 'ok';
      case 'discharge_to_load':
        return 'info';
      case 'grid_import':
        return 'warn';
      case 'hold':
        return 'neutral';
    }
  }

  private fmtHourTs(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours();
    const ampm = h < 12 ? 'a' : 'p';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${ampm}`;
  }

  private fmtDollars(d: number): string {
    if (!Number.isFinite(d)) return '—';
    const sign = d >= 0 ? '+' : '';
    return `${sign}$${d.toFixed(2)}`;
  }

  // ────────────────────────────── render ──────────────────────────────

  render() {
    const snap = this.snapshot;
    const title = this.config?.title ?? 'Strategy';

    if (!snap) {
      return html`<ha-card>
        ${this.renderHeader(title, null, null)}
        <div class="skeleton"><span class="dot"></span>Connecting to add-on…</div>
      </ha-card>`;
    }

    const shp2 = this.findShp2();
    if (!shp2 || !shp2.projection) {
      return html`<ha-card>
        ${this.renderHeader(title, null, null)}
        <div class="no-data">
          SHP2 not available — strategy view needs the Smart Home Panel online.
        </div>
      </ha-card>`;
    }

    const s = shp2.projection.strategy;
    return html`<ha-card>
      ${this.renderHeader(title, shp2, s)}
      ${this.renderStrategyTiles(s)}
      ${this.renderPriorities(shp2.projection.pairedCircuits)}
      ${this.renderTou(s)}
      ${this.renderRecommendations()}
    </ha-card>`;
  }

  private renderHeader(
    title: string,
    shp2: (DeviceSnapshot & { projection: Shp2Projection }) | null,
    s: Shp2Strategy | null,
  ): TemplateResult {
    const statusBadge = s
      ? html`<ef-badge tone=${s.loadShedEnabled ? 'ok' : s.loadShedConfigured ? 'neutral' : 'warn'}>
          ${s.loadShedEnabled
            ? 'load-shed active'
            : s.loadShedConfigured
              ? 'configured · inactive'
              : 'not configured'}
        </ef-badge>`
      : nothing;
    return html`<div class="header">
      <div>
        <div class="title">${title}</div>
        <div class="subtitle" title="Edit TOU/priorities in the add-on options or the EcoFlow app">
          ${shp2 ? shp2.deviceName : this.effectiveHost()} · read-only · edit in add-on
        </div>
      </div>
      <div class="badges">
        ${statusBadge}
        <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
      </div>
    </div>`;
  }

  // ── Section: strategy tiles (mid-priority floor, reserves, mode) ────

  private renderStrategyTiles(s: Shp2Strategy): TemplateResult {
    return html`<ef-section .title=${'Strategy'}>
      <div class="strategy-tiles">
        <ef-tile
          label="Mid-priority floor"
          value=${fmtPct(s.midPriorityDischargeFloorSoc)}
        >
          <span slot="label">${glossary('mid-priority floor')}</span>
          <span>mid loads cut at this SoC</span>
        </ef-tile>
        <ef-tile label="Backup reserve" value=${fmtPct(s.backupReserveSoc)}>
          <span slot="label">${glossary('reserve floor')}</span>
          <span>${s.backupReserveEnabled ? 'reserve enabled' : 'reserve disabled'}</span>
        </ef-tile>
        <ef-tile label="Solar reserve" value=${fmtPct(s.solarBackupReserveSoc)}>
          <span slot="label">${glossary('solar reserve')}</span>
          <span>target SoC on solar</span>
        </ef-tile>
        <ef-tile label="Smart backup" value=${String(s.smartBackupMode ?? '—')}>
          <span slot="label">${glossary('smart backup mode')}</span>
          <span>backup ${s.backupMode ?? '—'} · overload ${s.overloadMode ?? '—'}</span>
        </ef-tile>
      </div>
      ${!s.loadShedEnabled && s.loadShedConfigured
        ? html`<div class="strategy-hint full">
            Priorities below are configured but the automatic ${glossary('load-shed strategy')} is
            currently switched off in the SHP2. They define the intended shed order when enabled —
            lowest-ranked circuits drop first as the battery depletes.
          </div>`
        : nothing}
    </ef-section>`;
  }

  // ── Section: circuit priorities ─────────────────────────────────────

  private renderPriorities(circuits: Shp2PairedCircuit[]): TemplateResult {
    const ranked = circuits
      .filter((c) => c.loadPriority != null)
      .sort((a, b) => (a.loadPriority ?? 999) - (b.loadPriority ?? 999));
    const unranked = circuits.filter((c) => c.loadPriority == null);
    const total = ranked.length;

    if (ranked.length === 0 && unranked.length === 0) {
      return html`<ef-section .title=${'Circuit priorities'}>
        <div class="no-data">No paired circuits reported by the SHP2.</div>
      </ef-section>`;
    }

    return html`<ef-section .title=${'Circuit priorities'}>
      <div class="pri-list">
        ${ranked.map((c, i) => this.renderPriorityRow(c, i + 1, total))}
        ${unranked.map((c) => this.renderPriorityRow(c, null, total))}
      </div>
      <div class="pri-help full">
        #1 = highest priority (last to be shed, kept powered longest). Higher numbers shed earlier
        when ${glossary('backup')} runs low.
      </div>
    </ef-section>`;
  }

  private renderPriorityRow(
    c: Shp2PairedCircuit,
    rank: number | null,
    total: number,
  ): TemplateResult {
    const tier = this.rankTier(rank, total);
    const tierLabel = this.rankLabel(rank, total);
    const active = (c.watts ?? 0) > 1;
    const chLabel = c.isSplitPhase
      ? `ch${c.primaryCh}+${c.secondaryCh} · 240V`
      : `ch${c.primaryCh}`;
    return html`<div class="pri-row" data-tier=${tier}>
      <span class="pri-rank" data-tier=${tier}>${rank ?? '—'}</span>
      <div>
        <div class="pri-name" title=${c.name}>${c.name}</div>
        <span class="pri-meta"
          >${chLabel} · ${c.breakerAmps ?? '—'}A · raw priority ${c.loadPriority ?? '—'}</span
        >
      </div>
      <span class="pri-watts ${active ? 'active' : ''}">${fmtW(c.watts)}</span>
      <ef-badge tone=${tier === 'neutral' ? 'neutral' : tier}>${tierLabel}</ef-badge>
    </div>`;
  }

  // ── Section: TOU schedule ───────────────────────────────────────────

  private renderTou(s: Shp2Strategy): TemplateResult {
    const task = s.timeTask;
    const headerBadge = task
      ? html`<ef-badge slot="header" tone=${task.isEnabled ? 'ok' : 'neutral'}
          >${task.isEnabled ? 'enabled' : 'disabled'}</ef-badge
        >`
      : html`<ef-badge slot="header" tone="neutral">no task</ef-badge>`;

    if (!task) {
      return html`<ef-section .title=${'Charge schedule'}>
        ${headerBadge}
        <div class="no-data">
          No scheduled charge/discharge task configured on the SHP2.
        </div>
      </ef-section>`;
    }

    return html`<ef-section .title=${'Charge schedule'}>
      ${headerBadge}
      <div class="tou-tiles">
        <ef-tile label="Task" value=${this.taskLabel(task.type)}>
          <span slot="label">${glossary('charge schedule')}</span>
        </ef-tile>
        <ef-tile label="Repeat" value=${this.modeLabel(task.timeMode)}></ef-tile>
        <ef-tile label="Target SoC" value=${fmtPct(task.chargeCeilingSoc)}>
          <span>floor ${fmtPct(task.chargeFloorSoc)}</span>
        </ef-tile>
        <ef-tile label="Charge power" value=${fmtW(task.chargeWatts)}>
          <span slot="label">${glossary('charge power')}</span>
        </ef-tile>
      </div>
      ${this.renderDayTimeline(task.windows)}
      <div class="tou-hint full">
        ${task.windows.length === 0
          ? 'No active window in the schedule bitmap.'
          : html`Active window${task.windows.length > 1 ? 's' : ''}:
              ${task.windows
                .map(
                  (w) =>
                    `${this.fmtClock(w.startMinute)}–${this.fmtClock(w.endMinute)}`,
                )
                .join(', ')}
              · ${task.slotMinutes}-min resolution`}
        ${!task.isEnabled
          ? ' · task currently disabled, so this window is not being acted on.'
          : nothing}
      </div>
    </ef-section>`;
  }

  private renderDayTimeline(windows: Shp2ChargeWindow[]): TemplateResult {
    const DAY = 24 * 60;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const ticks = ['12a', '4a', '8a', '12p', '4p', '8p', '12a'];
    return html`<div class="full">
      <div class="tou-timeline">
        ${Array.from({ length: 23 }, (_, i) => i + 1).map(
          (h) =>
            html`<div class="tou-grid" style="left:${(h / 24) * 100}%"></div>`,
        )}
        ${windows.map(
          (w) => html`<div
            class="tou-window"
            style="left:${(w.startMinute / DAY) * 100}%;width:${((w.endMinute - w.startMinute) /
              DAY) *
            100}%"
          ></div>`,
        )}
        <div class="tou-now" style="left:${(nowMin / DAY) * 100}%" title="now"></div>
      </div>
      <div class="tou-ticks">
        ${ticks.map((t) => html`<span>${t}</span>`)}
      </div>
    </div>`;
  }

  // ── Section: recommendations from /api/dispatch-plan ────────────────

  private renderRecommendations(): TemplateResult {
    const plan = this.plan.data;
    const stale = this.plan.stale;

    if (!plan && !stale) {
      return html`<ef-section .title=${'Recommendations'}>
        <div class="no-data">Computing dispatch plan…</div>
      </ef-section>`;
    }
    if (!plan) {
      return html`<ef-section .title=${'Recommendations'}>
        <ef-badge slot="header" tone="warn">stale data</ef-badge>
        <div class="no-data">Dispatch plan unavailable.</div>
      </ef-section>`;
    }

    // Filter to next-24h actionable hours (skip "hold") so the list stays
    // short. Group runs of the same action into one row to avoid a wall of
    // identical "Charge from solar" entries.
    const nowTs = Date.now();
    const upcoming = plan.hours.filter((h) => h.ts >= nowTs - 60 * 60 * 1000 && h.action !== 'hold');
    const grouped = this.groupConsecutive(upcoming);
    const shown = grouped.slice(0, 4);
    const savings = plan.estimatedSavingsDollars;

    if (shown.length === 0) {
      return html`<ef-section .title=${'Recommendations'}>
        ${stale ? html`<ef-badge slot="header" tone="warn">stale data</ef-badge>` : nothing}
        <div class="no-data">
          No active dispatch actions in the next 24 hours — hold and self-consume.
        </div>
        ${savings > 0
          ? html`<div class="strategy-hint full">
              Plan saves ~${this.fmtDollars(savings)} vs all-grid baseline.
            </div>`
          : nothing}
      </ef-section>`;
    }

    return html`<ef-section .title=${'Recommendations'}>
      ${stale ? html`<ef-badge slot="header" tone="warn">stale data</ef-badge>` : nothing}
      <div class="rec-list">
        ${shown.map((g) => this.renderRecRow(g))}
      </div>
      ${savings !== 0
        ? html`<div class="strategy-hint full">
            Plan saves ~${this.fmtDollars(savings)} vs all-grid baseline · target ${plan.targetPrePeakSocPct}%
            SoC before peak.
          </div>`
        : nothing}
    </ef-section>`;
  }

  /**
   * Collapse runs of identical actions into single rows. The dispatch plan is
   * hourly; a 3-hour PV-charge block reads better as one entry than three.
   */
  private groupConsecutive(hours: DispatchHour[]): Array<{
    startTs: number;
    endTs: number;
    action: DispatchAction;
    totalFlowKwh: number;
    totalCostDollars: number;
    onPeak: boolean;
    finalSocPct: number;
  }> {
    const out: Array<{
      startTs: number;
      endTs: number;
      action: DispatchAction;
      totalFlowKwh: number;
      totalCostDollars: number;
      onPeak: boolean;
      finalSocPct: number;
    }> = [];
    for (const h of hours) {
      const last = out[out.length - 1];
      // 1h window per dispatch step matches server cadence.
      const stepMs = 60 * 60 * 1000;
      if (last && last.action === h.action && h.ts - last.endTs <= stepMs + 1) {
        last.endTs = h.ts + stepMs;
        last.totalFlowKwh += h.flowW / 1000;
        last.totalCostDollars += h.hourlyCostDollars;
        last.onPeak = last.onPeak || h.onPeak;
        last.finalSocPct = h.socEndPct;
      } else {
        out.push({
          startTs: h.ts,
          endTs: h.ts + stepMs,
          action: h.action,
          totalFlowKwh: h.flowW / 1000,
          totalCostDollars: h.hourlyCostDollars,
          onPeak: h.onPeak,
          finalSocPct: h.socEndPct,
        });
      }
    }
    return out;
  }

  private renderRecRow(g: {
    startTs: number;
    endTs: number;
    action: DispatchAction;
    totalFlowKwh: number;
    totalCostDollars: number;
    onPeak: boolean;
    finalSocPct: number;
  }): TemplateResult {
    const tone = this.actionTone(g.action);
    const label = this.actionLabel(g.action);
    const time = `${this.fmtHourTs(g.startTs)}–${this.fmtHourTs(g.endTs)}`;
    // Cost surfacing: grid_import = cost (positive $), others = saved cost.
    const savings = g.action === 'grid_import' ? -g.totalCostDollars : 0;
    const sub = `${Math.round(Math.abs(g.totalFlowKwh) * 10) / 10} kWh · ends ${g.finalSocPct.toFixed(0)}% SoC${
      g.onPeak ? ' · on-peak' : ''
    }`;
    return html`<div class="rec-row">
      <span class="rec-time">${time}</span>
      <div class="rec-detail">
        <ef-badge tone=${tone}>${label}</ef-badge>
        <span class="sub">${sub}</span>
      </div>
      <span class="rec-savings">
        ${g.action === 'grid_import'
          ? html`<span style="color:var(--ef-warn)">${this.fmtDollars(g.totalCostDollars)}</span>`
          : savings > 0
            ? html`<span style="color:var(--ef-ok)">${this.fmtDollars(savings)}</span>`
            : nothing}
      </span>
    </div>`;
  }

  getCardSize(): number {
    return 8;
  }
}

// Register in HA's custom-cards catalog so it shows up in the card picker.
(window as unknown as { customCards?: unknown[] }).customCards =
  (window as unknown as { customCards?: unknown[] }).customCards || [];
(window as unknown as { customCards: unknown[] }).customCards.push({
  type: 'ecoflow-strategy-card',
  name: 'EcoFlow Strategy Card',
  description: 'SHP2 load-shed priorities, TOU schedule and dispatch recommendations (read-only)',
});
