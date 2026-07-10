import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ecoflow, DeviceListItem } from './ecoflow/rest.js';
import { projectByProduct, Projection, backupPoolWithGraceHold, type BackupPoolHold } from './ecoflow/project.js';
import type { Alert } from './alerts.js';
import { config } from './config.js';

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
  lastUpdated: number; // ms epoch — last SUCCESSFUL data (fresh telemetry). The
  // 'Telemetry stale' alarm keys on this, so a FAILED poll must NOT bump it.
  lastError?: string;
  lastErrorAt?: number; // v0.97.0 — ms epoch of the last poll FAILURE (distinct
  // from lastUpdated so a REST error can't reset the staleness clock).
  projection?: Projection;
  raw?: Record<string, unknown>; // included only if SNAPSHOT_INCLUDE_RAW=1
  // v0.37.0 — the SHP2 device carries its own grid backstop + off_grid flag for
  // device-scoped clients (Shp2Card). Attached immutably by snapshotForClient();
  // inline-imported to avoid a snapshot.ts ↔ gridState.ts top-level cycle.
  grid?: import('./gridState.js').GridBackstop;
  off_grid?: boolean;
}

export interface FleetSnapshot {
  generatedAt: number;
  devices: Record<string, DeviceSnapshot>;
  alerts?: Alert[]; // computed fleet-wide alerts (set by the alert monitor)
  // v0.36.0 — the live grid backstop the dashboard/TUI consume. Inline-imported
  // so no top-level import is added (avoids a snapshot.ts ↔ gridState.ts cycle,
  // since gridState.ts already imports DeviceSnapshot from here).
  grid?: import('./gridState.js').GridBackstop;
  off_grid?: boolean;
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

  // v0.56.0 — last-coherent backup-pool trio per SHP2 SN, for the grace-hold that smooths the
  // ~10-15/day reconnect blips that would otherwise flap the gauge to "unknown".
  private backupPoolHoldBySn: Map<string, BackupPoolHold | null> = new Map();
  // Injectable clock — prod uses Date.now; tests call setClock() for deterministic grace-hold timing.
  private now: () => number = Date.now;
  /** test-only — drive the grace-hold window deterministically. */
  setClock(fn: () => number) { this.now = fn; }

  /**
   * v0.20.0 — monotonic per-emit sequence, bumped on every 'change' emit. Lets
   * the WS layer serialize the snapshot frame ONCE per emit and reuse the same
   * bytes across all connected clients (a 50-150 KB JSON.stringify otherwise
   * runs once per client per change). Keyed on a counter, NOT generatedAt,
   * because `snap` is mutated in place (stable reference) and two emits can
   * share a millisecond under sub-second MQTT bursts — a counter can't collide.
   */
  frameSeq = 0;

  override emit(event: string | symbol, ...args: any[]): boolean {
    if (event === 'change') this.frameSeq++;
    return super.emit(event, ...args);
  }

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
      // v1.3.0 (audit rank 1) — an MQTT message we cannot translate carries NO telemetry,
      // so it must NOT touch `lastUpdated`. That field is the "last fresh telemetry" clock
      // the 'Telemetry stale' alarm keys on (alerts.ts, STALE_MS = 3 min), and only the
      // REST/translated paths actually refresh the projection.
      //
      // This mattered most for the SHP2 — the device that owns the backup pool, reserve
      // floor and grid presence. `ecoflow/mqtt.ts` only translates `delta pro ultra`
      // products, so `translatedRest` is ALWAYS null for the SHP2, and its healthy ~9
      // msg/min MQTT stream perpetually reset the freshness clock. If the REST poll for the
      // SHP2 began failing, its projection would freeze while 'Telemetry stale' never fired.
      // Same class of defect as the v0.97.0 fix on the poll-failure path.
      //
      // We still emit so the WS/UI pick up the new lastMqttAt + source; the stale alert's
      // own detail line already reports "Last MQTT msg Xs ago" beside "no fresh telemetry
      // for Ym", which is exactly the chatter-without-telemetry diagnostic an operator needs.
      this.snap.generatedAt = Date.now();
      if (this.snap.devices[sn]) this.emit('change', this.snap, sn);
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
      // Local alias wins; else resolve a real display name from the cloud
      // deviceName, falling back to the product type when the cloud name is just
      // the bare serial (v0.75.0 — resolveDeviceName), then the raw serial.
      const name = deviceAliases[d.sn] ?? resolveDeviceName(d.deviceName, d.productName, d.sn);
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

