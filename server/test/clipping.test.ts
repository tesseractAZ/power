import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeClipping,
  resetHaStateShortLivedCaches,
  type DayForecast,
} from '../src/analytics.js';
import {
  setWeatherCacheForTesting,
  clearWeatherTestOverride,
  type WeatherForecast,
} from '../src/weather.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ─── computeClipping — POSITIVE path ───────────────────────────────────
 *
 * The existing dispatch.test.ts coverage exercises only the degenerate
 * exits (null forecast, empty fleet). The v0.69–v0.75 churn left the
 * actual clipping arithmetic unpinned. These tests drive the positive
 * branch: observed PV sits AT the array ceiling while the learned model
 * says the array *could* have produced more, so `clippedW > 0`.
 *
 * Determinism strategy:
 *   - `computeClipping` walks LOCAL hour-of-day (`new Date(hourStart)
 *     .getHours()`) from `startOfLocalDayMs()` up to `now`, so the test
 *     synthesises pv_total + weather relative to those same two anchors
 *     and only ever asserts on hours that are strictly elapsed.
 *   - The weather cache is pinned via `setWeatherCacheForTesting`; the
 *     short-lived clipping cache is cleared via
 *     `resetHaStateShortLivedCaches` before each case.
 * ─────────────────────────────────────────────────────────────────── */

const ARRAY_PEAK_W = 15_000;
const CLIPPING_PEAK_FRAC = 0.95;             // mirrors the constant in analytics.ts
const DAYLIGHT_GHI = 20;                     // mirrors the constant in analytics.ts
const HOUR_MS = 3_600_000;

const DPU_SN = 'DPU-HOME-1';

/**
 * Minimal SHP2 + one connected DPU. The SHP2's `sources` declare the DPU
 * as connected so `shp2ConnectedDpuSns` / `homeConnectedDpus` treat it as
 * a "home" array — the same fixture shape curtailment.test.ts uses.
 */
function buildDevices(): Record<string, DeviceSnapshot> {
  const dpu = {
    sn: DPU_SN,
    deviceName: 'Core 1',
    productName: 'Delta Pro Ultra',
    online: true,
    lastUpdated: Date.now(),
    projection: { kind: 'dpu', soc: 80, packs: [] },
  } as unknown as DeviceSnapshot;
  const shp2 = {
    sn: 'SHP2-1',
    deviceName: 'SHP2',
    productName: 'Smart Home Panel 2',
    online: true,
    lastUpdated: Date.now(),
    projection: {
      kind: 'shp2',
      sources: [{ slot: 1, sn: DPU_SN, isConnected: true }],
    },
  } as unknown as DeviceSnapshot;
  return { [DPU_SN]: dpu, 'SHP2-1': shp2 };
}

/**
 * A 24-hour solar model. `coeff` is W of PV per W/m² of GHI; `observedMaxPvW`
 * sets the per-hour ceiling whose max becomes `arrayPeakW`. We give every
 * hour the same ceiling so `arrayPeakW === ARRAY_PEAK_W`.
 */
function buildForecast(coeffByHour: (h: number) => number | null): DayForecast {
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
    solarModel: {
      hourly: Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        coeff: coeffByHour(h),
        r2: 0.95,
        samples: 100,
        observedMaxPvW: ARRAY_PEAK_W,
      })),
      peakCoeff: 5,
      pairCount: 240,
      historyDays: 30,
    },
    deviceModels: [],
    soiling: null,
  } as unknown as DayForecast;
}

/**
 * Synthesise a full-day weather forecast keyed on the same absolute UTC
 * hour-epoch that `computeClipping` buckets on (`Math.floor(ts/3.6e6)`).
 * GHI is constant so every elapsed daylight hour gets a model output.
 */
