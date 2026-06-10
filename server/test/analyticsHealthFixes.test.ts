/**
 * v0.13.3 — health-engine correctness fixes from the 7-day audit.
 *
 * Covers the analytics.ts fixes whose behavior is observable through the
 * exported compute* functions:
 *   • P3-1 RTE: a day with <50% integration coverage (e.g. a partial-boot day)
 *     reports efficiencyPct=null and is excluded from the aggregate totals,
 *     instead of surfacing a physically-impossible >100% ratio.
 *   • P2-4 EV: a DAILY charger that never reaches MIN_RECURRENCES on any single
 *     weekday is still detected (the parallel hour-of-day detector clusters it
 *     within a week).
 *
 * P3-2 (novelty divide-by-maxDist) lives in src/ml.ts, which is outside this
 * change's file scope (analytics.ts only); it is tracked separately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRoundTripEfficiency,
  computeEvWindowPrediction,
  computeSelfConsumption,
  resetRteCache,
  resetEvWindowCache,
  resetSelfConsumptionCache,
  resetDailyEnergyCache,
  runwayHoursForPublish,
  RUNWAY_NO_DEPLETION_SENTINEL_H,
} from '../src/analytics.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ─── fixtures ───────────────────────────────────────────────────────── */

/** One DPU with one pack — minimal surface to exercise RTE per-day gating. */
function oneDpuOnePack(sn = 'SN-RTE-0'): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn,
      deviceName: 'DELTA-PRO-ULTRA-1',
      online: true,
      lastSeenMs: Date.now(),
      projection: {
        kind: 'dpu',
        soc: 80,
        pvTotalWatts: 0, pvHighWatts: 0, pvLowWatts: 0,
        pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 0, batAmp: 0, mpptHvTemp: 0, mpptLvTemp: 0,
        packs: [{
          num: 1, soc: 80, temp: 25, inputWatts: 0, outputWatts: 0,
          maxCellTemp: 25, minCellTemp: 25, soh: 100, cycles: 50,
        }],
      } as any,
    } as any,
  };
}

/** Recorder whose queryMulti serves a fixed map of metric → samples. */
function recorderFor(series: Record<string, Array<{ ts: number; value: number }>>): Recorder {
  return {
    insertSnapshot: () => {},
    query: (_sn, metric) => series[metric] ?? [],
    queryMulti: (_sn, metrics) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, series[k] ?? []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as Recorder;
}

/** Constant-watt samples every `stepMin` minutes over [startMs, startMs+spanMs). */
function flat(startMs: number, spanMs: number, watts: number, stepMin = 5): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  const step = stepMin * 60_000;
  for (let t = startMs; t <= startMs + spanMs; t += step) out.push({ ts: t, value: watts });
  return out;
}

/* ─── P3-1: RTE coverage gate ────────────────────────────────────────── */

test('computeRoundTripEfficiency — a <50% coverage day yields null and is excluded from the aggregate', () => {
  resetRteCache();
  const todayStart = startOfLocalDayMs();
  const DAY = 86_400_000;
  // 3-day window: i=2 oldest (boot/partial), i=1 full, i=0 today.
  const bootDayStart = todayStart - 2 * DAY;
  const fullDayStart = todayStart - 1 * DAY;

  // Boot day: only ~40 min of data → coverage ≈ 40/1440 ≈ 3% of the 24h day.
  // The samples are a deliberately skew-prone pair (out >> in) that, ungated,
  // would have produced a >100% per-day ratio.
  const bootIn = flat(bootDayStart, 40 * 60_000, 200);   // small charge
  const bootOut = flat(bootDayStart, 40 * 60_000, 1800); // large discharge → ~900% if counted
  // Full day: charge 1000 W, discharge 950 W across the whole 24h → ~95% RTE.
  const fullIn = flat(fullDayStart, DAY, 1000);
  const fullOut = flat(fullDayStart, DAY, 950);

  const series = {
    pack1_in: [...bootIn, ...fullIn],
    pack1_out: [...bootOut, ...fullOut],
  };
  const rte = computeRoundTripEfficiency(oneDpuOnePack(), recorderFor(series), 3);

  assert.equal(rte.perDay.length, 3, 'three day-buckets for a 3-day window');
  const boot = rte.perDay.find((d) => d.chargedKwh > 0 && d.chargedKwh < 1);
  assert.ok(boot, 'boot day with a small charge integral should be present');
  assert.equal(
    boot!.efficiencyPct,
    null,
    'a <50%-coverage day must report null efficiency (not a >100% ratio)',
  );

  // The full day is counted and its ratio is the credible ~95% — NOT polluted
  // by the boot day's ~900% pair.
  const full = rte.perDay.find((d) => d.efficiencyPct != null);
  assert.ok(full, 'the full-coverage day should carry a real efficiency');
  assert.ok(
    full!.efficiencyPct! > 90 && full!.efficiencyPct! <= 100,
    `full-coverage day RTE should be ~95%, got ${full!.efficiencyPct}`,
  );

  // daysWithData counts only the gated-in day; the aggregate stays in band.
  assert.equal(rte.daysWithData, 1, 'only the full-coverage day has trustworthy data');
  assert.ok(
    rte.efficiencyPct != null && rte.efficiencyPct > 90 && rte.efficiencyPct <= 100,
    `aggregate RTE must stay in the credible band (≤100%), got ${rte.efficiencyPct}`,
  );
});

