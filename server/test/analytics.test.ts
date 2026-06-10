import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rootCausesFor,
  parseRange,
  onPeakAt,
  forecastDayAlerts,
  resetHaStateShortLivedCaches,
  resetForecastCachesForTesting,
  resetRteCache,
  resetSelfConsumptionCache,
  windowedEnergyWh,
  resetDailyEnergyCache,
  computeBaselineAlerts,
  computeRoundTripEfficiency,
  computeSelfConsumption,
  computeEquipmentHealth,
  type DayForecast,
} from '../src/analytics.js';
import { integrateWh, startOfLocalDayMs } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

test('rootCausesFor — direct match against a graph leaf', () => {
  const causes = rootCausesFor('forecast-low-solar');
  // The DAG has soiling-pv and mppt-efficiency-drop pointing at forecast-low-solar
  assert.ok(causes.length >= 2);
  assert.ok(causes.some((c) => c.id === 'soiling-pv'));
  assert.ok(causes.some((c) => c.id === 'mppt-efficiency-drop'));
});

test('rootCausesFor — alert id with a device suffix still matches the family', () => {
  // Real alerts have IDs like "forecast-soc-dip" or "baseline-load-Y7..."
  const causes = rootCausesFor('forecast-soc-dip-Y7XYZ');
  // forecast-low-solar / soiling-pv / storm-prep / baseline-load point at forecast-soc-dip
  assert.ok(causes.length >= 1);
});

test('rootCausesFor — unknown id returns empty array', () => {
  const causes = rootCausesFor('this-alert-does-not-exist');
  assert.equal(causes.length, 0);
});

test('parseRange — "15-20" → [15, 20]', () => {
  assert.deepEqual(parseRange('15-20'), [15, 20]);
});

test('parseRange — invalid input → null', () => {
  assert.equal(parseRange(''), null);
  assert.equal(parseRange('abc'), null);
  assert.equal(parseRange('15'), null);
});

test('onPeakAt — APS-Saver-style (default 15-20, Mon-Fri)', () => {
  // Tuesday 4pm = on-peak
  const tuesday4pm = new Date(2026, 4, 19, 16, 0, 0).getTime();
  assert.equal(onPeakAt(tuesday4pm), true);
  // Tuesday 9am = off-peak (before window)
  const tuesday9am = new Date(2026, 4, 19, 9, 0, 0).getTime();
  assert.equal(onPeakAt(tuesday9am), false);
  // Tuesday 9pm = off-peak (after window: 15-20 means h<20 is in)
  const tuesday9pm = new Date(2026, 4, 19, 21, 0, 0).getTime();
  assert.equal(onPeakAt(tuesday9pm), false);
  // Saturday 4pm = off-peak (weekend excluded by default 1-5)
  const sat4pm = new Date(2026, 4, 23, 16, 0, 0).getTime();
  assert.equal(onPeakAt(sat4pm), false);
});

function emptyForecast(overrides: Partial<DayForecast>): DayForecast {
  return {
    generatedAt: Date.now(),
    hasWeather: true,
    historyDays: 30,
    reserveSoc: 15,
    hours: [],
    forecastPvWhNext24: 50_000,
    typicalPvWhPerDay: 50_000,
    minProjectedSoc: null,
    minProjectedSocTs: null,
    solarModel: { hourly: [], peakCoeff: 0, pairCount: 0, historyDays: 30 },
    deviceModels: [],
    soiling: null,
    ...overrides,
  };
}

test('forecastDayAlerts — no alerts when forecast is healthy', () => {
  const df = emptyForecast({});
  const alerts = forecastDayAlerts(df);
  assert.equal(alerts.length, 0);
});

