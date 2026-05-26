import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { FleetSnapshot } from './types.js';
import { getStore } from './snapshot-store.js';

export interface EcoflowCardConfig {
  type: string; // e.g. 'custom:ecoflow-fleet-card'
  host?: string; // default 'http://homeassistant.local:8787'
  title?: string;
  refresh_seconds?: number;
}

export abstract class EcoflowCardBase extends LitElement {
  @property({ attribute: false }) config?: EcoflowCardConfig;
  @state() protected snapshot: FleetSnapshot | null = null;
  private _unsubscribe: (() => void) | null = null;

  setConfig(config: EcoflowCardConfig) {
    if (!config) throw new Error('Invalid config');
    this.config = {
      host: config.host || 'http://homeassistant.local:8787',
      title: config.title || 'EcoFlow Panel',
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
    this._unsubscribe = store.subscribe((s) => {
      this.snapshot = s;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
  }

  getCardSize(): number {
    return 6;
  }
}
