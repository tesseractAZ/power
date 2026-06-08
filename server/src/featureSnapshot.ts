/**
 * v0.9.25 — Feature snapshot at alert-fire time.
 *
 * When an alert fires NOW, the operator might not look at it for minutes
 * to hours. By the time they ack/dismiss it, the live telemetry has
 * moved on. To do online learning later we need the feature vector AS
 * IT WAS at the moment the alert fired — not at outcome time.
 *
 * This module captures + holds those snapshots:
 *
 *   - In-memory LRU (~500 entries, bounded so we don't grow forever)
 *   - Persisted to /data/feature-snapshots.jsonl on each capture so we
 *     survive restarts. On boot we re-hydrate the most recent N entries.
 *
 * Companion to alertOutcomes.ts: when an outcome arrives, we look up
 * the snapshot for that alertId and embed it in the outcome record.
 *
 * Feature schema is alert-category-specific. We define lightweight
 * extractors per category (thermal, battery, pack-risk, etc.) so we
 * snapshot only the relevant signals — not the whole device projection.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import type { Alert } from './alerts.js';
import type { FleetSnapshot, DeviceSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';
import type { Recorder } from './recorder.js';
import { getAnalytics, type AnalyticsClient } from './analyticsClient.js';
// v0.9.59 — capture the REAL LR feature vector (same code path ml.ts /
// computePackRiskV2 uses for inference) at alert fire time so the online
// learner trains on the same inputs the model saw — not on a proxy
// reconstructed at training time from generic snapshot fields.
import {
  extractFeatures as extractMlFeatures,
  FEATURE_NAMES,
  type FeatureName,
} from './ml.js';
import {
  computeDegradation,
  computeThermalEvents,
  computeInternalResistance,
  computeChargeCurveFingerprint,
} from './analytics.js';

const PATH = process.env.FEATURE_SNAPSHOTS_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'feature-snapshots.jsonl');

const MAX_IN_MEMORY = 500;
const HYDRATE_BYTES = 256 * 1024; // re-read last 256 KB at boot

export interface SnapshotRecord {
  alertId: string;
  ts: number;
  /** Alert-category-specific generic features (pack_temp_c, pack_soc, etc.).
   *  Used for diagnostics and as a fallback when lrFeatures is absent. */
  features: Record<string, number>;
  category?: string;
  severity?: string;
  title?: string;
  /**
   * v0.9.59 — Normalized LR feature vector captured AT alert fire time.
   * Same shape (and same code path) as ml.ts FEATURE_NAMES, so
   * onlineLR.snapshotToLrFeatures can consume them with no remapping.
   *
   * Only populated for pack-level alerts (where alert.packNum is set).
   * For SHP2/EVSE/system-level alerts, this is null.
   *
   * v0.13.0 — earlier comment claimed onlineLR's proxy fallback "returns
   * null and skips the SGD update" for non-pack alerts. That was WRONG: the
   * proxy reads pack_* keys that are absent from system snapshots and so
   * yields an ALL-ZERO vector, not null. With x=0 only the bias moved, so
   * every non-pack outcome silently inflated the pack-risk baseline (audit
   * P0-2). The outcome is still PERSISTED to alert-outcomes.jsonl for audit,
   * but onlineLR.updateFromOutcome now refuses to train on a degenerate
   * (all-zero / NaN) vector — category mismatch, no pack signal to learn.
   */
  lrFeatures?: Record<FeatureName, number> | null;
}

// LRU keyed by alertId. Insertion order is age — Map iterates in insertion order.
const cache = new Map<string, SnapshotRecord>();

let initialized = false;
function ensureInit(log: (m: string) => void = () => {}) {
  if (initialized) return;
  initialized = true;
  try {
    mkdirSync(dirname(PATH), { recursive: true });
  } catch { /* ignore */ }
  // Hydrate the most-recent entries from disk into memory so freshly-restarted
  // panel can still resolve features for in-flight alerts.
  if (!existsSync(PATH)) return;
  try {
    const text = readFileSync(PATH, 'utf-8');
    // Cheap approach for small files: read whole file. If it grows large
    // we can switch to the tail-with-fd pattern used elsewhere.
    const lines = text.split('\n').filter((l) => l.trim());
    let n = 0;
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as SnapshotRecord;
        cache.set(r.alertId, r);
        n++;
      } catch { /* skip */ }
    }
    // Trim to MAX_IN_MEMORY
    while (cache.size > MAX_IN_MEMORY) {
      const firstKey = cache.keys().next().value;
      if (firstKey === undefined) break;
      cache.delete(firstKey);
    }
    if (n > 0) log(`featureSnapshot: hydrated ${n} entries (${cache.size} kept in memory)`);
  } catch {
    /* file unreadable — start fresh */
  }
}