  /** v0.56.0 — smooth the SHP2 backup-pool gauge across brief cloud-reconnect blips: substitute
   *  the last-COHERENT trio for up to BACKUP_POOL_GRACE_HOLD_MS instead of immediately publishing
   *  "unknown" when coherentBackupPool nulls a transient incoherent read. Mutates the projection
   *  in place so EVERY consumer (gauge/MQTT/recorder/runway/SoC alarm) sees one consistent value.
   *  No-op for non-SHP2 projections. */
  private applyBackupPoolGraceHold(sn: string, proj: Projection | undefined): void {
    if (!proj || proj.kind !== 'shp2') return;
    const live = { pct: proj.backupBatPercent, fullCapWh: proj.backupFullCapWh, remainWh: proj.backupRemainWh };
    const { out, hold, source } = backupPoolWithGraceHold(live, this.backupPoolHoldBySn.get(sn) ?? null, this.now());
    this.backupPoolHoldBySn.set(sn, hold);
    proj.backupBatPercent = out.pct;
    proj.backupFullCapWh = out.fullCapWh;
    proj.backupRemainWh = out.remainWh;
    if (source === 'held') this.logger(`backup-pool: holding last-good ${out.pct}% across a reconnect blip (sn=${sn})`);
    else if (source === 'none' && live.pct == null) this.logger(`backup-pool: grace window expired → unknown (sn=${sn})`);
  }

  /** Replace the full raw quota for a device (called after a REST refresh). */
  setDeviceQuota(sn: string, raw: Record<string, unknown>, source: 'rest' | 'mqtt' = 'rest') {
    const cur = this.snap.devices[sn];
    if (!cur) return;
    this.rawBySn.set(sn, raw);
    cur.projection = projectByProduct(cur.productName, raw);
    this.applyBackupPoolGraceHold(sn, cur.projection);
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
    // v0.25.0 — merge the delta IN PLACE instead of cloning the whole raw map.
    // The raw map is large (5 packs × cell-temp/voltage arrays + ~hundreds of
    // keys); `partial` is tiny (one cmdId's fields). `{...prev,...partial}` used
    // to re-allocate the entire map on every ~1 Hz MQTT delta — pure GC churn.
    // IMMUTABILITY CONTRACT: this raw map is now mutated in place, so callers
    // must NOT retain a reference expecting it to stay frozen. Safe for every
    // current consumer: `partial` is always a freshly-built object (never aliases
    // prev); mqtt.ts reads getRaw() BEFORE this merge; projectByProduct rebuilds
    // a fresh projection below; the WS frame is JSON-stringified per frameSeq;
    // the analytics worker gets a structuredClone via postMessage. Do not add a
    // lazy consumer that holds this reference across merges.
    const merged = this.rawBySn.get(sn) ?? {};
    Object.assign(merged, partial);
    this.rawBySn.set(sn, merged);
    cur.projection = projectByProduct(cur.productName, merged);
    this.applyBackupPoolGraceHold(sn, cur.projection);
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
    // v0.97.0 (re-audit #4) — do NOT bump lastUpdated on a poll FAILURE. lastUpdated
    // is the "last fresh telemetry" clock the 'Telemetry stale' alarm keys on; a
    // recurring REST error (device still listed online, projection frozen) used to
    // reset it every ~60s, holding the device under the 3-min stale threshold forever
    // and defeating the safety-net. Record the failure time separately instead; a
    // live MQTT delta on a healthy device still bumps lastUpdated via mergeDeviceQuota.
    cur.lastErrorAt = Date.now();
    this.snap.generatedAt = Date.now();
    this.emit('change', this.snap, sn);
  }
}

