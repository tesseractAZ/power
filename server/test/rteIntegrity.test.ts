import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRunway,
  resetRunwayCache,
  RUNWAY_DISCHARGE_EFFICIENCY,
  DISPATCH_ROUND_TRIP_EFFICIENCY,
} from '../src/analytics.js';
import type { DayForecast } from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.32.0 — cross-model review of the v1.24–v1.27 finding-driven work.
 *
 * The v1.27.0 DISPATCH_ROUND_TRIP_EFFICIENCY=0.945 was a MISINTERPRETED
 * MEASUREMENT: the pack-terminal-plane RTE (which excludes both conversion
 * legs; live ~0.89–0.92) was conflated with the full PV→pack→AC system round
 * trip because it numerically coincided with the separately-measured
 * discharge-conversion leg (0.945) on 2026-07-14. The v1.27 tests were
 * η-agnostic by construction and structurally could not catch a wrong
 * constant. These tests pin the physics so the class cannot recur.
 */

const HOUR = 3_600_000;

/* ── cross-engine invariant: the test that would have caught v1.27 ── */

test('v1.32.0 — INVARIANT: √(dispatch round trip) ≤ runway discharge leg', () => {
  // A full round trip includes the measured discharge-conversion leg, so its
  // per-leg (√RTE) efficiency can never exceed that single measured leg. The
  // v1.27.0 constant violated this (√0.945 = 0.972 > 0.94) — the violation IS
  // the misinterpretation. Any future constant bump that re-violates it means
  // someone has again mistaken a one-leg or pack-plane number for the system
  // round trip.
  assert.ok(
    Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY) <= RUNWAY_DISCHARGE_EFFICIENCY + 1e-9,
    `√${DISPATCH_ROUND_TRIP_EFFICIENCY} = ${Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY).toFixed(3)} ` +
    `must not exceed the measured discharge leg ${RUNWAY_DISCHARGE_EFFICIENCY}`,
  );
});

test('v1.32.0 — the dispatch round trip sits in the composed three-plane band', () => {
  // η_chg-conv (~0.97) × η_pack-RTE (~0.89–0.92 live) × η_dis-conv (0.945
  // measured) ≈ 0.82–0.86. Allow headroom to 0.90 (mpc.ts's independent
  // estimate) but NEVER back to the 0.945 pack-plane reading.
  assert.ok(
    DISPATCH_ROUND_TRIP_EFFICIENCY >= 0.8 && DISPATCH_ROUND_TRIP_EFFICIENCY <= 0.9,
    `system round trip must stay in the physical [0.80, 0.90] band (got ${DISPATCH_ROUND_TRIP_EFFICIENCY})`,
  );
});

/* ── computeRunway pool cap (pre-existing gap, fixed v1.32.0) ────── */

function shp2(remainingKwh: number, reservePct: number, fullKwh: number): Record<string, DeviceSnapshot> {
  return {
    'SN-SHP2': {
      sn: 'SN-SHP2', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: 0,
      projection: {
        kind: 'shp2',
        backupRemainWh: remainingKwh * 1000,
        backupFullCapWh: fullKwh * 1000,
        backupReserveSoc: reservePct,
        circuits: [],
      } as any,
    } as any,
  };
}

function loadRecorder(loadW: number): Recorder {
  const pts = [{ ts: -HOUR / 2, value: loadW }, { ts: -1, value: loadW }];
  return {
    insertSnapshot: () => {}, query: (_sn, metric) => (metric === 'panel_load' ? pts : []),
    queryMulti: () => new Map(), listMetrics: () => [], listLifetimeKeys: () => [],
    close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

/** Forecast: massive PV surplus for the first `surplusHours`, then dark. */
function surplusThenDark(surplusHours: number, pvW: number, loadW: number): DayForecast {
  const hours = Array.from({ length: 24 }, (_, k) => ({
    ts: k * HOUR,
    forecastPvW: k < surplusHours ? pvW : 0,
    forecastLoadW: loadW,
    projectedSocPct: null,
  }));
  return { minProjectedSoc: 0, reserveSoc: 25, hours } as unknown as DayForecast;
}

test('v1.32.0 — computeRunway caps the pool at capacity: surplus cannot bank phantom energy', () => {
  resetRunwayCache();
  // Near-full pool + 6 h of 20 kW PV against a 4 kW load. Unclamped, the sim
  // banked ~90 + 6×15.7 ≈ 184 kWh — double physical capacity — and the reserve
  // crossing left the 24 h horizon entirely (hoursToReserve null). Clamped, the
  // pool pins at 92.16 through the surplus, and the overnight drain from FULL
  // crosses reserve at ≈ 6 + (92.16−23.04)/(4/0.94) ≈ 22.2 h.
  const full = 92.16, reserve = 23.04, remaining = 90;
  const loadKw = 4;
  const r = computeRunway(shp2(remaining, reserve, full), loadRecorder(loadKw * 1000), surplusThenDark(6, 20_000, loadKw * 1000));
  assert.ok(r.hoursToReserve != null,
    'the reserve crossing must be inside the horizon — phantom above-capacity banking would push it out');
  const expected = 6 + (full - reserve) / (loadKw / RUNWAY_DISCHARGE_EFFICIENCY);
  assert.ok(Math.abs(r.hoursToReserve! - expected) < 0.6,
    `crossing should be ~${expected.toFixed(1)}h (cap-limited); got ${r.hoursToReserve}`);
});
