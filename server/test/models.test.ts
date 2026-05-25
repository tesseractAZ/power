import { test } from 'node:test';
import assert from 'node:assert/strict';
import { physicsPmax, solarPosition, clearSkyGHI, PHOENIX_SITE } from '../src/physics/clearSky.js';
import { socFromOcv, ocvFromSoc, analyzePackLfp } from '../src/physics/lfpOcv.js';
import { fitHierarchical, findOutliers, type HBPackObs } from '../src/models/hierarchicalBayes.js';
import { recommendDispatch, type MpcInputs } from '../src/dispatch/mpc.js';
import { scoreForecast, type ForecastDatum } from '../src/backtest.js';

/* ─── clear-sky PV physics ───────────────────────────────────────── */

test('solarPosition — sun is high near noon on a summer day in Phoenix', () => {
  // June solstice ~12:30 PT (19:30 UTC), Phoenix
  const noon = new Date(Date.UTC(2026, 5, 21, 19, 30));
  const sp = solarPosition(noon, PHOENIX_SITE.lat, PHOENIX_SITE.lon);
  assert.ok(sp.elevation > 70, `expected elevation > 70°, got ${sp.elevation.toFixed(1)}`);
  assert.ok(sp.cosZenith > 0.9, `expected cosZenith > 0.9, got ${sp.cosZenith.toFixed(3)}`);
});

test('solarPosition — sun is below horizon at midnight', () => {
  const midnight = new Date(Date.UTC(2026, 5, 21, 8));  // 1 AM PT
  const sp = solarPosition(midnight, PHOENIX_SITE.lat, PHOENIX_SITE.lon);
  assert.ok(sp.elevation < 0, `expected elevation < 0, got ${sp.elevation.toFixed(1)}`);
  assert.equal(sp.cosZenith, 0);
});

test('clearSkyGHI — peaks at ~1000 W/m² with sun overhead', () => {
  const ghi = clearSkyGHI(1.0);
  assert.ok(ghi > 900 && ghi < 1100, `peak GHI should be ~1000, got ${ghi.toFixed(0)}`);
});

test('physicsPmax — at solar noon produces a substantial fraction of nameplate', () => {
  // Solar noon-ish on a summer day in Phoenix at 35°C ambient
  const ts = Date.UTC(2026, 5, 21, 19, 30);
  const r = physicsPmax(ts, 35);
  assert.ok(r.pMaxW > 8000, `expected pMax > 8 kW at noon, got ${r.pMaxW.toFixed(0)}`);
  assert.ok(r.pMaxW < PHOENIX_SITE.pNamplate, 'pMax should be below nameplate (derate + temp + non-noon optimal tilt)');
});

test('physicsPmax — at night is zero', () => {
  const ts = Date.UTC(2026, 5, 21, 8);  // 1 AM PT
  const r = physicsPmax(ts, 20);
  assert.equal(r.pMaxW, 0);
});

/* ─── LFP OCV ─────────────────────────────────────────────────────── */

test('socFromOcv — round-trip ocv→soc→ocv preserves SoC within 5%', () => {
  for (const soc of [10, 25, 50, 75, 90]) {
    const v = ocvFromSoc(soc, true);
    const back = socFromOcv(v, true);
    assert.ok(back != null, `soc ${soc}% should round-trip`);
    assert.ok(Math.abs(back - soc) <= 5, `soc ${soc}% → ${v.toFixed(3)}V → ${back.toFixed(1)}%`);
  }
});

test('socFromOcv — clamps below 2.5V to 0% and above 3.55V to 100%', () => {
  assert.equal(socFromOcv(2.0, true), 0);
  assert.equal(socFromOcv(4.0, true), 100);
});

test('analyzePackLfp — flags non-resting state', () => {
  const a = analyzePackLfp({
    packVoltageMv: 53_000,
    reportedSoCPct: 70,
    cellVoltagesMv: [3300, 3310, 3320, 3315, 3290],
    packCurrentA: 25,   // high current → not resting
    lastNonRestingAtMs: Date.now(),
  });
  assert.equal(a.isResting, false);
  assert.equal(a.physicsSoCPct, null);
  assert.ok(a.cellSpreadMv != null && a.cellSpreadMv > 0);
});

test('analyzePackLfp — computes physics-implied SoC when rested', () => {
  const longAgo = Date.now() - 20 * 60 * 1000;
  const a = analyzePackLfp({
    packVoltageMv: ocvFromSoc(60, false) * 1000,
    reportedSoCPct: 58,
    cellVoltagesMv: Array.from({ length: 16 }, () => ocvFromSoc(60, true) * 1000),
    packCurrentA: 0.1,
    lastNonRestingAtMs: longAgo,
  });
  assert.equal(a.isResting, true);
  assert.ok(a.physicsSoCPct != null);
  assert.ok(Math.abs((a.physicsSoCPct ?? 0) - 60) < 6, `physics SoC ~60% expected, got ${a.physicsSoCPct?.toFixed(1)}`);
  assert.ok(a.confidence > 0.5);
});

