import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ecoflow, DeviceListItem } from './ecoflow/rest.js';
import { projectByProduct, Projection } from './ecoflow/project.js';
import type { Alert } from './alerts.js';

/** Local SN→name overrides from device-aliases.json (optional file). */
function loadDeviceAliases(): Record<string, string> {
  try {
    const path = resolve(process.cwd(), 'device-aliases.json');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed.aliases === 'object' ? parsed.aliases : {};
  } catch {
    return {};
  }
}
const deviceAliases = loadDeviceAliases();

export interface DeviceSnapshot {
  sn: string;
  deviceName: string;
  productName: string;
  online: boolean;
  lastUpdated: number; // ms epoch
  lastError?: string;
  projection?: Projection;
  raw?: Record<string, unknown>; // included only if SNAPSHOT_INCLUDE_RAW=1
}

export interface FleetSnapshot {
  generatedAt: number;
  devices: Record<string, DeviceSnapshot>;
  alerts?: Alert[]; // computed fleet-wide alerts (set by the alert monitor)
}

const INCLUDE_RAW = process.env.SNAPSHOT_INCLUDE_RAW === '1';

export class SnapshotStore extends EventEmitter {
  private snap: FleetSnapshot = { generatedAt: 0, devices: {} };
  // REST quota cache (hs_yj751_* / pd303_mc.* schema). Populated by REST polling.
  private rawBySn: Map<string, Record<string, unknown>> = new Map();
  // MQTT message cache. Different schema from REST (cmdId-routed, bpInfo[].* etc.)
  // Keyed by sn, then by cmdId, value is the flattened param. Plus a "last" alias
  // mapping recent cmdId data into a flat lookup.
  private mqttByCmd: Map<string, Map<number, Record<string, unknown>>> = new Map();
  private mqttFlatBySn: Map<string, Record<string, unknown>> = new Map();
  public lastSourceBySn: Map<string, 'rest' | 'mqtt'> = new Map();
  public lastMqttAtBySn: Map<string, number> = new Map();
  public mqttMsgCountBySn: Map<string, number> = new Map();

  get(): FleetSnapshot {
    return this.snap;
  }

  /** Returns the most recent raw quota for a device, or undefined if never fetched. */
  getRaw(sn: string): Record<string, unknown> | undefined {
    return this.rawBySn.get(sn);
  }

  /** Attach computed alerts to the snapshot (called by the alert monitor). */
  setAlerts(alerts: Alert[]) {
    this.snap.alerts = alerts;
  }

  /** Returns the MQTT cmdId→param map for a device. */
  getMqttByCmd(sn: string): Record<string, Record<string, unknown>> {
    const m = this.mqttByCmd.get(sn);
    if (!m) return {};
    const obj: Record<string, Record<string, unknown>> = {};
    for (const [cmdId, params] of m.entries()) obj[String(cmdId)] = params;
    return obj;
  }

  /** Returns the flat union of all MQTT param fields seen for a device. */
  getMqttFlat(sn: string): Record<string, unknown> | undefined {
    return this.mqttFlatBySn.get(sn);
  }

  /**
   * Store a parsed MQTT message. Always updates the per-cmdId cache (for /debug/raw)
   * and the flat cache. If `translatedRest` is provided, also merges it into the
   * REST-schema raw cache and re-projects — that's how MQTT drives the live UI.
   * When translatedRest is set, the emit happens inside mergeDeviceQuota, so we
   * skip the duplicate emit here.
   */
  setMqttMessage(sn: string, cmdId: number, param: Record<string, unknown>, translatedRest?: Record<string, unknown> | null) {
    let byCmd = this.mqttByCmd.get(sn);
    if (!byCmd) {
      byCmd = new Map();
      this.mqttByCmd.set(sn, byCmd);
    }
    byCmd.set(cmdId, param);
    const flat = this.mqttFlatBySn.get(sn) ?? {};
    flattenInto(param, '', flat);
    this.mqttFlatBySn.set(sn, flat);
    this.lastMqttAtBySn.set(sn, Date.now());
    this.lastSourceBySn.set(sn, 'mqtt');
    this.mqttMsgCountBySn.set(sn, (this.mqttMsgCountBySn.get(sn) ?? 0) + 1);

    if (translatedRest && Object.keys(translatedRest).length > 0) {
      // mergeDeviceQuota handles raw cache merge, projection refresh, and change emit.
      this.mergeDeviceQuota(sn, translatedRest, 'mqtt');
    } else {
      // No REST-schema translation available — still surface the change so
      // the WS broadcasts the new lastUpdated/source info.
      const cur = this.snap.devices[sn];
      if (cur) {
        cur.lastUpdated = Date.now();
        this.snap.generatedAt = Date.now();
        this.emit('change', this.snap, sn);
      }
    }
  }

