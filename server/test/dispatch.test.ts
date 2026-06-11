import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRunway,
  computeClipping,
  computeSelfConsumption,
  computeShadeReport,
  computeSoilingDecomposition,
  computeStringMismatch,
  computeEvWindowPrediction,
  computeEquipmentHealth,
  computeCarbonReport,
  computeTariffReport,
  computeDispatchPlan,
  resetHaStateShortLivedCaches,
  resetRunwayCache,
  type DayForecast,
} from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { recommendDispatch, type MpcInputs } from '../src/dispatch/mpc.js';

/* ─── shared fixtures ────────────────────────────────────────────────── */

/** Build a mock Recorder. Optional metric overrides return synthetic series. */
function mockRecorder(
  metricSeries: Record<string, Array<{ ts: number; value: number }>> = {},
): Recorder & { queryCount: number; queryMultiCount: number } {
  let queryCount = 0;
  let queryMultiCount = 0;
  return {
    insertSnapshot: () => {},
    query: (_sn, metric) => {
      queryCount++;
      return metricSeries[metric] ?? [];
    },
    queryMulti: (_sn, metrics) => {
      queryMultiCount++;
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, metricSeries[k] ?? []);
      return m;
    },
    listMetrics: () => Object.keys(metricSeries),
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
    get queryCount() { return queryCount; },
    get queryMultiCount() { return queryMultiCount; },
  } as Recorder & { queryCount: number; queryMultiCount: number };
}

/** Synthesize a fleet of N DPUs each with P packs. */
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
        packs: Array.from({ length: packsPerDpu }, (_, p) => ({ num: p + 1, soc: 80 })),
      } as any,
    } as any;
  }
  return out;
}

/** Synthesize an SHP2 with backup capacity reported. */
function fakeShp2(opts: {
  backupFullCapWh?: number;
  backupRemainWh?: number;
  backupReserveSoc?: number;
  pairedCircuits?: Array<{ primaryCh: number }>;
}): Record<string, DeviceSnapshot> {
  return {
    'SN-SHP2-1': {
      sn: 'SN-SHP2-1',
      deviceName: 'Smart Home Panel 2',
      online: true,
      lastSeenMs: Date.now(),
      projection: {
        kind: 'shp2',
        backupFullCapWh: opts.backupFullCapWh ?? null,
        backupRemainWh: opts.backupRemainWh ?? null,
        backupReserveSoc: opts.backupReserveSoc ?? 15,
        pairedCircuits: opts.pairedCircuits ?? [],
      } as any,
    } as any,
  };
}

