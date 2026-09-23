/**
 * v1.178.0 — a LIVE panel reading of no grid vetoes a DECLARED-only grid, everywhere.
 *
 * The declaration (`input_boolean.grid_available`, hand-flipped, or the static
 * GRID_AVAILABLE) was trusted over the panel's own gridSta away from the reserve floor. In a
 * surprise outage with the toggle still ON, the grid kept "backstopping": the runway audible
 * stayed gated silent, HA's runway_projection_islanded_only read ON and off_grid OFF, and the
 * Runway card said "not a live countdown" — until the pool neared the floor. The early
 * warning (hours to shed load or start the generator) was lost.
 *
 * These drive the REAL resolver, then the real audible gate and the real card note.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGridBackstop } from '../src/gridState.js';
import { projectShp2 } from '../src/ecoflow/project.js';
import { SnapshotStore } from '../src/snapshot.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldGateRunwayAudible, classifyRunway } from '../src/runwayAlarm.js';
import { gridNote } from '../../web/src/cards/runwayText.js';

type Any = any;
const entity = (state: string): Any => ({ entity_id: 'input_boolean.grid_available', state, last_updated: new Date().toISOString() });

/** An online, fresh panel reporting `gridSta`, no grid flow, the pool discharging. */
function devices(gridSta: number | null, opts: { online?: boolean; shadowed?: boolean; gridWatt?: number; quotaAgoMs?: number; onlineChangedAgoMs?: number } = {}): Any {
  return {
    SHP2: {
      sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2',
      online: opts.online ?? true, lastUpdated: Date.now(), lastQuotaAtMs: Date.now() - (opts.quotaAgoMs ?? 20_000),
      onlineChangedAtMs: opts.onlineChangedAgoMs == null ? undefined : Date.now() - opts.onlineChangedAgoMs,
      contentStaleSinceMs: opts.shadowed ? Date.now() - 6 * 60_000 : null,
      projection: {
        kind: 'shp2', gridSta, gridConnected: gridSta == null ? null : gridSta === 1,
        gridWatt: opts.gridWatt ?? 0, backupBatPercent: 60, backupReserveSoc: 16,
        sources: [{ slot: 1, sn: 'C1', isConnected: true }],
      },
    },
    C1: {
      sn: 'C1', deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
      projection: { kind: 'dpu', soc: 60, acInWatts: 0, acOutWatts: 5000, packs: [{ num: 1, outputWatts: 5000, inputWatts: 0 }] },
    },
  };
}

const resolve = (d: Any, toggle = 'on', atReserveFloor = false) =>
  resolveGridBackstop({ devices: d, gridEntity: entity(toggle), gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor });

test('★★★ toggle ON, panel says "grid not detected" (gridSta 0), away from the floor: NOT backstopping, NOT present', () => {
  const g = resolve(devices(0));
  assert.equal(g.backstopping, false, 'the stale toggle no longer silences the outage');
  assert.equal(g.present, false, 'off_grid reads ON');
  assert.equal(g.declared, false, 'the declaration is vetoed by the measurement');
  assert.match(g.reason, /grid not detected \(gridSta=0\)/);
});

