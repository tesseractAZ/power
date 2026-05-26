import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { EcoflowCardBase } from '../shared/base-card.js';
import { themeCss } from '../shared/theme.css.js';

@customElement('ecoflow-fleet-card')
export class EcoflowFleetCard extends EcoflowCardBase {
  static styles = [
    themeCss,
    css`
      :host {
        display: block;
      }
      .title {
        font-weight: 600;
        padding-bottom: 8px;
        color: var(--ef-ink);
      }
      .status {
        color: var(--ef-muted);
        font-size: 0.9em;
      }
      ha-card {
        padding: 16px;
      }
    `,
  ];

  render() {
    return html`
      <ha-card>
        <div class="title">${this.config?.title ?? 'EcoFlow Panel'}</div>
        <div class="status">
          EcoFlow — ${this.snapshot ? 'live' : 'connecting (PR1 stub)'}
        </div>
        <div class="status">Host: ${this.effectiveHost()}</div>
      </ha-card>
    `;
  }
}

// Register in HA's custom-cards catalog so it shows up in the card picker.
(window as unknown as { customCards?: unknown[] }).customCards =
  (window as unknown as { customCards?: unknown[] }).customCards || [];
(window as unknown as { customCards: unknown[] }).customCards.push({
  type: 'ecoflow-fleet-card',
  name: 'EcoFlow Fleet Card',
  description: 'Top-level dashboard for EcoFlow off-grid system',
});
