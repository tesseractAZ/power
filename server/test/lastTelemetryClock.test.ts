import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../src/snapshot.js';

/**
 * v1.176.0 — `lastTelemetryAtMs`: moved by telemetry CONTENT and nothing else.
 *
 * The dashboard's header age and LIVE pill read it. `lastUpdated` could not serve: an MQTT
 * /status online flip bumps it on purpose (so a 6 s flip cannot raise a self-clearing stale
 * alarm), which made a device going OFFLINE read "0 s old". `lastQuotaAtMs` could not
 * either: it is REST-only, so a Core streaming MQTT every second read a poll-interval old.
 */

const item = (sn: string, online = 1) => ({ sn, deviceName: sn, productName: 'Delta Pro Ultra', online }) as any;
const quota = { 'hs_yj751_pd_appshow_addr.soc': 80 };

function store(t: { now: number }) {
  const s = new SnapshotStore();
  s.setClock(() => t.now);
  s.setDeviceList([item('C1')]);
  return s;
}
const dev = (s: SnapshotStore) => s.get().devices['C1'] as any;

test('a REST quota and an MQTT delta both move it', () => {
  const t = { now: 1_000_000 };
  const s = store(t);
  assert.equal(dev(s).lastTelemetryAtMs, undefined, 'nothing has landed yet');
  s.setDeviceQuota('C1', quota);
  assert.equal(dev(s).lastTelemetryAtMs, 1_000_000);
  s.mergeDeviceQuota('C1', { 'hs_yj751_pd_appshow_addr.soc': 81 });
  assert.ok(dev(s).lastTelemetryAtMs >= 1_000_000, 'an MQTT delta is content');
});

test('★★★ a /status flip does NOT move it (lastUpdated still does, for the stale alarm)', () => {
  const t = { now: 1_000_000 };
  const s = store(t);
  s.setDeviceQuota('C1', quota);
  const before = dev(s).lastTelemetryAtMs;
  const luBefore = dev(s).lastUpdated;
  s.setDeviceOnline('C1', false);
  assert.equal(dev(s).lastTelemetryAtMs, before, 'going OFFLINE is not telemetry');
  assert.ok(dev(s).lastUpdated >= luBefore, 'lastUpdated keeps its deliberate /status bump');
});

test('a failed poll does NOT move it', () => {
  const t = { now: 1_000_000 };
  const s = store(t);
  s.setDeviceQuota('C1', quota);
  const before = dev(s).lastTelemetryAtMs;
  s.setDeviceError('C1', 'getQuotaAll ETIMEDOUT');
  assert.equal(dev(s).lastTelemetryAtMs, before);
});

test('an EMPTY quota (cloud "success with no data") does NOT move it', () => {
  const t = { now: 1_000_000 };
  const s = store(t);
  s.setDeviceQuota('C1', quota);
  t.now += 60_000;
  s.setDeviceQuota('C1', {});
  assert.equal(dev(s).lastTelemetryAtMs, 1_000_000, 'the v1.171.1 empty-payload guard returns before the clock');
});

test('★★★ it survives the /device/list rebuild, which re-creates every device from a literal', () => {
  const t = { now: 1_000_000 };
  const s = store(t);
  s.setDeviceQuota('C1', quota);
  s.setDeviceList([item('C1')]);
  assert.equal(dev(s).lastTelemetryAtMs, 1_000_000, 'a field not named in the rebuild literal is silently dropped every 60 s');
});
