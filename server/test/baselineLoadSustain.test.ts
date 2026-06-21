import { test } from 'node:test';
import assert from 'node:assert/strict';

// v0.38.0 — sustained-duration notify gate for the per-circuit load-anomaly
// family ("<Circuit> load unusual for the hour"). In a verified 58 h log this
// one family fired/resolved 116× — 72% of all immediate notifications — because
// a normal AC compressor cycle (a few minutes) cleared the standard 60 s notify
// debounce, tripped an immediate "[Medium]" + "Resolved:" pair, then self-
// resolved when the compressor cycled off. The gate gives THIS family (only) a
// long fire debounce + matching resolve dwell so a transient cycle never
// notifies, while a genuinely sustained anomaly (a real fault) still surfaces.
//
// Pin the windows to known values BEFORE importing the module — they're read
// from env at import time (house pattern: `Number(process.env.X ?? default)`).
const SUSTAIN_MS = 8 * 60_000;
process.env.BASELINE_LOAD_SUSTAIN_MS = String(SUSTAIN_MS);
process.env.BASELINE_LOAD_RESOLVE_DWELL_MS = String(SUSTAIN_MS);
const { isSustainGatedLoadAnomaly, notifyDebounceMsFor } = await import('../src/alertMonitor.js');
import type { Alert } from '../src/alerts.js';

const DEBOUNCE_MS = 60_000; // the standard (ungated) notify debounce

function loadAnomaly(metric: string): Pick<Alert, 'id' | 'source' | 'severity'> {
  return { id: `baseline-${metric}-Y711ZAB0123456`, source: 'learned', severity: 'warning' };
}

/* ── which families the gate applies to ─────────────────────────────── */

test('isSustainGatedLoadAnomaly — per-circuit load baselines (ch / pair) ARE gated', () => {
  assert.equal(isSustainGatedLoadAnomaly(loadAnomaly('ch5_w')), true, 'single-circuit load');
  assert.equal(isSustainGatedLoadAnomaly(loadAnomaly('pair3_w')), true, 'paired-circuit load');
});

test('isSustainGatedLoadAnomaly — thermal/SoC baselines and other families are NOT gated', () => {
  // Thermal self-baselines (pack/MPPT temps) keep the normal debounce.
  assert.equal(isSustainGatedLoadAnomaly(loadAnomaly('pack3_temp')), false, 'pack temp baseline');
  assert.equal(isSustainGatedLoadAnomaly(loadAnomaly('mppt_hv_temp')), false, 'MPPT temp baseline');
  // Non-learned / genuinely-actionable families must never be gated.
  assert.equal(isSustainGatedLoadAnomaly({ id: 'soc-low-20', source: undefined }), false, 'pack nearly empty');
  assert.equal(isSustainGatedLoadAnomaly({ id: 'mppt-hv-err-Y711', source: undefined }), false, 'HV MPPT error');
  assert.equal(isSustainGatedLoadAnomaly({ id: 'forecast-runtime-dip', source: 'learned' }), false, 'projected reserve dip');
});

test('notifyDebounceMsFor — gated load anomaly uses the long sustain window; everything else uses the 60 s debounce', () => {
  assert.equal(notifyDebounceMsFor(loadAnomaly('ch5_w')), SUSTAIN_MS, 'load anomaly → 8 min');
  assert.equal(notifyDebounceMsFor(loadAnomaly('pack3_temp')), DEBOUNCE_MS, 'thermal baseline → 60 s');
  assert.equal(notifyDebounceMsFor({ id: 'soc-low-20', source: undefined }), DEBOUNCE_MS, 'soc-low → 60 s');
  assert.ok(SUSTAIN_MS > DEBOUNCE_MS, 'the gate is strictly longer than the standard debounce');
});

/* ── the core behavior: transient does NOT fire, sustained DOES ──────────
 *
 * Reproduce the monitor's rising-edge fire decision exactly:
 *   fire iff   (now - firstSeen) >= debounceMs   (severity 'warning' ⇒ no
 *   critical 0 ms bypass), using the real notifyDebounceMsFor() the monitor
 *   calls. Walk simulated time across the eval interval and assert when the
 *   first immediate notify would go out. */

const EVAL_MS = 20_000; // the monitor's eval cadence

/** Earliest elapsed-ms at which `alert` would fire its immediate notify,
 *  evaluated on the EVAL_MS tick grid, given it stays continuously present. */
function firstFireElapsedMs(alert: Pick<Alert, 'id' | 'source' | 'severity'>, maxElapsed: number): number | null {
  const debounce = alert.severity === 'critical' ? 0 : notifyDebounceMsFor(alert);
  for (let elapsed = 0; elapsed <= maxElapsed; elapsed += EVAL_MS) {
    if (elapsed >= debounce) return elapsed; // first tick at/after the debounce window
  }
  return null;
}

test('a transient compressor-cycle anomaly (4 min) does NOT fire an immediate alert', () => {
  // 4 min present then gone — well past the standard 60 s debounce, so the OLD
  // behavior fired. With the 8 min gate it never reaches the fire threshold.
  const fourMin = 4 * 60_000;
  const fired = firstFireElapsedMs(loadAnomaly('ch5_w'), fourMin);
  assert.equal(fired, null, 'a 4 min load anomaly must not push (it self-clears inside the 8 min gate)');
});

test('a borderline transient (just under the gate) still does NOT fire', () => {
  const justUnder = SUSTAIN_MS - 1;
  const fired = firstFireElapsedMs(loadAnomaly('ch5_w'), justUnder);
  assert.equal(fired, null, 'an anomaly that clears 1 ms before the gate must not push');
});

test('a sustained anomaly (30 min — a real fault) DOES fire the immediate alert, just later', () => {
  const thirtyMin = 30 * 60_000;
  const fired = firstFireElapsedMs(loadAnomaly('ch5_w'), thirtyMin);
  assert.notEqual(fired, null, 'a sustained 30 min anomaly must still surface');
  assert.ok(fired! >= SUSTAIN_MS, 'it fires only after the sustain window has elapsed');
  assert.ok(fired! < thirtyMin, 'and well before it eventually clears — the operator is alerted');
});

test('an UNgated family (e.g. soc-low) still fires on the standard 60 s debounce — gate is family-scoped', () => {
  const socLow: Pick<Alert, 'id' | 'source' | 'severity'> = { id: 'soc-low-20', source: undefined, severity: 'warning' };
  const fired = firstFireElapsedMs(socLow, 5 * 60_000);
  assert.notEqual(fired, null, 'soc-low must still notify');
  assert.ok(fired! >= DEBOUNCE_MS && fired! < SUSTAIN_MS, 'on the 60 s debounce, NOT the 8 min load gate');
});