/**
 * v0.75.0 — resolve a human-readable display name for a device. EcoFlow's
 * `/device/list` returns `deviceName === sn` when the owner never set a friendly
 * name, so the raw serial leaks into the UI and the recurring "<SN> is flagged
 * offline" info-alert (live example: KT21ZAH4HG160047, deviceName == its SN,
 * productName == "WAVE 2"). Conservatively override ONLY when the cloud name is
 * missing or is exactly the SN: prefer the cloud `deviceName` (a real name), then
 * the `productName`, then fall back to the SN. Trim before comparing so a padded
 * name still reads as "real". Pure + side-effect-free for unit testing.
 */
export function resolveDeviceName(
  deviceName: string | null | undefined,
  productName: string | null | undefined,
  sn: string,
): string {
  const name = (deviceName ?? '').trim();
  if (name !== '' && name !== sn.trim()) return name;
  const product = (productName ?? '').trim();
  if (product !== '') return product;
  return sn;
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

// v0.76.0 — the per-tick "poll ok" line fired unconditionally every poll
// (~5541 lines over 52h, the single largest INFO source). It carries no signal
// in steady state: an operator only cares that polling RECOVERED after a
// failure, or that a poll ran slow. Routine successes are demoted to debug
// (visible only at LOG_LEVEL=debug/trace); the recovery and slow-poll lines
// stay at INFO so a grep during an incident still surfaces them.
const POLL_DEBUG = /^(debug|trace)$/i.test(config.logLevel);
const SLOW_POLL_MS = 5_000;

/**
 * v1.3.1 (audit rank 46) — `warn` exists so a FAILED poll (DNS EAI_AGAIN, cloud 5xx) lands at
 * warn level. It used to log at info alongside the routine success lines, so scanning the
 * add-on log for level >= 40 returned nothing even while every poll was failing. Defaults to
 * `log` for callers that don't distinguish levels.
 */
export function startPollLoop(
  store: SnapshotStore,
  intervalMs: number,
  log: (msg: string) => void,
  warn: (msg: string) => void = log,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastPollFailed = false; // track failure→ok recovery for the one INFO line that matters
  // Wire the per-SN state-transition logger into the store on first poll.
  store.setLogger(log);
  const tick = async () => {
    if (stopped) return;
    const t0 = Date.now();
    try {
      await refreshAll(store);
      const tookMs = Date.now() - t0;
      if (lastPollFailed) {
        log(`poll ok in ${tookMs}ms (recovered)`);   // failure→ok transition: keep at INFO
      } else if (tookMs >= SLOW_POLL_MS) {
        log(`poll ok in ${tookMs}ms (slow)`);         // latency anomaly: keep at INFO
      } else if (POLL_DEBUG) {
        log(`poll ok in ${tookMs}ms`);                // routine success: debug-gated
      }
      lastPollFailed = false;
    } catch (e: any) {
      warn(`poll failed: ${e?.message ?? e}`);
      lastPollFailed = true;
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
        // v0.9.75 — devices that EcoFlow Cloud reports as ON but that have
        // NEVER produced an MQTT message (count=0, lastAt=null, ageS=-1)
        // are unrepresented on the MQTT bus — typically EVSE / Smart
        // Generator / spare-Core accessories where the OpenAPI doesn't
        // push `_quota`. Rendering them as `ON/0msg/∞` looked like a
        // delivery bug. `API-online/no-MQTT` makes the state explicit.
        let status: string;
        if (!d.online) {
          status = 'OFF';
        } else if (count === 0 && ageS < 0) {
          status = 'API-online/no-MQTT';
        } else {
          status = `ON/${count}msg/${ageS < 0 ? '∞' : ageS + 's'}`;
        }
        parts.push(`${d.deviceName}=${status}`);
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
