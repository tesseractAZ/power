/**
 * EcoFlow Panel — Lovelace custom card (HACS plugin, v0.9.0).
 *
 * Standalone Web Component (no framework deps) that fetches /api/ha-state
 * from a running EcoFlow Panel server and renders the headline numbers
 * inside a Home Assistant Lovelace dashboard. Click "Open dashboard" to
 * launch the full React PWA in a new tab.
 *
 * Usage in Lovelace YAML:
 *
 *   type: 'custom:ecoflow-panel-card'
 *   host: http://homeassistant.local:8787
 *   refresh_seconds: 30
 *
 * Defaults: host = window.location.origin/api swapped to :8787, refresh 30s.
 *
 * This card is intentionally lightweight — it shows ~12 headline numbers,
 * not the full Predictive Insights / Advanced Insights surface. For that,
 * open the PWA via the "Open dashboard" button.
 */

class EcoFlowPanelCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._state = null;
    this._timer = null;
    this._lastError = null;
  }

  // Lovelace calls setConfig() when the card is created; we use it to
  // capture the user's `host`/`refresh_seconds` options and start polling.
  setConfig(config) {
    if (!config) throw new Error('Card config missing');
    this._config = {
      host: config.host || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:8787` : ''),
      refresh_seconds: Math.max(5, Number(config.refresh_seconds || 30)),
      title: config.title || 'EcoFlow Panel',
    };
    this._scheduleNext();
  }

  // Lovelace passes hass on every state change; we ignore it (we have our
  // own polling) but the method is required to exist.
  set hass(_hass) {}

  getCardSize() {
    return 4;
  }

  connectedCallback() {
    this._render();
    this._fetch();
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
  }

  _scheduleNext() {
    if (this._timer) clearInterval(this._timer);
    if (!this._config) return;
    this._timer = setInterval(() => this._fetch(), this._config.refresh_seconds * 1000);
  }

  async _fetch() {
    if (!this._config?.host) return;
    try {
      const res = await fetch(`${this._config.host}/api/ha-state`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._state = await res.json();
      this._lastError = null;
    } catch (e) {
      this._lastError = e?.message || String(e);
    }
    this._render();
  }

  _render() {
    if (!this.shadowRoot) return;
    const s = this._state;
    const err = this._lastError;
    const host = this._config?.host || '—';

    const css = `
      :host {
        --c-bg: var(--card-background-color, #1c1c1e);
        --c-fg: var(--primary-text-color, #ffffff);
        --c-muted: var(--secondary-text-color, #8e8e93);
        --c-line: var(--divider-color, #2c2c2e);
        --c-accent: var(--accent-color, #22d3ee);
        --c-warn: var(--warning-color, #fbbf24);
        --c-bad: var(--error-color, #ef4444);
        --c-ok: var(--success-color, #10b981);
      }
      .card {
        background: var(--c-bg);
        color: var(--c-fg);
        border-radius: 12px;
        padding: 16px;
        font-family: var(--paper-font-body1_-_font-family, system-ui, -apple-system, sans-serif);
      }
      .header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 12px;
        gap: 8px;
      }
      .title { font-size: 1.1rem; font-weight: 600; letter-spacing: 0.02em; }
      .meta { font-size: 0.75rem; color: var(--c-muted); }
      .err { background: rgba(239, 68, 68, 0.12); border: 1px solid var(--c-bad); padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; color: var(--c-bad); margin-bottom: 12px; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(125px, 1fr));
        gap: 10px;
      }
      .tile {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid var(--c-line);
        border-radius: 8px;
        padding: 10px 12px;
      }
      .tile-label {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--c-muted);
        margin-bottom: 6px;
      }
      .tile-value {
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-weight: 600;
        font-size: 1.05rem;
        font-variant-numeric: tabular-nums;
      }
      .tile-sub { font-size: 0.7rem; color: var(--c-muted); margin-top: 4px; }
      .tile.accent .tile-value { color: var(--c-accent); }
      .tile.warn .tile-value { color: var(--c-warn); }
      .tile.bad .tile-value { color: var(--c-bad); }
      .tile.ok .tile-value { color: var(--c-ok); }
      .actions { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
      .btn {
        background: rgba(34, 211, 238, 0.12);
        color: var(--c-accent);
        border: 1px solid var(--c-accent);
        border-radius: 6px;
        padding: 6px 12px;
        font-size: 0.8rem;
        cursor: pointer;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .btn:hover { background: rgba(34, 211, 238, 0.2); }
      .skeleton { color: var(--c-muted); font-style: italic; font-size: 0.85rem; padding: 16px 0; text-align: center; }
    `;

    if (!s && !err) {
      this.shadowRoot.innerHTML = `<style>${css}</style><div class="card"><div class="header"><span class="title">${this._config.title}</span></div><div class="skeleton">Loading from ${host}…</div></div>`;
      return;
    }

    if (err) {
      this.shadowRoot.innerHTML = `<style>${css}</style><div class="card">
        <div class="header"><span class="title">${this._config.title}</span><span class="meta">${host}</span></div>
        <div class="err">Couldn't reach EcoFlow Panel: ${esc(err)}<br/><span style="font-size: 0.75rem; color: var(--c-muted)">Check the <code>host:</code> option points to your running add-on. Verify with <code>curl ${host}/api/health</code>.</span></div>
      </div>`;
      return;
    }

    const fmtW = (w) => (w == null ? '—' : `${Math.round(w).toLocaleString()} W`);
    const fmtKwh = (k) => (k == null ? '—' : `${Number(k).toFixed(1)} kWh`);
    const fmtPct = (p) => (p == null ? '—' : `${Number(p).toFixed(0)}%`);
    const fmtHours = (h) => (h == null ? '—' : `${Number(h).toFixed(1)} h`);
    const fmtUsd = (d) => (d == null ? '—' : `$${Number(d).toFixed(2)}`);

    const runwayClass = (s.runway_to_reserve_hours != null && s.runway_to_reserve_hours < 4) ? 'bad'
      : (s.runway_to_reserve_hours != null && s.runway_to_reserve_hours < 12) ? 'warn'
      : 'ok';
    const backupClass = (s.backup_pool_percent != null && s.backup_pool_percent < 25) ? 'bad'
      : (s.backup_pool_percent != null && s.backup_pool_percent < 50) ? 'warn'
      : 'ok';
    const gridClass = s.off_grid ? 'ok' : 'warn';
    const alertClass = s.alert_critical_count > 0 ? 'bad' : s.alert_warning_count > 0 ? 'warn' : 'ok';

    this.shadowRoot.innerHTML = `<style>${css}</style>
      <div class="card">
        <div class="header">
          <span class="title">${esc(this._config.title)}</span>
          <span class="meta">${s.fleet_devices_online}/${s.fleet_devices_total} online · ${new Date(s.generated_at).toLocaleTimeString()}</span>
        </div>
        <div class="grid">
          <div class="tile accent">
            <div class="tile-label">PV right now</div>
            <div class="tile-value">${fmtW(s.fleet_pv_watts)}</div>
            <div class="tile-sub">forecast 24h: ${fmtKwh(s.forecast_pv_next_24h_kwh)}</div>
          </div>
          <div class="tile">
            <div class="tile-label">Panel load</div>
            <div class="tile-value">${fmtW(s.panel_load_watts)}</div>
            <div class="tile-sub">${s.off_grid ? 'off-grid' : `grid in ${fmtW(s.ac_import_watts)}`}</div>
          </div>
          <div class="tile ${backupClass}">
            <div class="tile-label">Backup pool</div>
            <div class="tile-value">${fmtPct(s.backup_pool_percent)}</div>
            <div class="tile-sub">${fmtKwh(s.backup_remaining_kwh)} of ${fmtKwh(s.backup_full_capacity_kwh)}</div>
          </div>
          <div class="tile ${runwayClass}">
            <div class="tile-label">Runway to reserve</div>
            <div class="tile-value">${fmtHours(s.runway_to_reserve_hours)}</div>
            <div class="tile-sub">to empty: ${fmtHours(s.runway_to_empty_hours)}</div>
          </div>
          <div class="tile">
            <div class="tile-label">Projected SoC low</div>
            <div class="tile-value">${fmtPct(s.projected_low_soc_percent)}</div>
            <div class="tile-sub">${s.projected_low_soc_at ? new Date(s.projected_low_soc_at).toLocaleString([], { weekday: 'short', hour: 'numeric' }) : '—'}</div>
          </div>
          <div class="tile ${gridClass}">
            <div class="tile-label">Grid status</div>
            <div class="tile-value">${s.off_grid ? 'OFF-GRID' : 'IMPORTING'}</div>
            <div class="tile-sub">${s.fleet_devices_online}/${s.fleet_devices_total} online</div>
          </div>
          <div class="tile">
            <div class="tile-label">PV today (lifetime)</div>
            <div class="tile-value">${fmtKwh(s.pv_lifetime_kwh)}</div>
            <div class="tile-sub">CO2 saved: ${s.carbon_lifetime_kg_avoided ?? '—'} kg</div>
          </div>
          <div class="tile">
            <div class="tile-label">RTE (7d)</div>
            <div class="tile-value">${fmtPct(s.round_trip_efficiency_percent)}</div>
            <div class="tile-sub">solar fraction of load: ${fmtPct(s.solar_fraction_of_load_percent)}</div>
          </div>
          <div class="tile">
            <div class="tile-label">Tariff savings (7d)</div>
            <div class="tile-value">${fmtUsd(s.tariff_net_savings_7d_dollars)}</div>
            <div class="tile-sub">today: ${fmtUsd(s.tariff_today_solar_value_dollars)}</div>
          </div>
          <div class="tile ${alertClass}">
            <div class="tile-label">Alerts</div>
            <div class="tile-value">${(s.alert_critical_count || 0) + (s.alert_warning_count || 0)}</div>
            <div class="tile-sub">${s.alert_critical_count || 0} crit · ${s.alert_warning_count || 0} warn · ${s.learned_warning_count || 0} learned</div>
          </div>
          <div class="tile">
            <div class="tile-label">Soonest pack EOL</div>
            <div class="tile-value">${s.degradation_soonest_eol_years != null ? `${s.degradation_soonest_eol_years} yr` : '—'}</div>
            <div class="tile-sub">${s.degradation_soonest_eol_pack || `${s.degradation_packs_projecting || 0} projecting`}</div>
          </div>
          <div class="tile">
            <div class="tile-label">Clipped today</div>
            <div class="tile-value">${fmtKwh(s.pv_clipped_kwh_today)}</div>
            <div class="tile-sub">${s.pv_hours_at_peak_today || 0} h at array peak</div>
          </div>
        </div>
        <div class="actions">
          <a class="btn" href="${host}" target="_blank" rel="noopener">Open dashboard →</a>
          <a class="btn" href="${host}/api/repair-issues" target="_blank" rel="noopener">Repair issues</a>
          <a class="btn" href="${host}/api/calendar.ics" target="_blank" rel="noopener">Calendar feed</a>
        </div>
      </div>
    `;
  }

  static getConfigElement() {
    return null; // no GUI editor — YAML-only for now
  }

  static getStubConfig() {
    return { host: 'http://homeassistant.local:8787', refresh_seconds: 30 };
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

if (!customElements.get('ecoflow-panel-card')) {
  customElements.define('ecoflow-panel-card', EcoFlowPanelCard);
  // Register with HA's card picker so it appears in the "Add card" UI.
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'ecoflow-panel-card',
    name: 'EcoFlow Panel',
    description: 'Headline live values from your EcoFlow Panel add-on (PV, load, battery, runway, savings, alerts).',
    preview: true,
  });
}

console.info(
  '%c EcoFlow Panel Card %c v0.9.0 ',
  'color: white; background: #0b1014; padding: 2px 6px; border-radius: 3px 0 0 3px;',
  'color: #0b1014; background: #22d3ee; padding: 2px 6px; border-radius: 0 3px 3px 0;',
);
