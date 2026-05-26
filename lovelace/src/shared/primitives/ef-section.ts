import { LitElement, html, css } from 'lit';
import { property } from 'lit/decorators.js';
import { themeCss } from '../theme.css.js';

/**
 * `<ef-section title="Battery">…</ef-section>` — bordered card subsection.
 * Smaller than a full `ha-card`; meant to group several `<ef-tile>`s or
 * other content inside a single card. The header slot accepts trailing
 * widgets (e.g. a "show more" link or status badge).
 *
 * Registered manually via `customElements.define` with an idempotent guard
 * (see ef-badge.ts for the rationale).
 */
export class EfSection extends LitElement {
  @property() title = '';

  static styles = [
    themeCss,
    css`
      :host {
        display: block;
        border: 1px solid var(--ef-line);
        border-radius: 10px;
        background: var(--ef-panel);
        padding: 12px 14px;
        color: var(--ef-ink);
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      .title {
        font-weight: 600;
        font-size: 0.95rem;
      }
      .header-extra {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.8rem;
        color: var(--ef-muted);
      }
      .body {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
    `,
  ];

  render() {
    return html`
      <header>
        <div class="title"><slot name="title">${this.title}</slot></div>
        <div class="header-extra"><slot name="header"></slot></div>
      </header>
      <div class="body"><slot></slot></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ef-section': EfSection;
  }
}

if (!customElements.get('ef-section')) {
  customElements.define('ef-section', EfSection);
}
