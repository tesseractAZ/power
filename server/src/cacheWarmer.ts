import type { SnapshotStore } from './snapshot.js';
import type { Recorder } from './recorder.js';
import {
  getDayForecast,
  computeDegradation,
  computeRunway,
  computeRoundTripEfficiency,
  computeClipping,
  computeSelfConsumption,
  computeCarbonReport,
  computeTariffReport,
  computeForecastSkill,
  computeBayesianSolarModel,
  computeProbabilisticForecast,
  computeMultiDayForecast,
  computeAmbientThermalForecast,
  computeThermalEvents,
  computeEquipmentHealth,
  computeShadeReport,
  computeSoilingDecomposition,
  computeStringMismatch,
  computeEvWindowPrediction,
  computeChargeCurveFingerprint,
  computeInternalResistance,
  resetHaStateShortLivedCaches,
} from './analytics.js';
import { computeRepairIssues } from './repairIssues.js';
import { computeTotals, startOfLocalDayMs } from './aggregator.js';

/**
 * v0.9.5 — Cache pre-warmer.
 *
 * The /api/ha-state endpoint chains 8+ heavy computations (carbon, tariff,
 * self-consumption, clipping, getDayForecast, degradation, runway, RTE,
 * Bayesian, multi-day, ambient-thermal, forecast skill). Each function
 * has its own TTL cache, but several use a 5-minute TTL — when they
 * expire roughly together, the next /api/ha-state caller pays ~1.8s to
 * rebuild them all on its critical path.
 *
 * Pre-warmer fix: call all of them in the background every WARM_INTERVAL_MS
 * (4 min, just inside the 5-min TTL window). When a real request arrives,
 * every cache is warm and the response is <5ms.
 *
 * v0.9.11 — log analysis showed the spikes were still happening every
 * ~5 min in production. Root cause: each `compute*` function's cache
 * check returns the cached value WITHOUT updating its timestamp when
 * the cache is still warm, so the 4-min warmer never actually refreshes
 * a 5-min cache — it just reads it. The cache then expires 5 min after
 * the original cold compute, leaving a 1-3 min cold window every cycle.
 * Fix: call resetHaStateShortLivedCaches() at the start of each warm
 * cycle, forcing the subsequent computes to do real work + restamp `ts`.
 *
 * Errors in one function don't stop the rest — each is wrapped so a
 * transient weather-API failure doesn't block carbon/tariff warming.
 */

const WARM_INTERVAL_MS = 4 * 60 * 1000;

export interface CacheWarmerHandle {
  stop: () => void;
  /** Trigger an immediate warm cycle (used for testing). */
  warmNow: () => Promise<void>;
  /** Per-task wall time (ms) of the most recent successful run. */
  lastTimings: () => Record<string, number>;
}