  setDeviceList(devices: DeviceListItem[]) {
    for (const d of devices) {
      const existing = this.snap.devices[d.sn];
      // Local alias wins; then the API name; then the raw serial.
      const name = deviceAliases[d.sn] ?? d.deviceName ?? d.sn;
      this.snap.devices[d.sn] = {
        sn: d.sn,
        deviceName: name,
        productName: d.productName ?? guessProductFromName(name),
        online: d.online === 1,
        lastUpdated: existing?.lastUpdated ?? 0,
        lastError: existing?.lastError,
        projection: existing?.projection,
        raw: existing?.raw,
      };
    }
    this.snap.generatedAt = Date.now();
    this.emit('change', this.snap);
  }

  /** Replace the full raw quota for a device (called after a REST refresh). */
  setDeviceQuota(sn: string, raw: Record<string, unknown>, source: 'rest' | 'mqtt' = 'rest') {
    const cur = this.snap.devices[sn];
    if (!cur) return;
    this.rawBySn.set(sn, raw);
    cur.projection = projectByProduct(cur.productName, raw);
    cur.raw = INCLUDE_RAW ? raw : undefined;
    cur.lastUpdated = Date.now();
    cur.lastError = undefined;
    this.lastSourceBySn.set(sn, source);
    this.snap.generatedAt = Date.now();
    this.emit('change', this.snap, sn);
  }

  /** Merge a delta (partial) quota into the cached raw and re-project. */
  mergeDeviceQuota(sn: string, partial: Record<string, unknown>, source: 'rest' | 'mqtt' = 'mqtt') {
    const cur = this.snap.devices[sn];
    if (!cur) return;
    const prev = this.rawBySn.get(sn) ?? {};
    const merged = { ...prev, ...partial };
    this.rawBySn.set(sn, merged);
    cur.projection = projectByProduct(cur.productName, merged);
    cur.raw = INCLUDE_RAW ? merged : undefined;
    cur.lastUpdated = Date.now();
    cur.lastError = undefined;
    this.lastSourceBySn.set(sn, source);
    this.snap.generatedAt = Date.now();
    this.emit('change', this.snap, sn);
  }

  setDeviceOnline(sn: string, online: boolean) {
    const cur = this.snap.devices[sn];
    if (!cur || cur.online === online) return;
    cur.online = online;
    cur.lastUpdated = Date.now();
    this.snap.generatedAt = Date.now();
    this.emit('change', this.snap, sn);
  }

  setDeviceError(sn: string, error: string) {
    const cur = this.snap.devices[sn];
    if (!cur) return;
    cur.lastError = error;
    cur.lastUpdated = Date.now();
    this.snap.generatedAt = Date.now();
    this.emit('change', this.snap, sn);
  }
}

function guessProductFromName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('delta pro ultra') || n.startsWith('core ')) return 'DELTA Pro Ultra';
  if (n.includes('smart home panel')) return 'Smart Home Panel 2';
  if (n.includes('powerinsight')) return 'PowerInsight';
  if (n.includes('delta 3 plus')) return 'DELTA 3 Plus';
  if (n.includes('river 3 plus')) return 'RIVER 3 Plus';
  if (n.includes('evse') || n.includes('car charger')) return 'EVSE';
  if (n.includes('wave 2')) return 'WAVE 2';
  if (n.includes('smart generator')) return 'Smart Generator 3000';
  return 'Unknown';
}

export async function refreshAll(store: SnapshotStore): Promise<void> {
  const list = await ecoflow.listDevices();
  store.setDeviceList(list);
  await Promise.all(
    list
      .filter((d) => d.online === 1)
      .map(async (d) => {
        try {
          const quota = await ecoflow.getQuotaAll(d.sn);
          store.setDeviceQuota(d.sn, quota);
        } catch (e: any) {
          store.setDeviceError(d.sn, String(e?.message ?? e));
        }
      }),
  );
}

/** Flatten nested object/array into a flat key map using dot/bracket notation. */
function flattenInto(input: unknown, prefix: string, out: Record<string, unknown>): void {
  if (input == null) {
    if (prefix) out[prefix] = input;
    return;
  }
  if (Array.isArray(input)) {
    if (input.length === 0) out[prefix] = [];
    input.forEach((item, i) => flattenInto(item, `${prefix}[${i}]`, out));
    return;
  }
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      flattenInto(v, key, out);
    }
    return;
  }
  out[prefix] = input;
}

export function startPollLoop(store: SnapshotStore, intervalMs: number, log: (msg: string) => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    const t0 = Date.now();
    try {
      await refreshAll(store);
      log(`poll ok in ${Date.now() - t0}ms`);
    } catch (e: any) {
      log(`poll failed: ${e?.message ?? e}`);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
