import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretHostPowerEntity, liveHostPower, hostPowerEntityId } from '../src/hostPower.js';

/**
 * v1.6.0 — host power self-monitor. Pins the interpretation of the RPi Power
 * Supply Checker binary_sensor (device_class = problem) and the dormant-by-
 * default behaviour: an unset HOST_POWER_ENTITY must never manufacture an alarm.
 */

test('interpretHostPowerEntity — on/off/unknown mapping', () => {
  assert.equal(interpretHostPowerEntity({ state: 'on' }), true, 'on = under-voltage');
  assert.equal(interpretHostPowerEntity({ state: 'off' }), false, 'off = OK');
  assert.equal(interpretHostPowerEntity({ state: 'ON' }), true, 'case-insensitive');
  assert.equal(interpretHostPowerEntity({ state: 'unavailable' }), null, 'unavailable = unknown');
  assert.equal(interpretHostPowerEntity({ state: 'unknown' }), null, 'unknown = unknown');
  assert.equal(interpretHostPowerEntity(null), null, 'missing entity = unknown');
});

test('liveHostPower — dormant when HOST_POWER_ENTITY unset (never a false alarm)', () => {
  const prev = process.env.HOST_POWER_ENTITY;
  delete process.env.HOST_POWER_ENTITY;
  try {
    const h = liveHostPower();
    assert.equal(h.configured, false);
    assert.equal(h.underVoltage, null, 'unset entity must read as unknown, not a fault');
    assert.equal(hostPowerEntityId(), '');
  } finally {
    if (prev === undefined) delete process.env.HOST_POWER_ENTITY;
    else process.env.HOST_POWER_ENTITY = prev;
  }
});

test('liveHostPower — configured but no fresh cached value reads as unknown, not a fault', () => {
  const prev = process.env.HOST_POWER_ENTITY;
  process.env.HOST_POWER_ENTITY = 'binary_sensor.rpi_power_status';
  try {
    const h = liveHostPower();
    assert.equal(h.configured, true);
    assert.equal(h.entityId, 'binary_sensor.rpi_power_status');
    // With no successful HA fetch in this test process the cache is stale/empty,
    // so the reading is unknown — the alarm engine must NOT fire on unknown.
    assert.equal(h.underVoltage, null, 'no trustworthy reading ⇒ unknown, never under-voltage');
  } finally {
    if (prev === undefined) delete process.env.HOST_POWER_ENTITY;
    else process.env.HOST_POWER_ENTITY = prev;
  }
});
