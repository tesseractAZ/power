import { Worker } from 'node:worker_threads';
import type { FleetSnapshot } from './snapshot.js';
import type { ReportArgs } from './reports.js';

/**
 * v0.10.0 — main-thread proxy to the analytics worker.
 *
 * Spawns analyticsWorker.ts, correlates request/response by id, times out
 * stuck requests, and respawns the worker if it ever exits — re-pushing the
 * latest snapshot so reports keep working. Snapshot pushes are throttled
 * (the store emits a 'change' on every MQTT message; the worker only needs a
 * recent snapshot for mostly-historical analytics).
 */

export interface AnalyticsClient {
  report<T = any>(name: string, args?: ReportArgs): Promise<T>;
  query(
    sn: string,
    metric: string,
    sinceMs: number,
    untilMs: number,
    bucketSec?: number,
  ): Promise<Array<{ ts: number; value: number }>>;
  listMetrics(sn: string): Promise<string[]>;
  /** Hand the worker the latest snapshot (throttled internally). */
  pushSnapshot(snap: FleetSnapshot): void;
  stop(): void;
}

const REQUEST_TIMEOUT_MS = 30_000;
const SNAPSHOT_PUSH_MS = 750;
const RESPAWN_DELAY_MS = 1_000;

// v0.90.0 — main-thread coalesce + short TTL cache for report() results. A
// dashboard poll fans out ~9 concurrent report() calls (/api/ha-state,
// mqttDiscovery.buildState, alertMonitor, featureSnapshot) that ALL funnel through
// the single worker's serial message loop; a batch queued behind a slow scan
// serialises. Coalescing collapses concurrent identical calls into ONE worker
// round-trip, and a short TTL serves a repeat within the window from a structured
// clone instead of re-queueing. report() ONLY: query()/listMetrics() have
// effectively-unbounded args (untilMs≈now) → no hit rate + unbounded key growth, and
// /api/history already HTTP-caches. TTL is deliberately short — every heavy report
// already carries a 5–30 min internal TTL cache inside the worker and the alarm
// engine (alertMonitor, 20 s eval) tolerates that, so a few seconds on the main
// thread is strictly fresher than today and changes no alarm timing.
const REPORT_CACHE_DEFAULT_TTL_MS = Number(process.env.ANALYTICS_REPORT_TTL_MS ?? 20_000);
export const REPORT_CACHE_TTL_OVERRIDES_MS: Record<string, number> = {
  // Alarm-path + fast-moving reads: tiny TTL so coalescing does the heavy lifting
  // and any TTL staleness stays well under one 20 s alert-eval interval.
  forecast: 5_000,
  runway: 5_000,
  curtailmentAlerts: 3_000,
  baselineAlerts: 3_000,
  forecastAlerts: 3_000,
  // Parameterised / on-demand reports vary by args → coalesce only (TTL 0), never
  // TTL-cache (avoids unbounded key growth); they are HTTP-cached at the endpoint.
  circuitHistory: 0,
  totals: 0,
  backtest: 0,
};
export const reportTtlMs = (name: string): number =>
  name in REPORT_CACHE_TTL_OVERRIDES_MS ? REPORT_CACHE_TTL_OVERRIDES_MS[name] : REPORT_CACHE_DEFAULT_TTL_MS;

// Stable cache key: name + canonicalised args (sorted keys; numeric args truncated
// so fractional {days:7.1} can't grow the Map unbounded within a TTL window).
export const reportKey = (name: string, args: ReportArgs): string => {
  const keys = Object.keys(args ?? {}).sort();
  if (keys.length === 0) return name;
  const canon: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (args as Record<string, unknown>)[k];
    canon[k] = typeof v === 'number' ? Math.trunc(v) : v;
  }
  return name + ' ' + JSON.stringify(canon);
};

// structuredClone (Node ≥17 global). CRITICAL: alertMonitor mutates `a.annunciate`
// on alert objects that are ELEMENTS of report results; today each consumer gets an
// independent copy across the worker postMessage boundary. Coalescing/caching would
// share those refs — so every returned hit is cloned to preserve that exact
// semantic. Report results already survive postMessage, so the catch is dead-code
// insurance, never a silent shared-ref re-exposure.
const cloneResult = <T>(v: T): T => {
  try { return structuredClone(v); } catch { return v; }
};

