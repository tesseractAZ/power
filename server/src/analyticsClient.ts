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
    report: <T = any>(name: string, args?: ReportArgs) => requestWithRetry<T>({ kind: 'report', name, args: args ?? {} }),
    query: (sn, metric, sinceMs, untilMs, bucketSec) =>
      requestWithRetry({ kind: 'query', sn, metric, sinceMs, untilMs, bucketSec }),
    listMetrics: (sn) => requestWithRetry({ kind: 'listMetrics', sn }),
    pushSnapshot: (snap) => { lastSnapshot = snap; dirty = true; },
    stop: () => {
      stopped = true;
      clearInterval(pushTimer);
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('analytics client stopped')); }
      pending.clear();
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
