import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../src/snapshot.js';

/* ===================================================================
 * v1.3.0 (audit rank 1) — an MQTT message we cannot translate is NOT telemetry.
 *
 * `lastUpdated` is the "last fresh telemetry" clock the 'Telemetry stale' alarm keys on
 * (alerts.ts: now - lastUpdated > STALE_MS). `setMqttMessage` used to bump it on EVERY
 * parsed MQTT message, even when no `translatedRest` payload existed to refresh the
 * projection with.
 *
 * That mattered most for the SHP2 — the device owning the backup pool, reserve floor and
 * grid presence. `ecoflow/mqtt.ts` only translates `delta pro ultra` products, so
 * translatedRest is ALWAYS null for the SHP2, and its healthy ~9 msg/min stream perpetually
 * reset the freshness clock. Had the REST poll for the SHP2 begun failing, its projection
 * would have frozen while 'Telemetry stale' never fired.
 *
 * Same defect class as v0.97.0's setDeviceError fix, on the other input path.
 * =================================================================== */

const shp2Item = (sn: string) => ({ sn, deviceName: sn, productName: 'Smart Home Panel 2', online: 1 }) as any;
const dpuItem = (sn: string) => ({ sn, deviceName: sn, productName: 'Delta Pro Ultra', online: 1 }) as any;

test('an UNTRANSLATABLE MQTT message (SHP2 heartbeat) must not advance the telemetry clock', () => {
  const store = new SnapshotStore();
  store.setDeviceList([shp2Item('SHP2-1')]);
  const dev = () => store.get().devices['SHP2-1'];
  const before = dev().lastUpdated; // 0 — no successful quota yet

  // ecoflow/mqtt.ts passes translated=null for every non-"delta pro ultra" product.
  store.setMqttMessage('SHP2-1', 1, { someQuotaField: 1 }, null);

  assert.equal(dev().lastUpdated, before, 'MQTT chatter with no projection update must not reset the stale clock');
});

test('...but it DOES record MQTT liveness separately, so the operator can see chatter-without-telemetry', () => {
  const store = new SnapshotStore();
  store.setDeviceList([shp2Item('SHP2-1')]);
  store.setMqttMessage('SHP2-1', 1, { someQuotaField: 1 }, null);

  const at = store.lastMqttAtBySn.get('SHP2-1');
  assert.ok(typeof at === 'number' && at > 0, 'lastMqttAt is stamped');
  assert.equal(store.lastSourceBySn.get('SHP2-1'), 'mqtt');
  assert.equal(store.mqttMsgCountBySn.get('SHP2-1'), 1);
  // This is precisely what the stale alert's detail line reports beside the stale age:
  // "no fresh telemetry for 14m. Last MQTT msg 5s ago." — the diagnostic that names the bug.
});

test('an empty translatedRest is still not telemetry', () => {
  const store = new SnapshotStore();
  store.setDeviceList([shp2Item('SHP2-1')]);
  const before = store.get().devices['SHP2-1'].lastUpdated;
  store.setMqttMessage('SHP2-1', 1, { x: 1 }, {});
  assert.equal(store.get().devices['SHP2-1'].lastUpdated, before);
});

test('a TRANSLATED MQTT message (a DPU delta) still refreshes the telemetry clock', () => {
  const store = new SnapshotStore();
  store.setDeviceList([dpuItem('DPU-1')]);
  const before = store.get().devices['DPU-1'].lastUpdated;
  // A real translated payload merges into the raw cache and re-projects.
  store.setMqttMessage('DPU-1', 1, { raw: 1 }, { 'bmsMaster.soc': 55 });
  const after = store.get().devices['DPU-1'].lastUpdated;
  assert.ok(after > before, 'genuine telemetry MUST advance the freshness clock');
});

test('an untranslatable message for an unknown device is a safe no-op', () => {
  const store = new SnapshotStore();
  assert.doesNotThrow(() => store.setMqttMessage('NOPE', 1, { a: 1 }, null));
});
