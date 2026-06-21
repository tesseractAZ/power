/**
 * v0.36.0 / v0.40.0 — solar-fraction & carbon "whole-home grid" term, COVERAGE-GATED.
 *
 * Two self-consumption KPIs (solarFractionOfLoadPct, carbon gridDisplacedKwh) difference
 * load against grid. The authoritative whole-home grid is gridToHomeKwh (SHP2 main,
 * wattInfo.gridWatt / grid_home_w) — a superset of the DPU-ac_in subset (gridImportKwh).
 *
 *  • v0.39.0 coalesced both to max(gridToHomeKwh, gridImportKwh). But grid_home_w was
 *    instrumented in v0.34.0 with NO back-fill, so right after the update it covers only
 *    the TAIL of the 7-day window while load covers all of it → integrateWh reports the
 *    partial grid integral as a full-window total → grid is undercounted ~5× → the KPIs
 *    came out impossibly inflated (live: solar_fraction_of_load = 91.8 %, vs ~46 % ceiling).
 *  • v0.40.0 adds a COVERAGE GATE: trust the whole-home term only when grid_home_w is
 *    measured wherever panel_load is (coverage ratio ≥ GRID_HOME_MIN_COVERAGE = 0.9).
 *    SHP2 home + grid_home_w not yet spanning the load window → gridForKpiKwh = null →
 *    KPIs publish null (honest "unknown") rather than a wrong number. No SHP2 → ac_in.
 *
 * These tests drive both consumers end-to-end through the public compute* functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSelfConsumption,
  computeCarbonReport,
  resetSelfConsumptionCache,
  resetDailyEnergyCache,
} from '../src/analytics.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ─── fixtures (mirror analyticsHealthFixes.test.ts) ─────────────────────── */

function dpuSnap(sn = 'SN-SC-DPU'): Record<string, DeviceSnapshot> {
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

function shp2Snap(sn = 'SN-SC-SHP2', dpuSn = 'SN-SC-DPU'): Record<string, DeviceSnapshot> {
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
        sources: [{ isConnected: true, sn: dpuSn }],
      } as any,
    } as unknown as DeviceSnapshot,
  };
}

/** Recorder whose query/queryMulti serve a fixed metric→samples map (SN-agnostic;
 *  DPU metrics and SHP2 metrics are disjoint so one map serves both). */
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

/** Constant-watt samples every 5 min over `nDays` continuous days from `firstDayStart`. */
function flatDays(firstDayStart: number, nDays: number, watts: number): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  const step = 5 * 60_000;
  for (let t = firstDayStart; t <= firstDayStart + nDays * 86_400_000; t += step) out.push({ ts: t, value: watts });
  return out;
}
/** One fully-covered completed day ending at local midnight. */
function flatDay(dayStart: number, watts: number) { return flatDays(dayStart, 1, watts); }

/** Build a 1-day window's series (load/grid all cover the SAME single day → full coverage). */
function buildSeries(opts: { loadW: number; acInW: number; gridHomeW: number; pvW: number }) {
  const yesterday = startOfLocalDayMs() - 86_400_000;
  return {
    panel_load: flatDay(yesterday, opts.loadW),
    ac_in: flatDay(yesterday, opts.acInW),
    grid_home_w: flatDay(yesterday, opts.gridHomeW),
    pv_total: flatDay(yesterday, opts.pvW),
    pack1_in: flatDay(yesterday, 0),
    pack1_out: flatDay(yesterday, 0),
  } as Record<string, Array<{ ts: number; value: number }>>;
}

const fleet = () => ({ ...dpuSnap(), ...shp2Snap() });
function round1(n: number): number { return Math.round(n * 10) / 10; }

/* ─── (a) whole-home grid > ac-in subset, fully covered → coalesce picks larger ── */

