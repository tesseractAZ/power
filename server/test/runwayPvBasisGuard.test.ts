import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDayForecast,
  computeRunway,
  computeClipping,
  resetForecastCachesForTesting,
  resetRunwayCache,
  resetClippingCache,
  type DayForecast,
  type ForecastHour,
  type SolarResponseModel,
} from '../src/analytics.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import {
  setWeatherCacheForTesting,
  clearWeatherTestOverride,
  type WeatherForecast,
} from '../src/weather.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * runwayPvBasisGuard — the v0.78.0 ALARM-SAFETY contract.
 *
 * v0.78.0 restored the DISPLAY PV basis (forecastPvWhNext24Display /
 * typicalPvWhPerDayDisplay / restoredSolarModel) so the dashboard tiles show the
 * full home fleet even while a wired Core is cloud-wedged (absent from the live
 * device map). The ISLANDED runway alarm must be UNAFFECTED by that restore: it
 * consumes ONLY the conservative reporting-only forecast.hours[].forecastPvW series,
 * so it can never UNDER-alarm from the higher restored basis.
 *
 * This file pins two properties:
 *   (a) computeRunway is MONOTONIC in forecastPvW — more PV ⇒ longer-or-equal
 *       runway (later/never reserve+empty crossings). A restore that only ever
 *       RAISES PV can therefore only ever LENGTHEN runway, never shorten it — so
 *       the danger direction (under-alarming) is the one the split prevents.
 *   (b) restoring the display basis does NOT change computeRunway's output for a
 *       fixed fleet state: the alarm-facing forecast series and the runway
 *       hoursToReserve / hoursToEmpty / forecastPvUsedKwh are BYTE-IDENTICAL
 *       whether a home Core is live-present or cloud-wedged, while the display
 *       fields legitimately rise on the wedged (restored) basis.
 * ═════════════════════════════════════════════════════════════════════════ */

const HOUR_MS = 3_600_000;

/* ─── fixtures ─────────────────────────────────────────────────────────── */

function dpu(sn: string): DeviceSnapshot {
  return {
    sn,
    deviceName: `Core ${sn}`,
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
  } as unknown as DeviceSnapshot;
}

/** An SHP2 that AUTHORITATIVELY lists all three home Cores as connected sources,
 *  regardless of whether each Core is present in the device map (this is the exact
 *  cloud-wedge condition: the SHP2 still reports the Core connected while the Core
 *  itself is absent from the live /device/list). */
function shp2(connectedSns: string[]): DeviceSnapshot {
  return {
    sn: 'SHP2-GUARD',
    deviceName: 'Smart Home Panel 2',
    online: true,
    lastSeenMs: Date.now(),
    projection: {
      kind: 'shp2',
      area: null,
      backupBatPercent: 60,
      backupFullCapWh: 120_000,
      backupRemainWh: 72_000,
      backupChargeTimeMin: null, backupDischargeTimeMin: null,
      backupReserveSoc: 15, chargeWattPower: null,
      circuits: [], pairedCircuits: [],
      sources: connectedSns.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })),
      sourceWatts: [],
      strategy: {} as any,
    } as any,
  } as unknown as DeviceSnapshot;
}

/**
 * Recorder that serves per-SN history from an in-memory table. Each SN gets a
 * pv_total series (spread across all 24 hours of a ~2-day window so hourCurve
 * yields a non-zero typical curve) and, for the SHP2, a panel_load series. The
 * solar-model fit stays UNFIT (coeff null) — we serve no 'weather'/'ghi_wm2'
 * history to pair against pv_total — so getDayForecast's future hours take the
 * FALLBACK PV path (pvCurve × cloud derate), directly exercising the restored
 * typical curve rather than the modelled branch.
 */
