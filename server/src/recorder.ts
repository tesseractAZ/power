import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { SnapshotStore, FleetSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection, GenericProjection } from './ecoflow/project.js';
import { integrateWh } from './aggregator.js';
import { SPARE_DPU_SNS } from './shp2Membership.js';

interface MetricSample {
  sn: string;
  metric: string;
  value: number;
}

const MIN_INTERVAL_MS = 10_000;   // never record same metric more than once / 10s
const MAX_INTERVAL_MS = 300_000;  // heartbeat: record at least every 5 min even if unchanged
const VALUE_EPSILON = 0.5;        // ignore wiggle smaller than this (watts/percent)

/**
 * v0.30.0 — a persisted record of a telemetry blackout: a stretch where the
 * recorder wrote NO home-device samples for far longer than the heartbeat,
 * meaning upstream telemetry stalled (an MQTT session drop / broker reconnect,
 * or the process being down). All fields are ms epochs.
 */
export interface TelemetryGap {
  startMs: number;     // last home-device sample before the silence
  endMs: number;       // first home-device sample after the silence
  durationMs: number;  // endMs − startMs
  detectedAt: number;  // == endMs (when the gap was recognised)
}

/**
 * Pure gap predicate. A gap counts only when there was a prior insert
 * (`lastInsertMs > 0`, so the very first boot write never trips it) and the
 * silence exceeds the threshold. Separate + exported so it's unit-testable.
 */
export function detectTelemetryGap(lastInsertMs: number, nowMs: number, thresholdMs: number): boolean {
  return lastInsertMs > 0 && nowMs - lastInsertMs > thresholdMs;
}

// v0.13.1 — pseudo-device + metric names for the persisted weather-irradiance
// series (the durable GHI backfill, see recordWeatherGhi). Stored under SN
// "weather" so it shares the samples table + query() path with real devices
// but never collides with a hardware SN.
const WEATHER_SN = 'weather';
const WEATHER_GHI_METRIC = 'ghi_wm2';     // global horizontal irradiance, W/m²
const WEATHER_CLOUD_METRIC = 'cloud_pct'; // cloud cover, %

/* ─── Lifetime-energy persistence (v0.7.6) ─────────────────────────────────
 * HA's Energy Dashboard expects monotonically-increasing kWh counters
 * (`state_class: total_increasing`). The samples table only retains 30
 * days, so a naive "integrate everything in samples" would DECREASE as old
 * samples prune — HA would see that as a reset and double-count.
 *
 * Fix: keep a separate `lifetime_totals` table that accumulates integrated
 * Wh under a per-metric watermark. On every rollup we integrate the window
 * (watermark, now], add to the accumulator, advance the watermark. Survives
 * pruning, server restarts, and DB downsizing.
 *
 * The watt-based metrics we track (PV / panel-load / AC-in) are integrated
 * from the samples table. Battery in/out has authoritative lifetime mAh
 * counters from the BMS — those go straight in without integration. */

export interface LifetimeTotals {
  /** Persisted accumulator (Wh). Increments forever. */
  persistedWh: number;
  /** Integral of the current window past the watermark (also Wh) — added to the live total. */
  pendingWh: number;
  /** Watermark — last ts up to which we've already accumulated. */
  watermarkMs: number;
}

/**
 * v0.15.14 — lifetime micro-dip clamp (pure, testable core).
 *
 * The live total (persisted + pending) is re-estimated on every call, so it
 * can dip a few Wh below the previously emitted total (rollup persistence vs
 * live trapezoid rounding). HA `total_increasing` sensors interpret ANY
 * decrease as a meter reset, so those micro-dips registered as phantom
 * Energy-Dashboard resets. Returns the pendingWh to emit: held so the total
 * never dips by ≤ maxDipWh, while a larger drop (a genuine operator reset,
 * e.g. the v0.13.0 re-zero) passes through untouched so reset semantics work.
 */
export function clampLifetimeDip(
  prevEmittedTotalWh: number | undefined,
  persistedWh: number,
  pendingWh: number,
  maxDipWh = 50,
): number {
  if (prevEmittedTotalWh == null) return pendingWh;
  const total = persistedWh + pendingWh;
  const dip = prevEmittedTotalWh - total;
  if (dip > 0 && dip <= maxDipWh) return prevEmittedTotalWh - persistedWh;
  return pendingWh;
}

// v0.13.0 — per-pack lifetime baseline (absolute factory-register snapshot
// captured the first time a (sn, packNum) pair is seen). Home totals use
// the DELTA from this baseline, not the absolute register. See
// computeBmsBatteryTotals / packDeltaWh.
export interface PackBaseline {
  /** accuChgMah at first sight of this pack. */
  chgMah: number;
  /** accuDsgMah at first sight of this pack. */
  dsgMah: number;
}

/**
 * v0.13.0 — pure baseline-subtraction math (exported for unit testing).
 *
 * Convert one pack's BMS lifetime registers into the home-relative Wh that
 * have flowed since `base` was captured. Returns 0 for a missing register
 * (BMS readback dropout) or a missing baseline (caller hasn't captured one
 * yet). Deltas are floored at 0 so a register that reads BELOW its baseline
 * — only possible from a corrupt/rolled-back BMS read — can't decrement the
 * home counter. Because both registers are re-zeroed at the same instant,
 * `dsgWh ≤ chgWh` holds whenever the underlying deltas do, so the RTE clamp
 * downstream stops firing on healthy data.
 */
export function packDeltaWh(
  pk: { accuChgMah: number | null; accuDsgMah: number | null },
  base: PackBaseline | undefined,
  mahToWh: number,
): { chgWh: number; dsgWh: number } {
  if (!base) return { chgWh: 0, dsgWh: 0 };
  const chgDelta = pk.accuChgMah != null ? pk.accuChgMah - base.chgMah : 0;
  const dsgDelta = pk.accuDsgMah != null ? pk.accuDsgMah - base.dsgMah : 0;
  return {
    chgWh: Math.max(0, chgDelta) * mahToWh,
    dsgWh: Math.max(0, dsgDelta) * mahToWh,
  };
}

export interface Recorder {
  insertSnapshot: (snap: FleetSnapshot) => void;
  query: (sn: string, metric: string, sinceMs: number, untilMs: number, bucketSec?: number) => Array<{ ts: number; value: number }>;
  /** v0.9.29 — batched read: one SQL call returns rows for many (sn, metric)
   * pairs, keyed by metric. Cuts per-query overhead (statement-bind +
   * page-cache lookups) by ~6× when the caller has many metrics to pull
   * for a single device, e.g. equipment-health pulling pv_high + pv_high_v
   * + pv_high_a together. Result is a Map<metric, Array<{ts, value}>>; a
   * metric with no rows appears as an empty array, never missing. */
  queryMulti: (
    sn: string,
    metrics: string[],
    sinceMs: number,
    untilMs: number,
    bucketSec?: number,
  ) => Map<string, Array<{ ts: number; value: number }>>;
  listMetrics: (sn: string) => string[];
  /** v0.30.0 — durable record of detected telemetry blackouts (home-feed
   * silences longer than the heartbeat). Bounded ring, persisted across
   * restarts; surfaced at /api/telemetry-gaps. */
  telemetryGaps: () => TelemetryGap[];
  /** v0.13.1 — persist hourly weather irradiance (GHI) + cloud cover under
   * the pseudo-device SN "weather" so the historical series survives beyond
   * the 2h in-memory weather cache / 7-day fetch window. Change-detected and
   * idempotent: re-writing an already-stored hour is a no-op. Consumers
   * (forecast-skill, soiling, solar-model training) read it back via
   * query("weather", "ghi_wm2"|"cloud_pct", since, until). */
  recordWeatherGhi: (
    hours: Array<{ epochMs: number; radiationWm2: number | null; cloudCoverPct: number | null }>,
  ) => void;
  close: () => void;
  /** Force a lifetime-rollup tick (used by tests / on shutdown). */
  rollupLifetime: () => void;
  /** Snapshot of every lifetime counter (fleet + per-circuit). Keys are the metric_key strings. */
  getLifetimeTotals: () => Record<string, LifetimeTotals>;
  /** v0.40.3 — every persisted lifetime metric_key from the `lifetime_totals` table,
   *  independent of the current snapshot. Unlike getLifetimeTotals (whose key set is
   *  snapshot-gated via allLifetimeKeys → no per-circuit keys until an SHP2 projection is
   *  fetched), this returns the persisted keys directly, so the MQTT state payload can emit
   *  per-circuit lifetime keys at startup — before the first poll populates the snapshot —
   *  matching the retained HA per-circuit sensors from the prior run. */
  listLifetimeKeys: () => string[];
  /** v0.45.0 — READ-ONLY observability for the lifetime battery counters. Returns the
   *  unclamped charge/discharge floors, the emitted totals (persisted + pending split),
   *  the informational deficit (what the removed clamp would have shaved), the per-pack
   *  breakdown (filter membership + held-from-offline carry), and which SHP2 members are
   *  being carried while their packs are absent from the current snapshot. Performs ZERO
   *  writes and ZERO mutation of the emitted counters. Surfaced at /api/debug/battery-lifetime. */
  batteryLifetimeDebug: () => BatteryLifetimeDebug;
}

