import { parentPort, workerData } from 'node:worker_threads';
import { createReadRecorder } from './readRecorder.js';
import { setOwnerReserveFloorPct } from './nightChargeActuator.js';
import { buildReport, WARM_REPORTS } from './reports.js';
import type { FleetSnapshot } from './snapshot.js';

/**
 * v0.10.0 — analytics worker thread.
 *
 * Owns a read-only connection to the WAL SQLite DB and runs every heavy
 * analytics report here, on the worker's event loop. The main thread keeps
 * the sole write connection (ingestion + lifetime rollup) and never executes
 * a multi-second history scan again — which is what was intermittently
 * starving the HTTP port and tripping the Supervisor watchdog into a restart
 * every ~40 min.
 *
 * Messages in:  { kind:'snapshot', snapshot }     — latest fleet snapshot
 *               { kind:'report', id, name, args } — build a named report
 *               { kind:'query', id, ... }         — raw recorder.query
 *               { kind:'listMetrics', id, sn }    — recorder.listMetrics
 * Messages out: { kind:'ready' } | { kind:'log', message }
 *               { kind:'result', id, ok, result|error }
 */

const port = parentPort;
if (!port) throw new Error('analyticsWorker must run as a worker thread');

const log = (m: string) => port.postMessage({ kind: 'log', message: m });
const dbPath: string | undefined = (workerData as any)?.dbPath;

const recorder = createReadRecorder(dbPath);
let snapshot: FleetSnapshot = { generatedAt: 0, devices: {} };
const ctx = () => ({ recorder, snapshot, log });
const hasDevices = () => Object.keys(snapshot.devices).length > 0;

port.on('message', async (msg: any) => {
  try {
    switch (msg?.kind) {
      case 'snapshot':
        snapshot = msg.snapshot;
        return;
      // v1.119.0 — the OWNER reserve floor, published from the main thread.
      // The runway model must measure against the floor the owner actually set,
      // not the reserve our own night-charge write temporarily raised.
      case 'ownerFloor':
        setOwnerReserveFloorPct(msg.pct ?? null);
        return;
      case 'report': {
        const result = await buildReport(msg.name, ctx(), msg.args ?? {});
        port.postMessage({ kind: 'result', id: msg.id, ok: true, result });
        return;
      }
      case 'query': {
        const result = recorder.query(msg.sn, msg.metric, msg.sinceMs, msg.untilMs, msg.bucketSec);
        port.postMessage({ kind: 'result', id: msg.id, ok: true, result });
        return;
      }
      case 'listMetrics': {
        const result = recorder.listMetrics(msg.sn);
        port.postMessage({ kind: 'result', id: msg.id, ok: true, result });
        return;
      }
      default:
        return;
    }
  } catch (e: any) {
    if (msg?.id != null) {
      port.postMessage({ kind: 'result', id: msg.id, ok: false, error: e?.message ?? String(e) });
    } else {
      log(`analytics-worker: error handling ${msg?.kind}: ${e?.message ?? e}`);
    }
  }
});

// ── Self-warm: keep the report TTL caches hot so endpoint requests return
// the cached value over a ~1ms IPC hop instead of triggering a recompute.
// Recomputes that DO happen run here, on the worker — never on main.
const WARM_INTERVAL_MS = 4 * 60 * 1000;
let warming = false;
const warm = async () => {
  if (warming || !hasDevices()) return;
  warming = true;
  try {
    for (const name of WARM_REPORTS) {
      try { await buildReport(name, ctx()); }
      catch (e: any) { log(`analytics-worker: warm ${name} failed: ${e?.message ?? e}`); }
    }
  } finally {
    warming = false;
  }
};
const warmTimer = setInterval(() => { void warm(); }, WARM_INTERVAL_MS);
(warmTimer as any).unref?.();
// First warm as soon as a non-empty snapshot lands (mirrors the old
// cache-warmer's 250ms poll / 30s ceiling, but it's harmless to keep polling).
const firstWarm = setInterval(() => {
  if (hasDevices()) { clearInterval(firstWarm); void warm(); }
}, 500);
(firstWarm as any).unref?.();

port.postMessage({ kind: 'ready' });
