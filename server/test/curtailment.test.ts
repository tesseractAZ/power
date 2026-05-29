import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCurtailment,
  resetForecastCachesForTesting,
  setBayesianModelForTesting,
  type BayesianSolarModel,
} from '../src/analytics.js';
import {
  setWeatherCacheForTesting,
  clearWeatherTestOverride,
  type WeatherForecast,
} from '../src/weather.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ─── helpers ──────────────────────────────────────────────────────────
 *
 * Build a fully-mocked Bayesian posterior with a single hour-of-day
 * having ≥3 samples (the engine's `CURTAIL_MIN_BAYES_SAMPLES`). Pin the
 * weather cache to a constant GHI at "now" so the engine sees daylight.
 *
 * The recorder stub returns empty arrays everywhere — we're testing the
 * synchronous "current state" branch, not the historical walk.
 * ────────────────────────────────────────────────────────────────── */

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

/** Mock Bayesian posterior — wattsPerGHI is the μ for the current hour. */
function mockBayes(wattsPerGHI: number, samples = 10): BayesianSolarModel {
  const hour = new Date().getHours();
  return {
    generatedAt: Date.now(),
    hourly: [{
      hour,
      posteriorMean: wattsPerGHI,
      posteriorStdev: 0.5,
      ci95Low: wattsPerGHI - 1,
      ci95High: wattsPerGHI + 1,
      samples,
    }],
    totalSamples: samples,
    medianStdev: 0.5,
    agreementWithOls: 1,
  };
}

/** Synthesise a single-hour weather entry at "now" with given GHI. */
function syntheticWeatherNow(radiationWm2: number): WeatherForecast {
  const now = Date.now();
  const hourEpoch = Math.floor(now / 3_600_000);
  return {
    fetchedAt: now,
    lat: 33.45,
    lon: -112.07,
    hours: [{
      ts: hourEpoch * 3_600_000,
      cloudCoverPct: 20,
      radiationWm2,
      tempC: 30,
      ensembleSources: 1,
    }],
  };
}

/**
 * Build a minimal SHP2 + connected DPU pair. The SHP2's `sources`
 * declare the DPU as connected (slot 1, isConnected=true) — that's what
 * `shp2ConnectedDpuSns` keys on, so the curtailment engine treats this
 * DPU as a "home" pack.
 */
function buildDevices(opts: {
  dpuSocPct: number;
  dpuPvWatts: number;
  shp2LoadWatts: number;
  /** Configured charge ceiling (chgMaxSoc). Omit → null (engine falls
   *  back to the 96% legacy constant). */
  chgMaxSocPct?: number;
}): Record<string, DeviceSnapshot> {
  const dpuSn = 'DPU-HOME-1';
  const dpu: DeviceSnapshot = {
    sn: dpuSn,
    deviceName: 'Core 1',
    productName: 'Delta Pro Ultra',
    online: true,
    lastUpdated: Date.now(),
    projection: {
      kind: 'dpu',
      soc: opts.dpuSocPct,
      pvTotalWatts: opts.dpuPvWatts,
      pvHighWatts: opts.dpuPvWatts,
      pvLowWatts: 0,
      pvHighVolts: 200, pvHighAmps: opts.dpuPvWatts / 200,
      pvLowVolts: 0, pvLowAmps: 0,
      acInWatts: 0, acOutWatts: 0,
      totalInWatts: 0, totalOutWatts: 0,
      batVol: 53, batAmp: 0,
      mpptHvTemp: 30, mpptLvTemp: 30,
      sysErrCode: 0, pvHighErrCode: 0, pvLowErrCode: 0,
      emsParaVolMinMv: 47_500, emsParaVolMaxMv: 56_000,
      chgMaxSoc: opts.chgMaxSocPct ?? null,
      dsgMinSoc: null,
      packs: [],
    } as any,
  } as any;
  const shp2: DeviceSnapshot = {
    sn: 'SHP2-1',
    deviceName: 'SHP2',
    productName: 'Smart Home Panel 2',
    online: true,
    lastUpdated: Date.now(),
    projection: {
      kind: 'shp2',
      backupBatPercent: opts.dpuSocPct,
      backupFullCapWh: 21_500,
      backupRemainWh: 21_500 * (opts.dpuSocPct / 100),
      backupChargeTimeMin: null,
      backupDischargeTimeMin: null,
      circuits: [{ ch: 1, name: 'Test load', watts: opts.shp2LoadWatts, breakerAmps: 20 }],
      pairedCircuits: [],
      sources: [
        { slot: 1, sn: dpuSn, batteryPercentage: opts.dpuSocPct, emsBatTemp: 30, errorCodeNum: 0, isConnected: true } as any,
      ],
      sourceWatts: [],
    } as any,
  } as any;
  return { [dpuSn]: dpu, [shp2.sn]: shp2 };
}

/** Reset shared state between tests so cache hits don't leak across cases. */
function withFreshState() {
  resetForecastCachesForTesting();
  clearWeatherTestOverride();
}

test('curtailment — inactive when SoC below the taper-band saturation threshold', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10)); // 10 W per W/m² → 7000 W expected
  // No ceiling reported → assume 100, threshold = 90. SoC 75 < 90 → inactive.
  const devices = buildDevices({ dpuSocPct: 75, dpuPvWatts: 2000, shp2LoadWatts: 1500 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'soc-too-low');
  assert.equal(r.currentSurplusW, 0);
});