test('computeRoundTripEfficiency — never reports a physically-impossible >100% aggregate', () => {
  resetRteCache();
  const todayStart = startOfLocalDayMs();
  const DAY = 86_400_000;
  // Two partial days, each with a skewed out>in pair. Both should be gated out
  // for low coverage, leaving no impossible aggregate.
  const d2 = todayStart - 2 * DAY;
  const d1 = todayStart - 1 * DAY;
  const series = {
    pack1_in: [...flat(d2, 30 * 60_000, 100), ...flat(d1, 30 * 60_000, 100)],
    pack1_out: [...flat(d2, 30 * 60_000, 5000), ...flat(d1, 30 * 60_000, 5000)],
  };
  const rte = computeRoundTripEfficiency(oneDpuOnePack(), recorderFor(series), 3);
  assert.ok(
    rte.efficiencyPct == null || rte.efficiencyPct <= 100.5,
    `aggregate RTE must never exceed 100%, got ${rte.efficiencyPct}`,
  );
  assert.equal(rte.daysWithData, 0, 'two partial-coverage days both gated out');
});

/* ─── v0.14.1: RTE balanced-day (round-trip) filter ──────────────────── */

test('computeRoundTripEfficiency — a full-coverage net-charge (bulk-fill) day is excluded', () => {
  resetRteCache();
  const todayStart = startOfLocalDayMs();
  const DAY = 86_400_000;
  const fillDayStart = todayStart - 2 * DAY; // bulk-fill: pool ends much higher
  const balDayStart = todayStart - 1 * DAY; // genuine round trip
  // Bulk-fill day: FULL 24h coverage, but charge 2000 W vs discharge 700 W →
  // ratio 0.35. That's not an efficiency (the pool just filled up), so it must be
  // excluded rather than dragging the aggregate toward 35% (the real-world bug
  // that showed RTE 79.8% vs the ~96% the balanced days actually run at).
  const fillIn = flat(fillDayStart, DAY, 2000);
  const fillOut = flat(fillDayStart, DAY, 700);
  // Balanced day: charge 1000 W, discharge 960 W → ratio 0.96 (a real round trip).
  const balIn = flat(balDayStart, DAY, 1000);
  const balOut = flat(balDayStart, DAY, 960);
  const series = {
    pack1_in: [...fillIn, ...balIn],
    pack1_out: [...fillOut, ...balOut],
  };
  const rte = computeRoundTripEfficiency(oneDpuOnePack(), recorderFor(series), 3);

  const fill = rte.perDay.find((d) => d.chargedKwh > d.dischargedKwh * 2);
  assert.ok(fill, 'bulk-fill day present');
  assert.equal(fill!.efficiencyPct, null, 'a net-charge day is not a round trip → null efficiency');

  // Only the balanced day counts; the aggregate reflects ~96%, not the ~35% fill day.
  assert.equal(rte.daysWithData, 1, 'only the balanced round-trip day counts');
  assert.ok(
    rte.efficiencyPct != null && rte.efficiencyPct > 90 && rte.efficiencyPct <= 100,
    `aggregate should reflect the balanced day (~96%), got ${rte.efficiencyPct}`,
  );
});