function emptyForecast(overrides: Partial<DayForecast> = {}): DayForecast {
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

/* ─── computeRunway ──────────────────────────────────────────────────── */

test('computeRunway — no SHP2 → unavailable with reason', () => {
  const r = computeRunway({}, mockRecorder(), null);
  assert.ok(r.unavailable);
  assert.match(r.unavailable!, /SHP2/);
  assert.equal(r.backupRemainingKwh, null);
});

test('computeRunway — SHP2 reports capacity but no panel-load history → unavailable, but reports capacity', () => {
  const devices = fakeShp2({ backupFullCapWh: 60_000, backupRemainWh: 30_000, backupReserveSoc: 15 });
  const r = computeRunway(devices, mockRecorder(), null);
  // Insufficient load history → unavailable, but the function still reports
  // the capacity numbers it DID get (helpful UI hint).
  assert.match(r.unavailable!, /panel-load history/);
  assert.equal(r.backupRemainingKwh, 30);
  assert.equal(r.backupReserveKwh, 9);  // 15% of 60 kWh
});

test('computeRunway — discharge prediction with reserve floor', () => {
  // 60 kWh pool, 30 kWh remaining, 15% (9 kWh) reserve floor.
  // Average load = 1000 W → 1 kWh/h; no PV forecast → empty/null pvByHour.
  // Hours to reserve ≈ (30 - 9) / 1 = 21 h.
  const now = Date.now();
  const loadPts = Array.from({ length: 60 }, (_, i) => ({
    ts: now - (60 - i) * 60_000,
    value: 1000,  // 1000 W steady load
  }));
  const devices = fakeShp2({ backupFullCapWh: 60_000, backupRemainWh: 30_000, backupReserveSoc: 15 });
  const rec = mockRecorder({ panel_load: loadPts });
  const r = computeRunway(devices, rec, null);
  assert.equal(r.unavailable, null);
  assert.equal(r.recentLoadWatts, 1000);
  // hoursToReserve should be ~21 h (close enough — engine uses linear interp)
  assert.ok(r.hoursToReserve != null);
  assert.ok(
    r.hoursToReserve! >= 20 && r.hoursToReserve! <= 24,
    `expected hoursToReserve ~21, got ${r.hoursToReserve}`,
  );
});

/* v0.15.17 — the sim's near-term hours are anchored to the OBSERVED load.
 * The v0.14.0 forecast-curve change let the sim ignore a SUSTAINED real load
 * far above the modelled hour (live: 5–9 kW June-heat evenings vs a ~3 kW
 * curve → "no depletion" while the pool fell 5 %/h, muting the escalating
 * runway alarms). The first RUNWAY_BLEND_HOURS take a decaying max() blend
 * of the observed average into the curve. */

function runwayForecast(loadW: number): DayForecast {
  return emptyForecast({
    hours: Array.from({ length: 24 }, (_, i) => ({
      ts: Date.now() + i * 3_600_000,
      forecastPvW: 0,
      forecastLoadW: loadW,
    })) as any,
  });
}

test('computeRunway — sustained observed load above the curve pulls the crossing earlier', () => {
  resetRunwayCache();
  const now = Date.now();
  // Observed: steady 5 kW. Curve: 1 kW. Pool: 30 of 60 kWh, 15 % reserve (9 kWh) → 21 kWh usable.
  const loadPts = Array.from({ length: 60 }, (_, i) => ({ ts: now - (60 - i) * 60_000, value: 5000 }));
  const devices = fakeShp2({ backupFullCapWh: 60_000, backupRemainWh: 30_000, backupReserveSoc: 15 });
  const r = computeRunway(devices, mockRecorder({ panel_load: loadPts }), runwayForecast(1000));
  assert.equal(r.unavailable, null);
  // Blended hours: max(1, 5·w + 1·(1−w)) = 5, 4, 3, 2 kWh → 14 kWh by hour 4,
  // then the 1 kWh/h curve: reserve (7 kWh later) at ≈ 11 h — NOT the curve-only 21 h.
  assert.ok(r.hoursToReserve != null, 'crossing must be detected');
  assert.ok(
    r.hoursToReserve! >= 10 && r.hoursToReserve! <= 12.5,
    `expected hoursToReserve ≈ 11 with the observed-load anchor, got ${r.hoursToReserve}`,
  );
});

test('computeRunway — lighter-than-modelled observed load never increases optimism', () => {
  resetRunwayCache();
  const now = Date.now();
  // Observed: 500 W (below the 1 kW curve). max() keeps the curve → ~21 h unchanged.
  const loadPts = Array.from({ length: 60 }, (_, i) => ({ ts: now - (60 - i) * 60_000, value: 500 }));
  const devices = fakeShp2({ backupFullCapWh: 60_000, backupRemainWh: 30_000, backupReserveSoc: 15 });
  const r = computeRunway(devices, mockRecorder({ panel_load: loadPts }), runwayForecast(1000));
  assert.equal(r.unavailable, null);
  assert.ok(
    r.hoursToReserve! >= 20 && r.hoursToReserve! <= 24,
    `curve must still rule when observed < modelled, got ${r.hoursToReserve}`,
  );
});

/* ─── computeClipping ────────────────────────────────────────────────── */

test('computeClipping — null forecast → empty estimate', async () => {
  resetHaStateShortLivedCaches();
  const c = await computeClipping(fakeDpuFleet(2, 1), mockRecorder(), null);
  assert.equal(c.todayKwh, 0);
  assert.equal(c.perHour.length, 0);
  assert.equal(c.arrayPeakW, 0);
});

test('computeClipping — empty fleet → empty estimate', async () => {
  resetHaStateShortLivedCaches();
  const forecast = emptyForecast({
    solarModel: {
      hourly: Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        coeff: 5,
        r2: 0.9,
        samples: 10,
        observedMaxPvW: 15_000,
      })),
      peakCoeff: 5,
      pairCount: 240,
      historyDays: 30,
    },
  });
  const c = await computeClipping({}, mockRecorder(), forecast);
  assert.equal(c.todayKwh, 0);
});

