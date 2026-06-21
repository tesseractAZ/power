/**
 * v0.40.2 — circuitLifetimeFields: the per-circuit lifetime-kWh state fields must cover
 * the UNION of (a) the live circuits the MQTT discovery configs enumerate and (b) the
 * channels with a persisted `circuit_<ch>_wh` accumulator, so every retained
 * `ecoflow_circuit_<ch>_lifetime_kwh` sensor always finds its key — in steady state AND
 * at startup (before the first poll populates the snapshot). Otherwise HA logs
 * "'dict object' has no attribute circuit_N_lifetime_kwh" template warnings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circuitLifetimeFields } from '../src/mqttDiscovery.js';

const circuits = [{ ch: 1 }, { ch: 2 }, { ch: 10 }, { ch: 12 }];
const channelsOf = (fields: Record<string, unknown>) =>
  Object.keys(fields)
    .map((k) => Number(k.match(/^circuit_(\d+)_lifetime_kwh$/)?.[1]))
    .sort((a, b) => a - b);

test('emits a key for EVERY live circuit (discovery ⟷ state channel sets match)', () => {
  const acc = { circuit_1_wh: 12.5, circuit_10_wh: 3.0 }; // ch 2 + ch 12 not accumulated yet
  const lifetimeKwh = (k: string) => (acc as Record<string, number>)[k] ?? null;
  const fields = circuitLifetimeFields(circuits, Object.keys(acc), lifetimeKwh);
  assert.deepEqual(channelsOf(fields), [1, 2, 10, 12], 'one key per live circuit — even ones with no accumulator yet');
});

test('STARTUP race (Copilot): no live circuits yet, but persisted accumulators → keys still emitted', () => {
  // Before the first poll the snapshot is empty (circuits=[]), but the recorder has
  // loaded persisted accumulators. The retained HA sensors must still find their keys.
  const acc = { circuit_1_wh: 12.5, circuit_10_wh: 3.0, circuit_12_wh: 1.1, fleet_pv_wh: 99 };
  const lifetimeKwh = (k: string) => (acc as Record<string, number>)[k] ?? null;
  const fields = circuitLifetimeFields([], Object.keys(acc), lifetimeKwh);
  assert.deepEqual(channelsOf(fields), [1, 10, 12], 'startup → emit from persisted accumulator channels (fleet_* ignored)');
  assert.equal(fields['circuit_10_lifetime_kwh'], 3.0);
});

test('UNION of live circuits + accumulator channels, de-duplicated & sorted', () => {
  const acc = { circuit_10_wh: 3.0, circuit_99_wh: 7.0 }; // 10 overlaps a live circuit; 99 is accumulator-only
  const lifetimeKwh = (k: string) => (acc as Record<string, number>)[k] ?? null;
  const fields = circuitLifetimeFields(circuits, Object.keys(acc), lifetimeKwh);
  assert.deepEqual(channelsOf(fields), [1, 2, 10, 12, 99], 'union, no duplicate ch 10');
});

test('uses null (NOT 0) when a circuit has no accumulator — avoids a false total_increasing reset', () => {
  const fields = circuitLifetimeFields(circuits, [], () => null); // cold start, nothing accumulated
  for (const c of circuits) {
    assert.equal(fields[`circuit_${c.ch}_lifetime_kwh`], null, `ch ${c.ch} must be null, not 0`);
  }
});

test('passes through the accumulated kWh when present', () => {
  const lifetimeKwh = (k: string) => (k === 'circuit_10_wh' ? 42.7 : null);
  const fields = circuitLifetimeFields(circuits, ['circuit_10_wh'], lifetimeKwh);
  assert.equal(fields['circuit_10_lifetime_kwh'], 42.7);
  assert.equal(fields['circuit_1_lifetime_kwh'], null);
});

test('no SHP2 / no circuits / no accumulators → empty (no orphan keys)', () => {
  assert.deepEqual(circuitLifetimeFields([], [], () => null), {});
});

test('reads the correct accumulator key (circuit_<ch>_wh ← circuit_<ch>_lifetime_kwh)', () => {
  const seen: string[] = [];
  circuitLifetimeFields([{ ch: 7 }], [], (k) => { seen.push(k); return null; });
  assert.deepEqual(seen, ['circuit_7_wh'], 'lifetime field circuit_7_lifetime_kwh sources accumulator circuit_7_wh');
});