/* ─── hierarchical Bayesian ─────────────────────────────────────── */

test('fitHierarchical — shrinks outlier toward DPU mean', () => {
  // 5 DPUs × 5 packs, mostly clustered around 95% SoH except one outlier at 70%
  const obs: HBPackObs[] = [];
  for (let d = 0; d < 5; d++) {
    for (let p = 0; p < 5; p++) {
      const sohValue = d === 0 && p === 0 ? 70 : 95 + (Math.random() - 0.5) * 2;
      obs.push({
        packKey: `DPU${d}:${p}`,
        dpuKey: `DPU${d}`,
        value: sohValue,
        obsSigma: 1.0,
      });
    }
  }
  const fit = fitHierarchical(obs);
  const outlierResult = fit.packs.find((p) => p.packKey === 'DPU0:0');
  assert.ok(outlierResult);
  // The outlier should have been pulled UP toward DPU0's mean (which is
  // ~80 — average of 70 + four ~95s).
  assert.ok(outlierResult.posteriorMean > 70, 'outlier should be pulled toward DPU mean');
  assert.ok(outlierResult.shrinkageToDpu > 0.1, 'shrinkage should be non-trivial');
});

test('findOutliers — identifies the 70% pack as outlier vs 95% peers', () => {
  const obs: HBPackObs[] = [];
  for (let p = 0; p < 5; p++) {
    obs.push({ packKey: `DPU0:${p}`, dpuKey: 'DPU0', value: p === 0 ? 70 : 96, obsSigma: 0.5 });
    obs.push({ packKey: `DPU1:${p}`, dpuKey: 'DPU1', value: 95, obsSigma: 0.5 });
  }
  const fit = fitHierarchical(obs);
  const outliers = findOutliers(fit, 1.5);
  assert.ok(outliers.some((o) => o.packKey === 'DPU0:0'), 'DPU0:0 should be flagged as outlier');
});

/* ─── MPC dispatch ────────────────────────────────────────────────── */

test('recommendDispatch — produces a 24-step schedule', () => {
  const inputs: MpcInputs = {
    currentSocPct: 60, reserveFloorPct: 20, capacityKwh: 60,
    pvForecastP50: new Array(24).fill(2.5),
    pvForecastP10: new Array(24).fill(1.5),
    loadForecast: new Array(24).fill(2.0),
    tariffOnPeakCentsByHour: Array.from({ length: 24 }, (_, h) => h >= 15 && h < 20 ? 25 : 8),
    gridAvailable: true,
    cyclingCostUsdPerKwh: 0.02,
    reserveDipPenaltyUsdPerKwh: 1.0,
  };
  const r = recommendDispatch(inputs);
  assert.equal(r.steps.length, 24);
  assert.equal(r.setpointSchedule.length, 24);
  // Savings should be >= 0 (optimizer never picks a strictly worse plan than baseline).
  assert.ok(r.savingsVsBaselineUsd >= -0.01, `savings ${r.savingsVsBaselineUsd.toFixed(2)} should be >= 0`);
  // Every step has a recommended reserve in [0, 50].
  for (const s of r.steps) {
    assert.ok(s.recommendedReservePct >= 0 && s.recommendedReservePct <= 50);
  }
});

/* ─── backtest scoring ───────────────────────────────────────────── */

test('scoreForecast — perfect predictions score RMSE=0, MAE=0, bias=0', () => {
  const data: ForecastDatum[] = [
    { ts: 1, predicted: 10, actual: 10 },
    { ts: 2, predicted: 20, actual: 20 },
    { ts: 3, predicted: 30, actual: 30 },
  ];
  const s = scoreForecast(data);
  assert.equal(s.rmse, 0);
  assert.equal(s.mae, 0);
  assert.equal(s.bias, 0);
});

test('scoreForecast — over-prediction shows positive bias', () => {
  const data: ForecastDatum[] = [
    { ts: 1, predicted: 12, actual: 10 },
    { ts: 2, predicted: 22, actual: 20 },
    { ts: 3, predicted: 32, actual: 30 },
  ];
  const s = scoreForecast(data);
  assert.equal(s.bias, 2);
  assert.equal(s.mae, 2);
});

test('scoreForecast — empty input returns zero-everything', () => {
  const s = scoreForecast([]);
  assert.equal(s.n, 0);
  assert.equal(s.rmse, 0);
});
