/**
 * v0.36.0 — solar-fraction / carbon "whole-home grid" coalesce.
 *
 * Two self-consumption KPIs historically used the UNDERCOUNTING DPU-ac_in grid
 * figure (gridImportKwh = grid that only charged the DPUs):
 *   1. solarFractionOfLoadPct  (computeSelfConsumption)
 *   2. carbon gridDisplacedKwh (computeCarbonReport)
 * The authoritative whole-home grid import is gridToHomeKwh (SHP2 main,
 * wattInfo.gridWatt), a superset of ac-in. Both KPIs now use the coalesced
 * value `max(gridToHomeKwh, gridImportKwh)`:
 *   • when grid_home_w has history, gridToHomeKwh ≥ gridImportKwh → max picks the
 *     correct (larger) whole-home value → lower solar fraction, less CO₂ avoided;
 *   • when grid_home_w has NO history yet (fresh install / pre-v0.34.0 window),
 *     gridToHomeKwh = 0 → max falls back to gridImportKwh → identical to the OLD
 *     behavior (no 7-day data-gate cliff, no penalty for new installs).
 *
 * These tests drive both consumers end-to-end through the public compute*
 * functions with synthetic recorder series, following the analyticsHealthFixes
 * self-consumption fixture style.
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

/** One SHP2-connected DPU with one pack. SN matches shp2Snap's sources list. */
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

/** SHP2 whose membership.sources includes the DPU above. */
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

/** Recorder whose queryMulti serves a fixed metric→samples map (SN-agnostic;
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

/** Constant-watt samples every 5 min over a full 24h day at `dayStart`. */
function flatDay(dayStart: number, watts: number): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  const DAY = 86_400_000;
  const step = 5 * 60_000;
  for (let t = dayStart; t <= dayStart + DAY; t += step) out.push({ ts: t, value: watts });
  return out;
}

/** Build a 1-day window's worth of series. Load is the SHP2 panel_load;
 *  acInW is the DPU ac_in (subset grid); gridHomeW is the SHP2 grid_home_w
 *  (whole-home grid). pvW feeds pv_total. */
function buildSeries(opts: {
  loadW: number; acInW: number; gridHomeW: number; pvW: number;
}): Record<string, Array<{ ts: number; value: number }>> {
  const todayStart = startOfLocalDayMs();
  const yesterday = todayStart - 86_400_000; // one fully-covered completed day
  return {
    panel_load: flatDay(yesterday, opts.loadW),
    ac_in: flatDay(yesterday, opts.acInW),
    grid_home_w: flatDay(yesterday, opts.gridHomeW),
    pv_total: flatDay(yesterday, opts.pvW),
    pack1_in: flatDay(yesterday, 0),
    pack1_out: flatDay(yesterday, 0),
  };
}

const fleet = () => ({ ...dpuSnap(), ...shp2Snap() });

/* ─── (a) whole-home grid > ac-in subset → coalesce picks the larger ─────── */

