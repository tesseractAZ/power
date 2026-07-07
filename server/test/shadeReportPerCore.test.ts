import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadeHoursFromCorePvMaps } from '../src/analytics.js';
import type { WeatherHour } from '../src/weather.js';

/*
 * v0.93.0 (audit #9) — shadeHoursFromCorePvMaps must derive the shade shortfall
 * PER-CORE (mirroring fleetSoilingFromDevices), so a single Core's cloud-gap zero
 * hour drops out of its OWN pairs and can NOT deflate the fleet reference — the
 * pre-v0.63.0 fleet-SUM path counted that hour ~1/N short (still positive) and
 * read a phantom 58-91% shortfall while every array was really fine.
 *
 * The tests are deterministic: hour-epochs and clear-sky weather are injected, and
 * hour-of-day is derived by the SAME `new Date(he*3_600_000).getHours()` the helper
 * uses, so they are timezone-agnostic.
 */

const HR = 3_600_000;
const CLEAR: Omit<WeatherHour, 'ts'> = { cloudCoverPct: 5, radiationWm2: 800, tempC: 25 };

// Build a clear-sky weather map + N days × 3 clear hours-of-day of hour-epochs.
// Returns { wx, epochs } where epochs are grouped so every hour-of-day used has
// >= days distinct days (satisfies SHADE_MIN_CLEAR_DAYS=5 and the >=3-hour refCoeff).
function clearSkyGrid(days: number): { wx: Map<number, WeatherHour>; epochs: number[] } {
  const wx = new Map<number, WeatherHour>();
  const epochs: number[] = [];
  // A round epoch far from DST edges; step whole days (24h) so the same 3 local
  // hours-of-day recur each day.
  const baseHe = Math.floor(Date.UTC(2025, 3, 1, 18, 0, 0) / HR); // midday-ish UTC
  for (let d = 0; d < days; d++) {
    for (const hOff of [0, 2, 4]) { // 3 distinct clear hours per day
      const he = baseHe + d * 24 + hOff;
      wx.set(he, { ts: he * HR, ...CLEAR });
      epochs.push(he);
    }
  }
  return { wx, epochs };
}

test('shadeHoursFromCorePvMaps — two clean Cores → no shade, zero kWh', () => {
  const { wx, epochs } = clearSkyGrid(8);
  // Both Cores produce the same coeff (2 W per W/m²) on every clear hour → no shade.
  const coreA = new Map<number, number>(epochs.map((he) => [he, 2 * CLEAR.radiationWm2]));
  const coreB = new Map<number, number>(epochs.map((he) => [he, 2 * CLEAR.radiationWm2]));
  const out = shadeHoursFromCorePvMaps([coreA, coreB], wx);
  assert.equal(out.hours.length, 0);
  assert.equal(out.estTotalKwhPerYear, 0);
});

test('shadeHoursFromCorePvMaps — one Core cloud-gap zeros do NOT create phantom shade', () => {
  const { wx, epochs } = clearSkyGrid(8);
  const full = 2 * CLEAR.radiationWm2;
  const coreA = new Map<number, number>(epochs.map((he) => [he, full]));
  // Core B is a wedged Core: it reports 0 W on the FIRST 6 clear hours (a cloud/
  // telemetry gap), full production otherwise. In the OLD fleet-SUM path those
  // hours summed to ~half (A alone) → a false ~50% fleet shortfall. Per-Core, B's
  // zero hours fail coeff>0 and drop out of B's own pairs; A shows none.
  const coreB = new Map<number, number>(
    epochs.map((he, i) => [he, i < 6 ? 0 : full]),
  );
  const out = shadeHoursFromCorePvMaps([coreA, coreB], wx);
  assert.equal(out.hours.length, 0, 'no phantom shaded hour from a Core gap');
  assert.equal(out.estTotalKwhPerYear, 0, 'no phantom annual kWh shortfall');
});

test('shadeHoursFromCorePvMaps — real uniform shade IS still detected', () => {
  const { wx, epochs } = clearSkyGrid(8);
  // Both Cores really under-produce ~40% vs their own clean p90 on the most recent
  // days. Model: first 4 days clean (coeff 2.0), last 4 days shaded (coeff 1.2) on
  // EVERY hour → per-Core p90 ~2.0, recent observed 1.2 → ~40% shortfall on shaded
  // days, well above the 18% threshold, and it shows up on BOTH Cores.
  const coeffFor = (he: number): number => {
    const dayIdx = Math.floor((he - epochs[0]) / 24);
    return dayIdx >= 4 ? 1.2 : 2.0;
  };
  const coreA = new Map<number, number>(epochs.map((he) => [he, coeffFor(he) * CLEAR.radiationWm2]));
  const coreB = new Map<number, number>(epochs.map((he) => [he, coeffFor(he) * CLEAR.radiationWm2]));
  const out = shadeHoursFromCorePvMaps([coreA, coreB], wx);
  assert.ok(out.hours.length > 0, 'genuine uniform under-production is reported');
  for (const h of out.hours) {
    assert.ok(h.shortfallPct >= 18, `shortfall ${h.shortfallPct}% >= threshold`);
    // expectedW/observedW are fleet-scale SUMS across the 2 contributing Cores.
    assert.ok(h.expectedW > h.observedW);
  }
  assert.ok(out.estTotalKwhPerYear > 0, 'real shade yields a positive kWh/yr estimate');
});

test('shadeHoursFromCorePvMaps — empty input → no hours, zero kWh', () => {
  const out = shadeHoursFromCorePvMaps([], new Map());
  assert.equal(out.hours.length, 0);
  assert.equal(out.estTotalKwhPerYear, 0);
});
