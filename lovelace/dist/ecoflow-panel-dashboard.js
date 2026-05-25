/**
 * EcoFlow Panel — Multi-tab Dashboard card (HACS plugin, v0.9.4).
 *
 * Bigger sibling of the v0.9.0 stats card. Four navigable tabs:
 *
 *   - Dashboard: PV/load/backup + per-DPU compact tiles + alert summary
 *   - Battery:   per-pack SoC/SoH/temp + degradation summary + EOL
 *   - Forecast:  next-24h mini-chart (CSS bars) + 3-day rollups
 *   - Alerts:    full active alerts list with severity coloring
 *
 * Not the full PWA — rich SVG flow diagrams, interactive charts,
 * per-cell voltage tables, strategy config UI stay in the PWA. For
 * those, the "Open full dashboard" button launches the PWA in a tab.
 *
 * Usage in Lovelace YAML:
 *
 *   type: 'custom:ecoflow-panel-dashboard'
 *   host: http://homeassistant.local:8787
 *   refresh_seconds: 30
 *   default_tab: dashboard    # dashboard | battery | forecast | alerts
 *
 * Standalone Web Component (no Lit / framework dep), packaged
 * alongside `ecoflow-panel-card.js` in the same HACS plugin repo.
 */

class EcoFlowPanelDashboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._snapshot = null;
    this._forecast = null;
    this._degradation = null;
    this._packRisk = null;
    this._timer = null;
    this._lastError = null;
    this._activeTab = 'dashboard';
  }

  setConfig(config) {
    if (!config) throw new Error('Card config missing');
    this._config = {
      host: config.host || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:8787` : ''),
      refresh_seconds: Math.max(5, Number(config.refresh_seconds || 30)),
      title: config.title || 'EcoFlow Panel',
      default_tab: ['dashboard', 'battery', 'forecast', 'alerts'].includes(config.default_tab)
        ? config.default_tab
        : 'dashboard',
    };
    this._activeTab = this._config.default_tab;
    this._scheduleNext();
  }

  set hass(_hass) {}
  getCardSize() { return 8; }

  connectedCallback() {
    this._render();
    this._fetchAll();
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
  }

  _scheduleNext() {
    if (this._timer) clearInterval(this._timer);
    if (!this._config) return;
    this._timer = setInterval(() => this._fetchAll(), this._config.refresh_seconds * 1000);
  }

  async _fetchAll() {
    if (!this._config?.host) return;
    const base = this._config.host;
    const fetchJson = async (path) => {
      try {
        const r = await fetch(`${base}${path}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        return null;
      }
    };
    try {
      const [snap, fc, deg, risk] = await Promise.all([
        fetchJson('/api/snapshot'),
        fetchJson('/api/forecast'),
        fetchJson('/api/degradation'),
        fetchJson('/api/pack-risk/v2'),
      ]);
      this._snapshot = snap;
      this._forecast = fc;
      this._degradation = deg;
      this._packRisk = risk;
      this._lastError = snap == null ? 'snapshot unreachable' : null;
    } catch (e) {
      this._lastError = e?.message || String(e);
    }
    this._render();
  }

  _setTab(tab) {
    this._activeTab = tab;
    this._render();
  }

  _render() {
    if (!this.shadowRoot) return;
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
      .header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; gap: 8px; }
      .title { font-size: 1.1rem; font-weight: 600; letter-spacing: 0.02em; }
      .meta { font-size: 0.75rem; color: var(--c-muted); }
      .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--c-line); margin-bottom: 12px; flex-wrap: wrap; }
      .tab {
        padding: 6px 12px;
        font-size: 0.85rem;
        cursor: pointer;
        background: none;
        border: none;
        color: var(--c-muted);
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        font-family: inherit;
      }
      .tab.active { color: var(--c-accent); border-bottom-color: var(--c-accent); }
      .tab:hover { color: var(--c-fg); }
      .err { background: rgba(239, 68, 68, 0.12); border: 1px solid var(--c-bad); padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; color: var(--c-bad); margin-bottom: 12px; }
      .skeleton { color: var(--c-muted); font-style: italic; font-size: 0.85rem; padding: 16px 0; text-align: center; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
      .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
      .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px; }
      .tile {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid var(--c-line);
        border-radius: 8px;
        padding: 10px 12px;
      }
      .tile-label { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-muted); margin-bottom: 6px; }
      .tile-value { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; font-size: 1.05rem; font-variant-numeric: tabular-nums; }
      .tile-sub { font-size: 0.7rem; color: var(--c-muted); margin-top: 4px; }
      .tile.accent .tile-value { color: var(--c-accent); }
      .tile.warn { border-color: var(--c-warn); }
      .tile.warn .tile-value { color: var(--c-warn); }
      .tile.bad { border-color: var(--c-bad); }
      .tile.bad .tile-value { color: var(--c-bad); }
      .tile.ok .tile-value { color: var(--c-ok); }
      .section { margin-top: 16px; }
      .section-title { font-size: 0.85rem; font-weight: 600; color: var(--c-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
      .chart-bars { display: flex; align-items: end; gap: 2px; height: 80px; padding: 8px 0; border-bottom: 1px solid var(--c-line); }
      .chart-bar { flex: 1; background: var(--c-accent); border-radius: 2px 2px 0 0; min-height: 2px; position: relative; }
      .chart-bar.night { background: rgba(255, 255, 255, 0.1); }
      .chart-labels { display: flex; justify-content: space-between; font-size: 0.6rem; color: var(--c-muted); padding-top: 4px; }
      .alert-row { display: grid; grid-template-columns: 60px 1fr auto; gap: 8px; align-items: center; padding: 8px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); margin-bottom: 4px; border-left: 3px solid var(--c-muted); font-size: 0.85rem; }
      .alert-row.crit { border-left-color: var(--c-bad); }
      .alert-row.warn { border-left-color: var(--c-warn); }
      .alert-row.info { border-left-color: var(--c-accent); }
      .alert-title { font-weight: 600; }
      .alert-detail { font-size: 0.75rem; color: var(--c-muted); margin-top: 2px; }
      .alert-sev { font-size: 0.65rem; text-transform: uppercase; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
      .alert-sev.crit { background: var(--c-bad); color: white; }
      .alert-sev.warn { background: var(--c-warn); color: black; }
      .alert-sev.info { background: var(--c-accent); color: black; }
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
      .risk-row { display: grid; grid-template-columns: 110px 1fr 80px; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--c-line); font-size: 0.85rem; }
      .risk-bar { height: 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); overflow: hidden; position: relative; }
      .risk-bar-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
      .risk-bar-fill.low { background: var(--c-ok); }
      .risk-bar-fill.moderate { background: var(--c-accent); }
      .risk-bar-fill.elevated { background: var(--c-warn); }
      .risk-bar-fill.critical { background: var(--c-bad); }
    `;

    const host = this._config?.host || '—';
    const tabs = ['dashboard', 'battery', 'forecast', 'alerts'];
    const tabLabels = { dashboard: 'Dashboard', battery: 'Battery', forecast: 'Forecast', alerts: 'Alerts' };

    if (!this._snapshot && !this._lastError) {
      this.shadowRoot.innerHTML = `<style>${css}</style><div class="card"><div class="header"><span class="title">${esc(this._config.title)}</span></div><div class="skeleton">Loading from ${esc(host)}…</div></div>`;
      return;
    }
    if (this._lastError && !this._snapshot) {
      this.shadowRoot.innerHTML = `<style>${css}</style><div class="card">
        <div class="header"><span class="title">${esc(this._config.title)}</span><span class="meta">${esc(host)}</span></div>
        <div class="err">Couldn't reach EcoFlow Panel: ${esc(this._lastError)}<br/><span style="font-size: 0.75rem; color: var(--c-muted)">Check the <code>host:</code> option. Verify with <code>curl ${esc(host)}/api/health</code>.</span></div>
      </div>`;
      return;
    }

    const tabsHtml = tabs.map((t) =>
      `<button class="tab ${this._activeTab === t ? 'active' : ''}" data-tab="${t}">${tabLabels[t]}</button>`
    ).join('');

    const alertCount = (this._snapshot.alerts || []).length;
    const onlineCount = Object.values(this._snapshot.devices || {}).filter((d) => d.online).length;
    const totalCount = Object.keys(this._snapshot.devices || {}).length;
    const lastUpdated = new Date(this._snapshot.generatedAt || Date.now()).toLocaleTimeString();

    let body = '';
    if (this._activeTab === 'dashboard') body = this._renderDashboardTab();
    else if (this._activeTab === 'battery') body = this._renderBatteryTab();
    else if (this._activeTab === 'forecast') body = this._renderForecastTab();
    else if (this._activeTab === 'alerts') body = this._renderAlertsTab();

    this.shadowRoot.innerHTML = `<style>${css}</style>
      <div class="card">
        <div class="header">
          <span class="title">${esc(this._config.title)}</span>
          <span class="meta">${onlineCount}/${totalCount} online · ${alertCount} alerts · ${lastUpdated}</span>
        </div>
        <div class="tabs">${tabsHtml}</div>
        ${body}
        <div class="actions">
          <a class="btn" href="${esc(host)}" target="_blank" rel="noopener">Open full dashboard →</a>
        </div>
      </div>
    `;

    // Tab click handlers (re-attached every render)
    this.shadowRoot.querySelectorAll('.tab').forEach((el) => {
      el.addEventListener('click', () => this._setTab(el.getAttribute('data-tab')));
    });
  }

  _renderDashboardTab() {
    const s = this._snapshot;
    const devices = Object.values(s.devices || {});
    const shp2 = devices.find((d) => d.projection?.kind === 'shp2');
    const dpus = devices.filter((d) => d.projection?.kind === 'dpu' && d.online);

    let fleetPv = 0, fleetIn = 0, fleetOut = 0;
    for (const d of dpus) {
      fleetPv += d.projection.pvTotalWatts || 0;
      fleetIn += d.projection.totalInWatts || 0;
      fleetOut += d.projection.totalOutWatts || 0;
    }
    const panelLoad = shp2 ? (shp2.projection.circuits || []).reduce((s, c) => s + (c.watts || 0), 0) : 0;
    const acIn = dpus.reduce((s, d) => s + (d.projection.acInWatts || 0), 0);

    const backupPct = shp2?.projection.backupBatPercent;
    const backupRemain = shp2?.projection.backupRemainWh;
    const backupFull = shp2?.projection.backupFullCapWh;

    const dpuTiles = dpus.map((d) => {
      const p = d.projection;
      const soc = p.soc != null ? `${Math.round(p.soc)}%` : '—';
      const pv = p.pvTotalWatts != null ? `${Math.round(p.pvTotalWatts)} W PV` : '';
      const out = p.totalOutWatts != null ? `${Math.round(p.totalOutWatts)} W out` : '';
      return `<div class="tile">
        <div class="tile-label">${esc(d.deviceName)}</div>
        <div class="tile-value">${esc(soc)}</div>
        <div class="tile-sub">${esc(pv)}${pv && out ? ' · ' : ''}${esc(out)}</div>
      </div>`;
    }).join('');

    return `
      <div class="section">
        <div class="grid">
          <div class="tile accent">
            <div class="tile-label">Solar now</div>
            <div class="tile-value">${Math.round(fleetPv).toLocaleString()} W</div>
            <div class="tile-sub">${dpus.length} DPU online</div>
          </div>
          <div class="tile">
            <div class="tile-label">Panel load</div>
            <div class="tile-value">${Math.round(panelLoad).toLocaleString()} W</div>
            <div class="tile-sub">${acIn < 5 ? 'off-grid' : `grid: ${Math.round(acIn)} W`}</div>
          </div>
          <div class="tile ${backupPct < 25 ? 'bad' : backupPct < 50 ? 'warn' : 'ok'}">
            <div class="tile-label">Backup pool</div>
            <div class="tile-value">${backupPct != null ? Math.round(backupPct) + '%' : '—'}</div>
            <div class="tile-sub">${backupRemain != null && backupFull != null ? `${(backupRemain / 1000).toFixed(1)} / ${(backupFull / 1000).toFixed(1)} kWh` : ''}</div>
          </div>
          <div class="tile">
            <div class="tile-label">Battery net</div>
            <div class="tile-value">${Math.round(fleetOut - fleetIn).toLocaleString()} W</div>
            <div class="tile-sub">${fleetOut - fleetIn > 0 ? 'discharging' : 'charging'}</div>
          </div>
        </div>
      </div>
      ${dpus.length > 0 ? `
      <div class="section">
        <div class="section-title">Per-DPU live</div>
        <div class="grid-2">${dpuTiles}</div>
      </div>
      ` : ''}
    `;
  }

  _renderBatteryTab() {
    const deg = this._degradation;
    const risk = this._packRisk;
    if (!deg) return `<div class="skeleton">Loading degradation data…</div>`;

    const packs = deg.packs || [];
    const projecting = packs.filter((p) => p.status === 'projecting');
    const learning = packs.filter((p) => p.status === 'learning');
    const stable = packs.filter((p) => p.status === 'stable');

    const soonest = projecting.reduce((b, p) => (b == null || (p.yearsToEol ?? 1e9) < (b.yearsToEol ?? 1e9) ? p : b), null);
    const outliers = projecting.filter((p) => p.peerOutlier);

    const riskRows = (risk?.packs || []).slice(0, 8).map((p) => {
      const tier = p.composite0to100 >= 75 ? 'critical' : p.composite0to100 >= 50 ? 'elevated' : p.composite0to100 >= 25 ? 'moderate' : 'low';
      return `<div class="risk-row">
        <span>Core ${p.coreNum} · Pk ${p.packNum}</span>
        <div class="risk-bar"><div class="risk-bar-fill ${tier}" style="width: ${p.composite0to100}%"></div></div>
        <span style="text-align: right; font-family: ui-monospace; font-size: 0.8rem;">${p.composite0to100}</span>
      </div>`;
    }).join('');

    return `
      <div class="section">
        <div class="grid">
          <div class="tile">
            <div class="tile-label">Packs tracked</div>
            <div class="tile-value">${packs.length}</div>
            <div class="tile-sub">${projecting.length} projecting · ${learning.length} learning · ${stable.length} stable</div>
          </div>
          <div class="tile ${outliers.length > 0 ? 'warn' : ''}">
            <div class="tile-label">Peer outliers</div>
            <div class="tile-value">${outliers.length}</div>
            <div class="tile-sub">${outliers.length > 0 ? 'wearing faster than peers' : 'all packs on track'}</div>
          </div>
          <div class="tile ${soonest?.yearsToEol < 3 ? 'warn' : ''}">
            <div class="tile-label">Soonest EOL</div>
            <div class="tile-value">${soonest?.yearsToEol != null ? `${soonest.yearsToEol} yr` : '—'}</div>
            <div class="tile-sub">${soonest ? `Core ${soonest.coreNum} · Pk ${soonest.packNum}` : ''}</div>
          </div>
          ${risk ? `<div class="tile">
            <div class="tile-label">ML model</div>
            <div class="tile-value">${risk.modelSource === 'labeled' ? 'real' : 'baseline'}</div>
            <div class="tile-sub">${esc(risk.modelVersion)}</div>
          </div>` : ''}
        </div>
      </div>
      ${risk ? `
      <div class="section">
        <div class="section-title">Pack risk (composite — heuristic + trained + novelty)</div>
        ${riskRows}
      </div>
      ` : ''}
    `;
  }

  _renderForecastTab() {
    const fc = this._forecast;
    if (!fc) return `<div class="skeleton">Loading forecast…</div>`;

    const hours = fc.hours || [];
    const maxPv = Math.max(...hours.map((h) => h.forecastPvW), 1);
    const bars = hours.slice(0, 24).map((h) => {
      const hour = new Date(h.ts).getHours();
      const isDay = hour >= 5 && hour <= 20;
      const heightPct = (h.forecastPvW / maxPv) * 100;
      return `<div class="chart-bar ${isDay ? '' : 'night'}" style="height: ${heightPct}%" title="${hour}:00 — ${Math.round(h.forecastPvW)} W"></div>`;
    }).join('');

    return `
      <div class="section">
        <div class="grid">
          <div class="tile accent">
            <div class="tile-label">Next 24h PV</div>
            <div class="tile-value">${(fc.forecastPvWhNext24 / 1000).toFixed(1)} kWh</div>
            <div class="tile-sub">typical: ${(fc.typicalPvWhPerDay / 1000).toFixed(1)} kWh/day</div>
          </div>
          <div class="tile ${fc.minProjectedSoc != null && fc.minProjectedSoc < fc.reserveSoc ? 'warn' : ''}">
            <div class="tile-label">Min projected SoC</div>
            <div class="tile-value">${fc.minProjectedSoc != null ? Math.round(fc.minProjectedSoc) + '%' : '—'}</div>
            <div class="tile-sub">reserve floor: ${fc.reserveSoc}%</div>
          </div>
          <div class="tile">
            <div class="tile-label">History depth</div>
            <div class="tile-value">${fc.historyDays != null ? Math.round(fc.historyDays) + ' d' : '—'}</div>
            <div class="tile-sub">${fc.hasWeather ? 'weather: live' : 'weather: offline'}</div>
          </div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">Next 24 hours — hourly PV</div>
        <div class="chart-bars">${bars}</div>
        <div class="chart-labels"><span>now</span><span>+6 h</span><span>+12 h</span><span>+18 h</span><span>+24 h</span></div>
      </div>
    `;
  }

  _renderAlertsTab() {
    const alerts = this._snapshot.alerts || [];
    if (alerts.length === 0) {
      return `<div class="section"><div class="tile ok"><div class="tile-label">All clear</div><div class="tile-value">0 alerts</div><div class="tile-sub">No active conditions across the fleet.</div></div></div>`;
    }
    const sevRank = { critical: 0, warning: 1, info: 2 };
    const sevShort = { critical: 'crit', warning: 'warn', info: 'info' };
    const sorted = [...alerts].sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));
    const rows = sorted.map((a) => {
      const s = sevShort[a.severity] || 'info';
      return `<div class="alert-row ${s}">
        <span class="alert-sev ${s}">${s}</span>
        <div>
          <div class="alert-title">${esc(a.title)}</div>
          <div class="alert-detail">${esc(a.detail || '')}</div>
        </div>
        <span class="meta">${esc(a.device || '')}</span>
      </div>`;
    }).join('');
    return `<div class="section">${rows}</div>`;
  }

  static getConfigElement() {
    return null;
  }

  static getStubConfig() {
    return { host: 'http://homeassistant.local:8787', refresh_seconds: 30, default_tab: 'dashboard' };
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

if (!customElements.get('ecoflow-panel-dashboard')) {
  customElements.define('ecoflow-panel-dashboard', EcoFlowPanelDashboard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'ecoflow-panel-dashboard',
    name: 'EcoFlow Panel — Dashboard',
    description: 'Multi-tab Lovelace card for the EcoFlow Panel add-on (Dashboard / Battery / Forecast / Alerts).',
    preview: true,
  });
}

console.info(
  '%c EcoFlow Panel Dashboard %c v0.9.4 ',
  'color: white; background: #0b1014; padding: 2px 6px; border-radius: 3px 0 0 3px;',
  'color: #0b1014; background: #22d3ee; padding: 2px 6px; border-radius: 0 3px 3px 0;',
);
