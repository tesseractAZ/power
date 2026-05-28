import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSORS,
  BINARY_SENSORS,
  legacyUniqueIdsFor,
  MQTT_DISCOVERY_DEDUP_VERSION,
} from '../src/mqttDiscovery.js';

/**
 * Regression tests for the MQTT-discovery unique_id catalog
 * (`mqttDiscovery.ts`).
 *
 * Background: HA's MQTT discovery is keyed entirely on `unique_id`. A
 * duplicate in our SENSORS list silently publishes one entity twice
 * (last write wins on retained config but the registry stays
 * inconsistent). A unique_id that collides between a sensor and a
 * binary_sensor creates an even messier registry entry. These tests
 * pin both invariants so a future refactor can't reintroduce the
 * `ecoflow_panel_ecoflow_*` duplicate cascade that landed in HA via
 * the legacy scheme.
 */

test('mqtt-discovery: every SENSORS unique_id is unique', () => {
  const seen = new Set<string>();
  for (const s of SENSORS) {
    assert.ok(
      !seen.has(s.unique_id),
      `duplicate sensor unique_id: ${s.unique_id} (each metric must publish exactly one entity)`,
    );
    seen.add(s.unique_id);
  }
  assert.equal(seen.size, SENSORS.length);
});

test('mqtt-discovery: every BINARY_SENSORS unique_id is unique', () => {
  const seen = new Set<string>();
  for (const s of BINARY_SENSORS) {
    assert.ok(!seen.has(s.unique_id), `duplicate binary_sensor unique_id: ${s.unique_id}`);
    seen.add(s.unique_id);
  }
  assert.equal(seen.size, BINARY_SENSORS.length);
});

test('mqtt-discovery: no unique_id appears in BOTH SENSORS and BINARY_SENSORS', () => {
  const sensorIds = new Set(SENSORS.map((s) => s.unique_id));
  for (const b of BINARY_SENSORS) {
    assert.ok(
      !sensorIds.has(b.unique_id),
      `unique_id "${b.unique_id}" is registered as both sensor and binary_sensor — HA will reject one`,
    );
  }
});

test('mqtt-discovery: every SENSORS unique_id is the canonical ecoflow_* scheme (no double prefix)', () => {
  for (const s of SENSORS) {
    assert.ok(
      s.unique_id.startsWith('ecoflow_'),
      `unique_id "${s.unique_id}" does not start with the canonical ecoflow_ prefix`,
    );
    assert.ok(
      !s.unique_id.startsWith('ecoflow_panel_ecoflow_'),
      `unique_id "${s.unique_id}" uses the deprecated double-prefix scheme — keep only "ecoflow_*"`,
    );
  }
});

test('mqtt-discovery: every value_template references a value_json field name', () => {
  // Indirect duplicate guard — if two sensors point at the same JSON
  // field via different unique_ids, that's the same flavor of bug
  // (two entities echoing one metric). Allow one explicit boolean
  // wrapper for off_grid; everything else must be a 1:1 mapping.
  const fields = new Set<string>();
  for (const s of SENSORS) {
    const m = s.value_template.match(/value_json\.(\w+)/);
    assert.ok(m, `sensor ${s.unique_id} has no value_json.<field> reference`);
    const field = m[1];
    assert.ok(
      !fields.has(field),
      `sensor ${s.unique_id} reads value_json.${field} which is already wired to another sensor — duplicate metric`,
    );
    fields.add(field);
  }
});

test('legacyUniqueIdsFor: generates the double-prefix form for a canonical uid', () => {
  assert.deepEqual(legacyUniqueIdsFor('ecoflow_pv_lifetime_kwh'), [
    'ecoflow_panel_ecoflow_pv_lifetime_kwh',
  ]);
  assert.deepEqual(legacyUniqueIdsFor('ecoflow_off_grid'), [
    'ecoflow_panel_ecoflow_off_grid',
  ]);
});

test('legacyUniqueIdsFor: never returns the input uid (would clear the live entity)', () => {
  for (const s of SENSORS) {
    const legacy = legacyUniqueIdsFor(s.unique_id);
    assert.ok(
      !legacy.includes(s.unique_id),
      `legacyUniqueIdsFor returned the current uid "${s.unique_id}" — would self-clear`,
    );
  }
  for (const s of BINARY_SENSORS) {
    const legacy = legacyUniqueIdsFor(s.unique_id);
    assert.ok(
      !legacy.includes(s.unique_id),
      `legacyUniqueIdsFor returned the current uid "${s.unique_id}" — would self-clear`,
    );
  }
});

test('legacyUniqueIdsFor: also handles uids that already start with ecoflow_panel_ safely', () => {
  // `ecoflow_panel_load_watts` is a real current uid in SENSORS; its
  // legacy form is `ecoflow_panel_ecoflow_panel_load_watts`. The
  // prepended form is strictly longer than the input, so this can
  // never collide with the live entity.
  assert.deepEqual(legacyUniqueIdsFor('ecoflow_panel_load_watts'), [
    'ecoflow_panel_ecoflow_panel_load_watts',
  ]);
});

test('mqtt-discovery: dedup version is exposed for the once-only gate', () => {
  assert.equal(typeof MQTT_DISCOVERY_DEDUP_VERSION, 'number');
  assert.ok(MQTT_DISCOVERY_DEDUP_VERSION >= 1);
});
