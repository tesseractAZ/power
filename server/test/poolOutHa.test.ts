/**
 * v1.208.0 — Home Assistant: the binary sensor `ecoflow_pool_core_out` ("Core Out of Backup Pool"), its discovery
 * config, and its state in BOTH payload builders (the MQTT state publish and GET /api/ha-state).
 *
 * The state rule (ON during an alarm; OFF only on a capacity verdict at most 15 minutes old; otherwise unknown) is
 * pinned in test/poolOutRecord.test.ts. This file drives the REAL buildState over a real SnapshotStore fed the
 * pool-out fixture bodies (placeholder serials; the capacity and a moving circuit vector are the builder's), with
 * the broker absent (no listener on the port) and the analytics worker stubbed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalyticsClient } from '../src/analyticsClient.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'ef-pool-out-ha-'));
process.env.DB_PATH = join(TMP, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(TMP, 'shadow-witness.json');
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.DATA_DIR = TMP;
process.env.MQTT_DISCOVERY_ENABLED = '1';
process.env.MQTT_DISCOVERY_HOST = '127.0.0.1';
process.env.MQTT_DISCOVERY_PORT = '9'; // no listener: the client never connects
delete process.env.SUPERVISOR_TOKEN;

const mqttDiscovery = await import('../src/mqttDiscovery.js');
const { BINARY_SENSORS, SENSORS, auditDiscoveryTables, discoveryUniqueIds, poolCoreOutStateFields } = mqttDiscovery;
const { setAnalyticsClientForTesting } = await import('../src/analyticsClient.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { READINESS_FIELDS } = await import('../src/publishReadiness.js');
const fx = await import('./fixtures/poolOutFixtures.js');
const { PANEL_SN, MIN, at, healthyBody, lostBody } = fx;

after(() => { setAnalyticsClientForTesting(null); try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

function stubAnalytics(): AnalyticsClient {
  return {
    report: async <T = any>(): Promise<T> => null as T,
    query: async () => [], listMetrics: async () => [], pushSnapshot: () => {}, flushSnapshot: () => {},
    pushOwnerFloor: () => {}, stop: () => {},
  };
}

/* ══ the discovery config ═══════════════════════════════════════════════════════════════════════════ */

test('★★★ the entity: a problem-class binary sensor whose payload is "ON", "OFF" or null', () => {
  const b = BINARY_SENSORS.find((x) => x.unique_id === 'ecoflow_pool_core_out');
  assert.deepEqual(b, {
    unique_id: 'ecoflow_pool_core_out',
    name: 'Core Out of Backup Pool',
    device_class: 'problem',
    icon: 'mdi:battery-alert-variant',
    value_template: '{{ value_json.pool_core_out }}',
  });
  assert.equal('expire_after' in b!, false, 'the live 120 s default: a dead add-on reads unavailable, never a retained OFF');
  assert.equal('entity_category' in b!, false, 'not a diagnostic: it is the alarm\'s own state');
  assert.equal(discoveryUniqueIds([]).includes('ecoflow_pool_core_out'), true);
  assert.equal(SENSORS.some((s) => /pool_core|pool_cores|pool_out/.test(s.unique_id)), false, 'no attribute sensor in this release');
});

test('★ discovery invariants: the tables are coherent with the new entity, and it is in no readiness group', () => {
  assert.deepEqual(auditDiscoveryTables(SENSORS, BINARY_SENSORS), []);
  assert.equal(BINARY_SENSORS.filter((x) => x.unique_id === 'ecoflow_pool_core_out').length, 1);
  assert.equal(Object.values(READINESS_FIELDS).flat().includes('pool_core_out'), false, 'its unknown is its own rule (no reading, a stale shadow, 15 minutes), not a readiness group\'s');
});

test('★★★ the state key: "ON" for any panel\'s alarm, "OFF" only when every panel reads off, null otherwise — and null is what Home Assistant reads as unknown', () => {
  assert.deepEqual(poolCoreOutStateFields(['on']), { pool_core_out: 'ON' });
  assert.deepEqual(poolCoreOutStateFields(['off']), { pool_core_out: 'OFF' });
  assert.deepEqual(poolCoreOutStateFields(['unknown']), { pool_core_out: null });
  assert.deepEqual(poolCoreOutStateFields([]), { pool_core_out: null });
  assert.deepEqual(poolCoreOutStateFields(['off', 'unknown']), { pool_core_out: null });
  assert.deepEqual(poolCoreOutStateFields(['off', 'on']), { pool_core_out: 'ON' });
  // JSON null renders "None" through `{{ value_json.pool_core_out }}`; a missing key would render an empty string
  // (ignored, the last state kept): the key is always in the payload.
  assert.equal('pool_core_out' in poolCoreOutStateFields([]), true);
});