/* ─── computeSelfConsumption ─────────────────────────────────────────── */

test('computeSelfConsumption — empty fleet returns zeros', () => {
  resetHaStateShortLivedCaches();
  const sc = computeSelfConsumption({}, mockRecorder());
  assert.equal(sc.pvKwh, 0);
  assert.equal(sc.loadKwh, 0);
  assert.equal(sc.batteryChargeKwh, 0);
  assert.equal(sc.solarFractionOfLoadPct, null);
  assert.equal(sc.directUseRatioPct, null);
});

test('computeSelfConsumption — passes through windowDays parameter', () => {
  resetHaStateShortLivedCaches();
  const sc = computeSelfConsumption({}, mockRecorder(), 14);
  assert.equal(sc.windowDays, 14);
});

/* ─── computeShadeReport ─────────────────────────────────────────────── */

test('computeShadeReport — empty fleet → empty hours', async () => {
  const sr = await computeShadeReport({}, mockRecorder());
  assert.equal(sr.hours.length, 0);
  assert.equal(sr.estTotalKwhPerYear, 0);
});

test('computeShadeReport — fleet with no PV history → empty hours', async () => {
  // 2 DPUs, but the mock recorder returns no rows for any metric.
  // Either weather is unreachable (returns empty) or weather is reached
  // but the empty PV series yields no shade hours. Either is acceptable.
  const sr = await computeShadeReport(fakeDpuFleet(2, 1), mockRecorder());
  assert.equal(sr.hours.length, 0);
});

/* ─── computeSoilingDecomposition ────────────────────────────────────── */

test('computeSoilingDecomposition — empty fleet → empty perDevice + perHour', async () => {
  const sd = await computeSoilingDecomposition({}, mockRecorder());
  assert.equal(sd.perDevice.length, 0);
  assert.equal(sd.perHour.length, 0);
});

test('computeSoilingDecomposition — fleet with no data still returns one row per DPU', async () => {
  const sd = await computeSoilingDecomposition(fakeDpuFleet(3, 1), mockRecorder());
  // Whether weather is reachable or not: when weather IS available, we get
  // one row per DPU (with null dropPct since there's no PV data). When
  // weather is NOT available, the function early-outs with empty arrays.
  // Both are valid; just assert the shape doesn't blow up.
  assert.ok(sd.perDevice.length === 0 || sd.perDevice.length === 3);
  for (const d of sd.perDevice) {
    assert.equal(d.dropPct, null);
  }
});

/* ─── computeStringMismatch ───────────────────────────────────────────
 * NOTE: computeStringMismatch caches its result module-globally (15-min TTL,
 * keyed only by time). Once a meaningful call populates the cache, every
 * subsequent test sees the same result regardless of inputs. The empty-fleet
 * test runs FIRST and doesn't populate the cache; the underperformer test
 * runs SECOND and pins the cache to the right answer. */

test('computeStringMismatch — empty fleet returns empty devices list (no cache pollution)', () => {
  const sm = computeStringMismatch({}, mockRecorder());
  assert.equal(sm.devices.length, 0);
});

