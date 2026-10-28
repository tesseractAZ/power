import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastArchivable } from '../src/forecastArchiveGate.js';

const full = { forecastPvWhNext24: 41_200, forecastPvWhNext24Display: 41_200 };

test('forecastArchivable: a forecast on every Core is archived', () => {
  assert.equal(forecastArchivable(full), true);
  // A cloudy day forecast near zero is still a real forecast when both bases agree.
  assert.equal(forecastArchivable({ forecastPvWhNext24: 0, forecastPvWhNext24Display: 0 }), true);
});

test('forecastArchivable: a forecast missing a dark Core is not archived', () => {
  // Every Core dark: the alarm-facing sum drops them all, the restored sum re-adds them.
  assert.equal(forecastArchivable({ forecastPvWhNext24: 0, forecastPvWhNext24Display: 38_900 }), false);
  // One Core of three dark: short, not zero, and still not the day's forecast.
  assert.equal(forecastArchivable({ forecastPvWhNext24: 27_400, forecastPvWhNext24Display: 41_200 }), false);
});

test('forecastArchivable: an unavailable or pending PV basis is not archived', () => {
  assert.equal(forecastArchivable({ ...full, pvForecastUnavailable: true }), false);
  assert.equal(forecastArchivable({ ...full, homeBasisPending: true }), false);
  assert.equal(forecastArchivable({ forecastPvWhNext24: Number.NaN, forecastPvWhNext24Display: Number.NaN }), false);
  assert.equal(forecastArchivable(null), false);
  assert.equal(forecastArchivable(undefined), false);
});