/* ══ both payload builders ══════════════════════════════════════════════════════════════════════════ */

test('★★★ the MQTT state payload through the real buildState: unknown before a reading, OFF on healthy readings, ON at the raise, unknown after 15 minutes of silence', async (t) => {
  setAnalyticsClientForTesting(stubAnalytics());
  const clock = { ms: at(-20) };
  t.mock.method(Date, 'now', () => clock.ms);
  const store = new SnapshotStore({ poolOutPath: null, poolEventsDir: null });
  store.setClock(() => clock.ms);
  store.setDeviceList([{ sn: PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 }] as any);
  const handle = await mqttDiscovery.startMqttDiscovery(store, makeRecorderStub(), () => {});
  try {
    const published = async (): Promise<unknown> => {
      const state = await handle.buildState!(store.get());
      assert.equal('pool_core_out' in state, true, 'the key is always in the payload');
      return state.pool_core_out;
    };
    assert.equal(await published(), null, '★ no reading yet: unknown, not OFF');
    for (let m = -15; m < 0; m++) { clock.ms = at(m); store.setDeviceQuota(PANEL_SN, healthyBody(m)); }
    assert.equal(await published(), 'OFF');
    for (let m = 0; m <= 9; m++) { clock.ms = at(m); store.setDeviceQuota(PANEL_SN, lostBody(m)); }
    assert.equal(await published(), 'OFF', 'a streak is not the alarm: still OFF at T−1 (the capacity verdict is fresh)');
    clock.ms = at(10);
    store.setDeviceQuota(PANEL_SN, lostBody(10));
    assert.equal(await published(), 'ON', '★ ON at the raise');
    clock.ms = at(10) + 6 * 60 * MIN;
    assert.equal(await published(), 'ON', '★ six hours with no reading: the alarm stands');

    // A second store: healthy readings, then silence.
    const quiet = new SnapshotStore({ poolOutPath: null, poolEventsDir: null });
    quiet.setClock(() => clock.ms);
    quiet.setDeviceList([{ sn: PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 }] as any);
    for (let m = 0; m < 3; m++) { clock.ms = at(900 + m); quiet.setDeviceQuota(PANEL_SN, healthyBody(900 + m)); }
    const h2 = await mqttDiscovery.startMqttDiscovery(quiet, makeRecorderStub(), () => {});
    try {
      assert.equal((await h2.buildState!(quiet.get())).pool_core_out, 'OFF');
      clock.ms = at(902) + 15 * MIN;
      assert.equal((await h2.buildState!(quiet.get())).pool_core_out, 'OFF', 'exactly 15 minutes after the last capacity verdict');
      clock.ms = at(902) + 15 * MIN + 1;
      assert.equal((await h2.buildState!(quiet.get())).pool_core_out, null, '★ past it: unknown, never a stale OFF');
    } finally {
      h2.stop();
    }
  } finally {
    handle.stop();
  }
});

test('★★★ both builders publish the SAME field from the SAME function: the MQTT state and /api/ha-state', () => {
  const mqtt = readFileSync(new URL('../src/mqttDiscovery.ts', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const buildState = mqtt.slice(mqtt.indexOf('const buildState = async'));
  assert.equal(buildState.includes("      ...poolCoreOutStateFields(typeof store.poolOutSensorStatesSafe === 'function' ? store.poolOutSensorStatesSafe(Date.now()) : []),"), true, 'buildState');
  const haState = index.slice(index.indexOf("app.get('/api/ha-state'"), index.indexOf("app.post('/api/notify/test'"));
  assert.equal(haState.includes('    ...poolCoreOutStateFields(store.poolOutSensorStatesSafe(Date.now())),'), true, '/api/ha-state (index.ts is not reachable from a unit test)');
  // The key is written in one place only: the shared function.
  assert.equal(mqtt.split('pool_core_out: poolCoreOutState(panels),').length - 1, 1);
  assert.equal(index.includes('pool_core_out'), false, 'index.ts never names the key itself');
});
