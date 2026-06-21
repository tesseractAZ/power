import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SENSORS,
  BINARY_SENSORS,
  legacyUniqueIdsFor,
  MQTT_DISCOVERY_DEDUP_VERSION,
  planCircuitDiscovery,
} from '../src/mqttDiscovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/**
 * v0.9.69 — Pin MQTT v5 on every mqtt.connect() call in the codebase.
 *
 * HA Core 2026.x deprecates v3.1.1 to its broker and will drop support
 * in 2027.1.0. The npm `mqtt` library defaults to v3.1.1 when
 * `protocolVersion` is unset, which means a silent regression to v3.1.1
 * is a one-deletion-away failure mode. These tests source-grep every
 * file that calls `mqtt.connect` and assert the explicit v5 opt-in is
 * present.
 *
 * Source-grep style (not a runtime mock) is deliberate: it tests the
 * one thing that matters (the wire-level protocol we send to the
 * broker) without coupling to the connection-options shape or
 * requiring an mqtt-mocking layer. If you add a new `mqtt.connect`
 * call, add the file to MQTT_SOURCE_FILES below — the test will fail
 * fast if you forget the protocolVersion.
 */
const MQTT_SOURCE_FILES = [
  '../src/mqttDiscovery.ts',  // HA Discovery → core-mosquitto
  '../src/ecoflow/mqtt.ts',   // EcoFlow Cloud → mqtt-e.ecoflow.com
];