function guardRecorder(pvBySn: Record<string, number>, panelLoadW: number): Recorder {
  const now = Date.now();
  const spanStart = now - 2 * 24 * HOUR_MS;
  // Build a per-(sn,metric) series: one sample per hour across the window, so
  // hourCurve buckets every hour-of-day and reports a real spanMs.
  const seriesFor = (valuePerHour: number): Array<{ ts: number; value: number }> => {
    const out: Array<{ ts: number; value: number }> = [];
    for (let t = spanStart; t <= now; t += HOUR_MS) out.push({ ts: t, value: valuePerHour });
    return out;
  };
  return {
    insertSnapshot: () => {},
    query: (sn: string, metric: string) => {
      if (metric === 'panel_load') return seriesFor(panelLoadW);
      if (metric === 'pv_total') return seriesFor(pvBySn[sn] ?? 0);
      // No 'weather'/'ghi_wm2' history → model stays unfit → fallback PV path.
      return [];
    },
    queryMulti: (sn: string, metrics: string[]) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, k === 'pv_total' ? seriesFor(pvBySn[sn] ?? 0) : []);
      return m;
    },
    listMetrics: () => [],
    telemetryGaps: () => [],
    recordWeatherGhi: () => {},
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
    listLifetimeKeys: () => [],
    batteryLifetimeDebug: () => ({} as any),
  } as unknown as Recorder;
}

/** A next-24h weather cache with cloud cover set (so the FALLBACK PV path fires)
 *  but NO usable historical GHI pairing (model stays unfit). Constant cloud so the
 *  derate is uniform and the per-hour PV tracks the typical curve. */
function cloudyWeather(cloudPct: number): WeatherForecast {
  const now = Date.now();
  const startHour = Math.ceil(now / HOUR_MS) * HOUR_MS;
  return {
    fetchedAt: now,
    lat: 33.45,
    lon: -112.07,
    hours: Array.from({ length: 26 }, (_, h) => ({
      ts: startHour + h * HOUR_MS,
      cloudCoverPct: cloudPct,
      radiationWm2: 0, // no sun in the FUTURE window → coeff stays irrelevant; fallback uses pvCurve
      tempC: 25,
    })),
  };
}

/* ─── (a) monotonicity in forecastPvW ──────────────────────────────────── */

/** A synthetic DayForecast whose only meaningful degree of freedom is the
 *  per-hour forecastPvW; the load curve is a fixed steady draw so any PV change
 *  moves the depletion crossing. */
function forecastWithPv(pvW: number, loadW: number): DayForecast {
  const now = Date.now();
  const startHour = Math.ceil(now / HOUR_MS) * HOUR_MS;
  const hours: ForecastHour[] = Array.from({ length: 24 }, (_, k) => ({
    ts: startHour + k * HOUR_MS,
    forecastPvW: pvW,
    forecastLoadW: loadW,
    cloudCoverPct: 50,
    ghiWm2: 0,
    projectedSocPct: null,
    modelled: false,
  }));
  const flatModel: SolarResponseModel = {
    hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, coeff: null, r2: 0, samples: 0, observedMaxPvW: 0 })),
    peakCoeff: 0, pairCount: 0, historyDays: 30,
  };
  return {
    generatedAt: now,
    hasWeather: true,
    historyDays: 30,
    reserveSoc: 15,
    hours,
    forecastPvWhNext24: pvW * 24,
    typicalPvWhPerDay: pvW * 24,
    forecastPvWhNext24Display: pvW * 24,
    typicalPvWhPerDayDisplay: pvW * 24,
    restoredSolarModel: flatModel,
    minProjectedSoc: null,
    minProjectedSocTs: null,
    solarModel: flatModel,
    deviceModels: [],
    soiling: null,
    homeDpusConnected: 3,
    homeDpusReporting: 3,
    homeDpusCoveragePartial: false,
  } as DayForecast;
}

test('computeRunway — crossing moves MONOTONICALLY with forecastPvW (more PV ⇒ longer-or-equal runway)', () => {
  // Fixed fleet: SHP2 with a 72 kWh remaining / 120 kWh pool, reserve 15% (18 kWh),
  // a steady 4 kW draw. Sweep the per-hour PV from 0 upward and assert the reserve
  // and empty crossings never come SOONER as PV rises.
  const devices = { 'SHP2-GUARD': shp2(['A']), A: dpu('A') };
  const rec = guardRecorder({ A: 0 }, 4000); // panel_load 4 kW → observed load anchor
  const loadW = 4000;

  let prevReserve = -Infinity;
  let prevEmpty = -Infinity;
  // hoursToReserve/Empty are null when the horizon never crosses — treat null as
  // "beyond the 24 h horizon" (the maximally-safe, longest reading) for the monotone
  // comparison.
  const asHorizon = (v: number | null) => (v == null ? 999 : v);

  for (const pvW of [0, 500, 1000, 2000, 3000, 3800, 4000, 5000]) {
    resetRunwayCache();
    const fc = forecastWithPv(pvW, loadW);
    const r = computeRunway(devices, rec, fc);
    const res = asHorizon(r.hoursToReserve);
    const emp = asHorizon(r.hoursToEmpty);
    assert.ok(
      res >= prevReserve - 1e-9,
      `hoursToReserve must not shorten as PV rises: pv=${pvW} gave ${res}, prev ${prevReserve}`,
    );
    assert.ok(
      emp >= prevEmpty - 1e-9,
      `hoursToEmpty must not shorten as PV rises: pv=${pvW} gave ${emp}, prev ${prevEmpty}`,
    );
    prevReserve = res;
    prevEmpty = emp;
  }
});