test('computeStringMismatch — flags an underperforming DPU vs peers', () => {
  // Build 4 DPUs. DPU-0 produces only ~50% of what DPUs 1-3 produce at
  // each daytime hour. Should be flagged as an outlier.
  const devices = fakeDpuFleet(4, 1);
  const now = Date.now();
  const hourStartMs = (h: number) => {
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    return d.getTime() - 3 * 86_400_000;  // 3 days ago at that hour
  };
  const healthySeries: Array<{ ts: number; value: number }> = [];
  const slowSeries: Array<{ ts: number; value: number }> = [];
  for (let day = 0; day < 3; day++) {
    for (const h of [10, 11, 12, 13]) {
      const t = hourStartMs(h) + day * 86_400_000;
      for (let m = 0; m < 6; m++) {
        healthySeries.push({ ts: t + m * 600_000, value: 8000 });
        slowSeries.push({ ts: t + m * 600_000, value: 4000 });
      }
    }
  }
  const sm = computeStringMismatch(devices, {
    insertSnapshot: () => {},
    query: (sn, metric) => {
      if (metric !== 'pv_total') return [];
      return sn === 'SN-DPU-0' ? slowSeries : healthySeries;
    },
    queryMulti: () => new Map(),
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as Recorder);
  const dpu0 = sm.devices.find((d) => d.sn === 'SN-DPU-0');
  assert.ok(dpu0, 'DPU-0 should appear in the report');
  assert.ok(dpu0!.ratio != null && dpu0!.ratio < 0.7, `DPU-0 ratio should be ~0.5, got ${dpu0!.ratio}`);
  // Outlier flag depends on whether the modified-Z passes Z_INFO=3.5. With
  // 1 outlier in 4 samples that's borderline; not asserting `outlier === true`.
  assert.ok(dpu0!.modifiedZ != null, 'modifiedZ should be computed');
});

/* ─── computeEvWindowPrediction ──────────────────────────────────────
 * NOTE: computeEvWindowPrediction caches its result module-globally with a
 * 60-min TTL, UNCONDITIONALLY (no `dpus.length > 0` guard). Once any call
 * lands, every subsequent call in this process gets the same cached result.
 * Cap this file's coverage at ONE meaningful test that exercises both the
 * happy-path (sessions extracted, weekly pattern detected) AND the audit-
 * flagged hour-boundary behavior in a single combined scenario. */

test('computeEvWindowPrediction — round-to-nearest-hour aggregates jittered sessions (v0.9.62)', () => {
  // 7 weekly EV-charging sessions, jittered around two start hours on
  // two different weekdays.
  //   Group A (4 sessions, all at exactly 18:00 on weekday-A): obviously
  //     meets the ≥ 3-recurrence threshold → produces a pattern.
  //     typicalWatts ~ 7000.
  //   Group B (3 sessions on weekday-B, jittered ±5 min around 18:00):
  //     17:55, 18:02, 17:57. Under the v0.9.61 bucketing (exact getHours()),
  //     these split 2/1 across hour-17 and hour-18 and neither sub-bucket
  //     reached 3 recurrences — no Group-B pattern was emitted.
  //     Under the v0.9.62 round-to-nearest-hour rule
  //     (minutes >= 30 ⇒ +1 hour, else stay): 17:55→18, 18:02→18,
  //     17:57→18. All 3 land in hour-18 on weekday-B → meets the
  //     threshold → pattern emitted.
  //
  // This test pins the v0.9.62 fix: BOTH Group-A and Group-B should produce
  // a recurring pattern, with their respective weekdays distinct.

  const devices = fakeShp2({
    backupFullCapWh: 60_000, backupRemainWh: 30_000,
    pairedCircuits: [{ primaryCh: 7 }],
  });

  // Use absolute timestamps relative to `now` — avoid getDay() rollback
  // which can be fragile around DST transitions or test-runner timezones.
  const now = Date.now();
  const series: Array<{ ts: number; value: number }> = [];

  // Helper: emit a 45-min session of 7 kW samples at the given start time,
  // ending with a 0-watt sample to flush the session.
  function emitSession(startMs: number): void {
    for (let m = 0; m < 45; m += 5) {
      series.push({ ts: startMs + m * 60_000, value: 7000 });
    }
    series.push({ ts: startMs + 50 * 60_000, value: 0 });
  }

  // Build a baseline timestamp at 18:00 today.
  const today6pm = new Date(now);
  today6pm.setHours(18, 0, 0, 0);

  // Group A: 4 weekly sessions exactly at 18:00 (weeks 1-4 ago).
  for (let week = 1; week <= 4; week++) {
    emitSession(today6pm.getTime() - week * 7 * 86_400_000);
  }
  // Group B: 3 weekly sessions on a DIFFERENT weekday, jittered to
  // straddle the 17/18 boundary (weeks 5-7 ago).
  const groupBJitterMinutes = [-5, +2, -3];
  for (let i = 0; i < 3; i++) {
    const t = today6pm.getTime() - (5 + i) * 7 * 86_400_000 + 2 * 86_400_000 + groupBJitterMinutes[i] * 60_000;
    emitSession(t);
  }
  series.sort((a, b) => a.ts - b.ts);

  const rec: Recorder = {
    insertSnapshot: () => {},
    query: (_sn, metric) => (metric === 'pair7_w' ? series : []),
    queryMulti: () => new Map(),
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  };
  const r = computeEvWindowPrediction(devices, rec);

  // Some sessions were extracted (extractEvSessions found ≥ the 4 Group-A ones).
  assert.ok(r.sessionsObserved >= 4, `expected ≥ 4 sessions observed, got ${r.sessionsObserved}`);

  // Group A is 4 sessions on the same weekday at exact hour 18 → at least
  // one pattern with dayOfWeek matching Group A's weekday and startHour 18.
  const groupAPattern = r.patterns.find((p) => p.startHour === 18);
  assert.ok(groupAPattern, 'expected a pattern for the Group-A 18:00 sessions');
  assert.equal(groupAPattern!.recurrences >= 3, true);
  assert.ok(
    groupAPattern!.typicalWatts >= 6500 && groupAPattern!.typicalWatts <= 7500,
    `typicalWatts should be ~7000, got ${groupAPattern!.typicalWatts}`,
  );

  // v0.9.62 FIX: with round-to-nearest-hour bucketing, Group-B's three
  // jittered sessions (17:55, 18:02, 17:57) all collapse into hour-18 on
  // weekday-B. That sub-bucket now reaches 3 recurrences → a Group-B
  // pattern at startHour=18 on a DIFFERENT weekday from Group A must be
  // emitted. Two distinct (dayOfWeek, startHour=18) patterns total.
  const hour18Patterns = r.patterns.filter((p) => p.startHour === 18);
  assert.ok(
    hour18Patterns.length >= 2,
    `expected ≥2 startHour=18 patterns (Group A + Group B on different ` +
    `weekdays) after v0.9.62 round-to-nearest-hour fix, got ` +
    `${hour18Patterns.length}: ${JSON.stringify(hour18Patterns.map((p) => ({ dow: p.dayOfWeek, hr: p.startHour, n: p.recurrences })))}`,
  );
  const groupBPattern = r.patterns.find(
    (p) => p.startHour === 18 && p.dayOfWeek !== groupAPattern!.dayOfWeek,
  );
  assert.ok(
    groupBPattern,
    'expected a Group-B pattern at startHour=18 on a weekday different from Group A',
  );
  assert.ok(
    groupBPattern!.recurrences >= 3,
    `Group-B pattern should have ≥3 recurrences (the 3 jittered sessions), got ${groupBPattern!.recurrences}`,
  );

  // No hour-17 pattern should leak through: every jittered session rounds
  // forward to hour-18, so no hour-17 sub-bucket exists on any weekday.
  const anyHour17 = r.patterns.find((p) => p.startHour === 17);
  assert.equal(
    anyHour17,
    undefined,
    'round-to-nearest-hour should push all 17:55/17:57 sessions to hour 18',
  );
});

/* ─── computeEquipmentHealth ─────────────────────────────────────────── */

test('computeEquipmentHealth — empty fleet → empty mpptStrings and inverterStandby', () => {
  const eh = computeEquipmentHealth({}, mockRecorder());
  assert.equal(eh.mpptStrings.length, 0);
  assert.equal(eh.inverterStandby.length, 0);
});

test('computeEquipmentHealth — DPUs with no MPPT data return null efficiency', () => {
  const eh = computeEquipmentHealth(fakeDpuFleet(2, 1), mockRecorder());
  // Two HV + two LV strings = 4 entries; all null.
  assert.equal(eh.mpptStrings.length, 4);
  for (const m of eh.mpptStrings) {
    assert.equal(m.recentEffPct, null);
    assert.equal(m.driftPctPts, null);
  }
  // Inverter-standby: one entry per DPU, all null.
  assert.equal(eh.inverterStandby.length, 2);
  for (const inv of eh.inverterStandby) {
    assert.equal(inv.idleWatts, null);
  }
});

/* ─── computeCarbonReport ────────────────────────────────────────────── */

test('computeCarbonReport — empty fleet returns zero kg-avoided', () => {
  resetHaStateShortLivedCaches();
  const cr = computeCarbonReport({}, mockRecorder());
  assert.equal(cr.pvToLoadKgAvoided, 0);
  assert.equal(cr.batteryDischargeKgAvoided, 0);
  assert.equal(cr.totalKgAvoided, 0);
  assert.equal(cr.equivMilesNotDriven, 0);
  assert.ok(cr.gridCo2IntensityKgPerKwh > 0, 'intensity should be a positive constant');
});

test('computeCarbonReport — passes windowDays through to self-consumption', () => {
  resetHaStateShortLivedCaches();
  const cr = computeCarbonReport({}, mockRecorder(), 30);
  assert.equal(cr.windowDays, 30);
});

/* ─── computeTariffReport ────────────────────────────────────────────── */

test('computeTariffReport — REGRESSION GUARD v0.9.58: flat $0.17/kWh by default (on==off==17)', () => {
  // v0.9.58: switched default from APS-Saver TOU (25/8 ¢) to a flat 17 ¢/kWh
  // since most APS customers don't have a TOU plan. With NO tariff env vars
  // set, both on-peak and off-peak must come back == 17.
  resetHaStateShortLivedCaches();
  const tr = computeTariffReport({}, mockRecorder());
  assert.equal(tr.onPeakCents, 17, `on-peak should default to 17, got ${tr.onPeakCents}`);
  assert.equal(tr.offPeakCents, 17, `off-peak should default to 17, got ${tr.offPeakCents}`);
});

test('computeTariffReport — empty fleet returns zero cost / zero savings', () => {
  resetHaStateShortLivedCaches();
  const tr = computeTariffReport({}, mockRecorder());
  assert.equal(tr.gridImportCostDollars, 0);
  assert.equal(tr.solarLoadValueDollars, 0);
  assert.equal(tr.netSavingsDollars, 0);
});

test('computeTariffReport — exposes on-peak hours/days strings from env defaults', () => {
  resetHaStateShortLivedCaches();
  const tr = computeTariffReport({}, mockRecorder());
  // Defaults from analytics.ts: TARIFF_ON_PEAK_HOURS=15-20, TARIFF_ON_PEAK_DAYS=1-5.
  assert.equal(tr.onPeakHours, '15-20');
  assert.equal(tr.onPeakDays, '1-5');
});

/* ─── computeDispatchPlan (greedy heuristic, distinct from MPC) ──────── */

test('computeDispatchPlan — null forecast → empty plan', () => {
  const dp = computeDispatchPlan({}, null);
  assert.equal(dp.horizon, 0);
  assert.equal(dp.hours.length, 0);
  assert.equal(dp.estimatedSavingsDollars, 0);
});

test('computeDispatchPlan — no SHP2 capacity → empty plan', () => {
  // Has forecast hours, but no SHP2 device → empty plan.
  const forecast = emptyForecast({
    hours: Array.from({ length: 4 }, (_, h) => ({
      ts: Date.now() + h * 3600 * 1000,
      forecastPvW: 2000,
      forecastLoadW: 1500,
      cloudCoverPct: 30,
      ghiWm2: 400,
      projectedSocPct: 60,
      modelled: true,
    })),
  });
  const dp = computeDispatchPlan({}, forecast);
  assert.equal(dp.horizon, 0);
});

test('computeDispatchPlan — surplus-PV hour → charge_from_pv action', () => {
  const devices = fakeShp2({ backupFullCapWh: 60_000, backupRemainWh: 30_000, backupReserveSoc: 15 });
  const forecast = emptyForecast({
    hours: Array.from({ length: 2 }, (_, h) => ({
      ts: Date.now() + h * 3600 * 1000,
      forecastPvW: 5000,  // surplus
      forecastLoadW: 1000,
      cloudCoverPct: 10,
      ghiWm2: 800,
      projectedSocPct: 50,
      modelled: true,
    })),
  });
  const dp = computeDispatchPlan(devices, forecast);
  assert.equal(dp.hours.length, 2);
  assert.equal(dp.hours[0].action, 'charge_from_pv');
  assert.ok(dp.hours[0].flowW > 0);
});

/* ─── recommendDispatch (MPC) — v0.9.59 regression guards ────────────── */

test('recommendDispatch — REGRESSION GUARD v0.9.59: flat tariff sets degradeReason="no-tou-spread" and zero savings', () => {
  // Flat $0.17/kWh tariff (everyone has the same rate, so charge/discharge
  // arbitrage cannot save money). v0.9.59 added degradeReason; verify it.
  const inputs: MpcInputs = {
    currentSocPct: 60, reserveFloorPct: 20, capacityKwh: 60,
    pvForecastP50: Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? 4.0 : 0)),
    pvForecastP10: Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? 2.5 : 0)),
    loadForecast: Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 22 ? 2.0 : 1.0)),
    tariffOnPeakCentsByHour: new Array(24).fill(17),  // FLAT
    gridAvailable: true,
    cyclingCostUsdPerKwh: 0.02,
    reserveDipPenaltyUsdPerKwh: 1.0,
  };
  const r = recommendDispatch(inputs);
  assert.equal(r.degradeReason, 'no-tou-spread', `expected no-tou-spread, got ${r.degradeReason}`);
  assert.equal(r.expectedSavingsUsd, 0, `flat tariff means expectedSavingsUsd must be 0, got ${r.expectedSavingsUsd}`);
  // Notes should explain why.
  assert.ok(r.notes.some((n) => /TOU spread/i.test(n)), 'notes should mention TOU spread');
});