test('solarFraction + gridDisplaced use whole-home grid when grid_home_w covers the window', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  // Load 1000 W. DPU ac_in (subset) = 200 W. Whole-home grid = 600 W, sampled over the
  // SAME day as load → grid_home_w coverage == load coverage → trusted.
  const rec = recorderFor(buildSeries({ loadW: 1000, acInW: 200, gridHomeW: 600, pvW: 0 }));

  const sc = computeSelfConsumption(fleet(), rec, 7);
  assert.ok(sc.gridHomeCoverageFrac >= 0.9, `grid_home_w should be fully covered, got ${sc.gridHomeCoverageFrac}`);
  assert.ok(sc.gridToHomeKwh > sc.gridImportKwh, 'whole-home grid must exceed the ac-in subset');
  // solarFraction uses the LARGER whole-home grid → (load − 600)/load = 40%.
  assert.ok(
    sc.solarFractionOfLoadPct != null && Math.abs(sc.solarFractionOfLoadPct - 40) < 1,
    `solarFraction should be ~40% (whole-home grid), got ${sc.solarFractionOfLoadPct}`,
  );
  assert.ok(sc.gridForKpiKwh != null && Math.abs(sc.gridForKpiKwh - sc.gridToHomeKwh) < 0.01, 'gridForKpiKwh = whole-home term');

  resetSelfConsumptionCache();
  const carbon = computeCarbonReport(fleet(), rec, 7);
  const displacedKwhWholeHome = Math.max(0, sc.loadKwh - sc.gridToHomeKwh);
  const displacedKwhOld = Math.max(0, sc.loadKwh - sc.gridImportKwh);
  assert.ok(displacedKwhWholeHome < displacedKwhOld, 'whole-home grid displaces LESS than the ac-in undercount');
  const intensity = carbon.gridCo2IntensityKgPerKwh;
  assert.ok(
    carbon.totalKgAvoided != null && Math.abs(carbon.totalKgAvoided - displacedKwhWholeHome * intensity) < 0.5,
    `totalKgAvoided should reflect whole-home displacement, got ${carbon.totalKgAvoided}`,
  );
});

/* ─── (b) SHP2 reports zero whole-home grid (but fully covered) → max() falls back ── */

test('solarFraction falls back to ac_in when grid_home_w is covered but zero', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  // grid_home_w present and fully covered but reads 0 (SHP2 measures no whole-home grid).
  const rec = recorderFor(buildSeries({ loadW: 1000, acInW: 200, gridHomeW: 0, pvW: 0 }));

  const sc = computeSelfConsumption(fleet(), rec, 7);
  assert.ok(sc.gridHomeCoverageFrac >= 0.9, 'grid_home_w is covered (just zero) → trusted');
  assert.equal(round1(sc.gridToHomeKwh), 0, 'grid_home_w reads 0');
  assert.ok(sc.gridImportKwh > 0, 'ac-in subset still has data');
  // max(0, gridImportKwh) = gridImportKwh → (load − 200)/load ≈ 80%.
  const expected = Math.max(0, Math.round(((sc.loadKwh - sc.gridImportKwh) / sc.loadKwh) * 1000) / 10);
  assert.equal(sc.solarFractionOfLoadPct, expected, 'covered-but-zero grid_home_w → coalesce uses the ac-in subset');
  assert.ok(sc.solarFractionOfLoadPct != null && Math.abs(sc.solarFractionOfLoadPct - 80) < 1, `should be ~80%, got ${sc.solarFractionOfLoadPct}`);
});

/* ─── (c) the v0.40.0 BUG FIX: grid_home_w spans only the tail → null, not inflated ─ */

