import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleHostTemp, liveHostTemp, hostTempLevel, _resetHostTempForTest,
  HOST_TEMP_WARN_C, HOST_TEMP_CRIT_C, HOST_TEMP_HYST_C, HOST_TEMP_MAX_AGE_MS,
} from '../src/hostThermal.js';

/* v1.42.0 — host thermal monitor: max-of-zones sampling with validity bounds,
 * staleness-honest holder, and rise/clear hysteresis on the alert level. */

test('sample — hottest valid zone wins; invalid readings rejected', () => {
  _resetHostTempForTest();
  assert.equal(sampleHostTemp(1000, () => [63.2, 61.0, NaN]), 63.2);
  assert.equal(liveHostTemp(1000)?.tempC, 63.2);
  // absurd readings (disconnected sensor artifacts) are not temperatures
  _resetHostTempForTest();
  assert.equal(sampleHostTemp(1000, () => [0, 250, NaN]), null);
  assert.equal(liveHostTemp(1000), null, 'no valid zone ⇒ null, never fabricated');
});

test('holder — staleness bound: an old sample reads null', () => {
  _resetHostTempForTest();
  sampleHostTemp(1000, () => [70]);
  assert.equal(liveHostTemp(1000 + HOST_TEMP_MAX_AGE_MS - 1)?.tempC, 70);
  assert.equal(liveHostTemp(1000 + HOST_TEMP_MAX_AGE_MS + 1), null);
});

test('hysteresis — fires at threshold, clears only below threshold − hyst', () => {
  let lvl: ReturnType<typeof hostTempLevel> = 'ok';
  lvl = hostTempLevel(HOST_TEMP_WARN_C - 1, lvl); assert.equal(lvl, 'ok');
  lvl = hostTempLevel(HOST_TEMP_WARN_C, lvl);     assert.equal(lvl, 'warn');
  // dips just under the line HOLD (no churn)
  lvl = hostTempLevel(HOST_TEMP_WARN_C - 1, lvl); assert.equal(lvl, 'warn');
  lvl = hostTempLevel(HOST_TEMP_WARN_C - HOST_TEMP_HYST_C - 1, lvl); assert.equal(lvl, 'ok');
  // escalation is immediate; de-escalation steps down through warn
  lvl = hostTempLevel(HOST_TEMP_CRIT_C, lvl);     assert.equal(lvl, 'crit');
  lvl = hostTempLevel(HOST_TEMP_CRIT_C - 1, lvl); assert.equal(lvl, 'crit', 'crit holds in hysteresis band');
  lvl = hostTempLevel(HOST_TEMP_CRIT_C - HOST_TEMP_HYST_C - 1, lvl); assert.equal(lvl, 'warn');
});
