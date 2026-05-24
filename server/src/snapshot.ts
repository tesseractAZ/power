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
  // v0.7.7 — REST device-list health: timestamps of last attempt + last success.
  // Used to distinguish "EcoFlow Cloud session stale" from "device genuinely
  // offline per EcoFlow Cloud". An attempt without a recent success means we
  // can't trust whatever `online` flag is currently being shown.
  public lastDeviceListAttemptAt = 0;
  public lastDeviceListSuccessAt = 0;
  // Optional: a logger the store can use to record per-SN state transitions.
  // Wired by `startPollLoop` so tests / call sites that build a store directly
  // get silent no-op behavior by default. (The MQTT entry point also wires it.)
  private logger: (msg: string) => void = () => {};

  setLogger(log: (msg: string) => void) {
    this.logger = log;
  }

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
    const now = Date.now();
    this.lastDeviceListSuccessAt = now;
    for (const d of devices) {
      const existing = this.snap.devices[d.sn];
      const newOnline = d.online === 1;
      // Log transitions so the next "why is X offline" investigation isn't blind.
      // First-sight (existing == null) doesn't count as a transition since we
      // don't know what the prior state was — just record the inaugural state.
      if (existing != null && existing.online !== newOnline) {
        const name = existing.deviceName;
        this.logger(`device-list: ${name} (${d.sn}) → ${newOnline ? 'ONLINE' : 'OFFLINE'} per EcoFlow Cloud`);
      } else if (existing == null) {
        this.logger(`device-list: ${deviceAliases[d.sn] ?? d.deviceName ?? d.sn} (${d.sn}) first sight, ${newOnline ? 'online' : 'offline'}`);
      }
      // Local alias wins; then the API name; then the raw serial.
      const name = deviceAliases[d.sn] ?? d.deviceName ?? d.sn;
      this.snap.devices[d.sn] = {
        sn: d.sn,
        deviceName: name,
        productName: d.productName ?? guessProductFromName(name),
        online: newOnline,
        lastUpdated: existing?.lastUpdated ?? 0,
        lastError: existing?.lastError,
        projection: existing?.projection,
        raw: existing?.raw,
      };
    }
    this.snap.generatedAt = now;
    this.emit('change', this.snap);
  }

  /** Mark that a /device/list poll attempt happened, regardless of outcome. */
  markDeviceListAttempt() {
    this.lastDeviceListAttemptAt = Date.now();
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
    this.logger(`mqtt-status: ${cur.deviceName} (${sn}) → ${online ? 'ONLINE' : 'OFFLINE'} (via /status topic)`);
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
  store.markDeviceListAttempt();
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
  // Wire the per-SN state-transition logger into the store on first poll.
  store.setLogger(log);
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

  // v0.7.7 — periodic per-SN MQTT msg-count + last-seen dump so the next
  // "which device stopped reporting and when" question is one log-grep
  // away. Runs every 10 min; bounded output (one log line covers the fleet).
  const STATUS_DUMP_INTERVAL_MS = 10 * 60 * 1000;
  const dumpTimer = setInterval(() => {
    if (stopped) return;
    try {
      const now = Date.now();
      const parts: string[] = [];
      const devs = Object.values(store.get().devices);
      for (const d of devs) {
        const lastAt = store.lastMqttAtBySn.get(d.sn);
        const count = store.mqttMsgCountBySn.get(d.sn) ?? 0;
        const ageS = lastAt ? Math.round((now - lastAt) / 1000) : -1;
        parts.push(`${d.deviceName}=${d.online ? 'ON' : 'OFF'}/${count}msg/${ageS < 0 ? '∞' : ageS + 's'}`);
      }
      const sinceList = store.lastDeviceListSuccessAt > 0
        ? `${Math.round((now - store.lastDeviceListSuccessAt) / 1000)}s ago`
        : 'never';
      log(`fleet-status [device-list last success ${sinceList}]: ${parts.join(' · ')}`);
    } catch (e: any) {
      log(`fleet-status dump failed: ${e?.message ?? e}`);
    }
  }, STATUS_DUMP_INTERVAL_MS);
  dumpTimer.unref();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(dumpTimer);
  };
}
