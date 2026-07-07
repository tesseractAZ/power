/**
 * v0.93.0 (audit #5) — computeTariffReport whole-home grid cost, COVERAGE-GATED.
 *
 * Bug: gridImportCost was built ONLY from the DPU `ac_in` series. On an SHP2 home the
 * real grid flows through the SHP2 main (grid_home_w) while ac_in reads ~0 → the report
 * showed gridImportCost=$0 and credited ALL panel_load as solar value (net savings
 * over-stated). Fix mirrors computeSelfConsumption's gridForKpiKwh / gridHomeTrusted:
 * when grid_home_w is measured wherever panel_load is (coverage ≥ 0.9) use the
 * whole-home superset max(grid_home_w, ac_in) per hour; else keep ac_in unchanged.
 *
 * Drives the fix end-to-end through the public computeTariffReport with a flat tariff so
 * the math is exact: cost = grid_kWh × rate, solar value = max(0, load − grid) × rate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTariffReport, resetTariffCache } from '../src/analytics.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ─── fixtures (mirror selfConsumptionGridCoalesce.test.ts) ──────────────── */

function dpuSnap(sn = 'SN-T-DPU'): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn, deviceName: 'DELTA-PRO-ULTRA-1', online: true, lastSeenMs: Date.now(),
      projection: { kind: 'dpu', soc: 80 } as any,
    } as any,
  };
}
function shp2Snap(sn = 'SN-T-SHP2', dpuSn = 'SN-T-DPU'): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn, deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: Date.now(),
      projection: { kind: 'shp2', pairedCircuits: [], circuits: [], sources: [{ isConnected: true, sn: dpuSn }] } as any,
    } as unknown as DeviceSnapshot,
  };
}
const fleet = () => ({ ...dpuSnap(), ...shp2Snap() });

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
  } as unknown as Recorder;
}

/** Constant-watt samples every 5 min over `nDays` continuous days from `firstDayStart`. */
function flatDays(firstDayStart: number, nDays: number, watts: number): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  const step = 5 * 60_000;
  for (let t = firstDayStart; t <= firstDayStart + nDays * 86_400_000; t += step) out.push({ ts: t, value: watts });
  return out;
}
function flatDay(dayStart: number, watts: number) { return flatDays(dayStart, 1, watts); }

/* ─── (a) SHP2 home, grid_home_w covers the window → real grid cost, not $0 ── */

test('gridImportCost reflects grid_home_w on an SHP2 home (not $0)', () => {
  resetTariffCache();
  const yesterday = startOfLocalDayMs() - 86_400_000;
  // Load 1000 W all day. DPU ac_in ≈ 0 (grid serves the home through the SHP2 main).
  // Whole-home grid = 600 W, sampled over the SAME day → coverage == load coverage.
  const rec = recorderFor({
    panel_load: flatDay(yesterday, 1000),
    ac_in: flatDay(yesterday, 0),
    grid_home_w: flatDay(yesterday, 600),
  });
  const r = computeTariffReport(fleet(), rec, 7);
  // Grid cost must be > 0 (the bug reported exactly $0 here).
  assert.ok(r.gridImportCostDollars > 0, `grid cost should be > 0, got $${r.gridImportCostDollars}`);
  // ~24 kWh grid over one day at the default flat 17¢ ≈ $4.08.
  assert.ok(Math.abs(r.gridImportCostDollars - 24 * 0.6 * 0.17) < 0.3,
    `grid cost ~$${(24 * 0.6 * 0.17).toFixed(2)}, got $${r.gridImportCostDollars}`);
  // Solar value credits ONLY load NOT served by grid = (1000−600)/1000 → ~$1.63, NOT the
  // full load ($4.08). So net savings must be LESS than the grid cost here.
  assert.ok(r.solarLoadValueDollars < r.gridImportCostDollars,
    'solar value must exclude grid-served load, not credit all panel_load');
  assert.ok(r.netSavingsDollars < 0, `grid-heavy day → negative net savings, got $${r.netSavingsDollars}`);
});

/* ─── (b) DPU-only install (no grid_home_w) → ac_in unchanged ─────────────── */

test('DPU-only install keeps ac_in as the grid term (no whole-home coverage)', () => {
  resetTariffCache();
  const yesterday = startOfLocalDayMs() - 86_400_000;
  const rec = recorderFor({
    panel_load: flatDay(yesterday, 1000),
    ac_in: flatDay(yesterday, 300),
    // grid_home_w absent → coverage 0 → NOT trusted → ac_in used exactly as before.
  });
  const r = computeTariffReport(fleet(), rec, 7);
  // ~24 kWh × 0.3 × 0.17 ≈ $1.22 from ac_in.
  assert.ok(Math.abs(r.gridImportCostDollars - 24 * 0.3 * 0.17) < 0.3,
    `ac_in grid cost ~$${(24 * 0.3 * 0.17).toFixed(2)}, got $${r.gridImportCostDollars}`);
});

/* ─── (c) untrusted ramp: grid_home_w spans only the tail → keep ac_in ────── */

test('grid_home_w covering only part of the window is NOT trusted → ac_in kept', () => {
  resetTariffCache();
  const today = startOfLocalDayMs();
  const threeDaysAgo = today - 3 * 86_400_000;
  const rec = recorderFor({
    panel_load: flatDays(threeDaysAgo, 3, 1000),
    ac_in: flatDays(threeDaysAgo, 3, 300),
    grid_home_w: flatDay(today - 86_400_000, 600), // only yesterday → coverage ≈ 1/3 < 0.9
  });
  const r = computeTariffReport(fleet(), rec, 7);
  // Must fall back to ac_in (300 W), NOT the partial grid_home_w. ~72 kWh × 0.3 × 0.17.
  assert.ok(Math.abs(r.gridImportCostDollars - 72 * 0.3 * 0.17) < 1.0,
    `untrusted ramp → ac_in cost ~$${(72 * 0.3 * 0.17).toFixed(2)}, got $${r.gridImportCostDollars}`);
});