/** v0.45.0 — shape of recorder.batteryLifetimeDebug() (read-only diagnostics). */
export interface BatteryLifetimeDebug {
  rawChargeFloorWh: number;
  rawDischargeFloorWh: number;
  emittedChargeWh: number;
  emittedDischargeWh: number;
  charge: { persistedWh: number; pendingWh: number };
  discharge: { persistedWh: number; pendingWh: number };
  /** max(0, rawDischargeFloor − rawChargeFloor): what the removed clamp would have shaved. */
  deficitWh: number;
  packs: Array<{
    sn: string;
    num: number;
    present: boolean;
    passesFilter: boolean;
    baselineChgMah: number | null;
    baselineDsgMah: number | null;
    accuChgMah: number | null;
    accuDsgMah: number | null;
    chgWh: number;
    dsgWh: number;
    heldFromLastKnown: boolean;
    /** v0.48.0 — true when this pack's held value was reconstructed from recorder
     *  register history this rollup (offline-at-deploy backfill), not a live sighting. */
    backfilledFromHistory: boolean;
  }>;
  /** sourceSns members whose packs are absent this snapshot but carried via held last-known. */
  offlineHeldMembers: string[];
}

export function createRecorder(store: SnapshotStore, log: (m: string) => void): Recorder {
  const dbPath = resolve(process.cwd(), config.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  log(`recorder: opening ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    -- v0.9.14 — 32 MB page cache (negative N = KiB). Default is 2 MB, which
    -- is too small once the samples table grows past ~50 MB on disk: cold
    -- queries hit disk for index + data pages. 32 MB easily holds the
    -- working set (recent few days) for our typical fleet (~13 devices,
    -- ~30 metrics each). Trivial cost on a HA host.
    PRAGMA cache_size = -32768;
    -- mmap_size: let SQLite memory-map up to 256 MB of the db file for
    -- read paths. Reads from mmap'd pages skip the syscall overhead of
    -- pread/pwrite. Has no effect if the db is smaller; bounded so we
    -- don't surprise resource-constrained hosts.
    PRAGMA mmap_size = 268435456;
    -- temp_store: in-memory for temp B-trees used by GROUP BY (our new
    -- SQL-side bucketing query relies on these). The default (0) maps
    -- to "file" on some platforms - explicit MEMORY is faster + safer.
    PRAGMA temp_store = MEMORY;
    CREATE TABLE IF NOT EXISTS samples (
      ts INTEGER NOT NULL,
      sn TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_sn_metric_ts ON samples (sn, metric, ts);
    CREATE TABLE IF NOT EXISTS lifetime_totals (
      metric_key TEXT PRIMARY KEY,
      wh REAL NOT NULL DEFAULT 0,
      last_integrated_ts INTEGER NOT NULL DEFAULT 0
    );
  `);

  // v0.9.29 — refresh query-planner statistics. Without this, after a fresh
  // install (samples table empty when ANALYZE last ran), SQLite assumes the
  // composite index is uniform and may pick a less-efficient plan once
  // samples skew (e.g. one metric having 50× the rows of another). ANALYZE
  // on every startup is cheap on a single index — single-digit ms even at
  // millions of rows — and lets the planner keep pace with growth.
  try {
    db.exec(`ANALYZE samples;`);
  } catch (e: any) {
    log(`recorder: ANALYZE skipped (${e?.message ?? e})`);
  }

  const insert = db.prepare(`INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)`);
  const insertMany = db.prepare(`INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)`);

  // Last-recorded state per (sn,metric) for dedupe
  type Last = { ts: number; value: number };
  const last: Map<string, Last> = new Map();

  function shouldRecord(sn: string, metric: string, value: number, now: number): boolean {
    const k = `${sn}|${metric}`;
    const prev = last.get(k);
    if (!prev) return true;
    const dt = now - prev.ts;
    if (dt < MIN_INTERVAL_MS) return false;
    if (dt >= MAX_INTERVAL_MS) return true;
    return Math.abs(value - prev.value) >= VALUE_EPSILON;
  }

  // v0.30.0 — telemetry-gap detection. record() runs ONLY in response to a
  // store 'change' event; nothing fires when upstream telemetry STOPS. So a
  // silent blackout (one 132-min MQTT stall in the 7-day log) wrote zero rows
  // and left zero trace — only discoverable by scanning /api/history. Track the
  // last HOME-device insert (spares are excluded so a bench unit can't mask a
  // home-feed stall) and, when writes resume after a long silence, persist a
  // durable marker (NOT synthetic samples — those would corrupt the
  // byte-identical history + energy integration). Surfaced at /api/telemetry-gaps.
  const GAP_THRESHOLD_MS = 3 * MAX_INTERVAL_MS;   // 15 min — comfortably above the 5-min heartbeat
  const GAPS_MAX = 50;                            // bounded persisted ring
  const gapsPath = resolve(dirname(dbPath), 'telemetry-gaps.json');
  let lastHomeInsertTs = 0;
  const telemetryGapsLog: TelemetryGap[] = (() => {
    try {
      const arr = JSON.parse(readFileSync(gapsPath, 'utf8'));
      return Array.isArray(arr) ? (arr as TelemetryGap[]).slice(-GAPS_MAX) : [];
    } catch { return []; }
  })();

  function recordTelemetryGap(startMs: number, endMs: number) {
    const gap: TelemetryGap = { startMs, endMs, durationMs: endMs - startMs, detectedAt: endMs };
    telemetryGapsLog.push(gap);
    if (telemetryGapsLog.length > GAPS_MAX) telemetryGapsLog.splice(0, telemetryGapsLog.length - GAPS_MAX);
    try {
      writeFileSync(gapsPath, JSON.stringify(telemetryGapsLog), { mode: 0o644 });
    } catch (e: any) {
      log(`recorder: failed to persist telemetry gap (${e?.message ?? e})`);
    }
    const mins = Math.round(gap.durationMs / 60_000);
    log(`recorder: ⚠ TELEMETRY GAP — no home-device samples for ${mins} min (${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}); writes resumed`);
  }

  function record(samples: MetricSample[]) {
    if (samples.length === 0) return;
    const now = Date.now();
    const tx = db.prepare('BEGIN');
    tx.run();
    let written = 0;
    let sawHomeInsert = false;
    try {
      for (const s of samples) {
        if (typeof s.value !== 'number' || !Number.isFinite(s.value)) continue;
        if (!shouldRecord(s.sn, s.metric, s.value, now)) continue;
        insert.run(now, s.sn, s.metric, s.value);
        last.set(`${s.sn}|${s.metric}`, { ts: now, value: s.value });
        written++;
        if (!SPARE_DPU_SNS.has(s.sn)) sawHomeInsert = true;
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    // v0.30.0 — fleet telemetry-gap heartbeat. A home-device write just landed;
    // if the previous home write was long ago, telemetry was silent in between.
    if (sawHomeInsert) {
      if (detectTelemetryGap(lastHomeInsertTs, now, GAP_THRESHOLD_MS)) {
        recordTelemetryGap(lastHomeInsertTs, now);
      }
      lastHomeInsertTs = now;
    }
    // v0.9.74 — silence per-tick chatter. The previous "wrote N samples"
    // line fired every 10 s under normal load (~44 lines/min, ~88 % of
    // log volume). Aggregate to a once-per-minute heartbeat that
    // surfaces total + peak burst, and only when there's activity.
    recordedSamplesSinceTick += written;
    recordedSamplesPeak = Math.max(recordedSamplesPeak, written);
    const tickNowMs = Date.now();
    if (tickNowMs - lastSampleLogAt >= 60_000) {
      if (recordedSamplesSinceTick > 0) {
        log(`recorder: ${recordedSamplesSinceTick} samples in last ${Math.round((tickNowMs - lastSampleLogAt) / 1000)}s (peak burst ${recordedSamplesPeak})`);
      }
      recordedSamplesSinceTick = 0;
      recordedSamplesPeak = 0;
      lastSampleLogAt = tickNowMs;
    }
  }
  // v0.9.74 — sample-write log throttling state. See recordSamples() above.
  let recordedSamplesSinceTick = 0;
  let recordedSamplesPeak = 0;
  let lastSampleLogAt = Date.now();

  function extract(snap: FleetSnapshot): MetricSample[] {
    const out: MetricSample[] = [];
    for (const d of Object.values(snap.devices)) {
      const p = d.projection;
      if (!p) continue;
      const push = (metric: string, v: number | null | undefined) => {
        if (v == null || !Number.isFinite(v)) return;
        out.push({ sn: d.sn, metric, value: v });
      };
      if (p.kind === 'dpu') {
        const dpu = p as DpuProjection;
        push('soc', dpu.soc);
        push('pv_total', dpu.pvTotalWatts);
        push('pv_high', dpu.pvHighWatts);
        push('pv_low', dpu.pvLowWatts);
        push('pv_high_v', dpu.pvHighVolts);
        push('pv_high_a', dpu.pvHighAmps);
        push('pv_low_v', dpu.pvLowVolts);
        push('pv_low_a', dpu.pvLowAmps);
        push('ac_in', dpu.acInWatts);
        push('ac_out', dpu.acOutWatts);
        push('total_in', dpu.totalInWatts);
        push('total_out', dpu.totalOutWatts);
        push('bat_vol', dpu.batVol);
        push('bat_amp', dpu.batAmp);
        push('mppt_hv_temp', dpu.mpptHvTemp);
        push('mppt_lv_temp', dpu.mpptLvTemp);
        // v0.9.78 — record the configured charge ceiling so the
        // curtailment engine can judge each historical hour against the
        // ceiling that was actually in effect (Storm Guard raises it to
        // 100; normal mode sits lower). Slow-changing setting, but the
        // recorder's change-detection only writes when it moves, so this
        // costs ~nothing in steady state.
        push('chg_max_soc', dpu.chgMaxSoc);
        for (const pk of dpu.packs) {
          push(`pack${pk.num}_soc`, pk.soc);
          push(`pack${pk.num}_temp`, pk.temp);
          push(`pack${pk.num}_in`, pk.inputWatts);
          push(`pack${pk.num}_out`, pk.outputWatts);
          push(`pack${pk.num}_cell_max`, pk.maxCellTemp);
          push(`pack${pk.num}_cell_min`, pk.minCellTemp);
          push(`pack${pk.num}_mos_max`, pk.maxMosTemp);
          push(`pack${pk.num}_board`, pk.hwBoardTemp);
          push(`pack${pk.num}_vol_diff_mv`, pk.maxVolDiffMv);
          push(`pack${pk.num}_vol_max_mv`, pk.maxCellVoltageMv);
          push(`pack${pk.num}_vol_min_mv`, pk.minCellVoltageMv);
          push(`pack${pk.num}_balancing`, pk.balanceState != null && pk.balanceState !== 0 ? 1 : 0);
          // Battery health — slow-changing, but worth long-term trending
          push(`pack${pk.num}_soh`, pk.actSoh ?? pk.soh);
          push(`pack${pk.num}_cycles`, pk.cycles);
          push(`pack${pk.num}_full_cap_mah`, pk.fullCapMah);
          push(`pack${pk.num}_remain_cap_mah`, pk.remainCapMah);
          push(`pack${pk.num}_lifetime_chg_mah`, pk.accuChgMah);
          push(`pack${pk.num}_lifetime_dsg_mah`, pk.accuDsgMah);
        }
      } else if (p.kind === 'shp2') {
        const shp = p as Shp2Projection;
        push('backup_pct', shp.backupBatPercent);
        push('backup_remain_min', shp.backupDischargeTimeMin);
        push('backup_charge_min', shp.backupChargeTimeMin);
        let panelLoad = 0;
        for (const c of shp.circuits) {
          if (c.watts == null) continue;
          panelLoad += c.watts;
          push(`ch${c.ch}_w`, c.watts);
        }
        push('panel_load', panelLoad);
        // v0.34.0 — total grid power into the home at the SHP2 main. Distinct from
        // DPU ac_in (grid charging the DPUs): this captures grid that serves home
        // loads DIRECTLY through the panel, the term the self-consumption/carbon
        // energy balance was missing.
        push('grid_home_w', shp.gridWatt);
        // Paired (split-phase 240V) load totals — the canonical wattage for each "circuit"
        for (const pc of shp.pairedCircuits) {
          if (pc.watts != null) push(`pair${pc.primaryCh}_w`, pc.watts);
        }
        for (const s of shp.sources) {
          push(`src${s.slot}_pct`, s.batteryPercentage);
          push(`src${s.slot}_temp`, s.emsBatTemp);
        }
        for (let i = 0; i < shp.sourceWatts.length; i++) {
          push(`src${i + 1}_w`, shp.sourceWatts[i]);
        }
      } else {
        const g = p as GenericProjection;
        push('soc', g.soc);
        push('in_watts', g.inWatts);
        push('out_watts', g.outWatts);
        push('pv_watts', g.pvWatts);
        push('ac_in', g.acInWatts);
        push('ac_out', g.acOutWatts);
        push('temp', g.temp);
      }
    }
    return out;
  }

  // Subscribe to store changes, but coalesce: bursts of MQTT messages → one extract per tick.
  let pending = false;
  store.on('change', () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      try {
        record(extract(store.get()));
      } catch (e: any) {
        log(`recorder: record failed ${e?.message ?? e}`);
      }
    });
  });

  // Retention sweep every hour: drop samples > 30 days old.
  const prune = db.prepare(`DELETE FROM samples WHERE ts < ?`);
  const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
  setInterval(() => {
    try {
      const cutoff = Date.now() - RETAIN_MS;
      const res = prune.run(cutoff);
      if (res.changes && Number(res.changes) > 0) log(`recorder: pruned ${res.changes} old samples`);
    } catch (e: any) {
      log(`recorder: prune failed ${e?.message ?? e}`);
    }
  }, 60 * 60 * 1000).unref();

  const queryStmt = db.prepare(
    `SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`,
  );
  // v0.9.14 — SQL-side bucketing. Before this, query() read every raw sample
  // (potentially tens of thousands over a 7-day window) and the caller bucketed
  // in JS. Now the GROUP BY happens in SQLite, returning ~one row per bucket
  // and slashing both wire-bytes and JS work for chart queries. The bucket key
  // is `floor(ts / bucketMs) * bucketMs` (the canonical bucket-start timestamp)
  // so output matches the legacy JS implementation byte-for-byte.
  const queryBucketedStmt = db.prepare(
    `SELECT CAST((ts / ?) AS INTEGER) * ? AS bucket_ts, AVG(value) AS value
       FROM samples
      WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ?
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC`,
  );
  const metricsStmt = db.prepare(`SELECT DISTINCT metric FROM samples WHERE sn = ? ORDER BY metric ASC`);

  // v0.9.29 — multi-metric batched fetch. Single statement, IN-list bound at
  // call time. The query planner uses the composite (sn, metric, ts) index
  // and walks each metric's segment in turn; the result set comes back
  // already grouped by metric (within metric, by ts ASC). The hot callers
  // (equipment-health, self-consumption) used to do one db.prepare().all()
  // per metric — 6 round-trips per device — and now do one. We cache the
  // prepared statement per (metricCount, bucketed) tuple because `node:sqlite`
  // re-prepares on every new SQL string, and ratioSeries always uses the
  // same shape (3 metrics, unbucketed or 5-min-bucketed).
  const queryMultiStmtCache = new Map<string, ReturnType<typeof db.prepare>>();
  const getQueryMultiStmt = (metricCount: number, bucketed: boolean) => {
    const key = `${metricCount}|${bucketed ? 'b' : 'r'}`;
    let stmt = queryMultiStmtCache.get(key);
    if (stmt) return stmt;
    const placeholders = new Array(metricCount).fill('?').join(',');
    const sql = bucketed
      ? `SELECT metric, CAST((ts / ?) AS INTEGER) * ? AS bucket_ts, AVG(value) AS value
           FROM samples
          WHERE sn = ? AND metric IN (${placeholders}) AND ts >= ? AND ts <= ?
          GROUP BY metric, bucket_ts
          ORDER BY metric ASC, bucket_ts ASC`
      : `SELECT metric, ts, value
           FROM samples
          WHERE sn = ? AND metric IN (${placeholders}) AND ts >= ? AND ts <= ?
          ORDER BY metric ASC, ts ASC`;
    stmt = db.prepare(sql);
    queryMultiStmtCache.set(key, stmt);
    return stmt;
  };

  // ─── Lifetime energy accumulator ────────────────────────────────────────
  const lifetimeReadStmt = db.prepare(
    `SELECT wh, last_integrated_ts FROM lifetime_totals WHERE metric_key = ?`,
  );
  const lifetimeUpsertStmt = db.prepare(
    `INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)
     ON CONFLICT(metric_key) DO UPDATE SET wh = excluded.wh, last_integrated_ts = excluded.last_integrated_ts`,
  );
  // v0.40.3 — persisted lifetime keys, snapshot-independent (see Recorder.listLifetimeKeys).
  const lifetimeKeysStmt = db.prepare(`SELECT metric_key FROM lifetime_totals`);
  const listLifetimeKeys = (): string[] =>
    (lifetimeKeysStmt.all() as Array<{ metric_key: string }>).map((r) => r.metric_key);
  // Watt-integrated metrics: we sum these across all (sn,metric) pairs in
  // the current snapshot. Battery in/out comes from BMS counters directly
  // so it's NOT in this list (handled by computeBmsBatteryTotals).
  const LIFETIME_KEYS = [
    'fleet_pv_wh',
    'fleet_load_wh',
    'fleet_grid_import_wh',
    // v0.34.0 — total whole-home grid import metered at the SHP2 main
    // (grid_home_w = wattInfo.gridWatt). The existing fleet_grid_import_wh
    // (DPU ac_in) only counts grid charging the DPUs; this is the authoritative
    // total that makes the home-load energy balance close. Kept additive so the
    // existing HA Energy Dashboard grid counter is undisturbed.
    'fleet_grid_home_wh',
    'fleet_battery_charge_wh',
    'fleet_battery_discharge_wh',
  ] as const;
  // v0.8.0 — per-circuit watt-integrated lifetime counters. Dynamic key
  // shape `circuit_<chNum>_wh` populated from buildContributors using
  // each SHP2 circuit's `ch${ch}_w` watt metric. Pruning of raw samples
  // can't decrement these; same watermark guarantees as the fleet keys.

  const readLifetime = (key: string): { wh: number; ts: number } => {
    const r = lifetimeReadStmt.get(key) as { wh: number; last_integrated_ts: number } | undefined;
    return r ? { wh: r.wh, ts: r.last_integrated_ts } : { wh: 0, ts: 0 };
  };
  const writeLifetime = (key: string, wh: number, ts: number) => {
    lifetimeUpsertStmt.run(key, wh, ts);
  };

  /**
   * Build per-snapshot lists of (sn, metric) pairs that contribute to each
   * fleet-level lifetime metric. Filters by topology (grid-tied DPUs only
   * for AC-in; SHP2-only for panel_load).
   */
  const buildContributors = (snap: FleetSnapshot): Record<string, Array<{ sn: string; metric: string }>> => {
    const out: Record<string, Array<{ sn: string; metric: string }>> = {
      fleet_pv_wh: [],
      fleet_load_wh: [],
      fleet_grid_import_wh: [],
      fleet_grid_home_wh: [], // v0.34.0 — SHP2-metered total home grid import
    };
    const devices = Object.values(snap.devices);
    const shp2 = devices.find((d) => d.projection?.kind === 'shp2');
    const sourceSns = shp2
      ? new Set(((shp2.projection as Shp2Projection).sources ?? []).map((s) => s.sn).filter((s): s is string => !!s))
      : new Set<string>();
    for (const d of devices) {
      const p = d.projection;
      if (!p) continue;
      if (p.kind === 'dpu') {
        // v0.9.74 — fleet_pv_wh is the HA Energy Dashboard "lifetime PV
        // production" counter. Only SHP2-connected DPUs deliver power
        // to the home, so only their PV contributes. A spare core
        // charging from an outdoor solar string is still genuine PV
        // production but it isn't "the home's PV" until it's wired in.
        // (Same gating logic as fleet_grid_import_wh below — the
        // sourceSns.size === 0 fallback keeps DPU-only setups working.)
        if (sourceSns.size === 0 || sourceSns.has(d.sn)) {
          out.fleet_pv_wh.push({ sn: d.sn, metric: 'pv_total' });
          out.fleet_grid_import_wh.push({ sn: d.sn, metric: 'ac_in' });
        }
      } else if (p.kind === 'shp2') {
        out.fleet_load_wh.push({ sn: d.sn, metric: 'panel_load' });
        // v0.34.0 — total home grid import metered at the SHP2 main (the term the
        // self-consumption / carbon balance was missing). Integrated like the
        // other watt metrics; gridWatt ≥ 0 so the accumulator is monotone.
        out.fleet_grid_home_wh.push({ sn: d.sn, metric: 'grid_home_w' });
        // v0.8.0 — one lifetime key per circuit so each appears as an HA
        // Energy Dashboard "Individual device".
        for (const c of (p as Shp2Projection).circuits ?? []) {
          const key = `circuit_${c.ch}_wh`;
          out[key] = [{ sn: d.sn, metric: `ch${c.ch}_w` }];
        }
      }
    }
    return out;
  };

  /** Resolve the active list of lifetime keys (fixed fleet keys + dynamic per-circuit). */
  const allLifetimeKeys = (snap: FleetSnapshot): string[] => {
    const keys: string[] = [...LIFETIME_KEYS];
    const shp2 = Object.values(snap.devices).find((d) => d.projection?.kind === 'shp2');
    if (shp2 && shp2.projection?.kind === 'shp2') {
      for (const c of (shp2.projection as Shp2Projection).circuits ?? []) {
        keys.push(`circuit_${c.ch}_wh`);
      }
    }
    return keys;
  };

  /**
   * Battery in/out from BMS: sum `accuChgMah` and `accuDsgMah` across all
   * packs on all DPUs, convert mAh → Wh using the same conversion used by
   * analytics. The BMS counters are themselves monotone so we just store
   * the latest snapshot value (with a "monotone-or-stay" floor so a brief
   * BMS readback hiccup doesn't drop the count).
   */
  // Each pack is 32S1P (~104 V nominal; 32 series cells whose mV sum to packVoltageMv).
  // fullCap is single-string mAh; Wh = mAh × (32 × 3.2 V) / 1000 = mAh × 0.1024.
  const PACK_MAH_TO_WH = (32 * 3.2) / 1_000;   // = 0.1024 Wh/mAh (was (51.2 * 2)/1_000, same value)

  // v0.13.0 — per-pack baseline capture. The accu* registers are FACTORY-
  // lifetime counters: packs ship with accuDsgMah > accuChgMah from bench
  // cycling, so summing the ABSOLUTE values gave a permanent discharge-
  // favoring offset (~44→121 kWh in the audit window). That made lifetime
  // discharge always exceed charge, tripping the clamp below 926× and
  // flat-lining HA's discharge tile. Fix: subtract a per-(sn,packNum)
  // baseline captured once at install so DELTAS — the energy that's
  // actually flowed since we started watching — drive the home totals.
  // Both counters zero at install, so discharge ≤ charge holds naturally.
  const packBaseKey = (sn: string, packNum: number, kind: 'chg' | 'dsg') =>
    `pack_base_${sn}_${packNum}_${kind}`;
  const bmsBaselines: Map<string, PackBaseline> = new Map();
  const loadPackBaseline = (sn: string, packNum: number): PackBaseline | undefined => {
    const cacheKey = `${sn}|${packNum}`;
    const cached = bmsBaselines.get(cacheKey);
    if (cached) return cached;
    const chg = readLifetime(packBaseKey(sn, packNum, 'chg'));
    const dsg = readLifetime(packBaseKey(sn, packNum, 'dsg'));
    // ts === 0 on both means no baseline has been persisted yet.
    if (chg.ts === 0 && dsg.ts === 0) return undefined;
    const base: PackBaseline = { chgMah: chg.wh, dsgMah: dsg.wh };
    bmsBaselines.set(cacheKey, base);
    return base;
  };
  const savePackBaseline = (sn: string, packNum: number, base: PackBaseline) => {
    const now = Date.now();
    writeLifetime(packBaseKey(sn, packNum, 'chg'), base.chgMah, now);
    writeLifetime(packBaseKey(sn, packNum, 'dsg'), base.dsgMah, now);
    bmsBaselines.set(`${sn}|${packNum}`, base);
    log(`recorder: v0.13.0 captured BMS baseline sn=${sn} pack=${packNum} baseChg=${base.chgMah.toFixed(0)}mAh baseDsg=${base.dsgMah.toFixed(0)}mAh`);
  };

  // v0.45.0 — per-pack last-known home-relative Wh (charge/discharge deltas),
  // held across an SHP2-connected pack's cloud-offline gap. When a core goes
  // offline its packs leave the snapshot sum; without this the fleet BMS sum
  // dropped below the monotone floor and BOTH counters froze (HA "Battery
  // in/out today = 0 kWh"). We carry each connected pack's last good delta so
  // one offline core can't drag the fleet sum down. Keyed `${sn}|${num}`.
  //
  // PERSISTED (pack_lastwh_<sn>_<num>_chg/_dsg, mirroring savePackBaseline) so
  // a restart-while-offline — the operator's CURRENT condition (Core 1 offline)
  // plus routine add-on restarts — does NOT re-freeze the counters. These keys
  // are INTERNAL (like pack_base_*) and are excluded from the surfaced lifetime
  // key sets (allLifetimeKeys / getLifetimeTotals).
  const packLastWhKey = (sn: string, packNum: number, kind: 'chg' | 'dsg') =>
    `pack_lastwh_${sn}_${packNum}_${kind}`;
  const bmsLastPackWh: Map<string, { chgWh: number; dsgWh: number }> = new Map();
  const loadPackLastWh = (sn: string, packNum: number): { chgWh: number; dsgWh: number } | undefined => {
    const cacheKey = `${sn}|${packNum}`;
    const cached = bmsLastPackWh.get(cacheKey);
    if (cached) return cached;
    const chg = readLifetime(packLastWhKey(sn, packNum, 'chg'));
    const dsg = readLifetime(packLastWhKey(sn, packNum, 'dsg'));
    // ts === 0 on both means nothing persisted yet for this pack.
    if (chg.ts === 0 && dsg.ts === 0) return undefined;
    const held = { chgWh: chg.wh, dsgWh: dsg.wh };
    bmsLastPackWh.set(cacheKey, held);
    return held;
  };
  const savePackLastWh = (sn: string, packNum: number, held: { chgWh: number; dsgWh: number }) => {
    const now = Date.now();
    writeLifetime(packLastWhKey(sn, packNum, 'chg'), held.chgWh, now);
    writeLifetime(packLastWhKey(sn, packNum, 'dsg'), held.dsgWh, now);
    bmsLastPackWh.set(`${sn}|${packNum}`, held);
  };
  // v0.45.0 — corrupt-read guard: a single rollup may never advance a pack's
  // contribution by more than one full pack's capacity worth of Wh (a
  // physically-impossible jump only a garbage BMS read could produce). Removing
  // the old discharge≤charge invariant also removed its incidental protection
  // against such a read permanently inflating the floor, so this caps it. Once-
  // per-pack warn throttle keyed `${sn}|${num}` so a stuck read doesn't spew.
  const FALLBACK_FULL_PACK_WH = 6200; // ~one DPU pack when fullCap is unavailable
  const bmsCorruptWarned: Set<string> = new Set();

  /**
   * v0.45.0 — per-pack detail for one snapshot (the single source of truth for
   * both the fleet sum and batteryLifetimeDebug). For EVERY pack on EVERY DPU we
   * report whether it PASSES THE EXACT live-sum filter (`kind==='dpu'` AND
   * sourceSns membership AND a captured baseline), its fresh baseline-subtracted
   * delta (when it passes), and whether the contribution this snapshot came from
   * a HELD last-known value (offline carry). A pack that fails the sourceSns
   * filter (a spare core, the v0.9.74 exclusion) is NEVER carried and NEVER
   * summed — `passesFilter:false`, contributes 0. `mutate:false` makes this safe
   * for the read-only debug endpoint (no baseline capture, no held-value write).
   */
  const computeBmsBatteryDetail = (
    snap: FleetSnapshot,
    opts: { mutate: boolean },
  ): {
    chargeWh: number;
    dischargeWh: number;
    packs: Array<{
      sn: string;
      num: number;
      present: boolean;
      passesFilter: boolean;
      baselineChgMah: number | null;
      baselineDsgMah: number | null;
      accuChgMah: number | null;
      accuDsgMah: number | null;
      chgWh: number;
      dsgWh: number;
      heldFromLastKnown: boolean;
      backfilledFromHistory: boolean;
    }>;
    offlineHeldMembers: string[];
  } => {
    // v0.9.74 — only SHP2-connected packs count toward the home's lifetime
    // battery in/out totals. A spare core's BMS counts up every time it's
    // charged on the bench but that energy never reaches the home. Without this
    // filter the HA Energy Dashboard "battery charged / discharged" tile was
    // ~67% overstated for setups with spare cores.
    const devices = Object.values(snap.devices);
    const shp2 = devices.find((d) => d.projection?.kind === 'shp2');
    const sourceSns = shp2
      ? new Set(((shp2.projection as Shp2Projection).sources ?? []).map((s) => s.sn).filter((s): s is string => !!s))
      : new Set<string>();
    // v0.45.0 — "is this pack a home-fleet member?" uses the EXACT same predicate
    // as the live sum: a DPU passing the sourceSns filter. The empty-set fallback
    // (DPU-only setups / SHP2 not yet seen) matches the live sum's behavior. A
    // pack that fails this is a spare — never held, never resurrected.
    const isHomeMember = (sn: string) => sourceSns.size === 0 || sourceSns.has(sn);

    const packs: Array<{
      sn: string;
      num: number;
      present: boolean;
      passesFilter: boolean;
      baselineChgMah: number | null;
      baselineDsgMah: number | null;
      accuChgMah: number | null;
      accuDsgMah: number | null;
      chgWh: number;
      dsgWh: number;
      heldFromLastKnown: boolean;
      backfilledFromHistory: boolean;
    }> = [];
    // Keys passing the filter THIS snapshot (fresh delta path) — used to avoid
    // double-counting them via the held-offline carry below.
    const passedThisSnapshot = new Set<string>();
    let chargeWh = 0;
    let dischargeWh = 0;

    for (const d of devices) {
      if (d.projection?.kind !== 'dpu') continue;
      const member = isHomeMember(d.sn);
      for (const pk of (d.projection as DpuProjection).packs) {
        const cacheKey = `${d.sn}|${pk.num}`;
        // v0.13.0 — a newly-seen pack (install, pack-swap, hot-add) captures its
        // own baseline lazily so its absolute factory offset never leaks into
        // the home totals. Only members capture a baseline (mirrors the live
        // sum's filter; a spare must never seed home-fleet state).
        let base = loadPackBaseline(d.sn, pk.num);
        if (!base && member && (pk.accuChgMah != null || pk.accuDsgMah != null)) {
          base = { chgMah: pk.accuChgMah ?? 0, dsgMah: pk.accuDsgMah ?? 0 };
          // Persist the baseline only on the mutating (rollup/live) path; the
          // read-only debug path uses the just-derived value without writing.
          if (opts.mutate) savePackBaseline(d.sn, pk.num, base);
        }
        // The live-sum filter, applied identically here: DPU kind (already true)
        // AND sourceSns membership AND non-null register AND a captured baseline.
        const hasRegister = pk.accuChgMah != null || pk.accuDsgMah != null;
        const passesFilter = member && hasRegister && !!base;
        const fresh = passesFilter ? packDeltaWh(pk, base, PACK_MAH_TO_WH) : { chgWh: 0, dsgWh: 0 };

        if (passesFilter) {
          passedThisSnapshot.add(cacheKey);
          // v0.45.0 corrupt-read guard: a single rollup may not advance a pack's
          // contribution past its held value by more than one full pack capacity.
          const held = bmsLastPackWh.get(cacheKey) ?? loadPackLastWh(d.sn, pk.num);
          const capWh = (pk.fullCapMah != null ? pk.fullCapMah * PACK_MAH_TO_WH : FALLBACK_FULL_PACK_WH);
          let useChg = fresh.chgWh;
          let useDsg = fresh.dsgWh;
          let suspect = false;
          if (held) {
            if (fresh.chgWh - held.chgWh > capWh || fresh.dsgWh - held.dsgWh > capWh) {
              suspect = true;
              useChg = held.chgWh;
              useDsg = held.dsgWh;
            }
          }
          if (suspect && opts.mutate && !bmsCorruptWarned.has(cacheKey)) {
            bmsCorruptWarned.add(cacheKey);
            log(`recorder: v0.45.0 WARN suspect BMS read sn=${d.sn} pack=${pk.num} — single-rollup jump exceeds one pack capacity (${capWh.toFixed(0)} Wh); holding previous (freshChg=${fresh.chgWh.toFixed(0)} heldChg=${held!.chgWh.toFixed(0)} freshDsg=${fresh.dsgWh.toFixed(0)} heldDsg=${held!.dsgWh.toFixed(0)} Wh)`);
          } else if (!suspect) {
            bmsCorruptWarned.delete(cacheKey);
          }
          // MONOTONE-HOLD: a lower reconnect register read never de-syncs the
          // floor — store the max of held vs the (guard-applied) fresh value.
          const newHeld = {
            chgWh: Math.max(held?.chgWh ?? 0, useChg),
            dsgWh: Math.max(held?.dsgWh ?? 0, useDsg),
          };
          // Mutating path persists + caches the advanced hold; read-only debug
          // path leaves bmsLastPackWh untouched so it can never influence the
          // next rollup's monotone-hold (strictly read-only).
          if (opts.mutate) savePackLastWh(d.sn, pk.num, newHeld);
          chargeWh += newHeld.chgWh;
          dischargeWh += newHeld.dsgWh;
          packs.push({
            sn: d.sn,
            num: pk.num,
            present: true,
            passesFilter: true,
            baselineChgMah: base ? base.chgMah : null,
            baselineDsgMah: base ? base.dsgMah : null,
            accuChgMah: pk.accuChgMah,
            accuDsgMah: pk.accuDsgMah,
            chgWh: newHeld.chgWh,
            dsgWh: newHeld.dsgWh,
            heldFromLastKnown: false,
            backfilledFromHistory: false,
          });
        } else {
          // Present in the snapshot but fails the filter (spare, or no baseline/
          // register yet). Contributes nothing; reported for observability.
          packs.push({
            sn: d.sn,
            num: pk.num,
            present: true,
            passesFilter: false,
            baselineChgMah: base ? base.chgMah : null,
            baselineDsgMah: base ? base.dsgMah : null,
            accuChgMah: pk.accuChgMah,
            accuDsgMah: pk.accuDsgMah,
            chgWh: 0,
            dsgWh: 0,
            heldFromLastKnown: false,
            backfilledFromHistory: false,
          });
        }
      }
    }

    // v0.48.0 — offline-at-deploy backfill (MUTATE PATH ONLY). When v0.45.0
    // deployed with a member core ALREADY cloud-offline, that core's packs were
    // absent from every snapshot AND never got a pack_lastwh_* row (the held
    // hold is only written on a live sighting). It DID, however, get a v0.13.0
    // pack_base_* baseline (captured pre-deploy) plus recorded
    // pack{N}_lifetime_chg_mah/_dsg_mah register history. Without a held value
    // the offline-carry loop below skips it, so the live 2-core sum stays below
    // the boot-seeded floor and BOTH counters freeze. We reconstruct each such
    // pack's held delta ONCE from its LAST recorded register, persist it via
    // savePackLastWh, and let the EXISTING carry loop do the summing (we do NOT
    // add it to chargeWh/dischargeWh here — that would double-count). Guards:
    //   • mutate path only (read-only debug must never backfill or write);
    //   • current sourceSns member only (never a spare — isHomeMember);
    //   • pack ABSENT from this snapshot (not in passedThisSnapshot — a present
    //     pack already owns the fresh path / its own hold);
    //   • NO existing held value (not in bmsLastPackWh, no persisted
    //     pack_lastwh_* row) — so it runs at most once per pack; afterwards the
    //     pack_lastwh_* row exists and the carry loop / monotone hold own it.
    const backfilledThisCall = new Set<string>();
    if (opts.mutate) {
      const BACKFILL_WINDOW_MS = 40 * 24 * 60 * 60 * 1000; // ~40 days of register history
      const nowMs = Date.now();
      for (const baseKey of listLifetimeKeys()) {
        // Discover pack baselines via their _chg key; the _dsg key is the same pack.
        const m = baseKey.match(/^pack_base_(.+)_(\d+)_chg$/);
        if (!m) continue;
        const sn = m[1];
        const num = Number(m[2]);
        const cacheKey = `${sn}|${num}`;
        // Member-only (never a spare), absent this snapshot, and not already held.
        if (!isHomeMember(sn)) continue;
        if (passedThisSnapshot.has(cacheKey)) continue;
        if (bmsLastPackWh.has(cacheKey)) continue;
        if (loadPackLastWh(sn, num)) continue; // also populates bmsLastPackWh; harmless
        const base = loadPackBaseline(sn, num);
        if (!base) continue; // no baseline → nothing to subtract from
        // Last recorded register values before this pack went offline.
        const chgPts = queryStmt.all(sn, `pack${num}_lifetime_chg_mah`, nowMs - BACKFILL_WINDOW_MS, nowMs) as Array<{ ts: number; value: number }>;
        const dsgPts = queryStmt.all(sn, `pack${num}_lifetime_dsg_mah`, nowMs - BACKFILL_WINDOW_MS, nowMs) as Array<{ ts: number; value: number }>;
        if (chgPts.length === 0 && dsgPts.length === 0) continue; // no history → skip
        const lastChgMah = chgPts.length ? chgPts[chgPts.length - 1].value : null;
        const lastDsgMah = dsgPts.length ? dsgPts[dsgPts.length - 1].value : null;
        if (lastChgMah == null && lastDsgMah == null) continue; // registers null → skip
        const held = {
          chgWh: lastChgMah != null ? Math.max(0, lastChgMah - base.chgMah) * PACK_MAH_TO_WH : 0,
          dsgWh: lastDsgMah != null ? Math.max(0, lastDsgMah - base.dsgMah) * PACK_MAH_TO_WH : 0,
        };
        // PERSIST the held value only — the carry loop below sums it this same
        // rollup (cacheKey is now in bmsLastPackWh + has a pack_lastwh_* row).
        savePackLastWh(sn, num, held);
        backfilledThisCall.add(cacheKey);
        log(`recorder: v0.48.0 backfilled offline-at-deploy hold sn=${sn} pack=${num} from history (lastChg=${lastChgMah ?? 'null'}mAh lastDsg=${lastDsgMah ?? 'null'}mAh base=${base.chgMah.toFixed(0)}/${base.dsgMah.toFixed(0)} → held=${held.chgWh.toFixed(0)}/${held.dsgWh.toFixed(0)} Wh)`);
      }
    }

    // v0.45.0 — held-offline carry. Any pack we've previously held (in memory or
    // persisted) whose pack is NOT passing the filter THIS snapshot contributes
    // its HELD delta exactly once. This covers a member core going cloud-offline
    // (its packs vanish from the snapshot). A pack failing the sourceSns filter
    // this snapshot — e.g. a spare — must NEVER be carried; we only carry keys
    // that aren't currently spare-excluded. Since a spare never enters
    // bmsLastPackWh (only members are ever stored), the held set is members-only,
    // so this is safe. We still re-confirm membership defensively.
    const offlineHeldMembers: string[] = [];
    const heldKeys = new Set<string>(bmsLastPackWh.keys());
    // Also surface persisted-but-not-yet-loaded held keys (restart-while-offline):
    // a member that was offline at boot has no snapshot row, so loadPackBaseline
    // never ran for it — but its persisted pack_lastwh_* row must still carry.
    for (const key of listLifetimeKeys()) {
      const m = key.match(/^pack_lastwh_(.+)_(\d+)_chg$/);
      if (!m) continue;
      heldKeys.add(`${m[1]}|${Number(m[2])}`);
    }
    for (const cacheKey of heldKeys) {
      if (passedThisSnapshot.has(cacheKey)) continue; // already summed via fresh path
      const sep = cacheKey.lastIndexOf('|');
      const sn = cacheKey.slice(0, sep);
      const num = Number(cacheKey.slice(sep + 1));
      // Never resurrect a spare: if the SHP2 currently excludes this SN, skip it.
      if (!isHomeMember(sn)) continue;
      const held = bmsLastPackWh.get(cacheKey) ?? loadPackLastWh(sn, num);
      if (!held) continue;
      chargeWh += held.chgWh;
      dischargeWh += held.dsgWh;
      offlineHeldMembers.push(cacheKey);
      packs.push({
        sn,
        num,
        present: false,
        passesFilter: false,
        baselineChgMah: bmsBaselines.get(cacheKey)?.chgMah ?? null,
        baselineDsgMah: bmsBaselines.get(cacheKey)?.dsgMah ?? null,
        accuChgMah: null,
        accuDsgMah: null,
        chgWh: held.chgWh,
        dsgWh: held.dsgWh,
        heldFromLastKnown: true,
        backfilledFromHistory: backfilledThisCall.has(cacheKey),
      });
    }

    return { chargeWh, dischargeWh, packs, offlineHeldMembers };
  };

  const computeBmsBatteryTotals = (snap: FleetSnapshot): { chargeWh: number; dischargeWh: number } => {
    const { chargeWh, dischargeWh } = computeBmsBatteryDetail(snap, { mutate: true });
    return { chargeWh, dischargeWh };
  };

  // v0.9.74 — one-time reset for the SHP2-membership filter rollover.
  //
  // The previous code summed BMS counters across every DPU on the
  // EcoFlow account, including spare cores. Now we filter to SHP2-
  // connected only, which means the live `bms.chargeWh` value drops
  // ~67% (in the operator's 3-of-5-connected setup). Without a reset, the
  // persisted floor (from the 5-DPU sum) stays pinned and the HA
  // Energy Dashboard battery counters never advance again.
  //
  // We also reset the watt-integrated PV and grid-import counters for
  // the same reason — their persisted base is overstated by the
  // spare cores' historical contributions. The marker file at
  // `${DATA_DIR}/.shp2-filter-v1.flag` ensures this resets exactly
  // once per install. HA's state_class: total_increasing treats the
  // resulting one-time drop as a meter reset; the next day's delta
  // (and every day thereafter) is correct.
  // dbPath = /data/ecoflow.db, dirname → /data (the persistent volume).
  const SHP2_FILTER_FLAG = resolve(dirname(dbPath), '.shp2-filter-v1.flag');
  if (!existsSync(SHP2_FILTER_FLAG)) {
    log('recorder: v0.9.74 first run — resetting fleet lifetime counters for SHP2-membership filter');
    for (const key of ['fleet_battery_charge_wh', 'fleet_battery_discharge_wh', 'fleet_pv_wh', 'fleet_grid_import_wh']) {
      writeLifetime(key, 0, Date.now());
    }
    try {
      mkdirSync(dirname(SHP2_FILTER_FLAG), { recursive: true });
      writeFileSync(SHP2_FILTER_FLAG, `reset at ${new Date().toISOString()}\n`, { mode: 0o644 });
    } catch (e: any) {
      log(`recorder: could not write reset marker ${SHP2_FILTER_FLAG}: ${e?.message ?? e} (next boot will reset again — non-fatal but noisy)`);
    }
  }

  // v0.13.0 — one-time re-zero to per-pack baselines.
  //
  // Before this, computeBmsBatteryTotals summed the ABSOLUTE accu* factory
  // registers. DPU packs ship with accuDsgMah > accuChgMah (bench cycling),
  // so the home discharge total permanently exceeded charge — the RTE clamp
  // below fired on every rollup (926× in the 7-day audit) and pinned HA's
  // discharge tile. Re-zeroing math now lives in packDeltaWh; this block
  // performs the install-time capture exactly once, gated by a marker file
  // like the v0.9.74 one above so it never re-runs.
  //
  // We (a) capture each currently-visible pack's baseline from the live
  // snapshot and (b) reset the surfaced fleet battery counters to 0 so the
  // freshly-zeroed deltas drive them from here on. HA treats the one-time
  // drop as a meter reset (state_class: total_increasing); every subsequent
  // day's delta is correct. Packs not visible right now capture their
  // baseline lazily on first sight (see computeBmsBatteryTotals).
  const BMS_BASELINE_FLAG = resolve(dirname(dbPath), '.bms-baseline-v1.flag');
  if (!existsSync(BMS_BASELINE_FLAG)) {
    log('recorder: v0.13.0 first run — capturing per-pack BMS baselines and re-zeroing fleet battery counters');
    try {
      const snap = store.get();
      for (const d of Object.values(snap.devices)) {
        if (d.projection?.kind !== 'dpu') continue;
        for (const pk of (d.projection as DpuProjection).packs) {
          if (pk.accuChgMah == null && pk.accuDsgMah == null) continue;
          if (loadPackBaseline(d.sn, pk.num)) continue; // already captured
          savePackBaseline(d.sn, pk.num, { chgMah: pk.accuChgMah ?? 0, dsgMah: pk.accuDsgMah ?? 0 });
        }
      }
    } catch (e: any) {
      log(`recorder: v0.13.0 baseline capture deferred (snapshot not ready: ${e?.message ?? e}) — packs baseline lazily on first sight`);
    }
    for (const key of ['fleet_battery_charge_wh', 'fleet_battery_discharge_wh']) {
      writeLifetime(key, 0, Date.now());
    }
    try {
      mkdirSync(dirname(BMS_BASELINE_FLAG), { recursive: true });
      writeFileSync(BMS_BASELINE_FLAG, `baselined at ${new Date().toISOString()}\n`, { mode: 0o644 });
    } catch (e: any) {
      log(`recorder: could not write baseline marker ${BMS_BASELINE_FLAG}: ${e?.message ?? e} (next boot will re-capture — non-fatal but noisy)`);
    }
  }

  // Track the highest BMS lifetime ever observed across this process so a
  // momentary readback dropout (BMS returns 0 / null mid-poll) doesn't
  // appear as a "battery emptied" event to HA's Energy Dashboard.
  let bmsChargeFloor = 0;
  let bmsDischargeFloor = 0;
  // v0.45.0 — deficit-transition latch (formerly the clamp latch). The clamp is
  // gone; this now only rate-limits the INFORMATIONAL "discharge exceeds charge"
  // log in rollupLifetime to one line per transition into the (expected) deficit
  // state. Starts false so the first deficit, if any, logs once.
  let bmsClampActive = false;
  // Seed the floors from whatever was last persisted (a fresh process must
  // not regress the persisted Wh number; HA reads that with state_class:
  // total_increasing and would treat a step-down as a reset).
  {
    const seedC = readLifetime('fleet_battery_charge_wh');
    const seedD = readLifetime('fleet_battery_discharge_wh');
    bmsChargeFloor = seedC.wh;
    bmsDischargeFloor = seedD.wh;
  }

  /**
   * Roll up watt-based lifetime metrics from the samples table. Each metric
   * accumulates integrate(samples, watermark, now); battery counters come
   * from the BMS. Designed to be cheap enough to run every minute, but the
   * default cadence is 5 min.
   */
  const rollupLifetime = () => {
    const now = Date.now();
    const snap = store.get();
    const contributors = buildContributors(snap);

    // Watt-integrated metrics — fleet + per-circuit keys.
    const wattKeys = Object.keys(contributors); // fleet_pv/load/grid + circuit_<N>
    for (const key of wattKeys) {
      const prev = readLifetime(key);
      // On first run (ts === 0) start the watermark 60 s back so we don't try
      // to integrate the whole history (which would be huge and rotational).
      const since = prev.ts === 0 ? Math.max(now - 60_000, 0) : prev.ts;
      if (since >= now) continue;
      let addedWh = 0;
      for (const c of contributors[key] ?? []) {
        const pts = queryStmt.all(c.sn, c.metric, since, now) as Array<{ ts: number; value: number }>;
        const r = integrateWh(pts, since, now);
        addedWh += r.wh;
      }
      // Negative values are physically impossible for the metrics we track
      // (PV / load / grid-in / circuits); clamp to zero so a transient sign
      // flip from a bad sample can't decrement the lifetime counter.
      if (addedWh < 0) addedWh = 0;
      writeLifetime(key, prev.wh + addedWh, now);
    }

    // BMS-sourced battery counters — store max(BMS, persistedFloor).
    const bms = computeBmsBatteryTotals(snap);
    if (bms.chargeWh > bmsChargeFloor) bmsChargeFloor = bms.chargeWh;
    if (bms.dischargeWh > bmsDischargeFloor) bmsDischargeFloor = bms.dischargeWh;
    // v0.45.0 — REMOVED the discharge≤charge clamp. accuChgMah/accuDsgMah are
    // COULOMB counters; over an OPEN window (v0.13.0 baseline → now) that ends
    // at a LOWER SoC than baseline (the pool sits at ~30% now), cumulative
    // discharge LEGITIMATELY exceeds cumulative charge. HA never requires in≥out
    // — it ingests fleet_battery_charge_wh and fleet_battery_discharge_wh as two
    // INDEPENDENT total_increasing sensors. The clamp protected no RTE sensor
    // (RTE = analytics.computeRoundTripEfficiency, windowed, with its own ≤100%
    // clamp). The old clamp pinned discharge to charge, freezing the true (~+45
    // kWh higher) battery-out total. We now emit both monotone floors UNCLAMPED.
    // The discharge floor steps up to its true value on the first post-deploy
    // rollup — a one-time, intended, honest correction to HA's battery-out tile.
    //
    // Informational (NOT a clamp): if discharge exceeds charge by a wide margin
    // log it ONCE per transition into the deficit state, worded as the EXPECTED
    // open-window deficit. bmsClampActive is reused purely as the transition
    // latch to keep this to one line, not a per-rollup spew.
    const deficitWh = bmsDischargeFloor - bmsChargeFloor;
    const inDeficit = deficitWh > 1000;
    if (inDeficit && !bmsClampActive) {
      log(`recorder: v0.45.0 lifetime battery discharge exceeds charge by ${deficitWh.toFixed(0)} Wh — EXPECTED for an open accumulation window ending below the baseline SoC (NOT a fault, NOT clamped; the two HA total_increasing sensors are independent)`);
    } else if (!inDeficit && bmsClampActive) {
      log(`recorder: v0.45.0 lifetime battery discharge no longer exceeds charge by >1000 Wh (charge=${bmsChargeFloor.toFixed(0)} discharge=${bmsDischargeFloor.toFixed(0)} Wh)`);
    }
    bmsClampActive = inDeficit;
    writeLifetime('fleet_battery_charge_wh', bmsChargeFloor, now);
    writeLifetime('fleet_battery_discharge_wh', bmsDischargeFloor, now);
  };

  // Roll up every 5 min — fast enough that HA sees fresh totals each poll,
  // cheap enough that the integration query is bounded to one 5-min window.
  const LIFETIME_ROLLUP_INTERVAL_MS = 5 * 60 * 1000;
  const lifetimeTimer = setInterval(() => {
    try { rollupLifetime(); }
    catch (e: any) { log(`recorder: lifetime rollup failed ${e?.message ?? e}`); }
  }, LIFETIME_ROLLUP_INTERVAL_MS);
  lifetimeTimer.unref();
  // First rollup ~30 s after boot so the snapshot store has populated.
  setTimeout(() => {
    try { rollupLifetime(); }
    catch (e: any) { log(`recorder: lifetime initial rollup failed ${e?.message ?? e}`); }
  }, 30_000).unref();

  // v0.15.14 — last emitted total per key, for the jitter clamp below.
  const lifetimeEmitHighWater = new Map<string, number>();

  /** Snapshot of every counter (fleet + per-circuit), including live integral past the watermark. */
  const getLifetimeTotals = (): Record<string, LifetimeTotals> => {
    const now = Date.now();
    const snap = store.get();
    const contributors = buildContributors(snap);
    const out: Record<string, LifetimeTotals> = {};
    const allKeys = allLifetimeKeys(snap);
    for (const key of allKeys) {
      const prev = readLifetime(key);
      const watermark = prev.ts === 0 ? now : prev.ts;
      let pendingWh = 0;
      if (key === 'fleet_battery_charge_wh' || key === 'fleet_battery_discharge_wh') {
        // v0.45.0 — each battery counter emits persistedWh + max(0, liveBmsWh −
        // persisted), UNCLAMPED. The persisted value reflects the most-recent
        // rollup; the current snapshot (with offline-held carry) may read a hair
        // higher, so we add the live remainder. out > in is PHYSICAL for a
        // net-discharged window (coulomb counters over an open window ending
        // below baseline SoC) — the discharge counter is NOT pinned to charge.
        const bms = computeBmsBatteryTotals(snap);
        const liveBmsWh = key === 'fleet_battery_charge_wh' ? bms.chargeWh : bms.dischargeWh;
        const persisted = prev.wh;
        pendingWh = Math.max(0, liveBmsWh - persisted);
      } else if (watermark < now) {
        for (const c of contributors[key] ?? []) {
          const pts = queryStmt.all(c.sn, c.metric, watermark, now) as Array<{ ts: number; value: number }>;
          pendingWh += integrateWh(pts, watermark, now).wh;
        }
        if (pendingWh < 0) pendingWh = 0;
      }
      // v0.15.14 — micro-dip clamp. The live `pendingWh` trapezoid estimate is
      // re-derived each call, so consecutive totals can dip by a few Wh (e.g.
      // a rollup persisting slightly less than the previous live estimate).
      // HA's `total_increasing` sensors read any decrease as a meter RESET, so
      // 1-6 Wh of jitter produced phantom Energy-Dashboard resets ("state is
      // not strictly increasing", 21× in the HA core log). Hold the previous
      // total across small dips; a LARGE drop is a genuine operator reset
      // (v0.13.0 re-zero) and must pass through unclamped.
      pendingWh = clampLifetimeDip(
        lifetimeEmitHighWater.get(key),
        prev.wh,
        pendingWh,
      );
      lifetimeEmitHighWater.set(key, prev.wh + pendingWh);
      out[key] = { persistedWh: prev.wh, pendingWh, watermarkMs: watermark };
    }
    // v0.45.0 — REMOVED the emit-path discharge≤charge clamp. The two battery
    // counters are surfaced independently (each = persistedWh + max(0, liveBmsWh
    // − persisted)); out > in is physical for a net-discharged window and HA
    // ingests them as two independent total_increasing sensors. The per-key
    // micro-dip clamp (clampLifetimeDip) and per-key lifetimeEmitHighWater above
    // are correct and retained — they protect each counter's own monotonicity
    // without coupling discharge to charge.
    return out;
  };

  /**
   * v0.45.0 — read-only diagnostics for the lifetime battery counters. Mirrors
   * the math getLifetimeTotals uses for the two battery keys but writes NOTHING:
   * computeBmsBatteryDetail({ mutate:false }) skips savePackBaseline /
   * savePackLastWh and the corrupt-read warn, and we read the persisted floors
   * via readLifetime without ever calling writeLifetime. The lifetime_totals
   * table is byte/row-identical before and after this call.
   */
  const batteryLifetimeDebug = (): BatteryLifetimeDebug => {
    const snap = store.get();
    const detail = computeBmsBatteryDetail(snap, { mutate: false });
    const chargePersisted = readLifetime('fleet_battery_charge_wh').wh;
    const dischargePersisted = readLifetime('fleet_battery_discharge_wh').wh;
    // Emitted = persisted + max(0, liveBms − persisted), matching getLifetimeTotals.
    const chargePending = Math.max(0, detail.chargeWh - chargePersisted);
    const dischargePending = Math.max(0, detail.dischargeWh - dischargePersisted);
    // Raw unclamped floors: the in-memory floors advanced by rollups, lifted to
    // the live reading if the snapshot currently reads higher (never persisted here).
    const rawChargeFloorWh = Math.max(bmsChargeFloor, detail.chargeWh);
    const rawDischargeFloorWh = Math.max(bmsDischargeFloor, detail.dischargeWh);
    return {
      rawChargeFloorWh,
      rawDischargeFloorWh,
      emittedChargeWh: chargePersisted + chargePending,
      emittedDischargeWh: dischargePersisted + dischargePending,
      charge: { persistedWh: chargePersisted, pendingWh: chargePending },
      discharge: { persistedWh: dischargePersisted, pendingWh: dischargePending },
      deficitWh: Math.max(0, rawDischargeFloorWh - rawChargeFloorWh),
      packs: detail.packs,
      offlineHeldMembers: detail.offlineHeldMembers,
    };
  };

  // ─── Weather irradiance persistence (v0.13.1) ───────────────────────────
  // Durable backfill of hourly GHI + cloud cover under SN "weather". Unlike
  // the device samples (which are stamped with Date.now() and deduped by a
  // wall-clock interval), each weather row is stamped with the FORECAST
  // HOUR's own epoch so the series lines up with the device history it's
  // correlated against. Idempotency + change-detection are therefore keyed
  // on (sn, metric, ts): we skip a write when a row already exists at that
  // hour, and skip an unchanged value relative to the previous stored hour
  // (so a flat-irradiance night collapses to ~1 row, ~24 rows/day overall).
  const weatherExistsStmt = db.prepare(
    `SELECT 1 FROM samples WHERE sn = ? AND metric = ? AND ts = ? LIMIT 1`,
  );
  const weatherPrevStmt = db.prepare(
    `SELECT value FROM samples WHERE sn = ? AND metric = ? AND ts < ? ORDER BY ts DESC LIMIT 1`,
  );
  const recordWeatherGhi = (
    hours: Array<{ epochMs: number; radiationWm2: number | null; cloudCoverPct: number | null }>,
  ) => {
    if (!hours || hours.length === 0) return;
    // Write chronologically so the "previous stored value" change-detection
    // sees the just-written earlier hour within the same batch.
    const sorted = [...hours].sort((a, b) => a.epochMs - b.epochMs);
    const tx = db.prepare('BEGIN');
    tx.run();
    let written = 0;
    try {
      for (const h of sorted) {
        if (!Number.isFinite(h.epochMs)) continue;
        // Snap to the top of the hour so re-fetches that report the same hour
        // with a different sub-hour offset still dedupe to one row.
        const ts = Math.floor(h.epochMs / 3_600_000) * 3_600_000;
        const pairs: Array<[string, number | null]> = [
          [WEATHER_GHI_METRIC, h.radiationWm2],
          [WEATHER_CLOUD_METRIC, h.cloudCoverPct],
        ];
        for (const [metric, value] of pairs) {
          if (value == null || !Number.isFinite(value)) continue;
          // Idempotent: a row already at this exact hour is a no-op.
          if (weatherExistsStmt.get(WEATHER_SN, metric, ts)) continue;
          // Change-detection: skip if the most-recent earlier hour already
          // holds this value (within epsilon) — flat stretches collapse.
          const prev = weatherPrevStmt.get(WEATHER_SN, metric, ts) as { value: number } | undefined;
          if (prev && Math.abs(value - prev.value) < VALUE_EPSILON) continue;
          insert.run(ts, WEATHER_SN, metric, value);
          written++;
        }
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    if (written > 0) log(`recorder: v0.13.1 persisted ${written} weather GHI/cloud rows`);
  };

  return {
    insertSnapshot: (snap) => record(extract(snap)),
    query: (sn, metric, sinceMs, untilMs, bucketSec) => {
      if (!bucketSec || bucketSec <= 0) {
        return queryStmt.all(sn, metric, sinceMs, untilMs) as Array<{ ts: number; value: number }>;
      }
      // v0.9.14 — bucketing happens in SQLite now (see queryBucketedStmt).
      // The returned `bucket_ts` is already the canonical bucket-start ts; we
      // just rename it to `ts` to match the legacy interface.
      const bucketMs = bucketSec * 1000;
      const rows = queryBucketedStmt.all(bucketMs, bucketMs, sn, metric, sinceMs, untilMs) as Array<{ bucket_ts: number; value: number }>;
      return rows.map((r) => ({ ts: r.bucket_ts, value: r.value }));
    },
    queryMulti: (sn, metrics, sinceMs, untilMs, bucketSec) => {
      const out = new Map<string, Array<{ ts: number; value: number }>>();
      if (metrics.length === 0) return out;
      // Pre-seed empty arrays so callers can rely on `out.get(metric)` never
      // returning undefined for a known metric.
      for (const m of metrics) out.set(m, []);
      const bucketed = !!bucketSec && bucketSec > 0;
      const stmt = getQueryMultiStmt(metrics.length, bucketed);
      const rows = bucketed
        ? (stmt.all(bucketSec! * 1000, bucketSec! * 1000, sn, ...metrics, sinceMs, untilMs) as Array<{ metric: string; bucket_ts: number; value: number }>)
        : (stmt.all(sn, ...metrics, sinceMs, untilMs) as Array<{ metric: string; ts: number; value: number }>);
      for (const r of rows) {
        const arr = out.get(r.metric);
        if (!arr) continue; // metric not in requested list (shouldn't happen — defensive)
        arr.push({ ts: bucketed ? (r as any).bucket_ts : (r as any).ts, value: r.value });
      }
      return out;
    },
    listMetrics: (sn) => (metricsStmt.all(sn) as Array<{ metric: string }>).map((r) => r.metric),
    telemetryGaps: () => telemetryGapsLog.slice(),
    recordWeatherGhi,
    close: () => {
      clearInterval(lifetimeTimer);
      // Final rollup so we don't lose the trailing minute of energy on shutdown.
      try { rollupLifetime(); } catch { /* ignore on shutdown */ }
      db.close();
    },
    rollupLifetime,
    getLifetimeTotals,
    listLifetimeKeys,
    batteryLifetimeDebug,
  };
}
