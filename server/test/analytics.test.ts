import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rootCausesFor,
  parseRange,
  onPeakAt,
  forecastDayAlerts,
  type DayForecast,
} from '../src/analytics.js';

test('rootCausesFor — direct match against a graph leaf', () => {
  const causes = rootCausesFor('forecast-low-solar');
  // The DAG has soiling-pv and mppt-efficiency-drop pointing at forecast-low-solar
  assert.ok(causes.length >= 2);
  assert.ok(causes.some((c) => c.id === 'soiling-pv'));
  assert.ok(causes.some((c) => c.id === 'mppt-efficiency-drop'));
});

test('rootCausesFor — alert id with a device suffix still matches the family', () => {
  // Real alerts have IDs like "forecast-soc-dip" or "baseline-load-Y7..."
  const causes = rootCausesFor('forecast-soc-dip-Y7XYZ');
  // forecast-low-solar / soiling-pv / storm-prep / baseline-load point at forecast-soc-dip
  assert.ok(causes.length >= 1);
});

test('rootCausesFor — unknown id returns empty array', () => {
  const causes = rootCausesFor('this-alert-does-not-exist');
  assert.equal(causes.length, 0);
});

test('parseRange — "15-20" → [15, 20]', () => {
  assert.deepEqual(parseRange('15-20'), [15, 20]);
});

test('parseRange — invalid input → null', () => {
  assert.equal(parseRange(''), null);
  assert.equal(parseRange('abc'), null);
  assert.equal(parseRange('15'), null);
});

test('onPeakAt — APS-Saver-style (default 15-20, Mon-Fri)', () => {
  // Tuesday 4pm = on-peak
  const tuesday4pm = new Date(2026, 4, 19, 16, 0, 0).getTime();
  assert.equal(onPeakAt(tuesday4pm), true);
  // Tuesday 9am = off-peak (before window)
  const tuesday9am = new Date(2026, 4, 19, 9, 0, 0).getTime();
  assert.equal(onPeakAt(tuesday9am), false);
  // Tuesday 9pm = off-peak (after window: 15-20 means h<20 is in)
  const tuesday9pm = new Date(2026, 4, 19, 21, 0, 0).getTime();
  assert.equal(onPeakAt(tuesday9pm), false);
  // Saturday 4pm = off-peak (weekend excluded by default 1-5)
  const sat4pm = new Date(2026, 4, 23, 16, 0, 0).getTime();
  assert.equal(onPeakAt(sat4pm), false);
});

function emptyForecast(overrides: Partial<DayForecast>): DayForecast {
  return {
    generatedAt: Date.now(),
    hasWeather: true,
    historyDays: 30,
    reserveSoc: 15,
    hours: [],
    forecastPvWhNext24: 50_000,
    typicalPvWhPerDay: 50_000,
    minProjectedSoc: null,
    minProjectedSocTs: null,
    solarModel: { hourly: [], peakCoeff: 0, pairCount: 0, historyDays: 30 },
    deviceModels: [],
    soiling: null,
    ...overrides,
  };
}

test('forecastDayAlerts — no alerts when forecast is healthy', () => {
  const df = emptyForecast({});
  const alerts = forecastDayAlerts(df);
  assert.equal(alerts.length, 0);
});

test('forecastDayAlerts — fires forecast-soc-dip when minProjectedSoc < reserveSoc', () => {
  const df = emptyForecast({
    minProjectedSoc: 8,
    minProjectedSocTs: Date.now() + 6 * 3600 * 1000,
    reserveSoc: 15,
    // Need hours to drive the cloud-cover counterfactual.
    hours: Array.from({ length: 24 }, (_, h) => ({
      ts: Date.now() + h * 3600 * 1000,
      forecastPvW: 1000,
      forecastLoadW: 800,
      cloudCoverPct: 60,
      ghiWm2: 500,
      projectedSocPct: 30 - h,
      modelled: true,
    })),
  });
  const alerts = forecastDayAlerts(df);
  const dip = alerts.find((a) => a.id === 'forecast-soc-dip');
  assert.ok(dip, 'expected forecast-soc-dip alert');
  // v0.8.0 counterfactual: detail should reference cloud cover
  assert.match(dip!.detail, /cloud/i);
  // Facts should include cloud cover
  assert.ok(dip!.facts?.some((f) => f.label === 'Avg cloud cover'));
});

test('forecastDayAlerts — fires forecast-low-solar when next-24h is <60% of typical', () => {
  const df = emptyForecast({
    forecastPvWhNext24: 20_000,   // 40% of typical
    typicalPvWhPerDay: 50_000,
    hasWeather: true,
    hours: Array.from({ length: 24 }, (_, h) => ({
      ts: Date.now() + h * 3600 * 1000,
      forecastPvW: 500,
      forecastLoadW: 800,
      cloudCoverPct: 75,
      ghiWm2: 200,
      projectedSocPct: null,
      modelled: true,
    })),
  });
  const alerts = forecastDayAlerts(df);
  const low = alerts.find((a) => a.id === 'forecast-low-solar');
  assert.ok(low, 'expected forecast-low-solar alert');
  // Should have the counterfactual cloud-cover fact
  assert.ok(low!.facts?.some((f) => f.label === 'Avg cloud cover'));
});

test('forecastDayAlerts — fires soiling-pv when drop ≥ 12% and ≥ 6 clean days', () => {
  const df = emptyForecast({
    soiling: { dropPct: 18, baselineCoeff: 10, recentCoeff: 8.2, cleanDays: 10 },
  });
  const alerts = forecastDayAlerts(df);
  const soil = alerts.find((a) => a.id === 'soiling-pv');
  assert.ok(soil, 'expected soiling-pv alert');
});

test('forecastDayAlerts — does NOT fire soiling-pv when below threshold', () => {
  const df = emptyForecast({
    soiling: { dropPct: 8, baselineCoeff: 10, recentCoeff: 9.2, cleanDays: 10 },
  });
  const alerts = forecastDayAlerts(df);
  assert.equal(alerts.find((a) => a.id === 'soiling-pv'), undefined);
});
