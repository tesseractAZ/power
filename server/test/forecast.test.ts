import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bayesUpdate,
  BAYES_OBS_SIGMA2,
  computeProbabilisticForecast,
  computeMultiDayForecast,
  computeForecastSkill,
  computeAmbientThermalForecast,
  blendNightLoad,
  anchorNearTermLoad,
  isForecastNightHour,
  applyEmptyHysteresis,
  forecastDayAlerts,
  resetForecastCachesForTesting,
  type DayForecast,
  type ForecastHour,
  type HourResponse,
  type SolarResponseModel,
} from '../src/analytics.js';
import {
  setWeatherCacheForTesting,
  clearWeatherTestOverride,
  type WeatherForecast,
  type WeatherHour,
} from '../src/weather.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ─── shared helpers ─────────────────────────────────────────────────
 *
 * The forecast functions take a DayForecast and (where applicable) a
 * devices map + recorder. Build minimal synthetic inputs that exercise
 * the math without dragging in the full live system.
 * ───────────────────────────────────────────────────────────────── */

/** Build a 24-entry hourly solar response array — coeffs default to null
 *  so PV evaluates to 0 unless the caller overrides specific hours. */
function flatSolarHourly(overrides: Partial<Record<number, Partial<HourResponse>>> = {}): HourResponse[] {
  return Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    coeff: null,
    r2: 0,
    samples: 0,
    observedMaxPvW: 0,
    ...(overrides[h] ?? {}),
  }));
}

function flatSolarModel(overrides: Partial<Record<number, Partial<HourResponse>>> = {}): SolarResponseModel {
  return {
    hourly: flatSolarHourly(overrides),
    peakCoeff: 0,
    pairCount: 0,
    historyDays: 30,
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
    solarModel: flatSolarModel(),
    deviceModels: [],
    soiling: null,
    ...overrides,
  };
}

/** Build N hourly forecast entries starting at local midnight tomorrow. The
 *  resulting timestamps span the hour-of-day axis predictably so tests can
 *  reason about `new Date(ts).getHours()`. */
function hourlyForecast(opts: {
  count: number;
  startTs: number;
  forecastPvW?: (h: number, ts: number) => number;
  forecastLoadW?: (h: number, ts: number) => number;
  projectedSocPct?: (h: number, ts: number) => number | null;
}): ForecastHour[] {
  const out: ForecastHour[] = [];
  for (let i = 0; i < opts.count; i++) {
    const ts = opts.startTs + i * 3_600_000;
    out.push({
      ts,
      forecastPvW: opts.forecastPvW?.(i, ts) ?? 0,
      forecastLoadW: opts.forecastLoadW?.(i, ts) ?? 500,
      cloudCoverPct: 30,
      ghiWm2: 0,
      projectedSocPct: opts.projectedSocPct?.(i, ts) ?? null,
      modelled: true,
    });
  }
  return out;
}

/** Synthesise a WeatherForecast covering N hours from startTs with a constant
 *  GHI value. Useful for multi-day / Bayesian forecast tests that early-return
 *  on missing weather. */
function syntheticWeather(opts: {
  startTs: number;
  count: number;
  radiationWm2?: number;
  cloudCoverPct?: number;
  tempC?: number;
}): WeatherForecast {
  const hours: WeatherHour[] = [];
  for (let i = 0; i < opts.count; i++) {
    hours.push({
      ts: opts.startTs + i * 3_600_000,
      cloudCoverPct: opts.cloudCoverPct ?? 30,
      radiationWm2: opts.radiationWm2 ?? 600,
      tempC: opts.tempC ?? 25,
      ensembleSources: 1,
    });
  }
  return { fetchedAt: Date.now(), lat: 33.45, lon: -112.07, hours };
}

/** Recorder stub with empty history for any metric. Sufficient for the
 *  forecast functions because they only call recorder.query in code paths
 *  we're not exercising (skill needs actual PV samples; we test the empty
 *  edge cases). */
function emptyRecorder(): Recorder {
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn, metrics) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as Recorder;
}

/** Tomorrow's local midnight, useful as a reproducible anchor for the
 *  multi-day forecast (which iterates from todayStart). */
