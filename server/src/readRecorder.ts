import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { Recorder, LifetimeTotals } from './recorder.js';

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
  const dbPath = resolve(process.cwd(), dbPathInput ?? process.env.DB_PATH ?? '/data/ecoflow.db');
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
  // so report persistedWh and let pendingWh be 0.
  // Prepared lazily: on a brand-new DB the writer hasn't created the table
  // yet, and an eager prepare() would throw at construction.
  let lifetimeStmt: ReturnType<typeof db.prepare> | null = null;
  const getLifetimeTotals = (): Record<string, LifetimeTotals> => {
    const out: Record<string, LifetimeTotals> = {};
    try {
      lifetimeStmt ??= db.prepare(`SELECT metric_key, wh, last_integrated_ts FROM lifetime_totals`);
      const rows = lifetimeStmt.all() as Array<{ metric_key: string; wh: number; last_integrated_ts: number }>;
      for (const r of rows) {
        out[r.metric_key] = { persistedWh: r.wh, pendingWh: 0, watermarkMs: r.last_integrated_ts };
      }
    } catch {
      // Table absent before the writer's first rollup — same observable
      // behavior as the historical stub (empty totals).
    }
    return out;
  };

  return {
    // ── write path: stubbed (worker never writes) ──
    insertSnapshot: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals,
    recordWeatherGhi: () => {}, // v0.13.1 — write path; the read-only worker never writes
    // ── read path: real ──
    query: (sn, metric, sinceMs, untilMs, bucketSec) => {
      if (!bucketSec || bucketSec <= 0) {
        return queryStmt.all(sn, metric, sinceMs, untilMs) as Array<{ ts: number; value: number }>;
      }
      const bucketMs = bucketSec * 1000;
      const rows = queryBucketedStmt.all(bucketMs, bucketMs, sn, metric, sinceMs, untilMs) as Array<{ bucket_ts: number; value: number }>;
      return rows.map((r) => ({ ts: r.bucket_ts, value: r.value }));
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
    close: () => db.close(),
  };
}
