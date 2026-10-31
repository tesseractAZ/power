/**
 * v1.197.0 (review) — Home Assistant's End All Maintenance button through the REAL startMqttDiscovery,
 * against a minimal in-process broker: the button's command topic is subscribed on connect, a PRESS
 * delivered on it ends the controller's windows, and the state payload carries the windows in force.
 *
 * Ending is the loud direction, and a broken button fails quiet: the press ends nothing and the Core
 * stays shelved for up to 4 h. The pure parser test (mqttDiscovery.test.ts) cannot see a dropped
 * subscribe or a hook that is never called; this one does.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqttPacket from 'mqtt-packet';
import type { AnalyticsClient } from '../src/analyticsClient.js';
import type { FleetSnapshot, SnapshotStore } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'maint-mqtt-'));
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.DATA_DIR = TMP;
process.env.MQTT_DISCOVERY_ENABLED = '1';
process.env.MQTT_DISCOVERY_HOST = '127.0.0.1';

/** A broker that answers CONNECT, SUBSCRIBE and PINGREQ (MQTT 5), records each subscribed topic, and
 *  can deliver a PUBLISH to the connected client. */
async function fakeBroker() {
  const subscribed: string[] = [];
  const sockets: Socket[] = [];
  const opts = { protocolVersion: 5 as const };
  const server = createServer((s) => {
    sockets.push(s);
    const parser = mqttPacket.parser(opts);
    parser.on('packet', (p) => {
      if (p.cmd === 'connect') s.write(mqttPacket.generate({ cmd: 'connack', reasonCode: 0, sessionPresent: false }, opts));
      else if (p.cmd === 'subscribe') {
        for (const sub of p.subscriptions) subscribed.push(sub.topic);
        s.write(mqttPacket.generate({ cmd: 'suback', messageId: p.messageId, granted: p.subscriptions.map(() => 0) }, opts));
      } else if (p.cmd === 'pingreq') s.write(mqttPacket.generate({ cmd: 'pingresp' }, opts));
    });
    s.on('data', (b) => parser.parse(b));
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    subscribed,
    deliver: (topic: string, payload: string) => {
      for (const s of sockets) s.write(mqttPacket.generate({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false }, opts));
    },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

const broker = await fakeBroker();
process.env.MQTT_DISCOVERY_PORT = String(broker.port);

const mqttDiscovery = await import('../src/mqttDiscovery.js');
const { MAINTENANCE_END_ALL_TOPIC } = mqttDiscovery;
const { setAnalyticsClientForTesting } = await import('../src/analyticsClient.js');

after(async () => {
  await broker.close();
  setAnalyticsClientForTesting(null);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, what: string, logs: string[]): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}\n${logs.slice(-15).join('\n')}`);
    await sleep(10);
  }
}

function stubAnalytics(): AnalyticsClient {
  return {
    report: async <T = any>(): Promise<T> => null as T,
    query: async () => [], listMetrics: async () => [], pushSnapshot: () => {}, flushSnapshot: () => {},
    pushOwnerFloor: () => {}, stop: () => {},
  };
}

test('★★★ End All Maintenance: subscribed on connect, a PRESS ends the windows, the state carries them', { timeout: 30_000 }, async () => {
  setAnalyticsClientForTesting(stubAnalytics());
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {}, alerts: [], alertsComplete: true };
  const store = { get: () => snap, on: () => {} } as unknown as SnapshotStore;
  const logs: string[] = [];
  let open = [{ label: 'Core 3', untilMs: Date.UTC(2026, 9, 30, 21, 30) }];
  let endAllCalls = 0;
  const handle = await mqttDiscovery.startMqttDiscovery(store, makeRecorderStub(), (m) => logs.push(m), {
    active: () => open,
    endAll: () => { endAllCalls++; const n = open.length; open = []; return n; },
    fmtClock: (ms) => new Date(ms).toISOString().slice(11, 16),
  });
  try {
    await until(() => broker.subscribed.includes(MAINTENANCE_END_ALL_TOPIC), 10_000, '★ the End-all command topic is subscribed', logs);
    const state = await handle.buildState!(snap);
    assert.equal(state.maintenance_active, true);
    assert.equal(state.maintenance_count, 1);
    assert.deepEqual(state.maintenance_summary, ['Core 3 until 21:30']);
    broker.deliver(MAINTENANCE_END_ALL_TOPIC, 'PRESS');
    await until(() => endAllCalls > 0, 5_000, '★ the press reaches the controller', logs);
    assert.equal(endAllCalls, 1);
    assert.ok(logs.includes('mqtt-discovery: End All Maintenance pressed — 1 window(s) ended'), logs.join('\n'));
    const after = await handle.buildState!(snap);
    assert.equal(after.maintenance_active, false);
    // An unknown payload on the topic is a no-op.
    broker.deliver(MAINTENANCE_END_ALL_TOPIC, 'ON');
    await sleep(200);
    assert.equal(endAllCalls, 1);
  } finally {
    handle.stop();
  }
});

test('★★ a PRESS with no controller wired says so at WARNING, never "0 ended"', { timeout: 30_000 }, async () => {
  setAnalyticsClientForTesting(stubAnalytics());
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {}, alerts: [], alertsComplete: true };
  const store = { get: () => snap, on: () => {} } as unknown as SnapshotStore;
  const logs: string[] = [];
  const before = broker.subscribed.length;
  const handle = await mqttDiscovery.startMqttDiscovery(store, makeRecorderStub(), (m) => logs.push(m));
  try {
    await until(() => broker.subscribed.slice(before).includes(MAINTENANCE_END_ALL_TOPIC), 10_000, 'subscribed', logs);
    broker.deliver(MAINTENANCE_END_ALL_TOPIC, 'PRESS');
    await until(() => logs.some((l) => l.includes('End All Maintenance pressed')), 5_000, 'the press is logged', logs);
    assert.ok(logs.includes('mqtt-discovery: WARNING — End All Maintenance pressed, but no maintenance controller is wired; nothing ended'));
  } finally {
    handle.stop();
  }
});