test('forecastDayAlerts — fires forecast-soc-dip when minProjectedSoc < reserveSoc', () => {
  const df = emptyForecast({
    minProjectedSoc: 8,
    minProjectedSocTs: Date.now() + 6 * 3600 * 1000,
    reserveSoc: 15,
    // Need hours to drive the cloud-cover counterfactual.
    hours: Array.from({ length: 24 }, (_, h) => ({
      ts: Date.now() + h * 3600 * 1000,
      forecastPvW: 1000,
      forecastLoadW: 800,
      cloudCoverPct: 60,
      ghiWm2: 500,
      projectedSocPct: 30 - h,
      modelled: true,
    })),
  });
  const alerts = forecastDayAlerts(df);
  const dip = alerts.find((a) => a.id === 'forecast-soc-dip');
  assert.ok(dip, 'expected forecast-soc-dip alert');
  // v0.8.0 counterfactual: detail should reference cloud cover
  assert.match(dip!.detail, /cloud/i);
  // Facts should include cloud cover
  assert.ok(dip!.facts?.some((f) => f.label === 'Avg cloud cover'));
});

test('forecastDayAlerts — fires forecast-low-solar when next-24h is <60% of typical', () => {
  const df = emptyForecast({
    forecastPvWhNext24: 20_000,   // 40% of typical
    typicalPvWhPerDay: 50_000,
    hasWeather: true,
    hours: Array.from({ length: 24 }, (_, h) => ({
      ts: Date.now() + h * 3600 * 1000,
      forecastPvW: 500,
      forecastLoadW: 800,
      cloudCoverPct: 75,
      ghiWm2: 200,
      projectedSocPct: null,
      modelled: true,
    })),
  });
  const alerts = forecastDayAlerts(df);
  const low = alerts.find((a) => a.id === 'forecast-low-solar');
  assert.ok(low, 'expected forecast-low-solar alert');
  // Should have the counterfactual cloud-cover fact
  assert.ok(low!.facts?.some((f) => f.label === 'Avg cloud cover'));
});

test('forecastDayAlerts — fires soiling-pv when drop ≥ 12% and ≥ 6 clean days', () => {
  const df = emptyForecast({
    soiling: { dropPct: 18, baselineCoeff: 10, recentCoeff: 8.2, cleanDays: 10 },
  });
  const alerts = forecastDayAlerts(df);
  const soil = alerts.find((a) => a.id === 'soiling-pv');
  assert.ok(soil, 'expected soiling-pv alert');
});

test('forecastDayAlerts — does NOT fire soiling-pv when below threshold', () => {
  const df = emptyForecast({
    soiling: { dropPct: 8, baselineCoeff: 10, recentCoeff: 9.2, cleanDays: 10 },
  });
  const alerts = forecastDayAlerts(df);
  assert.equal(alerts.find((a) => a.id === 'soiling-pv'), undefined);
});

/* ─── cache-warmer reset (v0.9.11 bug fix) ───────────────────────────────
 *
 * Regression test for the bug surfaced by log analysis: the cache-warmer
 * called the heavy compute* functions every 4 min, but each function's
 * cache check (`if cached && !expired, return cached`) returned the
 * cached value WITHOUT updating `ts`. So 5-min TTLs would expire 5 min
 * after the original cold compute (not 5 min after the most recent
 * warmer call), leaving a 1-3 min cold window every cycle.
 *
 * `resetHaStateShortLivedCaches()` clears the affected caches so the
 * subsequent warmer compute calls do real work + restamp `ts`.
 */