/* ─── P2-4: EV daily-charger detection ───────────────────────────────── */

/** Minimal SHP2 device with one paired circuit. */
function shp2WithCircuit(primaryCh = 7): Record<string, DeviceSnapshot> {
  return {
    SHP: {
      sn: 'SHP',
      deviceName: 'Smart Panel',
      productName: 'Smart Home Panel 2',
      online: true,
      lastSeenMs: Date.now(),
      projection: {
        kind: 'shp2',
        pairedCircuits: [{ primaryCh }],
        sources: [],
      } as any,
    } as any,
  };
}

test('computeEvWindowPrediction — a DAILY charger is detected even though no single weekday reaches MIN_RECURRENCES', () => {
  resetEvWindowCache();
  // Six consecutive days, ONE ~50-min 7 kW session each at ~18:00. Spread across
  // six DISTINCT weekdays, every weekday+hour bucket holds exactly 1 session —
  // far below MIN_RECURRENCES=3 — so the weekday path alone emits 0 patterns.
  // The v0.13.3 hour-of-day daily detector must still surface the habit.
  const now = Date.now();
  const today6pm = new Date(now);
  today6pm.setHours(18, 0, 0, 0);

  const series: Array<{ ts: number; value: number }> = [];
  const jitter = [-4, +3, -2, +1, -5, +2]; // ±minutes, all round to hour 18
  for (let d = 1; d <= 6; d++) {
    const start = today6pm.getTime() - d * 86_400_000 + jitter[d - 1] * 60_000;
    for (let m = 0; m < 50; m += 5) series.push({ ts: start + m * 60_000, value: 7000 });
    series.push({ ts: start + 55 * 60_000, value: 0 }); // flush the session
  }
  series.sort((a, b) => a.ts - b.ts);

  const rec = recorderFor({ pair7_w: series });
  const r = computeEvWindowPrediction(shp2WithCircuit(7), rec);

  assert.ok(r.sessionsObserved >= 6, `expected ≥6 sessions observed, got ${r.sessionsObserved}`);
  // The daily habit must produce a pattern at startHour 18 despite no weekday
  // bucket reaching 3 recurrences.
  const hour18 = r.patterns.find((p) => p.startHour === 18);
  assert.ok(
    hour18,
    `daily 6pm charger must surface a startHour=18 pattern, got patterns ` +
    `${JSON.stringify(r.patterns.map((p) => ({ dow: p.dayOfWeek, hr: p.startHour, n: p.recurrences })))}`,
  );
  assert.ok(
    hour18!.recurrences >= 3,
    `the daily-detector pattern should aggregate ≥3 sessions, got ${hour18!.recurrences}`,
  );
  // And it lifts the upcoming-24h load at hour 18 regardless of which weekday
  // tomorrow is.
  assert.ok(
    r.upcomingNext24h.some((u) => new Date(u.ts).getHours() === 18 && u.watts > 0),
    'the daily charger should lift the forecast at 18:00 in the next 24 h',
  );
});

test('computeEvWindowPrediction — no spurious pattern from a single one-off cluster', () => {
  resetEvWindowCache();
  // Three sessions, ALL on the same calendar day at three different hours.
  // No hour recurs across distinct days and no hour reaches 3 recurrences, so
  // neither the weekday path nor the daily detector should emit a pattern.
  const now = Date.now();
  const base = new Date(now);
  base.setHours(9, 0, 0, 0);
  const oneDay = base.getTime() - 3 * 86_400_000; // a single day, 3 days ago
  const series: Array<{ ts: number; value: number }> = [];
  for (const hr of [9, 13, 19]) {
    const start = oneDay + hr * 3_600_000;
    for (let m = 0; m < 40; m += 5) series.push({ ts: start + m * 60_000, value: 7000 });
    series.push({ ts: start + 45 * 60_000, value: 0 });
  }
  series.sort((a, b) => a.ts - b.ts);

  const r = computeEvWindowPrediction(shp2WithCircuit(7), recorderFor({ pair7_w: series }));
  assert.equal(r.patterns.length, 0, 'a one-off single-day cluster must not become a recurring pattern');
});

