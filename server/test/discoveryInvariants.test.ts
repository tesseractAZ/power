import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SENSORS,
  BINARY_SENSORS,
  auditDiscoveryTables,
  runBrokerConnect,
  type SensorConfig,
  type ConnectLatch,
  type ConnectEffects,
} from '../src/mqttDiscovery.js';

/**
 * v1.137.0 — B3 + B5 from the HA Energy mapping audit.
 *
 * B3: an incoherent (device_class, state_class, unit) triple does not fail
 * loudly. HA either drops the entity with one log line or compiles the WRONG
 * statistic, and both look like success from the publisher's side. Two live
 * defects came from that gap — five permanently-"unknown" curtailment sensors
 * (v0.15.3) and three USD sensors that compile a mean where the Energy
 * Dashboard needs a sum (diagnosed v1.134.0).
 *
 * B5: discovery configs are retained, so the failure mode is the BROKER losing
 * its retained store. The old one-time `published` latch meant the add-on never
 * re-asserted them, and only an add-on restart brought the entities back.
 */

// ── B3: the shipped tables are coherent ──────────────────────────────────────

test('B3: the shipped discovery tables have no unwaived violations', () => {
  const violations = auditDiscoveryTables(SENSORS, BINARY_SENSORS);
  assert.deepEqual(
    violations,
    [],
    `discovery table violations:\n${violations.map((v) => `  ${v.unique_id} [${v.rule}] ${v.detail}`).join('\n')}`,
  );
});

test('B3: the tables are not trivially empty', () => {
  // Guards the assertion above: auditDiscoveryTables([], []) is vacuously
  // clean, so an empty table would "pass" the invariant while shipping nothing.
  assert.ok(SENSORS.length > 50, `expected a populated sensor table, got ${SENSORS.length}`);
  assert.ok(BINARY_SENSORS.length > 5, `expected a populated binary table, got ${BINARY_SENSORS.length}`);
});

// ── B3: each rule actually fires ─────────────────────────────────────────────
// A clean run of the real tables only proves what those tables happen to
// contain. Every rule is exercised against a mutant so a rule that can never
// fire cannot masquerade as a rule that never has to.

const base: SensorConfig = {
  unique_id: 'probe',
  name: 'Probe',
  value_template: '{{ value_json.probe }}',
};
const rulesFired = (s: SensorConfig) => auditDiscoveryTables([s], [], {}).map((v) => v.rule);

test('B3: device_class energy + state_class measurement is rejected', () => {
  // The exact combination HA refuses: an `energy` sensor must accumulate.
  const fired = rulesFired({ ...base, device_class: 'energy', state_class: 'measurement', unit_of_measurement: 'kWh' });
  assert.ok(fired.includes('device-class-state-class'), `got ${JSON.stringify(fired)}`);
});

test('B3: device_class power with an energy unit is rejected', () => {
  const fired = rulesFired({ ...base, device_class: 'power', state_class: 'measurement', unit_of_measurement: 'kWh' });
  assert.ok(fired.includes('device-class-unit'), `got ${JSON.stringify(fired)}`);
});

test('B3: a unit with no state_class is rejected', () => {
  // Compiles no long-term statistics at all — invisible until someone opens
  // the Statistics developer tool.
  const fired = rulesFired({ ...base, unit_of_measurement: 'kWh' });
  assert.ok(fired.includes('unit-without-state-class'), `got ${JSON.stringify(fired)}`);
});

test('B3: total_increasing with no unit is rejected', () => {
  const fired = rulesFired({ ...base, state_class: 'total_increasing' });
  assert.ok(fired.includes('total-increasing-without-unit'), `got ${JSON.stringify(fired)}`);
});

test('B3: a currency sensor that is not monetary/total is rejected', () => {
  // This is the money bug in miniature: USD + measurement compiles a MEAN, so
  // the entity can never be an Energy-Dashboard cost source.
  const fired = rulesFired({ ...base, state_class: 'measurement', unit_of_measurement: 'USD' });
  assert.ok(fired.includes('currency-needs-monetary-total'), `got ${JSON.stringify(fired)}`);
});

