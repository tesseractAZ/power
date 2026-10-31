import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { Recorder, LifetimeTotals, NightLedgerRow, NightCalibration } from './recorder.js';
// v1.38.0 (WS2) — site calendar-date resolution for the ledger read cutoff (v1.191.0, T7: the same
// siteYmd the writer's reader uses, so the two copies cannot disagree about the zone).
import { siteYmd } from './siteTime.js';
// v1.188.1 (review) — the samples generation reader (no schema, no writes: a SELECT on its table).
import { samplesGenerationReader } from './heldSamples.js';
import {
  bridgeFleetFlow, bridgeSite, emptyBridgeDebug, BRIDGE_LEDGER_SELECT_SQL, bridgeLedgerRowOf, BRIDGE_CHARGE_KEY,
  type BridgeLedger, type BridgeLedgerSqlRow,
} from './energyBridge.js';
import { config } from './config.js';

/**
 * v0.10.0 — read-only Recorder for the analytics worker thread.
 *
 * The main thread owns the single WRITE connection (ingestion + lifetime
 * rollup, see recorder.ts). The analytics worker opens its OWN connection
 * to the same WAL database and only ever runs SELECTs — so the heavy
 * multi-second history scans that drive the cache-warmer and /api/* reports
 * execute on the worker's event loop, never the main one.
 *
 * SQLite WAL allows one writer + many concurrent readers across connections,
 * so this second connection sees the writer's committed rows with no locking
 * on the read path.
 *
 * The query / queryMulti / listMetrics implementations below are a faithful
 * copy of recorder.ts's read path (same SQL, same bucketing). recorder.ts
 * remains the source of truth; test/readRecorder.test.ts asserts byte-for-byte
 * parity between the two so they can't silently drift. The Recorder write
 * methods are stubbed (no-ops / empty) — reports.ts only ever calls reads, and
 * the stubs keep this a drop-in `Recorder` for the analytics function
 * signatures without widening every one of them to a read-only interface.
 */