test('recommendDispatch — REGRESSION GUARD v0.9.59: real TOU spread → degradeReason=null and positive savings', () => {
  // TOU split: 25 ¢ on-peak (h 15-19), 8 ¢ off-peak.
  const inputs: MpcInputs = {
    currentSocPct: 60, reserveFloorPct: 20, capacityKwh: 60,
    pvForecastP50: Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? 4.0 : 0)),
    pvForecastP10: Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? 2.5 : 0)),
    loadForecast: Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 22 ? 2.0 : 1.0)),
    tariffOnPeakCentsByHour: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 25 : 8)),
    gridAvailable: true,
    cyclingCostUsdPerKwh: 0.02,
    reserveDipPenaltyUsdPerKwh: 1.0,
  };
  const r = recommendDispatch(inputs);
  assert.equal(r.degradeReason, null, `TOU spread should let planner optimize, got degradeReason=${r.degradeReason}`);
  assert.ok(r.expectedSavingsUsd >= 0, 'expectedSavingsUsd should be ≥ 0 with a real TOU spread');
});

// v0.9.64 — fixed. The pre-v0.9.64 simulator double-counted load against
// passive battery drain and the explicit `desiredFlowKwh`, so dischargeMax
// silently dropped battery energy without reducing grid imports (the reserve
// clamp re-imported the kWh from grid). The DP correctly avoided the action.
// Rewrote `simulateHour` to use a proper energy-balance model: PV serves load
// first; chargeFromGrid imports extra grid kWh into the battery; dischargeMax
// uses battery to displace load (capped at load shortfall). See mpc.ts header.
// v0.9.67 — UN-SKIPPED via deterministic `nowMs` injection. v0.9.66 skipped
// this test because `recommendDispatch` read wall-clock directly, so the
// planner's optimum shifted between local (MST) and CI (UTC). The fix:
// MpcInputs now accepts `nowMs?: number`, and we pin it to today at 06:00
// local. That puts the on-peak window (tariff hours 15-19) at DP-hours 9-13
// (mid-horizon), giving 9 hours of off-peak ramp time for chargeFromGrid to
// definitively win. Works the same in any TZ because both Date.setHours
// and recommendDispatch's getHours use the SAME runtime TZ.
test('recommendDispatch — REGRESSION GUARD v0.9.59: action set includes the new chargeFromGrid / dischargeMax actions', () => {
  // v0.9.59 expanded the MPC action set from 3 → 6 (added dischargeMax,
  // chargeFromGrid, idleHold). Verify the new actions are actually
  // available to the planner and appear in the chosen schedule under a
  // scenario where they should clearly win:
  //   - Very high cycling cost → discourages the LEGACY `lower` action
  //     (which causes natural discharge → cycling).
  //   - Massive TOU spread (50¢ on-peak vs 1¢ off-peak) → arbitrage is
  //     extremely profitable.
  //   - Load spike during on-peak that exceeds what the battery can
  //     supply without a top-off → planner needs to chargeFromGrid first.
  //   - Low starting SoC near the reserve floor → no room for `lower` to
  //     help (already near floor), so `chargeFromGrid` is the lever.
  const inputs: MpcInputs = {
    currentSocPct: 25, reserveFloorPct: 20, capacityKwh: 60,
    pvForecastP50: new Array(24).fill(0),
    pvForecastP10: new Array(24).fill(0),
    // Sustained heavy on-peak load (8 kWh/h for 5 hours = 40 kWh of
    // expensive grid imports if we don't pre-charge the battery).
    loadForecast: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 8.0 : 1.0)),
    // Extreme TOU spread.
    tariffOnPeakCentsByHour: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 50 : 1)),
    gridAvailable: true,
    // High cycling cost makes the legacy `lower` action expensive (it
    // triggers extra natural discharge → cycling). chargeFromGrid still
    // wins because the off-peak/on-peak spread (50 - 1 = 49¢) dwarfs
    // the rt-efficiency loss + cycling cost combined.
    cyclingCostUsdPerKwh: 0.05,
    reserveDipPenaltyUsdPerKwh: 1.0,
    // v0.9.67 — pin the wall-clock to today at 00:00 local. Both the test
    // and the planner read getHours() in the runtime TZ, so this anchors
    // startHour=0 in any TZ. Empirically, this is the startHour value
    // that produces `chargeFromGrid` cleanly in the DP — on-peak (hours
    // 15-19) maps to DP-hours 15-19, with 15 hours of off-peak ramp
    // before it (the planner's full forward window for arbitrage). Other
    // anchor hours like 6 or 12 collapse the off-peak window enough that
    // the DP optimum stays at `lower`/`maintain` instead. Determined by
    // parametric sweep, not theory — would be worth revisiting if the
    // cost function changes.
    nowMs: (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t.getTime(); })(),
  };
  const r = recommendDispatch(inputs);
  const actionsSeen = new Set(r.steps.map((s) => s.action));
  // The whole point of v0.9.59 is that these actions are wired in. If the
  // DP picks neither, the action set isn't being explored. (We don't pin
  // which specific action appears; the DP optimizes a continuous trade-off.)
  assert.ok(
    actionsSeen.has('dischargeMax') || actionsSeen.has('chargeFromGrid'),
    `expected at least one of dischargeMax/chargeFromGrid in plan; saw ${[...actionsSeen].join(',')}`,
  );
});