test('B3: monetary WITHOUT total still fails the currency rule', () => {
  // The half-fix that looks right: someone adds device_class 'monetary' and
  // stops there. HA compiles a sum only for `total`, so the entity is still
  // unusable as a cost source. The rule has to check both halves on its own —
  // not lean on DEVICE_CLASS_STATE_CLASSES, which a later edit could relax.
  const fired = rulesFired({ ...base, device_class: 'monetary', state_class: 'measurement', unit_of_measurement: 'USD' });
  assert.ok(fired.includes('currency-needs-monetary-total'), `got ${JSON.stringify(fired)}`);
});

test('B3: a correctly-declared monetary sensor passes', () => {
  assert.deepEqual(rulesFired({ ...base, device_class: 'monetary', state_class: 'total', unit_of_measurement: 'USD' }), []);
});

test('B3: USD/kWh is a price, not an amount, and is not forced to monetary', () => {
  // ecoflow_grid_price_now ships exactly this. `monetary` describes an amount
  // of money; applying it to a rate would be wrong, and HA mints its own
  // monetary/total cost entity from this sensor.
  const fired = rulesFired({ ...base, state_class: 'measurement', unit_of_measurement: 'USD/kWh' });
  assert.ok(!fired.includes('currency-needs-monetary-total'), `got ${JSON.stringify(fired)}`);
});

test('B3: duplicate unique_ids are caught in both tables', () => {
  const dup = auditDiscoveryTables([base, base], []).map((v) => v.rule);
  assert.ok(dup.includes('duplicate-unique-id'), `sensors: ${JSON.stringify(dup)}`);
  const b = { unique_id: 'probe', name: 'P', value_template: '{{ value_json.p }}' };
  const dupB = auditDiscoveryTables([], [b, b]).map((v) => v.rule);
  assert.ok(dupB.includes('duplicate-unique-id'), `binary: ${JSON.stringify(dupB)}`);
});

// ── B3: the waiver mechanism ─────────────────────────────────────────────────

test('B3: a waiver suppresses only its own rule, and only with a reason', () => {
  const bad: SensorConfig = { ...base, state_class: 'measurement', unit_of_measurement: 'USD' };
  const withReason = { probe: { rule: 'currency-needs-monetary-total', reason: 'dashboard readout' } };
  assert.deepEqual(auditDiscoveryTables([bad], [], withReason), []);

  // An empty reason is not a waiver — otherwise the list stops documenting why.
  const noReason = { probe: { rule: 'currency-needs-monetary-total', reason: '   ' } };
  assert.equal(auditDiscoveryTables([bad], [], noReason).length, 1);

  // A waiver for a DIFFERENT rule must not suppress this one.
  const wrongRule = { probe: { rule: 'device-class-unit', reason: 'unrelated' } };
  assert.equal(auditDiscoveryTables([bad], [], wrongRule).length, 1);
});

test('B3: the shipped waivers are all still load-bearing', () => {
  // A waiver for a violation that no longer exists is stale documentation that
  // will outlive the reason it records. Passing {} must surface exactly the
  // three known USD readouts — no more, and no fewer.
  const unwaived = auditDiscoveryTables(SENSORS, BINARY_SENSORS, {});
  assert.deepEqual(
    unwaived.map((v) => `${v.unique_id}:${v.rule}`).sort(),
    [
      'ecoflow_tariff_savings_7d:currency-needs-monetary-total',
      'ecoflow_tariff_today_cost:currency-needs-monetary-total',
      'ecoflow_tariff_today_saved:currency-needs-monetary-total',
    ],
  );
});

// ── B5: the connect sequence ─────────────────────────────────────────────────

function recordConnects(n: number) {
  const calls: string[] = [];
  const latch: ConnectLatch = { legacyCleared: false };
  const fx: ConnectEffects = {
    publishAvailability: () => calls.push('availability'),
    clearLegacyDiscovery: () => calls.push('clearLegacy'),
    publishDiscovery: () => calls.push('discovery'),
    invalidateCircuitDiscovery: () => calls.push('invalidateCircuits'),
    subscribeSwitchCommands: () => calls.push('subscribe'),
    publishState: () => calls.push('state'),
    publishSwitchStates: () => calls.push('switchStates'),
  };
  for (let i = 0; i < n; i++) runBrokerConnect(latch, fx);
  return calls;
}

