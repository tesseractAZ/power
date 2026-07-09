import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../src/snapshot.js';

/**
 * v0.97.0 (re-audit #4) — setDeviceError must NOT bump lastUpdated.
 *
 * lastUpdated is the "last fresh telemetry" clock the 'Telemetry stale' alarm keys
 * on (alerts.ts: now - lastUpdated > STALE_MS). setDeviceError() runs on every FAILED
 * REST quota poll (~60 s cadence). If it advanced lastUpdated, a device whose poll
 * keeps throwing — while /device/list still lists it online and its projection stays
 * frozen — would be held under the stale threshold forever, silently defeating the
 * safety-net. The failure time is recorded separately (lastErrorAt).
 */

const item = (sn: string) => ({ sn, deviceName: sn, productName: 'Delta Pro Ultra', online: 1 }) as any;

test('setDeviceError records the error but does NOT advance lastUpdated', () => {
  const store = new SnapshotStore();
  store.setDeviceList([item('DPU-1')]);
  const dev = () => store.get().devices['DPU-1'];
  const before = dev().lastUpdated; // 0 — no successful quota yet
  store.setDeviceError('DPU-1', 'getQuotaAll ETIMEDOUT');
  const after = dev();
  // The regression this guards: the old code set lastUpdated = Date.now() here, which
  // is a large non-zero value; the fix leaves it untouched.
  assert.equal(after.lastUpdated, before, 'a REST poll FAILURE must not reset the freshness clock');
  assert.equal(after.lastError, 'getQuotaAll ETIMEDOUT', 'the error string is recorded');
  assert.ok(typeof after.lastErrorAt === 'number' && after.lastErrorAt > 0, 'the failure time is recorded separately in lastErrorAt');
});

test('setDeviceError on an unknown device is a safe no-op', () => {
  const store = new SnapshotStore();
  store.setDeviceError('NOPE', 'boom'); // must not throw
  assert.equal(store.get().devices['NOPE'], undefined);
});