/** Capture (or update) the snapshot for an alert. Persisted + cached. */
export function captureSnapshot(record: SnapshotRecord, log: (m: string) => void = () => {}): void {
  ensureInit(log);
  // De-dup: if we already snapshotted this alert recently, don't re-write.
  // The features we care about are the ones at FIRST FIRING, not subsequent
  // refreshes. Update timestamp + features only if cache miss.
  if (cache.has(record.alertId)) return;
  cache.set(record.alertId, record);
  // Evict oldest if over cap.
  if (cache.size > MAX_IN_MEMORY) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  try {
    appendFileSync(PATH, JSON.stringify(record) + '\n');
  } catch (e: any) {
    console.error(`featureSnapshot: persist failed: ${e?.message ?? e}`);
  }
}

/** Look up snapshot for an alert. Returns undefined if not captured. */
export function getSnapshot(alertId: string): SnapshotRecord | undefined {
  ensureInit();
  return cache.get(alertId);
}

/** Drop a snapshot — used after an outcome is recorded for it, to free memory. */
export function dropSnapshot(alertId: string): void {
  cache.delete(alertId);
}

/* ─── per-category feature extractors ────────────────────────────── */

/**
 * Extract the relevant feature vector from the live snapshot for an
 * alert. Different categories surface different signals — we don't want
 * to snapshot the entire 5-DPU × 5-pack telemetry for every alert.
 *
 * Returns null if we don't know how to extract features for this alert
 * (no snapshot will be persisted; the outcome capture still works but
 * has no features attached). New extractors can be added per release as
 * we cover more alert categories.
 */
export function extractFeatures(alert: Alert, snap: FleetSnapshot): Record<string, number> | null {
  const devices = Object.values(snap.devices);
  const deviceFor = (sn: string): DeviceSnapshot | undefined =>
    devices.find((d) => d.sn === sn || d.deviceName === alert.device);
  const dev = deviceFor(alert.device);

  // Common features available for any alert.
  const common: Record<string, number> = {};

  // Thermal category — capture the involved pack/sensor + ambient context
  if (alert.category === 'Thermal' && dev?.projection?.kind === 'dpu') {
    const p = dev.projection as DpuProjection;
    const pkNum = alert.packNum;
    if (pkNum != null) {
      const pk = p.packs.find((x) => x.num === pkNum);
      if (pk?.temp != null) common['pack_temp_c'] = pk.temp;
      if (pk?.minCellTemp != null) common['min_cell_temp_c'] = pk.minCellTemp;
      if (pk?.maxCellTemp != null) common['max_cell_temp_c'] = pk.maxCellTemp;
      if (pk?.hwBoardTemp != null) common['board_temp_c'] = pk.hwBoardTemp;
      if (pk?.soc != null) common['pack_soc'] = pk.soc;
    }
    if (p.mpptHvTemp != null) common['mppt_hv_temp_c'] = p.mpptHvTemp;
    if (p.mpptLvTemp != null) common['mppt_lv_temp_c'] = p.mpptLvTemp;
    return common;
  }

  // Battery category — SoC + power + capacity context
  if (alert.category === 'Battery' && dev?.projection?.kind === 'dpu') {
    const p = dev.projection as DpuProjection;
    if (p.soc != null) common['device_soc'] = p.soc;
    if (p.totalInWatts != null) common['p_in_w'] = p.totalInWatts;
    if (p.totalOutWatts != null) common['p_out_w'] = p.totalOutWatts;
    if (p.batVol != null) common['bat_v_mv'] = p.batVol;
    if (p.batAmp != null) common['bat_a_ma'] = p.batAmp;
    const pkNum = alert.packNum;
    if (pkNum != null) {
      const pk = p.packs.find((x) => x.num === pkNum);
      if (pk?.soc != null) common['pack_soc'] = pk.soc;
      if (pk?.soh != null) common['pack_soh'] = pk.soh;
      if (pk?.cycles != null) common['pack_cycles'] = pk.cycles;
      if (pk?.maxVolDiffMv != null) common['pack_vol_diff_mv'] = pk.maxVolDiffMv;
    }
    return common;
  }

  // SHP2 / circuit alerts — circuit loads + bus state
  if (alert.category === 'SHP2') {
    const shp2 = devices.find((d) => d.projection?.kind === 'shp2');
    if (shp2?.projection?.kind === 'shp2') {
      const p = shp2.projection as Shp2Projection;
      if (p.backupBatPercent != null) common['pool_soc'] = p.backupBatPercent;
      if (p.backupReserveSoc != null) common['reserve_soc'] = p.backupReserveSoc;
      const panelLoad = p.circuits.reduce((s, c) => s + (c.watts ?? 0), 0);
      common['panel_load_w'] = panelLoad;
    }
    return common;
  }

  // Solar — PV totals + array health
  if (alert.category === 'Solar' && dev?.projection?.kind === 'dpu') {
    const p = dev.projection as DpuProjection;
    if (p.pvTotalWatts != null) common['pv_total_w'] = p.pvTotalWatts;
    if (p.pvHighWatts != null) common['pv_hv_w'] = p.pvHighWatts;
    if (p.pvLowWatts != null) common['pv_lv_w'] = p.pvLowWatts;
    if (p.pvHighVolts != null) common['pv_hv_v'] = p.pvHighVolts;
    if (p.pvLowVolts != null) common['pv_lv_v'] = p.pvLowVolts;
    if (p.pvHighAmps != null) common['pv_hv_a'] = p.pvHighAmps;
    if (p.pvLowAmps != null) common['pv_lv_a'] = p.pvLowAmps;
    return common;
  }

  // Grid / connectivity — minimal signals
  if (alert.category === 'Grid' || alert.category === 'Connectivity') {
    common['device_online'] = dev?.online ? 1 : 0;
    common['snapshot_age_ms'] = dev?.lastUpdated ? Date.now() - dev.lastUpdated : -1;
    return common;
  }

  // Unknown category — at minimum stamp the alert severity as a proxy.
  if (Object.keys(common).length === 0) {
    common['snapshot_at_ms'] = Date.now();
  }
  return common;
}

