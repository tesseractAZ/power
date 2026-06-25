import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { FleetSnapshot } from './types.js';
import { getStore, type ConnectionState } from './snapshot-store.js';

export interface EcoflowCardConfig {
  type: string; // e.g. 'custom:ecoflow-fleet-card'
  host?: string; // default 'http://homeassistant.local:8787'
  title?: string;
  refresh_seconds?: number;
}

/**
 * Base for all `ecoflow-*` cards. Owns the snapshot subscription so each
 * subclass only worries about rendering. Subclasses see two reactive
 * properties:
 *   - `this.snapshot` — latest FleetSnapshot or null
 *   - `this.connState` — current connection lifecycle for status badges
 */
export abstract class EcoflowCardBase extends LitElement {
  @property({ attribute: false }) config?: EcoflowCardConfig;
  @state() protected snapshot: FleetSnapshot | null = null;
  @state() protected connState: ConnectionState = 'idle';
  private _unsubscribe: (() => void) | null = null;
  private _stateTimer: ReturnType<typeof setInterval> | null = null;

  setConfig(config: EcoflowCardConfig) {
    if (!config) throw new Error('Invalid config');
    this.config = {
      host: config.host || 'http://homeassistant.local:8787',
      title: config.title || 'Power',
      refresh_seconds: config.refresh_seconds ?? 30,
      type: config.type,
    };
  }

  protected effectiveHost(): string {
    return this.config?.host || 'http://homeassistant.local:8787';
  }

  connectedCallback() {
    super.connectedCallback();
    const store = getStore(this.effectiveHost());
    this.connState = store.connectionState();
    this._unsubscribe = store.subscribe((s) => {
      this.snapshot = s;
      // The store notifies on every state change (open/reconnecting/etc.)
      // so we re-pull on each tick. Cheap; just a getter.
      this.connState = store.connectionState();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    if (this._stateTimer) {
      clearInterval(this._stateTimer);
      this._stateTimer = null;
    }
  }

  getCardSize(): number {
    return 6;
  }
}
