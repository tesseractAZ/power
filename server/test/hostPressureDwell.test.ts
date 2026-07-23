import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostPressureCritSustained, HOST_PRESSURE_CRIT_DWELL_MS, _resetHostPressureDwellForTest } from '../src/alerts.js';

/* ===================================================================
 * v1.45.0 — host-pressure crit dwell. Ground truth 2026-07-23: four crit
 * episodes in 9.5 h, each 1-3 min (boot load, store refresh, the nightly
 * backup's docker exports); the 05:00:50 one triggered a red broadcast
 * about the backup itself. Crit pressure must SUSTAIN for the dwell before
 * the critical (and its red broadcast) annunciates; transient spikes stay
 * warnings. QoS/degraded-mode keys on the raw assessment and is unaffected.
 * =================================================================== */

const D = HOST_PRESSURE_CRIT_DWELL_MS;

test('a crit spike shorter than the dwell never sustains', () => {
  _resetHostPressureDwellForTest();
  assert.equal(hostPressureCritSustained('crit', 0), false, 'first crit tick starts the clock');
  assert.equal(hostPressureCritSustained('crit', D - 1), false, 'still inside the dwell');
  assert.equal(hostPressureCritSustained('ok', D + 60_000), false, 'cleared — spike over');
  assert.equal(hostPressureCritSustained('crit', D + 120_000), false, 'a NEW spike restarts the clock');
});

test('crit that stands through the dwell sustains, and clearing resets', () => {
  _resetHostPressureDwellForTest();
  hostPressureCritSustained('crit', 0);
  assert.equal(hostPressureCritSustained('crit', D), true, 'sustained at exactly the dwell');
  assert.equal(hostPressureCritSustained('crit', D + 10_000), true, 'stays sustained while crit holds');
  hostPressureCritSustained('warn', D + 20_000);
  assert.equal(hostPressureCritSustained('crit', D + 30_000), false, 'de-escalation cleared the clock');
});

test('dwell default is 180 s', () => {
  assert.equal(D, 180_000);
});
