import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shp2ConnectedDpuSns, isShp2Connected } from '../src/shp2Membership.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v0.9.74 — SHP2 membership filter tests.
 *
 * Pins the contract that every fleet-capacity aggregation depends on:
 * "is this DPU's energy actually deliverable to the home?" Without the
 * filter, spare cores (present on the EcoFlow account but not wired to
 * an SHP2) overstated fleet PV / battery in/out by their share.
 *
 * Critical invariants tested:
 *   - Empty Set + isShp2Connected returns true (DPU-only setups)
 *   - sources without sn / isConnected:false are excluded
 *   - Cores 4 + 5 (the operator's spares) are excluded from connected
 *   - Re-call on the same snapshot is idempotent (no hidden mutation)
 */

function shp2Snapshot(sources: Array<{ slot: number; sn?: string; isConnected: boolean }>): Record<string, DeviceSnapshot> {
  return {
    'SHP2_SN_DUMMY': {
      sn: 'SHP2_SN_DUMMY',
      deviceName: 'Smart Home Panel 2',
      productName: 'Smart Home Panel 2',
      online: true,
      lastUpdated: 0,
      projection: {
        kind: 'shp2',
        sources,
        // Minimal fields — only `sources` is consulted by the helper.
      } as any,
    },
  };
}

test('shp2ConnectedDpuSns — empty devices map → empty Set', () => {
  assert.equal(shp2ConnectedDpuSns({}).size, 0);
});

test('shp2ConnectedDpuSns — no SHP2 in snapshot → empty Set', () => {
  const devices: Record<string, DeviceSnapshot> = {
    'DPU_1': {
      sn: 'DPU_1', deviceName: 'Core 1', productName: 'DELTA Pro Ultra',
      online: true, lastUpdated: 0,
      projection: { kind: 'dpu' } as any,
    },
  };
  assert.equal(shp2ConnectedDpuSns(devices).size, 0);
});

test('shp2ConnectedDpuSns — returns only sources with isConnected and a non-null sn', () => {
  const devices = shp2Snapshot([
    { slot: 1, sn: 'CORE_1', isConnected: true },
    { slot: 2, sn: 'CORE_2', isConnected: true },
    { slot: 3, sn: 'CORE_3', isConnected: true },
    // Edge cases that must be excluded:
    { slot: 4, sn: undefined, isConnected: true },   // no SN
    { slot: 5, sn: 'CORE_5', isConnected: false },   // not connected
  ]);
  const connected = shp2ConnectedDpuSns(devices);
  assert.equal(connected.size, 3);
  assert.ok(connected.has('CORE_1'));
  assert.ok(connected.has('CORE_2'));
  assert.ok(connected.has('CORE_3'));
  assert.ok(!connected.has('CORE_5'));
});

test('shp2ConnectedDpuSns — idempotent: repeated calls return equivalent Sets', () => {
  const devices = shp2Snapshot([
    { slot: 1, sn: 'A', isConnected: true },
    { slot: 2, sn: 'B', isConnected: true },
  ]);
  const a = shp2ConnectedDpuSns(devices);
  const b = shp2ConnectedDpuSns(devices);
  assert.equal(a.size, b.size);
  assert.deepEqual([...a].sort(), [...b].sort());
});

/* ─── isShp2Connected fallback semantics ────────────────────────── */

test('isShp2Connected — empty Set returns true (DPU-only fallback)', () => {
  // Critical for users without an SHP2 — we don't filter when membership
  // is unknown, because that would zero out every dashboard tile.
  assert.equal(isShp2Connected('ANY_SN', new Set()), true);
});

test('isShp2Connected — populated Set acts as allow-list', () => {
  const set = new Set(['A', 'B', 'C']);
  assert.equal(isShp2Connected('A', set), true);
  assert.equal(isShp2Connected('B', set), true);
  assert.equal(isShp2Connected('Z', set), false);
});

test('isShp2Connected — the operator scenario: 3-of-5 cores connected', () => {
  const devices = shp2Snapshot([
    { slot: 1, sn: 'Y711XXX00XXX0015', isConnected: true },  // Core 1
    { slot: 2, sn: 'Y711XXX00XXX0002', isConnected: true },  // Core 2
    { slot: 3, sn: 'Y711XXX00X000014', isConnected: true },  // Core 3
  ]);
  const connected = shp2ConnectedDpuSns(devices);
  assert.equal(isShp2Connected('Y711XXX00XXX0015', connected), true);  // Core 1
  assert.equal(isShp2Connected('Y711XXX00XXX0002', connected), true);  // Core 2
  assert.equal(isShp2Connected('Y711XXX00X000014', connected), true);  // Core 3
  assert.equal(isShp2Connected('Y711XXXX0X0X0004', connected), false); // Core 4 (spare)
  assert.equal(isShp2Connected('Y711XXX00X0X0003', connected), false); // Core 5 (spare)
});
