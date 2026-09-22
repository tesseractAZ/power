/**
 * v1.177.0 — the runway projection reports how LOW the islanded pool goes, and what its
 * recent load actually is.
 *
 * The card printed "no dip in 24 h — forecast PV keeps up with load" whenever the reserve
 * floor was not crossed, and the only condition behind it was that crossing. Live on
 * 2026-09-22 the same payload projected the pool falling 78 → 26 kWh (PV covering 57% of the
 * load). The simulation now records its minimum and end state — reporting only; the crossing
 * detectors and the alarm are untouched — and names the basis of `recentLoadWatts`.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { computeRunway, resetRunwayCache, type DayForecast } from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

type Pt = { ts: number; value: number };
const H = 3_600_000, MIN = 60_000;

const shp2 = (remainWh: number, circuitWatts: Array<number | null> = []) => ({
  SHP2: {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'shp2', backupFullCapWh: 92_000, backupRemainWh: remainWh, backupReserveSoc: 16,
      circuits: circuitWatts.map((w, i) => ({ ch: i + 1, watts: w })), pairedCircuits: [],
    },
  },
}) as any;

const rec = (rows: Pt[]): Recorder => makeRecorderStub({
  query: (_sn: string, metric: string) => (metric === 'panel_load' ? rows : []),
  queryMulti: () => new Map(),
  listMetrics: () => ['panel_load'],
}) as any;

const hourRows = (w: number, now = Date.now()) => Array.from({ length: 60 }, (_, i) => ({ ts: now - (60 - i) * MIN, value: w }));

/** A 24 h forecast: PV `pvKw` in hours 8-15 (a solar day; every hour when `allDay`), a flat
 *  `loadKw` load curve. */
function forecast(loadKw: number, pvKw: number, allDay = false): DayForecast {
  return {
    generatedAt: Date.now(), hasWeather: true, historyDays: 30, reserveSoc: 16,
    hours: Array.from({ length: 24 }, (_, h) => ({
      ts: Date.now() + h * H, forecastPvW: allDay || (h >= 8 && h < 16) ? pvKw * 1000 : 0, forecastLoadW: loadKw * 1000,
      cloudCoverPct: 0, ghiWm2: 0, projectedSocPct: null, modelled: true,
    })),
    forecastPvWhNext24: pvKw * 8 * 1000, typicalPvWhPerDay: 0, forecastPvWhNext24Display: pvKw * 8 * 1000,
    typicalPvWhPerDayDisplay: 0, restoredSolarModel: {} as any,
  } as any;
}

test('★★★ a drain that stops above the floor reports its lowest point — the case the card called "no dip"', () => {
  resetRunwayCache();
  // 78 kWh now, 16% reserve (14.72 kWh). 2 kW load for 24 h, 5 kW PV for 8 h:
  // the pool drains ~2.1 kWh/h for 8 h, gains ~2.9 kWh/h for 8 h, then drains again.
  const r = computeRunway(shp2(78_000), rec(hourRows(2000)), forecast(2, 5));
  assert.equal(r.hoursToReserve, null, 'the floor is never crossed');
  assert.ok(r.troughKwh != null && r.troughKwh < 78 && r.troughKwh > 14.72, `a real dip above the floor (${r.troughKwh})`);
  assert.ok(r.troughAtMs != null && r.troughAtMs > r.generatedAt, 'with a time');
  assert.ok(r.endKwh != null && r.endKwh < 78, `ends below where it started (${r.endKwh})`);
});

test('★★ a pool that only rises has its lowest point NOW', () => {
  resetRunwayCache();
  const r = computeRunway(shp2(40_000), rec(hourRows(300)), forecast(0.3, 2, true));
  assert.equal(r.troughKwh, 40, 'the minimum is the starting pool');
  assert.equal(r.troughAtMs, r.generatedAt, 'at hour 0');
});

test('the trough never goes below zero and never exceeds capacity (the sim clamps)', () => {
  resetRunwayCache();
  const r = computeRunway(shp2(10_000), rec(hourRows(6000)), forecast(6, 0));
  assert.equal(r.troughKwh, 0);
  assert.ok(r.hoursToEmpty != null);
});

test('the crossing detectors are unchanged by the trough tracking (reporting only)', () => {
  resetRunwayCache();
  const r = computeRunway(shp2(30_000), rec(hourRows(3000)), forecast(3, 0));
  assert.ok(r.hoursToReserve != null && r.hoursToReserve > 4 && r.hoursToReserve < 6.5, `${r.hoursToReserve}`);
  assert.ok(r.troughKwh != null && r.troughKwh <= 14.72, 'a crossing projection bottoms out at or below the floor');
});

/* ── the basis of recentLoadWatts ─────────────────────────────────────────── */

test('★★ recentLoadBasis names what recentLoadWatts is', () => {
  resetRunwayCache();
  assert.equal(computeRunway(shp2(60_000), rec(hourRows(1800)), forecast(2, 3)).recentLoadBasis, 'hour-mean');

  resetRunwayCache();
  const live = computeRunway(shp2(60_000, [900, 900]), rec([]), forecast(2, 3));
  assert.equal(live.recentLoadBasis, 'live', 'no rows in the hour: the live channel sum');
  assert.equal(live.recentLoadWatts, 1800);

  resetRunwayCache();
  const one = computeRunway(shp2(60_000, [null, null]), rec([{ ts: Date.now() - 5 * MIN, value: 1500 }]), forecast(2, 3));
  assert.equal(one.recentLoadBasis, 'single-sample');
});

test('recentLoadBasis "carried" when the previous compute’s value is re-used', () => {
  resetRunwayCache();
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const rows = hourRows(2200, now);
    const r = rec([]);
    (r as any).query = (_sn: string, metric: string) => (metric === 'panel_load' ? rows.filter((p) => p.ts >= now - H && p.ts <= now) : []);
    assert.equal(computeRunway(shp2(60_000, [null]), r, forecast(2, 3)).recentLoadBasis, 'hour-mean');
    now += 70 * MIN; // the hour has passed, no new rows, panel silent
    const carried = computeRunway(shp2(60_000, [null]), r, forecast(2, 3));
    assert.equal(carried.recentLoadBasis, 'carried');
  } finally {
    clock.mock.restore();
    resetRunwayCache();
  }
});

test('an unavailable projection carries nulls, never fabricated values', () => {
  resetRunwayCache();
  const r = computeRunway({} as any, rec([]), null);
  assert.ok(r.unavailable);
  assert.equal(r.troughKwh, null);
  assert.equal(r.troughAtMs, null);
  assert.equal(r.endKwh, null);
  assert.equal(r.recentLoadBasis, null);
});
