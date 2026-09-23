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

test('★★ an UNKNOWN reading vetoes nothing: offline panel, cloud-shadowed panel, or no gridSta field', () => {
  for (const [name, d] of [
    ['offline', devices(0, { online: false })],
    ['shadowed', devices(0, { shadowed: true })],
    ['no field', devices(null)],
  ] as const) {
    const g = resolve(d);
    assert.equal(g.backstopping, true, `${name}: the declaration stands when the panel cannot be heard`);
    assert.equal(g.declared, true, name);
  }
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

test('★★ a reading taken BEFORE the panel\'s latest return online vetoes nothing until a quota lands', () => {
  // setDeviceOnline / setDeviceList flip `online` and stamp onlineChangedAtMs without touching
  // the projection: the pre-outage 0 is re-exposed, and the grid may well be back.
  const g = resolve(devices(0, { quotaAgoMs: 40 * 60_000, onlineChangedAgoMs: 30_000 }));
  assert.equal(g.backstopping, true);
  assert.equal(g.declared, true);
  // ...and the first quota after the flip that still says 0 applies the veto.
  assert.equal(resolve(devices(0, { quotaAgoMs: 5_000, onlineChangedAgoMs: 30_000 })).backstopping, false);
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