test('solarFraction + gridDisplaced use whole-home grid when grid_home_w > ac_in', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  // Load 1000 W. DPU ac_in (subset) = 200 W. Whole-home grid = 600 W (3× the
  // subset — the panel feeds home loads directly, not just DPU charging).
  const rec = recorderFor(buildSeries({ loadW: 1000, acInW: 200, gridHomeW: 600, pvW: 0 }));

  const sc = computeSelfConsumption(fleet(), rec, 7);
  // Both raw figures are still reported.
  assert.ok(sc.gridToHomeKwh > sc.gridImportKwh, 'whole-home grid must exceed the ac-in subset');
  // solarFraction uses the LARGER whole-home grid → (load − 600)/load = 40%,
  // NOT the inflated (load − 200)/load = 80% the old undercounting figure gave.
  assert.ok(
    sc.solarFractionOfLoadPct != null &&
      Math.abs(sc.solarFractionOfLoadPct - 40) < 1,
    `solarFraction should be ~40% (whole-home grid), got ${sc.solarFractionOfLoadPct}`,
  );
  // Sanity: the old undercounting figure would have been ~80%.
  const oldFraction = (1 - sc.gridImportKwh / sc.loadKwh) * 100;
  assert.ok(oldFraction > 75 && oldFraction < 85, 'old ac-in-only fraction was ~80% (the bug)');

  resetSelfConsumptionCache();
  const carbon = computeCarbonReport(fleet(), rec, 7);
  // gridDisplaced = load − whole-home grid = (load − 600 W integral). With the
  // OLD ac-in figure it would have displaced (load − 200 W) → ~3× more CO₂.
  const displacedKwhWholeHome = Math.max(0, sc.loadKwh - sc.gridToHomeKwh);
  const displacedKwhOld = Math.max(0, sc.loadKwh - sc.gridImportKwh);
  assert.ok(displacedKwhWholeHome < displacedKwhOld, 'whole-home grid displaces LESS than the ac-in undercount');
  // totalKgAvoided must track the smaller whole-home displacement, not the old one.
  const intensity = carbon.gridCo2IntensityKgPerKwh;
  assert.ok(
    Math.abs(carbon.totalKgAvoided - displacedKwhWholeHome * intensity) < 0.5,
    `totalKgAvoided should reflect whole-home displacement ${(displacedKwhWholeHome * intensity).toFixed(2)}, got ${carbon.totalKgAvoided}`,
  );
  assert.ok(
    carbon.totalKgAvoided < displacedKwhOld * intensity - 0.5,
    'carbon must be lower than the old ac-in-only overstatement',
  );
});

/* ─── (b) no grid_home_w history → fall back to ac-in (regression guard) ──── */

test('solarFraction + gridDisplaced fall back to ac_in when grid_home_w is absent (fresh install)', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  // grid_home_w has NO data yet (fresh install / pre-v0.34.0 window) → 0.
  const rec = recorderFor(buildSeries({ loadW: 1000, acInW: 200, gridHomeW: 0, pvW: 0 }));

  const sc = computeSelfConsumption(fleet(), rec, 7);
  assert.equal(round1(sc.gridToHomeKwh), 0, 'grid_home_w empty → gridToHomeKwh reads 0');
  assert.ok(sc.gridImportKwh > 0, 'ac-in subset still has data');
  // max(0, gridImportKwh) = gridImportKwh → identical to the OLD behavior:
  // (load − 200)/load ≈ 80%.
  const oldFraction = Math.max(0, Math.round(((sc.loadKwh - sc.gridImportKwh) / sc.loadKwh) * 1000) / 10);
  assert.equal(
    sc.solarFractionOfLoadPct, oldFraction,
    'with no grid_home_w history the fraction must EXACTLY equal the legacy ac-in result',
  );
  assert.ok(
    sc.solarFractionOfLoadPct != null && Math.abs(sc.solarFractionOfLoadPct - 80) < 1,
    `fresh-install fraction should be the legacy ~80%, got ${sc.solarFractionOfLoadPct}`,
  );

  resetSelfConsumptionCache();
  const carbon = computeCarbonReport(fleet(), rec, 7);
  const displacedKwhOld = Math.max(0, sc.loadKwh - sc.gridImportKwh);
  const intensity = carbon.gridCo2IntensityKgPerKwh;
  assert.ok(
    Math.abs(carbon.totalKgAvoided - displacedKwhOld * intensity) < 0.5,
    `fresh-install carbon must equal the legacy ac-in displacement ${(displacedKwhOld * intensity).toFixed(2)}, got ${carbon.totalKgAvoided}`,
  );
});

/* ─── pure coalesce semantics (no recorder) ──────────────────────────────── */

test('coalesce semantics — max(gridToHome, gridImport) picks superset, falls back at 0', () => {
  const coalesce = (gridToHomeKwh: number, gridImportKwh: number) =>
    Math.max(gridToHomeKwh, gridImportKwh);
  assert.equal(coalesce(6, 2), 6, 'whole-home grid present → use the larger superset');
  assert.equal(coalesce(0, 2), 2, 'whole-home grid absent → fall back to ac-in (legacy)');
  assert.equal(coalesce(0, 0), 0, 'both empty → 0');
  assert.equal(coalesce(5, 5), 5, 'equal → idempotent');
});

function round1(n: number): number { return Math.round(n * 10) / 10; }