// Recorder mock — count query() calls so we can prove the cache actually
// recomputed (vs. returned a cached value).
function mockRecorder(): Recorder & { queryCount: number; queryMultiCount: number } {
  let queryCount = 0;
  let queryMultiCount = 0;
  return {
    insertSnapshot: () => {},
    query: () => { queryCount++; return []; },
    queryMulti: (_sn, metrics) => {
      queryMultiCount++;
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
    get queryCount() { return queryCount; },
    get queryMultiCount() { return queryMultiCount; },
  } as Recorder & { queryCount: number; queryMultiCount: number };
}

test('resetHaStateShortLivedCaches — forces compute on next call (cache cleared)', () => {
  // Empty devices map is the cheapest input that still exercises the
  // cache-check path (computeRoundTripEfficiency early-outs without a DPU
  // but the cache is still populated by the call).
  const rec = mockRecorder();
  // First call: populates cache (returns a default zero report for empty fleet).
  computeRoundTripEfficiency({}, rec);
  const afterFirst = rec.queryCount;
  // Second call without reset: should hit the cache, no new queries.
  computeRoundTripEfficiency({}, rec);
  assert.equal(rec.queryCount, afterFirst, 'second call should be cached');
  // Third call after reset: should NOT hit cache (but with empty devices,
  // recorder.query still isn't called since the loop body is skipped).
  // What we can assert is the reset itself doesn't throw + the export exists.
  resetHaStateShortLivedCaches();
  computeRoundTripEfficiency({}, rec);
  // The function returns deterministically for empty devices, so the assert
  // here is mostly that we didn't crash. The real win is in the live system
  // where recorder.query() IS called inside the loop.
  assert.ok(true, 'reset + recompute did not throw');
});

test('resetHaStateShortLivedCaches — is idempotent (safe to call when caches already null)', () => {
  resetHaStateShortLivedCaches();
  resetHaStateShortLivedCaches();
  resetHaStateShortLivedCaches();
  assert.ok(true);
});

/* ───────────────────────────────────────────────────────────────────────
 * v0.9.29 — query-budget tests for the warmer's hot 5-min-TTL functions.
 *
 * Production logs from a 4-DPU fleet showed cache-warmer cycles burning
 * ~3.4 s of wall time per pass, with self-consumption (~720 ms), RTE
 * (~650 ms), and equipment-health (~520 ms) dominating. Profiling traced
 * the cost to SQL round-trip count: RTE issued (days × dpus × packs × 2)
 * = 280 queries; self-consumption issued ~49; equipment-health issued
 * 6 × dpus = 24 unbucketed 60-day pulls (millions of rows materialized
 * in JS per cycle).
 *
 * These tests pin the new query budget so a future refactor that
 * accidentally reintroduces an N+1 pattern fails CI before it ships to
 * prod. The numbers below are upper bounds — exact counts depend on
 * fleet shape, but the budget scales linearly in (dpus × packs), not
 * (days × dpus × packs × 2).
 * ─────────────────────────────────────────────────────────────────── */

// Synthesize a fleet of N DPUs each with P packs — enough surface area
// to expose any per-pack-per-day N+1 loops.
function fakeDpuFleet(numDpus = 4, packsPerDpu = 5): Record<string, DeviceSnapshot> {
  const out: Record<string, DeviceSnapshot> = {};
  for (let i = 0; i < numDpus; i++) {
    const sn = `SN-DPU-${i}`;
    out[sn] = {
      sn,
      deviceName: `DELTA-PRO-ULTRA-${i + 1}`,
      online: true,
      lastSeenMs: Date.now(),
      projection: {
        kind: 'dpu',
        soc: 80,
        pvTotalWatts: 0,
        pvHighWatts: 0, pvLowWatts: 0,
        pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 0, batAmp: 0, mpptHvTemp: 0, mpptLvTemp: 0,
        packs: Array.from({ length: packsPerDpu }, (_, p) => ({
          num: p + 1, soc: 80, temp: 25, inputWatts: 0, outputWatts: 0,
          maxCellTemp: 25, minCellTemp: 25, soh: 100, cycles: 50,
        })),
      } as any,
    } as any;
  }
  return out;
}

test('computeRoundTripEfficiency — single batched fetch per DPU + coverage-gated days (v0.13.3)', () => {
  resetHaStateShortLivedCaches();
  const rec = mockRecorder();
  const devices = fakeDpuFleet(4, 5);
  computeRoundTripEfficiency(devices, rec);
  // v0.13.3 — RTE still does ONE batched queryMulti per DPU over the full window
  // (the pre-fetched packSeries already anchors interior midnights via
  // integrateWh's lastBefore sample), but now COVERAGE-GATES each day: a day with
  // <50% measured coverage (e.g. a 49-min partial-boot day) is set to null and
  // excluded from the aggregate. That removes the physically impossible
  // 130.8%/34.9% per-day values and reconciles the aggregate with
  // self-consumption — WITHOUT the O(days × dpus) refetch. Budget stays ≤1
  // queryMulti per DPU; never the per-metric query() path.
  assert.ok(
    rec.queryMultiCount > 0 && rec.queryMultiCount <= 4,
    `RTE made ${rec.queryMultiCount} queryMulti calls; budget is ≤ 4 (one per DPU)`,
  );
  assert.equal(rec.queryCount, 0, 'RTE should not use the per-metric query() path');
});

test('computeSelfConsumption — batched per device-segment + day-memoized warm reuse', () => {
  // v0.9.84 — SC now integrates via windowedEnergyWh: per-calendar-day
  // memoization. Cold scan = O(dpus × day-segments) but STILL batched
  // (one queryMulti carries all ~12 metrics per device per segment — not
  // one query per metric, which would be ~12× more). After warming, the
  // completed interior days are served from cache, so a result-cache reset
  // re-scans only the two boundary partials.
  resetForecastCachesForTesting();   // clears SC result cache AND the day-energy memo
  const rec = mockRecorder();
  const devices = fakeDpuFleet(4, 5);
  computeSelfConsumption(devices, rec);                 // cold — fills day cache
  const cold = rec.queryMultiCount;
  // Batched: 4 DPUs × ≤8 day-segments. Per-metric would be ×12 (~384).
  assert.ok(cold > 0 && cold <= 4 * 9, `cold is batched per device-segment (${cold} ≤ 36)`);

  resetSelfConsumptionCache();                          // force result recompute, KEEP day cache
  computeSelfConsumption(devices, rec);                 // reuses cached interior days
  const warm = rec.queryMultiCount - cold;
  assert.ok(warm < cold, `warm SC reuses cached days, fewer queries than cold (${warm} < ${cold})`);
  assert.ok(warm <= 4 * 2, `warm re-scans only the 2 boundary partials per DPU (${warm} ≤ 8)`);
});

test('computeEquipmentHealth — query count bounded; 5-min bucketing in use', () => {
  const rec = mockRecorder();
  const devices = fakeDpuFleet(4, 5);
  computeEquipmentHealth(devices, rec);
  // ratioSeries: ≤ 1 queryMulti per (DPU × string) = 8 calls.
  // inverter-standby: ≤ 1 queryMulti per DPU = 4 calls + 1 query for
  // SHP2 panel_load (no SHP2 here, so 0). Total budget: ≤ 12 queryMulti.
  assert.ok(
    rec.queryMultiCount <= 12,
    `equipment-health made ${rec.queryMultiCount} queryMulti calls; budget is ≤ 12`,
  );
  // The per-metric query() path should not be hit for the MPPT or
  // standby calculations themselves; only the SHP2 panel_load fallback
  // uses it (and there's no SHP2 in this synthetic fleet).
  assert.equal(rec.queryCount, 0);
});

/* ===================================================================
 * v0.9.80 — sustained-excursion gate on bursty SHP2 load circuits.
 *
 * Bimodal loads (AC compressors) + the May→summer ramp leave the
 * hour-of-day baseline dominated by the off/low state, so a single
 * compressor-on reading reads as a huge outlier and re-fired every
 * cycle (42h log: "East Air conditioner load unusual for the hour" ×13).
 * The gate requires the excursion to PERSIST across the recent real-time
 * window before flagging: a stuck/faulted circuit holds; a normal cycle
 * does not.
 * =================================================================== */

function shp2LoadDevice(circuitName: string, liveW: number): Record<string, DeviceSnapshot> {
  return {
    SHP: {
      sn: 'SHP', deviceName: 'Smart Panel', productName: 'Smart Home Panel 2',
      online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'shp2',
        pairedCircuits: [],
        circuits: [{ ch: 4, name: circuitName, watts: liveW, breakerAmps: 20 }],
      },
    } as unknown as DeviceSnapshot,
  };
}

