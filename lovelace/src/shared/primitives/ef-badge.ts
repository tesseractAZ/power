import { LitElement, html, css } from 'lit';
import { property } from 'lit/decorators.js';
import { themeCss } from '../theme.css.js';

/**
 * `<ef-badge tone="ok|warn|bad|info">text</ef-badge>` — small chip used for
 * status pills (connection state, alert counts, etc.). Text is slotted so
 * callers can include icons or other inline elements alongside the label.
 *
 * Registration uses a manual idempotent `customElements.define` rather
 * than the `@customElement` decorator. Each per-card bundle (fleet, battery,
 * solar, …) has its own copy of this module tree-shaken in; when HA loads
 * the second bundle the decorator would throw `NotSupportedError: name
 * "ef-badge" has already been used`, killing the IIFE before the card's
 * own `customElements.define` runs. The if-guard makes the second-and-later
 * bundles no-op the registration.
 */
export type EfBadgeTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export class EfBadge extends LitElement {
  @property({ reflect: true }) tone: EfBadgeTone = 'neutral';

  static styles = [
    themeCss,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        font-size: 0.75rem;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
        line-height: 1.5;
        background: var(--ef-line);
        color: var(--ef-ink);
        white-space: nowrap;
      }
      :host([tone='ok']) {
        background: color-mix(in srgb, var(--ef-ok) 20%, transparent);
        color: var(--ef-ok);
      }
      :host([tone='warn']) {
        background: color-mix(in srgb, var(--ef-warn) 22%, transparent);
        color: var(--ef-warn);
      }
      :host([tone='bad']) {
        background: color-mix(in srgb, var(--ef-bad) 22%, transparent);
        color: var(--ef-bad);
      }
      :host([tone='info']) {
        background: color-mix(in srgb, var(--ef-info) 22%, transparent);
        color: var(--ef-info);
      }
    `,
  ];

  render() {
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ef-badge': EfBadge;
  }
}

if (!customElements.get('ef-badge')) {
  customElements.define('ef-badge', EfBadge);
}
