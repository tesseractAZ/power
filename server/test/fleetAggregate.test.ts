import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFleetFlow, findShp2, onlineDpus, SPARE_DPU_SNS } from '../src/shp2Membership.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v0.52.0 — coverage for aggregateFleetFlow, the live fleet power-flow loop now
 * SHARED by /api/ha-state (index.ts) and MQTT buildState (mqttDiscovery.ts).
 * Neither copy had runtime coverage before; the two were hand-kept-in-sync.
 *
 * The "two surfaces stay byte-identical" guarantee: both surfaces now destructure
 * from this one function, so a single oracle (helper === the former inline loop)
 * pins both. The `reimplementInlineLoop` below is a VERBATIM copy of the loop
 * that used to live (identically) in both files; we assert the helper matches it.
 */

const SPARE_SN = [...SPARE_DPU_SNS][0]; // Core 4 — Y711ZABA9H3T0489

function dpu(
  sn: string,
  online: boolean,
  p: {
    pvTotalWatts: number;
    totalInWatts: number;
    totalOutWatts: number;
    acInWatts: number;
    packs: Array<{ inputWatts: number; outputWatts: number }>;
  },
): DeviceSnapshot {
  return { sn, online, projection: { kind: 'dpu', ...p } } as any;
}

function shp2(sn: string, circuits: Array<{ watts: number }>): DeviceSnapshot {
  return { sn, online: true, projection: { kind: 'shp2', circuits, sources: [] } } as any;
}

// VERBATIM reimplementation of the loop that previously lived identically in
// index.ts /api/ha-state AND mqttDiscovery buildState (the dedup oracle).
function reimplementInlineLoop(devices: Record<string, DeviceSnapshot>) {
  const list = Object.values(devices);
  const dpus = list.filter((d: any) => d.projection?.kind === 'dpu' && d.online) as any[];
  const sh = list.find((d: any) => d.projection?.kind === 'shp2') as any;
  // shp2ConnectedDpuSns equivalent: the SHP2 sources marked isConnected with an sn.
  const connected = new Set<string>(
    sh ? (sh.projection.sources ?? []).filter((s: any) => s.isConnected && s.sn).map((s: any) => s.sn) : [],
  );
  const isConn = (snx: string) => connected.size === 0 || connected.has(snx);
  const gridDpus = dpus.filter((d: any) => isConn(d.sn));
  let fleetPv = 0, fleetIn = 0, fleetOut = 0, acIn = 0, fleetBatteryNet = 0;
  for (const d of gridDpus) {
    fleetPv += d.projection.pvTotalWatts ?? 0;
    fleetIn += d.projection.totalInWatts ?? 0;
    fleetOut += d.projection.totalOutWatts ?? 0;
    acIn += d.projection.acInWatts ?? 0;
    for (const pk of d.projection.packs) fleetBatteryNet += (pk.outputWatts ?? 0) - (pk.inputWatts ?? 0);
  }
  let panelLoad = 0;
  if (sh) for (const c of sh.projection.circuits) panelLoad += c.watts ?? 0;
  return { fleetPv, fleetIn, fleetOut, acIn, fleetBatteryNet, panelLoad };
}

test('aggregateFleetFlow: sums online connected DPUs; per-pack net = out − in (positive = discharging)', () => {
  const devices = {
    A: dpu('A', true, {
      pvTotalWatts: 1000,
      totalInWatts: 1200,
      totalOutWatts: 800,
      acInWatts: 200,
      packs: [
        { inputWatts: 0, outputWatts: 300 }, // discharging +300
        { inputWatts: 100, outputWatts: 0 }, // charging   -100
      ],
    }),
    S: shp2('S', [{ watts: 400 }, { watts: 150 }]),
  };
  // empty connected set (SHP2 has no connected sources here) → no DPUs filtered out (fallback)
  const r = aggregateFleetFlow(devices);
  assert.equal(r.fleetPv, 1000);
  assert.equal(r.fleetIn, 1200);
  assert.equal(r.fleetOut, 800);
  assert.equal(r.acIn, 200);
  assert.equal(r.fleetBatteryNet, 200); // 300 − 100
  assert.equal(r.panelLoad, 550); // 400 + 150
  assert.deepEqual(r, reimplementInlineLoop(devices), 'helper === the former inline loop (both surfaces)');
});

