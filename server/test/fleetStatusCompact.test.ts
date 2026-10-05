/**
 * v1.187.10 (log review 10-03, C9) — the fleet-status dump at LOG_LEVEL=debug: what is EMITTED, not
 * the level it is emitted at.
 *
 * v1.145.0 kept the unchanged 10-minute dump at DEBUG as a byte saving. On an install running
 * LOG_LEVEL=debug (pino writes every level to stdout and the journal keeps it) that saved nothing:
 * 203 DEBUG lines in 40.8 h, 44.7 % of the journal, one distinct state vector. The tests in
 * logReachAndDisplayHonesty.test.ts pin only the returned LEVEL. Here every emitted line is
 * captured, whatever its level: the count per six hours, and that an unchanged tick carries only
 * the devices reporting over MQTT (the 10-minute message-rate witness) plus a count for the rest.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceSnapshot } from '../src/snapshot.js';

const TMP = mkdtempSync(join(tmpdir(), 'ef-fleet-status-'));
process.env.DB_PATH = join(TMP, 'ecoflow.db');
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { SnapshotStore, createFleetStatusDumper, fleetStatusDump } = await import('../src/snapshot.js');

const MIN = 60_000;
/** Six devices on MQTT, seven OFF or API-only — the reviewed fleet's shape (names made up). */
const MQTT_DEVICES = ['Smart Home Panel 2', 'Core 1', 'Core 2', 'Core 3', 'Core 4', 'Core 5'];
const QUIET_DEVICES: Array<[string, boolean]> = [
  ['EVSE - Car Charger', true], ['PowerInsight', true], ['BACC - Delta 3 Plus', true], ['SEC - River 3 Plus', true],
  ['Smart Generator 3000', false], ['WAVE 2', false], ['Core 6', false],
];

function fleet() {
  const store = new SnapshotStore();
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  let i = 0;
  const sn = () => `COREXXX00XXX${String(++i).padStart(4, '0')}`;
  const mqttSns: string[] = [];
  for (const name of MQTT_DEVICES) {
    const s = sn();
    mqttSns.push(s);
    devices[s] = { sn: s, deviceName: name, productName: 'DELTA Pro Ultra', online: true, lastUpdated: 0 } as DeviceSnapshot;
  }
  for (const [name, online] of QUIET_DEVICES) {
    const s = sn();
    devices[s] = { sn: s, deviceName: name, productName: 'Other', online, lastUpdated: 0 } as DeviceSnapshot;
  }
  return { store, mqttSns };
}

test('★★★ an unchanged fleet over six hours at debug level: 36 lines — 6 full INFO anchors and 30 compact lines without the static entries, every one still carrying the MQTT counters', () => {
  const { store, mqttSns } = fleet();
  const emitted: Array<{ level: 'info' | 'debug'; line: string }> = [];
  const dump = createFleetStatusDumper(store, (m) => emitted.push({ level: 'info', line: m }), (m) => emitted.push({ level: 'debug', line: m }));
  const t0 = 1_800_000_000_000;
  for (let k = 0; k < 36; k++) {
    const now = t0 + k * 10 * MIN;
    for (const s of mqttSns) {
      store.mqttMsgCountBySn.set(s, (store.mqttMsgCountBySn.get(s) ?? 0) + 50 + k);
      store.lastMqttAtBySn.set(s, now - 2_000);
    }
    store.lastDeviceListSuccessAt = now - 60_000;
    dump(now);
  }
  assert.equal(emitted.length, 36, 'one line per 10-minute tick');
  const info = emitted.filter((e) => e.level === 'info');
  const debug = emitted.filter((e) => e.level === 'debug');
  assert.equal(info.length, 6, 'the first dump and an hourly anchor — the counters moving every tick are not a "change"');
  assert.equal(debug.length, 30);
  for (const e of info) {
    assert.match(e.line, /^fleet-status \[device-list last success 60s ago\]: Smart Home Panel 2=ON\/\d+msg\/2s · /);
    assert.ok(e.line.includes('EVSE - Car Charger=API-online/no-MQTT') && e.line.includes('WAVE 2=OFF'), 'the anchor states every device');
  }
  for (const e of debug) {
    assert.ok(!e.line.includes('=OFF') && !e.line.includes('API-online/no-MQTT='), e.line);
    assert.ok(!e.line.includes('EVSE') && !e.line.includes('WAVE 2'), 'the static entries are not repeated');
    assert.match(e.line, /^fleet-status \(unchanged\) \[list 60s ago\]: Smart Home Panel 2=\d+msg\/2s · Core 1=\d+msg\/2s · Core 2=\d+msg\/2s · Core 3=\d+msg\/2s · Core 4=\d+msg\/2s · Core 5=\d+msg\/2s · \+7 OFF or API-online\/no-MQTT as last stated$/);
  }
  const fullBytes = Buffer.byteLength(info[0].line);
  const debugBytes = debug.reduce((n, e) => n + Buffer.byteLength(e.line), 0);
  assert.ok(debugBytes < 30 * fullBytes * 0.7, `the unchanged ticks cost ${debugBytes} B against ${30 * fullBytes} B as full lines`);
});

test('★★ a state change emits the full line at INFO at once, between anchors', () => {
  const { store, mqttSns } = fleet();
  const emitted: Array<{ level: string; line: string }> = [];
  const dump = createFleetStatusDumper(store, (m) => emitted.push({ level: 'info', line: m }), (m) => emitted.push({ level: 'debug', line: m }));
  const t0 = 1_800_000_000_000;
  for (const s of mqttSns) { store.mqttMsgCountBySn.set(s, 10); store.lastMqttAtBySn.set(s, t0 - 1_000); }
  dump(t0);
  dump(t0 + 10 * MIN);
  (store.get().devices as Record<string, DeviceSnapshot>)[mqttSns[3]].online = false; // Core 3 goes OFF
  dump(t0 + 20 * MIN);
  assert.deepEqual(emitted.map((e) => e.level), ['info', 'debug', 'info']);
  assert.ok(emitted[2].line.includes('Core 3=OFF'));
});

test('fleetStatusDump — the signature excludes counters and ages (a moving counter is not a change)', () => {
  const entry = (n: number, at: number) => [{ name: 'Core 1', online: true, msgCount: n, lastMqttAtMs: at }];
  const a = fleetStatusDump({ entries: entry(5, 1_000), nowMs: 2_000, deviceListSuccessAtMs: 0, prevSignature: null, lastInfoMs: 0 });
  const b = fleetStatusDump({ entries: entry(900, 7_000), nowMs: 9_000, deviceListSuccessAtMs: 0, prevSignature: a.signature, lastInfoMs: 2_000 });
  assert.equal(a.signature, b.signature);
  assert.equal(b.level, 'debug');
  assert.equal(b.line, 'fleet-status (unchanged) [list never]: Core 1=900msg/2s');
});