/* ─── v0.9.59 LR feature capture ─────────────────────────────────── */

/**
 * v0.9.59 — Capture the REAL normalized LR feature vector for a pack-
 * level alert at fire time. Reuses the same `extractFeatures` from
 * ml.ts that `computePackRiskV2` calls for inference, so we train on
 * the same inputs the model actually saw.
 *
 * Returns null when:
 *   - The alert has no packNum (system / EVSE / SHP2 alerts — those
 *     don't drive the pack-risk LR, so there's nothing to train).
 *   - We can't resolve the alert's device to a serial in the snapshot
 *     (offline / dropped device — the analytics functions wouldn't
 *     yield a vector either).
 *
 * `computeDegradation` is async because its history pull from the
 * recorder can hit disk; the other three are sync. All four have
 * internal TTL caches (~60s) so in steady state every call here is
 * a hash lookup. We swallow errors and return null rather than
 * blocking the alert dispatch — a missing LR feature vector just
 * means the SGD update is skipped (same fallback path that was used
 * pre-v0.9.59).
 */
export async function captureLrFeatures(
  alert: Alert,
  snap: FleetSnapshot,
  recorder: Recorder,
  // v0.10.0 — reports come from the analytics worker. Injectable so unit
  // tests can supply an inline stub without spawning a worker; production
  // (alertMonitor) omits it and the process-wide client is resolved lazily,
  // AFTER the early `return null` guards, so the null-path tests never touch
  // the (uninitialized-in-tests) singleton.
  injectedAnalytics?: Pick<AnalyticsClient, 'report'>,
): Promise<Record<FeatureName, number> | null> {
  // Pack-level only. system/EVSE/SHP2 alerts have no LR feature signal.
  if (alert.packNum == null) return null;
  // Resolve the device serial — alert.device is the friendly name; we
  // need the SN to key into the analytics outputs.
  const devices = Object.values(snap.devices);
  const dev = devices.find((d) => d.sn === alert.device || d.deviceName === alert.device);
  if (!dev || dev.projection?.kind !== 'dpu') return null;

  try {
    const analytics = injectedAnalytics ?? getAnalytics();
    const [degradation, thermalEvents, internalR, chargeCurve] = await Promise.all([
      analytics.report('degradation'),
      analytics.report('thermalEvents'),
      analytics.report('internalResistance'),
      analytics.report('chargeCurve'),
    ]);
    const fv = extractMlFeatures(
      dev.sn,
      alert.packNum,
      degradation,
      thermalEvents,
      internalR,
      chargeCurve,
    );
    // Return the normalized vector — that's exactly what onlineLR consumes.
    // Coerce to a plain Record so JSON.stringify round-trips cleanly.
    const out = {} as Record<FeatureName, number>;
    for (const n of FEATURE_NAMES) out[n] = fv.normalized[n] ?? 0;
    return out;
  } catch {
    return null;
  }
}
