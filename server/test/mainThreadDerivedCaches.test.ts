/**
 * v1.187.18 — derived caches outside the worker's basis reset are bound to the reports they are
 * built from.
 *
 * The worker resets its own result caches when the device basis changes (reports.ts buildReport),
 * but three caches are filled from reports rather than from the device map, and keyed on time alone
 * they outlive the report they were computed from:
 *  - the pack-risk scores (main thread, /api/pack-risk): 2026-10-11 they were built from the boot
 *    degradation report (4 packs of 24) and stood until 12:57:43, after that report was rebuilt;
 *  - the dispatch plan (main thread, /api/dispatch-plan), from the day forecast;
 *  - the multi-day rollup (worker), from the day forecast: a rollup from the boot forecast stood
 *    for 30 min after the forecast itself was rebuilt.
 * Each is now reused only for the same inputs (their generatedAt), and the two forecast-derived
 * ones are never cached from a structurally incomplete forecast (the probabilistic band's rule).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'main-derived-caches-'));
process.env.DATA_DIR = TMP;
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lp.json');
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const A = await import('../src/analytics.js');
const { computePackRiskScores, resetRiskCache, computeDispatchPlan, computeMultiDayForecast, resetForecastCachesForTesting } = A;
const { setWeatherCacheForTesting } = await import('../src/weather.js');

type Any = any;
const H = 3_600_000;
const SN = 'COREXXX00XXX0001';

/* ── pack risk ──────────────────────────────────────────────────────────────────────────────── */

const fleet: Any = { [SN]: { sn: SN, deviceName: 'Core 1', projection: { kind: 'dpu', packs: [{ num: 1 }, { num: 2 }] } } };
const reportsAt = (t: number, fade: number): Any => ({
  degradation: { generatedAt: t, eolSoh: 80, packs: [{ sn: SN, packNum: 1, status: 'projecting', peerFadeRatio: fade, fadePctPerYear: 6, coulombicEffPct: 99 }] },
  thermalEvents: { generatedAt: t, packs: [] },
  internalR: { generatedAt: t, devices: [] },
  chargeCurve: { generatedAt: t, packs: [] },
});
const risk = (r: Any) => computePackRiskScores(fleet, r.degradation, r.thermalEvents, r.internalR, r.chargeCurve);
const pack1 = (rep: Any) => rep.packs.find((p: Any) => p.packNum === 1);

test('★★★ pack risk: a rebuilt degradation report is scored at once, not after the 30-min TTL', () => {
  resetRiskCache();
  const boot = reportsAt(1_000, 1.0);
  const r1 = risk(boot);
  assert.equal(risk(boot), r1, 'the same reports: cached');
  const rebuilt = reportsAt(2_000, 2.5);
  const r2 = risk(rebuilt);
  assert.notEqual(r2, r1, 'a new degradation report: rescored');
  assert.ok(pack1(r2).score0to100 > pack1(r1).score0to100, 'and on its figures');
});

test('★★ pack risk: each of the four input reports keys the cache', () => {
  resetRiskCache();
  const base = reportsAt(5_000, 1.0);
  const r1 = risk(base);
  for (const k of ['thermalEvents', 'internalR', 'chargeCurve']) {
    const next = { ...base, [k]: { ...base[k], generatedAt: 6_000 } };
    assert.notEqual(risk(next), r1, `${k}`);
  }
});

/* ── dispatch plan ──────────────────────────────────────────────────────────────────────────── */

const panel: Any = {
  SHP2: {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', online: true,
    projection: { kind: 'shp2', backupFullCapWh: 92_160, backupRemainWh: 60_000, backupReserveSoc: 16, pairedCircuits: [] },
  },
};
const forecast = (generatedAt: number, loadW: number, incomplete = false): Any => {
  const start = Math.floor(Date.now() / H) * H;
  return {
    generatedAt, hasWeather: true, historyDays: 30, reserveSoc: 16, structurallyIncomplete: incomplete,
    solarModel: { hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, coeff: hour >= 8 && hour < 16 ? 10 : null, observedMaxPvW: 9_000, samples: 30 })) },
    pvBiasFactor: 1,
    forecastPvWhNext24: 0, typicalPvWhPerDay: 0, minProjectedSoc: null, minProjectedSocTs: null,
    hours: Array.from({ length: 24 }, (_, k) => ({
      ts: start + k * H, forecastPvW: k % 24 >= 8 && k % 24 < 16 ? 6_000 : 0, forecastLoadW: loadW,
      cloudCoverPct: 0, ghiWm2: 0, projectedSocPct: null, modelled: true,
    })),
  };
};

test('★★★ dispatch plan: reused only for the forecast it was planned on', () => {
  resetForecastCachesForTesting();
  const f1 = forecast(10_000, 1_000);
  const p1 = computeDispatchPlan(panel, f1);
  assert.equal(computeDispatchPlan(panel, f1), p1, 'the same forecast: cached');
  const p2 = computeDispatchPlan(panel, forecast(20_000, 4_000));
  assert.notEqual(p2, p1, 'a rebuilt forecast: replanned');
  assert.ok(p2.hours[0].loadW > p1.hours[0].loadW, 'on the new forecast\'s load');
});

test('★★★ dispatch plan: a plan on a structurally incomplete forecast is served, never cached', () => {
  resetForecastCachesForTesting();
  const f = forecast(30_000, 1_000, true);
  const p1 = computeDispatchPlan(panel, f);
  assert.ok(p1.hours.length > 0, 'served');
  assert.notEqual(computeDispatchPlan(panel, f), p1, 'not cached: computed again');
});

/* ── multi-day rollup ───────────────────────────────────────────────────────────────────────── */

const wxStart = Math.floor(Date.now() / H) * H - 24 * H;
setWeatherCacheForTesting({
  fetchedAt: Date.now(),
  hours: Array.from({ length: 24 * 6 }, (_, k) => ({ ts: wxStart + k * H, cloudCoverPct: 10, radiationWm2: 400, tempC: 25, ensembleSources: 1 })),
} as Any);
const rec = makeRecorderStub({});

test('★★★ multi-day rollup: reused only for the forecast it was built on', async () => {
  resetForecastCachesForTesting();
  const f1 = forecast(40_000, 1_000);
  const m1 = await computeMultiDayForecast(panel, rec, f1, 3);
  assert.equal(await computeMultiDayForecast(panel, rec, f1, 3), m1, 'the same forecast: cached');
  assert.notEqual(await computeMultiDayForecast(panel, rec, forecast(50_000, 1_000), 3), m1, 'a rebuilt forecast: rebuilt');
});

test('★★★ multi-day rollup: a rollup on a structurally incomplete forecast is served, never cached', async () => {
  resetForecastCachesForTesting();
  const f = forecast(60_000, 1_000, true);
  const m1 = await computeMultiDayForecast(panel, rec, f, 3);
  assert.notEqual(await computeMultiDayForecast(panel, rec, f, 3), m1, 'not cached: computed again');
});