function buildWeather(ghi: number): WeatherForecast {
  const todayStart = startOfLocalDayMs();
  return {
    fetchedAt: Date.now(),
    lat: 33.45,
    lon: -112.07,
    hours: Array.from({ length: 24 }, (_, h) => ({
      ts: todayStart + h * HOUR_MS,
      cloudCoverPct: 10,
      radiationWm2: ghi,
      tempC: 30,
      ensembleSources: 1,
    })),
  };
}

/**
 * Build a mock Recorder whose pv_total series places `wattsByHour(h)` watts
 * in every minute-bucket of local hour-of-day `h` (relative to today's
 * local midnight). `computeClipping` averages the buckets, so a constant
 * value per hour reproduces exactly that mean.
 */
function recorderWithPv(wattsByHour: (hourOfDay: number) => number): Recorder {
  const todayStart = startOfLocalDayMs();
  return {
    insertSnapshot: () => {},
    query: (_sn, metric) => {
      if (metric !== 'pv_total') return [];
      const pts: Array<{ ts: number; value: number }> = [];
      for (let h = 0; h < 24; h++) {
        // one sample mid-hour is enough; the engine averages within the hour
        const ts = todayStart + h * HOUR_MS + 30 * 60_000;
        pts.push({ ts, value: wattsByHour(h) });
      }
      return pts;
    },
    queryMulti: (_sn, metrics) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => ['pv_total'],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

/** Local hours-of-day that are fully or partially elapsed at `now`. */
function elapsedHours(): number[] {
  const todayStart = startOfLocalDayMs();
  const now = Date.now();
  const out: number[] = [];
  for (let h = 0; h < 24; h++) {
    if (todayStart + h * HOUR_MS < now) out.push(h);
  }
  return out;
}

test('computeClipping — clippedW>0 ONLY at the array ceiling; never negative; partial-hour weighted', async () => {
  resetHaStateShortLivedCaches();
  clearWeatherTestOverride();

  const elapsed = elapsedHours();
  // Need at least two distinct elapsed hours to contrast peak vs non-peak.
  // (Right after local midnight there may be only hour 0; skip then.)
  if (elapsed.length < 2) {
    clearWeatherTestOverride();
    return; // not enough elapsed hours this run to assert the contrast
  }
  const peakHour = elapsed[0];        // observed AT ceiling → clipping eligible
  const lowHour = elapsed[1];         // observed well below ceiling → never clips

  const atCeiling = ARRAY_PEAK_W;     // observed == ceiling → atPeak true
  const belowCeiling = Math.round(0.5 * ARRAY_PEAK_W); // 50% → atPeak false

  // GHI 800, coeff 25 → modelW = 20_000 > 15_000 observed at the peak hour,
  // so clippedW should be ~5_000 there. At the low hour modelW is also high
  // but observed is below the 0.95×ceiling gate, so clippedW must stay 0.
  setWeatherCacheForTesting(buildWeather(800));
  const forecast = buildForecast(() => 25);
  const recorder = recorderWithPv((h) =>
    h === peakHour ? atCeiling : h === lowHour ? belowCeiling : 0,
  );

  const c = await computeClipping(buildDevices(), recorder, forecast);
  clearWeatherTestOverride();

  // arrayPeakW is the max observedMaxPvW across the model.
  assert.equal(c.arrayPeakW, ARRAY_PEAK_W);

  const peakRow = c.perHour.find((r) => r.hour === peakHour);
  const lowRow = c.perHour.find((r) => r.hour === lowHour);
  assert.ok(peakRow, 'peak hour must appear in perHour');
  assert.ok(lowRow, 'low hour must appear in perHour');

  // At the ceiling, model (20_000) exceeds observed (15_000) → clipped ~5_000.
  assert.equal(peakRow!.observedW, ARRAY_PEAK_W);
  assert.equal(peakRow!.modelW, 20_000);
  assert.equal(peakRow!.clippedW, 5_000);

  // Below the ceiling: NOT at peak → clippedW is 0 even though modelW > observed.
  assert.ok(lowRow!.observedW < CLIPPING_PEAK_FRAC * ARRAY_PEAK_W);
  assert.equal(lowRow!.clippedW, 0);

  // clippedW is NEVER negative anywhere.
  for (const row of c.perHour) {
    assert.ok(row.clippedW >= 0, `clippedW must be >= 0, got ${row.clippedW} at hour ${row.hour}`);
  }

  // hoursAtPeak counts exactly the at-ceiling elapsed hours (just peakHour here).
  assert.equal(c.hoursAtPeak, 1);

  // todayKwh is elapsed/partial-hour weighted. The peak hour is fully elapsed
  // (it is the earliest elapsed hour and a later one exists), so it contributes
  // a FULL hour of (5_000 W / 1000) = 5 kWh. No other hour clips.
  assert.equal(c.todayKwh, 5);
});

test('computeClipping — current (partial) hour clips by the elapsed fraction only', async () => {
  resetHaStateShortLivedCaches();
  clearWeatherTestOverride();

  const todayStart = startOfLocalDayMs();
  const now = Date.now();
  const currentHour = Math.floor((now - todayStart) / HOUR_MS);
  if (currentHour < 0 || currentHour > 23) {
    clearWeatherTestOverride();
    return;
  }
  const elapsedFrac = (now - (todayStart + currentHour * HOUR_MS)) / HOUR_MS;
  // Skip the boundary right at the top of the hour where the fraction ~ 0
  // (the row exists with clippedW computed but the kWh contribution rounds to 0).
  if (elapsedFrac < 0.05) {
    clearWeatherTestOverride();
    return;
  }

  // Make ONLY the current hour clip: it is at the ceiling, every prior hour is 0.
  setWeatherCacheForTesting(buildWeather(800));
  const forecast = buildForecast(() => 25); // modelW 20_000 vs observed 15_000 → clipped 5_000
  const recorder = recorderWithPv((h) => (h === currentHour ? ARRAY_PEAK_W : 0));

  const c = await computeClipping(buildDevices(), recorder, forecast);
  clearWeatherTestOverride();

  const row = c.perHour.find((r) => r.hour === currentHour);
  assert.ok(row, 'current hour row must exist');
  assert.equal(row!.clippedW, 5_000);

  // todayKwh = (5_000/1000) × elapsedFrac, rounded to 2 decimals.
  const expected = Math.round((5 * elapsedFrac) * 100) / 100;
  assert.equal(c.todayKwh, expected);
  // Partial fraction means strictly less than a full hour's 5 kWh.
  assert.ok(c.todayKwh < 5, `partial-hour kWh ${c.todayKwh} must be < full-hour 5`);
});

test('computeClipping — GHI below the daylight floor yields no model → no clipping', async () => {
  resetHaStateShortLivedCaches();
  clearWeatherTestOverride();

  const elapsed = elapsedHours();
  if (elapsed.length < 1) {
    clearWeatherTestOverride();
    return;
  }
  const peakHour = elapsed[0];

  // GHI at the daylight floor: `wx.radiationWm2 > DAYLIGHT_GHI` is FALSE, so
  // modelW stays null and clippedW must be 0 even though observed is at ceiling.
  setWeatherCacheForTesting(buildWeather(DAYLIGHT_GHI));
  const forecast = buildForecast(() => 25);
  const recorder = recorderWithPv((h) => (h === peakHour ? ARRAY_PEAK_W : 0));

  const c = await computeClipping(buildDevices(), recorder, forecast);
  clearWeatherTestOverride();

  const row = c.perHour.find((r) => r.hour === peakHour);
  assert.ok(row, 'peak hour row must exist');
  assert.equal(row!.modelW, null);
  assert.equal(row!.clippedW, 0);
  assert.equal(c.todayKwh, 0);
  // The hour is still "at peak" by observed PV even with no model output.
  assert.ok(c.hoursAtPeak >= 1);
});