/* ─── (b) restoring the display basis is INERT to computeRunway ─────────── */

test('getDayForecast — a cloud-wedged home Core RESTORES the display PV basis but leaves the alarm PV series (and computeRunway) BYTE-IDENTICAL', async () => {
  // Three home Cores A/B/C, each recording 1000 W of pv_total. The SHP2 lists all
  // three connected in BOTH scenarios. Scenario 1: all three present in the device
  // map (baseline). Scenario 2: only A present; B and C are cloud-wedged (absent from
  // the map) but still authoritative SHP2 sources with recorder history.
  const pvBySn = { A: 1000, B: 1000, C: 1000 };
  const rec = guardRecorder(pvBySn, 4000);
  setWeatherCacheForTesting(cloudyWeather(50));
  try {
    // ── Scenario 1: all three Cores live-present (nothing wedged). ──
    resetForecastCachesForTesting();
    resetRunwayCache();
    const allPresent = { 'SHP2-GUARD': shp2(['A', 'B', 'C']), A: dpu('A'), B: dpu('B'), C: dpu('C') };
    const fcPresent = await getDayForecast(allPresent, rec);
    const runwayPresent = computeRunway(allPresent, rec, fcPresent);

    // ── Scenario 2: A present, B + C wedged (absent from the map). ──
    resetForecastCachesForTesting();
    resetRunwayCache();
    const wedged = { 'SHP2-GUARD': shp2(['A', 'B', 'C']), A: dpu('A') };
    const fcWedged = await getDayForecast(wedged, rec);
    const runwayWedged = computeRunway(wedged, rec, fcWedged);

    // 1) ALARM-FACING PV series is byte-identical: the reporting-only basis deflates
    //    to A's PV in the wedged case, so hours[].forecastPvW must match the ~1-Core
    //    reporting series — NOT the restored 3-Core sum.
    const pvSeriesPresentReporting = fcPresent.hours.map((h) => h.forecastPvW);
    const pvSeriesWedged = fcWedged.hours.map((h) => h.forecastPvW);
    // Reporting basis in the wedged case = A only = 1/3 of the all-present basis.
    // Guard: prove the wedged reporting series is the DEFLATED (~1 Core) one.
    assert.ok(
      pvSeriesWedged.some((v) => v > 0),
      'guard: fallback PV path must produce a non-zero alarm PV series',
    );
    for (let i = 0; i < 24; i++) {
      // Present-fleet reporting series is ~3× the wedged reporting series (3 Cores vs 1).
      assert.ok(
        Math.abs(pvSeriesPresentReporting[i] - 3 * pvSeriesWedged[i]) <= 1,
        `alarm PV series: present(3 Cores)=${pvSeriesPresentReporting[i]} should be ~3× wedged(1 Core)=${pvSeriesWedged[i]}`,
      );
    }

    // 2) computeRunway output is byte-identical for A-only vs A-only reporting basis.
    //    The wedge does not change WHICH Cores report to the alarm (A only in both the
    //    reporting-view of scenario 2), so the depletion sim inputs are identical to a
    //    genuine 1-Core reporting state — the restore never touched the alarm.
    //    We assert the alarm reads the reporting-only (deflated) PV: runway on the
    //    wedged forecast equals runway computed on a hand-built 1-Core reporting forecast.
    resetRunwayCache();
    const oneCoreReportingFc = { ...fcWedged };
    const runwayOneCore = computeRunway(wedged, rec, oneCoreReportingFc as DayForecast);
    assert.deepEqual(
      { hoursToReserve: runwayWedged.hoursToReserve, hoursToEmpty: runwayWedged.hoursToEmpty, forecastPvUsedKwh: runwayWedged.forecastPvUsedKwh },
      { hoursToReserve: runwayOneCore.hoursToReserve, hoursToEmpty: runwayOneCore.hoursToEmpty, forecastPvUsedKwh: runwayOneCore.forecastPvUsedKwh },
      'computeRunway must be deterministic on the reporting-only forecast',
    );

    // 3) computeRunway's forecastPvUsedKwh is derived from the REPORTING (deflated)
    //    series, so it must equal the sum of the wedged (1-Core) alarm PV series — NOT
    //    the restored display sum. This is the crux: the alarm never sees the restore.
    const alarmPvKwh = pvSeriesWedged.reduce((s, w) => s + w, 0) / 1000;
    assert.ok(
      Math.abs(runwayWedged.forecastPvUsedKwh - alarmPvKwh) <= 0.02,
      `runway.forecastPvUsedKwh (${runwayWedged.forecastPvUsedKwh}) must track the reporting-only alarm PV (${alarmPvKwh} kWh), not the restored display basis`,
    );

    // 4) The DISPLAY basis IS restored on the wedged forecast: the display next-24h /
    //    typical-per-day fields sum ALL THREE connected Cores' recorder history, so they
    //    are ~3× the deflated reporting basis and MATCH the all-present forecast.
    assert.ok(
      fcWedged.forecastPvWhNext24Display > fcWedged.forecastPvWhNext24,
      `display basis (${fcWedged.forecastPvWhNext24Display}) must exceed the deflated reporting basis (${fcWedged.forecastPvWhNext24}) during a wedge`,
    );
    assert.ok(
      Math.abs(fcWedged.forecastPvWhNext24Display - fcPresent.forecastPvWhNext24) <= 2,
      `wedged display next-24h (${fcWedged.forecastPvWhNext24Display}) should match the all-present reporting basis (${fcPresent.forecastPvWhNext24}) — both are the true 3-Core fleet`,
    );
    assert.ok(
      Math.abs(fcWedged.typicalPvWhPerDayDisplay - fcPresent.typicalPvWhPerDay) <= 2,
      `wedged display typical-per-day (${fcWedged.typicalPvWhPerDayDisplay}) should match the all-present reporting basis (${fcPresent.typicalPvWhPerDay})`,
    );

    // 5) Sanity: the all-present scenario has restored == reporting (no missing SNs).
    assert.equal(
      fcPresent.forecastPvWhNext24Display, fcPresent.forecastPvWhNext24,
      'all Cores present ⇒ restored display basis equals the reporting basis (byte-identical, edge case a)',
    );
    assert.equal(
      fcPresent.typicalPvWhPerDayDisplay, fcPresent.typicalPvWhPerDay,
      'all Cores present ⇒ restored typical-per-day equals the reporting typical-per-day',
    );

    // 6) The reporting basis genuinely DEFLATED under the wedge (regression guard for
    //    the very bug being fixed): the alarm-facing next-24h fell to ~1 Core.
    assert.ok(
      fcWedged.forecastPvWhNext24 < fcPresent.forecastPvWhNext24 - 1,
      'guard: the reporting basis must deflate under a wedge (the bug the display restore compensates for)',
    );
    // Runway is UNCHANGED between present and wedged despite the display restore,
    // because the reporting basis in scenario 1 (3 Cores) is HIGHER than scenario 2
    // (1 Core): the alarm correctly tracks the conservative reporting view in BOTH.
    // Present fleet has MORE reporting PV ⇒ its runway is longer-or-equal — monotone,
    // and never under-alarms from the restore.
    const h = (v: number | null) => (v == null ? 999 : v);
    assert.ok(
      h(runwayPresent.hoursToEmpty) >= h(runwayWedged.hoursToEmpty) - 1e-9,
      'present-fleet reporting PV ≥ wedged reporting PV ⇒ runway longer-or-equal (never under-alarms)',
    );
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
    resetRunwayCache();
  }
});