test('B5: discovery is re-asserted on EVERY connect', () => {
  // The defect: a broker that loses its retained store drops all ~90 configs,
  // and the old one-time latch meant nothing ever republished them.
  const calls = recordConnects(3);
  assert.equal(calls.filter((c) => c === 'discovery').length, 3);
});

test('B5: the legacy clear happens exactly once', () => {
  // Retired unique_ids need saying once. Repeating empty payloads on every
  // reconnect is traffic that would never stop.
  const calls = recordConnects(3);
  assert.equal(calls.filter((c) => c === 'clearLegacy').length, 1);
});

test('B5: the circuit signature is invalidated on every connect', () => {
  // The per-circuit configs are retained on the same broker and vanish with the
  // same store, so they need the same re-assertion. Their own sig latch is what
  // gates it.
  const calls = recordConnects(3);
  assert.equal(calls.filter((c) => c === 'invalidateCircuits').length, 3);
});

test('B5: availability goes out first, and before discovery', () => {
  // A retained LWT 'offline' holds every entity unavailable no matter what
  // configs follow it.
  const calls = recordConnects(1);
  assert.equal(calls[0], 'availability');
  assert.ok(calls.indexOf('availability') < calls.indexOf('discovery'));
});

test('B5: the legacy clear precedes the republish in the same session', () => {
  const calls = recordConnects(1);
  assert.ok(calls.indexOf('clearLegacy') < calls.indexOf('discovery'));
});

test('B5: switch subscriptions are renewed on every connect', () => {
  // MQTT subscriptions do not survive a clean-session reconnect.
  const calls = recordConnects(3);
  assert.equal(calls.filter((c) => c === 'subscribe').length, 3);
});

test('B5: state and switch states are published on every connect', () => {
  const calls = recordConnects(2);
  assert.equal(calls.filter((c) => c === 'state').length, 2);
  assert.equal(calls.filter((c) => c === 'switchStates').length, 2);
});

// ── B5: the live handler is actually wired to it ─────────────────────────────
/**
 * runBrokerConnect being correct proves nothing about the add-on if the real
 * `client.on('connect')` handler passes it the wrong callbacks. That gap is not
 * hypothetical — v0.33 shipped a dead `M` key that was wired, tested and
 * mutation-proven while the production source literal omitted it.
 *
 * The two things the handler must get right live inside the startMqttDiscovery
 * closure and are only observable through a live broker's retained store, so
 * this is source inspection — the convention this file's sibling already uses
 * for the same reason (see the availability test in mqttDiscovery.test.ts).
 */
test('B5: the live connect handler invalidates the circuit sig — and only that', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/mqttDiscovery.ts'), 'utf8');

  const start = src.indexOf('runBrokerConnect(connectLatch, {');
  assert.ok(start > 0, 'the live handler must call runBrokerConnect');
  const end = src.indexOf('\n    });', start);
  assert.ok(end > start, 'runBrokerConnect call site located');
  const call = src.slice(start, end);

  // The callback must actually clear the latch that gates re-assertion.
  // Without this the extracted sequence is correct and the add-on is inert.
  assert.match(
    call,
    /invalidateCircuitDiscovery:\s*\(\)\s*=>\s*\{[^}]*circuitDiscoverySig\s*=\s*null;/,
    'invalidateCircuitDiscovery must set circuitDiscoverySig = null — otherwise the per-circuit configs never come back after the broker loses its retained store',
  );

  // And it must NOT reset the orphan ledger. publishedCircuitChannels is the
  // memory of which circuits we have published, used to CLEAR the config topic
  // of one that goes away. Reset it here and a removed circuit's retained
  // config sits on the broker forever with nothing left to remove it.
  assert.ok(
    !/publishedCircuitChannels\s*=/.test(call),
    'the connect handler must not assign publishedCircuitChannels — it is the orphan ledger, not a latch',
  );
});
