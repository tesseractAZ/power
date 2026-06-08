import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { EcoflowCardBase } from '../shared/base-card.js';
import { themeCss } from '../shared/theme.css.js';
import { glossary } from '../shared/glossary.js';
import { priorityOf, priorityCounts, ALARM_PRIORITY_ORDER, ALARM_PRIORITY_META } from '../shared/alerts.js';
import type { Alert, ClearedAlert } from '../shared/types.js';
import { fmtMins, fmtRel } from '../shared/format.js';
// Side-effect imports register the custom elements.
import '../shared/primitives/ef-badge.js';
import '../shared/primitives/ef-tile.js';
import '../shared/primitives/ef-section.js';

/**
 * PR4 alerts card. Renders three logical sections inside one `ha-card`:
 *
 *   1. Active alerts — pulled live from `snapshot.alerts`. No extra fetch;
 *      the snapshot store already streams the freshest list. Operator can
 *      Ack / Dismiss / Failed each one — the verdict POSTs to
 *      /api/alerts/outcome and is the labeled-feedback signal feeding the
 *      learned-risk model.
 *
 *   2. Cleared today — fetched lazily from /api/alerts/history when the
 *      operator expands the section. Default-collapsed to keep the card
 *      compact.
 *
 *   3. Predictive insights — the learned/anomaly subset of the active list,
 *      separated visually so it doesn't get lost among threshold alerts.
 *      Anything with `source === 'learned'` or `id.startsWith('forecast-')`
 *      lands here (mirrors web/src/pages/PredictiveInsights.tsx).
 *
 *   4. Notify status — channel + Test button. Read once per render and on
 *      first connect, refreshed when the Test button completes.
 *
 * Independent of PR3's fleet card; both can mount side-by-side at the same
 * host and share the underlying snapshot WS via the per-host store.
 */
@customElement('ecoflow-alerts-card')
export class EcoflowAlertsCard extends EcoflowCardBase {
  @state() private cleared: ClearedAlert[] = [];
  @state() private clearedExpanded = false;
  @state() private clearedLoading = false;
  @state() private clearedError: string | null = null;
  @state() private notifyStatus: NotifyStatus | null = null;
  @state() private notifyTestState: TestState = 'idle';
  @state() private notifyTestMsg = '';
  /** Outcomes the operator submitted this session — keyed by alert id. */
  @state() private submittedOutcomes: Map<string, Outcome> = new Map();
  /** Outcome buttons in flight, keyed by alert id. */
  @state() private busyOutcomes: Map<string, Outcome> = new Map();
  /** Outcome submission errors, keyed by alert id (auto-cleared after 4s). */
  @state() private outcomeErrors: Map<string, string> = new Map();