function tomorrowLocalMidnight(): number {
  return startOfLocalDayMs() + 86_400_000;
}

function makeShp2(overrides: { backupFullCapWh?: number | null; backupRemainWh?: number | null } = {}): DeviceSnapshot {
  return {
    sn: 'SHP2-TEST',
    deviceName: 'SHP2',
    online: true,
    projection: {
      kind: 'shp2',
      area: null,
      backupBatPercent: 60,
      backupFullCapWh: overrides.backupFullCapWh ?? 120_000,
      backupRemainWh: overrides.backupRemainWh ?? 72_000,
      backupChargeTimeMin: null, backupDischargeTimeMin: null,
      backupReserveSoc: 15, chargeWattPower: null,
      circuits: [], pairedCircuits: [], sources: [], sourceWatts: [],
      strategy: {} as any,
    },
  } as any;
}

/* ─── bayesUpdate (pure math helper) ──────────────────────────────────
 *
 * Recursive Gaussian update of N(μ, τ²) by an observation (g, p) with
 * known noise σ². New precision = 1/τ² + g²/σ²; new μ is the precision-
 * weighted average of prior and the OLS-equivalent estimate p/g.
 * ─────────────────────────────────────────────────────────────────── */

test('bayesUpdate — uninformative prior collapses toward observation in one step', () => {
  // Prior N(0, 1000) (the actual analytics.ts prior); observe g=500 W/m² → p=4000 W
  // (β ≈ 8 W per W/m²). With τ²=1000 (basically no prior), the posterior μ
  // should snap close to 4000/500 = 8.
  const post = bayesUpdate(0, 1000, 500, 4000, BAYES_OBS_SIGMA2);
  assert.ok(post.mu > 6 && post.mu < 10, `posterior μ should be near 8, got ${post.mu.toFixed(3)}`);
  // Precision should have grown (variance shrunk) but not collapsed to zero.
  assert.ok(post.tau2 < 1000, 'τ² should shrink from prior');
  assert.ok(post.tau2 > 0, 'τ² should stay positive');
});

test('bayesUpdate — repeated observations shrink the posterior variance monotonically', () => {
  let mu = 0;
  let tau2 = 1000;
  const variances: number[] = [];
  for (let i = 0; i < 5; i++) {
    ({ mu, tau2 } = bayesUpdate(mu, tau2, 500, 4000, BAYES_OBS_SIGMA2));
    variances.push(tau2);
  }
  for (let i = 1; i < variances.length; i++) {
    assert.ok(variances[i] < variances[i - 1], `τ² should be monotonically non-increasing (step ${i}: ${variances[i - 1].toFixed(3)} → ${variances[i].toFixed(3)})`);
  }
});

test('bayesUpdate — posterior μ converges to true β under repeated noiseless obs', () => {
  // Generate 50 noise-free pairs at β=8: p = 8·g for g in [200, 1000].
  let mu = 0;
  let tau2 = 1000;
  const TRUE_BETA = 8;
  for (let i = 0; i < 50; i++) {
    const g = 200 + i * 16;
    const p = TRUE_BETA * g;
    ({ mu, tau2 } = bayesUpdate(mu, tau2, g, p, BAYES_OBS_SIGMA2));
  }
  assert.ok(Math.abs(mu - TRUE_BETA) < 0.5, `μ should converge to ${TRUE_BETA}, got ${mu.toFixed(3)}`);
});

