import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selfConsumptionCoverage,
  computeSelfConsumption,
  resetSelfConsumptionCache,
  resetDailyEnergyCache,
} from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

// v0.69.0 — guards the home-core coverage flag. The load-bearing case is the last
// one: when the SHP2 itself is cloud-offline it reports ZERO connectors, and a naive
// `reporting < connected` would read `N < 0 = false` ("fine") — masking the window
// where the KPI is least trustworthy. That silent failure is what this pins down.

const dev = (online?: boolean) => ({ online });

test('full coverage — all wired home cores online → not partial', () => {
  const r = selfConsumptionCoverage(
    new Set(['a', 'b', 'c']),
    [{ sn: 'a' }, { sn: 'b' }, { sn: 'c' }],
    { a: dev(true), b: dev(true), c: dev(true) },
    true,
  );
  assert.deepEqual(r, { homeDpusConnected: 3, homeDpusReporting: 3, coveragePartial: false });
});

test('one wired core cloud-offline → partial', () => {
  const r = selfConsumptionCoverage(
    new Set(['a', 'b', 'c']),
    [{ sn: 'a' }, { sn: 'b' }, { sn: 'c' }],
    { a: dev(true), b: dev(true), c: dev(false) },
    true,
  );
  assert.equal(r.homeDpusReporting, 2);
  assert.equal(r.coveragePartial, true);
});

test('wired core dropped from homeDpus (no live projection) → partial', () => {
  // `connected` still lists c (it comes from the SHP2 connector roster, independent of
  // whether we have a projection), but homeDpus omits it → reporting 2 < connected 3.
  const r = selfConsumptionCoverage(
    new Set(['a', 'b', 'c']),
    [{ sn: 'a' }, { sn: 'b' }],
    { a: dev(true), b: dev(true), c: dev(true) },
    true,
  );
  assert.equal(r.homeDpusConnected, 3);
  assert.equal(r.homeDpusReporting, 2);
  assert.equal(r.coveragePartial, true);
});

test('SHP2 cloud-offline — zero connectors but SHP2 present → PARTIAL (the v0.69.0 fix)', () => {
  const r = selfConsumptionCoverage(
    new Set(),
    [{ sn: 'a' }, { sn: 'b' }], // homeDpus expands to all DPUs when membership is empty
    { a: dev(true), b: dev(true) },
    true,
  );
  assert.equal(r.homeDpusConnected, 0);
  assert.equal(r.homeDpusReporting, 0, 'no authoritative roster → 0 confirmed reporting');
  assert.equal(r.coveragePartial, true, 'SHP2 present + no connectors = membership unknown = partial');
});

test('DPU-only install (no SHP2) → never partial', () => {
  const r = selfConsumptionCoverage(
    new Set(),
    [{ sn: 'a' }, { sn: 'b' }],
    { a: dev(true), b: dev(true) },
    false,
  );
  assert.equal(r.coveragePartial, false);
});

test('a device missing from the map counts as reporting (online undefined !== false)', () => {
  const r = selfConsumptionCoverage(
    new Set(['a', 'b']),
    [{ sn: 'a' }, { sn: 'b' }],
    { a: dev(true) }, // b absent
    true,
  );
  assert.equal(r.homeDpusReporting, 2);
  assert.equal(r.coveragePartial, false);
});

/* ─── v0.73.0: WIRING — computeSelfConsumption sets homeDpusCoveragePartial ───
 * The pure selfConsumptionCoverage helper is exercised above; these prove the FULL
 * computeSelfConsumption() function actually surfaces the flag (the audit's wiring gap).
 * ─────────────────────────────────────────────────────────────────────────── */

function emptyRecorder(): Recorder {
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn: string, metrics: string[]) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

function dpuSnap(sn: string, online = true): DeviceSnapshot {
  return {
    sn,
    deviceName: `Core ${sn.slice(-1)}`,
    productName: 'Delta Pro Ultra',
    online,
    lastUpdated: Date.now(),
    projection: {
      kind: 'dpu',
      soc: 80,
      packs: [{ num: 1, soc: 80, temp: 25, inputWatts: 0, outputWatts: 0, maxCellTemp: 25, minCellTemp: 25, soh: 100, cycles: 10 }],
      pvTotalWatts: 0, pvHighWatts: 0, pvLowWatts: 0,
      pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
      acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
      batVol: 0, batAmp: 0, mpptHvTemp: 0, mpptLvTemp: 0,
    } as any,
  } as unknown as DeviceSnapshot;
}

function shp2Snap(connectedSns: string[]): DeviceSnapshot {
  return {
    sn: 'SHP2-WIRE',
    deviceName: 'Smart Home Panel 2',
    productName: 'Smart Home Panel 2',
    online: true,
    lastUpdated: Date.now(),
    projection: {
      kind: 'shp2',
      pairedCircuits: [],
      circuits: [],
      sources: connectedSns.map((sn) => ({ isConnected: true, sn })),
    } as any,
  } as unknown as DeviceSnapshot;
}

test('WIRING: full roster (SHP2 + all wired cores online) → not partial', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  const devices: Record<string, DeviceSnapshot> = {
    'DPU-A': dpuSnap('DPU-A'),
    'DPU-B': dpuSnap('DPU-B'),
    'SHP2-WIRE': shp2Snap(['DPU-A', 'DPU-B']),
  };
  const sc = computeSelfConsumption(devices, emptyRecorder());
  assert.equal(sc.homeDpusConnected, 2);
  assert.equal(sc.homeDpusReporting, 2);
  assert.equal(sc.homeDpusCoveragePartial, false, 'full roster is not partial');
});

test('WIRING: a wired core cloud-offline → partial', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  const devices: Record<string, DeviceSnapshot> = {
    'DPU-A': dpuSnap('DPU-A', true),
    'DPU-B': dpuSnap('DPU-B', false), // cloud-offline
    'SHP2-WIRE': shp2Snap(['DPU-A', 'DPU-B']),
  };
  const sc = computeSelfConsumption(devices, emptyRecorder());
  assert.equal(sc.homeDpusConnected, 2);
  assert.equal(sc.homeDpusReporting, 1, 'the offline core is not reporting');
  assert.equal(sc.homeDpusCoveragePartial, true, 'a missing wired core makes coverage partial');
});

test('WIRING: SHP2 reports ZERO connectors (cloud-offline) but is present → partial (the v0.69.0 fix, end-to-end)', () => {
  resetSelfConsumptionCache();
  resetDailyEnergyCache();
  const devices: Record<string, DeviceSnapshot> = {
    'DPU-A': dpuSnap('DPU-A'),
    'DPU-B': dpuSnap('DPU-B'),
    'SHP2-WIRE': shp2Snap([]), // no connectors → membership unknown
  };
  const sc = computeSelfConsumption(devices, emptyRecorder());
  assert.equal(sc.homeDpusConnected, 0);
  assert.equal(sc.homeDpusReporting, 0);
  assert.equal(sc.homeDpusCoveragePartial, true, 'SHP2 present + zero connectors = unknown membership = partial');
});
