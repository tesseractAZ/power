/**
 * v1.187.1 — a device with NO data this session is not described as a measured gap (general-5).
 *
 * lastDataAt = 0 (nothing since the add-on started) read as Infinity minutes, so the offline alert
 * said "No telemetry for over 30 minutes — the device has lost its EcoFlow cloud (enhanced)
 * connection. It usually recovers once the cloud session re-establishes; if it stays offline, a
 * power-cycle forces a clean reconnect." three seconds after start-up — for three peripherals
 * offline since before the 82-day ledger began (2026-09-30), and it would say the same, on a pushed warning, of a home Core
 * that dropped a minute before a restart. Neither the duration nor the cause is known then. The
 * alert now says what is known: it has not reported since the add-on started, for how long EcoFlow
 * has listed it offline in this session, and that the cause is not known. Id, severity, priority
 * and annunciation are unchanged. The monitor's firstListedAtMs wiring is in v1187_1gWiring.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, type ConnectivityContext } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const WAVE = 'WAVEXXX00XXX0001';
const CORE = 'COREXXX00XXX0001';
const H = 3_600_000;

function dev(sn: string, productName: string, over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return { sn, deviceName: productName === 'WAVE 2' ? 'WAVE 2' : 'Core 1', productName, online: false, lastUpdated: 0, ...over } as DeviceSnapshot;
}
function conn(sn: string, p: { lastMqttAt?: number; mqttCount?: number; firstListedAtMs?: number | null; lastSource?: 'rest' | 'mqtt' } = {}): ConnectivityContext {
  const now = Date.now();
  return {
    lastDeviceListAttemptAt: now, lastDeviceListSuccessAt: now,
    perDevice: new Map([[sn, { mqttCount: p.mqttCount ?? 0, lastMqttAt: p.lastMqttAt, lastSource: p.lastSource, firstListedAtMs: p.firstListedAtMs }]]),
  };
}
const offline = (devices: DeviceSnapshot[], c?: ConnectivityContext) =>
  computeAlerts(Object.fromEntries(devices.map((d) => [d.sn, d])), c).find((a) => a.id.startsWith('offline-'))!;

test('★★★ 09-30, three seconds after start-up: no ">30 min", no "lost its cloud connection", no "usually recovers"', () => {
  const a = offline([dev(WAVE, 'WAVE 2')], conn(WAVE, { firstListedAtMs: Date.now() - 3_000 }));
  assert.equal(a.id, `offline-${WAVE}`);
  assert.equal(a.severity, 'info', 'unchanged');
  assert.equal(a.priority, 'low', 'unchanged');
  assert.equal(a.annunciate, undefined, 'unchanged');
  assert.doesNotMatch(a.detail, /30 minutes|lost its EcoFlow cloud|usually recovers|power-cycle|No telemetry received/);
  assert.match(a.detail, /^WAVE 2 is flagged offline by EcoFlow's \/device\/list\. It has not reported since the add-on started\. EcoFlow Cloud has listed it offline since the add-on's first device list \(3s ago\); how long before that, and why, is not known here\. If the device is meant to be on, check its power and its Wi-Fi\.$/, a.detail);
  assert.deepEqual(a.facts?.find((f) => f.label === 'Last data'), { label: 'Last data', value: 'no data this session' });
});

test('★★ hours later, the listing age grows with it — still no cause asserted', () => {
  const a = offline([dev(WAVE, 'WAVE 2')], conn(WAVE, { firstListedAtMs: Date.now() - 5 * H }));
  assert.match(a.detail, /listed it offline since the add-on's first device list \(5 h ago\)/);
  assert.doesNotMatch(a.detail, /lost its EcoFlow cloud/);
});

test('★★ no listing time known: the sentence stands without one', () => {
  const a = offline([dev(WAVE, 'WAVE 2')], conn(WAVE, { firstListedAtMs: null }));
  assert.match(a.detail, /listed it offline since the add-on's first device list; how long before that, and why, is not known here\./);
});

test('★★★ a home Core that went offline IN this session (a transition seen here) is described from that transition', () => {
  const a = offline([dev(CORE, 'Delta Pro Ultra', { onlineChangedAtMs: Date.now() - 12 * 60_000, onlineChangedVia: 'device-list' })],
    conn(CORE, { firstListedAtMs: Date.now() - 2 * H }));
  assert.equal(a.severity, 'warning', 'a home Core offline is still a warning');
  assert.match(a.detail, /It has not reported since the add-on started\. EcoFlow has reported it offline for the last 12 min; why is not known here\. If the device is meant to be on, check its power and its Wi-Fi\.$/, a.detail);
  assert.doesNotMatch(a.detail, /30 minutes|first device list/);
});

test('★★★ a device that DID report this session keeps the measured-gap hints', () => {
  const now = Date.now();
  const old = offline([dev(CORE, 'Delta Pro Ultra')], conn(CORE, { lastMqttAt: now - 45 * 60_000, mqttCount: 120, lastSource: 'mqtt' }));
  assert.match(old.detail, /We previously received 120 MQTT message\(s\) this session; last data 45 min ago via MQTT\. No telemetry for over 30 minutes — the device has lost its EcoFlow cloud/);
  const mid = offline([dev(CORE, 'Delta Pro Ultra')], conn(CORE, { lastMqttAt: now - 10 * 60_000, mqttCount: 5, lastSource: 'mqtt' }));
  assert.match(mid.detail, /Data is stale but recent/);
  const fresh = offline([dev(CORE, 'Delta Pro Ultra')], conn(CORE, { lastMqttAt: now - 60_000, mqttCount: 5, lastSource: 'mqtt' }));
  assert.match(fresh.detail, /Just dropped — likely a brief blip/);
  // REST data this session, no MQTT: the last data is stated, not "no telemetry".
  const rest = offline([dev(CORE, 'Delta Pro Ultra', { lastUpdated: now - 40 * 60_000 })], conn(CORE, { lastSource: 'rest' }));
  assert.match(rest.detail, /is flagged offline by EcoFlow's \/device\/list\. Last data 40 min ago via REST\. No telemetry for over 30 minutes/, rest.detail);
});