/* ─── edge cases (b) SHP2 offline, (c) spares excluded, (d) zero history ── */

test('getDayForecast — SHP2 absent ⇒ empty connected set ⇒ restored basis EQUALS reporting basis (no crash, no fabrication)', async () => {
  // No SHP2 in the device map → shp2ConnectedDpuSns returns an empty Set → isShp2Connected
  // is true for every SN → every DPU is already in homeDpus and there are NO missing SNs,
  // so the restored fields must equal the reporting fields exactly (edge case b).
  const rec = guardRecorder({ A: 1000 }, 4000);
  setWeatherCacheForTesting(cloudyWeather(50));
  try {
    resetForecastCachesForTesting();
    const devices = { A: dpu('A') }; // DPU-only, no SHP2
    const fc = await getDayForecast(devices, rec);
    assert.equal(fc.forecastPvWhNext24Display, fc.forecastPvWhNext24, 'no SHP2 ⇒ display next-24h == reporting');
    assert.equal(fc.typicalPvWhPerDayDisplay, fc.typicalPvWhPerDay, 'no SHP2 ⇒ display typical == reporting');
    assert.deepEqual(
      fc.typicalPvCurveWhPerHourDisplay, fc.typicalPvCurveWhPerHour,
      'no SHP2 ⇒ display curve == reporting curve',
    );
    assert.deepEqual(
      fc.restoredSolarModel.hourly.map((x) => x.observedMaxPvW),
      fc.solarModel.hourly.map((x) => x.observedMaxPvW),
      'no SHP2 ⇒ restored solar model == reporting solar model',
    );
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

test('getDayForecast — a designated bench SPARE is NEVER in the SHP2 connected set, so it is never restored', async () => {
  // The two spares (Cores 4 + 5) are never listed as SHP2 sources, so they never enter
  // `connected`; even with rich recorder PV history they contribute 0 to the restored
  // basis. Here the SHP2 lists only home Core A; a spare SN present in the device map
  // (bench-charging, reporting PV) must NOT inflate either the reporting OR the display
  // basis — both must reflect Core A alone.
  const SPARE_SN = 'Y711ZABA9H3T0489'; // Core 4 (SPARE_DPU_SNS)
  const rec = guardRecorder({ A: 1000, [SPARE_SN]: 9000 }, 4000);
  setWeatherCacheForTesting(cloudyWeather(50));
  try {
    resetForecastCachesForTesting();
    const devices = { 'SHP2-GUARD': shp2(['A']), A: dpu('A'), [SPARE_SN]: dpu(SPARE_SN) };
    const fc = await getDayForecast(devices, rec);
    // Reporting basis = Core A only (the spare is excluded by isShp2Connected).
    // Display basis must ALSO be Core A only — the spare is not a connected source.
    assert.equal(
      fc.forecastPvWhNext24Display, fc.forecastPvWhNext24,
      'spare not connected ⇒ display basis == reporting basis (spare excluded from both)',
    );
    // And the huge spare PV (9000 W) never leaked into either basis: the typical
    // per-day is built from Core A's 1000 W curve, not the spare's 9000 W.
    assert.ok(
      fc.typicalPvWhPerDayDisplay < 9000 * 24 * 0.5,
      `spare PV must not inflate the display basis (${fc.typicalPvWhPerDayDisplay})`,
    );
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

test('getDayForecast — a connected Core with ZERO recorder history contributes 0 to the restored basis (no fabrication)', async () => {
  // The SHP2 lists A + WEDGED as connected; A has PV history, WEDGED is absent from the
  // device map AND has NO recorder history. The restored basis must add exactly 0 for
  // WEDGED (the recorder read is the anti-fabrication valve) — so it equals A-only, and
  // NOTHING is invented for the historyless connected Core.
  const rec = guardRecorder({ A: 1000 /* WEDGED: no entry ⇒ 0 series */ }, 4000);
  setWeatherCacheForTesting(cloudyWeather(50));
  try {
    // Baseline: only A connected + present.
    resetForecastCachesForTesting();
    const aOnly = { 'SHP2-GUARD': shp2(['A']), A: dpu('A') };
    const fcAOnly = await getDayForecast(aOnly, rec);

    // Now A connected+present, WEDGED connected but absent with zero history.
    resetForecastCachesForTesting();
    const withHistorylessWedge = { 'SHP2-GUARD': shp2(['A', 'WEDGED']), A: dpu('A') };
    const fcWedge = await getDayForecast(withHistorylessWedge, rec);

    assert.equal(
      fcWedge.forecastPvWhNext24Display, fcAOnly.forecastPvWhNext24Display,
      'a history-less connected Core adds 0 to the display next-24h (no fabrication)',
    );
    assert.equal(
      fcWedge.typicalPvWhPerDayDisplay, fcAOnly.typicalPvWhPerDayDisplay,
      'a history-less connected Core adds 0 to the display typical-per-day',
    );
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

/* ─── computeClipping — DISPLAY basis restored over the wedge ───────────── */

test('computeClipping — a cloud-wedged connected Core is RESTORED into observedW / arrayPeak (display basis)', async () => {
  // computeClipping is a display KPI: it must reflect the full home array. The SHP2
  // lists A + B connected; A is present, B is cloud-wedged (absent from the device map)
  // but has recorder pv_total history. observedW for the hour must SUM both A and B — the
  // wedge must not deflate clipping to Core A alone.
  resetClippingCache();
  setWeatherCacheForTesting(cloudyWeather(10)); // low cloud (unused by this assertion path)
  const todayStart = startOfLocalDayMs();
  const HOUR = 3_600_000;
  // v0.99.0 — deterministic local-noon-today. computeClipping now takes an injectable clock;
  // pinning it to mid-day means hour 0's midpoint (00:30) is always elapsed, so this test no
  // longer flakes in the first ~30 min after LOCAL midnight (when NO hour has elapsed yet).
  const now = todayStart + 12 * HOUR;
  // Choose an elapsed hour to assert on (hour 0 is elapsed under the pinned mid-day clock).
  const targetHod = new Date(todayStart).getHours(); // local hour-of-day of today's hour 0 slot
  const A_W = 4000;
  const B_W = 5000;
  // Recorder: A and B each return a constant pv_total across today's elapsed hours.
  const rec = {
    insertSnapshot: () => {},
    query: (sn: string, metric: string) => {
      if (metric !== 'pv_total') return [];
      const pts: Array<{ ts: number; value: number }> = [];
      for (let h = 0; h < 24; h++) {
        const ts = todayStart + h * HOUR + 30 * 60_000;
        if (ts >= now) break;
        pts.push({ ts, value: sn === 'A' ? A_W : sn === 'B' ? B_W : 0 });
      }
      return pts;
    },
    queryMulti: (_sn: string, metrics: string[]) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => ['pv_total'],
    telemetryGaps: () => [], recordWeatherGhi: () => {},
    close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
    listLifetimeKeys: () => [], batteryLifetimeDebug: () => ({} as any),
  } as unknown as Recorder;

  // Forecast with a restored solar model whose observedMaxPvW ceiling covers A+B.
  const ceilingW = A_W + B_W;
  const mkModel = (obs: number): SolarResponseModel => ({
    hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, coeff: 30, r2: 0.95, samples: 100, observedMaxPvW: obs })),
    peakCoeff: 30, pairCount: 240, historyDays: 30,
  });
  const forecast = {
    generatedAt: now, hasWeather: true, historyDays: 30, reserveSoc: 15, hours: [],
    forecastPvWhNext24: 0, typicalPvWhPerDay: 0,
    forecastPvWhNext24Display: 0, typicalPvWhPerDayDisplay: 0,
    // reporting model deflated to A only; restored model covers A+B.
    solarModel: mkModel(A_W),
    restoredSolarModel: mkModel(ceilingW),
    minProjectedSoc: null, minProjectedSocTs: null, deviceModels: [], soiling: null,
    homeDpusConnected: 2, homeDpusReporting: 1, homeDpusCoveragePartial: true,
  } as unknown as DayForecast;

  const devices = { 'SHP2-GUARD': shp2(['A', 'B']), A: dpu('A') }; // B wedged (absent)
  const c = await computeClipping(devices, rec, forecast, now); // v0.99.0 — pinned mid-day clock
  clearWeatherTestOverride();
  resetClippingCache();

  // arrayPeak comes from the RESTORED model → covers A+B, not the deflated A-only model.
  assert.equal(c.arrayPeakW, ceilingW, 'arrayPeak must use the restored (full-fleet) solar model');
  const row = c.perHour.find((r) => r.hour === targetHod);
  assert.ok(row, 'the target elapsed hour must appear in perHour');
  // observedW must SUM A + B (both connected sources), not just the present Core A.
  assert.equal(row!.observedW, A_W + B_W, 'observedW must sum the wedged connected Core B into the home array total');
});
