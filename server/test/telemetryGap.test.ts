import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTelemetryGap } from '../src/recorder.js';

// v0.30.0 — the recorder writes only on a store 'change'; nothing fires when
// telemetry STOPS, so a silent blackout left no trace. detectTelemetryGap is the
// pure predicate behind the durable gap marker.
const MIN = 60_000;
const THRESHOLD = 15 * MIN; // 3 × MAX_INTERVAL_MS (the recorder's GAP_THRESHOLD_MS)

test('detectTelemetryGap — false on the very first insert (no prior write)', () => {
  // lastInsertMs === 0 must never count, or every fresh boot would log a gap.
  assert.equal(detectTelemetryGap(0, 1_000_000, THRESHOLD), false);
});

test('detectTelemetryGap — false for a normal sub-threshold heartbeat gap', () => {
  const last = 1_000_000;
  assert.equal(detectTelemetryGap(last, last + 5 * MIN, THRESHOLD), false);   // 5-min heartbeat
  assert.equal(detectTelemetryGap(last, last + 15 * MIN, THRESHOLD), false);  // exactly threshold → not > (exclusive)
});

test('detectTelemetryGap — true for a real blackout past the threshold', () => {
  const last = 1_000_000;
  assert.equal(detectTelemetryGap(last, last + 16 * MIN, THRESHOLD), true);   // just over
  assert.equal(detectTelemetryGap(last, last + 132 * MIN, THRESHOLD), true);  // the live 132-min MQTT stall
});