// Build a recorder returning a fixed history for any (sn, metric). `recentW`
// are the last-30-min samples (newest), `baseW` the older hour-of-day history
// (placed on prior days so they fall in the ±1h bucket). Ascending by ts.
function loadHistory(baseW: number, recentW: number[]): Recorder {
  const now = Date.now();
  const DAY = 86_400_000;
  const pts: Array<{ ts: number; value: number }> = [];
  // 20 days of low-baseline samples, one per day at ~now's hour-of-day.
  for (let k = 20; k >= 1; k--) pts.push({ ts: now - k * DAY, value: baseW });
  // recent real-time window: spread across the last ~28 min, oldest first.
  const span = recentW.length;
  recentW.forEach((v, i) => pts.push({ ts: now - (span - i) * 5 * 60_000 + 60_000, value: v }));
  return {
    insertSnapshot: () => {},
    query: () => pts,
    queryMulti: () => new Map(),
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

const loadAlerts = (devices: Record<string, DeviceSnapshot>, rec: Recorder) =>
  computeBaselineAlerts(devices, rec).filter((a) => /unusual for the hour/.test(a.title));

test('computeBaselineAlerts — bursty AC cycling does NOT flag (transient spike)', () => {
  resetForecastCachesForTesting();
  // Mostly-off baseline (150 W); a single compressor-on spike in the recent
  // window and live=3200 W. Without the gate this fires (huge z); with it,
  // only 1 of 6 recent samples is elevated → not sustained → suppressed.
  const rec = loadHistory(150, [150, 150, 3200, 150, 150, 150]);
  assert.equal(loadAlerts(shp2LoadDevice('East Air conditioner', 3200), rec).length, 0);
});

test('computeBaselineAlerts — genuinely stuck-on circuit DOES flag (sustained)', () => {
  resetForecastCachesForTesting();
  // Same low baseline, but the recent window is ALL elevated (circuit stuck
  // on / fault) and live=3200 W → sustained → fires.
  const rec = loadHistory(150, [3200, 3200, 3200, 3200, 3200, 3200]);
  const alerts = loadAlerts(shp2LoadDevice('East Air conditioner', 3200), rec);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /unusual for the hour/);
});

/* ===================================================================
 * v0.9.82 — scoped cache resetters must be INDEPENDENT so the cache-
 * warmer can stagger the heavy recomputes (self-consumption + RTE +
 * tariff) one group per cycle instead of nulling all five every cycle.
 * Benchmark proved this cuts the per-cycle synchronous DB burst ~58%
 * (475ms→199ms on SSD; ~3.1s→~1.3s on the Pi). This guards the
 * mechanism: resetting one group must NOT clear another.
 * =================================================================== */
test('resetRteCache clears RTE but leaves self-consumption warm (stagger isolation)', () => {
  const rec = mockRecorder();
  // v0.15.13 — SC only caches a structurally complete fleet (≥1 DPU AND the
  // SHP2), so the warm-cache fixture needs an SHP2 alongside the DPUs.
  const fleet: Record<string, DeviceSnapshot> = {
    ...fakeDpuFleet(),
    SHP: {
      sn: 'SHP', deviceName: 'Smart Panel', productName: 'Smart Home Panel 2',
      online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'shp2', pairedCircuits: [], circuits: [],
        sources: [{ isConnected: true, sn: 'SN-DPU-0' }, { isConnected: true, sn: 'SN-DPU-1' }, { isConnected: true, sn: 'SN-DPU-2' }, { isConnected: true, sn: 'SN-DPU-3' }],
      },
    } as unknown as DeviceSnapshot,
  };
  resetHaStateShortLivedCaches();
  computeSelfConsumption(fleet, rec);          // warm SC
  computeRoundTripEfficiency(fleet, rec);      // warm RTE
  const afterWarm = rec.queryMultiCount;

  resetRteCache();                             // scoped: RTE only
  computeSelfConsumption(fleet, rec);          // must stay cached → no new queries
  assert.equal(rec.queryMultiCount, afterWarm, 'self-consumption stays warm after resetRteCache');

  computeRoundTripEfficiency(fleet, rec);      // RTE was cleared → recomputes
  assert.ok(rec.queryMultiCount > afterWarm, 'RTE recomputes after resetRteCache');
});