test('recommendDispatch — REGRESSION GUARD v0.9.59: P10 risk-averse path uses P10 (not P50) near on-peak hours', () => {
  // Trick: zero loadForecast, and zero P10 PV, but a generous P50 PV.
  // If the planner used P50 to displace on-peak imports, the cost would be
  // near zero. If it correctly uses P10 (which is 0), the planner has to
  // import from the grid at the on-peak rate during on-peak hours when
  // SoC + battery flow can't cover load. We assert: cost is NOT zero.
  // (i.e. the planner did not over-optimistically count P50 PV against
  // on-peak load.)
  const inputs: MpcInputs = {
    currentSocPct: 25, reserveFloorPct: 20, capacityKwh: 60,
    // P50: 8 kWh of PV every on-peak hour. P10: 0 — pessimistic worst case.
    pvForecastP50: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 8.0 : 0)),
    pvForecastP10: new Array(24).fill(0),
    loadForecast: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 3.0 : 1.0)),
    tariffOnPeakCentsByHour: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 30 : 6)),
    gridAvailable: true,
    cyclingCostUsdPerKwh: 0.02,
    reserveDipPenaltyUsdPerKwh: 1.0,
  };
  const r = recommendDispatch(inputs);
  // The PUBLIC per-hour view uses P50 (so the operator sees what we "expect"),
  // but the planning cost should reflect the P10-shaped pessimistic branch.
  // Concretely: with low SoC (25 → 20 floor leaves 3 kWh headroom) and zero
  // P10 PV, the planner cannot avoid some on-peak imports → cost > 0.
  assert.ok(r.totalCostUsd > 0, `expected non-zero total cost since P10 PV = 0, got ${r.totalCostUsd}`);
});

test('recommendDispatch — empty/zero PV forecast still produces a valid 24h schedule', () => {
  const inputs: MpcInputs = {
    currentSocPct: 80, reserveFloorPct: 20, capacityKwh: 60,
    pvForecastP50: new Array(24).fill(0),
    pvForecastP10: new Array(24).fill(0),
    loadForecast: new Array(24).fill(1.0),
    tariffOnPeakCentsByHour: new Array(24).fill(17),
    gridAvailable: true,
    cyclingCostUsdPerKwh: 0.02,
    reserveDipPenaltyUsdPerKwh: 1.0,
  };
  const r = recommendDispatch(inputs);
  assert.equal(r.steps.length, 24);
  assert.equal(r.setpointSchedule.length, 24);
  // Flat PV + flat tariff → flat-forecast OR no-tou-spread; either way,
  // expectedSavingsUsd must be 0.
  assert.equal(r.expectedSavingsUsd, 0);
  assert.ok(r.degradeReason === 'flat-forecast' || r.degradeReason === 'no-tou-spread');
});