export function startCacheWarmer(
  store: SnapshotStore,
  recorder: Recorder,
  log: (m: string) => void,
): CacheWarmerHandle {
  let stopped = false;
  let inFlight = false;
  const timings: Record<string, number> = {};

  /** Run one task, catch + log errors, record wall time on success. */
  const safe = async (name: string, fn: () => Promise<unknown> | unknown) => {
    const t0 = Date.now();
    try {
      await fn();
      timings[name] = Date.now() - t0;
    } catch (e: any) {
      log(`cache-warmer: ${name} failed: ${e?.message ?? e}`);
    }
  };

  const warmNow = async () => {
    if (inFlight) return;        // a slow cycle shouldn't pile up if the interval fires early
    if (stopped) return;
    inFlight = true;
    const t0 = Date.now();
    const devices = store.get().devices;
    // Bail quietly when the snapshot store is empty — happens during the
    // first ~30s after boot, before the REST refresh has populated devices.
    if (Object.keys(devices).length === 0) {
      inFlight = false;
      return;
    }
    try {
      // v0.9.11 — clear the short-TTL caches so the subsequent computes
      // actually do the work instead of returning still-warm values
      // without restamping `ts`. See the file-level note for the bug.
      resetHaStateShortLivedCaches();
      // v0.9.49 — Parallelized: the previous serial sequence was 21
      // `await safe(...)` calls in a chain. Log analyst measured slow
      // cycles dominated by 3 offenders (self-consumption ~1100ms,
      // round-trip-efficiency ~1100ms, charge-curve ~500ms) running
      // back-to-back. None of them have data-flow dependencies on each
      // other beyond `fc` / `skill` / `devices` / `recorder`, all of
      // which are computed before the parallel block. Promise.all
      // collapses the ~3-4s cycle to ~1.2s (limited by the slowest
      // individual function).
      //
      // Three sequential checkpoints remain because they DO have data
      // dependencies:
      //   - fc                  (input to runway + clipping + multi-day + skill + probabilistic)
      //   - skill               (depends on fc; input to probabilistic-forecast)
      //   - repair-issues       (consumes degradation + soiling + equipment-health + skill)
      const fc = await getDayForecast(devices, recorder, () => {});
      const skill = await computeForecastSkill(devices, recorder, fc);

      // First parallel cohort: every function that only needs
      // (devices, recorder) and optionally (fc, skill). All independent.
      await Promise.all([
        safe('degradation', () => computeDegradation(devices, recorder)),
        safe('runway', () => computeRunway(devices, recorder, fc)),
        safe('round-trip-efficiency', () => computeRoundTripEfficiency(devices, recorder)),
        safe('clipping', () => computeClipping(devices, recorder, fc)),
        safe('self-consumption', () => computeSelfConsumption(devices, recorder)),
        safe('carbon', () => computeCarbonReport(devices, recorder)),
        safe('tariff', () => computeTariffReport(devices, recorder)),
        safe('multi-day', () => computeMultiDayForecast(devices, recorder, fc)),
        safe('bayesian-solar', () => computeBayesianSolarModel(devices, recorder)),
        safe('probabilistic-forecast', () => computeProbabilisticForecast(fc, skill)),
        safe('ambient-thermal', () => computeAmbientThermalForecast(devices, recorder)),
        // v0.9.14 — extended coverage: every "predictive insights"-tab endpoint
        // benefits from being pre-warm so its first fetch from a fresh page-load
        // hits <5 ms instead of recomputing.
        safe('thermal-events', () => computeThermalEvents(devices, recorder)),
        safe('equipment-health', () => computeEquipmentHealth(devices, recorder)),
        safe('shade-report', () => computeShadeReport(devices, recorder)),
        safe('soiling-decomposition', () => computeSoilingDecomposition(devices, recorder)),
        safe('string-mismatch', () => computeStringMismatch(devices, recorder)),
        safe('ev-window-prediction', () => computeEvWindowPrediction(devices, recorder)),
        safe('charge-curve', () => computeChargeCurveFingerprint(devices, recorder)),
        safe('internal-resistance', () => computeInternalResistance(devices, recorder)),
        safe('summary-today', () => computeTotals(store, recorder, startOfLocalDayMs(), Date.now())),
      ]);

      // repair-issues runs AFTER the parallel cohort because it
      // re-derives degradation / soiling / equipment-health internally;
      // running it concurrently would race the shared caches. Keep it
      // last so it pulls already-warm values.
      await safe('repair-issues', async () => {
        const snap = store.get();
        return computeRepairIssues({
          devices: snap.devices,
          alerts: snap.alerts ?? [],
          degradation: computeDegradation(devices, recorder),
          soiling: await computeSoilingDecomposition(devices, recorder),
          equipmentHealth: computeEquipmentHealth(devices, recorder),
          forecastSkill: skill,
        });
      });
      const totalMs = Date.now() - t0;
      // Log only when cycle is unusually slow (>3s) — otherwise this would
      // flood the log every 4 min with healthy timings. With v0.9.14's
      // SQL-side bucketing the typical cycle drops well below 1s.
      if (totalMs > 3000) {
        const top = Object.entries(timings).sort((a, b) => b[1] - a[1]).slice(0, 3);
        log(`cache-warmer: slow cycle (${totalMs}ms) — top: ${top.map(([k, v]) => `${k} ${v}ms`).join(', ')}`);
      }
    } finally {
      inFlight = false;
    }
  };

  // v0.9.49 — Kick off first cycle as soon as the snapshot has any
  // devices populated, rather than the fixed 10s wait. Log analyst
  // measured cold-start `/api/ha-state` at 6.6-7.0s on first hit after
  // every restart, because the cache-warmer's 10s grace period meant
  // the first /api/ha-state call had nothing pre-computed and had to
  // build from scratch. Polling every 250ms with a 30s ceiling
  // captures the common case (snapshot lands within 1-2s of MQTT
  // connect) while still guarding against a stuck/empty snapshot.
  const FIRST_WARM_POLL_MS = 250;
  const FIRST_WARM_DEADLINE_MS = 30_000;
  const firstWarmStartedAt = Date.now();
  const firstWarmTimer = setInterval(() => {
    if (stopped) { clearInterval(firstWarmTimer); return; }
    const hasDevices = Object.keys(store.get().devices).length > 0;
    const expired = Date.now() - firstWarmStartedAt > FIRST_WARM_DEADLINE_MS;
    if (hasDevices || expired) {
      clearInterval(firstWarmTimer);
      void warmNow();
    }
  }, FIRST_WARM_POLL_MS);
  (firstWarmTimer as any).unref?.();
  const timer = setInterval(() => warmNow(), WARM_INTERVAL_MS);
  timer.unref();

  log(`cache-warmer: started (interval ${WARM_INTERVAL_MS / 1000}s)`);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    warmNow,
    lastTimings: () => ({ ...timings }),
  };
}