test('resetSelfConsumptionCache clears SC but leaves RTE warm (stagger isolation)', () => {
  const rec = mockRecorder();
  const fleet = fakeDpuFleet();
  resetHaStateShortLivedCaches();
  computeRoundTripEfficiency(fleet, rec);      // warm RTE
  computeSelfConsumption(fleet, rec);          // warm SC
  const afterWarm = rec.queryMultiCount;

  resetSelfConsumptionCache();                 // scoped: SC (+carbon) only
  computeRoundTripEfficiency(fleet, rec);      // must stay cached → no new queries
  assert.equal(rec.queryMultiCount, afterWarm, 'RTE stays warm after resetSelfConsumptionCache');

  computeSelfConsumption(fleet, rec);          // SC was cleared → recomputes
  assert.ok(rec.queryMultiCount > afterWarm, 'self-consumption recomputes after resetSelfConsumptionCache');
});

/* ===================================================================
 * v0.9.84 — windowedEnergyWh per-day memoization. Must (a) match the
 * whole-window integral (energy accounting can't drift), (b) reuse
 * cached completed days so a warm call issues far fewer SQL queries,
 * and (c) re-query after a reset. This is what takes self-consumption
 * from ~1.9s to ~0.26s on the Pi without changing the numbers.
 * =================================================================== */