test('bayesUpdate — v0.9.59 σ² regression: posterior PV-band does NOT collapse to <100 W on a single 16 kW obs', () => {
  // The pre-v0.9.59 BAYES_OBS_SIGMA2 (=50) was off by ~5 orders of magnitude
  // relative to the actual fleet PV signal. A single observation at the
  // fleet's nameplate scale over-shrunk τ² so hard that posterior PV
  // uncertainty (≈ g · stdev_β) collapsed to ~7 W — leaving the filter
  // pinned to a single observation with no headroom for subsequent updates
  // to move the posterior.
  //
  // With the v0.9.59 fix (σ² = (0.10 · pNamplate)² ≈ 2.82e6 for ~16.8 kWp),
  // posterior coefficient stdev after one obs at g=800, p=16 000 sits
  // around ~2 W per W/m², so PV-space uncertainty (= g · stdev_β) is
  // ~1 600 W — far above the 100 W floor the brief calls out.
  const g = 800;
  const post = bayesUpdate(0, 1000, g, 16_000, BAYES_OBS_SIGMA2);
  const stdevBeta = Math.sqrt(post.tau2);
  const pvSpaceStdevW = g * stdevBeta;
  assert.ok(
    pvSpaceStdevW > 100,
    `posterior PV-space stdev should stay above 100 W after one obs; got ${pvSpaceStdevW.toFixed(1)} W ` +
      `(pre-v0.9.59 bug collapsed it to ~7 W)`,
  );
  // Sanity: also confirm BAYES_OBS_SIGMA2 itself wasn't accidentally
  // reverted to the v0.9.0 placeholder (~50).
  assert.ok(BAYES_OBS_SIGMA2 > 1e5, `BAYES_OBS_SIGMA2 should be O(1e6), got ${BAYES_OBS_SIGMA2}`);
});

/* ─── computeProbabilisticForecast ────────────────────────────────────
 *
 * P10/P50/P90 PV + SoC bands with v0.9.59 horizon-widening and v0.9.58
 * full-capacity-aware SoC scaling. Doesn't strictly require weather (falls
 * back to a 25% cloud-stdev baseline), so we don't need to seed the cache.
 * ─────────────────────────────────────────────────────────────────── */

test('computeProbabilisticForecast — null forecast returns empty shape', async () => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  const r = await computeProbabilisticForecast(null, null);
  assert.equal(r.hours.length, 0);
  assert.equal(r.pAboveReservePct, null);
  assert.equal(r.pFullCharge, null);
});

test('computeProbabilisticForecast — happy path: p10 ≤ p50 ≤ p90 at every hour', async () => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  const start = tomorrowLocalMidnight();
  const fc = emptyForecast({
    hours: hourlyForecast({
      count: 24,
      startTs: start,
      forecastPvW: (h) => (h >= 7 && h <= 18 ? 3_000 : 0),
      forecastLoadW: () => 1_000,
      // A linear SoC trajectory so back-out has at least one valid hour pair.
      projectedSocPct: (h) => 50 + h * 0.5,
    }),
  });
  const r = await computeProbabilisticForecast(fc, null);
  assert.equal(r.hours.length, 24);
  for (const b of r.hours) {
    assert.ok(b.p10W <= b.p50W, `hour ${new Date(b.ts).getHours()}: p10 ${b.p10W} > p50 ${b.p50W}`);
    assert.ok(b.p50W <= b.p90W, `hour ${new Date(b.ts).getHours()}: p50 ${b.p50W} > p90 ${b.p90W}`);
  }
});

test('computeProbabilisticForecast — v0.9.59 regression: hour-24 band is ~sqrt(2)× hour-0 band', async () => {
  // Horizon widening multiplier = sqrt(1 + hoursOut/24). For an hour 24 h
  // past the first hour of the forecast, the spread should grow by ~1.41×.
  // Use a 25-hour forecast with constant PV so the widening is the ONLY
  // source of band-width variation.
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  const start = tomorrowLocalMidnight();
  const fc = emptyForecast({
    hours: hourlyForecast({
      count: 25,
      startTs: start,
      forecastPvW: () => 2_000,
      forecastLoadW: () => 1_000,
      projectedSocPct: (h) => 50 + h * 0.5,
    }),
  });
  const r = await computeProbabilisticForecast(fc, null);
  assert.equal(r.hours.length, 25);
  const spread0 = r.hours[0].p90W - r.hours[0].p10W;
  const spread24 = r.hours[24].p90W - r.hours[24].p10W;
  const ratio = spread24 / spread0;
  // sqrt(2) ≈ 1.414. Allow ±5% slack for the integer rounding in the
  // function's `Math.round(...)` outputs.
  assert.ok(
    ratio > 1.35 && ratio < 1.48,
    `expected hour-24 spread ~1.41× hour-0 (sqrt(2)); got ${spread0} → ${spread24} (ratio ${ratio.toFixed(3)})`,
  );
});