test('★★ gridSta 2 (energized but out of spec — the panel islands onto the batteries) vetoes too', () => {
  const g = resolve(devices(2));
  assert.equal(g.backstopping, false);
  assert.match(g.reason, /out of spec \(gridSta=2/);
});

test('★★★ downstream: the runway audible is no longer gated, the card drops "not a live countdown"', () => {
  const g = resolve(devices(0));
  assert.equal(shouldGateRunwayAudible(g), false);
  // 5.5 h to empty: the "high" alarm the stale toggle used to silence.
  const p: Any = { unavailable: null, hoursToReserve: 2.5, hoursToEmpty: 5.5, belowReserveFloor: false, backupRemainingKwh: 30, backupReserveKwh: 14.75 };
  assert.notEqual(classifyRunway(p, g), null, 'the early warning speaks');
  assert.equal(gridNote(g), null);
});

test('measured flow still proves the grid regardless of gridSta (importLive wins)', () => {
  const g = resolve(devices(0, { gridWatt: 1900 }));
  assert.equal(g.importLive, true);
  assert.equal(g.backstopping, true);
  assert.equal(g.present, true);
});

test('a field the panel never reported vetoes nothing: the declaration stands', () => {
  const g = resolve(devices(null));
  assert.equal(g.backstopping, true);
  assert.equal(g.declared, true);
});

test('★★★ the veto clears on EVIDENCE, not silence: an offline or cloud-replayed panel whose last reading was not Grid OK keeps vetoing', () => {
  // A cloud-replay shadow (2-4 a day here) or a cloud-offline panel (an outage that also takes
  // the ISP down) must not republish "grid present" mid-outage.
  for (const [name, d, re] of [
    ['offline', devices(0, { online: false }), /last reading; panel offline/],
    ['shadowed', devices(0, { shadowed: true }), /last reading; panel data replayed/],
  ] as const) {
    const g = resolve(d);
    assert.equal(g.backstopping, false, name);
    assert.equal(g.present, false, `${name}: off_grid stays ON`);
    assert.equal(g.declared, false, name);
    assert.match(g.reason, re);
  }
});

test('an offline panel whose last reading was Grid OK: the veto needs a not-OK reading, so the declaration stands', () => {
  const g = resolve(devices(1, { online: false }));
  assert.equal(g.declared, true);
  assert.equal(g.backstopping, true);
  assert.equal(g.shp2GridConnected, null, 'the presence term stays online-gated: a stale 1 asserts nothing');
});

test('★★★ a 0 that merely stops being refreshed KEEPS vetoing: the cloud or uplink failing mid-outage must not republish "grid present"', () => {
  // The outage is announced, then REST goes quiet; nothing marks the panel offline, the
  // reading just ages. Lifting the veto on age would re-gate the runway audible in the outage.
  for (const quotaAgoMs of [6 * 60_000, 60 * 60_000]) {
    const g = resolve(devices(0, { quotaAgoMs, onlineChangedAgoMs: 3 * 3_600_000 }));
    assert.equal(g.backstopping, false, `${quotaAgoMs / 60_000} min old, no online transition since`);
    assert.equal(g.present, false);
  }
});

test('★★★ end to end through the real SnapshotStore: an outage survives a /status blip and a cloud-replay shadow; only a Grid OK reading clears it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veto-'));
  const prevPath = process.env.SHADOW_WITNESS_PATH;
  process.env.SHADOW_WITNESS_PATH = join(dir, 'shadow-witness.json');
  try {
    const store = new SnapshotStore();
    let t = 1_000_000;
    store.setClock(() => t);
    store.setDeviceList([{ sn: 'SHP2-1', deviceName: 'SHP2-1', productName: 'Smart Home Panel 2', online: 1 } as never]);
    const quota = (gridSta: number, k: number): Record<string, unknown> => ({
      'pd303_mc.masterIncreInfo.gridSta': gridSta, 'wattInfo.gridWatt': 0,
      'loadInfo.hall1Watt': [k, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
    });
    const r = () => resolveGridBackstop({ devices: store.get().devices, gridEntity: entity('on'), gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor: false });

    store.setDeviceQuota('SHP2-1', quota(0, 1));
    assert.equal(r().backstopping, false, 'the outage is announced');
    store.setDeviceOnline('SHP2-1', false);
    assert.equal(r().backstopping, false, '/status OFFLINE');
    store.setDeviceOnline('SHP2-1', true);
    assert.equal(r().backstopping, false, '/status ONLINE again, before any quota');
    for (let i = 0; i < 16; i++) { t += 60_000; store.setDeviceQuota('SHP2-1', quota(0, 1)); }
    assert.ok(store.get().devices['SHP2-1'].contentStaleSinceMs != null, 'the cloud-replay shadow latched');
    assert.equal(r().backstopping, false, 'shadow latched: still no grid');
    // The grid returns and the panel says so: that reading, and only that, clears the veto.
    t += 60_000;
    store.setDeviceQuota('SHP2-1', quota(1, 2));
    assert.equal(r().declared, true);
    assert.equal(r().backstopping, true);
  } finally {
    if (prevPath == null) delete process.env.SHADOW_WITNESS_PATH; else process.env.SHADOW_WITNESS_PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ a REST reply without gridSta (the pd303_mc subtree omitted) does not lift the veto; a setDeviceList rebuild keeps the reading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veto-partial-'));
  const prevPath = process.env.SHADOW_WITNESS_PATH;
  process.env.SHADOW_WITNESS_PATH = join(dir, 'shadow-witness.json');
  try {
    const store = new SnapshotStore();
    let t = 5_000_000;
    store.setClock(() => t);
    const item = { sn: 'SHP2-1', deviceName: 'SHP2-1', productName: 'Smart Home Panel 2', online: 1 } as never;
    store.setDeviceList([item]);
    const body = (k: number): Record<string, unknown> => ({
      'wattInfo.gridWatt': 0, 'loadInfo.hall1Watt': [k, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
    });
    const r = () => resolveGridBackstop({ devices: store.get().devices, gridEntity: entity('on'), gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor: false });
    store.setDeviceQuota('SHP2-1', { ...body(1), 'pd303_mc.masterIncreInfo.gridSta': 0 });
    assert.equal(r().backstopping, false, 'the outage is announced');
    t += 60_000;
    store.setDeviceQuota('SHP2-1', body(2)); // non-empty, no gridSta
    assert.equal(store.get().devices['SHP2-1'].projection?.kind === 'shp2' && (store.get().devices['SHP2-1'].projection as Any).gridConnected, null, '(the projection itself has no reading)');
    assert.equal(r().backstopping, false, 'a reply that said nothing about the grid does not lift the veto');
    assert.match(r().reason, /gridSta=0\) \(last reading; latest reply omitted gridSta\)/);
    store.setDeviceList([item]); // the 60 s /device/list rebuild
    assert.equal(r().backstopping, false, 'the reading survives the rebuild');
    t += 60_000;
    store.setDeviceQuota('SHP2-1', { ...body(3), 'pd303_mc.masterIncreInfo.gridSta': 1 });
    assert.equal(r().backstopping, true, 'a Grid OK reading clears it');
  } finally {
    if (prevPath == null) delete process.env.SHADOW_WITNESS_PATH; else process.env.SHADOW_WITNESS_PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real projection maps an undocumented gridSta to false (the veto depends on it)', () => {
  assert.equal(projectShp2({ 'pd303_mc.masterIncreInfo.gridSta': 3 } as Any).gridConnected, false);
  assert.equal(projectShp2({ 'pd303_mc.masterIncreInfo.gridSta': 1 } as Any).gridConnected, true);
  assert.equal(projectShp2({} as Any).gridConnected, null);
});

test('an undocumented gridSta code is not "Grid OK" (VALUE-1-ONLY) and the reason names the code it reported', () => {
  const g = resolve(devices(3));
  assert.equal(g.backstopping, false);
  assert.match(g.reason, /gridSta=3/);
  assert.doesNotMatch(g.reason, /gridSta=0/);
});

test('Grid OK (gridSta 1) with the toggle ON is unchanged: backstopping', () => {
  const g = resolve(devices(1));
  assert.equal(g.backstopping, true);
  assert.equal(g.present, true);
});

test('the static GRID_AVAILABLE fallback is vetoed the same way (no entity configured)', () => {
  const g = resolveGridBackstop({ devices: devices(0), gridEntity: null, gridEntityConfigured: false, gridAvailableFallback: true, atReserveFloor: false });
  assert.equal(g.backstopping, false);
  assert.equal(g.present, false);
});

test('toggle OFF was already honoured and still is', () => {
  const g = resolve(devices(1), 'off');
  assert.equal(g.declared, false);
  assert.equal(g.backstopping, true, 'gridSta=1 on its own is still a (floor-guarded) backstop signal');
});
