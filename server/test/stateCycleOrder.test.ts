/**
 * v1.187.10 — the state cycle publishes availability 'online' AFTER the state payload.
 *
 * runBrokerConnect published 'online' first on every connect, so at each restart Home Assistant
 * re-showed every entity's pre-restart value until the first fresh payload landed: a stale replay
 * a state trigger reads as a transition. The lighting-posture automation fired "to normal" twice
 * per deploy (2026-10-02 17:53 and 19:23, 2026-10-03 12:08). On the process's first connect
 * availability is now left to the state cycle, which asserts it after the payload; a RECONNECT
 * still asserts it first (discoveryInvariants.test.ts, B5). It is asserted even when the build
 * fails — a standing 'offline' holds every entity unavailable (v1.14.1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishStateCycle, type StateCycleEffects } from '../src/mqttDiscovery.js';

function recorder(over: Partial<StateCycleEffects> = {}) {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const fx: StateCycleEffects = {
    connected: () => true,
    publishCircuitDiscovery: () => { calls.push('circuits'); },
    buildState: async () => { calls.push('build'); return { x: 1 }; },
    publishStatePayload: () => { calls.push('state'); },
    publishAvailability: () => { calls.push('availability'); },
    onError: (e) => { errors.push(e); },
    ...over,
  };
  return { calls, errors, fx };
}

test('★★★ circuits, the state payload, THEN availability', async () => {
  const { calls, fx } = recorder();
  await publishStateCycle(fx);
  assert.deepEqual(calls, ['circuits', 'build', 'state', 'availability']);
});

test('★★★ a failed build still asserts availability — the add-on is alive', async () => {
  const { calls, errors, fx } = recorder({ buildState: async () => { calls.push('build'); throw new Error('boom'); } });
  await publishStateCycle(fx);
  assert.deepEqual(calls, ['circuits', 'build', 'availability']);
  assert.equal((errors[0] as Error).message, 'boom');
});

test('★★ a throwing circuit-config publish is logged, and availability still goes out', async () => {
  const { calls, errors, fx } = recorder({ publishCircuitDiscovery: () => { throw new Error('circuits'); } });
  await publishStateCycle(fx);
  assert.deepEqual(calls, ['availability']);
  assert.equal(errors.length, 1);
});

test('not connected: nothing at all', async () => {
  const { calls, fx } = recorder({ connected: () => false });
  await publishStateCycle(fx);
  assert.deepEqual(calls, []);
});

test('the state payload is the one the build returned', async () => {
  let published: unknown = null;
  const { fx } = recorder({ publishStatePayload: (s) => { published = s; } });
  await publishStateCycle(fx);
  assert.deepEqual(published, { x: 1 });
});