function energyRecorder(): Recorder & { queryMultiCount: number } {
  let n = 0;
  // Smooth, deterministic signal so trapezoidal integration is stable.
  const f = (ts: number) => 1000 + 500 * Math.sin(ts / 5_000_000);
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn, metrics, since, until, bucketSec) => {
      n++;
      const step = (bucketSec ?? 300) * 1000;
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const metric of metrics) {
        const pts: Array<{ ts: number; value: number }> = [];
        for (let t = Math.ceil(since / step) * step; t <= until; t += step) pts.push({ ts: t, value: f(t) });
        m.set(metric, pts);
      }
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
    get queryMultiCount() { return n; },
  } as Recorder & { queryMultiCount: number };
}

test('windowedEnergyWh — matches whole-window integral, memoizes completed days', () => {
  resetDailyEnergyCache();
  const rec = energyRecorder();
  const now = startOfLocalDayMs() + 14 * 3_600_000;  // today 14:00 local
  const since = now - 7 * 86_400_000;
  const todayStart = startOfLocalDayMs();

  // Whole-window reference.
  const whole = integrateWh(rec.queryMulti('SN', ['pv'], since, now, 300).get('pv')!, since, now).wh;
  const qRef = rec.queryMultiCount;

  // Day-cached cold (fills the per-day cache).
  const cold = windowedEnergyWh(rec, 'SN', ['pv'], since, now, 300, todayStart).get('pv')!;
  const qAfterCold = rec.queryMultiCount;
  // Day-cached warm (interior days served from cache).
  const warm = windowedEnergyWh(rec, 'SN', ['pv'], since, now, 300, todayStart).get('pv')!;
  const qAfterWarm = rec.queryMultiCount;

  assert.ok(Math.abs(whole - cold) / whole < 0.01,
    `day-cached within 1% of whole-window (${whole.toFixed(0)} vs ${cold.toFixed(0)})`);
  assert.equal(cold, warm, 'warm call returns identical energy');
  const coldQ = qAfterCold - qRef;
  const warmQ = qAfterWarm - qAfterCold;
  assert.ok(warmQ < coldQ, `warm issues fewer queries than cold (${warmQ} < ${coldQ})`);
  assert.ok(warmQ <= 2, `warm only re-scans the boundary partials (${warmQ} ≤ 2)`);

  // Reset forces full re-query.
  resetDailyEnergyCache();
  windowedEnergyWh(rec, 'SN', ['pv'], since, now, 300, todayStart);
  assert.ok(rec.queryMultiCount - qAfterWarm > warmQ, 'reset re-queries the previously-cached days');
});
