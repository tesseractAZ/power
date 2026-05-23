import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { SnapshotStore, FleetSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection, GenericProjection } from './ecoflow/project.js';

interface MetricSample {
  sn: string;
  metric: string;
  value: number;
}

const MIN_INTERVAL_MS = 10_000;   // never record same metric more than once / 10s
const MAX_INTERVAL_MS = 300_000;  // heartbeat: record at least every 5 min even if unchanged
const VALUE_EPSILON = 0.5;        // ignore wiggle smaller than this (watts/percent)

export interface Recorder {
  insertSnapshot: (snap: FleetSnapshot) => void;
  query: (sn: string, metric: string, sinceMs: number, untilMs: number, bucketSec?: number) => Array<{ ts: number; value: number }>;
  listMetrics: (sn: string) => string[];
  close: () => void;
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
    close: () => db.close(),
  };
}