test('computeProbabilisticForecast — v0.9.58 regression: SoC band scales to backed-out full capacity', async () => {
  // Construct a forecast where the deterministic SoC trajectory implies
  // fullKwh = 120 (1.2 kWh delta → 1 % SoC). Then a known sigmaFrac should
  // produce a known SoC band width — much narrower than the pre-fix
  // "1 kWh = 0.5 %" assumption (which over-widened by ~6×) or, equivalently
  // wider than the pre-back-out "socStep * 5" assumption depending on which
  // bug-state we're checking against.
  //
  // With no weather + no skill report: baseSigmaFrac = sqrt(0.25² + 0.15²)
  // ≈ 0.2915 at horizon factor 1.0 (hour 0). For pvW = 2 000, load = 1 000,
  // socStep = ((p90 - p10) / 1000) / 2 = (p50·(2·1.282·0.2915))/2000 kWh ≈
  // 0.748 kWh half-range → with fullKwh=120 ≈ 0.62 %. Buggy (×5) would
  // give ~3.7 %. The test asserts the correct ~0.62 %.
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  const start = tomorrowLocalMidnight();
  // Hours 0→1 move SoC by exactly 1 % under a 1.2 kWh net surplus
  // (1 200 W PV − 0 W load over 1 h = 1.2 kWh), implying fullKwh = 120.
  // (The function inverts dSoCpct ↔ kWh via candidate = kwhDelta /
  // (dSocPct/100), so 1.2 / 0.01 = 120 — matching the operator's real fleet.)
  const fc = emptyForecast({
    hours: hourlyForecast({
      count: 6,
      startTs: start,
      forecastPvW: (h) => (h === 0 ? 0 : 2_000),  // hour 0 = baseline, hour 1+ = 2 kW
      forecastLoadW: () => 800,                    // constant load — non-trivial kwhDelta
      projectedSocPct: (h) => 50 + h * 1.0,       // 1 %/h → 1.2 kWh per 1 % → fullKwh = 120 kWh
    }),
  });
  const r = await computeProbabilisticForecast(fc, null);
  // Hour 1 is the first hour after the back-out anchor. Use it to verify
  // the post-fix scaling, since hour 0's band is computed off the same
  // ratio but before p50Soc has stepped.
  const h1 = r.hours[1];
  assert.ok(h1.p10SocPct != null && h1.p50SocPct != null && h1.p90SocPct != null);
  const socBandWidth = (h1.p90SocPct ?? 0) - (h1.p10SocPct ?? 0);
  // Post-fix expected ≈ 2 · 0.62 % ≈ 1.24 %.
  // Pre-fix bug (×5) would have produced ≈ 7.5 %.
  // Pick a generous-but-discriminating window: [0.5 %, 3 %].
  assert.ok(
    socBandWidth >= 0.5 && socBandWidth <= 3.0,
    `SoC band width should be ~1.2 % for a 120 kWh fleet at hour 1; got ${socBandWidth.toFixed(2)} % ` +
      `(pre-v0.9.58 bug would give ~7-12 %)`,
  );
});

/* ─── computeMultiDayForecast ─────────────────────────────────────────
 *
 * 3-day rollup with per-hour-of-day load curve (v0.9.58). Requires
 * weather — seed the cache with a synthetic forecast.
 * ─────────────────────────────────────────────────────────────────── */

test('computeMultiDayForecast — null forecast returns empty days array', async () => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  const r = await computeMultiDayForecast({}, emptyRecorder(), null);
  assert.equal(r.days.length, 0);
});

test('computeMultiDayForecast — no weather available returns empty days array', async () => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  const fc = emptyForecast({
    hours: hourlyForecast({ count: 24, startTs: tomorrowLocalMidnight() }),
  });
  const r = await computeMultiDayForecast({}, emptyRecorder(), fc);
  assert.equal(r.days.length, 0);
});