for (const relPath of MQTT_SOURCE_FILES) {
  test(`mqtt v5: ${relPath} sets protocolVersion: 5 on mqtt.connect`, () => {
    const src = readFileSync(resolve(__dirname, relPath), 'utf8');
    // Confirm there's actually an mqtt.connect call we'd care about.
    assert.ok(
      /mqtt\.connect\(/.test(src),
      `${relPath} has no mqtt.connect() — remove it from MQTT_SOURCE_FILES or restore the call`,
    );
    // Confirm protocolVersion: 5 is present. Whitespace-tolerant regex
    // so we don't break on Prettier reformat.
    assert.ok(
      /protocolVersion\s*:\s*5\b/.test(src),
      `${relPath} calls mqtt.connect but does not set protocolVersion: 5 — npm 'mqtt' defaults to v3.1.1 which HA deprecates in 2027.1.0`,
    );
    // Belt-and-suspenders: explicitly reject any protocolVersion that
    // isn't 5. Catches typos like `protocolVersion: 4`.
    const allMatches = [...src.matchAll(/protocolVersion\s*:\s*(\d+)/g)];
    for (const m of allMatches) {
      assert.equal(
        m[1],
        '5',
        `${relPath} sets protocolVersion: ${m[1]} — only v5 is allowed`,
      );
    }
  });
}

/**
 * v0.15.1 — Per-SHP2-circuit discovery planner (`planCircuitDiscovery`).
 *
 * Background: the per-circuit Energy-Dashboard sensors used to be published
 * exactly once, inside the MQTT `connect` handler, gated on the SHP2 circuit
 * list already being present in the in-memory snapshot at that instant. Because
 * the first device poll is fire-and-forget, a boot where the broker connect won
 * the race against the first poll published ZERO of the 12 per-circuit configs
 * and never retried (observed on the post-migration boot). The publish/skip/
 * clear decision now lives in this pure function, driven by the recurring state
 * loop. These tests pin: (1) a fresh set publishes everything, (2) an unchanged
 * set yields a stable signature so the caller can no-op, (3) a changed set gets
 * a new signature and clears configs for circuits that disappeared.
 */

const PREFIX = 'homeassistant';

test('planCircuitDiscovery: fresh set publishes one well-formed config per circuit, clears none', () => {
  const plan = planCircuitDiscovery(PREFIX, [], [
    { ch: 1, name: 'Kitchen' },
    { ch: 2, name: 'EVSE' },
  ]);
  assert.equal(plan.clear.length, 0, 'nothing to clear on a fresh publish');
  assert.equal(plan.publish.length, 2, 'one config per circuit');
  const first = plan.publish[0];
  assert.equal(first.topic, 'homeassistant/sensor/ecoflow_circuit_1_lifetime_kwh/config');
  assert.equal(first.cfg.unique_id, 'ecoflow_circuit_1_lifetime_kwh');
  assert.equal(first.cfg.name, 'EcoFlow Kitchen Energy');
  assert.equal(first.cfg.device_class, 'energy');
  assert.equal(first.cfg.state_class, 'total_increasing'); // → no expire_after, never goes unavailable
  assert.equal(first.cfg.value_template, '{{ value_json.circuit_1_lifetime_kwh }}');
  assert.ok(first.cfg.device, 'every config carries the shared device block so entities group together');
});

test('planCircuitDiscovery: unnamed circuit falls back to "Circuit N"', () => {
  const plan = planCircuitDiscovery(PREFIX, [], [{ ch: 7 }]);
  assert.equal(plan.publish[0].cfg.name, 'EcoFlow Circuit 7 Energy');
});

test('planCircuitDiscovery: identical circuit set → identical signature (caller no-ops, no churn)', () => {
  const circuits = [{ ch: 1, name: 'A' }, { ch: 2, name: 'B' }];
  const a = planCircuitDiscovery(PREFIX, [], circuits);
  const b = planCircuitDiscovery(PREFIX, [1, 2], circuits);
  assert.equal(a.sig, b.sig, 'same channels+names produce the same change-latch key');
  assert.equal(b.clear.length, 0, 'no orphans when the set is unchanged');
});

test('planCircuitDiscovery: a renamed circuit changes the signature (re-publishes the friendly name)', () => {
  const before = planCircuitDiscovery(PREFIX, [], [{ ch: 1, name: 'Old Name' }]);
  const after = planCircuitDiscovery(PREFIX, [1], [{ ch: 1, name: 'New Name' }]);
  assert.notEqual(before.sig, after.sig, 'a rename must re-assert the config');
  assert.equal(after.publish[0].cfg.name, 'EcoFlow New Name Energy');
});

test('planCircuitDiscovery: a removed circuit is cleared and the signature changes', () => {
  const plan = planCircuitDiscovery(PREFIX, [1, 2, 3], [
    { ch: 1, name: 'A' },
    { ch: 2, name: 'B' },
  ]);
  assert.deepEqual(plan.clear, ['homeassistant/sensor/ecoflow_circuit_3_lifetime_kwh/config']);
  assert.equal(plan.publish.length, 2, 'remaining circuits still published');
  const prev = planCircuitDiscovery(PREFIX, [], [
    { ch: 1, name: 'A' }, { ch: 2, name: 'B' }, { ch: 3, name: 'C' },
  ]);
  assert.notEqual(plan.sig, prev.sig, 'dropping a circuit changes the latch key');
});

test('planCircuitDiscovery: empty circuit list publishes nothing and clears all previously-published channels', () => {
  const plan = planCircuitDiscovery(PREFIX, [4, 5], []);
  assert.equal(plan.sig, '', 'no circuits → empty signature');
  assert.equal(plan.publish.length, 0);
  assert.deepEqual(plan.clear, [
    'homeassistant/sensor/ecoflow_circuit_4_lifetime_kwh/config',
    'homeassistant/sensor/ecoflow_circuit_5_lifetime_kwh/config',
  ]);
});

/**
 * v0.15.3 — buildState ↔ SENSORS contract guard.
 *
 * Background: HA's MQTT discovery is keyed on `value_template` strings, which are
 * opaque to the type system. The five pv_curtailment_* sensors (v0.9.77)
 * referenced `value_json.*` keys that buildState() never emitted — so they sat at
 * "unknown" for months and logged a template warning on every publish. This test
 * statically asserts every `value_json.X` a sensor references is actually a key
 * buildState (or the advisoryStateFields spread) returns, so the next forgotten
 * wiring fails CI instead of silently shipping a dead entity.
 */
test('mqtt-discovery: every value_json key a sensor references is emitted by buildState', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/mqttDiscovery.ts'), 'utf8');
  const advisorSrc = readFileSync(resolve(__dir, '../src/loadShedAdvisor.ts'), 'utf8');

  // Referenced keys, excluding the dynamically-published per-circuit family
  // (circuit_<n>_lifetime_kwh, emitted via an Object.fromEntries spread).
  const referenced = [...new Set([...src.matchAll(/value_json\.([a-z0-9_]+)/g)].map((m) => m[1]))]
    .filter((k) => !k.startsWith('circuit_'));

  // Emitted keys: property names inside buildState()'s return literal …
  const bsStart = src.indexOf('const buildState');
  const retStart = src.indexOf('return {', bsStart);
  const retEnd = src.indexOf('\n    };', retStart);
  assert.ok(bsStart >= 0 && retStart > bsStart && retEnd > retStart, 'could not locate buildState return block');
  const emitted = new Set(
    [...src.slice(retStart, retEnd).matchAll(/^\s+([a-z][a-z0-9_]*):/gm)].map((m) => m[1]),
  );
  // … plus the keys spread in from advisoryStateFields().
  const advStart = advisorSrc.indexOf('return {', advisorSrc.indexOf('function advisoryStateFields'));
  const advEnd = advisorSrc.indexOf('};', advStart);
  for (const m of advisorSrc.slice(advStart, advEnd).matchAll(/^\s+([a-z][a-z0-9_]*):/gm)) emitted.add(m[1]);

  const missing = referenced.filter((k) => !emitted.has(k)).sort();
  assert.deepEqual(missing, [], `Sensors reference value_json keys buildState never emits: ${missing.join(', ')}`);
});

