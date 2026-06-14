import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunway, runwayAlarmMessage, type RunwayAlarmInput } from '../src/runwayAlarm.js';

/* ===================================================================
 * v0.23.0 — grid-aware runway floor classifier. The reserve-floor
 * crossing is only a non-event when the grid is actually carrying the
 * load; off-grid (or grid declared-but-not-carrying) it stays the
 * critical emergency the ladder exists for.
 * =================================================================== */

const atFloor: RunwayAlarmInput = {
  generatedAt: 0,
  hoursToReserve: 18,
  hoursToEmpty: 30,
  unavailable: null,
  backupRemainingKwh: 1.0,
  backupReserveKwh: 1.0, // remaining <= reserve ⇒ belowReserveFloor
};
const approaching: RunwayAlarmInput = {
  generatedAt: 0,
  hoursToReserve: 4,
  hoursToEmpty: null,
  unavailable: null,
  backupRemainingKwh: 5,
  backupReserveKwh: 1,
};
const emptySoon: RunwayAlarmInput = {
  generatedAt: 0,
  hoursToReserve: 1,
  hoursToEmpty: 2, // <= 3 ⇒ off-grid critical
  unavailable: null,
  backupRemainingKwh: 2,
  backupReserveKwh: 1, // NOT at floor (remaining > reserve)
};

test('at floor, off-grid (no grid ctx, or present:false) → critical — unchanged safe default', () => {
  assert.equal(classifyRunway(atFloor), 'critical');
  assert.equal(classifyRunway(atFloor, { present: false, backstopping: false }), 'critical');
});

test('at floor, grid backstopping → downgraded to a low advisory', () => {
  assert.equal(classifyRunway(atFloor, { present: true, backstopping: true }), 'low');
});

test('at floor, grid present but NOT backstopping (declared, not carrying) → still critical', () => {
  assert.equal(classifyRunway(atFloor, { present: true, backstopping: false }), 'critical');
});

test('approaching reserve: off-grid → medium; grid backstopping → silent; declared-not-carrying → still medium', () => {
  assert.equal(classifyRunway(approaching), 'medium');
  assert.equal(classifyRunway(approaching, { present: true, backstopping: true }), null);
  // present but NOT backstopping (declared, pool draining) must NOT silence it.
  assert.equal(classifyRunway(approaching, { present: true, backstopping: false }), 'medium');
});

test('projected empty soon: off-grid → critical; backstopping → silent; declared-not-carrying → still critical', () => {
  assert.equal(classifyRunway(emptySoon), 'critical');
  assert.equal(classifyRunway(emptySoon, { present: true, backstopping: true }), null);
  // declared present but pool racing toward empty with no backstop → stay critical.
  assert.equal(classifyRunway(emptySoon, { present: true, backstopping: false }), 'critical');
});

test('floor message: backstopping → calm "grid power" advisory; off-grid → shed/generator critical', () => {
  const adv = runwayAlarmMessage(atFloor, 'low', { present: true, backstopping: true });
  assert.match(adv, /grid power/i);
  assert.match(adv, /no action/i);
  const crit = runwayAlarmMessage(atFloor, 'critical');
  assert.match(crit, /reserve floor/i);
  assert.match(crit, /Shed load|generator/i);
});