test('aggregateFleetFlow: a SPARE DPU is excluded once the SHP2 declares connected sources', () => {
  const devices = {
    HOME: dpu('HOME', true, {
      pvTotalWatts: 500,
      totalInWatts: 0,
      totalOutWatts: 0,
      acInWatts: 0,
      packs: [{ inputWatts: 0, outputWatts: 0 }],
    }),
    SPARE: dpu(SPARE_SN, true, {
      pvTotalWatts: 9999, // must NOT count
      totalInWatts: 0,
      totalOutWatts: 0,
      acInWatts: 0,
      packs: [{ inputWatts: 0, outputWatts: 9999 }],
    }),
    // SHP2 declares only HOME as a connected source → SPARE is filtered out.
    S: { sn: 'S', online: true, projection: { kind: 'shp2', circuits: [{ watts: 100 }], sources: [{ sn: 'HOME', isConnected: true }] } } as any,
  };
  const r = aggregateFleetFlow(devices);
  assert.equal(r.fleetPv, 500, 'spare PV excluded');
  assert.equal(r.fleetBatteryNet, 0, 'spare pack flow excluded');
  assert.equal(r.panelLoad, 100);
  assert.deepEqual(r, reimplementInlineLoop(devices), 'helper === the former inline loop (both surfaces)');
});

test('aggregateFleetFlow: OFFLINE DPUs do not contribute', () => {
  const devices = {
    OFF: dpu('OFF', false, {
      pvTotalWatts: 777,
      totalInWatts: 0,
      totalOutWatts: 0,
      acInWatts: 0,
      packs: [{ inputWatts: 0, outputWatts: 777 }],
    }),
    S: shp2('S', []),
  };
  const r = aggregateFleetFlow(devices);
  assert.equal(r.fleetPv, 0);
  assert.equal(r.fleetBatteryNet, 0);
  assert.equal(r.panelLoad, 0);
  assert.deepEqual(r, reimplementInlineLoop(devices));
});

test('aggregateFleetFlow: empty-connected-set fallback includes every online DPU (no SHP2 sources)', () => {
  const devices = {
    A: dpu('A', true, { pvTotalWatts: 10, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, packs: [] }),
    B: dpu('B', true, { pvTotalWatts: 20, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, packs: [] }),
    // SHP2 present but with NO connected sources → empty Set → fallback (do not filter).
    S: shp2('S', [{ watts: 5 }]),
  };
  const r = aggregateFleetFlow(devices);
  assert.equal(r.fleetPv, 30, 'both online DPUs counted under the empty-set fallback');
  assert.equal(r.panelLoad, 5);
  assert.deepEqual(r, reimplementInlineLoop(devices));
});

test('aggregateFleetFlow: no SHP2 at all → panelLoad 0, DPUs still summed (fallback)', () => {
  const devices = {
    A: dpu('A', true, { pvTotalWatts: 42, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, packs: [] }),
  };
  const r = aggregateFleetFlow(devices);
  assert.equal(r.fleetPv, 42);
  assert.equal(r.panelLoad, 0);
  assert.deepEqual(r, reimplementInlineLoop(devices));
});

// idx-3 — findShp2 / onlineDpus selectors (shared by index.ts call sites).

test('findShp2: returns the SHP2 device, or undefined when absent', () => {
  const withShp2 = {
    A: dpu('A', true, { pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, packs: [] }),
    S: shp2('S', []),
  };
  assert.equal(findShp2(withShp2)?.sn, 'S');
  assert.equal(findShp2({}), undefined);
  const dpuOnly = { A: dpu('A', true, { pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, packs: [] }) };
  assert.equal(findShp2(dpuOnly), undefined);
});

test('onlineDpus: only kind==dpu AND online; excludes offline DPUs and the SHP2', () => {
  const devices = {
    ON1: dpu('ON1', true, { pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, packs: [] }),
    OFF: dpu('OFF', false, { pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, packs: [] }),
    ON2: dpu('ON2', true, { pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, packs: [] }),
    S: shp2('S', []),
  };
  const sns = onlineDpus(devices).map((d) => d.sn).sort();
  assert.deepEqual(sns, ['ON1', 'ON2']);
  assert.deepEqual(onlineDpus({}), []);
});
