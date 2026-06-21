/**
 * v0.40.1 — isSourceDpuStale: flag a connected SHP2 source slot whose underlying
 * DPU is itself cloud-offline. OBSERVABILITY ONLY — the helper is a pure predicate
 * and changes no backup-pool capacity (which is SHP2-aggregate, see shp2Membership.ts
 * docstring); these tests pin the flag semantics, incl. the spare-DPU exemption.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSourceDpuStale, SPARE_DPU_SNS } from '../src/shp2Membership.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const HOME = 'Y711ZAB59GBC0314'; // Core 1 (a real home core, not a spare)
const SPARE = [...SPARE_DPU_SNS][0]; // Core 4

function dev(sn: string, online: boolean): DeviceSnapshot {
  return { sn, deviceName: sn, productName: 'DELTA PRO ULTRA', online, lastUpdated: 1 } as DeviceSnapshot;
}
const src = (over: Partial<{ isConnected: boolean; sn: string | null }>) =>
  ({ isConnected: true, sn: HOME, ...over });

test('connected slot + its DPU offline → stale', () => {
  const devices = { [HOME]: dev(HOME, false) };
  assert.equal(isSourceDpuStale(src({}), devices), true);
});

test('connected slot + its DPU online → NOT stale', () => {
  const devices = { [HOME]: dev(HOME, true) };
  assert.equal(isSourceDpuStale(src({}), devices), false);
});

test('connected slot + DPU device absent from snapshot → NOT stale (conservative)', () => {
  assert.equal(isSourceDpuStale(src({}), {}), false);
});

test('DISCONNECTED slot (even if DPU offline) → NOT stale', () => {
  const devices = { [HOME]: dev(HOME, false) };
  assert.equal(isSourceDpuStale(src({ isConnected: false }), devices), false);
});

test('null sn → NOT stale', () => {
  assert.equal(isSourceDpuStale(src({ sn: null }), {}), false);
});

test('designated bench spare offline → NOT stale (spares never flagged)', () => {
  const devices = { [SPARE]: dev(SPARE, false) };
  assert.equal(isSourceDpuStale(src({ sn: SPARE }), devices), false);
});

test('returns a strict boolean (never undefined/null)', () => {
  assert.equal(typeof isSourceDpuStale(src({}), {}), 'boolean');
});
