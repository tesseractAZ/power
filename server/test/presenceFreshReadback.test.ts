/**
 * v1.179.0 — a stale gridSta=1 ("Grid OK") must never assert grid presence.
 *
 * computeShp2GridConnected gated the panel's flag on `online` and the shadow latch only, with
 * no look at how old the reading was. Two paths let a stale "1" through, both in the
 * missed-alarm direction (present + gridStaBackstop true, the runway audible gated, SoC
 * crossings spoken as "drawing from grid power", off_grid OFF, shp2_grid_connected ON):
 *   1. an OFFLINE→ONLINE /status flip re-exposes the pre-offline sample before any quota
 *      lands (setDeviceOnline never touches the projection or lastQuotaAtMs);
 *   2. a quota fetch that keeps failing with the panel still listed online.
 * The presence term now needs a fresh readback (shp2ReadbackFresh). These drive the REAL
 * SnapshotStore and the REAL resolver.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../src/snapshot.js';
import { resolveGridBackstop, computeShp2GridConnected } from '../src/gridState.js';
import { SHP2_READBACK_STALE_MS } from '../src/shp2Membership.js';

type Any = any;
const MIN = 60_000;

const quota = (gridSta: number, k = 1): Record<string, unknown> => ({
  'pd303_mc.masterIncreInfo.gridSta': gridSta,
  'wattInfo.gridWatt': 0,
  'loadInfo.hall1Watt': [k, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
});

/** A real store with the panel listed online; `at` sets the store clock (quota times). */
function withStore(fn: (store: SnapshotStore, at: (ms: number) => void) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'presence-'));
  const prev = process.env.SHADOW_WITNESS_PATH;
  process.env.SHADOW_WITNESS_PATH = join(dir, 'shadow-witness.json');
  try {
    const store = new SnapshotStore();
    let t = Date.now();
    store.setClock(() => t);
    store.setDeviceList([{ sn: 'SHP2-1', deviceName: 'SHP2-1', productName: 'Smart Home Panel 2', online: 1 } as never]);
    fn(store, (ms) => { t = ms; });
  } finally {
    if (prev == null) delete process.env.SHADOW_WITNESS_PATH; else process.env.SHADOW_WITNESS_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** No declaration at all: presence can come only from import or the panel's own flag. */
const resolve = (devices: Any, extra: Partial<Parameters<typeof resolveGridBackstop>[0]> = {}) =>
  resolveGridBackstop({ devices, gridEntity: null, gridEntityConfigured: false, gridAvailableFallback: false, atReserveFloor: false, ...extra });

test('★★★ path 1 — OFFLINE→ONLINE flip with no quota: the pre-offline "Grid OK" asserts nothing', () => {
  withStore((store, at) => {
    at(Date.now() - 12 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1));
    assert.equal(resolve(store.get().devices, { nowMs: Date.now() - 12 * MIN + 1_000 }).present, true, '(fresh then: Grid OK)');
    store.setDeviceOnline('SHP2-1', false);
    // ...the utility fails while the panel is dark; /status reports ONLINE before any quota.
    store.setDeviceOnline('SHP2-1', true);
    const g = resolve(store.get().devices);
    assert.equal(g.shp2GridConnected, null, 'shp2_grid_connected publishes unknown, not ON');
    assert.equal(g.present, false, 'off_grid reads ON');
    assert.equal(g.backstopping, false, 'the runway audible is not gated');
    // The first quota after the flip decides.
    at(Date.now());
    store.setDeviceQuota('SHP2-1', quota(0, 2));
    assert.equal(resolve(store.get().devices).shp2GridConnected, false);
    store.setDeviceQuota('SHP2-1', quota(1, 3));
    assert.equal(resolve(store.get().devices).present, true, 'a fresh Grid OK asserts presence again');
  });
});

test('★★★ path 2 — the quota fetch keeps failing with the panel still online: the stale "1" lapses at the readback window', () => {
  withStore((store, at) => {
    at(Date.now() - 6 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1));
    store.setDeviceError('SHP2-1', 'quota fetch failed');
    const d = store.get().devices['SHP2-1'];
    assert.equal(d.online, true, 'nothing marks the panel offline');
    const g = resolve(store.get().devices);
    assert.equal(g.shp2GridConnected, null);
    assert.equal(g.present, false);
    assert.equal(g.backstopping, false);
  });
});

test('★★ the burst-gap backstop is untouched inside the window: gridSta=1 a poll old, at the floor, pool idle → backstopping', () => {
  // v0.89.0 — gridSta stays 1 between the SHP2's 8 kW charge bursts while gridWatt reads 0.
  // Quotas arrive every ~60 s, far inside SHP2_READBACK_STALE_MS.
  withStore((store, at) => {
    at(Date.now() - 1 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1));
    const g = resolve(store.get().devices, { atReserveFloor: true });
    assert.equal(g.shp2GridConnected, true);
    assert.equal(g.backstopping, true, 'no false at-floor critical between bursts');
  });
});

test('the window boundary is the shared SHP2_READBACK_STALE_MS (5 min), not a private constant', () => {
  assert.equal(SHP2_READBACK_STALE_MS, 5 * MIN);
  withStore((store, at) => {
    const q = Date.now() - 10 * MIN;
    at(q);
    store.setDeviceQuota('SHP2-1', quota(1));
    const devs = store.get().devices;
    assert.equal(computeShp2GridConnected(devs, q + SHP2_READBACK_STALE_MS - 1_000), true, 'just inside');
    assert.equal(computeShp2GridConnected(devs, q + SHP2_READBACK_STALE_MS + 1_000), null, 'just outside');
  });
});

test('★ a 6 s /status blip does not drop a reading that is still fresh (dropping it would remove the burst-gap backstop at the floor)', () => {
  withStore((store, at) => {
    at(Date.now() - 20_000);
    store.setDeviceQuota('SHP2-1', quota(1));
    store.setDeviceOnline('SHP2-1', false);
    assert.equal(resolve(store.get().devices, { atReserveFloor: true }).shp2GridConnected, null, 'while offline: unknown (unchanged)');
    store.setDeviceOnline('SHP2-1', true);
    const g = resolve(store.get().devices, { atReserveFloor: true });
    assert.equal(g.shp2GridConnected, true);
    assert.equal(g.backstopping, true);
  });
});

test('★★ the v1.178.0 declared-grid veto is unchanged: it still reads the LAST reading, however stale', () => {
  withStore((store, at) => {
    at(Date.now() - 40 * MIN);
    store.setDeviceQuota('SHP2-1', quota(0));
    const g = resolveGridBackstop({
      devices: store.get().devices,
      gridEntity: { entity_id: 'input_boolean.grid_available', state: 'on', last_updated: new Date().toISOString() } as Any,
      gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor: false,
    });
    assert.equal(g.shp2GridConnected, null, 'presence: stale → unknown');
    assert.equal(g.declared, false, 'veto: the last reading still says no grid');
    assert.equal(g.backstopping, false);
  });
});