test('curtailment — inactive when PV below MIN_PV (panels off / dawn)', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10));
  const devices = buildDevices({ dpuSocPct: 99, dpuPvWatts: 50, shp2LoadWatts: 1500 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'pv-too-low');
});

test('curtailment — inactive when GHI is below the daylight floor', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(20)); // pre-dawn / heavy storm
  setBayesianModelForTesting(mockBayes(10));
  const devices = buildDevices({ dpuSocPct: 99, dpuPvWatts: 2000, shp2LoadWatts: 1500 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'no-daylight');
});

test('curtailment — inactive when the Bayesian model lacks samples for this hour', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  // posterior has zero samples → predictExpectedPv returns null.
  setBayesianModelForTesting({
    generatedAt: Date.now(),
    hourly: [],
    totalSamples: 0,
    medianStdev: 0,
    agreementWithOls: 0,
  });
  const devices = buildDevices({ dpuSocPct: 99, dpuPvWatts: 2000, shp2LoadWatts: 1500 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'no-model');
});

test('curtailment — inactive when expected and actual PV are close (small gap)', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  // μ=3 W/(W/m²) → expected = 2100 W. Actual = 2000 W → gap = 100 W < 300 W threshold.
  setBayesianModelForTesting(mockBayes(3));
  const devices = buildDevices({ dpuSocPct: 99, dpuPvWatts: 2000, shp2LoadWatts: 1500 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'small-gap');
});

test('curtailment — inactive when PV meaningfully exceeds load (energy flowing through)', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10));
  // Cloud just rolled in: SoC still 99 (slow to drop), expected = 7000 W,
  // but actual PV = 2000 W (clouds), load = 200 W. PV (2000) > 2x load (400) →
  // the home is using only a fraction of PV, the rest IS curtailment-like —
  // but actually the gap looks like clouds not curtailment. The guard requires
  // PV ≤ 2x load (panels throttled to match) to call it curtailment. With
  // PV way above load, it's NOT throttling — it's normal pass-through.
  const devices = buildDevices({ dpuSocPct: 99, dpuPvWatts: 2000, shp2LoadWatts: 200 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'pv-exceeds-load');
});

test('curtailment — ACTIVE when SoC high + PV matched to load + meaningful gap', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  // μ=10 W/(W/m²) → expected = 7000 W. Actual = 2000 W, load = 1800 W.
  // pv ≈ load (within 2x factor) → curtailing. Surplus = 5000 W.
  setBayesianModelForTesting(mockBayes(10));
  const devices = buildDevices({ dpuSocPct: 99, dpuPvWatts: 2000, shp2LoadWatts: 1800 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, true);
  assert.equal(r.inactiveReason, null);
  assert.equal(r.currentSurplusW, 5000);
  assert.equal(r.current.pvExpectedW, 7000);
  assert.equal(r.current.pvActualW, 2000);
  assert.equal(r.current.socAvg, 99);
});

test('curtailment — variable ceiling: ACTIVE at 72% SoC when charge limit is 80%', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10)); // expected 7000 W
  // The KEY case the operator flagged: batteries set to charge to 80%, in the taper
  // band. The old hardcoded 96% threshold would call this "soc-too-low" and
  // NEVER fire. With the ceiling at 80 and the 10-pt taper band, the
  // threshold is 70, so 72 ≥ 70 → curtailing (shedding has begun).
  const devices = buildDevices({ dpuSocPct: 72, dpuPvWatts: 2000, shp2LoadWatts: 1800, chgMaxSocPct: 80 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, true, 'curtailment fires at 72% when ceiling is 80%');
  assert.equal(r.inactiveReason, null);
  assert.equal(r.currentSurplusW, 5000);
  assert.equal(r.current.chargeCeilingPct, 80);
  assert.equal(r.current.saturationThresholdPct, 70);
});

test('curtailment — variable ceiling: INACTIVE at 65% SoC when charge limit is 80%', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10));
  // Same 80% ceiling, but SoC is 65 — below the taper band (threshold 70),
  // so the pool is still bulk-charging and absorbing PV. Not curtailing.
  const devices = buildDevices({ dpuSocPct: 65, dpuPvWatts: 2000, shp2LoadWatts: 1800, chgMaxSocPct: 80 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'soc-too-low');
  assert.equal(r.current.chargeCeilingPct, 80);
  assert.equal(r.current.saturationThresholdPct, 70);
});