  static styles = [
    themeCss,
    css`
      :host {
        display: block;
        /* v0.11.0 — High (ISA P2) has no theme token of its own. Blend
           warn↔bad toward orange, falling back to a literal deep-orange where
           color-mix is unsupported. Critical reuses --ef-bad, Medium --ef-warn,
           Low --ef-info. */
        --ef-high: #fb8c00;
        --ef-high: color-mix(in srgb, var(--ef-warn) 55%, var(--ef-bad));
      }
      ha-card {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .title {
        font-weight: 600;
        font-size: 1rem;
        color: var(--ef-ink);
      }
      .count-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      /* v0.11.0 — ISA priority count chips. ef-badge lacks a High (orange)
         tone, so the 4-tier chips are rendered here keyed on data-prio. */
      .count-chip {
        display: inline-flex;
        align-items: center;
        font-size: 0.75rem;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
        line-height: 1.5;
        white-space: nowrap;
        background: var(--ef-line);
        color: var(--ef-ink);
      }
      .count-chip[data-prio='critical'] {
        background: color-mix(in srgb, var(--ef-bad) 22%, transparent);
        color: var(--ef-bad);
      }
      .count-chip[data-prio='high'] {
        background: color-mix(in srgb, var(--ef-high) 22%, transparent);
        color: var(--ef-high);
      }
      .count-chip[data-prio='medium'] {
        background: color-mix(in srgb, var(--ef-warn) 22%, transparent);
        color: var(--ef-warn);
      }
      .count-chip[data-prio='low'] {
        background: color-mix(in srgb, var(--ef-info) 22%, transparent);
        color: var(--ef-info);
      }
      .alerts-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .alert-row {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 8px;
        padding: 8px 10px;
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ef-panel) 92%, transparent);
      }
      .alert-row[data-prio='critical'] {
        border-color: color-mix(in srgb, var(--ef-bad) 45%, var(--ef-line));
        background: color-mix(in srgb, var(--ef-bad) 6%, var(--ef-panel));
      }
      .alert-row[data-prio='high'] {
        border-color: color-mix(in srgb, var(--ef-high) 45%, var(--ef-line));
        background: color-mix(in srgb, var(--ef-high) 6%, var(--ef-panel));
      }
      .alert-row[data-prio='medium'] {
        border-color: color-mix(in srgb, var(--ef-warn) 45%, var(--ef-line));
        background: color-mix(in srgb, var(--ef-warn) 5%, var(--ef-panel));
      }
      .alert-row[data-prio='low'] {
        border-color: var(--ef-line);
      }
      .sev-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-top: 6px;
        align-self: flex-start;
        background: var(--ef-muted);
      }
      .sev-dot[data-prio='critical'] {
        background: var(--ef-bad);
      }
      .sev-dot[data-prio='high'] {
        background: var(--ef-high);
      }
      .sev-dot[data-prio='medium'] {
        background: var(--ef-warn);
      }
      .sev-dot[data-prio='low'] {
        background: var(--ef-info);
      }
      .alert-body {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .alert-title-row {
        display: flex;
        align-items: baseline;
        gap: 6px;
        flex-wrap: wrap;
      }
      .alert-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--ef-ink);
      }
      .alert-meta {
        font-size: 0.7rem;
        color: var(--ef-muted);
      }
      .alert-detail {
        font-size: 0.78rem;
        color: var(--ef-muted);
        line-height: 1.35;
      }
      .outcome-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
        align-items: center;
      }
      button.outcome {
        font: inherit;
        font-size: 0.7rem;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 6px;
        border: 1px solid var(--ef-line);
        background: var(--ef-panel);
        color: var(--ef-ink);
        cursor: pointer;
        line-height: 1.2;
      }
      button.outcome:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--ef-accent) 50%, var(--ef-line));
      }
      button.outcome:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      button.outcome[data-color='ok'] {
        border-color: color-mix(in srgb, var(--ef-ok) 45%, var(--ef-line));
        color: var(--ef-ok);
      }
      button.outcome[data-color='bad'] {
        border-color: color-mix(in srgb, var(--ef-bad) 45%, var(--ef-line));
        color: var(--ef-bad);
      }
      .submitted-label {
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--ef-muted);
      }
      .submitted-label[data-outcome='ack'] {
        color: var(--ef-ok);
      }
      .submitted-label[data-outcome='failed'] {
        color: var(--ef-bad);
      }
      .outcome-error {
        font-size: 0.7rem;
        color: var(--ef-bad);
      }
      .empty-ok {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85rem;
        color: var(--ef-ok);
      }
      .show-btn {
        font: inherit;
        font-size: 0.75rem;
        background: transparent;
        border: 1px solid var(--ef-line);
        border-radius: 6px;
        padding: 2px 8px;
        color: var(--ef-accent);
        cursor: pointer;
      }
      .show-btn:hover {
        background: color-mix(in srgb, var(--ef-accent) 8%, transparent);
      }
      .cleared-meta {
        font-size: 0.7rem;
        color: var(--ef-muted);
      }
      .insight-fact {
        display: inline-block;
        font-size: 0.7rem;
        font-family: ui-monospace, monospace;
        background: color-mix(in srgb, var(--ef-line) 50%, transparent);
        border-radius: 4px;
        padding: 1px 6px;
        margin-right: 4px;
        color: var(--ef-ink);
      }
      .notify-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 0.8rem;
        color: var(--ef-ink);
      }
      .notify-status {
        color: var(--ef-muted);
      }
      .test-msg {
        font-size: 0.75rem;
      }
      .test-msg[data-state='ok'] {
        color: var(--ef-ok);
      }
      .test-msg[data-state='fail'] {
        color: var(--ef-bad);
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    void this.loadNotifyStatus();
  }

  /* ── Active alerts derivations ────────────────────────────────────── */

  private activeAlerts(): Alert[] {
    return this.snapshot?.alerts ?? [];
  }

  /** Threshold alerts (everything that isn't a learned / forecast prediction). */
  private thresholdAlerts(): Alert[] {
    return this.activeAlerts().filter(
      (a) => !this.isInsight(a) && !this.submittedOutcomes.has(a.id),
    );
  }

  /** Predictive: learned-source or forecast-id alerts. */
  private insightAlerts(): Alert[] {
    return this.activeAlerts().filter(
      (a) => this.isInsight(a) && !this.submittedOutcomes.has(a.id),
    );
  }

  private isInsight(a: Alert): boolean {
    return a.source === 'learned' || a.id.startsWith('forecast-');
  }

  /* ── Outcome submission ───────────────────────────────────────────── */

  private async submitOutcome(alertId: string, outcome: Outcome): Promise<void> {
    // Optimistic: hide the alert immediately by marking it submitted.
    // On failure, drop the submission so the alert reappears with an inline
    // error chip. The submitted-label still shows briefly so the operator
    // gets visible feedback while the POST is in flight.
    this.submittedOutcomes = new Map(this.submittedOutcomes).set(alertId, outcome);
    this.busyOutcomes = new Map(this.busyOutcomes).set(alertId, outcome);
    this.outcomeErrors = withoutKey(this.outcomeErrors, alertId);
    try {
      const url = this.apiUrl('/api/alerts/outcome');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, outcome }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      // Success — keep the submission. The row stays out of the active list
      // until the snapshot stream confirms the alert is gone server-side.
    } catch (e: unknown) {
      // Restore: drop the optimistic submission so the operator can retry.
      this.submittedOutcomes = withoutKey(this.submittedOutcomes, alertId);
      const msg = e instanceof Error ? e.message : String(e);
      this.outcomeErrors = new Map(this.outcomeErrors).set(alertId, msg);
      window.setTimeout(() => {
        this.outcomeErrors = withoutKey(this.outcomeErrors, alertId);
      }, 4000);
    } finally {
      this.busyOutcomes = withoutKey(this.busyOutcomes, alertId);
    }
  }

  /* ── Cleared history ──────────────────────────────────────────────── */

  private async toggleCleared(): Promise<void> {
    this.clearedExpanded = !this.clearedExpanded;
    if (this.clearedExpanded && this.cleared.length === 0 && !this.clearedLoading) {
      await this.loadCleared();
    }
  }

  private async loadCleared(): Promise<void> {
    this.clearedLoading = true;
    this.clearedError = null;
    try {
      const url = this.apiUrl('/api/alerts/history?limit=20');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { cleared?: ClearedAlert[] };
      this.cleared = (body.cleared ?? []).slice(0, 20);
    } catch (e: unknown) {
      this.clearedError = e instanceof Error ? e.message : String(e);
    } finally {
      this.clearedLoading = false;
    }
  }

  /* ── Notify status ───────────────────────────────────────────────── */

  private async loadNotifyStatus(): Promise<void> {
    try {
      const url = this.apiUrl('/api/notify/status');
      const res = await fetch(url);
      if (res.ok) this.notifyStatus = (await res.json()) as NotifyStatus;
    } catch {
      // Best-effort — leave status null so the row simply hides.
    }
  }

  private async sendNotifyTest(): Promise<void> {
    this.notifyTestState = 'sending';
    this.notifyTestMsg = '';
    try {
      const url = this.apiUrl('/api/notify/test');
      const res = await fetch(url, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && body?.ok) {
        this.notifyTestState = 'ok';
        this.notifyTestMsg = 'Test sent';
      } else {
        this.notifyTestState = 'fail';
        this.notifyTestMsg = body?.error ?? `HTTP ${res.status}`;
      }
    } catch (e: unknown) {
      this.notifyTestState = 'fail';
      this.notifyTestMsg = e instanceof Error ? e.message : String(e);
    }
    window.setTimeout(() => {
      this.notifyTestState = 'idle';
      this.notifyTestMsg = '';
    }, 5000);
  }

  /* ── URL helper ──────────────────────────────────────────────────── */

  private apiUrl(path: string): string {
    const host = this.effectiveHost().replace(/\/$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${host}${p}`;
  }

