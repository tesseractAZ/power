/**
 * v1.186.5 — the PV band calibration is bound to the forecast it was scored against.
 *
 * 2026-09-27: a restart at 21:06 built a forecast on a partial device map (the solar model
 * fit on one Core's PV). The forecast-skill hindcast pairs that model with the actual PV of
 * every home Core, so each of 30 days read ~1/3 of actual; the skill was cached for an hour
 * by time alone, and the 21:30 night-charge plan read "PV band coverage 7%", latched "no
 * plan" and cancelled an armed 66 kWh charge. The same inputs re-scored to 97% at 22:14.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeForecastSkill,
  computeProbabilisticForecast,
  getDayForecast,
  homeModelSns,
  resetForecastCachesForTesting,
  type DayForecast,
  type HourResponse,
  type SolarResponseModel,
} from '../src/analytics.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride } from '../src/weather.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { eveningBasisDefers, NIGHT_PLAN_STALE_DEFER_UNTIL_MIN, computeNightChargePlan, buildNightChargeInputs } from '../src/nightChargeAdvisor.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const H = 3_600_000;
const DAY = 24 * H;
const SN = 'DPU-CACHEBOUND';
const devices: Record<string, DeviceSnapshot> = {
  [SN]: { sn: SN, deviceName: 'Core 1', online: true, projection: { kind: 'dpu', soc: 80, packs: [] } } as unknown as DeviceSnapshot,
};
const hourStart = (): number => startOfLocalDayMs() - DAY + 12 * H;

function model(coeff: number): SolarResponseModel {
  const hod = new Date(hourStart()).getHours();
  const hourly: HourResponse[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h, coeff: h === hod ? coeff : null, r2: 0, samples: 0, observedMaxPvW: 0,
  }));
  return { hourly, peakCoeff: coeff, peakGateMinGhiWm2: 300, pairCount: 0, historyDays: 30 };
}
function forecast(coeff: number, generatedAt: number, structurallyIncomplete = false, solarModelSns?: string[]): DayForecast {
  const m = model(coeff);
  return {
    ...(solarModelSns ? { solarModelSns } : {}),
    generatedAt, hasWeather: true, historyDays: 30, reserveSoc: 15, hours: [],
    forecastPvWhNext24: 0, typicalPvWhPerDay: 0, minProjectedSoc: null, minProjectedSocTs: null,
    homeDpusConnected: 0, homeDpusReporting: 0, homeDpusCoveragePartial: false,
    forecastPvWhNext24Display: 0, typicalPvWhPerDayDisplay: 0,
    solarModel: m, restoredSolarModel: m, deviceModels: [], soiling: null, structurallyIncomplete,
  };
}
const rec: Recorder = makeRecorderStub({
  query: (sn, metric) => {
    const hs = hourStart();
    if (sn === 'weather' && (metric === 'ghi_wm2' || metric === 'ghi_wm2_realized')) return [{ ts: hs, value: 300 }];
    if (sn === SN && metric === 'pv_total') return [{ ts: hs + 30 * 60_000, value: 6000 }];
    return [];
  },
});
const yesterday = async (fc: DayForecast): Promise<number | null> => {
  const r = await computeForecastSkill(devices, rec, fc, 7, 'realized');
  return r.days.length ? r.days[r.days.length - 1].predictedKwh : null;
};

beforeEach(() => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting({ fetchedAt: Date.now(), lat: 0, lon: 0, hours: [{ ts: hourStart() + 6 * H, radiationWm2: 0, cloudCoverPct: 0, tempC: 20 }] });
});
afterEach(() => clearWeatherTestOverride());

test('★★★ a skill scored on one forecast is not served for the next one', async () => {
  const t = Date.now();
  assert.equal(await yesterday(forecast(10, t)), 3.0, 'the partial-map model: coeff 10 × 300 W/m²');
  assert.equal(await yesterday(forecast(30, t + 1)), 9.0, 'the complete forecast re-scores (was served 3.0 for the hour)');
});

test('the same forecast still reads the cached skill', async () => {
  const t = Date.now();
  assert.equal(await yesterday(forecast(10, t)), 3.0);
  assert.equal(await yesterday(forecast(30, t)), 3.0, 'same generatedAt ⇒ cache hit');
});

test('★★ a structurally incomplete forecast is never scored, and the complete one after it is', async () => {
  const t = Date.now();
  assert.equal(await yesterday(forecast(10, t, true)), null, 'no days scored on an incomplete forecast');
  assert.equal(await yesterday(forecast(30, t + 1)), 9.0);
});

test('★★★ a model fitted on other Cores than the actuals is not scored; the same Cores are', async () => {
  // The 2026-09-27 shape with the SHP2 present: the boot map had one Core, so the forecast is
  // not flagged incomplete, yet its model covers a third of the plant.
  const t = Date.now();
  assert.equal(await yesterday(forecast(10, t, false, ['DPU-OTHER'])), null, 'model Cores ≠ actual Cores ⇒ not scored');
  assert.equal(await yesterday(forecast(10, t + 1, false, [SN])), 3.0, 'the same Cores ⇒ scored');
});

const dpu = (sn: string): DeviceSnapshot =>
  ({ sn, deviceName: sn, online: true, projection: { kind: 'dpu', soc: 80, packs: [] } } as unknown as DeviceSnapshot);
const panel = (sns: string[]): DeviceSnapshot =>
  ({ sn: 'SHP2-T', deviceName: 'Smart Home Panel 2', online: true,
     projection: { kind: 'shp2', sources: sns.map((sn) => ({ sn, isConnected: true })), pairedCircuits: [], circuits: [] } } as unknown as DeviceSnapshot);
function pvRecorder(): Recorder {
  const now = Date.now();
  const pv: Array<{ ts: number; value: number }> = [];
  for (let d = 1; d <= 20; d++) { const at = new Date(now - d * DAY); at.setHours(12, 0, 0, 0); pv.push({ ts: at.getTime(), value: 6000 }); }
  return makeRecorderStub({
    query: (qsn, metric) => {
      if (qsn === 'weather' && (metric === 'ghi_wm2' || metric === 'ghi_wm2_realized')) return pv.map((p) => ({ ts: p.ts, value: 600 }));
      if (qsn.startsWith('DPU-') && metric === 'pv_total') return pv;
      return [];
    },
    queryMulti: (qsn, metrics) => new Map(metrics.map((m) => [m, qsn.startsWith('DPU-') && m === 'pv_total' ? pv : []])),
  });
}

test('★★★ a real forecast and the skill use ONE Core set: the panel\'s connected Cores, not a projected bench Core', async () => {
  // Were the two sides built by different filters, every real skill would come back empty
  // and the night-charge basis gate would fail every night.
  setWeatherCacheForTesting(null);
  const map: Record<string, DeviceSnapshot> = {
    'SHP2-T': panel(['DPU-A', 'DPU-B']), 'DPU-B': dpu('DPU-B'), 'DPU-A': dpu('DPU-A'), 'DPU-BENCH': dpu('DPU-BENCH'),
  };
  const r2 = pvRecorder();
  const fc = await getDayForecast(map, r2, () => {});
  assert.deepEqual(fc.solarModelSns, ['DPU-A', 'DPU-B'], 'the bench Core is not in the model set');
  assert.deepEqual(homeModelSns(map), ['DPU-A', 'DPU-B']);
  setWeatherCacheForTesting({ fetchedAt: Date.now(), lat: 0, lon: 0, hours: [{ ts: hourStart() + 6 * H, radiationWm2: 0, cloudCoverPct: 0, tempC: 20 }] });
  // This minimal panel has no pool capacity ⇒ the forecast is (rightly) structurallyIncomplete;
  // clear that flag so this isolates the Core-set agreement.
  const skill = await computeForecastSkill(map, r2, { ...fc, structurallyIncomplete: false }, 7, 'realized');
  assert.ok(skill.days.length > 0, 'the same map ⇒ the Core-set check passes and days are scored');
});

test('★★★ a cached forecast whose Cores differ from the map is rebuilt, not served for its TTL', async () => {
  setWeatherCacheForTesting(null);
  const r2 = pvRecorder();
  const partial = { 'SHP2-T': panel(['DPU-A', 'DPU-B']), 'DPU-A': dpu('DPU-A') };
  const full = { ...partial, 'DPU-B': dpu('DPU-B') };
  const f1 = await getDayForecast(partial, r2, () => {});
  assert.deepEqual(f1.solarModelSns, ['DPU-A']);
  assert.equal(await getDayForecast(partial, r2, () => {}), f1, 'same Cores ⇒ the cache still serves');
  const f2 = await getDayForecast(full, r2, () => {});
  assert.notEqual(f2, f1, 'a Core joined ⇒ rebuilt');
  assert.deepEqual(f2.solarModelSns, ['DPU-A', 'DPU-B']);
});

test('★★ the probabilistic band is reused only for its own forecast, and never cached on an incomplete one', async () => {
  const t = Date.now();
  const a = forecast(10, t);
  const skill = await computeForecastSkill(devices, rec, a, 7, 'realized');
  const p1 = await computeProbabilisticForecast(a, skill);
  assert.equal(await computeProbabilisticForecast(a, skill), p1, 'same forecast ⇒ cached');
  const b = forecast(30, t + 1);
  assert.notEqual(await computeProbabilisticForecast(b, skill), p1, 'a new forecast ⇒ rebuilt');
  resetForecastCachesForTesting();
  const inc = forecast(10, t + 2, true);
  const q1 = await computeProbabilisticForecast(inc, skill);
  assert.notEqual(await computeProbabilisticForecast(inc, skill), q1, 'an incomplete forecast is served, not cached');
});

test('★★★ eveningBasisDefers: a transient-shaped gap waits until the defer deadline; a persistent one is decided at once', () => {
  const at = (h: number, m: number) => h * 60 + m;
  const transient = { basisComplete: false, basisTransient: true };
  assert.equal(eveningBasisDefers(null, at(21, 30)), true);
  assert.equal(eveningBasisDefers(transient, at(21, 30)), true);
  assert.equal(eveningBasisDefers(transient, NIGHT_PLAN_STALE_DEFER_UNTIL_MIN - 1), true);
  assert.equal(eveningBasisDefers(transient, NIGHT_PLAN_STALE_DEFER_UNTIL_MIN), false);
  assert.equal(eveningBasisDefers(null, NIGHT_PLAN_STALE_DEFER_UNTIL_MIN), false);
  assert.equal(eveningBasisDefers({ basisComplete: false, basisTransient: false }, at(21, 30)), false, 'a coverage miss is announced at 21:30');
  assert.equal(eveningBasisDefers({ basisComplete: false }, at(21, 30)), false);
  assert.equal(eveningBasisDefers({ basisComplete: true, basisTransient: false }, at(21, 30)), false);
});

test('★★★ basisTransient reaches the plan: a start-up gap is transient, a young history or a coverage miss is not', () => {
  const EVE = Date.UTC(2026, 8, 18, 4, 30);
  const overnight = (ms: number): string | null => { const h = new Date(ms).getUTCHours(); return h >= 6 && h < 12 ? 'overnight' : 'other'; };
  const hz = Array.from({ length: 30 }, (_, i) => ({ ts: EVE + i * H, pvP10W: 0, loadP90W: 1500 }));
  const plan = (over: Record<string, unknown>) => computeNightChargePlan(buildNightChargeInputs({
    gridInputCapKw: null, nowMs: EVE, fullKwh: 92.16, socNowPct: 30, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2, periodIdAt: overnight, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: hz, dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: null,
    ev: null, evMaxLoadW: 11520, confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 7, bandCoverageFrac: 0.9,
    morningPvSurplusP90Kwh: 10, morningPvSurplusP50Kwh: 5, minBuyKwh: 1, buyDebiasFactor: 1,
    islandedLoadKw: 3, outageCushionHours: 4, islandedLoadSafety: 1.25, objectiveMode: 'cost', costMaxSocPct: 90, longGapAhead: false,
    ...over,
  } as never));
  const shape = (over: Record<string, unknown>) => { const p = plan(over); return [p.basisComplete, p.basisTransient]; };
  assert.deepEqual(shape({ calScoredDays: 0 }), [false, true], 'zero scored days (an empty skill after a restart)');
  assert.deepEqual(shape({ forecastPresent: false }), [false, true], 'no forecast yet');
  assert.deepEqual(shape({ socCoherent: false }), [false, true], 'telemetry not yet coherent');
  assert.deepEqual(shape({ calScoredDays: 5 }), [false, false], 'a young history is persistent');
  assert.deepEqual(shape({ bandCoverageFrac: 0.07 }), [false, false], 'a coverage miss is persistent');
  assert.equal(plan({}).basisComplete, true);
});

test('★★ the evening job defers BEFORE it records a row, notifies, latches or cancels a prior arm', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  const start = src.indexOf('async function runNightChargeEveningJobInner');
  const body = src.slice(start, src.indexOf('\nasync function ', start + 10) > 0 ? src.indexOf('\nasync function ', start + 10) : undefined);
  const defer = body.indexOf('if (eveningBasisDefers(fresh?.plan ?? null, nowMin)) {');
  assert.ok(defer > 0, 'the evening job consults eveningBasisDefers');
  for (const later of [
    'recordNightPlanRow(today, fresh.plan, fresh.extras);',
    "cancelStalePriorArm(today, nowMs, shape === 'hold'",
    'writeNightChargeLatch({ lastNotifyDay: today }); // latch AFTER a successful send',
  ]) {
    const i = body.indexOf(later);
    assert.ok(i > defer, `${later} comes after the defer`);
  }
});