test('curtailment — taper-aware: Storm Guard ceiling 100, 90% SoC IS detected (the real-world onset)', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10));
  // Storm Guard / outage-prep pushed the ceiling to 100. This is exactly the
  // live state from the operator's fleet: SoC 90, ceiling 100, LV string already
  // shed. The v0.9.78 margin-of-2 (threshold 98) MISSED this; the v0.9.79
  // taper band (threshold 90) catches it. 90 ≥ 90 → curtailing.
  const devices = buildDevices({ dpuSocPct: 90, dpuPvWatts: 2000, shp2LoadWatts: 1800, chgMaxSocPct: 100 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, true, 'taper-onset curtailment detected at SoC 90 with a 100% ceiling');
  assert.equal(r.inactiveReason, null);
  assert.equal(r.current.chargeCeilingPct, 100);
  assert.equal(r.current.saturationThresholdPct, 90);
});

test('curtailment — taper-aware: SoC 85 with a 100% ceiling is still below the band', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10));
  // 100% ceiling, threshold 90. SoC 85 < 90 → still bulk-charging, no
  // shedding yet. Guards against firing too early in the absorption phase.
  const devices = buildDevices({ dpuSocPct: 85, dpuPvWatts: 2000, shp2LoadWatts: 1800, chgMaxSocPct: 100 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'soc-too-low');
  assert.equal(r.current.saturationThresholdPct, 90);
});

test('curtailment — no chgMaxSoc reported assumes 100% ceiling → threshold 90', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10));
  // chgMaxSocPct omitted → projection.chgMaxSoc is null → the engine assumes
  // a 100% ceiling (EcoFlow default) and applies the 10-pt band → threshold
  // 90. SoC 85 < 90 → inactive. chargeCeilingPct stays null (we report what
  // we actually read, not the assumption).
  const devices = buildDevices({ dpuSocPct: 85, dpuPvWatts: 2000, shp2LoadWatts: 1800 });
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'soc-too-low');
  assert.equal(r.current.chargeCeilingPct, null);
  assert.equal(r.current.saturationThresholdPct, 90);
});

test('curtailment — opportunistic loads marked as "fits" iff surplus ≥ estimatedW', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10));
  // Surplus = 5000 W (from previous case). Loads: pool=1800, dehumid=700,
  // precool=3500, waterhtr=4500, ev=7200. First 4 should fit, EV should not.
  const devices = buildDevices({ dpuSocPct: 99, dpuPvWatts: 2000, shp2LoadWatts: 1800 });
  const r = await computeCurtailment(devices, emptyRecorder());
  const pool = r.opportunisticLoads.find((o) => o.id === 'pool_pump_high');
  const dehum = r.opportunisticLoads.find((o) => o.id === 'dehumidifier');
  const precool = r.opportunisticLoads.find((o) => o.id === 'ac_precool');
  const waterhtr = r.opportunisticLoads.find((o) => o.id === 'water_heater');
  const ev = r.opportunisticLoads.find((o) => o.id === 'ev_charge_full');
  assert.equal(pool!.fitsInSurplus, true,  'pool pump (1.8 kW) fits 5 kW surplus');
  assert.equal(dehum!.fitsInSurplus, true, 'dehumidifier (0.7 kW) fits');
  assert.equal(precool!.fitsInSurplus, true, 'AC pre-cool (3.5 kW) fits');
  assert.equal(waterhtr!.fitsInSurplus, true, 'water heater (4.5 kW) fits');
  assert.equal(ev!.fitsInSurplus, false, 'EV charge (7.2 kW) does NOT fit 5 kW surplus');
});

test('curtailment — inactive when no SHP2 in snapshot (DPU-only setup)', async () => {
  withFreshState();
  setWeatherCacheForTesting(syntheticWeatherNow(700));
  setBayesianModelForTesting(mockBayes(10));
  // No SHP2 = no "home" definition. Engine bails before evaluating
  // active/inactive, so inactiveReason should be 'no-shp2' (not the
  // membership-filter default 'no-home-dpus' — that path only triggers
  // when there's an SHP2 but no SHP2-connected DPUs).
  const dpuSn = 'DPU-LONE';
  const devices: Record<string, DeviceSnapshot> = {
    [dpuSn]: {
      sn: dpuSn, deviceName: 'Core', productName: 'Delta Pro Ultra',
      online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'dpu', soc: 99, pvTotalWatts: 2000, pvHighWatts: 2000, pvLowWatts: 0,
        pvHighVolts: 200, pvHighAmps: 10, pvLowVolts: 0, pvLowAmps: 0,
        acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 53, batAmp: 0, mpptHvTemp: 30, mpptLvTemp: 30,
        sysErrCode: 0, pvHighErrCode: 0, pvLowErrCode: 0,
        emsParaVolMinMv: 47_500, emsParaVolMaxMv: 56_000, packs: [],
      } as any,
    } as any,
  };
  const r = await computeCurtailment(devices, emptyRecorder());
  assert.equal(r.active, false);
  assert.equal(r.inactiveReason, 'no-shp2');
});

test('cleanup — clear test seams', () => {
  clearWeatherTestOverride();
  setBayesianModelForTesting(null);
  resetForecastCachesForTesting();
});
