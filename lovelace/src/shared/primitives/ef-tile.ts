import { LitElement, html, css } from 'lit';
import { property } from 'lit/decorators.js';
import { themeCss } from '../theme.css.js';

/**
 * `<ef-tile label="kWh today" value="42.3" unit="kWh">` — labeled stat tile.
 * Three slots so callers can override:
 *   - default: optional supplementary content (badges, sublines)
 *   - `label`: replace the label entirely (e.g. to wrap with `glossary(...)`)
 *   - `value`: replace the value (e.g. to add color or formatting wrappers)
 *
 * Registered manually via `customElements.define` with an idempotent guard
 * (see ef-badge.ts for the rationale — each card bundle includes its own
 * copy of this module, so the second-and-later bundles would throw a
 * `NotSupportedError` if `@customElement` were used).
 */
export class EfTile extends LitElement {
  @property() label = '';
  @property() value: string | number = '';
  @property() unit = '';

  static styles = [
    themeCss,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 12px;
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: var(--ef-panel);
        min-width: 88px;
      }
      .label {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--ef-muted);
        line-height: 1.2;
      }
      .value-line {
        display: flex;
        align-items: baseline;
        gap: 4px;
        color: var(--ef-ink);
      }
      .value {
        font-size: 1.4rem;
        font-weight: 600;
        line-height: 1.1;
      }
      .unit {
        font-size: 0.8rem;
        color: var(--ef-muted);
      }
      ::slotted(*) {
        font-size: 0.75rem;
        color: var(--ef-muted);
      }
    `,
  ];

  render() {
    return html`
      <div class="label"><slot name="label">${this.label}</slot></div>
      <div class="value-line">
        <span class="value"><slot name="value">${this.value}</slot></span>
        ${this.unit ? html`<span class="unit">${this.unit}</span>` : null}
      </div>
      <slot></slot>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ef-tile': EfTile;
  }
}

if (!customElements.get('ef-tile')) {
  customElements.define('ef-tile', EfTile);
}
