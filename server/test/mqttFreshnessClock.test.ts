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

/* ===================================================================
 * v1.142.0 — the THIRD path into the same defect, and the clock that fixes it.
 *
 * v0.97.0 stopped `setDeviceError` bumping the freshness clock on a failed poll.
 * v1.3.0 (above) stopped `setMqttMessage` bumping it on chatter that refreshes no
 * projection. `setDeviceOnline` was never given the same treatment: a bare
 * /status OFFLINE→ONLINE flip carries no telemetry and never touches the
 * projection, yet it bumps `lastUpdated`.
 *
 * That bump is DELIBERATE and stays — the 3-min 'Telemetry stale' alarm keys on
 * `lastUpdated`, and a 6 s flip must not raise a self-clearing stale alert. What
 * it must not do is vouch for the PROJECTION, so control readbacks now key on
 * `lastQuotaAtMs`, which only a real quota write advances.
 * =================================================================== */

const shp2Raw = (watts: number[], gridWatt: number) => ({
  'loadInfo.hall1Watt': watts,
  'wattInfo.gridWatt': gridWatt,
  'pd303_mc.masterIncreInfo.gridSta': 1,
}) as Record<string, unknown>;

const LIVE_W = [0, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60];

test('★ a bare /status flip bumps the STALE clock but never the QUOTA clock', () => {
  const store = new SnapshotStore();
  store.setDeviceList([shp2Item('SHP2-1')]);
  store.setDeviceQuota('SHP2-1', shp2Raw(LIVE_W, 3914));
  const dev = () => store.get().devices['SHP2-1'];
  const quotaAt = dev().lastQuotaAtMs!;
  assert.ok(quotaAt > 0, 'a real quota write sets the quota clock');

  store.setDeviceOnline('SHP2-1', false);
  store.setDeviceOnline('SHP2-1', true);

  assert.equal(dev().lastQuotaAtMs, quotaAt, 'a flip carrying no telemetry must not vouch for the projection');
  assert.ok(dev().lastUpdated >= quotaAt, 'but the stale clock is still held off, by design');
});

test('★ THE INCIDENT: sixteen identical 60 s polls mark the panel content-stale', () => {
  // 200 OK every 60 s, byte-identical body. Observed live for 16.0 min and
  // 14.5 min on consecutive nights, inside armed charge windows.
  const store = new SnapshotStore();
  let t = 1_000_000;
  store.setClock(() => t);
  store.setDeviceList([shp2Item('SHP2-1')]);
  const dev = () => store.get().devices['SHP2-1'];
  for (let i = 0; i < 16; i++) { store.setDeviceQuota('SHP2-1', shp2Raw(LIVE_W, 3914)); t += 60_000; }
  assert.ok(dev().contentStaleSinceMs != null, 'a replayed body must be detectable');
});

test('★ sixteen identical polls in ONE MILLISECOND are NOT a shadow', () => {
  // The duration half of the test. A retry storm or a test harness can produce
  // the repeat count in no time at all; only elapsed wall-clock proves a freeze.
  const store = new SnapshotStore();
  store.setClock(() => 1_000_000);
  store.setDeviceList([shp2Item('SHP2-1')]);
  for (let i = 0; i < 16; i++) store.setDeviceQuota('SHP2-1', shp2Raw(LIVE_W, 3914));
  assert.equal(store.get().devices['SHP2-1'].contentStaleSinceMs, null);
});

test('a MOVING panel is never marked stale, however many polls land', () => {
  const store = new SnapshotStore();
  store.setDeviceList([shp2Item('SHP2-1')]);
  const dev = () => store.get().devices['SHP2-1'];
  let t2 = 1_000_000;
  store.setClock(() => t2);
  for (let i = 0; i < 40; i++) {
    const w = LIVE_W.slice(); w[2] = 100 + (i % 7); // one leg moves, as it always does
    store.setDeviceQuota('SHP2-1', shp2Raw(w, 0));  // grid pinned at 0 — a sunny day
    t2 += 60_000;
  }
  assert.equal(dev().contentStaleSinceMs, null, 'one moving leg is enough; the grid scalar alone is not the witness');
});

test('a stale panel CLEARS as soon as the content moves again', () => {
  const store = new SnapshotStore();
  let t = 1_000_000;
  store.setClock(() => t);
  store.setDeviceList([shp2Item('SHP2-1')]);
  const dev = () => store.get().devices['SHP2-1'];
  for (let i = 0; i < 16; i++) { store.setDeviceQuota('SHP2-1', shp2Raw(LIVE_W, 3914)); t += 60_000; }
  assert.ok(dev().contentStaleSinceMs != null);
  const moved = LIVE_W.slice(); moved[5] = 71;
  store.setDeviceQuota('SHP2-1', shp2Raw(moved, 3914));
  assert.equal(dev().contentStaleSinceMs, null, 'the guard must release itself without an add-on restart');
});

test('a DPU is never content-tracked — the witness is SHP2-only', () => {
  const store = new SnapshotStore();
  store.setDeviceList([dpuItem('DPU-1')]);
  for (let i = 0; i < 20; i++) store.setDeviceQuota('DPU-1', { 'bmsMaster.soc': 50 });
  assert.equal(store.get().devices['DPU-1'].contentStaleSinceMs ?? null, null);
});
