import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sanitizeDisplayName } from './logSanitize.js';
import { ecoflow, DeviceListItem } from './ecoflow/rest.js';
import { projectByProduct, Projection, backupPoolWithGraceHold, type BackupPoolHold } from './ecoflow/project.js';
import { shp2Panels } from './shp2Membership.js';
import { shp2ContentWitness, advanceContentFreshness, isContentStale, advanceShadowLatch, SHP2_SHADOW_CLEAR_DISTINCT } from './shp2Shadow.js';
import type { Alert } from './alerts.js';
import { notePollOk, notePollFailed, notePollHealth } from './telemetryBlind.js';
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
  /**
   * v1.142.0 — ms epoch of the last actual QUOTA WRITE. Distinct from
   * `lastUpdated`, which `setDeviceOnline` also bumps on a bare /status flip
   * carrying no telemetry at all. v0.97.0 made exactly this separation for
   * `setDeviceError` and said why; `setDeviceOnline` was never given the same
   * treatment, so a CONTROL READBACK gated on `lastUpdated` could be satisfied
   * by an OFFLINE→ONLINE flip against a projection nobody had refreshed.
   * `lastUpdated` keeps its meaning (the 'Telemetry stale' alarm keys on it and
   * a 6 s flip must not raise a self-clearing stale alert); readbacks use this.
   */
  lastQuotaAtMs?: number;
  /**
   * v1.143.0 — when this device's `online` flag last CHANGED, and which input
   * observed it. Two independent paths write `online` — the cloud
   * `/device/list` poll and the MQTT `/status` topic — and they can disagree by
   * tens of seconds. On 2026-09-09 Core 5's /status saw OFFLINE 24 s before the
   * cloud list did, so its dispatch dwell started 24 s earlier and it paged;
   * Core 1, offline for 59 s against a 60 s debounce, did not. The dwell was
   * working correctly, but nothing recorded WHY one paged and the other did not.
   */
  onlineChangedAtMs?: number;
  onlineChangedVia?: 'device-list' | 'status';
  /**
   * v1.142.0 — when this device's payload STOPPED MOVING, or null/absent if it
   * is moving. Set only for the SHP2, from the twelve-channel watt witness. See
   * shp2Shadow.ts: a 200 OK carrying a replayed body is invisible to every
   * fetch-keyed gate.
   */
  contentStaleSinceMs?: number | null;
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
  // v1.11.0 (review F8) — per-DPU inverter-error onset: {code, sinceMs} for the
  // currently-standing nonzero sysErrCode, or null when clear. A cloud reconnect
  // blips sysErrCode nonzero for 20-160s then clears (07-02: two transient CRITICAL
  // "Inverter error code" alerts drove the HA critical_alerts sensor to 2); a real
  // inverter fault persists. Reset when the code clears OR changes value, so the
  // debounce clock only runs while the SAME error is continuously present.
  private dpuErrOnsetBySn: Map<string, { code: number; sinceMs: number }> = new Map();
  /** v1.14.0 — per-SHP2-slot source-error onset (key `<sn>:<slot>`), mirroring
   *  dpuErrOnsetBySn for the shp2-src-err CRITICAL debounce. */
  private shp2SrcErrOnsetBySlot: Map<string, { count: number; sinceMs: number }> = new Map();
  // v1.8.0 (review F3) — ms epoch when the PUBLISHED pool % went null (i.e. after
  // the grace hold already absorbed reconnect blips). Feeds the reserve-blind
  // compensating alert so it keys off a SUSTAINED blind window, not a flicker.
  private backupPoolUnknownSinceBySn: Map<string, number> = new Map();
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
    const seenThisList = new Set<string>();
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
      seenThisList.add(d.sn);
      // Local alias wins; else resolve a real display name from the cloud
      // deviceName, falling back to the product type when the cloud name is just
      // the bare serial (v0.75.0 — resolveDeviceName), then the raw serial.
      const name = deviceAliases[d.sn] ?? resolveDeviceName(d.deviceName, d.productName, d.sn);
      this.snap.devices[d.sn] = {
        sn: d.sn,
        // v1.7.0 (security #2) — strip terminal control/ESC bytes from the
        // cloud/alias-sourced display name before it can reach the telnet render.
        deviceName: sanitizeDisplayName(name, 48, d.sn),
        productName: d.productName ?? guessProductFromName(name),
        online: newOnline,
        lastUpdated: existing?.lastUpdated ?? 0,
        lastError: existing?.lastError,
        projection: existing?.projection,
        raw: existing?.raw,
        // v1.143.0 — CARRY THE STICKY CLOCKS FORWARD. This literal rebuilds the
        // device object on EVERY /device/list poll, i.e. every 60 s, and silently
        // dropped every field not named here. `lastErrorAt` has been lost that way
        // since v0.97.0 added it — the field whose entire purpose was to stop a
        // REST error resetting the staleness clock. v1.142.0's `lastQuotaAtMs` and
        // `contentStaleSinceMs` would have gone the same way: usually masked,
        // because setDeviceQuota re-derives them microseconds later in the same
        // poll, but NOT when the quota fetch then fails — which is exactly the
        // state in which a frozen projection matters most.
        lastErrorAt: existing?.lastErrorAt,
        lastQuotaAtMs: existing?.lastQuotaAtMs,
        contentStaleSinceMs: existing?.contentStaleSinceMs,
        onlineChangedAtMs: existing?.onlineChangedAtMs,
        onlineChangedVia: existing?.onlineChangedVia,
      };
      // The transition stamp must land on the REBUILT object, not the one this
      // literal just replaced.
      if (existing != null && existing.online !== newOnline) {
        this.snap.devices[d.sn].onlineChangedAtMs = now;
        this.snap.devices[d.sn].onlineChangedVia = 'device-list';
      }
    }
    // v1.145.0 — a device that DISAPPEARS from /device/list keeps its last `online`
    // value forever with nothing logged, so "it says online but has been gone for
    // hours" is indistinguishable from a healthy device. Deliberately a BREADCRUMB
    // ONLY: marking an absent device offline would invert a cloud-side list glitch
    // into a device alarm, which is the wrong direction on a life-safety system.
    // Logged once per disappearance, not per poll.
    for (const [sn, d] of Object.entries(this.snap.devices)) {
      if (seenThisList.has(sn)) { this.absentFromList.delete(sn); continue; }
      if (this.absentFromList.has(sn)) continue;
      this.absentFromList.add(sn);
      this.logger(`device-list: ${d.deviceName} (${sn}) ABSENT from /device/list (last known ${d.online ? 'online' : 'offline'}) — state is now frozen, not refreshed`);
    }
    this.snap.generatedAt = now;
    this.emit('change', this.snap);
  }

  /** v1.145.0 — SNs already reported absent, so each disappearance logs once. */
  private absentFromList = new Set<string>();

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
    // v1.8.0 (review F3) — record the onset of a published-null pool; clear the
    // instant a real read returns. Consumed by backupPoolUnknownSince().
    if (out.pct == null) {
      if (!this.backupPoolUnknownSinceBySn.has(sn)) this.backupPoolUnknownSinceBySn.set(sn, this.now());
    } else {
      this.backupPoolUnknownSinceBySn.delete(sn);
    }
  }

  /** v1.8.0 (review F3) — ms epoch when this SHP2's published backup-pool % went
   *  null (post-grace-hold), or null while it is readable. */
  backupPoolUnknownSince(sn: string): number | null {
    return this.backupPoolUnknownSinceBySn.get(sn) ?? null;
  }

  /** v1.11.0 (review F8) — update the per-DPU inverter-error onset from the freshly
   *  applied projection. Called for every device at each ingest so the onset clock
   *  reflects continuous presence of the SAME nonzero code. */
  private trackDpuErrOnset(sn: string, proj: Projection | undefined): void {
    if (!proj || proj.kind !== 'dpu') return;
    const code = proj.sysErrCode ?? 0;
    if (code === 0) { this.dpuErrOnsetBySn.delete(sn); return; }
    const prev = this.dpuErrOnsetBySn.get(sn);
    // Re-baseline the clock on the first appearance OR a code change — a
    // different code is a different fault, not a continuation.
    if (!prev || prev.code !== code) this.dpuErrOnsetBySn.set(sn, { code, sinceMs: this.now() });
  }

  /** v1.11.0 (review F8) — {code, sinceMs} of the currently-standing inverter
   *  error for this DPU, or null when clear. alerts.ts debounces the CRITICAL on
   *  `now - sinceMs`. */
  dpuErrOnset(sn: string): { code: number; sinceMs: number } | null {
    return this.dpuErrOnsetBySn.get(sn) ?? null;
  }

  /** v1.14.0 — per-SHP2-slot source-error onset, mirroring trackDpuErrOnset. A
   *  transient device-reported error (60-s flap at 05:35 on 2026-07-12) fired a
   *  full audible red + critical push; alerts.ts now debounces the
   *  `shp2-src-err-<slot>` CRITICAL on `now - sinceMs` with the same 3-min
   *  window. Re-baselined on a count change or clear (a slot vanishing from
   *  `sources` clears too, so a stale onset can't debounce a NEW fault later). */
  private trackShp2SrcErrOnsets(sn: string, proj: Projection | undefined): void {
    if (!proj || proj.kind !== 'shp2') return;
    const live = new Set<string>();
    for (const s of proj.sources) {
      const key = `${sn}:${s.slot}`;
      const count = s.errorCodeNum ?? 0;
      if (count === 0) { this.shp2SrcErrOnsetBySlot.delete(key); continue; }
      live.add(key);
      const prev = this.shp2SrcErrOnsetBySlot.get(key);
      if (!prev || prev.count !== count) this.shp2SrcErrOnsetBySlot.set(key, { count, sinceMs: this.now() });
    }
    for (const key of this.shp2SrcErrOnsetBySlot.keys()) {
      if (key.startsWith(`${sn}:`) && !live.has(key)) this.shp2SrcErrOnsetBySlot.delete(key);
    }
  }

  /** v1.14.0 — copy of the per-slot src-err onset map (keys `<sn>:<slot>`), for
   *  the ConnectivityContext handed to computeAlerts. */
  shp2SrcErrOnsets(): Map<string, { count: number; sinceMs: number }> {
    return new Map(this.shp2SrcErrOnsetBySlot);
  }

  /** Replace the full raw quota for a device (called after a REST refresh). */
  setDeviceQuota(sn: string, raw: Record<string, unknown>, source: 'rest' | 'mqtt' = 'rest') {
    const cur = this.snap.devices[sn];
    if (!cur) return;
    this.rawBySn.set(sn, raw);
    cur.projection = projectByProduct(cur.productName, raw);
    this.applyBackupPoolGraceHold(sn, cur.projection);
    this.trackDpuErrOnset(sn, cur.projection);
    this.trackShp2SrcErrOnsets(sn, cur.projection);
    cur.raw = INCLUDE_RAW ? raw : undefined;
    // v1.142.0 — via the injectable clock (line ~116), matching the grace-hold and
    // err-onset trackers in this file. In production this IS Date.now.
    const nowQ = this.now();
    cur.lastUpdated = nowQ;
    cur.lastQuotaAtMs = nowQ;
    // v1.142.0 — did the CONTENT move, or did the cloud replay a shadow?
    if (this.contentFreshnessPath == null) this.loadContentFreshness(nowQ);
    const witness = shp2ContentWitness(cur.projection);
    const fresh = advanceContentFreshness(this.contentFreshness.get(sn), witness, nowQ);
    if (fresh) this.contentFreshness.set(sn, fresh); else this.contentFreshness.delete(sn);
    const stale = isContentStale(fresh, nowQ);
    if (witness != null && fresh?.repeats === 1) this.saveContentFreshness(); // witness changed
    const wasStale = cur.contentStaleSinceMs != null;
    // v1.154.0 — the RELEASE goes through a latch with hysteresis (shp2Shadow.ts,
    // advanceShadowLatch). The latch side is still exactly `stale` above.
    const prevLatch = this.shadowLatch.get(sn);
    const latch = advanceShadowLatch(prevLatch, fresh, stale);
    if (latch) this.shadowLatch.set(sn, latch); else this.shadowLatch.delete(sn);
    const latched = latch != null;
    cur.contentStaleSinceMs = latch ? latch.sinceMs : null;
    if (latched !== wasStale) {
      this.logger(
        latched
          ? `shp2-shadow: ${cur.deviceName} (${sn}) payload has not moved across ${fresh?.repeats} polls (${Math.round((nowQ - (fresh?.firstSeenMs ?? nowQ)) / 1000)}s) — the cloud is serving a STALE SHADOW; grid readings are being treated as UNKNOWN`
          : witness == null
            ? `shp2-shadow: ${cur.deviceName} (${sn}) payload is unmeasurable — releasing the stale latch (no witness is not evidence of a shadow)`
            : `shp2-shadow: ${cur.deviceName} (${sn}) payload is moving again (${SHP2_SHADOW_CLEAR_DISTINCT} distinct new readings)`,
      );
    } else if (latch && prevLatch && latch.moved.length > prevLatch.moved.length) {
      this.logger(
        `shp2-shadow: ${cur.deviceName} (${sn}) payload moved (${latch.moved.length}/${SHP2_SHADOW_CLEAR_DISTINCT}) — holding the stale latch until the movement is sustained`,
      );
    } else if (latch && prevLatch && latch.moved.length < prevLatch.moved.length && latch.frozenWitness === prevLatch.frozenWitness) {
      this.logger(
        `shp2-shadow: ${cur.deviceName} (${sn}) the frozen payload reappeared — movement count reset (0/${SHP2_SHADOW_CLEAR_DISTINCT}); the cloud is still replaying it`,
      );
    }
    cur.lastError = undefined;
    this.lastSourceBySn.set(sn, source);
    this.snap.generatedAt = Date.now();
    this.emit('change', this.snap, sn);
  }

  /**
   * v1.142.0 — per-SN content-freshness state for the cloud-shadow detector.
   *
   * v1.148.0 — PERSISTED. The map was in-memory only, so every process start
   * disarmed the fail-safe until 5 consecutive identical payloads AND 4 minutes
   * had re-accumulated. Measured: a freshly booted process published
   * `grid_power_home = 7618 W` alongside `shp2_payload_frozen = 0` — 7,618 being
   * the exact value the PREVIOUS process had already declared a stale shadow
   * ~2 minutes earlier. ~60-90 s of a 7.6 kW ghost on the alarm path, and in
   * `resolveGridBackstop` `importLive` is the one backstop term exempt from both
   * `poolDischargingAtFloor` and `floorWithoutFlow`, so a frozen positive reading
   * disables the very guards that would catch it. This is the v1.140.0 restart
   * door, one file over.
   *
   * ★ `firstSeenMs` is RE-STAMPED at rehydrate, deliberately. Carrying the
   * original across downtime would let the duration half of the AND be satisfied
   * by history, so one matching poll after a long gap would latch stale
   * immediately. That fails safe, but it is a nuisance-alarm path: at the reserve
   * floor it removes backstopping and can escalate a benign grid-up low-SoC to
   * critical. The repeat count is likewise reset — what survives a restart is
   * WHICH witness we last saw, not how long we had been seeing it.
   */
  private contentFreshness = new Map<string, import('./shp2Shadow.js').ContentFreshness>();
  /**
   * v1.154.0 — the release-side hysteresis state, per SN. Held HERE, beside the
   * freshness map, and deliberately not on DeviceSnapshot: setDeviceList rebuilds
   * that object from a literal every 60 s and drops any field it does not name.
   * `contentStaleSinceMs` is the published view of this latch. Not persisted: a
   * restart already re-arms the latch side from scratch (see the note below).
   */
  private shadowLatch = new Map<string, import('./shp2Shadow.js').ShadowLatch>();
  private contentFreshnessPath: string | null = null;

  /** v1.148.0 — load the shadow witness written by the previous process. */
  private loadContentFreshness(nowMs: number): void {
    const path = this.contentFreshnessPath
      ?? (process.env.SHADOW_WITNESS_PATH ?? resolve(process.cwd(), config.dbPath, '..', 'shadow-witness.json'));
    this.contentFreshnessPath = path;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { witness?: unknown }>;
      for (const [sn, v] of Object.entries(raw ?? {})) {
        if (v && typeof v.witness === 'string' && v.witness.length > 0) {
          // Witness only. Clock and count restart — see the note above.
          this.contentFreshness.set(sn, { witness: v.witness, firstSeenMs: nowMs, repeats: 1 });
        }
      }
    } catch { /* absent or corrupt → start cold, which is the pre-v1.148.0 behaviour */ }
  }

  /** v1.148.0 — best-effort; losing it costs one re-arm window, never correctness. */
  private saveContentFreshness(): void {
    if (!this.contentFreshnessPath) return;
    try {
      const out: Record<string, { witness: string }> = {};
      for (const [sn, f] of this.contentFreshness) out[sn] = { witness: f.witness };
      writeFileSync(this.contentFreshnessPath, JSON.stringify(out));
    } catch { /* best effort */ }
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
    this.trackDpuErrOnset(sn, cur.projection);
    this.trackShp2SrcErrOnsets(sn, cur.projection);
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
    cur.onlineChangedAtMs = Date.now();
    cur.onlineChangedVia = 'status';
    // v1.142.0 — this bump is DELIBERATE and stays: `lastUpdated` feeds the 3-min
    // 'Telemetry stale' alarm, and a 6 s /status flip must not raise a
    // self-clearing stale alert. What it must NOT do is vouch for the PROJECTION,
    // which this path never refreshes — so `lastQuotaAtMs` is untouched and every
    // control readback keys on that instead.
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

// v1.40.0: once-per-session memory for per-device quota-fetch failures so the
// debug breadcrumb below cannot become poll-cadence log spam.
const quotaErrLogged = new Set<string>();

/**
 * v1.138.0 — what one poll ATTEMPTED, not just what failed.
 *
 * THE DEFECT THIS EXISTS FOR: `refreshAll` used to return only `failedSns`, and
 * two downstream detectors read absence from that array as evidence of success.
 * It is not. `failedSns` can only ever contain devices this poll actually ASKED
 * — the fetch set is `list.filter((d) => d.online === 1)` — so a device that
 * goes cloud-offline is absent for the same reason a healthy one is.
 *
 * Returning the attempt set makes the third state expressible: a device that was
 * never asked is neither recovered nor failing, it is UNEVALUABLE. That is the
 * doctrine `fallingEdgeFrozenByEvidence` already states for the alert falling
 * edge (`alertMonitor.ts`); these two call sites never got it.
 */
export interface RefreshResult {
  /** SNs this poll actually asked (online === 1 at list time). */
  attemptedSns: string[];
  /** Of those, the SNs whose quota fetch threw. Always a subset of attemptedSns. */
  failedSns: string[];
}

export async function refreshAll(store: SnapshotStore, log: (m: string) => void = () => {}): Promise<RefreshResult> {
  store.markDeviceListAttempt();
  const list = await ecoflow.listDevices();
  store.setDeviceList(list);
  // v1.79.0 — the tick's poll line must not say a bare "ok" when a device
  // fetch inside it timed out (four 10.4-10.5 s polls logged "ok" across two
  // audits with the failing device unnamed).
  const online = list.filter((d) => d.online === 1);
  const attemptedSns = online.map((d) => d.sn);
  const failedSns: string[] = [];
  await Promise.all(
    online
      .map(async (d) => {
        try {
          const quota = await ecoflow.getQuotaAll(d.sn);
          store.setDeviceQuota(d.sn, quota);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          store.setDeviceError(d.sn, msg);
          failedSns.push(d.sn);
          // v1.40.0: debug-log once per device per session — persistent quota
          // failures (e.g. API code 1006, a PRODUCT-CLASS limitation on
          // some device classes) previously surfaced ONLY in the snapshot,
          // leaving no log breadcrumb at all (silent-catch rule).
          if (!quotaErrLogged.has(d.sn)) {
            quotaErrLogged.add(d.sn);
            log(`snapshot: quota fetch failed for ${d.sn} (${msg}) — device serves from device/list presence only (logged once per session)`);
          }
        }
      }),
  );
  return { attemptedSns, failedSns };
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
/**
 * v1.120.0 — which poll lines to emit, as a pure function.
 *
 * THE DEFECT THIS REPLACES: all three log branches were gated on
 * `failedSns.length === 0`. That guard was written for a fleet where fetch
 * failures are exceptional. On this fleet they are not: four accessory devices
 * (EVSE, PowerInsight, BACC Delta 3 Plus, SEC River 3 Plus) reject /quota/all on
 * EVERY poll — the branch immediately above says so in as many words — so the
 * failure set is never empty and the SLOW_POLL_MS latency detector could never
 * fire. The one 10,488 ms excursion in the 49 h audit window (21x the ~490 ms
 * baseline, and above the 8 s RTT-gate ceiling that decides whether a clock
 * sample is allowed to teach the offset learner) surfaced only by luck, because
 * its failure SET happened to change on that tick.
 *
 * Poll DURATION is a property of the poll. It does not depend on whether some
 * accessory answered, so it is no longer gated on the failure set. The recovery
 * and debug lines keep their original semantics.
 */
/** v1.123.0 — the delay until the next poll, holding a constant period. */
export function nextPollDelayMs(intervalMs: number, tookMs: number): number {
  if (!Number.isFinite(tookMs) || tookMs < 0) return intervalMs;
  return Math.max(0, intervalMs - tookMs);
}

/**
 * v1.139.0 — THE ENABLEMENT DOORBELL IS DELETED. Do not reinstate it.
 *
 * v1.88.0 added a detector to announce the moment the four 1006-blocked
 * accessories (EVSE, PowerInsight, BACC Delta 3 Plus, SEC River 3 Plus) started
 * answering `/quota/all` — the signal that an API-access request to EcoFlow had
 * been granted. v1.138.0 fixed it firing falsely. This release removes it,
 * because the premise it rested on is false.
 *
 * **API error 1006 is a PRODUCT-CLASS limit, not a grantable account
 * permission.** The owner settled this on 2026-09-08: EcoFlow is not expected to
 * extend API coverage to these device classes. The vendor's own wording scopes
 * the denial to the device — "current DEVICE is not allowed to get device info"
 * — and the same credentials read every Delta Pro Ultra and the SHP2 without
 * trouble. So the condition the doorbell watched for cannot occur, and a
 * detector that can only ever fire falsely is worse than no detector: it trains
 * the operator to discount a push on a life-safety system.
 *
 * The repo previously asserted BOTH readings — DOCS.md said "by design" while a
 * v1.40.0 comment here said "account-permission limitation". That contradiction
 * is what allowed the feature to be built at all. It is now reconciled to one
 * reading everywhere.
 *
 * WHAT SURVIVES, and why it is not part of the doorbell:
 *   - `refreshAll` still returns `{ attemptedSns, failedSns }`. The attempt set
 *     is what makes "never asked" distinguishable from "asked and failed", and
 *     `pollHealthVerdict` below depends on it.
 *   - `pollHealthVerdict` (S1) stays. It closed the same faulty inference where
 *     it actually mattered — a cloud-offline SHP2 counting as a healthy poll and
 *     disarming the telemetry-blind CRITICAL for the whole dark window.
 *
 * If EcoFlow ever does extend coverage, the honest signal is already present
 * without a detector: the device stops erroring and `lastUpdated` advances.
 * Look at `/api/debug/raw`, do not rebuild a push.
 */

/**
 * v1.138.0 — is this poll evidence that the alarm path can still see? (S1)
 *
 * THE DEFECT THIS REPLACES: `const shp2Failed = failedSns.some(isShp2)` — the
 * same absence-means-success read, applied to the single most important device
 * in the system. An SHP2 that goes cloud-offline is never fetched, so it is
 * never in `failedSns`, so `shp2Failed` was false and the poll counted as OK.
 * `assessBlind`'s other input counts devices carrying a projection regardless of
 * `online`, and `setDeviceList` deliberately PRESERVES `projection` across the
 * offline transition — so the telemetry-blind CRITICAL saw `hasDevices=true,
 * pollFresh=true` and returned `{blind: false}` for the whole SHP2-dark window.
 *
 * The v1.86.0 comment above the old line states the intent exactly — "the
 * telemetry-blind detector must not count a poll whose ALARM-PATH device (the
 * SHP2) failed as OK" — and closed the FAILED case while leaving NEVER-ASKED
 * open. This is the suspected mechanism behind the recorded "SHP2 cloud-offline
 * → floor gap with no compensating alarm"; confirm by sampling /api/health
 * during the next cloud-offline episode.
 *
 * Fail-open ONLY at bootstrap: before the first quota response there is no
 * projection, so no SHP2 is known and blindness cannot be asserted. Once ANY
 * SHP2 is known, every one of them must have been asked and answered — a
 * partially-dark multi-panel fleet is partial blindness, and v1.129.0 exists
 * because this fleet can have two panels.
 */
/**
 * v1.140.0 — R1: resolve the alarm-path panel roster by IDENTITY, not projection.
 *
 * THE DEFECT THIS REPLACES, and it is v1.138.0's own: the roster was built as
 * `Object.keys(devices).filter(sn => devices[sn]?.projection?.kind === 'shp2')`.
 * A projection only exists after a SUCCESSFUL quota fetch, and the store is
 * in-memory. So after any add-on restart while the SHP2 is cloud-dark the roster
 * is `[]` — not just at bootstrap but for as long as the panel stays dark —
 * `pollHealthVerdict` takes its documented `length === 0 → {ok:true}` branch,
 * `notePollOk` runs every 60 s, and `assessBlind` returns `{blind:false}`.
 *
 * That is the exact outcome v1.138.0 was written to prevent, re-entered through
 * the restart door. `pollHealthVerdict` was never wrong; the caller handed it a
 * collection filtered on the very evidence whose absence was the problem — the
 * same shape as `failedSns` one release earlier. The measured population is 9
 * restarts in one 50 h window, so "restart while the panel is dark" is not a
 * remote case.
 *
 * `shp2Panels` is the right census and its docstring was written for precisely
 * this window: "a panel that is in /device/list but whose /quota has not
 * hydrated yet has no projection at all". `setDeviceList` stores offline devices
 * with their `productName`, and its `smart home panel` test is byte-identical to
 * the projector's own predicate in `ecoflow/project.ts`.
 *
 * Exported and called from both the poll loop and the tests: a source-scan
 * bridge assertion is not a test, so the extraction is what makes the wiring
 * provable.
 */
export function alarmPathShp2Sns(devices: Record<string, DeviceSnapshot>): string[] {
  return shp2Panels(devices).sns;
}

export function pollHealthVerdict(o: {
  /** Every SN currently projected as an SHP2, online or not. */
  knownShp2Sns: readonly string[];
  attemptedSns: readonly string[];
  failedSns: readonly string[];
  /**
   * v1.148.0 — SNs whose payload the cloud is REPLAYING (contentStaleSinceMs set).
   *
   * v1.142.0 taught the CONSUMERS to distrust a shadow — computeHomeGridWatts and
   * computeShp2GridConnected both treat one as offline — and left every GATE
   * untouched. Measured consequence: across both live shadow firings `poll_health`
   * stayed 'ok', /api/health returned blind:false, and `notePollOk` ran on every
   * shadowed poll so the blind clock never aged. The diagnostic sensor moved to
   * 240 and no verdict moved at all.
   *
   * This is the fourth member of the family: asked-and-FAILED (v1.86.0), never
   * ASKED (v1.138.0), the restart door (v1.140.0), and now asked-answered-and-
   * REPLAYED.
   */
  contentFrozenSns?: readonly string[];
}): { ok: true } | { ok: false; reason: 'shp2-fetch-failed' | 'shp2-not-polled' | 'shp2-content-frozen'; sns: string[] } {
  if (o.knownShp2Sns.length === 0) return { ok: true }; // bootstrap: nothing known to be dark
  const failed = new Set(o.failedSns);
  const attempted = new Set(o.attemptedSns);

  const bad = o.knownShp2Sns.filter((sn) => failed.has(sn));
  if (bad.length) return { ok: false, reason: 'shp2-fetch-failed', sns: bad };

  const unasked = o.knownShp2Sns.filter((sn) => !attempted.has(sn));
  if (unasked.length) return { ok: false, reason: 'shp2-not-polled', sns: unasked };

  // Asked, answered 200 OK, and handed a body the cloud is replaying. Ordered
  // LAST because the two above are harder evidence — a fetch that failed or never
  // happened should name itself rather than be described as frozen.
  const frozen = new Set(o.contentFrozenSns ?? []);
  const stale = o.knownShp2Sns.filter((sn) => frozen.has(sn));
  if (stale.length) return { ok: false, reason: 'shp2-content-frozen', sns: stale };

  return { ok: true };
}

/** v1.145.0 — how often the fleet-status dump re-states an unchanged fleet at INFO. */
export const STATUS_ANCHOR_MS = 60 * 60_000;

/** v1.148.0 — polls per duration summary. 30 at a 60 s cadence = one line/30 min. */
export const POLL_SUMMARY_EVERY = Number(process.env.POLL_SUMMARY_EVERY ?? 30);

/**
 * v1.145.0 — the standing-failure heartbeat was HOURLY: 48 lines in 53 h about a
 * PERMANENT, owner-settled product-class limit (error 1006 on four accessories,
 * see v1.139.0). Daily is enough to prove the set is still what we think it is.
 */
export const PERSISTING_FAILURE_HEARTBEAT_MS = 24 * 60 * 60_000;

/**
 * v1.145.0 — the fleet-status dump is a CHANGE log, not a heartbeat.
 *
 * MEASURED over 53.1 h: 314 emissions and — once the per-device message counters
 * and the device-list age are normalised away — exactly **ONE distinct body**.
 * At ~1.1 KB each that is over a fifth of the whole log, and essentially all of
 * it is invariant text. On a ring that reaches only ~53 h, bytes are forensic
 * reach: this one line was costing hours of history to say nothing.
 *
 * Its charter — "which device stopped reporting and when, one grep away" — is now
 * better served by `msg-rate-floor`, which named 25 collapses with their rates and
 * learned baselines in the same window. And the dump cannot actually answer "when"
 * across a restart anyway, because its cumulative counters reset with the process.
 *
 * So: INFO when the state vector CHANGES, plus one hourly anchor so an operator
 * can still see the fleet is being polled at all. The 10-minute cadence stays, at
 * DEBUG. Against the observed window this is roughly 6 INFO lines instead of 314.
 *
 * The signature deliberately EXCLUDES the message counters and the list age — they
 * move every tick and would make every dump a "change", which is the trap this
 * replaces. What survives is per-device ON / OFF / API-online-no-MQTT, which is
 * the thing the dump exists to report.
 */
export function statusDumpLevel(o: {
  signature: string;
  prevSignature: string | null;
  nowMs: number;
  lastInfoMs: number;
  anchorMs?: number;
}): 'info' | 'debug' {
  if (o.prevSignature == null || o.signature !== o.prevSignature) return 'info';
  return o.nowMs - o.lastInfoMs >= (o.anchorMs ?? STATUS_ANCHOR_MS) ? 'info' : 'debug';
}

export function pollLogLines(o: {
  tookMs: number;
  failedCount: number;
  lastPollFailed: boolean;
  slowMs: number;
  pollDebug: boolean;
  /** v1.148.0 — true on the tick that closes a summary window. */
  summaryDue?: boolean;
  summaryCount?: number;
  summaryP50Ms?: number;
  summaryP95Ms?: number;
  summaryMaxMs?: number;
}): string[] {
  const lines: string[] = [];
  // v1.144.0 — UNGATED from the failure set, finishing what v1.120.0 started for
  // the slow-poll line. On this fleet four accessory devices fail /quota/all on
  // every poll by design, so `failedCount === 0` is never true and BOTH of these
  // branches were dead: `grep -c 'poll ok in'` returned 0 across a 52.5 h log
  // that was running at debug level. Two costs. There is no way to obtain a poll
  // DURATION distribution below the slow threshold even with debug on. And after
  // the one total poll failure in that window there was no line anywhere saying
  // polling had recovered — an operator grepping after `poll failed` found
  // nothing. Recovery and duration are properties of the POLL; neither depends
  // on whether an accessory answered.
  if (o.lastPollFailed) {
    lines.push(`poll ok in ${o.tookMs}ms (recovered)`);
  } else if (o.pollDebug && o.summaryDue) {
    // v1.148.0 — a PERIODIC SUMMARY, not a line per poll.
    //
    // v1.144.0 ungated this correctly (four accessories fail every poll by
    // design, so the old `failedCount === 0` guard made it dead code) and then
    // emitted it 60 times an hour: 1,058 lines in 16.4 h, 32.5% of ALL log bytes
    // and 88.3% of INFO lines. Net effect of the three-release hygiene campaign
    // was +52% volume and forensic reach x0.65 — the opposite of its claim.
    //
    // Demoting it to debug would buy NOTHING: LOG_LEVEL=debug is the standing
    // option on this install, pino writes every level to stdout, and the ring
    // captures stdout. Level is not emission. The only lever that moves bytes is
    // emitting fewer lines, so the distribution is reported once per window
    // instead of once per poll. `(recovered)` and `poll slow:` still carry the
    // incident signal per-event, which is what an operator greps for.
    lines.push(
      `poll duration over last ${o.summaryCount} poll(s): p50 ${o.summaryP50Ms}ms `
      + `p95 ${o.summaryP95Ms}ms max ${o.summaryMaxMs}ms`,
    );
  }
  // Unconditional on the failure set — that is the whole point of the fix.
  if (o.tookMs >= o.slowMs) {
    lines.push(
      `poll slow: ${o.tookMs}ms`
      + (o.failedCount > 0 ? ` (${o.failedCount} device fetch failure(s) — the standing accessory set)` : ''),
    );
  }
  return lines;
}

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
  /**
   * v1.145.0 — the DEBUG channel. The 10-minute fleet-status dump emitted 314
   * lines carrying exactly ONE distinct state vector in a 53 h window; it now
   * goes out at INFO only when that vector changes, and here otherwise. Defaults
   * to `log` so an existing caller keeps its current behaviour.
   *
   * (The v1.88.0 enablement-doorbell callback that used to occupy this slot was
   * deleted in v1.139.0 — error 1006 is a product-class limit, so it could only
   * ever fire falsely. Its doc comment outlived it by five releases.)
   */
  debug: (msg: string) => void = log,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastPollFailed = false; // track failure→ok recovery for the one INFO line that matters
  let lastFailedSetKey = ''; // v1.86.0 — poll-failure set-change dedupe
  let lastFailedSetLoggedMs = 0;
  // Wire the per-SN state-transition logger into the store on first poll.
  store.setLogger(log);
  const tick = async () => {
    if (stopped) return;
    const t0 = Date.now();
    try {
      const { attemptedSns, failedSns } = await refreshAll(store, log);
      const tookMs = Date.now() - t0;
      // v1.79.0 — a poll with per-device fetch failures is not a bare "ok":
      // name the devices at warn so the 10 s connect-timeout ceiling stops
      // hiding inside "poll ok in 10486ms (slow)".
      if (failedSns.length > 0) {
        // v1.86.0 — log on failure-SET CHANGE only. The four accessory devices
        // that reject /quota/all fail EVERY poll; the v1.79.0 per-poll warn ran
        // 2,336 lines in 40h and buried the one real SHP2 failure among them.
        // A stable set logs once at warn (and once per hour at info as a
        // heartbeat); a CHANGED set — a new device failing, or one recovering —
        // always logs at warn immediately.
        const setKey = [...failedSns].sort().join(',');
        if (setKey !== lastFailedSetKey) {
          lastFailedSetKey = setKey;
          lastFailedSetLoggedMs = Date.now();
          warn(`poll completed in ${tookMs}ms with ${failedSns.length} device fetch failure(s): ${failedSns.join(', ')} — serving from cache/presence`);
        } else if (Date.now() - lastFailedSetLoggedMs >= PERSISTING_FAILURE_HEARTBEAT_MS) {
          lastFailedSetLoggedMs = Date.now();
          log(`poll: ${failedSns.length} device fetch failure(s) persisting (${failedSns.join(', ')}) — daily heartbeat, set unchanged`);
        }
      } else {
        if (lastFailedSetKey !== '') {
          lastFailedSetKey = '';
          log(`poll: all device fetches recovered`);
        }
      }
      // v1.148.0 — accumulate durations; report once per window.
      pollDurations.push(tookMs);
      const summaryDue = pollDurations.length >= POLL_SUMMARY_EVERY;
      let summary: { count: number; p50: number; p95: number; max: number } | null = null;
      if (summaryDue) {
        const sorted = [...pollDurations].sort((a, b) => a - b);
        summary = {
          count: sorted.length,
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
          max: sorted[sorted.length - 1],
        };
        pollDurations.length = 0;
      }
      for (const line of pollLogLines({
        tookMs, failedCount: failedSns.length, lastPollFailed, slowMs: SLOW_POLL_MS, pollDebug: POLL_DEBUG,
        summaryDue, summaryCount: summary?.count, summaryP50Ms: summary?.p50,
        summaryP95Ms: summary?.p95, summaryMaxMs: summary?.max,
      })) log(line);
      lastPollFailed = false;
      // v1.86.0 — the telemetry-blind detector must not count a poll whose
      // ALARM-PATH device (the SHP2) failed as OK: notePollOk previously ran
      // unconditionally, so an SHP2 fetch failure was invisible to the blind
      // clock. Accessory-only failures still count OK (pool data arrived).
      // v1.138.0 — S1: `failedSns.some(isShp2)` could not see an SHP2 that was
      // never ASKED. Cloud-offline meant absent-from-failures meant "poll OK",
      // so the telemetry-blind CRITICAL stayed disarmed for the entire dark
      // window. pollHealthVerdict distinguishes asked-and-failed from never-asked.
      const devicesNow = store.get().devices;
      const health = pollHealthVerdict({
        knownShp2Sns: alarmPathShp2Sns(devicesNow), attemptedSns, failedSns,
        contentFrozenSns: Object.keys(devicesNow).filter(
          (sn) => (devicesNow[sn] as { contentStaleSinceMs?: number | null })?.contentStaleSinceMs != null,
        ),
      });
      notePollHealth(health.ok, health.ok ? null : health.reason);
      if (!health.ok) {
        notePollFailed(
          health.reason === 'shp2-fetch-failed'
            ? `SHP2 quota fetch failed (${health.sns.join(', ')})`
            : health.reason === 'shp2-content-frozen'
              ? `SHP2 payload is a REPLAYED SHADOW — the fetch succeeded but the content is not moving (${health.sns.join(', ')})`
              : `SHP2 not polled — cloud-offline, so this poll is NOT evidence the alarm path can see (${health.sns.join(', ')})`,
          // v1.154.0 — carry the verdict itself, so the telemetry-blind alert can say
          // WHICH blind this is rather than "no telemetry" while the Cores stream.
          { cause: health.reason, sns: health.sns },
        );
      } else {
        notePollOk(Date.now()); // v1.69.0 — feeds the telemetry-blind detector
      }
    } catch (e: any) {
      const emsg = e?.message ?? String(e);
      warn(`poll failed: ${emsg}`);
      lastPollFailed = true;
      // v1.69.0 — a failing poll is the alarm system losing its eyes. Record it so
      // telemetryBlind can raise a CRITICAL if it persists; the old code only logged.
      notePollFailed(emsg);
    }
    // v1.123.0 — DEADLINE-COMPENSATED. Arming the next tick at the END of this
    // one made the wall-clock period (intervalMs + poll duration): measured
    // 3,626-3,638 s against a 3,600 s nominal hour, ~0.8% slow. Small, but the
    // COUPLING is the point — the poll cadence degrades in lockstep with the
    // vendor's own slowness, so telemetry is least fresh exactly when the cloud
    // is misbehaving, which is the nightly starvation window. Subtracting the
    // elapsed time holds the period constant while keeping the no-overlap
    // property a setTimeout chain gives us (and setInterval would not).
    if (!stopped) timer = setTimeout(tick, nextPollDelayMs(intervalMs, Date.now() - t0));
  };
  tick();

  // v0.7.7 — periodic per-SN MQTT msg-count + last-seen dump so the next
  // "which device stopped reporting and when" question is one log-grep
  // away. Runs every 10 min; bounded output (one log line covers the fleet).
  const STATUS_DUMP_INTERVAL_MS = 10 * 60 * 1000;
  /** v1.145.0 — the last fleet state vector emitted at INFO, and when. */
  /** v1.148.0 — poll durations awaiting their periodic summary. */
  const pollDurations: number[] = [];
  let lastStatusSignature: string | null = null;
  let lastStatusInfoMs = 0;
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
      // The signature is the STATE vector only — no counters, no list age. Those
      // move every tick and would make every dump a "change".
      const signature = parts.map((x) => x.replace(/ON\/\d+msg\/(\d+s|∞)/, 'ON')).join('|');
      const level = statusDumpLevel({
        signature, prevSignature: lastStatusSignature, nowMs: now, lastInfoMs: lastStatusInfoMs,
      });
      const line = `fleet-status [device-list last success ${sinceList}]: ${parts.join(' · ')}`;
      if (level === 'info') { lastStatusInfoMs = now; log(line); } else { debug(line); }
      lastStatusSignature = signature;
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