test('computeMultiDayForecast — v0.9.58 regression: day-2 hour-18 load uses per-HoD curve, NOT hour-0 fallback', async () => {
  // The pre-v0.9.58 bug: `const load = forecast.hours[0]?.forecastLoadW ?? 0`
  // set the load to hour-0's value (typically a quiet overnight slot, ~100 W
  // in this test) and reused it for every hour of every day. With the fix,
  // hour 18 should see this test's 3 000 W spike. We verify by comparing
  // day-1's total load against the only-100W bug-state estimate.
  resetForecastCachesForTesting();
  const todayStart = startOfLocalDayMs();
  // Forecast hours spanning hour 0..23 of tomorrow (the same day-of-day-1
  // that computeMultiDayForecast walks first since dayIdx==0 skips past
  // hours of today). Build a load curve that is 100 W EVERYWHERE except
  // hour 18 = 3 000 W. The two scenarios diverge by 2 900 Wh/day at the
  // single hour-18 slot.
  const startTomorrow = todayStart + 86_400_000;
  const fc = emptyForecast({
    // Reserve a 24-h forecast covering every hour-of-day so loadByHod is
    // fully populated and we don't fall back to fallbackLoad.
    hours: hourlyForecast({
      count: 24,
      startTs: startTomorrow,                     // hour 0 of tomorrow
      forecastPvW: () => 0,
      forecastLoadW: (h) => (h === 18 ? 3_000 : 100),
    }),
    solarModel: flatSolarModel(),                 // all coeffs null → pv = 0 everywhere
  });
  // Seed weather covering today + the next 3 days so every hour-epoch
  // has a wx entry (the function only computes pv when wx is present;
  // load accumulates unconditionally so the wx coverage is mostly a
  // belt-and-suspenders measure).
  setWeatherCacheForTesting(syntheticWeather({
    startTs: todayStart,
    count: 4 * 24,
    radiationWm2: 0,                              // zero so we isolate load behavior
  }));
  const r = await computeMultiDayForecast({}, emptyRecorder(), fc, 3);
  assert.equal(r.days.length, 3, 'should return 3 days');
  // Day 1 (tomorrow) covers every hour 0..23 → 23 × 100 W + 1 × 3 000 W
  // = 5 300 Wh ≈ 5.3 kWh. With the bug: 24 × 100 = 2 400 Wh ≈ 2.4 kWh.
  const day1Load = r.days[1].loadKwh;
  assert.ok(
    day1Load > 4.5 && day1Load < 6.0,
    `day-1 loadKwh should be ~5.3 (bug would give ~2.4); got ${day1Load}`,
  );
  // Day 2 same expectation as day 1 (also full 24 h iterated).
  const day2Load = r.days[2].loadKwh;
  assert.ok(
    day2Load > 4.5 && day2Load < 6.0,
    `day-2 loadKwh should be ~5.3 (bug would give ~2.4); got ${day2Load}`,
  );
});

/* ─── computeForecastSkill ────────────────────────────────────────────
 *
 * Compares hindcast predictions against actuals over a back-window.
 * Requires weather + a DPU + recorded pv_total. We cover the early-exit
 * edge cases here; the integration math is left to the live system.
 * ─────────────────────────────────────────────────────────────────── */

test('computeForecastSkill — null forecast returns empty report', async () => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  const r = await computeForecastSkill({}, emptyRecorder(), null);
  assert.equal(r.days.length, 0);
  assert.equal(r.meanAbsErrorKwh, null);
  assert.equal(r.biasFactor, null);
});

test('computeForecastSkill — empty DPU fleet returns empty report', async () => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(syntheticWeather({
    startTs: startOfLocalDayMs() - 7 * 86_400_000,
    count: 14 * 24,
  }));
  const fc = emptyForecast({
    hours: hourlyForecast({ count: 24, startTs: tomorrowLocalMidnight() }),
  });
  // No DPU devices in the fleet — should early-exit to empty.
  const r = await computeForecastSkill({ 'SHP2': makeShp2() }, emptyRecorder(), fc);
  assert.equal(r.days.length, 0);
  assert.equal(r.meanAbsErrorKwh, null);
});

test('computeForecastSkill — no weather returns empty report', async () => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  const fc = emptyForecast({
    hours: hourlyForecast({ count: 24, startTs: tomorrowLocalMidnight() }),
  });
  // Even with a forecast in hand, computeForecastSkill can't backtest
  // without past weather to feed the hindcast — must early-exit clean.
  const r = await computeForecastSkill({}, emptyRecorder(), fc);
  assert.equal(r.days.length, 0);
});