export function createReadRecorder(dbPathInput?: string): Recorder {
  // v1.191.0 (S3c, lane A) — the DB path default is config.ts's (DB_PATH, else /data/ecoflow.db inside the
  // add-on). The analytics worker always passes the main thread's path; the fallback only matters to a
  // caller that passes none.
  const dbPath = resolve(process.cwd(), dbPathInput ?? config.dbPath);
  // Read-write capable handle (NOT readOnly: a readonly connection can't
  // create the WAL -shm shared-memory file, which breaks reads on a
  // WAL database that no writer has opened yet). We simply never write.
  const db = new DatabaseSync(dbPath);
  // Read-oriented pragmas mirroring recorder.ts. journal_mode is a property
  // of the database file (already WAL from the writer) — we don't set it here.
  db.exec(`
    PRAGMA cache_size = -32768;
    PRAGMA mmap_size = 268435456;
    PRAGMA temp_store = MEMORY;
    PRAGMA query_only = ON;
  `);

  const queryStmt = db.prepare(
    `SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`,
  );
  // v1.19.0 (F17 perf) — window-edge seeks (see recorder.ts twin).
  const queryFirstStmt = db.prepare(
    `SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1`,
  );
  const queryLastStmt = db.prepare(
    `SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
  );
  const queryBucketedStmt = db.prepare(
    `SELECT CAST((ts / ?) AS INTEGER) * ? AS bucket_ts, AVG(value) AS value
       FROM samples
      WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ?
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC`,
  );
  const metricsStmt = db.prepare(`SELECT DISTINCT metric FROM samples WHERE sn = ? ORDER BY metric ASC`);

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

  // v0.15.12 — real lifetime totals from the persisted accumulator table.
  // This was a `{}` stub, which silently zeroed every lifetime-derived value
  // computed on the worker (carbon_lifetime_kg_avoided / miles_not_driven
  // published 0 while pv_lifetime_kwh in the same payload showed 889 kWh).
  // The worker can't reproduce the main thread's live `pendingWh` integral
  // (it has no snapshot store), but the persisted watermark lags by at most
  // one rollup interval — negligible against a forever-accumulating total —
  // so report persistedWh and let pendingWh be 0. (v1.188.1 — up to
  // HELD_ENERGY_BRIDGE_MAX_MS while the recorder waits out a held panel's gap.)
  // Prepared lazily: on a brand-new DB the writer hasn't created the table
  // yet, and an eager prepare() would throw at construction.
  let lifetimeStmt: ReturnType<typeof db.prepare> | null = null;
  let basisStmt: ReturnType<typeof db.prepare> | null = null;
  const getLifetimeTotals = (): Record<string, LifetimeTotals> => {
    const out: Record<string, LifetimeTotals> = {};
    // v1.193.0 — each counter's basis shift (lifetime_basis), as the writer publishes it. Read on its
    // own: a database the writer has not yet migrated has no such table, and the rows still count.
    const shifts = new Map<string, number>();
    try {
      basisStmt ??= db.prepare(`SELECT metric_key, shift_wh FROM lifetime_basis`);
      for (const r of basisStmt.all() as Array<{ metric_key: string; shift_wh: number }>) {
        if (Number.isFinite(r.shift_wh)) shifts.set(r.metric_key, r.shift_wh);
      }
    } catch { /* no table yet: no shifts */ }
    try {
      lifetimeStmt ??= db.prepare(`SELECT metric_key, wh, last_integrated_ts FROM lifetime_totals`);
      const rows = lifetimeStmt.all() as Array<{ metric_key: string; wh: number; last_integrated_ts: number }>;
      for (const r of rows) {
        const shiftWh = shifts.get(r.metric_key) ?? 0;
        out[r.metric_key] = { persistedWh: r.wh + shiftWh, pendingWh: 0, watermarkMs: r.last_integrated_ts, shiftWh };
      }
    } catch {
      // Table absent before the writer's first rollup — same observable
      // behavior as the historical stub (empty totals).
    }
    return out;
  };
  // v0.40.3 — persisted lifetime keys, snapshot-independent (see Recorder.listLifetimeKeys).
  let lifetimeKeysStmt: ReturnType<typeof db.prepare> | null = null;
  const listLifetimeKeys = (): string[] => {
    try {
      lifetimeKeysStmt ??= db.prepare(`SELECT metric_key FROM lifetime_totals`);
      return (lifetimeKeysStmt.all() as Array<{ metric_key: string }>).map((r) => r.metric_key);
    } catch {
      return [];
    }
  };

  // v1.38.0 (WS2) — night-charge ledger reads over the SAME read connection.
  // Prepared lazily + wrapped in try/catch: on a brand-new DB the writer may not
  // have created the tables yet, and an eager prepare() would throw at
  // construction (mirrors getLifetimeTotals). Fail-safe to empty/null.
  let nightLedgerStmt: ReturnType<typeof db.prepare> | null = null;
  const readNightLedger = (sinceDays: number): NightLedgerRow[] => {
    try {
      nightLedgerStmt ??= db.prepare(
        `SELECT * FROM night_charge_ledger WHERE plan_date >= ? ORDER BY plan_date ASC`,
      );
      const cutoffMs = Date.now() - Math.max(0, sinceDays) * 86_400_000;
      const cutoff = siteYmd(cutoffMs);
      return nightLedgerStmt.all(cutoff) as unknown as NightLedgerRow[];
    } catch {
      return [];
    }
  };
  // v1.190.2 — the energy bridge's windows (the Today card's totals), the recorder's own read
  // (BRIDGE_LEDGER_SELECT_SQL). Lazy and fail-safe like the reads above: before the writer has
  // created the table, none.
  let bridgeLedgerStmt: ReturnType<typeof db.prepare> | null = null;
  let bridgeWatermarkStmt: ReturnType<typeof db.prepare> | null = null;
  const bridgeLedger = (sinceMs: number, untilMs: number): BridgeLedger => {
    try {
      bridgeLedgerStmt ??= db.prepare(BRIDGE_LEDGER_SELECT_SQL);
      bridgeWatermarkStmt ??= db.prepare(`SELECT last_integrated_ts FROM lifetime_totals WHERE metric_key = ?`);
      const rows = (bridgeLedgerStmt.all(sinceMs, untilMs) as unknown as BridgeLedgerSqlRow[]).map(bridgeLedgerRowOf);
      const wm = bridgeWatermarkStmt.get(BRIDGE_CHARGE_KEY) as { last_integrated_ts: number } | undefined;
      return { rows, watermarkMs: wm?.last_integrated_ts ?? 0 };
    } catch {
      return { rows: [], watermarkMs: 0 };
    }
  };
  let nightCalStmt: ReturnType<typeof db.prepare> | null = null;
  const readNightCalibration = (): NightCalibration | null => {
    try {
      nightCalStmt ??= db.prepare(`SELECT * FROM night_charge_calibration WHERE id = 1`);
      return (nightCalStmt.get() as NightCalibration | undefined) ?? null;
    } catch {
      return null;
    }
  };

  return {
    // ── write path: stubbed (worker never writes) ──
    insertSnapshot: () => {},
    rollupLifetime: () => {},
    // v1.31.0 — the forecast archive is written by the MAIN process's GHI
    // persistence tick; a worker-side call would be a wiring bug, so no-op.
    recordForecastArchive: () => {},
    // v1.38.0 (WS2) — night-charge ledger/calibration writes happen on the MAIN
    // process's evening job; a worker-side call would be a wiring bug, so no-op
    // (matches the recordForecastArchive stub precedent).
    recordNightPlan: () => {},
    recordNightOutcome: () => {},
    upsertNightCalibration: () => {},
    getLifetimeTotals,
    listLifetimeKeys,
    // v0.45.0 — battery-lifetime diagnostics live on the write-path recorder
    // (they need the snapshot store the worker doesn't have). /api/debug/battery-lifetime
    // uses the main recorder; this stub keeps the worker a drop-in `Recorder`.
    batteryLifetimeDebug: () => ({
      rawChargeFloorWh: 0,
      rawDischargeFloorWh: 0,
      emittedChargeWh: 0,
      emittedDischargeWh: 0,
      charge: { persistedWh: 0, pendingWh: 0 },
      discharge: { persistedWh: 0, pendingWh: 0 },
      deficitWh: 0,
      packs: [],
      offlineHeldMembers: [],
      bridge: emptyBridgeDebug(),
    }),
    // v1.188.1 — the worker never publishes the power sensors; its bridge holds no field verdicts
    // (the write-path recorder does), so it reads a daylight PV field unchecked, 0 at night.
    bridgedFleetFlow: (online, devices, nowMs) => bridgeFleetFlow(online, devices, nowMs, () => false, bridgeSite(config)),
    recordWeatherGhi: () => {}, // v0.13.1 — write path; the read-only worker never writes
    telemetryGaps: () => [],    // v0.30.0 — gaps are detected on the write path; /api/telemetry-gaps uses the main recorder
    // ── read path: real ──
    query: (sn, metric, sinceMs, untilMs, bucketSec) => {
      if (!bucketSec || bucketSec <= 0) {
        return queryStmt.all(sn, metric, sinceMs, untilMs) as Array<{ ts: number; value: number }>;
      }
      const bucketMs = bucketSec * 1000;
      const rows = queryBucketedStmt.all(bucketMs, bucketMs, sn, metric, sinceMs, untilMs) as Array<{ bucket_ts: number; value: number }>;
      return rows.map((r) => ({ ts: r.bucket_ts, value: r.value }));
    },
    queryFirstLast: (sn, metric, sinceMs, untilMs) => {
      const first = queryFirstStmt.get(sn, metric, sinceMs, untilMs) as { ts: number; value: number } | undefined;
      if (!first) return [];
      const last = queryLastStmt.get(sn, metric, sinceMs, untilMs) as { ts: number; value: number } | undefined;
      return last && last.ts !== first.ts ? [first, last] : [first];
    },
    queryMulti: (sn, metrics, sinceMs, untilMs, bucketSec) => {
      const out = new Map<string, Array<{ ts: number; value: number }>>();
      if (metrics.length === 0) return out;
      for (const m of metrics) out.set(m, []);
      const bucketed = !!bucketSec && bucketSec > 0;
      const stmt = getQueryMultiStmt(metrics.length, bucketed);
      const rows = bucketed
        ? (stmt.all(bucketSec! * 1000, bucketSec! * 1000, sn, ...metrics, sinceMs, untilMs) as Array<{ metric: string; bucket_ts: number; value: number }>)
        : (stmt.all(sn, ...metrics, sinceMs, untilMs) as Array<{ metric: string; ts: number; value: number }>);
      for (const r of rows) {
        const arr = out.get(r.metric);
        if (!arr) continue;
        arr.push({ ts: bucketed ? (r as any).bucket_ts : (r as any).ts, value: r.value });
      }
      return out;
    },
    listMetrics: (sn) => (metricsStmt.all(sn) as Array<{ metric: string }>).map((r) => r.metric),
    // v1.38.0 (WS2) — real ledger reads (the worker/reports path reduces over these).
    readNightLedger,
    readNightCalibration,
    bridgeLedger,
    // v1.188.1 (review) — the samples generation the main thread's held-sample moves advance: the
    // worker's report chokepoint resets its closed-day memos when it moves (reports.ts).
    samplesGeneration: samplesGenerationReader(db),
    close: () => db.close(),
  };
}