interface ReportCacheEntry { value: unknown; expiresAt: number; }

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function createAnalyticsClient(dbPath: string, log: (m: string) => void): AnalyticsClient {
  let worker: Worker;
  let stopped = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  // v0.90.0 — per-client report cache + in-flight coalescer.
  const reportCache = new Map<string, ReportCacheEntry>();
  const inflightReport = new Map<string, Promise<unknown>>();
  let lastSnapshot: FleetSnapshot | null = null;
  let dirty = false;

  // Spawn the .mjs bootstrap (loads natively), which registers tsx's loader
  // in the worker thread and then imports the real .ts worker. See
  // analyticsWorkerBootstrap.mjs — `execArgv: ['--import','tsx']` was not
  // enough on the container's tsx version.
  const workerUrl = new URL('./analyticsWorkerBootstrap.mjs', import.meta.url);

  const spawn = () => {
    worker = new Worker(workerUrl, { workerData: { dbPath } });
    worker.on('message', (msg: any) => {
      if (msg?.kind === 'log') { log(msg.message); return; }
      if (msg?.kind === 'ready') {
        if (lastSnapshot) { try { worker.postMessage({ kind: 'snapshot', snapshot: lastSnapshot }); } catch { /* */ } }
        return;
      }
      if (msg?.kind === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? 'analytics worker error'));
      }
    });
    worker.on('error', (e) => log(`analytics-worker: error ${e?.message ?? e}`));
    worker.on('exit', (code) => {
      // Fail in-flight requests so callers don't hang on a dead worker.
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('analytics worker exited')); }
      pending.clear();
      // v0.90.0 — drop cached values + in-flight coalesces computed against the DEAD
      // worker's snapshot. The respawned worker boots empty and re-receives
      // lastSnapshot on 'ready', so the first post-respawn report recomputes fresh.
      reportCache.clear();
      inflightReport.clear();
      if (stopped) return;
      log(`analytics-worker: exited (code ${code}) — respawning in ${RESPAWN_DELAY_MS}ms`);
      setTimeout(() => { if (!stopped) spawn(); }, RESPAWN_DELAY_MS);
    });
  };

  spawn();

  const request = <T>(payload: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`analytics request '${payload.kind}${payload.name ? ':' + payload.name : ''}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ ...payload, id });
      } catch (e: any) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

  // v0.15.18 — one retry on timeout. Every analytics 500 in the 50 h log
  // window fell inside ~2.5 min of a boot (cold worker, first heavy 7-day
  // scans), and a single retry rides out the warm-up instead of surfacing a
  // transient 500 to dashboards and internal feeds.
  const requestWithRetry = <T>(payload: Record<string, unknown>): Promise<T> =>
    request<T>(payload).catch((e: unknown) => {
      if (e instanceof Error && e.message.includes('timed out') && !stopped) {
        log(`analytics: '${String(payload.kind)}${payload.name ? ':' + String(payload.name) : ''}' timed out — retrying once`);
        return request<T>(payload);
      }
      throw e;
    });

  const pushTimer = setInterval(() => {
    if (!dirty || !lastSnapshot) return;
    dirty = false;
    try { worker.postMessage({ kind: 'snapshot', snapshot: lastSnapshot }); } catch { /* worker mid-respawn */ }
  }, SNAPSHOT_PUSH_MS);
  (pushTimer as any).unref?.();

  return {
    report: <T = any>(name: string, args?: ReportArgs): Promise<T> => {
      const a = args ?? {};
      const ttl = reportTtlMs(name);
      const key = reportKey(name, a);
      // 1) Fresh cache hit → a private clone; never touch the worker.
      if (ttl > 0) {
        const hit = reportCache.get(key);
        if (hit && hit.expiresAt > Date.now()) return Promise.resolve(cloneResult(hit.value) as T);
      }
      // 2) Coalesce: a concurrent identical call is already in flight → await it.
      const flying = inflightReport.get(key);
      if (flying) return flying.then((v) => cloneResult(v) as T);
      // 3) Miss → one worker round-trip. Cache the RAW value under TTL; every returned
      //    promise (starter + coalesced awaiters) clones it, so no caller shares a
      //    mutable ref. Rejections are NOT cached (no negative caching) and free the
      //    coalesce slot so the next call re-tries the worker.
      const p = requestWithRetry<T>({ kind: 'report', name, args: a })
        .then((v) => {
          if (ttl > 0) reportCache.set(key, { value: v, expiresAt: Date.now() + ttl });
          return v;
        })
        .finally(() => { inflightReport.delete(key); });
      inflightReport.set(key, p as Promise<unknown>);
      return p.then((v) => cloneResult(v) as T);
    },
    query: (sn, metric, sinceMs, untilMs, bucketSec) =>
      requestWithRetry({ kind: 'query', sn, metric, sinceMs, untilMs, bucketSec }),
    listMetrics: (sn) => requestWithRetry({ kind: 'listMetrics', sn }),
    pushSnapshot: (snap) => { lastSnapshot = snap; dirty = true; },
    stop: () => {
      stopped = true;
      clearInterval(pushTimer);
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('analytics client stopped')); }
      pending.clear();
      reportCache.clear();
      inflightReport.clear();
      try { void worker.terminate(); } catch { /* */ }
    },
  };
}

/* ── Process-wide singleton ──────────────────────────────────────────────
 * The analytics client owns ONE worker thread per process. index.ts calls
 * initAnalyticsClient() at startup; every other consumer (alertMonitor,
 * featureSnapshot, mqttDiscovery, telnet) reaches it via getAnalytics()
 * instead of threading the handle through their constructors. Unit tests
 * never hit getAnalytics() (they call the compute* functions directly), so
 * the "not initialized" throw only ever fires on a genuine wiring mistake. */
let singleton: AnalyticsClient | null = null;

export function initAnalyticsClient(dbPath: string, log: (m: string) => void): AnalyticsClient {
  if (singleton) return singleton;
  singleton = createAnalyticsClient(dbPath, log);
  return singleton;
}

export function getAnalytics(): AnalyticsClient {
  if (!singleton) throw new Error('analytics client not initialized — call initAnalyticsClient() first');
  return singleton;
}