/* ─── computeAmbientThermalForecast ──────────────────────────────────
 *
 * Per-pack thermal regression vs (ambient °C, load kW). Requires DPUs +
 * pack_*_temp samples in recorder + weather. We cover the early-exits.
 * ─────────────────────────────────────────────────────────────────── */

test('computeAmbientThermalForecast — empty fleet returns empty packs array', async () => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(syntheticWeather({
    startTs: startOfLocalDayMs() - 7 * 86_400_000,
    count: 14 * 24,
  }));
  const r = await computeAmbientThermalForecast({}, emptyRecorder());
  assert.equal(r.packs.length, 0);
});

test('computeAmbientThermalForecast — no weather returns empty packs array', async () => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(null);
  // Provide a single DPU with one pack — the function still bails out
  // because there's no ambient-temperature series to regress against.
  const devices: Record<string, DeviceSnapshot> = {
    'DPU-1': {
      sn: 'DPU-1',
      deviceName: 'DELTA-PRO-ULTRA-1',
      online: true,
      projection: {
        kind: 'dpu',
        packs: [{ num: 1, soc: 80, temp: 25, soh: 100, cycles: 50,
          inputWatts: 0, outputWatts: 0, maxCellTemp: 25, minCellTemp: 25 }],
      } as any,
    } as any,
  };
  const r = await computeAmbientThermalForecast(devices, emptyRecorder());
  assert.equal(r.packs.length, 0);
});

/* Clear caches and weather seam at the end so we don't leak state into
 * other test files that share the analytics module graph. */
test('cleanup — clear forecast caches and weather seam', () => {
  resetForecastCachesForTesting();
  clearWeatherTestOverride();
  assert.ok(true);
});

/* ─── v0.59.0 — forecast realism: night-load blend + grid-aware dip ──── */

test('blendNightLoad — trims a stale-high curve hour toward recent actual', () => {
  // curve 6000 W vs recent 3200 W: 6000 > 3200×1.5 (=4800) → blend 0.6 toward recent
  assert.equal(blendNightLoad(6000, 3200, 1.5, 0.6), 6000 * (1 - 0.6) + 3200 * 0.6); // ~4320, halves the over-prediction
});

test('blendNightLoad — never RAISES load; passes through when close or unknown', () => {
  assert.equal(blendNightLoad(3000, 3200, 1.5, 0.6), 3000, 'curve below recent → unchanged (never raises)');
  assert.equal(blendNightLoad(4000, 3200, 1.5, 0.6), 4000, 'within 1.5× of recent → not stale-high → unchanged');
  assert.equal(blendNightLoad(6000, null, 1.5, 0.6), 6000, 'recent unknown (cold window) → unchanged, never zeroes the night');
});

test('v1.4.2 — anchorNearTermLoad raises the near-term sim toward a SUSTAINED observed load', () => {
  // The daytime failure the runway sensors already guard against: a ~1 kW modelled hour while
  // the panel actually draws ~10 kW (AC compressor). The first RUNWAY_BLEND_HOURS must lift.
  const BH = 4;
  // hour 0: full weight → the observed load itself.
  assert.equal(anchorNearTermLoad(1000, 10000, 0, BH), 10000);
  // hour 1: weight .75 → 10000*.75 + 1000*.25 = 7750.
  assert.equal(anchorNearTermLoad(1000, 10000, 1, BH), 7750);
  // hour 2: .5, hour 3: .25 — monotonically decaying back toward the curve.
  assert.equal(anchorNearTermLoad(1000, 10000, 2, BH), 5500);
  assert.equal(anchorNearTermLoad(1000, 10000, 3, BH), 3250);
});