test('solarFraction + carbon are NULL when grid_home_w covers only part of the load window', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  const today = startOfLocalDayMs();
  const threeDaysAgo = today - 3 * 86_400_000;
  // Load / ac_in / pv span 3 full days; grid_home_w only the most recent day (the ramp
  // right after the v0.34/v0.36 instrument-add). coverage ratio ≈ 1/3 < 0.9.
  const rec = recorderFor({
    panel_load: flatDays(threeDaysAgo, 3, 1000),
    ac_in: flatDays(threeDaysAgo, 3, 200),
    pv_total: flatDays(threeDaysAgo, 3, 0),
    grid_home_w: flatDay(today - 86_400_000, 600), // only yesterday
    pack1_in: flatDays(threeDaysAgo, 3, 0),
    pack1_out: flatDays(threeDaysAgo, 3, 0),
  });

  const sc = computeSelfConsumption(fleet(), rec, 7);
  assert.ok(sc.loadKwh > 0.5, 'load is present (so a null fraction is the GATE, not the load guard)');
  assert.ok(sc.gridImportKwh > 0 && sc.gridToHomeKwh > 0, 'both grid terms have SOME data');
  assert.ok(sc.gridHomeCoverageFrac < 0.9, `coverage must be sub-threshold, got ${sc.gridHomeCoverageFrac}`);
  assert.equal(sc.gridForKpiKwh, null, 'untrusted grid term → gridForKpiKwh null');
  assert.equal(sc.solarFractionOfLoadPct, null, 'impossible-value guard: publish null over an inflated number');

  resetSelfConsumptionCache();
  const carbon = computeCarbonReport(fleet(), rec, 7);
  assert.equal(carbon.totalKgAvoided, null, 'window carbon nulled when grid term is untrusted');
  assert.equal(carbon.equivMilesNotDriven, null, 'equiv miles nulled too');
  // Lifetime carbon is independent of the window grid term — still a number.
  assert.equal(typeof carbon.lifetimeKgAvoided, 'number', 'lifetime carbon unaffected');
});

/* ─── (d) heal: once grid_home_w spans the load window → trusted whole-home value ── */

test('solarFraction recovers to the whole-home value once grid_home_w spans the window', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  const today = startOfLocalDayMs();
  const threeDaysAgo = today - 3 * 86_400_000;
  const rec = recorderFor({
    panel_load: flatDays(threeDaysAgo, 3, 1000),
    ac_in: flatDays(threeDaysAgo, 3, 200),
    pv_total: flatDays(threeDaysAgo, 3, 0),
    grid_home_w: flatDays(threeDaysAgo, 3, 600), // now spans all of load
    pack1_in: flatDays(threeDaysAgo, 3, 0),
    pack1_out: flatDays(threeDaysAgo, 3, 0),
  });

  const sc = computeSelfConsumption(fleet(), rec, 7);
  assert.ok(sc.gridHomeCoverageFrac >= 0.9, `coverage should heal to full, got ${sc.gridHomeCoverageFrac}`);
  assert.ok(
    sc.solarFractionOfLoadPct != null && Math.abs(sc.solarFractionOfLoadPct - 40) < 1,
    `healed fraction should be ~40% (whole-home), got ${sc.solarFractionOfLoadPct}`,
  );
  resetSelfConsumptionCache();
  const carbon = computeCarbonReport(fleet(), rec, 7);
  assert.ok(carbon.totalKgAvoided != null && carbon.totalKgAvoided > 0, 'window carbon publishes again once trusted');
});

/* ─── no-SHP2 install: ac_in is the legitimate grid measure ──────────────── */

test('DPU-only fleet (no SHP2) keeps a numeric grid term (never null-gated)', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  // No SHP2 → the coverage gate must NOT null the grid term (ac_in is the legitimate
  // measure there); carbon stays a number rather than going "unknown".
  const rec = recorderFor(buildSeries({ loadW: 0, acInW: 200, gridHomeW: 0, pvW: 0 }));
  const sc = computeSelfConsumption(dpuSnap(), rec, 7);
  assert.notEqual(sc.gridForKpiKwh, null, 'no-SHP2 → grid term is the ac-in subset, not null');
  assert.equal(sc.gridHomeCoverageFrac, 0, 'no SHP2 → no grid_home_w coverage');
  const carbon = computeCarbonReport(dpuSnap(), rec, 7);
  assert.equal(typeof carbon.totalKgAvoided, 'number', 'no-SHP2 carbon stays numeric (not null-gated)');
});

/* ─── pure coalesce semantics (trusted path) ─────────────────────────────── */

test('coalesce semantics — max(gridToHome, gridImport) picks superset, falls back at 0', () => {
  const coalesce = (gridToHomeKwh: number, gridImportKwh: number) => Math.max(gridToHomeKwh, gridImportKwh);
  assert.equal(coalesce(6, 2), 6, 'whole-home grid present → use the larger superset');
  assert.equal(coalesce(0, 2), 2, 'whole-home grid zero → fall back to ac-in');
  assert.equal(coalesce(0, 0), 0, 'both empty → 0');
  assert.equal(coalesce(5, 5), 5, 'equal → idempotent');
});