/* ───────────────────────────────────────────────────────────────────────
 * v0.15.11 — runway publish sentinel (BUG-2). On a net-charging horizon the sim
 * never crosses reserve, so hoursTo* are legitimately null — but bare null →
 * HA 'unknown', indistinguishable from a telemetry outage on an islanded home.
 * runwayHoursForPublish() emits a finite sentinel for the healthy-no-depletion
 * case (unavailable === null) and keeps null only for a genuine outage.
 * ─────────────────────────────────────────────────────────────────────── */
test('runwayHoursForPublish — real value passes through unchanged', () => {
  assert.equal(runwayHoursForPublish(8.8, null), 8.8);
  assert.equal(runwayHoursForPublish(0, null), 0, 'a real 0 is not the no-data case');
  assert.equal(runwayHoursForPublish(12.3, 'panel-load history insufficient'), 12.3);
});

test('runwayHoursForPublish — null + healthy → sentinel; null + unavailable → null', () => {
  // Net-charging / no depletion in the horizon, projection healthy → sentinel,
  // so HA shows a big finite number instead of 'unknown'.
  assert.equal(runwayHoursForPublish(null, null), RUNWAY_NO_DEPLETION_SENTINEL_H);
  assert.ok(RUNWAY_NO_DEPLETION_SENTINEL_H >= 999, 'sentinel must read as "off the chart"');
  // Genuine outage (unavailable reason set) → keep null so HA shows unknown,
  // which now uniquely means data-loss.
  assert.equal(runwayHoursForPublish(null, 'SHP2 backup-pool capacity not yet reported'), null);
  assert.equal(runwayHoursForPublish(null, 'panel-load history insufficient — wait a few minutes'), null);
});

/* ───────────────────────────────────────────────────────────────────────
 * v0.15.13 — boot-partial fleet must not latch the self-consumption cache.
 * Observed live after the v0.15.12 restart: the warm-up compute ran with one
 * polled DPU and no SHP2 yet, cached loadKwh=0 / partial pvKwh under the bare
 * `dpus.length > 0` guard, and served it for the full TTL. The guard now
 * requires a structurally complete fleet (≥1 DPU AND the SHP2): an incomplete
 * snapshot may be returned, but never cached.
 * ─────────────────────────────────────────────────────────────────────── */

/** Recorder that counts queryMulti calls and returns empty series. */
function countingRecorder(): Recorder & { queryMultiCount: number } {
  let queryMultiCount = 0;
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn: string, metrics: string[]) => {
      queryMultiCount++;
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
    get queryMultiCount() { return queryMultiCount; },
  } as unknown as Recorder & { queryMultiCount: number };
}

function shp2Snap(sn = 'SN-SC-SHP2'): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn,
      deviceName: 'Smart Home Panel 2',
      online: true,
      lastSeenMs: Date.now(),
      projection: {
        kind: 'shp2',
        pairedCircuits: [],
        circuits: [],
        // shp2ConnectedDpuSns reads .sources to decide fleet membership.
        sources: [{ isConnected: true, sn: 'SN-SC-DPU' }],
      } as any,
    } as unknown as DeviceSnapshot,
  };
}

test('selfConsumption cache — DPU-only boot snapshot is returned but never latched', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  const rec = countingRecorder();
  const dpuOnly = oneDpuOnePack('SN-SC-DPU');           // a DPU is present, the SHP2 is not
  computeSelfConsumption(dpuOnly, rec);
  const afterCold = rec.queryMultiCount;
  assert.ok(afterCold > 0, 'cold compute must hit the recorder');
  computeSelfConsumption(dpuOnly, rec);                 // a latched cache would serve this with 0 new queries
  assert.ok(rec.queryMultiCount > afterCold, 'partial-fleet result must not be served from cache');
});

test('selfConsumption cache — complete fleet (DPU + SHP2) is cached as before', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  const rec = countingRecorder();
  const full = { ...oneDpuOnePack('SN-SC-DPU'), ...shp2Snap() };
  computeSelfConsumption(full, rec);
  const cold = rec.queryMultiCount;
  computeSelfConsumption(full, rec);
  assert.equal(rec.queryMultiCount, cold, 'complete-fleet result is served from cache (TTL hit, zero new queries)');
});
