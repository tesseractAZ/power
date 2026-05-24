import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { SnapshotStore, FleetSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection, GenericProjection } from './ecoflow/project.js';
import { integrateWh } from './aggregator.js';

interface MetricSample {
  sn: string;
  metric: string;
  value: number;
}

const MIN_INTERVAL_MS = 10_000;   // never record same metric more than once / 10s
const MAX_INTERVAL_MS = 300_000;  // heartbeat: record at least every 5 min even if unchanged
const VALUE_EPSILON = 0.5;        // ignore wiggle smaller than this (watts/percent)

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
export type LifetimeMetricKey =
  | 'fleet_pv_wh'
  | 'fleet_load_wh'
  | 'fleet_grid_import_wh'
  | 'fleet_battery_charge_wh'   // sourced from BMS lifetime counters
  | 'fleet_battery_discharge_wh';

export interface LifetimeTotals {
  /** Persisted accumulator (Wh). Increments forever. */
  persistedWh: number;
  /** Integral of the current window past the watermark (also Wh) — added to the live total. */
  pendingWh: number;
  /** Watermark — last ts up to which we've already accumulated. */
  watermarkMs: number;
}

export interface Recorder {
  insertSnapshot: (snap: FleetSnapshot) => void;
  query: (sn: string, metric: string, sinceMs: number, untilMs: number, bucketSec?: number) => Array<{ ts: number; value: number }>;
  listMetrics: (sn: string) => string[];
  close: () => void;
  /** Force a lifetime-rollup tick (used by tests / on shutdown). */
  rollupLifetime: () => void;
  /** Snapshot of every lifetime counter (fleet + per-circuit). Keys are the metric_key strings. */
  getLifetimeTotals: () => Record<string, LifetimeTotals>;
}

export function createRecorder(store: SnapshotStore, log: (m: string) => void): Recorder {
  const dbPath = resolve(process.cwd(), config.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  log(`recorder: opening ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
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

  function record(samples: MetricSample[]) {
    if (samples.length === 0) return;
    const now = Date.now();
    const tx = db.prepare('BEGIN');
    tx.run();
    let written = 0;
    try {
      for (const s of samples) {
        if (typeof s.value !== 'number' || !Number.isFinite(s.value)) continue;
        if (!shouldRecord(s.sn, s.metric, s.value, now)) continue;
        insert.run(now, s.sn, s.metric, s.value);
        last.set(`${s.sn}|${s.metric}`, { ts: now, value: s.value });
        written++;
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    if (written > 0) log(`recorder: wrote ${written} samples`);
  }

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
  const metricsStmt = db.prepare(`SELECT DISTINCT metric FROM samples WHERE sn = ? ORDER BY metric ASC`);

  // ─── Lifetime energy accumulator ────────────────────────────────────────
  const lifetimeReadStmt = db.prepare(
    `SELECT wh, last_integrated_ts FROM lifetime_totals WHERE metric_key = ?`,
  );
  const lifetimeUpsertStmt = db.prepare(
    `INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)
     ON CONFLICT(metric_key) DO UPDATE SET wh = excluded.wh, last_integrated_ts = excluded.last_integrated_ts`,
  );
  // Watt-integrated metrics: we sum these across all (sn,metric) pairs in
  // the current snapshot. Battery in/out comes from BMS counters directly
  // so it's NOT in this list (handled by computeBmsBatteryTotals).
  const LIFETIME_KEYS = [
    'fleet_pv_wh',
    'fleet_load_wh',
    'fleet_grid_import_wh',
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
        out.fleet_pv_wh.push({ sn: d.sn, metric: 'pv_total' });
        // AC-in only counts as "grid import" for DPUs that are wired into
        // SHP2's grid path. A spare DPU charging from a wall outlet is the
        // user's choice, not "grid pulled by the house".
        if (sourceSns.size === 0 || sourceSns.has(d.sn)) {
          out.fleet_grid_import_wh.push({ sn: d.sn, metric: 'ac_in' });
        }
      } else if (p.kind === 'shp2') {
        out.fleet_load_wh.push({ sn: d.sn, metric: 'panel_load' });
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
  const PACK_MAH_TO_WH = (51.2 * 2) / 1_000;   // 102.4 V × Ah = Wh; 1000 mAh = 1 Ah
  const computeBmsBatteryTotals = (snap: FleetSnapshot): { chargeWh: number; dischargeWh: number } => {
    let chargeWh = 0;
    let dischargeWh = 0;
    for (const d of Object.values(snap.devices)) {
      if (d.projection?.kind !== 'dpu') continue;
      for (const pk of (d.projection as DpuProjection).packs) {
        if (pk.accuChgMah != null) chargeWh += pk.accuChgMah * PACK_MAH_TO_WH;
        if (pk.accuDsgMah != null) dischargeWh += pk.accuDsgMah * PACK_MAH_TO_WH;
      }
    }
    return { chargeWh, dischargeWh };
  };

  // Track the highest BMS lifetime ever observed across this process so a
  // momentary readback dropout (BMS returns 0 / null mid-poll) doesn't
  // appear as a "battery emptied" event to HA's Energy Dashboard.
  let bmsChargeFloor = 0;
  let bmsDischargeFloor = 0;
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
        // BMS counters are already "live" — the persisted value reflects the
        // most-recent rollup, and the current snapshot may show a slightly
        // higher reading. Compare and use the max.
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
      out[key] = { persistedWh: prev.wh, pendingWh, watermarkMs: watermark };
    }
    return out;
  };

  return {
    insertSnapshot: (snap) => record(extract(snap)),
    query: (sn, metric, sinceMs, untilMs, bucketSec) => {
      const rows = queryStmt.all(sn, metric, sinceMs, untilMs) as Array<{ ts: number; value: number }>;
      if (!bucketSec || bucketSec <= 0) return rows;
      // Average per bucket
      const bucketMs = bucketSec * 1000;
      const out: Array<{ ts: number; value: number }> = [];
      let curBucket = -1;
      let sum = 0;
      let count = 0;
      for (const r of rows) {
        const b = Math.floor(r.ts / bucketMs) * bucketMs;
        if (b !== curBucket) {
          if (count > 0) out.push({ ts: curBucket, value: sum / count });
          curBucket = b;
          sum = 0;
          count = 0;
        }
        sum += r.value;
        count++;
      }
      if (count > 0) out.push({ ts: curBucket, value: sum / count });
      return out;
    },
    listMetrics: (sn) => (metricsStmt.all(sn) as Array<{ metric: string }>).map((r) => r.metric),
    close: () => {
      clearInterval(lifetimeTimer);
      // Final rollup so we don't lose the trailing minute of energy on shutdown.
      try { rollupLifetime(); } catch { /* ignore on shutdown */ }
      db.close();
    },
    rollupLifetime,
    getLifetimeTotals,
  };
}