  /* ── Rendering ───────────────────────────────────────────────────── */

  private renderAlertRow(a: Alert) {
    const prio = priorityOf(a);
    const submitted = this.submittedOutcomes.get(a.id);
    const busy = this.busyOutcomes.get(a.id);
    const error = this.outcomeErrors.get(a.id);
    return html`
      <div class="alert-row" data-prio=${prio}>
        <span class="sev-dot" data-prio=${prio} aria-hidden="true"></span>
        <div class="alert-body">
          <div class="alert-title-row">
            <span class="alert-title">${a.title}</span>
            <span class="alert-meta">${a.category}</span>
            ${a.coreNum == null
              ? html`<span class="alert-meta">${a.device}</span>`
              : html`<span class="alert-meta">Core ${a.coreNum}${a.packNum != null ? ` / Pack ${a.packNum}` : ''}</span>`}
            ${a.source === 'learned' ? html`<ef-badge tone="info">learned</ef-badge>` : nothing}
          </div>
          <div class="alert-detail">${a.detail}</div>
          ${a.facts && a.facts.length > 0
            ? html`<div>
                ${a.facts.map(
                  (f) => html`<span class="insight-fact" title=${f.label}>${f.label}: ${f.value}</span>`,
                )}
              </div>`
            : nothing}
          <div class="outcome-row">
            ${submitted
              ? html`<span class="submitted-label" data-outcome=${submitted}
                  >${submittedLabel(submitted)}</span
                >`
              : html`
                  <button
                    class="outcome"
                    data-color="ok"
                    title="Acknowledge — real alert, dealing with it"
                    ?disabled=${busy != null}
                    @click=${() => this.submitOutcome(a.id, 'ack')}
                  >
                    ${busy === 'ack' ? '…' : glossary('Ack')}
                  </button>
                  <button
                    class="outcome"
                    title="Dismiss as false alarm"
                    ?disabled=${busy != null}
                    @click=${() => this.submitOutcome(a.id, 'dismiss')}
                  >
                    ${busy === 'dismiss' ? '…' : glossary('Dismiss')}
                  </button>
                  <button
                    class="outcome"
                    data-color="bad"
                    title="Preceded an actual hardware failure"
                    ?disabled=${busy != null}
                    @click=${() => this.submitOutcome(a.id, 'failed')}
                  >
                    ${busy === 'failed' ? '…' : glossary('Failed')}
                  </button>
                `}
            ${error ? html`<span class="outcome-error">${error}</span>` : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private renderActiveSection() {
    const alerts = this.thresholdAlerts();
    const counts = priorityCounts(this.activeAlerts());
    const title = `Active (${alerts.length})`;
    if (alerts.length === 0) {
      return html`
        <ef-section .title=${title}>
          <ef-badge slot="header" tone="ok">all clear</ef-badge>
          <div class="empty-ok">
            <span aria-hidden="true">✓</span>
            No active alerts
          </div>
        </ef-section>
      `;
    }
    // Priority-tinted summary chips, ordered Critical → Low (ISA-18.2).
    return html`
      <ef-section .title=${title}>
        <div slot="header" class="count-row">
          ${ALARM_PRIORITY_ORDER.map((p) =>
            counts[p] > 0
              ? html`<span class="count-chip" data-prio=${p}
                  >${ALARM_PRIORITY_META[p].label} ${counts[p]}</span
                >`
              : nothing,
          )}
        </div>
        <div class="alerts-list">
          ${alerts.map((a) => this.renderAlertRow(a))}
        </div>
      </ef-section>
    `;
  }

  private renderClearedSection() {
    const count = this.cleared.length;
    return html`
      <ef-section title="Cleared today">
        <button
          slot="header"
          class="show-btn"
          @click=${() => void this.toggleCleared()}
          aria-expanded=${this.clearedExpanded ? 'true' : 'false'}
        >
          ${this.clearedExpanded ? 'Hide' : count > 0 ? `Show (${count})` : 'Show'}
        </button>
        ${this.clearedExpanded
          ? this.clearedLoading
            ? html`<div class="cleared-meta">Loading…</div>`
            : this.clearedError
              ? html`<div class="cleared-meta" style="color:var(--ef-bad)">
                  Failed to load: ${this.clearedError}
                </div>`
              : count === 0
                ? html`<div class="cleared-meta">${glossary('recently cleared')} — none yet.</div>`
                : html`<div class="alerts-list">
                    ${this.cleared.map((ce) => this.renderClearedRow(ce))}
                  </div>`
          : nothing}
      </ef-section>
    `;
  }

  private renderClearedRow(ce: ClearedAlert) {
    const a = ce.alert;
    const prio = priorityOf(a);
    return html`
      <div class="alert-row" data-prio=${prio}>
        <span class="sev-dot" data-prio=${prio} aria-hidden="true"></span>
        <div class="alert-body">
          <div class="alert-title-row">
            <span class="alert-title">${a.title}</span>
            <ef-badge tone="ok">cleared</ef-badge>
            <span class="alert-meta">${a.category}</span>
          </div>
          <div class="alert-detail">${a.detail}</div>
          <div class="cleared-meta">
            raised ${fmtRel(ce.raisedAt)} · cleared ${fmtRel(ce.clearedAt)} · lasted
            ${fmtMins(ce.durationMs / 60000)}
          </div>
        </div>
      </div>
    `;
  }

  private renderInsightsSection() {
    const insights = this.insightAlerts();
    if (insights.length === 0) return nothing;
    return html`
      <ef-section>
        <span slot="title">${glossary('Predictive insights')}</span>
        <ef-badge slot="header" tone="info">${insights.length}</ef-badge>
        <div class="alerts-list">
          ${insights.map((a) => this.renderAlertRow(a))}
        </div>
      </ef-section>
    `;
  }

  private renderNotifySection() {
    const status = this.notifyStatus;
    if (!status) {
      // Don't render anything until we know — keeps the card from flickering
      // a "loading" row that may never resolve if /api/notify/status 404s.
      return nothing;
    }
    if (status.channel === 'none') {
      return html`
        <ef-section title="Notifications">
          <div class="notify-row">
            <ef-badge tone="neutral">disabled</ef-badge>
            <span class="notify-status">Set NOTIFY_CHANNEL in server/.env to enable.</span>
          </div>
        </ef-section>
      `;
    }
    const ok = status.configured;
    return html`
      <ef-section title="Notifications">
        <div class="notify-row">
          <ef-badge tone=${ok ? 'ok' : 'warn'}>
            ${status.channel}${ok ? ' · ready' : ' · not configured'}
          </ef-badge>
          <span class="notify-status"
            >Min sev: ${status.minSeverity}; sent ${status.sentSinceStart} this session</span
          >
          <button
            class="show-btn"
            ?disabled=${this.notifyTestState === 'sending' || !ok}
            @click=${() => void this.sendNotifyTest()}
          >
            ${this.notifyTestState === 'sending' ? 'Sending…' : 'Test'}
          </button>
          ${this.notifyTestMsg
            ? html`<span class="test-msg" data-state=${this.notifyTestState}
                >${this.notifyTestMsg}</span
              >`
            : nothing}
        </div>
      </ef-section>
    `;
  }

  render() {
    const title = this.config?.title ?? 'EcoFlow Alerts';
    const tone = this.connTone();
    return html`
      <ha-card>
        <div class="header">
          <span class="title">${title}</span>
          <ef-badge tone=${tone}>${this.connState}</ef-badge>
        </div>
        ${this.renderActiveSection()}
        ${this.renderInsightsSection()}
        ${this.renderClearedSection()}
        ${this.renderNotifySection()}
      </ha-card>
    `;
  }

  private connTone(): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
    switch (this.connState) {
      case 'open':
        return 'ok';
      case 'connecting':
      case 'reconnecting':
        return 'warn';
      case 'closed':
        return 'bad';
      default:
        return 'neutral';
    }
  }

  getCardSize(): number {
    const active = this.activeAlerts().length;
    // Header + section + per-alert row, plus notify/cleared chrome.
    return Math.min(12, 3 + Math.ceil(active * 0.7));
  }
}

/* ── Helpers ────────────────────────────────────────────────────────── */

type Outcome = 'ack' | 'dismiss' | 'failed';
type TestState = 'idle' | 'sending' | 'ok' | 'fail';

interface NotifyStatus {
  channel: string;
  configured: boolean;
  minSeverity: string;
  notifyResolved: boolean;
  ntfyServer?: string;
  ntfyTopic?: string;
  tracked: number;
  sentSinceStart: number;
}

function submittedLabel(outcome: Outcome): string {
  if (outcome === 'ack') return '✓ Acknowledged';
  if (outcome === 'dismiss') return '✕ Dismissed (false alarm)';
  return '🔧 Logged as real failure';
}

/** Non-mutating Map delete — returns a new Map so Lit detects the change. */
function withoutKey<K, V>(m: Map<K, V>, k: K): Map<K, V> {
  if (!m.has(k)) return m;
  const next = new Map(m);
  next.delete(k);
  return next;
}

// Register in HA's custom-cards catalog so it shows up in the card picker.
// v0.13.7 — idempotent guard (matches circuit/insights/solar) so a second
// bundle import can't double-register this card in HA's picker.
type CustomCardEntry = { type: string; name?: string; description?: string };
const w = window as unknown as { customCards?: CustomCardEntry[] };
w.customCards = w.customCards || [];
if (!w.customCards.some((c) => c.type === 'ecoflow-alerts-card')) {
  w.customCards.push({
    type: 'ecoflow-alerts-card',
    name: 'EcoFlow Alerts Card',
    description: 'Active + cleared alerts, predictive insights and notification controls',
  });
}