/**
 * v0.44.0 — grid-import naming honesty for the HA Energy Dashboard.
 *
 * Two grid energy sensors exist and they measure DIFFERENT things:
 *   • grid_to_home_lifetime_kwh = SHP2-main meter (wattInfo.gridWatt) = the TRUE
 *     whole-home grid import → the sensor to wire into Energy → Grid consumption.
 *   • grid_import_lifetime_kwh  = DPU ac_in = grid energy that CHARGES the
 *     batteries — a near-zero diagnostic SUBSET on a solar-charged home.
 * Wiring the latter as grid consumption shows ~0 kWh (the v0.44.0 bug report).
 * Pin the semantics so a future edit can't silently swap them back.
 */
test('mqtt-discovery: grid_to_home is the canonical (non-diagnostic) Grid Import energy sensor', () => {
  const home = SENSORS.find((s) => s.unique_id === 'ecoflow_grid_to_home_lifetime_kwh');
  assert.ok(home, 'grid_to_home lifetime sensor must exist');
  assert.equal(home!.device_class, 'energy');
  assert.equal(home!.state_class, 'total_increasing');
  assert.equal(home!.entity_category, undefined, 'whole-home grid import must NOT be diagnostic (Energy Dashboard cannot pick diagnostic entities)');
  assert.match(home!.value_template, /grid_to_home_lifetime_kwh/);
});

test('mqtt-discovery: grid_import (DPU ac_in) is demoted to a diagnostic sub-metric', () => {
  const acIn = SENSORS.find((s) => s.unique_id === 'ecoflow_grid_import_lifetime_kwh');
  assert.ok(acIn, 'grid_import (ac_in) lifetime sensor must exist');
  assert.equal(acIn!.entity_category, 'diagnostic', 'ac_in is a charging subset, not whole-home grid — must be diagnostic so it is not mistaken for grid consumption');
  assert.match(acIn!.value_template, /grid_import_lifetime_kwh/);
});
