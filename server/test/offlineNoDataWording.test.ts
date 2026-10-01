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
import { SnapshotStore, type DeviceSnapshot } from '../src/snapshot.js';

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

/** The monitor's connectivity context, built the way alertMonitor builds it from the store. */
function fromStore(store: SnapshotStore): ConnectivityContext {
  const perDevice: ConnectivityContext['perDevice'] = new Map();
  for (const d of Object.values(store.get().devices)) {
    perDevice.set(d.sn, {
      lastMqttAt: store.lastMqttAtBySn.get(d.sn),
      lastSource: store.lastSourceBySn.get(d.sn),
      mqttCount: store.mqttMsgCountBySn.get(d.sn) ?? 0,
      firstListedAtMs: store.firstListedAt(d.sn),
    });
  }
  return { lastDeviceListAttemptAt: store.lastDeviceListAttemptAt, lastDeviceListSuccessAt: store.lastDeviceListSuccessAt, perDevice };
}

test('★★★ (review) a /status flip is not data: listed offline, then online, then offline via /status, no quota — still "has not reported"', () => {
  // setDeviceOnline bumps lastUpdated on a bare /status flip (for the stale alarm), and that was
  // read as data: "Last data 0s ago via REST. Just dropped", then "over 30 minutes … power-cycle".
  const store = new SnapshotStore();
  store.setLogger(() => {});
  store.setDeviceList([{ sn: WAVE, deviceName: 'WAVE 2', productName: 'WAVE 2', online: 0 } as never]);
  store.setDeviceOnline(WAVE, true);
  store.setDeviceOnline(WAVE, false);
  const devices = store.get().devices;
  assert.ok(devices[WAVE].lastUpdated > 0, 'the flip did bump lastUpdated (the premise)');
  const a = offline([devices[WAVE]], fromStore(store));
  assert.match(a.detail, /It has not reported since the add-on started\. EcoFlow has reported it offline for the last \d+s; why is not known here\./, a.detail);
  assert.doesNotMatch(a.detail, /via REST|Last data|Just dropped|30 minutes/);
  assert.deepEqual(a.facts?.find((f) => f.label === 'Last data'), { label: 'Last data', value: 'no data this session' });
  // Thirty-five minutes on (the flip's clocks moved back), the same: no measured-gap hint.
  const later = { ...devices[WAVE], lastUpdated: Date.now() - 35 * 60_000, onlineChangedAtMs: Date.now() - 35 * 60_000 };
  const b = offline([later], fromStore(store));
  assert.match(b.detail, /It has not reported since the add-on started\. EcoFlow has reported it offline for the last 35 min;/, b.detail);
  assert.doesNotMatch(b.detail, /30 minutes|lost its EcoFlow cloud|power-cycle|via REST/);
});

test('★★ (review) a REST quota this session IS data: the last data is stated, from the store, with no connectivity context', () => {
  const store = new SnapshotStore();
  store.setLogger(() => {});
  store.setDeviceList([{ sn: CORE, deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: 1 } as never]);
  store.setDeviceQuota(CORE, { 'hs_yj751_pd_appshow_addr.soc': 70 });
  store.setDeviceOnline(CORE, false);
  const viaStore = offline([store.get().devices[CORE]], fromStore(store));
  assert.match(viaStore.detail, /Last data \d+s ago via REST\. Just dropped/, viaStore.detail);
  // computeAlerts called without a connectivity context still sees the device's own telemetry clock.
  const bare = offline([store.get().devices[CORE]]);
  assert.match(bare.detail, /Last data \d+s ago via REST\./, bare.detail);
  assert.doesNotMatch(bare.detail, /has not reported/);
  // …and an MQTT message this session (translated or not) is data too.
  const mq = offline([dev(CORE, 'Delta Pro Ultra')], conn(CORE, { lastMqttAt: Date.now() - 60_000, mqttCount: 1 }));
  assert.doesNotMatch(mq.detail, /has not reported|first device list/);
  assert.match(mq.detail, /last data \d+s ago via \w+\. Just dropped — likely a brief blip\./, mq.detail);
});