test('v1.4.2 — anchorNearTermLoad never LOWERS load and no-ops past the window / with no sample', () => {
  const BH = 4;
  // A lighter-than-modelled day: recent below curve → max() keeps the (higher) curve. Never
  // becomes MORE optimistic, mirroring blendNightLoad's own never-raise guard on the trim side.
  assert.equal(anchorNearTermLoad(6000, 2000, 0, BH), 6000);
  assert.equal(anchorNearTermLoad(6000, 2000, 1, BH), 6000);
  // Past the blend window the far horizon is untouched (a burst can't dominate hour 4+).
  assert.equal(anchorNearTermLoad(1000, 10000, 4, BH), 1000);
  assert.equal(anchorNearTermLoad(1000, 10000, 12, BH), 1000);
  // Cold window (no recent sample) passes through unchanged.
  assert.equal(anchorNearTermLoad(1000, null, 0, BH), 1000);
});

test('forecastDayAlerts — projected dip is grid-aware (v0.59.0)', () => {
  const fc = emptyForecast({ minProjectedSoc: 0, minProjectedSocTs: 1_900_000_000_000, reserveSoc: 15 });
  const islanded = forecastDayAlerts(fc).find((a) => a.id === 'forecast-soc-dip');
  assert.ok(islanded, 'a sub-reserve projection raises the dip alert');
  assert.equal(islanded!.severity, 'warning', 'no grid context → actionable warning (today behaviour)');

  const offGrid = forecastDayAlerts(fc, { backstopping: false }).find((a) => a.id === 'forecast-soc-dip');
  assert.equal(offGrid!.severity, 'warning', 'grid not backstopping (islanded) → still a warning');

  const onGrid = forecastDayAlerts(fc, { backstopping: true, reason: 'grid import 3.2 kW' }).find((a) => a.id === 'forecast-soc-dip');
  assert.ok(onGrid);
  assert.equal(onGrid!.severity, 'info', 'grid backstopping → informational, not an actionable emergency');
  assert.match(onGrid!.detail, /islanded|backstopping/i);
});

test('blendNightLoad — trim is FLOOR-CAPPED so a pathologically-quiet recent window cannot gut the curve (v0.59.0 review)', () => {
  // recent 500 W vs curve 6000 W: raw blend = 6000*0.4 + 500*0.6 = 2700, but the
  // 50% max-trim floor (6000*0.5 = 3000) binds → never below half the curve.
  assert.equal(blendNightLoad(6000, 500, 1.5, 0.6, 0.5), 3000);
  // a moderate recent (3200) lands above the floor → unaffected by the cap.
  assert.equal(blendNightLoad(6000, 3200, 1.5, 0.6, 0.5), 6000 * 0.4 + 3200 * 0.6);
});

test('isForecastNightHour — gates the load blend to the overnight/idle band only (v0.59.0 review)', () => {
  for (const h of [21, 22, 23, 0, 2, 5]) assert.equal(isForecastNightHour(h), true, `${h}:00 is overnight`);
  for (const h of [6, 9, 14, 17, 20]) assert.equal(isForecastNightHour(h), false, `${h}:00 is daytime — curve must NOT be trimmed`);
});

/* ─── v0.60.0 — runway to-empty hysteresis (asymmetric) ─────────────── */

test('applyEmptyHysteresis — finite publishes immediately + arms; null holds N then releases to sentinel', () => {
  const s = { streak: 0, lastFinite: null as number | null };
  assert.equal(applyEmptyHysteresis(8, s, 3), 8);     // finite crossing → publish + arm latch
  assert.equal(applyEmptyHysteresis(null, s, 3), 8);  // 1st no-crossing → hold last finite
  assert.equal(applyEmptyHysteresis(null, s, 3), 8);  // 2nd → hold
  assert.equal(applyEmptyHysteresis(null, s, 3), null);// 3rd consecutive → release to 999 sentinel
  assert.equal(applyEmptyHysteresis(null, s, 3), null);// stays released
});

test('applyEmptyHysteresis — a real depletion (none→finite) is published IMMEDIATELY, never delayed', () => {
  const s = { streak: 0, lastFinite: null as number | null };
  assert.equal(applyEmptyHysteresis(null, s, 3), null); // no depletion
  assert.equal(applyEmptyHysteresis(5, s, 3), 5);       // depletion appears → immediate, no damping (safety)
  assert.equal(applyEmptyHysteresis(null, s, 3), 5);    // the optimistic clear re-earns the hold from the fresh finite
});
